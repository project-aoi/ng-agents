import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { workTreeKey, type WaitRecord } from "@ng/cell";
import {
  all,
  CELL_DIRECT_CHAT_KEY,
  CELL_STATUS_KEY,
  get,
  isLeafLifetime,
  KERNEL_FROM,
  parsePrincipal,
  PAYLOAD,
  pullCursorKey,
  steerNoteText,
  type ApprovalResolvedPayload,
  type CellDirectChatPayload,
  type CellDirectChatState,
  type CellMessagePayload,
  type CellProgressPayload,
  type CellRecord,
  type CellResultPayload,
  type CellStatusLine,
  type CellTaskPayload,
  type ControlSteerPayload,
  type Envelope,
  type EvidenceEntry,
  type HandbackPayload,
  type JobRecord,
  type JobResultPayload,
  type ProjectRecord,
  type SourceHitPayload,
  type StepOrExternalEvidence,
  type TimerFiredPayload,
  type UserMessagePayload,
  type WaitTimeoutPayload,
} from "@ng/protocol";
import type {
  AgentVisualState,
  ArtifactRefDTO,
  ButtonDTO,
  CellJobDTO,
  CellTimelineDTO,
  ComposerDTO,
  ResourcePageDTO,
  TimelineItemDTO,
  ToolStepDTO,
  TopologyDTO,
  TopologyNodeDTO,
} from "../../shared/api";
import { approvalProjectId, projectOfAction, readActions, readProjects, type DeskKernel, type ProjectionInput } from "./common";
import { button, channelLabelOfAddress, enc, post } from "./format";
import { whenText } from "./time";

// 分身实况 (Agents): who is there, what each one did, and what a box under its record does. Pure reads of the kernel.
// What a person reads is plain Chinese — a state is "待命可唤醒", never the machinery behind it — while what a cell
// touched (paths, commands, outputs, branch names) passes through verbatim.

type Activity = { state: "working" | "waiting" | "dormant" | "idle" | "paused" | "closed"; why: string };

interface Facts {
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

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;
const OUTPUT_HEAD = 1_200;
const ARTIFACT_LIMIT = 20;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const oneLine = (text: string, max: number) => clip(text.replace(/\s+/g, " ").trim(), max);

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
  for (const rec of kernel.gate.listPendingSync({ includeSnoozed: true })) {
    const ref = { id: rec.actionId, title: rec.card.title ?? rec.action.summary };
    if (rec.snoozedUntil !== null && rec.snoozedUntil > now) {
      snoozedCards.add(rec.cellId);
      continue;
    }
    if (!cards.has(rec.cellId)) cards.set(rec.cellId, ref);
    const pid = approvalProjectId(kernel, rec);
    if (pid && !projectCards.has(pid)) projectCards.set(pid, ref);
  }
  for (const item of kernel.humanItems.list()) {
    if (item.category !== "decision") continue;
    const ref = {id:item.id,title:item.title};
    if (item.cellId && !cards.has(item.cellId)) cards.set(item.cellId,ref);
    for (const pid of item.relatedProjectIds) if (!projectCards.has(pid)) projectCards.set(pid,ref);
  }
  for (const id of cards.keys()) snoozedCards.delete(id);

  const human = new Map<string, { cellId: string; actionId: string; title: string }>();
  const actions = readActions(kernel);
  const projectIds = new Set(projects.keys());
  for (const a of actions) {
    if (a.record.status !== "open" || a.record.owner !== "human") continue;
    const ref = { cellId: a.cellId, actionId: a.record.id, title: a.record.title };
    for (const id of [a.cellId, a.record.cellId, projectOfAction(kernel, a, projectIds)]) if (id && !human.has(id)) human.set(id, ref);
  }
  return { input, cells, children, activity, facts, waits, projects, cards, snoozedCards, projectCards, human };
}

// ==================== naming ====================

const isRoot = (c: CellRecord) => c.parentId === null;

/** A worker or a probe: the third column, and the cells a project pulls from. */
export function isLeafCell(c: Pick<CellRecord, "spec" | "preset">): boolean {
  return isLeafLifetime(c.spec.lifetime);
}

function roleOf(v: AgentsView, c: CellRecord): { roleLabel: string; layer: 0 | 1 | 2 } {
  const role = typeof c.spec.meta?.["role"] === "string" ? (c.spec.meta["role"] as string) : null;
  if (isRoot(c) || role === "desk") return { roleLabel: "总助理", layer: 0 };
  if (v.projects.has(c.id) || c.preset === "project") return { roleLabel: "项目协调", layer: 1 };
  if (c.preset === "hub" || role === "hub") return { roleLabel: "领域中枢", layer: 1 };
  if (c.preset === "sensor" || role === "sensor") return { roleLabel: "信源巡检", layer: 0 };
  if (c.preset === "checker" || role === "checker") return { roleLabel: "外部盯梢", layer: 2 };
  if (isLeafCell(c)) return { roleLabel: "执行分身", layer: 2 };
  return { roleLabel: "分身", layer: 1 };
}

function titleOf(v: AgentsView, c: CellRecord): string {
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

function crumbLabel(v: AgentsView, c: CellRecord): string {
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
function projectIdOf(v: AgentsView, c: CellRecord): string | null {
  if (v.projects.has(c.id)) return c.id;
  const pid = c.spec.meta?.["projectCellId"];
  return typeof pid === "string" && v.projects.has(pid) ? pid : null;
}

function isPerson(kernel: DeskKernel, principalId: string): boolean {
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
function tailRecords(kernel: DeskKernel, cellId: string, n: number, beforeSeq?: number): EvidenceEntry[] {
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
    what = `等「${c ? titleOf(v, c) : id}」回信`;
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
    const parked = v.projects.get(projectIdOf(v, c) ?? "")?.lifecycle === "someday";
    return { state: "paused", stateLabel: "已暂停", stateDetail: parked ? "放在以后再说里" : null };
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
    else if (v.snoozedCards.has(c.id)) detail = "有一张卡推迟了，到点回到待确认";
    return { state: "waiting", stateLabel: "等待外部", stateDetail: detail };
  }
  if (act.state === "dormant" || isLeafCell(c)) return { state: "dormant", stateLabel: "已待命 · 发消息即唤醒", stateDetail: null };
  // A coordinator between the events of its project: nothing to do until something arrives.
  return { state: "waiting", stateLabel: "待命", stateDetail: null };
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
  const llm = c.spec.processor.kind === "llm";
  const processor = c.spec.processor as { kind: string; engine?: string; modelTier?: "strong" | "fast" };
  const s = stateOf(v, c);
  const cwd = c.spec.cwd ?? null;
  const leaf = isLeafCell(c);
  const chat = kernel.context.readStateSync<CellDirectChatState>(c.id, CELL_DIRECT_CHAT_KEY);
  const card = v.cards.get(c.id) ?? (v.projects.has(c.id) ? v.projectCards.get(c.id) : undefined);
  const human = isRoot(c) || c.status === "closed" ? undefined : v.human.get(c.id);
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
    engine: llm ? (processor.engine ?? kernel.agentBackend ?? null) : null,
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

// ==================== the timeline ====================

/** What a tool call was about, in a few words: the command, the path, the patch's files. Verbatim. */
export function callBrief(input: unknown): string {
  if (input === null || typeof input !== "object") return typeof input === "string" ? oneLine(input, 300) : "";
  const o = input as Record<string, unknown>;
  for (const k of ["command", "cmd", "file_path", "path", "filePath", "notebook_path", "pattern", "query", "url", "title", "to", "artifactId", "cellId", "name"]) {
    const val = o[k];
    if (typeof val === "string" && val) return oneLine(val, 300);
    if (Array.isArray(val) && val.every((x) => typeof x === "string") && val.length) return oneLine(val.join(" "), 300);
  }
  if (Array.isArray(o["changes"])) return oneLine(changedPaths(o).join(", "), 300);
  if (typeof o["input"] === "string") return oneLine(o["input"], 300);
  const json = JSON.stringify(o);
  return json === "{}" ? "" : oneLine(json, 200);
}

function changedPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  if (Array.isArray(o["changes"])) {
    return (o["changes"] as unknown[]).flatMap((c) => (c && typeof c === "object" && typeof (c as Record<string, unknown>)["path"] === "string" ? [(c as Record<string, string>)["path"]!] : []));
  }
  if (o["changes"] && typeof o["changes"] === "object") return Object.keys(o["changes"] as object);
  for (const k of ["file_path", "path", "filePath", "notebook_path", "target_file", "TargetFile"]) if (typeof o[k] === "string" && o[k]) return [o[k] as string];
  return [];
}

/** MCP-qualified names ("mcp__ng__save_artifact", "ng.save_artifact") reduced to the tool's own name. */
const baseName = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "").replace(/^[\w-]+\./, "");

const READ = /^(read|read_file|view|view_file|grep|glob|ls|list_dir|list_files|find_files|grep_search|file_search|codebase_search|search_files|notebookread)$/i;
const EDIT = /^(edit|write|multiedit|notebookedit|apply_patch|write_file|edit_file|create_file|str_replace_editor|replace_file_content|write_to_file|file_change)$/i;
const RUN = /^(bash|shell|command|exec_command|local_shell|run_command|run_terminal_command|command_execution|job_start)$/i;
const WEB = /^(websearch|web_search|webfetch|web_fetch|read_url_content|search_web)$/i;
const KERNEL_TOOL_ZH: Readonly<Record<string, string>> = {
  save_artifact: "保存报告",
  patch_artifact: "修订报告",
  read_artifact: "读取报告",
  set_state: "更新记录",
  read_state: "查看记录",
  report_to_parent: "汇报进展",
  send_message: "发消息",
  request_approval: "提交确认卡",
  inspect_cell: "查看分身记录",
  spawn_cell: "派出分身",
  dispatch: "派出分身",
  update_cell: "调整分身",
  control_cell: "调度分身",
  close_cell: "结束分身",
  wait: "进入等待",
  save_note: "更新笔记",
  save_skill: "保存做事手册",
  read_resource: "读取完整输出",
  search_history: "翻查历史",
  set_reminder: "设提醒",
  cancel_scheduled: "取消提醒",
  track_action: "记录行动",
  complete_self: "收尾",
  pause_self: "暂停自己",
  handback: "交回总助理",
  job_observe: "查看后台命令",
  job_input: "向后台命令输入",
  job_cancel: "停止后台命令",
};

function relPath(path: string, cwd: string | null): string {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

/** "执行了 6 步操作：读取 3 个文件 · 修改 src/retry.ts · 运行 pnpm test（通过）" */
export function toolSummary(steps: readonly ToolStepDTO[], inputs: ReadonlyMap<number, unknown>, cwd: string | null): string {
  const parts = new Map<string, { kind: "read" | "edit" | "run" | "web" | "other"; label: string; items: string[]; runs: Array<{ cmd: string; ok: boolean | null }>; n: number }>();
  for (const s of steps) {
    const base = baseName(s.name);
    const kind = READ.test(base) ? "read" : EDIT.test(base) ? "edit" : RUN.test(base) ? "run" : WEB.test(base) ? "web" : "other";
    const key = kind === "other" ? (KERNEL_TOOL_ZH[base] ?? base) : kind;
    let p = parts.get(key);
    if (!p) parts.set(key, (p = { kind, label: key, items: [], runs: [], n: 0 }));
    p.n++;
    if (kind === "read" && s.brief && !p.items.includes(s.brief)) p.items.push(s.brief);
    if (kind === "edit") for (const path of changedPaths(inputs.get(s.seq)).map((x) => relPath(x, cwd))) if (!p.items.includes(path)) p.items.push(path);
    if (kind === "run") p.runs.push({ cmd: oneLine((s.brief || s.name).split("\n")[0]!, 60), ok: s.ok });
  }
  const text = [...parts.values()].map((p) => {
    switch (p.kind) {
      case "read":
        return p.items.length === 1 ? `读取 ${relPath(p.items[0]!, cwd)}` : `读取 ${p.items.length || p.n} 个文件`;
      case "edit":
        return p.items.length === 0 ? `修改 ${p.n} 处文件` : p.items.length <= 2 ? `修改 ${p.items.join("、")}` : `修改 ${p.items.slice(0, 2).join("、")} 等 ${p.items.length} 个文件`;
      case "run": {
        const shown = p.runs.slice(-2).map((r) => `运行 ${r.cmd}（${r.ok === null ? "进行中" : r.ok ? "通过" : "失败"}）`);
        return p.runs.length > 2 ? `${shown.join(" · ")} 等 ${p.runs.length} 条命令` : shown.join(" · ");
      }
      case "web":
        return `查资料 ${p.n} 次`;
      default:
        return p.n > 1 ? `${p.label} ×${p.n}` : p.label;
    }
  });
  return `执行了 ${steps.length} 步操作：${text.join(" · ")}`;
}

const SPILL_TEXT = /\n?…\[\d+ of \d+ characters are left out here:[^\]]*\]/g;
const SPILL_URI = /read_resource\("(res:\/\/[^"]+)"/;

function outputHead(output: string): string {
  const cleaned = output.replace(SPILL_TEXT, "\n…").trimEnd();
  return clip(cleaned, OUTPUT_HEAD);
}

interface BuildCtx {
  v: AgentsView;
  cell: CellRecord;
  /** The parent project that is given a copy of what a person says to this leaf. */
  syncedTo: string | null;
  /** control.steer rows of this cell, oldest first: who sent each steer (the loops record only its text). */
  steers: Array<{ id: string; principalId: string; message: string; used: boolean }>;
}

interface Built {
  item: TimelineItemDTO;
  /** Last evidence seq the item covers (a tool group grows while its steps arrive). */
  end: number;
}

function steerOrigin(ctx: BuildCtx, message: string): { id: string; principalId: string } | null {
  const s = ctx.steers.find((x) => !x.used && x.message === message) ?? ctx.steers.find((x) => x.message === message);
  if (!s) return null;
  s.used = true;
  return s;
}

function payloadOf<T>(env: Envelope): T {
  return (env.payload ?? {}) as T;
}

function inboundItem(ctx: BuildCtx, seq: number, at: number, env: Envelope): TimelineItemDTO | null {
  const { v, syncedTo } = ctx;
  const { kernel } = v.input;
  const base = { seq, at };
  const person = isPerson(kernel, env.principalId);
  const e = `e${seq}`;
  switch (env.type) {
    case PAYLOAD.cellTask: {
      const p = payloadOf<CellTaskPayload>(env);
      const text = p.instruction ?? (p.input !== undefined ? (typeof p.input === "string" ? p.input : JSON.stringify(p.input, null, 2)) : (p.title ?? ""));
      return { ...base, id: e, kind: "dispatch_brief", fromLabel: person ? personLabel(kernel, env.principalId) : cellLabel(v, p.parentCellId), text };
    }
    case PAYLOAD.userMessage: {
      const p = payloadOf<UserMessagePayload & { replyToId?: string }>(env);
      if (person) {
        const direct = env.from === KERNEL_FROM.control || env.from === "channel:ui:owner";
        return { ...base, id: env.id, kind: "user_chat", text: p.text, senderLabel: personLabel(kernel, env.principalId, p.sender), direct, mode: "enqueue", syncedTo, replyToId: p.replyToId ?? null };
      }
      const who = p.sender?.displayName ?? p.sender?.id;
      return { ...base, id: e, kind: "peer_message", fromLabel: `${channelLabelOfAddress(env.from)}${who ? ` · ${who}` : ""}`, text: p.text };
    }
    case PAYLOAD.cellMessage: {
      const p = payloadOf<CellMessagePayload>(env);
      if (person && env.from === KERNEL_FROM.control) {
        return { ...base, id: env.id, kind: "user_chat", text: p.text, senderLabel: personLabel(kernel, env.principalId), direct: true, mode: "enqueue", syncedTo, replyToId: p.replyToId ?? null };
      }
      return { ...base, id: e, kind: "peer_message", fromLabel: cellLabel(v, p.fromCellId), text: p.text };
    }
    case PAYLOAD.controlSteer: {
      const p = payloadOf<ControlSteerPayload>(env);
      if (person) return { ...base, id: env.id, kind: "user_chat", text: p.message, senderLabel: personLabel(kernel, env.principalId), direct: true, mode: "steer", syncedTo, replyToId: null };
      const from = parsePrincipal(env.principalId, kernel.ownerPrincipal);
      return { ...base, id: e, kind: "peer_message", fromLabel: `${from.kind === "cell" ? cellLabel(v, from.cellId) : "上级"}（插话）`, text: p.message };
    }
    case PAYLOAD.cellResult: {
      const p = payloadOf<CellResultPayload>(env);
      const child = v.cells.get(p.childCellId);
      const name = child ? titleOf(v, child) : "分身";
      const said = reportText(p.summary);
      const summary = said ? `：${clip(said, 300)}` : "";
      if ((p.data as { synthetic?: unknown } | undefined)?.synthetic === true) {
        const by = (p.data as { closedBy?: unknown }).closedBy;
        const who = typeof by === "string" && isPerson(kernel, by) ? personLabel(kernel, by) : null;
        return { ...base, id: e, kind: "milestone", text: `${cellLabel(v, p.childCellId)}${p.status === "cancelled" ? (who ? `被${who}叫停了` : "被叫停了") : "已结束"}`, tone: "info" };
      }
      if (p.turn) {
        const told = v.projects.has(ctx.cell.id) ? "，项目已收到通知" : "";
        return { ...base, id: e, kind: "milestone", text: `分身「${name}」这一轮结束${told}${summary}`, tone: p.status === "completed" ? "ok" : "warn" };
      }
      const label = cellLabel(v, p.childCellId);
      switch (p.status) {
        case "completed":
          return { ...base, id: e, kind: "milestone", text: `${label}已完成${summary}`, tone: "ok" };
        case "failed":
          return { ...base, id: e, kind: "milestone", text: `${label}没能完成${summary}`, tone: "warn" };
        default:
          return { ...base, id: e, kind: "milestone", text: `${label}已取消`, tone: "info" };
      }
    }
    case PAYLOAD.cellProgress: {
      const p = payloadOf<CellProgressPayload>(env);
      return { ...base, id: e, kind: "peer_message", fromLabel: cellLabel(v, p.childCellId), text: p.text };
    }
    case PAYLOAD.cellDirectChat: {
      const p = payloadOf<CellDirectChatPayload>(env);
      const who = personLabel(kernel, env.principalId);
      const child = p.childTitle ?? (v.cells.get(p.childCellId)?.title ?? "分身");
      return { ...base, id: e, kind: "system_event", text: p.mode === "steer" ? `${who}打断了分身「${child}」：${p.text}` : `${who}直接对分身「${child}」说：${p.text}` };
    }
    case PAYLOAD.jobResult: {
      const p = payloadOf<JobResultPayload>(env);
      const how = p.state === "succeeded" ? "成功" : p.state === "failed" ? `失败${p.exitCode !== null && p.exitCode !== undefined ? `，退出码 ${p.exitCode}` : ""}` : "已取消";
      return { ...base, id: e, kind: "system_event", text: `后台命令结束：${p.command}（${how}）` };
    }
    case PAYLOAD.timerFired: {
      const p = payloadOf<TimerFiredPayload>(env);
      const label = typeof p.label === "string" && p.label && !p.label.startsWith("schedule:") ? `：${p.label}` : "";
      return { ...base, id: e, kind: "system_event", text: `定时唤醒${label}` };
    }
    case PAYLOAD.stalledCheck:
      return { ...base, id: e, kind: "system_event", text: "系统巡检唤醒" };
    case PAYLOAD.runContinue:
      return { ...base, id: e, kind: "system_event", text: "接着上一轮没做完的继续" };
    case PAYLOAD.waitTimeout:
      return { ...base, id: e, kind: "system_event", text: `等待超时：${payloadOf<WaitTimeoutPayload>(env).reason}` };
    case PAYLOAD.approvalResolved: {
      const p = payloadOf<ApprovalResolvedPayload>(env);
      const who = p.approverId && p.approverId !== kernel.ownerPrincipal && isPerson(kernel, p.approverId) ? "主 Agent 代你" : "你";
      const what = p.action?.summary ?? "一张卡";
      const text =
        p.status === "approved"
          ? `${who}确认了：${what}`
          : p.status === "executed"
            ? `${who}已执行：${what}`
            : p.status === "denied"
              ? `${who}拒绝了：${what}${p.note ? `（${p.note}）` : ""}`
 : `卡片已撤下：${what}${p.note ? `（${p.note}）` : ""}`;
      return { ...base, id: e, kind: "system_event", text };
    }
    case PAYLOAD.approvalRevise:
      return { ...base, id: e, kind: "system_event", text: `你要求重拟：${payloadOf<{ instruction: string }>(env).instruction}` };
    case PAYLOAD.handback: {
      const p = payloadOf<HandbackPayload>(env);
      const original = (p.original?.payload as { text?: unknown } | undefined)?.text;
      return { ...base, id: e, kind: "system_event", text: `${cellLabel(v, p.fromCellId)}交回一条消息重新分拣${typeof original === "string" && original ? `：${clip(original, 300)}` : ""}` };
    }
    case PAYLOAD.sourceHit: {
      const p = payloadOf<SourceHitPayload>(env);
      return { ...base, id: e, kind: "peer_message", fromLabel: cellLabel(v, p.sourceCellId), text: `${p.title}：${p.summary}` };
    }
    default: {
      const p = env.payload as { text?: unknown } | null;
      return p && typeof p.text === "string" && p.text ? { ...base, id: e, kind: "peer_message", fromLabel: "系统", text: p.text } : null;
    }
  }
}

/** What a child reported, without the kernel's stand-ins for "it said nothing" (they are not news for a person). */
function reportText(summary: string | undefined): string | null {
  const t = (summary ?? "").trim();
  if (!t || /^(Finished without a report\.|Its turn ended without a word|Closed \((completed|cancelled)\) by )/.test(t)) return null;
  return t;
}

const STEER_PREFIX = steerNoteText("");
const SCRIPT_FAILED = /^\[script (.+?) exited with code (-?\d+)\]\n?([\s\S]*)$/;

function noteItem(ctx: BuildCtx, seq: number, at: number, text: string): TimelineItemDTO | null {
  const { v, syncedTo } = ctx;
  const { kernel } = v.input;
  if (text.startsWith(STEER_PREFIX)) {
    const message = text.slice(STEER_PREFIX.length);
    const origin = steerOrigin(ctx, message);
    if (origin && !isPerson(kernel, origin.principalId)) {
      const from = parsePrincipal(origin.principalId, kernel.ownerPrincipal);
      return { seq, at, id: `e${seq}`, kind: "peer_message", fromLabel: `${from.kind === "cell" ? cellLabel(v, from.cellId) : "上级"}（插话）`, text: message };
    }
    return { seq, at, id: origin?.id ?? `e${seq}`, kind: "user_chat", text: message, senderLabel: origin ? personLabel(kernel, origin.principalId) : "你", direct: true, mode: "steer", syncedTo, replyToId: null };
  }
  const script = SCRIPT_FAILED.exec(text);
  if (script) {
    const tail = script[3]!.trim();
    return { seq, at, id: `e${seq}`, kind: "system_event", text: `脚本 ${script[1]} 运行失败（退出码 ${script[2]}）${tail ? `\n${clip(tail.slice(-600), 600)}` : ""}` };
  }
  if (/^\[(closing|cancelling) this cell was not carried out/.test(text)) {
    return { seq, at, id: `e${seq}`, kind: "system_event", text: "这次收尾没有完成：还有分身在工作，等它们结束后再收尾" };
  }
  // Step-limit notes are told by the run's end; other notes are bookkeeping.
  return null;
}

function boundaryItem(seq: number, at: number, r: Extract<StepOrExternalEvidence, { kind: "run_boundary" }>): TimelineItemDTO | null {
  if (r.phase !== "end") return null;
  const e = `e${seq}`;
  switch (r.outcome) {
    case "deferred_for_approval":
      return { seq, at, id: e, kind: "milestone", text: "提交了一张卡等你确认", tone: "info" };
    case "cancelled":
      return { seq, at, id: e, kind: "system_event", text: "已被打断" };
    case "step_limit":
      return { seq, at, id: e, kind: "system_event", text: "这一轮步数到上限，先停下，稍后自动接着做" };
    case "refused":
      return { seq, at, id: e, kind: "system_event", text: "这一轮没有执行" };
    case "error":
      return { seq, at, id: e, kind: "system_event", text: `本轮出错：${clip(r.error ?? "未知错误", 500)}` };
    default:
      return null;
  }
}

const isQuestion = (text: string) => /[?？]\s*$/.test(text.trim());

function artifactRef(kernel: DeskKernel, artifactId: string, version?: number): ArtifactRefDTO | null {
  const a = kernel.context.getArtifactSync(artifactId);
  if (!a) return null;
  const v = version !== undefined ? kernel.context.getArtifactVersionSync(artifactId, version) : null;
  return { artifactId, title: a.content.title ?? "未命名文档", version: v?.version ?? a.version, updatedAt: v?.createdAt ?? a.updatedAt };
}

/** Records (oldest first) → items. Consecutive tool calls fold into one group; a message to the owner is a reply. */
function buildItems(ctx: BuildCtx, records: readonly EvidenceEntry[]): Built[] {
  const { v, cell } = ctx;
  const { kernel } = v.input;
  const out: Built[] = [];
  const seenEnvelopes = new Set<string>();
  const hidden = new Set<string>();
  const steps = new Map<string, { step: ToolStepDTO; group: Built | null; name: string }>();
  const inputs = new Map<number, unknown>();
  let group: { built: Built; steps: ToolStepDTO[] } | null = null;
  let pendingArtifacts: Built[] = [];

  const finishGroup = () => {
    if (group) {
      const item = group.built.item as Extract<TimelineItemDTO, { kind: "tool_group" }>;
      item.summary = toolSummary(group.steps, inputs, cell.spec.cwd ?? null);
      item.failed = group.steps.filter((s) => s.ok === false).length;
      item.toSeq = group.built.end;
      out.push(group.built);
      group = null;
    }
    out.push(...pendingArtifacts);
    pendingArtifacts = [];
  };
  const push = (item: TimelineItemDTO | null, end: number) => {
    finishGroup();
    if (item) out.push({ item, end });
  };

  for (const { seq, record: r } of records) {
    const at = r.at;
    switch (r.kind) {
      case "inbound": {
        if (seenEnvelopes.has(r.envelope.id)) break; // a retried batch is recorded again
        seenEnvelopes.add(r.envelope.id);
        push(inboundItem(ctx, seq, at, r.envelope), seq);
        break;
      }
      case "assistant_text":
        if (r.text.trim()) push({ seq, at, id: `r${seq}`, kind: "assistant_reply", text: r.text.trim(), toOwner: false, question: isQuestion(r.text) }, seq);
        break;
      case "system_note":
        push(noteItem(ctx, seq, at, r.text), seq);
        break;
      case "external":
        push({ seq, at, id: `e${seq}`, kind: "peer_message", fromLabel: `外部资料 · ${r.title ?? r.source}`, text: clip(r.text, 4_000) }, seq);
        break;
      case "run_boundary": {
        const item = boundaryItem(seq, at, r);
        if (item) push(item, seq);
        else if (group) group.built.end = Math.max(group.built.end, seq);
        break;
      }
      case "tool_call": {
        const base = baseName(r.name);
        const input = (r.input ?? {}) as Record<string, unknown>;
        if (base === "send_message" && input["to"] === "channel:ui:owner") {
          hidden.add(r.toolUseId);
          const text = typeof input["text"] === "string" ? input["text"] : typeof input["artifactId"] === "string" ? `（发来一份草稿：${artifactRef(kernel, input["artifactId"])?.title ?? "未命名文档"}）` : "";
          if (text.trim()) push({ seq, at, id: `r${seq}`, kind: "assistant_reply", text: text.trim(), toOwner: true, question: isQuestion(text) }, seq);
          break;
        }
        if (!group) group = { built: { item: { seq, at, id: `g${seq}`, kind: "tool_group", toSeq: seq, summary: "", failed: 0, steps: [] }, end: seq }, steps: [] };
        const step: ToolStepDTO = { seq, at, name: r.name, brief: callBrief(r.input), ok: null, output: null, spillUri: null, durationMs: null };
        group.steps.push(step);
        (group.built.item as Extract<TimelineItemDTO, { kind: "tool_group" }>).steps = group.steps;
        group.built.end = seq;
        inputs.set(seq, r.input);
        steps.set(r.toolUseId, { step, group: group.built, name: base });
        break;
      }
      case "tool_result": {
        if (hidden.has(r.toolUseId)) break;
        let found = steps.get(r.toolUseId);
        if (!found) {
          // Its call is before this window (or was never recorded): the result stands as a step of its own.
          if (!group) group = { built: { item: { seq, at, id: `g${seq}`, kind: "tool_group", toSeq: seq, summary: "", failed: 0, steps: [] }, end: seq }, steps: [] };
          const step: ToolStepDTO = { seq, at, name: r.name, brief: "", ok: null, output: null, spillUri: null, durationMs: null };
          group.steps.push(step);
          (group.built.item as Extract<TimelineItemDTO, { kind: "tool_group" }>).steps = group.steps;
          found = { step, group: group.built, name: baseName(r.name) };
        }
        const { step } = found;
        step.ok = r.isError !== true;
        step.output = r.output ? outputHead(r.output) : null;
        step.spillUri = r.spillUri ?? SPILL_URI.exec(r.output ?? "")?.[1] ?? null;
        step.durationMs = step.seq === seq ? null : Math.max(0, at - step.at);
        if (found.group) found.group.end = Math.max(found.group.end, seq);
        if ((found.name === "save_artifact" || found.name === "patch_artifact") && step.ok) {
          const m = /Saved (\S+?) v(\d+)/.exec(r.output ?? "");
          const callInput = inputs.get(step.seq) as { artifactId?: unknown } | undefined;
          const id = m?.[1] ?? (typeof callInput?.artifactId === "string" ? callInput.artifactId : null);
          const ref = id ? artifactRef(kernel, id, m ? Number(m[2]) : undefined) : null;
          if (ref) {
            const built: Built = { item: { seq, at, id: `a${seq}`, kind: "artifact_event", verb: ref.version === 1 ? "created" : "revised", artifact: ref }, end: seq };
            if (group) pendingArtifacts.push(built);
            else out.push(built);
          }
        }
        break;
      }
    }
  }
  finishGroup();
  out.sort((a, b) => a.item.seq - b.item.seq);
  return out;
}

function buildCtx(v: AgentsView, cell: CellRecord): BuildCtx {
  const { kernel } = v.input;
  const parent = cell.parentId ? v.cells.get(cell.parentId) : undefined;
  const syncedTo = cell.spec.ccParent && parent && parent.status !== "closed" ? titleOf(v, parent) : null;
  const steers = kernel.inbox
    .listMessagesSync({ cellId: cell.id, type: PAYLOAD.controlSteer })
    .sort((a, b) => a.seq - b.seq)
    .map((m) => ({ id: m.envelope.id, principalId: m.envelope.principalId, message: (m.envelope.payload as ControlSteerPayload).message, used: false }));
  return { v, cell, syncedTo, steers };
}

export interface TimelineQuery {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
}

/** Items of one page and the evidence range it covers. */
function page(ctx: BuildCtx, q: TimelineQuery): { items: TimelineItemDTO[]; firstSeq: number; lastSeq: number; hasEarlier: boolean } {
  const { kernel } = ctx.v.input;
  const cellId = ctx.cell.id;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(q.limit ?? DEFAULT_LIMIT)));
  // Run boundaries never become items: a page that starts right after one has nothing earlier to show.
  const earlier = (seq: number) => get<{ n: number }>(kernel.db, "SELECT 1 AS n FROM evidence WHERE cell_id = ? AND seq < ? AND kind != 'run_boundary' LIMIT 1", [cellId, seq]) !== undefined;

  if (q.afterSeq !== undefined) {
    // Incremental: an open tool group that the caller already has a part of is sent again whole (same id).
    const after = Math.max(0, Math.floor(q.afterSeq));
    let start = after + 1;
    const back = tailRecords(kernel, cellId, 200, after + 1);
    for (let i = back.length - 1; i >= 0; i--) {
      const k = back[i]!.record.kind;
      if (k !== "tool_call" && k !== "tool_result") break;
      start = back[i]!.seq;
    }
    let records = kernel.context.listEvidenceSync(cellId, { afterSeq: start - 1, limit: limit * 8 + 50 });
    if (q.beforeSeq !== undefined) records = records.filter((r) => r.seq < q.beforeSeq!);
    const built = buildItems(ctx, records).filter((b) => b.end > after);
    const taken = built.slice(0, limit);
    if (taken.length === 0) return { items: [], firstSeq: 0, lastSeq: 0, hasEarlier: false };
    const lastSeq = taken.length === built.length ? Math.max(records.at(-1)!.seq, ...taken.map((b) => b.end)) : Math.max(...taken.map((b) => b.end));
    return { items: taken.map((b) => b.item), firstSeq: taken[0]!.item.seq, lastSeq, hasEarlier: earlier(taken[0]!.item.seq) };
  }

  // The newest `limit` items (before `beforeSeq`): read backwards until enough items are complete.
  let window = limit * 4;
  for (;;) {
    const records = tailRecords(kernel, cellId, window, q.beforeSeq);
    if (records.length === 0) return { items: [], firstSeq: 0, lastSeq: 0, hasEarlier: false };
    const fromStart = !earlier(records[0]!.seq);
    let built = buildItems(ctx, records);
    // The first item of a window that does not reach back to the beginning may be a cut tool group.
    if (!fromStart) built = built.slice(1);
    if (built.length >= limit || fromStart || window >= 20_000) {
      const taken = built.slice(-limit);
      if (taken.length === 0) return { items: [], firstSeq: 0, lastSeq: 0, hasEarlier: !fromStart };
      return { items: taken.map((b) => b.item), firstSeq: taken[0]!.item.seq, lastSeq: Math.max(records.at(-1)!.seq, ...taken.map((b) => b.end)), hasEarlier: earlier(taken[0]!.item.seq) };
    }
    window *= 2;
  }
}

/** The latest question the node asked the owner that nobody has answered yet. */
function pendingQuestionOf(ctx: BuildCtx): CellTimelineDTO["pendingQuestion"] {
  let q: CellTimelineDTO["pendingQuestion"] = null;
  for (const { item } of buildItems({ ...ctx, steers: ctx.steers.map((s) => ({ ...s, used: false })) }, tailRecords(ctx.v.input.kernel, ctx.cell.id, 200))) {
    if (item.kind === "assistant_reply" && item.question) q = { id: item.id, text: item.text };
    else if (item.kind === "user_chat") q = null;
  }
  return q;
}

/** The text of the timeline item `id` of this cell (what a reply refers to), if it can be found. */
export function timelineItemText(input: ProjectionInput, cellId: string, id: string): string | null {
  const m = /^[a-z](\d+)$/.exec(id);
  const v = agentsView(input, [cellId]);
  const cell = v.cells.get(cellId);
  if (!cell) return null;
  const ctx = buildCtx(v, cell);
  let records: EvidenceEntry[];
  if (m) records = input.kernel.context.listEvidenceSync(cellId, { afterSeq: Number(m[1]) - 1, limit: 1 });
  else records = tailRecords(input.kernel, cellId, 400);
  for (const { item } of buildItems(ctx, records)) {
    if (item.id !== id) continue;
    if ("text" in item && typeof item.text === "string") return item.text;
    if (item.kind === "tool_group") return item.summary;
    if (item.kind === "artifact_event") return item.artifact.title;
  }
  return null;
}

function artifactsOf(v: AgentsView, cell: CellRecord): ArtifactRefDTO[] {
  const { kernel } = v.input;
  const ids = new Set([cell.id]);
  const pid = projectIdOf(v, cell);
  if (pid) {
    const stack = [pid];
    ids.add(pid);
    while (stack.length) for (const ch of v.children.get(stack.pop()!) ?? []) (ids.add(ch.id), stack.push(ch.id));
  }
  return [...ids]
    .flatMap((id) => kernel.context.listArtifactsSync(id))
    .filter((a) => a.content.format !== "card")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, ARTIFACT_LIMIT)
    .map((a) => ({ artifactId: a.artifactId, title: a.content.title ?? "未命名文档", version: a.version, updatedAt: a.updatedAt }));
}

/** A coordinator's own notes (save_note, scope "cell"), as the kernel puts them in front of it at every wake-up. */
export function notesOf(kernel: DeskKernel, cellId: string): string | null {
  const notes = kernel.context.listKnowledgeSync({ kind: "working_note", cellId, includeGlobal: false }).filter((n) => n.scope === "cell" && n.cellId === cellId && n.body.trim());
  if (notes.length === 0) return null;
  notes.sort((a, b) => a.name.localeCompare(b.name));
  return notes.map((n) => `## ${n.name}\n${n.body.trim()}`).join("\n\n");
}

/** Last thing a leaf said after its parent's cursor (the "未汇总" preview). */
function lastSaid(kernel: DeskKernel, cellId: string, afterSeq: number): string | null {
  const row = get<{ content: string }>(kernel.db, "SELECT content FROM evidence WHERE cell_id = ? AND seq > ? AND kind = 'assistant_text' ORDER BY seq DESC LIMIT 1", [cellId, afterSeq]);
  if (!row) return null;
  try {
    const text = (JSON.parse(row.content) as { text?: unknown }).text;
    return typeof text === "string" && text.trim() ? oneLine(text, 200) : null;
  } catch {
    return null;
  }
}

function controlsOf(v: AgentsView, c: CellRecord): ButtonDTO[] {
  if (c.status === "closed") return [];
  const path = `/api/cells/${enc(c.id)}/control`;
  const treeIds = new Set([c.id]);
  for (const id of treeIds) for (const child of v.children.get(id) ?? []) treeIds.add(child.id);
  const jobs = v.input.kernel.workspace.listJobsSync({state:["running"]}).filter(j=>treeIds.has(j.cellId));
  const pause = button({ ...(jobs.length ? {confirm:`还有 ${jobs.length} 个后台命令正在运行。确认暂停？`} : {}), id: "pause", label: "⏸ 暂停", endpoint: post(path, { action: "pause" }) });
  const resume = button({ id: "resume", label: "▶ 继续", primary: true, endpoint: post(path, { action: "resume" }) });
  const cancel = button({
    id: "cancel",
    label: "■ 紧急叫停",
    group: "more",
    endpoint: post(path, { action: "cancel" }),
    confirm: "立即停止它和它下面的全部后台工作？正在跑的命令会被中断，文件和分支都留在原处。",
  });
  const parked = v.projects.get(c.id)?.lifecycle === "someday";
  // The desk is the root of everything: pausing or stopping it would stop the whole workbench.
  if (isRoot(c)) return c.status === "paused" ? [resume] : [];
  // A source is removed in the sources drawer; here it is only paused and resumed.
  const isSource = c.preset === "sensor";
  if (c.status === "paused") return parked ? [cancel] : isSource ? [resume] : [resume, cancel];
  return isSource ? [pause] : [pause, cancel];
}

function composerOf(v: AgentsView, c: CellRecord, node: TopologyNodeDTO): ComposerDTO {
  const parent = c.parentId ? v.cells.get(c.parentId) : undefined;
  const leaf = isLeafCell(c);
  const syncTo = leaf && parent && parent.status !== "closed" && !isRoot(parent) ? { cellId: parent.id, title: titleOf(v, parent) } : null;
  const title = node.title;
  const base = { canSteer: false, syncTo, quick: [] as ButtonDTO[] };
  if (node.processorType === "code") {
    const path = `/api/cells/${enc(c.id)}`;
    const quick =
      c.status === "closed"
        ? []
        : [
            button({ id: "trigger", label: "立即触发一次检查", primary: true, endpoint: post(`${path}/trigger`) }),
            c.status === "paused" ? button({ id: "resume", label: "▶ 继续", endpoint: post(`${path}/control`, { action: "resume" }) }) : controlsOf(v,c).find(b=>b.id==="pause")!,
          ];
    return { ...base, syncTo: null, enabled: false, mode: "script", hint: "这是零算力确定性脚本探针，不接受自然语言对话", placeholder: "", quick };
  }
  if (c.status === "closed" && !node.canChat) {
    return {
      ...base,
      syncTo: null,
      enabled: false,
      mode: "archived",
      hint: "它已随所属项目归档，不能再发消息；有新的需要，去总助理另起新事项",
      placeholder: "",
      quick: [button({ id: "open_desk", label: "去总助理另起新事项", primary: true, href: "#/agents/desk" })],
    };
  }
  const running = node.state === "running";
  if (isRoot(c)) {
    return {
      ...base,
      enabled: true,
      mode: "desk",
      canSteer: running,
      hint: running ? "总助理正在处理 — 默认顺手补充，它这一步做完就看；方向不对可以立即打断" : "直接和总助理说：交代新事、回答它的追问、问问进展",
      placeholder: "和总助理说点什么…",
    };
  }
  if (c.status === "paused") {
    return { ...base, enabled: true, mode: "paused", hint: "已暂停 — 消息会先存着，继续之后它再处理", placeholder: `给「${title}」留言…` };
  }
  if (!leaf) {
    return {
      ...base,
      enabled: true,
      mode: "coordinator",
      canSteer: running,
      hint: running ? "它正在处理 — 默认顺手补充，这一步做完就看；方向不对可以立即打断" : "直接向它传达指令，它醒来后会调整安排和派单",
      placeholder: `给「${title}」下指令…`,
    };
  }
  if (running) {
    return { ...base, enabled: true, mode: "running", canSteer: true, hint: "该分身正在运行 — 默认顺手补充，本轮收尾时处理；跑偏了可以立即打断", placeholder: `给「${title}」发补充指示…` };
  }
  const hint =
    c.status === "closed"
      ? "分身已结束 — 发消息会把它带回来，沿原上下文接着做"
      : node.state === "dormant"
        ? "分身已待命 — 发消息将沿原上下文立即唤醒续跑"
        : "分身在等待中 — 发消息会立即唤醒它";
  return { ...base, enabled: true, mode: "wake", hint, placeholder: `给「${title}」发消息…` };
}

function jobsOf(kernel: DeskKernel, facts: Facts | undefined): CellJobDTO[] {
  return (facts?.jobs ?? []).map((j) => {
    let tail: string | null = null;
    try {
      const o = kernel.workspace.observeJobSync(j.jobId);
      tail = o?.tail ? o.tail.slice(-2_000) : null;
    } catch {
      tail = null;
    }
    return { jobId: j.jobId, command: j.command, startedAt: j.startedAt, tail };
  });
}

/** GET /api/cells/:cellId/timeline — null for an unknown cell. */
export function projectTimeline(input: ProjectionInput, cellId: string, q: TimelineQuery = {}): CellTimelineDTO | null {
  const { kernel, now } = input;
  const cell = kernel.getCell(cellId);
  if (!cell) return null;
  const leafChildren = kernel.listCells({ parentId: cellId }).filter((c) => isLeafCell(c));
  const v = agentsView(input, [cellId, ...leafChildren.map((c) => c.id)]);
  const node = nodeOf(v, cell);
  const ctx = buildCtx(v, cell);

  const breadcrumb: CellTimelineDTO["breadcrumb"] = [];
  for (let c: CellRecord | undefined = cell; c; c = c.parentId ? v.cells.get(c.parentId) : undefined) breadcrumb.unshift({ cellId: c.id, label: crumbLabel(v, c) });

  const unpulled: CellTimelineDTO["unpulled"] = [];
  if (!isLeafCell(cell)) {
    for (const leaf of leafChildren) {
      const { count, cursor } = unpulledOf(kernel, leaf);
      if (count === 0) continue;
      const chat = kernel.context.readStateSync<CellDirectChatState>(leaf.id, CELL_DIRECT_CHAT_KEY);
      unpulled.push({ cellId: leaf.id, title: titleOf(v, leaf), count, preview: lastSaid(kernel, leaf.id, cursor), hadDirectUserChat: (chat?.total ?? 0) > 0 });
    }
  }
  const p = page(ctx, q);
  return {
    generatedAt: now,
    node,
    breadcrumb,
    branch: branchOf(node.gitRoot),
    artifacts: artifactsOf(v, cell),
    notes: isLeafCell(cell) ? null : notesOf(kernel, cell.id),
    unpulled,
    jobs: jobsOf(kernel, v.facts.get(cell.id)),
    pendingQuestion: pendingQuestionOf(ctx),
    controls: controlsOf(v, cell),
    composer: composerOf(v, cell, node),
    items: p.items,
    firstSeq: p.firstSeq,
    lastSeq: p.lastSeq,
    hasEarlier: p.hasEarlier,
  };
}

/** One node as the topology shows it (the answer of a control click). */
export function projectNode(input: ProjectionInput, cellId: string): TopologyNodeDTO | null {
  const v = agentsView(input, [cellId]);
  const cell = v.cells.get(cellId);
  return cell ? nodeOf(v, cell) : null;
}

export const RESOURCE_PAGE_DEFAULT = 16_000;
export const RESOURCE_PAGE_MAX = 64_000;

/** One page of a spilled output (`res://…`); null when there is no such resource. */
export function resourcePage(kernel: DeskKernel, uri: string, offset: number, limit: number): ResourcePageDTO | null {
  const row = get<{ size_chars: number }>(kernel.db, "SELECT size_chars FROM resources WHERE uri = ?", [uri]);
  if (!row) return null;
  const content = kernel.context.readResourceSync(kernel.deskCellId, uri, { offset, limit });
  return { uri, content, offset, limit, totalChars: row.size_chars, hasMore: offset + content.length < row.size_chars };
}
