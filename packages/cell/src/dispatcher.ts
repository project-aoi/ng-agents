import { isNgError, newId, type CellRecord, type ClaimedBatch, type Envelope, type TimerFiredPayload } from "@ng/protocol";
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

  function pump(): void {
    let budget = due.length;
    while (started && budget-- > 0 && runs.size < core.maxConcurrentRuns && due.length > 0) {
      const cellId = due.shift()!;
      dueSet.delete(cellId);
      const cell = cells.get(cellId);
      if (!cell || cell.status !== "active") continue;
      const mode = cell.spec.claimMode ?? "serial_coalesce";
      // A cell with a Run in flight is re-notified when that Run ends; the claim is the real lock either way.
      if (mode === "serial_coalesce" && inFlight(cellId) > 0) continue;
      if (mode === "competing_workers" && inFlight(cellId) >= (cell.spec.maxParallelRuns ?? core.maxConcurrentRuns)) continue;
      let batch: ClaimedBatch | null;
      try {
        batch = inbox.claimNextRunSync(cellId, workerId, mode, core.leaseMs);
      } catch (err) {
        core.onError(err, `claim ${cellId}`);
        continue;
      }
      if (!batch) continue;
      launch(batch, cell);
      if (mode === "competing_workers") notify(cellId);
    }
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
    };
    runs.set(handle.claimId, handle);
    let set = byCell.get(handle.cellId);
    if (!set) byCell.set(handle.cellId, (set = new Set()));
    set.add(handle.claimId);
    handle.done = execute(handle, batch, cell)
      .catch((err) => core.onError(err, `run ${handle.claimId} of ${handle.cellId}`))
      .finally(() => {
        runs.delete(handle.claimId);
        const s = byCell.get(handle.cellId);
        s?.delete(handle.claimId);
        if (s && s.size === 0) byCell.delete(handle.cellId);
        notify(handle.cellId);
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

  /** Give the batch back or complete it, according to how the Run ended. */
  function settleClaim(handle: RunHandle, result: RunResult, error: string | undefined): void {
    try {
      if (result === "error") {
        const attempts = attemptsOf(handle.claimId);
        const delay = Math.min(core.maxRetryBackoffMs, core.retryBackoffMs * 2 ** attempts);
        inbox.releaseSync(handle.claimId, `run failed: ${error ?? "unknown error"}`, { retryAt: clock.now() + delay });
      } else if (result === "cancelled" && handle.controller.signal.aborted) {
        const reason = handle.stopReason ?? "aborted";
        // Pause and shutdown are not failures; cancel/close moved the epoch, so the batch is cancelled anyway.
        inbox.releaseSync(handle.claimId, `run stopped: ${reason}`, { countAttempt: reason !== "pause" && reason !== "shutdown" });
      } else {
        inbox.completeSync(handle.claimId);
      }
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
    if (resurfacing.length === batch.envelopes.length) {
      settleClaim(handle, "completed", undefined);
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
    settleClaim(handle, result, error);
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
        const dueNow = inbox.dueCellIdsSync();
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
  };
}
