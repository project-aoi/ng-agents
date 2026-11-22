import { z } from "zod";
import { NgError, type CellSpec, type ScheduleRule } from "@ng/protocol";

// Tool inputs shared by the presets' composites. Watches and schedules use the same shapes as spawn_cell, so a model
// that learned one writes the other the same way.

export const watchFilterInput = z
  .record(z.string(), z.unknown())
  .describe(
    'match on envelope fields (type, principalId, from) or payload.<key> (payload.text, payload.eventKind, payload.mentions, payload.tags, payload.sender.id). A value is compared for equality, or use one operator: {"$in": [..]}, {"$contains": "x"} (substring of a string / element of a list, case-insensitive), {"$anyKeyword": ["a", "b"]}',
  );

export const watchInput = z.object({
  thread: z.string().optional().describe('external thread id "<channelId>:<threadId>"'),
  filter: watchFilterInput.optional(),
  cancelGroup: z.string().optional(),
});

export const scheduleInput = z.object({
  at: z.string().optional().describe("ISO 8601 time with offset, one-shot"),
  cron: z.string().optional(),
  tz: z.string().optional().describe("IANA timezone for cron"),
  cancelGroup: z.string().optional(),
});

export const repoInput = z.object({
  name: z.string().min(1).describe('how the owner calls it, e.g. "gateway"'),
  cwd: z.string().min(1).describe("absolute path of its checkout on this machine"),
  defaultBranch: z.string().optional(),
});

export function toWatch(w: z.infer<typeof watchInput>, coalesceMs?: number): NonNullable<CellSpec["watches"]>[number] {
  const threadOrFilter = { ...(w.filter ?? {}), ...(w.thread ? { thread: w.thread } : {}) };
  if (Object.keys(threadOrFilter).length === 0) throw new NgError("invalid_argument", "a watch needs a thread or a filter");
  return { threadOrFilter, ...(w.cancelGroup ? { cancelGroup: w.cancelGroup } : {}), ...(coalesceMs ? { coalesceMs } : {}) };
}

export function toSchedule(s: z.infer<typeof scheduleInput>): ScheduleRule {
  const rule: ScheduleRule = {};
  if (s.at) {
    const t = Date.parse(s.at);
    if (Number.isNaN(t)) throw new NgError("invalid_argument", `invalid schedule time "${s.at}" (use ISO 8601 with an offset)`);
    rule.deliverAt = t;
  }
  if (s.cron) rule.cron = s.cron;
  if (s.tz) rule.tz = s.tz;
  if (s.cancelGroup) rule.cancelGroup = s.cancelGroup;
  if ([rule.deliverAt, rule.cron].filter((v) => v !== undefined).length !== 1) {
    throw new NgError("invalid_argument", "each schedule needs exactly one of at or cron");
  }
  return rule;
}

/** ISO 8601 → epoch ms; a string result is the error to show the model. */
export function parseIso(at: string, what: string): number | string {
  const t = Date.parse(at);
  return Number.isNaN(t) ? `Cannot parse ${what} "${at}"; use ISO 8601 with an offset, e.g. 2026-11-20T15:00:00+08:00.` : t;
}

/** The text of an error for a tool result. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A kernel refusal that is about the directory (it does not exist, it is not absolute). */
export function isCwdError(err: unknown): boolean {
  return err instanceof NgError && err.code === "invalid_argument" && /\bcwd\b|directory/i.test(err.message);
}
