import { attenuateBounds, meetBounds } from "@ng/gate";
import { CLI_FORK_SESSION_KEY, CLI_SESSION_KEY } from "@ng/loop";
import {
  afterCommit,
  requirePrincipalId,
  all,
  get,
  cellPrincipal,
  createEnvelope,
  finalResultEnvelopeId,
  inboxAddr,
  isLeafLifetime,
  CELL_TURN_KEY,
  KERNEL_FROM,
  makeBounds,
  newId,
  NgError,
  parsePrincipal,
  PAYLOAD,
  run,
  serializeBounds,
  stableStringify,
  timerFrom,
  toJson,
  withTx,
  type BoundsInit,
  type CellRecord,
  type CellResultPayload,
  type CellSpec,
  type CellTaskPayload,
  type CloseReason,
  type InboxAddr,
  type PolicyBounds,
  type ScheduleRule,
  type TimerFiredPayload,
} from "@ng/protocol";
import { isProjectRoot, type KernelCore } from "./core";
import { jsonSafeBounds, resolveSpec, scheduleEnvelopeId, validateSpec } from "./spec";
import type { ActorOptions, CellSpecInput, CloseActorOptions, CloseResult, RootCellOptions, SpawnOptions } from "./types";
import { assertDirectory, normalizeCwd } from "./workdir";

export interface Lifecycle {
  createRootCell(spec: CellSpecInput, opts: RootCellOptions): CellRecord;
  ensureRootCell(spec: CellSpecInput & { id: string }, opts: RootCellOptions): CellRecord;
  spawnCell(parentId: string, spec: CellSpecInput, initialPayload: unknown, opts: SpawnOptions): InboxAddr;
  updateCell(cellId: string, patch: Partial<CellSpec>, opts: ActorOptions): CellRecord;
  /** The transactional cascade; returns the ids it closed (empty if already closed). Cleanup is the caller's. */
  closeCellSync(cellId: string, reason: CloseReason, opts: CloseOptions): string[];
  closeCell(cellId: string, reason: CloseReason | undefined, opts: CloseActorOptions): Promise<CloseResult>;
  /** Abort Runs and stop the background jobs of cells that were just closed. Nothing on disk is touched. */
  cleaningUp(cellId: string): boolean;
  cleanupPaused(ids: string[]): Promise<void>;
  cleanupClosed(cellIds: readonly string[]): Promise<void>;
  /** Deactivate a cell's watches (all, or one cancelGroup's). */
  deactivateWatches(cellId: string, cancelGroup?: string): number;
  /**
   * Bring a closed leaf back so a message can reach it: `active` again at its current epoch, authority reinstated,
   * its CLI session still on record — the next Run resumes it. Only below a parent that is itself still open; a cell
   * archived with a finished project stays archived (false). Watches and timers are not restored: the message that
   * prompted this is what wakes it. Call inside the transaction that enqueues that message.
   */
  reopenProject(cellId: string, principalId: string, words?: ReopenWords): Promise<string[]>;
  waitForClosedProject(id:string):Promise<number>;
  reopenProjectSync(id:string,principalId:string,epoch:number,words?:ReopenWords):string[];
  reopenLeafSync(cellId: string): boolean;
}

/** closeCellSync options. `internal`: the kernel itself settles the cell (drain-then-close, complete_self) — no actor check. */
export interface CloseOptions extends CloseActorOptions {
  internal?: boolean;
}

const UPDATABLE = new Set(["title", "meta", "processor", "bounds", "watches", "schedules","cwd"]);
/** What a cell may change about itself (docs/05 §5.1.2): how it is woken and how it is labelled — never what it may do. */
const SELF_UPDATABLE = new Set(["title", "meta", "watches", "schedules","cwd"]);

function definedEntries<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function sameBounds(a: PolicyBounds, b: PolicyBounds): boolean {
  return stableStringify(serializeBounds(a)) === stableStringify(serializeBounds(b));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function createLifecycle(core: KernelCore): Lifecycle {
  const { db, cells, inbox, gate, context, registry, bus, clock } = core;

  // ---------- principals ----------

  function actorKind(principalId: string): { kind: "owner" } | { kind: "agent"; agentId: string } | { kind: "cell"; cellId: string } {
    const p = parsePrincipal(principalId, core.ownerPrincipal);
    if (p.kind === "owner") return { kind: "owner" };
    if (p.kind === "agent") return { kind: "agent", agentId: p.agentId };
    if (p.kind === "cell") return { kind: "cell", cellId: p.cellId };
    throw new NgError("bounds_violation", `principal "${principalId}" may not manage cells`);
  }

  /** The owner or an external main agent; never a background cell (external principals are refused by actorKind). */
  function assertControlPlane(principalId: string, what: string): void {
    if (actorKind(principalId).kind === "cell") throw new NgError("bounds_violation", `only the owner or an agent on the control plane may ${what}`);
  }

  function isStrictAncestor(ancestorId: string, cellId: string): boolean {
    return ancestorId !== cellId && cells.ancestors(cellId).some((a) => a.id === ancestorId);
  }

  /** Owner and control-plane agent: any cell. `cell:X`: X's strict descendants, and X itself where `self` is allowed. */
  function assertManages(principalId: string, target: CellRecord, what: string, self = false): "owner" | "agent" | "ancestor" | "self" {
    const actor = actorKind(principalId);
    if (actor.kind === "owner") return "owner";
    if (actor.kind === "agent") return "agent";
    if (isStrictAncestor(actor.cellId, target.id)) return "ancestor";
    if (self && actor.cellId === target.id) return "self";
    throw new NgError("bounds_violation", `${what}: cell "${actor.cellId}" may only manage its own descendants, not "${target.id}"`);
  }

  // ---------- materialization ----------

  function insertWatches(cellId: string, watches: NonNullable<CellSpec["watches"]>): void {
    const now = clock.now();
    for (const w of watches) {
      const thread = typeof w.threadOrFilter["thread"] === "string" ? (w.threadOrFilter["thread"] as string) : null;
      run(db, "INSERT INTO cell_watches (cell_id, thread, filter, cancel_group, active, created_at, coalesce_ms) VALUES (?, ?, ?, ?, 1, ?, ?)", [
        cellId,
        thread,
        toJson(w.threadOrFilter),
        w.cancelGroup ?? null,
        now,
        w.coalesceMs !== undefined && w.coalesceMs > 0 ? Math.floor(w.coalesceMs) : null,
      ]);
    }
  }

  function deactivateWatches(cellId: string, cancelGroup?: string): number {
    return cancelGroup === undefined
      ? run(db, "UPDATE cell_watches SET active = 0 WHERE cell_id = ? AND active = 1", [cellId]).changes
      : run(db, "UPDATE cell_watches SET active = 0 WHERE cell_id = ? AND active = 1 AND cancel_group = ?", [cellId, cancelGroup]).changes;
  }

  /** Ids of a schedule rule's live rows/schedules (a re-added deliverAt rule gets a `~n` suffix). */
  function liveScheduleIds(cellId: string, base: string): string[] {
    const matches = (id: string) => id === base || id.startsWith(`${base}~`);
    const rows = inbox.listMessagesSync({ cellId, status: ["pending"], type: PAYLOAD.timerFired }).map((m) => m.envelope.id).filter(matches);
    const scheds = inbox.listSchedulesSync({ cellId, activeOnly: true }).map((s) => s.template.id).filter(matches);
    return [...new Set([...rows, ...scheds])];
  }

  function enqueueSchedule(cell: CellRecord, rule: ScheduleRule, index: number): void {
    const base = scheduleEnvelopeId(cell.id, rule);
    let id = base;
    if (rule.deliverAt !== undefined) {
      // A deliverAt row id can never be reused (dedupe), so a rule that comes back after removal gets a fresh id.
      const used = inbox.listMessagesSync({ cellId: cell.id, type: PAYLOAD.timerFired }).filter((m) => m.envelope.id === base || m.envelope.id.startsWith(`${base}~`)).length;
      if (used > 0) id = `${base}~${used}`;
    }
    const env = createEnvelope<TimerFiredPayload>(
      {
        id,
        from: timerFrom(cell.id),
        principalId: cellPrincipal(cell.id),
        kind: "event",
        type: PAYLOAD.timerFired,
        payload: { label: `schedule:${index}` },
        expectedEpoch: cell.epoch,
      },
      clock,
    );
    inbox.enqueueSync(cell.id, env, rule);
  }

  function insertCell(init: { id: string; parentId: string | null; spec: CellSpec; bounds: PolicyBounds; principalId: string }): CellRecord {
    const rec = cells.insert({
      id: init.id,
      parentId: init.parentId,
      preset: init.spec.preset ?? null,
      title: init.spec.title ?? null,
      spec: init.spec,
      bounds: init.bounds,
      principalId: init.principalId,
    });
    if (rec.preset) registry.presets.get(rec.preset)?.onCellCreated?.(rec, context, clock);
    insertWatches(rec.id, init.spec.watches ?? []);
    (init.spec.schedules ?? []).forEach((rule, i) => enqueueSchedule(rec, rule, i));
    afterCommit(db, () => bus.emit("cell.changed", { cellId: rec.id, change: "created", status: rec.status, epoch: rec.epoch }));
    return rec;
  }

  // ---------- bounds ----------

  function rootBounds(init: BoundsInit | undefined): PolicyBounds {
    return makeBounds({ ...core.rootBounds, ...definedEntries(init ?? {}) });
  }

  function updatedBounds(cell: CellRecord, req: Partial<PolicyBounds>, isOwner: boolean): PolicyBounds {
    const merged = { ...cell.bounds, ...definedEntries(req) } as Partial<PolicyBounds>;
    if (!cell.parentId) {
      if (!isOwner) throw new NgError("bounds_violation", "only the owner may change a root cell's bounds");
      return makeBounds(merged as BoundsInit);
    }
    const parent = cells.require(cell.parentId);
    const next = attenuateBounds(parent.bounds, parent.id, merged);
    return isOwner ? next : meetBounds(next, cell.bounds);
  }

  /** Refresh inherited prefixes and tightened bounds in parent-first order. */
  function refreshDescendants(rootId: string, rootBoundsChanged: boolean): void {
    const queue = [{ id: rootId, narrowed: rootBoundsChanged }];
    for (const entry of queue) {
      const parent = cells.require(entry.id);
      for (const child of cells.children(parent.id, { status: ["active", "paused"] })) {
        let narrowed = false;
        if (entry.narrowed) {
          let next: PolicyBounds;
          try {
            next = meetBounds(attenuateBounds(parent.bounds, parent.id, child.bounds), child.bounds);
          } catch {
            next = meetBounds(child.bounds, { ...parent.bounds, canSendTo: [...parent.bounds.canSendTo, inboxAddr(parent.id)], maxDepth: 0 });
          }
          narrowed = !sameBounds(next, child.bounds);
          if (narrowed) {
            cells.update(child.id, { bounds: next });
            afterCommit(db, () => bus.emit("cell.changed", { cellId: child.id, change: "updated" }));
          }
        }
        if (narrowed || child.spec.fork?.fromCellId === parent.id) {
          context.refreshPrefixSync(child.id);
          queue.push({ id: child.id, narrowed });
        }
      }
    }
  }

  // ---------- create ----------

  function createRootCell(spec: CellSpecInput, opts: RootCellOptions): CellRecord {
    const principalId = requirePrincipalId(opts?.principalId);
    assertControlPlane(principalId, "create root cells");
    return withTx(db, () => {
      const id = spec.id ?? newId("cell", clock);
      if (cells.get(id)) throw new NgError("duplicate", `cell "${id}" already exists`);
      const { spec: resolved } = resolveSpec(registry, spec, null);
      validateSpec(registry, resolved, core.cliRunners);
      if (resolved.cwd !== undefined) assertDirectory(resolved.cwd, "cwd");
      const bounds = rootBounds(opts.bounds);
      if (isLeafLifetime(resolved.lifetime)) bounds.maxDepth = 0;
      delete resolved.bounds;
      return insertCell({ id, parentId: null, spec: { ...resolved, id }, bounds, principalId });
    });
  }

  function ensureRootCell(spec: CellSpecInput & { id: string }, opts: RootCellOptions): CellRecord {
    assertControlPlane(requirePrincipalId(opts?.principalId), "initialize root cells");
    return withTx(db, () => cells.get(spec.id) ?? createRootCell(spec, opts));
  }

  function cellTask(parentId: string, title: string | undefined, initial: unknown): CellTaskPayload {
    const base: CellTaskPayload = { parentCellId: parentId, ...(title ? { title } : {}) };
    if (typeof initial === "string") return { ...base, instruction: initial };
    if (isRecord(initial) && typeof initial["instruction"] === "string") {
      const t = typeof initial["title"] === "string" ? (initial["title"] as string) : title;
      return {
        ...base,
        ...(t ? { title: t } : {}),
        instruction: initial["instruction"] as string,
        ...(initial["input"] !== undefined ? { input: initial["input"] } : {}),
      };
    }
    return { ...base, input: initial };
  }

  function spawnCell(parentId: string, spec: CellSpecInput, initialPayload: unknown, opts: SpawnOptions): InboxAddr {
    const principalId = requirePrincipalId(opts?.principalId);
    return withTx(db, () => {
      const parent = cells.require(parentId);
      const actor = actorKind(principalId);
      if (actor.kind === "cell" && actor.cellId !== parent.id && !isStrictAncestor(actor.cellId, parent.id)) {
        throw new NgError("bounds_violation", `cell "${actor.cellId}" may only spawn children of itself or of its descendants`);
      }
      if (!cells.isActiveInTree(parentId)) throw new NgError("conflict", `cell "${parent.id}" or an ancestor is paused or closed; it cannot have new children`);

      const { spec: resolved, boundsRequest } = resolveSpec(registry, spec, parent);
      if (resolved.preset && registry.presets.get(resolved.preset)?.rootOnly) throw new NgError("bounds_violation", "这个角色只允许作为根任务");
      validateSpec(registry, resolved, core.cliRunners);
      if (parent.bounds.maxDepth < 1) {
        throw new NgError("bounds_violation", `cell "${parent.id}" may not spawn children (maxDepth 0); do the work itself or report to its parent`);
      }
      if (resolved.cwd !== undefined && resolved.cwd !== parent.spec.cwd) assertDirectory(resolved.cwd, "cwd");
      // docs/05 §3.1: the cap is on execution, not on containers. Persistent cells (projects, hubs, sensors), anything
      // paused/parked, and workers that have finished their turn and lie dormant do not take a slot — otherwise sixteen
      // "someday" projects, or sixteen workers that are merely still addressable, would block the next one.
      if (isLeafLifetime(resolved.lifetime)) {
        const busy = core.readModel.busyLeafChildren(parent.id).length;
        if (busy >= parent.bounds.maxConcurrentChildren) {
          throw new NgError(
            "bounds_violation",
            `cell "${parent.id}" already has ${busy} children at work (maxConcurrentChildren ${parent.bounds.maxConcurrentChildren}); wait for one to finish its turn or close one`,
          );
        }
      }
      // Never trust requested bounds: Gate clamps them to the parent's effective bounds.
      const bounds = gate.attenuate(parent.bounds, parent.id, boundsRequest);
      if (isLeafLifetime(resolved.lifetime)) bounds.maxDepth = 0;

      const id = spec.id ?? newId("cell", clock);
      if (cells.get(id)) throw new NgError("duplicate", `cell "${id}" already exists`);
      const stored: CellSpec = { ...resolved, id, parentId: parent.id };
      if (stored.contextMode === "fork_prefix") stored.fork = { fromCellId: parent.id, uptoSeq: context.lastEvidenceSeqSync(parent.id) };
      const rec = insertCell({ id, parentId: parent.id, spec: stored, bounds, principalId });
      if (stored.fork) {
        // A CLI-run parent's agent session: the child's CLI loop forks it instead of replaying the inherited history.
        const parentSession = context.readStateSync(parent.id, CLI_SESSION_KEY);
        if (parentSession && !core.dispatcher.isRunning(parent.id)) context.commitSync(id, { statePatches: { [CLI_FORK_SESSION_KEY]: parentSession } });
      }
      if (initialPayload !== undefined) {
        const task = createEnvelope<CellTaskPayload>(
          {
            id: `${id}:task`,
            from: KERNEL_FROM.spawn,
            principalId,
            kind: "event",
            type: PAYLOAD.cellTask,
            payload: cellTask(parent.id, stored.title, initialPayload),
            expectedEpoch: rec.epoch,
          },
          clock,
        );
        inbox.enqueueSync(id, task);
      }
      return inboxAddr(id);
    });
  }

  // ---------- update ----------

  function updateCell(cellId: string, patch: Partial<CellSpec>, opts: ActorOptions): CellRecord {
    const principalId = requirePrincipalId(opts?.principalId);
    if (!patch || typeof patch !== "object") throw new NgError("invalid_argument", "patch must be an object");
    const given = definedEntries(patch);
    for (const key of Object.keys(given)) {
      if (!UPDATABLE.has(key)) throw new NgError("invalid_argument", `updateCell cannot change "${key}" (allowed: ${[...UPDATABLE].join(", ")})`);
    }
    return withTx(db, () => {
      const cell = cells.require(cellId);
      if (cell.status === "closed") throw new NgError("conflict", `cell "${cellId}" is closed`);
      const by = assertManages(principalId, cell, "updateCell", true);
      if (by === "self") {
        const refused = Object.keys(given).filter((k) => !SELF_UPDATABLE.has(k));
        if (refused.length) throw new NgError("bounds_violation", `a cell may change its own ${[...SELF_UPDATABLE].join(", ")} only, not ${refused.join(", ")}`);
      }
      // Only the owner widens bounds; an agent on the control plane narrows like an ancestor would.
      const isOwner = by === "owner";
      const next: CellSpec = { ...cell.spec };
      let refreshPrefix = false;
      if (given.cwd !== undefined) {
        next.cwd = normalizeCwd(given.cwd);
        assertDirectory(next.cwd, "cwd");
        refreshPrefix = true;
      }
      if (given.title !== undefined) next.title = given.title;
      if (given.meta !== undefined) { next.meta = given.meta; refreshPrefix = true; }
      if (given.processor !== undefined) {
        next.processor = given.processor;
        refreshPrefix = true;
      }
      if (given.watches !== undefined) next.watches = given.watches;
      if (given.schedules !== undefined) next.schedules = given.schedules;
      validateSpec(registry, next, core.cliRunners);

      let bounds = cell.bounds;
      if (given.bounds !== undefined) {
        if (isLeafLifetime(cell.spec.lifetime) && (given.bounds.maxDepth ?? 0) > 0)
          throw new NgError("bounds_violation", `preset "${cell.preset}" has maxDepth 0`);
        bounds = updatedBounds(cell, given.bounds, isOwner);
        next.bounds = jsonSafeBounds({ ...(cell.spec.bounds ?? {}), ...definedEntries(given.bounds) });
        if (!sameBounds(bounds, cell.bounds)) refreshPrefix = true;
      }

      if (given.watches !== undefined) {
        deactivateWatches(cellId);
        insertWatches(cellId, given.watches);
      }
      if (given.schedules !== undefined) {
        const before = new Set((cell.spec.schedules ?? []).map((r) => scheduleEnvelopeId(cellId, r)));
        const after = new Map(given.schedules.map((r, i) => [scheduleEnvelopeId(cellId, r), { r, i }] as const));
        for (const base of before) {
          if (after.has(base)) continue;
          for (const id of liveScheduleIds(cellId, base)) inbox.cancelScheduledSync({ cellId, envelopeId: id });
        }
        for (const [base, { r, i }] of after) if (!before.has(base)) enqueueSchedule(cell, r, i);
      }

      const updated = cells.update(cellId, { spec: next, title: next.title ?? null, bounds });
      if (refreshPrefix) {
        context.refreshPrefixSync(cellId);
        refreshDescendants(cellId, !sameBounds(bounds, cell.bounds));
      }
      afterCommit(db, () => bus.emit("cell.changed", { cellId, change: "updated" }));
      return updated;
    });
  }

  // ---------- close ----------

  /**
   * Has this cell's *final* result — the one the settle transaction delivers when it closes the cell — reached the
   * parent? Earlier interim results of a persistent cell (a project reporting a phase) do not count: when someone else
   * closes such a cell later, its parent must still be told.
   */
  function finalResultDelivered(parentId: string, child: CellRecord): boolean {
    return inbox.listMessagesSync({ cellId: parentId, envelopeId: finalResultEnvelopeId(child.id, child.epoch) }).length > 0;
  }

  function closeCellSync(cellId: string, reason: CloseReason, opts: CloseOptions): string[] {
    const principalId = requirePrincipalId(opts?.principalId);
    if (reason !== "completed" && reason !== "cancelled") throw new NgError("invalid_argument", `invalid close reason "${String(reason)}"`);
    return withTx(db, () => {
      const target = cells.require(cellId);
      // Physical guardrail (BUG-020): root cells (parentId === null, e.g. desk) can never be closed.
      if (target.parentId === null) throw new NgError("bounds_violation", `cannot close root cell "${cellId}"`);
      if (target.status === "closed") return [];
      if (!opts.internal) assertManages(principalId, target, "closeCell");
      const subtree = [target, ...cells.descendants(target.id, { status: ["active", "paused"] })];

      // A parent waiting on this child (a join, the desk's record) must not wait forever when someone else closes it.
      const parent = target.parentId ? cells.get(target.parentId) : undefined;
      if (parent && parent.status !== "closed" && principalId !== cellPrincipal(parent.id) && !finalResultDelivered(parent.id, target)) {
        // A wakeable worker has told its parent about every settled turn already; what is new is only that it is gone.
        const reported = context.readStateSync(target.id, CELL_TURN_KEY) !== null;
        const payload: CellResultPayload = {
          childCellId: target.id,
          status: reason,
          summary: reported ? `Closed (${reason}) by ${principalId}; its turns were already reported.` : `Closed (${reason}) by ${principalId} before it reported a result.`,
          data: { closedBy: principalId, synthetic: true },
          childState: "closed",
        };
        inbox.enqueueSync(
          parent.id,
          createEnvelope<CellResultPayload>(
            {
              id: `${target.id}:${target.epoch}:closed`,
              delivery: opts.parentDelivery ?? "wakeup",
              from: inboxAddr(target.id),
              principalId,
              kind: "result",
              type: PAYLOAD.cellResult,
              payload,
              expectedEpoch: parent.epoch,
            },
            clock,
          ),
        );
      }

      const closed: Array<{ id: string; epoch: number }> = [];
      const closureId = newId("close", clock);
      const working = new Set(core.dispatcher.activeRuns().map((r) => r.cellId));
      for (const c of subtree) {
        const epoch = cells.bumpEpoch(c.id);
        run(db, `INSERT INTO cell_closures(cell_id,epoch,target_id,closure_id,was_revoked)
          VALUES(?,?,?,?,EXISTS(SELECT 1 FROM cells WHERE id=? AND revoked_at IS NOT NULL))`,
          [c.id,epoch,target.id,closureId,c.id]);
        // A worker that had finished its turns and was merely still addressable is archived with its project, not
        // cancelled: nothing of its work was cut short.
        const archived = reason === "completed" && isLeafLifetime(c.spec.lifetime) && !working.has(c.id) && context.readStateSync(c.id, CELL_TURN_KEY) !== null;
        cells.setStatus(c.id, "closed", c.id === target.id || archived ? reason : "cancelled");
        inbox.cancelScheduledSync({ cellId: c.id });
        deactivateWatches(c.id);
        closed.push({ id: c.id, epoch });
      }
      core.waits.dropFor(closed.map((c) => c.id));
      for (const {id} of closed) {
        const closedCell=cells.require(id);
        if (closedCell.preset) registry.presets.get(closedCell.preset)?.onCellClosed?.(closedCell,id===target.id ? reason : "cancelled",context,clock,core);
      }
      core.humanItems.withdrawForClosedCells(closed);
      gate.revokeSync(target.id);
      afterCommit(db, () => {
        void core.track(cleanupClosed(closed.map(c => c.id)));
        for (const c of closed) bus.emit("cell.changed", { cellId: c.id, change: "status", status: "closed", epoch: c.epoch });
      });
      return closed.map((c) => c.id);
    });
  }

  const cleanups = new Map<string, { epoch: number; done: Promise<void> }>();

  const pausedCleanups = new Map<string, Promise<void>>();
  async function cleanupPaused(ids: string[]): Promise<void> {
    await Promise.all(ids.map(id => {
      const previous = pausedCleanups.get(id);
      if (previous) return previous;
      const done = core.workspace.cancelJobsForCell(id).then(() => undefined)
        .catch((err: unknown) => core.onError(err, `stop jobs of paused cell ${id}`))
        .finally(() => {
          pausedCleanups.delete(id);
          if (cells.get(id)?.status === "active") core.dispatcher.notify(id);
        });
      pausedCleanups.set(id, done);
      return done;
    }));
  }

  async function cleanupClosed(cellIds: readonly string[]): Promise<void> {
    await Promise.all(cellIds.map(id => {
      const cell = cells.get(id);
      if (cell?.status !== "closed") return;
      const epoch = cell.epoch;
      const existing = cleanups.get(id);
      if (existing?.epoch === epoch) return existing.done;
      const stillClosed = () => {
        const current = cells.get(id);
        return current?.epoch === epoch && current.status === "closed" ||
          current?.epoch === epoch + 1 && current.status === "active" && isLeafLifetime(current.spec.lifetime);
      };
      core.dispatcher.abortCells([id], "close");
      const cleanup = Promise.all([existing?.done, core.dispatcher.settled([id])]).then(async () => {
        if (stillClosed()) await core.workspace.cancelJobsForCell(id);
      }).catch((err: unknown) => core.onError(err, `stop runtime of closed cell ${id}`)).finally(() => {
        if (cleanups.get(id)?.epoch !== epoch) return;
        cleanups.delete(id);
        if (cells.get(id)?.status === "active") core.dispatcher.notify(id);
      });
      cleanups.set(id, {epoch, done:cleanup});
      return cleanup;
    }));
  }

  async function closeCell(cellId: string, reason: CloseReason = "completed", opts: CloseActorOptions): Promise<CloseResult> {
    const principalId = requirePrincipalId(opts?.principalId);
    const closed = closeCellSync(cellId, reason, {principalId, ...(opts.parentDelivery && {parentDelivery:opts.parentDelivery})});
    await core.track(cleanupClosed(closed));
    return { closed };
  }

  async function waitForClosedProject(id:string):Promise<number> {
    const project = cells.require(id);
    const pending = [project, ...cells.descendants(id)].map(c => cleanups.get(c.id)?.done);
    await Promise.all(pending);
    return project.epoch;
  }

  async function reopenProject(id:string, principalId:string, words?: ReopenWords) {
    const epoch = await waitForClosedProject(id);
    return reopenProjectSync(id,principalId,epoch,words);
  }

  function restoreBounds(cell: CellRecord): boolean {
    const parent = cells.require(cell.parentId!);
    let bounds: PolicyBounds;
    try {
      bounds = meetBounds(cell.bounds, attenuateBounds(parent.bounds, parent.id, cell.bounds));
    } catch (error) {
      if (error instanceof NgError && error.code === "bounds_violation") return false;
      throw error;
    }
    if (!sameBounds(bounds,cell.bounds)) {
      cells.update(cell.id,{bounds});
      context.refreshPrefixSync(cell.id);
    }
    return true;
  }

  function reopenProjectSync(id: string, principalId: string, expectedEpoch:number, words?: ReopenWords): string[] {
    if (typeof principalId !== "string" || !principalId.trim()) throw new NgError("invalid_argument","explicit actor required");
    const actor = parsePrincipal(principalId, core.ownerPrincipal);
    if (actor.kind !== "owner" && actor.kind !== "agent") throw new NgError("bounds_violation","only a workbench actor may reopen a project");
    return withTx(db, () => {
      const project = cells.require(id);
      if (project.epoch !== expectedEpoch) throw new NgError("conflict","project changed while reopening");
      if (!project.parentId || !isProjectRoot(registry, project) || project.status !== "closed") throw new NgError("conflict","the project must be closed");
      if (cells.ancestors(id).some(c => c.status !== "active")) throw new NgError("conflict","上级任务已暂停或结束");
      const closure = get<{closure_id:string}>(db,"SELECT closure_id FROM cell_closures WHERE cell_id=? AND epoch=?",[id,project.epoch]);
      const members = closure ? all<{cell_id:string;epoch:number;was_revoked:number}>(db,
        "SELECT cell_id,epoch,was_revoked FROM cell_closures WHERE closure_id=? ORDER BY cell_id",[closure.closure_id]) : [];
      const restored: string[] = [];
      for (const c of [project,...cells.children(id)]) {
        const member = members.find(m => m.cell_id===c.id && m.epoch===c.epoch);
        if (c.id!==id && (!member || c.status!=="closed" || c.spec.lifetime!=="wakeable")) continue;
        if (member?.was_revoked) {
          if (c.id===id) throw new NgError("bounds_violation","the project was revoked before closure");
          continue;
        }
        if (!restoreBounds(c)) {
          if (c.id === id) throw new NgError("bounds_violation", "当前权限不允许重开这个项目");
          continue;
        }
        const epoch = cells.bumpEpoch(c.id);
        cells.setStatus(c.id,"active");
        gate.reinstateSync(c.id);
        afterCommit(db, () => bus.emit("cell.changed",{cellId:c.id,change:"status",status:"active",epoch}));
        restored.push(c.id);
      }
      for (const restoredId of restored) {
        const restoredCell = cells.require(restoredId);
        if (restoredCell.preset) registry.presets.get(restoredCell.preset)?.onCellReopened?.(restoredCell,context,clock,core);
      }
      const delivered = inbox.enqueueSync(id,createEnvelope({id:`${id}:reopened:${cells.require(id).epoch}`,from:KERNEL_FROM.control,
        principalId,kind:"event",type:PAYLOAD.cellMessage,expectedEpoch:cells.require(id).epoch,
        payload:{fromCellId:principalId,text:reopenText(actor.kind === "agent", words?.text),...(words?.agentContext?.trim() ? {agentContext:words.agentContext.trim()} : {})}},clock));
      if (delivered !== "accepted") throw new NgError("conflict","project wakeup was not queued");
      return restored;
    });
  }

  function reopenLeafSync(cellId: string): boolean {
    return withTx(db, () => {
      const cell = cells.get(cellId);
      if (!cell || cell.status !== "closed" || !cell.parentId || !isLeafLifetime(cell.spec.lifetime)) return false;
      // Every ancestor must still be open: a worker of a finished or cancelled project is history.
      if (cells.ancestors(cellId).some((a) => a.status !== "active")) return false;
      const closure=get<{was_revoked:number}>(db,"SELECT was_revoked FROM cell_closures WHERE cell_id=? AND epoch=?",[cellId,cell.epoch]);
      if (closure?.was_revoked) return false;
      if (!restoreBounds(cell)) return false;
      const epoch = cells.bumpEpoch(cellId);
      core.waits.dropFor([cellId]);
      cells.setStatus(cellId, "active");
      gate.reinstateSync(cellId);
      afterCommit(db, () => bus.emit("cell.changed", { cellId, change: "status", status: "active", epoch }));
      return true;
    });
  }

  return { createRootCell, ensureRootCell, spawnCell, updateCell, closeCellSync, closeCell, cleanupPaused, cleaningUp: id => cleanups.has(id) || pausedCleanups.has(id), cleanupClosed, deactivateWatches, reopenProject, waitForClosedProject, reopenProjectSync, reopenLeafSync };
}

/** What the owner said when they reopened a project, and what their coding agent added of its own. */
export interface ReopenWords {
  text?: string;
  agentContext?: string;
}

/** The message a reopened project wakes with: the owner's words, or the fact that none came with it (audit R03). */
function reopenText(byAgent: boolean, text: string | undefined): string {
  const who = byAgent ? "主人（经其编码助手）" : "主人";
  const said = text?.trim();
  return said ? `${who}重新打开了这个项目，并说：\n${said}` : `${who}重新打开了这个项目，没有附带新的要求。`;
}

/** Active watches as rows (for routing and read models). */
export function activeWatches(core: Pick<KernelCore, "db">, cellId?: string): Array<{ cellId: string; thread: string | null; filter: Record<string, unknown> }> {
  const rows =
    cellId === undefined
      ? all<{ cell_id: string; thread: string | null; filter: string }>(core.db, "SELECT cell_id, thread, filter FROM cell_watches WHERE active = 1 ORDER BY id")
      : all<{ cell_id: string; thread: string | null; filter: string }>(core.db, "SELECT cell_id, thread, filter FROM cell_watches WHERE active = 1 AND cell_id = ? ORDER BY id", [cellId]);
  return rows.map((r) => ({ cellId: r.cell_id, thread: r.thread, filter: JSON.parse(r.filter) as Record<string, unknown> }));
}
