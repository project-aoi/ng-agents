import {
  describeEnvelopeSource,
  isEnvelopeOfType,
  projectCellIdOf,
  type Envelope,
  type ItemSource,
  type PromptSnapshot,
  type ToolContext,
} from "@ng/protocol";

export function selfId(ctx: ToolContext): string {
  return ctx.ports.self.cellId;
}

/** Envelope types that represent "the item" a Run is handling (for card sources and default subjects). */
const ITEM_TYPES = new Set(["user.message", "source.hit", "handback", "approval.revise"]);

/** The envelope the current batch is about: the first item-like envelope, else the first one. */
export function primaryEnvelope(snapshot: PromptSnapshot): Envelope | undefined {
  const envs = snapshot.batch.envelopes;
  const env = envs.find((e) => ITEM_TYPES.has(e.type)) ?? envs[0];
  if (env && isEnvelopeOfType(env, "handback")) return env.payload.original;
  return env;
}

/** A default issue is scoped to the current work item. Project membership is recorded independently. */
export function defaultSubjectKey(ctx: ToolContext): string {
  const env = primaryEnvelope(ctx.snapshot);
  const id = ctx.snapshot.spec.meta?.actionId;
  const project = projectCellIdOf(ctx.snapshot.spec) ?? selfId(ctx);
  return `action:${project}:${typeof id === "string" ? id : env?.id ?? ctx.snapshot.runId}`;
}

export function itemSource(snapshot: PromptSnapshot): ItemSource {
  return describeEnvelopeSource(primaryEnvelope(snapshot), snapshot.createdAt);
}

export function itemRawInput(snapshot: PromptSnapshot): { text: string; kind: "message" | "voice_transcript" | "monitor_summary" | "system" } {
  const env = primaryEnvelope(snapshot);
  if (!env) return { text: "", kind: "system" };
  if (isEnvelopeOfType(env, "user.message")) return { text: env.payload.text, kind: env.payload.voice ? "voice_transcript" : "message" };
  if (isEnvelopeOfType(env, "source.hit")) return { text: env.payload.rawInput ?? env.payload.summary, kind: "monitor_summary" };
  if (isEnvelopeOfType(env, "cell.result")) return { text: env.payload.summary, kind: "system" };
  if (isEnvelopeOfType(env, "timer.fired")) return { text: env.payload.label, kind: "system" };
  return { text: clip(JSON.stringify(env.payload) ?? "", 2_000), kind: "system" };
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function firstLine(text: string, max = 120): string {
  return clip((text.split("\n").find((l) => l.trim()) ?? "").trim(), max);
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
