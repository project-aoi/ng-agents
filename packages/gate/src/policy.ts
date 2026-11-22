import { parseAddress, anyCovers, type PolicyBounds, type ProposedAction } from "@ng/protocol";

const ACTION_TYPES = ["project.start", "custom"];
const SIDE_EFFECTS = ["none", "internal", "notify_owner", "external"];
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Shape check of the common fields; returns model-facing feedback, or null when well-formed. */
export function actionShapeFeedback(action: unknown): string | null {
  if (!isObject(action)) return "invalid action: expected an object";
  if (!(ACTION_TYPES as readonly unknown[]).includes(action["type"])) return `invalid action: unknown type ${JSON.stringify(action["type"])}`;
  if (typeof action["summary"] !== "string") return "invalid action: summary must be a string";
  if (!isNonEmptyString(action["subjectKey"])) return "invalid action: subjectKey must be a non-empty string (the item this action belongs to)";
  if (!(SIDE_EFFECTS as readonly unknown[]).includes(action["sideEffect"])) {
    return `invalid action: sideEffect must be one of ${SIDE_EFFECTS.join(", ")}`;
  }
  if (action["artifactId"] !== undefined && !isNonEmptyString(action["artifactId"])) return "invalid action: artifactId must be a non-empty string";
  if (action["type"] === "project.start" && (!isObject(action["proposal"]) || !isNonEmptyString(action["proposal"]["title"]))) return "project.start proposal needs a title";
  if (action["type"] === "custom" && !isNonEmptyString(action["name"])) return "custom action needs a name";
  return null;
}

export function ownerOnlyApproval(action: ProposedAction): string | null {
  return action["type"] === "project.start" ? "it starts a new project" : null;
}

export function deliveryAllowed(bounds: Pick<PolicyBounds, "canSendTo">, parentCellId: string | null, addr: string): boolean {
  if (typeof addr !== "string" || addr.endsWith("*") || parseAddress(addr) === null) return false;
  if (parentCellId && addr === `inbox:${parentCellId}`) return true;
  return anyCovers(bounds.canSendTo, addr);
}
