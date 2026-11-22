import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { groupAlive, markedGroupState, processInspection, pidAlive, processIdentity, processDescendants, processHasMarker } from "@ng/protocol";

export interface CliProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  /** Resolves once the process has exited and its stdout has been fully read. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Last ~8 KB of stderr (diagnostics only; never parsed as protocol). */
  stderrTail(): string;
  /** Writes a line to stdin. Returns false when stdin is closed/destroyed (line was NOT accepted). */
  write(line: string): boolean;
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
  opts: { cwd: string; env: Record<string, string>; onLine(line: string): void; registry?: CliProcessRegistration; killGraceMs?: number },
): CliProcess {
  const [file, ...args] = argv;
  if (!file) throw new Error("empty argv");
  const reg = opts.registry;
  const marker = reg ? `${reg.runId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}` : null;
  const env = marker ? { ...opts.env, [CLI_PROCESS_MARKER]: marker } : opts.env;
  const wrapped = marker && process.platform === "darwin";
  // Catch TERM in the marker-bearing shell; exec resets a caught signal to default in the actual CLI.
  const child = spawn(wrapped ? "/bin/sh" : file, wrapped ? ["-c", 'trap ":" TERM; "$@"; exit $?', `${CLI_PROCESS_MARKER}=${marker}`, file, ...args] : args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true });
  const record = reg && marker && child.pid ? registerCliProcess(reg, { pid: child.pid, marker, cwd: opts.cwd, bin: file }) : null;
  let stopping: Promise<void> | undefined;
  const pid = child.pid ?? -1;
  const leaderIsOurs = () => child.exitCode === null && child.signalCode === null;
  function stop(graceMs: number): Promise<void> {
    if (pid <= 0 || (!leaderIsOurs() && (pidAlive(pid) || !groupAlive(pid)))) return stopping ?? Promise.resolve();
    stopping ??= stopProcessTree(pid, leaderIsOurs, graceMs).then(gone => {
      if (record && gone) rmSync(record, { force: true });
    });
    return stopping;
  }
  child.once("exit", () => {
    if (stopping) return;
    if (groupAlive(pid)) void stop(opts.killGraceMs ?? 3_000);
    else if (record) rmSync(record, { force: true });
  });
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
  child.stdin!.on("close", () => {
    inputOpen = false;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      inputOpen = false;
      if (settled) return;
      settled = true;
      // stdout may close slightly after exit; never wait long for it (a helper might have inherited it).
      void Promise.race([stdoutDone, new Promise((r) => setTimeout(r, 2_000))])
        .then(() => stopping)
        .then(() => resolve({ code, signal }));
    };
    child.on("exit", done);
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      done(127, null);
    });
  });

  return {
    child,
    pid,
    exited,
    stderrTail: () => stderr,
    write(line) {
      if (!inputOpen || child.stdin!.destroyed || child.stdin!.writableEnded || !child.stdin!.writable) return false;
      try {
        child.stdin!.write(line.endsWith("\n") ? line : `${line}\n`);
        return true;
      } catch {
        inputOpen = false;
        return false;
      }
    },
    endInput() {
      if (!inputOpen) return;
      inputOpen = false;
      child.stdin!.end();
    },
    kill: stop,
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
  ownerInstanceId?: string;
  runId: string;
  cellId: string;
}

const liveOwners = new Set<string>();
let localIdentity: string | undefined;
function identityHash(pid: number): string {
  const stamp = processIdentity(pid);
  return stamp ? createHash("sha256").update(stamp).digest("hex") : "";
}

export function createCliOwner(): { ownerInstanceId: string; release(): void } {
  localIdentity ??= identityHash(process.pid);
  const ownerInstanceId = `${process.pid}:${localIdentity}:${randomUUID()}`;
  liveOwners.add(ownerInstanceId);
  return { ownerInstanceId, release: () => { liveOwners.delete(ownerInstanceId); } };
}

export function isCliOwnerAlive(instanceId: string | undefined): boolean {
  if (!instanceId) return false;
  const [pid, stamp, instance] = instanceId.split(":");
  if (!instance) return false;
  const ownerPid = Number(pid);
  if (ownerPid === process.pid) return liveOwners.has(instanceId);
  if (!pidAlive(ownerPid)) return false;
  const current = identityHash(ownerPid);
  return !stamp || !current || stamp === current;
}

interface CliProcessRecord {
  pid: number;
  marker: string;
  runId: string;
  cellId: string;
  cwd: string;
  bin: string;
  startedAt: number;
  identity?: string | null;
  unknownSince?: number;
  ownerInstanceId?: string;
}

function registrationState(rec: CliProcessRecord): boolean | null {
  return Number.isSafeInteger(rec.pid) && rec.pid > 0 && typeof rec.marker === "string"
    ? markedGroupState(rec.pid, CLI_PROCESS_MARKER, rec.marker, rec.identity) : false;
}

function registerCliProcess(reg: CliProcessRegistration, p: { pid: number; marker: string; cwd: string; bin: string }): string | null {
  try {
    mkdirSync(reg.dir, { recursive: true });
    const path = join(reg.dir, `${p.pid}.json`);
    const rec: CliProcessRecord = {
      pid: p.pid,
      marker: p.marker,
      runId: reg.runId,
      cellId: reg.cellId,
      cwd: p.cwd,
      bin: p.bin,
      startedAt: Date.now(),
      ownerInstanceId: reg.ownerInstanceId,
      identity: process.platform === "darwin" ? processIdentity(p.pid) : null,
    };
    writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
    return path;
  } catch {
    return null; // a record that cannot be written must not stop the Run
  }
}

/**
 * Three-state check for whether `pid` is still the CLI process started with `marker` (cross-platform: `/proc` on
 * Linux, `ps -E` on macOS — same utility as `@ng/workspace`):
 * - `true`:  confirmed alive and carries `NG_CLI_PROC=<marker>`.
 * - `false`: confirmed exited or PID recycled (does not carry the marker).
 * - `null`:  process appears alive, but its environment could not be read (identity unknown).
 */
export function cliProcessStatus(pid: number, marker: string, identity?: string | null): boolean | null {
  return processHasMarker(pid, CLI_PROCESS_MARKER, marker, identity);
}

/** Positively identified alive check (`cliProcessStatus(...) === true`). Never true for unknown identity (`null`). */
export function cliProcessAlive(pid: number, marker: string): boolean {
  return cliProcessStatus(pid, marker) === true;
}

export interface ReapedCliProcess {
  pid: number;
  cellId: string;
  runId: string;
  cwd: string;
  /**
   * - `"killed"`: positively identified orphan; terminated (SIGTERM/SIGKILL) and record removed.
   * - `"gone"`: confirmed exited or PID recycled; stale record removed without signalling.
   * - `"owned"`: another kernel instance is still handling this cell.
   * - `"unknown"`: PID appears alive, but environment could not be read; NOT killed, record kept on disk so the
   *   dispatcher can hold replacement CLI runs for `cellId` until confirmed gone.
   */
  status: "killed" | "gone" | "unknown" | "owned";
  /** true iff `status === "killed"`. */
  killed: boolean;
}

/**
 * Call once at kernel start, before any Run is dispatched: every CLI process a previous kernel left on record and that
 * is verifiably still that process is stopped with its whole tree (SIGTERM, then SIGKILL after `graceMs`), and the
 * call resolves only when they are gone. Records of processes that already exited are removed. Records whose process
 * is alive with unreadable identity (`null`) are KEPT untouched and reported as `status: "unknown"`.
 */
export async function reapOrphanedCliProcesses(
  dir: string,
  opts: { graceMs?: number; cellId?: string; ownerInstanceId?: string } = {},
): Promise<ReapedCliProcess[]> {
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
      if (opts.cellId !== undefined && rec.cellId !== opts.cellId) return;
      if (opts.ownerInstanceId && rec.ownerInstanceId === opts.ownerInstanceId) return;
      const state = registrationState(rec);
      if (state !== false && isCliOwnerAlive(rec.ownerInstanceId)) {
        out.push({ pid: rec.pid, cellId: rec.cellId, runId: rec.runId, cwd: rec.cwd, status: "owned", killed: false });
        return;
      }
      if (state === null) {
        // The dispatcher retries unknown registrations within the observation window without sending a signal.
        out.push({ pid: rec.pid, cellId: rec.cellId, runId: rec.runId, cwd: rec.cwd, status: "unknown", killed: false });
        return;
      }
      if (state === true) {
        const gone = await stopProcessTree(rec.pid, () => cliProcessStatus(rec.pid, rec.marker, rec.identity) === true, graceMs);
        if (gone) {
          rmSync(path, { force: true });
          out.push({ pid: rec.pid, cellId: rec.cellId, runId: rec.runId, cwd: rec.cwd, status: "killed", killed: true });
        } else {
          // Still alive or identity became unreadable: keep record on disk so no replacement process runs concurrently.
          out.push({ pid: rec.pid, cellId: rec.cellId, runId: rec.runId, cwd: rec.cwd, status: "unknown", killed: false });
        }
        return;
      }
      rmSync(path, { force: true });
      out.push({ pid: rec.pid, cellId: rec.cellId, runId: rec.runId, cwd: rec.cwd, status: "gone", killed: false });
    }),
  );
  return out;
}

/**
 * Re-probe any retained orphan CLI PID records for `cellId`. Records whose process has since exited (`false`) are
 * cleaned up. Returns `"clear"` when no unresolved orphan remains for `cellId`, `"unknown"` if one is still unverified
 * alive (caller should defer dispatching a replacement CLI run), or `"alive"` if an identifiable orphan needs reaping.
 */
export function probeOrphanCliCell(dir: string, cellId: string, opts: { ownerInstanceId?: string } = {}): "clear" | "unknown" | "alive" {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return "clear";
  }
  let sawUnknown = false;
  for (const f of files) {
    const path = join(dir, f);
    let rec: CliProcessRecord;
    try {
      rec = JSON.parse(readFileSync(path, "utf8")) as CliProcessRecord;
    } catch {
      rmSync(path, { force: true });
      continue;
    }
    if (rec.cellId !== cellId) continue;
    if (opts.ownerInstanceId && rec.ownerInstanceId === opts.ownerInstanceId) continue;
    const state = registrationState(rec);
    if (state === false) {
      rmSync(path, { force: true });
      continue;
    }
    if (isCliOwnerAlive(rec.ownerInstanceId)) {
      sawUnknown = true;
      continue;
    }
    if (state === true) return "alive";
    if (rec.unknownSince === undefined) {
      rec.unknownSince = Date.now();
      try {
        writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
      } catch {
        // Another recovery may have removed the record. Keep the hold until the next probe.
      }
    } else if (Date.now() - rec.unknownSince >= 30_000) {
      // No verifiable process to reap. Retire the stale registration without signalling this PID.
      rmSync(path, { force: true });
      continue;
    }
    sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "clear";
}

/** Called after identifying the leader. Its descendants can live in independent process groups. */
async function stopProcessTree(pid: number, leaderIsOurs: () => boolean, graceMs: number): Promise<boolean> {
  const tree = new Map<number, string | null>();
  const scan = () => {
    if (!leaderIsOurs()) return;
    for (const child of descendants(pid)) {
      if (!tree.has(child)) tree.set(child, processInspection.readIdentity(child));
    }
  };
  const sameChild = (child: number, before: string | null) =>
    pidAlive(child) && before !== null && processInspection.readIdentity(child) === before;
  const ownGroup = () => leaderIsOurs() || !pidAlive(pid);
  const groupRuns = () => groupAlive(pid) && ownGroup();
  function signal(sig: NodeJS.Signals) {
    if (groupRuns()) {
      try { process.kill(-pid, sig); } catch { /* group already exited */ }
    } else if (leaderIsOurs()) {
      try { process.kill(pid, sig); } catch { /* leader already exited */ }
    }
    for (const [child, before] of tree) {
      if (!sameChild(child, before)) continue;
      try { process.kill(child, sig); } catch { /* descendant already exited */ }
    }
  }
  async function waitGone(ms: number) {
    const deadline = performance.now() + ms;
    while (groupRuns() || (pidAlive(pid) && leaderIsOurs()) || [...tree].some(([p, before]) => sameChild(p, before))) {
      if (performance.now() >= deadline) return false;
      await new Promise(r => setTimeout(r, 25));
    }
    return true;
  }
  scan();
  signal("SIGTERM");
  if (await waitGone(graceMs)) return true;
  scan();
  signal("SIGKILL");
  return waitGone(2_000);
}

/** Descendant pids of `root` (cross-platform: Linux `/proc`, macOS/POSIX `ps -eo pid=,ppid=`). */
export function descendants(root: number): number[] {
  return processDescendants(root);
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
