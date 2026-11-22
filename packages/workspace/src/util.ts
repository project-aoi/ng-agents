import { createHash } from "node:crypto";
import {
  groupAlive,
  killGroup,
  markedAlive,
  pidAlive,
  processDescendants,
  processHasMarker,
  processInspection,
  psEnvironment,
} from "@ng/protocol";

export { groupAlive, killGroup, markedAlive, pidAlive, processDescendants, processHasMarker, processInspection, psEnvironment };

/** Filesystem/branch-safe name for a cell id: `[A-Za-z0-9_-]` only, plus a hash suffix when anything was replaced. */
export function slugify(id: string, max = 48): string {
  let s = id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) s = "cell";
  if (s.length > max) s = s.slice(0, max);
  if (s !== id) s += "-" + createHash("sha256").update(id).digest("hex").slice(0, 8);
  return s;
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
