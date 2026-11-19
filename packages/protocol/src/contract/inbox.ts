import type { Envelope } from "./envelope";

// docs/02 §二 — ② Inbox, verbatim (comments translated). Extensions follow the `[ext]` marker.

// ==================== ② Inbox: SQLite queue, delayed/scheduled wakeups and a real-time control bypass ====================
export interface ScheduleRule {
  deliverAt?: number;                   // one-shot delayed delivery timestamp (a column on the queue row, no separate one-shot alarm table)
  cron?: string;                        // periodic trigger (e.g. a sensor polling a source)
  idleSec?: number;                     // fire when this Cell has been idle for N seconds (background housekeeping)
  cancelGroup?: string;                 // linked-cancel group (e.g. clear pending timeout nudges when the other side replies early)
  tz?: string;                          // [ext] IANA timezone for `cron` (default: process local time)
  /**
   * [ext] docs/05 §3.3 — fixed (tumbling) batching window, keyed. Exclusive with deliverAt/cron/idleSec. At enqueue:
   * the cell has an active claim → deliver now (the running Loop absorbs it); otherwise, if a pending wakeup row of the
   * same cell with `cancel_group = key` is not yet due, reuse *its* deliver_at (the window's fixed right edge: never
   * extended by later arrivals, never borrowed from another key or an ordinary timer); else deliver_at = now + windowMs.
   * The row's cancel_group is `key` (convention `coalesce:<watchId>`).
   */
  coalesce?: { key: string; windowMs: number };
}

export interface Inbox {
  enqueue(cellId: string, env: Envelope, schedule?: ScheduleRule): Promise<"accepted" | "deduped">;
  cancelScheduled(scope: { cellId: string; cancelGroup?: string; envelopeId?: string }): Promise<void>;
  claimNextRun(cellId: string, workerId: string, mode: "serial_coalesce" | "competing_workers", leaseMs?: number): Promise<ClaimedBatch | null>;
  complete(claimId: string): Promise<void>;
  handback(claimId: string, envelopeId: string, reason: string): Promise<void>; // hand an off-topic new item back to the desk for re-triage
  // independent control bypass: skips the normal queue lock, authorized via Gate, immediately interrupts the in-flight Run/Job (cancel atomically advances the Cell epoch)
  control(cellId: string, cmd: {
    action: "cancel" | "pause" | "resume" | "steer";
    principalId: string;
    steerMessage?: string;
  }): Promise<{ applied: boolean; epoch: number }>;

  // [ext] enqueue semantics:
  //   - stores the envelope with `to = inbox:<cellId>`; same (cellId, env.id) again → "deduped" (nothing changes).
  //   - unregistered type or payload failing validatePayload → stored as `quarantined` (still "accepted").
  //   - env.expectedEpoch set and ≠ the cell's current epoch → stored as `dropped_epoch`; closed cell → `cancelled`.
  //   - schedule: at most one of deliverAt | cron | idleSec. deliverAt → the row's deliver_at; cron/idleSec → an
  //     inbox_schedules row (the envelope is the template; firings get id `${env.id}@${fireAt}`).
  //     idleSec fires once the cell has had no live claim, no due pending message and no finished Run for N seconds
  //     (counted from the rule's creation or the end of the last Run), then stays disarmed until the next Run that
  //     processed something other than idle firings ends. cancelGroup tags the row/schedule.
  //     A schedule template whose payload fails validation throws NgError("invalid_argument") (never quarantined).
  //     Re-enqueueing the template id of a *deactivated* schedule replaces and re-activates it ("accepted").
  //   - unknown cellId → throws NgError("not_found").
  // [ext] cancelScheduled: cancels the cell's `pending` messages (due or future) and deactivates its schedules that
  //   match every given filter (cancelGroup, envelopeId = message id or schedule template id); pending firings of a
  //   deactivated schedule are cancelled with it. With no filter: everything pending + every schedule of the cell.
  // [ext] handback: marks the message `handed_back` and enqueues a `handback` envelope (HandbackPayload) to the desk
  //   (`inbox:desk` if that cell exists, else the root of the cell's tree, unless configured), id
  //   `${envelopeId}#handback#${cellId}`, from `kernel:handback`, principalId = the original sender's.

  // ---------- [ext] sync twins (same semantics; the async methods delegate to these) ----------
  enqueueSync(cellId: string, env: Envelope, schedule?: ScheduleRule): EnqueueResult;
  /** Returns how many pending messages + schedules were cancelled. */
  cancelScheduledSync(scope: CancelScope): number;
  claimNextRunSync(cellId: string, workerId: string, mode: ClaimMode, leaseMs?: number): ClaimedBatch | null;
  completeSync(claimId: string): void;
  handbackSync(claimId: string, envelopeId: string, reason: string): void;
  controlSync(cellId: string, cmd: ControlCommand): ControlResult;

  // ---------- [ext] sync-only operations ----------
  /** Extend an active claim's lease (long Runs heartbeat). Returns false if the claim is no longer active. */
  renewLeaseSync(claimId: string, leaseMs: number): boolean;
  /**
   * Give a claim back without completing it (Run crashed/aborted): its messages return to `pending` with attempts+1
   * (not claimable before `opts.retryAt` when given), or `dead` past the retry limit. If the cell's epoch moved since
   * the claim (control cancel), they become `cancelled` instead. No-op for a claim that is no longer active.
   */
  releaseSync(claimId: string, reason: string, opts?: ReleaseOptions): void;
  /**
   * Take the `control.steer` messages that arrived for this cell since the Run started (marks them done, attached to
   * the active claim). Returns [] when the cell has no active claim, so an idle cell's steer still wakes it normally.
   */
  drainSteerSync(cellId: string): string[];
  /**
   * [ext] docs/05 §3.3 — move this cell's due pending messages (wakeup and silent_inject, any type but `control.steer`)
   * into the active serial claim `claimId`: status → claimed, claim_id set, same expected-epoch drop rule as a claim.
   * Returns them in seq order with their seqs. [] when the claim is no longer active (nothing is taken) or nothing is
   * due. Because the rows belong to the claim, `handbackSync` works on them and `releaseSync` gives them back.
   */
  drainInboundSync(cellId: string, claimId: string): Array<{ envelope: Envelope; seq: number }>;
  /**
   * [ext] docs/05 guard 1 — how many messages would wake this cell: pending `wakeup` rows that are due now, plus
   * not-yet-due ones that are not the cell's own timers (`timer.fired`) — e.g. a follow-up still inside a coalescing
   * window. `silent_inject` rows never count, and neither do the kernel's own notices `kernel.stalled_check` and
   * `kernel.wait_timeout` (they are not work for the cell to finish).
   */
  pendingWakeupCountSync(cellId: string): number;
  /** [ext] Active claims of the cell, optionally excluding one (the settling Run's own). */
  activeClaimCountSync(cellId: string, exceptClaimId?: string): number;
  /**
   * Advance time-driven state as of `clock.now()`: expire leases, fire due cron/idleSec schedules into messages,
   * and emit `inbox.enqueued {reason:"due"}` for cells whose delayed messages just became due (`"released"` for cells
   * whose expired claims returned work). Missed cron occurrences coalesce into one firing.
   */
  tickSync(): TickReport;
  /** Earliest instant at which `tickSync` would do something (null = nothing scheduled; ≤ now = a tick is overdue). */
  nextWakeAtSync(): number | null;
  /** Start/stop the real-time timer that calls `tickSync` at `nextWakeAtSync()`. Tests drive `tickSync` with a ManualClock instead. */
  start(): void;
  stop(): void;

  listMessagesSync(filter?: InboxMessageFilter): InboxMessageRecord[];
  listSchedulesSync(filter?: { cellId?: string; activeOnly?: boolean }): InboxScheduleRecord[];
  /** Count of due-or-future pending messages per cell (UI badges, idle detection). */
  pendingCountsSync(cellIds?: readonly string[]): Record<string, number>;
  /** Cells that are claimable right now (active, a due pending wakeup message, no active serial claim) — dispatcher startup scan. */
  dueCellIdsSync(): string[];
}

// ==================== [ext] types ====================

// Spelled out (not derived from `Inbox[...]`) so the interface above can reference them without a cycle.
export type EnqueueResult = "accepted" | "deduped";
export type ClaimMode = "serial_coalesce" | "competing_workers";
export interface CancelScope {
  cellId: string;
  cancelGroup?: string;
  envelopeId?: string;
}
export type ControlAction = "cancel" | "pause" | "resume" | "steer";
export interface ControlCommand {
  action: ControlAction;
  principalId: string;
  steerMessage?: string;
  /**
   * [ext] steer only: the id the steer message is stored under (default: a new one). A caller that retries with the
   * same id does not deliver the steer twice, and whoever shows the conversation can match the stored message to
   * what was typed.
   */
  steerEnvelopeId?: string;
}
/**
 * Queue-side effects of `control` (the kernel does the rest when it sees the `inbox.control` bus event):
 * - cancel: for the cell and every non-closed descendant: epoch += 1 (via cellsRepo.bumpEpoch), pending messages +
 *   schedules → cancelled. Kernel then aborts the Runs, cancels Jobs and closes the cell subtree. A claim taken
 *   before the cancel can still be completed; if it is released or its lease expires, its messages are cancelled.
 * - pause: the cell and its non-closed descendants → paused (not claimable); resume: the cell and its paused
 *   descendants → active, emitting `inbox.enqueued {reason:"resumed"}` for those with due work.
 * - steer: enqueues a wakeup `control.steer` envelope (expectedEpoch = current epoch) to the cell only; a running Loop
 *   drains it via `drainSteer()`, otherwise it is simply the next batch.
 * `inbox.control` is emitted once per affected cell (target first, each with its own epoch).
 * `applied:false` + `reason` when the authorizer refuses or the cell is closed/unknown (unknown: epoch -1).
 */
export interface ControlResult {
  applied: boolean;
  epoch: number;
  reason?: string;
}

/**
 * A leased batch of inbox messages = exactly one Run. The Run's id is the claim id
 * (`PromptSnapshot.runId === batch.claimId`).
 *
 * - `serial_coalesce`: at most one active claim per cell; the batch holds every due pending message of the cell
 *   (wakeup and silent_inject), in seq order. A cell with only silent_inject messages is not claimable.
 * - `competing_workers`: several claims may be active for one cell; each batch holds exactly one wakeup message.
 * - Messages whose `expectedEpoch` differs from the cell's current epoch are marked `dropped_epoch` at claim time
 *   and never appear in a batch. Paused/closed cells are not claimable.
 */
export interface ClaimedBatch {
  claimId: string;
  cellId: string;
  epoch: number;                        // cell epoch at claim time
  workerId: string;
  mode: ClaimMode;
  envelopes: Envelope[];                // seq order
  seqs: number[];                       // inbox_messages.seq of each envelope, same order
  claimedAt: number;
  leaseExpiresAt: number;
}

export type InboxMessageStatus =
  | "pending"
  | "claimed"
  | "done"
  | "cancelled"
  | "dropped_epoch"
  | "quarantined"   // unknown payload type or payload failing its schema (stored, never delivered)
  | "handed_back"
  | "dead";         // exceeded the retry limit after repeated releases/lease expiries

export interface InboxMessageRecord {
  seq: number;
  cellId: string;
  envelope: Envelope;
  status: InboxMessageStatus;
  deliverAt: number;
  cancelGroup: string | null;
  scheduleId: string | null;
  expectedEpoch: number | null;
  claimId: string | null;
  attempts: number;
  statusReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface InboxMessageFilter {
  cellId?: string;
  status?: readonly InboxMessageStatus[];
  type?: string;
  cancelGroup?: string;
  limit?: number;
  envelopeId?: string;                  // [ext]
  claimId?: string;                     // [ext] messages taken by this claim
  deliverAfter?: number;                // [ext] deliver_at > this (e.g. clock.now() → scheduled future rows)
}

/** [ext] Options of `releaseSync`. */
export interface ReleaseOptions {
  retryAt?: number;                     // released messages are not claimable before this instant
}

/**
 * A recurring rule created by `enqueue(cellId, template, { cron | idleSec })`. Each firing inserts a message whose
 * envelope is the template with id `${template.id}@${fireAt}` (deterministic, so a double tick cannot double-fire).
 * Re-enqueueing the same template id for the same cell returns "deduped".
 */
export interface InboxScheduleRecord {
  id: string;
  cellId: string;
  template: Envelope;
  cron: string | null;
  idleSec: number | null;
  tz: string | null;
  cancelGroup: string | null;
  expectedEpoch: number | null;
  nextFireAt: number | null;
  lastFiredAt: number | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TickReport {
  fired: number;                        // schedule firings inserted as messages
  dueCellIds: string[];                 // cells this tick gave claimable work (firings, delayed rows that came due, expired claims) and that are claimable now
  expiredClaims: number;
}

// ==================== [ext] injection interfaces (so other primitives never import @ng/inbox) ====================

/**
 * Same-database enqueue used inside other primitives' transactions:
 * Context.commit (`inboxOut`), Workspace (job results). Implemented by `Inbox.enqueueSync`.
 */
export interface InboxWriter {
  enqueueSync(cellId: string, env: Envelope, schedule?: ScheduleRule): EnqueueResult;
}

/**
 * Decides whether `principalId` may apply a control action to `cellId`. Injected into the Inbox
 * (wired to `Gate.authorizeControlSync`) so the control bypass is "authorized via Gate" without a package dependency.
 */
export type ControlAuthorizer = (
  cellId: string,
  principalId: string,
  action: ControlAction,
) => { ok: true } | { ok: false; reason: string };
