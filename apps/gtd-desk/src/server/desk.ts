import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CaptureAssetStore } from "./capture-assets";
import { captureAssetId, CAPTURE_ASSET_PREFIX, MAX_CAPTURE_IMAGES, type CaptureImageUpload } from "../shared/capture-assets";
import { createModelSwitch } from "./models";
import type { UpdateModelsRequest } from "../shared/api";
import { isRunnerOverride, type HumanDecision, type HumanItem, type CardOption, type RunnerOverride } from "@ng/protocol";
import { isProjectRoot, type Kernel } from "@ng/cell";
import type { UiChannel } from "@ng/channel";
import {
  createSensorSpec,
  gtdKeys,
  RESTORE_REASON,
  sensorProcessor,
  notifyProjectOfOwnerChangeSync,
  projectIdForApproval,
  startProjectSync,
  writeActionRecordSync,
  type ProjectInit,
} from "@ng/presets";
import type { ProjectRecord, SourceState } from "@ng/presets/records";
import {
  all,
  asDecisionCard,
  acceptsApprovalDraft,
  isProjectProposal,
  get,
  createEnvelope,
  inboxAddr,
  isEnvelopeOfType,
  KERNEL_FROM,
  newId,
  NgError,
  PAYLOAD,
  projectCellIdOf,
  parsePrincipal,
  subjectKeys,
  stableStringify,
  withTx,
  type ActionRecord,
  type ApprovalRecord,
  type BallOwner,
  type DecisionCard,
  type Effort,
  type Envelope,
  type HandbackPayload,
  type ProjectProposal,
} from "@ng/protocol";
import type {
  ActivityKind,
  ActivityMutationResponse,
  AddActionRequest,
  ArtifactDTO,
  ArtifactSaveRequest,
  ArtifactSaveResponse,
  CaptureRequest,
  CaptureResponse,
  CreateSourceRequest,
  PlanSaveRequest,
  PlanSaveResponse,
  ProjectMutationResponse,
  ProjectOutcome,
  RadarDTO,
  ReviewMutationResponse,
  SensorToCodeRequest,
  SourceModeRequest,
  SourcesDTO,
  SourcesMutationResponse,
  StatusDTO,
  WeeklyReviewDTO,
  ActivityListDTO,
} from "../shared/api";
import {
  inputOf,
  projectOfAction,
  readActions,
  readActivities,
  readProjects,
  SENSOR_SUGGESTION_PREFIX,
  SKILL_SUGGESTION_PREFIX,
  type DeskSettings,
  type Located,
  type SkillSuggestion,
} from "./projections/common";
import { artifactDTO, artifactEditorKey, localTime as localTimeOf, pauseInfoOf } from "./projections/format";
import { projectRadar } from "./projections/radar";
import { projectReview } from "./projections/review";
import { projectStatus } from "./projections/status";
import { unpromptedDeskWords } from "./projections/desk-words";
import { projectSources } from "./projections/sources";
import { projectActivity } from "./projections/activity";
import { createAgentsApi } from "./agents";
import { workTreeText } from "./work-trees";


/** An HTTP-mappable failure: bad input (400), unknown id (404), wrong state (409). */
export class DeskError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeskError";
  }
}

const bad = (message: string) => new DeskError(400, "invalid_argument", message);
const missing = (message: string) => new DeskError(404, "not_found", message);
const wrongState = (message: string) => new DeskError(409, "conflict", message);

/** What the desk tells the desk cell when the owner moves an archived item back to the desk. */

export interface DeskDeps {
  kernel: Kernel;
  ui: UiChannel;
  assets?: CaptureAssetStore;
  settings: DeskSettings;
  /** Background follow-ups that failed after the owner's action itself succeeded. Default: console.error. */
  onError?: (err: unknown, where: string) => void;
}

/**
 * Who presses the button. Every mutating desk call requires an explicit `principalId` (the web client passes the
 * owner principal; the external main agent's control plane passes its own `agent:<id>` principal). Never fall back
 * silently to the owner when a caller omits identity.
 */
export interface DeskActor {
  principalId: string;
  /** The owner's words that go with the operation (passed on to the project, e.g. on "activate"). */
  note?: string;
}

export type ProjectOp = "pause" | "resume" | "cancel" | "complete" | "someday" | "activate";

export type Desk = ReturnType<typeof createDesk>;

/**
 * The synchronous transaction API behind the endpoints (docs/04 "同步事务接口"): each method calls Context / Gate /
 * Inbox / kernel directly and answers with the refreshed view. Messages to a Loop: capture, revise and "交回主台" go
 * to the desk; a change the owner makes to a project's books (an action ticked off, taken over or added, the project
 * brought back from someday) is told to that project cell (docs/05), so it wakes and decides what comes next.
 * Approvals the kernel hands back to a cell are the kernel's business. The project and card operations take a
 * DeskActor: the external main agent's control plane calls them as `agent:<id>`.
 */
export function createDesk({ kernel, ui, assets, settings, onError = (err, where) => console.error(`[desk] ${where}:`, err) }: DeskDeps) {
  const { context, gate, clock } = kernel;
  const owner = kernel.ownerPrincipal;
  const desk = kernel.deskCellId;
  const models = createModelSwitch(kernel);
  const input = () => inputOf(kernel, settings);
  const now = () => clock.now();
  const isEffort = (s: unknown): s is Effort => s === "15m" || s === "45m" || s === "low_energy";

  // ==================== reads ====================

  // Status and Radar show the kernel's stall stamps (docs/05 guard 2); the check runs right after every change, but a
  // request that follows a change synchronously could otherwise see the previous stamp.
  const status = (): StatusDTO => {
    restamp();
    const model = models.label();
    return { ...projectStatus(input()), backend: kernel.agentBackend ?? settings.backend, ...(model ? {model} : {}) };
  };
  const radar = (): RadarDTO => {
    restamp();
    return projectRadar(input());
  };
  const review = (): WeeklyReviewDTO => projectReview(input());
  const sources = (): SourcesDTO => projectSources(input());
  const activity = (kind?: ActivityKind): ActivityListDTO => projectActivity(input(), kind);
  function artifact(artifactId: string): ArtifactDTO {
    const a = artifactDTO(kernel, artifactId, now());
    if (!a) throw missing("这份草稿已移除");
    return a;
  }

  // ==================== record helpers ====================

  function commitState(cellId: string, patches: Record<string, unknown>): void {
    const r = context.commitSync(cellId, { statePatches: patches });
    if (!r.ok) throw new Error("state commit unexpectedly rejected");
  }

  /** Marks open actions finished; returns how many changed. */
  function finishActions(actions: Iterable<Located<ActionRecord>>, statusTo: "done" | "cancelled"): number {
    const t = now();
    return withTx(kernel.db, () => {
      let count = 0;
      for (const action of actions) {
        if (action.record.status !== "open") continue;
        writeActionRecordSync(kernel, action.cellId, {
          ...action.record, status: statusTo, updatedAt: t, ...(statusTo === "done" ? { completedAt: t } : {}),
        });
        count++;
      }
      return count;
    });
  }

  function principalOf(as: DeskActor): string {
    if (!as || typeof as.principalId !== "string" || !as.principalId.trim()) {
      throw bad("缺少操作者身份");
    }
    const id = as.principalId.trim();
    const actor = parsePrincipal(id, owner);
    if (actor.kind !== "owner" && actor.kind !== "agent") throw new NgError("bounds_violation", "此身份不能操作工作台");
    return id;
  }
  const actorOf = (as: DeskActor) => ({ principalId: principalOf(as) });
  const byAgent = (as: DeskActor) => principalOf(as) !== owner;
  function seenRevisionOf(v: number | null | undefined): number {
    if (v == null) throw bad("请核对页面上显示的事项版本");
    if (!Number.isInteger(v) || v < 1) throw bad("事项版本必须是正整数");
    return v;
  }

  /**
   * docs/05: the owner changed a project's books from outside (ticked off their action, added a step): the project is
   * told in plain words, as whoever acted, so it wakes and decides what comes next — its wait on "human" is answered by
   * it. A paused project reads it when it is resumed. In the caller's transaction.
   */
  function tellProject(projectCellId: string, text: string, as: DeskActor): void {
    notifyProjectOfOwnerChangeSync(kernel, projectCellId, text, { principalId: principalOf(as), id: newId("own", clock) });
  }

  /** The words a project hears: "主人…" from the UI, "主人（经编码助手）…" from the control plane. */
  const whoText = (as: DeskActor) => (byAgent(as) ? "主人（经编码助手）" : "主人");

  const localTime = (ms: number) => localTimeOf(ms, settings.timeZone);

  /** The directories a project and its open cells work in. */
  function projectDirs(projectId: string): string[] {
    const ids = [projectId];
    for (let i = 0; i < ids.length; i++) for (const c of kernel.listCells({ parentId: ids[i]! })) if (c.status !== "closed") ids.push(c.id);
    return [...new Set(ids.flatMap((id) => kernel.getCell(id)?.spec.cwd ?? []))];
  }

  /**
   * Where a project that is stopped part-way leaves its work trees: the owner's repository may sit on a feature branch
   * with half-done changes, and nothing else tells them.
   */
  async function stopped(projectId: string, outcome: ProjectOutcome, message: string): Promise<ProjectMutationResponse> {
    const workTrees = (await Promise.all(projectDirs(projectId).map(workTreeText))).filter((t) => t !== null);
    return projectResult(outcome, true, `${message}${workTrees.length ? `。仓库留在原样：${workTrees.join("；")}` : ""}`, { workTrees });
  }

  const pauseInfo = (cellId: string) => pauseInfoOf(kernel, cellId, settings.timeZone);

  /** The GTD records changed here: re-run the kernel's stall check now, so the view answered with is current. */
  function restamp(): void {
    try {
      kernel.checkStalls();
    } catch (err) {
      onError(err, "stall check");
    }
  }

  /** The inbound message an item came from (unwrapping handbacks), if the inbox still has it. */
  function originalEnvelope(envelopeId: string | undefined): Envelope | null {
    if (!envelopeId) return null;
    const [m] = kernel.inbox.listMessagesSync({ envelopeId, limit: 1 });
    if (!m) return null;
    return isEnvelopeOfType(m.envelope, "handback") ? m.envelope.payload.original : m.envelope;
  }

  function itemAttachments(item: HumanItem) {
    if (!item.source?.envelopeId) return undefined;
    const id = item.source.envelopeId;
    const [message] = item.cellId ? kernel.inbox.listMessagesSync({cellId:item.cellId, envelopeId:id, limit:1}) : [];
    const original = message ?? (item.cellId !== desk ? kernel.inbox.listMessagesSync({cellId:desk, envelopeId:id, limit:1})[0] : undefined);
    if (!original) return undefined;
    const env = isEnvelopeOfType(original.envelope, "handback") ? original.envelope.payload.original : original.envelope;
    if (!isEnvelopeOfType(env, "user.message")) return undefined;
    return env.payload.attachments?.map(({label,uri}) => ({label,uri}));
  }

  // ==================== top bar ====================

  function captureRecord(id:string): Envelope | undefined {
    // The normal UI path uses the existing (cell_id,envelope_id) index. Watched ingress can route away from Desk.
    return kernel.inbox.listMessagesSync({cellId:desk,envelopeId:id,limit:1})[0]?.envelope ??
      kernel.inbox.listMessagesSync({envelopeId:id,limit:1})[0]?.envelope;
  }
  function sameCapture(requested: Omit<Envelope,"to">, recorded: Envelope) {
    const content=(env:Omit<Envelope,"to">)=>({type:env.type,from:env.from,principalId:env.principalId,payload:env.payload,threads:env.threads ?? []});
    if (stableStringify(content(requested)) !== stableStringify(content(recorded)))
      throw new DeskError(409,"capture_conflict","此提交标识已用于其他内容，请核对上次提交并为修改后的内容新建请求");
  }
  function captureAccepted(env:Omit<Envelope,"to">):CaptureResponse {
    return {ok:true,id:env.id,acceptedAt:env.createdAt,message:"已收进信箱",status:status()};
  }
  async function ingest(req: CaptureRequest, as:DeskActor): Promise<CaptureResponse> {
    if(!req || typeof req!=="object" || Array.isArray(req)) throw bad("随手记参数格式不对");
    if (req?.text !== undefined && typeof req.text !== "string") throw bad("随手记正文格式不对");
    const text = req?.text ?? "";
    if (req?.attachments !== undefined && (!Array.isArray(req.attachments) || req.attachments.some(a=>!a || typeof a.label!=="string" || typeof a.uri!=="string")))
      throw bad("附件格式不对");
    const attachments = req?.attachments?.map(({label,uri})=>({label,uri}));
    if (!text.trim() && !attachments?.length) throw bad("随手记不能为空");
    if (req.clientId !== undefined && (typeof req.clientId !== "string" || !/^[\w.:-]{1,80}$/.test(req.clientId))) throw bad("clientId 格式不对");
    if (req.threads !== undefined && (!Array.isArray(req.threads) || req.threads.length > 16 ||
        req.threads.some(t => typeof t !== "string" || !t.startsWith("ui:") || !t.slice(3).trim() || t.length > 160)))
      throw bad("请提供有效的工作台专题");
    const principal=principalOf(as);
    const input={...(req.threads && {threads:[...new Set(req.threads)]}),text,
      ...(attachments?.length ? {attachments}:{}),...(req.voice ? {voice:true}:{}),...(req.clientId ? {clientId:req.clientId}:{})};
    if(req.clientId) {
      const candidate=ui.captureEnvelope(input,principal), prior=captureRecord(candidate.id);
      if(prior) {sameCapture(candidate,prior);return captureAccepted(prior);}
    }
    const images = attachments?.filter(a => a.uri.startsWith(CAPTURE_ASSET_PREFIX)) ?? [];
    if (images.length > MAX_CAPTURE_IMAGES) throw bad("每条随手记最多5张图片");
    if (attachments?.some(a => /^data:image\//i.test(a.uri))) throw bad("图片请先保存为本地附件");
    for (const image of images) {
      const id = captureAssetId(image.uri);
      if (!id || !assets) throw bad("图片标识无效");
      await assets.read(id);
    }
    if(req.clientId) {
      // Asset reads awaited above. Recheck immediately before routing.ts's synchronous withTx enqueue begins.
      const candidate=ui.captureEnvelope(input,principal), prior=captureRecord(candidate.id);
      if(prior) {sameCapture(candidate,prior);return captureAccepted(prior);}
    }
    const sent=await ui.capture(input,principal), recorded=captureRecord(sent.id);
    if(!recorded) throw new DeskError(409,"capture_unconfirmed","提交尚未得到持久回执，请保留原内容后重试");
    // Check the actual inserted row too: concurrent requests may both pass the earlier lookup before ON CONFLICT.
    sameCapture(sent,recorded);
    return captureAccepted(recorded);
  }

  function approval(cardId: string): ApprovalRecord {
    const rec = gate.getApprovalSync(cardId);
    if (!rec) throw missing("找不到这张卡");
    return rec;
  }

  function pendingCard(cardId: string): { rec: ApprovalRecord; card: DecisionCard | null } {
    const rec = approval(cardId);
    if (rec.status !== "pending") throw wrongState("这张卡已经处理过了");
    return { rec, card: asDecisionCard(rec.card.data) };
  }

  function proposalOf(rec: ApprovalRecord, card: DecisionCard | null): ProjectProposal {
    if (card?.cardType !== "project_proposal") throw wrongState("这不是立项卡");
    const draftId = rec.artifactId ?? card.draft?.artifactId;
    const proposal = draftId ? context.getArtifactSync(draftId)?.content.data : card.proposal;
    if (!isProjectProposal(proposal)) throw wrongState("立项方案的内容不完整，请修改后再确认");
    return proposal;
  }

  /**
   * "📦 先放进以后再说" on a project proposal (docs/05 §3.1 Someday): the real project cell is created right away (same
   * id an approval would give it) and paused in the same synchronous call, before the dispatcher could run it — its
   * first task stays queued and is its brief when the owner activates it. Its record says someday and keeps the plan.
   * Nothing is closed, nothing runs, and activating it later is the normal "activate".
   */
  function parkProposal(cardId: string, decision: HumanDecision, as: DeskActor) {
    const approverId = principalOf(as);
    const seenRev = seenRevisionOf(decision.seenItemRevision);
    const { rec, card } = pendingCard(cardId);
    const proposal = proposalOf(rec, card);
    const draftId = rec.artifactId ?? (card?.cardType === "project_proposal" ? card.draft?.artifactId : undefined);
    if (draftId && context.getArtifactSync(draftId)?.version !== decision.seenArtifactVersion) throw wrongState("方案已变动，请重新查看");
    const holder = kernel.getCell(rec.cellId);
    if (!holder || holder.status === "closed" || holder.epoch !== rec.epoch) throw wrongState("事项所属任务已变动");
    const parent = holder;
    const parentId = parent.id;
    const t = now();
    const source = card?.source ?? { label: "以后再说", at: t };
    const note = decision.note?.trim();
    const init: ProjectInit = {
      id: projectIdForApproval(cardId),
      title: proposal.title,
      outcome: proposal.outcome,
      brief: parkedBrief(proposal, as, note),
      briefBy: "plan",
      proposal,
      plan: proposal.actions,
      source,
      ...(card?.rawInput.text ? { rawInput: card.rawInput.text } : {}),
      ...(proposal.cwd ? { cwd: proposal.cwd! } : {}),
      ...(proposal.repos ? { repos: proposal.repos! } : {}),
      ...(proposal.phases ? { phases: proposal.phases! } : {}),
    };
    const record: ProjectRecord = {
      title: proposal.title,
      outcome: proposal.outcome,
      lifecycle: "active",
      source,
      summary: `${whoText(as)}把这个方案放进了以后再说，还没有开始推进`,
      proposal,
      createdAt: t,
      updatedAt: t,
    };
    const projectId = withTx(kernel.db, () => {
      if (gate.withdrawSync(cardId, "someday", {seenItemRevision:seenRev}) !== "cancelled") throw wrongState("立项卡已变动");
      const started = startProjectSync(kernel, init, { parentId, ...actorOf(as) });
      const paused = kernel.control(started.projectId, { action: "pause",pauseReason:"parked",...(note ? {note} : {}) }, actorOf(as));
      if (!paused.applied) throw new Error(`could not park the new project: ${paused.reason ?? "pause refused"}`);
      // The project's books seed its record on its first run only when there is none: this one is kept as it is.
      commitState(started.projectId, { [gtdKeys.project]: record });
      const receipt = createEnvelope({id:`${cardId}:parked:${seenRev}`,from:KERNEL_FROM.approval,principalId:approverId,
        kind:"result",type:PAYLOAD.approvalResolved,delivery:"wakeup",expectedEpoch:parent.epoch,
        payload:{actionId:cardId,status:"cancelled",decision:"someday",action:rec.action,approverId,projectId:started.projectId,...(note ? {note} : {})}},kernel.clock);
      kernel.inbox.enqueueSync(parentId,receipt);
      if (!kernel.inbox.listMessagesSync({cellId:parentId,envelopeId:receipt.id,status:["pending"]}).length) throw wrongState("立项结果无法送达");
      return started.projectId;
    });
    return { status: "someday", projectId };
  }

  /** The first message of a project parked straight from its proposal: the plan the owner saw, as text. */
  function parkedBrief(proposal: ProjectProposal, as: DeskActor, note?: string): string {
    const owners: Record<BallOwner, string> = { agent: "交给 worker", human: "主人来做", waiting: "等外部" };
    return [
      `${whoText(as)}在立项卡上选了“先放进以后再说”：这个项目先停着，什么都不做。你读到这条消息时它已经被重新启动——谁启动的、带了什么话，见本轮开头的说明和后面的消息；确认是主人要现在开始，再按下面的方案推进（方案也在你的项目记录里，proposal 字段）。`,
      note ? `放进以后再说时${whoText(as)}的话：${note}` : "",
      proposal.background ?? "",
      proposal.actions.length ? ["方案里的步骤（启动时自动记入行动记录）：", ...proposal.actions.map((a) => `- [${owners[a.owner]}] ${a.title}${a.nextStep ? `：${a.nextStep}` : ""}`)].join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** A control-plane revision (the owner's or the external agent's) is `updatedBy: "human"`, so it is never mistaken for a background write. */
  async function savePlan(cardId: string, req: PlanSaveRequest, as: DeskActor): Promise<PlanSaveResponse> {
    principalOf(as);
    return withTx(kernel.db, () => {
      const { rec, card } = pendingCard(cardId);
      if (card?.cardType !== "project_proposal") throw wrongState("这不是立项卡");
      const draftId = rec.artifactId ?? card.draft?.artifactId;
      const art = draftId ? context.getArtifactSync(draftId) : null;
      if (!art) throw wrongState("这张卡的方案不能在这里修改");
      if (!Number.isInteger(req?.expectedVersion) || req.expectedVersion < 1) throw bad("方案版本必须是正整数");
      const p = req.proposal;
      if (!p || typeof p.outcome !== "string" || !p.outcome.trim() || !Array.isArray(p.actions)) throw bad("请填写项目目标和行动清单");
      const owners = new Set<BallOwner>(["human", "agent", "waiting"]);
      const actions = p.actions.map((a) => {
        if (!a || typeof a.title !== "string" || !a.title.trim() || !owners.has(a.owner)) throw bad("每项行动都需要标题和负责方");
        if (a.effort !== undefined && !isEffort(a.effort)) throw bad(`未知的精力标签 ${String(a.effort)}`);
        return { title: a.title.trim(), owner: a.owner, ...(a.effort ? { effort: a.effort } : {}), ...(a.nextStep ? { nextStep: a.nextStep } : {}) };
      });
      const baseProposal = proposalOf(rec, card);
      let nextRunnerOverride: RunnerOverride | undefined = baseProposal.runnerOverride;
      if (p.runnerOverride === null) {
        nextRunnerOverride = undefined;
      } else if (p.runnerOverride !== undefined) {
        const candidate: RunnerOverride = {
          engine: p.runnerOverride.engine,
          ...(typeof p.runnerOverride.model === "string" && p.runnerOverride.model.trim() ? { model: p.runnerOverride.model.trim() } : {}),
          ...(typeof p.runnerOverride.effort === "string" && p.runnerOverride.effort.trim() ? { effort: p.runnerOverride.effort.trim() } : {}),
        };
        if (!isRunnerOverride(candidate)) throw bad("请核对项目 Runner、模型与推理强度（设置推理强度时需要选择模型）");
        if (kernel.cliRunners.length > 0 && !kernel.cliRunners.includes(candidate.engine)) {
          throw bad(`Runner「${candidate.engine}」未启用`);
        }
        const cat = kernel.modelSettings(candidate.engine)?.view().catalog;
        if (cat && candidate.model) {
          const m = cat.models.find((x) => x.id === candidate.model);
          if (!m) throw bad(`${candidate.engine} 的模型列表里没有 "${candidate.model}"`);
          if (candidate.effort && !m.efforts.includes(candidate.effort)) {
            throw bad(`${m.label} 不提供推理强度 "${candidate.effort}"`);
          }
        }
        nextRunnerOverride = candidate;
      }
      const { runnerOverride: _oldRunner, phases: oldPhases, cwd: oldCwd, repos: oldRepos, agentContext: oldNote, ...restProposal } = baseProposal;
      if (p.agentContext !== undefined && p.agentContext !== null && typeof p.agentContext !== "string") throw bad("补充说明必须是文字");
      const agentNote = p.agentContext === undefined ? oldNote : p.agentContext?.trim() ? p.agentContext.trim() : undefined;
      // E17: the stages and directories are part of the plan the owner approves, so they can be changed with it.
      let phases = oldPhases;
      if (p.phases !== undefined) {
        if (!Array.isArray(p.phases) || p.phases.some((x) => typeof x !== "string")) throw bad("阶段必须是文字列表");
        const list = p.phases.map((x) => x.trim()).filter(Boolean);
        phases = list.length ? list : undefined;
      }
      const cwd = p.cwd === undefined ? oldCwd : p.cwd === null ? undefined : existingDir(p.cwd, "项目目录");
      let repos = oldRepos;
      if (p.repos === null) repos = undefined;
      else if (p.repos !== undefined) {
        if (!Array.isArray(p.repos)) throw bad("仓库必须是列表");
        repos = p.repos.map((r) => {
          if (!r || typeof r.name !== "string" || !r.name.trim()) throw bad("每个仓库都需要名字");
          const defaultBranch = typeof r.defaultBranch === "string" && r.defaultBranch.trim() ? r.defaultBranch.trim() : undefined;
          return { name: r.name.trim(), cwd: existingDir(r.cwd, `仓库「${r.name.trim()}」的目录`), ...(defaultBranch ? { defaultBranch } : {}) };
        });
        if (repos.length === 0) repos = undefined;
      }
      const proposal: ProjectProposal = {
        ...restProposal,
        title: typeof p.title === "string" && p.title.trim() ? p.title.trim() : baseProposal.title,
        outcome: p.outcome.trim(),
        ...(p.background !== undefined ? { background: p.background } : {}),
        ...(agentNote ? { agentContext: agentNote } : {}),
        ...(nextRunnerOverride ? { runnerOverride: nextRunnerOverride } : {}),
        ...(cwd ? { cwd } : {}),
        ...(repos ? { repos } : {}),
        ...(phases ? { phases } : {}),
        actions,
      };
      if (!isProjectProposal(proposal)) throw bad("请核对方案背景、行动说明及项目目录");
      const r = context.commitSync(art.cellId, {
        artifact: {
          artifactId: art.artifactId,
          content: { format: "json", title: proposal.title, body: JSON.stringify(proposal, null, 2), data: proposal },
          updatedBy: "human",
          expectedVersion: req.expectedVersion,
        },
      });
      if (!r.ok) {
        return { ok: false, outcome: "conflict", message: "方案在你编辑时被更新了，请看一下最新版本再保存", current: artifact(art.artifactId) };
      }
      recordEditor(art.artifactId, r.artifactVersion, as);
      return { ok: true, outcome: "saved", message: `已保存方案 v${r.artifactVersion}`, artifact: artifact(art.artifactId), deskStatus: status() };
    });
  }

  /**
   * A document's version saved from the control plane counts as the owner's edit ("human"); that their coding agent
   * saved it is kept beside it, so that the owner is not told "由你修改" (audit M18).
   */
  function recordEditor(artifactId: string, version: number | undefined, as: DeskActor): void {
    if (version === undefined) return;
    commitState(desk, { [artifactEditorKey(artifactId)]: byAgent(as) ? { version, principalId: principalOf(as) } : null });
  }

  /** A directory the owner named: absolute (or ~/…) and existing on this machine — never guessed. */
  function existingDir(path: unknown, what: string): string {
    if (typeof path !== "string" || !path.trim()) throw bad(`${what}需要一个绝对路径`);
    const raw = path.trim();
    const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
    if (!isAbsolute(expanded)) throw bad(`${what}必须是绝对路径：${raw}`);
    const dir = resolve(expanded);
    let ok = false;
    try {
      ok = statSync(dir).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw bad(`${what}在本机不存在：${dir}。请向主人确认正确的绝对路径，不要猜`);
    return dir;
  }

  // ==================== drafts ====================

  /** `updatedBy: "human"` as in savePlan: a background write based on an older version is parked, not merged over it. */
  function saveArtifact(artifactId: string, req: ArtifactSaveRequest, as: DeskActor): ArtifactSaveResponse {
    principalOf(as);
    return withTx(kernel.db, () => {
      const art = context.getArtifactSync(artifactId);
      if (!art) throw missing("这份草稿已移除");
      if (!Number.isInteger(req?.expectedVersion) || req.expectedVersion < 1) throw bad("请刷新草稿，核对要保存的版本");
      if (typeof req.body !== "string") throw bad("草稿正文必须是文本");
      const format = req.format ?? (art.content.format === "card" ? "card" : art.content.format);
      if (!["text", "markdown", "json", "card"].includes(format)) throw bad(`未知格式 ${String(format)}`);
      let data: unknown = req.data !== undefined ? req.data : art.content.data;
      if (format === "json" && req.data === undefined) {
        try {
          data = JSON.parse(req.body);
        } catch {
          throw bad("JSON 草稿的内容不是合法的 JSON");
        }
      }
      const boundPlan = get(kernel.db,"SELECT 1 FROM human_items WHERE artifact_id=? AND action_type='project.start' AND status IN ('pending','snoozed','revising') LIMIT 1",[artifactId]);
      if (boundPlan && !acceptsApprovalDraft("project.start", format, data)) throw bad("立项方案需要有效的标题、目标、动作、目录和阶段");
      const title = req.title ?? art.content.title;
      const r = context.commitSync(art.cellId, {
        artifact: {
          artifactId,
          content: {
            format,
            body: req.body,
            ...(title !== undefined ? { title } : {}),
            ...(data !== undefined && format !== "text" && format !== "markdown" ? { data } : {}),
            ...(art.content.attachments ? { attachments: art.content.attachments } : {}),
          },
          updatedBy: "human",
          expectedVersion: req.expectedVersion,
        },
      });
      if (!r.ok) {
        return {
          ok: false,
          outcome: "conflict",
          message: `草稿在你编辑时已更新到 v${r.currentArtifact.version}，你的修改还没保存：请对照右栏的新内容合并后再保存`,
          artifact: artifact(artifactId),
        };
      }
      recordEditor(artifactId, r.artifactVersion, as);
      return { ok: true, outcome: "saved", message: `已保存 v${r.artifactVersion}`, artifact: artifact(artifactId) };
    });
  }

  function dismissParked(artifactId: string, parkedId: string, as: DeskActor): ArtifactDTO {
    principalOf(as);
    if (!context.listParkedSync(artifactId).some((p) => p.id === parkedId)) throw missing("这条补充信息已经移除了");
    context.dismissParkedSync(parkedId);
    return artifact(artifactId);
  }

  // ==================== 🧭 Radar ====================

  function projectRecord(projectId: string): ProjectRecord {
    const v = readProjects(kernel).find(project => project.cellId === projectId)?.record;
    if (!v || typeof v !== "object" || typeof v.title !== "string") throw missing("找不到这个项目");
    return v;
  }

  function projectActions(projectId: string): Array<Located<ActionRecord>> {
    const projectCells = new Set(readProjects(kernel).map((p) => p.cellId));
    return readActions(kernel).filter((a) => projectOfAction(kernel, a, projectCells) === projectId);
  }

  function projectResult(outcome: ProjectOutcome, ok: boolean, message: string, extra: Partial<ProjectMutationResponse> = {}): ProjectMutationResponse {
    return { ok, outcome, message, view: radar(), status: status(), ...extra };
  }

  /**
   * Radar's project buttons, and the control plane's set_project_state (same code, the caller's principal):
   * - pause / resume: kernel.control on the project cell (its whole subtree follows).
   * - someday: pause the project with the parked reason. Nothing is closed or deleted: records, reports and history stay.
   * - activate: a parked project cell is resumed and told the owner's words, so it wakes and
   *   continues from its records and report.
   * - cancel / complete: closeCell — the kernel settles the project's records; the project's actions held elsewhere
   *   (e.g. a card taken over on the desk) and cards about it on the desk follow here.
   */
  async function projectOp(projectId: string, op: ProjectOp, as: DeskActor): Promise<ProjectMutationResponse> {
    principalOf(as);
    const record = projectRecord(projectId);
    const cell = kernel.getCell(projectId);
    const open = cell !== undefined && cell.status !== "closed";
    // E05: the words that came with a pause or a parking ("先停一下，我还没想好") are kept on the cell's record.
    const note = as.note?.trim();
    const control = (action: "pause" | "resume") => kernel.control(projectId, { action, ...(note ? { note } : {}) }, actorOf(as));
    switch (op) {
      case "pause": {
        if (!open) return projectResult("not_applied", false, "这个项目没有在运行的任务");
        if (cell.status === "paused") return projectResult("paused", true, `「${record.title}」已经暂停了`);
        if (!control("pause").applied) return projectResult("not_applied", false, "暂停没有生效");
        return stopped(projectId, "paused", `已暂停「${record.title}」`);
      }
      case "resume": {
        if (!open) return projectResult("not_applied", false, "这个项目没有可以继续的任务");
        if (cell?.pauseReason === "parked") return projectResult("not_applied", false, `「${record.title}」在以后再说里：用“重新启动”让它继续`);
        if (cell.status === "active") return projectResult("resumed", true, `「${record.title}」正在推进`);
        const r = control("resume");
        return r.applied ? projectResult("resumed", true, `「${record.title}」继续推进`) : projectResult("not_applied", false, "继续没有生效");
      }
      case "cancel":
      case "complete": {
        if (record.lifecycle === "completed" || record.lifecycle === "cancelled") {
          return projectResult("not_applied", false, `「${record.title}」已经${record.lifecycle === "completed" ? "完结" : "取消"}了`);
        }
        const how = op === "cancel" ? "cancelled" : "completed";
        if (!open) return projectResult("not_applied", false, "这个项目已结束");
        await kernel.closeCell(projectId, how, actorOf(as));
        finishActions(
          projectActions(projectId).filter((a) => a.record.status === "open"),
          op === "cancel" ? "cancelled" : "done",
        );
        return op === "cancel"
          ? projectResult("cancelled", true, `已取消「${record.title}」，后台任务已全部停止（文件和分支都留在原处）`)
          : projectResult("completed", true, `「${record.title}」已完结`);
      }
      case "someday": {
        if (cell?.pauseReason === "parked") return projectResult("someday", true, "已经在以后再说里了");
        if (!open || record.lifecycle !== "active") return projectResult("not_applied", false, "只有进行中的项目可以移进以后再说");
        {
          const r = kernel.control(projectId,{action:"pause",pauseReason:"parked",...(note ? {note} : {})},actorOf(as));
          if (!r.applied) return projectResult("not_applied", false, "暂停没有生效");
        }
        return stopped(projectId, "someday", `「${record.title}」已移进以后再说，后台任务已暂停，记录和报告都留着`);
      }
      case "activate": {
        if (cell?.pauseReason !== "parked") return projectResult("not_applied", false, "这个项目不在以后再说里");
        if (!open) return projectResult("not_applied", false, "这个项目已结束");
        const parked = pauseInfo(projectId);
        withTx(kernel.db, () => {
          if (cell.status === "paused") {
            const r = control("resume");
            if (!r.applied) throw wrongState("继续没有生效");
          }
          tellProject(projectId, activateText(record, as, parked), as);
        });
        // Whoever activated it is told what it was parked with.
        const was = parked ? `（此前${parked.text}）` : "";
        const words = note ? `，带去的话：「${note}」` : byAgent(as) ? "；这次启动没有带主人的话，项目会先向主人确认再动手" : "";
        return projectResult("activated", true, `「${record.title}」已从以后再说里拿出来${was}，接着之前的记录和报告做${words}`);
      }
    }
  }

  /**
   * What a parked project hears when it is brought back: who did it — from the control plane that is the owner's coding
   * agent, not the owner pressing a button — and the owner's words apart from it (audit R01). What to make of them is
   * in the project's prompt; only what it cannot know is added (from the list the owner sees no chat of its).
   */
  function activateText(record: ProjectRecord, as: DeskActor, parked: ReturnType<typeof pauseInfo>): string {
    const said = as.note?.trim();
    const lines = [
      byAgent(as)
        ? `主人的编码助手把「${record.title}」从以后再说里拿了出来。`
        : `主人在工作台里把「${record.title}」从以后再说里拿了出来。`,
    ];
    if (parked) lines.push(`停靠时的情况：${parked.text}。`);
    lines.push(said ? `这次带来的主人的话：「${said}」` : "这次没有带来主人的话。");
    if (!byAgent(as)) lines.push("主人是在项目列表里点的，不在看你的对话：没有能推进的就用 send_message（channel:ui:owner）告诉主人停在哪、需要什么。");
    return lines.join("\n");
  }

  /**
   * "补上下一步" (Radar) and add_action (control plane): an open action on the project's books — the owner's own
   * ("human", on their to-do list) or something to wait for ("waiting") — and the project is told.
   */
  async function addProjectAction(projectId: string, req: AddActionRequest & { owner?: "human" | "waiting" }, as: DeskActor): Promise<ProjectMutationResponse> {
    const actorPrincipal = principalOf(as);
    projectRecord(projectId);
    const title = typeof req?.title === "string" ? req.title.trim() : "";
    if (!title) throw bad("下一步需要一个标题");
    if (req.effort !== undefined && !isEffort(req.effort)) throw bad(`未知的精力标签 ${String(req.effort)}`);
    if (req.owner !== undefined && req.owner !== "human" && req.owner !== "waiting") throw bad("owner 只能是 human 或 waiting");
    const owner: "human" | "waiting" = req.owner ?? "human";
    const t = now();
    const nextStep = typeof req.nextStep === "string" && req.nextStep.trim() ? req.nextStep.trim() : undefined;
    const action: ActionRecord = {
      id: newId("act", clock),
      title,
      owner,
      status: "open",
      projectCellId: projectId,
      ...(owner === "human" ? { nextStep: nextStep ?? title } : nextStep ? { nextStep } : {}),
      ...(owner === "waiting" ? { waiting: { description: title, parties: [], join: "all" as const } } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      source: { label: byAgent(as) ? "编码助手" : "项目全局", principalId: actorPrincipal, at: t },
      createdAt: t,
      updatedAt: t,
    };
    const cell = kernel.getCell(projectId);
    withTx(kernel.db, () => {
      writeActionRecordSync(kernel, projectId, action);
      if (cell && cell.status !== "closed") {
        tellProject(
          projectId,
          owner === "human"
            ? `${whoText(as)}在项目上补了一个自己来做的动作：${title}（${action.id}）${action.nextStep && action.nextStep !== title ? `\n下一步：${action.nextStep}` : ""}\n主人办完会勾掉它，你会收到通知。`
            : `${whoText(as)}在项目上加了一个要等的事：${title}（${action.id}）${nextStep ? `\n说明：${nextStep}` : ""}\n需要的话派一个 checker 盯住它，达成后用 track_action 关掉这个动作。`,
          as,
        );
      }
    });
    return projectResult("action_added", true, `已补上${owner === "human" ? "下一步" : "要等的事"}：${title}`, { actionId: action.id });
  }

  // ==================== weekly review ====================

  function reviewResult(outcome: ReviewMutationResponse["outcome"], ok: boolean, message: string): ReviewMutationResponse {
    return { ok, outcome, message, view: review(), status: status() };
  }

  function acceptSkill(slug: string, as: DeskActor): ReviewMutationResponse {
    principalOf(as);
    const key = `${SKILL_SUGGESTION_PREFIX}${slug}`;
    const s = context.readStateSync<SkillSuggestion>(desk, key);
    if (!s || typeof s.name !== "string" || typeof s.body !== "string") throw missing("这条技能建议已经不在了");
    try {
      context.upsertSkillOrNoteSync(desk, { kind: "skill", name: s.name, description: s.description ?? s.name, body: s.body, scope: "global", mode: "upsert" });
    } catch (err) {
      if (err instanceof NgError && err.code === "invalid_argument") throw bad(`技能名不合法：${err.message}`);
      throw err;
    }
    commitState(desk, { [key]: null });
    return reviewResult("skill_saved", true, `已保存技能「${s.name}」`);
  }

  function dismissSkill(slug: string, as: DeskActor): ReviewMutationResponse {
    principalOf(as);
    const key = `${SKILL_SUGGESTION_PREFIX}${slug}`;
    if (context.readStateSync(desk, key) === null) throw missing("这条技能建议已经不在了");
    commitState(desk, { [key]: null });
    return reviewResult("dismissed", true, "好的，不保存");
  }

  function checkEntry(entry: unknown): string {
    if (typeof entry !== "string" || !entry.trim()) throw bad("需要脚本路径或检查名");
    const e = entry.trim();
    if (e.startsWith("script:")) {
      if (!e.slice("script:".length).trim()) throw bad("script: 后面需要脚本路径");
      return e;
    }
    if (!kernel.registry.codeProcessors.has(e)) throw bad(`没有名为 ${e} 的检查`);
    return e;
  }

  function sensorToCode(sensorId: string, req: SensorToCodeRequest, as: DeskActor): ReviewMutationResponse {
    principalOf(as);
    const src = context.readStateSync<SourceState>(sensorId, gtdKeys.source);
    const cell = kernel.getCell(sensorId);
    if (!src || !cell || cell.status === "closed") throw missing("找不到这个信源");
    const entry = checkEntry(req?.entry);
    kernel.updateCell(sensorId, { processor: sensorProcessor(entry) },actorOf(as));
    commitState(desk, { [`${SENSOR_SUGGESTION_PREFIX}${sensorId}`]: null });
    return reviewResult("switched_to_code", true, `「${src.title}」已改为零 Token 的脚本检查`);
  }

  // ==================== activity drawer ====================

  async function restoreActivity(cellId: string, activityId: string, as: DeskActor): Promise<ActivityMutationResponse> {
    principalOf(as);
    const key = gtdKeys.activity(activityId);
    const found = readActivities(kernel).find((a) => a.cellId === cellId && a.key === key);
    if (!found) throw missing("找不到这条记录");
    const r = found.record;
    const result = (outcome: ActivityMutationResponse["outcome"], ok: boolean, message: string): ActivityMutationResponse => ({
      ok,
      outcome,
      message,
      view: activity(),
      status: status(),
    });
    if (!r.restorable || r.restoredAt) return result("not_restorable", false, r.restoredAt ? "已经移回过了" : "这条记录不能移回");
    const restored = { ...r, restoredAt: now() };
    const original = r.envelope ?? (r.actionId ? originalEnvelope(asDecisionCard(gate.getApprovalSync(r.actionId)?.card.data)?.source.envelopeId) : null);
    if (original) {
      const handback = createEnvelope<HandbackPayload>(
        {
          id: `${original.id}#restore#${activityId}`,
          from: KERNEL_FROM.router,
          principalId: principalOf(as),
          kind: "event",
          type: PAYLOAD.handback,
          payload: { original, fromCellId: desk, reason: RESTORE_REASON },
        },
        clock,
      );
      context.commitSync(cellId, { statePatches: { [key]: restored }, inboxOut: [{ to: inboxAddr(desk), envelope: handback }] });
      return result("restored", true, "已交回主台处理");
    }
    return result("not_restorable", false, "原始消息已经找不到了，不能移回");
  }

  // ==================== ⚡ 信源 ====================

  function sourcesResult(outcome: SourcesMutationResponse["outcome"], ok: boolean, message: string, sensorId?: string): SourcesMutationResponse {
    return { ok, outcome, message, view: sources(), status: status(), ...(sensorId ? { sensorId } : {}) };
  }

  function cronOf(schedule: CreateSourceRequest["schedule"]): { cron: string; tz?: string } {
    if (!schedule || typeof schedule !== "object") throw bad("需要检查频率");
    if ("cron" in schedule) {
      if (typeof schedule.cron !== "string" || schedule.cron.trim().split(/\s+/).length !== 5) throw bad("cron 需要 5 段，例如 0 9 * * 1");
      return { cron: schedule.cron.trim(), ...(typeof schedule.tz === "string" && schedule.tz ? { tz: schedule.tz } : {}) };
    }
    const m = schedule.everyMinutes;
    if (!Number.isInteger(m) || m < 1) throw bad("检查间隔必须是正整数分钟");
    if (m < 60) return { cron: `*/${m} * * * *` };
    if (m % 60 === 0 && m <= 24 * 60) return { cron: m === 24 * 60 ? "0 0 * * *" : `0 */${m / 60} * * *` };
    throw bad("检查间隔需小于一小时，或为整小时，最长一天");
  }

  function createSource(req: CreateSourceRequest, as: DeskActor): SourcesMutationResponse {
    principalOf(as);
    const title = typeof req?.title === "string" ? req.title.trim() : "";
    if (!title) throw bad("信源需要一个名字");
    const schedule = cronOf(req.schedule);
    const check = req.check;
    if (!check || typeof check !== "object") throw bad("需要说明检查方式");
    let processor: ReturnType<typeof sensorProcessor> | undefined;
    let instruction = typeof req.description === "string" && req.description.trim() ? req.description.trim() : title;
    if (check.kind === "script") {
      if (typeof check.path !== "string" || !check.path.trim()) throw bad("需要脚本路径");
      processor = sensorProcessor(`script:${check.path.trim()}`);
    } else if (check.kind === "code") {
      processor = sensorProcessor(checkEntry(check.entry));
    } else if (check.kind === "llm") {
      if (typeof check.instruction !== "string" || !check.instruction.trim()) throw bad("需要说明要检查什么");
      instruction = check.instruction.trim();
    } else {
      throw bad("检查方式必须是 script / code / llm");
    }
    const mode = req.mode === "observe" ? "observe" : "active";
    const id = newId("src", clock);
    const spec = createSensorSpec(id, {
      title, kind: "cron", schedule, mode, processor: processor ? "code" : "llm",
      description: instruction,
    }, processor ?? kernel.registry.presets.get("sensor")?.defaults?.processor);
    kernel.spawnCell(desk, spec, undefined, actorOf(as));
    return sourcesResult("created", true, `已添加信源「${title}」`, id);
  }

  function sourceRecord(sensorId: string): SourceState {
    const src = context.readStateSync<SourceState>(sensorId, gtdKeys.source);
    const cell = kernel.getCell(sensorId);
    if (!src || !cell || cell.status === "closed") throw missing("找不到这个信源");
    return src;
  }

  function pauseSource(sensorId: string, pause: boolean, as: DeskActor): SourcesMutationResponse {
    principalOf(as);
    const src = sourceRecord(sensorId);
    const r = kernel.control(sensorId, { action: pause ? "pause" : "resume" },actorOf(as));
    if (!r.applied) throw wrongState("操作没有生效，请检查所属项目是否暂停或结束");
    return sourcesResult(pause ? "paused" : "resumed", true, pause ? `已暂停「${src.title}」` : `「${src.title}」恢复运行`, sensorId);
  }

  function setSourceMode(sensorId: string, req: SourceModeRequest, as: DeskActor): SourcesMutationResponse {
    principalOf(as);
    if (req?.mode !== "active" && req?.mode !== "observe") throw bad("mode 必须是 active 或 observe");
    const src = sourceRecord(sensorId);
    // A hit that was only noted while observing has not been reported to anyone: marked so, a condition that still holds
    // is reported at the next check instead of being taken for a repeat (audit R04).
    const ongoing = req.mode === "active" && src.mode !== "active" && src.lastHitDigest !== undefined;
    const { lastHitRepeats: _repeats, ...rest } = src;
    const next: SourceState = ongoing ? { ...rest, lastHitUnreported: true } : src;
    commitState(sensorId, { [gtdKeys.source]: { ...next, mode: req.mode, updatedAt: now() } });
    return sourcesResult(
      "mode_changed",
      true,
      req.mode === "observe"
        ? `「${src.title}」改为只记观察笔记，不再弹卡`
        : `「${src.title}」命中时会投进信箱${ongoing ? "；观察期间记下的命中还没有报给任何人，如果下次检查时仍然命中，会当作新命中报出来" : "；现在仍有问题的话，下次检查就会报"}`,
      sensorId,
    );
  }

  async function deleteSource(sensorId: string, as: DeskActor): Promise<SourcesMutationResponse> {
    principalOf(as);
    const src = sourceRecord(sensorId);
    await kernel.closeCell(sensorId, "cancelled", { ...actorOf(as), parentDelivery: "silent_inject" });
    return sourcesResult("deleted", true, `已删除信源「${src.title}」`, sensorId);
  }

  const agents = createAgentsApi({
    requireActor: actorOf,
    commands:{
      message:(id,req,as)=>kernel.directMessage(id,req,actorOf(as)),
      control:(id,cmd,as)=>kernel.control(id,cmd,actorOf(as)),
      close:(id,as)=>kernel.closeCell(id,"cancelled",actorOf(as)),
      trigger:(id,epoch,as)=>kernel.inbox.enqueueSync(id,createEnvelope({
        id:newId("trig",clock),from:"timer:manual",to:inboxAddr(id),principalId:principalOf(as),kind:"event",type:PAYLOAD.timerFired,
        payload:{label:"主人手动触发了一次检查"},expectedEpoch:epoch},clock)),
    },
    kernel,
    settings,
    status,
    projectOp: (projectId, op, as) => projectOp(projectId, op, as),
    errors: { bad, missing },
  });

  function deskOptions(item: HumanItem): CardOption[] {
    if (item.action?.type !== "project.start") return item.options;
    return item.options.flatMap(option => option.id === "system.execute"
      ? [{...option, label: "确认立项"}, {id: "system.someday", label: "先放进以后再说", effect: "execute" as const, input: {mode: "optional" as const}}]
      : [option]);
  }

  function decisionCells(cellId: string | null) {
    const issuer = cellId ? kernel.getCell(cellId) : undefined;
    const pid = issuer && (isProjectRoot(kernel.registry, issuer) ? issuer.id : projectCellIdOf(issuer.spec));
    const project = pid ? kernel.getCell(pid) : undefined;
    const paused = project?.status === "paused" ? project : issuer?.status === "paused" ? issuer : undefined;
    return {project, paused};
  }

  function closureMembers(target: string) {
    const root = kernel.getCell(target);
    if (!root || !isProjectRoot(kernel.registry, root) || root.status==="closed") return [];
    const members = [root];
    for (const parent of members) members.push(...kernel.listCells({parentId:parent.id}).filter(c=>c.status!=="closed"));
    return members.map(c=>({id:c.id,title:c.title?.trim() || "未命名任务"})).sort((a,b)=>a.id.localeCompare(b.id));
  }

  function toHumanItemDTO(item: HumanItem) {
    const {project, paused} = decisionCells(item.cellId);
    const closeTargets: Record<string,ReturnType<typeof closureMembers>> = {};
    for (const o of item.options) if (o.terminateMode==="cancel_task") closeTargets[o.id]=closureMembers(o.targetCellIds![0]!);
    const projects=item.relatedProjectIds.map(id=>kernel.getCell(id)).filter(p=>p!==undefined)
      .map(p=>({id:p.id,title:p.title?.trim() || "未命名项目"}));
    const planArtifact=item.action?.type==="project.start" && item.artifactId ? context.getArtifactSync(item.artifactId) : undefined;
    const plan=item.action?.type==="project.start" ? (item.artifactId ? planArtifact?.content.data : item.action.proposal) : undefined;
    // The card row keeps the first draft's title, description and plan; what the owner decides on is the current
    // version of the plan document, so that is what is shown (audit M18).
    const stepBy = { human: "主人来做", waiting: "等外部", agent: "交给后台" };
    const current = isProjectProposal(plan) && item.action?.type === "project.start"
      ? { title: plan.title, description: [plan.outcome, ...plan.actions.map(a => `- [${stepBy[a.owner]}] ${a.title}`)].join("\n"), action: { ...item.action, proposal: plan },
          // The desk's preparatory note was written for its own draft; a plan changed since may no longer fit it.
          ...(item.prep && planArtifact?.updatedBy === "human" ? { prep: { ...item.prep, summary: "" } } : {}) }
      : {};
    return {...item, ...current, attachments:itemAttachments(item), options:deskOptions(item), resumeTarget:paused ? {id:paused.id, title:paused.title?.trim() || "未命名任务"} : null, proposal:isProjectProposal(plan) ? plan : null, projects, closeTargets, artifact:item.artifactId ? artifactDTO(kernel,item.artifactId,now()) : null,
      project:project ? {id:project.id,title:project.title?.trim() || "未命名项目",paused:project.status==="paused",parked:project.pauseReason==="parked"} : null,
    };
  }

  return {
    ownerPrincipal: owner,
    models: (refresh: boolean) => models.view({ refresh }),
    async setModel(req: UpdateModelsRequest, actor: DeskActor) {
      principalOf(actor);
      const result = await models.set(req);
      kernel.bus.emit("runner.settings.changed", {});
      return result;
    },
    status,
    topology: agents.topology,
    timeline: agents.timeline,
    questions: agents.questions,
    resource: agents.resource,
    sendCellMessage: agents.sendMessage,
    directMessage: agents.deliver,
    createProject(init: ProjectInit, as:DeskActor, parentId=desk) {
      return startProjectSync(kernel,init,{parentId,...actorOf(as)});
    },
    spawnCell(parentId:string,spec:import("@ng/cell").CellSpecInput,task:unknown,as:DeskActor) {
      return kernel.spawnCell(parentId,spec,task,actorOf(as));
    },
    savePreference(patch:import("@ng/protocol").KnowledgePatch,as:DeskActor) {
      principalOf(as);
      if (patch.kind!=="preference") throw bad("需要偏好设置");
      context.upsertSkillOrNoteSync(desk,patch);
    },
    cellControl: agents.control,
    cellTrigger: agents.trigger,
    recentlyClosedProjects: () => kernel.listCells({status:["closed"]}).filter(cell => isProjectRoot(kernel.registry, cell)).sort((a,b)=>b.updatedAt-a.updatedAt)
      .slice(0,30).map(c=>({id:c.id,title:c.title?.trim() || "未命名任务",reason:c.closeReason})),
    openArtifactIds: () => all<{artifact_id: string}>(kernel.db, `
      SELECT DISTINCT artifact_id FROM human_items
      WHERE status IN ('pending','snoozed','revising') AND artifact_id IS NOT NULL
    `).map(row => row.artifact_id),
    saveCaptureImage: (value:CaptureImageUpload, check?:()=>void) => {
      if (!assets) throw missing("图片存储尚未配置");
      return assets.save(value,check);
    },
    readCaptureImage: (id:string) => {
      if (!assets) throw missing("图片存储尚未配置");
      return assets.read(id);
    },
    listHumanItems: (includeSnoozed = false) => kernel.humanItems.list(includeSnoozed).map(toHumanItemDTO),
    listRevisingHumanItems: () => kernel.humanItems.listRevising().map(toHumanItemDTO),
    async decideHumanItem(id: string, decision: HumanDecision, as: DeskActor) {
      const principal = principalOf(as);
      if (decision.optionId === "system.someday") {
        return withTx(kernel.db, () => {
          const item = kernel.humanItems.get(id);
          if (!item) throw missing("找不到这件事项");
          if (!deskOptions(item).some(o => o.id === decision.optionId)) throw wrongState(`选项已变动：现在可选 ${deskOptions(item).map(o => o.id).join("、")}`);
          return parkProposal(id, decision, as);
        });
      }
      const accept = (item: HumanItem, option: CardOption) => {
        if (option?.terminateMode==="cancel_task") {
          const expected=closureMembers(option.targetCellIds![0]!).map(c=>c.id);
          if (!expected.length || JSON.stringify(expected)!==JSON.stringify(decision.confirmedClosure)) throw wrongState("待关闭的任务清单已变动");
        }
        if (option?.effect === "defer" || option?.effect === "terminate") return;
        const {paused} = decisionCells(item.cellId);
        if (!paused) return;
        if (decision.resumeProjectId !== paused.id) throw wrongState(`请先确认恢复「${paused.title?.trim() || "未命名任务"}」`);
        const r = kernel.control(paused.id, {action:"resume"}, actorOf(as));
        if (!r.applied) throw wrongState("任务未能恢复");
      };
      try {
        return await kernel.humanItems.decide(id, decision, principal, accept);
      } catch (err) {
        if (err instanceof NgError && err.code === "not_found" && !kernel.humanItems.get(id)) throw missing("找不到这件事项");
        throw err;
      }
    },
    undoHumanDecision: (activityId: string, as: DeskActor) => kernel.humanItems.undo(activityId,principalOf(as)),
    localTime,
    unpromptedWords: (since: number) => unpromptedDeskWords(input(), since),
    reopenProject: async (projectId: string, as: DeskActor, words?: { text?: string; agentContext?: string }) => ({restored:await kernel.reopenProject(projectId,principalOf(as),words)}),
    pauseInfo,
    radar,
    review,
    sources,
    activity,
    artifact,
    ingest,
    savePlan,
    saveArtifact,
    dismissParked,
    projectOp,
    addProjectAction,
    acceptSkill,
    dismissSkill,
    sensorToCode,
    restoreActivity,
    createSource,
    pauseSource,
    setSourceMode,
    deleteSource,
  };
}
