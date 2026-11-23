import type { ActivityRecord, ProjectRecord, SourceState } from "./product-records";
import {
  isEnvelopeOfType,
  type ActionRecord,
  type CellStatusLine,
  type DecisionCard,
  type Envelope,
  type Progress,
} from "@ng/protocol";

// GTD record helpers. Records are plain Context state (gtd.ts); everything here writes through the running cell's
// own ports, so a record always lives in the cell that owns it.

export type RawInput = DecisionCard["rawInput"];

/** Envelope types that are "an item" (something that came in and may deserve a card). */
const ITEM_TYPES = new Set(["user.message", "source.hit", "handback"]);

/** A handback carries the original item. */
export function unwrapItem(env: Envelope): Envelope {
  return isEnvelopeOfType(env, "handback") ? env.payload.original : env;
}

/** The item a batch is about: the first message / sensor hit / handback (unwrapped). */
export function primaryItem(envelopes: readonly Envelope[]): Envelope | undefined {
  const env = envelopes.find((e) => ITEM_TYPES.has(e.type));
  return env ? unwrapItem(env) : undefined;
}

export {describeEnvelopeSource as itemSource} from "@ng/protocol";
export function itemRawInput(env: Envelope | undefined): RawInput {
  if (!env) return { text: "", kind: "system" };
  if (isEnvelopeOfType(env, "user.message")) return { text: env.payload.text, kind: env.payload.voice ? "voice_transcript" : "message" };
  if (isEnvelopeOfType(env, "source.hit")) return { text: env.payload.rawInput ?? env.payload.summary, kind: "monitor_summary" };
  return { text: "", kind: "system" };
}

// ---------- builders ----------

export function newProject(init: Omit<ProjectRecord, "lifecycle" | "createdAt" | "updatedAt"> & { lifecycle?: ProjectRecord["lifecycle"] }, now: number): ProjectRecord {
  return { lifecycle: "active", ...init, createdAt: now, updatedAt: now };
}

export function newAction(init: Omit<ActionRecord, "status" | "createdAt" | "updatedAt"> & { status?: ActionRecord["status"] }, now: number): ActionRecord {
  return { status: "open", ...init, createdAt: now, updatedAt: now };
}

/** Apply a patch; `null` removes an optional field. Closing an action stamps completedAt. */
export function patchAction(prev: ActionRecord, patch: { [K in keyof ActionRecord]?: ActionRecord[K] | null }, now: number): ActionRecord {
  const next: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else if (v !== undefined) next[k] = v;
  }
  next["updatedAt"] = now;
  if (prev.status === "open" && next["status"] !== "open" && next["completedAt"] === undefined) next["completedAt"] = now;
  return next as unknown as ActionRecord;
}

export function patchProject(prev: ProjectRecord, patch: Partial<ProjectRecord>, now: number): ProjectRecord {
  const next: ProjectRecord = { ...prev, ...patch, updatedAt: now };
  if (prev.lifecycle === "active" && (next.lifecycle === "completed" || next.lifecycle === "cancelled") && next.completedAt === undefined) next.completedAt = now;
  return next;
}

export function newActivity(init: Omit<ActivityRecord, "at"> & { at?: number }, now: number): ActivityRecord {
  return { ...init, at: init.at ?? now };
}

export function newSource({title, mode, description}: Pick<SourceState, "title" | "mode" | "description">, now: number): SourceState {
  return { title, mode, ...(description && {description}), runCount: 0, hitCount: 0, createdAt: now, updatedAt: now };
}

export function statusLine(text: string, now: number, progress?: Progress): CellStatusLine {
  return { text, at: now, ...(progress ? { progress } : {}) };
}

// ---------- owner-facing text ----------

export function formatWhen(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}月${get("day")}日${get("weekday")} ${get("hour")}:${get("minute")}`;
}

export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const TOKEN_CHAR = /[\w./:#@%+=~-]/;

/**
 * Like clip, for a line a person reads: it never ends inside an ASCII token — half a commit hash, path or URL looks
 * complete and is wrong — but backs off to where that token starts (unless that loses more than half the line).
 */
export function clipLine(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  let end = max;
  if (TOKEN_CHAR.test(t[end - 1]!) && TOKEN_CHAR.test(t[end]!)) {
    let start = end;
    while (start > 0 && TOKEN_CHAR.test(t[start - 1]!)) start--;
    if (start >= max / 2) end = start;
  }
  const code = t.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${t.slice(0, end).trimEnd()}…`;
}

