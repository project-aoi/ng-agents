import {
  afterCommit,
  all,
  cellsRepo,
  createEnvelope,
  DESK_CELL_ID,
  fromJson,
  get,
  inboxAddr,
  inTransaction,
  KERNEL_FROM,
  newId,
  NgError,
  OWNER_PRINCIPAL,
  parsePrincipal,
  PAYLOAD,
  run,
  systemClock,
  toBool,
  toJson,
  validatePayload,
  withTx,
  type BusTopics,
  type CancelScope,
  type CellRecord,
  type CellsRepo,
  type ClaimedBatch,
  type ClaimMode,
  type ControlAuthorizer,
  type ControlCommand,
  type ControlResult,
  type ControlSteerPayload,
  type EnqueueResult,
  type Envelope,
  type HandbackPayload,
  type InboxMessageFilter,
  type InboxMessageRecord,
  type InboxMessageStatus,
  type InboxScheduleRecord,
  type ScheduleRule,
  type SqlParam,
  type TickReport,
} from "@ng/protocol";
import { nextCronAt } from "./cron";
import { toClaim, toMessage, toSchedule, type ClaimRow, type MessageRow, type ScheduleRow } from "./rows";
import type {
  ControlEvent,
  ControlListener,
  InboxClaimRecord,
  InboxClaimStatus,
  InboxOptions,
  InboxReleaseOptions,
  InboxService,
  ReleaseResult,
} from "./types";

type EnqueuedReason = BusTopics["inbox.enqueued"]["reason"];

type Rule =
  | { kind: "now"; cancelGroup: string | null }
  | { kind: "at"; deliverAt: number; cancelGroup: string | null }
  | { kind: "coalesce"; key: string; windowMs: number }
  | { kind: "cron"; cron: string; tz: string | null; cancelGroup: string | null }
  | { kind: "idle"; idleSec: number; cancelGroup: string | null };

interface InsertOpts {
  deliverAt: number;
  cancelGroup: string | null;
  scheduleId: string | null;
  /** Emit `inbox.enqueued` with this reason when the row is claimable work right away; null = the caller announces. */
  announce: EnqueuedReason | null;
}

interface InsertResult {
  result: EnqueueResult;
  status?: InboxMessageStatus;
  seq?: number;
}

interface FireResult {
  fired: boolean;                       // a firing message was inserted
  wakes: boolean;                       // ...and it is a pending wakeup (makes the cell due)
}

const CONTROL_ACTIONS = new Set(["cancel", "pause", "resume", "steer"]);

/** Wall-over-monotonic advance above this is a host suspend; below it, timer jitter and clock slewing. */
const SUSPEND_SKEW_MS = 5_000;

// "Real work" = anything except idle firings. Idle firings must not count as activity, otherwise an idle rule
// would re-arm itself through its own Run and fire every idleSec forever (and two idle rules would ping-pong).
const SQL_CLAIM_HAD_REAL_WORK = `SELECT 1 AS x FROM inbox_messages m LEFT JOIN inbox_schedules s ON s.id = m.schedule_id
  WHERE m.claim_id = ? AND s.idle_sec IS NULL LIMIT 1`;
const SQL_LIVE_REAL_CLAIM = `SELECT 1 AS x FROM inbox_claims k
  JOIN inbox_messages m ON m.claim_id = k.claim_id
  LEFT JOIN inbox_schedules s ON s.id = m.schedule_id
  WHERE k.cell_id = ? AND k.status = 'active' AND s.idle_sec IS NULL LIMIT 1`;
const SQL_DUE_REAL_WORK = `SELECT 1 AS x FROM inbox_messages m LEFT JOIN inbox_schedules s ON s.id = m.schedule_id
  WHERE m.cell_id = ? AND m.status = 'pending' AND m.delivery = 'wakeup' AND m.deliver_at <= ?
    AND (m.expected_epoch IS NULL OR m.expected_epoch = ?) AND s.idle_sec IS NULL LIMIT 1`;
const SQL_DUE_WAKEUP = `SELECT 1 AS x FROM inbox_messages
  WHERE cell_id = ? AND status = 'pending' AND delivery = 'wakeup' AND deliver_at <= ?
    AND (expected_epoch IS NULL OR expected_epoch = ?) LIMIT 1`;
// Serial: every due pending row (wakeup and silent_inject) in one batch. Stale-epoch rows were dropped just before.
const SQL_TAKE_SERIAL = `UPDATE inbox_messages SET status = 'claimed', claim_id = ?, updated_at = ?
  WHERE cell_id = ? AND status = 'pending' AND deliver_at <= ?
  RETURNING seq, envelope`;
// Mid-run absorption (drainInboundSync): like a serial claim, but steer messages keep their own channel (drainSteerSync).
const SQL_DUE_INBOUND_WAKEUP = `SELECT 1 AS x FROM inbox_messages
  WHERE cell_id = ? AND status = 'pending' AND delivery = 'wakeup' AND deliver_at <= ? AND type != ? LIMIT 1`;
const SQL_ABSORB = `UPDATE inbox_messages SET status = 'claimed', claim_id = ?, status_reason = 'absorbed mid-run', updated_at = ?
  WHERE cell_id = ? AND status = 'pending' AND deliver_at <= ? AND type != ?
  RETURNING seq, envelope`;
// Something could be claimable: a due wakeup row, or an overdue claim whose rows would return to the queue.
const SQL_MAYBE_CLAIMABLE = `SELECT 1 AS x WHERE
  EXISTS (SELECT 1 FROM inbox_messages WHERE cell_id = ? AND status = 'pending' AND delivery = 'wakeup' AND deliver_at <= ?)
  OR EXISTS (SELECT 1 FROM inbox_claims WHERE cell_id = ? AND status = 'active' AND lease_expires_at <= ?)`;
// Competing: one wakeup row, chosen and taken by a single conditional UPDATE so two claimers can never get the same row.
const SQL_TAKE_ONE = `UPDATE inbox_messages SET status = 'claimed', claim_id = ?, updated_at = ?
  WHERE seq = (SELECT seq FROM inbox_messages
               WHERE cell_id = ? AND status = 'pending' AND delivery = 'wakeup' AND deliver_at <= ?
               ORDER BY seq LIMIT 1)
    AND status = 'pending'
  RETURNING seq, envelope`;

export function createInbox(opts: InboxOptions): InboxService {
  const { db, bus, clock } = opts;
  const cells = cellsRepo(db, clock);
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 5));
  const defaultLeaseMs = opts.defaultLeaseMs ?? 10 * 60_000;
  const maxTimerDelayMs = Math.max(1, opts.maxTimerDelayMs ?? 60_000);
  const onError = opts.onError ?? ((err: unknown) => console.error("[inbox]", err));
  const authorizeControl = opts.authorizeControl ?? defaultControlAuthorizer(cells, opts.ownerPrincipal ?? OWNER_PRINCIPAL);
  const resolveDesk = opts.resolveDesk ?? ((cellId: string) => defaultDesk(cells, cellId));
  const controlListeners = new Set<ControlListener>();

  // Delayed rows with deliver_at in (watermark, now] are announced by the next tick. Rows due at insert time are
  // announced by the insert itself; rows that became due while no process ran are found by `start()` / dueCellIds.
  let watermark = clock.now();

  // ---------- timer state (start/stop) ----------
  const manualClock = isSubscribable(clock) ? clock : null;
  let started = false;
  let ticking = false;
  let recheckAfterTick = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeClock: (() => void) | undefined;

  // ---------- host suspend detection ----------
  // Wall time keeps running while the host sleeps; the monotonic clock does not (performance.now() is CLOCK_MONOTONIC
  // on Linux and mach_absolute_time on macOS, and both stop during system sleep). A wall advance clearly larger than
  // the monotonic advance since the last sample is therefore time the machine was suspended: no Run could work or
  // renew its lease in it. A manual or demo clock jumps on purpose, so detection is off for them by default.
  const monotonicNow = opts.monotonicNow ?? (clock === systemClock ? () => performance.now() : null);
  let sample = monotonicNow ? { wall: clock.now(), mono: monotonicNow() } : null;
  let lastSuspend: { at: number; sleptMs: number } | null = null;

  // ==================== small helpers ====================

  function requireCell(cellId: string): CellRecord {
    const cell = cells.get(cellId);
    if (!cell) throw new NgError("not_found", `cell "${cellId}" not found`);
    return cell;
  }

  function requireClaim(claimId: string): ClaimRow {
    const c = get<ClaimRow>(db, "SELECT * FROM inbox_claims WHERE claim_id = ?", [claimId]);
    if (!c) throw new NgError("not_found", `claim "${claimId}" not found`);
    return c;
  }

  function announce(cellId: string, reason: EnqueuedReason): void {
    afterCommit(db, () => bus.emit("inbox.enqueued", { cellId, reason }));
  }

  function scheduleChanged(): void {
    if (started && !manualClock) afterCommit(db, rearmTimer);
  }

  function hasDueWakeup(cellId: string, now: number, epoch: number): boolean {
    return get(db, SQL_DUE_WAKEUP, [cellId, now, epoch]) !== undefined;
  }

  function isClaimable(cellId: string, now: number): boolean {
    const cell = cells.get(cellId);
    if (!cell || cell.status !== "active") return false;
    const serialHeld = get(
      db,
      "SELECT 1 AS x FROM inbox_claims WHERE cell_id = ? AND status = 'active' AND mode = 'serial_coalesce' AND lease_expires_at > ? LIMIT 1",
      [cellId, now],
    );
    return !serialHeld && hasDueWakeup(cellId, now, cell.epoch);
  }

  function claimHadRealWork(claimId: string): boolean {
    return get(db, SQL_CLAIM_HAD_REAL_WORK, [claimId]) !== undefined;
  }

  function rearmIdle(cellId: string, now: number): void {
    const r = run(
      db,
      "UPDATE inbox_schedules SET next_fire_at = ? + idle_sec * 1000, updated_at = ? WHERE cell_id = ? AND active = 1 AND idle_sec IS NOT NULL",
      [now, now, cellId],
    );
    if (r.changes > 0) scheduleChanged();
  }

  function suspendIdle(cellId: string, now: number): void {
    run(
      db,
      "UPDATE inbox_schedules SET next_fire_at = NULL, updated_at = ? WHERE cell_id = ? AND active = 1 AND idle_sec IS NOT NULL",
      [now, cellId],
    );
  }

  function dropStale(cell: CellRecord, now: number): void {
    run(
      db,
      `UPDATE inbox_messages SET status = 'dropped_epoch', status_reason = 'expected epoch ' || expected_epoch || ', cell is at ' || ?, updated_at = ?
       WHERE cell_id = ? AND status = 'pending' AND expected_epoch IS NOT NULL AND expected_epoch != ?`,
      [String(cell.epoch), now, cell.id, cell.epoch],
    );
  }

  // ==================== insert paths ====================

  function insertMessage(cell: CellRecord, env: Envelope, o: InsertOpts, now: number): InsertResult {
    let status: InboxMessageStatus = "pending";
    let reason: string | null = null;
    const expected = env.expectedEpoch ?? null;
    const valid = validatePayload(env);
    if (!valid.ok) {
      status = "quarantined";
      reason = `${valid.reason}: ${valid.message}`;
    } else if (cell.status === "closed") {
      status = "cancelled";
      reason = "cell is closed";
    } else if (expected !== null && expected !== cell.epoch) {
      status = "dropped_epoch";
      reason = `expected epoch ${expected}, cell is at ${cell.epoch}`;
    }
    const delivery = env.delivery ?? "wakeup";
    const row = get<{ seq: number }>(
      db,
      `INSERT INTO inbox_messages (cell_id, envelope_id, envelope, kind, type, delivery, principal_id, status, status_reason,
         deliver_at, cancel_group, schedule_id, expected_epoch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (cell_id, envelope_id) DO NOTHING
       RETURNING seq`,
      [
        cell.id,
        env.id,
        toJson(env),
        env.kind,
        env.type,
        delivery,
        env.principalId,
        status,
        reason,
        o.deliverAt,
        o.cancelGroup,
        o.scheduleId,
        expected,
        now,
        now,
      ],
    );
    if (!row) return { result: "deduped" };
    if (status === "pending") {
      if (o.deliverAt > now) scheduleChanged();
      else if (o.announce && delivery === "wakeup" && cell.status === "active") announce(cell.id, o.announce);
    }
    return { result: "accepted", status, seq: row.seq };
  }

  function upsertSchedule(cell: CellRecord, tpl: Envelope, rule: Extract<Rule, { kind: "cron" | "idle" }>, now: number): EnqueueResult {
    const valid = validatePayload(tpl);
    if (!valid.ok) {
      throw new NgError("invalid_argument", `schedule template "${tpl.id}" for cell "${cell.id}": ${valid.message}`);
    }
    const existing = get<ScheduleRow>(db, "SELECT * FROM inbox_schedules WHERE cell_id = ? AND template_id = ?", [cell.id, tpl.id]);
    if (existing && toBool(existing.active)) return "deduped";

    const expected = tpl.expectedEpoch ?? null;
    const live = cell.status !== "closed" && (expected === null || expected === cell.epoch);
    const cron = rule.kind === "cron" ? rule.cron : null;
    const tz = rule.kind === "cron" ? rule.tz : null;
    const idleSec = rule.kind === "idle" ? rule.idleSec : null;
    // Evaluated even for an inactive rule so a bad expression or timezone fails the enqueue, not a later tick.
    const firstCron = cron !== null ? nextCronAt(cron, tz, now) : null;
    const nextFireAt = !live ? null : cron !== null ? firstCron : now + (idleSec ?? 0) * 1000;
    const params: SqlParam[] = [toJson(tpl), cron, idleSec, tz, rule.cancelGroup, expected, nextFireAt, live ? 1 : 0, now];
    if (existing) {
      run(
        db,
        `UPDATE inbox_schedules SET envelope = ?, cron = ?, idle_sec = ?, tz = ?, cancel_group = ?, expected_epoch = ?,
           next_fire_at = ?, active = ?, updated_at = ?
         WHERE id = ?`,
        [...params, existing.id],
      );
    } else {
      run(
        db,
        `INSERT INTO inbox_schedules (envelope, cron, idle_sec, tz, cancel_group, expected_epoch, next_fire_at, active, updated_at,
           id, cell_id, template_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...params, newId("sch", clock), cell.id, tpl.id, now],
      );
    }
    if (live) scheduleChanged();
    return "accepted";
  }

  // ==================== claim lifecycle ====================

  function finishClaim(
    c: ClaimRow,
    status: "released" | "expired",
    reason: string,
    retryAt: number | undefined,
    now: number,
    countAttempt = true,
  ): ReleaseResult {
    const real = claimHadRealWork(c.claim_id);
    const epoch = cells.getEpoch(c.cell_id);
    const res: ReleaseResult = { requeued: 0, dead: 0, cancelled: 0 };
    if (epoch !== c.epoch) {
      // The cell was cancelled while this Run held the batch: retrying would resurrect work the human stopped.
      res.cancelled = run(
        db,
        "UPDATE inbox_messages SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE claim_id = ? AND status = 'claimed'",
        [`cell epoch moved during the run (${c.epoch} -> ${epoch}); ${reason}`, now, c.claim_id],
      ).changes;
    } else if (!countAttempt) {
      res.requeued = run(
        db,
        `UPDATE inbox_messages SET status = 'pending', claim_id = NULL, status_reason = ?, deliver_at = MAX(deliver_at, ?), updated_at = ?
         WHERE claim_id = ? AND status = 'claimed'`,
        [reason, retryAt ?? Number.MIN_SAFE_INTEGER, now, c.claim_id],
      ).changes;
    } else {
      const dead = all<{ seq: number; envelope_id: string }>(
        db,
        `UPDATE inbox_messages SET status = 'dead', attempts = attempts + 1, status_reason = ?, updated_at = ?
         WHERE claim_id = ? AND status = 'claimed' AND attempts + 1 >= ?
         RETURNING seq, envelope_id`,
        [reason, now, c.claim_id, maxAttempts],
      );
      res.dead = dead.length;
      res.requeued = run(
        db,
        `UPDATE inbox_messages SET status = 'pending', claim_id = NULL, attempts = attempts + 1, status_reason = ?,
           deliver_at = MAX(deliver_at, ?), updated_at = ?
         WHERE claim_id = ? AND status = 'claimed'`,
        [reason, retryAt ?? Number.MIN_SAFE_INTEGER, now, c.claim_id],
      ).changes;
      if (dead.length > 0) {
        dead.sort((a, b) => a.seq - b.seq);
        const payload = {
          cellId: c.cell_id,
          claimId: c.claim_id,
          seqs: dead.map((d) => d.seq),
          envelopeIds: dead.map((d) => d.envelope_id),
          reason,
        };
        afterCommit(db, () => bus.emit("inbox.dead", payload));
      }
    }
    run(db, "UPDATE inbox_claims SET status = ?, finished_at = ?, release_reason = ? WHERE claim_id = ?", [status, now, reason, c.claim_id]);
    if (real) rearmIdle(c.cell_id, now);
    return res;
  }

  /** Time the host spent suspended since the last sample (0 under the threshold), and the sample to keep. */
  function measureSuspend(now: number): { sleptMs: number; next: { wall: number; mono: number } } | null {
    if (!monotonicNow || !sample) return null;
    const mono = monotonicNow();
    const skew = now - sample.wall - (mono - sample.mono);
    return { sleptMs: skew > SUSPEND_SKEW_MS ? Math.round(skew) : 0, next: { wall: now, mono } };
  }

  /**
   * Called inside a transaction before anything compares leases with `now`: after a suspend every active lease is
   * pushed forward by the time slept, so the first tick after wake-up (which can run before the kernel's heartbeat
   * renews them) does not expire Runs that were frozen with the machine and deliver their batches twice. The sample
   * advances only when the transaction commits: after a rollback the next check finds the same suspend again.
   */
  function absorbSuspend(now: number): void {
    const m = measureSuspend(now);
    if (!m) return;
    if (m.sleptMs > 0) {
      run(db, "UPDATE inbox_claims SET lease_expires_at = lease_expires_at + ? WHERE status = 'active'", [m.sleptMs]);
      afterCommit(db, () => (lastSuspend = { at: now, sleptMs: m.sleptMs }));
      scheduleChanged();
    }
    afterCommit(db, () => (sample = m.next));
  }

  function expireClaims(now: number, cellId?: string): ClaimRow[] {
    const rows =
      cellId === undefined
        ? all<ClaimRow>(db, "SELECT * FROM inbox_claims WHERE status = 'active' AND lease_expires_at <= ? ORDER BY lease_expires_at", [now])
        : all<ClaimRow>(db, "SELECT * FROM inbox_claims WHERE cell_id = ? AND status = 'active' AND lease_expires_at <= ?", [cellId, now]);
    for (const c of rows) finishClaim(c, "expired", "lease expired", undefined, now);
    return rows;
  }

  function claimNextRunSync(cellId: string, workerId: string, mode: ClaimMode, leaseMs?: number): ClaimedBatch | null {
    if (mode !== "serial_coalesce" && mode !== "competing_workers") throw new NgError("invalid_argument", `unknown claim mode "${String(mode)}"`);
    if (typeof workerId !== "string" || workerId.length === 0) throw new NgError("invalid_argument", "workerId is required");
    const lease = leaseMs ?? defaultLeaseMs;
    if (!Number.isFinite(lease) || lease <= 0) throw new NgError("invalid_argument", `leaseMs must be > 0 (got ${lease})`);

    // Read-only fast path: the dispatcher polls cells that often have nothing due; don't take the write lock for them.
    // A row enqueued right after this check announces itself, so returning null here loses nothing.
    if (!inTransaction(db)) {
      const now = clock.now();
      if (cells.getEpoch(cellId) === undefined) throw new NgError("not_found", `cell "${cellId}" not found`);
      if (get(db, SQL_MAYBE_CLAIMABLE, [cellId, now, cellId, now]) === undefined) return null;
    }

    return withTx(db, () => {
      const cell = requireCell(cellId);
      if (cell.status !== "active") return null;
      const now = clock.now();
      absorbSuspend(now);
      const expired = expireClaims(now, cellId);
      dropStale(cell, now);

      const blocked =
        mode === "serial_coalesce"
          ? get(db, "SELECT 1 AS x FROM inbox_claims WHERE cell_id = ? AND status = 'active' LIMIT 1", [cellId])
          : get(db, "SELECT 1 AS x FROM inbox_claims WHERE cell_id = ? AND status = 'active' AND mode = 'serial_coalesce' LIMIT 1", [cellId]);
      if (blocked) return null;
      if (!hasDueWakeup(cellId, now, cell.epoch)) return null;

      const claimId = newId("run", clock);
      const rows = all<{ seq: number; envelope: string }>(db, mode === "serial_coalesce" ? SQL_TAKE_SERIAL : SQL_TAKE_ONE, [
        claimId,
        now,
        cellId,
        now,
      ]);
      if (rows.length === 0) return null;
      rows.sort((a, b) => a.seq - b.seq);
      const leaseExpiresAt = now + lease;
      run(
        db,
        `INSERT INTO inbox_claims (claim_id, cell_id, worker_id, mode, epoch, status, claimed_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        [claimId, cellId, workerId, mode, cell.epoch, now, leaseExpiresAt],
      );
      if (claimHadRealWork(claimId)) suspendIdle(cellId, now);
      if (expired.length > 0 && mode === "competing_workers" && hasDueWakeup(cellId, now, cell.epoch)) announce(cellId, "released");
      scheduleChanged();
      return {
        claimId,
        cellId,
        epoch: cell.epoch,
        workerId,
        mode,
        envelopes: rows.map((r) => fromJson<Envelope>(r.envelope)),
        seqs: rows.map((r) => r.seq),
        claimedAt: now,
        leaseExpiresAt,
      };
    });
  }

  function completeSync(claimId: string): void {
    withTx(db, () => {
      const c = requireClaim(claimId);
      if (c.status === "completed") return;
      if (c.status !== "active") {
        throw new NgError(
          "conflict",
          `claim "${claimId}" is ${c.status}${c.release_reason ? ` (${c.release_reason})` : ""}; its messages already went back to the queue`,
          { status: c.status },
        );
      }
      const now = clock.now();
      run(db, "UPDATE inbox_messages SET status = 'done', updated_at = ? WHERE claim_id = ? AND status = 'claimed'", [now, claimId]);
      run(db, "UPDATE inbox_claims SET status = 'completed', finished_at = ? WHERE claim_id = ?", [now, claimId]);
      if (claimHadRealWork(claimId)) rearmIdle(c.cell_id, now);
      if (isClaimable(c.cell_id, now)) announce(c.cell_id, "released");
    });
  }

  function releaseSync(claimId: string, reason: string, ropts: InboxReleaseOptions = {}): ReleaseResult {
    const retryAt = ropts.retryAt;
    if (retryAt !== undefined && !Number.isFinite(retryAt)) throw new NgError("invalid_argument", "retryAt must be a finite timestamp");
    return withTx(db, () => {
      const c = requireClaim(claimId);
      if (c.status !== "active") return { requeued: 0, dead: 0, cancelled: 0 };
      const now = clock.now();
      const res = finishClaim(c, "released", reason || "released", retryAt, now, ropts.countAttempt !== false);
      if (isClaimable(c.cell_id, now)) announce(c.cell_id, "released");
      if (retryAt !== undefined && retryAt > now) scheduleChanged();
      return res;
    });
  }

  function renewLeaseSync(claimId: string, leaseMs: number): boolean {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new NgError("invalid_argument", `leaseMs must be > 0 (got ${leaseMs})`);
    return withTx(db, () => {
      // First, so the suspend is not added again later on top of this fresh lease.
      absorbSuspend(clock.now());
      const r = run(db, "UPDATE inbox_claims SET lease_expires_at = ? WHERE claim_id = ? AND status = 'active'", [clock.now() + leaseMs, claimId]);
      if (r.changes > 0) scheduleChanged();
      return r.changes > 0;
    });
  }

  function handbackSync(claimId: string, envelopeId: string, reason: string): void {
    withTx(db, () => {
      const c = requireClaim(claimId);
      if (c.status !== "active") throw new NgError("conflict", `claim "${claimId}" is ${c.status}`, { status: c.status });
      const row = get<MessageRow>(db, "SELECT * FROM inbox_messages WHERE claim_id = ? AND envelope_id = ? AND status = 'claimed'", [
        claimId,
        envelopeId,
      ]);
      if (!row) throw new NgError("not_found", `envelope "${envelopeId}" is not held by claim "${claimId}"`);
      const deskId = resolveDesk(c.cell_id);
      if (deskId === c.cell_id) throw new NgError("invalid_argument", `cell "${c.cell_id}" has no desk to hand back to`);
      const desk = requireCell(deskId);
      const now = clock.now();
      run(db, "UPDATE inbox_messages SET status = 'handed_back', status_reason = ?, updated_at = ? WHERE seq = ?", [reason, now, row.seq]);
      const original = fromJson<Envelope>(row.envelope);
      const env = createEnvelope<HandbackPayload>(
        {
          id: `${envelopeId}#handback#${c.cell_id}`,
          from: KERNEL_FROM.handback,
          to: inboxAddr(deskId),
          principalId: original.principalId,
          kind: "event",
          type: PAYLOAD.handback,
          payload: { original, fromCellId: c.cell_id, reason },
          ...(original.threads ? { threads: original.threads } : {}),
          createdAt: now,
        },
        clock,
      );
      insertMessage(desk, env, { deliverAt: now, cancelGroup: null, scheduleId: null, announce: "enqueued" }, now);
    });
  }

  function drainSteerSync(cellId: string): string[] {
    return withTx(db, () => {
      const cell = requireCell(cellId);
      const claim = get<{ claim_id: string; epoch: number }>(
        db,
        "SELECT claim_id, epoch FROM inbox_claims WHERE cell_id = ? AND status = 'active' ORDER BY claimed_at, claim_id LIMIT 1",
        [cellId],
      );
      // A Run from before a cancel is being aborted; a newer steer belongs to the next Run.
      if (!claim || claim.epoch !== cell.epoch) return [];
      const now = clock.now();
      const rows = all<{ seq: number; envelope: string }>(
        db,
        `UPDATE inbox_messages SET status = 'done', claim_id = ?, status_reason = 'drained mid-run', updated_at = ?
         WHERE cell_id = ? AND status = 'pending' AND type = ? AND deliver_at <= ?
           AND (expected_epoch IS NULL OR expected_epoch = ?)
         RETURNING seq, envelope`,
        [claim.claim_id, now, cellId, PAYLOAD.controlSteer, now, cell.epoch],
      );
      rows.sort((a, b) => a.seq - b.seq);
      return rows.map((r) => fromJson<Envelope<ControlSteerPayload>>(r.envelope).payload.message);
    });
  }

  function drainInboundSync(cellId: string, claimId: string): Array<{ envelope: Envelope; seq: number }> {
    return withTx(db, () => {
      const cell = requireCell(cellId);
      const c = get<ClaimRow>(db, "SELECT * FROM inbox_claims WHERE claim_id = ?", [claimId]);
      // Only the cell's live serial Run may absorb: a claim that was released/expired no longer owns anything, and a
      // Run from before a cancel (epoch moved) is being aborted — what arrives now belongs to whatever runs next.
      if (!c || c.cell_id !== cellId || c.status !== "active" || c.mode !== "serial_coalesce") return [];
      if (cell.status !== "active" || c.epoch !== cell.epoch) return [];
      const now = clock.now();
      dropStale(cell, now);
      // Same rule as a claim: silent_inject rows ride along with a wakeup, they never start anything by themselves.
      if (get(db, SQL_DUE_INBOUND_WAKEUP, [cellId, now, PAYLOAD.controlSteer]) === undefined) return [];
      const rows = all<{ seq: number; envelope: string }>(db, SQL_ABSORB, [claimId, now, cellId, now, PAYLOAD.controlSteer]);
      if (rows.length === 0) return [];
      rows.sort((a, b) => a.seq - b.seq);
      // An idle-only Run that absorbs real work must count as real work when it ends (see SQL_CLAIM_HAD_REAL_WORK).
      if (claimHadRealWork(claimId)) suspendIdle(cellId, now);
      return rows.map((r) => ({ envelope: fromJson<Envelope>(r.envelope), seq: r.seq }));
    });
  }

  function pendingWakeupCountSync(cellId: string): number {
    const cell = requireCell(cellId);
    const now = clock.now();
    const row = get<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM inbox_messages
       WHERE cell_id = ? AND status = 'pending' AND delivery = 'wakeup'
         AND (expected_epoch IS NULL OR expected_epoch = ?)
         AND type NOT IN (?, ?)
         AND (deliver_at <= ? OR type != ?)`,
      // The kernel's own notices are not work: a stalled_check is dropped unseen once the cell has moved on, and a
      // wait's timeout dies with the wait. Counted, either would keep a finished cell open with nothing left to run.
      [cellId, cell.epoch, PAYLOAD.stalledCheck, PAYLOAD.waitTimeout, now, PAYLOAD.timerFired],
    );
    return Number(row?.n ?? 0);
  }

  function activeClaimCountSync(cellId: string, exceptClaimId?: string): number {
    const row =
      exceptClaimId === undefined
        ? get<{ n: number }>(db, "SELECT count(*) AS n FROM inbox_claims WHERE cell_id = ? AND status = 'active'", [cellId])
        : get<{ n: number }>(db, "SELECT count(*) AS n FROM inbox_claims WHERE cell_id = ? AND status = 'active' AND claim_id != ?", [cellId, exceptClaimId]);
    return Number(row?.n ?? 0);
  }

  /**
   * Right edge of the batching window a coalesced message joins (ScheduleRule.coalesce). A fixed (tumbling) bucket per
   * key: the first message opens it at now + windowMs and everything that follows lands on that same instant, so a
   * steady stream can neither push the batch out forever nor borrow the time of another key or of an ordinary timer.
   */
  function windowEdge(cell: CellRecord, key: string, windowMs: number, now: number): number {
    // Something is running: hand it over now, the Run absorbs it (or it is simply the next batch).
    if (get(db, "SELECT 1 AS x FROM inbox_claims WHERE cell_id = ? AND status = 'active' LIMIT 1", [cell.id])) return now;
    const open = get<{ deliver_at: number }>(
      db,
      `SELECT deliver_at FROM inbox_messages
       WHERE cell_id = ? AND status = 'pending' AND delivery = 'wakeup' AND cancel_group = ?
       ORDER BY deliver_at DESC LIMIT 1`,
      [cell.id, key],
    );
    if (!open) return now + windowMs;
    // A window that already came due but was not claimed yet (the cell is queued or paused): join that batch.
    return open.deliver_at > now ? open.deliver_at : now;
  }

  // ==================== enqueue / cancel ====================

  function enqueueSync(cellId: string, env: Envelope, schedule?: ScheduleRule): EnqueueResult {
    checkEnvelope(env);
    const rule = normalizeRule(schedule);
    return withTx(db, () => {
      const cell = requireCell(cellId);
      const now = clock.now();
      const stored: Envelope = { ...env, to: inboxAddr(cellId) };
      if (rule.kind === "cron" || rule.kind === "idle") return upsertSchedule(cell, stored, rule, now);
      if (rule.kind === "coalesce") {
        return insertMessage(cell, stored, { deliverAt: windowEdge(cell, rule.key, rule.windowMs, now), cancelGroup: rule.key, scheduleId: null, announce: "enqueued" }, now).result;
      }
      const deliverAt = rule.kind === "at" ? rule.deliverAt : now;
      return insertMessage(cell, stored, { deliverAt, cancelGroup: rule.cancelGroup, scheduleId: null, announce: "enqueued" }, now).result;
    });
  }

  function cancelScheduledSync(scope: CancelScope): number {
    if (!scope || typeof scope.cellId !== "string" || scope.cellId.length === 0) {
      throw new NgError("invalid_argument", "cancelScheduled: cellId is required");
    }
    return withTx(db, () => {
      requireCell(scope.cellId);
      const now = clock.now();

      let sWhere = "cell_id = ? AND active = 1";
      const sParams: SqlParam[] = [now, scope.cellId];
      if (scope.cancelGroup !== undefined) {
        sWhere += " AND cancel_group = ?";
        sParams.push(scope.cancelGroup);
      }
      if (scope.envelopeId !== undefined) {
        sWhere += " AND template_id = ?";
        sParams.push(scope.envelopeId);
      }
      const schedules = all<{ id: string }>(
        db,
        `UPDATE inbox_schedules SET active = 0, next_fire_at = NULL, updated_at = ? WHERE ${sWhere} RETURNING id`,
        sParams,
      );

      const match: string[] = [];
      const mParams: SqlParam[] = ["cancelScheduled", now, scope.cellId];
      if (scope.cancelGroup !== undefined) {
        match.push("cancel_group = ?");
        mParams.push(scope.cancelGroup);
      }
      if (scope.envelopeId !== undefined) {
        match.push("envelope_id = ?");
        mParams.push(scope.envelopeId);
      }
      let cond = match.length > 0 ? `(${match.join(" AND ")})` : "1 = 1";
      if (schedules.length > 0) {
        cond = `(${cond} OR schedule_id IN (${schedules.map(() => "?").join(", ")}))`;
        mParams.push(...schedules.map((s) => s.id));
      }
      const messages = run(
        db,
        `UPDATE inbox_messages SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE cell_id = ? AND status = 'pending' AND ${cond}`,
        mParams,
      ).changes;
      if (schedules.length > 0 || messages > 0) scheduleChanged();
      return messages + schedules.length;
    });
  }

  // ==================== control bypass ====================

  function publishControl(event: ControlEvent): void {
    for (const listener of [...controlListeners]) {
      try {
        listener(event);
      } catch (err) {
        onError(err);
      }
    }
    for (const c of event.cells) {
      bus.emit("inbox.control", { cellId: c.cellId, action: event.action, epoch: c.epoch, principalId: event.principalId });
    }
    if (event.action === "cancel") {
      for (const c of event.cells) bus.emit("cell.changed", { cellId: c.cellId, change: "epoch", epoch: c.epoch });
    } else if (event.action === "pause" || event.action === "resume") {
      const status = event.action === "pause" ? "paused" : "active";
      for (const c of event.cells) bus.emit("cell.changed", { cellId: c.cellId, change: "status", status });
    }
  }

  function controlSync(cellId: string, cmd: ControlCommand): ControlResult {
    if (!cmd || !CONTROL_ACTIONS.has(cmd.action)) throw new NgError("invalid_argument", `unknown control action "${String(cmd?.action)}"`);
    if (typeof cmd.principalId !== "string" || cmd.principalId.length === 0) throw new NgError("invalid_argument", "control: principalId is required");
    if (cmd.action === "steer" && (typeof cmd.steerMessage !== "string" || cmd.steerMessage.trim().length === 0)) {
      throw new NgError("invalid_argument", "control steer: steerMessage is required");
    }
    return withTx(db, () => {
      const cell = cells.get(cellId);
      if (!cell) return { applied: false, epoch: -1, reason: "not_found" };
      const auth = authorizeControl(cellId, cmd.principalId, cmd.action);
      if (!auth.ok) return { applied: false, epoch: cell.epoch, reason: auth.reason };
      if (cell.status === "closed") return { applied: false, epoch: cell.epoch, reason: "closed" };

      const now = clock.now();
      const affected: ControlEvent["cells"] = [];
      const wake: string[] = [];
      let steerEnvelopeId: string | undefined;

      switch (cmd.action) {
        case "cancel": {
          const why = `control.cancel by ${cmd.principalId}`;
          for (const t of [cell, ...cells.descendants(cellId, { status: ["active", "paused"] })]) {
            const epoch = cells.bumpEpoch(t.id);
            run(db, "UPDATE inbox_messages SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE cell_id = ? AND status = 'pending'", [
              why,
              now,
              t.id,
            ]);
            run(db, "UPDATE inbox_schedules SET active = 0, next_fire_at = NULL, updated_at = ? WHERE cell_id = ? AND active = 1", [now, t.id]);
            affected.push({ cellId: t.id, epoch });
          }
          break;
        }
        case "pause": {
          for (const t of [cell, ...cells.descendants(cellId, { status: ["active", "paused"] })]) {
            if (t.status === "active") cells.setStatus(t.id, "paused");
            affected.push({ cellId: t.id, epoch: t.epoch });
          }
          break;
        }
        case "resume": {
          for (const t of [cell, ...cells.descendants(cellId, { status: ["paused"] })]) {
            if (t.status === "paused") cells.setStatus(t.id, "active");
            affected.push({ cellId: t.id, epoch: t.epoch });
            if (isClaimable(t.id, now)) wake.push(t.id);
          }
          break;
        }
        case "steer": {
          const env = createEnvelope<ControlSteerPayload>(
            {
              id: cmd.steerEnvelopeId ?? newId("steer", clock),
              from: KERNEL_FROM.control,
              to: inboxAddr(cellId),
              principalId: cmd.principalId,
              kind: "event",
              type: PAYLOAD.controlSteer,
              payload: { message: cmd.steerMessage! },
              expectedEpoch: cell.epoch,
              delivery: "wakeup",
              createdAt: now,
            },
            clock,
          );
          insertMessage(cell, env, { deliverAt: now, cancelGroup: null, scheduleId: null, announce: null }, now);
          steerEnvelopeId = env.id;
          affected.push({ cellId, epoch: cell.epoch });
          if (cell.status === "active") wake.push(cellId);
          break;
        }
      }

      const epoch = affected[0]!.epoch;
      const event: ControlEvent = {
        cellId,
        action: cmd.action,
        principalId: cmd.principalId,
        epoch,
        cells: affected,
        ...(cmd.action === "steer" ? { steerMessage: cmd.steerMessage!, steerEnvelopeId: steerEnvelopeId! } : {}),
      };
      afterCommit(db, () => publishControl(event));
      for (const id of wake) announce(id, cmd.action === "resume" ? "resumed" : "enqueued");
      scheduleChanged();
      return { applied: true, epoch };
    });
  }

  // ==================== time ====================

  function processSchedule(s: ScheduleRow, now: number): FireResult {
    const none: FireResult = { fired: false, wakes: false };
    const cell = cells.get(s.cell_id);
    if (!cell || cell.status === "closed" || (s.expected_epoch !== null && s.expected_epoch !== cell.epoch)) {
      run(db, "UPDATE inbox_schedules SET active = 0, next_fire_at = NULL, updated_at = ? WHERE id = ?", [now, s.id]);
      return none;
    }
    const fireAt = s.next_fire_at ?? now;
    const setNext = (next: number | null, firedAt: number | null) =>
      run(db, "UPDATE inbox_schedules SET next_fire_at = ?, last_fired_at = COALESCE(?, last_fired_at), updated_at = ? WHERE id = ?", [
        next,
        firedAt,
        now,
        s.id,
      ]);

    if (s.cron !== null) {
      // Missed occurrences (process down, long pause) coalesce into this one firing.
      const next = nextCronAt(s.cron, s.tz, now);
      if (cell.status === "paused") {
        setNext(next, null);
        return none;
      }
      const r = fireSchedule(s, cell, fireAt, now);
      setNext(next, now);
      return r;
    }

    const idleMs = (s.idle_sec ?? 0) * 1000;
    if (
      cell.status === "paused" ||
      get(db, SQL_LIVE_REAL_CLAIM, [cell.id]) !== undefined ||
      get(db, SQL_DUE_REAL_WORK, [cell.id, now, cell.epoch]) !== undefined
    ) {
      setNext(now + idleMs, null);
      return none;
    }
    const r = fireSchedule(s, cell, fireAt, now);
    setNext(null, now);
    return r;
  }

  function fireSchedule(s: ScheduleRow, cell: CellRecord, fireAt: number, now: number): FireResult {
    const tpl = fromJson<Envelope>(s.envelope);
    const payload =
      tpl.type === PAYLOAD.timerFired && isRecord(tpl.payload) ? { ...tpl.payload, scheduleId: s.id, firedAt: fireAt } : tpl.payload;
    const env: Envelope = { ...tpl, id: `${tpl.id}@${fireAt}`, payload, createdAt: now };
    const r = insertMessage(cell, env, { deliverAt: now, cancelGroup: s.cancel_group, scheduleId: s.id, announce: null }, now);
    const fired = r.result === "accepted";
    return { fired, wakes: fired && r.status === "pending" && (env.delivery ?? "wakeup") === "wakeup" };
  }

  function tickSync(): TickReport {
    // `at` before the query: a delayed row inserted after it has deliver_at > created_at >= at, so it stays above the watermark.
    const at = clock.now();
    const next = nextWakeAtSync();
    const suspend = measureSuspend(at);
    if ((next === null || next > at) && !suspend?.sleptMs) {
      // Nothing expired, no rule due, no delayed row in (watermark, now], no suspend to absorb: skip the write transaction.
      if (suspend) sample = suspend.next;
      if (at > watermark) watermark = at;
      return { fired: 0, dueCellIds: [], expiredClaims: 0 };
    }
    ticking = true;
    try {
      return withTx(db, () => {
        const now = clock.now();
        const touched = new Map<string, EnqueuedReason>();

        absorbSuspend(now);
        const expired = expireClaims(now);
        for (const c of expired) touched.set(c.cell_id, "released");

        let fired = 0;
        const dueSchedules = all<ScheduleRow>(
          db,
          "SELECT * FROM inbox_schedules WHERE active = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at, id",
          [now],
        );
        for (const s of dueSchedules) {
          let r: FireResult = { fired: false, wakes: false };
          try {
            r = withTx(db, () => processSchedule(s, now));
          } catch (err) {
            // A rule that cannot be evaluated (e.g. its timezone vanished) would otherwise fail every tick.
            onError(err);
            run(db, "UPDATE inbox_schedules SET active = 0, next_fire_at = NULL, updated_at = ? WHERE id = ?", [now, s.id]);
          }
          if (r.fired) fired++;
          if (r.wakes) touched.set(s.cell_id, "due");
        }

        for (const r of all<{ cell_id: string }>(
          db,
          `SELECT DISTINCT cell_id FROM inbox_messages
           WHERE status = 'pending' AND delivery = 'wakeup' AND deliver_at > ? AND deliver_at <= ? AND deliver_at > created_at`,
          [watermark, now],
        )) {
          touched.set(r.cell_id, "due");
        }

        const dueCellIds: string[] = [];
        for (const [cellId, reason] of touched) {
          if (!isClaimable(cellId, now)) continue;
          dueCellIds.push(cellId);
          announce(cellId, reason);
        }
        afterCommit(db, () => {
          if (now > watermark) watermark = now;
        });
        scheduleChanged();
        return { fired, dueCellIds, expiredClaims: expired.length };
      });
    } finally {
      ticking = false;
    }
  }

  function nextWakeAtSync(): number | null {
    const r = get<{ t: number | null }>(
      db,
      `SELECT MIN(t) AS t FROM (
         SELECT MIN(deliver_at) AS t FROM inbox_messages
           WHERE status = 'pending' AND delivery = 'wakeup' AND deliver_at > ? AND deliver_at > created_at
         UNION ALL SELECT MIN(next_fire_at) FROM inbox_schedules WHERE active = 1
         UNION ALL SELECT MIN(lease_expires_at) FROM inbox_claims WHERE status = 'active'
       )`,
      [watermark],
    );
    return r?.t ?? null;
  }

  function dueCellIdsSync(): string[] {
    const now = clock.now();
    const rows = all<{ cell_id: string }>(
      db,
      `SELECT cell_id, MIN(seq) AS first_seq FROM inbox_messages
       WHERE status = 'pending' AND delivery = 'wakeup' AND deliver_at <= ?
       GROUP BY cell_id ORDER BY first_seq`,
      [now],
    );
    return rows.map((r) => r.cell_id).filter((id) => isClaimable(id, now));
  }

  function rearmTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!started || manualClock) return;
    const next = nextWakeAtSync();
    if (next === null) return;
    const delay = Math.min(Math.max(0, next - clock.now()), maxTimerDelayMs);
    timer = setTimeout(backgroundTick, delay);
    timer.unref?.();
  }

  function backgroundTick(): void {
    timer = undefined;
    if (!started || ticking) return;
    try {
      tickSync();
    } catch (err) {
      onError(err);
      if (started && !manualClock) {
        timer = setTimeout(backgroundTick, Math.min(1000, maxTimerDelayMs));
        timer.unref?.();
      }
      return;
    }
    rearmTimer();
  }

  function onClockChange(): void {
    if (!started) return;
    if (ticking) {
      // e.g. a bus handler advanced the clock while this tick was emitting; re-check once the tick is done
      recheckAfterTick = true;
      return;
    }
    const next = nextWakeAtSync();
    if (next === null || next > clock.now()) return;
    try {
      tickSync();
    } catch (err) {
      onError(err);
    }
    if (recheckAfterTick) {
      recheckAfterTick = false;
      onClockChange();
    }
  }

  // ==================== reads ====================

  function listMessagesSync(filter: InboxMessageFilter = {}): InboxMessageRecord[] {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (filter.cellId !== undefined) {
      where.push("cell_id = ?");
      params.push(filter.cellId);
    }
    if (filter.status !== undefined) {
      if (filter.status.length === 0) return [];
      where.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    if (filter.type !== undefined) {
      where.push("type = ?");
      params.push(filter.type);
    }
    if (filter.cancelGroup !== undefined) {
      where.push("cancel_group = ?");
      params.push(filter.cancelGroup);
    }
    if (filter.envelopeId !== undefined) {
      where.push("envelope_id = ?");
      params.push(filter.envelopeId);
    }
    if (filter.claimId !== undefined) {
      where.push("claim_id = ?");
      params.push(filter.claimId);
    }
    if (filter.deliverAfter !== undefined) {
      where.push("deliver_at > ?");
      params.push(filter.deliverAfter);
    }
    let sql = `SELECT * FROM inbox_messages${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq`;
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(Math.max(0, Math.floor(filter.limit)));
    }
    return all<MessageRow>(db, sql, params).map(toMessage);
  }

  function listSchedulesSync(filter: { cellId?: string; activeOnly?: boolean } = {}): InboxScheduleRecord[] {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (filter.cellId !== undefined) {
      where.push("cell_id = ?");
      params.push(filter.cellId);
    }
    if (filter.activeOnly) where.push("active = 1");
    const sql = `SELECT * FROM inbox_schedules${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
    return all<ScheduleRow>(db, sql, params).map(toSchedule);
  }

  function pendingCountsSync(cellIds?: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    const params: SqlParam[] = [];
    let sql = "SELECT cell_id, expected_epoch, COUNT(*) AS n FROM inbox_messages WHERE status = 'pending'";
    if (cellIds !== undefined) {
      if (cellIds.length === 0) return out;
      for (const id of cellIds) out[id] = 0;
      sql += ` AND cell_id IN (${cellIds.map(() => "?").join(", ")})`;
      params.push(...cellIds);
    }
    sql += " GROUP BY cell_id, expected_epoch";
    const epochs = new Map<string, number | undefined>();
    for (const r of all<{ cell_id: string; expected_epoch: number | null; n: number }>(db, sql, params)) {
      if (!epochs.has(r.cell_id)) epochs.set(r.cell_id, cells.getEpoch(r.cell_id));
      // Stale-epoch rows are still `pending` until the next claim drops them; they will never be delivered.
      if (r.expected_epoch !== null && r.expected_epoch !== epochs.get(r.cell_id)) continue;
      out[r.cell_id] = (out[r.cell_id] ?? 0) + r.n;
    }
    return out;
  }

  function getClaimSync(claimId: string): InboxClaimRecord | undefined {
    const r = get<ClaimRow>(db, "SELECT * FROM inbox_claims WHERE claim_id = ?", [claimId]);
    return r ? toClaim(r) : undefined;
  }

  function listClaimsSync(filter: { cellId?: string; status?: readonly InboxClaimStatus[]; limit?: number } = {}): InboxClaimRecord[] {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (filter.cellId !== undefined) {
      where.push("cell_id = ?");
      params.push(filter.cellId);
    }
    if (filter.status !== undefined) {
      if (filter.status.length === 0) return [];
      where.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    let sql = `SELECT * FROM inbox_claims${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY claimed_at, claim_id`;
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(Math.max(0, Math.floor(filter.limit)));
    }
    return all<ClaimRow>(db, sql, params).map(toClaim);
  }

  function recoverClaimsSync(ropts: { workerId?: string; reason?: string } = {}): number {
    return withTx(db, () => {
      const now = clock.now();
      const rows =
        ropts.workerId === undefined
          ? all<ClaimRow>(db, "SELECT * FROM inbox_claims WHERE status = 'active' ORDER BY claimed_at")
          : all<ClaimRow>(db, "SELECT * FROM inbox_claims WHERE status = 'active' AND worker_id = ? ORDER BY claimed_at", [ropts.workerId]);
      const reason = ropts.reason ?? "recovered: the process holding the claim ended";
      const cellIds = new Set<string>();
      for (const c of rows) {
        finishClaim(c, "released", reason, undefined, now);
        cellIds.add(c.cell_id);
      }
      for (const id of cellIds) if (isClaimable(id, now)) announce(id, "released");
      return rows.length;
    });
  }

  // ==================== the object ====================

  const inbox: InboxService = {
    enqueueSync,
    cancelScheduledSync,
    claimNextRunSync,
    completeSync,
    handbackSync,
    controlSync,
    renewLeaseSync,
    releaseSync,
    drainSteerSync,
    drainInboundSync,
    pendingWakeupCountSync,
    activeClaimCountSync,
    tickSync,
    nextWakeAtSync,
    dueCellIdsSync,
    listMessagesSync,
    listSchedulesSync,
    pendingCountsSync,
    getClaimSync,
    listClaimsSync,
    recoverClaimsSync,
    lastSuspendSync: () => lastSuspend,

    async enqueue(cellId, env, schedule) {
      return enqueueSync(cellId, env, schedule);
    },
    async cancelScheduled(scope) {
      cancelScheduledSync(scope);
    },
    async claimNextRun(cellId, workerId, mode, leaseMs) {
      return claimNextRunSync(cellId, workerId, mode, leaseMs);
    },
    async complete(claimId) {
      completeSync(claimId);
    },
    async handback(claimId, envelopeId, reason) {
      handbackSync(claimId, envelopeId, reason);
    },
    async control(cellId, cmd) {
      return controlSync(cellId, cmd);
    },

    onControl(listener) {
      controlListeners.add(listener);
      return () => {
        controlListeners.delete(listener);
      };
    },

    start() {
      if (started) return;
      started = true;
      if (manualClock) unsubscribeClock = manualClock.subscribe(onClockChange);
      let announced: string[] = [];
      try {
        announced = tickSync().dueCellIds;
      } catch (err) {
        onError(err);
      }
      // Rows that came due while no process was running were never announced.
      const already = new Set(announced);
      for (const cellId of dueCellIdsSync()) if (!already.has(cellId)) bus.emit("inbox.enqueued", { cellId, reason: "due" });
      rearmTimer();
    },
    stop() {
      started = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      unsubscribeClock?.();
      unsubscribeClock = undefined;
    },
  };
  return inbox;
}

// ==================== module-level helpers ====================

function checkEnvelope(env: Envelope): void {
  const bad = (what: string) => new NgError("invalid_argument", `envelope ${what}`);
  if (env === null || typeof env !== "object") throw bad("must be an object");
  if (typeof env.id !== "string" || env.id.length === 0) throw bad("id must be a non-empty string");
  if (typeof env.from !== "string" || env.from.length === 0) throw bad(`"${env.id}": from is required`);
  if (typeof env.principalId !== "string" || env.principalId.length === 0) throw bad(`"${env.id}": principalId is required`);
  if (env.kind !== "event" && env.kind !== "result") throw bad(`"${env.id}": kind must be "event" or "result"`);
  if (typeof env.type !== "string" || env.type.length === 0) throw bad(`"${env.id}": type is required`);
  if (typeof env.createdAt !== "number" || !Number.isFinite(env.createdAt)) throw bad(`"${env.id}": createdAt must be a number`);
  if (env.delivery !== undefined && env.delivery !== "wakeup" && env.delivery !== "silent_inject") {
    throw bad(`"${env.id}": delivery must be "wakeup" or "silent_inject"`);
  }
  const expected = env.expectedEpoch ?? null;
  if (expected !== null && !Number.isInteger(expected)) throw bad(`"${env.id}": expectedEpoch must be an integer`);
}

function normalizeRule(s: ScheduleRule | undefined): Rule {
  if (s === undefined || s === null) return { kind: "now", cancelGroup: null };
  const cancelGroup = s.cancelGroup ?? null;
  if (cancelGroup !== null && (typeof cancelGroup !== "string" || cancelGroup.length === 0)) {
    throw new NgError("invalid_argument", "schedule.cancelGroup must be a non-empty string");
  }
  const given = [s.deliverAt, s.cron, s.idleSec, s.coalesce].filter((v) => v !== undefined && v !== null).length;
  if (given > 1) throw new NgError("invalid_argument", "schedule: at most one of deliverAt, cron, idleSec, coalesce");
  if (s.coalesce !== undefined && s.coalesce !== null) {
    const { key, windowMs } = s.coalesce;
    if (typeof key !== "string" || key.length === 0) throw new NgError("invalid_argument", "schedule.coalesce.key must be a non-empty string");
    if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs < 0) throw new NgError("invalid_argument", "schedule.coalesce.windowMs must be >= 0");
    // The key is the row's cancel group: one name for "this window", so a separate cancelGroup would be ambiguous.
    if (cancelGroup !== null && cancelGroup !== key) throw new NgError("invalid_argument", "schedule.coalesce cannot be combined with a different cancelGroup");
    return { kind: "coalesce", key, windowMs };
  }
  if (s.deliverAt !== undefined && s.deliverAt !== null) {
    if (typeof s.deliverAt !== "number" || !Number.isFinite(s.deliverAt)) throw new NgError("invalid_argument", "schedule.deliverAt must be a timestamp");
    return { kind: "at", deliverAt: s.deliverAt, cancelGroup };
  }
  if (s.cron !== undefined && s.cron !== null) {
    if (typeof s.cron !== "string" || s.cron.trim().length === 0) throw new NgError("invalid_argument", "schedule.cron must be a cron expression");
    return { kind: "cron", cron: s.cron.trim(), tz: s.tz ?? null, cancelGroup };
  }
  if (s.idleSec !== undefined && s.idleSec !== null) {
    if (!Number.isInteger(s.idleSec) || s.idleSec <= 0) throw new NgError("invalid_argument", "schedule.idleSec must be a positive integer");
    return { kind: "idle", idleSec: s.idleSec, cancelGroup };
  }
  return { kind: "now", cancelGroup };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

interface SubscribableClock {
  now(): number;
  subscribe(listener: (now: number) => void): () => void;
}

function isSubscribable(clock: object): clock is SubscribableClock {
  return typeof (clock as { subscribe?: unknown }).subscribe === "function";
}

/** Mirrors Gate.authorizeControlSync's documented rule, for setups that do not wire a Gate. */
function defaultControlAuthorizer(cells: CellsRepo, owner: string): ControlAuthorizer {
  return (cellId, principalId) => {
    const p = parsePrincipal(principalId, owner);
    if (p.kind === "owner") return { ok: true };
    if (p.kind === "cell") {
      if (p.cellId !== cellId && cells.ancestors(cellId).some((a) => a.id === p.cellId)) return { ok: true };
      return { ok: false, reason: `cell "${p.cellId}" may only control its own descendants` };
    }
    return { ok: false, reason: `principal "${principalId}" may not control cells` };
  };
}

function defaultDesk(cells: CellsRepo, cellId: string): string {
  if (cellId !== DESK_CELL_ID && cells.getEpoch(DESK_CELL_ID) !== undefined) return DESK_CELL_ID;
  const cell = cells.get(cellId);
  if (!cell) throw new NgError("not_found", `cell "${cellId}" not found`);
  return cell.rootId;
}
