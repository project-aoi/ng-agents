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
  type ApprovalRecord, type ApprovalOutcome, type ApprovalResolvedPayload, type ApprovalRevisePayload, type Envelope, type RunContinuePayload, type TimerFiredPayload,
  type HumanDecision,
  type HumanItem,
  type HumanItemDraft,
  type HumanItemStatus,
  type ProposedAction,
} from "@ng/protocol";
import type { ApprovalDecision, ResolveApprovalResult } from "./types";
import { ownerOnlyApproval } from "@ng/gate";
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

const HUMAN_DIFF_MAX = 1_500;

interface InflightEntry {
  decision: ApprovalDecision["decision"];
  startedRevision: number | null;
  promise: Promise<ResolveApprovalResult>;
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
  const inflight = new Map<string, InflightEntry>();

  function currentVersion(rec: ApprovalRecord): number | null {
    return rec.artifactId ? (context.getArtifactSync(rec.artifactId)?.version ?? null) : null;
  }

  function assertExplicitActor(approverId: unknown, what: string): string {
    if (typeof approverId !== "string" || !approverId.trim()) {
      throw new NgError("invalid_argument", `${what}: approverId is required`);
    }
    const kind = parsePrincipal(approverId, core.ownerPrincipal).kind;
    if (kind !== "owner" && kind !== "agent") {
      throw new NgError("bounds_violation", `${what} needs the owner or an agent on the control plane; ${approverId} may not`);
    }
    return approverId;
  }
  function assertMayDecide(rec: ApprovalRecord, approverId: string, what: string): void {
    assertExplicitActor(approverId, what);
    if (parsePrincipal(approverId, core.ownerPrincipal).kind === "owner") return;
    const why = ownerOnlyApproval({ ...rec.action, card: rec.card });
    if (why) throw new NgError("bounds_violation", `${what} needs the owner (${why}); ${approverId} may not`);
  }

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
    const payload: ApprovalResolvedPayload & { decision?: string; until?: number } = {
      actionId: rec.actionId,
      status,
      action: rec.action,
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
    const controlled = action && (action.type !== "custom" || isKernelEscalation(action) || !!ownerOnlyApproval({ ...action, card }));
    const callback = r.cell_id !== null;
    let options: CardOption[];
    if (r.status === "resolved" || r.status === "cancelled") options = [];
    else {
      const defaults: CardOption[] = callback
        ? [
            controlled
              ? {
                  id: "system.execute",
                  label: action?.type === "project.start" ? "确认立项" : action && isKernelEscalation(action) ? "继续处理" : "批准执行",
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
        "SELECT * FROM human_items WHERE subject_key = ? AND status IN ('pending','snoozed')",
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
      ownerOnlyApproval({ ...item.action, card: JSON.parse(r.card) })
    )
      throw new NgError("bounds_violation", "这张卡需要主人批准");
    if (o.input?.mode === "required" && !d.note?.trim()) throw new NgError("invalid_argument", "请填写说明");
    const locks = {
      approverId: actor,
      seenItemRevision: d.seenItemRevision,
      ...(d.seenArtifactVersion === undefined ? {} : { seenArtifactVersion: d.seenArtifactVersion }),
    };
    if (o.effect === "execute") {
      if (o.id === "system.someday") throw new NgError("invalid_argument", "请通过工作台将方案放进以后再说");
      if (item.action?.type === "custom") {
        return resolve(
          id,
          {
            ...locks,
            decision: "continue",
            ...(d.note ? { note: d.note } : {}),
            ...(d.until !== undefined ? { until: d.until } : {}),
          },
          onAccepted,
        );
      }
      return resolve(id, { ...locks, decision: "approve" }, onAccepted);
    }
    if (o.effect === "revise" && r.action_hash !== "")
      return resolve(id, { ...locks, decision: "revise", instruction: d.note?.trim() || o.label }, onAccepted);
    return withTx(db, () => {
      let receiptCell: string | null = null;
      let receiptId: string | null = null;
      let activityId: string | undefined;
      if (row(id)?.item_revision !== d.seenItemRevision) throw new NgError("conflict", "item changed");
      if (o.effect !== "defer") onAccepted?.();
      if (o.effect === "revise") {
        if (!r.cell_id) throw new NgError("conflict", "修改意见没有接收方");
        sendRevision(r.cell_id, r.epoch!, actor, {
          actionId: id,
          subjectKey: r.subject_key,
          instruction: d.note?.trim() || o.label,
          ...(r.artifact_id ? { artifactId: r.artifact_id } : {}),
          ...humanEditInfo(
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
          o.effect === "terminate" ? "denied" : alternative ? "cancelled" : "executed";
        if (disposition === "denied" && r.action_hash && r.disposition === "pending") {
          if (gate.denySync(id, actor, d.note, locks) !== "denied") throw new NgError("conflict", "事项已变动");
        } else
          run(
            db,
            "UPDATE human_items SET disposition=?, approver_id=?, resolved_at=?, updated_at=?, item_revision=item_revision+1 WHERE action_id=?",
            [disposition, actor, clock.now(), clock.now(), id],
          );
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
            const edit = rec ? humanEditInfo(rec, item.artifactVersion) : { humanEdited: false };
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
      if (actor !== core.ownerPrincipal && original && ownerOnlyApproval({ ...original, card: JSON.parse(current.card) }))
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
            `SELECT 1 FROM human_items WHERE subject_key=? AND action_id<>? AND status IN ('pending','snoozed')`,
            [current.subject_key, current.action_id],
          )
        )
          throw new NgError("conflict", "同一事项已有新的待处理决定");
        if (receipt && receipt.status === "pending") core.inbox.cancelScheduledSync({ cellId: receipt.cellId, envelopeId: receipt.envelope.id });
        if (event.target_project && epoch !== null) core.lifecycle.reopenProjectSync(event.target_project, actor, epoch);
        const prior = JSON.parse(event.before_state);
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

  async function decideApproval(actionId: string, d: ApprovalDecision, onAccepted?:()=>void): Promise<ResolveApprovalResult> {
    if (d.decision === "approve") return withTx(db, (): ResolveApprovalResult => {
      const before = gate.getApprovalSync(actionId);
      if (!before) return { status: "not_found", actionId };
      const result = gate.approveSync(actionId, d.approverId, d.seenArtifactVersion, d.seenItemRevision === undefined ? {} : { seenItemRevision: d.seenItemRevision });
      if (result === "version_mismatch") return { status: result, actionId, currentVersion: currentVersion(before) };
      if (result === "revision_mismatch") return { status: result, actionId, currentRevision: before.itemRevision };
      if (result !== "approved") return { status: result, actionId };
      if (before.status === "pending") {
        onAccepted?.();
        const rec = gate.getApprovalSync(actionId)!;
        const issuer = cells.require(rec.cellId);
        const spawn = issuer.preset ? core.registry.presets.get(issuer.preset)?.approvedSpawn?.(rec, context, clock) : undefined;
        if (spawn) core.lifecycle.spawnCell(issuer.id, spawn.spec, spawn.task, { principalId: cellPrincipal(issuer.id) });
        deliverResolved(rec, "approved", d.approverId);
      }
      return { status: result, actionId };
    });
    const approverId = assertExplicitActor(d.approverId, `deciding "${d.decision}" on a card`);
    const revOpts = d.seenItemRevision !== undefined ? { seenItemRevision: d.seenItemRevision } : {};

    switch (d.decision) {
      case "deny":
      case "snooze": {
        const item = core.humanItems.get(actionId);
        if (!item) return {status:"not_found", actionId};
        if (d.seenItemRevision !== undefined && d.seenItemRevision !== item.itemRevision)
          return {status:"revision_mismatch", actionId, currentRevision:item.itemRevision};
        const option = item.options.find(o=>d.decision === "snooze" ? o.effect === "defer" : o.effect === "terminate" && o.terminateMode !== "cancel_task");
        if (!option || gate.getApprovalSync(actionId)?.status !== "pending") return {status:"not_pending",actionId};
        // These historical commands act on the card itself, never on its draft.
        await core.humanItems.decide(actionId, {optionId:option.id, seenItemRevision:item.itemRevision,
          ...(item.artifactVersion !== null ? {seenArtifactVersion:item.artifactVersion} : {}),
          ...(d.decision==="snooze" ? {until:d.until} : d.reason ? {note:d.reason} : {})}, approverId);
        return {status:d.decision === "deny" ? "denied" : "snoozed", actionId};
      }

      case "revise": {
        if (typeof d.instruction !== "string" || !d.instruction.trim()) throw new NgError("invalid_argument", "revise needs an instruction");
        return withTx(db, (): ResolveApprovalResult => {
          const rec = gate.getApprovalSync(actionId);
          if (!rec) return { status: "not_found", actionId };
          if (rec.status !== "pending") return { status: "not_pending", actionId, reason: rec.status };
          const r = gate.reviseSync(actionId, approverId, {
            ...revOpts,
            ...(d.seenArtifactVersion !== undefined ? { seenArtifactVersion: d.seenArtifactVersion } : {}),
          });
          if (r === "revision_mismatch") return { status: "revision_mismatch", actionId, currentRevision: rec.itemRevision };
          if (r === "version_mismatch") return { status: "version_mismatch", actionId, currentVersion: currentVersion(rec) };
          if (r !== "revised") return { status: "not_pending", actionId };
          onAccepted?.();
          const edit = humanEditInfo(rec);
          // subjectKey/target let the redraft re-defer under the same subject, which updates this card in place.
          const payload: ApprovalRevisePayload & { subjectKey: string; target?: string } = {
            actionId,
            instruction: d.instruction,
            subjectKey: rec.subjectKey,
            ...(rec.artifactId ? { artifactId: rec.artifactId } : {}),
            ...(edit.artifactVersion !== undefined ? { artifactVersion: edit.artifactVersion } : {}),
            ...(edit.humanEdited ? { humanEdited: true } : {}),
            ...(edit.humanDiff ? { humanDiff: edit.humanDiff } : {}),
            ...(d.voice ? { voice: true } : {}),
          };
          const {to, expectedEpoch} = deliveryTarget(rec);
          sendRevision(to, expectedEpoch, approverId, payload);
          return { status: "revising", actionId };
        });
      }

      case "continue": {
        return withTx(db, (): ResolveApprovalResult => {
          const rec = gate.getApprovalSync(actionId);
          if (!rec) return { status: "not_found", actionId };
          if (rec.status !== "pending") return { status: "not_pending", actionId, reason: rec.status };
          assertMayDecide(rec, approverId, "continuing this card");

          const kernelArgs = isKernelEscalation(rec.action) ? rec.action.args : null;
          const a = gate.approveSync(actionId, approverId, d.seenArtifactVersion, revOpts);
          if (a === "revision_mismatch") return { status: "revision_mismatch", actionId, currentRevision: rec.itemRevision };
          if (a === "version_mismatch") return {status:"version_mismatch", actionId, currentVersion:currentVersion(rec)};
          if (a === "already_cancelled") return { status: "already_cancelled", actionId };
          if (a !== "approved") return { status: "not_pending", actionId };
          onAccepted?.();

          gate.recordOutcomeSync(actionId, "executed", { note: d.note ?? "continued by the owner" });
          if (kernelArgs?.reason === "retry_limit") {
            if (kernelArgs.stepLimit) continueSteps(kernelArgs.cellId, actionId);
            else requeueDead(kernelArgs.cellId, kernelArgs.envelopeIds ?? []);
            deliverResolved(rec, "executed", approverId, { decision: "continue", silent: true, ...(d.note ? {note:d.note} : {}), ...(d.until !== undefined ? {until:d.until} : {}) });
          } else {
            deliverResolved(rec, "executed", approverId, {
              decision: "continue",
              ...(d.note ? { note: d.note } : {}),
              ...(d.until ? { until: d.until } : {}),
            });
          }
          return { status: "continued", actionId };
        });
      }

      case "resolve_offline":
      case "dismiss": {
        const offline = d.decision === "resolve_offline";
        const note = offline ? d.note : d.reason;
        const reason = note ?? (offline ? "resolved offline by the owner" : "dismissed by the owner");
        return withTx(db, (): ResolveApprovalResult => {
          const rec = gate.getApprovalSync(actionId);
          if (!rec) return { status: "not_found", actionId };
          const result = gate.withdrawSync(actionId, reason, revOpts);
          if (result === "revision_mismatch") return {status:result, actionId, currentRevision:rec.itemRevision};
          if (result !== "cancelled") return {status:"not_pending", actionId};
          deliverResolved(rec, "cancelled", approverId, {decision:d.decision, ...(note ? {note} : offline ? {note:"已在线下解决"} : {})});
          return offline ? {status:"resolved_offline",actionId,closedCellIds:[]} : {status:"dismissed",actionId};
        });
      }
    }
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

  async function resolve(actionId: string, decision: ApprovalDecision, onAccepted?: () => void): Promise<ResolveApprovalResult> {
    // BUG-020: Validate actor identity & ownerOnly policy BEFORE consulting inflight.
    const approverId = assertExplicitActor(decision.approverId, `deciding "${decision.decision}" on a card`);
    const pre = gate.getApprovalSync(actionId);
    if (pre && (decision.decision === "approve" || decision.decision === "continue")) {
      assertMayDecide(pre, approverId, decision.decision === "approve" ? "approving this card" : "continuing this card");
    }

    const existing = inflight.get(actionId);
    if (existing) {
      if (decision.decision === "approve" && existing.decision === "approve") {
        // Validate caller-held version & revision before sharing the in-flight approve promise.
        if (pre && pre.artifactId !== null && (pre.status === "pending" || pre.status === "approved")) {
          const curVer = currentVersion(pre);
          if (curVer !== null && (decision.seenArtifactVersion !== curVer || decision.seenArtifactVersion !== pre.boundVersion)) {
            return { status: "version_mismatch", actionId, currentVersion: curVer };
          }
        }
        if (
          decision.seenItemRevision !== undefined &&
          existing.startedRevision !== null &&
          decision.seenItemRevision !== existing.startedRevision &&
          decision.seenItemRevision !== pre?.itemRevision
        ) {
          return { status: "revision_mismatch", actionId, currentRevision: pre?.itemRevision ?? existing.startedRevision };
        }
        return existing.promise;
      }
      // Fast-reject an already-stale non-matching concurrent decision before waiting on inflight.
      if (pre && pre.status === "pending" && decision.seenItemRevision !== undefined && decision.seenItemRevision !== pre.itemRevision) {
        return { status: "revision_mismatch", actionId, currentRevision: pre.itemRevision };
      }
      // Serialize different concurrent decisions (e.g. deny racing an in-flight approve).
      await existing.promise.catch(() => undefined);
    }

    const startRev = gate.getApprovalSync(actionId)?.itemRevision ?? null;
    const entry: InflightEntry = {
      decision: decision.decision,
      startedRevision: startRev,
      promise: Promise.resolve({ status: "not_found", actionId }),
    };
    const p = core.track(decideApproval(actionId, decision, onAccepted)).finally(() => {
      if (inflight.get(actionId) === entry) inflight.delete(actionId);
    });
    entry.promise = p;
    inflight.set(actionId, entry);
    return p;
  }

  return {
    resolve,
    superseded(rec: ApprovalRecord, actor: string) { deliverResolved(rec, "superseded", actor, {forwardIfClosed:true}); },
    resurfaced(env: Envelope) {
      const data = (env.payload as TimerFiredPayload).data as { actionId?: string; until?: number } | undefined;
      if (data?.actionId) resurface(data.actionId, data.until);
    },
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
