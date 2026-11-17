import { Cron } from "croner";
import { NgError } from "@ng/protocol";

// croner defaults every reference time to the wall clock; callers here always pass an explicit instant taken from
// the injected Clock, and the Cron objects never get a callback, so croner never schedules timers of its own.

const cache = new Map<string, Cron>();
const CACHE_LIMIT = 256;

function cronFor(expr: string, tz: string | null | undefined): Cron {
  const key = `${tz ?? ""}\u0000${expr}`;
  let c = cache.get(key);
  if (!c) {
    try {
      c = new Cron(expr, { paused: true, ...(tz ? { timezone: tz } : {}) });
    } catch (err) {
      throw new NgError("invalid_argument", `invalid cron "${expr}": ${(err as Error).message}`);
    }
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, c);
  }
  return c;
}

/** First occurrence strictly after `afterMs` (ms precision is truncated to whole seconds by croner), or null if none. */
export function nextCronAt(expr: string, tz: string | null | undefined, afterMs: number): number | null {
  const c = cronFor(expr, tz);
  let next: Date | null;
  try {
    next = c.nextRun(new Date(afterMs));
  } catch (err) {
    throw new NgError("invalid_argument", `cron "${expr}"${tz ? ` (tz ${tz})` : ""}: ${(err as Error).message}`);
  }
  return next ? next.getTime() : null;
}
