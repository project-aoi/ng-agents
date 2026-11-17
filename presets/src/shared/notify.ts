import { anyCovers, type ChannelAddr, type RunPorts, type SendReceipt } from "@ng/protocol";

/**
 * A light notification to the owner ("已存入阅读清单"): Gate classifies it notify_owner and allows it without a card;
 * the hub buffers it during focus time. `key` must be stable across retries of the same Run (the hub dedupes on it).
 * Returns null when this cell may not reach the owner (only the desk may).
 */
export async function notifyOwner(ports: RunPorts, to: ChannelAddr, text: string, key: string): Promise<SendReceipt | null> {
  if (!anyCovers(ports.self.bounds.canSendTo, to)) return null;
  const content = { format: "text" as const, body: text };
  const r = await ports.authorize({ type: "channel.send", target: to, content, summary: text, subjectKey: `notice:${key}`, sideEffect: "notify_owner" });
  if (r.type !== "allow") return null;
  return ports.notifyChannel({ target: to, content, idempotencyKey: `notice:${ports.self.cellId}:${key}`, actionToken: r.actionToken, respectDnd: true });
}
