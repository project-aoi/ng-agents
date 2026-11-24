import {
  createEnvelope,
  all, get, run, inboxAddr, newId,
  KERNEL_FROM,
  PAYLOAD,
  withTx,
  type Envelope,
  type StalledCheckPayload,
} from "@ng/protocol";
import { isProjectRoot, type KernelCore } from "./core";

/** Wakes a monitored cell once per loss of progress and correlates unanswered waits with a decision. */
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
    return cells.list({status:["active"]}).filter(c => {
      if (c.spec.stallPolicy !== "monitor" && !waiting.has(c.id)) return false;
      const ancestors = cells.ancestors(c.id);
      return !ancestors.some(a => a.status === "paused") &&
        (c.spec.stallPolicy === "monitor" || !ancestors.some(a => a.spec.stallPolicy === "monitor"));
    });
  }
  function record(cellId: string) {
    return get<{since: number; notified_at: number | null; wake_envelope_id: string}>(db, "SELECT since,notified_at,wake_envelope_id FROM cell_stalls WHERE cell_id=?", [cellId]);
  }
  function clearStall(cellId: string, since: number) {
    withTx(db, () => {
      const cancelGroup = `${cellId}:stalled:${since}`;
      for (const target of new Set([cellId, core.deskCellId])) {
        if (cells.get(target)) inbox.cancelScheduledSync({cellId: target, cancelGroup});
      }
      run(db, "DELETE FROM cell_stalls WHERE cell_id=?", [cellId]);
    });
  }
  function evaluate(): string[] {
    const stalled: string[] = [];
    const monitoredCells = monitored();
    const active = new Set(monitoredCells.map(c => c.id));
    // A local check deferred to a live desk wake must be eligible again if that wake
    // settles without creating a card or is cancelled. A genuinely new stall gets a new id.
    run(db, `DELETE FROM cell_stalls WHERE deferred_to IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM inbox_messages m WHERE m.cell_id=? AND m.envelope_id=cell_stalls.deferred_to
        AND m.status IN ('pending','claimed'))`, [core.deskCellId]);
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
        const wakeId = newId("stall", clock);
        const payload: StalledCheckPayload = { projectCellId: cellId, stalledSince: since, detail: report.detail };
        inbox.enqueueSync(
          target.id,
          createEnvelope<StalledCheckPayload>(
            {
              id: wakeId,
              from: KERNEL_FROM.stall,
              principalId: core.ownerPrincipal,
              kind: "event",
              type: PAYLOAD.stalledCheck,
              payload,
              expectedEpoch: target.epoch,
            },
            clock,
          ),
          { deliverAt: now + core.stallGraceMs, cancelGroup: `${cellId}:stalled:${since}` },
        );
        run(db,"INSERT OR REPLACE INTO cell_stalls(cell_id,since,notified_at,wake_envelope_id) VALUES(?,?,?,?)",[cellId,since,now,wakeId]);
      });
    }
    return stalled;
  }

  interface WaitRef { cellId: string; waitId: string; registrationId: string | null }
  interface Incident { incident_id: string; cause_key: string; wake_envelope_id: string | null; escalation_id: string | null; wait_ids: string }
  function sameWait(left: WaitRef, right: WaitRef): boolean {
    return left.cellId === right.cellId && left.waitId === right.waitId && left.registrationId === right.registrationId;
  }
  function incident(key: string, waits: WaitRef[]): Incident | undefined {
    for (const row of all<Incident>(db, "SELECT * FROM stall_incidents WHERE cause_key=?", [key])) {
      if (row.escalation_id) {
        const status = core.humanItems.get(row.escalation_id)?.status;
        if (status !== "pending" && status !== "snoozed") {
          run(db, "DELETE FROM stall_incidents WHERE incident_id=?", [row.incident_id]);
          continue;
        }
      }
      const previous = JSON.parse(row.wait_ids) as WaitRef[];
      if ((!previous.length && !waits.length) || (previous.length === waits.length && previous.every(w => waits.some(other => sameWait(w, other))))) return row;
    }
  }

  function escalate(key: string, projects: string[], waits: WaitRef[], issuer: string) {
    withTx(db, () => {
      const existing = incident(key, waits);
      if (existing?.escalation_id) return;
      const id = existing?.incident_id ?? newId("incident", clock);
      const card = core.humanItems.create({
        title: "后台仍在等待下一步",
        description: waits.length
          ? [...new Set(waits.map(w => cells.get(w.cellId)?.title?.trim() || "后台任务"))].map(title => `${title}仍在等答复，请确认接下来怎么做。`).join("\n")
          : "后台已自查一次，仍没有可以推进的下一步。",
        relatedProjectIds: projects, subjectKey: `kernel:stalled:${key}:${id}`, options: [{id:"reply", label:"回复后台", effect:"reply", input:{mode:"optional"}}],
      }, issuer, undefined, "kernel:stall");
      run(db, `INSERT INTO stall_incidents(incident_id, cause_key, wait_ids, escalation_id, updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(incident_id) DO UPDATE SET escalation_id=excluded.escalation_id,wait_ids=excluded.wait_ids,updated_at=excluded.updated_at`,
        [id,key,JSON.stringify(waits),card.id,clock.now()]);
    });
  }

  function afterRun(cellId: string, consumed: readonly Envelope[]) {
    for (const env of consumed) {
      // Once dequeued, the wake no longer owns the wait. Re-evaluate the remaining
      // registrations below and create an escalation only for those still uncovered.
      if (env.type === PAYLOAD.arbitrationUnanswered)
        run(db, "DELETE FROM stall_incidents WHERE wake_envelope_id=? AND escalation_id IS NULL", [env.id]);
      if (env.type === PAYLOAD.stalledCheck) {
        const p = env.payload as StalledCheckPayload;
        if (record(p.projectCellId)?.wake_envelope_id !== env.id || !core.readModel.anchorsOf(p.projectCellId).stalled) continue;
        const active = [p.projectCellId, ...cells.descendants(p.projectCellId).map(c => c.id)].filter(id => cells.isActiveInTree(id));
        const waits = core.waits.list(active);
        const activeIncidents = all<Incident>(db, `SELECT i.* FROM stall_incidents i
          WHERE EXISTS (SELECT 1 FROM human_items h WHERE h.action_id=i.escalation_id AND h.disposition='pending')
             OR EXISTS (SELECT 1 FROM inbox_messages m WHERE m.cell_id=? AND m.envelope_id=i.wake_envelope_id AND m.status IN ('pending','claimed'))`,
          [core.deskCellId]);
        const pending = activeIncidents.find(i => i.wake_envelope_id && !i.escalation_id &&
          (JSON.parse(i.wait_ids) as WaitRef[]).some(previous => waits.some(w => sameWait(w, previous))));
        if (pending) {
          run(db, "UPDATE cell_stalls SET deferred_to=? WHERE cell_id=? AND wake_envelope_id=?", [pending.wake_envelope_id, p.projectCellId, env.id]);
          continue;
        }
        const covered = activeIncidents.flatMap(i => JSON.parse(i.wait_ids) as WaitRef[]);
        const uncovered = waits.filter(w => !covered.some(other => sameWait(w, other)));
        if (waits.length && !uncovered.length) continue;
        const holder=cells.require(p.projectCellId);
        const project=[holder,...cells.ancestors(holder.id)].find(c=>isProjectRoot(core.registry, c));
        escalate(env.id, project ? [project.id] : [], uncovered, holder.id);
        continue;
      }
      if (cellId !== core.deskCellId || (env.type !== PAYLOAD.approvalResolved && env.type !== PAYLOAD.arbitrationUnanswered)) continue;
      const p = env.payload as { actionId?:string; causeKey?:string; relatedProjectIds?:string[]; waiters?:WaitRef[] };
      const item = p.actionId ? core.humanItems.get(p.actionId) : undefined;
      const projects = p.relatedProjectIds ?? item?.relatedProjectIds ?? [];
      if (p.actionId && run(db, "DELETE FROM stall_incidents WHERE escalation_id=?", [p.actionId]).changes) continue;
      const key = p.causeKey ?? item?.subjectKey;
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
          return !refs.some(Boolean) && w.refId === null && w.waitId === w.waitingFor && outstanding.filter(x => x.cellId === w.cellId).length === 1;
        });
      });
      if (!remaining.length) continue;
      // This is the desk's own turn ending: that it is busy again already is no answer to these waiters.
      const covered = new Set(core.readModel.groundedWaits(remaining, new Set(), { afterTurn: true }));
      const uncovered = remaining.filter(w => !covered.has(w));
      if (!uncovered.length) continue;
      const affected = [...new Set(uncovered.flatMap(w => [cells.require(w.cellId), ...cells.ancestors(w.cellId)].filter(c => isProjectRoot(core.registry, c)).map(c => c.id)))];
      const prior = incident(key, uncovered);
      if (prior?.escalation_id) continue;
      if (env.type === PAYLOAD.arbitrationUnanswered) { escalate(key, affected, uncovered, cellId); continue; }
      if (prior?.wake_envelope_id) {
        if (inbox.listMessagesSync({cellId, envelopeId:prior.wake_envelope_id, status:["pending","claimed"]}).length) continue;
        run(db, "DELETE FROM stall_incidents WHERE incident_id=?", [prior.incident_id]);
      }
      const wake = createEnvelope({from:KERNEL_FROM.stall, principalId:core.ownerPrincipal, kind:"event", type:PAYLOAD.arbitrationUnanswered,
        expectedEpoch:cells.require(cellId).epoch, payload:{causeKey:key,waiters:uncovered.map(({cellId,waitId,registrationId}) => ({cellId,waitId,registrationId}))}},clock);
      withTx(db, () => {
        inbox.enqueueSync(cellId,wake);
        run(db, `INSERT INTO stall_incidents(incident_id,cause_key,wait_ids,wake_envelope_id,updated_at) VALUES(?,?,?,?,?)`,
          [newId("incident",clock),key,JSON.stringify(uncovered),wake.id,clock.now()]);
      });
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
        if (record(p.projectCellId)?.wake_envelope_id !== e.id) return false;
        return core.readModel.anchorsOf(p.projectCellId).stalled;
      });
    },
    start() {
      if (running) return;
      running = true;
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
