import {
  all,
  get,
  CELL_STATUS_KEY,
  isLeafLifetime,
  PAYLOAD,
  projectCellIdOf,
  pullCursorKey,
  type CellRecord,
  type CellStatusLine,
  type ChildSummary,
  type WorkspaceOccupancy,
  type WorkspaceUser,
} from "@ng/protocol";
import type { KernelCore } from "./core";
import type { AnchorReport, CellActivity, CellNode, KernelStats, RosterEntry } from "./types";
import { waitTargetCell, type WaitRecord } from "./waits";
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
  /** Internal waits whose target can make progress for the waiting cell. */
  groundedWaits(waits: readonly WaitRecord[], localCells: ReadonlySet<string>): WaitRecord[];
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
  const { cells, context, inbox, clock, db } = core;

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
      if (m.envelope.type === PAYLOAD.stalledCheck || !keep(m.cellId) || m.envelope.delivery === "silent_inject") continue;
      if (!epochs.has(m.cellId)) epochs.set(m.cellId, cells.get(m.cellId)?.epoch);
      if (m.expectedEpoch !== null && m.expectedEpoch !== epochs.get(m.cellId)) continue;
      if (m.deliverAt > now) timer(m.cellId, m.deliverAt);
      else f.due.add(m.cellId);
    }
    const schedules = perCell ? cellIds.flatMap((cellId) => inbox.listSchedulesSync({ cellId, activeOnly: true })) : inbox.listSchedulesSync({ activeOnly: true });
    for (const s of schedules) timer(s.cellId, s.nextFireAt);
    const pending = all<{cell_id:string; count:number}>(db, `SELECT cell_id, COUNT(*) AS count FROM human_items
      WHERE cell_id IS NOT NULL AND status IN ('pending','snoozed') GROUP BY cell_id`);
    for (const a of pending) if (keep(a.cell_id)) f.pending.set(a.cell_id, a.count);
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
    const notes = context.listKnowledgeSync({ kind: "working_note", cellId, includeGlobal: false }).filter((n) => n.scope === "cell" && n.cellId === cellId && n.body.trim());
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
      notes.push(`[your open waits]\n${own.map((w) => `- waiting for ${w.waitingFor}: ${w.reason} [${w.waitId}]${w.timeoutAt ? ` (times out ${new Date(w.timeoutAt).toISOString()})` : ""}`).join("\n")}`);
    }
    const waiting = all<{cell_id: string; wait_id: string; reason: string}>(db, `SELECT w.cell_id, w.wait_id, w.reason FROM cell_waits w
      JOIN cells c ON c.id=w.cell_id AND c.epoch=w.epoch AND c.status='active' WHERE w.waiting_for=? ORDER BY w.created_at`, [`inbox:${cellId}`]);
    if (waiting.length) notes.push("[cells waiting on you]\n" + waiting.map(w => `${w.cell_id} [${w.wait_id}] ${w.reason}`).join("\n"));
    const cards = all<{action_id: string; subject_key: string; status: string}>(db, `SELECT action_id,subject_key,status FROM human_items
      WHERE cell_id=? AND status IN ('pending','snoozed')`, [cellId]);
    if (cards.length) notes.push("[your open cards]\n" + cards.map(c => `${c.action_id} ${c.subject_key} (${c.status})`).join("\n"));
    const jobs = core.workspace.listJobsSync({ cellId, state: ["running"] });
    if (jobs.length) notes.push("[your running jobs]\n" + jobs.map(j => `${j.jobId} ${j.command.slice(0,120)}`).join("\n"));
    const authors = leaf ? [cellId] : [cellId, ...cells.descendants(cellId).map(c => c.id)];
    const edits = all<{artifact_id:string; version:number}>(db, `SELECT a.artifact_id,a.version FROM artifacts a
      WHERE a.cell_id IN (SELECT value FROM json_each(?)) AND a.updated_by='human'
      AND (EXISTS(SELECT 1 FROM human_items h WHERE h.artifact_id=a.artifact_id AND h.status IN ('pending','snoozed'))
      OR (a.updated_at>=? AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.cell_id=? AND e.kind='run_boundary'
        AND json_extract(e.content,'$.phase')='start' AND e.at>a.updated_at)))
      ORDER BY a.updated_at DESC LIMIT 12`, [JSON.stringify(authors), clock.now()-86_400_000, cellId]);
    if (edits.length) notes.push("[human-edited artifacts]\n" + edits.map(a => `${a.artifact_id} v${a.version}`).join("\n"));
    const watches = all<{id:number; thread:string | null}>(db, "SELECT id,thread FROM cell_watches WHERE active=1 AND cell_id=?", [cellId]);
    const schedules = inbox.listSchedulesSync({cellId, activeOnly:true});
    if (watches.length || schedules.length) notes.push("[your active watches & schedules]\n" + [
      ...watches.map(w => `watch ${w.id} ${w.thread ?? ""}`), ...schedules.map(s => `schedule ${s.id} next ${s.nextFireAt}`),
    ].join("\n"));
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

  function groundedWaits(waits: readonly WaitRecord[], localCells: ReadonlySet<string>, cachedFacts?: Facts): WaitRecord[] {
    const internal = waits.filter(w => waitTargetCell(w.waitingFor) !== null);
    if (!internal.length) return [];
    const allCells = new Map(cells.list().map(c => [c.id, c]));
    function available(cell: CellRecord): boolean {
      for (let c: CellRecord | undefined = cell; c; c = c.parentId ? allCells.get(c.parentId) : undefined) {
        if (c.status !== "active") return false;
      }
      return true;
    }
    const live = new Map([...allCells].filter(([,cell]) => available(cell)));
    const edges = new Map<string, string[]>();
    for (const w of core.waits.list()) {
      const target = waitTargetCell(w.waitingFor);
      if (target && live.has(target) && live.get(w.cellId)?.epoch === w.epoch) push(edges, w.cellId, target);
    }

    // An open wait is a dependency, not a source of progress. Exclude the nodes that participate in a cycle.
    const cycle = new Map<string, boolean>();
    function inCycle(start: string): boolean {
      if (cycle.has(start)) return cycle.get(start)!;
      const queue = [...(edges.get(start) ?? [])];
      const seen = new Set<string>();
      while (queue.length) {
        const next = queue.pop()!;
        if (next === start) { cycle.set(start, true); return true; }
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(...(edges.get(next) ?? []));
      }
      cycle.set(start, false);
      return false;
    }

    const f = cachedFacts ?? facts();
    const working = new Set(core.dispatcher.running().filter(r => !r.stallOnly).map(r => r.cellId));
    const cards = all<{cell_id:string; category:string; related_project_ids:string}>(db, `SELECT cell_id, category, related_project_ids FROM human_items
      WHERE cell_id IS NOT NULL AND status IN ('pending','snoozed')`);
    const cardOwners = new Set(cards.map(card => card.cell_id));
    const hasSource = (id: string) => working.has(id) || f.jobs.has(id) || f.due.has(id) || f.watching.has(id) || f.nextTimer.has(id) || cardOwners.has(id);
    const requests = inbox.listMessagesSync({status:["pending","claimed"]}).filter(m => m.envelope.delivery !== "silent_inject" &&
      (m.expectedEpoch === null || m.expectedEpoch === live.get(m.cellId)?.epoch));
    function canAnswer(from: string, target: string, seen: Set<string>): boolean {
      const t = live.get(target);
      if (!t || seen.has(target) || inCycle(target)) return false;
      const path = new Set(seen).add(target);
      if (!localCells.has(target) && !isLeafLifetime(t.spec.lifetime)) {
        // An outside coordinator must have work for this particular requester.
        const owner = cells.require(from);
        const project = owner.preset === "project" ? from : projectCellIdOf(owner.spec) ?? cells.ancestors(from).find(c => c.preset === "project")?.id;
        if (requests.some(m => m.cellId === target && waitTargetCell(m.envelope.from) === from)) return true;
        if (!project) return false;
        if (cards.some(c => c.cell_id === target && c.category === "decision" && JSON.parse(c.related_project_ids).includes(project))) return true;
        return cells.children(target,{status:["active"]}).some(c => isLeafLifetime(c.spec.lifetime) &&
          Array.isArray(c.spec.meta?.relatedProjectIds) && c.spec.meta.relatedProjectIds.includes(project) && canAnswer(target, c.id, path));
      }
      return hasSource(target) || (edges.get(target) ?? []).some(next => canAnswer(target, next, path));
    }
    return internal.filter(w => live.get(w.cellId)?.epoch === w.epoch && canAnswer(w.cellId, waitTargetCell(w.waitingFor)!, new Set([w.cellId])));
  }

  function anchorsOf(cellId: string): AnchorReport {
    const root = cells.get(cellId);
    const empty: AnchorReport = { cellId, agent: false, external: false, internal: false, human: false, parked: true, stalled: false, detail: "no such cell" };
    if (!root) return empty;

    const subtree = [root, ...cells.descendants(cellId, { status: ["active", "paused"] })].filter((c) => c.status !== "closed");
    const ids = subtree.map((c) => c.id);
    const idSet = new Set(ids);
    const projectId = root.preset === "project" ? cellId : projectCellIdOf(root.spec) ?? cells.ancestors(cellId).find(c=>c.preset==="project")?.id;
    const why: string[] = [];

    const parked = root.status !== "active" || cells.ancestors(cellId).some(c => c.status === "paused");
    if (parked) why.push("cell or ancestor is parked");

    // Descendants are ordered by depth. A manually parked ancestor suspends its whole branch.
    const active = new Set<string>();
    for (const cell of subtree) {
      if (!parked && cell.status === "active" && (cell.id === cellId || active.has(cell.parentId!))) active.add(cell.id);
    }
    const available = [...active];
    const waits = core.waits.list(ids);
    const f = facts(waits.some(w => waitTargetCell(w.waitingFor) !== null) ? undefined : available);
    const working = new Set(core.dispatcher.running().filter(r => !r.stallOnly).map(r => r.cellId));
    const agent = available.find(id => working.has(id) || f.jobs.has(id) || f.due.has(id));
    if (agent) why.push(`${agent} has a run, job or queued work`);
    const external = available.find(id => f.watching.has(id) || f.nextTimer.has(id));
    if (external) why.push(`${external} has an active watch or timer`);

    // 3. @Waiting(internal) — an open wait on a cell that can still answer.
    const backed = groundedWaits(waits, idSet, f);
    const internal = backed.length > 0;
    if (backed[0]) why.push(`${backed[0].cellId} waits for ${backed[0].waitingFor}`);

    // 4. @Human — a card, or an open action that is the owner's to do.
    // A card about this project is the owner's ball whoever holds it (the desk raises some on a project's behalf).
    const open=all<{action_id:string;cell_id:string|null;related_project_ids:string;subject_key:string}>(db,
      "SELECT action_id,cell_id,related_project_ids,subject_key FROM human_items WHERE status IN ('pending','snoozed')");
    const cards=open.filter(h=>(h.cell_id && idSet.has(h.cell_id)) || (JSON.parse(h.related_project_ids) as string[]).includes(projectId ?? cellId));
    const human = cards.length > 0;
    if (human) why.push(`${cards.length} card(s) await the owner`);

    const stalled = !parked && !agent && !external && !internal && !human;
    return {
      cellId,
      agent: agent !== undefined,
      external: external !== undefined,
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
    const counts = get<{ total:number; snoozed:number }>(db,`
      SELECT count(*) AS total, count(*) FILTER (WHERE snoozed_until > ?) AS snoozed FROM human_items
      WHERE category='decision' AND status IN ('pending','snoozed')`,[now])!;
    return {
      backgroundCells: live.filter((c) => c.parentId !== null).length,
      pausedCells: live.filter((c) => c.status === "paused").length,
      runningRuns: core.dispatcher.activeRuns().length,
      busyCells: busy,
      runningJobs: [...f.jobs.values()].reduce((n, js) => n + js.length, 0),
      waitingCells: waiting,
      pendingApprovals: counts.total-counts.snoozed,
      snoozedApprovals: counts.snoozed,
    };
  }

  return { rosterFor, childSummaries, tree, stats, activeWorkspaces, anchorsOf, groundedWaits, tailNotes, activityOf, blockingChildren, busyLeafChildren };
}
