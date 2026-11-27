import { CLI_SESSION_KEY, type CliSessionRecord, probeOrphanCliCell, reapOrphanedCliProcesses } from "@ng/loop";
import {
  all,
  get,
  run,
  stripAnsi,
  timerFrom,
  CELL_DIRECT_CHAT_KEY,
  CELL_RESULT_CANDIDATE_KEY,
  CELL_STATUS_KEY,
  CELL_TURN_KEY,
  STEER_NOTE_HEAD,
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
  type PromptSnapshot,
  type RunContinuePayload,
  type SelfSettleRequest,
  type SettledTurn,
  type TimerFiredPayload,
} from "@ng/protocol";
import { RESURFACE_MARKER, MESSAGE_ARRIVED, notCarriedOut } from "./constants";
import { effectiveCwd } from "./workdir";
import { isProjectRoot, type KernelCore } from "./core";
import { recordPaused } from "./pauses";
import { buildRunPorts } from "./ports";
import { WAIT_HUMAN } from "./waits";
import type { IdleOptions, RunInfo, RunResult } from "./types";

/** Why the kernel stopped a Run: decides whether releasing its claim counts as a failed attempt. */
export type StopReason = "cancel" | "pause" | "close" | "shutdown";

export interface RunHandle {
  cwd: string | null;
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
  /** Launch order within this kernel process. */
  seq: number;
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
  running(): Array<{ cwd: string | null; cellId: string; stallOnly: boolean }>;
  /**
   * `root` was just resumed and `cellIds` (below it) woke with it. While the root has a Run to do, theirs wait for it
   * to settle: the coordinator reads what was said at the resume before a worker picks up an instruction from before
   * the pause. A root with nothing to do holds nobody.
   */
  holdUntilSettled(root: string, cellIds: readonly string[]): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isResurface(env: Envelope): boolean {
  if (env.from!==timerFrom("approval") || env.type !== "timer.fired") return false;
  const data = (env.payload as TimerFiredPayload | null)?.data;
  return data !== null && typeof data === "object" && (data as Record<string, unknown>)["kernel"] === RESURFACE_MARKER;
}

/** Somebody speaking to a cell, as opposed to its own machinery waking it. */
const SPOKEN: ReadonlySet<string> = new Set([PAYLOAD.cellMessage, PAYLOAD.userMessage, PAYLOAD.controlSteer]);

/** Read-only tools whose completion produces no external or persistent write side effects (M1). */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_state",
  "read_artifact",
  "read_resource",
  "search_history",
  "inspect_cell",
  "list_artifacts",
  "job_observe",
  "review_week",
  "no_hit",
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebSearch",
  "WebFetch",
  "read_file",
  "list_dir",
  "find_by_name",
  "grep_search",
  "view_file",
]);

function summarizeWriteCall(name: string, input: unknown): string {
  const rec = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (!rec) return name;
  if (name === "send_message" && typeof rec["to"] === "string") return `send_message(to=${rec["to"]})`;
  if (name === "set_state" && rec["patches"] && typeof rec["patches"] === "object") {
    const keys = Object.keys(rec["patches"] as Record<string, unknown>).slice(0, 4).join(",");
    return `set_state(keys=${keys})`;
  }
  if ((name === "save_artifact" || name === "patch_artifact") && typeof rec["artifactId"] === "string") {
    return `${name}(${rec["artifactId"]})`;
  }
  if ((name === "spawn_cell" || name === "dispatch") && typeof rec["title"] === "string") {
    return `${name}(${String(rec["title"]).slice(0, 40)})`;
  }
  if (name === "request_approval" && typeof rec["title"] === "string") {
    return `request_approval(${String(rec["title"]).slice(0, 40)})`;
  }
  if (typeof rec["command"] === "string") {
    return `${name}(${rec["command"].replace(/\s+/g, " ").trim().slice(0, 60)})`;
  }
  const compact = JSON.stringify(rec);
  return compact.length <= 80 ? `${name}(${compact})` : `${name}(${compact.slice(0, 77)}…)`;
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
  /** holdUntilSettled: cell → the resumed root it waits for, and the launch count when the hold was set. */
  const resumeHolds = new Map<string, { root: string; after: number }>();
  let launchSeq = 0;
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
        inbox.retryPendingSync(cellId, env.id, String(err), core.retryBackoffMs);
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
      const hold = resumeHolds.get(cellId);
      if (hold) {
        // Re-notified when the root's Run ends (launch's finally). A root with nothing to do, or gone, holds nobody.
        if (cells.isActiveInTree(hold.root) && (inFlight(hold.root) > 0 || inbox.dueCellIdsSync().includes(hold.root))) continue;
        resumeHolds.delete(cellId);
      }
      if (core.workspace.listJobsSync({cellId, state:["running"]}).some(job => job.cancelRequestedAt !== null)) continue;
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
      if (!batch) {
        // Nothing to run after all (its due message was a kernel notice settled without a Run): whoever was held back
        // for this cell is looked at again.
        for (const [id, hold] of resumeHolds) if (hold.root === cellId) notify(id);
        continue;
      }
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
      cwd: cell.spec.cwd || core.repoPath ? effectiveCwd(core, cell) : null,
      claimId: batch.claimId,
      cellId: batch.cellId,
      epoch: batch.epoch,
      startedAt: clock.now(),
      controller: new AbortController(),
      stopReason: null,
      done: Promise.resolve(),
      stallOnly: batch.envelopes.every(e => e.type === PAYLOAD.stalledCheck || e.delivery === "silent_inject"),
      selfSettle: null,
      seq: ++launchSeq,
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
        // The resumed coordinator has had its Run: the cells that waited for it go.
        for (const [id, hold] of resumeHolds) {
          if (hold.root !== handle.cellId || handle.seq <= hold.after) continue;
          resumeHolds.delete(id);
          notify(id);
        }
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

  /** M1: Extract completed non-error write tool calls executed during this Run before it failed. */
  function executedWritesOf(cellId: string, runId: string): string[] {
    const records = context.listEvidenceSync(cellId, { runId });
    const calls = new Map<string, { name: string; input: unknown }>();
    const writes: string[] = [];
    for (const { record: r } of records) {
      if (r.kind === "tool_call") {
        calls.set(r.toolUseId, { name: r.name, input: r.input });
      } else if (r.kind === "tool_result" && !r.isError) {
        const call = calls.get(r.toolUseId);
        const name = call?.name ?? r.name;
        if (!READ_ONLY_TOOLS.has(name)) {
          writes.push(summarizeWriteCall(name, call?.input));
        }
      }
    }
    if (writes.length <= 20) return writes;
    return [...writes.slice(0, 19), `…(+${writes.length - 19} more writes)`];
  }

  /** The Run failed or was stopped: its batch goes back to the queue (or is cancelled with the epoch). */
  function releaseClaim(handle: RunHandle, result: "error" | "cancelled", error: string | undefined): void {
    if (result === "error") {
      const cleanError = stripAnsi(error ?? "unknown error");
      const attempts = attemptsOf(handle.claimId);
      const delay = Math.min(core.maxRetryBackoffMs, core.retryBackoffMs * 2 ** attempts);
      inbox.releaseSync(handle.claimId, `run failed: ${cleanError}`, { retryAt: clock.now() + delay });
      return;
    }
    const reason = handle.stopReason ?? "aborted";
    // Pause and shutdown are not failures; cancel/close moved the epoch, so the batch is cancelled anyway.
    inbox.releaseSync(handle.claimId, `run stopped: ${reason}`, { countAttempt: reason !== "pause" && reason !== "shutdown" });
  }

  /**
   * M1: When a Run fails AFTER completing external/state write side effects, never blindly re-deliver the raw original
   * batch. Acknowledge the consumed batch and enqueue a compact recovery prompt listing already-executed writes.
   */
  function recoverAfterWrites(handle: RunHandle, batch: ClaimedBatch, cleanError: string, executedWrites: string[]): void {
    const cellId = handle.cellId;
    const prev = batch.envelopes.reduce(
      (n, e) => (e.type === PAYLOAD.runContinue && (e.payload as RunContinuePayload).reason === "error_recovery" ? Math.max(n, (e.payload as RunContinuePayload).count) : n),
      0,
    );
    const maxRecoveries = Math.max(1, Math.min(4, core.maxStepContinuations || 4));
    inbox.completeSync(handle.claimId, () => {
      const inputs = inbox.listMessagesSync({ claimId: handle.claimId, status: ["done"] }).map((row) => row.envelope);
      const cur = cells.get(cellId);
      if (!cur || cur.status === "closed" || cur.epoch !== handle.epoch) return;
      if (handle.cliInput) {
        const session = context.readStateSync<CliSessionRecord>(cellId, CLI_SESSION_KEY);
        if (session?.sessionId === handle.cliInput.sessionId) {
          context.commitSync(cellId, {
            statePatches: {
              [CLI_SESSION_KEY]: { ...session, lastDeliveredEvidenceSeq: Math.max(session.lastDeliveredEvidenceSeq, handle.cliInput.throughSeq) },
            },
          });
        }
      }
      core.waits.answeredBy(cellId, inputs, handle.claimId);
      if (prev >= maxRecoveries) {
        core.escalations.errorRecoveryLimit(cellId, prev + 1, cleanError, executedWrites);
        core.stall.afterRun(cellId, inputs);
        return;
      }
      const delay = Math.min(core.maxRetryBackoffMs, core.retryBackoffMs * 2 ** prev);
      const payload: RunContinuePayload = {
        reason: "error_recovery",
        count: prev + 1,
        error: cleanError.slice(0, 600),
        executedWrites,
        originalEnvelopeIds: batch.envelopes.map((e) => e.id).slice(0, 20),
      };
      inbox.enqueueSync(
        cellId,
        createEnvelope<RunContinuePayload>(
          {
            id: `${handle.claimId}:error_recovery`,
            from: KERNEL_FROM.dispatcher,
            principalId: cellPrincipal(cellId),
            kind: "event",
            type: PAYLOAD.runContinue,
            payload,
            expectedEpoch: handle.epoch,
          },
          clock,
        ),
        { deliverAt: clock.now() + delay },
      );
      core.stall.afterRun(cellId, inputs);
    });
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
    // Its last words, and the accounts it had ended on when somebody then spoke to it: what it says after that answers
    // the newcomer. An account is text it stopped at (no tool call since) — words on the way to its next step are not,
    // and neither is what it says before its own machinery (a job's result, a timer) wakes it again. The range can span
    // more than one Run (one that ended in a wait settles nothing); only the last Run's words count.
    let said: string | null = null;
    let account: string | null = null;
    let before: string[] = [];
    let prevAccount: string | null = null;
    let prevBefore: string[] = [];
    let atRunStart = false;
    const artifactIds = new Set<string>();
    for (const { record: r } of records) {
      if (r.kind === "run_boundary" && r.phase === "start") {
        prevAccount = account;
        prevBefore = before;
        atRunStart = true;
        said = account = null;
        before = [];
        continue;
      }
      if (atRunStart && r.kind !== "inbound") {
        atRunStart = false;
        prevAccount = null;
        prevBefore = [];
      }
      if (r.kind === "assistant_text" && r.text.trim()) said = account = r.text.trim();
      const spokenTo = r.kind === "inbound" ? SPOKEN.has(r.envelope.type) : r.kind === "system_note" && STEER_NOTE_HEAD.test(r.text);
      if (atRunStart && spokenTo) {
        before = prevBefore;
        if (prevAccount) before.push(prevAccount);
        prevAccount = null;
        prevBefore = [];
        atRunStart = false;
      } else if (spokenTo && account) {
        before.push(account);
        said = account = null;
      }
      if (r.kind !== "tool_call") continue;
      steps++;
      const rep = r.name === "report_to_parent" ? (r.input as { kind?: unknown; text?: unknown } | null) : null;
      if (rep?.kind === "result" && typeof rep.text === "string" && rep.text.trim()) {
        said = account = rep.text.trim();
      } else {
        account = null;
      }
      // Artifacts it wrote through the kernel tools, whoever created them first.
      const id = (r.input as { artifactId?: unknown } | null)?.artifactId;
      if ((r.name === "save_artifact" || r.name === "patch_artifact") && typeof id === "string") artifactIds.add(id);
    }
    said ??= before.pop() ?? null;
    const saidBefore = before.join("\n\n");
    // Its own artifacts that it wrote a version of since its last settled turn — not ones somebody else changed
    // meanwhile (a hub marking the worker's old report as superseded while the worker was closed).
    for (const a of all<{ artifact_id: string }>(core.db, "SELECT DISTINCT artifact_id FROM artifact_versions WHERE cell_id = ? AND created_at >= ?", [cellId, prev?.settledAt ?? 0])) artifactIds.add(a.artifact_id);
    if (cand?.artifactId) artifactIds.add(cand.artifactId);
    const directChats = chat?.unsettled ?? 0;
    const parent = cell.parentId ? cells.get(cell.parentId) : undefined;
    const messagesToParent = !parent ? 0 : get<{ n: number }>(
      core.db,
      "SELECT count(*) AS n FROM inbox_messages WHERE cell_id = ? AND seq > ? AND type = ? AND json_extract(envelope, '$.from') = ?",
      [parent.id, prev?.inboxSeq ?? 0, PAYLOAD.cellMessage, inboxAddr(cellId)],
    )!.n;
    const turn: SettledTurn = {
      runId: handle.claimId,
      fromSeq,
      toSeq,
      hadDirectUserChat: directChats > 0,
      directChats,
      artifactIds: [...artifactIds],
      steps,
      outcome: how.failed !== undefined ? how.outcome : cand?.status === "failed" ? "failed" : how.outcome,
      // The summary below is the worker's last words unless it reported a structured result: only then is there
      // something more to preview.
      preview: said && cand?.summary && said !== cand.summary ? (said.length > 600 ? `${said.slice(0, 600)}…` : said) : null,
      ...(messagesToParent ? { messagesToParent } : {}),
    };
    if (parent && parent.status !== "closed") {
      const payload: CellResultPayload = {
        childCellId: cellId,
        status: how.failed !== undefined ? "failed" : (cand?.status ?? "completed"),
        summary: how.failed ?? cand?.summary ?? (said ? said.slice(0, 4_000) : "Its turn ended without a word; inspect_cell shows what it did."),
        ...(cand?.artifactId ? { artifactId: cand.artifactId } : {}),
        ...(cand?.data !== undefined ? { data: cand.data } : {}),
        childState: "dormant",
        // (A structured report, or a failure, is the account itself.)
        ...(saidBefore && how.failed === undefined && !cand?.summary ? { saidBefore: saidBefore.slice(0, 4_000) } : {}),
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
    // A self-cancelled job's silent_inject receipt has no wakeup behind it once this leaf settles into dormancy.
    run(
      core.db,
      "UPDATE inbox_messages SET status = 'done', status_reason = 'settled with turn', updated_at = ? WHERE cell_id = ? AND status = 'pending' AND delivery = 'silent_inject' AND type = ? AND deliver_at <= ?",
      [now, cellId, PAYLOAD.jobResult, now],
    );
    context.commitSync(cellId, {
      statePatches: {
        [CELL_TURN_KEY]: {
          settledSeq: toSeq,
          settledAt: now,
          notices: (prev?.notices ?? 0) + 1,
          inboxSeq: get<{ n: number }>(core.db, "SELECT coalesce(max(seq), 0) AS n FROM inbox_messages")!.n,
        } satisfies CellTurnState,
        // Delivered: the next turn reports for itself.
        [CELL_RESULT_CANDIDATE_KEY]: null,
        ...(!cand && said && context.readStateSync(cellId, CELL_STATUS_KEY) !== null
          ? { [CELL_STATUS_KEY]: { text: said.replace(/\s+/g, " ").trim().length > 200 ? `${said.replace(/\s+/g, " ").trim().slice(0, 199)}…` : said.replace(/\s+/g, " ").trim(), updatedAt: now } }
          : {}),
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
    inbox.completeSync(handle.claimId, pauseSelf => {
      const inputs = inbox.listMessagesSync({ claimId: handle.claimId, status: ["done"] }).map(row => row.envelope);
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

      if (result === "step_limit" || result === "timeout") {
        const prev = batch.envelopes.reduce((n, e) => (e.type === PAYLOAD.runContinue ? Math.max(n, (e.payload as RunContinuePayload).count) : n), 0);
        if (prev >= core.maxStepContinuations) {
          core.escalations.stepLimit(cellId, prev + 1);
          core.stall.afterRun(cellId, inputs);
          return;
        }
        const payload: RunContinuePayload = { reason: result, count: prev + 1 };
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

      const leaf = isLeafLifetime(cur.spec.lifetime) && cur.parentId !== null;
      const oneShot = leaf && cur.spec.lifetime === "one_shot";
      if (result === "refused") {
        if (leaf && inbox.pendingWakeupCountSync(cellId) > 0) return;
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
      // Safety net: if a cell finishes a turn while holding a card in `revising` and has no further background work
      // in flight (no pending wakeups, running jobs, non-human waits, or active project subtree work), bring the card
      // back to `pending` so it is never stranded hidden from the owner.
      if ((result === "completed" || result === "yielded_waiting") && !self) {
        const hasPendingWakeup = inbox.pendingWakeupCountSync(cellId) > 0 || inbox.activeClaimCountSync(cellId, handle.claimId) > 0;
        if (!hasPendingWakeup && core.humanItems.hasRevising(cellId)) {
          const waits = core.waits.list([cellId]);
          const hasNonHumanWait = waits.some((w) => w.waitingFor !== WAIT_HUMAN);
          const hasHumanWait = waits.some((w) => w.waitingFor === WAIT_HUMAN);
          const hasJobs = core.workspace.listJobsSync({ cellId, state: ["running"] }).length > 0;
          const projectBusy = isProjectRoot(core.registry, cur)
            ? (() => {
                const a = core.readModel.anchorsOf(cellId);
                return a.agent || a.internal || (!hasHumanWait && a.external);
              })()
            : false;
          if (!hasNonHumanWait && !hasJobs && !projectBusy) {
            core.humanItems.reopenRevising(cellId);
          }
        }
      }
      // A wakeable leaf that ended its turn "waiting" may have arranged nothing to wait for (a bare `wait`): whether
      // its turn is over is decided below by what is actually out, not by how the Run was labelled.
      const restingLeaf = leaf && !oneShot && result === "yielded_waiting";
      const currentCandidate = leaf && candidateOf(handle);
      const reported = oneShot && result === "yielded_waiting" && currentCandidate;
      if ((result !== "completed" && !self && !restingLeaf && !reported) || (!leaf && !self)) {
        if (!leaf && (result === "completed" || result === "yielded_waiting")) {
          const chat = context.readStateSync<CellDirectChatState>(cellId, CELL_DIRECT_CHAT_KEY);
          if (chat && chat.unsettled > 0) {
            context.commitSync(cellId, { statePatches: { [CELL_DIRECT_CHAT_KEY]: { ...chat, unsettled: 0 } satisfies CellDirectChatState } });
          }
        }
        if (result !== "cancelled") core.stall.afterRun(cellId, inputs);
        return;
      }
      // Drain first: something that would wake the cell is waiting, so it is not done.
      if (inbox.pendingWakeupCountSync(cellId) > 0 || inbox.activeClaimCountSync(cellId, handle.claimId) > 0) {
        // A cell that asked to close or park must not go on believing it did (nor was the owner told that it had).
        if (self) {
          context.appendEvidenceSync(cellId, {
            kind: "system_note",
            runId: handle.claimId,
            at: clock.now(),
            text: notCarriedOut(self.action, `${MESSAGE_ARRIVED}, so nothing was closed and the owner was not told that it ended. Deal with what arrived first; then ask again if it is still right.`),
          });
        }
        return;
      }
      if (leaf && !oneShot && currentCandidate) {
        for (const wait of core.waits.list([cellId])) core.waits.clear(cellId, wait.waitId);
      }
      if (oneShot && !self && !currentCandidate &&
          core.readModel.activityOf([cellId]).get(cellId)?.state !== "dormant") {
        core.stall.afterRun(cellId, inputs);
        return;
      }
      if (!self && !oneShot) {
        // A wakeable leaf. Its turn is over only when nothing of it is still out — no wait it registered, no Job, no
        // card with the owner, no timer or watch it set for itself: exactly when it is dormant (this Run has already
        // left the run table and its claim is completed, so the read model sees the cell as it will be).
        if (core.readModel.activityOf([cellId]).get(cellId)?.state !== "dormant") {
          forwardOrphanReplyIfNeeded(cur, handle, inputs);
          core.stall.afterRun(cellId, inputs);
          return;
        }
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
            text: notCarriedOut(self.action, `${open.length} child cell(s) were still at work when the run settled (${open.map((c) => c.id).join(", ")}). Call complete_self again once they are done or closed.`),
          });
        }
        return;
      }
      if (self?.action === "complete") {
        const pending = core.readModel.pendingSettlement(cellId, self.force);
        if (pending.length) {
          context.appendEvidenceSync(cellId, {kind: "system_note", runId: handle.claimId, at: clock.now(),
            text: `Project remains open. Unfinished work: ${pending.join(", ")}`});
          return;
        }
      }
      if (self?.statePatches) context.commitSync(cellId, { statePatches: self.statePatches });
      const tellOwner = () => {
        if (self?.ownerNotice) core.hub.notifyOwner({ cellId, content: { format: "text", body: self.ownerNotice.body }, idempotencyKey: self.ownerNotice.key });
      };
      if (self?.action === "pause") {
        if (cur.status === "active" && pauseSelf(self.pauseReason).applied) {
          recordPaused(core, cellId, { by: cellPrincipal(cellId), ...(self.pauseReason ? { reason: self.pauseReason } : {}), ...(self.summary ? { note: self.summary } : {}) });
          tellOwner();
        }
        return;
      }
      tellOwner();
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

  /**
   * M6: Orphan-reply safeguard for wakeable workers. If a worker consumed a non-silent parent `cell.message`,
   * produced non-empty `assistant_text`, sent no reply to its parent, and did not settle into dormancy (so
   * `notifySettled` did not fire — e.g. an older open wait kept it in `waiting`), relay its answer to the parent
   * so parent and child never deadlock waiting on each other.
   */
  function forwardOrphanReplyIfNeeded(cur: CellRecord, handle: RunHandle, inputs: readonly Envelope[]): void {
    const parent = cur.parentId ? cells.get(cur.parentId) : undefined;
    if (!parent || parent.status === "closed") return;
    const parentAddr = inboxAddr(parent.id);
    const parentPrincipal = cellPrincipal(parent.id);
    const parentQuestions = inputs.filter(
      (e) =>
        e.type === PAYLOAD.cellMessage &&
        e.delivery !== "silent_inject" &&
        (e.from === parentAddr || e.principalId === parentPrincipal),
    );
    if (parentQuestions.length === 0) return;
    const said = lastWords(cur.id, handle.claimId);
    if (!said) return;
    const runRecords = context.listEvidenceSync(cur.id, { runId: handle.claimId });
    let sentToParent = false;
    let startedAsyncWork = false;
    for (const { record: r } of runRecords) {
      if (r.kind !== "tool_call") continue;
      if (r.name === "report_to_parent") sentToParent = true;
      if (r.name === "send_message") {
        const to = (r.input as { to?: unknown } | null)?.to;
        if (to === parentAddr) sentToParent = true;
        else if (typeof to === "string" && to.startsWith("inbox:")) startedAsyncWork = true;
      }
      if (r.name === "job_start" || r.name === "request_approval") startedAsyncWork = true;
    }
    if (sentToParent) return;
    const parentWaitingOnChild = core.waits.list([parent.id]).some((w) => w.waitingFor === inboxAddr(cur.id));
    if (!parentWaitingOnChild && startedAsyncWork) return;
    const lastQ = parentQuestions[parentQuestions.length - 1]!;
    const qPayload = lastQ.payload as { refId?: unknown; waitId?: unknown } | null;
    const refId =
      typeof qPayload?.refId === "string" && qPayload.refId.trim()
        ? qPayload.refId.trim()
        : typeof qPayload?.waitId === "string" && qPayload.waitId.trim()
          ? qPayload.waitId.trim()
          : undefined;
    inbox.enqueueSync(
      parent.id,
      createEnvelope(
        {
          id: `${cur.id}:${handle.claimId}:orphan_reply`,
          from: inboxAddr(cur.id),
          to: parentAddr,
          principalId: cellPrincipal(cur.id),
          kind: "event",
          type: PAYLOAD.cellMessage,
          expectedEpoch: parent.epoch,
          payload: {
            fromCellId: cur.id,
            summary: "分身回合答复（自动抄送）",
            text: said.slice(0, 4_000),
            ...(refId ? { refId } : {}),
          },
        },
        clock,
      ),
    );
  }

  /** Give the batch back or settle it, according to how the Run ended. */
  function settleClaim(handle: RunHandle, batch: ClaimedBatch, result: RunResult, error: string | undefined): void {
    try {
      if (result === "error") {
        const cleanError = stripAnsi(error ?? "unknown error");
        const writes = executedWritesOf(handle.cellId, handle.claimId);
        if (writes.length > 0) recoverAfterWrites(handle, batch, cleanError, writes);
        else releaseClaim(handle, "error", cleanError);
      } else if (result === "cancelled" && handle.controller.signal.aborted) releaseClaim(handle, "cancelled", undefined);
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

    const isCodeProcessor = cell.spec.processor.kind === "code";
    const skipHydrate = isCodeProcessor && cell.spec.contextMode !== "fork_prefix";
    const isRoutineCodeProbe =
      cell.spec.processor.kind === "code" &&
      cell.spec.processor.entry === "gtd.check_probe" &&
      batch.envelopes.every((e) => e.type === PAYLOAD.timerFired);
    const signal = handle.controller.signal;
    try {
      if (stale(handle)) {
        handle.stopReason ??= cells.get(cellId)?.status === "paused" ? "pause" : "close";
        handle.controller.abort(new Error("cell paused, closed or cancelled before the run started"));
      }
      signal.throwIfAborted();
      // M5: Pure code processors (non-fork_prefix) do not consume LLM context; skip context.hydrate() so they never scan history or trigger compaction.
      let snapshot: PromptSnapshot = skipHydrate
        ? {
            cellId,
            epoch: handle.epoch,
            runId,
            spec: cell.spec,
            bounds: cell.bounds,
            mode: cell.spec.contextMode ?? "isolated",
            batch,
            system: { text: "", hash: "" },
            history: [],
            historyUptoSeq: 0,
            tail: { roster: [], notes: [], messages: [] },
            skills: [],
            createdAt: clock.now(),
          }
        : await context.hydrate(cellId, batch, cell.spec.contextMode ?? "isolated");
      signal.throwIfAborted();
      const at = clock.now();
      if (!isRoutineCodeProbe) {
        context.appendEvidenceSync(cellId, { kind: "run_boundary", phase: "start", epoch: handle.epoch, runId, at });
        for (const envelope of batch.envelopes) context.appendEvidenceSync(cellId, { kind: "inbound", envelope, runId, at });
      }
      ranLoop = true;
      const ports = buildRunPorts(core, { cell, batch, handle, snapshot });
      const preset = cell.preset ? core.registry.presets.get(cell.preset) : undefined;
      const prepare = preset?.prepareRun;
      let handled = false;
      if (prepare) {
        const books = preset?.actionBooks?.(core, cellId);
        const openBefore = new Set((books?.list() ?? []).filter((a) => a.status === "open").map((a) => a.id));
        let said: string[] = [];
        try {
          const r = await prepare({ snapshot, ports, signal, clock });
          handled = r === "handled";
          if (r && typeof r === "object") said = r.notes;
        } catch (err) {
          if (signal.aborted) throw err;
          // The Loop still runs: a model that calls the preset's tools retries the same bookkeeping.
          core.onError(err, `prepareRun of ${cellId}`);
        }
        signal.throwIfAborted();
        if (!handled) {
          // The notes were read before the bookkeeping ran; the model must see the records as they are now — and be
          // told what was closed on its behalf, so it neither closes it again nor takes a wrong closing for granted.
          const closed = (books?.list() ?? []).filter((a) => openBefore.has(a.id) && a.status === "done");
          const note = closed.length
            ? `[actions closed for you at this wake-up — the turn of the cell carrying each ended as completed. If its report says the work is not actually done, reopen it: track_action with status "open"]\n${closed.map((a) => `- ${a.id} "${a.title}"${a.cellId ? ` (cell ${a.cellId})` : ""}`).join("\n")}`
            : null;
          snapshot = context.refreshTailSync(snapshot, [...(note ? [note] : []), ...said]);
        }
      }
      result = handled ? "completed" : await core.loop.run(snapshot, ports, signal);
    } catch (err) {
      if (signal.aborted) result = "cancelled";
      else {
        result = "error";
        error = err instanceof Error ? err.message : String(err);
      }
    }

    if (ranLoop && (!isRoutineCodeProbe || result === "error")) {
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
    holdUntilSettled(root, cellIds) {
      for (const id of cellIds) resumeHolds.set(id, { root, after: launchSeq });
    },
    running: () => [...runs.values()].map((h) => ({ cellId: h.cellId, cwd: h.cwd, stallOnly: h.stallOnly })),
  };
}
