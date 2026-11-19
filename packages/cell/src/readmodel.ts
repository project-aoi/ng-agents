import {
  all,
  CELL_STATUS_KEY,
  gtdKeys,
  isLeafLifetime,
  PAYLOAD,
  projectCellIdOf,
  pullCursorKey,
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
import type { AnchorReport, CellActivity, CellNode, KernelStats, RosterEntry } from "./types";
import { waitTargetCell } from "./waits";
import { effectiveCwd, workTreeKey } from "./workdir";

export interface ReadModel {
  rosterFor(cellId: string): RosterEntry[];
  /** Context's rosterProvider: the roster folded into one status line per child (the snapshot's volatile tail). */
  childSummaries(cellId: string): ChildSummary[];
  tree(opts?: { rootId?: string; includeClosed?: boolean }): CellNode[];
  stats(): KernelStats;
  /** Which cells are active (a Run or a Job in flight) in which work tree right now. */
  activeWorkspaces(): WorkspaceOccupancy[];
  /**
   * What each of these cells is doing, in one pass. `dormant` — a live leaf with no Run, no Job, no message waiting,
   * no watch, timer, wait or card — is the state that costs nothing and blocks nothing: it takes no child slot and
   * does not keep its project from finishing.
   */
  activityOf(cellIds: readonly string[]): Map<string, CellActivity>;
  /**
   * The children that stand in the way of closing or parking `cellId`: persistent children that are still open, and
   * leaf children that are not dormant.
   */
  blockingChildren(cellId: string): Array<{ cell: CellRecord; why: string }>;
  /** Leaf children of `cellId` that hold a slot of maxConcurrentChildren: active and not dormant. */
  busyLeafChildren(cellId: string): CellRecord[];
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
  /** Cells with a wake-up message that is due now (their own stall notice does not count). */
  due: Set<string>;
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
    const f: Facts = { jobs: new Map(), threads: new Map(), watching: new Set(), nextTimer: new Map(), pending: new Map(), due: new Set() };
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
    const messages = perCell ? cellIds.flatMap((cellId) => inbox.listMessagesSync({ cellId, status: ["pending"] })) : inbox.listMessagesSync({ status: ["pending"] });
    const epochs = new Map<string, number | undefined>();
    for (const m of messages) {
      // The kernel's own stall notice is not something the cell is waiting for (anchorsOf excludes it the same way).
      if (m.envelope.type === PAYLOAD.stalledCheck || !keep(m.cellId)) continue;
      if (m.deliverAt > now) timer(m.cellId, m.deliverAt);
      else if ((m.envelope.delivery ?? "wakeup") === "wakeup") {
        // A row addressed to an earlier epoch is dropped at the next claim: it will never start anything.
        if (!epochs.has(m.cellId)) epochs.set(m.cellId, cells.get(m.cellId)?.epoch);
        const expected = m.envelope.expectedEpoch ?? null;
        if (expected === null || expected === epochs.get(m.cellId)) f.due.add(m.cellId);
      }
    }
    const schedules = perCell ? cellIds.flatMap((cellId) => inbox.listSchedulesSync({ cellId, activeOnly: true })) : inbox.listSchedulesSync({ activeOnly: true });
    for (const s of schedules) timer(s.cellId, s.nextFireAt);
    const pending = gate.listPendingSync({ includeSnoozed: true, ...(perCell ? { cellIds } : {}) });
    for (const a of pending) if (keep(a.cellId)) f.pending.set(a.cellId, (f.pending.get(a.cellId) ?? 0) + 1);
    return f;
  }

  function activity(c: CellRecord, f: Facts, waiting: ReadonlySet<string>): CellActivity {
    if (c.status === "closed") return { state: "closed", why: `closed (${c.closeReason ?? "completed"})` };
    if (core.dispatcher.isRunning(c.id)) return { state: "working", why: "a run is in flight" };
    const jobs = f.jobs.get(c.id);
    if (jobs?.length) return { state: "working", why: `a background job is running (${jobs[0]!.command.slice(0, 60)})` };
    if (c.status === "paused") return { state: "paused", why: "paused" };
    if (f.due.has(c.id)) return { state: "working", why: "a message is waiting to start its next run" };
    if (f.pending.get(c.id)) return { state: "waiting", why: "a card of its awaits the owner" };
    if (waiting.has(c.id)) return { state: "waiting", why: "it has an open wait" };
    if (f.watching.has(c.id)) return { state: "waiting", why: "it watches for an outside event" };
    if (f.nextTimer.has(c.id)) return { state: "waiting", why: `it has a timer at ${new Date(f.nextTimer.get(c.id)!).toISOString()}` };
    // Nothing in flight and nothing that would wake it. For a leaf that is the resting state; a coordinator in the
    // same position is simply idle between the events of its project.
    if (!isLeafLifetime(c.spec.lifetime)) return { state: "idle", why: "idle" };
    // A leaf that was given spawn depth on purpose is not at rest while a cell of its own is still at work: its
    // result will wake it, and closing it now would take that cell down with it.
    if (c.bounds.maxDepth > 0) {
      const below = cells.children(c.id, { status: ["active", "paused"] });
      const busy = below.length > 0 ? [...activities(below).values()].find((a) => a.state !== "dormant") : undefined;
      if (busy) return { state: "waiting", why: "a cell it started is still at work" };
    }
    return { state: "dormant", why: "dormant: nothing in flight; a message wakes it on its session" };
  }

  function activities(list: readonly CellRecord[]): Map<string, CellActivity> {
    if (list.length === 0) return new Map();
    const ids = list.map((c) => c.id);
    const f = facts(ids);
    const waiting = new Set(core.waits.list(ids).map((w) => w.cellId));
    return new Map(list.map((c) => [c.id, activity(c, f, waiting)]));
  }

  function activityOf(cellIds: readonly string[]): Map<string, CellActivity> {
    return activities(cellIds.flatMap((id) => cells.get(id) ?? []));
  }

  function blockingChildren(cellId: string): Array<{ cell: CellRecord; why: string }> {
    const open = cells.children(cellId, { status: ["active", "paused"] });
    const act = activities(open);
    const out: Array<{ cell: CellRecord; why: string }> = [];
    for (const c of open) {
      const a = act.get(c.id)!;
      if (!isLeafLifetime(c.spec.lifetime)) out.push({ cell: c, why: "a persistent cell that is still open" });
      else if (a.state !== "dormant") out.push({ cell: c, why: a.why });
    }
    return out;
  }

  function busyLeafChildren(cellId: string): CellRecord[] {
    const leaves = cells.children(cellId, { status: ["active"] }).filter((c) => isLeafLifetime(c.spec.lifetime));
    const act = activities(leaves);
    return leaves.filter((c) => act.get(c.id)!.state !== "dormant");
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
   * Who a cell sees in its roster. A coordinating cell (the desk, a project, a hub) sees its whole live subtree in
   * tree order, so the desk knows which grandchild sits in which directory; a leaf sees its direct children (it has
   * none unless someone gave it spawn depth on purpose).
   */
  function rosterCells(cell: CellRecord): Array<{ cell: CellRecord; depth: number }> {
    const direct = cells.children(cell.id, { status: ["active", "paused"] });
    if (isLeafLifetime(cell.spec.lifetime)) return direct.map((c) => ({ cell: c, depth: 1 }));
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
      ...(c.spec.cwd ? { cwd: c.spec.cwd } : {}),
    }));
  }

  function childSummaries(cellId: string): ChildSummary[] {
    const waits = new Map<string, string[]>();
    const roster = rosterFor(cellId);
    if (roster.length === 0) return [];
    for (const w of core.waits.list(roster.map((r) => r.cellId))) {
      const list = waits.get(w.cellId) ?? [];
      list.push(`waiting for ${w.waitingFor} (${w.reason})`);
      waits.set(w.cellId, list);
    }
    const act = activityOf(roster.map((r) => r.cellId));
    return roster.map((r) => {
      const parts: string[] = [];
      const a = act.get(r.cellId);
      const child = cells.get(r.cellId);
      if (r.statusLine) parts.push(r.statusLine);
      if (r.running) parts.push("working now");
      else if (a?.state === "dormant") parts.push("dormant — its turn is over; send_message to it wakes it with everything it knows");
      for (const j of r.jobs) parts.push(`job running: ${j.command.length > 80 ? `${j.command.slice(0, 80)}…` : j.command}`);
      for (const w of waits.get(r.cellId) ?? []) parts.push(w);
      if (r.waitingOn.threads.length) parts.push(`watching ${r.waitingOn.threads.join(", ")}`);
      if (r.waitingOn.nextTimerAt !== null) parts.push(`next timer ${new Date(r.waitingOn.nextTimerAt).toISOString()}`);
      if (r.waitingOn.pendingApprovals) parts.push(`${r.waitingOn.pendingApprovals} card(s) awaiting the owner`);
      // What this cell has not looked at yet in a direct leaf child (its own cursor; a grandchild is its parent's to read).
      let unread: ChildSummary["unread"];
      if (child && r.parentId === cellId && isLeafLifetime(child.spec.lifetime)) {
        const last = context.lastEvidenceSeqSync(r.cellId);
        const seen = context.readStateSync<number>(cellId, pullCursorKey(r.cellId)) ?? 0;
        if (last > seen) {
          unread = { from: seen + 1, to: last };
          parts.push(seen > 0 ? `new since your last inspect_cell: #${seen + 1}–#${last}` : `not inspected yet (its record runs to #${last})`);
        }
      }
      const state: ChildSummary["activity"] | undefined =
        a === undefined || a.state === "closed" ? undefined : a.state === "idle" ? "waiting" : a.state;
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
        ...(state ? { activity: state } : {}),
        ...(unread ? { unread } : {}),
      };
    });
  }

  // ---------- directory occupancy: a fact the kernel shows, not a lock it holds ----------

  function activeWorkspaces(): WorkspaceOccupancy[] {
    const running = new Set(core.dispatcher.running().map((r) => r.cellId));
    const jobCells = new Set(core.workspace.listJobsSync({ state: ["running"] }).map((j) => j.cellId));
    const byKey = new Map<string, WorkspaceOccupancy>();
    // A Job of a cell that was just closed still works in its tree until the process is gone.
    for (const id of new Set([...running, ...jobCells])) {
      const c = cells.get(id);
      // The desk and other cells nobody gave a directory are not part of this picture.
      if (!c || (!c.spec.cwd && !core.repoPath)) continue;
      const cwd = effectiveCwd(core, c);
      let key: string;
      try {
        key = workTreeKey(cwd);
      } catch {
        continue;
      }
      const projectId = projectCellIdOf(c.spec) ?? null;
      const project = projectId && projectId !== c.id ? cells.get(projectId) : undefined;
      const user: WorkspaceUser = {
        cellId: c.id,
        title: c.title,
        preset: c.preset,
        parentId: c.parentId,
        projectCellId: projectId,
        projectTitle: project?.title ?? null,
        cwd,
        state: running.has(id) ? "running" : "job",
        statusLine: formatStatus(statusOf(context.readStateSync(c.id, CELL_STATUS_KEY))),
      };
      let o = byKey.get(key);
      if (!o) byKey.set(key, (o = { key, active: [] }));
      o.active.push(user);
    }
    for (const o of byKey.values()) o.active.sort((a, b) => a.cellId.localeCompare(b.cellId));
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /** `forCell`: a leaf sees only who else is active in its own work tree; a coordinator sees every tree. */
  function occupancyNote(forCell: CellRecord): string | null {
    const leaf = isLeafLifetime(forCell.spec.lifetime);
    let all = activeWorkspaces();
    if (leaf) {
      if (!forCell.spec.cwd && !core.repoPath) return null;
      let own: string;
      try {
        own = workTreeKey(effectiveCwd(core, forCell));
      } catch {
        return null;
      }
      all = all.filter((o) => o.key === own).map((o) => ({ ...o, active: o.active.filter((u) => u.cellId !== forCell.id) }));
    }
    all = all.filter((o) => o.active.length > 0);
    if (all.length === 0) return null;
    const who = (u: WorkspaceUser) => {
      const where = u.cwd !== all.find((o) => o.active.includes(u))?.key ? ` in ${u.cwd}` : "";
      const project = u.projectTitle ? ` of project "${u.projectTitle}"` : "";
      return `${u.cellId}${u.title ? ` "${u.title}"` : ""}${project}${where} — ${u.state === "job" ? "background job" : "working"}${u.statusLine ? `: ${u.statusLine}` : ""}`;
    };
    const lines = all.flatMap((o) => [`- ${o.key}`, ...o.active.map((u) => `  - ${who(u)}`)]);
    const head = leaf
      ? "[others active in your work tree right now — nothing stops two cells from changing the same files, so look before you change; not part of the conversation]"
      : "[active workspaces: who is working in which directory right now — the kernel starts every cell at once and locks nothing, so the split is yours to decide; not part of the conversation]";
    return `${head}\n${lines.join("\n")}`;
  }

  /** A coordinator's own notes (save_note, scope "cell"), put in front of it at every wake-up. */
  const NOTES_LIMIT = 8_000;
  function notesNote(cellId: string): string | null {
    const notes = context.listKnowledgeSync({ kind: "note", cellId, includeGlobal: false }).filter((n) => n.scope === "cell" && n.cellId === cellId && n.body.trim());
    if (notes.length === 0) return null;
    notes.sort((a, b) => a.name.localeCompare(b.name));
    let left = NOTES_LIMIT;
    const blocks: string[] = [];
    for (const n of notes) {
      if (left <= 0) {
        blocks.push(`## ${n.name}\n(not shown: the notes above already fill the space — read_resource("note://${n.name}"))`);
        continue;
      }
      const body = n.body.trim();
      const shown = body.length > left ? `${body.slice(0, left)}\n… (cut here; the rest: read_resource("note://${n.name}"). Keep notes short — rewrite instead of appending.)` : body;
      left -= shown.length;
      blocks.push(`## ${n.name}\n${shown}`);
    }
    return `[your notes — kept across every wake-up; update with save_note]\n${blocks.join("\n\n")}`;
  }

  function tailNotes(cellId: string): string[] {
    const cell = cells.get(cellId);
    if (!cell) return [];
    const leaf = isLeafLifetime(cell.spec.lifetime);
    const notes: string[] = [];
    const own = core.waits.list([cellId]);
    if (own.length) {
      notes.push(`[your open waits]\n${own.map((w) => `- waiting for ${w.waitingFor}: ${w.reason}${w.timeoutAt ? ` (times out ${new Date(w.timeoutAt).toISOString()})` : ""}`).join("\n")}`);
    }
    const occ = occupancyNote(cell);
    if (occ) notes.push(occ);
    // Last, right before the batch: the one thing a coordinator must not lose to a compacted or rebuilt session.
    if (!leaf) {
      const mine = notesNote(cellId);
      if (mine) notes.push(mine);
    }
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

    // 1. @Agent — a Run that is not just the stall check, due real work, or a Job.
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

  return { rosterFor, childSummaries, tree, stats, activeWorkspaces, anchorsOf, tailNotes, activityOf, blockingChildren, busyLeafChildren };
}
