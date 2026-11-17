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

const HAVE_PROC = existsSync("/proc/self/environ");

/**
 * Whether `pid` is a live process carrying `name=value` in its environment. Every process the workspace starts gets
 * such a marker, which is what makes a pid stored before a restart safe to signal: a recycled pid will not carry it.
 * Returns null when /proc is unavailable (non-Linux), so callers fall back to a bare liveness probe.
 */
export function processHasMarker(pid: number, name: string, value: string): boolean | null {
  if (!HAVE_PROC) return null;
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "latin1");
    return env.split("\0").includes(`${name}=${value}`);
  } catch {
    return false;
  }
}

export function markedAlive(pid: number, name: string, value: string): boolean {
  const m = processHasMarker(pid, name, value);
  return m === null ? pidAlive(pid) : m;
}

export function assertNever(x: never, what: string): never {
  throw new NgError("invalid_argument", `unexpected ${what}: ${String(x)}`);
}
