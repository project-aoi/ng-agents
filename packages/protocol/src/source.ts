import { parseAddress, KERNEL_FROM } from "./address";
import { isEnvelopeOfType, PAYLOAD } from "./payloads";
import type { ItemSource } from "./gtd";
import type { Envelope } from "./contract/envelope";
export const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  ui: "随手记",
  memory: "测试通道",
};

/**
 * Whether an envelope carries its sender's own words. A cell.message names as its sender whoever spoke; the kernel also
 * sends one on a person's doing (a decision they took back), which carries that person's principal but says nothing
 * they said. Read it together with the kind of principal.
 */
export function speaks(env: Envelope): boolean {
  return env.type !== PAYLOAD.cellMessage || (env.payload as { fromCellId?: unknown }).fromCellId === env.principalId;
}

export function describeEnvelopeSource(env: Envelope | undefined, now: number): ItemSource {
  if (!env) return { label: "系统", at: now };
  const base = { principalId: env.principalId, envelopeId: env.id, at: env.createdAt };
  if (isEnvelopeOfType(env, "source.hit")) {
    return { ...base, label: `信源 · ${env.payload.title}`, ...(env.payload.uri ? { uri: env.payload.uri } : {}) };
  }
  const from = parseAddress(env.from);
  if (from?.kind === "channel") return { ...base, label: CHANNEL_LABELS[from.channelId] ?? from.channelId, channelId: from.channelId };
  if (from?.kind === "inbox") return { ...base, label: "后台分身" };
  if (env.from.startsWith("timer:")) return { ...base, label: "定时提醒" };
  if (env.from === KERNEL_FROM.control && speaks(env)) return { ...base, label: env.principalId.startsWith("agent:") ? "编码助手" : "对话" };
  return { ...base, label: "系统" };
}
