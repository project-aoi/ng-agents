import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CommandRunner, SpawnRequest } from "../types";
import { leaderGoneOrZombie, liveGroupMembers } from "@ng/protocol";
import { groupAlive, killGroup } from "../util";

export const defaultCommandRunner: CommandRunner = {
  spawn(req: SpawnRequest): ChildProcess {
    return spawn(req.file, [...req.args], {
      cwd: req.cwd,
      env: req.env,
      detached: req.detached ?? false,
      stdio: req.stdio ?? ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  },
};

/** Bounded capture: keeps the first and last halves of the budget and records how much was elided in between. */
export class OutputCollector {
  #head = "";
  #tail = "";
  #total = 0;
  readonly #headMax: number;
  readonly #tailMax: number;

  constructor(maxChars: number) {
    this.#headMax = Math.floor(maxChars / 2);
    this.#tailMax = maxChars - this.#headMax;
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.#total += chunk.length;
    let rest = chunk;
    if (this.#head.length < this.#headMax) {
      const take = this.#headMax - this.#head.length;
      this.#head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest) {
      this.#tail += rest;
      if (this.#tail.length > this.#tailMax) this.#tail = this.#tail.slice(this.#tail.length - this.#tailMax);
    }
  }

  get truncated(): boolean {
    return this.#total > this.#head.length + this.#tail.length;
  }

  text(): string {
    if (!this.truncated) return this.#head + this.#tail;
    const omitted = this.#total - this.#head.length - this.#tail.length;
    return `${this.#head}\n[... ${omitted} characters omitted ...]\n${this.#tail}`;
  }
}

export interface SuperviseOptions {
  timeoutMs: number;
  killGraceMs: number;
  signal?: AbortSignal | undefined;
  onData(chunk: string, stream: "stdout" | "stderr"): void;
}

export interface SuperviseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: Error;
}

/**
 * Waits for a child started with `detached: true` (its own process group). On timeout/abort the whole group gets
 * SIGTERM, then SIGKILL after the grace period. After the leader exits, leftover group members (background `&`
 * processes that would otherwise hold the output pipes open) are terminated the same way, so a call never hangs on
 * a stray grandchild.
 */
export function supervise(child: ChildProcess, opts: SuperviseOptions): Promise<SuperviseResult> {
  return new Promise((resolve) => {
    const pid = child.pid;
    let timedOut = false;
    let aborted = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let settled = false;
    let groupPoll: NodeJS.Timeout | undefined;
    let pollDelay = 50;
    let warned = false;
    const timers: NodeJS.Timeout[] = [];
    const decOut = new StringDecoder("utf8");
    const decErr = new StringDecoder("utf8");

    child.stdout?.on("data", (b: Buffer) => opts.onData(decOut.write(b), "stdout"));
    child.stderr?.on("data", (b: Buffer) => opts.onData(decErr.write(b), "stderr"));

    const ownedGroupAlive = () => {
      if (pid === undefined || !groupAlive(pid)) return false;
      if (!exited) return true;
      return leaderGoneOrZombie(pid) && liveGroupMembers(pid)?.length !== 0;
    };
    const terminate = () => {
      if (pid !== undefined && ownedGroupAlive()) killGroup(pid, "SIGTERM");
      timers.push(
        setTimeout(() => {
          if (pid !== undefined && ownedGroupAlive()) killGroup(pid, "SIGKILL");
        }, opts.killGraceMs),
      );
    };

    const finish = (spawnError?: Error) => {
      if (settled) return;
      if (!spawnError && ownedGroupAlive()) {
        if (!warned && pollDelay >= 1000) {
          warned = true;
          opts.onData("Waiting for the remaining process group to exit after termination.\n", "stderr");
        }
        if (!groupPoll) {
          groupPoll = setTimeout(() => {
            groupPoll = undefined;
            finish();
          }, pollDelay);
          pollDelay = Math.min(pollDelay * 2, 1000);
        }
        return;
      }
      settled = true;
      clearTimeout(groupPoll);
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener("abort", onAbort);
      opts.onData(decOut.end(), "stdout");
      opts.onData(decErr.end(), "stderr");
      resolve({ code: exited?.code ?? null, signal: exited?.signal ?? null, timedOut, aborted, ...(spawnError ? { spawnError } : {}) });
    };

    const onAbort = () => {
      if (exited || aborted) return;
      aborted = true;
      terminate();
    };

    timers.push(
      setTimeout(() => {
        if (exited) return;
        timedOut = true;
        terminate();
      }, opts.timeoutMs),
    );
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (err) => {
      if (!exited) finish(err);
    });
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      if (ownedGroupAlive()) terminate();
      // Pipes normally close right after exit; the deadline covers a straggler that ignores SIGTERM.
      timers.push(
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish();
        }, opts.killGraceMs + 1000),
      );
    });
    child.once("close", () => finish());
  });
}
