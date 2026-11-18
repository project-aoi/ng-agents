import type { CellSpecInput, Kernel } from "@ng/cell";
import type { UiChannel } from "@ng/channel";
import { ownerOnlyApproval } from "@ng/gate";
import { ROLES, startProjectSync, type ProjectInit, type ProjectMode } from "@ng/presets";
import {
  CELL_STATUS_KEY,
  createEnvelope,
  gtdKeys,
  inboxAddr,
  isNgError,
  newId,
  PAYLOAD,
  type ActionRecord,
  type ApprovalRecord,
  type BallOwner,
  type CellStatusLine,
  type ProjectRecord,
  type SendToCellResult,
  type UserMessagePayload,
} from "@ng/protocol";
import type { ClarifyCardDTO, EngageItemDTO, ProjectRowDTO } from "../shared/api";
import { DeskError, type Desk, type DeskActor, type ProjectOp } from "../server/desk";
import { inputOf, projectOfAction, readActions, readProjects, type DeskSettings, type Located } from "../server/projections/common";
import { projectClarify } from "../server/projections/clarify";
import { projectEngage } from "../server/projections/engage";
import { AGENT_TOOLS, type AgentToolDoc } from "./guide";
import type { AgentControlPlane, AgentToolResult } from "./routes";

// docs/05 §5.3 — the external main agent's control plane: every tool of guide.ts, run as the caller's `agent:<id>`
// principal. Reads go through the same projections as the web client; changes go through the same Desk functions as
// the Radar / Engage / Clarify buttons (parameterised by the principal) or straight to the kernel as that principal.
// The kernel and the Gate decide what an agent may do; this file only turns their answers into plain text.

export interface AgentControlPlaneDeps {
  kernel: Kernel;
  desk: Desk;
  ui: UiChannel;
  settings: DeskSettings;
}

type Args = Record<string, unknown>;
type Principal = `agent:${string}`;
type Handler = (args: Args, principalId: Principal) => Promise<AgentToolResult> | AgentToolResult;

/** The `text` an agent reads for an owner-only card (outgoing send, exhausted budget). */
export function ownerOnlyText(cardId: string, why: string): string {
  return `Refused: only the owner can decide card ${cardId} (${why}). You may not approve or continue it on their behalf, even on their say-so. Tell the owner to confirm it themselves in the workbench UI (待确认 / Clarify). The card is still pending.`;
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
  const { kernel, desk, settings } = deps;
  const { context, gate, clock } = kernel;
  const deskId = kernel.deskCellId;
  const docs = new Map(AGENT_TOOLS.map((t) => [t.name, t]));
  const now = () => clock.now();
  const as = (principalId: Principal, note?: string): DeskActor => ({ principalId, ...(note ? { note } : {}) });

  // ---------- shared readers ----------

  function projectRecordOf(id: string): ProjectRecord | null {
    const v = context.readStateSync<ProjectRecord>(id, gtdKeys.project);
    return v && typeof v === "object" && typeof v.title === "string" ? v : null;
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

  function ownerOnlyOf(rec: ApprovalRecord): string | null {
    return ownerOnlyApproval({ ...rec.action, card: rec.card }, kernel.ownerAddresses);
  }

  function cardKind(c: ClarifyCardDTO): string {
    if (c.cardType === "response") {
      if (c.reply?.confirmVerb === "accept") return "结果请主人过目";
      if (c.reply?.confirmVerb === "merge") return `合入确认（${c.reply.targetLabel}）`;
      return `对外回复，发给 ${c.reply?.targetLabel ?? "对方"}`;
    }
    if (c.cardType === "project_proposal") return "立项方案";
    if (c.cardType === "escalation") return c.escalation ? `受阻：${c.escalation.reasonLabel}` : "受阻";
    return "需要确认";
  }

  function cardLine(c: ClarifyCardDTO): { line: string; data: Record<string, unknown> } {
    const rec = gate.getApprovalSync(c.id);
    const why = rec ? ownerOnlyOf(rec) : null;
    const ask = c.escalation?.explanation ?? c.proposal?.outcome ?? (c.draft ? oneLine(c.draft.body, 120) : c.prep.summary);
    const line = `- ${c.id}「${c.title}」 ${cardKind(c)}${c.projectId ? `，项目 ${c.projectId}` : ""}${c.state !== "pending" ? `，状态 ${c.state}` : ""}${ask ? ` — ${oneLine(ask, 140)}` : ""}${why ? ` [ownerOnly：${why}]` : ""}`;
    return {
      line,
      data: {
        id: c.id,
        title: c.title,
        cardType: c.cardType,
        kind: cardKind(c),
        state: c.state,
        projectId: c.projectId,
        ask: ask ?? null,
        ownerOnly: why !== null,
        ...(why ? { ownerOnlyReason: why } : {}),
        createdAt: c.createdAt,
      },
    };
  }

  function humanLine(i: EngageItemDTO): string {
    const due = i.dueAt !== null ? `，到期 ${isoMin(i.dueAt)}${i.overdue ? "（已超时）" : ""}` : "";
    const where = i.project ? `项目 ${i.project.id}「${i.project.title}」` : "随手待办";
    return `- ${i.actionId}「${i.title}」${i.nextStep && i.nextStep !== i.title ? ` — 下一步：${oneLine(i.nextStep, 120)}` : ""}（${where}${due}）`;
  }

  function projectLine(p: ProjectRowDTO): string {
    const parts: string[] = [];
    if (p.ball) parts.push(`球在：${OWNER_TEXT[p.ball.owner]} · ${oneLine(p.ball.text, 100)}`);
    else parts.push("没有未完成的动作");
    if (p.summary) parts.push(`摘要：${oneLine(p.summary, 120)}`);
    if (p.cwd) parts.push(`目录 ${p.cwd}`);
    if (p.workers.length) parts.push(`${p.workers.length} 个后台分身（${p.workers.filter((w) => w.state === "running").length} 个在跑）`);
    if (p.pendingCardId) parts.push(`有卡 ${p.pendingCardId} 待确认`);
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

  function workspaceLines(): { lines: string[]; data: unknown[] } {
    const occ = kernel.activeWorkspaces();
    const who = (u: { cellId: string; title: string | null; state: string; cwdMode: string }) => `${u.cellId}${u.title ? `「${u.title}」` : ""}`;
    const lines = occ.map((o) => {
      const parts: string[] = [];
      parts.push(o.holder ? `写入中：${who(o.holder)}（${o.holder.state}）` : "没有人在写");
      if (o.queued.length) parts.push(`排队：${o.queued.map(who).join("、")}`);
      const sleeping = o.others.filter((u) => u.cwdMode === "write");
      if (sleeping.length) parts.push(`有写权限但在休眠：${sleeping.map((u) => `${who(u)}（${u.state}）`).join("、")}`);
      const readers = o.others.filter((u) => u.cwdMode === "read");
      if (readers.length) parts.push(`只读：${readers.map(who).join("、")}`);
      return `- ${o.key} — ${parts.join("；")}`;
    });
    return { lines, data: occ };
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
          `Not delivered: project ${id} has already finished${r.closeReason ? ` (${r.closeReason})` : ""}. To continue the same subject, create_project with a brief that names what the old project delivered (read_artifact the reports first) so nothing is redone.${named}`,
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
      const rec = isProject ? projectRecordOf(id) : null;
      return rec?.lifecycle === "someday"
        ? `Delivered to ${id}, but it is parked ("someday"): it reads this when it is activated. To have it act now, set_project_state ${id} activate (with the owner's words as note).`
        : `Delivered to ${id}, but it is paused: it reads this when it is resumed (set_project_state / control_cell resume).`;
    }
    return `Delivered to ${id} (message ${r.envelopeId}); it reads it at its next turn${isProject ? " and acts on it with a new worker if needed" : ""}. Results arrive asynchronously — check later with ${isProject ? "get_project" : "get_cell"}.`;
  }

  // ==================== tools ====================

  const handlers: Record<string, Handler> = {
    workbench_overview(args) {
      const input = inputOf(kernel, settings);
      const engage = projectEngage(input);
      const clarify = projectClarify(input);
      const radar = desk.radar();
      const human = engage.items.map((i) => ({ line: humanLine(i), data: { id: i.actionId, cellId: i.cellId, title: i.title, nextStep: i.nextStep, projectId: i.project?.id ?? null, dueAt: i.dueAt, overdue: i.overdue } }));
      const cards = clarify.cards.map(cardLine);
      const running = runningLines();
      const ws = workspaceLines();
      const parts = [
        section("需要主人处理", human.map((h) => h.line)),
        section("待确认卡片", cards.map((c) => c.line)),
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
      if (clarify.snoozed > 0) parts.push(`另有 ${clarify.snoozed} 张卡被推迟，到点会回到待确认。`);
      return ok(`工作台概览（${isoMin(now())}）\n\n${parts.join("\n\n")}`, {
        generatedAt: now(),
        humanActions: human.map((h) => h.data),
        cards: cards.map((c) => c.data),
        projects: radar.projects.map(projectData),
        parked: radar.someday.map(projectData),
        running: running.data,
        workspaces: ws.data,
        snoozedCards: clarify.snoozed,
        ...(finished ? { finished } : {}),
      });
    },

    capture(args, principalId) {
      const text = str(args["text"])!;
      // The owner's words, delivered to the desk the way 随手记 delivers them (from the owner's own ui address, so the
      // desk files it as the owner's item and its answers go back to the owner), but signed by the agent.
      const owner = "channel:ui:owner" as const;
      const payload: UserMessagePayload = { text, replyTo: owner, sender: { id: principalId, displayName: "主 Agent" } };
      const env = createEnvelope<UserMessagePayload>(
        { id: newId("agcap", clock), from: owner, to: inboxAddr(deskId), principalId, kind: "event", type: PAYLOAD.userMessage, payload },
        clock,
      );
      kernel.inbox.enqueueSync(deskId, env);
      return ok(
        `Handed to the desk (message ${env.id}). It triages it in the background: a note or a reminder is filed at once, a message to answer becomes a card, a task may become a project. Nothing more to do now; the result shows up in workbench_overview.`,
        { envelopeId: env.id },
      );
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
        r = startProjectSync(kernel, init, { principalId });
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
      const live = ids.filter((cid) => cid !== id && kernel.getCell(cid)?.status !== "closed");
      const waits = kernel.listWaits(ids.filter((cid) => kernel.getCell(cid)?.status !== "closed"));
      const running = new Set(kernel.activeRuns().map((r) => r.cellId));
      const artifacts = ids.flatMap((cid) => context.listArtifactsSync(cid)).sort((a, b) => b.updatedAt - a.updatedAt);
      const cards = gate.listPendingSync({ includeSnoozed: true }).filter((r) => ids.includes(r.cellId) || r.subjectKey === `project:${id}`);
      const anchors = cell && cell.status !== "closed" ? kernel.anchorsOf(id) : null;
      const state = cell?.status === "closed" ? `cell closed (${cell.closeReason ?? "?"})` : cell?.status === "paused" ? "paused" : "active";
      const actionLine = (a: Located<ActionRecord>) => {
        const r = a.record;
        const carrier = r.cellId ? `，由 ${r.cellId} 承担` : "";
        return `- ${r.id}「${r.title}」${OWNER_TEXT[r.owner]}，${r.status}${carrier}${r.nextStep && r.nextStep !== r.title ? ` — 下一步：${oneLine(r.nextStep, 120)}` : ""}${r.dueAt ? `，到期 ${isoMin(r.dueAt)}` : ""}`;
      };
      const cellLines = live.map((cid) => {
        const c = kernel.getCell(cid)!;
        const w = waits.filter((x) => x.cellId === cid).map((x) => x.waitingFor);
        const st = running.has(cid) ? "running" : c.status === "paused" ? "paused" : w.length ? `waiting for ${w.join(", ")}` : "asleep";
        const line = statusLineOf(cid);
        return `- ${cid}${c.title ? `「${c.title}」` : ""}（${c.preset ?? "cell"}，${st}${c.spec.cwd ? `，目录 ${c.spec.cwd}` : ""}）${line ? ` — ${oneLine(line, 120)}` : ""}`;
      });
      const ownWaits = waits.filter((w) => w.cellId === id).map((w) => `${w.waitingFor}（${oneLine(w.reason, 80)}）`);
      const head = [
        `项目 ${id}「${record.title}」`,
        `状态：${record.lifecycle}；${state}${row?.stalled || record.stalledSince ? `；⚠ 停滞（自 ${isoMin(record.stalledSince)}）` : ""}`,
        `目标：${record.outcome ?? "—"}`,
        `摘要：${record.summary ?? "—"}`,
        `目录：${record.cwd ?? cell?.spec.cwd ?? "—"}`,
        `来源：${record.source?.label ?? "—"}；创建 ${isoMin(record.createdAt)}；更新 ${isoMin(record.updatedAt)}`,
        ...(row?.ball ? [`球在：${OWNER_TEXT[row.ball.owner]} · ${oneLine(row.ball.text, 120)}`] : []),
        ...(ownWaits.length ? [`项目本身在等：${ownWaits.join("；")}`] : []),
        ...(anchors?.stalled ? [`为什么停滞：${anchors.detail}`] : []),
      ];
      const text = [
        head.join("\n"),
        section("未完成的动作", open.map(actionLine)),
        ...(closed.length ? [section("最近完成/取消的动作", closed.map(actionLine))] : []),
        section("正在为它工作的分身", cellLines),
        section("报告与草稿", artifacts.map((a) => `- ${a.artifactId} v${a.version}${a.content.title ? `「${a.content.title}」` : ""}（${a.content.format}，${a.updatedBy} 更新于 ${isoMin(a.updatedAt)}）`)),
        section("待确认卡片", cards.map((r) => `- ${r.actionId}「${r.card.title ?? r.action.summary}」${ownerOnlyOf(r) ? " [ownerOnly]" : ""}${r.snoozedUntil && r.snoozedUntil > now() ? `（推迟到 ${isoMin(r.snoozedUntil)}）` : ""}`)),
      ].join("\n\n");
      return ok(text, {
        id,
        title: record.title,
        lifecycle: record.lifecycle,
        cellStatus: cell?.status ?? null,
        outcome: record.outcome ?? null,
        summary: record.summary ?? null,
        cwd: record.cwd ?? cell?.spec.cwd ?? null,
        stalled: Boolean(row?.stalled),
        stalledSince: record.stalledSince ?? null,
        ball: row?.ball ? { owner: row.ball.owner, text: row.ball.text } : null,
        actions: actions.map((a) => ({ id: a.record.id, cellId: a.cellId, title: a.record.title, owner: a.record.owner, status: a.record.status, nextStep: a.record.nextStep ?? null, carriedBy: a.record.cellId ?? null })),
        cells: live.map((cid) => ({ id: cid, title: kernel.getCell(cid)?.title ?? null, preset: kernel.getCell(cid)?.preset ?? null, status: kernel.getCell(cid)?.status, running: running.has(cid), waitingFor: waits.filter((w) => w.cellId === cid).map((w) => w.waitingFor), statusLine: statusLineOf(cid) })),
        waits: waits.map((w) => ({ cellId: w.cellId, waitingFor: w.waitingFor, reason: w.reason })),
        artifacts: artifacts.map((a) => ({ id: a.artifactId, title: a.content.title ?? null, version: a.version, cellId: a.cellId, updatedAt: a.updatedAt })),
        cards: cards.map((r) => ({ id: r.actionId, title: r.card.title ?? r.action.summary, ownerOnly: ownerOnlyOf(r) !== null })),
      });
    },

    message_project(args, principalId) {
      const id = str(args["id"])!;
      const text = str(args["text"])!;
      const record = projectRecordOf(id);
      if (!record && !kernel.getCell(id)) return noProject(id);
      if (args["urgent"] === true) {
        const cell = kernel.getCell(id);
        if (cell?.status === "closed") return sendFailure(id, { status: "closed", closeReason: cell.closeReason }, true);
        const r = kernel.control(id, { action: "steer", steerMessage: text }, { principalId });
        if (r.applied) return ok(`Passed to ${id} as an interruption: it takes it between its current steps.`, { applied: true });
        if (r.reason === "closed") return sendFailure(id, { status: "closed", closeReason: kernel.getCell(id)?.closeReason ?? null }, true);
        return fail(`Not passed on: ${r.reason ?? "refused"}.`, { applied: false, reason: r.reason ?? null });
      }
      const r = kernel.sendToCell(id, { text, summary: "主人的新要求（经主 Agent）", id: newId("agmsg", clock) }, { principalId });
      if (r.status !== "delivered") return sendFailure(id, r, true);
      return ok(deliveredText(id, r, true), r);
    },

    async set_project_state(args, principalId) {
      const id = str(args["id"])!;
      if (!projectRecordOf(id)) return noProject(id);
      const r = await desk.projectOp(id, args["state"] as ProjectOp, as(principalId, str(args["note"])));
      const extra = r.outcome === "migrated" && r.projectId ? ` The parked item came from an older version and could not be resumed: it continues as the new project ${r.projectId} (its plan and reports were handed over).` : "";
      return r.ok ? ok(`${r.message}${extra}`, { outcome: r.outcome, ...(r.projectId ? { projectId: r.projectId } : {}) }) : fail(`Not applied: ${r.message}`, { outcome: r.outcome });
    },

    async add_action(args, principalId) {
      const projectId = str(args["projectId"])!;
      if (!projectRecordOf(projectId)) return noProject(projectId);
      const owner = args["owner"] as "human" | "waiting";
      const nextStep = str(args["nextStep"]);
      const r = await desk.addProjectAction(projectId, { title: str(args["title"])!, owner, ...(nextStep ? { nextStep } : {}) }, as(principalId));
      return ok(
        `Recorded action ${r.actionId}「${str(args["title"])}」 on project ${projectId} (${owner === "human" ? "the owner's to-do" : "waiting"}); the project was told. ${owner === "human" ? "When the owner has done it, complete_action with what happened." : ""}`.trim(),
        { actionId: r.actionId },
      );
    },

    async complete_action(args, principalId) {
      const projectId = str(args["projectId"])!;
      const actionId = str(args["actionId"])!;
      if (!projectRecordOf(projectId)) return noProject(projectId);
      const actions = projectActionsOf(projectId);
      const a = actions.find((x) => x.record.id === actionId);
      if (!a) {
        const open = actions.filter((x) => x.record.status === "open").map((x) => `${x.record.id}「${x.record.title}」`);
        return fail(`Project ${projectId} has no action ${actionId}. Its open actions: ${open.join("; ") || "none"}.`);
      }
      if (a.record.status !== "open") return ok(`Action ${actionId}「${a.record.title}」 is already ${a.record.status}; nothing changed.`, { status: a.record.status });
      const note = str(args["note"]);
      const r = await desk.done(a.cellId, actionId, note ? { note } : {}, as(principalId));
      return ok(
        `Ticked off ${actionId}「${a.record.title}」 on project ${projectId}${note ? " with the note" : ""}; the project was told and continues with whatever waited on it.${r.closedTasks ? ` ${r.closedTasks} background cell(s) that existed only for it were closed.` : ""}`,
        { outcome: r.outcome, closedTasks: r.closedTasks ?? 0 },
      );
    },

    list_cards() {
      const clarify = projectClarify(inputOf(kernel, settings));
      const cards = clarify.cards.map(cardLine);
      const text = `${section("待确认卡片", cards.map((c) => c.line))}${clarify.snoozed ? `\n另有 ${clarify.snoozed} 张卡被推迟。` : ""}\nCards marked ownerOnly can only be decided by the owner in the workbench UI.`;
      return ok(text, { cards: cards.map((c) => c.data), snoozed: clarify.snoozed });
    },

    async decide_card(args, principalId) {
      const id = str(args["id"])!;
      const decision = args["decision"] as "approve" | "deny" | "continue" | "snooze" | "dismiss";
      const note = str(args["note"]);
      const rec = gate.getApprovalSync(id);
      if (!rec) return fail(`There is no card "${id}". Card ids come from list_cards / workbench_overview.`);
      if (rec.status !== "pending") return fail(`Card ${id} is no longer pending (${rec.status}); nothing to decide.`, { status: rec.status });
      const why = ownerOnlyOf(rec);
      if (why && (decision === "approve" || decision === "continue")) return fail(ownerOnlyText(id, why), { ownerOnly: true, reason: why });
      const actor = as(principalId, note);
      const title = rec.card.title ?? rec.action.summary;
      try {
        switch (decision) {
          case "approve": {
            // The tool has no version argument: the agent approves the draft as it stands now (what list_cards showed).
            const seen = rec.artifactId ? (context.getArtifactSync(rec.artifactId)?.version ?? null) : null;
            const r = await desk.approve(id, seen !== null ? { seenVersion: seen } : {}, actor);
            return r.ok ? ok(`Approved「${title}」: ${r.message}.`, { outcome: r.outcome }) : fail(`Not approved: ${r.message} (${r.outcome}).`, { outcome: r.outcome });
          }
          case "deny": {
            const r = await desk.deny(id, note ? { note } : {}, actor);
            return r.ok ? ok(`Denied「${title}」; whoever asked was told${note ? " why" : ""}.`, { outcome: r.outcome }) : fail(`Not denied: ${r.message}.`, { outcome: r.outcome });
          }
          case "continue": {
            const r = await desk.extend(id, note ? { note } : {}, actor);
            return r.ok ? ok(`Continued「${title}」: ${r.message}.`, { outcome: r.outcome }) : fail(`Not continued: ${r.message}.`, { outcome: r.outcome });
          }
          case "snooze": {
            const minutes = typeof args["minutes"] === "number" && args["minutes"] > 0 ? args["minutes"] : 120;
            const until = now() + Math.round(minutes * 60_000);
            const r = await desk.snooze(id, { until }, actor);
            return r.ok ? ok(`Snoozed「${title}」 until ${isoMin(until)}; it comes back to the owner's cards then.`, { outcome: r.outcome, until }) : fail(`Not snoozed: ${r.message}.`, { outcome: r.outcome });
          }
          case "dismiss": {
            const r = await desk.dismiss(id, note ? { note } : {}, actor);
            return r.ok ? ok(`Took down「${title}」 without an answer (archived; the owner can move it back).`, { outcome: r.outcome }) : fail(`Not dismissed: ${r.message}.`, { outcome: r.outcome });
          }
        }
      } catch (err) {
        if (isNgError(err, "bounds_violation")) return fail(ownerOnlyText(id, why ?? err.message), { ownerOnly: true, reason: err.message });
        throw err;
      }
    },

    read_artifact(args) {
      const id = str(args["id"])!;
      const a = context.getArtifactSync(id);
      if (!a) return fail(`There is no artifact "${id}". Artifact ids come from get_project or search.`);
      const head = `artifact ${a.artifactId} v${a.version}${a.content.title ? `「${a.content.title}」` : ""} — ${a.content.format}，${a.updatedBy} 更新于 ${isoMin(a.updatedAt)}，属于 ${a.cellId}`;
      return ok(`${head}\n---\n${a.content.body}`, { id: a.artifactId, version: a.version, title: a.content.title ?? null, format: a.content.format, cellId: a.cellId, updatedBy: a.updatedBy, updatedAt: a.updatedAt, body: a.content.body });
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

    save_preference(args) {
      const name = str(args["name"])!;
      const text = str(args["text"])!;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return fail(`name must be a short slug (letters, digits, "-", "_", "."), e.g. "code-change-followup"; got "${name}".`);
      const existed = context.getKnowledgeSync({ kind: "preference", name, scope: "global" }) !== null;
      context.upsertSkillOrNoteSync(deskId, { kind: "preference", name, description: oneLine(text.split("\n")[0], 120), body: text, scope: "global", mode: "upsert" });
      return ok(`${existed ? "Replaced" : "Saved"} the global preference "${name}": every background agent sees it from its next turn on.`, { name, replaced: existed });
    },

    list_preferences() {
      const prefs = context.listKnowledgeSync({ kind: "preference", includeGlobal: true }).filter((k) => k.scope === "global");
      const skills = context.listKnowledgeSync({ kind: "skill", includeGlobal: true }).filter((k) => k.scope === "global");
      const prefLines = prefs.map((k) => `- ${k.name}（${isoMin(k.updatedAt)}）: ${k.body.replace(/\s+/g, " ").trim()}`);
      const skillLines = skills.map((k) => `- ${k.name}: ${k.description}`);
      return ok(`${section("主人的长期偏好", prefLines)}\n\n${section("做事手册（skills）", skillLines)}\nTo change a preference, save_preference under the same name.`, {
        preferences: prefs.map((k) => ({ name: k.name, text: k.body, updatedAt: k.updatedAt })),
        skills: skills.map((k) => ({ name: k.name, description: k.description })),
      });
    },

    list_workspaces() {
      const ws = workspaceLines();
      return ok(`${section("工作目录占用", ws.lines)}\nOne writer per work tree at a time; others are queued by the kernel. Do not change a directory yourself while a cell is writing there.`, { workspaces: ws.data });
    },

    get_cell(args) {
      const id = str(args["id"])!;
      const c = kernel.getCell(id);
      if (!c) return fail(`There is no cell "${id}".`);
      const n = typeof args["tail"] === "number" ? Math.max(0, Math.min(100, Math.floor(args["tail"]))) : 12;
      const waits = kernel.listWaits([id]);
      const running = kernel.activeRuns().some((r) => r.cellId === id);
      const children = kernel.listCells({ parentId: id });
      const cards = gate.listPendingSync({ includeSnoozed: true }).filter((r) => r.cellId === id);
      const project = projectRecordOf(id);
      const tail = n > 0 ? evidenceTail(id, n) : [];
      const head = [
        `cell ${id}${c.title ? `「${c.title}」` : ""} — ${c.preset ?? "cell"}，${c.status}${c.closeReason ? `（${c.closeReason}）` : ""}${running ? "，running" : ""}，epoch ${c.epoch}`,
        `父节点：${c.parentId ?? "—"}；目录：${c.spec.cwd ?? "（继承 / 默认）"}（${c.spec.cwdMode ?? "preset default"}）；lifetime ${c.spec.lifetime ?? "persistent"}`,
        `状态行：${statusLineOf(id) ?? "—"}`,
        `在等：${waits.length ? waits.map((w) => `${w.waitingFor}（${oneLine(w.reason, 80)}${w.timeoutAt ? `，${isoMin(w.timeoutAt)} 超时` : ""}）`).join("；") : "—"}`,
        ...(project ? [`持有项目记录：${project.lifecycle}「${project.title}」`] : []),
        ...(cards.length ? [`待确认卡片：${cards.map((r) => r.actionId).join(", ")}`] : []),
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
        cwdMode: c.spec.cwdMode ?? null,
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
      const cwdMode = str(args["cwdMode"]) as "read" | "write" | undefined;
      const parentId = str(args["parentId"]) ?? deskId;
      const parent = kernel.getCell(parentId);
      if (!parent) return fail(`There is no cell "${parentId}" to attach it to.`);
      if (parent.status === "closed") return fail(`Cell ${parentId} has closed; attach the new cell elsewhere (default: the desk).`);
      let cellId: string;
      try {
        if (preset === "project") {
          cellId = startProjectSync(kernel, { title, outcome: title, brief: instruction, source: { label: "主 Agent", principalId, at: now() }, ...(cwd ? { cwd } : {}) }, { principalId, parentId }).projectId;
        } else {
          const spec: CellSpecInput = { preset: preset as NonNullable<CellSpecInput["preset"]>, title };
          if (cwd) spec.cwd = cwd;
          if (cwdMode) spec.cwdMode = cwdMode;
          if (preset === "hub") spec.meta = { role: ROLES.hub, gtd: { source: { title, description: instruction, kind: "channel", mode: "active", processor: "llm" } } };
          const addr = kernel.spawnCell(parentId, spec, { instruction, title }, { principalId });
          cellId = addr.slice("inbox:".length);
        }
      } catch (err) {
        if (isNgError(err, "invalid_argument") && /\bcwd\b|directory|path/i.test(err.message)) {
          return fail(`Not started: ${err.message}. Ask the owner for the correct absolute path; never guess one.`);
        }
        throw err;
      }
      return ok(
        `Started ${preset} ${cellId}「${title}」 under ${parentId}. It runs in the background${preset === "worker" ? ", reports once and closes" : ""}; look at it with get_cell ${cellId}${preset === "project" ? ` or get_project ${cellId}` : ""}.`,
        { cellId, parentId, preset },
      );
    },

    control_cell(args, principalId) {
      const id = str(args["id"])!;
      const action = args["action"] as "message" | "steer" | "pause" | "resume" | "cancel";
      const text = str(args["text"]);
      const isProject = projectRecordOf(id) !== null;
      if ((action === "message" || action === "steer") && !text) return fail(`control_cell ${action} needs text: what to tell the cell.`);
      if (action === "message") {
        const r = kernel.sendToCell(id, { text: text!, summary: "主 Agent 的消息", id: newId("agmsg", clock) }, { principalId });
        if (r.status !== "delivered") return sendFailure(id, r, isProject);
        return ok(deliveredText(id, r, isProject), r);
      }
      const cell = kernel.getCell(id);
      if (!cell) return sendFailure(id, { status: "not_found" }, isProject);
      if (cell.status === "closed") {
        if (action === "cancel") return ok(`${id} had already closed (${cell.closeReason ?? "?"}); nothing to cancel.`, { applied: false, reason: "closed" });
        return sendFailure(id, { status: "closed", closeReason: cell.closeReason }, isProject);
      }
      const r = kernel.control(id, { action, ...(action === "steer" ? { steerMessage: text! } : {}) }, { principalId });
      if (!r.applied) return fail(`Not applied: ${r.reason ?? "refused"}.`, { applied: false, reason: r.reason ?? null });
      const what: Record<"steer" | "pause" | "resume" | "cancel", string> = {
        steer: "it takes the correction between its current steps",
        pause: "it and everything below it are paused",
        resume: "it continues",
        cancel: "it and everything below it are stopped and closed (files and branches are left as they are)",
      };
      return ok(`${action} applied to ${id}: ${what[action]}.`, { applied: true, epoch: r.epoch });
    },
  };

  /** The last `n` evidence records of a cell, briefly: kind, tool name, the first ~200 characters. */
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
      const brief = oneLine(text, 200);
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
