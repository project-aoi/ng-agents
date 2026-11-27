import {
  checkCardOptions, NgError, OWNER_PRINCIPAL, afterCommit, all, artifactsRepo,
  boundsViolations, cellsRepo, fromJson, get, hashAction, newId, parsePrincipal, run, systemClock,
  toBool, toJson, withTx, type ApprovalFilter, type ApprovalOutcome, type ApprovalRecord,
  type ApprovalStatus, type ApproveResult, type AuthorizeMeta, type AuthorizeResult,
  type Bus, type CellRecord, type Clock, type ControlAction, type Db, type Deliverable, type Gate,
  type PendingFilter, type ProposedAction, type SqlParam,
} from "@ng/protocol";
import { attenuateBounds, meetBounds } from "./attenuate";
import { approvalCardFor } from "./card";
import { actionShapeFeedback, requiresApproval } from "./policy";

const CONTROL_ACTIONS: readonly ControlAction[] = ["cancel", "pause", "resume", "steer"];

export interface GateOptions {
  isProjectRoot?(cell: CellRecord): boolean;
  onSnooze?(id: string, until: number, principalId: string): void;
  onSuperseded?(old: ApprovalRecord, principalId: string): void;
  db: Db;
  bus: Bus;
  clock?: Clock;
  ownerPrincipal?: string;
}

export type GateService = Gate;
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

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
function withoutCard(action: ProposedAction): ProposedAction {
  const { card: _card, ...rest } = action;
  return rest as ProposedAction;
}
export function createGate(opts: GateOptions): GateService {
  const { db, bus } = opts;
  const clock = opts.clock ?? systemClock;
  const ownerPrincipal = opts.ownerPrincipal ?? OWNER_PRINCIPAL;
  const cells = cellsRepo(db, clock);
  const artifacts = artifactsRepo(db);
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
      `SELECT id AS cell_id FROM cells WHERE revoked_at IS NOT NULL AND id IN (${placeholders(cellIds.length)})`,
      [...cellIds],
    );
    const hit = new Set(rows.map((r) => r.cell_id));
    return cellIds.find((id) => hit.has(id));
  }

  /** A revoked or closed ancestor also prevents the cell from acting. */
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

  function approvalRow(actionId: string): ApprovalRow | undefined {
    return get<ApprovalRow>(db, `${approvalSelect} WHERE action_id = ? AND cell_id IS NOT NULL AND action_hash <> ''`, [actionId]);
  }

  function pendingBySubject(subjectKey: string, cellId: string): ApprovalRow | undefined {
    return get<ApprovalRow>(db, `${approvalSelect} WHERE subject_key=? AND cell_id=? AND disposition IN ('pending','revising')`,
      [subjectKey, cellId]);
  }

  function resolveRow(row: ApprovalRow, status: ApprovalStatus, reason: string | null): void {
    const now = clock.now();
    run(db, "UPDATE human_items SET disposition = ?, status_reason = ?, revise_note = NULL, item_revision = item_revision + 1, resolved_at = ?, updated_at = ? WHERE action_id = ?", [
      status,
      reason === null ? null : reason,
      now,
      now,
      row.action_id,
    ]);
    emitApproval(row, status);
  }

  function humanEditedBetween(artifactId: string, fromVersion: number | null, toVersion: number): boolean {
    if (fromVersion === null) return false;
    const authors = new Map<number, string>();
    for (const v of artifacts.listVersions(artifactId)) authors.set(v.version, v.updatedBy);
    const current = artifacts.get(artifactId);
    if (current) authors.set(current.version, current.updatedBy);
    for (const [v, by] of authors) if (v > fromVersion && v <= toVersion && by === "human") return true;
    return false;
  }

  function deferAction(action: ProposedAction, meta: AuthorizeMeta, cell: CellRecord, boundVersion: number | undefined): AuthorizeResult {
    const now = clock.now();
    const card = approvalCardFor(action);
    const storedAction = withoutCard(action);
    const actionHash = hashAction(action);
    const artifactId = action.artifactId ?? null;
    const related = new Set([...(action.relatedProjectIds ?? []), ...(action.blockingProjectIds ?? [])]);
    const issuerProject = chainOf(cell).find(c => opts.isProjectRoot?.(c))?.id;
    if (issuerProject) related.add(issuerProject);
    if (action.cardOptions) {
      checkCardOptions(action.cardOptions, { callback: true, controlled: requiresApproval(action) });
      for (const option of action.cardOptions) {
        if (option.terminateMode === "cancel_task") {
          const target = option.targetCellIds![0]!;
          if (!related.has(target) || (target !== cell.id && !isStrictDescendant(cell.id, target)))
            throw new NgError("bounds_violation", "取消范围超出发起任务的权限");
        }
      }
    }
    for (const id of [...(action.relatedProjectIds ?? []), ...(action.blockingProjectIds ?? [])]) {
      const target = cells.get(id);
      if (!target || !opts.isProjectRoot?.(target)) throw new NgError("invalid_argument", "unknown related project");
      if (cell.id !== id && !isStrictDescendant(id, cell.id) && !isStrictDescendant(cell.id, id))
        throw new NgError("bounds_violation", "关联项目超出发起任务的权限");
    }
    const existing = pendingBySubject(action.subjectKey, cell.id);
    if (existing && !existing.action_hash) return {type:"deny", feedback:`Subject ${action.subjectKey} already has a pending card from ${existing.cell_id}`};
    let actionId: string;

    if (
      existing &&
      existing.action_type === action.type &&
      existing.epoch === cell.epoch &&
      existing.action_hash === actionHash && existing.artifact_id === artifactId
    ) {
      // Same item, same requester: the card stays and simply shows the new proposal / draft version.
      actionId = existing.action_id;
      const proposed =
        artifactId !== null && artifactId === existing.artifact_id ? (existing.proposed_version ?? boundVersion ?? null) : (boundVersion ?? null);
      run(
        db,
        `UPDATE human_items SET principal_id = ?, action = ?, action_hash = ?, card = ?, artifact_id = ?, bound_version = ?,
           proposed_version = ?, disposition = 'pending', snoozed_until = NULL, item_revision = item_revision + 1, status_reason = NULL, revise_note = NULL, updated_at = ? WHERE action_id = ?`,
        [meta.principalId, toJson(storedAction), actionHash, toJson(card), artifactId, boundVersion ?? null, proposed, now, actionId],
      );
    } else {
      actionId = newId("act", clock);
      if (existing) {
        resolveRow(existing, "superseded", `superseded by ${actionId}`);
        opts.onSuperseded?.(toApproval(existing), meta.principalId);
      }
      run(db,
        `INSERT INTO human_items (action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card,
           artifact_id, bound_version, proposed_version, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
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
        ],
      );
    }
    run(db, "UPDATE human_items SET options=?,related_project_ids=? WHERE action_id=?",
      [action.cardOptions ? toJson(action.cardOptions) : null, toJson([...related]), actionId]);
    emitApproval({ action_id: actionId, cell_id: cell.id, subject_key: action.subjectKey }, "pending");
    const result: AuthorizeResult = { type: "defer", actionId, approvalCard: card };
    if (boundVersion !== undefined) result.boundArtifactVersion = boundVersion;
    return result;
  }

  // ---------- rules ----------

  function assertOwnerOrAgent(principalId: unknown, what: string): void {
    if (!isNonEmptyString(principalId)) throw new NgError("invalid_argument", `${what}: principal required`);
    const kind = parsePrincipal(principalId, ownerPrincipal).kind;
    if (kind !== "owner" && kind !== "agent") {
      throw new NgError("bounds_violation", `${what} needs the owner or an agent on the control plane; ${principalId} may not`);
    }
  }

  // ==================== the Gate ====================

  const gate: GateService = {
    attenuate(parent, parentCellId, requested) {
      const stored = parentCellId ? cells.get(parentCellId) : undefined;
      if (!stored) return attenuateBounds(parent, parentCellId, requested);
      const effectiveParent = meetBounds(parent, stored.bounds);
      const child = attenuateBounds(effectiveParent, parentCellId, requested);
      const violations = boundsViolations(child, parent, { parentCellId });
      if (violations.length > 0) throw new NgError("bounds_violation", `attenuate: ${violations.join("; ")}`);
      return child;
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

        if (requiresApproval(action)) return deferAction(action, meta, cell, boundVersion);
        return { type: "allow" };
      });
    },
    approveSync(actionId, approverId, seenArtifactVersion, approveOpts = {}): ApproveResult {
      assertOwnerOrAgent(approverId, "approving a card");
      return withTx(db, (): ApproveResult => {
        const row = approvalRow(actionId);
        if (!row) return "not_found";
        if (row.status === "approved" || row.status === "executed") {
          if (approveOpts.seenItemRevision !== undefined && approveOpts.seenItemRevision !== row.item_revision) {
            return "revision_mismatch";
          }
          return "approved";
        }
        if (row.status !== "pending") return "already_cancelled";
        if (approveOpts.seenItemRevision !== undefined && approveOpts.seenItemRevision !== row.item_revision) {
          return "revision_mismatch";
        }
        const cancel = (reason: string): ApproveResult => {
          if (row.status === "pending") resolveRow(row, "cancelled", reason);
          return "already_cancelled";
        };

        const cell = cells.get(row.cell_id);
        if (!cell) return cancel("task no longer exists");
        const inactive = inactiveReason(chainOf(cell), { allowPaused: true });
        if (inactive) return cancel(inactive);
        if (cell.epoch !== row.epoch) return cancel("task was cancelled or restarted");

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
          `UPDATE human_items SET disposition = 'approved', status_reason = NULL, revise_note = NULL, approver_id = ?, bound_version = ?, human_edited = ?,
             item_revision = item_revision + 1, resolved_at = COALESCE(resolved_at, ?), updated_at = ? WHERE action_id = ?`,
          [approverId, bound, humanEdited ? 1 : 0, now, now, row.action_id],
        );
        emitApproval(row, "approved");
        return "approved";
      });
    },

    revokeSync(cellId) {
      withTx(db, () => {
        const cell = cells.get(cellId);
        if (!cell) return;
        const ids = [cell.id, ...cells.descendants(cell.id).map((c) => c.id)];
        const now = clock.now();
        const inList = placeholders(ids.length);
        run(db, `UPDATE cells SET revoked_at = COALESCE(revoked_at, ?) WHERE id IN (${inList})`, [now, ...ids]);
        const pending = all<ApprovalRow>(db, `${approvalSelect} WHERE disposition IN ('pending','revising') AND cell_id IN (${inList})`, ids);
        for (const row of pending) resolveRow(row, "cancelled", "authority revoked");
      });
    },

    reinstateSync(cellId) {
      run(db, "UPDATE cells SET revoked_at = NULL WHERE id = ?", [cellId]);
    },
    listPendingSync(filter: PendingFilter = {}) {
      const params: SqlParam[] = [];
      let sql = `${approvalSelect} WHERE disposition = 'pending' AND cell_id IS NOT NULL AND action_hash <> ''`;
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
      let sql = `${approvalSelect} WHERE cell_id IS NOT NULL AND action_hash <> ''`;
      if (filter.status !== undefined) {
        if (filter.status.length === 0) return [];
        sql += ` AND disposition IN (${placeholders(filter.status.length)})`;
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
      const row = approvalRow(actionId);
      return row ? toApproval(row) : undefined;
    },

    findPendingBySubjectSync(subjectKey, cellId) {
      const row = pendingBySubject(subjectKey, cellId);
      return row?.cell_id && row.action_hash ? toApproval(row) : undefined;
    },

    snoozeSync(actionId, until, snoozeOpts = {}) {
      return withTx(db, () => {
        const row = approvalRow(actionId);
        if (!row || row.status !== "pending") return "not_pending";
        if (!Number.isFinite(until) || until <= clock.now()) throw new NgError("invalid_argument", "请选择未来的提醒时间");
        if (snoozeOpts.seenItemRevision !== undefined && snoozeOpts.seenItemRevision !== row.item_revision) return "revision_mismatch";
        run(db, "UPDATE human_items SET snoozed_until = ?, item_revision = item_revision + 1, updated_at = ? WHERE action_id = ?", [
          until,
          clock.now(),
          actionId,
        ]);
        emitApproval(row, "pending");
        opts.onSnooze?.(actionId, until, snoozeOpts.approverId ?? row.principal_id);
        return "snoozed";
      });
    },

    denySync(actionId, approverId, reason, denyOpts = {}) {
      assertOwnerOrAgent(approverId, "denying a card");
      return withTx(db, () => {
        const row = approvalRow(actionId);
        if (!row || row.status !== "pending") return "not_pending";
        if (denyOpts.seenItemRevision !== undefined && denyOpts.seenItemRevision !== row.item_revision) return "revision_mismatch";
        const now = clock.now();
        run(
          db,
          "UPDATE human_items SET disposition = 'denied', status_reason = ?, approver_id = ?, item_revision = item_revision + 1, resolved_at = ?, updated_at = ? WHERE action_id = ?",
          [reason === undefined ? null : reason, approverId, now, now, actionId],
        );
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
        if (row.artifact_id !== null) {
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
        run(
          db,
          "UPDATE human_items SET disposition = 'revising', snoozed_until = NULL, revise_note = ?, item_revision = item_revision + 1, updated_at = ? WHERE action_id = ?",
          [reviseOpts.note?.trim() || null, clock.now(), actionId],
        );
        emitApproval(row, "revising");
        return "revised";
      });
    },

    withdrawSync(actionId, reason, withdrawOpts = {}) {
      return withTx(db, () => {
        const row = approvalRow(actionId);
        if (!row || (row.status !== "pending" && row.status !== "revising")) return "not_pending";
        if (withdrawOpts.seenItemRevision !== undefined && withdrawOpts.seenItemRevision !== row.item_revision) return "revision_mismatch";
        resolveRow(row, "cancelled", reason);
        return "cancelled";
      });
    },

    recordOutcomeSync(actionId, status, outcome) {
      withTx(db, () => {
        const row = approvalRow(actionId);
        if (!row) throw new NgError("not_found", `approval "${actionId}" not found`);
        if (row.status === "executed") return;
        if (row.status !== "approved") throw new NgError("conflict", "item is not approved");
        const now = clock.now();
        run(
          db,
          "UPDATE human_items SET disposition = ?, outcome = ?, item_revision = item_revision + 1, resolved_at = COALESCE(resolved_at, ?), updated_at = ? WHERE action_id = ?",
          [status, toJson(outcome), now, now, actionId],
        );
        emitApproval(row, status);
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
      // An external main agent has the owner's rights on the control plane (proposal 07).
      if (p.kind === "owner" || p.kind === "agent") return { ok: true };
      if (p.kind !== "cell") return { ok: false, reason: "only the owner, an agent on the control plane, or an ancestor cell may control a cell" };
      const actor = cells.get(p.cellId);
      if (!actor) return { ok: false, reason: `unknown cell "${p.cellId}"` };
      const inactive = inactiveReason(chainOf(actor), { allowPaused: false });
      if (inactive) return { ok: false, reason: `${principalId}: ${inactive}` };
      if (!isStrictDescendant(actor.id, target.id)) return { ok: false, reason: `cell "${cellId}" is not a descendant of ${principalId}` };
      return { ok: true };
    },

  };
  return gate;
}
