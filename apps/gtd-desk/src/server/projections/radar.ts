import type { CellNode } from "@ng/cell";
import { all, type ActionRecord, type BallOwner, type CellRecord } from "@ng/protocol";
import {
  BALL_LABEL,
  type ArtifactRefDTO,
  type ButtonDTO,
  type ProgressDTO,
  type ProjectActionDTO,
  type ProjectRowDTO,
  type ProjectWorkerDTO,
  type RadarDTO,
  type WaitingDTO,
} from "../../shared/api";
import { projectOfAction, readActions, readProjects, type DeskKernel, type Located, type ProjectionInput } from "./common";
import { button, enc, ownerLabel, pauseInfoOf, post, progressDTO, waitingDeadline, waitingDTO } from "./format";
import { projectReview } from "./review";
import { weekStart, whenText } from "./time";

/** Display priority when aggregating a project's open actions: 🔵 > 🟢 > 🟡. */
const BALL_OWNER_PRIORITY: readonly BallOwner[] = ["human", "agent", "waiting"];

function compareBallOwner(a: BallOwner, b: BallOwner): number {
  return BALL_OWNER_PRIORITY.indexOf(a) - BALL_OWNER_PRIORITY.indexOf(b);
}

/** The ball owner a project row shows: the highest-priority owner among its open actions (null if none open). */
export function topBallOwner(actions: Iterable<Pick<ActionRecord, "owner" | "status">>): BallOwner | null {
  let best: BallOwner | null = null;
  for (const a of actions) {
    if (a.status !== "open") continue;
    if (best === null || compareBallOwner(a.owner, best) < 0) best = a.owner;
  }
  return best;
}

export const STALLED_TEXT = "没有在推进的任务、没有在等的回复，也没有下一步 — 补上下一步，或移进以后再说";

interface Activity {
  running: number;
  waiting: number;
  /** First status line of a busy cell (what the agent is doing right now). */
  busy: { cellId: string; statusLine: string | null } | null;
  /** What the first waiting cell waits for ("「等 CI」下次检查 今天 14:32"). */
  waitLine: string | null;
}

type KernelActivity = ReturnType<DeskKernel["activityOf"]>;

function flatten(nodes: readonly CellNode[], into = new Map<string, CellNode>()): Map<string, CellNode> {
  for (const n of nodes) {
    into.set(n.cellId, n);
    flatten(n.children, into);
  }
  return into;
}

/** The kernel's account of what a cell is doing, in the row's four words (a dormant worker is resting: "idle"). */
function nodeState(n: CellNode, activity: KernelActivity): ProjectWorkerDTO["state"] {
  switch (activity.get(n.cellId)?.state) {
    case "working":
      return "running";
    case "paused":
      return "paused";
    case "waiting":
      return "waiting";
    case undefined:
      return n.status === "paused" ? "paused" : n.running || n.runningJobs > 0 ? "running" : n.watching || n.nextTimerAt !== null ? "waiting" : "idle";
    default:
      return "idle";
  }
}

function waitLineOf(n: CellNode, now: number): string {
  const what = n.nextTimerAt !== null ? `下次检查 ${whenText(n.nextTimerAt, now)}` : n.watching ? (n.threads.length ? `盯着 ${n.threads.join("、")}` : "盯着外部事件") : "在等回音";
  return n.title ? `「${n.title}」${what}` : what;
}

function subtreeActivity(node: CellNode | undefined, activity: KernelActivity, now: number): Activity {
  const a: Activity = { running: 0, waiting: 0, busy: null, waitLine: null };
  const walk = (n: CellNode) => {
    if (n.status !== "closed") {
      const s = nodeState(n, activity);
      if (s === "running") {
        a.running++;
        if (!a.busy || (!a.busy.statusLine && n.statusLine)) a.busy = { cellId: n.cellId, statusLine: n.statusLine };
      } else if (s === "waiting") {
        a.waiting++;
        a.waitLine ??= waitLineOf(n, now);
      }
    }
    n.children.forEach(walk);
  };
  if (node) walk(node);
  return a;
}

/** The live cells below a project (its workers and checkers, and theirs), excluding cells that are projects of their own. */
function workersOf(node: CellNode | undefined, activity: KernelActivity, projectCells: ReadonlySet<string>): ProjectWorkerDTO[] {
  const out: ProjectWorkerDTO[] = [];
  const walk = (n: CellNode) => {
    for (const c of n.children) {
      if (c.status === "closed" || projectCells.has(c.cellId)) continue;
      out.push({ cellId: c.cellId, title: c.title?.trim() || "未命名项目", preset: c.preset, state: nodeState(c, activity), statusLine: c.statusLine });
      walk(c);
    }
  };
  if (node) walk(node);
  return out;
}

/** Every cell of a project's subtree, closed ones included (finished workers' reports stay with the project). */
function subtreeIds(rootId: string, byParent: ReadonlyMap<string, CellRecord[]>): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) for (const c of byParent.get(out[i]!) ?? []) out.push(c.id);
  return out;
}

/** BUG-010: the project's reports and drafts (its own and its cells'), newest first — each opens in the drawer. */
function projectArtifacts(kernel: DeskKernel, ids: readonly string[]): ArtifactRefDTO[] {
  return ids
    .flatMap((id) => kernel.context.listArtifactsSync(id))
    .filter((a) => a.content.format !== "card")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((a) => ({ artifactId: a.artifactId, title: a.content.title ?? "未命名文档", version: a.version, updatedAt: a.updatedAt }));
}

/** The entry to the Agents view: "3 个分身（1 个在跑） →". */
function agentsEntry(projectId: string, ids: readonly string[], cells: ReadonlyMap<string, CellRecord>, activity: KernelActivity): ProjectRowDTO["agents"] {
  const below = ids.filter((id) => id !== projectId && cells.get(id)?.status !== "closed");
  const running = below.filter((id) => activity.get(id)?.state === "working").length;
  const total = below.length;
  const label = total === 0 ? "查看分身实况 →" : running > 0 ? `${total} 个分身（${running} 个在跑） →` : `${total} 个分身 →`;
  return { total, running, href: `#/agents?project=${enc(projectId)}`, label };
}

function actionText(r: ActionRecord, now: number): { text: string; progress: ProgressDTO | null; waiting: WaitingDTO | null } {
  const progress = progressDTO(r.progress, r.owner === "agent" ? r.title : undefined);
  const waiting = r.owner === "waiting" ? waitingDTO(r.waiting, now) : null;
  switch (r.owner) {
    case "human":
      return { text: r.nextStep || r.title, progress, waiting };
    case "agent":
      return { text: progress?.text ?? r.title, progress, waiting };
    case "waiting":
      return { text: waiting ? `${r.waiting?.description || r.title} (${waiting.text})` : r.title, progress, waiting };
  }
}

function sumProgress(list: readonly ProgressDTO[]): ProgressDTO | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0]!;
  const done = list.reduce((n, p) => n + p.done, 0);
  const total = list.reduce((n, p) => n + p.total, 0);
  const label = list[0]!.label;
  return { done, total, label, text: label ? `${label} 等 ${done}/${total}` : `${done}/${total}` };
}

function mergeWaiting(list: readonly WaitingDTO[]): WaitingDTO | null {
  if (list.length <= 1) return list[0] ?? null;
  const parties = list.flatMap((w) => w.parties);
  const replied = parties.filter((p) => p.replied).length;
  const due = list.map((w) => w.dueAt).filter((d): d is number => d !== null);
  return { ...list[0]!, parties, replied, total: parties.length, dueAt: due.length ? Math.min(...due) : null, text: `已回 ${replied}/${parties.length}` };
}

function projectButtons(id: string, parked: boolean, paused: boolean, stalled: boolean, jobs:number): ButtonDTO[] {
  const base = `/api/projects/${enc(id)}`;
  const cancel = button({ id: "cancel", label: "✕ 取消项目", endpoint: post(`${base}/cancel`), confirm: "取消后会立即停止这个项目的全部后台任务，确定吗？" });
  if (parked) {
    return [button({ id: "activate", label: "↺ 重新启动", primary: true, endpoint: post(`${base}/activate`) }), cancel];
  }
  const out: ButtonDTO[] = [];
  if (stalled) {
    out.push(
      button({
        id: "add_action",
        label: "补上下一步",
        primary: true,
        endpoint: post(`${base}/actions`),
        input: { field: "title", kind: "text", placeholder: "下一步具体做什么？" },
      }),
    );
  }
  out.push(
    paused
      ? button({ id: "resume", label: "▶ 继续", primary: !stalled, endpoint: post(`${base}/resume`) })
      : button({ id: "pause", label: "⏸ 暂停", ...(jobs ? {confirm:`有 ${jobs} 个长任务仍在运行。确认暂停这个项目？`} : {}), endpoint: post(`${base}/pause`) }),
  );
  out.push(cancel);
  out.push(button({ id: "complete", label: "✓ 完结", group: "more", endpoint: post(`${base}/complete`), confirm: "标记整个项目已完成？进行中的后台任务会一并结束。" }));
  out.push(button({ id: "someday", label: "📦 移进以后再说", group: "more", endpoint: post(`${base}/someday`), hint: "暂停全部后台任务，以后可以重新启动" }));
  return out;
}

/** Project rows and counts (the left column); `projectRadar` adds the weekly review. */
export function radarProjects(input: ProjectionInput): Omit<RadarDTO, "review"> {
  const { kernel, now } = input;
  const projects = readProjects(kernel);
  const projectCells = new Set(projects.map((p) => p.cellId));
  const nodes = flatten(kernel.tree());
  const cellList = kernel.listCells();
  const cells = new Map(cellList.map((c) => [c.id, c]));
  const byParent = new Map<string, CellRecord[]>();
  for (const c of cellList) if (c.parentId !== null) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  const activity = kernel.activityOf(cellList.filter((c) => c.status !== "closed").map((c) => c.id));

  const actionsByProject = new Map<string, Array<Located<ActionRecord>>>();
  for (const a of readActions(kernel)) {
    const pid = projectOfAction(kernel, a, projectCells);
    if (!pid) continue;
    const list = actionsByProject.get(pid);
    if (list) list.push(a);
    else actionsByProject.set(pid, [a]);
  }
  const visibleCards = new Map<string, { id: string; title: string }>();
  for (const item of kernel.humanItems.list()) {
    if (item.category !== "decision") continue;
    // M2: Only cards owned by the project or explicitly declared in blockingProjectIds hijack the project's ball;
    // FYI-only relatedProjectIds stay side links without marking a running project blocked on the human.
    const blocking = item.blockingProjectIds ?? (item.cellId ? [item.cellId] : []);
    for (const pid of blocking) if (!visibleCards.has(pid)) visibleCards.set(pid, { id: item.id, title: item.title });
  }
  const revisingIds = new Set(kernel.humanItems.listRevising().map((item) => item.id));
  const stalls = new Map(all<{ cell_id: string; since: number }>(kernel.db, "SELECT cell_id,since FROM cell_stalls").map(r => [r.cell_id, r.since]));
  const rows: ProjectRowDTO[] = [];
  for (const p of projects) {
    const r = p.record;
    if (r.lifecycle !== "active") continue;
    const cell = cells.get(p.cellId);
    // BUG-011.3: a parked project is paused underneath, but "以后再说" is its state — not also "已暂停".
    const parked = cell?.pauseReason === "parked";
    const paused = cell?.status === "paused" && !parked;
    // docs/05 guard 2: the kernel's five-anchor check (whole subtree, waits, cards, the owner's actions) stamps the
    // record; the app has no stall rule of its own. A stamp that a pause has not cleared yet does not count. A stalled
    // project has, by the kernel's account, nothing running and nothing it waits for — the pending stall notice itself
    // looks like a timer to the cell tree, so its activity is not counted.
    const stalledSince = cell?.status === "active" ? stalls.get(p.cellId) ?? null : null;
    const stalled = stalledSince !== null;
    const act = stalled ? { running: 0, waiting: 0, busy: null, waitLine: null } : subtreeActivity(nodes.get(p.cellId), activity, now);
    const subtree = subtreeIds(p.cellId, byParent);
    const open = (actionsByProject.get(p.cellId) ?? []).filter(
      (a) => a.record.status === "open" && !(a.record.owner === "human" && revisingIds.has(a.record.id)),
    );
    open.sort((a, b) => compareBallOwner(a.record.owner, b.record.owner) || (a.record.dueAt ?? Infinity) - (b.record.dueAt ?? Infinity) || a.record.createdAt - b.record.createdAt);
    const projectCellIds = new Set(subtree);
    // Dispatch also records the action ID on the child. Recover an omitted carrier only for a unique match.
    const dispatched = new Map<string, string | null>();
    for (const child of byParent.get(p.cellId) ?? []) {
      const gtd = child.spec.meta?.["gtd"] as { actionId?: unknown } | undefined;
      if (typeof gtd?.actionId === "string") {
        dispatched.set(gtd.actionId, dispatched.has(gtd.actionId) ? null : child.id);
      }
    }
    const openActions: ProjectActionDTO[] = open.map((a) => {
      const t = actionText(a.record, now);
      const carrier = a.record.cellId ?? (a.cellId === p.cellId ? dispatched.get(a.record.id) : a.cellId);
      return {
        cellId: a.cellId,
        ...(a.record.owner !== "human" && carrier && carrier !== p.cellId && projectCellIds.has(carrier) ? { targetCellId: carrier } : {}),
        actionId: a.record.id,
        title: a.record.title,
        owner: a.record.owner,
        // Nothing of a parked project is being handled: its agents' steps wait with it.
        ownerLabel: parked && a.record.owner === "agent" ? "已停靠，没有在处理" : ownerLabel(a.record.owner),
        text: t.text,
        progress: t.progress,
        waiting: t.waiting,
        dueAt: a.record.dueAt ?? waitingDeadline(a.record.waiting),
      };
    });
    const card = visibleCards.get(p.cellId) ?? null;

    let ball: ProjectRowDTO["ball"] = null;
    // A decision about an action supplies its own link.
    const top = topBallOwner(open.map((a) => a.record));
    const first = (owner: BallOwner) => openActions.find((a) => a.owner === owner);
    // Parked: nothing is in play — its open items wait with it (the row says who parked it and that a restart goes on).
    // Paused: nobody is working, whatever the books say is the agents' next step.
    if (parked) {
      ball = null;
    } else if (paused && top !== "human" && !card) {
      ball = null;
    } else if (top === "human") {
      const a = first("human")!;
      ball = { owner: "human", label: BALL_LABEL.human, text: a.text, cardId: a.actionId };
    } else if (card) {
      ball = { owner: "human", label: BALL_LABEL.human, text: `有一张卡等你确认：${card.title}`, cardId: card.id };
    } else if (top === "agent") {
      const action = first("agent")!;
      ball = { owner: "agent", label: BALL_LABEL.agent, text: action.text, ...(action.targetCellId && { targetCellId: action.targetCellId }) };
    } else if (act.busy) {
      ball = { owner: "agent", label: BALL_LABEL.agent, text: act.busy.statusLine ?? "后台处理中", targetCellId: act.busy.cellId };
    } else if (top === "waiting") {
      const action = first("waiting")!;
      ball = { owner: "waiting", label: BALL_LABEL.waiting, text: action.text, ...(action.targetCellId && { targetCellId: action.targetCellId }) };
    } else if (act.waiting > 0) {
      ball = { owner: "waiting", label: BALL_LABEL.waiting, text: act.waitLine ?? "后台在等外部条件" };
    }

    rows.push({
      id: p.cellId,
      title: r.title,
      outcome: r.outcome ?? null,
      summary: typeof r.summary === "string" && r.summary ? r.summary : null,
      cwd: cell?.spec.cwd ?? null,
      lifecycle: parked ? "someday" : r.lifecycle,
      paused,
      pausedText: pauseInfoOf(kernel, p.cellId, input.settings.timeZone)?.text ?? null,
      ball,
      progress: sumProgress(openActions.filter((a) => a.owner === "agent" && a.progress).map((a) => a.progress!)),
      waiting: mergeWaiting(openActions.filter((a) => a.waiting).map((a) => a.waiting!)),
      openActions,
      pendingCardId: card?.id ?? null,
      stalled,
      stalledText: stalled ? STALLED_TEXT : null,
      stalledSince,
      running: act.running,
      waitingOn: act.waiting,
      workers: workersOf(nodes.get(p.cellId), activity, projectCells),
      artifacts: projectArtifacts(kernel, subtree),
      agents: agentsEntry(p.cellId, subtree, cells, activity),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      buttons: projectButtons(p.cellId, parked, paused, stalled, kernel.workspace.listJobsSync({state:["running"]}).filter(j=>subtree.includes(j.cellId)).length),
    });
  }

  const rank = (row: ProjectRowDTO) => (row.stalled ? -1 : row.ball ? ["human", "agent", "waiting"].indexOf(row.ball.owner) : 3);
  const active = rows.filter((x) => x.lifecycle === "active").sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  const someday = rows.filter((x) => x.lifecycle === "someday").sort((a, b) => b.updatedAt - a.updatedAt);
  const ws = weekStart(now);
  const completedThisWeek = projects.filter((p) => p.record.lifecycle === "completed" && (p.record.completedAt ?? p.record.updatedAt) >= ws).length;
  return {
    generatedAt: now,
    projects: active,
    someday,
    counts: { active: active.length, stalled: active.filter((x) => x.stalled).length, someday: someday.length, completedThisWeek },
  };
}

export function projectRadar(input: ProjectionInput): RadarDTO {
  return { ...radarProjects(input), review: projectReview(input) };
}
