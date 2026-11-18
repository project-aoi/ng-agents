import { ownerOnlyApproval } from "@ng/gate";
import {
  cellPrincipal,
  createEnvelope,
  KERNEL_FROM,
  newId,
  NgError,
  parsePrincipal,
  PAYLOAD,
  timerFrom,
  type RunContinuePayload,
  type ApprovalOutcome,
  type ApprovalRecord,
  type ApprovalResolvedPayload,
  type ApprovalRevisePayload,
  type ApprovalStatus,
  type ChannelSendAction,
  type Deliverable,
  type Envelope,
  type SendReceipt,
  type TimerFiredPayload,
} from "@ng/protocol";
import { RESURFACE_MARKER } from "./constants";
import type { KernelCore } from "./core";
import { isKernelEscalation } from "./escalations";
import type { ApprovalDecision, ResolveApprovalResult } from "./types";

export interface Approvals {
  resolve(actionId: string, decision: ApprovalDecision): Promise<ResolveApprovalResult>;
  resolveUnknownSend(actionId: string, verdict: "sent" | "failed", note?: string): "resolved" | "not_unknown" | "not_found";
  /** A snoozed card's wake-up came due: let the UI know the card is back (no Run needed). */
  resurfaced(env: Envelope): void;
  /** Startup: finish approved sends a previous process left half-done. */
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

export function createApprovals(core: KernelCore): Approvals {
  const { gate, hub, inbox, context, cells, clock, bus } = core;
  const inflight = new Map<string, Promise<ResolveApprovalResult>>();

  function currentVersion(rec: ApprovalRecord): number | null {
    return rec.artifactId ? (context.getArtifactSync(rec.artifactId)?.version ?? null) : null;
  }

  /**
   * The owning cell always learns the outcome (wake-up unless `silent`); dropped by the epoch check if it moved on.
   * A kernel escalation may be held by an ancestor of the cell it is about: that cell is the one to wake.
   */
  function deliverResolved(
    rec: ApprovalRecord,
    status: ApprovalStatus,
    approverId: string,
    extra: { outcome?: ApprovalOutcome; note?: string; decision?: string; until?: number; silent?: boolean } = {},
  ): void {
    let to = rec.cellId;
    let expectedEpoch = rec.epoch;
    if (isKernelEscalation(rec.action) && rec.action.args.cellId !== rec.cellId) {
      const affected = cells.get(rec.action.args.cellId);
      if (affected) {
        to = affected.id;
        expectedEpoch = affected.epoch;
      }
    }
    const payload: ApprovalResolvedPayload & { decision?: string; until?: number } = {
      actionId: rec.actionId,
      status,
      action: rec.action,
      approverId,
      humanEdited: rec.humanEdited,
      ...(rec.boundVersion !== null ? { artifactVersion: rec.boundVersion } : {}),
      ...(extra.outcome ? { outcome: extra.outcome } : {}),
      ...(extra.note !== undefined ? { note: extra.note } : {}),
      ...(extra.decision !== undefined ? { decision: extra.decision } : {}),
      ...(extra.until !== undefined ? { until: extra.until } : {}),
    };
    try {
      inbox.enqueueSync(
        to,
        createEnvelope(
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
        ),
      );
    } catch (err) {
      core.onError(err, `approval.resolved for ${rec.actionId}`);
    }
  }

  function boundContent(rec: ApprovalRecord, action: ChannelSendAction): Deliverable | undefined {
    if (rec.artifactId === null || rec.boundVersion === null) return action.content;
    const v = context.getArtifactVersionSync(rec.artifactId, rec.boundVersion);
    if (v) return v.content;
    const cur = context.getArtifactSync(rec.artifactId);
    return cur?.version === rec.boundVersion ? cur.content : undefined;
  }

  function recordOutcome(actionId: string, status: "executed" | "failed" | "unknown", outcome: ApprovalOutcome): void {
    try {
      gate.recordOutcomeSync(actionId, status, outcome);
    } catch (err) {
      core.onError(err, `record outcome of ${actionId}`);
    }
  }

  /** Executes an approved `channel.send` with the bound draft version (IMPL_BRIEF §2.7). Never resends an `unknown`. */
  async function executeSend(rec: ApprovalRecord, approverId: string): Promise<ResolveApprovalResult> {
    const action = rec.action as ChannelSendAction;
    const content = boundContent(rec, action);
    const artifactVersion = rec.boundVersion;
    if (!content) {
      const error = "the approved draft version no longer exists";
      recordOutcome(rec.actionId, "failed", { error });
      deliverResolved(rec, "failed", approverId, { outcome: { error } });
      return { status: "failed", actionId: rec.actionId, artifactVersion, error };
    }
    let receipt: SendReceipt;
    let error: string | undefined;
    try {
      const existing = hub.getOutboxSync(rec.actionId);
      if (existing && existing.status === "failed" && !existing.refused) {
        receipt = await hub.retryFailed(rec.actionId);
      } else {
        // A refused row (bad token) can never be retried under its key; a fresh key carries a fresh token.
        const key = existing?.refused ? `${rec.actionId}:retry:${newId("r", clock)}` : rec.actionId;
        const finalAction: ChannelSendAction = {
          type: "channel.send",
          target: action.target,
          content,
          summary: action.summary,
          subjectKey: rec.subjectKey,
          sideEffect: "external",
        };
        const token = existing && !existing.refused ? undefined : gate.issueTokenSync(rec.actionId, finalAction);
        receipt = await hub.send({
          target: action.target,
          content,
          idempotencyKey: key,
          ...(token ? { actionToken: token } : {}),
          // The owner just approved this card: it gets a real receipt even in focus mode.
          respectDnd: false,
          ...(action.urgent ? { urgent: true } : {}),
          cellId: rec.cellId,
          actionId: rec.actionId,
        });
      }
      if (receipt !== "sent") error = hub.getOutboxSync(rec.actionId)?.error ?? undefined;
    } catch (err) {
      receipt = "failed";
      error = err instanceof Error ? err.message : String(err);
    }
    const status = RECEIPT_STATUS[receipt];
    const outcome: ApprovalOutcome = { receipt, ...(error ? { error } : {}) };
    recordOutcome(rec.actionId, status, outcome);
    deliverResolved(rec, status, approverId, { outcome });
    return { status: STATUS_RESULT[status], actionId: rec.actionId, artifactVersion, ...(error ? { error } : {}) };
  }

  async function approve(actionId: string, d: Extract<ApprovalDecision, { decision: "approve" }>): Promise<ResolveApprovalResult> {
    const approverId = d.approverId ?? core.ownerPrincipal;
    const before = gate.getApprovalSync(actionId);
    if (!before) return { status: "not_found", actionId };
    assertMayDecide(before, approverId, "approving this card");
    const r = gate.approveSync(actionId, approverId, d.seenArtifactVersion);
    if (r === "not_found") return { status: "not_found", actionId };
    const rec = gate.getApprovalSync(actionId)!;
    if (r === "version_mismatch") return { status: "version_mismatch", actionId, currentVersion: currentVersion(rec) };
    if (r === "already_cancelled") return { status: "already_cancelled", actionId, ...(rec.statusReason ? { reason: rec.statusReason } : {}) };

    if (rec.action.type !== "channel.send") {
      // Handed back: the owning cell's Loop carries the action out (project.start, merge, custom).
      if (before.status === "pending") deliverResolved(rec, "approved", approverId);
      return { status: "approved", actionId };
    }
    switch (rec.status) {
      case "executed":
      case "unknown":
        return { status: STATUS_RESULT[rec.status], actionId, artifactVersion: rec.boundVersion };
      case "approved":
      case "failed":
        return executeSend(rec, approverId);
      default:
        return { status: "already_cancelled", actionId };
    }
  }

  /**
   * docs/05 guard 3: an agent on the control plane may decide ordinary cards, but letting something leave through a
   * channel, or continuing past an exhausted budget, is the owner's alone — refused here for every entry point (the
   * Gate refuses the same on approve; "continue" would otherwise reach raiseBudget).
   */
  function assertMayDecide(rec: ApprovalRecord, approverId: string, what: string): void {
    if (parsePrincipal(approverId, core.ownerPrincipal).kind === "owner") return;
    const why = ownerOnlyApproval({ ...rec.action, card: rec.card }, core.ownerAddresses);
    if (why) throw new NgError("bounds_violation", `${what} needs the owner (${why}); ${approverId} may not`);
  }

  function pendingOrResult(actionId: string): { rec: ApprovalRecord } | { result: ResolveApprovalResult } {
    const rec = gate.getApprovalSync(actionId);
    if (!rec) return { result: { status: "not_found", actionId } };
    if (rec.status !== "pending") return { result: { status: "not_pending", actionId, reason: rec.status } };
    return { rec };
  }

  async function decide(actionId: string, d: ApprovalDecision): Promise<ResolveApprovalResult> {
    if (d.decision === "approve") return approve(actionId, d);
    const approverId = d.approverId ?? core.ownerPrincipal;
    const got = pendingOrResult(actionId);
    if ("result" in got) return got.result;
    const rec = got.rec;

    switch (d.decision) {
      case "deny": {
        if (gate.denySync(actionId, approverId, d.reason) !== "denied") return { status: "not_pending", actionId };
        deliverResolved(rec, "denied", approverId, d.reason !== undefined ? { note: d.reason } : {});
        return { status: "denied", actionId };
      }

      case "snooze": {
        if (!Number.isFinite(d.until)) throw new NgError("invalid_argument", "snooze needs an `until` timestamp");
        if (gate.snoozeSync(actionId, d.until) !== "snoozed") return { status: "not_pending", actionId };
        const payload: TimerFiredPayload = {
          label: "推迟的卡片回到待确认",
          subjectKey: rec.subjectKey,
          data: { kernel: RESURFACE_MARKER, actionId },
        };
        inbox.enqueueSync(
          rec.cellId,
          createEnvelope<TimerFiredPayload>(
            {
              id: `${actionId}:resurface:${d.until}`,
              from: timerFrom("approval"),
              principalId: approverId,
              kind: "event",
              type: PAYLOAD.timerFired,
              payload,
              expectedEpoch: rec.epoch,
            },
            clock,
          ),
          { deliverAt: d.until },
        );
        return { status: "snoozed", actionId };
      }

      case "revise": {
        if (typeof d.instruction !== "string" || !d.instruction.trim()) throw new NgError("invalid_argument", "revise needs an instruction");
        const version = currentVersion(rec);
        // subjectKey/target let the redraft re-defer under the same subject, which updates this card in place.
        const payload: ApprovalRevisePayload & { subjectKey: string; target?: string } = {
          actionId,
          instruction: d.instruction,
          subjectKey: rec.subjectKey,
          ...(rec.action.type === "channel.send" ? { target: rec.action.target } : {}),
          ...(rec.artifactId ? { artifactId: rec.artifactId } : {}),
          ...(version !== null ? { artifactVersion: version } : {}),
          ...(d.voice ? { voice: true } : {}),
        };
        inbox.enqueueSync(
          rec.cellId,
          createEnvelope<ApprovalRevisePayload>(
            {
              id: `${actionId}:revise:${newId("rev", clock)}`,
              from: KERNEL_FROM.approval,
              principalId: approverId,
              kind: "event",
              type: PAYLOAD.approvalRevise,
              payload,
              expectedEpoch: rec.epoch,
            },
            clock,
          ),
        );
        return { status: "revising", actionId };
      }

      case "continue": {
        assertMayDecide(rec, approverId, "continuing this card");
        const kernelArgs = isKernelEscalation(rec.action) ? rec.action.args : null;
        const reason = kernelArgs?.reason ?? escalationReason(rec);
        if (reason === "budget_exhausted") {
          const affected = kernelArgs?.cellId ?? rec.cellId;
          const limitedBy = cells.get(affected) ? (gate.usageSync(affected).limitedBy ?? kernelArgs?.limitedBy ?? affected) : null;
          if (limitedBy && cells.get(limitedBy)) {
            const lim = gate.usageSync(limitedBy);
            const add = d.raise ?? { tokens: Math.max(1, Math.ceil(lim.limitTokens / 2)), cents: Math.max(1, Math.ceil(lim.limitCents / 2)) };
            gate.raiseBudgetSync(limitedBy, add, approverId);
          }
        }
        if (rec.action.type !== "custom") {
          // e.g. "再等 1 天" on a watcher's nudge card: the proposed send does not happen; the cell keeps waiting.
          gate.withdrawSync(actionId, "the owner chose to continue without it");
          deliverResolved(rec, "cancelled", approverId, { decision: "continue", ...(d.note ? { note: d.note } : {}), ...(d.until ? { until: d.until } : {}) });
          return { status: "continued", actionId };
        }
        gate.approveSync(actionId, approverId);
        recordOutcome(actionId, "executed", { note: d.note ?? "continued by the owner" });
        if (kernelArgs?.reason === "retry_limit") {
          if (kernelArgs.stepLimit) continueSteps(kernelArgs.cellId, actionId);
          else requeueDead(kernelArgs.cellId, kernelArgs.envelopeIds ?? []);
          deliverResolved(rec, "executed", approverId, { decision: "continue", silent: true });
        } else {
          deliverResolved(rec, "executed", approverId, { decision: "continue", ...(d.note ? { note: d.note } : {}), ...(d.until ? { until: d.until } : {}) });
        }
        return { status: "continued", actionId };
      }

      case "resolve_offline": {
        gate.withdrawSync(actionId, d.note ?? "resolved offline by the owner");
        const affectedId = isKernelEscalation(rec.action) ? rec.action.args.cellId : rec.cellId;
        const affected = cells.get(affectedId);
        if (affected && affected.parentId !== null && affected.status !== "closed") {
          const { closed } = await core.lifecycle.closeCell(affectedId, "completed", { principalId: approverId });
          return { status: "resolved_offline", actionId, closedCellIds: closed };
        }
        deliverResolved(rec, "cancelled", approverId, { decision: "resolve_offline", ...(d.note ? { note: d.note } : {}) });
        return { status: "resolved_offline", actionId, closedCellIds: [] };
      }

      case "dismiss": {
        gate.withdrawSync(actionId, d.reason ?? "dismissed by the owner");
        deliverResolved(rec, "cancelled", approverId, { decision: "dismiss", silent: true, ...(d.reason ? { note: d.reason } : {}) });
        return { status: "dismissed", actionId };
      }
    }
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
    inbox.enqueueSync(
      cellId,
      createEnvelope<RunContinuePayload>(
        { id: `${actionId}:continue`, from: KERNEL_FROM.dispatcher, principalId: cellPrincipal(cellId), kind: "event", type: PAYLOAD.runContinue, payload, expectedEpoch: cell.epoch },
        clock,
      ),
    );
  }

  /** "Continue" on a dead letter: the same messages again, under new ids (the old rows stay `dead` for the record). */
  function requeueDead(cellId: string, envelopeIds: readonly string[]): void {
    const cur = cells.get(cellId);
    if (!cur || cur.status === "closed") return;
    const wanted = new Set(envelopeIds);
    for (const m of inbox.listMessagesSync({ cellId, status: ["dead"] })) {
      if (!wanted.has(m.envelope.id)) continue;
      const { to: _to, expectedEpoch: _e, ...rest } = m.envelope;
      inbox.enqueueSync(cellId, { ...rest, id: `${m.envelope.id}#retry:${newId("r", clock)}`, createdAt: clock.now() });
    }
  }

  return {
    resolve(actionId, decision) {
      if (decision.decision === "approve") {
        // A second click while the first send is still in flight gets the same receipt.
        const running = inflight.get(actionId);
        if (running) return running;
        const p = core.track(decide(actionId, decision)).finally(() => inflight.delete(actionId));
        inflight.set(actionId, p);
        return p;
      }
      return core.track(decide(actionId, decision));
    },

    resolveUnknownSend(actionId, verdict, note) {
      const r = hub.resolveUnknownSync(actionId, verdict, note);
      if (r !== "resolved") return r;
      const rec = gate.getApprovalSync(actionId);
      if (rec && rec.status === "unknown") {
        const status = verdict === "sent" ? "executed" : "failed";
        recordOutcome(actionId, status, { receipt: verdict, note: note ?? "verified by the owner" });
        deliverResolved(rec, status, core.ownerPrincipal, { outcome: { receipt: verdict }, decision: "verified", silent: true });
      }
      return r;
    },

    resurfaced(env) {
      const data = (env.payload as TimerFiredPayload).data as { actionId?: unknown } | undefined;
      const actionId = typeof data?.actionId === "string" ? data.actionId : null;
      if (!actionId) return;
      const rec = gate.getApprovalSync(actionId);
      if (rec?.status === "pending") bus.emit("approval.changed", { actionId, cellId: rec.cellId, subjectKey: rec.subjectKey, status: "pending" });
    },

    reconcile() {
      for (const rec of gate.listApprovalsSync({ status: ["approved"] })) {
        if (rec.action.type !== "channel.send") continue;
        const row = hub.getOutboxSync(rec.actionId);
        const approver = rec.approverId ?? core.ownerPrincipal;
        if (!row) {
          const outcome = { error: "interrupted before sending; approve again to send" };
          recordOutcome(rec.actionId, "failed", outcome);
          deliverResolved(rec, "failed", approver, { outcome });
          continue;
        }
        const status = row.status === "sent" ? "executed" : row.status === "failed" ? "failed" : "unknown";
        const outcome: ApprovalOutcome = { receipt: row.status === "sent" ? "sent" : row.status === "failed" ? "failed" : "unknown", ...(row.error ? { error: row.error } : {}) };
        recordOutcome(rec.actionId, status, outcome);
        deliverResolved(rec, status, approver, { outcome });
      }
    },
  };
}
