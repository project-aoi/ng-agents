import { deliverableSchema, type Deliverable, type ProposedAction } from "@ng/protocol";


export function describeAction(action: ProposedAction): string {
  switch (action.type) {
    case "project.start":
      return `立项：${action.proposal.title}`;
    case "custom":
      return `执行 ${action.name}`;
  }
}

/** The card shown to the owner: the caller's own Deliverable when it is valid, otherwise a plain one built from the action. */
export function approvalCardFor(action: ProposedAction): Deliverable {
  if (action.card !== undefined && deliverableSchema.safeParse(action.card).success) return action.card;
  const lines = [action.summary || describeAction(action), describeAction(action)];
  return { format: "card", title: action.summary || describeAction(action), body: [...new Set(lines.slice(0, 2)), ...lines.slice(2)].join("\n") };
}
