import { randomBytes } from "node:crypto";
import {
  checkCardOptions,
  projectCellIdOf,
  NgError,
  OWNER_PRINCIPAL,
  actionClassOf,
  addressCovers,
  afterCommit,
  all,
  artifactsRepo,
  boundsViolations,
  cellsRepo,
  fromJson,
  get,
  hashAction,
  newId,
  operativeAction,
  parsePrincipal,
  run,
  sha256Hex,
  stableStringify,
  systemClock,
  toBool,
  toJson,
  withTx,
  type CardOption,
  type ApprovalFilter,
  type ApprovalOutcome,
  type ApprovalRecord,
  type ApprovalStat,
  type ApprovalStatus,
  type ApproveResult,
  type AuthorizeMeta,
  type AuthorizeResult,
  type BudgetRaise,
  type Bus,
  type CellRecord,
  type Clock,
  type ControlAction,
  type Db,
  type Deliverable,
  type Gate,
  type LedgerUsage,
  type LedgerViewOptions,
  type MeterResult,
  type PendingFilter,
  type PolicyRule,
  type PolicyRuleInput,
  type ProposedAction,
  type SqlParam,
  type TokenCheck,
} from "@ng/protocol";
import { attenuateBounds, meetBounds } from "./attenuate";
import { approvalCardFor } from "./card";
import {
  ACTION_TYPES,
  isBudgetEscalation,
  actionShapeFeedback,
  boundsFeedback,
  effectiveSideEffect,
  ownerOnlyApproval,
  parseActionClass,
  pickRule,
  type BoundsContext,
} from "./policy";
import { envSecretStore, redactSecrets, type SecretStore } from "./secrets";

/** Owner-facing channels: a channel.send to these is `notify_owner` (no card); anything else is `external`. */
export const DEFAULT_OWNER_ADDRESSES: readonly string[] = ["channel:ui:*", "channel:cli:*"];
export const DEFAULT_TOKEN_TTL_MS = 10 * 60_000;
export const DEFAULT_TRUST_STREAK = 5;
/** What a prompt-cache read costs against a token limit, relative to an uncached token (providers bill it at about a tenth). */
export const DEFAULT_CACHE_READ_WEIGHT = 0.1;
/** The wrap-up allowance (LedgerViewOptions.wrapUp): this share of a limit, at most these absolute amounts. */
export const DEFAULT_WRAP_UP = { ratio: 0.05, maxTokens: 200_000, maxCents: 200 } as const;
const CONTROL_ACTIONS: readonly ControlAction[] = ["cancel", "pause", "resume", "steer"];
const TOKEN_PREFIX = "ngt_";

export interface GateOptions {
  onSuperseded?(old: ApprovalRecord, principalId: string): void;
  db: Db;
  bus: Bus;
  clock?: Clock;
  /** Default: envSecretStore() — `NG_SECRET_<REF>` environment variables. */
  secrets?: SecretStore;
  /** Principal of the human owner (default "owner"): may control any cell. */
  ownerPrincipal?: string;
  /** Address patterns (trailing `*` = prefix) of the owner's own channels. Default DEFAULT_OWNER_ADDRESSES. */
  ownerAddresses?: readonly string[];
  tokenTtlMs?: number;
  /** Fraction of a limit at which meter() starts returning "warn". Default 0.8. */
  warnRatio?: number;
  /** Default `minStreak` of trustCandidatesSync. */
  trustStreak?: number;
  /** Charge of one prompt-cache read token against token limits, 0..1. Default DEFAULT_CACHE_READ_WEIGHT. */
  cacheReadWeight?: number;
  /** Overrides of DEFAULT_WRAP_UP; `ratio: 0` switches the allowance off. */
  wrapUp?: Partial<{ ratio: number; maxTokens: number; maxCents: number }>;
  /**
   * The owner's switch for budget limits, read on every decision. `false` = limits are off: usage is metered into the
   * ledgers exactly as before (so what was spent stays visible), but no ledger is ever in "warn" or "hard_stop" — no
   * alert, no denied action, no stopped Run. Default: always enforced.
   */
  budgetEnforced?: () => boolean;
  setBudgetPaused?: (cellId:string, paused:boolean, actor:string) => void;
}

/** The Gate contract plus maintenance helpers that only the kernel/app use. */
export interface GateService extends Gate {
  /** Deletes tokens that expired, were used or were revoked more than `olderThanMs` ago (default 1 day). Returns the count. */
  pruneTokensSync(olderThanMs?: number): number;
  /** Records that the weekly review offered these action classes for auto-approval (ApprovalStat.suggestedAt). */
  markTrustSuggestedSync(actionClasses: readonly string[], at?: number): void;
}

// ==================== rows ====================

const approvalSelect = `SELECT action_id,cell_id,epoch,principal_id,subject_key,action_type,action,action_hash,card,artifact_id,bound_version,proposed_version,item_revision,disposition AS status,status_reason,snoozed_until,approver_id,human_edited,outcome,created_at,updated_at,resolved_at FROM human_items`;

interface ApprovalRow {
  action_id: string;
  cell_id: string;
  epoch: number;
  principal_id: string;
  subject_key: string;
  action_type: string;
  action: string;
  action_hash: string;
  card: string;
  artifact_id: string | null;
  bound_version: number | null;
  proposed_version: number | null;
  item_revision: number;
  status: ApprovalStatus;
  status_reason: string | null;
  snoozed_until: number | null;
  approver_id: string | null;
  human_edited: number;
  outcome: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

interface LedgerRow {
  cell_id: string;
  own_tokens: number;
  own_cents: number;
  subtree_tokens: number;
  subtree_cents: number;
  raised_tokens: number;
  raised_cents: number;
  warned_at: number | null;
  stopped_at: number | null;
  revoked_at: number | null;
}

interface TokenRow {
  token_hash: string;
  action_hash: string;
  action_id: string | null;
  cell_id: string;
  epoch: number;
  secret_ref: string | null;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}

interface RuleRow {
  id: string;
  action_type: string;
  target_pattern: string | null;
  effect: PolicyRule["effect"];
  scope_cell_id: string | null;
  max_uses: number | null;
  uses: number;
  note: string | null;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface StatRow {
  action_class: string;
  approved: number;
  approved_unedited: number;
  unedited_streak: number;
  denied: number;
  last_decided_at: number | null;
  suggested_at: number | null;
}

function toApproval(r: ApprovalRow): ApprovalRecord {
  return {
    actionId: r.action_id,
    cellId: r.cell_id,
    epoch: r.epoch,
    principalId: r.principal_id,
    subjectKey: r.subject_key,
    action: fromJson<ProposedAction>(r.action),
    card: fromJson<Deliverable>(r.card),
    artifactId: r.artifact_id,
    boundVersion: r.bound_version,
    proposedVersion: r.proposed_version,
    itemRevision: r.item_revision,
    status: r.status,
    statusReason: r.status_reason,
    snoozedUntil: r.snoozed_until,
    approverId: r.approver_id,
    humanEdited: toBool(r.human_edited),
    outcome: r.outcome === null ? null : fromJson<ApprovalOutcome>(r.outcome),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}

function toRule(r: RuleRow): PolicyRule {
  const match: PolicyRule["match"] = { type: r.action_type as PolicyRule["match"]["type"] };
  if (r.target_pattern !== null) match.target = r.target_pattern;
  return {
    id: r.id,
    match,
    effect: r.effect,
    scopeCellId: r.scope_cell_id,
    maxUses: r.max_uses,
    uses: r.uses,
    note: r.note,
    enabled: toBool(r.enabled),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toStat(r: StatRow): ApprovalStat {
  return {
    actionClass: r.action_class,
    approved: r.approved,
    approvedUnedited: r.approved_unedited,
    uneditedStreak: r.unedited_streak,
    denied: r.denied,
    lastDecidedAt: r.last_decided_at,
    suggestedAt: r.suggested_at,
  };
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const STATE_RANK: Readonly<Record<MeterResult, number>> = { ok: 0, warn: 1, hard_stop: 2 };

function withoutCard(action: ProposedAction): ProposedAction {
  const { card: _card, ...rest } = action;
  return rest as ProposedAction;
}

/**
 * Whether a re-defer may update a pending card in place: approve() only re-checks the draft version, so anything else
 * that changes what the card does (another target, a revised proposal) must become a new card instead.
 */
function sameEffectExceptDraft(previous: ProposedAction, previousArtifactId: string | null, next: ProposedAction): boolean {
  const ignoreContent = previousArtifactId !== null && next.artifactId === previousArtifactId;
  const strip = (a: ProposedAction) => {
    const op = operativeAction(a);
    if (ignoreContent) delete op["content"];
    return stableStringify(op);
  };
  return strip(previous) === strip(next);
}

// ==================== factory ====================

export function createGate(opts: GateOptions): GateService {
  const { db, bus } = opts;
  const clock = opts.clock ?? systemClock;
  const secrets = opts.secrets ?? envSecretStore();
  const ownerPrincipal = opts.ownerPrincipal ?? OWNER_PRINCIPAL;
  const ownerAddresses = [...(opts.ownerAddresses ?? DEFAULT_OWNER_ADDRESSES)];
  const tokenTtlMs = opts.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const warnRatio = opts.warnRatio ?? 0.8;
  const trustStreak = opts.trustStreak ?? DEFAULT_TRUST_STREAK;
  const finiteOr = (v: number | undefined, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : fallback);
  const cacheReadWeight = Math.min(1, finiteOr(opts.cacheReadWeight, DEFAULT_CACHE_READ_WEIGHT));
  const enforced = () => opts.budgetEnforced?.() !== false;
  const wrapUp = {
    ratio: finiteOr(opts.wrapUp?.ratio, DEFAULT_WRAP_UP.ratio),
    maxTokens: finiteOr(opts.wrapUp?.maxTokens, DEFAULT_WRAP_UP.maxTokens),
    maxCents: finiteOr(opts.wrapUp?.maxCents, DEFAULT_WRAP_UP.maxCents),
  };
  const cells = cellsRepo(db, clock);
  const artifacts = artifactsRepo(db);
  /** value → ref of every secret handed out by injectSecret in this process (for scrubbing persisted text). */
  const injected = new Map<string, string>();

  // ---------- secrets hygiene ----------

  function knownSecretValues(): Map<string, string> {
    const out = new Map(injected);
    for (const ref of secrets.refs?.() ?? []) {
      const v = secrets.get(ref);
      if (v) out.set(v, ref);
    }
    return out;
  }
  const redact = <T>(value: T): T => redactSecrets(value, knownSecretValues());

  // ---------- events ----------

  function emitApproval(row: Pick<ApprovalRow, "action_id" | "cell_id" | "subject_key">, status: ApprovalStatus): void {
    afterCommit(db, () =>
      bus.emit("approval.changed", { actionId: row.action_id, cellId: row.cell_id, subjectKey: row.subject_key, status }),
    );
  }

  // ---------- cell tree ----------

  /** [cell, parent, …, root]. */
  function chainOf(cell: CellRecord): CellRecord[] {
    return [cell, ...cells.ancestors(cell.id)];
  }

  function isStrictDescendant(ancestorId: string, cellId: string): boolean {
    if (ancestorId === cellId) return false;
    return cells.ancestors(cellId).some((a) => a.id === ancestorId);
  }

  function revokedAmong(cellIds: readonly string[]): string | undefined {
    if (cellIds.length === 0) return undefined;
    const rows = all<{ cell_id: string }>(
      db,
      `SELECT cell_id FROM ledger WHERE revoked_at IS NOT NULL AND cell_id IN (${placeholders(cellIds.length)})`,
      [...cellIds],
    );
    const hit = new Set(rows.map((r) => r.cell_id));
    return cellIds.find((id) => hit.has(id));
  }

  /** Why this cell may not act right now, or null. Same rule for authorize, approve, issueToken and tokens. */
  function inactiveReason(chain: readonly CellRecord[], opts: { allowPaused: boolean }): string | null {
    const [cell, ...ancestors] = chain;
    if (!cell) return "unknown cell";
    const revoked = revokedAmong(chain.map((c) => c.id));
    if (revoked) return revoked === cell.id ? "this cell's authority was revoked" : `authority of ancestor cell "${revoked}" was revoked`;
    if (cell.status === "closed" || (cell.status === "paused" && !opts.allowPaused)) return `this cell is ${cell.status}`;
    const blocked = ancestors.find((a) => a.status === "closed" || (a.status === "paused" && !opts.allowPaused));
    if (blocked) return `ancestor cell "${blocked.id}" is ${blocked.status}`;
    return null;
  }

  function boundsContext(cell: CellRecord): BoundsContext {
    return {
      cellId: cell.id,
      bounds: cell.bounds,
      isStrictDescendant: (id) => isStrictDescendant(cell.id, id),
      secretConfigured: (ref) => secrets.has(ref),
    };
  }

  // ---------- ledger ----------

  function ledgerRow(cellId: string): LedgerRow | undefined {
    return get<LedgerRow>(db, "SELECT * FROM ledger WHERE cell_id = ?", [cellId]);
  }

  function ensureLedger(cellIds: readonly string[]): void {
    const now = clock.now();
    for (const id of cellIds) run(db, "INSERT OR IGNORE INTO ledger (cell_id, updated_at) VALUES (?, ?)", [id, now]);
  }

  interface OwnLedger {
    cell: CellRecord;
    row: LedgerRow | undefined;
    limitTokens: number;
    limitCents: number;
    state: MeterResult;
  }

  /**
   * `overdraw`: read for a coordinator's wrap-up turn — the stop sits at limit + allowance instead of at the limit
   * (a limit of 0 gets no allowance: such a cell is not meant to spend at all).
   */
  function ownLedger(cell: CellRecord, overdraw = false): OwnLedger {
    const row = ledgerRow(cell.id);
    const limitTokens = cell.bounds.maxTokens + (row?.raised_tokens ?? 0);
    const limitCents = cell.bounds.maxCents + (row?.raised_cents ?? 0);
    const usedTokens = row?.subtree_tokens ?? 0;
    const usedCents = row?.subtree_cents ?? 0;
    const stopTokens = limitTokens + (overdraw ? Math.min(limitTokens * wrapUp.ratio, wrapUp.maxTokens) : 0);
    const stopCents = limitCents + (overdraw ? Math.min(limitCents * wrapUp.ratio, wrapUp.maxCents) : 0);
    let state: MeterResult = "ok";
    // Limits switched off by the owner: the numbers are still kept, but they stop nothing.
    if (!enforced()) return { cell, row, limitTokens, limitCents, state };
    if (usedTokens >= stopTokens || usedCents >= stopCents) state = "hard_stop";
    else if (usedTokens >= limitTokens * warnRatio || usedCents >= limitCents * warnRatio) state = "warn";
    return { cell, row, limitTokens, limitCents, state };
  }

  function effectiveLedger(chain: readonly CellRecord[], overdraw = false): { own: OwnLedger[]; state: MeterResult; limitedBy: OwnLedger | null } {
    const own = chain.map((c) => ownLedger(c, overdraw));
    let limitedBy: OwnLedger | null = null;
    for (const l of own) if (l.state !== "ok" && (limitedBy === null || STATE_RANK[l.state] > STATE_RANK[limitedBy.state])) limitedBy = l;
    return { own, state: limitedBy?.state ?? "ok", limitedBy };
  }

  function describeLimit(l: OwnLedger, selfId: string): string {
    const who = l.cell.id === selfId ? "this cell" : `ancestor cell "${l.cell.id}"`;
    const t = l.row?.subtree_tokens ?? 0;
    const c = l.row?.subtree_cents ?? 0;
    return `${who} used ${t}/${l.limitTokens} tokens and ${c}/${l.limitCents} cents`;
  }

  function usageOf(cell: CellRecord, view: LedgerViewOptions = {}): LedgerUsage {
    const eff = effectiveLedger(chainOf(cell), view.wrapUp === true);
    const self = eff.own[0]!;
    return {
      cellId: cell.id,
      ownTokens: self.row?.own_tokens ?? 0,
      ownCents: self.row?.own_cents ?? 0,
      subtreeTokens: self.row?.subtree_tokens ?? 0,
      subtreeCents: self.row?.subtree_cents ?? 0,
      limitTokens: self.limitTokens,
      limitCents: self.limitCents,
      raisedTokens: self.row?.raised_tokens ?? 0,
      raisedCents: self.row?.raised_cents ?? 0,
      state: eff.state,
      limitedBy: eff.limitedBy?.cell.id ?? null,
      enforced: enforced(),
    };
  }

  // ---------- tokens ----------

  function mintToken(t: { actionHash: string; actionId: string | null; cellId: string; epoch: number; secretRef: string | null }): string {
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const now = clock.now();
    run(
      db,
      `INSERT INTO action_tokens (token_hash, action_hash, action_id, cell_id, epoch, secret_ref, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sha256Hex(token), t.actionHash, t.actionId, t.cellId, t.epoch, t.secretRef, now + tokenTtlMs, now],
    );
    return token;
  }

  type TokenFailure = Extract<TokenCheck, { ok: false }>["reason"];

  /** Validity of a presented token, without consuming it. */
  function inspectToken(token: unknown): { row: TokenRow; cell: CellRecord } | { fail: TokenFailure } {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return { fail: "unknown" };
    const row = get<TokenRow>(db, "SELECT * FROM action_tokens WHERE token_hash = ?", [sha256Hex(token)]);
    if (!row) return { fail: "unknown" };
    if (row.used_at !== null) return { fail: "used" };
    if (row.revoked_at !== null) return { fail: "revoked" };
    const cell = cells.get(row.cell_id);
    if (!cell) return { fail: "revoked" };
    // A paused cell's own Loop must stop acting; an action the human already approved may still be carried out.
    if (inactiveReason(chainOf(cell), { allowPaused: row.action_id !== null }) !== null) return { fail: "revoked" };
    if (row.expires_at <= clock.now()) return { fail: "expired" };
    if (cell.epoch !== row.epoch) return { fail: "stale_epoch" };
    return { row, cell };
  }

  function consumeToken(row: TokenRow): boolean {
    return (
      run(db, "UPDATE action_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL", [
        clock.now(),
        row.token_hash,
      ]).changes === 1
    );
  }

  // ---------- approvals ----------

  function approvalRow(actionId: string): ApprovalRow | undefined {
    return get<ApprovalRow>(db, "SELECT * FROM approvals WHERE action_id = ?", [actionId]);
  }

  function pendingBySubject(subjectKey: string, cellId?: string): ApprovalRow | undefined {
    return get<ApprovalRow>(db, `${approvalSelect} WHERE subject_key = ? AND disposition = 'pending' AND cell_id IS NOT NULL AND action_hash <> ''
      ${cellId === undefined ? "" : "AND cell_id = ?"} ORDER BY created_at DESC, action_id DESC LIMIT 1`, cellId === undefined ? [subjectKey] : [subjectKey, cellId]);
  }

  function resolveRow(row: ApprovalRow, status: ApprovalStatus, reason: string | null): void {
    const now = clock.now();
    run(db, "UPDATE human_items SET disposition = ?, status_reason = ?, item_revision = item_revision + 1, resolved_at = ?, updated_at = ? WHERE action_id = ?", [
      status,
      reason === null ? null : redact(reason),
      now,
      now,
      row.action_id,
    ]);
    emitApproval(row, status);
  }

  function bumpStat(actionClass: string, outcome: { approved: true; edited: boolean } | { approved: false }): void {
    const now = clock.now();
    run(db, "INSERT OR IGNORE INTO approval_stats (action_class) VALUES (?)", [actionClass]);
    if (outcome.approved) {
      run(
        db,
        `UPDATE approval_stats SET approved = approved + 1,
           approved_unedited = approved_unedited + ?,
           unedited_streak = CASE WHEN ? THEN 0 ELSE unedited_streak + 1 END,
           last_decided_at = ? WHERE action_class = ?`,
        [outcome.edited ? 0 : 1, outcome.edited ? 1 : 0, now, actionClass],
      );
    } else {
      run(db, "UPDATE approval_stats SET denied = denied + 1, unedited_streak = 0, last_decided_at = ? WHERE action_class = ?", [
        now,
        actionClass,
      ]);
    }
  }

  /** Did a human write any version in (fromVersion, toVersion]? */
  function humanEditedBetween(artifactId: string, fromVersion: number | null, toVersion: number): boolean {
    if (fromVersion === null) return false;
    const authors = new Map<number, string>();
    for (const v of artifacts.listVersions(artifactId)) authors.set(v.version, v.updatedBy);
    const current = artifacts.get(artifactId);
    if (current) authors.set(current.version, current.updatedBy);
    for (const [v, by] of authors) if (v > fromVersion && v <= toVersion && by === "human") return true;
    return false;
  }

  function budgetOptions(cell:CellRecord, options?:CardOption[], legacy=false):CardOption[] {
    const usage=usageOf(cell);
    const ledger=usage.limitedBy ? usageOf(cells.require(usage.limitedBy)) : usage;
    const increment=(spent:number,limit:number) => Number.isFinite(limit) ? Math.max(1,Math.ceil(limit/2),Math.ceil(spent-limit+limit/4)) : 0;
    const defaults={tokens:increment(ledger.subtreeTokens,ledger.limitTokens),cents:increment(ledger.subtreeCents,ledger.limitCents)};
    const base:CardOption[]=options ?? [{id:"system.execute",label:"追加额度",effect:"execute"}];
    return base.map(option=>{
      if (option.effect!=="execute") return option;
      const requested=option.payload?.raise as {tokens?:number;cents?:number}|undefined;
      let tokens=requested === undefined ? defaults.tokens : requested?.tokens ?? 0;
      let cents=requested === undefined ? defaults.cents : requested?.cents ?? 0;
      if (!Number.isSafeInteger(tokens) || tokens<0 || !Number.isFinite(cents) || cents<0 || !(tokens+cents>0)) {
        if (!legacy) throw new NgError("invalid_argument","a budget option must specify a positive allowance");
        ({tokens,cents}=defaults);
      }
      const savedLedger=legacy ? option.payload?.ledgerCellId : undefined;
      const frozenLedger=typeof savedLedger==="string" && chainOf(cell).some(c=>c.id===savedLedger) ? savedLedger : ledger.cellId;
      const label=`为 ${cells.require(frozenLedger).title ?? frozenLedger} 追加 ${tokens} tokens、${cents} 美分并继续`;
      return {...option,label,payload:{...option.payload,raise:{tokens,cents},ledgerCellId:frozenLedger}};
    });
  }

  function deferAction(action: ProposedAction, meta: AuthorizeMeta, cell: CellRecord, boundVersion: number | undefined): AuthorizeResult {
    const now = clock.now();
    const card = redact(approvalCardFor(action));
    const storedAction = redact(withoutCard(action));
    const actionHash = hashAction(action);
    const artifactId = action.artifactId ?? null;
    const related = new Set(action.relatedProjectIds ?? []);
    const issuerProject = cell.preset === "project" ? cell.id : projectCellIdOf(cell.spec);
    if (issuerProject) related.add(issuerProject);
    if (action.cardOptions) {
      checkCardOptions(action.cardOptions, { callback: true, controlled: action.type !== "custom" || !!ownerOnlyApproval(action, ownerAddresses) });
      for (const option of action.cardOptions) {
        if (option.terminateMode === "cancel_task" && !related.has(option.targetCellIds![0]!)) throw new NgError("invalid_argument", "unrelated cancel target");
      }
    }
    for (const id of action.relatedProjectIds ?? []) if (cells.get(id)?.preset !== "project") throw new NgError("invalid_argument","unknown related project");
    const existing = pendingBySubject(action.subjectKey);
    if (existing && existing.cell_id !== cell.id) return {type:"deny", feedback:`Subject ${action.subjectKey} already has a pending card from ${existing.cell_id}`};
    let actionId: string;

    if (
      existing &&
      existing.cell_id === cell.id &&
      existing.action_type === action.type &&
      existing.epoch === cell.epoch &&
      sameEffectExceptDraft(fromJson<ProposedAction>(existing.action), existing.artifact_id, action)
    ) {
      // Same item, same requester: the card stays and simply shows the new proposal / draft version.
      actionId = existing.action_id;
      const proposed =
        artifactId !== null && artifactId === existing.artifact_id ? (existing.proposed_version ?? boundVersion ?? null) : (boundVersion ?? null);
      run(
        db,
        `UPDATE human_items SET principal_id = ?, action = ?, action_hash = ?, card = ?, artifact_id = ?, bound_version = ?,
           proposed_version = ?, item_revision = item_revision + 1, status_reason = NULL, updated_at = ? WHERE action_id = ?`,
        [meta.principalId, toJson(storedAction), actionHash, toJson(card), artifactId, boundVersion ?? null, proposed, now, actionId],
      );
    } else {
      actionId = newId("act", clock);
      if (existing) {
        resolveRow(existing, "superseded", `superseded by ${actionId}`);
        opts.onSuperseded?.(toApproval(existing), meta.principalId);
      }
      const predecessor = get<{ action_id: string }>(db, `SELECT h.action_id FROM human_items h
        WHERE h.subject_key = ? AND h.status IN ('pending','snoozed','unknown')
        AND NOT EXISTS (SELECT 1 FROM human_items next WHERE next.blocked_by = h.action_id AND next.status IN ('pending','snoozed','unknown'))
        LIMIT 1`, [action.subjectKey]);
      run(
        db,
        `INSERT INTO human_items (action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card,
           artifact_id, bound_version, proposed_version, disposition, created_at, updated_at, blocked_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          actionId,
          cell.id,
          cell.epoch,
          meta.principalId,
          action.subjectKey,
          action.type,
          toJson(storedAction),
          actionHash,
          toJson(card),
          artifactId,
          boundVersion ?? null,
          boundVersion ?? null,
          now,
          now,
          predecessor?.action_id ?? null,
        ],
      );
    }
    run(db, "UPDATE human_items SET options=?,related_project_ids=? WHERE action_id=?",
      [isBudgetEscalation(action) ? toJson(budgetOptions(cell,action.cardOptions)) : action.cardOptions ? toJson(action.cardOptions) : null, toJson([...related]), actionId]);
    emitApproval({ action_id: actionId, cell_id: cell.id, subject_key: action.subjectKey }, "pending");
    const result: AuthorizeResult = { type: "defer", actionId, approvalCard: card };
    if (boundVersion !== undefined) result.boundArtifactVersion = boundVersion;
    return result;
  }

  // ---------- rules ----------

  function listRules(): PolicyRule[] {
    return all<RuleRow>(db, "SELECT * FROM policy_rules ORDER BY created_at, id").map(toRule);
  }

  // ---------- deciders ----------

  /** Owner-only decisions: raising a budget, authoring policy rules, approving an `ownerOnlyApproval` card. */
  function assertOwner(principalId: unknown, what: string): asserts principalId is string {
    if (!isNonEmptyString(principalId)) throw new NgError("invalid_argument", `${what}: principal required`);
    if (principalId !== ownerPrincipal) throw new NgError("bounds_violation", `${what} needs the owner; ${principalId} may not`);
  }

  /**
   * Decisions an external main agent (`agent:*`) may take besides the owner: declining, and approving what is not
   * owner-only. Cells and everyone else are refused. Returns which of the two decided.
   */
  function assertOwnerOrAgent(principalId: unknown, what: string): "owner" | "agent" {
    if (!isNonEmptyString(principalId)) throw new NgError("invalid_argument", `${what}: principal required`);
    const kind = parsePrincipal(principalId, ownerPrincipal).kind;
    if (kind !== "owner" && kind !== "agent") {
      throw new NgError("bounds_violation", `${what} needs the owner or an agent on the control plane; ${principalId} may not`);
    }
    return kind;
  }

  // ==================== the Gate ====================

  const gate: GateService = {
    attenuate(parent, parentCellId, requested) {
      const stored = parentCellId ? cells.get(parentCellId) : undefined;
      if (!stored) return attenuateBounds(parent, parentCellId, requested);
      const effectiveParent = meetBounds(parent, stored.bounds);
      // No ledger cap: what the chain has left at this instant is not frozen into the child. The child shares the
      // live ledgers of its ancestors (meter and authorize read the whole chain every time), so a later raise or a
      // sibling's unused share reaches it without anyone re-deriving bounds.
      const child = attenuateBounds(effectiveParent, parentCellId, requested);
      const violations = boundsViolations(child, parent, { parentCellId });
      if (violations.length > 0) throw new NgError("bounds_violation", `attenuate: ${violations.join("; ")}`);
      return child;
    },

    async authorize(action, meta) {
      return gate.authorizeSync(action, meta);
    },

    authorizeSync(action, meta) {
      const deny = (feedback: string): AuthorizeResult => ({ type: "deny", feedback });
      const shape = actionShapeFeedback(action);
      if (shape) return deny(shape);
      if (meta === null || typeof meta !== "object" || !isNonEmptyString(meta.cellId) || !Number.isInteger(meta.epoch)) {
        return deny("invalid authorize meta: cellId and an integer epoch are required");
      }
      if (!isNonEmptyString(meta.principalId)) return deny("invalid authorize meta: principalId is required");

      return withTx(db, (): AuthorizeResult => {
        const cell = cells.get(meta.cellId);
        if (!cell) return deny(`unknown cell "${meta.cellId}"`);
        const chain = chainOf(cell);
        const chainIds = chain.map((c) => c.id);
        const inactive = inactiveReason(chain, { allowPaused: false });
        if (inactive) return deny(`${inactive}; it may not act. Stop here.`);
        if (meta.epoch !== cell.epoch) {
          return deny(`stale epoch ${meta.epoch} (current ${cell.epoch}): this task was cancelled or restarted. Stop here.`);
        }
        const kernelEscalation = action.type === "custom" && action.name === "kernel.escalation";
        if ((action.subjectKey.startsWith("kernel:") || kernelEscalation) && meta.principalId !== "kernel:escalation") {
          return deny("kernel escalation identities and subjects are reserved");
        }
        const principal = parsePrincipal(meta.principalId, ownerPrincipal);
        if (principal.kind === "cell" && principal.cellId !== cell.id) {
          return deny(`principal ${meta.principalId} may not act for cell "${cell.id}"`);
        }

        const outOfBounds = boundsFeedback(action, boundsContext(cell));
        if (outOfBounds) return deny(outOfBounds);

        const ledger = effectiveLedger(chain, meta.wrapUp === true);
        const exhausted = ledger.state === "hard_stop" ? ledger.limitedBy : null;

        let boundVersion: number | undefined;
        if (action.artifactId !== undefined) {
          const art = artifacts.get(action.artifactId);
          if (!art) return deny(`draft artifact "${action.artifactId}" not found`);
          const lineage = chainIds.includes(art.cellId) || isStrictDescendant(cell.id, art.cellId);
          if (!lineage) return deny(`draft artifact "${action.artifactId}" belongs to an unrelated task`);
          const v = meta.artifactVersion ?? art.version;
          if (!Number.isInteger(v) || v < 1 || v > art.version) {
            return deny(`draft artifact "${action.artifactId}" has no version ${String(v)} (current ${art.version})`);
          }
          boundVersion = v;
        }

        // Recovery requests and budget increases need an explicit decision, even with a broad standing rule.
        if (isBudgetEscalation(action) || kernelEscalation) return deferAction(action, meta, cell, boundVersion);

        const sideEffect = effectiveSideEffect(action, cell.bounds, ownerAddresses);
        const baseline: "allow" | "defer" = sideEffect === "external" ? "defer" : "allow";
        const rule = pickRule(listRules(), action, chainIds);
        if (rule?.effect === "deny") return deny(`blocked by the owner's policy${rule.note ? `: ${rule.note}` : ""}`);
        const decision: "allow" | "defer" = rule ? (rule.effect === "defer" ? "defer" : "allow") : baseline;

        // A card spends nothing, and asking the owner is how an exhausted budget (or a join whose workers used it up)
        // still surfaces; the hard stop applies to everything that would act right away.
        if (decision === "defer") return deferAction(action, meta, cell, boundVersion);
        if (action.type === "channel.send" && !ownerAddresses.some(pattern => addressCovers(pattern, action.target))) {
          // Never auto-allow a new send on a subject that still has an unverified unknown send waiting on the owner.
          const unresolvedUnknown = get<{ action_id: string }>(
            db,
            "SELECT action_id FROM human_items WHERE subject_key = ? AND status IN ('pending','unknown','snoozed') AND (action_type <> 'channel.send' OR disposition <> 'pending' OR cell_id <> ? OR epoch <> ?) LIMIT 1",
            [action.subjectKey,cell.id,cell.epoch],
          );
          if (unresolvedUnknown) {
            return deny(
              `an earlier send (${unresolvedUnknown.action_id}) for subject "${action.subjectKey}" has unresolved or unknown delivery status — wait for the owner to verify it before sending again`,
            );
          }
        }
        const pending = ownerOnlyApproval(action, ownerAddresses) !== null ? pendingBySubject(action.subjectKey) : undefined;
        if (pending?.cell_id === cell.id && pending.epoch === cell.epoch && pending.action_type === action.type) {
          // A newly enabled rule applies to future actions. Keep an already presented owner decision on its card.
          return deferAction(action, meta, cell, boundVersion);
        }
        if (exhausted && !(action.type === "channel.send" && sideEffect === "notify_owner")) {
          return deny(`budget exhausted: ${describeLimit(exhausted, cell.id)}. Stop and report; the owner can raise the budget.`);
        }

        if (action.type === "channel.send" && action.content === undefined) {
          return deny("channel.send needs `content` to be sent directly (include the draft's content)");
        }
        if (rule && baseline === "defer") {
          run(db, "UPDATE policy_rules SET uses = uses + 1, updated_at = ? WHERE id = ?", [clock.now(), rule.id]);
        }
        const secretRef = action.type === "secret.use" ? action.secretRef : null;
        const actionToken = mintToken({ actionHash: hashAction(action), actionId: null, cellId: cell.id, epoch: cell.epoch, secretRef });
        return secretRef === null ? { type: "allow", actionToken } : { type: "allow", actionToken, proxyInjectedSecretRef: secretRef };
      });
    },

    async approve(actionId, approverId, seenArtifactVersion, approveOpts) {
      return gate.approveSync(actionId, approverId, seenArtifactVersion, approveOpts);
    },

    approveSync(actionId, approverId, seenArtifactVersion, approveOpts = {}): ApproveResult {
      const decider = assertOwnerOrAgent(approverId, "approving a card");
      return withTx(db, (): ApproveResult => {
        const row = approvalRow(actionId);
        if (!row) return "not_found";
        const action = fromJson<ProposedAction>(row.action);
        if (decider !== "owner") {
          const ownerOnly = ownerOnlyApproval({ ...action, card: fromJson<Deliverable>(row.card) }, ownerAddresses);
          if (ownerOnly !== null) throw new NgError("bounds_violation", `approving this card needs the owner (${ownerOnly}); ${approverId} may not`);
        }
        const retryingFailedSend = row.status === "failed" && action.type === "channel.send";
        if (row.status === "approved" || row.status === "executed" || row.status === "unknown" || (row.status === "failed" && !retryingFailedSend)) {
          if (approveOpts.seenItemRevision !== undefined && approveOpts.seenItemRevision !== row.item_revision) {
            return "revision_mismatch";
          }
          return "approved";
        }
        if (row.status !== "pending" && !retryingFailedSend) return "already_cancelled";
        if (approveOpts.seenItemRevision !== undefined && approveOpts.seenItemRevision !== row.item_revision) {
          return "revision_mismatch";
        }
        const cancel = (reason: string): ApproveResult => {
          if (row.status === "pending" || retryingFailedSend) resolveRow(row, "cancelled", reason);
          return "already_cancelled";
        };

        const cell = cells.get(row.cell_id);
        if (!cell) return cancel("task no longer exists");
        const inactive = inactiveReason(chainOf(cell), { allowPaused: true });
        if (inactive) return cancel(inactive);
        if (cell.epoch !== row.epoch) return cancel("task was cancelled or restarted");
        const outOfBounds = boundsFeedback(action, boundsContext(cell));
        if (outOfBounds) return cancel(`no longer within the task's permissions: ${outOfBounds}`);

        let bound = row.bound_version;
        let humanEdited = toBool(row.human_edited);
        if (row.artifact_id !== null) {
          const current = artifacts.currentVersion(row.artifact_id);
          if (current === undefined) return cancel("draft no longer exists");
          if (seenArtifactVersion !== current) {
            if (row.bound_version !== current) {
              run(db, "UPDATE human_items SET bound_version = ?, item_revision = item_revision + 1, updated_at = ? WHERE action_id = ?", [
                current,
                clock.now(),
                row.action_id,
              ]);
              emitApproval(row, row.status);
            }
            return "version_mismatch";
          }
          bound = current;
          humanEdited = humanEditedBetween(row.artifact_id, row.proposed_version ?? row.bound_version, current);
        }

        const now = clock.now();
        run(
          db,
          `UPDATE human_items SET disposition = 'approved', status_reason = NULL, approver_id = ?, bound_version = ?, human_edited = ?,
             item_revision = item_revision + 1, resolved_at = COALESCE(resolved_at, ?), updated_at = ? WHERE action_id = ?`,
          [approverId, bound, humanEdited ? 1 : 0, now, now, row.action_id],
        );
        // Trust statistics describe the owner's own judgement (only counted on the initial pending -> approved transition).
        if (decider === "owner" && row.status === "pending" && action.type !== "custom") bumpStat(actionClassOf(action), { approved: true, edited: humanEdited });
        emitApproval(row, "approved");
        return "approved";
      });
    },

    async revoke(cellId) {
      gate.revokeSync(cellId);
    },

    revokeSync(cellId) {
      withTx(db, () => {
        const cell = cells.get(cellId);
        if (!cell) return;
        const ids = [cell.id, ...cells.descendants(cell.id).map((c) => c.id)];
        const now = clock.now();
        ensureLedger(ids);
        const inList = placeholders(ids.length);
        run(
          db,
          `UPDATE ledger SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, ?), updated_at = ?
           WHERE cell_id IN (${inList})`,
          [now, `revoked via ${cell.id}`, now, ...ids],
        );
        run(db, `UPDATE action_tokens SET revoked_at = ? WHERE used_at IS NULL AND revoked_at IS NULL AND cell_id IN (${inList})`, [
          now,
          ...ids,
        ]);
        const pending = all<ApprovalRow>(db, `${approvalSelect} WHERE (disposition='pending' OR (disposition='failed' AND action_type='channel.send')) AND cell_id IN (${inList})`, ids);
        for (const row of pending) resolveRow(row, "cancelled", "authority revoked");
      });
    },

    reinstateSync(cellId) {
      run(db, "UPDATE ledger SET revoked_at = NULL, revoke_reason = NULL, updated_at = ? WHERE cell_id = ?", [clock.now(), cellId]);
    },

    meter(cellId, usage, view = {}) {
      const tokens = usage?.tokens;
      const cents = usage?.billedCents;
      if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
        throw new NgError("invalid_argument", "meter: tokens must be a finite number ≥ 0");
      }
      if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) {
        throw new NgError("invalid_argument", "meter: billedCents must be a finite number ≥ 0");
      }
      const cachedIn = usage.cachedTokens;
      if (cachedIn !== undefined && (typeof cachedIn !== "number" || !Number.isFinite(cachedIn) || cachedIn < 0)) {
        throw new NgError("invalid_argument", "meter: cachedTokens must be a finite number ≥ 0");
      }
      const raw = Math.ceil(tokens);
      const cached = Math.min(raw, Math.floor(cachedIn ?? 0));
      // What the limits are charged: cache reads at their weight, everything else in full.
      const t = Math.ceil(raw - cached + cached * cacheReadWeight);
      return withTx(db, (): MeterResult => {
        const cell = cells.require(cellId);
        const chain = chainOf(cell);
        const ids = chain.map((c) => c.id);
        const now = clock.now();
        ensureLedger(ids);
        if (t > 0 || cents > 0) {
          run(db, "UPDATE ledger SET own_tokens = own_tokens + ?, own_cents = own_cents + ?, updated_at = ? WHERE cell_id = ?", [
            t,
            cents,
            now,
            cell.id,
          ]);
          run(
            db,
            `UPDATE ledger SET subtree_tokens = subtree_tokens + ?, subtree_cents = subtree_cents + ?, updated_at = ?
             WHERE cell_id IN (${placeholders(ids.length)})`,
            [t, cents, now, ...ids],
          );
          run(db, "INSERT INTO usage_log (cell_id, tokens, cents, at, raw_tokens, cached_tokens) VALUES (?, ?, ?, ?, ?, ?)", [cell.id, t, cents, now, raw, cached]);
        }
        // Alerts follow the limits themselves; what the caller is told follows its own view of them.
        const eff = effectiveLedger(chain);
        for (const l of eff.own) {
          if (l.state === "hard_stop" && l.row?.stopped_at == null) {
            run(db, "UPDATE ledger SET stopped_at = ?, warned_at = COALESCE(warned_at, ?) WHERE cell_id = ?", [now, now, l.cell.id]);
            afterCommit(db, () => bus.emit("ledger.alert", { cellId: l.cell.id, level: "hard_stop" }));
          } else if (l.state === "warn" && l.row?.warned_at == null) {
            run(db, "UPDATE ledger SET warned_at = ? WHERE cell_id = ?", [now, l.cell.id]);
            afterCommit(db, () => bus.emit("ledger.alert", { cellId: l.cell.id, level: "warn" }));
          }
        }
        return view.wrapUp ? effectiveLedger(chain, true).state : eff.state;
      });
    },

    // ---------- approvals administration ----------

    listPendingSync(filter: PendingFilter = {}) {
      const params: SqlParam[] = [];
      let sql = "SELECT * FROM approvals WHERE status = 'pending'";
      if (filter.cellIds !== undefined) {
        if (filter.cellIds.length === 0) return [];
        sql += ` AND cell_id IN (${placeholders(filter.cellIds.length)})`;
        params.push(...filter.cellIds);
      }
      if (!filter.includeSnoozed) {
        sql += " AND (snoozed_until IS NULL OR snoozed_until <= ?)";
        params.push(filter.now ?? clock.now());
      }
      sql += " ORDER BY created_at, action_id";
      if (filter.limit !== undefined) {
        sql += " LIMIT ?";
        params.push(Math.max(0, Math.floor(filter.limit)));
      }
      return all<ApprovalRow>(db, sql, params).map(toApproval);
    },

    listApprovalsSync(filter: ApprovalFilter = {}) {
      const params: SqlParam[] = [];
      let sql = "SELECT * FROM approvals WHERE 1 = 1";
      if (filter.status !== undefined) {
        if (filter.status.length === 0) return [];
        sql += ` AND status IN (${placeholders(filter.status.length)})`;
        params.push(...filter.status);
      }
      if (filter.cellIds !== undefined) {
        if (filter.cellIds.length === 0) return [];
        sql += ` AND cell_id IN (${placeholders(filter.cellIds.length)})`;
        params.push(...filter.cellIds);
      }
      if (filter.subjectKey !== undefined) {
        sql += " AND subject_key = ?";
        params.push(filter.subjectKey);
      }
      sql += " ORDER BY updated_at DESC, action_id DESC";
      if (filter.limit !== undefined) {
        sql += " LIMIT ?";
        params.push(Math.max(0, Math.floor(filter.limit)));
      }
      return all<ApprovalRow>(db, sql, params).map(toApproval);
    },

    getApprovalSync(actionId) {
      const row = get<ApprovalRow>(db, `${approvalSelect} WHERE action_id=? AND cell_id IS NOT NULL AND action_hash<>''`, [actionId]);
      return row ? toApproval(row) : undefined;
    },

    findPendingBySubjectSync(subjectKey, cellId) {
      const row = pendingBySubject(subjectKey, cellId);
      return row ? toApproval(row) : undefined;
    },

    snoozeSync(actionId, until, snoozeOpts = {}) {
      if (typeof until !== "number" || !Number.isFinite(until)) throw new NgError("invalid_argument", "snooze: until must be a timestamp");
      return withTx(db, () => {
        const row = approvalRow(actionId);
        if (!row || row.status !== "pending") return "not_pending";
        if (snoozeOpts.seenItemRevision !== undefined && snoozeOpts.seenItemRevision !== row.item_revision) return "revision_mismatch";
        run(db, "UPDATE human_items SET snoozed_until = ?, item_revision = item_revision + 1, updated_at = ? WHERE action_id = ?", [
          until,
          clock.now(),
          actionId,
        ]);
        emitApproval(row, "pending");
        return "snoozed";
      });
    },

    denySync(actionId, approverId, reason, denyOpts = {}) {
      // Declining is never an escalation of privilege: an agent may deny even an owner-only card.
      const decider = assertOwnerOrAgent(approverId, "denying a card");
      return withTx(db, () => {
        const row = approvalRow(actionId);
        if (!row || row.status !== "pending") return "not_pending";
        if (denyOpts.seenItemRevision !== undefined && denyOpts.seenItemRevision !== row.item_revision) return "revision_mismatch";
        const now = clock.now();
        run(
          db,
          "UPDATE human_items SET disposition = 'denied', status_reason = ?, approver_id = ?, item_revision = item_revision + 1, resolved_at = ?, updated_at = ? WHERE action_id = ?",
          [reason === undefined ? null : redact(reason), approverId, now, now, actionId],
        );
        if (decider === "owner" && row.action_type !== "custom") bumpStat(actionClassOf(fromJson<ProposedAction>(row.action)), { approved: false });
        emitApproval(row, "denied");
        return "denied";
      });
    },

    reviseSync(actionId, approverId, reviseOpts = {}) {
      assertOwnerOrAgent(approverId, "revising a card");
      return withTx(db, () => {
        const row = approvalRow(actionId);
        if (!row || row.status !== "pending") return "not_pending";
        if (reviseOpts.seenItemRevision !== undefined && reviseOpts.seenItemRevision !== row.item_revision) return "revision_mismatch";
        if (reviseOpts.seenArtifactVersion !== undefined && row.artifact_id !== null) {
          const current = artifacts.currentVersion(row.artifact_id);
          if (current !== undefined && reviseOpts.seenArtifactVersion !== current) {
            if (row.bound_version !== current) {
              run(db, "UPDATE human_items SET bound_version = ?, item_revision = item_revision + 1, updated_at = ? WHERE action_id = ?", [
                current,
                clock.now(),
                row.action_id,
              ]);
              emitApproval(row, "pending");
            }
            return "version_mismatch";
          }
        }
        run(db, "UPDATE human_items SET item_revision = item_revision + 1, updated_at = ? WHERE action_id = ?", [clock.now(), actionId]);
        emitApproval(row, "pending");
        return "revised";
      });
    },

    withdrawSync(actionId, reason, withdrawOpts = {}) {
      return withTx(db, () => {
        const row = get<ApprovalRow>(db, `${approvalSelect} WHERE action_id=? AND cell_id IS NOT NULL AND action_hash<>''`, [actionId]);
        if (!row || row.status !== "pending") return "not_pending";
        if (withdrawOpts.seenItemRevision !== undefined && withdrawOpts.seenItemRevision !== row.item_revision) return "revision_mismatch";
        resolveRow(row, "cancelled", reason);
        return "cancelled";
      });
    },

    setSendAbandonedSync(actionId, activityId, abandoned, seenItemRevision) {
      return withTx(db, () => {
        const row = get<ApprovalRow>(db, `${approvalSelect} WHERE action_id=?`, [actionId]);
        if (!row || row.action_type !== "channel.send" || row.item_revision !== seenItemRevision) return false;
        const reason = `abandoned:${activityId}`;
        if (abandoned ? row.status !== "failed" : row.status !== "cancelled" || row.status_reason !== reason) return false;
        if (!abandoned && get(db,`SELECT 1 FROM human_items WHERE subject_key=? AND blocked_by IS NULL
          AND status IN ('pending','snoozed','unknown')`,[row.subject_key])) return false;
        resolveRow(row, abandoned ? "cancelled" : "failed", abandoned ? reason : null);
        return true;
      });
    },

    cancelForCellSync(cellId, reason) {
      return withTx(db, () => {
        const rows = all<ApprovalRow>(db, `${approvalSelect} WHERE (disposition='pending' OR (disposition='failed' AND action_type='channel.send')) AND cell_id = ?`, [cellId]);
        for (const row of rows) resolveRow(row, "cancelled", reason);
        return rows.length;
      });
    },

    recordOutcomeSync(actionId, status, outcome) {
      if (status !== "executed" && status !== "failed" && status !== "unknown") {
        throw new NgError("invalid_argument", `recordOutcome: invalid status "${String(status)}"`);
      }
      withTx(db, () => {
        const row = approvalRow(actionId);
        if (!row) throw new NgError("not_found", `approval "${actionId}" not found`);
        if (row.status === "executed") {
          if (status === "executed") return;
          throw new NgError("conflict", `approval "${actionId}" was already executed`);
        }
        if (row.status !== "approved" && row.status !== "failed" && row.status !== "unknown") {
          throw new NgError("conflict", `approval "${actionId}" is ${row.status}, not approved`);
        }
        const now = clock.now();
        run(
          db,
          "UPDATE human_items SET disposition = ?, outcome = ?, item_revision = item_revision + 1, resolved_at = COALESCE(resolved_at, ?), updated_at = ? WHERE action_id = ?",
          [status, toJson(redact(outcome ?? {})), now, now, actionId],
        );
        emitApproval(row, status);
      });
    },

    recordStandingSendSync(actionId, action, meta) {
      return withTx(db, () => {
        const prior = get<ApprovalRow>(db,`${approvalSelect} WHERE action_id=?`,[actionId]);
        if (prior && prior.cell_id === meta.cellId && prior.epoch === meta.epoch && prior.action_hash === hashAction(action)) return toApproval(prior);
        if (prior || get(db, `SELECT 1 FROM human_items WHERE subject_key=? AND status IN ('pending','unknown','snoozed')`,[action.subjectKey]))
          throw new NgError("conflict", "这个主题已有待处理的发送记录");
        const now = clock.now();
        const card = redact(approvalCardFor(action));
        const storedAction = redact(withoutCard(action));
        const actionHash = hashAction(action);
        const artifactId = action.artifactId ?? null;
        run(
          db,
          `INSERT INTO human_items (action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card,
             artifact_id, bound_version, proposed_version, item_revision, disposition, approver_id, outcome, created_at, updated_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'approved', 'policy:standing_rule', NULL, ?, ?, ?)`,
          [
            actionId,
            meta.cellId,
            meta.epoch,
            meta.principalId,
            action.subjectKey,
            action.type,
            toJson(storedAction),
            actionHash,
            toJson(card),
            artifactId,
            meta.artifactVersion ?? null,
            meta.artifactVersion ?? null,
            now,
            now,
            now,
          ],
        );
        emitApproval({ action_id: actionId, cell_id: meta.cellId, subject_key: action.subjectKey }, "approved");
        return toApproval(approvalRow(actionId)!);
      });
    },

    rebindSync(actionId, version) {
      return withTx(db, () => {
        const row = approvalRow(actionId);
        if (!row || row.status !== "pending") return "not_pending";
        if (row.artifact_id === null) throw new NgError("invalid_argument", `approval "${actionId}" is not bound to a draft`);
        const current = artifacts.currentVersion(row.artifact_id);
        if (current === undefined || !Number.isInteger(version) || version < 1 || version > current) {
          throw new NgError("invalid_argument", `draft "${row.artifact_id}" has no version ${String(version)}`);
        }
        run(db, "UPDATE human_items SET bound_version = ?, item_revision = item_revision + 1, updated_at = ? WHERE action_id = ?", [
          version,
          clock.now(),
          actionId,
        ]);
        emitApproval(row, "pending");
        return "rebound";
      });
    },

    // ---------- tokens ----------

    issueTokenSync(actionId, action) {
      return withTx(db, () => {
        const row = approvalRow(actionId);
        if (!row) throw new NgError("not_found", `approval "${actionId}" not found`);
        if (row.status !== "approved" && row.status !== "failed") {
          throw new NgError("conflict", `approval "${actionId}" is ${row.status}; a token needs an approved (or failed, for a retry) approval`);
        }
        const cell = cells.get(row.cell_id);
        if (!cell) throw new NgError("not_found", `cell "${row.cell_id}" not found`);
        const inactive = inactiveReason(chainOf(cell), { allowPaused: true });
        if (inactive) throw new NgError("conflict", `cannot issue a token: ${inactive}`);
        if (cell.epoch !== row.epoch) throw new NgError("stale_epoch", `cell "${cell.id}" epoch moved since approval "${actionId}"`);
        // Only operative fields matter here; the kernel may rebuild the action without summary/subjectKey (as the hub does).
        if (action === null || typeof action !== "object" || action.type !== row.action_type) {
          throw new NgError("invalid_argument", `token action must be the approved ${row.action_type} action`);
        }
        const approved = fromJson<ProposedAction>(row.action);
        if (action.type === "channel.send" && row.artifact_id !== null && row.bound_version !== null) {
          // Draft sends execute the bound version's content: same target, content = that exact version.
          if (approved.type !== "channel.send" || action.target !== approved.target) {
            throw new NgError("invalid_argument", "token action must target the approved address");
          }
          const boundContent =
            artifacts.getVersion(row.artifact_id, row.bound_version)?.content ??
            (artifacts.get(row.artifact_id)?.version === row.bound_version ? artifacts.get(row.artifact_id)?.content : undefined);
          if (boundContent === undefined) throw new NgError("not_found", `draft "${row.artifact_id}" v${row.bound_version} not found`);
          if (action.content === undefined || stableStringify(action.content) !== stableStringify(boundContent)) {
            throw new NgError("invalid_argument", `token content must be draft "${row.artifact_id}" v${row.bound_version} as approved`);
          }
        } else if (hashAction(action) !== row.action_hash) {
          throw new NgError("invalid_argument", "token action differs from the approved action");
        }
        const outOfBounds = boundsFeedback(action, boundsContext(cell));
        if (outOfBounds) throw new NgError("bounds_violation", `approved action is no longer within bounds: ${outOfBounds}`);
        return mintToken({
          actionHash: hashAction(action),
          actionId,
          cellId: cell.id,
          epoch: cell.epoch,
          secretRef: action.type === "secret.use" ? action.secretRef : null,
        });
      });
    },

    verifyTokenSync(token, action): TokenCheck {
      return withTx(db, (): TokenCheck => {
        const r = inspectToken(token);
        if ("fail" in r) return { ok: false, reason: r.fail };
        if (!action || !ACTION_TYPES.includes(action.type)) return {ok:false, reason:"mismatch"};
        let hash: string;
        try {
          hash = hashAction(action);
        } catch {
          return { ok: false, reason: "mismatch" };
        }
        if (hash !== r.row.action_hash) return { ok: false, reason: "mismatch" };
        if (!consumeToken(r.row)) return { ok: false, reason: "used" };
        return { ok: true, cellId: r.cell.id, actionId: r.row.action_id };
      });
    },

    injectSecretSync(token, expectedSecretRef) {
      return withTx(db, () => {
        const r = inspectToken(token);
        if ("fail" in r) {
          const code = r.fail === "unknown" ? "not_found" : r.fail === "stale_epoch" ? "stale_epoch" : "conflict";
          throw new NgError(code, `injectSecret: token ${r.fail}`, { reason: r.fail });
        }
        const ref = r.row.secret_ref;
        if (ref === null) throw new NgError("invalid_argument", "injectSecret: token was not issued for secret.use");
        if (expectedSecretRef !== undefined && expectedSecretRef !== ref) {
          throw new NgError("invalid_argument", `injectSecret: token was issued for secret "${ref}", not "${expectedSecretRef}"`);
        }
        if (!r.cell.bounds.secretRefs.has(ref)) throw new NgError("bounds_violation", `injectSecret: secret "${ref}" is no longer within bounds`);
        const value = secrets.get(ref);
        if (value === undefined) throw new NgError("not_found", `injectSecret: secret "${ref}" is not configured`);
        if (!consumeToken(r.row)) throw new NgError("conflict", "injectSecret: token used", { reason: "used" });
        injected.set(value, ref);
        return value;
      });
    },

    authorizeControlSync(cellId, principalId, action) {
      if (!CONTROL_ACTIONS.includes(action)) return { ok: false, reason: `unknown control action ${JSON.stringify(action)}` };
      const target = cells.get(cellId);
      if (!target) return { ok: false, reason: `unknown cell "${cellId}"` };
      if (target.parentId === null && (action === "pause" || action === "cancel")) {
        return { ok: false, reason: "cannot pause or cancel a root cell" };
      }
      if (!isNonEmptyString(principalId)) return { ok: false, reason: "principal required" };
      const p = parsePrincipal(principalId, ownerPrincipal);
      // An external main agent orchestrates like the owner (docs/05 §5.3); it is only kept from owner-only decisions.
      if (p.kind === "owner" || p.kind === "agent") return { ok: true };
      if (p.kind !== "cell") return { ok: false, reason: "only the owner, an agent on the control plane, or an ancestor cell may control a cell" };
      const actor = cells.get(p.cellId);
      if (!actor) return { ok: false, reason: `unknown cell "${p.cellId}"` };
      const inactive = inactiveReason(chainOf(actor), { allowPaused: false });
      if (inactive) return { ok: false, reason: `${principalId}: ${inactive}` };
      if (!isStrictDescendant(actor.id, target.id)) return { ok: false, reason: `cell "${cellId}" is not a descendant of ${principalId}` };
      return { ok: true };
    },

    // ---------- ledger ----------

    usageSync(cellId, view) {
      return usageOf(cells.require(cellId), view);
    },

    declineBudgetSync(cellId, approverId) {
      assertOwnerOrAgent(approverId, "declining a budget");
      withTx(db, () => {
        const cell = cells.require(cellId);
        ensureLedger([cell.id]);
        run(db,"UPDATE ledger SET declined_at=? WHERE cell_id=?",[clock.now(),cell.id]);
        if (cell.parentId !== null && cell.status === "active") opts.setBudgetPaused?.(cell.id,true,approverId);
      });
    },

    clearBudgetDeclinesSync(approverId, cellId) {
      assertOwner(approverId, "restoring a declined budget");
      return withTx(db, () => {
        const rows = all<{cell_id:string}>(db,
          "UPDATE ledger SET declined_at=NULL, stopped_at=NULL WHERE declined_at IS NOT NULL" + (cellId ? " AND cell_id=?" : "") + " RETURNING cell_id", cellId ? [cellId] : []);
        for (const {cell_id} of rows) {
          if (cells.require(cell_id).pauseReason === "budget_declined") opts.setBudgetPaused?.(cell_id,false,approverId);
        }
        return rows.map(row => row.cell_id);
      });
    },

    budgetDeclinedSync(cellId) {
      return get(db, "SELECT 1 FROM ledger WHERE cell_id = ? AND declined_at IS NOT NULL", [cellId]) !== undefined;
    },

    raiseBudgetSync(cellId, add, approverId) {
      assertOwner(approverId, "raising a budget");
      const tokens = add?.tokens ?? 0;
      const cents = add?.cents ?? 0;
      if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(cents) || cents < 0) {
        throw new NgError("invalid_argument", "raiseBudget: tokens and cents must be finite numbers ≥ 0");
      }
      return withTx(db, () => {
        const cell = cells.require(cellId);
        const now = clock.now();
        ensureLedger([cell.id]);
        const t = Math.floor(tokens);
        run(db, "UPDATE ledger SET declined_at = NULL, raised_tokens = raised_tokens + ?, raised_cents = raised_cents + ?, updated_at = ? WHERE cell_id = ?", [
          t,
          cents,
          now,
          cell.id,
        ]);
        if (cell.pauseReason === "budget_declined" && (t > 0 || cents > 0)) opts.setBudgetPaused?.(cell.id,false,approverId);
        run(db, "INSERT INTO budget_raises (cell_id, tokens, cents, approver_id, at) VALUES (?, ?, ?, ?, ?)", [cell.id, t, cents, approverId, now]);
        const own = ownLedger(cell);
        // Re-arm the alerts so crossing the new limit is announced again.
        if (own.state !== "hard_stop") run(db, "UPDATE ledger SET stopped_at = NULL WHERE cell_id = ?", [cell.id]);
        if (own.state === "ok") run(db, "UPDATE ledger SET warned_at = NULL WHERE cell_id = ?", [cell.id]);
        afterCommit(db, () => bus.emit("ledger.raised", { cellId: cell.id }));
        return usageOf(cell);
      });
    },

    raiseChainSync(cellId, approverId, add) {
      assertOwner(approverId, "raising a budget");
      return withTx(db, () => {
        const raised: BudgetRaise[] = [];
        for (const l of chainOf(cells.require(cellId)).map((c) => ownLedger(c))) {
          if (l.state !== "hard_stop") continue;
          // Default: half the limit again, and never so little that the ledger is still stopped afterwards.
          const overTokens = Math.max(0, (l.row?.subtree_tokens ?? 0) - l.limitTokens);
          const overCents = Math.max(0, (l.row?.subtree_cents ?? 0) - l.limitCents);
          // An explicit amount is taken as given (a field left out adds nothing, as with raiseBudgetSync).
          const tokens = add ? (add.tokens ?? 0) : Math.max(1, Math.ceil(l.limitTokens / 2), overTokens + Math.ceil(l.limitTokens / 4));
          const cents = add ? (add.cents ?? 0) : Math.max(1, Math.ceil(l.limitCents / 2), overCents + Math.ceil(l.limitCents / 4));
          gate.raiseBudgetSync(l.cell.id, { tokens, cents }, approverId);
          raised.push({ cellId: l.cell.id, tokens, cents });
        }
        return raised;
      });
    },

    // ---------- policy rules & trust ----------

    listPolicyRulesSync() {
      return listRules();
    },

    upsertPolicyRuleSync(input: PolicyRuleInput) {
      const type = input?.match?.type;
      if (type !== "*" && !(ACTION_TYPES as readonly unknown[]).includes(type)) {
        throw new NgError("invalid_argument", `policy rule: unknown action type ${JSON.stringify(type)}`);
      }
      const target = input.match.target;
      if (target !== undefined && target !== null && !isNonEmptyString(target)) {
        throw new NgError("invalid_argument", "policy rule: target must be a non-empty pattern");
      }
      if (input.effect !== "allow" && input.effect !== "defer" && input.effect !== "deny") {
        throw new NgError("invalid_argument", `policy rule: invalid effect ${JSON.stringify(input.effect)}`);
      }
      // A rule is a standing approval (an allow rule can open external sends), so it is the owner's alone.
      assertOwner(input.createdBy, "authoring a policy rule");
      const maxUses = input.maxUses ?? null;
      if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 0)) {
        throw new NgError("invalid_argument", "policy rule: maxUses must be an integer ≥ 0 or null");
      }
      const scope = input.scopeCellId ?? null;
      if (scope !== null && !cells.get(scope)) throw new NgError("not_found", `policy rule: scope cell "${scope}" not found`);
      const note = input.note ?? null;
      const enabled = input.enabled ?? true;
      return withTx(db, () => {
        const now = clock.now();
        const existing = input.id ? get<RuleRow>(db, "SELECT * FROM policy_rules WHERE id = ?", [input.id]) : undefined;
        const id = input.id ?? newId("rule", clock);
        if (existing) {
          run(
            db,
            `UPDATE policy_rules SET action_type = ?, target_pattern = ?, effect = ?, scope_cell_id = ?, max_uses = ?, note = ?,
               enabled = ?, created_by = ?, updated_at = ? WHERE id = ?`,
            [type, target ?? null, input.effect, scope, maxUses, note, enabled ? 1 : 0, input.createdBy, now, id],
          );
        } else {
          run(
            db,
            `INSERT INTO policy_rules (id, action_type, target_pattern, effect, scope_cell_id, max_uses, uses, note, enabled, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
            [id, type, target ?? null, input.effect, scope, maxUses, note, enabled ? 1 : 0, input.createdBy, now, now],
          );
        }
        return toRule(get<RuleRow>(db, "SELECT * FROM policy_rules WHERE id = ?", [id])!);
      });
    },

    deletePolicyRuleSync(id) {
      run(db, "DELETE FROM policy_rules WHERE id = ?", [id]);
    },

    approvalStatsSync() {
      return all<StatRow>(db, "SELECT * FROM approval_stats ORDER BY action_class").map(toStat);
    },

    trustCandidatesSync(minStreak = trustStreak) {
      const allowRules = listRules().filter(
        (r) => r.enabled && r.effect === "allow" && r.scopeCellId === null && (r.maxUses === null || r.uses < r.maxUses),
      );
      return gate.approvalStatsSync().filter((s) => {
        if (s.uneditedStreak < minStreak) return false;
        const cls = parseActionClass(s.actionClass);
        const covered = allowRules.some((r) => {
          if (r.match.type !== "*" && r.match.type !== cls.type) return false;
          if (r.match.target === undefined) return true;
          // cell.control classes are keyed by control verb while rule targets match cell ids: only a target-less rule covers them.
          return cls.target !== null && addressCovers(r.match.target, cls.target);
        });
        return !covered;
      });
    },

    markTrustSuggestedSync(actionClasses, at) {
      const when = at ?? clock.now();
      withTx(db, () => {
        for (const cls of actionClasses) run(db, "UPDATE approval_stats SET suggested_at = ? WHERE action_class = ?", [when, cls]);
      });
    },

    pruneTokensSync(olderThanMs = 24 * 60 * 60_000) {
      const cutoff = clock.now() - olderThanMs;
      return run(
        db,
        `DELETE FROM action_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?) OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
        [cutoff, cutoff, cutoff],
      ).changes;
    },
  };

  // Old cards had no frozen amount. Materialize it once before the first client can see or approve them.
  withTx(db, () => {
    const rows=all<{action_id:string;action:string;card:string;cell_id:string;options:string|null}>(db,
      "SELECT action_id,action,card,cell_id,options FROM human_items WHERE disposition='pending' AND action_type='custom' AND action_hash<>''");
    for (const row of rows) {
      const action=fromJson<ProposedAction>(row.action);
      if (!isBudgetEscalation({...action, card:fromJson<Deliverable>(row.card)})) continue;
      const options=budgetOptions(cells.require(row.cell_id),row.options ? fromJson<CardOption[]>(row.options) : undefined,true);
      const json=toJson(options);
      if (json!==row.options) run(db,"UPDATE human_items SET options=?,item_revision=item_revision+1 WHERE action_id=?",[json,row.action_id]);
    }
  });
  return gate;
}
