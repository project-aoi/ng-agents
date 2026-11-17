import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface CliProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  /** Resolves once the process has exited and its stdout has been fully read. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Last ~8 KB of stderr (diagnostics only; never parsed as protocol). */
  stderrTail(): string;
  write(line: string): void;
  endInput(): void;
  /** SIGTERM to the process group and every descendant, SIGKILL after `graceMs` if still alive. */
  kill(graceMs: number): Promise<void>;
}

const STDERR_KEEP = 8_192;

/**
 * Spawns a CLI in its own process group with piped stdio and calls `onLine` for every stdout line. CLIs start helpers
 * in groups of their own (MCP servers, sandbox hosts), so kill() also walks the descendant tree.
 */
export function spawnCli(argv: readonly string[], opts: { cwd: string; env: Record<string, string>; onLine(line: string): void }): CliProcess {
  const [file, ...args] = argv;
  if (!file) throw new Error("empty argv");
  const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true });
  let stderr = "";
  let inputOpen = true;
  const decoder = new StringDecoder("utf8");
  let buf = "";
  const flushLines = (final: boolean) => {
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.trim()) opts.onLine(line);
    }
    if (final && buf.trim()) {
      opts.onLine(buf);
      buf = "";
    }
  };
  child.stdout!.on("data", (d: Buffer) => {
    buf += decoder.write(d);
    flushLines(false);
  });
  const stdoutDone = new Promise<void>((resolve) => {
    child.stdout!.on("end", () => {
      buf += decoder.end();
      flushLines(true);
      resolve();
    });
    child.stdout!.on("error", () => resolve());
  });
  child.stderr!.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString("utf8")).slice(-STDERR_KEEP);
  });
  child.stdin!.on("error", () => {
    inputOpen = false;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      // stdout may close slightly after exit; never wait long for it (a helper might have inherited it).
      void Promise.race([stdoutDone, new Promise((r) => setTimeout(r, 2_000))]).then(() => resolve({ code, signal }));
    };
    child.on("exit", done);
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      done(127, null);
    });
  });

  const pid = child.pid ?? -1;
  return {
    child,
    pid,
    exited,
    stderrTail: () => stderr,
    write(line) {
      if (!inputOpen || child.stdin!.destroyed) return;
      child.stdin!.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    endInput() {
      if (!inputOpen) return;
      inputOpen = false;
      child.stdin!.end();
    },
    async kill(graceMs) {
      if (pid <= 0) return;
      const tree = descendants(pid);
      signalAll(pid, tree, "SIGTERM");
      const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))]);
      // Helpers may outlive the CLI itself; finish them too.
      const rest = [...tree, ...descendants(pid)];
      signalAll(pid, rest, "SIGKILL", gone);
      if (!gone) await Promise.race([exited, new Promise((r) => setTimeout(r, 1_000))]);
    },
  };
}

function signalAll(pid: number, tree: readonly number[], sig: NodeJS.Signals, leaderGone = false): void {
  if (!leaderGone) {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  }
  for (const p of tree) {
    try {
      process.kill(p, sig);
    } catch {
      // already gone
    }
  }
}

/** Descendant pids of `root` (Linux /proc; empty elsewhere). */
export function descendants(root: number): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = readFileSync(`/proc/${e}/stat`, "utf8");
      // comm may contain spaces/parens: fields after the last ")" are positional.
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(after[1]);
      const list = children.get(ppid) ?? [];
      list.push(Number(e));
      children.set(ppid, list);
    } catch {
      // process vanished while scanning
    }
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of children.get(p) ?? []) {
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

/** `<bin> --version` → first version-looking token, or null when the binary is missing or broken. */
export function probeVersion(bin: string, env: Record<string, string | undefined> = process.env, timeoutMs = 10_000): string | null {
  try {
    const r = spawnSync(bin, ["--version"], { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error || r.status !== 0) return null;
    const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    return /\d+\.\d+(?:\.\d+)?(?:[-+.\w]*)?/.exec(text)?.[0] ?? (text.trim().split("\n")[0] || null);
  } catch {
    return null;
  }
}
