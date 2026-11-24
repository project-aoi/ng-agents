import { isProjectRoot, type Kernel } from "@ng/cell";
import { gtdKeys } from "@ng/presets";
import { createEnvelope, inboxAddr, isNgError, newId, PAYLOAD, type TimerFiredPayload } from "@ng/protocol";
import type {
  CellControlRequest,
  CellControlResponse,
  CellTimelineDTO,
  CellTriggerResponse,
  ProjectMutationResponse,
  ResourcePageDTO,
  SendCellMessageOutcome,
  SendCellMessageRequest,
  SendCellMessageResponse,
  StatusDTO,
  TopologyDTO,
  TopologyNodeDTO,
} from "../shared/api";
import { inputOf, type DeskSettings } from "./projections/common";
import {
  isLeafCell,
  ownerQuestions,
  projectNode,
  projectTimeline,
  projectTopology,
  RESOURCE_PAGE_DEFAULT,
  RESOURCE_PAGE_MAX,
  resourcePage,
  timelineItemText,
  type TimelineQuery,
} from "./projections/agents";

// 分身实况 (Agents): the endpoints behind the agent view — the topology, one cell's timeline, a page of a spilled
// output, a message typed to a cell, and its pause / resume / stop buttons. A message is the kernel's directMessage
// (one transaction: a closed worker under an open project is brought back, the message is queued or steered, the
// project is given a copy); this file validates, words the outcome for a person and answers with the fresh view.

/** An HTTP-mappable failure (same shape as DeskError, which desk.ts re-uses for these). */
export interface AgentsErrors {
  bad(message: string): Error;
  missing(message: string): Error;
}

export interface AgentsDeps {
  requireActor(actor: {principalId: string}): {principalId: string};
  kernel: Kernel;
  commands:{
    message(id:string, req:KernelMessage, as:{principalId:string}):ReturnType<Kernel["directMessage"]>;
    control(id:string, req:Parameters<Kernel["control"]>[1], as:{principalId:string}):ReturnType<Kernel["control"]>;
    close(id:string,as:{principalId:string}): ReturnType<Kernel["closeCell"]>;
    trigger(id:string,epoch:number,as:{principalId:string}): unknown;
  };
  settings: DeskSettings;
  status(): StatusDTO;
  /** Radar's project buttons: pause / resume / cancel of a cell that holds a project go through them. */
  projectOp(projectId: string, op: "pause" | "resume" | "cancel", as: { principalId: string; note?: string }): Promise<ProjectMutationResponse>;
  errors: AgentsErrors;
}

const CLIENT_ID = /^[\w.:-]{1,80}$/;
const REPLY_ID = /^[\w.:#@-]{1,120}$/;
const AGENT_CONTEXT_MAX = 8_000;

/**
 * A person's message as the kernel takes it, plus what the owner's coding agent added on its own (audit E02): the
 * owner's words stay in `text`; `agentContext` travels beside them in the payload and is shown to the cell as the
 * agent's note, never as the owner's words.
 */
export type KernelMessage = Parameters<Kernel["directMessage"]>[1] & { agentContext?: string };

/** A message typed in the workbench or passed on by the owner's agent (the control plane adds a conversation and a note). */
export type PersonMessage = SendCellMessageRequest & { conversationId?: string; agentContext?: string };

/** Notes of a cell the control plane may read by URI (the kernel's own read_resource resolves them the same way). */
const NOTE_SCHEMES = ["reference://", "working_note://"] as const;

/** "web": what is typed in the workbench's own chat box (the external agent's words carry its own conversation id). */
export const WEB_CONVERSATION = "web";

export type AgentsApi = ReturnType<typeof createAgentsApi>;

/** What happened to a person's message, before it is answered as a view (web) or as text (control plane). */
export interface Delivery {
  outcome: SendCellMessageOutcome;
  ok: boolean;
  /** Ready to show (Chinese). */
  message: string;
  id: string | null;
  /** The cell as it was before the message (null when there is no such cell). */
  before: TopologyNodeDTO | null;
  ccTo: string | null;
  ccTitle: string | null;
}

export function createAgentsApi({ requireActor, commands, kernel, settings, status, projectOp, errors }: AgentsDeps) {
  const input = () => inputOf(kernel, settings);
  function topology(q: { includeArchived?: boolean; projectId?: string | null } = {}): TopologyDTO {
    if (q.projectId && !kernel.getCell(q.projectId)) throw errors.missing("找不到这个项目");
    return projectTopology(input(), q);
  }

  function timeline(cellId: string, q: TimelineQuery = {}): CellTimelineDTO {
    const t = projectTimeline(input(), cellId, q);
    if (!t) throw errors.missing("找不到这个分身");
    return t;
  }

  /** The unanswered question each of these cells is asking, if any (get_cell's pendingQuestion, for many at once). */
  const questions = () => ownerQuestions(input());

  /**
   * One page of stored text: a spilled output (`res://…`, readable from anywhere), or a cell's note
   * (`reference://<name>`, `working_note://<name>`, read as that cell sees it — e.g. a source's 观察笔记).
   */
  function resource(uri: string, offset = 0, limit = RESOURCE_PAGE_DEFAULT, cellId?: string): ResourcePageDTO {
    if (!Number.isInteger(offset) || offset < 0) throw errors.bad("offset 必须是非负整数");
    if (!Number.isInteger(limit) || limit < 1) throw errors.bad("limit 必须是正整数");
    const max = Math.min(limit, RESOURCE_PAGE_MAX);
    if (typeof uri === "string" && NOTE_SCHEMES.some((scheme) => uri.startsWith(scheme))) {
      if (!cellId) throw errors.bad("读取笔记需要 cellId：笔记所属的分身（信源列表和 get_cell 里有）");
      if (!kernel.getCell(cellId)) throw errors.missing("找不到这个分身");
      let text: string;
      try {
        text = kernel.context.readResourceSync(cellId, uri, { offset: 0, limit: Number.MAX_SAFE_INTEGER });
      } catch (err) {
        if (isNgError(err, "not_found")) throw errors.missing("这个分身没有这份笔记");
        if (isNgError(err, "invalid_argument")) throw errors.bad(`读不了这个地址：${uri}`);
        throw err;
      }
      const content = text.slice(offset, offset + max);
      return { uri, content, offset, limit: max, totalChars: text.length, hasMore: offset + content.length < text.length };
    }
    if (typeof uri !== "string" || !uri.startsWith("res://")) throw errors.bad("只能读取 res://（完整输出）、reference:// 或 working_note://（分身的笔记）");
    const page = resourcePage(kernel, uri, offset, max);
    if (!page) throw errors.missing("找不到这份输出");
    return page;
  }

  // ---------- a person speaks to a cell ----------

  /**
   * Validate and hand a person's message to the kernel (directMessage, strictly as `as.principalId` — never falling
   * back to the owner), and say in plain words what happened. Shared by the chat box and the control plane.
   */
  function deliver(cellId: string, req: PersonMessage, as: { principalId: string }): Delivery {
    const actor = requireActor(as);
    const text = typeof req?.text === "string" ? req.text.trim() : "";
    if (!text) throw errors.bad("消息不能为空");
    if (typeof req.clientId !== "string" || !CLIENT_ID.test(req.clientId)) throw errors.bad("clientId 格式不对（字母、数字、_ . : -，最多 80 个字符）");
    if (req.mode !== undefined && req.mode !== "enqueue" && req.mode !== "steer") throw errors.bad("mode 只能是 enqueue 或 steer");
    if (req.notifyParent !== undefined && req.notifyParent !== "silent" && req.notifyParent !== "wakeup") throw errors.bad("notifyParent 只能是 silent 或 wakeup");
    if (req.replyToId !== undefined && (typeof req.replyToId !== "string" || !REPLY_ID.test(req.replyToId))) throw errors.bad("replyToId 格式不对");
    if (req.conversationId !== undefined && (typeof req.conversationId !== "string" || !REPLY_ID.test(req.conversationId))) throw errors.bad("conversationId 格式不对");
    if (req.agentContext !== undefined && (typeof req.agentContext !== "string" || req.agentContext.length > AGENT_CONTEXT_MAX)) throw errors.bad(`补充说明必须是不超过 ${AGENT_CONTEXT_MAX} 字的文本`);
    const agentContext = req.agentContext?.trim();
    const cell = kernel.getCell(cellId);
    if (!cell) return { outcome: "not_found", ok: false, message: "找不到这个分身", id: null, before: null, ccTo: null, ccTitle: null };

    const before = projectNode(input(), cellId)!;
    const replyToText = req.replyToId ? timelineItemText(input(), cellId, req.replyToId) : null;
    const mode = req.mode ?? "enqueue";
    const r = commands.message(
      cellId,
      {
        text,
        clientId: req.clientId,
        mode,
        ...(req.notifyParent ? { notifyParent: req.notifyParent } : {}),
        ...(req.replyToId ? { replyToId: req.replyToId } : {}),
        ...(replyToText ? { replyToText } : {}),
        conversationId: req.conversationId ?? WEB_CONVERSATION,
        ...(agentContext ? { agentContext } : {}),
      },
      actor,
    );
    const no = { id: null, before, ccTo: null, ccTitle: null };
    switch (r.status) {
      case "not_found":
        return { ...no, outcome: "not_found", ok: false, message: "找不到这个分身", before: null };
      case "refused":
        if (r.reason === "code") return { ...no, outcome: "refused_script", ok: false, message: "这是零算力确定性脚本探针，不接受自然语言对话（可以立即触发一次检查或暂停它）" };
        if (r.reason === "paused_parent") return { ...no, outcome: "refused_paused_parent", ok: false, message: "请先恢复所属任务，再向这个分身发消息" };
        if (r.reason === "archived") return { ...no, outcome: "refused_archived", ok: false, message: "它已随所属项目归档。请在已结束的项目中重新打开，再继续对话" };
        return { ...no, outcome: "refused_archived", ok: false, message: "没有送达：它现在不接受消息" };
      case "delivered": {
        if (r.duplicate) return { ...no, id: r.envelopeId, outcome: "duplicate", ok: true, message: "这条消息已经发过了，不会重复发送" };
        const cc = r.ccTo ? kernel.getCell(r.ccTo) : undefined;
        const above = cc && isProjectRoot(kernel.registry, cc) ? "所属项目" : "它的上级";
        const ccTitle = cc ? (kernel.context.readStateSync<{ title?: string }>(cc.id, gtdKeys.project)?.title ?? cc.title ?? (above === "所属项目" ? "所属项目" : "上级协调")) : null;
        const synced = ccTitle ? `；已同步给${above}「${ccTitle}」${req.notifyParent === "wakeup" ? `，并唤醒了${above === "所属项目" ? "项目" : "上级"}协调` : ""}` : "";
        const done = { id: r.envelopeId, before, ccTo: r.ccTo, ccTitle };
        if (r.reopened) return { ...done, outcome: "reopened", ok: true, message: `分身已重新打开，会沿原上下文接着做${synced}` };
        let message: string;
        if (mode === "steer" && before.state === "running") message = "已打断插话，它马上就会看到";
        else if (mode === "steer") message = isLeafCell(cell) ? "它这一轮已经结束，没有可打断的；消息已送达，会唤醒它处理" : "它当时没有在运行，没有可打断的；消息已送达，下一轮处理";
        else if (r.targetStatus === "paused") message = "已送达；它暂停中，继续之后再处理";
        else if (before.state === "running") message = isLeafCell(cell) ? "已顺手补充，本轮收尾时处理" : "已顺手补充，它这一步做完就看";
        else if (cell.parentId === null) message = "已发给总助理";
        else if (isLeafCell(cell)) message = before.state === "dormant" ? "已发送，分身已被唤醒" : "已发送，分身会被唤醒处理";
        else message = `已传达给「${before.title}」`;
        return { ...done, outcome: "delivered", ok: true, message: `${message}${synced}` };
      }
    }
  }

  /** POST /api/cells/:cellId/messages. Always answers (not_found included) with the outcome in the body. */
  function sendMessage(cellId: string, req: SendCellMessageRequest, as: { principalId: string }): SendCellMessageResponse {
    const d = deliver(cellId, req, as);
    return { ok: d.ok, outcome: d.outcome, message: d.message, id: d.id, timeline: d.outcome === "not_found" ? null : projectTimeline(input(), cellId), status: status() };
  }

  // ---------- pause / resume / stop ----------

  function controlResult(outcome: CellControlResponse["outcome"], ok: boolean, message: string, cellId: string | null): CellControlResponse {
    return { ok, outcome, message, node: cellId ? projectNode(input(), cellId) : null, status: status() };
  }

  /** POST /api/cells/:cellId/control. A project goes through Radar's own buttons (its books and cards follow). */
  async function control(cellId: string, req: CellControlRequest, as: { principalId: string; note?: string }): Promise<CellControlResponse> {
    const actor = requireActor(as);
    const note = as.note?.trim();
    const action = req?.action;
    if (action !== "pause" && action !== "resume" && action !== "cancel") throw errors.bad("action 只能是 pause / resume / cancel");
    const cell = kernel.getCell(cellId);
    if (!cell) return controlResult("not_found", false, "找不到这个分身", null);
    const name = projectNode(input(), cellId)!.title;
    if (cell.status === "closed") return controlResult("not_applied", false, `「${name}」已经结束了`, cellId);
    if (cell.parentId === null && action !== "resume") {
      return controlResult("not_applied", false, "总助理是整个工作台的根，不能暂停或叫停：停下它，所有后台工作都会停", cellId);
    }
    if (isProjectRoot(kernel.registry, cell)) {
      const r = await projectOp(cellId, action, { ...actor, ...(note ? { note } : {}) });
      const outcome = r.outcome === "paused" || r.outcome === "resumed" || r.outcome === "cancelled" ? r.outcome : "not_applied";
      return controlResult(outcome, r.ok, r.message, cellId);
    }
    switch (action) {
      case "pause": {
        if (cell.status === "paused") return controlResult("paused", true, `「${name}」已经暂停了`, cellId);
        const r = commands.control(cellId, { action: "pause", ...(note ? { note } : {}) }, actor);
        return r.applied ? controlResult("paused", true, `已暂停「${name}」`, cellId) : controlResult("not_applied", false, "暂停没有生效", cellId);
      }
      case "resume": {
        if (cell.status === "active") return controlResult("resumed", true, `「${name}」没有暂停`, cellId);
        const r = commands.control(cellId, { action: "resume" }, actor);
        return r.applied ? controlResult("resumed", true, `「${name}」继续`, cellId) : controlResult("not_applied", false, "继续没有生效（它的上级可能还在暂停）", cellId);
      }
      case "cancel": {
        if (kernel.context.readStateSync(cellId, gtdKeys.source) !== null) return controlResult("not_applied", false, "信源请在信源抽屉里删除", cellId);
        // Its parent hears that it was stopped (the kernel tells it), and decides what comes next.
        const r = await commands.close(cellId,actor);
        const others = Math.max(0, r.closed.length - 1);
        return controlResult("cancelled", true, `已叫停「${name}」${others ? `和它下面的 ${others} 个分身` : ""}（文件和分支都留在原处）`, cellId);
      }
    }
  }

  /** POST /api/cells/:cellId/trigger — "立即触发一次检查": a script probe runs its check now. */
  function trigger(cellId: string, as: { principalId: string }): CellTriggerResponse {
    const actor = requireActor(as);
    const cell = kernel.getCell(cellId);
    const result = (outcome: CellTriggerResponse["outcome"], ok: boolean, message: string): CellTriggerResponse => ({
      ok,
      outcome,
      message,
      node: cell ? projectNode(input(), cellId) : null,
      status: status(),
    });
    if (!cell) return result("not_found", false, "找不到这个分身");
    if (cell.spec.processor.kind !== "code") return result("not_applied", false, "只有脚本探针可以手动触发检查；和它说话就好");
    if (cell.status !== "active") return result("not_applied", false, cell.status === "paused" ? "它暂停中，先继续再触发" : "它已经结束了");
    commands.trigger(cellId,cell.epoch,actor);
    return result("triggered", true, "已触发一次检查");
  }

  return { topology, timeline, questions, resource, deliver, sendMessage, control, trigger };
}
