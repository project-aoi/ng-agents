import {
  createEnvelope,
  all, get, run, inboxAddr,
  KERNEL_FROM,
  PAYLOAD,
  withTx,
  type Envelope,
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
  afterRun(cellId: string, consumed: readonly Envelope[]): void;
  stillStalled(checks: readonly Envelope[]): boolean;
  start(): void;
  stop(): void;
}

export function createStallMonitor(core: KernelCore): StallMonitor {
  const { cells, inbox, clock, bus, db } = core;
  let scheduled = false;
  let running = false;
  const unsubscribe: Array<() => void> = [];

  const hasPausedAncestor = (id: string) => cells.ancestors(id).some(a => a.status === "paused");

  function monitored() {
    const waiting = new Set(core.waits.list().filter(w => w.waitingFor.startsWith("inbox:")).map(w => w.cellId));
    return cells.list().filter(c => {
      if (c.spec.stallPolicy !== "monitor" && (c.status !== "active" || !waiting.has(c.id))) return false;
      const ancestors = cells.ancestors(c.id);
      return !ancestors.some(a => a.status === "paused") &&
        (c.spec.stallPolicy === "monitor" || !ancestors.some(a => a.spec.stallPolicy === "monitor"));
    });
  }
  function record(cellId: string) {
    return get<{since: number; notified_at: number | null}>(db, "SELECT since,notified_at FROM cell_stalls WHERE cell_id=?", [cellId]);
  }
  function clearStall(cellId: string, since: number) {
    withTx(db, () => {
      const envelopeId = `${cellId}:stalled:${since}`;
      for (const target of new Set([cellId, core.deskCellId])) {
        if (cells.get(target)) inbox.cancelScheduledSync({cellId: target, envelopeId});
      }
      run(db, "DELETE FROM cell_stalls WHERE cell_id=?", [cellId]);
    });
  }
  function evaluate(): string[] {
    const stalled: string[] = [];
    const monitoredCells = monitored();
    const active = new Set(monitoredCells.map(c => c.id));
    for (const saved of all<{cell_id: string; since: number}>(db, "SELECT cell_id,since FROM cell_stalls")) {
      if (!active.has(saved.cell_id)) clearStall(saved.cell_id, saved.since);
    }
    for (const cell of monitoredCells) {
      const cellId = cell.id;
      const report = core.readModel.anchorsOf(cellId);
      const saved = record(cellId);
      if (!report.stalled) {
        if (saved) clearStall(cellId, saved.since);
        continue;
      }
      stalled.push(cellId);
      const now=clock.now();
      withTx(db,()=>{
        if (saved?.notified_at!=null) return;
        const since=saved?.since ?? now;
        const target=cell;
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
        run(db,"INSERT OR REPLACE INTO cell_stalls(cell_id,since,notified_at) VALUES(?,?,?)",[cellId,since,now]);
      });
    }
    return stalled;
  }

  interface WaitRef { cellId: string; waitId: string; registrationId: string | null }
  interface Incident { wake_envelope_id: string | null; escalation_id: string | null; wait_ids: string }
  function sameWait(left: WaitRef, right: WaitRef): boolean {
    return left.cellId === right.cellId && left.waitId === right.waitId && left.registrationId === right.registrationId;
  }
  function incident(key: string, current?: WaitRef[]) {
    const row = get<Incident>(db, "SELECT * FROM stall_incidents WHERE cause_key=?", [key]);
    if (!row || !current?.length) return row;
    if ((JSON.parse(row.wait_ids) as WaitRef[]).some(w => current.some(other => sameWait(w, other)))) return row;
    const card = row.escalation_id && core.humanItems.get(row.escalation_id);
    if (card && ["pending","snoozed","unknown"].includes(card.status)) return row;
    run(db, "DELETE FROM stall_incidents WHERE cause_key=?", [key]);
    return undefined;
  }
  function escalate(key: string, projects: string[], waits: WaitRef[], issuer: string) {
    if (incident(key, waits)?.escalation_id) return;
    const card = core.humanItems.create({
      title: "后台仍在等待下一步", description: waits.length ? waits.map(w => `${w.cellId} 等待 ${w.waitId}`).join("\n") : "后台已自查一次，仍没有可以推进的下一步。",
      relatedProjectIds: projects, subjectKey: `kernel:stalled:${key}`, options: [{id:"reply", label:"回复后台", effect:"reply", input:{mode:"optional"}}],
    }, issuer, undefined, "kernel:stall");
    run(db, `INSERT INTO stall_incidents(cause_key, wait_ids, escalation_id, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(cause_key) DO UPDATE SET escalation_id=excluded.escalation_id,wait_ids=excluded.wait_ids,updated_at=excluded.updated_at`, [key,JSON.stringify(waits),card.id,clock.now()]);
  }

  function afterRun(cellId: string, consumed: readonly Envelope[]) {
    for (const env of consumed) {
      if (env.type === PAYLOAD.stalledCheck) {
        const p = env.payload as StalledCheckPayload;
        if (!core.readModel.anchorsOf(p.projectCellId).stalled) continue;
        const waits = core.waits.list([p.projectCellId,...cells.descendants(p.projectCellId).map(c=>c.id)]);
        const matched = all<{cause_key:string;wait_ids:string}>(db,"SELECT cause_key,wait_ids FROM stall_incidents WHERE wait_ids <> '[]'")
          .find(r => (JSON.parse(r.wait_ids) as WaitRef[]).some(w => waits.some(x => sameWait(x,w))));
        if (matched?.cause_key && incident(matched.cause_key)?.wake_envelope_id) continue;
        const holder=cells.require(p.projectCellId);
        const project=[holder,...cells.ancestors(holder.id)].find(c=>c.preset==="project");
        escalate(matched?.cause_key ?? env.id, project ? [project.id] : [], waits, holder.id);
        continue;
      }
      if (cellId !== core.deskCellId || (env.type !== PAYLOAD.approvalResolved && env.type !== PAYLOAD.arbitrationUnanswered)) continue;
      const p = env.payload as { actionId?:string; causeKey?:string; relatedProjectIds?:string[]; waiters?:WaitRef[] };
      const item = p.actionId ? core.humanItems.get(p.actionId) : undefined;
      const projects = p.relatedProjectIds ?? item?.relatedProjectIds ?? [];
      const previousCause = p.actionId ? get<{cause_key:string}>(db, "SELECT cause_key FROM stall_incidents WHERE escalation_id=?", [p.actionId]) : undefined;
      const key = p.causeKey ?? previousCause?.cause_key ?? item?.subjectKey;
      if (!key || (!projects.length && !p.waiters?.length)) continue;
      const outstanding = core.waits.list().filter(w => w.waitingFor === inboxAddr(cellId) && cells.get(w.cellId)?.status === "active" && !hasPausedAncestor(w.cellId) &&
        (p.waiters ? p.waiters.some(x => sameWait(x,w)) :
          projects.some(id => w.cellId===id || cells.ancestors(w.cellId).some(c => c.id===id))));
      const remaining = outstanding.filter(w => {
        const messages = inbox.listMessagesSync({cellId:w.cellId,status:["pending","claimed"]});
        return !messages.some(m => {
          if (m.envelope.from !== inboxAddr(cellId) || m.envelope.delivery === "silent_inject" || m.createdAt < w.createdAt) return false;
          const payload = m.envelope.payload as {replyToId?: string; data?: {refId?: string; waitId?: string}};
          const refs = [payload.replyToId, payload.data?.refId, payload.data?.waitId];
          if (refs.includes(w.waitId) || (w.refId !== null && refs.includes(w.refId))) return true;
          return !payload.data?.refId && !payload.data?.waitId && outstanding.filter(x => x.cellId === w.cellId).length === 1;
        });
      });
      if (!remaining.length) continue;
      const covered = new Set(core.readModel.groundedWaits(remaining, new Set()));
      const uncovered = remaining.filter(w => !covered.has(w));
      if (!uncovered.length) continue;
      const affected = [...new Set(uncovered.flatMap(w => [cells.require(w.cellId), ...cells.ancestors(w.cellId)].filter(c => c.preset==="project").map(c => c.id)))];
      const prior = incident(key, uncovered);
      if (prior?.escalation_id) continue;
      if (env.type === PAYLOAD.arbitrationUnanswered) { escalate(key, affected, uncovered, cellId); continue; }
      if (prior?.wake_envelope_id) continue;
      const wake = createEnvelope({from:KERNEL_FROM.stall, principalId:core.ownerPrincipal, kind:"event", type:PAYLOAD.arbitrationUnanswered,
        expectedEpoch:cells.require(cellId).epoch, payload:{causeKey:key,waiters:uncovered.map(({cellId,waitId,registrationId}) => ({cellId,waitId,registrationId}))}},clock);
      inbox.enqueueSync(cellId,wake);
      run(db,`INSERT INTO stall_incidents(cause_key,wait_ids,wake_envelope_id,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(cause_key) DO UPDATE SET wait_ids=excluded.wait_ids,wake_envelope_id=excluded.wake_envelope_id,updated_at=excluded.updated_at`,[key,JSON.stringify(uncovered),wake.id,clock.now()]);
    }
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
    poke, afterRun,
    evaluate,
    stillStalled(checks) {
      return checks.some((e) => {
        const p = e.payload as StalledCheckPayload;
        if (record(p.projectCellId)?.since !== p.stalledSince) return false;
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
        bus.on("state.changed", poke),
      );
      poke();
    },
    stop() {
      running = false;
      for (const u of unsubscribe.splice(0)) u();
    },
  };
}
