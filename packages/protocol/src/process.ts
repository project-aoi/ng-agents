import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/** Send `sig` to process group `-pgid`. Returns true if the kernel accepted the signal. */
export function killGroup(pgid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

function probe(target: number): boolean {
  if (!Number.isInteger(target) || target === 0) return false;
  try {
    process.kill(target, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const pidAlive = (pid: number): boolean => pid > 0 && probe(pid);
export const groupAlive = (pgid: number): boolean => pgid > 0 && probe(-pgid);

/** Host start time and executable as reported by ps; usable even if SIP strips the environment. */
export function processIdentity(pid: number): string | null {
  try {
    return execFileSync("ps", ["-ww", "-o", "lstart=,comm=", "-p", String(pid)], {
      encoding: "utf8", env: {...process.env, LC_ALL:"C", TZ:"UTC"}, timeout: 2000, stdio:["ignore","pipe","ignore"],
    }).trim() || null;
  } catch { return null; }
}

/**
 * A live process's command line followed by its environment, via `ps` (macOS has no /proc). `-E` adds the
 * environment there; the BSD-style `eww` is avoided because on macOS `-e` is `-A` (every process), so `-p` would no
 * longer narrow the output to one process. The variables come out space-separated and unquoted. Null when `ps`
 * fails, times out or prints nothing.
 */
export function psEnvironment(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "latin1",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}

/** Command line without environment (used on macOS to detect when SIP stripped all env vars from `ps -E`). */
export function psCommand(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "latin1",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}

/** Process state column via `ps` (e.g. `Z` for zombie). */
export function psStat(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Snapshot of `(pid, ppid)` pairs via POSIX `ps` (used for descendant lookup when `/proc` is absent, e.g. macOS). */
export function psParentChild(): Array<{ pid: number; ppid: number }> | null {
  try {
    const out = execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rows: Array<{ pid: number; ppid: number }> = [];
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
    }
    return rows;
  } catch {
    return null;
  }
}

/**
 * How process environments and parent-child trees are inspected.
 * With `/proc` (Linux) it reads `/proc/<pid>/environ` and `/proc/<pid>/stat`; otherwise `readEnvironment` (`ps -E` on
 * macOS, `null` elsewhere) and `listParentChild` (`ps -eo pid=,ppid=`). Mutable so tests can drive non-/proc and
 * unreadable-environment paths deterministically on any OS.
 */
export const processInspection: {
  useProc: boolean;
  readEnvironment: (pid: number) => string | null;
  readCommand: (pid: number) => string | null;
  readIdentity: (pid: number) => string | null;
  listParentChild: () => Array<{ pid: number; ppid: number }> | null;
} = {
  useProc: existsSync("/proc/self/environ"),
  readEnvironment: process.platform === "darwin" ? psEnvironment : () => null,
  readCommand: psCommand,
  readIdentity: processIdentity,
  listParentChild: psParentChild,
};

/**
 * Three-state marker check for `pid`:
 * - `true`:  confirmed alive AND carries `name=value` in its environment (safe to identify/signal).
 * - `false`: confirmed gone OR alive with a different environment (recycled PID — do NOT signal).
 * - `null`:  process appears alive, but its environment could not be read (identity unknown — do NOT kill AND do NOT
 *            blindly assume dead or start a duplicate).
 */
export function processHasMarker(pid: number, name: string, value: string, identity?: string | null): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const expected = `${name}=${value}`;
  if (processInspection.useProc) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "latin1");
      return env.split("\0").includes(expected);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return false;
      return pidAlive(pid) ? null : false;
    }
  }
  if (!pidAlive(pid)) return false;
  const env = processInspection.readEnvironment(pid);
  const words = env?.split(/\s+/) ?? [];
  if (words.includes(expected)) return true;
  if (words.some(word=>word.startsWith(name+"="))) return false;
  if (psStat(pid)?.includes("Z") || !pidAlive(pid)) return false;
  // SIP can return argv alone. A complete argv followed by environment without our marker identifies another process.
  const command = env && processInspection.readCommand(pid)?.trim();
  if (command && env.trim().startsWith(command) && env.trim().slice(command.length).trim()) return false;
  const current = identity ? processInspection.readIdentity(pid) : null;
  return current && identity ? current === identity : null;
}

/** Recheck a detached group after its recorded leader has exited. A recycled leader never authorizes a signal. */
export function markedGroupState(pid: number, name: string, value: string, identity?: string | null): boolean | null {
  const leader = processHasMarker(pid, name, value, identity);
  if (leader !== false || pidAlive(pid) || !groupAlive(pid)) return leader;
  try {
    const listing = execFileSync("ps", ["-eo", "pid=,pgid="], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
    for (const line of listing.trim().split("\n")) {
      const [member, group] = line.trim().split(/\s+/).map(Number);
      if (!member || group !== pid) continue;
      const state = processHasMarker(member, name, value);
      if (state === true) return true;
    }
    // Descendants may clear the inherited marker. Keep the group under observation until it exits.
    return groupAlive(pid) ? null : false;
  } catch {
    return groupAlive(pid) ? null : false;
  }
}

/** Only a process positively identified by its marker counts: one we cannot identify is never signalled as ours. */
export function markedAlive(pid: number, name: string, value: string): boolean {
  return processHasMarker(pid, name, value) === true;
}

/** Descendant PIDs of `root` (cross-platform: `/proc/<pid>/stat` on Linux, `ps -eo pid=,ppid=` on macOS/POSIX). */
export function processDescendants(root: number): number[] {
  if (!Number.isInteger(root) || root <= 0) return [];
  const children = new Map<number, number[]>();
  if (processInspection.useProc) {
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return [];
    }
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
  } else {
    const rows = processInspection.listParentChild();
    if (!rows) return [];
    for (const { pid, ppid } of rows) {
      const list = children.get(ppid) ?? [];
      list.push(pid);
      children.set(ppid, list);
    }
  }
  const out: number[] = [];
  const visited = new Set<number>([root]);
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of children.get(p) ?? []) {
      if (visited.has(c)) continue;
      visited.add(c);
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}
