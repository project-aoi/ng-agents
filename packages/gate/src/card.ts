import { deliverableSchema, type Deliverable, type ProposedAction } from "@ng/protocol";

const CONTROL_LABEL = { cancel: "停止", pause: "暂停", resume: "恢复", steer: "传话给" } as const;

/** One line (Chinese, user-facing) saying what approving the action will do. Never includes secret values (Gate never has them here). */
export function describeAction(action: ProposedAction): string {
  switch (action.type) {
    case "channel.send":
      return `对外发送到 ${action.target}`;
    case "secret.use":
      return `使用密钥 ${action.secretRef}${action.purpose ? `（${action.purpose}）` : ""}`;
    case "project.start":
      return `立项：${action.proposal.title}`;
    case "custom":
      return `执行 ${action.name}`;
  }
}

/** The card shown in Clarify: the caller's own Deliverable when it is valid, otherwise a plain one built from the action. */
export function approvalCardFor(action: ProposedAction): Deliverable {
  if (action.card !== undefined && deliverableSchema.safeParse(action.card).success) return action.card;
  const lines = [action.summary || describeAction(action), describeAction(action)];
  if (action.type === "channel.send" && action.content) lines.push("", action.content.body);
  return { format: "card", title: action.summary || describeAction(action), body: [...new Set(lines.slice(0, 2)), ...lines.slice(2)].join("\n") };
}
