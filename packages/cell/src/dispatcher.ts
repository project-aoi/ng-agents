import { CLI_SESSION_KEY, type CliSessionRecord, probeOrphanCliCell, reapOrphanedCliProcesses } from "@ng/loop";
import {
  timerFrom,
  CELL_DIRECT_CHAT_KEY,
  CELL_RESULT_CANDIDATE_KEY,
  CELL_TURN_KEY,
  cellPrincipal,
  createEnvelope,
  finalResultEnvelopeId,
  inboxAddr,
  isLeafLifetime,
  isNgError,
  KERNEL_FROM,
  PAYLOAD,
  withTx,
  type CellDirectChatState,
  type CellRecord,
  type CellResultCandidate,
  type CellResultPayload,
  type CellTurnState,
  type ClaimedBatch,
  type CloseReason,
  type Envelope,
  type RunContinuePayload,
  type SelfSettleRequest,
  type SettledTurn,
  type TimerFiredPayload,
} from "@ng/protocol";
import { RESURFACE_MARKER } from "./constants";
import type { KernelCore } from "./core";
import { buildRunPorts } from "./ports";
import type { IdleOptions, RunInfo, RunResult } from "./types";

/** Why the kernel stopped a Run: decides whether releasing its claim counts as a failed attempt. */
export type StopReason = "cancel" | "pause" | "close" | "shutdown";

export interface RunHandle {
  claimId: string;
  cellId: string;
  epoch: number;
  startedAt: number;
  controller: AbortController;
  stopReason: StopReason | null;
  done: Promise<void>;
  /** docs/05 guard 2: only a `kernel.stalled_check` started this Run — it is not an anchor of its project. */
  stallOnly: boolean;
  /** RunPorts.settleSelf: what to do with the cell once this Run has settled. */
  selfSettle: SelfSettleRequest | null;
  cliInput?: { sessionId: string; throughSeq: number };
}

export interface Dispatcher {
  readonly workerId: string;
  start(): void;
  /** Abort every Run and wait for them to give their claims back. */
  stop(): Promise<void>;
  /** A cell may have claimable work (inbox.enqueued). */
  notify(cellId: string): void;
  abortCells(cellIds: readonly string[], reason: StopReason): void;
  /** Resolves when no Run of these cells is in flight. */
  settled(cellIds: readonly string[]): Promise<void>;
  isRunning(cellId: string): boolean;
  activeRuns(): RunInfo[];
  /** Extend the leases of every live Run (heartbeat; also on every ManualClock step). */
  renewAll(): void;
  idle(opts?: IdleOptions): Promise<void>;
  /** Defer CLI dispatch for a cell whose previous CLI process has unknown identity (`null` on macOS). */
  holdForUnknownOrphan(cellId: string): void;
  /** Runs in flight with what the stall check and the occupancy view need. */
  running(): Array<{ cellId: string; stallOnly: boolean }>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isResurface(env: Envelope): boolean {
  if (env.from!==timerFrom("approval") || env.type !== "timer.fired") return false;
  const data = (env.payload as TimerFiredPayload | null)?.data;
  return data !== null && typeof data === "object" && (data as Record<string, unknown>)["kernel"] === RESURFACE_MARKER;
}

export function createDispatcher(core: KernelCore, opts: { idleTimeoutMs: number }): Dispatcher {
  const { inbox, cells, bus, clock, context } = core;
  const runs = new Map<string, RunHandle>();
  const byCell = new Map<string, Set<string>>();
  const due: string[] = [];
  const dueSet = new Set<string>();
  const runEndWaiters = new Set<() => void>();
  /** Cells deferred because a previous CLI process is alive with unreadable identity (`null`). */
  const unknownOrphans = new Set<string>();
  const reapingOrphans = new Set<string>();
  let orphanTimer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let pumpScheduled = false;

  function clearOrphanTimerIfEmpty(): void {
    if (unknownOrphans.size === 0 && orphanTimer) {
      clearInterval(orphanTimer);
      orphanTimer = undefined;
    }
  }

  function reapUnknownOrphan(id: string): void {
    if (reapingOrphans.has(id)) return;
    reapingOrphans.add(id);
    // Scope strictly to this cell and never touch CLI children spawned by this live kernel process!
    void core.track(
      reapOrphanedCliProcesses(core.cliProcDir, { cellId: id, ownerInstanceId: core.ownerInstanceId })
        .finally(() => reapingOrphans.delete(id))
        .then(() => {
          if (probeOrphanCliCell(core.cliProcDir, id, { ownerInstanceId: core.ownerInstanceId }) === "clear") {
            unknownOrphans.delete(id);
            clearOrphanTimerIfEmpty();
            notify(id);
          }
        }),
    );
  }

  function ensureOrphanPoller(): void {
    if (orphanTimer || unknownOrphans.size === 0 || !started) return;
    orphanTimer = setInterval(() => {
      if (unknownOrphans.size === 0) {
        clearOrphanTimerIfEmpty();
        return;
      }
      for (const id of [...unknownOrphans]) {
        if (reapingOrphans.has(id)) continue;
        const probe = probeOrphanCliCell(core.cliProcDir, id, { ownerInstanceId: core.ownerInstanceId });
        if (probe === "clear") {
          unknownOrphans.delete(id);
          notify(id);
        } else if (probe === "alive") {
          reapUnknownOrphan(id);
        }
      }
      clearOrphanTimerIfEmpty();
    }, 2_000);
    orphanTimer.unref?.();
  }

  function holdForUnknownOrphan(cellId: string): void {
    unknownOrphans.add(cellId);
    ensureOrphanPoller();
  }

  function wakeWaiters(): void {
    for (const w of [...runEndWaiters]) w();
    runEndWaiters.clear();
  }

  function nextRunEnd(): Promise<void> {
    return new Promise((resolve) => runEndWaiters.add(resolve));
  }

  function notify(cellId: string): void {
    if (!dueSet.has(cellId)) {
      dueSet.add(cellId);
      due.push(cellId);
    }
    schedulePump();
  }

  function schedulePump(): void {
    if (!started || pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      try {
        pump();
      } catch (err) {
        core.onError(err, "dispatcher pump");
      }
    });
  }

  function inFlight(cellId: string): number {
    return byCell.get(cellId)?.size ?? 0;
  }

  function settleKernelMessages(cell: CellRecord): void {
    const cellId = cell.id;
    for (const m of inbox.listMessagesSync({ cellId, type: PAYLOAD.timerFired, status: ["pending"] })) {
      if (m.deliverAt > clock.now()) continue;
      const env = m.envelope;
      try {
        const preset = cell.preset && core.registry.presets.get(cell.preset);
        const reminder = env.from === timerFrom(cellId) && preset ? preset.personalReminder?.(env) : undefined;
        const resurface = isResurface(env);
        if (!reminder && !resurface) continue;
        inbox.consumePendingSync(cellId, env.id, cell.epoch, () => {
          if (reminder) {
            core.humanItems.create(reminder.draft, null, reminder.id);
            core.hub.notifyOwner({
              cellId,
              content: { format: "text", body: `⏰ 提醒：${reminder.draft.title}` },
              idempotencyKey: reminder.draft.subjectKey,
            });
          } else core.humanItems.resurfaced(env);
          if (reminder) context.appendEvidenceSync(cellId, {kind:"inbound", envelope:env, runId:`timer:${env.id}`, at:clock.now()});
        });
      } catch (err) {
        core.onError(err, `处理 ${cellId} 的定时事项 ${env.id}`);
      }
    }
    for (const row of inbox.listMessagesSync({ cellId, type: PAYLOAD.stalledCheck, status: ["pending"] })) {
      if (row.deliverAt <= clock.now() && !core.stall.stillStalled([row.envelope])) {
        inbox.consumePendingSync(cellId, row.envelope.id, cell.epoch);
      }
    }
  }

  function pump(): void {
    let remaining = due.length;
    while (started && remaining-- > 0 && runs.size < core.maxConcurrentRuns && due.length > 0) {
      const cellId = due.shift()!;
      dueSet.delete(cellId);
      const cell = cells.get(cellId);
      if (!cell || !cells.isActiveInTree(cellId)) {
        continue;
      }
      if (core.lifecycle.cleaningUp(cellId)) continue; // The previous epoch notifies us when its runtime has stopped.
      // A cell with a Run in flight is re-notified when that Run ends; the claim is the real lock either way.
      if (inFlight(cellId) > 0) continue;
      if (reapingOrphans.has(cellId)) continue;
      if (cell.spec.processor.kind === "llm") {
        // BUG-027: do not launch a replacement CLI process while an unverified previous process for this cell may still run.
        if (unknownOrphans.has(cellId)) {
          settleKernelMessages(cell);
          const probe = probeOrphanCliCell(core.cliProcDir, cellId, { ownerInstanceId: core.ownerInstanceId });
          if (probe === "clear") {
            unknownOrphans.delete(cellId);
            clearOrphanTimerIfEmpty();
          } else {
            if (probe === "alive") reapUnknownOrphan(cellId);
            ensureOrphanPoller();
            continue;
          }
        }
      }
      let batch: ClaimedBatch | null;
      try {
        batch = inbox.claimNextRunSync(cellId, core.ownerInstanceId, core.leaseMs, () => settleKernelMessages(cell));
      } catch (err) {
        core.onError(err, `claim ${cellId}`);
        continue;
      }
      if (!batch) continue;
      launch(batch, cell);
    }
  }

  function detach(handle: RunHandle): void {
    if (!runs.delete(handle.claimId)) return;
    const s = byCell.get(handle.cellId);
    s?.delete(handle.claimId);
    if (s && s.size === 0) byCell.delete(handle.cellId);
  }

  function launch(batch: ClaimedBatch, cell: CellRecord): void {
    const handle: RunHandle = {
      claimId: batch.claimId,
      cellId: batch.cellId,
      epoch: batch.epoch,
      startedAt: clock.now(),
      controller: new AbortController(),
      stopReason: null,
      done: Promise.resolve(),
      stallOnly: batch.envelopes.every(e => e.type === PAYLOAD.stalledCheck || e.delivery === "silent_inject"),
      selfSettle: null,
    };
    runs.set(handle.claimId, handle);
    let set = byCell.get(handle.cellId);
    if (!set) byCell.set(handle.cellId, (set = new Set()));
    set.add(handle.claimId);
    handle.done = execute(handle, batch, cell)
      .catch((err) => core.onError(err, `run ${handle.claimId} of ${handle.cellId}`))
      .finally(() => {
        detach(handle);
        notify(handle.cellId);
        schedulePump();
        wakeWaiters();
      });
  }

  function stale(handle: RunHandle): boolean {
    const cur = cells.get(handle.cellId);
    return !cur || cur.epoch !== handle.epoch || !cells.isActiveInTree(handle.cellId);
  }

  function attemptsOf(claimId: string): number {
    let n = 0;
    for (const m of inbox.listMessagesSync({ claimId })) n = Math.max(n, m.attempts);
    return n;
  }

  /** The Run failed or was stopped: its batch goes back to the queue (or is cancelled with the epoch). */
  function releaseClaim(handle: RunHandle, result: "error" | "cancelled", error: string | undefined): void {
    if (result === "error") {
      const attempts = attemptsOf(handle.claimId);
      const delay = Math.min(core.maxRetryBackoffMs, core.retryBackoffMs * 2 ** attempts);
      inbox.releaseSync(handle.claimId, `run failed: ${error ?? "unknown error"}`, { retryAt: clock.now() + delay });
      return;
    }
    const reason = handle.stopReason ?? "aborted";
    // Pause and shutdown are not failures; cancel/close moved the epoch, so the batch is cancelled anyway.
    inbox.releaseSync(handle.claimId, `run stopped: ${reason}`, { countAttempt: reason !== "pause" && reason !== "shutdown" });
  }

  function lastWords(cellId: string, runId: string): string | null {
    const records = context.listEvidenceSync(cellId, { runId });
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]!.record;
      if (r.kind === "assistant_text" && r.text.trim()) return r.text.trim().slice(0, 4_000);
    }
    return null;
  }

  /**
   * The single sender of a cell's final result (docs/05 guard 1). Runs inside the settle transaction: the result
   * (fixed id per cell and epoch, so a replay can never deliver a second one) and the close commit together with the
   * completed claim, or not at all.
   */
  function candidateOf(handle: RunHandle): CellResultCandidate | undefined {
    const candidate = context.readStateSync<CellResultCandidate>(handle.cellId, CELL_RESULT_CANDIDATE_KEY);
    return candidate?.runId === handle.claimId ? candidate : undefined;
  }

  function deliverAndClose(cell: CellRecord, handle: RunHandle, how: { reason: CloseReason; failed?: string; summary?: string }): string[] {
    const cellId = cell.id;
    const parent = cell.parentId ? cells.get(cell.parentId) : undefined;
    if (parent && parent.status !== "closed") {
      const cand = candidateOf(handle);
      const said = how.failed ?? cand?.summary ?? how.summary ?? lastWords(cellId, handle.claimId);
      const payload: CellResultPayload = {
        childCellId: cellId,
        status: how.failed !== undefined ? "failed" : how.reason === "cancelled" ? "cancelled" : (cand?.status ?? "completed"),
        summary: said ?? "Finished without a report.",
        ...(cand?.artifactId ? { artifactId: cand.artifactId } : {}),
        ...(cand?.data !== undefined ? { data: cand.data } : {}),
        childState: "closed",
      };
      inbox.enqueueSync(
        parent.id,
        createEnvelope<CellResultPayload>(
          {
            id: finalResultEnvelopeId(cellId, handle.epoch),
            from: inboxAddr(cellId),
            to: inboxAddr(parent.id),
            principalId: cellPrincipal(cellId),
            kind: "result",
            type: PAYLOAD.cellResult,
            payload,
            expectedEpoch: parent.epoch,
          },
          clock,
        ),
      );
    }
    return core.lifecycle.closeCellSync(cellId, how.reason, { internal: true, principalId: cellPrincipal(cellId) });
  }

  /**
   * A wakeable leaf's turn has settled: the parent is told, by the kernel, every time — it does not depend on the
   * worker remembering to report, and a worker the owner woke directly reports like any other. Runs inside the settle
   * transaction. The notice carries facts read from the record (what range of evidence the turn covers, whether the
   * owner spoke to the worker directly, which artifacts it touched, how many tool calls, its last words); the parent
   * pulls the detail with inspect_cell. The cell is not closed: it stays active with nothing in flight — dormant.
   */
  function notifySettled(cell: CellRecord, handle: RunHandle, how: { failed?: string; outcome: SettledTurn["outcome"] }): void {
    const cellId = cell.id;
    const now = clock.now();
    const prev = context.readStateSync<CellTurnState>(cellId, CELL_TURN_KEY);
    const chat = context.readStateSync<CellDirectChatState>(cellId, CELL_DIRECT_CHAT_KEY);
    const cand = candidateOf(handle);
    const fromSeq = (prev?.settledSeq ?? 0) + 1;
    const records = context.listEvidenceSync(cellId, { afterSeq: fromSeq - 1 });
    const toSeq = records.length ? records[records.length - 1]!.seq : fromSeq - 1;
    let steps = 0;
    let said: string | null = null;
    const artifactIds = new Set<string>();
    for (const { record: r } of records) {
      if (r.kind === "assistant_text" && r.text.trim()) said = r.text.trim();
      if (r.kind !== "tool_call") continue;
      steps++;
      // Artifacts it wrote through the kernel tools, whoever created them first.
      const id = (r.input as { artifactId?: unknown } | null)?.artifactId;
      if ((r.name === "save_artifact" || r.name === "patch_artifact") && typeof id === "string") artifactIds.add(id);
    }
    for (const a of context.listArtifactsSync(cellId)) if (a.updatedAt >= (prev?.settledAt ?? 0)) artifactIds.add(a.artifactId);
    if (cand?.artifactId) artifactIds.add(cand.artifactId);
    const directChats = chat?.unsettled ?? 0;
    const turn: SettledTurn = {
      runId: handle.claimId,
      fromSeq,
      toSeq,
      hadDirectUserChat: directChats > 0,
      directChats,
      artifactIds: [...artifactIds],
      steps,
      outcome: how.failed !== undefined ? how.outcome : cand?.status === "failed" ? "failed" : how.outcome,
      preview: said ? (said.length > 600 ? `${said.slice(0, 600)}…` : said) : null,
    };
    const parent = cell.parentId ? cells.get(cell.parentId) : undefined;
    if (parent && parent.status !== "closed") {
      const payload: CellResultPayload = {
        childCellId: cellId,
        status: how.failed !== undefined ? "failed" : (cand?.status ?? "completed"),
        summary: how.failed ?? cand?.summary ?? (said ? said.slice(0, 4_000) : "Its turn ended without a word; inspect_cell shows what it did."),
        ...(cand?.artifactId ? { artifactId: cand.artifactId } : {}),
        ...(cand?.data !== undefined ? { data: cand.data } : {}),
        childState: "dormant",
        turn,
      };
      inbox.enqueueSync(
        parent.id,
        createEnvelope<CellResultPayload>(
          {
            // Per Run, not per life: the worker's second and third settled turns are announced like the first.
            id: `${cellId}:${handle.claimId}:settled`,
            from: inboxAddr(cellId),
            to: inboxAddr(parent.id),
            principalId: cellPrincipal(cellId),
            kind: "result",
            type: PAYLOAD.cellResult,
            payload,
            expectedEpoch: parent.epoch,
          },
          clock,
        ),
      );
    }
    context.commitSync(cellId, {
      statePatches: {
        [CELL_TURN_KEY]: { settledSeq: toSeq, settledAt: now, notices: (prev?.notices ?? 0) + 1 } satisfies CellTurnState,
        // Delivered: the next turn reports for itself.
        [CELL_RESULT_CANDIDATE_KEY]: null,
        ...(chat ? { [CELL_DIRECT_CHAT_KEY]: { ...chat, unsettled: 0 } satisfies CellDirectChatState } : {}),
      },
    });
  }

  /**
   * How a Run that returned (did not throw, was not aborted) is settled — one transaction, entered only after the Run
   * left the run table, so nothing here can race the cell's own next Run or wait on itself:
   *
   * - the claim is completed;
   * - `step_limit`: a continuation is queued (or, past the limit, the owner is asked) — never reported as done;
   * - `refused`: a one-shot cell delivers a *failed* result and closes, a wakeable one tells its parent the turn
   *   failed and stays; any other cell raises a blocked card;
   * - `completed` on a leaf, or a `complete`/`cancel` request (complete_self) on any cell — **drain first**: if a
   *   wake-up is waiting in the inbox (a follow-up that arrived while it worked — silent notes do not count) or
   *   another claim is live, nothing is sent: the next Run takes the follow-up and the candidate result is refreshed.
   *   Otherwise, atomically here: a one-shot cell (or an explicit request) delivers the final result and closes; a
   *   wakeable cell — unless it still has a wait open, a Job running, a card with the owner or a timer or watch of
   *   its own, which all mean the turn is not over — tells its parent the turn settled (notifySettled) and stays,
   *   dormant.
   * - a `pause` request (pause_self): the cell is parked.
   * An explicit request also applies to a Run that ended `yielded_waiting` (an earlier tool of the turn arranged a
   * wake-up); it never applies to one that ended on a card.
   */
  function settleRun(handle: RunHandle, batch: ClaimedBatch, result: Exclude<RunResult, "error">): void {
    const cellId = handle.cellId;
    let closed: string[] = [];
    const afterwards: Array<() => void> = [];
    withTx(core.db, () => {
      const inputs = inbox.listMessagesSync({ claimId: handle.claimId, status: ["claimed", "done"] }).map(row => row.envelope);
      inbox.completeSync(handle.claimId);
      const cur = cells.get(cellId);
      // Closed or cancelled while it ran: the late outcome changes nothing (guard 4).
      if (!cur || cur.status === "closed" || cur.epoch !== handle.epoch) return;

      if (handle.cliInput) {
        const session = context.readStateSync<CliSessionRecord>(cellId, CLI_SESSION_KEY);
        if (session?.sessionId === handle.cliInput.sessionId) context.commitSync(cellId, { statePatches: {
          [CLI_SESSION_KEY]: { ...session, lastDeliveredEvidenceSeq: Math.max(session.lastDeliveredEvidenceSeq, handle.cliInput.throughSeq) },
        } });
      }
      if (result !== "cancelled") core.waits.answeredBy(cellId, inputs, handle.claimId);

      if (result === "step_limit") {
        const prev = batch.envelopes.reduce((n, e) => (e.type === PAYLOAD.runContinue ? Math.max(n, (e.payload as RunContinuePayload).count) : n), 0);
        if (prev >= core.maxStepContinuations) {
          core.escalations.stepLimit(cellId, prev + 1);
          core.stall.afterRun(cellId, inputs);
          return;
        }
        const payload: RunContinuePayload = { reason: "step_limit", count: prev + 1 };
        inbox.enqueueSync(
          cellId,
          createEnvelope<RunContinuePayload>(
            { id: `${handle.claimId}:continue`, from: KERNEL_FROM.dispatcher, principalId: cellPrincipal(cellId), kind: "event", type: PAYLOAD.runContinue, payload, expectedEpoch: handle.epoch },
            clock,
          ),
        );
        core.stall.afterRun(cellId, inputs);
        return;
      }

      if (result !== "cancelled") core.stall.afterRun(cellId, inputs);
      const leaf = isLeafLifetime(cur.spec.lifetime) && cur.parentId !== null;
      const oneShot = leaf && cur.spec.lifetime === "one_shot";
      if (result === "refused") {
        const said = lastWords(cellId, handle.claimId);
        const failed = `The model refused this task${said ? `: ${said}` : "."}`;
        if (oneShot) closed = deliverAndClose(cur, handle, { reason: "completed", failed });
        else if (leaf) notifySettled(cur, handle, { failed, outcome: "refused" });
        else afterwards.push(() => void core.escalations.refused(cellId, said));
        return;
      }
      // An explicit request (complete_self / pause_self) stands even when the Run is reported as waiting because an
      // earlier tool of the same turn arranged a wake-up (it spawned a child, started a job). A pending card is the
      // one thing that outranks it: the cell asked the owner something and must be there for the answer.
      const self = result === "completed" || result === "yielded_waiting" ? handle.selfSettle : null;
      // A wakeable leaf that ended its turn "waiting" may have arranged nothing to wait for (a bare `wait`): whether
      // its turn is over is decided below by what is actually out, not by how the Run was labelled.
      const restingLeaf = leaf && !oneShot && result === "yielded_waiting";
      const currentCandidate = leaf && candidateOf(handle);
      const reported = oneShot && result === "yielded_waiting" && currentCandidate;
      if (result !== "completed" && !self && !restingLeaf && !reported) return;
      if (!leaf && !self) return;
      // Drain first: something that would wake the cell is waiting, so it is not done.
      if (inbox.pendingWakeupCountSync(cellId) > 0 || inbox.activeClaimCountSync(cellId, handle.claimId) > 0) return;
      if (leaf && !oneShot && currentCandidate) {
        for (const wait of core.waits.list([cellId])) core.waits.clear(cellId, wait.waitId);
      }
      if (oneShot && !self && !currentCandidate &&
          core.readModel.activityOf([cellId]).get(cellId)?.state !== "dormant") return;
      if (!self && !oneShot) {
        // A wakeable leaf. Its turn is over only when nothing of it is still out — no wait it registered, no Job, no
        // card with the owner, no timer or watch it set for itself: exactly when it is dormant (this Run has already
        // left the run table and its claim is completed, so the read model sees the cell as it will be).
        if (core.readModel.activityOf([cellId]).get(cellId)?.state !== "dormant") return;
        notifySettled(cur, handle, { outcome: "completed" });
        return;
      }
      // Closing cascades. A cell with children that are still at work is not finished, whatever its model said
      // (dormant workers are not in the way: they are archived with it).
      const open = self?.force ? [] : core.readModel.blockingChildren(cellId).map((b) => b.cell);
      if (open.length > 0) {
        // The request was accepted when it was made (no child was open then); one was started afterwards. Say so on
        // the record, so the cell's next Run does not believe it closed.
        if (self) {
          context.appendEvidenceSync(cellId, {
            kind: "system_note",
            runId: handle.claimId,
            at: clock.now(),
            text: `[${self.action === "cancel" ? "cancelling" : "closing"} this cell was not carried out: ${open.length} child cell(s) were still at work when the run settled (${open.map((c) => c.id).join(", ")}). Call complete_self again once they are done or closed.]`,
          });
        }
        return;
      }
      if (self?.statePatches) context.commitSync(cellId, { statePatches: self.statePatches });
      if (self?.action === "pause") {
        if (cur.status === "active") inbox.controlSync(cellId, { action: "pause", ...(self.pauseReason ? {pauseReason:self.pauseReason} : {}), principalId: core.ownerPrincipal });
        return;
      }
      closed = deliverAndClose(cur, handle, { reason: self?.action === "cancel" ? "cancelled" : "completed", ...(self?.summary ? { summary: self.summary } : {}) });
    });
    if (closed.length > 0) void core.track(core.lifecycle.cleanupClosed(closed));
    for (const f of afterwards) {
      try {
        f();
      } catch (err) {
        core.onError(err, `settle follow-up of ${cellId}`);
      }
    }
  }

  /** Give the batch back or settle it, according to how the Run ended. */
  function settleClaim(handle: RunHandle, batch: ClaimedBatch, result: RunResult, error: string | undefined): void {
    try {
      if (result === "error") releaseClaim(handle, "error", error);
      else if (result === "cancelled" && handle.controller.signal.aborted) releaseClaim(handle, "cancelled", undefined);
      else settleRun(handle, batch, result);
    } catch (err) {
      // e.g. the lease expired under a very long Run: the batch already went back to the queue and will run again.
      if (!isNgError(err, "conflict")) throw err;
      core.onError(err, `settle claim ${handle.claimId}`);
    }
  }

  async function execute(handle: RunHandle, batch: ClaimedBatch, cell: CellRecord): Promise<void> {
    const { cellId, claimId: runId } = handle;
    bus.emit("run.started", { cellId, runId, epoch: handle.epoch });
    let result: RunResult = "error";
    let error: string | undefined;
    let ranLoop = false;

    const signal = handle.controller.signal;
    try {
      if (stale(handle)) {
        handle.stopReason ??= cells.get(cellId)?.status === "paused" ? "pause" : "close";
        handle.controller.abort(new Error("cell paused, closed or cancelled before the run started"));
      }
      signal.throwIfAborted();
      const snapshot = await context.hydrate(cellId, batch, cell.spec.contextMode ?? "isolated");
      signal.throwIfAborted();
      const at = clock.now();
      context.appendEvidenceSync(cellId, { kind: "run_boundary", phase: "start", epoch: handle.epoch, runId, at });
      for (const envelope of batch.envelopes) context.appendEvidenceSync(cellId, { kind: "inbound", envelope, runId, at });
      ranLoop = true;
      const ports = buildRunPorts(core, { cell, batch, handle, snapshot });
      const prepare = cell.preset ? core.registry.presets.get(cell.preset)?.prepareRun : undefined;
      let handled = false;
      if (prepare) {
        try {
          handled = (await prepare({ snapshot, ports, signal, clock })) === "handled";
        } catch (err) {
          if (signal.aborted) throw err;
          // The Loop still runs: a model that calls the preset's tools retries the same bookkeeping.
          core.onError(err, `prepareRun of ${cellId}`);
        }
        signal.throwIfAborted();
      }
      result = handled ? "completed" : await core.loop.run(snapshot, ports, signal);
    } catch (err) {
      if (signal.aborted) result = "cancelled";
      else {
        result = "error";
        error = err instanceof Error ? err.message : String(err);
      }
    }

    if (ranLoop) {
      try {
        context.appendEvidenceSync(cellId, {
          kind: "run_boundary",
          phase: "end",
          epoch: handle.epoch,
          runId,
          at: clock.now(),
          outcome: result,
          ...(error !== undefined ? { error } : {}),
        });
      } catch (err) {
        core.onError(err, `run boundary of ${runId}`);
      }
    }
    // Out of the run table first: the settlement below may close this very cell (its cleanup waits for the cell's Runs)
    // or leave it free for the Run that takes a follow-up.
    detach(handle);
    settleClaim(handle, batch, result, error);
    try {
      if (cells.get(cellId)) cells.update(cellId, { lastRunAt: clock.now() });
    } catch (err) {
      core.onError(err, `lastRunAt of ${cellId}`);
    }
    bus.emit("run.finished", { cellId, runId, epoch: handle.epoch, outcome: result, ...(error !== undefined ? { error } : {}) });
  }

  function abortCells(cellIds: readonly string[], reason: StopReason): void {
    const ids = new Set(cellIds);
    for (const h of runs.values()) {
      if (!ids.has(h.cellId) || h.controller.signal.aborted) continue;
      h.stopReason = reason;
      h.controller.abort(new Error(`run stopped: ${reason}`));
    }
  }

  async function settled(cellIds: readonly string[]): Promise<void> {
    const ids = new Set(cellIds);
    const pending = [...runs.values()].filter((h) => ids.has(h.cellId)).map((h) => h.done);
    await Promise.allSettled(pending);
  }

  function renewAll(): void {
    for (const h of runs.values()) {
      try {
        inbox.renewLeaseSync(h.claimId, core.leaseMs);
      } catch (err) {
        core.onError(err, `renew lease ${h.claimId}`);
      }
    }
  }

  async function idle(o: IdleOptions = {}): Promise<void> {
    const deadline = Date.now() + (o.timeoutMs ?? opts.idleTimeoutMs);
    for (;;) {
      await new Promise<void>((r) => setImmediate(r));
      const busy = runs.size > 0 || pumpScheduled || core.pendingTasks() > 0;
      if (!busy && started) {
        const next = inbox.nextWakeAtSync();
        if (next !== null && next <= clock.now()) inbox.tickSync();
        const dueNow = inbox.dueCellIdsSync().filter((id) => !unknownOrphans.has(id));
        const jobsRunning = o.jobs ? core.workspace.listJobsSync({ state: ["running"] }).length : 0;
        if (dueNow.length === 0 && jobsRunning === 0 && !pumpScheduled && runs.size === 0) return;
        for (const id of dueNow) notify(id);
      } else if (!busy) {
        return;
      }
      if (Date.now() > deadline) {
        const detail = {
          runs: [...runs.values()].map((h) => `${h.cellId}/${h.claimId}`),
          due: started ? inbox.dueCellIdsSync() : [],
          tasks: core.pendingTasks(),
          jobs: core.workspace.listJobsSync({ state: ["running"] }).map((j) => `${j.cellId}:${j.command}`),
        };
        throw new Error(`kernel.idle() timed out: ${JSON.stringify(detail)}`);
      }
      const waits: Array<Promise<void>> = [nextRunEnd(), sleep(runs.size > 0 ? 50 : 5)];
      if (core.pendingTasks() > 0) waits.push(core.tasksSettled());
      await Promise.race(waits);
    }
  }

  return {
    workerId: core.ownerInstanceId,
    start() {
      if (started) return;
      started = true;
      ensureOrphanPoller();
      schedulePump();
    },
    async stop() {
      started = false;
      if (orphanTimer) {
        clearInterval(orphanTimer);
        orphanTimer = undefined;
      }
      abortCells([...byCell.keys()], "shutdown");
      await Promise.allSettled([...runs.values()].map((h) => h.done));
    },
    notify,
    abortCells,
    settled,
    isRunning: (cellId) => inFlight(cellId) > 0,
    activeRuns: () => [...runs.values()].map((h) => ({ runId: h.claimId, cellId: h.cellId, epoch: h.epoch, startedAt: h.startedAt })),
    renewAll,
    idle,
    holdForUnknownOrphan,
    running: () => [...runs.values()].map((h) => ({ cellId: h.cellId, stallOnly: h.stallOnly })),
  };
}
