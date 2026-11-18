import {
  all,
  CELL_STATUS_KEY,
  gtdKeys,
  PAYLOAD,
  subjectKeys,
  type ActionRecord,
  type CellRecord,
  type CellStatusLine,
  type ChildSummary,
  type ProjectRecord,
  type WorkspaceOccupancy,
  type WorkspaceUser,
} from "@ng/protocol";
import type { KernelCore } from "./core";
import type { AnchorReport, CellNode, KernelStats, RosterEntry } from "./types";
import { waitTargetCell } from "./waits";
import { cwdModeOf, effectiveCwd, workTreeKey, writeSlotKey } from "./workdir";

export interface ReadModel {
  rosterFor(cellId: string): RosterEntry[];
  /** Context's rosterProvider: the roster folded into one status line per child (the snapshot's volatile tail). */
  childSummaries(cellId: string): ChildSummary[];
  tree(opts?: { rootId?: string; includeClosed?: boolean }): CellNode[];
  stats(): KernelStats;
  /** docs/05 §3.2: who writes / queues / idles in which work tree. */
  activeWorkspaces(): WorkspaceOccupancy[];
  /** docs/05 guard 2: the five anchors of a cell's subtree. */
  anchorsOf(cellId: string): AnchorReport;
  /** Context's tailNotesProvider: the volatile notes a coordinating cell sees after its roster. */
  tailNotes(cellId: string): string[];
}

interface Facts {
  jobs: Map<string, Array<{ jobId: string; command: string; startedAt: number }>>;
  threads: Map<string, string[]>;
  watching: Set<string>;
  nextTimer: Map<string, number>;
  pending: Map<string, number>;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

function statusOf(value: unknown): CellStatusLine | null {
  if (!value || typeof value !== "object") return typeof value === "string" ? { text: value, at: 0 } : null;
  const v = value as Partial<CellStatusLine>;
  return typeof v.text === "string" ? (v as CellStatusLine) : null;
}

function formatStatus(s: CellStatusLine | null): string | null {
  if (!s) return null;
  const p = s.progress;
  return p ? `${s.text} (${p.done}/${p.total}${p.label ? ` ${p.label}` : ""})` : s.text;
}

/** A coordinating cell's roster shows its whole subtree; this caps a runaway tree's footprint in the prompt. */
const ROSTER_LIMIT = 60;

export function createReadModel(core: KernelCore): ReadModel {
  const { cells, context, gate, inbox, clock, db } = core;

  /** Everything per cell the views need, gathered in a few queries instead of one per cell. */
  function facts(cellIds?: readonly string[]): Facts {
    const only = cellIds ? new Set(cellIds) : null;
    const keep = (id: string) => only === null || only.has(id);
    const f: Facts = { jobs: new Map(), threads: new Map(), watching: new Set(), nextTimer: new Map(), pending: new Map() };
    const jobs = cellIds !== undefined && cellIds.length <= 32
      ? cellIds.flatMap((cellId) => core.workspace.listJobsSync({ cellId, state: ["running"] }))
      : core.workspace.listJobsSync({ state: ["running"] });
    for (const j of jobs) {
      if (keep(j.cellId)) push(f.jobs, j.cellId, { jobId: j.jobId, command: j.command, startedAt: j.startedAt });
    }
    for (const w of all<{ cell_id: string; thread: string | null }>(db, "SELECT cell_id, thread FROM cell_watches WHERE active = 1 ORDER BY id")) {
      if (!keep(w.cell_id)) continue;
      f.watching.add(w.cell_id);
      if (w.thread) push(f.threads, w.cell_id, w.thread);
    }
    const now = clock.now();
    const timer = (id: string, at: number | null) => {
      if (at === null || !keep(id)) return;
      const cur = f.nextTimer.get(id);
      if (cur === undefined || at < cur) f.nextTimer.set(id, at);
    };
    // A roster (a few children, on every hydrate of their parent) asks per cell; the global views scan once.
    const perCell = cellIds !== undefined && cellIds.length <= 32;
    const messages = perCell
      ? cellIds.flatMap((cellId) => inbox.listMessagesSync({ cellId, status: ["pending"], deliverAfter: now }))
      : inbox.listMessagesSync({ status: ["pending"], deliverAfter: now });
    // The kernel's own stall notice is not something the cell is waiting for (anchorsOf excludes it the same way).
    for (const m of messages) if (m.envelope.type !== PAYLOAD.stalledCheck) timer(m.cellId, m.deliverAt);
    const schedules = perCell ? cellIds.flatMap((cellId) => inbox.listSchedulesSync({ cellId, activeOnly: true })) : inbox.listSchedulesSync({ activeOnly: true });
    for (const s of schedules) timer(s.cellId, s.nextFireAt);
    const pending = gate.listPendingSync({ includeSnoozed: true, ...(perCell ? { cellIds } : {}) });
    for (const a of pending) if (keep(a.cellId)) f.pending.set(a.cellId, (f.pending.get(a.cellId) ?? 0) + 1);
    return f;
  }

  function entry(c: CellRecord, f: Facts): RosterEntry {
    const status = statusOf(context.readStateSync(c.id, CELL_STATUS_KEY));
    return {
      cellId: c.id,
      title: c.title,
      preset: c.preset,
      status: c.status,
      epoch: c.epoch,
      lastRunAt: c.lastRunAt,
      statusLine: formatStatus(status),
      running: core.dispatcher.isRunning(c.id),
      progress: status?.progress ?? null,
      jobs: f.jobs.get(c.id) ?? [],
      waitingOn: {
        threads: f.threads.get(c.id) ?? [],
        nextTimerAt: f.nextTimer.get(c.id) ?? null,
        pendingApprovals: f.pending.get(c.id) ?? 0,
      },
    };
  }

  /**
   * Who a cell sees in its roster. A coordinating cell (anything that is not a one-shot worker: the desk, a project, a
   * hub) sees its whole live subtree in tree order, so the desk knows which grandchild sits in which directory; a
   * one-shot cell sees its direct children.
   */
  function rosterCells(cell: CellRecord): Array<{ cell: CellRecord; depth: number }> {
    const direct = cells.children(cell.id, { status: ["active", "paused"] });
    if (cell.spec.lifetime === "one_shot") return direct.map((c) => ({ cell: c, depth: 1 }));
    const out: Array<{ cell: CellRecord; depth: number }> = [];
    const walk = (list: CellRecord[], depth: number) => {
      for (const c of list) {
        out.push({ cell: c, depth });
        if (out.length >= ROSTER_LIMIT) return;
        walk(cells.children(c.id, { status: ["active", "paused"] }), depth + 1);
        if (out.length >= ROSTER_LIMIT) return;
      }
    };
    walk(direct, 1);
    return out;
  }

  function rosterFor(cellId: string): RosterEntry[] {
    const self = cells.get(cellId);
    if (!self) return [];
    const listed = rosterCells(self);
    if (listed.length === 0) return [];
    const f = facts(listed.map((l) => l.cell.id));
    return listed.map(({ cell: c, depth }) => ({
      ...entry(c, f),
      depth,
      parentId: c.parentId,
      // Only a directory someone chose is worth showing; the kernel's own per-cell fallback is noise.
      ...(c.spec.cwd ? { cwd: c.spec.cwd, cwdMode: cwdModeOf(c) } : {}),
    }));
  }

  function childSummaries(cellId: string): ChildSummary[] {
    const waits = new Map<string, string[]>();
    const roster = rosterFor(cellId);
    for (const w of core.waits.list(roster.map((r) => r.cellId))) {
      const list = waits.get(w.cellId) ?? [];
      list.push(`waiting for ${w.waitingFor} (${w.reason})`);
      waits.set(w.cellId, list);
    }
    const queued = new Map(core.dispatcher.queued().map((q) => [q.cellId, q.key]));
    return roster.map((r) => {
      const parts: string[] = [];
      if (r.statusLine) parts.push(r.statusLine);
      if (r.running) parts.push("working now");
      else if (queued.has(r.cellId)) parts.push(`queued for the write slot of ${queued.get(r.cellId)}`);
      for (const j of r.jobs) parts.push(`job running: ${j.command.length > 80 ? `${j.command.slice(0, 80)}…` : j.command}`);
      for (const w of waits.get(r.cellId) ?? []) parts.push(w);
      if (r.waitingOn.threads.length) parts.push(`watching ${r.waitingOn.threads.join(", ")}`);
      if (r.waitingOn.nextTimerAt !== null) parts.push(`next timer ${new Date(r.waitingOn.nextTimerAt).toISOString()}`);
      if (r.waitingOn.pendingApprovals) parts.push(`${r.waitingOn.pendingApprovals} card(s) awaiting the owner`);
      return {
        cellId: r.cellId,
        title: r.title,
        preset: r.preset,
        status: r.status,
        epoch: r.epoch,
        lastRunAt: r.lastRunAt,
        statusLine: parts.length ? parts.join(" · ") : null,
        ...(r.depth !== undefined ? { depth: r.depth } : {}),
        ...(r.parentId !== undefined ? { parentId: r.parentId } : {}),
        ...(r.cwd ? { cwd: r.cwd } : {}),
        ...(r.cwdMode ? { cwdMode: r.cwdMode } : {}),
      };
    });
  }

  // ---------- docs/05 §3.2: directory occupancy ----------

  function activeWorkspaces(): WorkspaceOccupancy[] {
    const live = cells.list({ status: ["active", "paused"] });
    const running = new Map(core.dispatcher.running().map((r) => [r.cellId, r]));
    const queued = new Map(core.dispatcher.queued().map((q, i) => [q.cellId, i]));
    const jobs = new Map<string, number>();
    const jobCells = new Set<string>();
    for (const j of core.workspace.listJobsSync({ state: ["running"] })) {
      jobs.set(j.cellId, (jobs.get(j.cellId) ?? 0) + 1);
      jobCells.add(j.cellId);
    }
    const byKey = new Map<string, WorkspaceOccupancy>();
    const slot = (key: string) => {
      let o = byKey.get(key);
      if (!o) byKey.set(key, (o = { key, holder: null, queued: [], others: [] }));
      return o;
    };
    // A Job of a cell that was just closed still holds its tree until the process is gone.
    const candidates = [...live, ...[...jobCells].filter((id) => !live.some((c) => c.id === id)).flatMap((id) => cells.get(id) ?? [])];
    const queuedUsers: Array<{ user: WorkspaceUser; key: string; order: number }> = [];
    for (const c of candidates) {
      // The desk and other cells nobody gave a directory are not part of this picture.
      if (!c.spec.cwd && !core.repoPath) continue;
      const mode = cwdModeOf(c);
      const cwd = effectiveCwd(core, c);
      const isRunning = running.has(c.id);
      const hasJob = jobs.has(c.id);
      if (mode === "read" && !isRunning) continue;
      let key: string;
      try {
        key = writeSlotKey(core, c) ?? workTreeKey(cwd);
      } catch {
        continue;
      }
      const status = context.readStateSync(c.id, CELL_STATUS_KEY);
      const user: WorkspaceUser = {
        cellId: c.id,
        title: c.title,
        preset: c.preset,
        parentId: c.parentId,
        cwd,
        cwdMode: mode,
        state: isRunning ? "running" : hasJob ? "job" : queued.has(c.id) ? "queued" : c.status === "paused" ? "paused" : "waiting",
        statusLine: formatStatus(statusOf(status)),
      };
      const o = slot(key);
      if (mode === "write" && (isRunning || hasJob) && o.holder === null) o.holder = user;
      else if (user.state === "queued") queuedUsers.push({ user, key, order: queued.get(c.id)! });
      else o.others.push(user);
    }
    for (const q of queuedUsers.sort((a, b) => a.order - b.order)) slot(q.key).queued.push(q.user);
    return [...byKey.values()].filter((o) => o.holder !== null || o.queued.length > 0 || o.others.length > 0).sort((a, b) => a.key.localeCompare(b.key));
  }

  function occupancyNote(): string | null {
    const all = activeWorkspaces().filter((o) => o.holder !== null || o.queued.length > 0 || o.others.some((u) => u.cwdMode === "write"));
    if (all.length === 0) return null;
    const who = (u: WorkspaceUser) => `${u.cellId}${u.title ? ` "${u.title}"` : ""}`;
    const lines = all.map((o) => {
      const parts: string[] = [];
      if (o.holder) parts.push(`writing now: ${who(o.holder)}${o.holder.state === "job" ? " (background job)" : ""}`);
      if (o.queued.length) parts.push(`queued: ${o.queued.map(who).join(", ")}`);
      const idle = o.others.filter((u) => u.cwdMode === "write");
      if (idle.length) parts.push(`asleep (slot released): ${idle.map((u) => `${who(u)} [${u.state}]`).join(", ")}`);
      const readers = o.others.filter((u) => u.cwdMode === "read");
      if (readers.length) parts.push(`reading: ${readers.map(who).join(", ")}`);
      return `- ${o.key} — ${parts.join("; ")}`;
    });
    return `[active workspaces: who holds which work tree right now — one writer per tree, the kernel queues the rest; not part of the conversation]\n${lines.join("\n")}`;
  }

  function tailNotes(cellId: string): string[] {
    const cell = cells.get(cellId);
    if (!cell || cell.spec.lifetime === "one_shot") return [];
    const notes: string[] = [];
    const own = core.waits.list([cellId]);
    if (own.length) {
      notes.push(`[your open waits]\n${own.map((w) => `- waiting for ${w.waitingFor}: ${w.reason}${w.timeoutAt ? ` (times out ${new Date(w.timeoutAt).toISOString()})` : ""}`).join("\n")}`);
    }
    const occ = occupancyNote();
    if (occ) notes.push(occ);
    return notes;
  }

  // ---------- docs/05 guard 2: the five anchors ----------

  function anchorsOf(cellId: string): AnchorReport {
    const root = cells.get(cellId);
    const empty: AnchorReport = { cellId, agent: false, external: false, internal: false, human: false, parked: true, stalled: false, detail: "no such cell" };
    if (!root) return empty;
    const project = context.readStateSync<ProjectRecord>(cellId, gtdKeys.project);
    const subtree = [root, ...cells.descendants(cellId, { status: ["active", "paused"] })].filter((c) => c.status !== "closed");
    const ids = subtree.map((c) => c.id);
    const idSet = new Set(ids);
    const now = clock.now();
    const why: string[] = [];

    // 5. Parked on purpose.
    const parked = root.status !== "active" || (project !== null && project.lifecycle !== "active");
    if (parked) why.push(root.status !== "active" ? `the cell is ${root.status}` : `lifecycle ${project!.lifecycle}`);

    // 1. @Agent — a Run that is not just the stall check, due or slot-queued real work, or a Job.
    let agent = false;
    for (const r of core.dispatcher.running()) {
      if (idSet.has(r.cellId) && !r.stallOnly) {
        agent = true;
        why.push(`${r.cellId} is working`);
        break;
      }
    }
    const pending = ids.length ? inbox.listMessagesSync({ status: ["pending"] }).filter((m) => idSet.has(m.cellId) && m.envelope.type !== PAYLOAD.stalledCheck) : [];
    const active = new Set(subtree.filter((c) => c.status === "active").map((c) => c.id));
    const dueWork = pending.find((m) => m.deliverAt <= now && (m.envelope.delivery ?? "wakeup") === "wakeup" && active.has(m.cellId));
    if (!agent && dueWork) {
      agent = true;
      why.push(`${dueWork.cellId} has work queued (${dueWork.envelope.type})`);
    }
    if (!agent) {
      const job = core.workspace.listJobsSync({ state: ["running"] }).find((j) => idSet.has(j.cellId));
      if (job) {
        agent = true;
        why.push(`a job of ${job.cellId} is running`);
      }
    }

    // 2. @Waiting(external) — a watch, a timer/cron, or a message inside a batching window.
    let external = false;
    const watch = ids.length ? all<{ cell_id: string }>(db, "SELECT cell_id FROM cell_watches WHERE active = 1 ORDER BY id").find((w) => idSet.has(w.cell_id)) : undefined;
    if (watch) {
      external = true;
      why.push(`${watch.cell_id} watches for an external event`);
    }
    const future = pending.find((m) => m.deliverAt > now);
    if (!external && future) {
      external = true;
      why.push(`${future.cellId} has a timer at ${new Date(future.deliverAt).toISOString()}`);
    }
    if (!external) {
      const sched = inbox.listSchedulesSync({ activeOnly: true }).find((sc) => idSet.has(sc.cellId));
      if (sched) {
        external = true;
        why.push(`${sched.cellId} has a schedule`);
      }
    }

    // 3. @Waiting(internal) — an open wait on a cell that can still answer.
    let internal = false;
    for (const w of core.waits.list(ids)) {
      const target = waitTargetCell(w.waitingFor);
      if (target === null) continue; // "human"/"external" must be backed by a card, an action or a watch/timer
      const t = cells.get(target);
      if (t && t.status !== "closed") {
        internal = true;
        why.push(`${w.cellId} waits for ${w.waitingFor}`);
        break;
      }
    }

    // 4. @Human — a card, or an open action that is the owner's to do.
    let human = false;
    // A card about this project is the owner's ball whoever holds it (the desk raises some on a project's behalf).
    const subject = subjectKeys.project(cellId);
    const cards = ids.length ? gate.listPendingSync({ includeSnoozed: true }).filter((a) => idSet.has(a.cellId) || a.subjectKey === subject) : [];
    if (cards.length) {
      human = true;
      why.push(`${cards.length} card(s) await the owner`);
    }
    if (!human) {
      const mine = context
        .queryStateSync({ keyPrefix: gtdKeys.actionPrefix, cellIds: ids })
        .map((e) => e.value as ActionRecord)
        .find((a) => a && a.status === "open" && a.owner === "human");
      if (mine) {
        human = true;
        why.push(`the owner has an open action: ${mine.title}`);
      }
    }

    const stalled = !parked && !agent && !external && !internal && !human;
    return {
      cellId,
      agent,
      external,
      internal,
      human,
      parked,
      stalled,
      detail: stalled ? "nothing is running or queued, no watch or timer is set, no open wait points at a live cell, and the owner has no card or open action" : why.join("; "),
    };
  }

  function tree(opts: { rootId?: string; includeClosed?: boolean } = {}): CellNode[] {
    const listed = (opts.rootId ? cells.list({ rootId: opts.rootId }) : cells.list()).filter((c) => opts.includeClosed || c.status !== "closed");
    const f = facts(listed.map((c) => c.id));
    const byParent = new Map<string | null, CellRecord[]>();
    for (const c of listed) push(byParent, c.parentId, c);
    const ids = new Set(listed.map((c) => c.id));
    const build = (c: CellRecord): CellNode => {
      const e = entry(c, f);
      return {
        cellId: c.id,
        title: c.title,
        preset: c.preset,
        status: c.status,
        epoch: c.epoch,
        depth: c.depth,
        running: e.running,
        runningJobs: e.jobs.length,
        pendingApprovals: e.waitingOn.pendingApprovals,
        threads: e.waitingOn.threads,
        watching: f.watching.has(c.id),
        nextTimerAt: e.waitingOn.nextTimerAt,
        statusLine: e.statusLine,
        lastRunAt: c.lastRunAt,
        children: (byParent.get(c.id) ?? []).map(build),
      };
    };
    // Roots of the forest: cells whose parent is not part of the listed set.
    return listed.filter((c) => c.parentId === null || !ids.has(c.parentId)).map(build);
  }

  function stats(): KernelStats {
    const live = cells.list({ status: ["active", "paused"] });
    const f = facts();
    const now = clock.now();
    let busy = 0;
    let waiting = 0;
    for (const c of live) {
      const isBusy = core.dispatcher.isRunning(c.id) || (f.jobs.get(c.id)?.length ?? 0) > 0;
      if (isBusy) busy++;
      else if (f.watching.has(c.id) || f.nextTimer.has(c.id)) waiting++;
    }
    const visible = gate.listPendingSync({ now }).length;
    const allPending = gate.listPendingSync({ includeSnoozed: true }).length;
    return {
      backgroundCells: live.filter((c) => c.parentId !== null).length,
      pausedCells: live.filter((c) => c.status === "paused").length,
      runningRuns: core.dispatcher.activeRuns().length,
      busyCells: busy,
      runningJobs: [...f.jobs.values()].reduce((n, js) => n + js.length, 0),
      waitingCells: waiting,
      pendingApprovals: visible,
      snoozedApprovals: allPending - visible,
      bufferedNotifications: core.hub.bufferedCountSync(),
      focus: core.hub.isFocusSync(),
    };
  }

  return { rosterFor, childSummaries, tree, stats, activeWorkspaces, anchorsOf, tailNotes };
}
