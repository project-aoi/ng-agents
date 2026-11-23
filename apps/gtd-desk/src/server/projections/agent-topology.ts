import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isProjectRoot, workTreeKey, type WaitRecord } from "@ng/cell";
import type { ProjectRecord } from "@ng/presets/records";
import { all, CELL_DIRECT_CHAT_KEY, CELL_STATUS_KEY, get, isLeafLifetime, parsePrincipal, PAYLOAD, pullCursorKey, type CellDirectChatState, type CellRecord, type CellStatusLine, type EvidenceEntry, type JobRecord } from "@ng/protocol";
import type { AgentVisualState, TopologyDTO, TopologyNodeDTO } from "../../shared/api";
import { projectOfAction, readActions, readProjects, type DeskKernel, type ProjectionInput } from "./common";
import { whenText } from "./time";
import { oneLine, callBrief } from "./agent-tool-summaries";

// 分身实况 (Agents): who is there, what each one did, and what a box under its record does. Pure reads of the kernel.
// What a person reads is plain Chinese — a state is "待命可唤醒", never the machinery behind it — while what a cell
// touched (paths, commands, outputs, branch names) passes through verbatim.

type Activity = { state: "working" | "waiting" | "dormant" | "idle" | "paused" | "closed"; why: string };

export interface Facts {
  statusLine: string | null;
  threads: string[];
  watching: boolean;
  nextTimerAt: number | null;
  jobs: JobRecord[];
}

interface Ref {
  id: string;
  title: string;
}

/** Everything the node projection needs, read once per request. */
export interface AgentsView {
  input: ProjectionInput;
  cells: Map<string, CellRecord>;
  /** By parent id, in creation order. */
  children: Map<string, CellRecord[]>;
  activity: Map<string, Activity>;
  facts: Map<string, Facts>;
  waits: Map<string, WaitRecord[]>;
  projects: Map<string, ProjectRecord>;
  /** A visible (not snoozed) card each cell raised itself; and the cells whose only cards are snoozed. */
  cards: Map<string, Ref>;
  snoozedCards: Set<string>;
  /** A visible card about each project (wherever it is held). */
  projectCards: Map<string, Ref>;
  /** An open action of the owner's that belongs to a cell (held, carried or on its project's books). */
  human: Map<string, { cellId: string; actionId: string; title: string }>;
}



// ==================== reading the kernel ====================

function statusText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const s = value as Partial<CellStatusLine>;
  if (typeof s.text !== "string") return null;
  const p = s.progress;
  return p ? `${s.text} (${p.done}/${p.total}${p.label ? ` ${p.label}` : ""})` : s.text;
}

/** Per-cell facts for a handful of cells (the timeline header); the topology reads them from one tree() instead. */
function factsOf(kernel: DeskKernel, cellIds: readonly string[], now: number): Map<string, Facts> {
  const out = new Map<string, Facts>();
  for (const cellId of cellIds) {
    const threads = all<{ thread: string | null }>(kernel.db, "SELECT thread FROM cell_watches WHERE cell_id = ? AND active = 1 ORDER BY id", [cellId]);
    let next: number | null = null;
    const timer = (at: number | null) => {
      if (at !== null && (next === null || at < next)) next = at;
    };
    for (const m of kernel.inbox.listMessagesSync({ cellId, status: ["pending"] })) {
      if (m.envelope.type !== PAYLOAD.stalledCheck && m.deliverAt > now) timer(m.deliverAt);
    }
    for (const s of kernel.inbox.listSchedulesSync({ cellId, activeOnly: true })) timer(s.nextFireAt);
    out.set(cellId, {
      statusLine: statusText(kernel.context.readStateSync(cellId, CELL_STATUS_KEY)),
      threads: threads.flatMap((t) => (t.thread ? [t.thread] : [])),
      watching: threads.length > 0,
      nextTimerAt: next,
      jobs: kernel.workspace.listJobsSync({ cellId, state: ["running"] }),
    });
  }
  return out;
}

/** `focus`: the cells whose live facts are needed (default: every open cell, read in one pass). */
export function agentsView(input: ProjectionInput, focus?: readonly string[]): AgentsView {
  const { kernel, now } = input;
  const list = kernel.listCells();
  const cells = new Map(list.map((c) => [c.id, c]));
  const children = new Map<string, CellRecord[]>();
  for (const c of list) {
    if (c.parentId === null) continue;
    const l = children.get(c.parentId);
    if (l) l.push(c);
    else children.set(c.parentId, [c]);
  }
  for (const l of children.values()) l.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const open = (focus ? focus.flatMap((id) => cells.get(id) ?? []) : list).filter((c) => c.status !== "closed").map((c) => c.id);
  const activity = new Map<string, Activity>(kernel.activityOf(open));
  let facts: Map<string, Facts>;
  if (focus) {
    facts = factsOf(kernel, open, now);
  } else {
    facts = new Map();
    const jobs = new Map<string, JobRecord[]>();
    for (const j of kernel.workspace.listJobsSync({ state: ["running"] })) jobs.set(j.cellId, [...(jobs.get(j.cellId) ?? []), j]);
    const walk = (nodes: ReturnType<DeskKernel["tree"]>) => {
      for (const n of nodes) {
        facts.set(n.cellId, { statusLine: n.statusLine, threads: n.threads, watching: n.watching, nextTimerAt: n.nextTimerAt, jobs: jobs.get(n.cellId) ?? [] });
        walk(n.children);
      }
    };
    walk(kernel.tree());
  }
  const waits = new Map<string, WaitRecord[]>();
  for (const w of kernel.listWaits(focus ? open : undefined)) waits.set(w.cellId, [...(waits.get(w.cellId) ?? []), w]);

  const projects = new Map(readProjects(kernel).map((p) => [p.cellId, p.record]));
  const cards = new Map<string, Ref>();
  const snoozedCards = new Set<string>();
  const projectCards = new Map<string, Ref>();
  const visibleActions = new Set<string>();
  for (const item of kernel.humanItems.list(true)) {
    if (item.category === "action" && (item.snoozedUntil === null || item.snoozedUntil <= now)) visibleActions.add(item.id);
    if (item.category !== "decision") continue;
    if (item.snoozedUntil !== null && item.snoozedUntil > now) {
      if (item.cellId) snoozedCards.add(item.cellId);
      continue;
    }
    const ref = { id: item.id, title: item.title };
    if (item.cellId && !cards.has(item.cellId)) cards.set(item.cellId, ref);
    for (const id of item.relatedProjectIds) if (!projectCards.has(id)) projectCards.set(id, ref);
  }
  for (const id of cards.keys()) snoozedCards.delete(id);

  const human = new Map<string, { cellId: string; actionId: string; title: string }>();
  const actions = readActions(kernel);
  const projectIds = new Set(projects.keys());
  for (const a of actions) {
    if (a.record.status !== "open" || a.record.owner !== "human" || !visibleActions.has(a.record.id)) continue;
    const ref = { cellId: a.cellId, actionId: a.record.id, title: a.record.title };
    for (const id of [a.cellId, a.record.cellId, projectOfAction(kernel, a, projectIds)]) if (id && !human.has(id)) human.set(id, ref);
  }
  return { input, cells, children, activity, facts, waits, projects, cards, snoozedCards, projectCards, human };
}

// ==================== naming ====================

export const isRoot = (c: CellRecord) => c.parentId === null;

/** A worker or a probe: the third column, and the cells a project pulls from. */
export function isLeafCell(c: Pick<CellRecord, "spec" | "preset">): boolean {
  return isLeafLifetime(c.spec.lifetime);
}

function roleOf(v: AgentsView, c: CellRecord): { roleLabel: string; layer: 0 | 1 | 2 } {
  const role = typeof c.spec.meta?.["role"] === "string" ? (c.spec.meta["role"] as string) : null;
  if (isRoot(c)) return { roleLabel: "总助理", layer: 0 };
  if (isProjectRoot(v.input.kernel.registry, c)) return { roleLabel: "项目协调", layer: 1 };
  if (role === "hub") return { roleLabel: "领域中枢", layer: 1 };
  if (role === "sensor") return { roleLabel: "信源巡检", layer: 0 };
  if (role === "checker") return { roleLabel: "外部盯梢", layer: 2 };
  if (isLeafCell(c)) return { roleLabel: "执行分身", layer: 2 };
  return { roleLabel: "分身", layer: 1 };
}

export function titleOf(v: AgentsView, c: CellRecord): string {
  return v.projects.get(c.id)?.title ?? c.title ?? roleOf(v, c).roleLabel;
}

/** "总助理" · "项目协调「支付重试改造」" · "执行分身「核心退避编码」" */
export function cellLabel(v: AgentsView, cellId: string): string {
  const c = v.cells.get(cellId);
  if (!c) return "分身";
  const { roleLabel } = roleOf(v, c);
  if (isRoot(c)) return roleLabel;
  const title = v.projects.get(c.id)?.title ?? c.title;
  return title ? `${roleLabel}「${title}」` : roleLabel;
}

export function crumbLabel(v: AgentsView, c: CellRecord): string {
  const { roleLabel } = roleOf(v, c);
  if (isRoot(c)) return roleLabel;
  const title = titleOf(v, c);
  switch (roleLabel) {
    case "执行分身":
      return `分身：${title}`;
    case "外部盯梢":
      return `盯梢：${title}`;
    case "信源巡检":
      return `信源：${title}`;
    default:
      return title;
  }
}

/** The project a cell works for (itself for a project); null for the desk, sources and hubs. */
export function projectIdOf(v: AgentsView, c: CellRecord): string | null {
  if (isProjectRoot(v.input.kernel.registry, c)) return c.id;
  const pid = c.spec.meta?.["projectCellId"];
  return typeof pid === "string" && v.projects.has(pid) ? pid : null;
}

export function isPerson(kernel: DeskKernel, principalId: string): boolean {
  const kind = parsePrincipal(principalId, kernel.ownerPrincipal).kind;
  return kind === "owner" || kind === "agent";
}

const AGENT_NAMES: Readonly<Record<string, string>> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity", antigravity: "Antigravity" };

/** "你" · "你（经主 Agent）" · "你（经 Claude Code）" */
export function personLabel(kernel: DeskKernel, principalId: string, sender?: { id?: string; displayName?: string }): string {
  const p = parsePrincipal(principalId, kernel.ownerPrincipal);
  if (p.kind !== "agent") return "你";
  const name = (sender?.displayName && sender.displayName !== principalId ? sender.displayName : null) ?? AGENT_NAMES[p.agentId.toLowerCase()] ?? "主 Agent";
  return `你（经${/^[\x20-\x7e]/.test(name) ? " " : ""}${name}）`;
}


/** "~/dev/pay-core" */
function homeShort(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function safeWorkTree(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  try {
    return workTreeKey(cwd);
  } catch {
    return null;
  }
}

/** The checked-out branch of the work tree at `gitRoot`, read from `.git/HEAD` (a worktree's `.git` file is followed). */
export function branchOf(gitRoot: string | null): string | null {
  if (!gitRoot) return null;
  try {
    let gitDir = join(gitRoot, ".git");
    if (!existsSync(gitDir)) return null;
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return null;
      gitDir = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(gitRoot, m[1]!.trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1]!;
    return /^[0-9a-f]{7,64}$/i.test(head) ? head.slice(0, 7) : null;
  } catch {
    return null;
  }
}

// ==================== one node ====================

/** The leaf's records its parent has not looked at with inspect_cell (run boundaries are not news). */
export function unpulledOf(kernel: DeskKernel, leaf: Pick<CellRecord, "id" | "parentId">): { count: number; cursor: number } {
  if (!leaf.parentId) return { count: 0, cursor: 0 };
  const cursor = kernel.context.readStateSync<number>(leaf.parentId, pullCursorKey(leaf.id)) ?? 0;
  const row = get<{ n: number }>(kernel.db, "SELECT COUNT(*) AS n FROM evidence WHERE cell_id = ? AND seq > ? AND kind != 'run_boundary'", [leaf.id, cursor]);
  return { count: row?.n ?? 0, cursor };
}

/** The newest `n` records of a cell (before `beforeSeq`), oldest first. */
export function tailRecords(kernel: DeskKernel, cellId: string, n: number, beforeSeq?: number): EvidenceEntry[] {
  const bound = beforeSeq !== undefined ? " AND seq < ?" : "";
  const params: Array<string | number> = beforeSeq !== undefined ? [cellId, beforeSeq, n - 1] : [cellId, n - 1];
  const start = get<{ seq: number }>(kernel.db, `SELECT seq FROM evidence WHERE cell_id = ?${bound} ORDER BY seq DESC LIMIT 1 OFFSET ?`, params);
  const rows = kernel.context.listEvidenceSync(cellId, { afterSeq: start ? start.seq - 1 : 0 });
  return beforeSeq !== undefined ? rows.filter((r) => r.seq < beforeSeq) : rows;
}

function waitText(v: AgentsView, w: WaitRecord, now: number): string {
  let what: string;
  if (w.waitingFor === "human") what = "等你回复";
  else if (w.waitingFor === "external") what = "等外部消息";
  else if (w.waitingFor.startsWith("inbox:")) {
    const id = w.waitingFor.slice("inbox:".length);
    const c = v.cells.get(id);
    what = `等「${c ? titleOf(v, c) : "后台任务"}」回信`;
  } else what = `等 ${w.waitingFor}`;
  return w.timeoutAt ? `${what}（最晚 ${whenText(w.timeoutAt, now)}）` : what;
}

/** "正在执行：pnpm test" when its last record is a tool call still in flight. */
function runningStep(kernel: DeskKernel, cellId: string): string | null {
  const last = tailRecords(kernel, cellId, 1)[0];
  if (!last || last.record.kind !== "tool_call") return null;
  const brief = callBrief(last.record.input);
  return brief ? `正在执行：${oneLine(brief, 120)}` : `正在执行：${last.record.name}`;
}

export function isParked(v: AgentsView, c: CellRecord): boolean {
  for (let at: CellRecord | undefined = c; at; at = at.parentId ? v.cells.get(at.parentId) : undefined)
    if (at.status === "paused" && at.pauseReason === "parked") return true;
  return false;
}

function stateOf(v: AgentsView, c: CellRecord): { state: AgentVisualState; stateLabel: string; stateDetail: string | null } {
  const { now, kernel } = v.input;
  if (c.status === "closed") return { state: "archived", stateLabel: "已归档", stateDetail: c.closeReason === "cancelled" ? "已取消" : null };
  const act = v.activity.get(c.id) ?? { state: c.status === "paused" ? "paused" : "idle", why: "" };
  const facts = v.facts.get(c.id);
  if (act.state === "working") {
    const job = facts?.jobs[0];
    const detail = job ? `后台命令：${oneLine(job.command, 120)}` : act.why.startsWith("a message is waiting") ? "收到新消息，马上开始处理" : runningStep(kernel, c.id);
    return { state: "running", stateLabel: "运行中", stateDetail: detail };
  }
  if (act.state === "paused") {
    const parked = isParked(v,c);
    return { state: "paused", stateLabel: parked ? "已停靠" : "已暂停", stateDetail: parked ? "放在以后再说里" : null };
  }
  const card = v.cards.get(c.id) ?? (v.projects.has(c.id) ? v.projectCards.get(c.id) : undefined);
  const human = isRoot(c) ? undefined : v.human.get(c.id);
  if (card) return { state: "blocked_human", stateLabel: "等你拍板", stateDetail: `有一张卡等你确认：${card.title}` };
  if (human) return { state: "blocked_human", stateLabel: "等你拍板", stateDetail: `等你处理：${human.title}` };
  if (act.state === "waiting") {
    const w = v.waits.get(c.id)?.[0];
    if (w) return { state: "waiting", stateLabel: w.waitingFor.startsWith("inbox:") ? "等待协同" : "等待外部", stateDetail: waitText(v, w, now) };
    let detail: string | null = null;
    if (facts?.watching) detail = facts.threads.length ? `盯着 ${facts.threads.join("、")}` : "盯着外部事件";
    else if (facts?.nextTimerAt != null) detail = `下次检查 ${whenText(facts.nextTimerAt, now)}`;
    else if (v.snoozedCards.has(c.id)) detail = "有一张卡推迟了，到点回到「待我处理」";
    return { state: "waiting", stateLabel: "等待外部", stateDetail: detail };
  }
  if (act.state === "dormant" || isLeafCell(c)) return { state: "dormant", stateLabel: "已待命 · 发消息即唤醒", stateDetail: null };
  // A coordinator between the events of its project: nothing to do until something arrives.
  return { state: "idle", stateLabel: "待命", stateDetail: null };
}

/** A closed leaf whose ancestors are all open: a message brings it back (the kernel reopens it). */
function reopenable(v: AgentsView, c: CellRecord): boolean {
  if (c.status !== "closed" || !c.parentId || !isLeafLifetime(c.spec.lifetime)) return false;
  for (let p = v.cells.get(c.parentId); p; p = p.parentId ? v.cells.get(p.parentId) : undefined) if (p.status === "closed") return false;
  return true;
}

export function nodeOf(v: AgentsView, c: CellRecord): TopologyNodeDTO {
  const { kernel } = v.input;
  const { roleLabel, layer } = roleOf(v, c);
  const processor = c.spec.processor;
  const llm = processor.kind === "llm";
  const s = stateOf(v, c);
  const cwd = c.spec.cwd ?? null;
  const leaf = isLeafCell(c);
  const chat = kernel.context.readStateSync<CellDirectChatState>(c.id, CELL_DIRECT_CHAT_KEY);
  const card = v.cards.get(c.id) ?? (v.projects.has(c.id) ? v.projectCards.get(c.id) : undefined);
  const human = isRoot(c) || c.status === "closed" ? undefined : v.human.get(c.id);
  const effective = llm ? (kernel.effectiveRunnerFor?.(c.spec) ?? null) : null;
  return {
    cellId: c.id,
    parentId: c.parentId,
    projectId: projectIdOf(v, c),
    preset: c.preset,
    roleLabel,
    title: titleOf(v, c),
    layer,
    state: s.state,
    stateLabel: s.stateLabel,
    stateDetail: s.stateDetail,
    processorType: llm ? "llm" : "code",
    canChat: llm && (c.status !== "closed" || reopenable(v, c)),
    engine: llm ? (effective?.runner ?? processor.engine ?? kernel.agentBackend ?? null) : null,
    ...(llm && processor.model ? { modelOverride: { model: processor.model, effort: processor.effort } } : {}),
    ...(llm && effective ? { effectiveModel: effective.choice, runnerSource: effective.source } : {}),
    modelTier: llm ? (processor.modelTier ?? "strong") : null,
    cwd,
    gitRoot: safeWorkTree(cwd),
    statusLine: v.facts.get(c.id)?.statusLine ?? statusText(kernel.context.readStateSync(c.id, CELL_STATUS_KEY)),
    lastEvidenceSeq: kernel.context.lastEvidenceSeqSync(c.id),
    unpulledCount: leaf ? unpulledOf(kernel, c).count : 0,
    hadDirectUserChat: (chat?.total ?? 0) > 0,
    pendingCardId: c.status === "closed" ? null : (card?.id ?? null),
    humanItemId: human?.actionId ?? null,
    archivedChildren: (v.children.get(c.id) ?? []).filter((x) => x.status === "closed").length,
    updatedAt: c.lastRunAt ?? c.updatedAt,
  };
}

// ==================== the topology ====================

export interface TopologyQuery {
  includeArchived?: boolean;
  /** That project's subtree plus its ancestors. */
  projectId?: string | null;
}

export function projectTopology(input: ProjectionInput, q: TopologyQuery = {}): TopologyDTO {
  const { kernel, now } = input;
  const v = agentsView(input);
  let scope: Set<string> | null = null;
  if (q.projectId) {
    scope = new Set();
    const root = v.cells.get(q.projectId);
    if (root) {
      for (let p: CellRecord | undefined = root; p; p = p.parentId ? v.cells.get(p.parentId) : undefined) scope.add(p.id);
      const stack = [root.id];
      while (stack.length) for (const ch of v.children.get(stack.pop()!) ?? []) (scope.add(ch.id), stack.push(ch.id));
    }
  }
  const inScope = (c: CellRecord) => scope === null || scope.has(c.id);
  const nodes: TopologyNodeDTO[] = [];
  const counts = { running: 0, waiting: 0, dormant: 0, archived: 0 };
  const visit = (c: CellRecord) => {
    if (!inScope(c)) return;
    if (c.status === "closed") counts.archived++;
    if (c.status === "closed" && !q.includeArchived) return;
    const n = nodeOf(v, c);
    nodes.push(n);
    if (n.state === "running") counts.running++;
    else if (n.state === "waiting" || n.state === "blocked_human") counts.waiting++;
    else if (n.state === "dormant") counts.dormant++;
    for (const ch of v.children.get(c.id) ?? []) visit(ch);
  };
  // Closed cells below a hidden closed parent are counted too (the archive of a finished project).
  const countHidden = (c: CellRecord) => {
    for (const ch of v.children.get(c.id) ?? []) {
      if (!inScope(ch)) continue;
      if (ch.status === "closed") counts.archived++;
      countHidden(ch);
    }
  };
  const roots = [...v.cells.values()].filter((c) => c.parentId === null || !v.cells.has(c.parentId));
  roots.sort((a, b) => (a.id === kernel.deskCellId ? -1 : b.id === kernel.deskCellId ? 1 : a.createdAt - b.createdAt));
  for (const r of roots) visit(r);
  if (!q.includeArchived) for (const c of v.cells.values()) if (c.status === "closed" && inScope(c) && v.cells.get(c.parentId ?? "")?.status !== "closed") countHidden(c);

  const shown = new Set(nodes.map((n) => n.cellId));
  const waits: TopologyDTO["waits"] = [];
  for (const [cellId, list] of v.waits) {
    if (!shown.has(cellId)) continue;
    for (const w of list) {
      const target = w.waitingFor.startsWith("inbox:") ? w.waitingFor.slice("inbox:".length) : null;
      waits.push({
        fromCellId: cellId,
        targetCellId: target && v.cells.has(target) ? target : null,
        targetLabel: w.waitingFor === "human" ? "你" : w.waitingFor === "external" ? "外部" : target ? cellLabel(v, target) : w.waitingFor,
        description: w.reason,
        since: w.createdAt,
      });
    }
  }
  const workspaces: TopologyDTO["workspaces"] = [];
  for (const o of kernel.activeWorkspaces()) {
    const ids = o.active.map((u) => u.cellId).filter((id) => scope === null || scope.has(id));
    if (ids.length) workspaces.push({ gitRoot: o.key, label: homeShort(o.key), activeCellIds: ids });
  }
  return { generatedAt: now, deskCellId: kernel.deskCellId, counts, nodes, waits, workspaces };
}
