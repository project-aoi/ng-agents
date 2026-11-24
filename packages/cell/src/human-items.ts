import {
  addCardExits,
  afterCommit,
  all,
  cellPrincipal,
  checkCardOptions,
  createEnvelope,
  isProjectProposal,
  get,
  KERNEL_FROM,
  cellIdOf,
  newId,
  timerFrom,
  NgError,
  parsePrincipal,
  PAYLOAD,
  subjectKeys,
  stableStringify,
  run,
  withTx,
  type ApprovalStatus,
  type CardOption,
  type CellRecord,
  type Deliverable,
  type ApprovalRecord, type ApprovalOutcome, type ApprovalResolvedPayload, type ApprovalRevisePayload, type Envelope, type RunContinuePayload, type TimerFiredPayload,
  type HumanDecision,
  type HumanItem,
  type HumanItemDraft,
  type HumanItemStatus,
  type ProposedAction,
  type SettleItemRequest,
  type SettleItemResult,
} from "@ng/protocol";
import { requiresApproval } from "@ng/gate";
import { isProjectRoot, type KernelCore } from "./core";
import { RESURFACE_MARKER } from "./constants";
import { isKernelEscalation } from "./escalations";
import { sendCellMessage } from "./messages";

interface ItemRow {
  principal_id: string;
  action_hash: string;
  action_id: string;
  cell_id: string | null;
  epoch: number | null;
  subject_key: string;
  status_reason: string | null;
  outcome: string | null;
  resolved_at: number | null;
  approver_id: string | null;
  status: HumanItemStatus;
  disposition: ApprovalStatus;
  item_revision: number;
  card: string;
  action: string;
  options: string | null;
  related_project_ids: string;
  artifact_id: string | null;
  proposed_version: number | null;
  bound_version: number | null;
  human_edited: number;
  category: HumanItem["category"];
  due_at: number | null;
  effort: string | null;
  snoozed_until: number | null;
  created_at: number;
}

const HUMAN_DIFF_MAX = 1_500;

interface DecisionResult {
  status: string;
  activityId?: string;
  restorable?: boolean;
}

/** Compact line-level diff capped to `maxChars` so the agent sees exactly what the human changed without bloating prompts. */
function compactLineDiff(before: string, after: string, maxChars = HUMAN_DIFF_MAX): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  // Trim shared prefix and suffix for crisp diffs even on large drafts.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: string[] = [];
  if (start > 0) out.push(`@@ line ${start + 1} @@`);

  // Use LCS for bounded mid sections; fall back to direct removed/added block for very long rewrites.
  if (midA.length * midB.length <= 20_000) {
    const m = midA.length;
    const n = midB.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && midA[i] === midB[j]) {
        out.push(`  ${midA[i]}`);
        i++;
        j++;
      } else if (i < m && (j === n || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
        out.push(`- ${midA[i]}`);
        i++;
      } else {
        out.push(`+ ${midB[j]}`);
        j++;
      }
    }
  } else {
    for (const line of midA) out.push(`- ${line}`);
    for (const line of midB) out.push(`+ ${line}`);
  }
  const joined = out.join("\n").trim();
  if (joined.length <= maxChars) return joined;
  const suffix = "\n…(diff truncated)";
  return joined.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

export function createHumanItems(core: KernelCore) {
  const { inbox, cells, db, clock, gate, context } = core;
  const inflight = new Map<string, { key: string; acceptedRevision: number; promise: Promise<DecisionResult> }>();

  function humanEditInfo(
    rec: Pick<ApprovalRecord, "artifactId" | "humanEdited" | "proposedVersion" | "boundVersion">,
    targetVersion?: number | null,
  ): { humanEdited: boolean; humanDiff?: string; artifactVersion?: number } {
    if (!rec.artifactId) return { humanEdited: rec.humanEdited };
    const targetVerRec = targetVersion !== undefined && targetVersion !== null
      ? context.getArtifactVersionSync(rec.artifactId, targetVersion)
      : undefined;
    const cur = targetVerRec ?? context.getArtifactSync(rec.artifactId);
    const curVersion = targetVerRec?.version ?? cur?.version ?? rec.boundVersion;
    const baseVersion = rec.proposedVersion ?? rec.boundVersion;
    let edited = rec.humanEdited;
    if (!edited && baseVersion !== null && curVersion !== null && curVersion > baseVersion) {
      const versions = context.listArtifactVersionsSync(rec.artifactId);
      edited = versions.some((v) => v.version > baseVersion && v.version <= curVersion && v.updatedBy === "human") || cur?.updatedBy === "human";
    }
    if (!edited) return { humanEdited: false, ...(curVersion !== null ? { artifactVersion: curVersion } : {}) };
    const baseBody = baseVersion !== null ? context.getArtifactVersionSync(rec.artifactId, baseVersion)?.content.body : undefined;
    const curBody = cur?.content.body;
    const diff = baseBody !== undefined && curBody !== undefined && baseBody !== curBody ? compactLineDiff(baseBody, curBody, HUMAN_DIFF_MAX) : undefined;
    return {
      humanEdited: true,
      ...(diff ? { humanDiff: diff } : {}),
      ...(curVersion !== null ? { artifactVersion: curVersion } : {}),
    };
  }

  /** Verify an enqueue actually landed as `pending` (or was deduped against a live/delivered row when allowed). */
  function enqueueVerified(
    to: string,
    env: Envelope,
    opts: { schedule?: { deliverAt: number }; acceptDedupedDelivered?: boolean; forwardIfClosed?: boolean; what: string },
  ): void {
    const deliverTo = (targetId: string, envelope: Envelope): "ok" | "closed_or_stale" => {
      const r = inbox.enqueueSync(targetId, envelope, opts.schedule);
      const stored = inbox.listMessagesSync({ cellId: targetId, envelopeId: envelope.id })[0];
      if (!stored) {
        throw new NgError("conflict", `${opts.what}: envelope "${envelope.id}" missing after enqueue to "${targetId}"`);
      }
      if (r === "accepted") {
        if (stored.status === "pending") return "ok";
        if (stored.status === "dropped_epoch" || stored.status === "cancelled") return "closed_or_stale";
        throw new NgError("conflict", `${opts.what}: envelope "${envelope.id}" landed with status "${stored.status}" (${stored.statusReason ?? "unknown"})`);
      }
      // deduped: inspect the existing row's status (BUG-028).
      if (stored.status === "pending" || stored.status === "claimed" || stored.status === "done") {
        if (opts.acceptDedupedDelivered !== false) return "ok";
      }
      if (stored.status === "dropped_epoch" || stored.status === "cancelled") return "closed_or_stale";
      throw new NgError("conflict", `${opts.what}: envelope "${envelope.id}" deduped against status "${stored.status}" (${stored.statusReason ?? "unknown"})`);
    };

    const first = deliverTo(to, env);
    if (first === "ok") return;
    if (opts.forwardIfClosed) {
      const ancestor = cells.ancestors(to).find((a) => a.status !== "closed");
      if (ancestor) {
        const fwd: Envelope = { ...env, id: `${env.id}:fwd:${ancestor.id}`, expectedEpoch: ancestor.epoch };
        const second = deliverTo(ancestor.id, fwd);
        if (second === "ok") return;
      }
    }
    throw new NgError("conflict", `${opts.what}: target cell "${to}" closed or epoch moved; envelope "${env.id}" was not delivered`);
  }

  /**
   * The owning cell always learns the outcome (wake-up unless `silent`). Enqueue is verified inside the caller's
   * transaction — never swallows errors or silently accepts `dropped_epoch` / `cancelled`.
   */
  function deliveryTarget(rec: ApprovalRecord): { to: string; expectedEpoch: number } {
    let to = rec.cellId;
    let expectedEpoch = rec.epoch;
    if (isKernelEscalation(rec.action) && rec.action.args.cellId !== rec.cellId) {
      const affected = cells.get(rec.action.args.cellId);
      if (affected && affected.status !== "closed") {
        to = affected.id;
        expectedEpoch = affected.epoch;
      }
    }
    return { to, expectedEpoch };
  }

  function deliverResolved(
    rec: ApprovalRecord,
    status: ApprovalStatus,
    approverId: string,
    extra: {
      outcome?: ApprovalOutcome;
      note?: string;
      decision?: string;
      until?: number;
      silent?: boolean;
      forwardIfClosed?: boolean;
    } = {},
  ): void {
    const { to, expectedEpoch } = deliveryTarget(rec);
    const edit = humanEditInfo(rec, rec.boundVersion);
    // A project plan lives in its document: the version the decision is bound to is the plan, whatever was first drafted.
    let action = rec.action;
    if (action.type === "project.start" && rec.artifactId && rec.boundVersion !== null) {
      const plan = context.getArtifactVersionSync(rec.artifactId, rec.boundVersion)?.content.data;
      if (isProjectProposal(plan)) action = { ...action, proposal: plan, summary: `立项：${plan.title}` };
    }
    const payload: ApprovalResolvedPayload & { decision?: string; until?: number } = {
      actionId: rec.actionId,
      status,
      action,
      approverId,
      humanEdited: edit.humanEdited,
      ...(edit.humanDiff ? { humanDiff: edit.humanDiff } : {}),
      ...(rec.boundVersion !== null ? { artifactVersion: rec.boundVersion } : {}),
      ...(extra.outcome ? { outcome: extra.outcome } : {}),
      ...(extra.note !== undefined ? { note: extra.note } : {}),
      ...(extra.decision !== undefined ? { decision: extra.decision } : {}),
      ...(extra.until !== undefined ? { until: extra.until } : {}),
    };
    const env = createEnvelope(
      {
        id: `${rec.actionId}:resolved:${extra.decision ?? status}`,
        from: KERNEL_FROM.approval,
        principalId: approverId,
        kind: "result",
        type: PAYLOAD.approvalResolved,
        payload,
        expectedEpoch,
        delivery: extra.silent ? "silent_inject" : "wakeup",
      },
      clock,
    );
    enqueueVerified(to, env, {
      acceptDedupedDelivered: true,
      ...(extra.forwardIfClosed ? { forwardIfClosed: true } : {}),
      what: `approval.resolved for ${rec.actionId}`,
    });

  }

  const row = (id: string) => get<ItemRow>(db, "SELECT * FROM human_items WHERE action_id = ?", [id]);
  const changed = (r: ItemRow) =>
    afterCommit(db, () =>
      core.bus.emit("approval.changed", {
        actionId: r.action_id,
        cellId: r.cell_id ?? core.deskCellId,
        subjectKey: r.subject_key,
        status: r.disposition,
      }),
    );
  function project(r: ItemRow): HumanItem {
    const action: ProposedAction | null = JSON.parse(r.action);
    const card: Deliverable = JSON.parse(r.card);
    const info = card.data as Partial<HumanItemDraft> | undefined;
    const controlled = action && !!r.action_hash && requiresApproval(action);
    const callback = r.cell_id !== null;
    let options: CardOption[];
    if (r.status === "resolved" || r.status === "cancelled") options = [];
    else {
      const defaults: CardOption[] = callback
        ? [
            controlled
              ? {
                  id: "system.execute",
                  label: action && isKernelEscalation(action) ? "继续处理" : "批准执行",
                  effect: "execute",
                }
              : { id: "system.reply", label: "确认并回复", effect: "reply", input: { mode: "optional" } },
            ...(controlled && action.type === "custom" && !isKernelEscalation(action)
              ? [{id: "system.reply", label: "只回复", effect: "reply" as const, input: {mode: "optional" as const}}] : []),
            ...(r.artifact_id
              ? [{ id: "system.revise", label: "请修改", effect: "revise" as const, input: { mode: "required" as const } }]
              : []),
          ]
        : [{ id: "system.complete", label: "已办完", effect: "complete", input: { mode: "optional" } }];
      const custom = r.options ? (JSON.parse(r.options) as CardOption[]) : null;
      // A card about a draft can always be sent back for another draft, whatever choices its cell listed.
      if (custom && callback && r.artifact_id && !custom.some((o) => o.effect === "revise"))
        custom.push({ id: "system.revise", label: "请修改", effect: "revise", input: { mode: "required" }, group: "more" });
      options = addCardExits(custom ?? defaults, callback);
    }
    const art = r.artifact_id ? context.getArtifactSync(r.artifact_id) : null;
    const related = JSON.parse(r.related_project_ids) as string[];
    const holder = r.cell_id ? core.cells.get(r.cell_id) : undefined;
    const projectId = holder && [holder, ...cells.ancestors(holder.id)].find(c => isProjectRoot(core.registry, c))?.id;
    if (projectId && !related.includes(projectId)) related.push(projectId);
    const humanEdited =
      !!r.human_edited ||
      !!(
        art &&
        (art.updatedBy === "human" ||
          get(db, "SELECT 1 FROM artifact_versions WHERE artifact_id = ? AND version > ? AND updated_by = 'human' LIMIT 1", [
            r.artifact_id,
            r.proposed_version ?? 0,
          ]))
      );
    return {
      id: r.action_id,
      cellId: r.cell_id,
      epoch: r.epoch,
      subjectKey: r.subject_key,
      status: r.status,
      itemRevision: r.item_revision,
      createdAt: r.created_at,
      relatedProjectIds: related,
      options,
      title: card.title ?? action?.summary ?? r.subject_key,
      description: card.body,
      ...(info?.prep && { prep: info.prep }),
      ...(info?.rawInput && { rawInput: info.rawInput }),
      ...(info?.source && { source: info.source }),
      category: r.category,
      artifactId: r.artifact_id,
      artifactVersion: art?.version ?? null,
      humanEdited,
      action,
      snoozedUntil: r.snoozed_until,
      ...(r.due_at !== null ? { dueAt: r.due_at } : {}),
      ...(r.effort ? { effort: r.effort } : {}),
    };
  }

  function create(draft: HumanItemDraft, cellId: string | null, id = newId("act", clock), principalId = cellId ? cellPrincipal(cellId) : core.ownerPrincipal): HumanItem {
    if (draft.subjectKey?.startsWith("kernel:") && principalId !== "kernel:stall") throw new NgError("invalid_argument", "kernel subjects are reserved");
    return withTx(db, () => {
      checkCardOptions(draft.options, { callback: cellId !== null, controlled: false });
      if (!draft.title?.trim() || !draft.subjectKey?.trim()) throw new NgError("invalid_argument", "a title and subject are required");
      const cell = cellId === null ? null : core.cells.require(cellId);
      if (cell?.status === "closed") throw new NgError("conflict", "issuing cell is closed");
      const related = [...new Set(draft.relatedProjectIds ?? [])];
      const manages = (id: string) => !cell || id === cell.id || cells.ancestors(id).some(a => a.id === cell.id);
      for (const pid of related) {
        if (!isProjectRoot(core.registry, cells.get(pid))) throw new NgError("invalid_argument", "unknown related project");
        if (cell && !manages(pid) && !cells.ancestors(cell.id).some(a => a.id === pid))
          throw new NgError("bounds_violation", "关联项目超出发起任务的权限");
      }
      for (const o of draft.options)
        if (o.terminateMode === "cancel_task" && (!related.includes(o.targetCellIds![0]!) || !manages(o.targetCellIds![0]!)))
          throw new NgError("invalid_argument", "cancel target must be an explicitly related project");
      const now = clock.now();
      if (draft.dueAt !== undefined && !Number.isFinite(draft.dueAt)) throw new NgError("invalid_argument", "invalid due date");
      // A card about a draft is bound to the version that exists now: the owner's decision names the version they saw.
      const art = draft.artifactId ? context.getArtifactSync(draft.artifactId) : null;
      if (draft.artifactId && !art) throw new NgError("invalid_argument", `there is no artifact "${draft.artifactId}"`);
      const prior = get<ItemRow>(
        db,
        "SELECT * FROM human_items WHERE subject_key = ? AND cell_id IS ? AND status IN ('pending','snoozed')",
        [draft.subjectKey, cellId],
      );
      const card = JSON.stringify({
        format: "card",
        title: draft.title,
        body: draft.description ?? draft.title,
        data: { prep: draft.prep, rawInput: draft.rawInput, source: draft.source },
      });
      // The draft's id travels on the action, as it does for a gated approval: `approval.resolved` names it there.
      const action = { type: "custom", name: "human.reply", summary: draft.title, sideEffect: "none", subjectKey: draft.subjectKey, ...(art ? { artifactId: art.artifactId } : {}) };
      const existingId = row(id);
      if (existingId && existingId.action_id !== prior?.action_id) throw new NgError("conflict", "事项编号已被占用");
      if (prior) {
        if (prior.action_hash !== "" || !prior.options || prior.epoch !== (cell?.epoch ?? null) ||
            prior.category !== (draft.category ?? "decision") || prior.principal_id !== principalId)
          throw new NgError("conflict", "this subject has an open item");
        id = prior.action_id;
        run(
          db,
          `UPDATE human_items SET action=?, card=?, options=?, related_project_ids=?, item_revision=item_revision+1,
          updated_at=?, due_at=?, effort=?, category=?, artifact_id=?, proposed_version=?, bound_version=?, human_edited=0 WHERE action_id=?`,
          [
            JSON.stringify(action),
            card,
            JSON.stringify(draft.options),
            JSON.stringify(related),
            now,
            draft.dueAt ?? null,
            draft.effort ?? null,
            draft.category ?? "decision",
            art?.artifactId ?? null,
            art?.version ?? null,
            art?.version ?? null,
            id,
          ],
        );
      } else
        run(
          db,
          `INSERT INTO human_items
        (action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card, options, related_project_ids, category, due_at, effort, artifact_id, proposed_version, bound_version, created_at, updated_at)
        VALUES (?,?,?,?,?,'custom',?,'',?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            cellId,
            cell?.epoch ?? null,
            principalId,
            draft.subjectKey,
            JSON.stringify(action),
            card,
            JSON.stringify(draft.options),
            JSON.stringify(related),
            draft.category ?? "decision",
            draft.dueAt ?? null,
            draft.effort ?? null,
            art?.artifactId ?? null,
            art?.version ?? null,
            art?.version ?? null,
            now,
            now,
          ],
        );
      const created = row(id)!;
      changed(created);
      return project(created);
    });
  }

  /** An item of this cell or of a cell below it; an item without a cell (a personal reminder) is the desk's. */
  function ownedBy(r: ItemRow, cellId: string): boolean {
    if (r.cell_id === null) return cellId === core.deskCellId;
    return r.cell_id === cellId || cells.ancestors(r.cell_id).some(a => a.id === cellId);
  }

  /** Closes a pending item as answered by `actor`. What they said stays on the item (`outcome.note`). */
  function closeAnswered(r: ItemRow, how: { disposition: "executed" | "cancelled"; reason: string | null; actor: string; note?: string | undefined }): void {
    const note = how.note?.trim();
    run(db, "UPDATE human_items SET disposition=?, status_reason=?, approver_id=?, outcome=?, snoozed_until=NULL, resolved_at=?, updated_at=?, item_revision=item_revision+1 WHERE action_id=?",
      [how.disposition, how.reason, how.actor, note ? JSON.stringify({ note }) : r.outcome, clock.now(), clock.now(), r.action_id]);
  }

  /** Binds a decided item to the document version it was decided on, and records whether the owner edited it on the way. */
  function bindDocument(r: ItemRow, item: HumanItem): ReturnType<typeof humanEditInfo> {
    const edit = humanEditInfo({ artifactId: r.artifact_id, humanEdited: item.humanEdited, proposedVersion: r.proposed_version, boundVersion: r.bound_version }, item.artifactVersion);
    if (r.artifact_id) run(db, "UPDATE human_items SET bound_version=?, human_edited=? WHERE action_id=?", [item.artifactVersion, Number(edit.humanEdited), r.action_id]);
    return edit;
  }

  /** Tells `recipient` how an item was decided; the receipt is what undo takes back or corrects. */
  function sendReceipt(r: ItemRow, item: HumanItem, recipient: CellRecord, actor: string, id: string, payload: Record<string, unknown>): { cell: string; id: string } {
    const envelope = createEnvelope(
      {
        id, from: KERNEL_FROM.approval, principalId: actor, kind: "result", type: PAYLOAD.approvalResolved, delivery: "wakeup",
        expectedEpoch: recipient.epoch,
        payload: { actionId: r.action_id, action: item.action, approverId: actor, relatedProjectIds: item.relatedProjectIds, ...payload },
      },
      clock,
    );
    core.inbox.enqueueSync(recipient.id, envelope);
    if (!core.inbox.listMessagesSync({ cellId: recipient.id, envelopeId: envelope.id, status: ["pending"] }).length)
      throw new NgError("conflict", "reply could not be queued");
    return { cell: recipient.id, id: envelope.id };
  }

  /**
   * The activity undo works from: the item as it was, and who was told. `cell` without a receipt: that cell closed the
   * item itself, so it knows — undo tells it.
   */
  function recordActivity(before: ItemRow, after: { cell?: string | null; receiptId?: string | null; target?: string | null }): string {
    const updated = row(before.action_id)!;
    const activityId = newId("activity", clock);
    const state = { disposition: before.disposition, reason: before.status_reason, outcome: before.outcome, until: before.snoozed_until, actor: before.approver_id, resolvedAt: before.resolved_at };
    run(
      db,
      `INSERT INTO human_item_activity(id,item_id,before_state,after_revision,after_disposition,closed_epoch,receipt_cell,receipt_id,target_project,at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        activityId,
        before.action_id,
        JSON.stringify(state),
        updated.item_revision,
        updated.status_reason === "replied" ? "executed" : updated.disposition,
        after.target ? cells.require(after.target).epoch : null,
        after.cell ?? null,
        after.receiptId ?? null,
        after.target ?? null,
        clock.now(),
      ],
    );
    return activityId;
  }

  function withdraw(id: string, reason: string) {
    const r = row(id);
    if (!r || r.disposition !== "pending") return;
    if (r.action_hash) gate.withdrawSync(id, reason, {seenItemRevision: r.item_revision});
    else {
      run(db, "UPDATE human_items SET disposition='cancelled',status_reason=?,resolved_at=?,updated_at=?,item_revision=item_revision+1 WHERE action_id=?",
        [reason, clock.now(), clock.now(), id]);
      changed(row(id)!);
    }
  }

  function armResurface(id: string, until: number, actor: string) {
    const r = row(id)!;
    const root = core.cells.require(r.cell_id ? core.cells.require(r.cell_id).rootId : core.deskCellId);
    const group = `resurface:${id}`;
    core.inbox.cancelScheduledSync({ cellId: root.id, cancelGroup: group });
    const envelope = createEnvelope(
      {
        id: `${group}:${r.item_revision}`,
        from: timerFrom("approval"),
        principalId: actor,
        kind: "event",
        type: PAYLOAD.timerFired,
        expectedEpoch: root.epoch,
        payload: { label: "推迟的事项到期", data: { kernel: RESURFACE_MARKER, actionId: id, until } },
      },
      clock,
    );
    core.inbox.enqueueSync(root.id, envelope, { deliverAt: until, cancelGroup: group });
    if (!core.inbox.listMessagesSync({ cellId: root.id, envelopeId: envelope.id, status: ["pending"] }).length)
      throw new NgError("conflict", "could not arm reminder");
  }

  function resurface(id: string, until?: number) {
    const r = row(id);
    if (!r || r.snoozed_until === null || r.snoozed_until > clock.now() || (until !== undefined && until !== r.snoozed_until)) return;
    if (!["pending", "snoozed"].includes(r.status)) return;
    run(db, "UPDATE human_items SET snoozed_until=NULL,item_revision=item_revision+1,updated_at=? WHERE action_id=?", [clock.now(), id]);
    changed(row(id)!);
  }

  function list(includeSnoozed = false): HumanItem[] {
    return all<ItemRow>(
      db,
      `SELECT * FROM human_items WHERE status IN ('pending','snoozed')
      AND (cell_id IS NOT NULL OR due_at IS NULL OR due_at <= ?) AND (? OR snoozed_until IS NULL OR snoozed_until <= ?)
      ORDER BY created_at, action_id`,
      [clock.now(), Number(includeSnoozed), clock.now()],
    ).map(project);
  }

  async function decide(id: string, decision: HumanDecision, actor: string, onAccepted?: (item: HumanItem, option: CardOption) => void): Promise<DecisionResult> {
    const key = stableStringify({ actor, decision });
    const existing = inflight.get(id);
    if (existing?.key === key) {
      const current = row(id);
      if (current?.item_revision === existing.acceptedRevision &&
          (!current.artifact_id || context.getArtifactSync(current.artifact_id)?.version === decision.seenArtifactVersion)) return existing.promise;
    }
    if (existing) await existing.promise.catch(() => undefined);
    const result = withTx(db, () => applyDecision(id, decision, actor, onAccepted));
    if (result.status === "issuer_closed") throw new NgError("conflict", "事项所属任务已结束");
    const promise = Promise.resolve(result).finally(() => {
      if (inflight.get(id)?.promise === promise) inflight.delete(id);
    });
    inflight.set(id, { key, acceptedRevision: row(id)!.item_revision, promise });
    return promise;
  }

  function applyDecision(
    id: string,
    d: HumanDecision,
    actor: string,
    onAccepted?: (item: HumanItem, option: CardOption) => void,
  ): DecisionResult {
    if (typeof actor !== "string" || !["owner", "agent"].includes(parsePrincipal(actor, core.ownerPrincipal).kind))
      throw new NgError("bounds_violation", "a control-plane actor is required");
    const r = row(id);
    if (!r) throw new NgError("not_found", "item is unavailable");
    const item = project(r);
    if (r.status !== "pending" && r.status !== "snoozed") throw new NgError("conflict", `这件事项已经处理过了（${r.status === "cancelled" ? "已撤回或取消" : "已办结"}），不用再决定`);
    // A refusal says what is current (INV-UC01-03: "被拒并给出新版本"): whoever decides reads that version, not a guess.
    if (d.seenItemRevision !== item.itemRevision)
      throw new NgError("conflict", `事项已变动：现在是第 ${item.itemRevision} 版，提交的是第 ${d.seenItemRevision} 版。请重新查看后再决定`);
    const o = item.options.find((option) => option.id === d.optionId);
    if (!o) throw new NgError("conflict", `选项已变动：现在可选 ${item.options.map((option) => option.id).join("、")}`);
    if (item.artifactId && d.seenArtifactVersion !== item.artifactVersion)
      throw new NgError("conflict", `草稿已变动：现在是 v${item.artifactVersion}，提交的是${d.seenArtifactVersion === undefined ? "没有带版本" : ` v${d.seenArtifactVersion}`}。请先看过新版本再决定`);
    if (o.input?.mode === "required" && !d.note?.trim()) throw new NgError("invalid_argument", "请填写说明");
    const locks = {
      approverId: actor,
      seenItemRevision: d.seenItemRevision,
      ...(d.seenArtifactVersion === undefined ? {} : { seenArtifactVersion: d.seenArtifactVersion }),
    };
    return withTx(db, () => {
      let receipt: { cell: string; id: string } | null = null;
      let activityId: string | undefined;
      if (row(id)?.item_revision !== d.seenItemRevision) throw new NgError("conflict", "item changed");
      if (r.cell_id && r.disposition === "pending") {
        const issuer = cells.get(r.cell_id);
        if (!issuer || issuer.status === "closed" || issuer.epoch !== r.epoch) {
          withdraw(id, "issuer_closed");
          return { status: "issuer_closed" };
        }
      }
      if (o.effect !== "defer") onAccepted?.(item, o);
      if (o.effect === "execute") {
        const rec = gate.getApprovalSync(id);
        if (rec?.status !== "pending" || gate.approveSync(id, actor, d.seenArtifactVersion, locks) !== "approved")
          throw new NgError("conflict", "事项已变动");
        if (rec.action.type === "project.start") {
          const approved = gate.getApprovalSync(id)!;
          const issuer = cells.require(approved.cellId);
          const parent = issuer.preset && core.registry.presets.get(issuer.preset)?.approvedSpawn ? issuer : cells.require(core.deskCellId);
          const spawn = parent.preset ? core.registry.presets.get(parent.preset)?.approvedSpawn?.(approved, context, clock) : undefined;
          if (!spawn) throw new NgError("conflict", "当前任务无法执行这项已批准的操作，请交回主台");
          const started = core.lifecycle.spawnCell(parent.id, spawn.spec, spawn.task, { principalId: cellPrincipal(parent.id) });
          // What the owner wrote while approving is for the project that now starts: it reads it with its task.
          const note = d.note?.trim();
          if (note) {
            sendCellMessage(core, { from: KERNEL_FROM.control, principalId: actor, sender: actor, toCellId: cellIdOf(started), id: `${id}:approval-note`,
              message: { text: note, summary: "主人批准方案时的补充" } });
          }
          deliverResolved(approved, "approved", actor, note ? { note } : {});
          return { status: "approved" };
        }
        const retry = isKernelEscalation(rec.action) && rec.action.args.reason === "retry_limit" ? rec.action.args : null;
        gate.recordOutcomeSync(id, "executed", { note: d.note ?? o.label });
        if (retry?.stepLimit) continueSteps(retry.cellId, id);
        else if (retry) requeueDead(retry.cellId, retry.envelopeIds ?? []);
        deliverResolved(gate.getApprovalSync(id)!, "executed", actor, { decision: "continue", silent: !!retry, note: d.note, until: d.until });
        return { status: "continued" };
      }
      if (o.effect === "revise") {
        if (!r.cell_id) throw new NgError("conflict", "修改意见没有接收方");
        const rec = gate.getApprovalSync(id);
        if (rec && gate.reviseSync(id, actor, locks) !== "revised") throw new NgError("conflict", "草稿已变动");
        const target = rec ? deliveryTarget(rec) : { to: r.cell_id, expectedEpoch: r.epoch! };
        sendRevision(target.to, target.expectedEpoch, actor, {
          actionId: id,
          subjectKey: r.subject_key,
          instruction: d.note?.trim() || o.label,
          ...(r.artifact_id ? { artifactId: r.artifact_id } : {}),
          ...humanEditInfo({ artifactId: r.artifact_id, humanEdited: item.humanEdited, proposedVersion: r.proposed_version,
            boundVersion: item.artifactVersion }, item.artifactVersion),
        });
        if (!rec) {
          run(db, "UPDATE human_items SET item_revision=item_revision+1,updated_at=? WHERE action_id=?", [clock.now(), id]);
          changed(row(id)!);
        }
        return { status: "revising" };
      }
      if (o.effect === "defer") {
        const until = d.until ?? clock.now() + 86_400_000;
        if (!Number.isSafeInteger(until) || until <= clock.now()) throw new NgError("invalid_argument", "choose a future time");
        if (r.action_hash) {
          if (gate.snoozeSync(id, until, locks) !== "snoozed") throw new NgError("conflict", "事项已变动");
        } else {
          run(db, "UPDATE human_items SET snoozed_until=?, updated_at=?, item_revision=item_revision+1 WHERE action_id=?",
            [until, clock.now(), id]);
          armResurface(id, until, actor);
        }
      } else {
        const target = o.targetCellIds?.[0];
        if (o.terminateMode === "cancel_task") {
          if (
            !target ||
            !isProjectRoot(core.registry, core.cells.get(target)) ||
            !item.relatedProjectIds.includes(target) ||
            d.confirmedTargets?.length !== 1 ||
            d.confirmedTargets[0] !== target
          )
            throw new NgError("conflict", "confirm the exact project to close");
        }
        const alternative = o.effect === "reply" && r.action_hash !== "" && !!item.action && requiresApproval(item.action);
        const disposition =
          o.effect === "terminate" ? "denied" : alternative ? "cancelled" : "executed";
        if (disposition === "denied" && r.action_hash && r.disposition === "pending") {
          if (gate.denySync(id, actor, d.note, locks) !== "denied") throw new NgError("conflict", "事项已变动");
        } else closeAnswered(r, { disposition: disposition as "executed" | "cancelled", reason: alternative ? "replied" : null, actor, note: d.note });
        if (r.cell_id && item.action) {
          const rec = gate.getApprovalSync(id);
          const destination = rec && deliveryTarget(rec);
          const issuer = core.cells.require(destination?.to ?? r.cell_id);
          const lineage = [issuer, ...core.cells.ancestors(issuer.id)];
          const closingRoot = o.terminateMode === "cancel_task" ? lineage.findIndex(c => c.id === target) : -1;
          const recipient = lineage.slice(closingRoot + 1).find(c =>
            c.status !== "closed" && (c.id !== issuer.id || c.epoch === (destination?.expectedEpoch ?? r.epoch))
          );
          if (!recipient) throw new NgError("conflict", "no live recipient");
          receipt = sendReceipt(r, item, recipient, actor, `${id}:decision:${r.item_revision}`, {
            status: disposition, optionId: o.id, label: o.label, note: d.note, payload: o.payload, ...bindDocument(r, item),
          });
        }
        if (target && o.terminateMode === "cancel_task") {
          const closed = core.lifecycle.closeCellSync(target, "cancelled", { principalId: actor });
          afterCommit(db, () => {
            void core.track(core.lifecycle.cleanupClosed(closed));
          });
        }
      }
      const updated = row(id)!;
      if (o.effect !== "defer") {
        activityId = recordActivity(r, { cell: receipt?.cell ?? null, receiptId: receipt?.id ?? null, target: o.terminateMode === "cancel_task" ? o.targetCellIds![0]! : null });
      }
      if (!(r.action_hash && (o.effect === "defer" || o.effect === "terminate"))) changed(updated);
      return { status: updated.status, ...(activityId ? { activityId, restorable: true } : {}) };
    });
  }
  async function undo(activityId: string, actor: string) {
    if (typeof actor !== "string" || !["owner", "agent"].includes(parsePrincipal(actor, core.ownerPrincipal).kind))
      throw new NgError("bounds_violation", "explicit workbench actor required");
    const targetProject = get<{ target_project: string | null }>(db, "SELECT target_project FROM human_item_activity WHERE id=?", [
      activityId,
    ])?.target_project;
    const epoch = targetProject ? await core.lifecycle.waitForClosedProject(targetProject) : null;
    return withTx(db, () => {
      const event = get<{
        item_id: string;
        after_revision: number;
        closed_epoch: number | null;
        receipt_cell: string | null;
        receipt_id: string | null;
        before_state: string;
        undone_at: number | null;
        target_project: string | null;
      }>(db, "SELECT * FROM human_item_activity WHERE id=?", [activityId]);
      if (!event) throw new NgError("not_found", "找不到这次操作");
      if (event.undone_at !== null) throw new NgError("conflict", "这次操作已撤销");
      const current = row(event.item_id);
      if (!current || current.item_revision !== event.after_revision) throw new NgError("conflict", "事项已有后续操作");
      const receipt =
        event.receipt_cell && event.receipt_id
          ? core.inbox.listMessagesSync({ cellId: event.receipt_cell, envelopeId: event.receipt_id })[0]
          : undefined;
      if (event.receipt_id && !receipt) throw new NgError("conflict", "无法确认后台是否已读");
      // Closed by a cell on the owner's word (no receipt): it has known all along. Its own item is then its to put right;
      // one that no cell holds (a personal reminder) goes back on the owner's list, and the cell is told.
      const settledBy = event.receipt_id ? null : event.receipt_cell;
      const claimed = (settledBy !== null && current.cell_id !== null) || (!!receipt && receipt.firstClaimedAt !== null);
      if (claimed && event.target_project) throw new NgError("conflict", "后台已读这次中止决定，请在已结束的项目中选择重新打开");
      const recipient = receipt && cells.get(receipt.cellId);
      let corrected = claimed || !!recipient && (recipient.status === "closed" || (receipt?.envelope.expectedEpoch != null && recipient.epoch !== receipt.envelope.expectedEpoch)) || !event.target_project && !!current.cell_id && cells.require(current.cell_id).epoch !== current.epoch;
      if (event.target_project && epoch !== null && !claimed) {
        const target = cells.require(event.target_project);
        if (target.epoch !== event.closed_epoch || epoch !== event.closed_epoch) throw new NgError("conflict", "项目已另行重开或关闭");
        if (target.status === "closed" && target.epoch === epoch) {
          try {
            core.lifecycle.reopenProjectSync(target.id, actor, epoch);
          } catch (error) {
            if (!(error instanceof NgError) || (error.code !== "bounds_violation" && error.code !== "conflict")) throw error;
          }
        }
        corrected = cells.require(target.id).status !== "active" || !!current.cell_id && cells.require(current.cell_id).status !== "active";
      }
      if (corrected) {
        if (receipt?.status === "pending" && !claimed) core.inbox.cancelScheduledSync({cellId: receipt.cellId, envelopeId: receipt.envelope.id});
        const issuer = cells.require(receipt?.cellId ?? settledBy ?? event.target_project ?? current.cell_id ?? core.deskCellId);
        const target = issuer.status !== "closed" ? issuer : core.cells.ancestors(issuer.id).find((c) => c.status !== "closed");
        if (!target) throw new NgError("conflict", "找不到可接收更正的后台分身");
        const result = core.inbox.enqueueSync(
          target.id,
          createEnvelope(
            {
              id: `${activityId}:correction`,
              from: KERNEL_FROM.control,
              principalId: actor,
              kind: "event",
              type: PAYLOAD.cellMessage,
              expectedEpoch: target.epoch,
              payload: {
                fromCellId: core.deskCellId,
                ...(receipt ? {replyToId: receipt.envelope.id} : {}),
                text: `主人已撤回对事项 ${event.item_id} 的决定。请核实现状并更正，必要时重新请求确认。`,
              },
            },
            clock,
          ),
        );
        if (
          result !== "accepted" ||
          !core.inbox.listMessagesSync({ cellId: target.id, envelopeId: `${activityId}:correction`, status: ["pending"] }).length
        )
          throw new NgError("conflict", "更正未能送达");
      } else {
        if (
          get(
            db,
            `SELECT 1 FROM human_items WHERE subject_key=? AND cell_id IS ? AND action_id<>? AND status IN ('pending','snoozed')`,
            [current.subject_key, current.cell_id, current.action_id],
          )
        )
          throw new NgError("conflict", "同一事项已有新的待处理决定");
        if (receipt && receipt.status === "pending") core.inbox.cancelScheduledSync({ cellId: receipt.cellId, envelopeId: receipt.envelope.id });
        const prior = JSON.parse(event.before_state);
        run(
          db,
          `UPDATE human_items SET disposition=?,status_reason=?,outcome=?,snoozed_until=?,approver_id=?,resolved_at=?,updated_at=?,epoch=CASE WHEN ? THEN (SELECT epoch FROM cells WHERE id=human_items.cell_id) ELSE epoch END,item_revision=item_revision+1 WHERE action_id=?`,
          [prior.disposition, prior.reason, prior.outcome ?? null, prior.until > clock.now() ? prior.until : null, prior.actor, prior.resolvedAt, clock.now(), event.target_project ? 1 : 0, event.item_id],
        );
        if (prior.until > clock.now()) armResurface(event.item_id, prior.until, actor);
        const restored = row(event.item_id)!;
        changed(restored);
        const knows = settledBy ? cells.get(settledBy) : undefined;
        if (knows && knows.status !== "closed") {
          core.inbox.enqueueSync(knows.id, createEnvelope({
            id: `${activityId}:undone`, from: KERNEL_FROM.control, principalId: actor, kind: "event", type: PAYLOAD.cellMessage,
            expectedEpoch: knows.epoch, delivery: "silent_inject",
            payload: { fromCellId: core.deskCellId, text: `主人撤销了你按他的话对「${project(restored).title}」的结清：它又在主人的待办里了。` },
          }, clock));
        }
      }
      if (corrected) changed(current);
      run(db, "UPDATE human_item_activity SET undone_at=? WHERE id=?", [clock.now(), activityId]);
      return { status: corrected ? ("corrected" as const) : ("undone" as const), message: corrected ? "已通知后台更正" : "已撤销" };
    });
  }

  function sendRevision(cellId:string, epoch:number, actor:string, payload:ApprovalRevisePayload & {subjectKey:string; target?:string}) {
    const env = createEnvelope({from:KERNEL_FROM.approval, principalId:actor, kind:"event", type:PAYLOAD.approvalRevise,
      expectedEpoch:epoch, payload},clock);
    enqueueVerified(cellId,env,{what:`approval.revise for ${payload.actionId}`,acceptDedupedDelivered:false});
  }

  /** "Continue" on a step-limit card: one fresh continuation (the consecutive count starts over). */
  function continueSteps(cellId: string, actionId: string): void {
    const cell = cells.get(cellId);
    if (!cell || cell.status === "closed") return;
    const payload: RunContinuePayload = { reason: "step_limit", count: 1 };
    const env = createEnvelope<RunContinuePayload>(
      { id: `${actionId}:continue`, from: KERNEL_FROM.dispatcher, principalId: cellPrincipal(cellId), kind: "event", type: PAYLOAD.runContinue, payload, expectedEpoch: cell.epoch },
      clock,
    );
    enqueueVerified(cellId, env, { what: `step-limit continue for ${actionId}` });
  }

  /** "Continue" on a dead letter: the same messages again, under new ids (the old rows stay `dead` for the record). */
  function requeueDead(cellId: string, envelopeIds: readonly string[]): void {
    const cur = cells.get(cellId);
    if (!cur || cur.status === "closed") return;
    const wanted = new Set(envelopeIds);
    for (const m of inbox.listMessagesSync({ cellId, status: ["dead"] })) {
      if (!wanted.has(m.envelope.id)) continue;
      const { to: _to, expectedEpoch: _e, ...rest } = m.envelope;
      const env: Envelope = { ...rest, id: `${m.envelope.id}#retry:${newId("r", clock)}`, createdAt: clock.now() };
      enqueueVerified(cellId, env, { what: `requeue dead envelope ${m.envelope.id}` });
    }
  }

  return {
    superseded(rec: ApprovalRecord, actor: string) { deliverResolved(rec, "superseded", actor, {forwardIfClosed:true}); },
    resurfaced(env: Envelope) {
      const data = (env.payload as TimerFiredPayload).data as { actionId?: string; until?: number } | undefined;
      if (data?.actionId) resurface(data.actionId, data.until);
    },
    create,
    list,
    undo,
    withdrawForClosedCells(closed: readonly {id: string; epoch: number}[]) {
      for (const {id,epoch} of closed) {
        for (const r of all<{action_id: string}>(db, "SELECT action_id FROM human_items WHERE cell_id=? AND epoch<? AND disposition='pending'", [id,epoch]))
          withdraw(r.action_id, "issuer_closed");
        if (!isProjectRoot(core.registry, cells.get(id))) continue;
        const held = all<ItemRow>(db, `SELECT * FROM human_items WHERE cell_id=? AND category='decision' AND disposition='pending'
          AND (subject_key=? OR EXISTS(SELECT 1 FROM json_each(related_project_ids) WHERE value=?))`,
          [core.deskCellId, subjectKeys.project(id), id]);
        for (const r of held) {
          const related = JSON.parse(r.related_project_ids) as string[];
          if (related.every(pid => cells.get(pid)?.status === "closed")) withdraw(r.action_id, "project_closed");
        }
      }
    },
    /** A cell takes back an undecided card or human action of its own, or of a cell below it (the desk: also a personal reminder). */
    withdrawOwn(id: string, cellId: string, reason: string): "withdrawn" | "not_pending" | "not_found" {
      const r = row(id);
      if (!r || !ownedBy(r, cellId)) return "not_found";
      if (r.disposition !== "pending") return "not_pending";
      withdraw(id, reason);
      return "withdrawn";
    },
    /**
     * The owner settled an open item in conversation ("浇水浇过了", "报告行了") and the cell that holds it, or one above
     * it, closes it on their word — as a decision would: checked against the item revision and document version they
     * were talking about, bound to that version, with whose word it was and what they said on record, the holder told
     * when somebody above it did this, and undoable. Never an approval: a card with an option that executes something
     * (an outward action, a project to start) is decided on the card, where the owner sees what they approve.
     */
    settleOwn(id: string, cellId: string, how: SettleItemRequest & { approverId?: string }): SettleItemResult {
      return withTx(db, () => {
        const r = row(id);
        if (!r || !ownedBy(r, cellId)) return { status: "not_found" };
        if (r.disposition !== "pending") return { status: "not_pending" };
        const item = project(r);
        if (item.options.some((o) => o.effect === "execute")) return { status: "needs_owner" };
        if (how.seenItemRevision !== item.itemRevision || (item.artifactId !== null && how.seenArtifactVersion !== item.artifactVersion))
          return { status: "stale", itemRevision: item.itemRevision, artifactVersion: item.artifactVersion };
        const actor = how.approverId ?? cellPrincipal(cellId);
        // A card the Gate holds is closed the way a reply on it closes it (decided otherwise than by executing).
        closeAnswered(r, { ...(r.action_hash ? { disposition: "cancelled", reason: "replied" } : { disposition: "executed", reason: "settled_in_conversation" }), actor, note: how.ownerWords });
        const edit = bindDocument(r, item);
        // Settled from above (the desk, for an item a project holds): it is what the holder was waiting for.
        const holder = r.cell_id !== null && r.cell_id !== cellId ? cells.get(r.cell_id) : undefined;
        const receipt = holder && holder.status !== "closed" && holder.epoch === r.epoch
          ? sendReceipt(r, item, holder, actor, `${id}:settled:${r.item_revision}`, { status: "executed", label: "主人在对话里答复了", note: how.ownerWords.trim(), ...edit })
          : null;
        recordActivity(r, receipt ? { cell: receipt.cell, receiptId: receipt.id } : { cell: cellId });
        changed(row(id)!);
        return { status: "settled" };
      });
    },
    armResurface,
    resurface,
    get: (id: string) => {
      const r = row(id);
      return r && project(r);
    },
    decide,
  };
}
