import { inboxAddr,
  cellIdOf,
  isInboxAddr,
  all,
  get,
  CELL_STATUS_KEY,
  isLeafLifetime,
  PAYLOAD,
  projectCellIdOf,
  pullCursorKey,
  type CellRecord,
  type CellStatusLine,
  type Envelope,
  type ChildSummary,
  type WorkspaceOccupancy,
  type WorkspaceUser,
} from "@ng/protocol";
import { isProjectRoot, type KernelCore } from "./core";
import type { AnchorReport, CellActivity, CellNode, KernelStats, RosterEntry } from "./types";
import { lastRunStart, pauseLine, prePauseNote, resumeNote } from "./pauses";
import { WAIT_HUMAN, waitTargetCell, type WaitRecord } from "./waits";
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
  pendingSettlement(cellId: string, stopChildren?: boolean): string[];
  blockingChildren(cellId: string): Array<{ cell: CellRecord; why: string }>;
  /** Leaf children of `cellId` that hold a slot of maxConcurrentChildren: active and not dormant. */
  busyLeafChildren(cellId: string): CellRecord[];
  /** docs/05 guard 2: the five anchors of a cell's subtree. */
  anchorsOf(cellId: string): AnchorReport;
  /**
   * Internal waits whose target can make progress for the waiting cell. `afterTurn`: asked when the target's own turn
   * has just ended — that it is (still) busy then says nothing about whether it answers.
   */
  groundedWaits(waits: readonly WaitRecord[], localCells: ReadonlySet<string>, opts?: { afterTurn?: boolean }): WaitRecord[];
  /**
   * Context's tailNotesProvider: the volatile notes a coordinating cell sees after its roster. `runId`: the Run that
   * will read them (its own start is already on record when they are read again after the preset's bookkeeping).
   */
  tailNotes(cellId: string, incoming?: readonly Envelope[], runId?: string): string[];
  /**
   * The waits of these cells that are still unanswered: an open wait whose answer already sits in the cell's inbox (or
   * is being acted on in its current turn) is closed when that turn settles — to an onlooker it is no longer a wait.
   */
  openWaits(cellIds?: readonly string[]): WaitRecord[];
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
      WHERE cell_id IS NOT NULL AND category='decision' AND status IN ('pending','snoozed') GROUP BY cell_id`);
    for (const a of pending) if (keep(a.cell_id)) f.pending.set(a.cell_id, a.count);
    return f;
  }

  function activity(c: CellRecord, f: Facts, waiting: ReadonlySet<string>): CellActivity {
    if (c.status === "closed") return { state: "closed", why: `closed (${c.closeReason ?? "completed"})` };
    if (core.dispatcher.isRunning(c.id)) return { state: "working", cause: "run", why: "a run is in flight" };
    const jobs = f.jobs.get(c.id);
    if (jobs?.length) return { state: "working", cause: "job", why: `a background job is running (${jobs[0]!.command.slice(0, 60)})` };
    if (c.status === "paused") return { state: "paused", why: "paused" };
    if (f.due.has(c.id)) return { state: "working", cause: "message", why: "a message is waiting to start its next run" };
    if (f.pending.get(c.id)) return { state: "waiting", cause: "card", why: "a card of its awaits the owner" };
    if (waiting.has(c.id)) return { state: "waiting", cause: "wait", why: "it has an open wait" };
    if (f.watching.has(c.id)) return { state: "waiting", cause: "watch", why: "it watches for an outside event" };
    if (f.nextTimer.has(c.id)) return { state: "waiting", cause: "timer", why: `it has a timer at ${new Date(f.nextTimer.get(c.id)!).toISOString()}` };
    // Nothing in flight and nothing that would wake it. For a leaf that is the resting state; a coordinator in the
    // same position is simply idle between the events of its project.
    if (!isLeafLifetime(c.spec.lifetime)) return { state: "idle", why: "idle" };
    // A leaf that was given spawn depth on purpose is not at rest while a cell of its own is still at work: its
    // result will wake it, and closing it now would take that cell down with it.
    if (c.bounds.maxDepth > 0) {
      const below = cells.children(c.id, { status: ["active", "paused"] });
      const busy = below.length > 0 ? [...activities(below).values()].find((a) => a.state !== "dormant") : undefined;
      if (busy) return { state: "waiting", cause: "child", why: "a cell it started is still at work" };
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

  function pendingSettlement(cellId: string, stopChildren?: boolean): string[] {
    const c = cells.require(cellId);
    if (!isProjectRoot(core.registry, c)) return [];
    const preset = c.preset ? core.registry.presets.get(c.preset) : undefined;
    const actions = preset?.actionBooks?.(core, cellId)?.list() ?? [];
    return [...actions.filter(a => a.status === "open" && !(stopChildren && a.owner !== "human" && a.cellId && cells.get(a.cellId)?.parentId === cellId)).map(a => a.title),
      ...core.workspace.listJobsSync({cellId, state: ["running"]}).map(j => j.command)];
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

  /**
   * The open waits of a cell whose answer already sits in its inbox, or is being acted on in its current turn: they are
   * closed when that turn settles, and nobody who looks at the cell meanwhile should take it to be still waiting.
   */
  function answeredWaits(): (cellId: string) => ReadonlySet<string> {
    const seen = new Map<string, ReadonlySet<string>>();
    return (cellId) => {
      let ids = seen.get(cellId);
      if (!ids) {
        const queued = inbox.listMessagesSync({ cellId, status: ["pending", "claimed"] }).filter((m) => m.deliverAt <= clock.now()).map((m) => m.envelope);
        seen.set(cellId, (ids = new Set(core.waits.wouldAnswer(cellId, queued).map((w) => w.waitId))));
      }
      return ids;
    };
  }

  function openWaits(cellIds?: readonly string[]): WaitRecord[] {
    const answered = answeredWaits();
    return core.waits.list(cellIds).filter((w) => {
      if (answered(w.cellId).has(w.waitId)) return false;
      // Nor for somebody who is gone (such a wait is no anchor either).
      return !(isInboxAddr(w.waitingFor) && cells.get(cellIdOf(w.waitingFor))?.status === "closed");
    });
  }

  function childSummaries(cellId: string): ChildSummary[] {
    const waits = new Map<string, string[]>();
    const roster = rosterFor(cellId);
    if (roster.length === 0) return [];
    const answered = answeredWaits();
    for (const w of core.waits.list(roster.map((r) => r.cellId))) {
      const list = waits.get(w.cellId) ?? [];
      const party = `waiting for ${w.waitingFor} (${w.reason})`;
      const when = core.dispatcher.isRunning(w.cellId) ? "it has the answer and is acting on it now" : "the answer is in its inbox; it acts on it at its next turn";
      list.push(answered(w.cellId).has(w.waitId) ? `was ${party} — ${when}` : party);
      waits.set(w.cellId, list);
    }
    const act = activityOf(roster.map((r) => r.cellId));
    return roster.map((r) => {
      const parts: string[] = [];
      const a = act.get(r.cellId);
      const child = cells.get(r.cellId);
      if (r.statusLine) parts.push(r.statusLine);
      if (r.running) parts.push("working now");
      else if (a?.cause === "message") parts.push("a message is queued for it; its next turn has not started yet");
      else if (a?.state === "dormant") parts.push("dormant — its turn is over; send_message to it wakes it with everything it knows");
      const paused = r.status === "paused" ? pauseLine(core, r.cellId) : null;
      if (paused) parts.push(paused);
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
        a === undefined || a.state === "closed" ? undefined : a.state === "idle" ? "waiting" : a.cause === "message" ? "queued" : a.state;
      return {
        cellId: r.cellId,
        ...(child && {processorKind: child.spec.processor.kind}),
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
    const runs = core.dispatcher.running().map(r => ({ ...r, state: "running" as const }));
    const jobs = core.workspace.listJobsSync({ state: ["running"] }).map(j => ({ ...j, state: "job" as const }));
    const byKey = new Map<string, WorkspaceOccupancy>();
    for (const { cellId, cwd, state } of [...runs, ...jobs]) {
      const c = cells.get(cellId);
      if (!c || !cwd) continue;
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
        state,
        statusLine: formatStatus(statusOf(context.readStateSync(c.id, CELL_STATUS_KEY))),
      };
      let o = byKey.get(key);
      if (!o) byKey.set(key, (o = { key, active: [] }));
      if (!o.active.some(u => u.cellId === c.id && u.cwd === cwd)) o.active.push(user);
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
      all = all.filter((o) => o.key === own);
    }
    // "Who else": not the reader, and not the coordinators above it whose turn merely overlaps — they sent it here
    // (a background command of theirs is still someone working in the tree).
    // Nor any other coordinator that merely has a turn in flight: a desk, project or hub hands the work out and
    // changes no files itself, so its turn is nobody working in the tree (its background command still is).
    const above = new Set(cells.ancestors(forCell.id).map((a) => a.id));
    const coordinating = (id: string) => {
      const c = cells.get(id);
      return above.has(id) || (c !== undefined && !isLeafLifetime(c.spec.lifetime));
    };
    all = all.map((o) => ({ ...o, active: o.active.filter((u) => u.cellId !== forCell.id && !(u.state === "running" && coordinating(u.cellId))) })).filter((o) => o.active.length > 0);
    if (all.length === 0) return null;
    const who = (u: WorkspaceUser) => {
      const where = u.cwd !== all.find((o) => o.active.includes(u))?.key ? ` in ${u.cwd}` : "";
      const project = u.projectTitle ? ` of project "${u.projectTitle}"` : "";
      return `${u.cellId}${u.title ? ` "${u.title}"` : ""}${u.preset ? ` (${u.preset})` : ""}${project}${where} — ${u.state === "job" ? "background job started from here" : "working"}${u.statusLine ? `: ${u.statusLine}` : ""}`;
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
        blocks.push(`## ${n.name}\n(not shown: the notes above already fill the space — read_resource("working_note://${n.name}"))`);
        continue;
      }
      const body = n.body.trim();
      const shown = body.length > left ? `${body.slice(0, left)}\n… (cut here; the rest: read_resource("working_note://${n.name}"). Keep notes short — rewrite instead of appending.)` : body;
      left -= shown.length;
      blocks.push(`## ${n.name}\n${shown}`);
    }
    return `[your notes — kept across every wake-up; update with save_note]\n${blocks.join("\n\n")}`;
  }

  function tailNotes(cellId: string, incoming: readonly Envelope[] = [], runId?: string): string[] {
    const cell = cells.get(cellId);
    if (!cell) return [];
    const leaf = isLeafLifetime(cell.spec.lifetime);
    const notes: string[] = [];
    // A wait the messages of this wake-up answer is closed when the Run settles; it is no longer something to act on.
    const answered = new Set(core.waits.wouldAnswer(cellId, incoming).map((w) => w.waitId));
    const all_ = core.waits.list([cellId]);
    const own = all_.filter((w) => !answered.has(w.waitId));
    const waitLine = (w: WaitRecord) => `- waiting for ${w.waitingFor}: ${w.reason} [${w.waitId}]`;
    if (own.length) {
      notes.push(`[your open waits]\n${own.map((w) => `${waitLine(w)}${w.timeoutAt ? ` (times out ${new Date(w.timeoutAt).toISOString()})` : ""}`).join("\n")}`);
    }
    if (answered.size) {
      notes.push(`[waits closed by this wake-up — answered by the party you waited for, or by the owner speaking to you. Nothing to clear; if you still need what you were waiting for, wait again]\n${all_.filter((w) => answered.has(w.waitId)).map(waitLine).join("\n")}`);
    }
    // A leaf's parent is told when the leaf's turn ends and reads what it did: its wait needs no message from the leaf.
    const answeredIn = answeredWaits();
    const waiting = all<{cell_id: string; wait_id: string; ref_id: string | null; reason: string}>(db, `SELECT w.cell_id, w.wait_id, w.ref_id, w.reason FROM cell_waits w
      JOIN cells c ON c.id=w.cell_id AND c.epoch=w.epoch AND c.status='active' WHERE w.waiting_for=? ORDER BY w.created_at`, [`inbox:${cellId}`])
      .filter(w => !(leaf && w.cell_id === cell.parentId))
      .filter(w => !answeredIn(w.cell_id).has(w.wait_id));
    if (waiting.length) notes.push("[cells waiting on you]\n" + waiting.map(w => `${w.cell_id} [waitId=${w.wait_id}${w.ref_id && w.ref_id !== w.wait_id ? `, refId=${w.ref_id}` : ""}] ${w.reason}`).join("\n"));
    const resumed = resumeNote(core, cellId, runId);
    if (resumed) notes.push(resumed);
    // Messages handed to an earlier turn that never settled (the workbench was restarted, the turn failed) come again
    // unchanged: say so, or the same work is started twice without a second look.
    const again = !runId || !incoming.length ? [] : all<{ id: string }>(db, `SELECT m.envelope_id AS id FROM inbox_messages m
      JOIN inbox_claims c ON c.claim_id=? WHERE m.cell_id=? AND m.type<>? AND m.first_claimed_at<c.claimed_at
        AND m.envelope_id IN (SELECT value FROM json_each(?))`, [runId, cellId, PAYLOAD.controlSteer, JSON.stringify(incoming.map((e) => e.id))]);
    if (again.length) {
      notes.push(`[delivered again — ${again.length === incoming.length ? "these message(s)" : "the messages below"} were already given to an earlier turn of yours that was cut off before it finished. Your record shows how far it got: check what is already done and continue from there]\n${again.map((r) => `- ${r.id}`).join("\n")}`);
    }
    const fromBefore = prePauseNote(core, cellId, incoming);
    if (fromBefore) notes.push(fromBefore);
    // What this cell has on the owner's list, with the numbers a decision is checked against. The desk also holds what
    // belongs to no cell: the owner's personal reminders that have come due.
    const personal = cellId === core.deskCellId ? " OR (h.cell_id IS NULL AND (h.due_at IS NULL OR h.due_at<=?))" : "";
    const held = all<{action_id: string; category: string; subject_key: string; status: string; card: string; item_revision: number; artifact_id: string | null; version: number | null}>(db, `SELECT h.action_id,h.category,h.subject_key,h.status,h.card,h.item_revision,h.artifact_id,a.version
      FROM human_items h LEFT JOIN artifacts a ON a.artifact_id=h.artifact_id
      WHERE (h.cell_id=?${personal}) AND h.status IN ('pending','snoozed')`, personal ? [cellId, clock.now()] : [cellId]);
    const seen = (h: (typeof held)[number]) => `rev ${h.item_revision}${h.artifact_id ? ` about ${h.artifact_id} v${h.version ?? "?"}` : ""}`;
    const heldById = new Map(held.map((h) => [h.action_id, h]));
    const listed = new Set<string>();
    if (isProjectRoot(core.registry, cell)) {
      const preset = cell.preset ? core.registry.presets.get(cell.preset) : undefined;
      const openActions = (preset?.actionBooks?.(core, cellId)?.list() ?? []).filter(a => a.status === "open");
      if (openActions.length) {
        notes.push("[your open actions]\n" + openActions.map(a =>
          `- ${a.id}${heldById.has(a.id) ? ` ${seen(heldById.get(a.id)!)}` : ""} [${a.owner}] "${a.title}"${a.cellId ? ` (cell ${a.cellId})` : ""}${a.phase ? ` (phase ${a.phase})` : ""}${a.nextStep && a.nextStep !== a.title ? ` — ${a.nextStep}` : ""}`
        ).join("\n"));
        for (const a of openActions) listed.add(a.id);
      }
    }
    // An action that is the owner's to do is shown once, under the actions above; what is left are the cards.
    const cards = held.filter((h) => !listed.has(h.action_id));
    if (cards.length) notes.push("[your open cards]\n" + cards.map(c => {
      let title = "";
      let body = "";
      try {
        const parsed = JSON.parse(c.card) as { title?: string; body?: string };
        title = parsed.title?.trim() ?? "";
        body = parsed.body?.trim() ?? "";
      } catch { /* ignore malformed card json */ }
      const detail = c.category === "action" && body && body !== title ? ` — ${body.replace(/\s+/g, " ").slice(0, 120)}` : "";
      return `${c.action_id} ${seen(c)} [${c.category}]${title ? ` "${title}"` : ""} ${c.subject_key} (${c.status})${detail}`;
    }).join("\n"));
    // … and what it has set to fire later: for the desk these are the owner's reminders, which become items only when
    // they fire — nothing else shows them to it.
    const timers = inbox
      .listMessagesSync({ cellId, type: PAYLOAD.timerFired, status: ["pending"] })
      .filter((m) => m.deliverAt > clock.now() && !incoming.some((e) => e.id === m.envelope.id))
      .sort((a, b) => a.deliverAt - b.deliverAt)
      .slice(0, 20);
    if (timers.length) notes.push("[your timers that have not fired yet]\n" + timers.map((m) => {
      const label = (m.envelope.payload as { label?: unknown } | null)?.label;
      return `${new Date(m.deliverAt).toISOString()}${typeof label === "string" && label ? ` "${label}"` : ""}${m.cancelGroup ? ` cancelGroup "${m.cancelGroup}"` : ""}`;
    }).join("\n"));
    const jobs = core.workspace.listJobsSync({ cellId, state: ["running"] });
    if (jobs.length) notes.push("[your running jobs]\n" + jobs.map(j => `${j.jobId} ${j.command.slice(0,120)}`).join("\n"));
    const authors = leaf ? [cellId] : [cellId, ...cells.descendants(cellId).map(c => c.id)];
    // The owner's edits since this cell's last turn (the turn reading this note does not count), per document: the
    // newest version they saved — also when a cell has saved a newer one on top since — and any document with an open
    // card whose current text is the owner's.
    const since = Math.max(clock.now() - 86_400_000, lastRunStart(core, cellId, runId));
    const edits = all<{artifact_id:string; version:number; current:number}>(db, `SELECT a.artifact_id, max(v.version) AS version, a.version AS current
      FROM artifacts a JOIN artifact_versions v ON v.artifact_id=a.artifact_id AND v.updated_by='human'
      WHERE a.cell_id IN (SELECT value FROM json_each(?)) AND (v.created_at>=? OR
        (v.version=a.version AND EXISTS(SELECT 1 FROM human_items h WHERE h.artifact_id=a.artifact_id AND h.status IN ('pending','snoozed'))))
      GROUP BY a.artifact_id ORDER BY max(v.created_at) DESC LIMIT 12`, [JSON.stringify(authors), since]);
    if (edits.length) notes.push("[human-edited artifacts — changed by the owner since you last looked; read_artifact before you rely on or write to them]\n" + edits.map(a => `${a.artifact_id} v${a.version}${a.current > a.version ? ` (a cell has saved v${a.current} on top since)` : ""}`).join("\n"));
    const watches = all<{id:number; thread:string | null; cancel_group:string | null}>(db, "SELECT id,thread,cancel_group FROM cell_watches WHERE active=1 AND cell_id=?", [cellId]);
    const schedules = inbox.listSchedulesSync({cellId, activeOnly:true});
    if (watches.length || schedules.length) notes.push("[your active watches & schedules]\n" + [
      ...watches.map(w => `watch ${w.id}${w.thread ? ` thread ${w.thread}` : ""}${w.cancel_group ? ` cancelGroup "${w.cancel_group}"` : ""}`),
      ...schedules.map(s => `schedule ${s.id}${s.cron ? ` cron "${s.cron}"${s.tz ? ` (${s.tz})` : ""}` : ""}${s.cancelGroup ? ` cancelGroup "${s.cancelGroup}"` : ""} next ${s.nextFireAt !== null ? new Date(s.nextFireAt).toISOString() : "none"}`),
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

  function groundedWaits(waits: readonly WaitRecord[], localCells: ReadonlySet<string>, opts: { afterTurn?: boolean; facts?: Facts } = {}): WaitRecord[] {
    const cachedFacts = opts.facts;
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
    const cards = all<{cell_id:string; subject_key:string; related_project_ids:string}>(db, `SELECT cell_id, subject_key, related_project_ids FROM human_items
      WHERE cell_id IS NOT NULL AND category='decision' AND status IN ('pending','snoozed')`);
    const incidents = openIncidentWaits();
    const cardOwners = new Set(cards.map(card => card.cell_id));
    // A cell that itself waits for the owner and holds an open item of any kind (a card, or an action it recorded as
    // the owner's) is woken when the owner acts on it, and can then answer whoever waits on it.
    const itemOwners = new Set(all<{cell_id:string}>(db, `SELECT DISTINCT cell_id FROM human_items
      WHERE cell_id IS NOT NULL AND status IN ('pending','snoozed')`).map(r => r.cell_id));
    const askedOwner = new Set(core.waits.list().filter(w => w.waitingFor === WAIT_HUMAN && live.get(w.cellId)?.epoch === w.epoch && itemOwners.has(w.cellId)).map(w => w.cellId));
    const hasSource = (id: string) => working.has(id) || f.jobs.has(id) || f.due.has(id) || f.watching.has(id) || f.nextTimer.has(id) || cardOwners.has(id) || askedOwner.has(id);
    const requests = inbox.listMessagesSync({status:["pending","claimed"]}).filter(m => m.envelope.delivery !== "silent_inject" &&
      (m.expectedEpoch === null || m.expectedEpoch === live.get(m.cellId)?.epoch));
    // A result one of the coordinator's own leaves (a fixer) has just handed it, not yet taken in or still being
    // worked on: the coordinator is about to act on it, for the projects that leaf was started for.
    const resultFor = (target: string, project: string | undefined) => requests.some(m => {
      if (m.cellId !== target || m.envelope.type !== PAYLOAD.cellResult) return false;
      const child = allCells.get(waitTargetCell(m.envelope.from) ?? "");
      if (!child || child.parentId !== target || !isLeafLifetime(child.spec.lifetime)) return false;
      const related = child.spec.meta?.relatedProjectIds;
      return !Array.isArray(related) || (project !== undefined && related.includes(project));
    });
    function canAnswer(from: string, target: string, seen: Set<string>, wait?: WaitRecord): boolean {
      const t = live.get(target);
      if (!t || seen.has(target) || inCycle(target)) return false;
      const path = new Set(seen).add(target);
      if (!localCells.has(target) && !isLeafLifetime(t.spec.lifetime)) {
        // An outside coordinator must have work for this particular requester.
        const owner = cells.require(from);
        const project = isProjectRoot(core.registry, owner) ? from : cells.ancestors(from).find(c => isProjectRoot(core.registry, c))?.id;
        // The coordinator is in the middle of a turn (or has one about to start): whether it answers this requester is
        // known when that turn is over, not before. The owner decides the arbitration card, the card is gone, and the
        // desk is at that moment writing to the waiters — judging now would call every one of them stranded. The end
        // of the turn re-evaluates (run.finished), and the desk's own after-turn check asks with `afterTurn`.
        if (!opts.afterTurn && (working.has(target) || f.due.has(target))) return true;
        if (requests.some(m => m.cellId === target && waitTargetCell(m.envelope.from) === from)) return true;
        if (wait && incidents.some(i => i.cell_id === target && i.cellId === from &&
          i.waitId === wait.waitId && i.registrationId === wait.registrationId)) return true;
        const refs = [wait?.refId, wait?.waitId];
        if (cards.some(c => c.cell_id === target && !c.subject_key.startsWith("kernel:stalled:") &&
          (c.subject_key === `cell:${from}` || refs.includes(c.subject_key) ||
          (!wait?.refId && project && JSON.parse(c.related_project_ids).includes(project))))) return true;
        if (resultFor(target, project)) return true;
        if (!project) return false;
        return cells.children(target,{status:["active"]}).some(c => isLeafLifetime(c.spec.lifetime) &&
          Array.isArray(c.spec.meta?.relatedProjectIds) && c.spec.meta.relatedProjectIds.includes(project) && canAnswer(target, c.id, path));
      }
      return hasSource(target) || (edges.get(target) ?? []).some(next => canAnswer(target, next, path));
    }
    return internal.filter(w => live.get(w.cellId)?.epoch === w.epoch && canAnswer(w.cellId, waitTargetCell(w.waitingFor)!, new Set([w.cellId]), w));
  }

  function openIncidentWaits() {
    return all<{cell_id: string; wait_ids: string; action_id: string}>(db, `SELECT h.cell_id,i.wait_ids,h.action_id
      FROM stall_incidents i JOIN human_items h ON h.action_id=i.escalation_id WHERE h.status IN ('pending','snoozed')`)
      .flatMap(row => (JSON.parse(row.wait_ids) as Pick<WaitRecord, "cellId" | "waitId" | "registrationId">[])
        .map(wait => ({...wait, cell_id: row.cell_id, actionId: row.action_id})));
  }

  function anchorsOf(cellId: string): AnchorReport {
    const root = cells.get(cellId);
    const empty: AnchorReport = { cellId, agent: false, external: false, internal: false, human: false, parked: true, stalled: false, detail: "no such cell" };
    if (!root) return empty;

    if (root.status !== "active" || cells.ancestors(cellId).some(c => c.status !== "active")) {
      return { ...empty, detail: "cell or ancestor is inactive" };
    }
    const subtree = [root, ...cells.descendants(cellId, { status: ["active", "paused"] })].filter((c) => c.status !== "closed");
    const ids = subtree.map((c) => c.id);
    const idSet = new Set(ids);
    const projectId = isProjectRoot(core.registry, root) ? cellId : cells.ancestors(cellId).find(c=>isProjectRoot(core.registry, c))?.id;
    const why: string[] = [];

    // Descendants are ordered by depth. A manually parked ancestor suspends its whole branch.
    const active = new Set<string>();
    for (const cell of subtree) {
      if (cell.status === "active" && (cell.id === cellId || active.has(cell.parentId!))) active.add(cell.id);
    }
    const available = [...active];
    const waits = core.waits.list(available);
    const f = facts(waits.some(w => waitTargetCell(w.waitingFor) !== null) ? undefined : available);
    const working = new Set(core.dispatcher.running().filter(r => !r.stallOnly).map(r => r.cellId));
    const agent = available.find(id => working.has(id) || f.jobs.has(id) || f.due.has(id));
    if (agent) why.push(`${agent} has a run, job or queued work`);
    const external = available.find(id => f.watching.has(id) || f.nextTimer.has(id));
    if (external) why.push(`${external} has an active watch or timer`);

    // 3. @Waiting(internal) — an open wait on a cell that can still answer.
    const backed = groundedWaits(waits, idSet, { facts: f });
    const internal = backed.length > 0;
    if (backed[0]) why.push(`${backed[0].cellId} waits for ${backed[0].waitingFor}`);

    // 4. @Human — a card, or an open action that is the owner's to do.
    // A card about this project is the owner's ball whoever holds it (the desk raises some on a project's behalf).
    const open=all<{action_id:string;cell_id:string|null;related_project_ids:string;subject_key:string;category:string}>(db,
      "SELECT action_id,cell_id,related_project_ids,subject_key,category FROM human_items WHERE status IN ('pending','snoozed')");
    const incidents = new Set(openIncidentWaits().filter(i => waits.some(w => w.cellId === i.cellId && w.waitId === i.waitId && w.registrationId === i.registrationId)).map(i => i.actionId));
    const cards=open.filter(h=>incidents.has(h.action_id) || (h.cell_id && idSet.has(h.cell_id)) || (JSON.parse(h.related_project_ids) as string[]).includes(projectId ?? cellId));
    const strandedWaits = waits.filter(w => waitTargetCell(w.waitingFor) !== null && !backed.includes(w));
    const stranded = strandedWaits.length > 0;
    const human = cards.some(card => !stranded || card.category === "decision");
    if (human) why.push(`${cards.length} card(s) await the owner`);

    const stalled = !agent && !external && !internal && !human;
    // Say what was actually found: a model told "the owner has no card" while its own notes list one stops trusting both.
    const nothing = "nothing is running or queued, and no watch or timer is set";
    const detail = !stalled ? why.join("; ")
      : stranded ? `${nothing}; ${strandedWaits.map(w => `${w.cellId} waits for ${w.waitingFor} (${w.reason.replace(/\s+/g, " ").slice(0, 80)}), which has nothing in flight that would produce an answer`).join("; ")}${cards.length ? `; ${cards.length} open item(s) with the owner do not answer that wait` : ""}`
      : `${nothing}, no open wait points at a live cell, and the owner has no card or open action`;
    return {
      cellId,
      agent: agent !== undefined,
      external: external !== undefined,
      internal,
      human,
      parked: false,
      stalled,
      detail,
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
      else if (c.parentId !== null && (f.watching.has(c.id) || f.nextTimer.has(c.id))) waiting++;
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

  return {
    rosterFor, childSummaries, tree, stats, activeWorkspaces, anchorsOf, tailNotes, activityOf, pendingSettlement, blockingChildren, busyLeafChildren, openWaits,
    groundedWaits: (waits, localCells, opts) => groundedWaits(waits, localCells, opts?.afterTurn ? { afterTurn: true } : {}),
  };
}
