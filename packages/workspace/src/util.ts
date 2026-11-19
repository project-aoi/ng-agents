import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { NgError } from "@ng/protocol";

/** Filesystem/branch-safe name for a cell id: `[A-Za-z0-9_-]` only, plus a hash suffix when anything was replaced. */
export function slugify(id: string, max = 48): string {
  let s = id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) s = "cell";
  if (s.length > max) s = s.slice(0, max);
  if (s !== id) s += "-" + createHash("sha256").update(id).digest("hex").slice(0, 8);
  return s;
}

/** `p` is `root` or lies below it (both absolute, already normalized). */
export function isInside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
}

/** Serializes async work per key (per cell, per repository). */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.#tails.set(key, tail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- processes ----------

export function killGroup(pgid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

function probe(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const pidAlive = (pid: number) => probe(pid);
export const groupAlive = (pgid: number) => probe(-pgid);

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

/**
 * How a process's environment is read. With /proc (Linux) it is `/proc/<pid>/environ`; otherwise `readEnvironment`,
 * which is `ps` on macOS and nothing elsewhere. Mutable so tests can drive the non-/proc path on Linux.
 */
export const processInspection: { useProc: boolean; readEnvironment: (pid: number) => string | null } = {
  useProc: existsSync("/proc/self/environ"),
  readEnvironment: process.platform === "darwin" ? psEnvironment : () => null,
};

/**
 * Whether `pid` is a live process carrying `name=value` in its environment. Every process the workspace starts gets
 * such a marker, which is what makes a pid stored before a restart safe to signal: a recycled pid will not carry it.
 * Null when the process is alive but its environment could not be read (no /proc, and `ps` failed or is unavailable).
 */
export function processHasMarker(pid: number, name: string, value: string): boolean | null {
  if (processInspection.useProc) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "latin1");
      return env.split("\0").includes(`${name}=${value}`);
    } catch {
      return false;
    }
  }
  if (!pidAlive(pid)) return false;
  const env = processInspection.readEnvironment(pid);
  if (env === null) return null;
  return env.split(/\s+/).includes(`${name}=${value}`);
}

/** Only a process positively identified by its marker counts: one we cannot identify is never adopted or signalled. */
export function markedAlive(pid: number, name: string, value: string): boolean {
  return processHasMarker(pid, name, value) === true;
}

export function assertNever(x: never, what: string): never {
  throw new NgError("invalid_argument", `unexpected ${what}: ${String(x)}`);
}
