import { gtdKeys } from "@ng/presets";
import { join } from "node:path";
import { CELL_DIRECT_CHAT_KEY, get, KERNEL_FROM, parsePrincipal, PAYLOAD, steerNoteText, type ApprovalResolvedPayload, type CellDirectChatPayload, type CellDirectChatState, type CellMessagePayload, type CellProgressPayload, type CellRecord, type CellResultPayload, type CellTaskPayload, type ControlSteerPayload, type Envelope, type EvidenceEntry, type HandbackPayload, type JobResultPayload, type SourceHitPayload, type StepOrExternalEvidence, type TimerFiredPayload, type UserMessagePayload, type WaitTimeoutPayload } from "@ng/protocol";
import type { ArtifactRefDTO, ButtonDTO, CellJobDTO, CellTimelineDTO, ComposerDTO, ResourcePageDTO, TimelineItemDTO, ToolStepDTO, TopologyNodeDTO } from "../../shared/api";
import { type DeskKernel, type ProjectionInput } from "./common";
import { button, channelLabelOfAddress, enc, post } from "./format";
import { isParked, type Facts, type AgentsView, agentsView, isRoot, isLeafCell, titleOf, cellLabel, crumbLabel, projectIdOf, isPerson, personLabel, branchOf, unpulledOf, tailRecords, nodeOf } from "./agent-topology";
import { clip, oneLine, callBrief, baseName, toolSummary } from "./agent-tool-summaries";
export { type AgentsView, agentsView, isLeafCell, cellLabel, personLabel, branchOf, unpulledOf, nodeOf, type TopologyQuery, projectTopology } from "./agent-topology";
export { callBrief, toolSummary } from "./agent-tool-summaries";

const ARTIFACT_LIMIT = 20;
const OUTPUT_HEAD = 1_200;
const MAX_LIMIT = 300;
const DEFAULT_LIMIT = 100;
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

/** An unanswered question of a cell, and how it was asked. */
export interface OpenQuestion {
  id: string;
  text: string;
  at: number;
  /** Sent to the owner as a message (send_message to the owner), not only said in a turn. */
  toOwner: boolean;
  /** Said after a person (the owner, or their agent) spoke to the cell in the records read: the answer to them. */
  afterOwner: boolean;
}

/** The latest question the node asked that nobody has answered yet (a person's message answers it). */
function openQuestionOf(ctx: BuildCtx): OpenQuestion | null {
  let q: OpenQuestion | null = null;
  let spoken = false;
  for (const { item } of buildItems({ ...ctx, steers: ctx.steers.map((s) => ({ ...s, used: false })) }, tailRecords(ctx.v.input.kernel, ctx.cell.id, 200))) {
    if (item.kind === "assistant_reply" && item.question) q = { id: item.id, text: item.text, at: item.at, toOwner: item.toOwner, afterOwner: spoken };
    else if (item.kind === "user_chat") {
      q = null;
      spoken = true;
    }
  }
  return q;
}

function pendingQuestionOf(ctx: BuildCtx): CellTimelineDTO["pendingQuestion"] {
  const q = openQuestionOf(ctx);
  return q ? { id: q.id, text: q.text } : null;
}

/** The open question of each of these cells (one view for all of them): what the overview lists for the owner. */
export function pendingQuestions(input: ProjectionInput, cellIds: readonly string[]): Map<string, OpenQuestion> {
  const out = new Map<string, OpenQuestion>();
  if (cellIds.length === 0) return out;
  const v = agentsView(input, cellIds);
  for (const id of cellIds) {
    const cell = v.cells.get(id);
    const q = cell && cell.status !== "closed" ? openQuestionOf(buildCtx(v, cell)) : null;
    if (q) out.set(id, q);
  }
  return out;
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
  const parked = isParked(v,c);
  // The desk is the root of everything: pausing or stopping it would stop the whole workbench.
  if (isRoot(c)) return c.status === "paused" ? [resume] : [];
  // A source is removed in the sources drawer; here it is only paused and resumed.
  const isSource = v.input.kernel.context.readStateSync(c.id, gtdKeys.source) !== null;
  if (c.status === "paused") return parked || (c.parentId && v.cells.get(c.parentId)?.status === "paused") ? [cancel] : isSource ? [resume] : [resume, cancel];
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
            ...controlsOf(v,c).filter(b => b.id === "pause" || b.id === "resume"),
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
    return { ...base, enabled: true, mode: "paused", hint: isParked(v,c) ? "已停靠，重新启动项目后处理留言" : "已暂停，继续后处理留言", placeholder: `给「${title}」留言…` };
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
