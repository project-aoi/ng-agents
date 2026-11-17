import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CommandRunner, SpawnRequest } from "../types";
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

export const DEFAULT_ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;

/** Copies only the allow-listed variables of the kernel's environment (which may hold NG_SECRET_* values). */
export function pickHostEnv(allowlist: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of allowlist) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

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
  /** Extra termination for processes that live outside the host process group (inside a container). */
  killInside?(sig: "TERM" | "KILL"): void;
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
    const timers: NodeJS.Timeout[] = [];
    const decOut = new StringDecoder("utf8");
    const decErr = new StringDecoder("utf8");

    child.stdout?.on("data", (b: Buffer) => opts.onData(decOut.write(b), "stdout"));
    child.stderr?.on("data", (b: Buffer) => opts.onData(decErr.write(b), "stderr"));

    const terminate = (inside: boolean) => {
      if (pid !== undefined) killGroup(pid, "SIGTERM");
      if (inside) opts.killInside?.("TERM");
      timers.push(
        setTimeout(() => {
          if (pid !== undefined && groupAlive(pid)) killGroup(pid, "SIGKILL");
          if (inside) opts.killInside?.("KILL");
        }, opts.killGraceMs),
      );
    };

    const finish = (spawnError?: Error) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener("abort", onAbort);
      opts.onData(decOut.end(), "stdout");
      opts.onData(decErr.end(), "stderr");
      resolve({ code: exited?.code ?? null, signal: exited?.signal ?? null, timedOut, aborted, ...(spawnError ? { spawnError } : {}) });
    };

    const onAbort = () => {
      if (exited || aborted) return;
      aborted = true;
      terminate(true);
    };

    timers.push(
      setTimeout(() => {
        if (exited) return;
        timedOut = true;
        terminate(true);
      }, opts.timeoutMs),
    );
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (err) => {
      if (!exited) finish(err);
    });
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      if (pid !== undefined && groupAlive(pid)) terminate(false);
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

/** Runs a short host command to completion (git, docker lifecycle). Never throws for a non-zero exit. */
export async function runCapture(
  runner: CommandRunner,
  req: Omit<SpawnRequest, "stdio" | "detached">,
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  let child: ChildProcess;
  try {
    child = runner.spawn({ ...req, detached: true, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  } catch (err) {
    return { code: null, stdout: "", stderr: "", error: err as Error };
  }
  let stdout = "";
  let stderr = "";
  const decOut = new StringDecoder("utf8");
  const decErr = new StringDecoder("utf8");
  child.stdout?.on("data", (b: Buffer) => (stdout += decOut.write(b)));
  child.stderr?.on("data", (b: Buffer) => (stderr += decErr.write(b)));
  if (opts.input !== undefined) child.stdin?.end(opts.input);
  const r = await supervise(child, { timeoutMs: opts.timeoutMs ?? 120_000, killGraceMs: 2000, onData: () => {} });
  stdout += decOut.end();
  stderr += decErr.end();
  if (r.spawnError) return { code: null, stdout, stderr, error: r.spawnError };
  if (r.timedOut) return { code: r.code, stdout, stderr, error: new Error(`${req.file} timed out`) };
  return { code: r.code, stdout, stderr };
}
