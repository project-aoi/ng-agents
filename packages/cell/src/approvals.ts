import type { DeliveryResult } from "@ng/channel";
import { ownerOnlyApproval } from "@ng/gate";
import {
  afterCommit, anyCovers, get, run,
  cellPrincipal,
  createEnvelope,
  KERNEL_FROM,
  newId,
  NgError,
  parsePrincipal,
  PAYLOAD,
  stableStringify,
  sha256Hex,
  type AuthorizeMeta,
  type ReplyDecision,
  timerFrom,
  withTx,
  type ApprovalOutcome,
  type ApprovalRecord,
  type ApprovalResolvedPayload,
  type ApprovalRevisePayload,
  type ApprovalStatus,
  type ChannelSendAction,
  type Deliverable,
  type Envelope,
  type RunContinuePayload,
  type SendReceipt,
  type TimerFiredPayload,
} from "@ng/protocol";
import { RESURFACE_MARKER } from "./constants";
import type { KernelCore } from "./core";
import { isKernelEscalation } from "./escalations";
import type { ApprovalDecision, ResolveApprovalResult } from "./types";

export interface Approvals {
  deliveryTarget(rec: ApprovalRecord): {to:string; expectedEpoch:number};
  superseded(rec: ApprovalRecord, actor: string): void;
  sendRevision(cellId: string, epoch: number, actor: string, payload: ApprovalRevisePayload & { subjectKey:string; target?:string }): void;
  humanEditInfo(rec: Pick<ApprovalRecord, "artifactId" | "humanEdited" | "proposedVersion" | "boundVersion">, version?: number | null): { humanEdited: boolean; humanDiff?: string };
  resolve(actionId: string, decision: ApprovalDecision, onAccepted?:()=>void): Promise<ResolveApprovalResult>;
  submitReply(action: ChannelSendAction, sourceId: string, meta: AuthorizeMeta): Promise<ReplyDecision>;
  resolveUnknownSend(
    actionId: string,
    verdict: "sent" | "failed",
    opts: { approverId: string; seenItemRevision: number; seenAttempt: number; note?: string },
  ): "resolved" | "not_unknown" | "revision_mismatch" | "not_found";
  /** A snoozed card's wake-up came due: let the UI know the card is back (no Run needed). */
  resurfaced(env: Envelope): void;
  /** Startup: finish approved sends and non-send approvals a previous process left half-done. */
  reconcile(): void;
}

const RECEIPT_STATUS: Readonly<Record<SendReceipt, "executed" | "failed" | "unknown">> = {
  sent: "executed",
  failed: "failed",
  unknown: "unknown",
  // Approved sends bypass DND, so this cannot happen; if it did, nothing is known to have arrived yet.
  buffered_dnd: "unknown",
};

const STATUS_RESULT: Readonly<Record<"executed" | "failed" | "unknown", "sent" | "failed" | "unknown">> = {
  executed: "sent",
  failed: "failed",
  unknown: "unknown",
};

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

export function createApprovals(core: KernelCore): Approvals {
  const { db, gate, hub, inbox, context, cells, clock, bus } = core;
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

  function assertOwnerActor(approverId: unknown, what: string): string {
    if (typeof approverId !== "string" || !approverId.trim()) {
      throw new NgError("invalid_argument", `${what}: approverId is required`);
    }
    if (approverId !== core.ownerPrincipal) {
      throw new NgError("bounds_violation", `${what} needs the owner; ${approverId} may not`);
    }
    return approverId;
  }

  /**
   * docs/05 guard 3 + BUG-020: an agent on the control plane may decide ordinary cards, but letting something leave
   * through a channel, starting a proposed project from a card, or continuing past an exhausted budget is the owner's
   * alone.
   */
  function assertMayDecide(rec: ApprovalRecord, approverId: string, what: string): void {
    assertExplicitActor(approverId, what);
    if (parsePrincipal(approverId, core.ownerPrincipal).kind === "owner") return;
    const why = ownerOnlyApproval({ ...rec.action, card: rec.card }, core.ownerAddresses);
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
      // The issuing cell closed or moved epoch while external I/O was in flight: preserve the known delivery outcome
      // by forwarding to the nearest live ancestor (root desk cannot be closed).
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
      attemptSeq?: number;
      attemptTag?: string;
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
    const attemptSuffix = extra.attemptTag
      ? `:${extra.attemptTag}`
      : extra.attemptSeq !== undefined && (status === "failed" || status === "unknown")
        ? `:a${extra.attemptSeq}`
        : "";
    const env = createEnvelope(
      {
        id: `${rec.actionId}:resolved:${extra.decision ?? status}${attemptSuffix}`,
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

  function boundContent(rec: ApprovalRecord, action: ChannelSendAction): Deliverable | undefined {
    if (rec.artifactId === null || rec.boundVersion === null) return action.content;
    const v = context.getArtifactVersionSync(rec.artifactId, rec.boundVersion);
    if (v) return v.content;
    const cur = context.getArtifactSync(rec.artifactId);
    return cur?.version === rec.boundVersion ? cur.content : undefined;
  }

  /**
   * Approve a card.
   * - Non-send actions: single atomic `withTx` (approve + deliverResolved).
   * - `channel.send`: 3-step Saga (BUG-028):
   *   TX 1 (approve + issueToken + hub.prepareSendAttemptSync) → outside-TX transport (`hub.deliverPreparedAttempt`,
   *   never `hub.send()`) → TX 2 (`hub.finalizePreparedAttemptSync` guarded by attemptSeq + `gate.recordOutcomeSync`
   *   + verified `deliverResolved`, forwarding to nearest live ancestor if the issuing cell closed in between).
   */
  async function approve(actionId: string, d: Extract<ApprovalDecision, { decision: "approve" }>, onAccepted?:()=>void): Promise<ResolveApprovalResult> {
    const approverId = assertExplicitActor(d.approverId, "approving a card");
    const revOpts = d.seenItemRevision !== undefined ? { seenItemRevision: d.seenItemRevision } : {};

    type Tx1Outcome =
      | { kind: "done"; result: ResolveApprovalResult }
      | { kind: "deliver"; rec: ApprovalRecord; rowId: string; attemptSeq: number };

    const tx1 = withTx(db, (): Tx1Outcome => {
      const before = gate.getApprovalSync(actionId);
      if (!before) return { kind: "done", result: { status: "not_found", actionId } };
      assertMayDecide(before, approverId, "approving this card");

      const r = gate.approveSync(actionId, approverId, d.seenArtifactVersion, revOpts);
      if (r === "not_found") return { kind: "done", result: { status: "not_found", actionId } };
      const rec = gate.getApprovalSync(actionId)!;
      if (r === "revision_mismatch") return { kind: "done", result: { status: "revision_mismatch", actionId, currentRevision: rec.itemRevision } };
      if (r === "version_mismatch") return { kind: "done", result: { status: "version_mismatch", actionId, currentVersion: currentVersion(rec) } };
      if (r === "already_cancelled") {
        return { kind: "done", result: { status: "already_cancelled", actionId, ...(rec.statusReason ? { reason: rec.statusReason } : {}) } };
      }

      onAccepted?.();
      if (rec.action.type !== "channel.send") {
        // Non-I/O approval + notification committed in the exact same SQLite transaction.
        if (before.status === "pending") {
          const issuer = cells.require(rec.cellId);
          const spawn = issuer.preset ? core.registry.presets.get(issuer.preset)?.approvedSpawn?.(rec, context, clock) : undefined;
          if (spawn) core.lifecycle.spawnCell(issuer.id, spawn.spec, spawn.task, {principalId:cellPrincipal(issuer.id)});
          deliverResolved(rec, "approved", approverId);
        }
        return { kind: "done", result: { status: "approved", actionId } };
      }

      if (rec.status === "executed" || rec.status === "unknown") {
        return { kind: "done", result: { status: STATUS_RESULT[rec.status], actionId, artifactVersion: rec.boundVersion } };
      }
      if (rec.status !== "approved" && rec.status !== "failed") {
        return { kind: "done", result: { status: "already_cancelled", actionId } };
      }

      const action = rec.action as ChannelSendAction;
      const content = boundContent(rec, action);
      const artifactVersion = rec.boundVersion;
      if (!content) {
        const error = "the approved draft version no longer exists";
        gate.recordOutcomeSync(rec.actionId, "failed", { error });
        deliverResolved(rec, "failed", approverId, { outcome: { error }, attemptSeq: 0, forwardIfClosed: true });
        return { kind: "done", result: { status: "failed", actionId: rec.actionId, artifactVersion, error } };
      }

      const existing = hub.getLatestOutboxByActionSync(rec.actionId);
      const contentChanged = existing !== undefined && stableStringify(existing.content) !== stableStringify(content);
      const finalAction: ChannelSendAction = {
        type: "channel.send",
        target: action.target,
        content,
        summary: action.summary,
        subjectKey: rec.subjectKey,
        sideEffect: "external",
      };
      let token: string | undefined;
      if (!existing || existing.refused || contentChanged) {
        try {
          token = gate.issueTokenSync(rec.actionId, finalAction);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          gate.recordOutcomeSync(rec.actionId, "failed", { receipt: "failed", error });
          deliverResolved(rec, "failed", approverId, {
            outcome: { receipt: "failed", error },
            attemptTag: `pf_${newId("pf", clock)}`,
            forwardIfClosed: true,
          });
          return { kind: "done", result: { status: "failed", actionId: rec.actionId, artifactVersion, error } };
        }
      }

      const prep = hub.prepareSendAttemptSync({
        target: action.target,
        content,
        idempotencyKey: rec.actionId,
        ...(token ? { actionToken: token } : {}),
        // The owner just approved this card: it gets a real receipt even in focus mode.
        respectDnd: false,
        ...(action.urgent ? { urgent: true } : {}),
        cellId: rec.cellId,
        actionId: rec.actionId,
      });

      if (prep.kind === "receipt") {
        const status = RECEIPT_STATUS[prep.receipt];
        const outcome: ApprovalOutcome = { receipt: prep.receipt, ...(prep.error ? { error: prep.error } : {}) };
        gate.recordOutcomeSync(rec.actionId, status, outcome);
        deliverResolved(rec, status, approverId, { outcome, attemptSeq: prep.attemptSeq, forwardIfClosed: true });
        return {
          kind: "done",
          result: { status: STATUS_RESULT[status], actionId: rec.actionId, artifactVersion, ...(prep.error ? { error: prep.error } : {}) },
        };
      }

      return { kind: "deliver", rec, rowId: prep.rowId, attemptSeq: prep.attemptSeq };
    });

    if (tx1.kind === "done") return tx1.result;

    return deliverPrepared(tx1, approverId);
  }

  async function deliverPrepared(
    tx1: { rec: ApprovalRecord; rowId: string; attemptSeq: number },
    approverId: string,
    notify = true,
  ): Promise<ResolveApprovalResult> {
    // Step 2 (outside any transaction): execute transport for this exact prepared attempt.
    let delivery: DeliveryResult;
    try {
      delivery = await hub.deliverPreparedAttempt(tx1.rowId, tx1.attemptSeq);
    } catch (err) {
      delivery = { status: "unknown", error: err instanceof Error ? err.message : String(err) };
    }

    // Step 3 (TX 2): finalize attempt guarded by attemptSeq + record approval outcome + verified delivery.
    try {
      return withTx(db, (): ResolveApprovalResult => {
        const fin = hub.finalizePreparedAttemptSync(tx1.rowId, tx1.attemptSeq, delivery);
        if (!fin.applied) {
          // A newer attempt or manual resolution already won; report the current truth without clobbering it.
          const latest = gate.getApprovalSync(tx1.rec.actionId);
          const st = latest?.status === "executed" || latest?.status === "failed" || latest?.status === "unknown" ? latest.status : "unknown";
          const err = fin.row?.error ?? latest?.outcome?.error;
          return { status: STATUS_RESULT[st], actionId: tx1.rec.actionId, artifactVersion: tx1.rec.boundVersion, ...(err ? { error: err } : {}) };
        }
        const receipt: SendReceipt = delivery.status;
        const error = delivery.status === "sent" ? undefined : delivery.error;
        const status = RECEIPT_STATUS[receipt];
        const outcome: ApprovalOutcome = { receipt, ...(error ? { error } : {}) };
        gate.recordOutcomeSync(tx1.rec.actionId, status, outcome);
        const latestRec = gate.getApprovalSync(tx1.rec.actionId) ?? tx1.rec;
        if (notify) deliverResolved(latestRec, status, approverId, {
          outcome,
          attemptSeq: tx1.attemptSeq,
          forwardIfClosed: true,
        });
        return { status: STATUS_RESULT[status], actionId: tx1.rec.actionId, artifactVersion: tx1.rec.boundVersion, ...(error ? { error } : {}) };
      });
    } finally {
      hub.releasePreparedAttempt(tx1.rowId, tx1.attemptSeq);
    }
  }

  async function decide(actionId: string, d: ApprovalDecision, onAccepted?:()=>void): Promise<ResolveApprovalResult> {
    if (d.decision === "approve") return approve(actionId, d, onAccepted);
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
            ...(rec.action.type === "channel.send" ? { target: rec.action.target } : {}),
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
          const reason = kernelArgs?.reason ?? escalationReason(rec);

          // MUST transition and verify the card decision FIRST before raising budget or requeuing dead letters (BUG-028).
          if (rec.action.type !== "custom") {
            const w = gate.withdrawSync(actionId, "the owner chose to continue without it", revOpts);
            if (w === "revision_mismatch") return { status: "revision_mismatch", actionId, currentRevision: rec.itemRevision };
            if (w !== "cancelled") return { status: "not_pending", actionId };
            if (reason === "budget_exhausted") {
              const affected = kernelArgs?.cellId ?? rec.cellId;
              if (d.budgetLedgerId && d.raise) gate.raiseBudgetSync(d.budgetLedgerId, d.raise, approverId);
              else if (cells.get(affected)) gate.raiseChainSync(affected, approverId, d.raise);
            }
            deliverResolved(rec, "cancelled", approverId, {
              decision: "continue",
              ...(d.note ? { note: d.note } : {}),
              ...(d.until ? { until: d.until } : {}),
            });
            return { status: "continued", actionId };
          }

          const a = gate.approveSync(actionId, approverId, d.seenArtifactVersion, revOpts);
          if (a === "revision_mismatch") return { status: "revision_mismatch", actionId, currentRevision: rec.itemRevision };
          if (a === "version_mismatch") return {status:"version_mismatch", actionId, currentVersion:currentVersion(rec)};
          if (a === "already_cancelled") return { status: "already_cancelled", actionId };
          if (a !== "approved") return { status: "not_pending", actionId };
          onAccepted?.();

          if (reason === "budget_exhausted") {
            const affected = kernelArgs?.cellId ?? rec.cellId;
            if (d.budgetLedgerId && d.raise) gate.raiseBudgetSync(d.budgetLedgerId, d.raise, approverId);
            else if (cells.get(affected)) gate.raiseChainSync(affected, approverId, d.raise);
          }
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
          if (isKernelEscalation(rec.action) && rec.action.args.reason === "budget_exhausted")
            gate.declineBudgetSync(rec.action.args.limitedBy ?? rec.action.args.cellId, approverId);
          else deliverResolved(rec, "cancelled", approverId, {decision:d.decision, ...(note ? {note} : offline ? {note:"已在线下解决"} : {})});
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

  function escalationReason(rec: ApprovalRecord): string | null {
    const data = rec.card.data as { cardType?: string; escalation?: { reason?: string } } | undefined;
    if (data?.cardType === "escalation" && typeof data.escalation?.reason === "string") return data.escalation.reason;
    if (rec.action.type === "custom" && rec.action.name.startsWith("escalation.")) return rec.action.name.slice("escalation.".length);
    return null;
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
    humanEditInfo, sendRevision, deliveryTarget,
    superseded(rec, actor) { deliverResolved(rec, "superseded", actor, {forwardIfClosed:true}); },
    async submitReply(action, sourceId, meta) {
      const actionId = "reply:" + sha256Hex(JSON.stringify([meta.cellId, sourceId, action.target]));
      const prepared = withTx(db, () => {
        const prior = gate.getApprovalSync(actionId);
        if (prior) {
          const status = prior.status;
          const receipt = status === "executed" ? "sent" : status === "approved" ? "pending" :
            status === "unknown" || status === "failed" ? status : "cancelled";
          return { type: "delivery", actionId, receipt } as const;
        }
        if (action.artifactId && core.context.getArtifactSync(action.artifactId)?.version !== meta.artifactVersion) {
          return { type: "deny", feedback: "The draft changed before submission. Read the current version before submitting it again." } as const;
        }
        const decision = gate.authorizeSync(action, meta);
        if (decision.type !== "allow") return decision;
        // An owner-addressed delivery has its own receipt. An unrelated decision may still own the request's subject.
        const recordedAction = anyCovers(core.ownerAddresses, action.target) ? {...action, subjectKey:actionId} : action;
        const rec = gate.recordStandingSendSync(actionId, recordedAction, meta);
        const attempt = hub.prepareSendAttemptSync({
          target: action.target, content: action.content!, actionId, idempotencyKey: actionId,
          actionToken: decision.actionToken, cellId: meta.cellId, respectDnd: false,
        });
        if (attempt.kind === "receipt") {
          const status = RECEIPT_STATUS[attempt.receipt];
          gate.recordOutcomeSync(actionId, status, { receipt: attempt.receipt, ...(attempt.error ? { error: attempt.error } : {}) });
          return { type: "delivery", actionId, receipt: STATUS_RESULT[status] } as const;
        }
        return { type: "prepared", rec, ...attempt } as const;
      });
      if (prepared.type !== "prepared") return prepared;
      const promise = core.track(deliverPrepared(prepared, "policy:standing_rule", false));
      const entry: InflightEntry = { decision: "approve", startedRevision: prepared.rec.itemRevision, promise };
      inflight.set(actionId, entry);
      const result = await promise.finally(() => {
        if (inflight.get(actionId) === entry) inflight.delete(actionId);
      });
      const receipt = result.status === "sent" || result.status === "failed" ? result.status : "unknown";
      return { type: "delivery", actionId, receipt };
    },

    async resolve(actionId, decision, onAccepted) {
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
          if (pre && pre.artifactId !== null && (pre.status === "pending" || pre.status === "approved" || pre.status === "failed")) {
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
      const p = core.track(decide(actionId, decision, onAccepted)).finally(() => {
        if (inflight.get(actionId) === entry) inflight.delete(actionId);
      });
      entry.promise = p;
      inflight.set(actionId, entry);
      return p;
    },

    resolveUnknownSend(actionId, verdict, opts) {
      const approverId = assertOwnerActor(opts?.approverId, "verifying an unknown send");
      return withTx(db, () => {
        const rec = gate.getApprovalSync(actionId);
        if (!rec) return "not_found";
        if (rec.itemRevision !== opts.seenItemRevision) return "revision_mismatch";
        if (rec.status !== "unknown") return "not_unknown";
        const attempt = hub.getLatestOutboxByActionSync(actionId);
        if (!attempt) return "not_found";
        if (attempt.attempts !== opts.seenAttempt) return "revision_mismatch";
        const r = hub.resolveUnknownByActionSync(actionId, verdict, opts.note);
        if (r !== "resolved") return r;
        const status = verdict === "sent" ? "executed" : "failed";
        const outcome: ApprovalOutcome = { receipt: verdict, note: opts.note ?? "verified by the owner" };
        gate.recordOutcomeSync(actionId, status, outcome);
        const superseded = verdict === "failed" && !!get(db, "SELECT 1 FROM human_items WHERE blocked_by=? AND status IN ('pending','snoozed','unknown') LIMIT 1", [actionId]);
        if (superseded) {
          run(db, "UPDATE human_items SET disposition='superseded',status_reason='verified unsuccessful; subsequent draft available',updated_at=?,item_revision=item_revision+1 WHERE action_id=?", [clock.now(), actionId]);
          afterCommit(db, () => bus.emit("approval.changed", {actionId, cellId:rec.cellId, subjectKey:rec.subjectKey, status:"superseded"}));
        }
        deliverResolved(rec, superseded ? "superseded" : status, approverId, {
          outcome, decision: "verified", attemptSeq: attempt.attempts, forwardIfClosed: true,
          ...(opts.note !== undefined ? { note: opts.note } : {}),
        });
        return r;
      });
    },

    resurfaced(env) {
      const data = (env.payload as TimerFiredPayload).data as { actionId?: unknown } | undefined;
      const actionId = typeof data?.actionId === "string" ? data.actionId : null;
      if (!actionId) return;
      const until = (env.payload as TimerFiredPayload).data as { until?: number };
      core.humanItems.resurface(actionId, until.until);
    },

    reconcile() {
      for (const rec of gate.listApprovalsSync({ status: ["approved"] })) {
        try {
          withTx(db, () => {
            const approver = rec.approverId ?? core.ownerPrincipal;
            if (rec.action.type !== "channel.send") {
              // BUG-028: cover non-channel.send approved cards too, without forwarding dead/cancelled child cards to desk.
              const { to, expectedEpoch } = deliveryTarget(rec);
              const targetCell = cells.get(to);
              if (!targetCell || targetCell.status === "closed" || targetCell.epoch !== expectedEpoch) return;
              const existingEnv = inbox.listMessagesSync({ cellId: to, envelopeId: `${rec.actionId}:resolved:approved` })[0];
              if (
                existingEnv &&
                (existingEnv.status === "done" ||
                  existingEnv.status === "claimed" ||
                  existingEnv.status === "pending" ||
                  existingEnv.status === "cancelled" ||
                  existingEnv.status === "dropped_epoch")
              ) {
                return;
              }
              deliverResolved(rec, "approved", approver);
              return;
            }
            const row = hub.getLatestOutboxByActionSync(rec.actionId);
            if (!row) {
              const outcome: ApprovalOutcome = { error: "interrupted before sending; approve again to send" };
              gate.recordOutcomeSync(rec.actionId, "failed", outcome);
              deliverResolved(rec, "failed", approver, { outcome, attemptSeq: 0, forwardIfClosed: true });
              return;
            }
            const status = row.status === "sent" ? "executed" : row.status === "failed" ? "failed" : "unknown";
            const outcome: ApprovalOutcome = {
              receipt: row.status === "sent" ? "sent" : row.status === "failed" ? "failed" : "unknown",
              ...(row.error ? { error: row.error } : {}),
            };
            gate.recordOutcomeSync(rec.actionId, status, outcome);
            deliverResolved(rec, status, approver, { outcome, attemptSeq: row.attempts, forwardIfClosed: true });
          });
        } catch (err) {
          core.onError(err, `reconcile approval ${rec.actionId}`);
        }
      }
    },
  };
}
