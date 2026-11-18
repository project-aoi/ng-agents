import {
  createEnvelope,
  gtdKeys,
  KERNEL_FROM,
  PAYLOAD,
  withTx,
  type Envelope,
  type ProjectRecord,
  type StalledCheckPayload,
} from "@ng/protocol";
import type { KernelCore } from "./core";

/**
 * docs/05 guard 2 — "no unmarked dangling task". An *active* project (a cell holding `gtd:project` with lifecycle
 * "active", not paused) must always have at least one of the five anchors somewhere in its subtree (see
 * ReadModel.anchorsOf). When it has none:
 *
 * - `stalledSince` is stamped on its record (Radar shows it), and
 * - exactly one `kernel.stalled_check` is sent to the project cell (to the desk when the project cell is closed),
 *   due after a short grace period and re-checked at delivery, and `stalledNotifiedAt` is stamped.
 *
 * The check itself is never an anchor: neither the pending stalled_check message nor a Run that only it started
 * counts. So a model that wakes, does nothing useful and ends leaves the project stalled *and notified* — no second
 * wake-up is ever sent for the same stall (no token-burning loop). Both stamps are cleared the moment a real anchor
 * returns, which re-arms the single notification for the next stall.
 */
export interface StallMonitor {
  /** Something that can create or remove an anchor happened; evaluate soon (coalesced, tracked by idle()). */
  poke(): void;
  /** Evaluate now. Returns the project cells that are stalled after this pass. */
  evaluate(): string[];
  /** At delivery: is the project these checks are about still without an anchor? */
  stillStalled(checks: readonly Envelope[]): boolean;
  start(): void;
  stop(): void;
}

export function createStallMonitor(core: KernelCore): StallMonitor {
  const { context, cells, inbox, clock, bus, db } = core;
  let scheduled = false;
  let running = false;
  const unsubscribe: Array<() => void> = [];

  function projects(): Array<{ cellId: string; record: ProjectRecord }> {
    return context
      .queryStateSync({ keyPrefix: gtdKeys.project })
      .filter((e) => e.key === gtdKeys.project && e.value !== null && typeof e.value === "object")
      .map((e) => ({ cellId: e.cellId, record: e.value as ProjectRecord }));
  }

  function patch(cellId: string, record: ProjectRecord, change: Partial<ProjectRecord>, drop: Array<keyof ProjectRecord> = []): void {
    const next: ProjectRecord = { ...record, ...change };
    for (const k of drop) delete next[k];
    context.commitSync(cellId, { statePatches: { [gtdKeys.project]: next } });
  }

  function evaluate(): string[] {
    const stalled: string[] = [];
    for (const { cellId, record } of projects()) {
      const cell = cells.get(cellId);
      if (!cell) continue;
      const report = core.readModel.anchorsOf(cellId);
      if (!report.stalled) {
        if (record.stalledSince !== undefined || record.stalledNotifiedAt !== undefined) {
          // The stall is over: its notice, if still on the way, is withdrawn with it.
          if (record.stalledSince !== undefined) {
            const noticeId = `${cellId}:stalled:${record.stalledSince}`;
            for (const target of new Set([cellId, core.deskCellId])) if (cells.get(target)) inbox.cancelScheduledSync({ cellId: target, envelopeId: noticeId });
          }
          patch(cellId, record, {}, ["stalledSince", "stalledNotifiedAt"]);
        }
        continue;
      }
      stalled.push(cellId);
      const now = clock.now();
      withTx(db, () => {
        const since = record.stalledSince ?? now;
        if (record.stalledNotifiedAt !== undefined) {
          if (record.stalledSince === undefined) patch(cellId, record, { stalledSince: since });
          return;
        }
        // The project cell decides what its project needs; a project whose cell is gone is the desk's to sort out.
        const target = cell.status !== "closed" ? cell : cells.get(core.deskCellId);
        if (!target || target.status === "closed") {
          patch(cellId, record, { stalledSince: since });
          return;
        }
        const payload: StalledCheckPayload = { projectCellId: cellId, stalledSince: since, detail: report.detail };
        inbox.enqueueSync(
          target.id,
          createEnvelope<StalledCheckPayload>(
            {
              // One per stall: the id carries when the stall began.
              id: `${cellId}:stalled:${since}`,
              from: KERNEL_FROM.stall,
              principalId: core.ownerPrincipal,
              kind: "event",
              type: PAYLOAD.stalledCheck,
              payload,
              expectedEpoch: target.epoch,
            },
            clock,
          ),
          { deliverAt: now + core.stallGraceMs },
        );
        patch(cellId, record, { stalledSince: since, stalledNotifiedAt: now });
      });
    }
    return stalled;
  }

  function poke(): void {
    if (scheduled || !running) return;
    scheduled = true;
    void core.track(
      Promise.resolve().then(() => {
        scheduled = false;
        if (!running) return;
        try {
          evaluate();
        } catch (err) {
          core.onError(err, "stall check");
        }
      }),
    );
  }

  return {
    poke,
    evaluate,
    stillStalled(checks) {
      return checks.some((e) => {
        const p = e.payload as StalledCheckPayload;
        const rec = context.readStateSync<ProjectRecord>(p.projectCellId, gtdKeys.project);
        if (!rec || rec.lifecycle !== "active") return false;
        return core.readModel.anchorsOf(p.projectCellId).stalled;
      });
    },
    start() {
      if (running) return;
      running = true;
      // Everything that can add or remove an anchor. State changes matter for the GTD records themselves (a human
      // action ticked off, a lifecycle change); our own stamps on gtd:project re-enter once and change nothing.
      unsubscribe.push(
        bus.on("run.finished", poke),
        bus.on("cell.changed", poke),
        bus.on("job.changed", (e) => {
          if (e.state !== "running") poke();
        }),
        bus.on("approval.changed", poke),
        bus.on("state.changed", (e) => {
          if (e.keys.some((k) => k.startsWith(gtdKeys.actionPrefix) || k === gtdKeys.project)) poke();
        }),
      );
      poke();
    },
    stop() {
      running = false;
      for (const u of unsubscribe.splice(0)) u();
    },
  };
}
