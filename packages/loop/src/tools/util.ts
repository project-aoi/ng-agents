import {
  describeEnvelopeSource,
  isEnvelopeOfType,
  parsePrincipal,
  projectCellIdOf,
  type Envelope,
  type ItemSource,
  type PromptSnapshot,
  type ToolContext,
  speaks,
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
  // What a person wrote is quoted; machinery (a decision's receipt, a kernel notice) is not shown to the owner as if
  // it were the message the item came from.
  // …and a cell's task or message to this cell is workbench text, not the owner's.
  const person = ["owner", "agent"].includes(parsePrincipal(env.principalId).kind) && speaks(env);
  const p = env.payload as { text?: unknown; note?: unknown } | null;
  const words = person ? [p?.text, p?.note].find((x): x is string => typeof x === "string" && x.trim().length > 0) : undefined;
  return { text: words ? clip(words, 2_000) : "", kind: "system" };
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const TOKEN_CHAR = /[\w./:#@%+=~-]/;

/** Clip a single status line on a token/word boundary so hashes, identifiers and English words are never cut in half. */
export function clipLine(text: string, max: number): string {
  const t = (text.split("\n")[0] ?? "").trim();
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

export function firstLine(text: string, max = 120): string {
  return clip((text.split("\n").find((l) => l.trim()) ?? "").trim(), max);
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
