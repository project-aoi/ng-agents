import {
  addCardExits,
  afterCommit,
  all,
  cellPrincipal,
  checkCardOptions,
  createEnvelope,
  get,
  KERNEL_FROM,
  newId,
  timerFrom,
  NgError,
  parsePrincipal,
  PAYLOAD,
  projectCellIdOf,
  run,
  withTx,
  type ApprovalStatus,
  type CardOption,
  type Deliverable,
  type HumanDecision,
  type HumanItem,
  type HumanItemDraft,
  type HumanItemStatus,
  type ProposedAction,
} from "@ng/protocol";
import { isBudgetEscalation, ownerOnlyApproval } from "@ng/gate";
import type { KernelCore } from "./core";
import { RESURFACE_MARKER } from "./constants";
import { isKernelEscalation } from "./escalations";

interface ItemRow {
  action_hash: string;
  action_id: string;
  cell_id: string | null;
  epoch: number | null;
  subject_key: string;
  status_reason: string | null;
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
  human_edited: number;
  category: HumanItem["category"];
  due_at: number | null;
  effort: string | null;
  snoozed_until: number | null;
}

export function createHumanItems(core: KernelCore) {
  const { db, clock, gate, context } = core;
  const row = (id: string) => get<ItemRow>(db, "SELECT * FROM human_items WHERE action_id = ? AND blocked_by IS NULL", [id]);
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
    const controlled = action && (action.type !== "custom" || isKernelEscalation(action) || !!ownerOnlyApproval({ ...action, card }, core.ownerAddresses));
    const callback = r.cell_id !== null;
    let options: CardOption[];
    if (r.disposition === "unknown")
      options = [
        { id: "system.sent", label: "已核实，对方收到了", effect: "execute" },
        { id: "system.not_sent", label: "已核实，对方没收到", effect: "execute" },
        { id: "system.defer", label: "稍后核实", effect: "defer" },
      ];
    else if (r.disposition === "approved" && action?.type === "channel.send") options = [];
    else if (r.disposition === "failed" && action?.type === "channel.send")
      options = [
        { id: "system.retry", label: "重新发送", effect: "execute" },
        { id: "system.abandon", label: "放弃发送", effect: "terminate" },
      ];
    else if (r.status === "resolved" || r.status === "cancelled") options = [];
    else {
      const defaults: CardOption[] = callback
        ? [
            controlled
              ? {
                  id: "system.execute",
                  label: action?.type === "channel.send" ? "确认发送" : action?.type === "project.start" ? "确认立项" : action && isKernelEscalation(action) ? "继续处理" : "批准执行",
                  effect: "execute",
                }
              : { id: "system.reply", label: "确认并回复", effect: "reply", input: { mode: "optional" } },
            ...(action?.type === "project.start" ? [{ id: "system.someday", label: "先放进以后再说", effect: "execute" as const }] : []),
            ...(r.artifact_id
              ? [{ id: "system.revise", label: "请修改", effect: "revise" as const, input: { mode: "required" as const } }]
              : []),
          ]
        : [{ id: "system.complete", label: "已办完", effect: "complete", input: { mode: "optional" } }];
      options = addCardExits(r.options ? (JSON.parse(r.options) as CardOption[]) : defaults, callback);
    }
    const art = r.artifact_id ? context.getArtifactSync(r.artifact_id) : null;
    const related = JSON.parse(r.related_project_ids) as string[];
    const holder = r.cell_id ? core.cells.get(r.cell_id) : undefined;
    const projectId = holder && (holder.preset === "project" ? holder.id : projectCellIdOf(holder.spec));
    if (projectId && !related.includes(projectId)) related.push(projectId);
    const attempt = action?.type === "channel.send" ? core.hub.getLatestOutboxByActionSync(r.action_id) : null;
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
      attempt: attempt?.attempts ?? null,
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
      for (const pid of related) if (core.cells.get(pid)?.preset !== "project") throw new NgError("invalid_argument", "unknown related project");
      for (const o of draft.options)
        if (o.terminateMode === "cancel_task" && !related.includes(o.targetCellIds![0]!))
          throw new NgError("invalid_argument", "cancel target must be an explicitly related project");
      const now = clock.now();
      if (draft.dueAt !== undefined && !Number.isFinite(draft.dueAt)) throw new NgError("invalid_argument", "invalid due date");
      const prior = get<ItemRow>(
        db,
        "SELECT * FROM human_items WHERE subject_key = ? AND blocked_by IS NULL AND status IN ('pending','snoozed','unknown')",
        [draft.subjectKey],
      );
      const card = JSON.stringify({
        format: "card",
        title: draft.title,
        body: draft.description ?? draft.title,
        data: { prep: draft.prep, rawInput: draft.rawInput, source: draft.source },
      });
      const action = { type: "custom", name: "human.reply", summary: draft.title, sideEffect: "none", subjectKey: draft.subjectKey };
      if (prior) {
        if (prior.action_hash !== "" || !prior.options || prior.cell_id !== cellId || prior.epoch !== (cell?.epoch ?? null))
          throw new NgError("conflict", "this subject has an open item");
        id = prior.action_id;
        run(
          db,
          `UPDATE human_items SET card=?, options=?, related_project_ids=?, item_revision=item_revision+1,
          updated_at=?, due_at=?, effort=?, category=? WHERE action_id=?`,
          [
            card,
            JSON.stringify(draft.options),
            JSON.stringify(related),
            now,
            draft.dueAt ?? null,
            draft.effort ?? null,
            draft.category ?? "decision",
            id,
          ],
        );
      } else
        run(
          db,
          `INSERT INTO human_items
        (action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card, options, related_project_ids, category, due_at, effort, created_at, updated_at)
        VALUES (?,?,?,?,?,'custom',?,'',?,?,?,?,?,?,?,?)`,
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
            now,
            now,
          ],
        );
      const created = row(id)!;
      changed(created);
      return project(created);
    });
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
    if (!["unknown", "pending", "snoozed"].includes(r.status)) return;
    run(db, "UPDATE human_items SET snoozed_until=NULL,item_revision=item_revision+1,updated_at=? WHERE action_id=?", [clock.now(), id]);
    changed(row(id)!);
  }

  function list(includeSnoozed = false): HumanItem[] {
    return all<ItemRow>(
      db,
      `SELECT * FROM human_items WHERE blocked_by IS NULL AND status IN ('pending','snoozed','unknown')
      AND (cell_id IS NOT NULL OR due_at IS NULL OR due_at <= ?) AND (? OR snoozed_until IS NULL OR snoozed_until <= ?)
      ORDER BY created_at, action_id`,
      [clock.now(), Number(includeSnoozed), clock.now()],
    ).map(project);
  }

  async function decide(
    id: string,
    d: HumanDecision,
    actor: string,
    onAccepted?: () => void,
  ): Promise<{ status: string; activityId?: string; restorable?: boolean }> {
    if (typeof actor !== "string" || !["owner", "agent"].includes(parsePrincipal(actor, core.ownerPrincipal).kind))
      throw new NgError("bounds_violation", "a control-plane actor is required");
    const r = row(id);
    if (!r) throw new NgError("not_found", "item is unavailable");
    const item = project(r);
    if (d.seenItemRevision !== item.itemRevision) throw new NgError("conflict", "事项已变动");
    const o = item.options.find((option) => option.id === d.optionId);
    if (!o) throw new NgError("conflict", "选项已变动");
    if (item.artifactId && d.seenArtifactVersion !== item.artifactVersion)
      throw new NgError("conflict", "草稿已变动");
    if (
      o.effect === "execute" &&
      actor !== core.ownerPrincipal &&
      item.action &&
      ownerOnlyApproval({ ...item.action, card: JSON.parse(r.card) }, core.ownerAddresses)
    )
      throw new NgError("bounds_violation", "这张卡需要主人批准");
    if (o.input?.mode === "required" && !d.note?.trim()) throw new NgError("invalid_argument", "请填写说明");
    const locks = {
      approverId: actor,
      seenItemRevision: d.seenItemRevision,
      ...(d.seenArtifactVersion === undefined ? {} : { seenArtifactVersion: d.seenArtifactVersion }),
    };
    if (r.disposition === "unknown" && o.effect === "execute") {
      if (d.seenAttempt === undefined) throw new NgError("invalid_argument", "send attempt required");
      return withTx(db, () => {
        const status = core.approvals.resolveUnknownSend(id, o.id === "system.sent" ? "sent" : "failed", {
          ...locks,
          seenAttempt: d.seenAttempt!,
          ...(d.note ? { note: d.note } : {}),
        });
        if (status === "resolved") onAccepted?.();
        return { status };
      });
    }
    if (o.effect === "execute") {
      if (o.id === "system.someday") throw new NgError("invalid_argument", "请通过工作台将方案放进以后再说");
      if (item.action?.type === "custom") {
        const raise = o.payload?.raise as { tokens?: number; cents?: number } | undefined;
        return core.approvals.resolve(
          id,
          {
            ...locks,
            decision: "continue",
            ...(d.note ? { note: d.note } : {}),
            ...(d.until !== undefined ? { until: d.until } : {}),
            ...(raise && typeof o.payload?.ledgerCellId === "string" ? { raise, budgetLedgerId: o.payload.ledgerCellId } : {}),
          },
          onAccepted,
        );
      }
      return core.approvals.resolve(id, { ...locks, decision: "approve" }, onAccepted);
    }
    if (o.effect === "revise" && r.action_hash !== "")
      return core.approvals.resolve(id, { ...locks, decision: "revise", instruction: d.note?.trim() || o.label }, onAccepted);
    return withTx(db, () => {
      let receiptCell: string | null = null;
      let receiptId: string | null = null;
      let activityId: string | undefined;
      if (row(id)?.item_revision !== d.seenItemRevision) throw new NgError("conflict", "item changed");
      if (o.effect !== "defer") onAccepted?.();
      if (o.effect === "revise") {
        if (!r.cell_id) throw new NgError("conflict", "修改意见没有接收方");
        core.approvals.sendRevision(r.cell_id, r.epoch!, actor, {
          actionId: id,
          subjectKey: r.subject_key,
          instruction: d.note?.trim() || o.label,
          ...(r.artifact_id ? { artifactId: r.artifact_id } : {}),
          ...core.approvals.humanEditInfo(
            {
              artifactId: r.artifact_id,
              humanEdited: item.humanEdited,
              proposedVersion: r.proposed_version,
              boundVersion: item.artifactVersion,
            },
            item.artifactVersion,
          ),
        });
        run(db, "UPDATE human_items SET item_revision=item_revision+1,updated_at=? WHERE action_id=?", [clock.now(), id]);
        changed(row(id)!);
        return { status: "revising" };
      }
      if (o.effect === "defer") {
        const until = d.until ?? clock.now() + 86_400_000;
        if (!Number.isSafeInteger(until) || until <= clock.now()) throw new NgError("invalid_argument", "choose a future time");
        run(db, "UPDATE human_items SET snoozed_until=?, updated_at=?, item_revision=item_revision+1 WHERE action_id=?", [
          until,
          clock.now(),
          id,
        ]);
        armResurface(id, until, actor);
      } else {
        const target = o.targetCellIds?.[0];
        if (o.terminateMode === "cancel_task") {
          if (
            !target ||
            core.cells.get(target)?.preset !== "project" ||
            !item.relatedProjectIds.includes(target) ||
            d.confirmedTargets?.length !== 1 ||
            d.confirmedTargets[0] !== target
          )
            throw new NgError("conflict", "confirm the exact project to close");
        }
        const alternative = o.effect === "reply" && r.action_hash !== "" && item.options.some((option) => option.effect === "execute");
        const disposition =
          o.id === "system.abandon" ? "cancelled" : o.effect === "terminate" ? "denied" : alternative ? "cancelled" : "executed";
        if (disposition === "denied" && r.action_hash && r.disposition === "pending") {
          if (gate.denySync(id, actor, d.note, locks) !== "denied") throw new NgError("conflict", "事项已变动");
        } else
          run(
            db,
            "UPDATE human_items SET disposition=?, approver_id=?, resolved_at=?, updated_at=?, item_revision=item_revision+1 WHERE action_id=?",
            [disposition, actor, clock.now(), clock.now(), id],
          );
        if (r.cell_id && item.action && (o.id !== "system.abandon" || r.approver_id === "policy:standing_rule")) {
          if (o.effect === "terminate" && isBudgetEscalation({ ...item.action, card: JSON.parse(r.card) })) {
            const ledger = isKernelEscalation(item.action)
              ? (item.action.args.limitedBy ?? item.action.args.cellId)
              : (gate.usageSync(r.cell_id).limitedBy ?? r.cell_id);
            gate.declineBudgetSync(ledger, actor);
            run(db, "UPDATE human_items SET status_reason=? WHERE action_id=?", ["budget_declined:" + ledger, id]);
          } else {
            const rec = gate.getApprovalSync(id);
            const destination = rec && core.approvals.deliveryTarget(rec);
            const issuer = core.cells.require(destination?.to ?? r.cell_id);
            const lineage = [issuer, ...core.cells.ancestors(issuer.id)];
            const closingRoot = o.terminateMode === "cancel_task" ? lineage.findIndex(c => c.id === target) : -1;
            const recipient = lineage.slice(closingRoot + 1).find(c =>
              c.status !== "closed" && (c.id !== issuer.id || c.epoch === (destination?.expectedEpoch ?? r.epoch))
            );
            if (!recipient) throw new NgError("conflict", "no live recipient");
            const edit = rec ? core.approvals.humanEditInfo(rec, item.artifactVersion) : { humanEdited: false };
            const envelope = createEnvelope(
              {
                id: `${id}:decision:${r.item_revision}`,
                from: KERNEL_FROM.approval,
                principalId: actor,
                kind: "result",
                type: PAYLOAD.approvalResolved,
                delivery: "wakeup",
                expectedEpoch: recipient.epoch,
                payload: {
                  actionId: id,
                  status: disposition,
                  action: item.action,
                  approverId: actor,
                  optionId: o.id,
                  label: o.label,
                  note: d.note,
                  payload: o.payload,
                  relatedProjectIds: item.relatedProjectIds,
                  ...edit,
                },
              },
              clock,
            );
            receiptCell = recipient.id;
            receiptId = envelope.id;
            core.inbox.enqueueSync(recipient.id, envelope);
            if (!core.inbox.listMessagesSync({ cellId: recipient.id, envelopeId: envelope.id, status: ["pending"] }).length)
              throw new NgError("conflict", "reply could not be queued");
          }
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
        activityId = newId("activity", clock);
        const before = {
          disposition: r.disposition,
          reason: r.status_reason,
          until: r.snoozed_until,
          actor: r.approver_id,
          resolvedAt: r.resolved_at,
        };
        run(
          db,
          `INSERT INTO human_item_activity(id,item_id,before_state,after_revision,receipt_cell,receipt_id,target_project,at)
          VALUES(?,?,?,?,?,?,?,?)`,
          [
            activityId,
            id,
            JSON.stringify(before),
            updated.item_revision,
            receiptCell,
            receiptId,
            o.terminateMode === "cancel_task" ? o.targetCellIds![0]! : null,
            clock.now(),
          ],
        );
      }
      changed(updated);
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
      const original = JSON.parse(current.action) as ProposedAction | null;
      if (actor !== core.ownerPrincipal && original && ownerOnlyApproval({ ...original, card: JSON.parse(current.card) }, core.ownerAddresses))
        throw new NgError("bounds_violation", "这张卡需要主人处理");
      const receipt =
        event.receipt_cell && event.receipt_id
          ? core.inbox.listMessagesSync({ cellId: event.receipt_cell, envelopeId: event.receipt_id })[0]
          : undefined;
      if (event.receipt_id && !receipt) throw new NgError("conflict", "无法确认后台是否已读");
      const claimed = receipt && receipt.firstClaimedAt !== null;
      if (claimed && event.target_project) throw new NgError("conflict", "后台已读这次中止决定，请使用 reopen_project 重新打开项目");
      if (claimed) {
        const issuer = core.cells.require(receipt.cellId);
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
                replyToId: receipt.envelope.id,
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
            `SELECT 1 FROM human_items WHERE subject_key=? AND action_id<>? AND blocked_by IS NULL AND status IN ('pending','snoozed','unknown')`,
            [current.subject_key, current.action_id],
          )
        )
          throw new NgError("conflict", "同一事项已有新的待处理决定");
        if (receipt && receipt.status === "pending") core.inbox.cancelScheduledSync({ cellId: receipt.cellId, envelopeId: receipt.envelope.id });
        if (event.target_project && epoch !== null) core.lifecycle.reopenProjectSync(event.target_project, actor, epoch);
        const prior = JSON.parse(event.before_state);
        if (current.status_reason?.startsWith("budget_declined:")) {
          gate.clearBudgetDeclinesSync(actor, current.status_reason.slice("budget_declined:".length));
        } else {
          const action = JSON.parse(current.action) as ProposedAction | null;
          if (action && isKernelEscalation(action) && action.args.reason === "budget_exhausted")
            gate.clearBudgetDeclinesSync(actor, action.args.limitedBy ?? action.args.cellId);
        }
        run(
          db,
          `UPDATE human_items SET disposition=?,status_reason=?,snoozed_until=?,approver_id=?,resolved_at=?,updated_at=?,epoch=CASE WHEN ? THEN (SELECT epoch FROM cells WHERE id=human_items.cell_id) ELSE epoch END,item_revision=item_revision+1 WHERE action_id=?`,
          [prior.disposition, prior.reason, prior.until, prior.actor, prior.resolvedAt, clock.now(), event.target_project ? 1 : 0, event.item_id],
        );
        if (prior.until > clock.now()) armResurface(event.item_id, prior.until, actor);
        changed(row(event.item_id)!);
      }
      run(db, "UPDATE human_item_activity SET undone_at=? WHERE id=?", [clock.now(), activityId]);
      return { status: claimed ? ("corrected" as const) : ("undone" as const), message: claimed ? "已通知后台更正" : "已撤销" };
    });
  }

  return {
    create,
    list,
    undo,
    armResurface,
    resurface,
    get: (id: string) => {
      const r = row(id);
      return r && project(r);
    },
    decide,
  };
}
