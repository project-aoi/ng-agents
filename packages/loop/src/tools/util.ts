import {
  isEnvelopeOfType,
  parseAddress,
  projectCellIdOf,
  subjectKeys,
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

/**
 * One pending card per subject (gtd.ts `subjectKeys`): inside a project everything shares the project's subject;
 * otherwise the item that triggered this Run; otherwise the cell itself.
 */
export function defaultSubjectKey(ctx: ToolContext): string {
  const project = projectCellIdOf(ctx.snapshot.spec);
  if (project) return subjectKeys.project(project);
  const env = primaryEnvelope(ctx.snapshot);
  if (env && ITEM_TYPES.has(env.type)) return subjectKeys.inbound(env.id);
  return subjectKeys.cell(selfId(ctx));
}

/** Card source labels, in the UI's wording (docs/04 §2.1: "飞书转发 · 12 分钟前"). */
const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  ui: "随手记",
  cli: "命令行",
  feishu: "飞书",
  slack: "Slack",
  github: "GitHub",
  webhook: "Webhook",
  email: "邮件",
  memory: "测试通道",
};

export function itemSource(snapshot: PromptSnapshot): ItemSource {
  const env = primaryEnvelope(snapshot);
  if (!env) return { label: "系统", at: snapshot.createdAt };
  const base = { principalId: env.principalId, envelopeId: env.id, at: env.createdAt };
  if (isEnvelopeOfType(env, "source.hit")) return { ...base, label: `信源 · ${env.payload.title}`, ...(env.payload.uri ? { uri: env.payload.uri } : {}) };
  const from = parseAddress(env.from);
  if (from?.kind === "channel") return { ...base, label: CHANNEL_LABELS[from.channelId] ?? from.channelId, channelId: from.channelId };
  if (from?.kind === "inbox") return { ...base, label: "后台分身" };
  if (env.from.startsWith("timer:")) return { ...base, label: "定时提醒" };
  return { ...base, label: "系统" };
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
