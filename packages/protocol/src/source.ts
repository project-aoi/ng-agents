import { parseAddress, KERNEL_FROM } from "./address";
import { isEnvelopeOfType } from "./payloads";
import type { ItemSource } from "./gtd";
import type { Envelope } from "./contract/envelope";
export const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  ui: "随手记",
  cli: "命令行",
  feishu: "飞书",
  slack: "Slack",
  github: "GitHub",
  webhook: "Webhook",
  email: "邮件",
  memory: "测试通道",
  demo: "演示 IM",
};

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
  if (env.from === KERNEL_FROM.control) return { ...base, label: env.principalId.startsWith("agent:") ? "外部助手" : "对话" };
  return { ...base, label: "系统" };
}
