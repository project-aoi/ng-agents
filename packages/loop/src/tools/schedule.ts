import { z } from "zod";
import { defineTool, PAYLOAD, type ScheduleRule, type TimerFiredPayload, type Toolset } from "@ng/protocol";
import { selfId } from "./util";

export const SCHEDULE_TOOLSET = "kernel.schedule";

const setReminder = defineTool({
  name: "set_reminder",
  kind: "kernel",
  description: [
    "Wake yourself later with a timer.fired message carrying this label: once (at, or inSeconds) or on a cron schedule.",
    "Use it for the owner's reminders and for your own follow-ups/timeouts; give related timers a cancelGroup so cancel_scheduled can clear them together (e.g. when the awaited reply arrives).",
  ].join(" "),
  input: z.object({
    label: z.string().min(1).describe("what it is about; you will see it when it fires"),
    at: z.string().optional().describe("ISO 8601 time with offset, e.g. 2026-11-20T15:00:00+08:00"),
    inSeconds: z.number().int().min(1).optional(),
    cron: z.string().optional().describe("5-field cron, recurring"),
    tz: z.string().optional().describe("IANA timezone for cron"),
    cancelGroup: z.string().optional(),
    subjectKey: z.string().optional(),
    data: z.unknown().optional(),
    id: z.string().optional().describe("stable id: setting the same id again is a no-op"),
  }),
  async handler(args, ctx) {
    const given = [args.at, args.inSeconds, args.cron].filter((v) => v !== undefined).length;
    if (given !== 1) return { output: "Give exactly one of at, inSeconds or cron.", isError: true };
    const rule: ScheduleRule = {};
    if (args.cancelGroup) rule.cancelGroup = args.cancelGroup;
    if (args.at !== undefined) {
      const t = Date.parse(args.at);
      if (Number.isNaN(t)) return { output: `Cannot parse time "${args.at}"; use ISO 8601 with an offset.`, isError: true };
      rule.deliverAt = t;
    } else if (args.inSeconds !== undefined) {
      rule.deliverAt = ctx.clock.now() + args.inSeconds * 1000;
    } else {
      rule.cron = args.cron!;
      if (args.tz) rule.tz = args.tz;
    }
    const payload: TimerFiredPayload = {
      label: args.label,
      ...(args.data !== undefined ? { data: args.data } : {}),
      ...(args.subjectKey ? { subjectKey: args.subjectKey } : {}),
    };
    const r = await ctx.ports.scheduleSelf({ type: PAYLOAD.timerFired, payload, ...(args.id ? { id: args.id } : {}) }, rule);
    const when = rule.deliverAt !== undefined ? `for ${new Date(rule.deliverAt).toISOString()}` : `on cron "${rule.cron}"${rule.tz ? ` (${rule.tz})` : ""}`;
    return { output: r === "deduped" ? `Already set (id ${args.id}).` : `Reminder set ${when}.`, data: { deliverAt: rule.deliverAt, cron: rule.cron } };
  },
});

const cancelScheduled = defineTool({
  name: "cancel_scheduled",
  kind: "kernel",
  description: "Cancel this cell's pending reminders/timeouts by cancelGroup, or a single one by its id.",
  input: z.object({ cancelGroup: z.string().optional(), envelopeId: z.string().optional() }),
  async handler(args, ctx) {
    if (!args.cancelGroup && !args.envelopeId) return { output: "Give cancelGroup or envelopeId.", isError: true };
    await ctx.ports.cancelScheduled({
      cellId: selfId(ctx),
      ...(args.cancelGroup ? { cancelGroup: args.cancelGroup } : {}),
      ...(args.envelopeId ? { envelopeId: args.envelopeId } : {}),
    });
    return "Cancelled.";
  },
});

/** `kernel.schedule`: set_reminder, cancel_scheduled (the cell's own inbox only). */
export function scheduleToolset(): Toolset {
  return { name: SCHEDULE_TOOLSET, description: "Reminders, follow-up timers and their cancellation.", tools: [setReminder, cancelScheduled] };
}
