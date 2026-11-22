import {
  afterCommit,
  all,
  cellPrincipal,
  createEnvelope,
  isInboxAddr,
  cellIdOf,
  KERNEL_FROM,
  NgError,
  PAYLOAD,
  parsePrincipal,
  run,
  isChannelAddr,
  newId,
  withTx,
  type CellRecord,
  type Envelope,
  type InboxAddr,
  type WaitTimeoutPayload,
} from "@ng/protocol";
import type { KernelCore } from "./core";

/** docs/05 guard 2 — one open wait of a sleeping cell (`cell_waits`). */
export interface WaitRecord {
  cellId: string;
  waitId: string;
  refId: string | null;
  registrationId: string | null;
  registeredRun: string | null;
  waitingFor: string;
  reason: string;
  epoch: number;
  timeoutAt: number | null;
  createdAt: number;
}

export interface Waits {
  /** Upsert (cell, waitingFor); a timeout arms one `kernel.wait_timeout` wake-up (replacing the previous one). */
  register(cell: Pick<CellRecord, "id" | "epoch">, wait: { waitingFor: string; reason: string; timeoutAt?: number; waitId?: string; refId?: string }, runId?: string): void;
  clear(cellId: string, waitingFor: string): boolean;
  /**
   * The cell is about to see these envelopes: close the waits they answer and return the parties. A wait is answered
   * only by its own party (or its own timeout) — an unrelated message that happens to wake the cell leaves it open.
   */
  answeredBy(cellId: string, envelopes: readonly Envelope[], runId?: string): string[];
  list(cellIds?: readonly string[]): WaitRecord[];
  /** Closed cells wait for nothing. */
  dropFor(cellIds: readonly string[]): void;
}

interface Row {
  cell_id: string;
  wait_id: string;
  ref_id: string | null;
  registration_id: string | null;
  registered_run: string | null;
  waiting_for: string;
  reason: string;
  epoch: number;
  timeout_at: number | null;
  created_at: number;
}

const toRecord = (r: Row): WaitRecord => ({ waitId: r.wait_id, refId: r.ref_id, registrationId: r.registration_id, registeredRun: r.registered_run, cellId: r.cell_id, waitingFor: r.waiting_for, reason: r.reason, epoch: r.epoch, timeoutAt: r.timeout_at, createdAt: r.created_at });

/** The two parties that are not addresses. */
export const WAIT_HUMAN = "human";
export const WAIT_EXTERNAL = "external";

export const waitTimerGroup = (waitingFor: string) => `wait:${waitingFor}`;

export function createWaits(core: Pick<KernelCore, "db" | "clock" | "inbox" | "bus" | "ownerPrincipal" | "cells">): Waits {
  const { db, clock, inbox, bus } = core;

  const touched = (cellId: string) => afterCommit(db, () => bus.emit("cell.changed", { cellId, change: "updated" }));

  function answers(wait: WaitRecord, env: Envelope): boolean {
    if (env.type === PAYLOAD.waitTimeout) {
      const timer = env.payload as WaitTimeoutPayload;
      return (timer.waitId ?? timer.waitingFor) === wait.waitId && (timer.registrationId ?? null) === wait.registrationId;
    }
    if (env.type === PAYLOAD.stalledCheck || env.type === PAYLOAD.runContinue) return false;
    // The owner (or their agent) writing to the cell directly — as a message or as an interruption — outranks whoever
    // it was waiting for: a worker that asked its project what to do about a dirty directory and is told by the owner
    // has its answer. A steer from another cell is a correction, not an answer.
    if ((env.type === PAYLOAD.cellMessage || env.type === PAYLOAD.userMessage || env.type === PAYLOAD.controlSteer) && env.from === KERNEL_FROM.control) {
      const p = parsePrincipal(env.principalId, core.ownerPrincipal);
      if (p.kind === "owner" || p.kind === "agent") return true;
    }
    if (env.type === PAYLOAD.controlSteer) return false;
    if (wait.waitingFor === WAIT_HUMAN) {
      // The owner spoke, decided a card, or an agent acting for them on the control plane did.
      const p = parsePrincipal(env.principalId, core.ownerPrincipal);
      return p.kind === "owner" || p.kind === "agent" || env.type === PAYLOAD.approvalResolved;
    }
    if (wait.waitingFor === WAIT_EXTERNAL) {
      // The vague party: "something outside me will happen". An outside message, a source hit, and also the things a
      // cell arranged for itself and then waited on without naming them — its timer, its job, a child's result.
      const p = parsePrincipal(env.principalId, core.ownerPrincipal);
      if (env.type === PAYLOAD.userMessage) return p.kind === "external";
      return env.type === PAYLOAD.sourceHit || env.type === PAYLOAD.timerFired || env.type === PAYLOAD.jobResult || env.type === PAYLOAD.cellResult;
    }
    return env.from === wait.waitingFor;
  }

  function remove(cellId: string, waitingFor: string): boolean {
    const r = run(db, "DELETE FROM cell_waits WHERE cell_id = ? AND wait_id = ?", [cellId, waitingFor]);
    if (r.changes === 0) return false;
    inbox.cancelScheduledSync({ cellId, cancelGroup: waitTimerGroup(waitingFor) });
    touched(cellId);
    return true;
  }

  return {
    register(cell, wait, runId) {
      const waitingFor = wait.waitingFor.trim();
      const waitId = (wait.waitId ?? wait.refId ?? waitingFor).trim();
      if (!waitId || !wait.reason.trim() || (wait.refId !== undefined && !wait.refId.trim())) throw new NgError("invalid_argument", "wait requires a nonempty id, reference and reason");
      if (![WAIT_HUMAN, WAIT_EXTERNAL].includes(waitingFor) && !isChannelAddr(waitingFor) && !isInboxAddr(waitingFor)) throw new NgError("invalid_argument", "waitingFor requires a valid address, human or external");
      if (isInboxAddr(waitingFor)) {
        const target = core.cells.get(cellIdOf(waitingFor));
        if (!target || target.status === "closed" || target.id === cell.id) throw new NgError("invalid_argument", "wait requires another live cell");
      }
      const registrationId = newId("wait", clock);
      if (wait.timeoutAt !== undefined && !Number.isFinite(wait.timeoutAt)) throw new NgError("invalid_argument", "timeoutAt must be a timestamp");
      withTx(db, () => {
        const now = clock.now();
        inbox.cancelScheduledSync({ cellId: cell.id, cancelGroup: waitTimerGroup(waitId) });
        run(
          db,
          `INSERT INTO cell_waits (cell_id, wait_id, ref_id, registered_run, registration_id, waiting_for, reason, epoch, timeout_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (cell_id, wait_id) DO UPDATE SET waiting_for = excluded.waiting_for, ref_id = excluded.ref_id, registered_run = excluded.registered_run, registration_id = excluded.registration_id, reason = excluded.reason, epoch = excluded.epoch, timeout_at = excluded.timeout_at, created_at = excluded.created_at`,
          [cell.id, waitId, wait.refId?.trim() ?? null, runId ?? null, registrationId, waitingFor, wait.reason, cell.epoch, wait.timeoutAt ?? null, now],
        );
        if (wait.timeoutAt !== undefined) {
          const payload: WaitTimeoutPayload = { waitId, registrationId, waitingFor, reason: wait.reason, since: now };
          inbox.enqueueSync(
            cell.id,
            createEnvelope(
              {
                // A wait that is re-registered gets a new timer row (a fired or cancelled row id cannot be reused).
                id: `${cell.id}:wait:${registrationId}`,
                from: KERNEL_FROM.wait,
                principalId: cellPrincipal(cell.id),
                kind: "event",
                type: PAYLOAD.waitTimeout,
                payload,
                expectedEpoch: cell.epoch,
              },
              clock,
            ),
            { deliverAt: wait.timeoutAt, cancelGroup: waitTimerGroup(waitId) },
          );
        }
        touched(cell.id);
      });
    },

    clear(cellId, waitingFor) {
      return withTx(db, () => remove(cellId, waitingFor.trim()));
    },

    answeredBy(cellId, envelopes, runId) {
      if (envelopes.length === 0) return [];
      return withTx(db, () => {
        const open = all<Row>(db, "SELECT * FROM cell_waits WHERE cell_id = ?", [cellId]).map(toRecord);
        const done = new Set<string>();
        for (const env of envelopes) {
          const p = env.payload as Record<string, unknown> | null;
          const data = p?.data as Record<string, unknown> | undefined;
          const refs = [p?.refId, p?.waitId, p?.replyToId, data?.refId, data?.waitId].filter((x) => typeof x === "string");
          const candidates = open.filter(w => !done.has(w.waitId) && w.registeredRun !== runId && answers(w, env));
          const keys = p?.actionId ? [...refs, p.actionId] : refs;
          const explicit = candidates.filter(w => keys.includes(w.waitId) || (w.refId !== null && keys.includes(w.refId)));
          const direct = env.from === KERNEL_FROM.control && ["owner", "agent"].includes(parsePrincipal(env.principalId, core.ownerPrincipal).kind);
          const legacy = direct || (candidates.length === 1 && ![p?.refId, p?.waitId, data?.refId, data?.waitId].some(Boolean)) ? candidates : [];
          const matches = env.type === PAYLOAD.waitTimeout ? candidates : explicit.length ? explicit : legacy;
          for (const w of matches) if (remove(cellId, w.waitId)) done.add(w.waitId);
        }
        return [...done];
      });
    },

    list(cellIds) {
      if (cellIds === undefined) return all<Row>(db, "SELECT * FROM cell_waits ORDER BY created_at, cell_id").map(toRecord);
      if (cellIds.length === 0) return [];
      const marks = cellIds.map(() => "?").join(",");
      return all<Row>(db, `SELECT * FROM cell_waits WHERE cell_id IN (${marks}) ORDER BY created_at, cell_id`, [...cellIds]).map(toRecord);
    },

    dropFor(cellIds) {
      for (const id of cellIds) run(db, "DELETE FROM cell_waits WHERE cell_id = ?", [id]);
    },
  };
}

/** The cell a wait points at, when the party is an inbox address. */
export function waitTargetCell(waitingFor: string): string | null {
  return isInboxAddr(waitingFor) ? cellIdOf(waitingFor as InboxAddr) : null;
}
