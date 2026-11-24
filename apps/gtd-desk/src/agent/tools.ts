import type { CellActivity, CellSpecInput, Kernel } from "@ng/cell";

import { OBSERVATION_NOTE, type ProjectInit, type ProjectMode } from "@ng/presets";
import type { ProjectRecord } from "@ng/presets/records";
import {
  CELL_DIRECT_CHAT_KEY,
  CELL_STATUS_KEY,
  cellRoleOf,
  DEFAULT_RESOURCE_PAGE_CHARS,
  MAX_RESOURCE_PAGE_CHARS,
  childRunnerOverride,
  get,
  isNgError,
  newId,
  PAYLOAD,
  type ActionRecord,
  type BallOwner,
  type CellDirectChatState,
  type CellRecord,
  type CellResultPayload,
  type CellStatusLine,
  type ProjectProposal,
  type SendToCellResult,
  type SourceHitPayload,
  type RunnerSelection,
} from "@ng/protocol";
import type {
  ActivityKind,
  ArtifactDTO,
  ArtifactSaveRequest,
  CaptureRequest,
  CellRoleDTO,
  CreateSourceRequest,
  Effort,
  ModelChoiceDTO,
  ModelSelectionDTO,
  ModelsDTO,
  PlanSaveRequest,
  ProjectRowDTO,
  RunnerDTO,
  TimelineItemDTO,
  UpdateModelsRequest,
} from "../shared/api";
import type { Delivery, PersonMessage } from "../server/agents";
import { DeskError, type Desk, type DeskActor, type ProjectOp } from "../server/desk";
import { isLeafCell, notesOf, unpulledOf } from "../server/projections/agents";
import { projectOfAction, readActions, readProjects, SKILL_SUGGESTION_PREFIX, type Located, type SkillSuggestion } from "../server/projections/common";
import { parseDecisions, planDecisions } from "../server/projections/format";
import { AGENT_TOOLS, type AgentToolDoc } from "./guide";
import type { AgentCallContext, AgentControlPlane, AgentToolResult } from "./routes";

// docs/05 §5.3 — the external main agent's control plane: every tool of guide.ts, run as the caller's `agent:<id>`
// principal. Reads go through the same projections as the web client; changes go through the same Desk functions as
// the workbench buttons (parameterised by the principal) or straight to the kernel as that principal.
// The rights are the owner's (proposal 07); the principal records the entrance. The kernel and the Gate check state,
// versions and concurrency; this file only turns their answers into plain text.

export interface AgentControlPlaneDeps {
  kernel: Kernel;
  desk: Desk;
}

type Args = Record<string, unknown>;
type Principal = `agent:${string}`;
type Handler = (args: Args, principalId: Principal, call: AgentCallContext) => Promise<AgentToolResult> | AgentToolResult;

/** chat_with_desk waits at most this long for the desk's answer (audit E08): a bounded look, never a poll. */
const MAX_WAIT_SECONDS = 30;

/** A notice to the owner is quoted whole up to here: what it ends on (who merges, what is left) matters as much as how it starts. */
const NOTICE_CHARS = 1_500;

/** Who has the ball, as the agent reads it. */
const OWNER_TEXT: Readonly<Record<BallOwner, string>> = { human: "主人", agent: "agent", waiting: "等待外部" };

const ok = (text: string, data?: unknown): AgentToolResult => ({ text, ...(data !== undefined ? { data } : {}) });
const fail = (text: string, data?: unknown): AgentToolResult => ({ text, isError: true, ...(data !== undefined ? { data } : {}) });

/** 2026-11-18T09:30Z */
export function isoMin(t: number | null | undefined): string {
  if (typeof t !== "number" || !Number.isFinite(t)) return "—";
  return `${new Date(t).toISOString().slice(0, 16)}Z`;
}

function oneLine(text: string | null | undefined, max = 160): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function runnerSelection(args: Args): RunnerSelection {
  return { runner: str(args["runner"]), model: str(args["model"]), effort: str(args["effort"]) };
}

// ==================== argument validation (against the schemas in guide.ts) ====================

interface PropSchema {
  type?: string | readonly string[];
  enum?: readonly unknown[];
  items?: PropSchema;
  properties?: Record<string, PropSchema>;
  required?: readonly string[];
  additionalProperties?: unknown;
  /** Strings: blank counts as missing unless this is 0. */
  minLength?: number;
}

const typesOf = (p: PropSchema): readonly string[] => (p.type === undefined ? [] : typeof p.type === "string" ? [p.type] : p.type);
const isRecord = (v: unknown): v is Args => v !== null && typeof v === "object" && !Array.isArray(v);
const schemaOf = (doc: AgentToolDoc) => doc.inputSchema as PropSchema;

/**
 * Near-miss argument names an agent calling from the tool's name alone tends to use (some clients show a tool's
 * schema only after its first call). Applied only when the real name is absent and the alias is not itself a
 * parameter of that tool, so a correct call is never altered.
 */
const ARG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  text: ["message", "instruction", "content", "body", "note_text"],
  id: ["projectId", "project_id", "cellId", "cell_id", "cardId", "card_id", "artifactId", "artifact_id"],
  projectId: ["project_id", "project"],
  actionId: ["action_id", "action"],
  query: ["q", "text", "keywords"],
  state: ["op", "action", "status"],
  note: ["reason", "comment"],
  name: ["slug", "title"],
  brief: ["description", "instruction", "details"],
};


export function normalizeArgs(doc: AgentToolDoc, args: Args): Args {
  const props = (doc.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const out: Args = { ...args };
  for (const [real, aliases] of Object.entries(ARG_ALIASES)) {
    if (!(real in props) || out[real] !== undefined) continue;
    for (const alias of aliases) {
      if (alias in props || out[alias] === undefined) continue;
      out[real] = out[alias];
      delete out[alias];
      break;
    }
  }
  // A bare "id" on a tool that takes projectId/actionId: the id's own prefix says which one was meant.
  if (out["id"] !== undefined && !("id" in props)) {
    const target = "sensorId" in props ? "sensorId" : typeof out["id"] === "string" && out["id"].startsWith("act_") ? "actionId" : "projectId";
    if (target in props && out[target] === undefined) {
      out[target] = out["id"];
      delete out["id"];
    }
  }
  return out;
}

/** Clients send null for an argument they leave out; it stays only where the schema gives null a meaning. */
export function dropNulls(value: unknown, schema: PropSchema | undefined): unknown {
  if (Array.isArray(value)) return schema?.items ? value.map((v) => dropNulls(v, schema.items)) : value;
  if (!isRecord(value) || !schema?.properties) return value;
  const out: Args = {};
  for (const [k, v] of Object.entries(value)) {
    const p = schema.properties[k];
    if (v === undefined || (v === null && !(p && typesOf(p).includes("null")))) continue;
    out[k] = dropNulls(v, p);
  }
  return out;
}

function fitsType(type: string, v: unknown): boolean {
  switch (type) {
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return isRecord(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    default:
      return typeof v === type;
  }
}

function typeText(p: PropSchema): string {
  return typesOf(p)
    .map((t) => {
      const items = p.items ? typesOf(p.items)[0] : undefined;
      return t === "null" ? "null" : t === "array" ? `an array${items ? ` of ${items}s` : ""}` : `${t === "object" ? "an" : "a"} ${t}`;
    })
    .join(" or ");
}

function checkProps(schema: PropSchema, args: Args, at: string, problems: string[]): void {
  const props = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(args)) if (!(k in props)) problems.push(`unknown argument "${at}${k}"`);
  }
  for (const r of schema.required ?? []) {
    const v = args[r];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim() && props[r]?.minLength !== 0)) problems.push(`"${at}${r}" is required`);
  }
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (p && v !== undefined) checkValue(p, v, `${at}${k}`, problems);
  }
}

function checkValue(p: PropSchema, v: unknown, name: string, problems: string[]): void {
  const types = typesOf(p);
  if (types.length > 0 && !types.some((t) => fitsType(t, v))) {
    problems.push(`"${name}" must be ${typeText(p)}`);
    return;
  }
  if (Array.isArray(v) && p.items) {
    const item = p.items;
    // A list of plain values is named once; a list of objects says which entry and field is wrong.
    if (item.properties) v.forEach((x, i) => checkValue(item, x, `${name}[${i}]`, problems));
    else if (typesOf(item).length > 0 && !v.every((x) => typesOf(item).some((t) => fitsType(t, x)))) problems.push(`"${name}" must be ${typeText(p)}`);
    return;
  }
  if (isRecord(v) && p.properties) return checkProps(p, v, `${name}.`, problems);
  if (p.minLength && typeof v === "string" && v.trim().length < p.minLength) problems.push(`"${name}" must not be blank`);
  else if (p.enum && !p.enum.includes(v)) problems.push(`"${name}" must be one of ${p.enum.map((e) => JSON.stringify(e)).join(", ")}`);
}

/** null when `args` fits the tool's input schema; otherwise what is wrong, for the agent to fix. */
export function validateArgs(doc: AgentToolDoc, args: Args): string | null {
  const schema = schemaOf(doc);
  const problems: string[] = [];
  checkProps({ ...schema, additionalProperties: false }, args, "", problems);
  if (problems.length === 0) return null;
  const required = schema.required?.length ? ` Required: ${schema.required.join(", ")}.` : "";
  return `Invalid arguments for ${doc.name}: ${problems.join("; ")}.${required} Allowed: ${Object.keys(schema.properties ?? {}).join(", ") || "none"}.`;
}

// ==================== the control plane ====================

export function createAgentControlPlane(deps: AgentControlPlaneDeps): AgentControlPlane {
  const { kernel, desk } = deps;
  const { context, clock } = kernel;
  const deskId = kernel.deskCellId;
  const docs = new Map(AGENT_TOOLS.map((t) => [t.name, t]));
  const now = () => clock.now();
  const as = (principalId: Principal, note?: string): DeskActor => ({ principalId, ...(note ? { note } : {}) });

  // ---------- shared readers ----------

  function projectRecordOf(id: string): ProjectRecord | null {
    return readProjects(kernel).find(p => p.cellId === id)?.record ?? null;
  }

  const noProject = (id: string) =>
    fail(`There is no project "${id}". Project ids look like proj_…; get them from workbench_overview, search or create_project. (For any other cell use get_cell / control_cell.)`);

  function statusLineOf(cellId: string): string | null {
    const s = context.readStateSync<CellStatusLine>(cellId, CELL_STATUS_KEY);
    return s && typeof s.text === "string" ? s.text : null;
  }

  /** Every cell of a subtree, closed ones included (reports of finished workers stay with the project). */
  function subtreeIds(rootId: string): string[] {
    const out = [rootId];
    for (let i = 0; i < out.length; i++) for (const c of kernel.listCells({ parentId: out[i]! })) out.push(c.id);
    return out;
  }

  function projectActionsOf(projectId: string): Array<Located<ActionRecord>> {
    const projectCells = new Set(readProjects(kernel).map((p) => p.cellId));
    return readActions(kernel).filter((a) => projectOfAction(kernel, a, projectCells) === projectId);
  }

  function cardLine(item: ReturnType<typeof desk.listHumanItems>[number]) {
    const parts = [`rev=${item.itemRevision}`, item.artifactVersion !== null && `草稿 v${item.artifactVersion}`,
      item.project && `${item.project.title}${item.project.parked ? "（项目已停靠在以后再说，这一项暂时不用办）" : item.project.paused ? "（项目已暂停）" : ""}`].filter(Boolean);
    // What it asks of the owner: a title alone ("确认范围") does not say what to answer.
    const ask = item.description && item.description.trim() !== item.title.trim() ? `\n  ↳ ${oneLine(item.description, 240)}` : "";
    const choices = item.category === "decision" && item.options.length ? `\n  ↳ 选项：${item.options.map((o) => o.label).join(" / ")}` : "";
    return `- ${item.id}「${item.title}」 ${parts.join(" · ")}${ask}${choices}`;
  }

  function projectLine(p: ProjectRowDTO): string {
    const parts: string[] = [];
    if (p.ball) parts.push(`球在：${OWNER_TEXT[p.ball.owner]} · ${oneLine(p.ball.text, 100)}`);
    else parts.push("没有未完成的动作");
    if (p.summary) parts.push(`摘要：${oneLine(p.summary, 120)}`);
    if (p.cwd) parts.push(`目录 ${p.cwd}`);
    if (p.workers.length) parts.push(`${p.workers.length} 个后台分身（${p.workers.filter((w) => w.state === "running").length} 个在跑）`);
    if (p.pendingCardId) parts.push(`有一项 ${p.pendingCardId} 等你决定`);
    if (p.paused && p.lifecycle === "active") parts.push(`已暂停${desk.pauseInfo(p.id) ? `（${desk.pauseInfo(p.id)!.text}）` : ""}`);
    if (p.stalled) parts.push(`⚠ 停滞（自 ${isoMin(p.stalledSince)}，没有任何推进锚点）`);
    return `- ${p.id}「${p.title}」— ${parts.join("；")}`;
  }

  function projectData(p: ProjectRowDTO): Record<string, unknown> {
    return {
      id: p.id,
      title: p.title,
      lifecycle: p.lifecycle,
      paused: p.paused,
      ball: p.ball ? { owner: p.ball.owner, text: p.ball.text } : null,
      summary: p.summary,
      cwd: p.cwd,
      stalled: p.stalled,
      stalledSince: p.stalledSince,
      pendingCardId: p.pendingCardId,
      openActions: p.openActions.map((a) => ({ id: a.actionId, title: a.title, owner: a.owner, text: a.text })),
      workers: p.workers,
    };
  }

  function section(title: string, lines: string[]): string {
    return `${title}（${lines.length}）\n${lines.length ? lines.join("\n") : "（无）"}`;
  }

  /** Who is active in which work tree right now — a fact, not a lock: nobody is queued. */
  function workspaceLines(): { lines: string[]; data: unknown[] } {
    // A coordinator whose own turn is under way is not at work in the tree: it reads and dispatches (audit L04).
    const occ = kernel
      .activeWorkspaces()
      .map((o) => ({ ...o, active: o.active.filter((u) => u.state === "job" || isLeafCell(kernel.getCell(u.cellId)!)) }))
      .filter((o) => o.active.length > 0);
    const lines = occ.map((o) => {
      const who = o.active.map(
        (u) =>
          `${u.cellId}${u.title ? `「${u.title}」` : ""}${u.projectTitle ? `（项目「${u.projectTitle}」）` : ""}${u.cwd !== o.key ? ` 在 ${u.cwd}` : ""}：${u.state === "job" ? "后台命令在跑" : "正在工作"}${u.statusLine ? ` — ${oneLine(u.statusLine, 80)}` : ""}`,
      );
      return `- ${o.key} — ${who.join("；")}`;
    });
    return { lines, data: occ };
  }

  /** Whom a wait is on, for a person. */
  function waitPartyText(waitingFor: string): string {
    if (waitingFor === "human") return "主人";
    if (waitingFor === "external") return "外部事件";
    if (waitingFor === `inbox:${deskId}`) return "主台答复";
    if (waitingFor.startsWith("inbox:")) {
      const c = kernel.getCell(waitingFor.slice("inbox:".length));
      return c?.title ? `「${c.title}」答复` : `${waitingFor.slice("inbox:".length)} 答复`;
    }
    return waitingFor;
  }
  /** What a waiting cell waits on, as the owner reads it. */
  const WAIT_CAUSE: Partial<Record<NonNullable<CellActivity["cause"]>, string>> = {
    card: "有一项在等主人决定",
    watch: "在等它订阅的新消息",
    timer: "定了时，到点再看",
    wait: "在等答复",
    child: "它派出的分身还在做",
  };

  /** A cell's state in a few words for a person (and for the agent relaying it). */
  function cellStateText(c: CellRecord): string {
    if (c.status === "closed") return c.closeReason === "cancelled" ? "已取消" : "已归档";
    const a = kernel.activityOf([c.id]).get(c.id);
    switch (a?.state) {
      case "working":
        return "运行中";
      case "paused":
        return "已暂停";
      case "waiting": {
        const w = kernel.listOpenWaits([c.id])[0];
        return w ? `等待中（在等${waitPartyText(w.waitingFor)}：${oneLine(w.reason, 60)}）` : `等待中（${(a.cause && WAIT_CAUSE[a.cause]) ?? a.why}）`;
      }
      case "dormant":
        return "待命可唤醒";
      default:
        return isLeafCell(c) ? "待命可唤醒" : "待命";
    }
  }

  function runningLines(): { lines: string[]; data: unknown[] } {
    const out: Array<{ cellId: string; title: string | null; preset: string | null; projectId: string | null; jobs: number; statusLine: string | null }> = [];
    const walk = (nodes: ReturnType<Kernel["tree"]>) => {
      for (const n of nodes) {
        if (n.status !== "closed" && (n.running || n.runningJobs > 0)) {
          const pid = kernel.getCell(n.cellId)?.spec.meta?.["projectCellId"];
          out.push({ cellId: n.cellId, title: n.title, preset: n.preset, projectId: typeof pid === "string" ? pid : null, jobs: n.runningJobs, statusLine: n.statusLine });
        }
        walk(n.children);
      }
    };
    walk(kernel.tree());
    const lines = out.map(
      (r) =>
        `- ${r.cellId}${r.title ? `「${r.title}」` : ""}（${r.preset ?? "cell"}${r.projectId && r.projectId !== r.cellId ? `，属于项目 ${r.projectId}` : ""}${r.jobs ? `，${r.jobs} 个后台命令` : ""}）${r.statusLine ? ` — ${oneLine(r.statusLine, 120)}` : ""}`,
    );
    return { lines, data: out };
  }

  // ---------- what a source found (audit E19) ----------

  const NOTE_TAIL_CHARS = 1_500;

  /**
   * The latest hits of a source as text: for an observe-mode source the tail of its observation note (a cell-scoped
   * reference record of the source cell); for an active one the last hit it posted to its parent's inbox.
   */
  function latestHits(sensorId: string, mode: "active" | "observe"): { label: string; text: string | null; more: string | null } {
    const note = context.getKnowledgeSync({ kind: "reference", name: OBSERVATION_NOTE, scope: "cell", cellId: sensorId })?.body.trim() ?? "";
    if (mode === "observe" || note) {
      if (!note) return { label: "观察笔记", text: null, more: null };
      // Whole entries from the end, as many as fit.
      const entries = note.split(/\n(?=- )/);
      const kept: string[] = [];
      let size = 0;
      for (let i = entries.length - 1; i >= 0 && (kept.length === 0 || size + entries[i]!.length <= NOTE_TAIL_CHARS); i--) {
        kept.unshift(entries[i]!.length > NOTE_TAIL_CHARS ? `${entries[i]!.slice(0, NOTE_TAIL_CHARS)}…` : entries[i]!);
        size += entries[i]!.length;
      }
      const more = kept.length < entries.length ? `（共 ${entries.length} 条，前面的：read_resource { uri: "reference://${OBSERVATION_NOTE}", cellId: "${sensorId}" }）` : null;
      return { label: `观察笔记（最近 ${kept.length} 条）`, text: kept.join("\n"), more };
    }
    const parentId = kernel.getCell(sensorId)?.parentId;
    const row = parentId
      ? get<{ envelope: string }>(kernel.db, "SELECT envelope FROM inbox_messages WHERE cell_id = ? AND type = ? AND json_extract(envelope, '$.payload.sourceCellId') = ? ORDER BY seq DESC LIMIT 1", [parentId, PAYLOAD.sourceHit, sensorId])
      : undefined;
    if (!row) return { label: "最近一次命中", text: null, more: null };
    try {
      const hit = (JSON.parse(row.envelope) as { payload: SourceHitPayload }).payload;
      return { label: "最近一次命中（已投进信箱）", text: `${hit.title}：${oneLine(hit.summary, 1_000)}${hit.uri ? `（${hit.uri}）` : ""}`, more: null };
    } catch {
      return { label: "最近一次命中", text: null, more: null };
    }
  }

  // ---------- what the overview adds: questions for the owner, hubs, the desk's own workers ----------

  /** First line of a text, shortened: the gist of a report. */
  function firstLine(text: string | null | undefined, max = 160): string {
    return oneLine((text ?? "").split("\n").find((l) => l.trim()) ?? "", max);
  }

  const roleOf = (c: CellRecord) => (typeof c.spec.meta?.["role"] === "string" ? (c.spec.meta["role"] as string) : null);

  /**
   * Audit E08: the questions the desk and other live cells are asking the owner and nobody has answered — what get_cell
   * shows one cell at a time. Cheap: only cells that can ask the owner something (the desk, coordinators, and workers the
   * owner has spoken to); closed cells and scripts are never read. A cell's plain words count as a question to the owner
   * only for the desk or after the owner spoke to it; a message sent to the owner always does.
   */
  function openQuestions(): { lines: string[]; data: Array<{ cellId: string; title: string | null; id: string; text: string; answerWith: string }> } {
    const data = desk.questions().map((q) => ({ cellId: q.cellId, title: q.title, id: q.id, text: q.text, answerWith: q.desk ? "chat_with_desk" : "message_cell", stopped: q.stopped }));
    const lines = data.map((q) => {
      const who = q.cellId === deskId ? "主台" : `${q.cellId}${q.title ? `「${q.title}」` : ""}`;
      return `- ${who}在问主人${q.stopped ? "（它已停靠或暂停，这一项暂时不用答）" : ""}：${oneLine(q.text, NOTICE_CHARS)}\n  ↳ ${questionNote(q.id, q.answerWith as "chat_with_desk" | "message_cell")}`;
    });
    return { lines, data };
  }

  /** The gist of the latest result a leaf handed its parent (cell.result), without the kernel's stand-ins for "it said nothing". */
  function latestResultOf(c: CellRecord, max: number): string | null {
    if (!c.parentId) return null;
    const row = get<{ envelope: string }>(
      kernel.db,
      "SELECT envelope FROM inbox_messages WHERE cell_id = ? AND type = ? AND json_extract(envelope, '$.payload.childCellId') = ? ORDER BY seq DESC LIMIT 1",
      [c.parentId, PAYLOAD.cellResult, c.id],
    );
    if (!row) return null;
    try {
      const p = (JSON.parse(row.envelope) as { payload?: Partial<CellResultPayload> }).payload;
      const summary = (p?.summary ?? "").trim();
      if (!summary || /^(Finished without a report\.|Its turn ended without a word|Closed \((completed|cancelled)\) by )/.test(summary)) return null;
      // Spoken to after it had reported, its last words may answer only that: the report comes first.
      return p?.saidBefore ? `${firstLine(p.saidBefore, max)}；之后又说：${firstLine(summary, max)}` : firstLine(summary, max);
    } catch {
      return null;
    }
  }

  /** What the desk told the owner unprompted in the past day, the latest few (projections/desk-words.ts). */
  function deskLastSaid(listed: ReadonlySet<string>): string[] {
    return desk.unpromptedWords(now() - 24 * 3_600_000)
      .filter((w) => !listed.has(w.id))
      .slice(-3)
      .map((w) => `- ${desk.localTime(w.at)} [${w.id}] ${oneLine(w.text, NOTICE_CHARS)}`);
  }

  /** The last thing a cell sent to the owner (send_message to their workbench address), from its recent record. */
  function lastToOwner(cellId: string): { id: string; text: string; at: number } | null {
    const t = desk.timeline(cellId, { limit: 30 });
    for (let i = t.items.length - 1; i >= 0; i--) {
      const it = t.items[i]!;
      if (it.kind === "assistant_reply" && it.toOwner) return { id: it.id, text: it.text, at: it.at };
    }
    return null;
  }

  /** Audit E27/R06: live hubs with their last message to the owner and their workers' latest results: a hub keeps no status line. */
  function hubLines(): { lines: string[]; data: unknown[] } {
    const hubs = kernel.listCells().filter((c) => c.status !== "closed" && roleOf(c) === "hub");
    const data = hubs.map((c) => {
      const workers = kernel.listCells({ parentId: c.id }).filter((w) => w.status !== "closed" && isLeafCell(w)).map((w) => {
        return { cellId: w.id, title: w.title, state: cellStateText(w), latestResult: latestResultOf(w, 220), statusLine: statusLineOf(w.id) };
      });
      const topics = [...new Set((c.spec.watches ?? []).flatMap((w) => (typeof w.threadOrFilter["thread"] === "string" ? [w.threadOrFilter["thread"] as string] : [])))];
      return { cellId: c.id, title: c.title, state: cellStateText(c), statusLine: statusLineOf(c.id), topics, lastToOwner: lastToOwner(c.id), workers };
    });
    const lines = data.map((h) => {
      const own = `- ${h.cellId}${h.title ? `「${h.title}」` : ""}（${h.state}${h.topics.length ? `；收 ${h.topics.join("、")}` : ""}）${h.statusLine ? ` — ${oneLine(h.statusLine, 160)}` : ""}`;
      const said = h.lastToOwner ? `\n  ↳ 最近对主人说（${isoMin(h.lastToOwner.at)}，${h.lastToOwner.id}）：${oneLine(h.lastToOwner.text, NOTICE_CHARS)}` : "";
      const below = h.workers.map((w) => {
        const gist = w.latestResult ? `最近结果：${w.latestResult}` : w.statusLine ? `状态：${oneLine(w.statusLine, 160)}` : "还没有结果";
        return `\n  - ${w.cellId}${w.title ? `「${w.title}」` : ""}（${w.state}）— ${gist}`;
      });
      return `${own}${said}${below.join("")}`;
    });
    return { lines, data };
  }

  /** What these cells told the owner lately (their workbench notices), oldest first. */
  function noticesOf(cellIds: readonly string[], limit: number, since = 0): Array<{ cellId: string; at: number; text: string }> {
    return kernel.hub.listNotificationsSync(limit, { cellIds, since }).reverse().map((n) => ({ cellId: n.cellId, at: n.createdAt, text: n.content.body }));
  }

  /** Reminders set for the owner that have not come due yet (they become items in 待我处理 when they fire). */
  function upcomingReminders(): { lines: string[]; data: Array<{ id: string; text: string; remindAt: number }> } {
    const data = kernel.inbox
      .listMessagesSync({ cellId: deskId, type: PAYLOAD.timerFired, status: ["pending"] })
      .filter((m) => m.deliverAt > now())
      .flatMap((m) => {
        const g = ((m.envelope.payload as { data?: { gtd?: { kind?: string; id?: string; text?: string } } } | null)?.data ?? {}).gtd;
        return g?.kind === "reminder" && g.id && g.text ? [{ id: g.id, text: g.text, remindAt: m.deliverAt }] : [];
      })
      .sort((a, b) => a.remindAt - b.remindAt);
    return { lines: data.map((r) => `- ${isoMin(r.remindAt)} ${r.text}`), data };
  }

  /**
   * Audit E27: the workers the desk itself started (a shared fix, a one-off look) — not under any project, so nothing
   * else shows them: state, the first line of their latest result or status, and what the desk has not taken in yet.
   */
  function deskLeafLines(): { lines: string[]; data: unknown[] } {
    const leaves = kernel.listCells({ parentId: deskId }).filter((c) => c.status !== "closed" && isLeafCell(c) && roleOf(c) !== "sensor");
    const data = leaves.map((c) => {
      return { cellId: c.id, title: c.title, preset: c.preset, state: cellStateText(c), latestResult: latestResultOf(c, 200), statusLine: statusLineOf(c.id), unpulled: unpulledOf(kernel, c).count };
    });
    const lines = data.map((w) => {
      const gist = w.latestResult ? `最近结果：${w.latestResult}` : w.statusLine ? `状态：${oneLine(w.statusLine, 160)}` : "";
      return `- ${w.cellId}${w.title ? `「${w.title}」` : ""}（${w.preset ?? "cell"}，${w.state}）${gist ? ` — ${gist}` : ""}${w.unpulled ? `；主台还没看过的新记录 ${w.unpulled} 条` : ""}`;
    });
    return { lines, data };
  }

  // ---------- commands, documents and settings as text ----------

  interface JobLine {
    jobId: string;
    command: string;
    startedAt: number;
    tail: string | null;
    cellId?: string;
  }

  /** Background commands running right now in any of these cells. */
  function jobsOf(cellIds: readonly string[]): JobLine[] {
    const ids = new Set(cellIds);
    return kernel.workspace
      .listJobsSync({ state: ["running"] })
      .filter((j) => ids.has(j.cellId))
      .map((j) => {
        let tail: string | null = null;
        try {
          tail = kernel.workspace.observeJobSync(j.jobId)?.tail.slice(-2_000) || null;
        } catch {
          // the log is not readable (yet); the command itself is still worth showing
        }
        return { jobId: j.jobId, cellId: j.cellId, command: j.command, startedAt: j.startedAt, tail };
      });
  }

  function jobLine(j: JobLine, withCell: boolean): string {
    const tail = j.tail?.trim().split("\n").slice(-5).map((l) => `\n    ${l}`).join("") ?? "";
    return `- ${j.jobId}${withCell && j.cellId ? `（${j.cellId}）` : ""} 自 ${isoMin(j.startedAt)}：${oneLine(j.command, 200)}${tail}`;
  }

  const parkedData = (parked: ArtifactDTO["parked"]) => parked.map(({ dismiss: _, ...p }) => p);

  /** A plan's stages, directory and steps in one line (what the owner approves with it). */
  function planFacts(p: ProjectProposal): string {
    return [
      `「${p.title}」`,
      p.phases?.length ? `阶段：${p.phases.map((x, i) => `${i + 1}. ${x}`).join(" → ")}` : "不分阶段",
      `目录：${p.cwd ?? "—"}`,
      ...(p.repos?.length ? [`仓库：${p.repos.map((r) => `${r.name} ${r.cwd}`).join("、")}`] : []),
      `${p.actions.length} 个步骤`,
    ].join("；");
  }

  const PARKED_INLINE = 2_000;
  function parkedSection(artifactId: string, parked: ArtifactDTO["parked"]): string[] {
    if (parked.length === 0) return [];
    const lines = parked.map((p) => {
      const cut = p.body.length > PARKED_INLINE ? `…（共 ${p.body.length} 字符；全文：read_artifact { id: "${artifactId}", parkedId: "${p.id}" }）` : "";
      return `- ${p.id}（基于 v${p.basedOnVersion}，${isoMin(p.createdAt)}${p.title ? `，「${p.title}」` : ""}${p.note ? `，${oneLine(p.note, 160)}` : ""}）\n${p.body.slice(0, PARKED_INLINE).split("\n").map((l) => `    ${l}`).join("\n")}${cut}`;
    });
    return [`${section("后台基于旧版本写的、还没合并的内容（合并后 dismiss_parked）", lines)}`];
  }

  function artifactData(a: ArtifactDTO): Record<string, unknown> {
    return { id: a.artifactId, version: a.version, title: a.title ?? null, format: a.format, updatedBy: a.updatedBy, updatedAt: a.updatedAt, versions: a.versions, parked: parkedData(a.parked), decisions: a.decisions };
  }

  /** A version conflict: nothing was written, and here is what to merge into. */
  function conflictOf(what: string, a: ArtifactDTO, outcome: string): AgentToolResult {
    const page = a.body.slice(0, MAX_RESOURCE_PAGE_CHARS);
    const rest = page.length < a.body.length ? `\n（后面还有：read_artifact { id: "${a.artifactId}", offset: ${page.length} }）` : "";
    return fail(
      [
        `${what}; nothing was written. It is now v${a.version}（${a.updatedBy} 更新于 ${isoMin(a.updatedAt)}）. Merge your change into the current text below and save again with expectedVersion ${a.version}.`,
        ...parkedSection(a.artifactId, a.parked),
        "---",
        page + rest,
      ].join("\n"),
      { outcome, ...artifactData(a), body: a.body },
    );
  }

  /** A suggestion is stored under a slug that need not be the playbook's own name; the agent may give either. */
  function skillSlug(name: string): string {
    const all = context.listStateSync(deskId, SKILL_SUGGESTION_PREFIX).map((e) => ({ slug: e.key.slice(SKILL_SUGGESTION_PREFIX.length), name: (e.value as Partial<SkillSuggestion> | null)?.name }));
    return (all.find((s) => s.slug === name) ?? all.find((s) => s.name === name))?.slug ?? name;
  }

  const choiceText = (c: ModelChoiceDTO | null | undefined) => (c ? `${c.model}${c.effort ? ` · ${c.effort}` : ""}` : "CLI 自己的默认");
  const selectionText = (s: ModelSelectionDTO) => (s.mode === "auto" ? "auto" : `fixed ${s.model}${s.effort ? ` · ${s.effort}` : ""}`);

  function modelsText(m: ModelsDTO): string {
    if (!m.available) return "当前不是由 CLI Agent 驱动，没有可切换的模型。";
    const catalogs = Object.values(m.catalogs).filter((c) => c !== undefined);
    return [
      `默认 runner：${m.engine ?? "—"}；已启用：${m.runners.join("、")}`,
      ...catalogs.map((c) =>
        [
          `${c.engine}${c.engine === m.engine ? "（默认）" : ""} — 列表更新于 ${isoMin(c.fetchedAt)}${c.error ? `；⚠ 上次读取失败：${oneLine(c.error, 200)}` : ""}`,
          `  strong：${selectionText(c.selection.strong)} → ${choiceText(c.effective.strong)}；fast：${selectionText(c.selection.fast)} → ${choiceText(c.effective.fast)}`,
          ...c.models.map((x) => `  - ${x.id}「${x.label}」推理强度：${x.efforts.join("、") || "无"}${x.description ? ` — ${oneLine(x.description, 120)}` : ""}`),
        ].join("\n"),
      ),
      section(
        "各层级",
        Object.entries(m.roles).map(([role, sel]) => {
          const eff = m.effectiveRoles[role as keyof ModelsDTO["effectiveRoles"]];
          return `- ${role}：${sel.mode === "inherit" ? "inherit" : `custom ${[sel.runner, sel.model, sel.effort].filter(Boolean).join(" · ")}`} → ${eff ? `${eff.runner} · ${choiceText(eff.choice)}` : "—"}`;
        }),
      ),
    ].join("\n\n");
  }

  /** configure_models' flat arguments as the settings request, or what is missing. */
  function modelsRequest(args: Args): UpdateModelsRequest | string {
    const runner = args["runner"] as RunnerDTO;
    const model = str(args["model"]);
    const effort = str(args["effort"]);
    const mode = args["mode"];
    switch (args["target"]) {
      case "runner":
        return args["runner"] === undefined ? "target runner needs runner: the new default." : { runner };
      case "tier": {
        const tier = args["tier"] as "strong" | "fast" | undefined;
        const engine = args["engine"] as RunnerDTO | undefined;
        if (!tier) return 'target tier needs tier: "strong" or "fast".';
        if (mode === "auto") return model || effort ? "mode auto takes no model or effort; use fixed to pin them." : { tier, mode, ...(engine ? { engine } : {}) };
        if (mode !== "fixed") return 'target tier needs mode: "auto" or "fixed".';
        return model ? { tier, mode, model, ...(effort ? { effort } : {}), ...(engine ? { engine } : {}) } : "mode fixed needs model: an id from get_models.";
      }
      default: {
        const role = args["role"] as CellRoleDTO | undefined;
        if (!role) return "target role needs role.";
        if (mode === "inherit") return args["runner"] !== undefined || model || effort ? "mode inherit takes no runner, model or effort; use custom to pin them." : { role, mode };
        if (mode !== "custom") return 'target role needs mode: "inherit" or "custom".';
        return args["runner"] === undefined ? "mode custom needs runner." : { role, mode, runner, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
      }
    }
  }

  // ---------- refusals turned into plain answers ----------

  function sendFailure(id: string, r: Exclude<SendToCellResult, { status: "delivered" }>, isProject: boolean): AgentToolResult {
    switch (r.status) {
      case "closed": {
        if (!isProject) {
          return fail(
            `Not delivered: cell ${id} has already closed${r.closeReason ? ` (${r.closeReason})` : ""} — finished cells take no messages. If the work still needs doing, start a new cell (create_project, or spawn_cell with the context it needs); get_cell ${id} shows what it did.`,
            { status: "closed", closeReason: r.closeReason },
          );
        }
        const reports = subtreeIds(id).flatMap((cid) => context.listArtifactsSync(cid));
        const named = reports.length ? ` Its reports: ${reports.map((a) => `${a.artifactId} v${a.version}${a.content.title ? `「${a.content.title}」` : ""}`).join(", ")}.` : "";
        return fail(
          `Not delivered: project ${id} has already finished${r.closeReason ? ` (${r.closeReason})` : ""}. Use reopen_project to continue this project with its existing record.${named}`,
          { status: "closed", closeReason: r.closeReason, artifacts: reports.map((a) => a.artifactId) },
        );
      }
      case "not_found":
        return fail(`Not delivered: there is no ${isProject ? "project" : "cell"} "${id}". Check the id with workbench_overview or search.`, { status: "not_found" });
      case "refused":
        return fail(`Not delivered: ${r.reason}.`, { status: "refused", reason: r.reason });
    }
  }

  function deliveredText(id: string, r: Extract<SendToCellResult, { status: "delivered" }>, isProject: boolean, withNote = false): string {
    const what = withNote ? "the owner's words, with your note marked as yours" : "the owner's words";
    if (r.targetStatus === "paused") {
      return isProject && kernel.getCell(id)?.pauseReason === "parked"
        ? `Delivered ${what} to ${id}, which is parked ("someday"): it reads them when it is activated. Activating it is the owner's call.`
        : `Delivered ${what} to ${id}, but it is paused: it reads them when it is resumed (set_project_state / control_cell resume).`;
    }
    return `Delivered ${what} to ${id} (message ${r.envelopeId}): so far only passed on; it reads them at its next turn. Results arrive asynchronously — ${isProject ? "get_project" : "get_cell"}.${isProject ? lastNoticeLine(id) : ""}`;
  }

  /**
   * What a cell said in the turn that took a person's words (`messageId`, or their latest): its last words there, and
   * the notices it sent the owner in that turn — a notice, when there is one, is the answer.
   */
  function answerOf(cellId: string, messageId?: string): { said: { at: number; text: string } | null; notices: string[]; did: string[] } {
    const items = desk.timeline(cellId, { limit: 60 }).items;
    let from = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === "user_chat" && (!messageId || it.id === messageId)) {
        from = i;
        break;
      }
    }
    let said: { at: number; text: string } | null = null;
    const notices: string[] = [];
    const did: string[] = [];
    if (from < 0) return { said, notices, did };
    for (const it of items.slice(from + 1)) {
      if (it.kind === "assistant_reply") {
        if (it.toOwner) notices.push(it.text);
        else said = { at: it.at, text: it.text };
      } else if (it.kind === "tool_group") {
        if (it.summary.trim()) did.push(oneLine(it.summary, 200));
      } else if (it.kind !== "artifact_event") break;
    }
    return { said, notices, did };
  }

  /** Where a project stood when it last told the owner. */
  function lastNoticeLine(projectId: string): string {
    const [last] = noticesOf(subtreeIds(projectId), 1);
    return last ? `\n它上一次发给主人的通知（${desk.localTime(last.at)}，在这之前）：${oneLine(last.text, NOTICE_CHARS)}` : "";
  }

  /** How a question from the workbench is put to the agent: it is the owner's to answer (audit E02). */
  function questionNote(questionId: string, tool: "chat_with_desk" | "message_cell"): string {
    return `a question for the owner — put it to them, and send their answer back with ${tool} and replyToId ${questionId}; do not answer it yourself.`;
  }

  /**
   * chat_with_desk's waitSeconds: resolves once the desk has taken the message in and its turn is over (so the answer
   * is its whole reply, not a "let me look" on the way), or when the time is up. Event-driven on the kernel's bus.
   */
  const deskSettles = (messageId: string, ms: number) => cellSettles(deskId, messageId, ms);

  /** Resolves when `cellId` has dealt with message `messageId` and has no turn in flight, or after `ms`. */
  function cellSettles(cellId: string, messageId: string, ms: number): Promise<"settled" | "timeout"> {
    const settled = () => {
      if (kernel.activeRuns().some((r) => r.cellId === cellId)) return false;
      const [m] = kernel.inbox.listMessagesSync({ cellId, envelopeId: messageId, limit: 1 });
      return !m || (m.status !== "pending" && m.status !== "claimed");
    };
    return new Promise((resolve) => {
      let over = false;
      const finish = (r: "settled" | "timeout") => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        off();
        resolve(r);
      };
      // After the run's own bookkeeping (the claim is settled in the same tick that announces the end).
      const off = kernel.bus.on("run.finished", (e) => {
        if (e.cellId === cellId) setTimeout(() => settled() && finish("settled"), 0);
      });
      const timer = setTimeout(() => finish("timeout"), ms);
      if (settled()) finish("settled");
    });
  }

  // ==================== tools ====================

  const handlers: Record<string, Handler> = {
    workbench_overview(args, _principalId, call) {
      const all = desk.listHumanItems(true);
      const items = all.filter((item) => item.snoozedUntil == null || item.snoozedUntil <= now());
      const actions = items.filter((item) => item.category === "action");
      const cards = items.filter((item) => item.category === "decision");
      const radar = desk.radar();
      const running = runningLines();
      const ws = workspaceLines();
      const questions = openQuestions();
      const deskSaid = deskLastSaid(new Set(questions.data.map((q) => q.id)));
      const hubs = hubLines();
      const leaves = deskLeafLines();
      const reminders = upcomingReminders();
      const { today, backend, model } = desk.status();
      // Who parked it, when and in what words: whoever is about to bring a parked project back reads this first.
      const parkedLine = (p: ProjectRowDTO) => {
        const info = desk.pauseInfo(p.id);
        return `- ${p.id}「${p.title}」— 以后再说${info ? `（${info.text}）` : ""}${p.summary ? `；摘要：${oneLine(p.summary, 120)}` : ""}${p.cwd ? `；目录 ${p.cwd}` : ""}`;
      };
      const parts = [
        ...(call.baseUrl ? [`工作台地址：${call.baseUrl}`] : []),
        section("待我处理", [...items.map(cardLine), ...questions.lines]),
        ...(deskSaid.length ? [section("主台最近对主人说的", deskSaid)] : []),
        ...(reminders.lines.length ? [section("已设好、还没到点的提醒", reminders.lines)] : []),
        section("进行中的项目", radar.projects.map(projectLine)),
        section("已停靠（重新启动前先问主人，除非主人此后明确说了现在开始）", radar.someday.map(parkedLine)),
        ...(hubs.lines.length ? [section("领域中枢", hubs.lines)] : []),
        ...(leaves.lines.length ? [section("主台直接派出的分身", leaves.lines)] : []),
        section("正在运行", running.lines),
        section("工作目录占用", ws.lines),
        `今日（自 ${isoMin(today.since)}）：静默归档通知 ${today.archivedNotifications}，存笔记 ${today.notesSaved}，设提醒 ${today.remindersSet}，撤卡 ${today.cardsWithdrawn}（list_activity 看明细）`,
        `执行后端：${backend}${model ? ` · ${model}` : ""}`,
      ];
      // What closed in the past day, with its closing notice: "is anything left for me?" is asked right after an
      // acceptance, when the project is gone from the lists above — and where its work landed is in that notice.
      const justClosed = readProjects(kernel)
        .filter((p) => (p.record.lifecycle === "completed" || p.record.lifecycle === "cancelled") && (p.record.completedAt ?? p.record.updatedAt) >= now() - 24 * 3_600_000)
        .sort((a, b) => (b.record.completedAt ?? b.record.updatedAt) - (a.record.completedAt ?? a.record.updatedAt))
        .slice(0, 6);
      if (justClosed.length) {
        parts.push(
          section(
            "24 小时内结束的项目（附它发过的最后一条通知；主人自己结束的项目，那条可能早于结束，里面的请求未必还成立）",
            justClosed.map((p) => {
              const [last] = noticesOf(subtreeIds(p.cellId), 1);
              return `- ${p.cellId}「${p.record.title}」— ${p.record.lifecycle === "completed" ? "已完成" : "已取消"} ${desk.localTime(p.record.completedAt ?? p.record.updatedAt)}${last ? `\n  ↳ 最后一条通知（${desk.localTime(last.at)}）：${oneLine(last.text, NOTICE_CHARS)}` : p.record.summary ? `\n  ↳ ${oneLine(p.record.summary, 300)}` : ""}`;
            }),
          ),
        );
      }
      let finished: unknown[] | undefined;
      if (args["includeFinished"] === true) {
        // (Those closed in the past day are in the section above, with their closing notices: not listed twice.)
        const shown = new Set(justClosed.map((p) => p.cellId));
        const recent = readProjects(kernel)
          .filter((p) => (p.record.lifecycle === "completed" || p.record.lifecycle === "cancelled") && !shown.has(p.cellId))
          .sort((a, b) => (b.record.completedAt ?? b.record.updatedAt) - (a.record.completedAt ?? a.record.updatedAt))
          .slice(0, 30);
        parts.push(
          section(
            "最近结束的项目",
            recent.map((p) => `- ${p.cellId}「${p.record.title}」— ${p.record.lifecycle === "completed" ? "已完成" : "已取消"} ${isoMin(p.record.completedAt ?? p.record.updatedAt)}${p.record.summary ? `；${oneLine(p.record.summary, 120)}` : ""}`),
          ),
        );
        finished = recent.map((p) => ({ id: p.cellId, title: p.record.title, lifecycle: p.record.lifecycle, at: p.record.completedAt ?? p.record.updatedAt, summary: p.record.summary ?? null }));
      }
      const snoozed = all.length - items.length;
      if (snoozed > 0) parts.push(`另有 ${snoozed} 项已推迟，到点会回到「待我处理」。`);
      return ok(`工作台概览（主人的本地时间 ${desk.localTime(now())}，即 ${isoMin(now())}）\n\n${parts.join("\n\n")}`, {
        generatedAt: now(),
        humanActions: actions.map((item) => ({ ...item, nextStep: item.description, projectId: item.project?.id ?? null, overdue: item.dueAt != null && item.dueAt < now() })),
        cards,
        questions: questions.data,
        projects: radar.projects.map(projectData),
        parked: radar.someday.map((p) => ({ ...projectData(p), parkedBy: desk.pauseInfo(p.id) })),
        upcomingReminders: reminders.data,
        ...(call.baseUrl ? { baseUrl: call.baseUrl } : {}),
        hubs: hubs.data,
        deskWorkers: leaves.data,
        running: running.data,
        workspaces: ws.data,
        snoozedCards: snoozed,
        today,
        backend,
        model: model ?? null,
        ...(finished ? { finished } : {}),
      });
    },

    async capture(args,principalId) {
      const clientId=str(args["clientId"]);
      const receipt=await desk.ingest({
        text:str(args["text"]) ?? "",
        ...(args.threads !== undefined && {threads: args.threads as string[]}),
        ...(args.attachments !== undefined && {attachments: args.attachments as NonNullable<CaptureRequest["attachments"]>}),
        ...(args.voice === true && {voice: true}),
        ...(clientId ? {clientId} : {}),
      },{principalId});
      return ok(`Captured message ${receipt.id}. The workbench routes it to the matching subscriber or the desk.`,{envelopeId:receipt.id});
    },

    async chat_with_desk(args, principalId, call) {
      const text = str(args["text"]);
      const note = str(args["context"]);
      const since = typeof args["since"] === "number" ? Math.max(0, Math.floor(args["since"])) : undefined;
      if (note && !text) return fail("context goes with text: it is your note on the owner's words, sent together with them.");
      if (!text && since === undefined) return fail("Give text (only the owner's words for the desk), or since (to read the desk's replies after that cursor).");
      const conversationId = str(args["conversationId"]) ?? call.conversationId ?? principalId;
      const replyToId = str(args["replyToId"]);
      const waitSeconds = text && typeof args["waitSeconds"] === "number" ? Math.max(0, Math.min(MAX_WAIT_SECONDS, args["waitSeconds"])) : 0;
      const from = since ?? context.lastEvidenceSeqSync(deskId);
      let sent: Delivery | null = null;
      const sentAt = now();
      if (text) {
        sent = desk.directMessage(
          deskId,
          { text, clientId: newId("agchat", clock), conversationId, ...(replyToId ? { replyToId } : {}), ...(note ? { agentContext: note } : {}) },
          { principalId },
        );
        if (!sent.ok) return fail(`Not passed on: ${sent.message}`, { outcome: sent.outcome });
      }
      const waited = sent?.id && waitSeconds > 0 ? await deskSettles(sent.id, waitSeconds * 1_000) : null;
      const t = desk.timeline(deskId, { afterSeq: from, limit: 50 });
      const replies = t.items.filter((i): i is Extract<TimelineItemDTO, { kind: "assistant_reply" }> => i.kind === "assistant_reply");
      const cursor = Math.max(from, t.lastSeq);
      // A reply is a question by its wording, or because it is what the desk now waits for the owner on (R06).
      const waitingOn = desk.questions().find((q) => q.cellId === deskId)?.id;
      const asks = (r: (typeof replies)[number]) => r.question || r.id === waitingOn;
      const stillWorking = waited === "timeout" || (waited === null && kernel.activeRuns().some((r) => r.cellId === deskId));
      const lines = replies.map((r) => `- [${r.id}] ${r.text}${asks(r) ? `\n  ↳ ${questionNote(r.id, "chat_with_desk")}` : ""}`);
      // What the desk did in words elsewhere: notices its tools sent the owner, and cards it put before them (raising one
      // ends its turn without a word). Without them "no written reply" reads as if nothing had come back.
      const notices = sent ? noticesOf([deskId], 5, sentAt) : [];
      const cards = desk.listHumanItems(sent !== null).filter((i) => i.cellId === deskId && (sent ? i.createdAt >= sentAt : i.category === "decision" && !stillWorking));
      const later = `chat_with_desk { since: ${cursor} }`;
      const state = stillWorking
        ? `The desk is still working on it${waited === "timeout" ? ` (no final answer within ${waitSeconds} s)` : ""}. Its answer may hold a question or a card: read it (${later}) before you decide or pass on anything about this request.`
        : !sent && !replies.length
          ? `Nothing new from the desk after #${from}${waitingOn ? `: it is waiting for the owner's answer to its question ${waitingOn}` : ""}.`
          : sent && waited === null && !replies.length
            ? `It answers in the background: ${later}, or pass waitSeconds next time.`
            : sent && !replies.length
              ? `The desk has taken it in${notices.length || cards.length ? "" : " without a written reply"}.`
              : `Later replies: ${later}.`;
      const parts = [
        replies.length ? `${stillWorking ? `What the desk has said on the way after #${from} (not its answer)` : `The desk's replies after #${from}`}:\n${lines.join("\n")}` : "",
        notices.length ? `Notices the desk sent the owner since${replies.length ? ` (a reply above, such as "我会安排…", may be older than these)` : ""}:\n${notices.map((n) => `- ${oneLine(n.text, NOTICE_CHARS)}`).join("\n")}` : "",
        cards.length ? `Cards of the desk waiting for the owner${sent ? ", raised since" : ""} (list_human_items has the options):\n${cards.map((i) => `- ${i.id}「${oneLine(i.title, 80)}」${i.proposal ? "（立项方案）" : ""}`).join("\n")}` : "",
      ].filter(Boolean);
      const head = sent
        ? `Passed to the desk (message ${sent.id}, conversation ${conversationId}${replyToId ? `, answering ${replyToId}` : ""}) ${note ? "as the owner's words, with your note marked as yours" : "as the owner's words"}. `
        : "";
      return ok([`${head}${state}`, ...parts].join("\n"), {
        ...(sent ? { messageId: sent.id } : {}),
        conversationId,
        cursor,
        ...(waited ? { waited } : {}),
        stillWorking,
        replies: replies.map((r) => ({ id: r.id, text: r.text, question: asks(r), forOwner: asks(r), toOwner: r.toOwner, at: r.at })),
      });
    },

    message_cell(args, principalId, call) {
      const id = str(args["id"])!;
      const mode = (str(args["mode"]) ?? "enqueue") as "enqueue" | "steer";
      const notifyParent = str(args["notifyParent"]) as "silent" | "wakeup" | undefined;
      const replyToId = str(args["replyToId"]);
      const note = str(args["context"]);
      const req: PersonMessage = {
        text: str(args["text"])!,
        clientId: newId("agmsg", clock),
        mode,
        ...(notifyParent ? { notifyParent } : {}),
        ...(replyToId ? { replyToId } : {}),
        ...(note ? { agentContext: note } : {}),
        conversationId: str(args["conversationId"]) ?? call.conversationId ?? principalId,
      };
      return deliveredToCell(id, desk.directMessage(id, req, { principalId }), mode, notifyParent, Boolean(note));
    },

    inspect_cell(args) {
      const id = str(args["id"])!;
      const afterSeq = typeof args["afterSeq"] === "number" ? Math.max(0, Math.floor(args["afterSeq"])) : 0;
      const detail = str(args["detail"]) === "full" ? "full" : "summary";
      const r = kernel.inspectCell(id, { afterSeq, detail });
      const nextAfterSeq = r.resumeAfterSeq ?? r.toSeq;
      const more = r.more ? `\n(More follows: inspect_cell ${id} with afterSeq ${nextAfterSeq}.)` : "";
      return ok(`${r.text}${more}`, {
        cellId: r.cellId,
        title: r.title,
        state: r.state,
        fromSeq: r.fromSeq,
        toSeq: r.toSeq,
        more: r.more,
        ...(r.resumeAfterSeq !== undefined ? { resumeAfterSeq: r.resumeAfterSeq } : {}),
        directChats: r.directChats,
        artifactIds: r.artifactIds,
      });
    },

    read_resource(args) {
      const uri = str(args["uri"])!;
      const offset = typeof args["offset"] === "number" ? Math.max(0, Math.floor(args["offset"])) : 0;
      const limit = typeof args["limit"] === "number" ? Math.max(1, Math.min(MAX_RESOURCE_PAGE_CHARS, Math.floor(args["limit"]))) : DEFAULT_RESOURCE_PAGE_CHARS;
      const page = desk.resource(uri, offset, limit, str(args["cellId"]));
      const end = offset + page.content.length;
      const where = `${uri}${args["cellId"] ? ` of ${str(args["cellId"])}` : ""} — characters ${offset}–${end} of ${page.totalChars}${page.hasMore ? `; the rest: read_resource { uri, ${args["cellId"] ? "cellId, " : ""}offset: ${end} }` : " (to the end)"}`;
      return ok(`${where}\n---\n${page.content}`, page);
    },

    async create_project(args, principalId) {
      const mode = (str(args["mode"]) ?? "now") as ProjectMode;
      const phases = Array.isArray(args["phases"]) ? (args["phases"] as string[]).map((p) => p.trim()).filter(Boolean) : [];
      const cwd = str(args["cwd"]);
      const init: ProjectInit = {
        title: str(args["title"])!,
        outcome: str(args["outcome"])!,
        brief: str(args["brief"])!,
        briefBy: "agent",
        ...(str(args["context"]) ? { agentContext: str(args["context"])! } : {}),
        mode,
        source: { label: "编码助手", principalId, at: now() },
        ...(cwd ? { cwd } : {}),
        ...(phases.length ? { phases } : {}),
        runnerOverride: await childRunnerOverride(kernel, runnerSelection(args), { role: "project", tier: "strong" }),
      };
      let r: { projectId: string; started: boolean };
      try {
        r = desk.createProject(init,{principalId});
      } catch (err) {
        if (isNgError(err, "invalid_argument") && /\bcwd\b|directory|path/i.test(err.message)) {
          return fail(
            `Not started: ${err.message} Then call create_project again with the absolute path of the directory or repository on this machine.`,
          );
        }
        throw err;
      }
      const next =
        mode === "research_then_park"
          ? "It researches what the idea should look like, saves a report and then parks itself as someday (nothing else runs)."
          : `Its coordinator is planning now and hands the work to background workers${cwd ? ` in ${cwd}` : ""}${phases.length ? `, one phase at a time (it asks the owner before each next phase)` : ""}.`;
      return ok(`Started project ${r.projectId}「${init.title}」. ${next} Results arrive over the next minutes; look with get_project ${r.projectId} when the owner asks.`, {
        projectId: r.projectId,
        started: r.started,
      });
    },

    get_project(args) {
      const id = str(args["id"])!;
      const record = projectRecordOf(id);
      if (!record) return noProject(id);
      const cell = kernel.getCell(id);
      const radar = desk.radar();
      const row = [...radar.projects, ...radar.someday].find((p) => p.id === id) ?? null;
      const actions = projectActionsOf(id).sort((a, b) => Number(b.record.status === "open") - Number(a.record.status === "open") || b.record.updatedAt - a.record.updatedAt);
      const open = actions.filter((a) => a.record.status === "open");
      const closed = actions.filter((a) => a.record.status !== "open").slice(0, 8);
      const ids = subtreeIds(id);
      // Every cell below it, the archived ones included: what ran for it, what rests and can be woken, what is history.
      const below = ids.filter((cid) => cid !== id).map((cid) => kernel.getCell(cid)!);
      const waits = kernel.listOpenWaits(ids.filter((cid) => kernel.getCell(cid)?.status !== "closed"));
      const running = new Set(kernel.activeRuns().map((r) => r.cellId));
      const artifacts = ids.flatMap((cid) => context.listArtifactsSync(cid)).sort((a, b) => b.updatedAt - a.updatedAt);
      const notes = notesOf(kernel, id);
      const jobs = jobsOf(ids);
      const cards = desk.listHumanItems(true).filter(r => r.category === "decision" &&
        ((r.cellId && ids.includes(r.cellId)) || r.relatedProjectIds.includes(id) || r.subjectKey === `project:${id}`));
      const anchors = cell && cell.status !== "closed" ? kernel.anchorsOf(id) : null;
      const notices = noticesOf(ids, 6);
      // BUG-011.3: a parked project is paused underneath, but it is brought back with activate — never resume.
      const pausedBy = desk.pauseInfo(id);
      const state =
        cell?.pauseReason === "parked"
          ? `以后再说（停靠中，什么都不运行${pausedBy ? `；${pausedBy.text}` : ""}。重新启动前先问主人；启动用 set_project_state activate，不是 resume）`
          : cell?.status === "closed"
            ? `${record.lifecycle}（cell closed: ${cell.closeReason ?? "?"}）`
            : cell?.status === "paused"
              ? `${record.lifecycle}；已暂停（${pausedBy ? `${pausedBy.text}；` : ""}主人说继续时 set_project_state resume）`
              : record.lifecycle;
      const actionLine = (a: Located<ActionRecord>) => {
        const r = a.record;
        const carrier = r.cellId ? `，由 ${r.cellId} 承担` : "";
        return `- ${r.id}「${r.title}」${OWNER_TEXT[r.owner]}，${r.status}${carrier}${r.status === "open" && r.nextStep && r.nextStep !== r.title ? ` — 下一步：${oneLine(r.nextStep, 120)}` : ""}${r.status === "open" && r.dueAt ? `，到期 ${isoMin(r.dueAt)}` : ""}`;
      };
      const runnerInfo = (cell: CellRecord) => {
        if (cell.spec.processor.kind !== "llm") return null;
        const eff = kernel.effectiveRunnerFor?.(cell.spec);
        if (!eff) return cell.spec.processor.engine ?? kernel.agentBackend ?? null;
        const m = eff.choice ? `${eff.choice.model}${eff.choice.effort ? ` · ${eff.choice.effort}` : ""}` : null;
        return m ? `${eff.runner} · ${m}` : eff.runner;
      };
      const cellLines = below.map((c) => {
        const line = statusLineOf(c.id);
        const r = runnerInfo(c);
        return `- ${c.id}${c.title ? `「${c.title}」` : ""}（${c.preset ?? "cell"}，${cellStateText(c)}${r ? `，${r}` : ""}${c.spec.cwd ? `，目录 ${c.spec.cwd}` : ""}）${line && c.status !== "closed" ? ` — ${oneLine(line, 120)}` : ""}`;
      });
      // Proposal 02 §四.2: what its workers did or were told past the project's own cursor, read live — the project
      // may not have woken since, but whoever asks sees it now (the owner's direct words included).
      // What the project said in answer to the owner's latest words without sending it as a notice: an owner who talks
      // through their agent never opens its record. Only while it is the project's latest word, and it is at rest.
      const back = answerOf(id);
      const laterNotice = back.said !== null && notices.some((n) => n.at >= back.said!.at);
      const busyNow = ids.some((cid) => running.has(cid));
      const saidBack = back.said && !back.notices.length && !laterNotice && !busyNow && cell?.status !== "closed" ? [`- ${desk.localTime(back.said.at)} ${oneLine(back.said.text, 500)}`] : [];
      const unpulled = (cell?.status === "closed" ? [] : below)
        .filter((c) => isLeafCell(c) && c.parentId !== null)
        .map((c) => ({ c, ...unpulledOf(kernel, c) }))
        .filter((u) => u.count > 0)
        .map((u) => ({ cellId: u.c.id, count: u.count, text: kernel.inspectCell(u.c.id, { afterSeq: u.cursor, maxChars: 3_000 }).text }));
      const ownWaits = waits.filter((w) => w.cellId === id).map((w) => `${waitPartyText(w.waitingFor)}（${oneLine(w.reason, 80)}）`);
      const head = [
        `项目 ${id}「${record.title}」`,
        `状态：${state}${row?.stalled ? `；⚠ 停滞（自 ${isoMin(row.stalledSince)}）` : ""}`,
        `目标：${record.outcome ?? "—"}`,
        `摘要：${record.summary ?? "—"}`,
        `目录：${cell?.spec.cwd ?? "—"}`,
        `来源：${record.source?.label ?? "—"}；创建 ${isoMin(record.createdAt)}；更新 ${isoMin(record.updatedAt)}`,
        ...(row?.ball ? [`球在：${OWNER_TEXT[row.ball.owner]} · ${oneLine(row.ball.text, 120)}`] : []),
        ...(ownWaits.length ? [`项目本身在等：${ownWaits.join("；")}`] : []),
        ...(anchors?.stalled ? [`为什么停滞：${anchors.detail}`] : []),
      ];
      // Right under the state line, ahead of the summary and the ball it qualifies.
      if (cell?.status === "paused") head.splice(2, 0, "（以下是停下那一刻的情况。）");
      const text = [
        head.join("\n"),
        section("未完成的动作", open.map(actionLine)),
        ...(closed.length ? [section("最近完成/取消的动作", closed.map(actionLine))] : []),
        section("它的分身（运行中 / 等待中 / 待命可唤醒 / 已归档）", cellLines),
        ...(jobs.length ? [section("在途后台命令", jobs.map((j) => jobLine(j, true)))] : []),
        ...(notes ? [`项目白板\n${notes}`] : []),
        ...(unpulled.length ? [section("尚未汇总至项目的 Worker 最新动态", unpulled.map((u) => `- ${u.cellId}：${u.count} 条新记录\n${u.text.split("\n").map((l) => `  ${l}`).join("\n")}`))] : []),
        ...(saidBack.length ? [section("它对主人上一句话的答复（没有发通知，主人没看到）", saidBack)] : []),
        ...(notices.length ? [section("它最近发给主人的通知", notices.map((n) => `- ${desk.localTime(n.at)} ${n.text.replace(/\n+/g, "\n  ")}`))] : []),
        section("报告与草稿", artifacts.map((a) => `- ${a.artifactId} v${a.version}${a.content.title ? `「${a.content.title}」` : ""}（${a.content.format}，${a.updatedBy} 更新于 ${isoMin(a.updatedAt)}）`)),
        section("等你决定", cards.map(cardLine)),
      ].join("\n\n");
      return ok(text, {
        id,
        title: record.title,
        lifecycle: cell?.pauseReason === "parked" ? "someday" : record.lifecycle,
        cellStatus: cell?.status ?? null,
        pausedBy,
        outcome: record.outcome ?? null,
        summary: record.summary ?? null,
        cwd: cell?.spec.cwd ?? null,
        stalled: Boolean(row?.stalled),
        stalledSince: row?.stalledSince ?? null,
        ball: row?.ball ? { owner: row.ball.owner, text: row.ball.text } : null,
        actions: actions.map(({ record, cellId }) => {
          const item = record.owner === "human" ? kernel.humanItems.get(record.id) : undefined;
          return { id: record.id, cellId, title: record.title, owner: record.owner, status: record.status, nextStep: record.nextStep ?? null,
            carriedBy: record.cellId ?? null, ...(item ? { itemRevision: item.itemRevision } : {}) };
        }),
        cells: below.map((c) => ({ id: c.id, title: c.title, preset: c.preset, status: c.status, state: cellStateText(c), running: running.has(c.id), waitingFor: waits.filter((w) => w.cellId === c.id).map((w) => w.waitingFor), statusLine: statusLineOf(c.id) })),
        notes,
        jobs,
        notices,
        unpulled: unpulled.map((u) => ({ cellId: u.cellId, count: u.count })),
        waits: waits.map((w) => ({ cellId: w.cellId, waitingFor: w.waitingFor, reason: w.reason })),
        artifacts: artifacts.map((a) => ({ id: a.artifactId, title: a.content.title ?? null, version: a.version, cellId: a.cellId, updatedAt: a.updatedAt })),
        cards,
      });
    },

    async message_project(args, principalId, call) {
      const id = str(args["id"])!;
      const text = str(args["text"])!;
      const note = str(args["context"]);
      const conversationId = str(args["conversationId"]) ?? call.conversationId ?? principalId;
      const record = projectRecordOf(id);
      if (!record && !kernel.registry.presets.get(kernel.getCell(id)?.preset ?? "")?.projectRoot) return noProject(id);
      const mode=args["urgent"]===true ? "steer" : "enqueue";
      const cell=kernel.getCell(id);
      if (cell?.status==="closed") return sendFailure(id,{status:"closed",closeReason:cell.closeReason},true);
      const r=desk.directMessage(id,{text,mode,clientId:newId("agmsg",clock),conversationId,...(note ? {agentContext:note} : {})},{principalId});
      const waitSeconds = typeof args["waitSeconds"] === "number" ? Math.max(0, Math.min(MAX_WAIT_SECONDS, args["waitSeconds"])) : 0;
      if (r.ok && r.id && (mode==="enqueue" || waitSeconds > 0)) {
        const delivered={status:"delivered" as const,envelopeId:r.id,targetStatus:cell?.status==="paused" ? "paused" as const : "active" as const};
        if (waitSeconds === 0 || delivered.targetStatus === "paused") return ok(deliveredText(id,delivered,true,Boolean(note)),{...delivered,conversationId});
        const waited = await cellSettles(id, r.id, waitSeconds * 1_000);
        const head = `Delivered ${note ? "the owner's words, with your note marked as yours" : "the owner's words"} to ${id} (message ${r.id}).`;
        if (waited === "timeout") return ok(`${head} It is still working on them (no answer within ${waitSeconds} s); get_project has its answer later.${lastNoticeLine(id)}`, { ...delivered, conversationId, stillWorking: true });
        // What it answered in the turn that took the words — said in the turn, or sent as a notice — and what it did: a
        // request it withdrew no longer stands, whatever an earlier notice says.
        const back = answerOf(id, r.id);
        const open = desk.listHumanItems(false).filter((i) => i.project?.id === id);
        const lines = [
          ...back.notices.map((n) => `它这一回合发给主人的通知：${oneLine(n, NOTICE_CHARS)}`),
          ...(back.said && !back.notices.length ? [`它这一回合的答复（没有发通知，主人没看到）：${oneLine(back.said.text, 500)}`] : []),
          ...(back.did.length ? [`它这一回合做了：${back.did.join("；")}`] : []),
          `它现在等主人的事项：${open.length ? open.map((i) => `「${oneLine(i.title, 60)}」`).join("、") : "没有"}`,
        ];
        return ok(`${head} It has taken them in${back.said || back.notices.length ? "" : " without a word for the owner"}.\n${lines.join("\n")}`, { ...delivered, conversationId, stillWorking: false, reply: back.said?.text ?? null });
      }
      return deliveredToCell(id,r,mode,undefined,Boolean(note));
    },

    async set_project_state(args, principalId) {
      const id = str(args["id"])!;
      if (!projectRecordOf(id)) return noProject(id);
      const state = args["state"] as ProjectOp;
      const r = await desk.projectOp(id, state, as(principalId, str(args["note"])));
      if (!r.ok) return fail(`Not applied: ${r.message}`, { outcome: r.outcome });
      if (state !== "pause" && state !== "someday") return ok(r.message, { outcome: r.outcome });
      // Stopping a project does not make what it has put before the owner go away.
      const ids = subtreeIds(id);
      const open = desk.listHumanItems(true).filter((i) => (i.cellId && ids.includes(i.cellId)) || i.relatedProjectIds.includes(id));
      const lines = [
        r.message,
        ...(open.length ? [`它还有 ${open.length} 项在等主人：${open.map((i) => `「${oneLine(i.title, 60)}」`).join("、")}（停着的时候不用办）`] : []),
      ];
      return ok(`${lines.join("\n")}${lastNoticeLine(id)}`, { outcome: r.outcome, workTrees: r.workTrees ?? [], openItems: open.map((i) => i.id) });
    },

    async add_action(args, principalId) {
      const projectId = str(args["projectId"])!;
      if (!projectRecordOf(projectId)) return noProject(projectId);
      const owner = args["owner"] as "human" | "waiting";
      const nextStep = str(args["nextStep"]);
      const effort = args["effort"] as Effort | undefined;
      const r = await desk.addProjectAction(projectId, { title: str(args["title"])!, owner, ...(nextStep ? { nextStep } : {}), ...(effort ? { effort } : {}) }, as(principalId));
      return ok(
        `Recorded action ${r.actionId}「${str(args["title"])}」 on project ${projectId} (${owner === "human" ? "the owner's to-do" : "waiting"}); the project was told. ${owner === "human" ? "When the owner has done it, decide_human_item with the current option and revision." : ""}`.trim(),
        { actionId: r.actionId },
      );
    },

    list_human_items(args) {
      const items = desk.listHumanItems(args["includeSnoozed"] === true);
      // A project confirmation card's plan in one line each (stages included), ahead of the full JSON (audit E17).
      const plans = items.flatMap((i) => {
        if (!i.proposal) return [];
        const marked = planDecisions(i.proposal);
        return [`- ${i.id} 立项方案 v${i.artifactVersion ?? "—"}：${planFacts(i.proposal)}${marked.length ? `；需要主人拍板的段落 ${marked.length} 处：${marked.map((d) => `「${oneLine(d.label, 80)}」`).join("、")}（逐条问过主人再批准；没答的在改方案时留着）` : ""}`];
      });
      return ok(`待处理 ${items.length} 项\n${plans.length ? `${plans.join("\n")}\n` : ""}${JSON.stringify(items, null, 2)}`, {items});
    },
    async decide_human_item(args,principalId) {
      // Whose item it is, read before the decision closes it.
      const decided = desk.listHumanItems(true).find((i) => i.id === str(args.id));
      // (An acceptance or another to-do of the owner's — a decision card says itself what it is about.)
      const ofProject = decided?.category === "action" ? (decided.project?.id ?? null) : null;
      const result = await desk.decideHumanItem(str(args.id)!,{
        optionId:str(args.optionId)!, seenItemRevision:args.seenItemRevision as number,
        ...(typeof args.seenArtifactVersion==="number" ? {seenArtifactVersion:args.seenArtifactVersion} : {}),
        ...(typeof args.until==="number" ? {until:args.until} : {}), ...(typeof args.note==="string" ? {note:args.note} : {}),
        ...(typeof args.resumeProjectId==="string" ? {resumeProjectId:args.resumeProjectId} : {}),
        ...(Array.isArray(args.confirmedClosure) ? {confirmedClosure:args.confirmedClosure as string[]} : {}),
        ...(Array.isArray(args.confirmedTargets) ? {confirmedTargets:args.confirmedTargets as string[]} : {}),
      },as(principalId));
      // Recording an acceptance does not land the work: where the delivery sits is in what the project last told the
      // owner, and "还要我做什么吗" is often asked in the same breath.
      const recent = ofProject ? noticesOf(subtreeIds(ofProject), 3) : [];
      const where = recent.length ? `\n这个项目最近发给主人的通知（在这个决定之前；交付落在哪个分支、由谁合并见其中）：\n${recent.map((n) => `- ${desk.localTime(n.at)} ${oneLine(n.text, NOTICE_CHARS)}`).join("\n")}` : "";
      return ok(`${JSON.stringify(result)}${where}`,result);
    },
    async reopen_project(args,principalId) {
      const text = str(args["text"]);
      const note = str(args["context"]);
      if (note && !text) return fail("context goes with text: it is your note on the owner's words, sent together with them.");
      const id = str(args.projectId)!;
      const result = await desk.reopenProject(id,as(principalId),{ ...(text ? { text } : {}), ...(note ? { agentContext: note } : {}) });
      return ok(
        text
          ? `Reopened ${id}: it wakes with the owner's words${note ? " (your note marked as yours)" : ""} and continues on its previous record; its dormant workers are back too.`
          : `Reopened ${id} without any words from the owner; it is told so. Words for it or for one of its workers go with message_project / message_cell.`,
        result,
      );
    },
    async undo_human_decision(args,principalId) {
      const result = await desk.undoHumanDecision(str(args.activityId)!,as(principalId));
      return ok(result.message,result);
    },

    read_artifact(args) {
      const id = str(args["id"])!;
      const a = context.getArtifactSync(id);
      if (!a) return fail(`There is no artifact "${id}". Artifact ids come from get_project or search.`);
      const wanted = typeof args["version"] === "number" ? Math.floor(args["version"]) : null;
      const ver = wanted !== null && wanted !== a.version ? context.getArtifactVersionSync(id, wanted) : null;
      if (wanted !== null && wanted !== a.version && !ver) return fail(`Artifact ${id} has no version ${wanted}; its current version is v${a.version}.`);
      const { versions, parked } = desk.artifact(id);
      const parkedId = str(args["parkedId"]);
      const aside = parkedId ? parked.find((p) => p.id === parkedId) : undefined;
      if (parkedId && !aside) return fail(`Artifact ${id} has no parked addition "${parkedId}"${parked.length ? `; it has ${parked.map((p) => p.id).join(", ")}` : ""}.`);
      const content = ver?.content ?? a.content;
      const version = ver?.version ?? a.version;
      const body = aside?.body ?? content.body;
      const decisions = ver ? [] : content.format === "markdown" || content.format === "text" ? parseDecisions(content.body) : content.format === "json" ? planDecisions(content.data) : [];
      const offset = typeof args["offset"] === "number" ? Math.max(0, Math.floor(args["offset"])) : 0;
      const limit = typeof args["limit"] === "number" ? Math.max(1, Math.min(MAX_RESOURCE_PAGE_CHARS, Math.floor(args["limit"]))) : 16_000;
      const page = body.slice(offset, offset + limit);
      const end = offset + page.length;
      const hasMore = end < body.length;
      const head = `artifact ${a.artifactId} v${version}${content.title ? `「${content.title}」` : ""} — ${content.format}，${(ver?.updatedBy ?? a.updatedBy)} 更新于 ${isoMin(ver?.createdAt ?? a.updatedAt)}，属于 ${a.cellId}${ver ? `（当前版本是 v${a.version}）` : ""}`;
      const paging = offset > 0 || hasMore ? `\ncharacters ${offset}–${end} of ${body.length}${hasMore ? `; the rest: read_artifact { id: "${id}"${aside ? `, parkedId: "${aside.id}"` : ver ? `, version: ${version}` : ""}, offset: ${end} }` : " (to the end)"}` : "";
      if (aside) {
        return ok(`parked addition ${aside.id} of ${id}（基于 v${aside.basedOnVersion}，文稿现在是 v${a.version}）${paging}\n---\n${page}`, {
          id, parkedId: aside.id, basedOnVersion: aside.basedOnVersion, currentVersion: a.version, body: page, offset, totalChars: body.length, hasMore,
        });
      }
      // What goes with the text is said once, on its first page.
      const extras = offset > 0 ? [] : [
        ...(versions.length > 1 ? [`版本：${versions.slice(-20).map((v) => `v${v.version} ${v.updatedBy} ${isoMin(v.createdAt)}`).join("；")}`] : []),
        ...(decisions.length ? [section("需要主人拍板的段落", decisions.map((x) => `- ${content.format === "json" ? "" : `第 ${x.startLine + 1}–${x.endLine + 1} 行`}「${x.label}」：${oneLine(x.text, 200)}`))] : []),
        ...parkedSection(id, parked),
      ];
      return ok(`${head}${paging}${extras.map((e) => `\n${e}`).join("")}\n---\n${page}`, {
        id: a.artifactId,
        version,
        currentVersion: a.version,
        title: content.title ?? null,
        format: content.format,
        cellId: a.cellId,
        updatedBy: ver?.updatedBy ?? a.updatedBy,
        updatedAt: ver?.createdAt ?? a.updatedAt,
        body: page,
        offset,
        totalChars: body.length,
        hasMore,
        versions,
        decisions,
        parked: parkedData(parked),
      });
    },

    search(args) {
      const query = str(args["query"])!;
      const limit = typeof args["limit"] === "number" ? Math.max(1, Math.min(50, Math.floor(args["limit"]))) : 12;
      const hits = context.searchHistorySync(deskId, query, { scope: "global", limit });
      const projectOfCell = (cellId: string | null) => {
        if (!cellId) return null;
        if (projectRecordOf(cellId)) return cellId;
        const pid = kernel.getCell(cellId)?.spec.meta?.["projectCellId"];
        return typeof pid === "string" ? pid : null;
      };
      const lines = hits.map((h) => {
        const pid = projectOfCell(h.cellId);
        const where = h.cellId ? `${h.cellId}${pid && pid !== h.cellId ? `（项目 ${pid}）` : ""}` : "全局";
        return `- [${h.source}/${h.kind}] ${where} ${isoMin(h.at)}${h.title ? `「${h.title}」` : ""}${h.uri ? ` ${h.uri}` : h.spillUri ? ` ${h.spillUri}` : ""} — ${oneLine(h.text, 220)}`;
      });
      return ok(lines.length ? `${lines.length} hit(s) for "${query}":\n${lines.join("\n")}` : `No hits for "${query}". Try other words (Chinese and English both work; short terms match too).`, {
        hits: hits.map((h) => ({ source: h.source, kind: h.kind, cellId: h.cellId, projectId: projectOfCell(h.cellId), at: h.at, title: h.title ?? null, uri: h.uri ?? h.spillUri ?? null, text: h.text })),
      });
    },

    save_preference(args,principalId) {
      const name = str(args["name"])!;
      const text = str(args["text"])!;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return fail(`name must be a short slug (letters, digits, "-", "_", "."), e.g. "code-change-followup"; got "${name}".`);
      const cwdPrefix = str(args["cwdPrefix"]);
      const roles = Array.isArray(args["roles"]) ? (args["roles"] as string[]).map((r) => r.trim()).filter(Boolean) : [];
      const applies = { ...(cwdPrefix ? { cwdPrefix } : {}), ...(roles.length > 0 ? { roles } : {}) };
      const existed = context.getKnowledgeSync({ kind: "preference", name, scope: "global" }) !== null;
      try {
        desk.savePreference({
          kind: "preference",
          name,
          description: oneLine(text.split("\n")[0], 120),
          body: text,
          scope: "global",
          mode: "upsert",
          ...(cwdPrefix || roles.length > 0 ? { applies } : {}),
        },{principalId});
      } catch (err) {
        if (isNgError(err, "invalid_argument")) return fail(`${err.message}. cwdPrefix is the absolute path of a directory on this machine; roles are names like "worker" or "project".`);
        throw err;
      }
      const stored = context.getKnowledgeSync({ kind: "preference", name, scope: "global" })?.applies;
      if (!stored) return ok(`${existed ? "Replaced" : "Saved"} the global preference "${name}": every background agent sees it from its next turn on.`, { name, replaced: existed });
      const who = [stored.cwdPrefix ? `working in ${stored.cwdPrefix} or below` : "", stored.roles ? `whose role is ${stored.roles.join(" or ")}` : ""].filter(Boolean).join(" and ");
      return ok(`${existed ? "Replaced" : "Saved"} the preference "${name}": only background agents ${who} see it, from their next turn on.`, { name, replaced: existed, applies: stored });
    },

    list_preferences() {
      const prefs = context.listKnowledgeSync({ kind: "preference", includeGlobal: true }).filter((k) => k.scope === "global");
      const skills = context.listKnowledgeSync({ kind: "skill", includeGlobal: true }).filter((k) => k.scope === "global");
      const limitOf = (a: NonNullable<(typeof prefs)[number]["applies"]>) =>
        [a.cwdPrefix ? `仅限目录 ${a.cwdPrefix}` : "", a.roles ? `仅限角色 ${a.roles.join("/")}` : ""].filter(Boolean).join("，");
      const prefLines = prefs.map((k) => `- ${k.name}（${isoMin(k.updatedAt)}${k.applies ? `；${limitOf(k.applies)}` : ""}）: ${k.body.replace(/\s+/g, " ").trim()}`);
      const skillLines = skills.map((k) => `- ${k.name}: ${k.description}`);
      return ok(`${section("主人的长期偏好", prefLines)}\n\n${section("做事手册（skills）", skillLines)}\nTo change a preference, save_preference under the same name (with its cwdPrefix / roles again, if it has them).`, {
        preferences: prefs.map((k) => ({ name: k.name, text: k.body, updatedAt: k.updatedAt, ...(k.applies ? { applies: k.applies } : {}) })),
        skills: skills.map((k) => ({ name: k.name, description: k.description })),
      });
    },

    list_workspaces() {
      const ws = workspaceLines();
      return ok(
        `${section("工作目录占用", ws.lines)}\nNothing is locked: several cells may work in one work tree at the same time. Before you change files yourself in a directory listed here, tell that cell's project (message_project) or pause it, so nobody's work is overwritten.`,
        { workspaces: ws.data },
      );
    },

    get_cell(args) {
      const id = str(args["id"])!;
      const c = kernel.getCell(id);
      if (!c) return fail(`There is no cell "${id}".`);
      const n = typeof args["tail"] === "number" ? Math.max(0, Math.min(100, Math.floor(args["tail"]))) : 12;
      const activity = c.status === "closed" ? null : (kernel.activityOf([id]).get(id) ?? null);
      const chats = context.readStateSync<CellDirectChatState>(id, CELL_DIRECT_CHAT_KEY)?.total ?? 0;
      const waits = kernel.listOpenWaits([id]);
      const running = kernel.activeRuns().some((r) => r.cellId === id);
      const children = kernel.listCells({ parentId: id });
      const cards = desk.listHumanItems(true).filter(r => r.category === "decision" && r.cellId === id);
      const project = projectRecordOf(id);
      const tail = n > 0 ? evidenceTail(id, n) : [];
      const { branch, notes, jobs, pendingQuestion } = desk.timeline(id, { limit: 1 });
      const effRunner = c.spec.processor.kind === "llm" ? (kernel.effectiveRunnerFor?.(c.spec) ?? null) : null;
      const runnerText = c.spec.processor.kind === "code"
        ? "零算力脚本"
        : effRunner
          ? `${effRunner.runner}${effRunner.choice ? ` · ${effRunner.choice.model}${effRunner.choice.effort ? ` · ${effRunner.choice.effort}` : ""}` : ""}`
          : (c.spec.processor.engine ?? kernel.agentBackend ?? "—");
      const head = [
        `cell ${id}${c.title ? `「${c.title}」` : ""} — ${c.preset ?? "cell"}，${cellStateText(c)}（${c.status}${c.closeReason ? `, ${c.closeReason}` : ""}${activity ? `; ${activity.why}` : ""}）`,
        `父节点：${c.parentId ?? "—"}；目录：${c.spec.cwd ?? "（默认）"}${branch ? `（分支 ${branch}）` : ""}；执行：${runnerText}；${isLeafCell(c) ? "叶节点：一轮做完待命，发消息即唤醒" : "常驻"}${chats ? `；主人直接和它说过 ${chats} 次话` : ""}`,
        `状态行：${statusLineOf(id) ?? "—"}`,
        `在等：${waits.length ? waits.map((w) => `${w.waitingFor}（${oneLine(w.reason, 80)}${w.timeoutAt ? `，${isoMin(w.timeoutAt)} 超时` : ""}）`).join("；") : "—"}`,
        ...(project ? [`持有项目记录：${project.lifecycle}「${project.title}」`] : []),
        ...(cards.length ? [`等你决定：${cards.map(cardLine).join(", ")}`] : []),
        ...(pendingQuestion ? [`在问主人（${pendingQuestion.id}）：${oneLine(pendingQuestion.text, 600)}\n  ↳ ${questionNote(pendingQuestion.id, id === deskId ? "chat_with_desk" : "message_cell")}`] : []),
        ...(jobs.length ? [section("在途后台命令", jobs.map((j) => jobLine(j, false)))] : []),
        ...(notes ? [`白板\n${notes}`] : []),
        `子节点：${children.length ? children.map((x) => `${x.id}（${x.preset ?? "cell"}，${x.status}）`).join("、") : "—"}`,
      ];
      return ok(`${head.join("\n")}\n\n${section("最近记录", tail.map((t) => `- ${t.line}`))}`, {
        id,
        title: c.title,
        preset: c.preset,
        status: c.status,
        closeReason: c.closeReason,
        parentId: c.parentId,
        cwd: c.spec.cwd ?? null,
        runner: effRunner?.runner ?? (c.spec.processor.kind === "llm" ? (c.spec.processor.engine ?? kernel.agentBackend ?? null) : null),
        model: effRunner?.choice?.model ?? (c.spec.processor.kind === "llm" ? (c.spec.processor.model ?? null) : null),
        effort: effRunner?.choice?.effort ?? (c.spec.processor.kind === "llm" ? (c.spec.processor.effort ?? null) : null),
        state: activity?.state ?? "closed",
        directChats: chats, cards,
        branch,
        notes,
        jobs,
        pendingQuestion,
        running,
        waits: waits.map((w) => ({ waitingFor: w.waitingFor, reason: w.reason, timeoutAt: w.timeoutAt })),
        children: children.map((x) => ({ id: x.id, preset: x.preset, status: x.status, title: x.title })),
        tail: tail.map((t) => t.data),
      });
    },

    async spawn_cell(args, principalId) {
      const preset = str(args["preset"])!;
      if (preset === kernel.getCell(deskId)?.preset) return fail("主台角色只能用于根工作台");
      const title = str(args["title"])!;
      const instruction = str(args["instruction"])!;
      const cwd = str(args["cwd"]);
      const parentId = str(args["parentId"]) ?? deskId;
      const parent = kernel.getCell(parentId);
      if (!parent) return fail(`There is no cell "${parentId}" to attach it to.`);
      if (parent.status === "closed") return fail(`Cell ${parentId} has closed; attach the new cell elsewhere (default: the desk).`);
      const presetDef = kernel.registry.presets.get(preset);
      const base = presetDef?.defaults.processor;
      const role = cellRoleOf({ preset, meta: presetDef?.defaults.meta });
      const runnerOverride = await childRunnerOverride(kernel, runnerSelection(args), {
        kind: base?.kind,
        role,
        ...(base?.kind === "llm" && base.modelTier ? { tier: base.modelTier } : {}),
      });
      let cellId: string;
      try {
        if (preset === "project") {
          cellId = desk.createProject({ title, outcome: title, brief: instruction, briefBy: "agent", source: { label: "编码助手", principalId, at: now() }, ...(cwd ? { cwd } : {}), runnerOverride }, { principalId },parentId).projectId;
        } else {
          const spec: CellSpecInput = { preset: preset as NonNullable<CellSpecInput["preset"]>, title };
          if (cwd) spec.cwd = cwd;
          if (runnerOverride && base?.kind === "llm") spec.processor = { ...base, ...runnerOverride };
          const addr = desk.spawnCell(parentId, spec, { instruction, title }, { principalId });
          cellId = addr.slice("inbox:".length);
        }
      } catch (err) {
        if (isNgError(err, "invalid_argument") && /\bcwd\b|directory|path/i.test(err.message)) {
          return fail(`Not started: ${err.message}`);
        }
        throw err;
      }
      return ok(
        `Started ${preset} ${cellId}「${title}」 under ${parentId}. It runs in the background${preset === "worker" ? "; when its turn is over it stays dormant — message_cell asks it more, inspect_cell reads what it did" : ""}; look at it with get_cell ${cellId}${preset === "project" ? ` or get_project ${cellId}` : ""}.`,
        { cellId, parentId, preset },
      );
    },

    async control_cell(args, principalId, call) {
      const id = str(args["id"])!;
      const action = args["action"] as "message" | "steer" | "pause" | "resume" | "cancel" | "trigger";
      const text = str(args["text"]);
      const note = str(args["context"]);
      const isProject = projectRecordOf(id) !== null;
      if ((action === "message" || action === "steer") && !text) return fail(`control_cell ${action} needs text: the owner's words for the cell.`);
      if (action === "message" || action === "steer") {
        const mode = action === "steer" ? "steer" : "enqueue";
        const req: PersonMessage = { text: text!, clientId: newId("agmsg", clock), mode, conversationId: call.conversationId ?? principalId, ...(note ? { agentContext: note } : {}) };
        return deliveredToCell(id, desk.directMessage(id, req, { principalId }), mode, undefined, Boolean(note));
      }
      const cell = kernel.getCell(id);
      if (!cell) return sendFailure(id, { status: "not_found" }, isProject);
      if (action === "trigger") {
        const r = desk.cellTrigger(id, as(principalId));
        const data = { applied: r.ok, outcome: r.outcome };
        return r.ok ? ok(`trigger applied to ${id}: its check runs now（${r.message}）. Look with get_cell ${id}.`, data) : fail(`Not applied: ${r.message}`, data);
      }
      if (cell.status === "closed") {
        if (action === "cancel") return ok(`${id} had already closed (${cell.closeReason ?? "?"}); nothing to cancel.`, { applied: false, reason: "closed" });
        return sendFailure(id, { status: "closed", closeReason: cell.closeReason }, isProject);
      }
      // BUG-020: route pause / resume / cancel through DeskService (keeps root guard, project lifecycle & cards in sync).
      // The owner's words that came with a pause are kept with the cell (audit E05).
      const r = await desk.cellControl(id, { action }, as(principalId, action === "pause" ? text : undefined));
      if (!r.ok) return fail(`Not applied: ${r.message}`, { applied: false, outcome: r.outcome });
      const what: Record<"pause" | "resume" | "cancel", string> = {
        pause: "it and everything below it are paused",
        resume: "it continues",
        cancel: "it and everything below it are stopped and closed (files and branches are left as they are)",
      };
      const epoch = kernel.getCell(id)?.epoch;
      return ok(`${action} applied to ${id}: ${what[action]}（${r.message}）.`, { applied: true, outcome: r.outcome, ...(epoch !== undefined ? { epoch } : {}) });
    },

    // ---------- documents and plans ----------

    save_artifact(args, principalId) {
      const id = str(args["id"])!;
      const title = str(args["title"]);
      const req: ArtifactSaveRequest = {
        expectedVersion: args["expectedVersion"] as number,
        body: args["body"] as string,
        ...(title ? { title } : {}),
        ...(args["format"] !== undefined ? { format: args["format"] as NonNullable<ArtifactSaveRequest["format"]> } : {}),
        ...(args["data"] !== undefined ? { data: args["data"] } : {}),
      };
      const r = desk.saveArtifact(id, req, as(principalId));
      if (!r.ok) return conflictOf(`Not saved: ${id} has moved on since v${req.expectedVersion}`, r.artifact, r.outcome);
      const left = r.artifact.parked.length ? ` It has ${r.artifact.parked.length} parked addition(s): read_artifact ${id}, merge what is useful, then dismiss_parked.` : "";
      return ok(`Saved ${id} as v${r.artifact.version}.${left}`, { outcome: r.outcome, ...artifactData(r.artifact) });
    },

    dismiss_parked(args, principalId) {
      const id = str(args["artifactId"])!;
      const a = desk.dismissParked(id, str(args["parkedId"])!, as(principalId));
      return ok(`Removed it. ${id} (v${a.version}) has ${a.parked.length} parked addition(s) left.`, artifactData(a));
    },

    async save_plan(args, principalId) {
      const id = str(args["id"])!;
      const title = str(args["title"]);
      const req: PlanSaveRequest = {
        expectedVersion: args["expectedVersion"] as number,
        proposal: {
          ...(title ? { title } : {}),
          outcome: str(args["outcome"])!,
          ...(args["background"] !== undefined ? { background: args["background"] as string } : {}),
          ...(args["context"] !== undefined ? { agentContext: args["context"] as string } : {}),
          ...(args["runnerOverride"] !== undefined ? { runnerOverride: args["runnerOverride"] as NonNullable<PlanSaveRequest["proposal"]["runnerOverride"]> | null } : {}),
          ...(args["phases"] !== undefined ? { phases: args["phases"] as string[] } : {}),
          ...(args["cwd"] !== undefined ? { cwd: args["cwd"] as string | null } : {}),
          ...(args["repos"] !== undefined ? { repos: args["repos"] as PlanSaveRequest["proposal"]["repos"] } : {}),
          actions: args["actions"] as PlanSaveRequest["proposal"]["actions"],
        },
      };
      const previous = desk.listHumanItems(true).find((i) => i.id === id)?.proposal;
      const before = planDecisions(previous);
      const r = await desk.savePlan(id, req, as(principalId));
      if (!r.ok) return conflictOf(`Not saved: the plan of ${id} has moved on since v${req.expectedVersion}`, r.current, r.outcome);
      const item = desk.listHumanItems(true).find((i) => i.id === id);
      const saved = r.artifact.data as ProjectProposal | undefined;
      // What the new version no longer has is easily overwritten without anybody noticing, and the project reads only
      // the new text: marked passages, steps, and a background that was replaced.
      const named = (titles: readonly string[]) => titles.map((t) => `「${oneLine(t, 80)}」`).join("、");
      const left = planDecisions(saved).map((x) => x.label);
      const dropped = before.map((x) => x.label).filter((label) => !left.includes(label));
      const stepsNow = new Set((saved?.actions ?? []).map((a) => a.title.trim()));
      const goneSteps = (previous?.actions ?? []).map((a) => a.title.trim()).filter((t) => !stepsNow.has(t));
      const [bgBefore, bgNow] = [previous?.background?.trim() ?? "", saved?.background?.trim() ?? ""];
      const changes = [
        dropped.length ? ` No longer in it: ${dropped.length} passage(s) marked for the owner to decide: ${named(dropped)}.` : "",
        left.length ? ` Still marked for the owner to decide (${left.length}): ${named(left)} — each needs their answer before approving.` : "",
        goneSteps.length ? ` Steps of v${req.expectedVersion} that are gone or reworded: ${named(goneSteps)}.` : "",
        bgBefore && bgBefore !== bgNow ? ` Its background was replaced (${bgBefore.length} → ${bgNow.length} characters; the earlier one: read_artifact version ${req.expectedVersion}).` : "",
      ].join("");
      return ok(
        `Saved the plan of ${id} as v${r.artifact.version}. ${saved ? `Now: ${planFacts(saved)}. ` : ""}Show the owner what changed; to approve it on their word: decide_human_item with seenArtifactVersion ${r.artifact.version}${item ? ` and seenItemRevision ${item.itemRevision}` : ""}.${changes}`,
        { outcome: r.outcome, itemRevision: item?.itemRevision ?? null, ...artifactData(r.artifact), proposal: saved ?? null, droppedDecisions: dropped },
      );
    },

    // ---------- scheduled sources ----------

    list_sources() {
      const { sensors } = desk.sources();
      const hits = new Map(sensors.map((s) => [s.id, latestHits(s.id, s.mode)]));
      const lines = sensors.map((s) => {
        const h = hits.get(s.id)!;
        return [
          `- ${s.id}「${s.title}」`,
          ` ${s.scheduleText}；${s.processorLabel}；${s.modeLabel}；${s.statusLabel}；跑了 ${s.runCount} 次，${s.mode === "observe" ? "记进观察笔记" : "记下或报出"} ${s.hitCount} 次（结果不变时不重复）；上次运行 ${isoMin(s.lastRunAt)}，上次${s.mode === "observe" ? "记下" : "记下或报出"} ${isoMin(s.lastHitAt)}${s.lastCheckText ? `；${s.lastCheckText}` : ""}`,
          s.description ? `；${oneLine(s.description, 200)}` : "",
          s.lastError ? `；⚠ 最近错误：${oneLine(s.lastError, 300)}` : "",
          h.text ? `\n  ${h.label}：\n${h.text.split("\n").map((l) => `    ${l}`).join("\n")}${h.more ? `\n  ${h.more}` : ""}` : "",
        ].join("");
      });
      return ok(section("信源", lines), { sensors: sensors.map(({ buttons: _, ...s }) => ({ ...s, latestHits: hits.get(s.id)!.text })) });
    },

    create_source(args, principalId) {
      const title = str(args["title"])!;
      const cron = str(args["cron"]);
      const tz = str(args["tz"]);
      const every = args["everyMinutes"] as number | undefined;
      if ((cron === undefined) === (every === undefined)) return fail("Give exactly one of cron and everyMinutes: when the check runs.");
      if (tz && !cron) return fail("tz belongs to a cron expression: give cron instead of everyMinutes.");
      const kind = args["checkKind"] as CreateSourceRequest["check"]["kind"];
      const field = { script: "scriptPath", code: "codeEntry", llm: "instruction" }[kind];
      const value = str(args[field]);
      if (!value) return fail(`checkKind "${kind}" needs ${field}.`);
      const description = str(args["description"]);
      const r = desk.createSource(
        {
          title,
          ...(description ? { description } : {}),
          schedule: cron ? { cron, ...(tz ? { tz } : {}) } : { everyMinutes: every! },
          check: kind === "script" ? { kind, path: value } : kind === "code" ? { kind, entry: value } : { kind, instruction: value },
          ...(args["mode"] !== undefined ? { mode: args["mode"] as "active" | "observe" } : {}),
        },
        as(principalId),
      );
      const s = r.view.sensors.find((x) => x.id === r.sensorId);
      return ok(`Added source ${r.sensorId}「${title}」${s ? `: ${s.scheduleText}；${s.processorLabel}；${s.modeLabel}` : ""}.`, { outcome: r.outcome, sensorId: r.sensorId });
    },

    async manage_source(args, principalId) {
      const id = str(args["sensorId"])!;
      const actor = as(principalId);
      const action = args["action"] as "pause" | "resume" | "set_mode" | "delete";
      const mode = args["mode"] as "active" | "observe" | undefined;
      if (action === "set_mode" && !mode) return fail('set_mode needs mode: "active" or "observe".');
      const r =
        action === "set_mode" ? desk.setSourceMode(id, { mode: mode! }, actor)
        : action === "delete" ? await desk.deleteSource(id, actor)
        : desk.pauseSource(id, action === "pause", actor);
      return ok(r.message, { outcome: r.outcome, sensorId: id });
    },

    // ---------- weekly review ----------

    get_review() {
      const r = desk.review();
      const text = [
        `周回顾（本周自 ${isoMin(r.weekStart)}；下次 ${isoMin(r.nextReviewAt)}）`,
        section("本周完结", r.completed.map((c) => `- ${c.kind === "project" ? "项目" : c.kind === "action" ? "我办的" : "回复"}「${c.title}」${c.project ? `（${c.project}）` : ""} ${isoMin(c.at)}`)),
        section("超期等待", r.overdueWaits.map((w) => `- ${w.actionId}「${w.title}」${w.project ? `（${w.project}）` : ""} ${w.text}，到期 ${isoMin(w.dueAt)}`)),
        `批准前改过的草稿：${r.editedDrafts} 份`,
        section("建议存成技能（resolve_review_suggestion accept_skill / dismiss_skill）", r.skillSuggestions.map((s) => `- ${s.name}：${s.description}${s.reason ? `（${s.reason}）` : ""}\n${s.body.trim().split("\n").map((l) => `    ${l}`).join("\n")}`)),
        section("建议改成脚本检查的信源（resolve_review_suggestion sensor_to_code）", r.sensorSuggestions.map((s) => `- ${s.sensorId}「${s.title}」：${s.reason}${s.entry ? `；已备好 ${s.entry}` : "；需要给出 entry"}`)),
      ];
      return ok(text.join("\n\n"), {
        ...r,
        skillSuggestions: r.skillSuggestions.map(({ buttons: _, ...s }) => s),
        sensorSuggestions: r.sensorSuggestions.map(({ buttons: _, ...s }) => s),
      });
    },

    resolve_review_suggestion(args, principalId) {
      const actor = as(principalId);
      const action = args["action"] as "accept_skill" | "dismiss_skill" | "sensor_to_code";
      if (action === "sensor_to_code") {
        const sensorId = str(args["sensorId"]);
        if (!sensorId) return fail("sensor_to_code needs sensorId.");
        const entry = str(args["entry"]) ?? desk.review().sensorSuggestions.find((s) => s.sensorId === sensorId)?.entry;
        if (!entry) return fail(`sensor_to_code needs entry: "script:<path>" or the name of a registered check (the review prepared none for ${sensorId}).`);
        const r = desk.sensorToCode(sensorId, { entry }, actor);
        return ok(r.message, { outcome: r.outcome });
      }
      const name = str(args["name"]);
      if (!name) return fail(`${action} needs name: the suggestion's name from get_review.`);
      const slug = skillSlug(name);
      const r = action === "accept_skill" ? desk.acceptSkill(slug, actor) : desk.dismissSkill(slug, actor);
      return ok(r.message, { outcome: r.outcome });
    },

    // ---------- what was filed away ----------

    list_activity(args) {
      const { items, counts } = desk.activity(args["kind"] as ActivityKind | undefined);
      const back = (i: (typeof items)[number]) =>
        i.restoredAt ? `；已移回 ${isoMin(i.restoredAt)}`
        : !i.restorable ? ""
        : i.buttons.some((b) => b.id === "undo") ? "；可撤销：undo_human_decision"
        : "；可移回：restore_activity";
      const lines = items.map((i) => `- ${i.id}（cellId ${i.cellId}）${isoMin(i.at)} ${i.kindLabel}「${i.title}」${i.detail ? ` — ${oneLine(i.detail, 160)}` : ""}${i.source ? `；来源 ${i.source.label}` : ""}${i.remindAt ? `；提醒 ${isoMin(i.remindAt)}` : ""}${back(i)}`);
      return ok(
        `静默归档 ${counts.notification_archived}，笔记 ${counts.note_saved}，提醒 ${counts.reminder_set}，撤卡 ${counts.card_withdrawn}，办完 ${counts.action_completed}\n\n${section("活动记录", lines)}`,
        { counts, items: items.map(({ buttons, ...i }) => ({ ...i, undo: buttons.some((b) => b.id === "undo") })) },
      );
    },

    async restore_activity(args, principalId) {
      const id = str(args["activityId"])!;
      const r = await desk.restoreActivity(str(args["cellId"])!, id, as(principalId));
      return r.ok ? ok(r.message, { outcome: r.outcome }) : fail(`Not restored: ${r.message}`, { outcome: r.outcome });
    },

    // ---------- runners and models ----------

    async get_models(args) {
      const m = await desk.models(args["refresh"] === true);
      return ok(modelsText(m), m);
    },

    async configure_models(args, principalId) {
      const req = modelsRequest(args);
      if (typeof req === "string") return fail(req);
      const m = await desk.setModel(req, as(principalId));
      return ok(`Saved; it applies from the next run on.\n\n${modelsText(m)}`, m);
    },

    // ---------- who works for whom ----------

    get_topology(args) {
      const t = desk.topology({ includeArchived: args["includeArchived"] === true, projectId: str(args["projectId"]) ?? null });
      const depth = new Map<string, number>();
      const lines = t.nodes.map((n) => {
        const d = n.parentId !== null && depth.has(n.parentId) ? depth.get(n.parentId)! + 1 : 0;
        depth.set(n.cellId, d);
        const runner = n.processorType === "code" ? "零算力脚本" : [n.engine, n.effectiveModel?.model, n.effectiveModel?.effort].filter(Boolean).join(" · ");
        const parts = [
          `${n.roleLabel}，${n.stateLabel}${n.stateDetail ? `：${oneLine(n.stateDetail, 100)}` : ""}`,
          runner,
          n.cwd && `目录 ${n.cwd}`,
          n.statusLine && oneLine(n.statusLine, 100),
          n.unpulledCount > 0 && `未汇总 +${n.unpulledCount}`,
          n.hadDirectUserChat && "主人直接说过话",
          n.humanItemId ? `待处理 ${n.humanItemId}` : n.pendingCardId && `待处理 ${n.pendingCardId}`,
          n.archivedChildren > 0 && `另有 ${n.archivedChildren} 个已归档`,
        ].filter(Boolean);
        return `${"  ".repeat(d)}- ${n.cellId}「${n.title}」${parts.join("；")}`;
      });
      const text = [
        `运行 ${t.counts.running}，等待 ${t.counts.waiting}，待命 ${t.counts.dormant}，归档 ${t.counts.archived}`,
        section("分身", lines),
        section("谁在等谁", t.waits.map((w) => `- ${w.fromCellId} → ${w.targetCellId ?? w.targetLabel}：${oneLine(w.description, 160)}（自 ${isoMin(w.since)}）`)),
        section("同目录协作", t.workspaces.map((w) => `- ${w.gitRoot}：${w.activeCellIds.join("、")}`)),
      ];
      return ok(text.join("\n\n"), t);
    },
  };

  /** A person's message to a cell (message_cell / control_cell message|steer), told to the agent in plain words. */
  function deliveredToCell(id: string, d: Delivery, mode: "enqueue" | "steer", notifyParent: "silent" | "wakeup" | undefined, withNote = false): AgentToolResult {
    const data = { outcome: d.outcome, messageId: d.id, ccTo: d.ccTo };
    switch (d.outcome) {
      case "not_found":
        return fail(`Not delivered: there is no cell "${id}". Check the id with get_project or workbench_overview.`, data);
      case "refused_script":
        return fail(`Not delivered: ${id} is a deterministic script probe, not a model — it takes no conversation. control_cell can pause or resume it; to change what it checks, tell its project or the desk.`, data);
      case "refused_paused_parent":
        return fail("Not delivered. Resume the paused parent before messaging its archived worker.", data);
      case "refused_archived":
        return fail(
          `Not delivered: ${id} was archived with a project that has finished. Use reopen_project on the project, then retry — inspect_cell ${id} shows it.`,
          data,
        );
      case "duplicate":
        return ok(`Already delivered earlier (same message); not sent again.`, data);
      default: {
        const before = d.before;
        let what: string;
        if (d.outcome === "reopened") what = `${id} had been closed and was brought back for this: it continues on its previous record (no new cell).`;
        else if (mode === "steer" && before?.state === "running") what = `${id} was interrupted with it: it sees it now, between its steps.`;
        else if (mode === "steer" && before?.state === "paused") what = `${id} is paused: nothing was interrupted; it reads it when it is resumed.`;
        else if (mode === "steer") what = `${id} was not running (its turn had already ended), so nothing was interrupted: the message is delivered and it ${before?.state === "dormant" ? "is woken by it, on its previous record" : "reads it at its next turn"}. Do not tell the owner it was interrupted.`;
        else if (before?.state === "paused") what = `${id} is paused: it reads it when it is resumed.`;
        else if (before?.state === "running") what = `${id} is at work: it takes the message when its current step ends.`;
        else if (before?.state === "dormant") what = `${id} was dormant and is woken by it, on its previous record (no new cell).`;
        else what = `${id} reads it at its next turn.`;
        const cc = d.ccTo
          ? ` Its project ${d.ccTo}${d.ccTitle ? `「${d.ccTitle}」` : ""} was given a copy of the owner's words${notifyParent === "wakeup" ? " and woken" : " (it reads it at its next wake-up; it is not woken for it)"}.`
          : "";
        const mine = withNote ? " Your note went with them, marked as yours." : "";
        return ok(`Delivered (message ${d.id}). ${what}${mine}${cc} Results arrive asynchronously — look later with get_cell / inspect_cell ${id}.`, data);
      }
    }
  }

  /** The last `n` evidence records of a cell, briefly: kind, tool name, the first ~600 characters. */
  function evidenceTail(cellId: string, n: number): Array<{ line: string; data: Record<string, unknown> }> {
    const last = context.lastEvidenceSeqSync(cellId);
    let rows = context.listEvidenceSync(cellId, { afterSeq: Math.max(0, last - 5_000) });
    if (rows.length < n && last > 5_000) rows = context.listEvidenceSync(cellId);
    return rows.slice(-n).map((e) => {
      const r = e.record;
      let name: string | null = null;
      let text = "";
      switch (r.kind) {
        case "inbound":
          name = r.envelope.type;
          text = JSON.stringify((r.envelope.payload as { text?: unknown } | null)?.text ?? r.envelope.payload);
          break;
        case "assistant_text":
          text = r.text;
          break;
        case "tool_call":
          name = r.name;
          text = JSON.stringify(r.input);
          break;
        case "tool_result":
          name = r.name;
          text = `${r.isError ? "ERROR " : ""}${r.output}`;
          break;
        case "external":
          name = r.source;
          text = r.title ? `${r.title}: ${r.text}` : r.text;
          break;
        case "system_note":
          text = r.text;
          break;
        case "run_boundary":
          name = r.phase;
          text = r.phase === "end" ? `outcome ${r.outcome ?? "?"}${r.error ? `: ${r.error}` : ""}` : `epoch ${r.epoch}`;
          break;
      }
      const at = (r as { at?: number }).at;
      const brief = oneLine(text, 600);
      return {
        line: `#${e.seq} ${typeof at === "number" ? `${isoMin(at)} ` : ""}${r.kind}${name ? ` ${name}` : ""}${brief ? ` — ${brief}` : ""}`,
        data: { seq: e.seq, kind: r.kind, name, at: typeof at === "number" ? at : null, text: brief },
      };
    });
  }

  return {
    async tools() {
      const options = await kernel.describeRunnerOptions();
      return AGENT_TOOLS.map((tool) => tool.name === "create_project" || tool.name === "spawn_cell"
        ? { ...tool, description: `${tool.description}\n\n${options}` }
        : tool);
    },
    async call(name, rawArgs, principalId, call = {}) {
      const doc = docs.get(name);
      const handler = handlers[name];
      if (!doc || !handler) {
        return fail(`Unknown tool "${name}". Available: ${AGENT_TOOLS.map((t) => t.name).join(", ")}.`);
      }
      const args = normalizeArgs(doc, dropNulls(rawArgs ?? {}, schemaOf(doc)) as Args);
      const invalid = validateArgs(doc, args);
      if (invalid) return fail(invalid);
      try {
        return await handler(args, principalId, call);
      } catch (err) {
        // Caller mistakes and refusals are answers, not server errors.
        if (err instanceof DeskError) return fail(`${err.status === 404 ? "Not found" : err.status === 409 ? "Not possible now" : "Not accepted"}: ${err.message}`, { code: err.code });
        if (isNgError(err, "bounds_violation")) return fail(`Not allowed: ${err.message}`, { code: err.code });
        if (isNgError(err, "not_found")) return fail(`Not found: ${err.message}`, { code: err.code });
        if (isNgError(err, "invalid_argument") || isNgError(err, "conflict") || isNgError(err, "duplicate") || isNgError(err, "stale_epoch") || isNgError(err, "unsupported")) {
          return fail(`Not done: ${err.message}`, { code: err.code });
        }
        throw err;
      }
    },
  };
}
