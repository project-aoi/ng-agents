import { NgError, type Envelope, type ScheduleRule } from "@ng/protocol";

export type Rule =
  | { kind: "now"; cancelGroup: string | null }
  | { kind: "at"; deliverAt: number; cancelGroup: string | null }
  | { kind: "coalesce"; key: string; windowMs: number }
  | { kind: "cron"; cron: string; tz: string | null; cancelGroup: string | null };

export function checkEnvelope(env: Envelope): void {
  const bad = (what: string) => new NgError("invalid_argument", `envelope ${what}`);
  if (env === null || typeof env !== "object") throw bad("must be an object");
  if (typeof env.id !== "string" || env.id.length === 0) throw bad("id must be a non-empty string");
  if (typeof env.from !== "string" || env.from.length === 0) throw bad(`"${env.id}": from is required`);
  if (typeof env.principalId !== "string" || env.principalId.length === 0) throw bad(`"${env.id}": principalId is required`);
  if (env.kind !== "event" && env.kind !== "result") throw bad(`"${env.id}": kind must be "event" or "result"`);
  if (typeof env.type !== "string" || env.type.length === 0) throw bad(`"${env.id}": type is required`);
  if (typeof env.createdAt !== "number" || !Number.isFinite(env.createdAt)) throw bad(`"${env.id}": createdAt must be a number`);
  if (env.delivery !== undefined && env.delivery !== "wakeup" && env.delivery !== "silent_inject") {
    throw bad(`"${env.id}": delivery must be "wakeup" or "silent_inject"`);
  }
  const expected = env.expectedEpoch ?? null;
  if (expected !== null && !Number.isInteger(expected)) throw bad(`"${env.id}": expectedEpoch must be an integer`);
}

export function normalizeRule(s: ScheduleRule | undefined): Rule {
  if (s === undefined || s === null) return { kind: "now", cancelGroup: null };
  const cancelGroup = s.cancelGroup ?? null;
  if (cancelGroup !== null && (typeof cancelGroup !== "string" || cancelGroup.length === 0)) {
    throw new NgError("invalid_argument", "schedule.cancelGroup must be a non-empty string");
  }
  const given = [s.deliverAt, s.cron, s.coalesce].filter((v) => v !== undefined && v !== null).length;
  if (given > 1) throw new NgError("invalid_argument", "schedule: at most one of deliverAt, cron, coalesce");
  if (s.coalesce !== undefined && s.coalesce !== null) {
    const { key, windowMs } = s.coalesce;
    if (typeof key !== "string" || key.length === 0) throw new NgError("invalid_argument", "schedule.coalesce.key must be a non-empty string");
    if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs < 0) throw new NgError("invalid_argument", "schedule.coalesce.windowMs must be >= 0");
    // The key is the row's cancel group: one name for "this window", so a separate cancelGroup would be ambiguous.
    if (cancelGroup !== null && cancelGroup !== key) throw new NgError("invalid_argument", "schedule.coalesce cannot be combined with a different cancelGroup");
    return { kind: "coalesce", key, windowMs };
  }
  if (s.deliverAt !== undefined && s.deliverAt !== null) {
    if (typeof s.deliverAt !== "number" || !Number.isFinite(s.deliverAt)) throw new NgError("invalid_argument", "schedule.deliverAt must be a timestamp");
    return { kind: "at", deliverAt: s.deliverAt, cancelGroup };
  }
  if (s.cron !== undefined && s.cron !== null) {
    if (typeof s.cron !== "string" || s.cron.trim().length === 0) throw new NgError("invalid_argument", "schedule.cron must be a cron expression");
    return { kind: "cron", cron: s.cron.trim(), tz: s.tz ?? null, cancelGroup };
  }
  return { kind: "now", cancelGroup };
}
