import { parseAddress, anyCovers, type ProposedAction, type PolicyBounds } from "@ng/protocol";

export { actionShapeFeedback, ownerOnlyApproval } from "@ng/protocol";

export function requiresApproval(action: ProposedAction): boolean {
  return action.type !== "custom" || action.name === "kernel.escalation" || action.sideEffect === "external";
}

export function deliveryAllowed(bounds: Pick<PolicyBounds, "canSendTo">, parentCellId: string | null, addr: string): boolean {
  if (typeof addr !== "string" || addr.endsWith("*") || parseAddress(addr) === null) return false;
  if (parentCellId && addr === `inbox:${parentCellId}`) return true;
  return anyCovers(bounds.canSendTo, addr);
}
