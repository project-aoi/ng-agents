import type { CellNode } from "@ng/cell";
import { asClarifyCard, compareBallOwner, topBallOwner, type ActionRecord, type BallOwner, type ProjectRecord } from "@ng/protocol";
import { BALL_LABEL, type ButtonDTO, type ProgressDTO, type ProjectActionDTO, type ProjectRowDTO, type ProjectWorkerDTO, type RadarDTO, type WaitingDTO } from "../../shared/api";
import { actionKey, approvalProjectId, cardBackedActions, projectOfAction, readActions, readProjects, type Located, type ProjectionInput } from "./common";
import { button, enc, ownerLabel, post, progressDTO, waitingDeadline, waitingDTO } from "./format";
import { projectReview } from "./review";
import { weekStart } from "./time";

export const STALLED_TEXT = "没有在推进的任务、没有在等的回复，也没有下一步 — 补上下一步，或移进以后再说";

interface Activity {
  running: number;
  waiting: number;
  /** First status line of a busy cell (what the agent is doing right now). */
  busyLine: string | null;
}

function flatten(nodes: readonly CellNode[], into = new Map<string, CellNode>()): Map<string, CellNode> {
  for (const n of nodes) {
    into.set(n.cellId, n);
    flatten(n.children, into);
  }
  return into;
}

function nodeState(n: CellNode, due: ReadonlySet<string>): ProjectWorkerDTO["state"] {
  if (n.running || n.runningJobs > 0 || (n.status === "active" && due.has(n.cellId))) return "running";
  if (n.status === "paused") return "paused";
  if (n.watching || n.nextTimerAt !== null) return "waiting";
  return "idle";
}

function subtreeActivity(node: CellNode | undefined, due: ReadonlySet<string>): Activity {
  const a: Activity = { running: 0, waiting: 0, busyLine: null };
  const walk = (n: CellNode) => {
    if (n.status !== "closed") {
      const s = nodeState(n, due);
      if (s === "running") {
        a.running++;
        a.busyLine ??= n.statusLine;
      } else if (s === "waiting") {
        a.waiting++;
      }
    }
    n.children.forEach(walk);
  };
  if (node) walk(node);
  return a;
}

/** The live cells below a project (its workers and watchers, and theirs), excluding cells that are projects of their own. */
function workersOf(node: CellNode | undefined, due: ReadonlySet<string>, projectCells: ReadonlySet<string>): ProjectWorkerDTO[] {
  const out: ProjectWorkerDTO[] = [];
  const walk = (n: CellNode) => {
    for (const c of n.children) {
      if (c.status === "closed" || projectCells.has(c.cellId)) continue;
      out.push({ cellId: c.cellId, title: c.title ?? c.cellId, preset: c.preset, state: nodeState(c, due), statusLine: c.statusLine });
      walk(c);
    }
  };
  if (node) walk(node);
  return out;
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

function projectButtons(id: string, record: ProjectRecord, paused: boolean, stalled: boolean): ButtonDTO[] {
  const base = `/api/projects/${enc(id)}`;
  const cancel = button({ id: "cancel", label: "✕ 取消项目", endpoint: post(`${base}/cancel`), confirm: "取消后会立即停止这个项目的全部后台任务，确定吗？" });
  if (record.lifecycle === "someday") {
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
      : button({ id: "pause", label: "⏸ 暂停", endpoint: post(`${base}/pause`) }),
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
  const due = new Set(kernel.inbox.dueCellIdsSync());

  const actionsByProject = new Map<string, Array<Located<ActionRecord>>>();
  for (const a of readActions(kernel)) {
    const pid = projectOfAction(kernel, a, projectCells);
    if (!pid) continue;
    const list = actionsByProject.get(pid);
    if (list) list.push(a);
    else actionsByProject.set(pid, [a]);
  }
  const onCard = cardBackedActions(kernel, [...actionsByProject.values()].flat());
  const visibleCards = new Map<string, { id: string; title: string }>();
  for (const rec of kernel.gate.listPendingSync({ includeSnoozed: true })) {
    const pid = approvalProjectId(kernel, rec);
    if (!pid) continue;
    if (rec.snoozedUntil === null || rec.snoozedUntil <= now) {
      const card = asClarifyCard(rec.card.data);
      if (!visibleCards.has(pid)) visibleCards.set(pid, { id: rec.actionId, title: card?.title ?? rec.card.title ?? rec.action.summary });
    }
  }

  const rows: ProjectRowDTO[] = [];
  for (const p of projects) {
    const r = p.record;
    if (r.lifecycle !== "active" && r.lifecycle !== "someday") continue;
    const cell = kernel.getCell(p.cellId);
    const paused = cell?.status === "paused";
    // docs/05 guard 2: the kernel's five-anchor check (whole subtree, waits, cards, the owner's actions) stamps the
    // record; the app has no stall rule of its own. A stamp that a pause has not cleared yet does not count. A stalled
    // project has, by the kernel's account, nothing running and nothing it waits for — the pending stall notice itself
    // looks like a timer to the cell tree, so its activity is not counted.
    const stalledSince = r.lifecycle === "active" && !paused && typeof r.stalledSince === "number" ? r.stalledSince : null;
    const stalled = stalledSince !== null;
    const act = stalled ? { running: 0, waiting: 0, busyLine: null } : subtreeActivity(nodes.get(p.cellId), due);
    const open = (actionsByProject.get(p.cellId) ?? []).filter((a) => a.record.status === "open");
    open.sort((a, b) => compareBallOwner(a.record.owner, b.record.owner) || (a.record.dueAt ?? Infinity) - (b.record.dueAt ?? Infinity) || a.record.createdAt - b.record.createdAt);
    const openActions: ProjectActionDTO[] = open.map((a) => {
      const t = actionText(a.record, now);
      return {
        cellId: a.cellId,
        actionId: a.record.id,
        title: a.record.title,
        owner: a.record.owner,
        ownerLabel: ownerLabel(a.record.owner),
        text: t.text,
        progress: t.progress,
        waiting: t.waiting,
        dueAt: a.record.dueAt ?? waitingDeadline(a.record.waiting),
      };
    });
    const card = visibleCards.get(p.cellId) ?? null;

    let ball: ProjectRowDTO["ball"] = null;
    // An action whose owner part is a pending card points at that card, not at Engage.
    const todos = open.filter((a) => !onCard.has(actionKey(a)));
    const top = topBallOwner(todos.map((a) => a.record));
    const first = (owner: BallOwner) => openActions.find((a) => a.owner === owner && !onCard.has(`${a.cellId}\u0000${a.actionId}`));
    if (top === "human") {
      const a = first("human")!;
      ball = { owner: "human", label: BALL_LABEL.human, text: a.text, engage: { cellId: a.cellId, actionId: a.actionId } };
    } else if (card) {
      ball = { owner: "human", label: BALL_LABEL.human, text: `有一张卡等你确认：${card.title}`, cardId: card.id };
    } else if (top === "agent") {
      ball = { owner: "agent", label: BALL_LABEL.agent, text: first("agent")!.text };
    } else if (act.running > 0) {
      ball = { owner: "agent", label: BALL_LABEL.agent, text: act.busyLine ?? "后台处理中" };
    } else if (top === "waiting") {
      ball = { owner: "waiting", label: BALL_LABEL.waiting, text: first("waiting")!.text };
    } else if (act.waiting > 0) {
      ball = { owner: "waiting", label: BALL_LABEL.waiting, text: "等待外部回复" };
    }

    rows.push({
      id: p.cellId,
      title: r.title,
      outcome: r.outcome ?? null,
      summary: typeof r.summary === "string" && r.summary ? r.summary : null,
      cwd: typeof r.cwd === "string" && r.cwd ? r.cwd : (cell?.spec.cwd ?? null),
      lifecycle: r.lifecycle,
      paused,
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
      workers: workersOf(nodes.get(p.cellId), due, projectCells),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      buttons: projectButtons(p.cellId, r, paused, stalled),
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
