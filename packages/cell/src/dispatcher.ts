import {
  CELL_RESULT_CANDIDATE_KEY,
  cellPrincipal,
  createEnvelope,
  finalResultEnvelopeId,
  inboxAddr,
  isNgError,
  KERNEL_FROM,
  newId,
  PAYLOAD,
  withTx,
  type CellRecord,
  type CellResultCandidate,
  type CellResultPayload,
  type ClaimedBatch,
  type CloseReason,
  type Envelope,
  type RunContinuePayload,
  type SelfSettleRequest,
  type TimerFiredPayload,
} from "@ng/protocol";
import { RESURFACE_MARKER } from "./constants";
import type { KernelCore } from "./core";
import { buildRunPorts } from "./ports";
import type { IdleOptions, RunInfo, RunResult } from "./types";
import { workTreeKey, writeSlotKey } from "./workdir";

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
  /** docs/05 §3.2: the work tree whose write slot this Run holds (null: a read-mode or privately isolated cell). */
  slotKey: string | null;
  /** docs/05 guard 2: only a `kernel.stalled_check` started this Run — it is not an anchor of its project. */
  stallOnly: boolean;
  /** RunPorts.settleSelf: what to do with the cell once this Run has settled. */
  selfSettle: SelfSettleRequest | null;
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
  /** A write slot may have been freed outside a Run's end (a Job finished, a closed cell's runtime stopped). */
  slotsChanged(): void;
  /** Cells with due work that wait for their work tree's write slot, in arrival order. */
  queued(): Array<{ cellId: string; key: string }>;
  /** The other cell that holds `key` right now through a Run or a running Job, if any. */
  slotHolder(key: string, exceptCellId?: string): string | null;
  /** Runs in flight with what the stall check and the occupancy view need. */
  running(): Array<{ cellId: string; slotKey: string | null; stallOnly: boolean }>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isResurface(env: Envelope): boolean {
  if (env.type !== "timer.fired") return false;
  const data = (env.payload as TimerFiredPayload | null)?.data;
  return data !== null && typeof data === "object" && (data as Record<string, unknown>)["kernel"] === RESURFACE_MARKER;
}

export function createDispatcher(core: KernelCore, opts: { idleTimeoutMs: number }): Dispatcher {
  const { inbox, cells, bus, clock, context } = core;
  const workerId = newId("kernel", clock);
  const runs = new Map<string, RunHandle>();
  const byCell = new Map<string, Set<string>>();
  const due: string[] = [];
  const dueSet = new Set<string>();
  const runEndWaiters = new Set<() => void>();
  /** Writing cells with due work whose work tree is taken, in arrival order (docs/05 §3.2). */
  const parked = new Map<string, string>();
  let started = false;
  let pumpScheduled = false;

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

  // ---------- per-work-tree write slot (docs/05 §3.2) ----------
  // Mutual exclusion lives here and nowhere else: planners spawn freely, and a second writer of the same work tree
  // simply is not started until the first one's Run *and* background Jobs are gone. A cell that goes to sleep (wait,
  // a card) holds nothing, so a worker waiting for an arbitration can never block the worker sent to fix its problem.

  function slotHolder(key: string, exceptCellId?: string): string | null {
    for (const h of runs.values()) if (h.slotKey === key && h.cellId !== exceptCellId) return h.cellId;
    // A Job outlives its Run and keeps writing; "running" includes one that is being cancelled until its process
    // group is confirmed gone (workspace JobManager.cancel), and Jobs of a cell that was just closed.
    for (const j of core.workspace.listJobsSync({ state: ["running"] })) {
      if (j.cellId === exceptCellId || !j.cwd) continue;
      if (workTreeKey(j.cwd) === key) return j.cellId;
    }
    return null;
  }

  function requeueParked(): void {
    if (parked.size === 0) return;
    const ids = [...parked.keys()];
    parked.clear();
    // Back to the front, in their original order: whoever waited longest for the tree gets it first.
    for (const id of ids.reverse()) {
      if (dueSet.has(id)) continue;
      dueSet.add(id);
      due.unshift(id);
    }
    schedulePump();
  }

  function pump(): void {
    let budget = due.length;
    let dueNow: Set<string> | null = null;
    while (started && budget-- > 0 && runs.size < core.maxConcurrentRuns && due.length > 0) {
      const cellId = due.shift()!;
      dueSet.delete(cellId);
      const cell = cells.get(cellId);
      if (!cell || cell.status !== "active") continue;
      const mode = cell.spec.claimMode ?? "serial_coalesce";
      // A cell with a Run in flight is re-notified when that Run ends; the claim is the real lock either way.
      if (mode === "serial_coalesce" && inFlight(cellId) > 0) continue;
      if (mode === "competing_workers" && inFlight(cellId) >= (cell.spec.maxParallelRuns ?? core.maxConcurrentRuns)) continue;
      let key: string | null;
      try {
        key = writeSlotKey(core, cell);
      } catch (err) {
        core.onError(err, `work tree of ${cellId}`);
        key = null;
      }
      if (key !== null && slotHolder(key, cellId) !== null) {
        // Not claimed: its messages stay pending (no lease runs), and later arrivals simply join the batch.
        dueNow ??= new Set(inbox.dueCellIdsSync());
        if (dueNow.has(cellId)) parked.set(cellId, key);
        continue;
      }
      let batch: ClaimedBatch | null;
      try {
        batch = inbox.claimNextRunSync(cellId, workerId, mode, core.leaseMs);
      } catch (err) {
        core.onError(err, `claim ${cellId}`);
        continue;
      }
      if (!batch) continue;
      launch(batch, cell, key);
      if (mode === "competing_workers") notify(cellId);
    }
  }

  function detach(handle: RunHandle): void {
    if (!runs.delete(handle.claimId)) return;
    const s = byCell.get(handle.cellId);
    s?.delete(handle.claimId);
    if (s && s.size === 0) byCell.delete(handle.cellId);
  }

  function launch(batch: ClaimedBatch, cell: CellRecord, slotKey: string | null): void {
    const handle: RunHandle = {
      claimId: batch.claimId,
      cellId: batch.cellId,
      epoch: batch.epoch,
      startedAt: clock.now(),
      controller: new AbortController(),
      stopReason: null,
      done: Promise.resolve(),
      slotKey,
      stallOnly: false,
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
        requeueParked();
        schedulePump();
        wakeWaiters();
      });
  }

  function stale(handle: RunHandle): boolean {
    const cur = cells.get(handle.cellId);
    return !cur || cur.status !== "active" || cur.epoch !== handle.epoch;
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
  function deliverAndClose(cell: CellRecord, handle: RunHandle, how: { reason: CloseReason; failed?: string; summary?: string }): string[] {
    const cellId = cell.id;
    const parent = cell.parentId ? cells.get(cell.parentId) : undefined;
    if (parent && parent.status !== "closed") {
      const cand = context.readStateSync<CellResultCandidate>(cellId, CELL_RESULT_CANDIDATE_KEY);
      const said = how.failed ?? cand?.summary ?? how.summary ?? lastWords(cellId, handle.claimId);
      const payload: CellResultPayload = {
        childCellId: cellId,
        status: how.failed !== undefined ? "failed" : how.reason === "cancelled" ? "cancelled" : (cand?.status ?? "completed"),
        summary: said ?? "Finished without a report.",
        ...(cand?.artifactId ? { artifactId: cand.artifactId } : {}),
        ...(cand?.data !== undefined ? { data: cand.data } : {}),
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
   * How a Run that returned (did not throw, was not aborted) is settled — one transaction, entered only after the Run
   * left the run table, so nothing here can race the cell's own next Run or wait on itself:
   *
   * - the claim is completed;
   * - `step_limit`: a continuation is queued (or, past the limit, the owner is asked) — never reported as done;
   * - `refused`: a one-shot cell delivers a *failed* result and closes; any other cell raises a blocked card;
   * - `completed` on a one-shot cell, or a `complete`/`cancel` request (complete_self) on any cell: **drain-then-close**.
   *   If a wake-up is waiting in the inbox (a follow-up that arrived while it worked — silent notes do not count) or
   *   another claim is live, nothing is sent and nothing closes: the next Run takes the follow-up and the candidate
   *   result is refreshed. Otherwise the final result is delivered and the cell closed, here, atomically. A sender
   *   that lost the race gets `closed` from sendToCell (it runs in its own transaction, before or after this one).
   * - a `pause` request (pause_self): the cell is parked.
   * An explicit request also applies to a Run that ended `yielded_waiting` (an earlier tool of the turn arranged a
   * wake-up); it never applies to one that ended on a card.
   */
  function settleRun(handle: RunHandle, batch: ClaimedBatch, result: Exclude<RunResult, "error">): void {
    const cellId = handle.cellId;
    let closed: string[] = [];
    const afterwards: Array<() => void> = [];
    withTx(core.db, () => {
      inbox.completeSync(handle.claimId);
      const cur = cells.get(cellId);
      // Closed or cancelled while it ran: the late outcome changes nothing (guard 4).
      if (!cur || cur.status === "closed" || cur.epoch !== handle.epoch) return;

      if (result === "step_limit") {
        const prev = batch.envelopes.reduce((n, e) => (e.type === PAYLOAD.runContinue ? Math.max(n, (e.payload as RunContinuePayload).count) : n), 0);
        if (prev >= core.maxStepContinuations) {
          afterwards.push(() => void core.escalations.stepLimit(cellId, prev + 1));
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
        return;
      }

      const oneShot = cur.spec.lifetime === "one_shot" && cur.parentId !== null;
      if (result === "refused") {
        const said = lastWords(cellId, handle.claimId);
        if (oneShot) closed = deliverAndClose(cur, handle, { reason: "completed", failed: `The model refused this task${said ? `: ${said}` : "."}` });
        else afterwards.push(() => void core.escalations.refused(cellId, said));
        return;
      }
      // An explicit request (complete_self / pause_self) stands even when the Run is reported as waiting because an
      // earlier tool of the same turn arranged a wake-up (it spawned a child, started a job). A pending card is the
      // one thing that outranks it: the cell asked the owner something and must be there for the answer.
      const self = result === "completed" || result === "yielded_waiting" ? handle.selfSettle : null;
      if (result !== "completed" && !self) return;
      if (self?.action === "pause") {
        if (cur.status === "active") inbox.controlSync(cellId, { action: "pause", principalId: core.ownerPrincipal });
        return;
      }
      if (!oneShot && !self) return;
      // Drain first: something that would wake the cell is waiting, so it is not done.
      if (inbox.pendingWakeupCountSync(cellId) > 0 || inbox.activeClaimCountSync(cellId, handle.claimId) > 0) return;
      // Closing cascades. A cell that still has children is not finished, whatever its model said.
      const open = self?.force ? [] : cells.children(cellId, { status: ["active", "paused"] });
      if (open.length > 0) {
        // The request was accepted when it was made (no child was open then); one was started afterwards. Say so on
        // the record, so the cell's next Run does not believe it closed.
        if (self) {
          context.appendEvidenceSync(cellId, {
            kind: "system_note",
            runId: handle.claimId,
            at: clock.now(),
            text: `[${self.action === "cancel" ? "cancelling" : "closing"} this cell was not carried out: ${open.length} child cell(s) were still open when the run settled (${open.map((c) => c.id).join(", ")}). Call complete_self again once they are done or closed.]`,
          });
        }
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

    // Kernel bookkeeping (a snoozed card coming due) needs no Run of its own.
    const resurfacing = batch.envelopes.filter(isResurface);
    for (const env of resurfacing) core.approvals.resurfaced(env);
    // The parties this cell was waiting for have answered (docs/05 guard 2): their waits close now, others stay open.
    try {
      core.waits.answeredBy(cellId, batch.envelopes);
    } catch (err) {
      core.onError(err, `waits of ${cellId}`);
    }
    // A stalled_check that reaches a project which has found an anchor in the meantime is dropped unseen: the grace
    // period is re-checked at delivery, so a project that merely paused between two steps is never woken for it.
    const stallChecks = batch.envelopes.filter((e) => e.type === PAYLOAD.stalledCheck);
    const bookkeepingOnly = resurfacing.length + stallChecks.length === batch.envelopes.length;
    if (stallChecks.length > 0 && bookkeepingOnly) handle.stallOnly = true;
    if (resurfacing.length === batch.envelopes.length || (bookkeepingOnly && !core.stall.stillStalled(stallChecks))) {
      // No Run happened, so nothing is settled beyond the claim: a one-shot cell must not be "completed" (reported and
      // closed) because a snoozed card of its came back.
      detach(handle);
      try {
        inbox.completeSync(handle.claimId);
      } catch (err) {
        if (!isNgError(err, "conflict")) throw err;
        core.onError(err, `settle claim ${handle.claimId}`);
      }
      bus.emit("run.finished", { cellId, runId, epoch: handle.epoch, outcome: "completed" });
      return;
    }

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
    if (result === "budget_stopped") {
      try {
        core.escalations.budgetStopped(cellId);
      } catch (err) {
        core.onError(err, `budget escalation of ${cellId}`);
      }
    }
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
        // A cell queued behind a Job that holds its work tree is not something this loop can move: it starts when
        // the Job ends (wait for that with `jobs: true`).
        const dueNow = inbox.dueCellIdsSync().filter((id) => !parked.has(id));
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
    workerId,
    start() {
      if (started) return;
      started = true;
      schedulePump();
    },
    async stop() {
      started = false;
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
    slotsChanged: requeueParked,
    queued: () => [...parked].map(([cellId, key]) => ({ cellId, key })),
    slotHolder,
    running: () => [...runs.values()].map((h) => ({ cellId: h.cellId, slotKey: h.slotKey, stallOnly: h.stallOnly })),
  };
}
