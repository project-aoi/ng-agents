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
  sha256Hex,
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
  waitingFor: string;
  reason: string;
  epoch: number;
  timeoutAt: number | null;
  createdAt: number;
}

export interface Waits {
  /** Upsert (cell, waitingFor); a timeout arms one `kernel.wait_timeout` wake-up (replacing the previous one). */
  register(cell: Pick<CellRecord, "id" | "epoch">, wait: { waitingFor: string; reason: string; timeoutAt?: number }): void;
  clear(cellId: string, waitingFor: string): boolean;
  /**
   * The cell is about to see these envelopes: close the waits they answer and return the parties. A wait is answered
   * only by its own party (or its own timeout) — an unrelated message that happens to wake the cell leaves it open.
   */
  answeredBy(cellId: string, envelopes: readonly Envelope[]): string[];
  list(cellIds?: readonly string[]): WaitRecord[];
  /** Closed cells wait for nothing. */
  dropFor(cellIds: readonly string[]): void;
}

interface Row {
  cell_id: string;
  waiting_for: string;
  reason: string;
  epoch: number;
  timeout_at: number | null;
  created_at: number;
}

const toRecord = (r: Row): WaitRecord => ({ cellId: r.cell_id, waitingFor: r.waiting_for, reason: r.reason, epoch: r.epoch, timeoutAt: r.timeout_at, createdAt: r.created_at });

/** The two parties that are not addresses. */
export const WAIT_HUMAN = "human";
export const WAIT_EXTERNAL = "external";

export const waitTimerGroup = (waitingFor: string) => `wait:${waitingFor}`;

export function createWaits(core: Pick<KernelCore, "db" | "clock" | "inbox" | "bus" | "ownerPrincipal">): Waits {
  const { db, clock, inbox, bus } = core;

  const touched = (cellId: string) => afterCommit(db, () => bus.emit("cell.changed", { cellId, change: "updated" }));

  function answers(wait: WaitRecord, env: Envelope): boolean {
    if (env.type === PAYLOAD.waitTimeout) return (env.payload as WaitTimeoutPayload).waitingFor === wait.waitingFor;
    if (env.type === PAYLOAD.stalledCheck || env.type === PAYLOAD.runContinue || env.type === PAYLOAD.controlSteer) return false;
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
    const r = run(db, "DELETE FROM cell_waits WHERE cell_id = ? AND waiting_for = ?", [cellId, waitingFor]);
    if (r.changes === 0) return false;
    inbox.cancelScheduledSync({ cellId, cancelGroup: waitTimerGroup(waitingFor) });
    touched(cellId);
    return true;
  }

  return {
    register(cell, wait) {
      const waitingFor = wait.waitingFor.trim();
      if (!waitingFor) throw new NgError("invalid_argument", "waitingFor must not be empty");
      if (wait.timeoutAt !== undefined && !Number.isFinite(wait.timeoutAt)) throw new NgError("invalid_argument", "timeoutAt must be a timestamp");
      withTx(db, () => {
        const now = clock.now();
        inbox.cancelScheduledSync({ cellId: cell.id, cancelGroup: waitTimerGroup(waitingFor) });
        run(
          db,
          `INSERT INTO cell_waits (cell_id, waiting_for, reason, epoch, timeout_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (cell_id, waiting_for) DO UPDATE SET reason = excluded.reason, epoch = excluded.epoch, timeout_at = excluded.timeout_at, created_at = excluded.created_at`,
          [cell.id, waitingFor, wait.reason, cell.epoch, wait.timeoutAt ?? null, now],
        );
        if (wait.timeoutAt !== undefined) {
          const payload: WaitTimeoutPayload = { waitingFor, reason: wait.reason, since: now };
          inbox.enqueueSync(
            cell.id,
            createEnvelope(
              {
                // A wait that is re-registered gets a new timer row (a fired or cancelled row id cannot be reused).
                id: `${cell.id}:wait:${sha256Hex(waitingFor).slice(0, 10)}:${now}:${wait.timeoutAt}`,
                from: KERNEL_FROM.wait,
                principalId: cellPrincipal(cell.id),
                kind: "event",
                type: PAYLOAD.waitTimeout,
                payload,
                expectedEpoch: cell.epoch,
              },
              clock,
            ),
            { deliverAt: wait.timeoutAt, cancelGroup: waitTimerGroup(waitingFor) },
          );
        }
        touched(cell.id);
      });
    },

    clear(cellId, waitingFor) {
      return withTx(db, () => remove(cellId, waitingFor.trim()));
    },

    answeredBy(cellId, envelopes) {
      if (envelopes.length === 0) return [];
      return withTx(db, () => {
        const open = all<Row>(db, "SELECT * FROM cell_waits WHERE cell_id = ?", [cellId]).map(toRecord);
        const done: string[] = [];
        for (const w of open) {
          if (envelopes.some((e) => answers(w, e)) && remove(cellId, w.waitingFor)) done.push(w.waitingFor);
        }
        return done;
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
