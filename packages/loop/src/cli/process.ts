import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
export function spawnCli(
  argv: readonly string[],
  opts: { cwd: string; env: Record<string, string>; onLine(line: string): void; registry?: CliProcessRegistration },
): CliProcess {
  const [file, ...args] = argv;
  if (!file) throw new Error("empty argv");
  const reg = opts.registry;
  const marker = reg ? `${reg.runId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}` : null;
  const env = marker ? { ...opts.env, [CLI_PROCESS_MARKER]: marker } : opts.env;
  const child = spawn(file, args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true });
  const record = reg && marker && child.pid ? registerCliProcess(reg, { pid: child.pid, marker, cwd: opts.cwd, bin: file }) : null;
  if (record) child.once("exit", () => rmSync(record, { force: true }));
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

// ---------- orphans of a kernel that died (docs/05 guard 4) ----------
// A CLI agent runs in its own process group so that a Run can stop its whole tree. The price: when the kernel itself is
// killed, the CLI is not — it finishes its turn alone, still editing files, while a restarted kernel would start a
// second agent in the same directory for the batch it took back. So every CLI process is put on record when it starts
// and taken off when it exits, and the next kernel kills what is still on record before it dispatches anything.

/** Environment variable carrying the per-process marker (pid reuse cannot fool the reaper: it checks the marker). */
export const CLI_PROCESS_MARKER = "NG_CLI_PROC";

export interface CliProcessRegistration {
  /** Directory of the records (`<dataDir>/cli-procs`). */
  dir: string;
  runId: string;
  cellId: string;
}

interface CliProcessRecord {
  pid: number;
  marker: string;
  runId: string;
  cellId: string;
  cwd: string;
  bin: string;
  startedAt: number;
}

function registerCliProcess(reg: CliProcessRegistration, p: { pid: number; marker: string; cwd: string; bin: string }): string | null {
  try {
    mkdirSync(reg.dir, { recursive: true });
    const path = join(reg.dir, `${p.pid}.json`);
    const rec: CliProcessRecord = { pid: p.pid, marker: p.marker, runId: reg.runId, cellId: reg.cellId, cwd: p.cwd, bin: p.bin, startedAt: Date.now() };
    writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
    return path;
  } catch {
    return null; // a record that cannot be written must not stop the Run
  }
}

/** Is `pid` still the process that was started with `marker`? (Linux: its environment says so; elsewhere unknown → false.) */
export function cliProcessAlive(pid: number, marker: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`${CLI_PROCESS_MARKER}=${marker}`);
  } catch {
    return false;
  }
}

export interface ReapedCliProcess {
  pid: number;
  cellId: string;
  runId: string;
  cwd: string;
  /** false: the record was stale (the process had already exited, or the pid belongs to someone else now). */
  killed: boolean;
}

/**
 * Call once at kernel start, before any Run is dispatched: every CLI process a previous kernel left on record and that
 * is verifiably still that process is stopped with its whole tree (SIGTERM, then SIGKILL after `graceMs`), and the
 * call resolves only when they are gone. Records of processes that already exited are just removed.
 */
export async function reapOrphanedCliProcesses(dir: string, opts: { graceMs?: number } = {}): Promise<ReapedCliProcess[]> {
  const graceMs = opts.graceMs ?? 3_000;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ReapedCliProcess[] = [];
  await Promise.all(
    files.map(async (f) => {
      const path = join(dir, f);
      let rec: CliProcessRecord;
      try {
        rec = JSON.parse(readFileSync(path, "utf8")) as CliProcessRecord;
      } catch {
        rmSync(path, { force: true });
        return;
      }
      // Our own live children (a second loop instance in this process) are not orphans.
      const alive = typeof rec.pid === "number" && rec.pid > 0 && cliProcessAlive(rec.pid, rec.marker);
      if (alive) {
        const tree = descendants(rec.pid);
        signalAll(rec.pid, tree, "SIGTERM");
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline && cliProcessAlive(rec.pid, rec.marker)) await new Promise((r) => setTimeout(r, 50));
        const still = cliProcessAlive(rec.pid, rec.marker);
        signalAll(rec.pid, [...tree, ...descendants(rec.pid)], "SIGKILL", !still);
        const hard = Date.now() + 2_000;
        while (Date.now() < hard && cliProcessAlive(rec.pid, rec.marker)) await new Promise((r) => setTimeout(r, 25));
      }
      rmSync(path, { force: true });
      out.push({ pid: rec.pid, cellId: rec.cellId, runId: rec.runId, cwd: rec.cwd, killed: alive });
    }),
  );
  return out;
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
