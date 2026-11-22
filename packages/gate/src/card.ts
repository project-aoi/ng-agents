import { deliverableSchema, type Deliverable, type ProposedAction } from "@ng/protocol";


export function describeAction(action: ProposedAction): string {
  return action.summary || (action.type === "custom" ? action.name : action.type);
}

/** The card shown to the owner: the caller's own Deliverable when it is valid, otherwise a plain one built from the action. */
export function approvalCardFor(action: ProposedAction): Deliverable {
  if (action.card !== undefined && deliverableSchema.safeParse(action.card).success) return action.card;
  const description = describeAction(action);
  return { format: "card", title: description, body: description };
}
