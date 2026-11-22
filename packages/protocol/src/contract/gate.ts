import { isProjectProposal, type ProjectProposal } from "../gtd";
import { sha256Hex, stableStringify } from "../json";
import type { Deliverable } from "./deliverable";
import type { PolicyBounds } from "./envelope";
import type { ControlAction } from "./inbox";

export interface Gate {
  attenuate(parent: PolicyBounds, parentCellId: string, requested?: Partial<PolicyBounds>): PolicyBounds; // enforces child ⊆ parent and maxDepth - 1
  authorizeSync(action: ProposedAction, meta: AuthorizeMeta): AuthorizeResult;
  approveSync(actionId: string, approverId: string, seenArtifactVersion?: number, opts?: { seenItemRevision?: number }): ApproveResult;
  revokeSync(cellId: string): void;
  reinstateSync(cellId: string): void;
  listPendingSync(filter?: PendingFilter): ApprovalRecord[];
  getApprovalSync(actionId: string): ApprovalRecord | undefined;
  findPendingBySubjectSync(subjectKey: string, cellId: string): ApprovalRecord | undefined;
  snoozeSync(actionId: string, until: number, opts?: { seenItemRevision?: number; approverId?: string }): "snoozed" | "not_pending" | "revision_mismatch";
  denySync(actionId: string, approverId: string, reason?: string, opts?: { seenItemRevision?: number }): "denied" | "not_pending" | "revision_mismatch";
  /** Record an accepted revise instruction against a pending card: checks & increments itemRevision in the same tx. */
  reviseSync(
    actionId: string,
    approverId: string,
    opts?: { seenItemRevision?: number; seenArtifactVersion?: number },
  ): "revised" | "not_pending" | "version_mismatch" | "revision_mismatch";
  withdrawSync(actionId: string, reason: string, opts?: { seenItemRevision?: number }): "cancelled" | "not_pending" | "revision_mismatch";
  recordOutcomeSync(actionId: string, status: "executed", outcome: ApprovalOutcome): void;
  listApprovalsSync(filter?: ApprovalFilter): ApprovalRecord[];
  authorizeControlSync(cellId: string, principalId: string, action: ControlAction): { ok: true } | { ok: false; reason: string };
}

export type SideEffect = "none" | "internal" | "notify_owner" | "external";

interface ActionBase {
  cardOptions?: import("../human-item").CardOption[];
  relatedProjectIds?: string[];

  summary: string;                      // one human-readable line (card title fallback, audit log)
  subjectKey: string;                   // the item this action belongs to; at most one pending approval per subjectKey
  sideEffect: SideEffect;
  card?: Deliverable;                   // the approval card to show if deferred (format "card", data: DecisionCard); Gate builds a plain one from `summary` if absent
  artifactId?: string;
}

export interface ProjectStartAction extends ActionBase {
  type: "project.start";
  proposal: ProjectProposal;
}
export interface CustomAction extends ActionBase {
  type: "custom";
  name: string;
  args?: unknown;
}

export type ProposedAction = ProjectStartAction | CustomAction;
export type ProposedActionType = ProposedAction["type"];

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
  if (action["type"] === "project.start" && !isProjectProposal(action["proposal"])) return "project.start needs a valid proposal with a title, outcome and actions";
  if (action["type"] === "custom" && !isNonEmptyString(action["name"])) return "custom action needs a name";
  return null;
}

export function acceptsApprovalDraft(type: ProposedAction["type"], format: Deliverable["format"], data: unknown): boolean {
  return type !== "project.start" || (format === "json" && isProjectProposal(data));
}

export function ownerOnlyApproval(action: ProposedAction): string | null {
  return action["type"] === "project.start" ? "it starts a new project" : null;
}

export interface AuthorizeMeta {
  cellId: string;
  principalId: string;
  epoch: number;
  artifactVersion?: number;
}

export type AuthorizeResult =
  | { type: "allow" }
  | { type: "deny"; feedback: string }
  | { type: "defer"; actionId: string; boundArtifactVersion?: number; approvalCard: Deliverable };
export type ApproveResult = "approved" | "version_mismatch" | "revision_mismatch" | "already_cancelled" | "not_found";

export type ApprovalStatus = "pending" | "approved" | "denied" | "cancelled" | "superseded" | "executed";

export interface ApprovalOutcome {
  result?: unknown;
  error?: string;
  note?: string;
}
export interface ApprovalRecord {
  actionId: string;
  cellId: string;
  epoch: number;                        // cell epoch at defer time
  principalId: string;                  // who asked (usually `cell:<id>`)
  subjectKey: string;
  action: ProposedAction;
  card: Deliverable;
  artifactId: string | null;
  boundVersion: number | null;
  proposedVersion: number | null;       // [ext] version proposed by the agent (used to compute human edit diff)
  itemRevision: number;                 // [ext] card-level optimistic lock; bumped on every accepted decision/update
  status: ApprovalStatus;
  statusReason: string | null;          // [ext] why it was denied / cancelled / superseded (e.g. "someone already answered")
  snoozedUntil: number | null;
  approverId: string | null;
  humanEdited: boolean;
  outcome: ApprovalOutcome | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface PendingFilter {
  cellIds?: readonly string[];
  /** Default false: cards snoozed past `now` are hidden. */
  includeSnoozed?: boolean;
  now?: number;
  limit?: number;
}

/** [ext] */
export interface ApprovalFilter {
  status?: readonly ApprovalStatus[];
  cellIds?: readonly string[];
  subjectKey?: string;
  limit?: number;
}


export function hashAction(action: ProposedAction): string {
  return sha256Hex(stableStringify(action.type === "project.start" ? { type: action.type, proposal: action.proposal } : { type: action.type, name: action.name, args: action.args }));
}
