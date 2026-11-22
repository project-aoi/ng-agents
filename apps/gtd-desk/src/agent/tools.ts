import type { CellSpecInput, Kernel } from "@ng/cell";

import { type ProjectInit, type ProjectMode } from "@ng/presets";
import {
  CELL_DIRECT_CHAT_KEY,
  CELL_STATUS_KEY,
  DEFAULT_RESOURCE_PAGE_CHARS,
  MAX_RESOURCE_PAGE_CHARS,
  isNgError,
  newId,
  type ActionRecord,
  type BallOwner,
  type CellDirectChatState,
  type CellRecord,
  type CellStatusLine,
  type ProjectRecord,
  type SendToCellResult,
} from "@ng/protocol";
import type { ProjectRowDTO, SendCellMessageRequest, TimelineItemDTO } from "../shared/api";
import type { Delivery } from "../server/agents";
import { DeskError, type Desk, type DeskActor, type ProjectOp } from "../server/desk";
import { isLeafCell, unpulledOf } from "../server/projections/agents";
import { projectOfAction, readActions, readProjects,  type Located } from "../server/projections/common";
import { AGENT_TOOLS, type AgentToolDoc } from "./guide";
import type { AgentControlPlane, AgentToolResult } from "./routes";

// docs/05 §5.3 — the external main agent's control plane: every tool of guide.ts, run as the caller's `agent:<id>`
// principal. Reads go through the same projections as the web client; changes go through the same Desk functions as
// the workbench buttons (parameterised by the principal) or straight to the kernel as that principal.
// The kernel and the Gate decide what an agent may do; this file only turns their answers into plain text.

export interface AgentControlPlaneDeps {
  kernel: Kernel;
  desk: Desk;
}

type Args = Record<string, unknown>;
type Principal = `agent:${string}`;
type Handler = (args: Args, principalId: Principal) => Promise<AgentToolResult> | AgentToolResult;

/** The `text` an agent reads for an owner-only card (project approval). */
export function ownerOnlyText(cardId: string, why: string): string {
  return `Refused: only the owner can approve card ${cardId} (${why}). You may not approve or continue it on their behalf, even on their say-so. Tell the owner to confirm it themselves in the workbench UI (待我处理). The card is still pending.`;
}

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

// ==================== argument validation (against the schemas in guide.ts) ====================

interface PropSchema {
  type?: string;
  enum?: readonly unknown[];
  items?: { type?: string };
}

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
    const target = typeof out["id"] === "string" && out["id"].startsWith("act_") ? "actionId" : "projectId";
    if (target in props && out[target] === undefined) {
      out[target] = out["id"];
      delete out["id"];
    }
  }
  return out;
}

/** null when `args` fits the tool's input schema; otherwise what is wrong, for the agent to fix. */
export function validateArgs(doc: AgentToolDoc, args: Args): string | null {
  const schema = doc.inputSchema as { properties?: Record<string, PropSchema>; required?: string[] };
  const props = schema.properties ?? {};
  const problems: string[] = [];
  for (const k of Object.keys(args)) if (!(k in props)) problems.push(`unknown argument "${k}"`);
  for (const r of schema.required ?? []) {
    const v = args[r];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) problems.push(`"${r}" is required`);
  }
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p || v === undefined || v === null) continue;
    const typeOk =
      p.type === "string"
        ? typeof v === "string"
        : p.type === "number"
          ? typeof v === "number" && Number.isFinite(v)
          : p.type === "boolean"
            ? typeof v === "boolean"
            : p.type === "array"
              ? Array.isArray(v) && (p.items?.type !== "string" || v.every((x) => typeof x === "string"))
              : true;
    if (!typeOk) problems.push(`"${k}" must be ${p.type === "array" ? `an array${p.items?.type ? ` of ${p.items.type}s` : ""}` : `a ${p.type}`}`);
    else if (p.enum && !p.enum.includes(v)) problems.push(`"${k}" must be one of ${p.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (problems.length === 0) return null;
  const required = schema.required?.length ? ` Required: ${schema.required.join(", ")}.` : "";
  return `Invalid arguments for ${doc.name}: ${problems.join("; ")}.${required} Allowed: ${Object.keys(props).join(", ") || "none"}.`;
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
      item.project?.title, item.ownerOnly && "[ownerOnly]"].filter(Boolean);
    return `- ${item.id}「${item.title}」 ${parts.join(" · ")}`;
  }

  function projectLine(p: ProjectRowDTO): string {
    const parts: string[] = [];
    if (p.ball) parts.push(`球在：${OWNER_TEXT[p.ball.owner]} · ${oneLine(p.ball.text, 100)}`);
    else parts.push("没有未完成的动作");
    if (p.summary) parts.push(`摘要：${oneLine(p.summary, 120)}`);
    if (p.cwd) parts.push(`目录 ${p.cwd}`);
    if (p.workers.length) parts.push(`${p.workers.length} 个后台分身（${p.workers.filter((w) => w.state === "running").length} 个在跑）`);
    if (p.pendingCardId) parts.push(`有一项 ${p.pendingCardId} 等你决定`);
    if (p.paused && p.lifecycle === "active") parts.push("已暂停");
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
    const occ = kernel.activeWorkspaces();
    const lines = occ.map((o) => {
      const who = o.active.map(
        (u) =>
          `${u.cellId}${u.title ? `「${u.title}」` : ""}${u.projectTitle ? `（项目「${u.projectTitle}」）` : ""}${u.cwd !== o.key ? ` 在 ${u.cwd}` : ""}：${u.state === "job" ? "后台命令在跑" : "正在工作"}${u.statusLine ? ` — ${oneLine(u.statusLine, 80)}` : ""}`,
      );
      return `- ${o.key} — ${who.join("；")}`;
    });
    return { lines, data: occ };
  }


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
        const w = kernel.listWaits([c.id])[0];
        return w ? `等待中（waiting for ${w.waitingFor}：${oneLine(w.reason, 60)}）` : `等待中（${a.why}）`;
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

  function deliveredText(id: string, r: Extract<SendToCellResult, { status: "delivered" }>, isProject: boolean): string {
    if (r.targetStatus === "paused") {
      return isProject && kernel.getCell(id)?.pauseReason === "parked"
        ? `Delivered to ${id}, but it is parked ("someday"): it reads this when it is activated. To have it act now, set_project_state ${id} activate (with the owner's words as note).`
        : `Delivered to ${id}, but it is paused: it reads this when it is resumed (set_project_state / control_cell resume).`;
    }
    return `Delivered to ${id} (message ${r.envelopeId}); it reads it at its next turn${isProject ? " and acts on it with a new worker if needed" : ""}. Results arrive asynchronously — check later with ${isProject ? "get_project" : "get_cell"}.`;
  }

  // ==================== tools ====================

  const handlers: Record<string, Handler> = {
    workbench_overview(args) {
      const all = desk.listHumanItems(true);
      const items = all.filter((item) => item.snoozedUntil == null || item.snoozedUntil <= now());
      const actions = items.filter((item) => item.category === "action");
      const cards = items.filter((item) => item.category === "decision");
      const radar = desk.radar();
      const running = runningLines();
      const ws = workspaceLines();
      const parts = [
        section("待我处理", items.map(cardLine)),
        section("进行中的项目", radar.projects.map(projectLine)),
        section("已停靠", radar.someday.map((p) => `- ${p.id}「${p.title}」— 以后再说${p.summary ? `；摘要：${oneLine(p.summary, 120)}` : ""}${p.cwd ? `；目录 ${p.cwd}` : ""}`)),
        section("正在运行", running.lines),
        section("工作目录占用", ws.lines),
      ];
      let finished: unknown[] | undefined;
      if (args["includeFinished"] === true) {
        const recent = readProjects(kernel)
          .filter((p) => p.record.lifecycle === "completed" || p.record.lifecycle === "cancelled")
          .sort((a, b) => (b.record.completedAt ?? b.record.updatedAt) - (a.record.completedAt ?? a.record.updatedAt))
          .slice(0, 15);
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
      return ok(`工作台概览（${isoMin(now())}）\n\n${parts.join("\n\n")}`, {
        generatedAt: now(),
        humanActions: actions.map((item) => ({ ...item, nextStep: item.description, projectId: item.project?.id ?? null, overdue: item.dueAt != null && item.dueAt < now() })),
        cards,
        projects: radar.projects.map(projectData),
        parked: radar.someday.map(projectData),
        running: running.data,
        workspaces: ws.data,
        snoozedCards: snoozed,
        ...(finished ? { finished } : {}),
      });
    },

    async capture(args,principalId) {
      const clientId=str(args["clientId"]);
      const receipt=await desk.ingest({text:str(args["text"])!,...(clientId ? {clientId} : {})},{principalId});
      return ok(`Captured message ${receipt.id}. The workbench routes it to the matching subscriber or the desk.`,{envelopeId:receipt.id});
    },

    chat_with_desk(args, principalId) {
      const text = str(args["text"]);
      const since = typeof args["since"] === "number" ? Math.max(0, Math.floor(args["since"])) : undefined;
      if (!text && since === undefined) return fail("Give text (the owner's words for the desk), or since (to read the desk's replies after that cursor).");
      const conversationId = str(args["conversationId"]) ?? principalId;
      const replyToId = str(args["replyToId"]);
      const from = since ?? context.lastEvidenceSeqSync(deskId);
      let sent: Delivery | null = null;
      if (text) {
        sent = desk.directMessage(deskId, { text, clientId: newId("agchat", clock), conversationId, ...(replyToId ? { replyToId } : {}) }, { principalId });
        if (!sent.ok) return fail(`Not passed on: ${sent.message}`, { outcome: sent.outcome });
      }
      const t = desk.timeline(deskId, { afterSeq: from, limit: 50 });
      const replies = t.items.filter((i): i is Extract<TimelineItemDTO, { kind: "assistant_reply" }> => i.kind === "assistant_reply");
      const cursor = Math.max(from, t.lastSeq);
      const lines = replies.map((r) => `- [${r.id}${r.question ? ", a question — answer with replyToId " + r.id : ""}] ${r.text}`);
      const head = sent ? `Passed to the desk as the owner's words (message ${sent.id}, conversation ${conversationId}${replyToId ? `, answering ${replyToId}` : ""}). ` : "";
      const body = replies.length
        ? `The desk's replies after #${from}:\n${lines.join("\n")}\nRelay them to the owner. To read later replies: chat_with_desk with since ${cursor}.`
        : `No reply from the desk yet — it answers in the background. When the owner asks (never in a loop), read its answer with chat_with_desk { since: ${cursor} }.`;
      return ok(`${head}${body}`, {
        ...(sent ? { messageId: sent.id } : {}),
        conversationId,
        cursor,
        replies: replies.map((r) => ({ id: r.id, text: r.text, question: r.question, toOwner: r.toOwner, at: r.at })),
      });
    },

    message_cell(args, principalId) {
      const id = str(args["id"])!;
      const mode = (str(args["mode"]) ?? "enqueue") as "enqueue" | "steer";
      const notifyParent = str(args["notifyParent"]) as "silent" | "wakeup" | undefined;
      const replyToId = str(args["replyToId"]);
      const req: SendCellMessageRequest & { conversationId: string } = {
        text: str(args["text"])!,
        clientId: newId("agmsg", clock),
        mode,
        ...(notifyParent ? { notifyParent } : {}),
        ...(replyToId ? { replyToId } : {}),
        conversationId: str(args["conversationId"]) ?? principalId,
      };
      return deliveredToCell(id, desk.directMessage(id, req, { principalId }), mode, notifyParent);
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
      const page = desk.resource(uri, offset, limit);
      const end = offset + page.content.length;
      const where = `${uri} — characters ${offset}–${end} of ${page.totalChars}${page.hasMore ? `; the rest: read_resource { uri, offset: ${end} }` : " (to the end)"}`;
      return ok(`${where}\n---\n${page.content}`, page);
    },

    create_project(args, principalId) {
      const mode = (str(args["mode"]) ?? "now") as ProjectMode;
      const phases = Array.isArray(args["phases"]) ? (args["phases"] as string[]).map((p) => p.trim()).filter(Boolean) : [];
      const cwd = str(args["cwd"]);
      const init: ProjectInit = {
        title: str(args["title"])!,
        outcome: str(args["outcome"])!,
        brief: str(args["brief"])!,
        mode,
        source: { label: "主 Agent", principalId, at: now() },
        ...(cwd ? { cwd } : {}),
        ...(phases.length ? { phases } : {}),
      };
      let r: { projectId: string; started: boolean };
      try {
        r = desk.createProject(init,{principalId});
      } catch (err) {
        if (isNgError(err, "invalid_argument") && /\bcwd\b|directory|path/i.test(err.message)) {
          return fail(
            `Not started: ${err.message}. Ask the owner for the correct absolute path of the directory or repository on this machine, then call create_project again with it. Never guess or invent a path.`,
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
      const waits = kernel.listWaits(ids.filter((cid) => kernel.getCell(cid)?.status !== "closed"));
      const running = new Set(kernel.activeRuns().map((r) => r.cellId));
      const artifacts = ids.flatMap((cid) => context.listArtifactsSync(cid)).sort((a, b) => b.updatedAt - a.updatedAt);
      const cards = desk.listHumanItems(true).filter(r => r.category === "decision" &&
        ((r.cellId && ids.includes(r.cellId)) || r.relatedProjectIds.includes(id) || r.subjectKey === `project:${id}`));
      const anchors = cell && cell.status !== "closed" ? kernel.anchorsOf(id) : null;
      // BUG-011.3: a parked project is paused underneath, but it is brought back with activate — never resume.
      const state =
        cell?.pauseReason === "parked"
          ? "以后再说（停靠中，什么都不运行；要它继续：set_project_state activate，不是 resume）"
          : cell?.status === "closed"
            ? `${record.lifecycle}（cell closed: ${cell.closeReason ?? "?"}）`
            : cell?.status === "paused"
              ? `${record.lifecycle}；已暂停（set_project_state resume 继续）`
              : record.lifecycle;
      const actionLine = (a: Located<ActionRecord>) => {
        const r = a.record;
        const carrier = r.cellId ? `，由 ${r.cellId} 承担` : "";
        return `- ${r.id}「${r.title}」${OWNER_TEXT[r.owner]}，${r.status}${carrier}${r.nextStep && r.nextStep !== r.title ? ` — 下一步：${oneLine(r.nextStep, 120)}` : ""}${r.dueAt ? `，到期 ${isoMin(r.dueAt)}` : ""}`;
      };
      const cellLines = below.map((c) => {
        const line = statusLineOf(c.id);
        return `- ${c.id}${c.title ? `「${c.title}」` : ""}（${c.preset ?? "cell"}，${cellStateText(c)}${c.spec.cwd ? `，目录 ${c.spec.cwd}` : ""}）${line && c.status !== "closed" ? ` — ${oneLine(line, 120)}` : ""}`;
      });
      // Proposal 02 §四.2: what its workers did or were told past the project's own cursor, read live — the project
      // may not have woken since, but whoever asks sees it now (the owner's direct words included).
      const unpulled = below
        .filter((c) => isLeafCell(c) && c.parentId !== null)
        .map((c) => ({ c, ...unpulledOf(kernel, c) }))
        .filter((u) => u.count > 0)
        .map((u) => ({ cellId: u.c.id, count: u.count, text: kernel.inspectCell(u.c.id, { afterSeq: u.cursor, maxChars: 3_000 }).text }));
      const ownWaits = waits.filter((w) => w.cellId === id).map((w) => `${w.waitingFor}（${oneLine(w.reason, 80)}）`);
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
      const text = [
        head.join("\n"),
        section("未完成的动作", open.map(actionLine)),
        ...(closed.length ? [section("最近完成/取消的动作", closed.map(actionLine))] : []),
        section("它的分身（运行中 / 等待中 / 待命可唤醒 / 已归档）", cellLines),
        ...(unpulled.length ? [section("尚未汇总至项目的 Worker 最新动态", unpulled.map((u) => `- ${u.cellId}：${u.count} 条新记录\n${u.text.split("\n").map((l) => `  ${l}`).join("\n")}`))] : []),
        section("报告与草稿", artifacts.map((a) => `- ${a.artifactId} v${a.version}${a.content.title ? `「${a.content.title}」` : ""}（${a.content.format}，${a.updatedBy} 更新于 ${isoMin(a.updatedAt)}）`)),
        section("等你决定", cards.map(cardLine)),
      ].join("\n\n");
      return ok(text, {
        id,
        title: record.title,
        lifecycle: record.lifecycle,
        cellStatus: cell?.status ?? null,
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
        unpulled: unpulled.map((u) => ({ cellId: u.cellId, count: u.count })),
        waits: waits.map((w) => ({ cellId: w.cellId, waitingFor: w.waitingFor, reason: w.reason })),
        artifacts: artifacts.map((a) => ({ id: a.artifactId, title: a.content.title ?? null, version: a.version, cellId: a.cellId, updatedAt: a.updatedAt })),
        cards,
      });
    },

    message_project(args, principalId) {
      const id = str(args["id"])!;
      const text = str(args["text"])!;
      const record = projectRecordOf(id);
      if (!record && !kernel.getCell(id)) return noProject(id);
      const mode=args["urgent"]===true ? "steer" : "enqueue";
      const cell=kernel.getCell(id);
      if (cell?.status==="closed") return sendFailure(id,{status:"closed",closeReason:cell.closeReason},true);
      const r=desk.directMessage(id,{text,mode,clientId:newId("agmsg",clock),conversationId:principalId},{principalId});
      if (mode==="enqueue" && r.ok && r.id) {
        const delivered={status:"delivered" as const,envelopeId:r.id,targetStatus:cell?.status==="paused" ? "paused" as const : "active" as const};
        return ok(deliveredText(id,delivered,true),delivered);
      }
      return deliveredToCell(id,r,mode,undefined);
    },

    async set_project_state(args, principalId) {
      const id = str(args["id"])!;
      if (!projectRecordOf(id)) return noProject(id);
      const r = await desk.projectOp(id, args["state"] as ProjectOp, as(principalId, str(args["note"])));
      return r.ok ? ok(r.message, { outcome: r.outcome }) : fail(`Not applied: ${r.message}`, { outcome: r.outcome });
    },

    async add_action(args, principalId) {
      const projectId = str(args["projectId"])!;
      if (!projectRecordOf(projectId)) return noProject(projectId);
      const owner = args["owner"] as "human" | "waiting";
      const nextStep = str(args["nextStep"]);
      const r = await desk.addProjectAction(projectId, { title: str(args["title"])!, owner, ...(nextStep ? { nextStep } : {}) }, as(principalId));
      return ok(
        `Recorded action ${r.actionId}「${str(args["title"])}」 on project ${projectId} (${owner === "human" ? "the owner's to-do" : "waiting"}); the project was told. ${owner === "human" ? "When the owner has done it, decide_human_item with the current option and revision." : ""}`.trim(),
        { actionId: r.actionId },
      );
    },

    list_human_items() {
      const items = desk.listHumanItems();
      return ok(`待处理 ${items.length} 项\n${JSON.stringify(items, null, 2)}`, {items});
    },
    async decide_human_item(args,principalId) {
      const result = await desk.decideHumanItem(str(args.id)!,{
        optionId:str(args.optionId)!, seenItemRevision:args.seenItemRevision as number,
        ...(typeof args.seenArtifactVersion==="number" ? {seenArtifactVersion:args.seenArtifactVersion} : {}),
        ...(typeof args.until==="number" ? {until:args.until} : {}), ...(typeof args.note==="string" ? {note:args.note} : {}),
        ...(typeof args.resumeProjectId==="string" ? {resumeProjectId:args.resumeProjectId} : {}),
        ...(Array.isArray(args.confirmedClosure) ? {confirmedClosure:args.confirmedClosure as string[]} : {}),
        ...(Array.isArray(args.confirmedTargets) ? {confirmedTargets:args.confirmedTargets as string[]} : {}),
      },as(principalId));
      if (["already_cancelled", "not_found", "not_pending", "version_mismatch", "revision_mismatch"].includes(result.status)) return fail(JSON.stringify(result), result);
      return ok(JSON.stringify(result),result);
    },
    async reopen_project(args,principalId) {
      const result = await desk.reopenProject(str(args.projectId)!,as(principalId));
      return ok("项目已重新打开",result);
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
      const content = ver?.content ?? a.content;
      const version = ver?.version ?? a.version;
      const body = content.body;
      const offset = typeof args["offset"] === "number" ? Math.max(0, Math.floor(args["offset"])) : 0;
      const limit = typeof args["limit"] === "number" ? Math.max(1, Math.min(MAX_RESOURCE_PAGE_CHARS, Math.floor(args["limit"]))) : 16_000;
      const page = body.slice(offset, offset + limit);
      const end = offset + page.length;
      const hasMore = end < body.length;
      const head = `artifact ${a.artifactId} v${version}${content.title ? `「${content.title}」` : ""} — ${content.format}，${(ver?.updatedBy ?? a.updatedBy)} 更新于 ${isoMin(ver?.createdAt ?? a.updatedAt)}，属于 ${a.cellId}${ver ? `（当前版本是 v${a.version}）` : ""}`;
      const paging = offset > 0 || hasMore ? `\ncharacters ${offset}–${end} of ${body.length}${hasMore ? `; the rest: read_artifact { id: "${id}"${ver ? `, version: ${version}` : ""}, offset: ${end} }` : " (to the end)"}` : "";
      return ok(`${head}${paging}\n---\n${page}`, {
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
      const waits = kernel.listWaits([id]);
      const running = kernel.activeRuns().some((r) => r.cellId === id);
      const children = kernel.listCells({ parentId: id });
      const cards = desk.listHumanItems(true).filter(r => r.category === "decision" && r.cellId === id);
      const project = projectRecordOf(id);
      const tail = n > 0 ? evidenceTail(id, n) : [];
      const head = [
        `cell ${id}${c.title ? `「${c.title}」` : ""} — ${c.preset ?? "cell"}，${cellStateText(c)}（${c.status}${c.closeReason ? `, ${c.closeReason}` : ""}${activity ? `; ${activity.why}` : ""}）`,
        `父节点：${c.parentId ?? "—"}；目录：${c.spec.cwd ?? "（默认）"}；${isLeafCell(c) ? "叶节点：一轮做完待命，发消息即唤醒" : "常驻"}${chats ? `；主人直接和它说过 ${chats} 次话` : ""}`,
        `状态行：${statusLineOf(id) ?? "—"}`,
        `在等：${waits.length ? waits.map((w) => `${w.waitingFor}（${oneLine(w.reason, 80)}${w.timeoutAt ? `，${isoMin(w.timeoutAt)} 超时` : ""}）`).join("；") : "—"}`,
        ...(project ? [`持有项目记录：${project.lifecycle}「${project.title}」`] : []),
        ...(cards.length ? [`等你决定：${cards.map(cardLine).join(", ")}`] : []),
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
        state: activity?.state ?? "closed",
        directChats: chats, cards,
        running,
        waits: waits.map((w) => ({ waitingFor: w.waitingFor, reason: w.reason, timeoutAt: w.timeoutAt })),
        children: children.map((x) => ({ id: x.id, preset: x.preset, status: x.status, title: x.title })),
        tail: tail.map((t) => t.data),
      });
    },

    spawn_cell(args, principalId) {
      const preset = str(args["preset"])!; // any registered preset; the kernel says so when it is not one
      const title = str(args["title"])!;
      const instruction = str(args["instruction"])!;
      const cwd = str(args["cwd"]);
      const parentId = str(args["parentId"]) ?? deskId;
      const parent = kernel.getCell(parentId);
      if (!parent) return fail(`There is no cell "${parentId}" to attach it to.`);
      if (parent.status === "closed") return fail(`Cell ${parentId} has closed; attach the new cell elsewhere (default: the desk).`);
      let cellId: string;
      try {
        if (preset === "project") {
          cellId = desk.createProject({ title, outcome: title, brief: instruction, source: { label: "主 Agent", principalId, at: now() }, ...(cwd ? { cwd } : {}) }, { principalId },parentId).projectId;
        } else {
          const spec: CellSpecInput = { preset: preset as NonNullable<CellSpecInput["preset"]>, title };
          if (cwd) spec.cwd = cwd;
          const addr = desk.spawnCell(parentId, spec, { instruction, title }, { principalId });
          cellId = addr.slice("inbox:".length);
        }
      } catch (err) {
        if (isNgError(err, "invalid_argument") && /\bcwd\b|directory|path/i.test(err.message)) {
          return fail(`Not started: ${err.message}. Ask the owner for the correct absolute path; never guess one.`);
        }
        throw err;
      }
      return ok(
        `Started ${preset} ${cellId}「${title}」 under ${parentId}. It runs in the background${preset === "worker" ? "; when its turn is over it stays dormant — message_cell asks it more, inspect_cell reads what it did" : ""}; look at it with get_cell ${cellId}${preset === "project" ? ` or get_project ${cellId}` : ""}.`,
        { cellId, parentId, preset },
      );
    },

    async control_cell(args, principalId) {
      const id = str(args["id"])!;
      const action = args["action"] as "message" | "steer" | "pause" | "resume" | "cancel";
      const text = str(args["text"]);
      const isProject = projectRecordOf(id) !== null;
      if ((action === "message" || action === "steer") && !text) return fail(`control_cell ${action} needs text: what to tell the cell.`);
      if (action === "message" || action === "steer") {
        const mode = action === "steer" ? "steer" : "enqueue";
        return deliveredToCell(id, desk.directMessage(id, { text: text!, clientId: newId("agmsg", clock), mode, conversationId: principalId }, { principalId }), mode, undefined);
      }
      const cell = kernel.getCell(id);
      if (!cell) return sendFailure(id, { status: "not_found" }, isProject);
      if (cell.status === "closed") {
        if (action === "cancel") return ok(`${id} had already closed (${cell.closeReason ?? "?"}); nothing to cancel.`, { applied: false, reason: "closed" });
        return sendFailure(id, { status: "closed", closeReason: cell.closeReason }, isProject);
      }
      // BUG-020: route pause / resume / cancel through DeskService (keeps root guard, project lifecycle & cards in sync).
      const r = await desk.cellControl(id, { action }, as(principalId));
      if (!r.ok) return fail(`Not applied: ${r.message}`, { applied: false, outcome: r.outcome });
      const what: Record<"pause" | "resume" | "cancel", string> = {
        pause: "it and everything below it are paused",
        resume: "it continues",
        cancel: "it and everything below it are stopped and closed (files and branches are left as they are)",
      };
      const epoch = kernel.getCell(id)?.epoch;
      return ok(`${action} applied to ${id}: ${what[action]}（${r.message}）.`, { applied: true, outcome: r.outcome, ...(epoch !== undefined ? { epoch } : {}) });
    },
  };

  /** A person's message to a cell (message_cell / control_cell message|steer), told to the agent in plain words. */
  function deliveredToCell(id: string, d: Delivery, mode: "enqueue" | "steer", notifyParent: "silent" | "wakeup" | undefined): AgentToolResult {
    const data = { outcome: d.outcome, messageId: d.id, ccTo: d.ccTo };
    switch (d.outcome) {
      case "not_found":
        return fail(`Not delivered: there is no cell "${id}". Check the id with get_project or workbench_overview.`, data);
      case "refused_script":
        return fail(`Not delivered: ${id} is a deterministic script probe, not a model — it takes no conversation. control_cell can pause or resume it; to change what it checks, tell its project or the desk.`, data);
      case "refused_archived":
        return fail(
          `Not delivered: ${id} was archived with a project that has finished, so it cannot be brought back. To continue that work, chat_with_desk (or create_project) naming what it did — inspect_cell ${id} shows it.`,
          data,
        );
      case "duplicate":
        return ok(`Already delivered earlier (same message); not sent again.`, data);
      default: {
        const before = d.before;
        let what: string;
        if (d.outcome === "reopened") what = `${id} had been closed and was brought back for this: it continues on its previous record (no new cell).`;
        else if (mode === "steer") what = `${id} was interrupted with it: it sees it now, between its steps.`;
        else if (before?.state === "paused") what = `${id} is paused: it reads it when it is resumed.`;
        else if (before?.state === "running") what = `${id} is at work: it takes the message when its current step ends.`;
        else if (before?.state === "dormant") what = `${id} was dormant and is woken by it, on its previous record (no new cell).`;
        else what = `${id} reads it at its next turn.`;
        const cc = d.ccTo
          ? ` Its project ${d.ccTo}${d.ccTitle ? `「${d.ccTitle}」` : ""} was given a copy of the owner's words${notifyParent === "wakeup" ? " and woken" : " (it reads it at its next wake-up; it is not woken for it)"}.`
          : "";
        return ok(`Delivered (message ${d.id}). ${what}${cc} Results arrive asynchronously — look later with get_cell / inspect_cell ${id}.`, data);
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
    tools: () => AGENT_TOOLS,
    async call(name, rawArgs, principalId) {
      const doc = docs.get(name);
      const handler = handlers[name];
      if (!doc || !handler) {
        return fail(`Unknown tool "${name}". Available: ${AGENT_TOOLS.map((t) => t.name).join(", ")}.`);
      }
      const given: Args = {};
      for (const [k, v] of Object.entries(rawArgs ?? {})) if (v !== null && v !== undefined) given[k] = v;
      const args = normalizeArgs(doc, given);
      const invalid = validateArgs(doc, args);
      if (invalid) return fail(invalid);
      try {
        return await handler(args, principalId);
      } catch (err) {
        // Caller mistakes and refusals are answers, not server errors.
        if (err instanceof DeskError) return fail(`${err.status === 404 ? "Not found" : err.status === 409 ? "Not possible now" : "Not accepted"}: ${err.message}`, { code: err.code });
        if (isNgError(err, "bounds_violation")) return fail(`Not allowed for an agent: ${err.message}. If the owner wants this, they do it themselves in the workbench UI.`, { code: err.code });
        if (isNgError(err, "not_found")) return fail(`Not found: ${err.message}`, { code: err.code });
        if (isNgError(err, "invalid_argument") || isNgError(err, "conflict") || isNgError(err, "duplicate") || isNgError(err, "stale_epoch") || isNgError(err, "unsupported")) {
          return fail(`Not done: ${err.message}`, { code: err.code });
        }
        throw err;
      }
    },
  };
}
