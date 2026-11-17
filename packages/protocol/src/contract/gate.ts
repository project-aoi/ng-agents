import type { ProjectProposal } from "../gtd";
import { sha256Hex, stableStringify } from "../json";
import type { CellSpec } from "./cell";
import type { SendReceipt } from "./channel";
import type { Deliverable } from "./deliverable";
import type { ChannelAddr, PolicyBounds, ToolKind } from "./envelope";
import type { ControlAction } from "./inbox";

// docs/02 §二 — ⑥ Gate, verbatim (comments translated). Extensions follow the `[ext]` marker.

// ==================== ⑥ Gate: monotonic narrowing, secret proxy, draft-version-bound approvals and budget ====================
export interface Gate {
  attenuate(parent: PolicyBounds, parentCellId: string, requested?: Partial<PolicyBounds>): PolicyBounds; // enforces child ⊆ parent and maxDepth - 1
  authorize(action: ProposedAction, meta: {
    cellId: string;
    principalId: string;
    epoch: number;                      // checks the Cell has not been cancelled
    artifactVersion?: number;           // binds the exact draft version when sending/executing it externally
  }): Promise<
    | { type: "allow"; actionToken: string; proxyInjectedSecretRef?: string }
    | { type: "deny"; feedback: string }
    | { type: "defer"; actionId: string; boundArtifactVersion?: number; approvalCard: Deliverable }
  >;
  // synchronous UI confirmation: checks the draft version seen at click time; if the background just refreshed it, returns version_mismatch (no blind send)
  approve(actionId: string, approverId: string, seenArtifactVersion?: number): Promise<
    "approved" | "version_mismatch" | "already_cancelled" | "not_found" /* [ext] not_found */
  >;
  revoke(cellId: string): Promise<void>;
  meter(cellId: string, usage: { tokens: number; billedCents: number }): "ok" | "warn" | "hard_stop";

  // [ext] attenuate semantics (never widens, clamps instead of failing):
  //   omitted field → tools = parent.tools, canSendTo = [inbox:<parentCellId>], secretRefs = ∅,
  //   isolation = parent.isolation, maxConcurrentChildren / maxTokens / maxCents = parent's, maxDepth = parent.maxDepth − 1;
  //   requested field → intersected with / clamped to the parent's (isolation = the stronger of the two; an unknown
  //   level clamps to the strongest). `inbox:<parentCellId>` is always kept in canSendTo (a child can always report back).
  //   maxTokens / maxCents are further capped by what the parent and every ancestor still have left in the ledger.
  //   When parentCellId is a stored cell, the passed bounds are first met with its stored bounds.
  //   Throws NgError("bounds_violation") only when parent.maxDepth < 1. Result satisfies
  //   isSubsetBounds(result, parent, { parentCellId }).
  //
  // [ext] authorize policy (in order): malformed action/meta → deny; unknown cell, cell or any ancestor
  //   revoked / not active, meta.epoch ≠ current epoch, or principal `cell:<other>` → deny;
  //   action outside bounds (send target ∉ canSendTo, tool ∉ tools, secretRef ∉ secretRefs or not configured, spawn with
  //   maxDepth 0 or at maxConcurrentChildren, control of a non-descendant) → deny with feedback; ledger hard_stop of the
  //   cell or any ancestor → deny; draft artifact unknown / outside the cell's lineage / version out of range → deny;
  //   effective sideEffect = max(declared, derived from the action) (a channel.send outside the owner's addresses is
  //   always external; project.start is always external); an enabled matching PolicyRule decides (most specific first);
  //   otherwise none/internal/notify_owner → allow, external → defer (approval row + card).
  //   Every allow mints a single-use token bound to hashAction(action).

  // ---------- [ext] sync twins (the async methods delegate to these) ----------
  authorizeSync(action: ProposedAction, meta: AuthorizeMeta): AuthorizeResult;
  approveSync(actionId: string, approverId: string, seenArtifactVersion?: number): ApproveResult;
  /** Invalidate the cell's unused tokens and cancel its pending approvals (cancel/close). */
  revokeSync(cellId: string): void;

  // ---------- [ext] approvals administration (sync-only; the UI's synchronous transaction API) ----------
  listPendingSync(filter?: PendingFilter): ApprovalRecord[];
  getApprovalSync(actionId: string): ApprovalRecord | undefined;
  findPendingBySubjectSync(subjectKey: string): ApprovalRecord | undefined;
  /** Card leaves the Clarify stack until `until` (status stays pending). */
  snoozeSync(actionId: string, until: number): "snoozed" | "not_pending";
  denySync(actionId: string, approverId: string, reason?: string): "denied" | "not_pending";
  /** Auto-withdraw (e.g. someone already answered in the group): pending → cancelled with a reason. */
  withdrawSync(actionId: string, reason: string): "cancelled" | "not_pending";
  /** Cancel every pending approval of a cell; returns the count. */
  cancelForCellSync(cellId: string, reason: string): number;
  /** Kernel records the result of executing an approved action. */
  recordOutcomeSync(actionId: string, status: "executed" | "failed" | "unknown", outcome: ApprovalOutcome): void;
  /** [ext] Re-bind a pending card to another existing version of its draft (the draft was revised). */
  rebindSync(actionId: string, version: number): "rebound" | "not_pending";
  /** [ext] Any approvals by status/cell, newest first (e.g. `unknown` sends that must stay visible). */
  listApprovalsSync(filter?: ApprovalFilter): ApprovalRecord[];

  // ---------- [ext] action tokens ----------
  /** Mint a token for an `approved` approval, bound to the final operative action (e.g. channel.send with the bound version's content). */
  issueTokenSync(actionId: string, action: ProposedAction): string;
  /** Single-use: a successful check consumes the token. Fails if expired, used, revoked, epoch moved, or hashAction differs. */
  verifyTokenSync(token: string, action: ProposedAction): TokenCheck;
  /**
   * [ext] Host-side secret proxy: consumes a token minted by an `allow` for a `secret.use` action and returns the secret
   * value. Never call this from anything whose result flows back into a Loop. Throws NgError (message never contains
   * the value) if the token is invalid, the ref left the cell's bounds, or the store has no value.
   */
  injectSecretSync(token: string, expectedSecretRef?: string): string;

  // ---------- [ext] control bypass authorization (implements ControlAuthorizer) ----------
  /** owner principal: any cell; `cell:<id>`: only its strict descendants; anyone else: refused. */
  authorizeControlSync(cellId: string, principalId: string, action: ControlAction): { ok: true } | { ok: false; reason: string };

  // ---------- [ext] dual ledger ----------
  usageSync(cellId: string): LedgerUsage;
  /** Human-granted extra allowance for one cell ("追加额度继续"). */
  raiseBudgetSync(cellId: string, add: { tokens?: number; cents?: number }, approverId: string): LedgerUsage;

  // ---------- [ext] policy rules: trust grows gradually (docs/03 principle 4) ----------
  listPolicyRulesSync(): PolicyRule[];
  upsertPolicyRuleSync(rule: PolicyRuleInput): PolicyRule;
  deletePolicyRuleSync(id: string): void;
  approvalStatsSync(): ApprovalStat[];
  /** Action classes the human approved unedited at least `minStreak` times in a row and that have no allow rule yet. */
  trustCandidatesSync(minStreak?: number): ApprovalStat[];
}

// ==================== [ext] types ====================

export type SideEffect = "none" | "internal" | "notify_owner" | "external";

interface ActionBase {
  summary: string;                      // one human-readable line (card title fallback, audit log)
  subjectKey: string;                   // the item this action belongs to; at most one pending approval per subjectKey
  /**
   * none: pure read/compute · internal: touches only this system (notes, cells, inbox) ·
   * notify_owner: a non-urgent message to the owner's own channel · external: anything another human or system sees.
   * Default policy: none/internal/notify_owner → allow (within bounds); external → defer unless a policy rule allows.
   */
  sideEffect: SideEffect;
  urgent?: boolean;                     // channel sends only: bypass DND buffering
  card?: Deliverable;                   // the approval card to show if deferred (format "card", data: ClarifyCard); Gate builds a plain one from `summary` if absent
  /** [ext] (was on ChannelSendAction only) draft this action carries out — a reply draft, a project proposal; Gate binds approvals to its version (meta.artifactVersion). */
  artifactId?: string;
}

export interface ChannelSendAction extends ActionBase {
  type: "channel.send";
  target: ChannelAddr;
  content?: Deliverable;                // required to obtain a token; for a draft send it is the bound artifact version's content
}
export interface WorkspaceExecAction extends ActionBase {
  type: "workspace.exec";
  tool: ToolKind;
  args: unknown;
}
export interface JobStartAction extends ActionBase {
  type: "job.start";
  command: string;
}
export interface CellSpawnAction extends ActionBase {
  type: "cell.spawn";
  spec: CellSpec;
  initialPayload?: unknown;
}
export interface CellControlAction extends ActionBase {
  type: "cell.control";
  targetCellId: string;
  action: ControlAction;
  steerMessage?: string;
}
export interface SecretUseAction extends ActionBase {
  type: "secret.use";
  secretRef: string;
  tool?: ToolKind;
  purpose?: string;
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

export type ProposedAction =
  | ChannelSendAction
  | WorkspaceExecAction
  | JobStartAction
  | CellSpawnAction
  | CellControlAction
  | SecretUseAction
  | ProjectStartAction
  | CustomAction;

export type ProposedActionType = ProposedAction["type"];

export interface AuthorizeMeta {
  cellId: string;
  principalId: string;
  epoch: number;
  artifactVersion?: number;
}

export type AuthorizeResult =
  | { type: "allow"; actionToken: string; proxyInjectedSecretRef?: string }
  | { type: "deny"; feedback: string }
  | { type: "defer"; actionId: string; boundArtifactVersion?: number; approvalCard: Deliverable };

/**
 * approve rules:
 * - not pending: approved/executed/failed/unknown → "approved" (idempotent); denied/cancelled/superseded → "already_cancelled".
 * - bound to an artifact: `seenArtifactVersion` must equal the artifact's *current* version, else "version_mismatch"
 *   (undefined counts as a mismatch). On success bound_version := seen, and human_edited records whether any
 *   version after the originally bound one was written by a human.
 * - the cell's epoch must still equal the approval's epoch, else the approval is cancelled → "already_cancelled".
 *   [ext] Likewise (cancelled → "already_cancelled") when the cell is gone, closed or revoked, the bound draft no longer
 *   exists, or the action is no longer within the cell's current bounds. The mismatch re-binds the row to the current
 *   version, so the next click on the refreshed card can pass. A paused cell can still be approved.
 */
export type ApproveResult = "approved" | "version_mismatch" | "already_cancelled" | "not_found";

export type ApprovalStatus = "pending" | "approved" | "denied" | "cancelled" | "superseded" | "executed" | "failed" | "unknown";

export interface ApprovalOutcome {
  receipt?: SendReceipt;                // channel.send executions
  result?: unknown;
  error?: string;
  note?: string;
}

/**
 * One row per deferred action = one Clarify card while `pending`.
 * A second defer for a subjectKey that already has a pending row from the same cell and action type updates that row
 * in place (same actionId; new action/card/bound version) — the card simply shows the new draft version.
 * [ext] …provided the epoch is the same and the operative action is unchanged apart from the bound draft's content
 * (approve only re-checks the draft version, so a new target or a revised proposal must be a new card).
 * Otherwise the old pending row becomes `superseded`.
 */
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

export interface Usage {
  tokens: number;
  billedCents: number;
}

export type MeterResult = "ok" | "warn" | "hard_stop";

/**
 * Own usage is this cell's Runs; subtree usage includes all descendants. Effective limits = bounds.max* + raised.
 * meter() returns hard_stop if the cell or any ancestor has subtree usage ≥ its effective limit; warn at ≥ 80%.
 * A limit of 0 is therefore exhausted from the start (a cell meant to spend nothing on paid models still needs maxCents > 0
 * if it is to act at all; subscription models that bill $0 are governed by maxTokens).
 */
export interface LedgerUsage {
  cellId: string;
  ownTokens: number;
  ownCents: number;
  subtreeTokens: number;
  subtreeCents: number;
  limitTokens: number;
  limitCents: number;
  raisedTokens: number;
  raisedCents: number;
  /** Worst state over this cell and its ancestors (what meter/authorize act on). */
  state: MeterResult;
  /** [ext] Nearest cell (self or ancestor) whose ledger causes `state`; null when ok. Raise *that* cell's budget to continue. */
  limitedBy: string | null;
}

export type TokenCheck =
  | { ok: true; cellId: string; actionId: string | null }
  | { ok: false; reason: "unknown" | "expired" | "used" | "revoked" | "mismatch" | "stale_epoch" };

/**
 * `match.target` is an address/tool/secret pattern; a trailing `*` is a prefix wildcard (same rule as canSendTo).
 * `scopeCellId` limits the rule to that cell's subtree (null = everywhere).
 * `maxUses`: auto-allow at most this many times (null = unlimited) — "auto-execute with a budget cap".
 */
export interface PolicyRule {
  id: string;
  match: { type: ProposedActionType | "*"; target?: string };
  effect: "allow" | "defer" | "deny";
  scopeCellId: string | null;
  maxUses: number | null;
  uses: number;
  note: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export type PolicyRuleInput = Pick<PolicyRule, "match" | "effect" | "createdBy"> &
  Partial<Pick<PolicyRule, "id" | "scopeCellId" | "maxUses" | "note" | "enabled">>;

/** Keyed by `actionClassOf(action)`. */
export interface ApprovalStat {
  actionClass: string;
  approved: number;
  approvedUnedited: number;
  uneditedStreak: number;
  denied: number;
  lastDecidedAt: number | null;
  suggestedAt: number | null;           // last time the weekly review offered to auto-allow this class
}

// ==================== [ext] pure helpers ====================

const PRESENTATIONAL_KEYS = new Set(["summary", "subjectKey", "sideEffect", "urgent", "card", "artifactId"]);

/** The fields that determine what an action *does*; tokens are bound to these. */
export function operativeAction(action: ProposedAction): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action)) if (!PRESENTATIONAL_KEYS.has(k)) out[k] = v;
  return out;
}

/** sha256 over the stable JSON of `operativeAction(action)`. For channel.send that is `{type, target, content}`. */
export function hashAction(action: ProposedAction): string {
  return sha256Hex(stableStringify(operativeAction(action)));
}

/** Coarse class used for approval statistics and policy suggestions, e.g. `channel.send|channel:feishu:*`. */
export function actionClassOf(action: ProposedAction): string {
  switch (action.type) {
    case "channel.send": {
      const [, channelId] = action.target.split(":");
      return `channel.send|channel:${channelId}:*`;
    }
    case "workspace.exec":
      return `workspace.exec|${action.tool}`;
    case "secret.use":
      return `secret.use|${action.secretRef}`;
    case "cell.control":
      return `cell.control|${action.action}`;
    case "custom":
      return `custom|${action.name}`;
    default:
      return action.type;
  }
}

/** The pattern-matchable target of an action for PolicyRule.match.target. */
export function actionTargetOf(action: ProposedAction): string | null {
  switch (action.type) {
    case "channel.send":
      return action.target;
    case "workspace.exec":
      return action.tool;
    case "secret.use":
      return action.secretRef;
    case "cell.control":
      return action.targetCellId;
    case "custom":
      return action.name;
    case "job.start":
      return action.command;
    default:
      return null;
  }
}
