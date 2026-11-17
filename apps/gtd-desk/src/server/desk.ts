import type { Kernel, ResolveApprovalResult } from "@ng/cell";
import type { UiChannel } from "@ng/channel";
import { ruleInputForClass } from "@ng/gate";
import { SCRIPT_PREFIX } from "@ng/loop";
import { startApprovedProjectSync, syncItemAfterOwnerChangeSync } from "@ng/presets";
import {
  asClarifyCard,
  cellPrincipal,
  createEnvelope,
  gtdKeys,
  inboxAddr,
  isEnvelopeOfType,
  KERNEL_FROM,
  newId,
  NgError,
  PAYLOAD,
  subjectKeys,
  withTx,
  type ActionRecord,
  type ActivityRecord,
  type ApprovalRecord,
  type BallOwner,
  type ClarifyCard,
  type Effort,
  type Envelope,
  type HandbackPayload,
  type ItemSource,
  type ProjectProposal,
  type ProjectProposalCard,
  type ProjectRecord,
  type SourceRecord,
  type ToolKind,
} from "@ng/protocol";
import type {
  ActivityKind,
  ActivityMutationResponse,
  AddActionRequest,
  ApproveOutcome,
  ApproveRequest,
  ArtifactDTO,
  ArtifactSaveRequest,
  ArtifactSaveResponse,
  CaptureRequest,
  CaptureResponse,
  ClarifyMutationResponse,
  ClarifyOutcome,
  ClarifyQueueDTO,
  CreateSourceRequest,
  DoneRequest,
  EnableRuleRequest,
  EngageDetailDTO,
  EngageListDTO,
  EngageMutationResponse,
  EngageSendRequest,
  ExtendRequest,
  FocusRequest,
  FocusResponse,
  NoteRequest,
  PlanSaveRequest,
  ProjectMutationResponse,
  ProjectOutcome,
  RadarDTO,
  ReviewMutationResponse,
  ReviseRequest,
  SensorToCodeRequest,
  SnoozeRequest,
  SourceModeRequest,
  SourcesDTO,
  SourcesMutationResponse,
  StatusDTO,
  ToHumanRequest,
  VerifyRequest,
  WeeklyReviewDTO,
  ActivityListDTO,
  EngageOutcome,
} from "../shared/api";
import {
  approvalProjectId,
  inputOf,
  linkedApprovalId,
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
import { clarifyCardById, projectClarify } from "./projections/clarify";
import { isEffort, projectEngage, projectEngageDetail } from "./projections/engage";
import { artifactDTO } from "./projections/format";
import { projectRadar } from "./projections/radar";
import { projectReview } from "./projections/review";
import { projectStatus } from "./projections/status";
import { projectSources } from "./projections/sources";
import { projectActivity } from "./projections/activity";
import { afternoonSlot, whenText } from "./projections/time";

const DAY = 24 * 3_600_000;

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

/** What the desk tells the desk cell when the owner moves an archived item back to Clarify. */
export const RESTORE_REASON = "主人把这条从归档记录里移回了待确认：请为它准备一张待确认卡片，不要再静默归档。";

export interface DeskDeps {
  kernel: Kernel;
  ui: UiChannel;
  settings: DeskSettings;
  /** Background follow-ups that failed after the owner's action itself succeeded. Default: console.error. */
  onError?: (err: unknown, where: string) => void;
}

export type Desk = ReturnType<typeof createDesk>;

/**
 * The synchronous transaction API behind the endpoints (docs/04 "同步事务接口"): each method calls Context / Gate /
 * Inbox / kernel directly and answers with the refreshed view. Only capture, revise and "移回待确认" deliver a message
 * to a Loop; approvals the kernel hands back to a cell are the kernel's business.
 */
export function createDesk({ kernel, ui, settings, onError = (err, where) => console.error(`[desk] ${where}:`, err) }: DeskDeps) {
  const { context, gate, clock } = kernel;
  const owner = kernel.ownerPrincipal;
  const desk = kernel.deskCellId;
  const input = () => inputOf(kernel, settings);
  const now = () => clock.now();

  // ==================== reads ====================

  const status = (): StatusDTO => projectStatus(input());
  const clarify = (): ClarifyQueueDTO => projectClarify(input());
  const radar = (): RadarDTO => projectRadar(input());
  const review = (): WeeklyReviewDTO => projectReview(input());
  const sources = (): SourcesDTO => projectSources(input());
  const activity = (kind?: ActivityKind): ActivityListDTO => projectActivity(input(), kind);
  const engage = (filter: Effort | "all" = "all"): EngageListDTO => projectEngage(input(), filter);

  function engageDetail(cellId: string, actionId: string): EngageDetailDTO {
    const d = projectEngageDetail(input(), cellId, actionId);
    if (!d) throw missing("这件事不在专注工作区里（可能已办完）");
    return d;
  }

  function artifact(artifactId: string): ArtifactDTO {
    const a = artifactDTO(kernel, artifactId, now());
    if (!a) throw missing(`没有这份草稿 ${artifactId}`);
    return a;
  }

  // ==================== record helpers ====================

  function commitState(cellId: string, patches: Record<string, unknown>): void {
    const r = context.commitSync(cellId, { statePatches: patches });
    if (!r.ok) throw new Error("state commit unexpectedly rejected");
  }

  function addActivity(rec: Omit<ActivityRecord, "id" | "at"> & { at?: number }): ActivityRecord {
    const full: ActivityRecord = { ...rec, id: newId("acty", clock), at: rec.at ?? now() };
    commitState(desk, { [gtdKeys.activity(full.id)]: full });
    return full;
  }

  function findAction(cellId: string, actionId: string): Located<ActionRecord> {
    const value = context.readStateSync(cellId, gtdKeys.action(actionId));
    const found = readActions(kernel).find((a) => a.cellId === cellId && a.record.id === actionId);
    if (!value || !found) throw missing("找不到这件事");
    return found;
  }

  /** Marks open actions finished; returns how many changed. */
  function finishActions(actions: Iterable<Located<ActionRecord>>, statusTo: "done" | "cancelled"): number {
    const t = now();
    const byCell = new Map<string, Record<string, unknown>>();
    let n = 0;
    for (const a of actions) {
      if (a.record.status !== "open") continue;
      const patch = byCell.get(a.cellId) ?? {};
      patch[a.key] = { ...a.record, status: statusTo, updatedAt: t, ...(statusTo === "done" ? { completedAt: t } : {}) };
      byCell.set(a.cellId, patch);
      n++;
    }
    withTx(kernel.db, () => {
      for (const [cellId, patch] of byCell) commitState(cellId, patch);
    });
    return n;
  }

  /** Cells that were closed: their open actions are finished and a project they hold is completed. */
  function settleClosedCells(cellIds: readonly string[], how: "done" | "cancelled"): void {
    if (cellIds.length === 0) return;
    const set = new Set(cellIds);
    finishActions(readActions(kernel).filter((a) => set.has(a.cellId)), how);
    const t = now();
    for (const p of readProjects(kernel)) {
      if (!set.has(p.cellId) || p.record.lifecycle !== "active") continue;
      commitState(p.cellId, {
        [gtdKeys.project]: { ...p.record, lifecycle: how === "done" ? "completed" : "cancelled", updatedAt: t, ...(how === "done" ? { completedAt: t } : {}) },
      });
    }
  }

  /**
   * The kernel tells a card's cell about a dismissal only silently; an item root or watcher that keeps the item's books
   * is woken so they reflect it now (the result was not wanted → the item completes; a nudge was dropped → the next
   * check is set). A model-run cell (the desk) picks it up with its next wake-up instead.
   */
  function wakeBookkeeper(cellId: string): void {
    syncItemAfterOwnerChangeSync(context, cellId, { principalId: owner, now: now(), id: newId("sync", clock) });
  }

  /** The inbound message an item came from (unwrapping handbacks), if the inbox still has it. */
  function originalEnvelope(envelopeId: string | undefined): Envelope | null {
    if (!envelopeId) return null;
    const [m] = kernel.inbox.listMessagesSync({ envelopeId, limit: 1 });
    if (!m) return null;
    return isEnvelopeOfType(m.envelope, "handback") ? m.envelope.payload.original : m.envelope;
  }

  // ==================== top bar ====================

  async function capture(req: CaptureRequest): Promise<CaptureResponse> {
    const text = typeof req?.text === "string" ? req.text : "";
    const attachments = Array.isArray(req?.attachments)
      ? req.attachments.filter((a) => a && typeof a.label === "string" && typeof a.uri === "string").map((a) => ({ label: a.label, uri: a.uri }))
      : undefined;
    if (!text.trim() && !attachments?.length) throw bad("随手记不能为空");
    if (req.clientId !== undefined && (typeof req.clientId !== "string" || !/^[\w.:-]{1,80}$/.test(req.clientId))) throw bad("clientId 格式不对");
    const env = await ui.capture({
      text,
      ...(attachments?.length ? { attachments } : {}),
      ...(req.voice ? { voice: true } : {}),
      ...(req.clientId ? { clientId: req.clientId } : {}),
    });
    return { ok: true, id: env.id, acceptedAt: env.createdAt, message: "已收进信箱", status: status() };
  }

  async function focus(req: FocusRequest): Promise<FocusResponse> {
    if (typeof req?.on !== "boolean") throw bad("on 必须是 true 或 false");
    const flushed = await kernel.setFocus(req.on);
    const f = { on: kernel.hub.isFocusSync(), buffered: kernel.hub.bufferedCountSync() };
    const delivered = flushed ? flushed.sent + flushed.failed + flushed.unknown : 0;
    const message = req.on
      ? "已开启免打扰：非紧急通知先暂存，退出专注后再看"
      : delivered > 0
        ? `已退出专注，送达 ${flushed!.sent} 条暂存通知${flushed!.failed + flushed!.unknown > 0 ? `（${flushed!.failed + flushed!.unknown} 条未确认送达）` : ""}`
        : "已退出专注";
    return { ok: true, focus: f, flushed, message, status: status() };
  }

  // ==================== 📥 Clarify ====================

  function approval(cardId: string): ApprovalRecord {
    const rec = gate.getApprovalSync(cardId);
    if (!rec) throw missing("找不到这张卡");
    return rec;
  }

  function pendingCard(cardId: string): { rec: ApprovalRecord; card: ClarifyCard | null } {
    const rec = approval(cardId);
    if (rec.status !== "pending") throw wrongState("这张卡已经处理过了");
    return { rec, card: asClarifyCard(rec.card.data) };
  }

  function clarifyResult(outcome: ClarifyOutcome, ok: boolean, message: string, cardId: string, extra: Partial<ClarifyMutationResponse> = {}): ClarifyMutationResponse {
    const view = clarify();
    return { ok, outcome, message, view, status: status(), card: view.cards.find((c) => c.id === cardId) ?? null, ...extra };
  }

  function kernelRefusal(r: ResolveApprovalResult, cardId: string): ClarifyMutationResponse {
    if (r.status === "not_found") return clarifyResult("not_found", false, "找不到这张卡", cardId);
    return clarifyResult("not_pending", false, "这张卡已经处理过了", cardId);
  }

  const APPROVE_MESSAGE: Readonly<Record<ApproveOutcome, string>> = {
    sent: "已发送",
    approved: "已确认，Agent 继续推进",
    failed: "发送失败，对方没有收到。可以重新发送",
    unknown: "发送结果未知，请核实",
    version_mismatch: "草稿已更新，请重看",
    already_cancelled: "这件事已经取消或撤回了",
    not_found: "找不到这张卡",
  };

  async function runApprove(cardId: string, seenVersion: number | null | undefined) {
    if (seenVersion !== undefined && seenVersion !== null && (!Number.isInteger(seenVersion) || seenVersion < 1)) throw bad("seenVersion 必须是正整数");
    const before = gate.getApprovalSync(cardId);
    const r = await kernel.resolveApproval(cardId, { decision: "approve", ...(seenVersion != null ? { seenArtifactVersion: seenVersion } : {}) });
    let outcome: ApproveOutcome;
    switch (r.status) {
      case "sent":
      case "failed":
      case "unknown":
      case "approved":
      case "version_mismatch":
      case "already_cancelled":
      case "not_found":
        outcome = r.status;
        break;
      default:
        outcome = "already_cancelled";
    }
    let message = APPROVE_MESSAGE[outcome];
    const beforeCard = asClarifyCard(before?.card.data);
    if (outcome === "approved" && before?.action.type === "project.start") message = "已确认立项，Agent 开始推进";
    if (outcome === "approved" && beforeCard?.cardType === "response" && beforeCard.confirmVerb === "accept") message = "已收下";
    if (outcome === "approved" && beforeCard?.cardType === "response" && beforeCard.confirmVerb === "merge") message = "已确认合入，Agent 继续推进";
    if (outcome === "sent" && beforeCard?.cardType === "escalation") message = "已发送催问，继续跟进";
    return {
      outcome,
      message,
      ...(r.status === "version_mismatch" ? { currentVersion: r.currentVersion } : {}),
      ...("error" in r && r.error ? { error: r.error } : {}),
    };
  }

  async function approve(cardId: string, req: ApproveRequest) {
    const r = await runApprove(cardId, req?.seenVersion);
    // "✓ 确认立项并让 Agent 开工" creates the project root right here (docs/04 §2.2 B); the desk's own wake-up on the
    // approval finds it started (same root id) and only keeps the books.
    if (r.outcome === "approved") {
      try {
        startApprovedProjectSync(kernel, cardId);
      } catch (err) {
        // The approval stands; the desk's own wake-up on it retries the start.
        onError(err, `start the project of ${cardId}`);
      }
    }
    const view = clarify();
    const ok = r.outcome === "sent" || r.outcome === "approved";
    return { ok, ...r, view, status: status(), card: view.cards.find((c) => c.id === cardId) ?? null };
  }

  async function revise(cardId: string, req: ReviseRequest): Promise<ClarifyMutationResponse> {
    const instruction = typeof req?.instruction === "string" ? req.instruction.trim() : "";
    if (!instruction) throw bad("说说要怎么改");
    approval(cardId);
    const r = await kernel.resolveApproval(cardId, { decision: "revise", instruction, ...(req.voice ? { voice: true } : {}) });
    if (r.status !== "revising") return kernelRefusal(r, cardId);
    return clarifyResult("revising", true, "收到，正在按你的意见重拟", cardId);
  }

  async function snooze(cardId: string, req: SnoozeRequest): Promise<ClarifyMutationResponse> {
    const t = now();
    const until = req?.until ?? afternoonSlot(t, settings.snoozeAfternoonHour);
    if (!Number.isFinite(until) || until <= t) throw bad("推迟时间必须在将来");
    approval(cardId);
    const r = await kernel.resolveApproval(cardId, { decision: "snooze", until });
    if (r.status !== "snoozed") return kernelRefusal(r, cardId);
    return clarifyResult("snoozed", true, `已推迟到 ${whenText(until, t)}，到点回到待确认`, cardId);
  }

  function proposalOf(rec: ApprovalRecord, card: ClarifyCard | null): ProjectProposal {
    if (card?.cardType !== "project_proposal") throw wrongState("这不是立项卡");
    const draftId = rec.artifactId ?? card.draft?.artifactId;
    const data = draftId ? (context.getArtifactSync(draftId)?.content.data as Partial<ProjectProposal> | undefined) : undefined;
    return data && typeof data.outcome === "string" && Array.isArray(data.actions) ? ({ ...card.proposal, ...data } as ProjectProposal) : card.proposal;
  }

  async function someday(cardId: string, _req: NoteRequest): Promise<ClarifyMutationResponse> {
    const { rec, card } = pendingCard(cardId);
    const proposal = proposalOf(rec, card);
    const r = await kernel.resolveApproval(cardId, { decision: "dismiss", reason: "someday" });
    if (r.status !== "dismissed") return kernelRefusal(r, cardId);
    // The project record needs a cell to live in; a closed one costs nothing and keeps the plan for "重新启动".
    const projectId = newId("proj", clock);
    const t = now();
    const record: ProjectRecord & { proposal: ProjectProposal } = {
      title: proposal.title,
      outcome: proposal.outcome,
      lifecycle: "someday",
      ...(card?.source ? { source: card.source } : {}),
      createdAt: t,
      updatedAt: t,
      proposal,
    };
    withTx(kernel.db, () => {
      kernel.spawnCell(rec.cellId, { id: projectId, preset: "worker", title: proposal.title, meta: { projectCellId: projectId, someday: true } });
      commitState(projectId, { [gtdKeys.project]: record });
    });
    // Closed by its parent: nobody needs to be woken for a holder that never ran.
    await kernel.closeCell(projectId, "cancelled", { principalId: cellPrincipal(rec.cellId) });
    return clarifyResult("someday", true, `「${proposal.title}」已放进以后再说`, cardId, { projectId });
  }

  async function savePlan(cardId: string, req: PlanSaveRequest): Promise<ClarifyMutationResponse> {
    const { rec, card } = pendingCard(cardId);
    if (card?.cardType !== "project_proposal") throw wrongState("这不是立项卡");
    const draftId = rec.artifactId ?? card.draft?.artifactId;
    const art = draftId ? context.getArtifactSync(draftId) : null;
    if (!art) throw wrongState("这张卡的方案不能在这里修改");
    if (!Number.isInteger(req?.expectedVersion)) throw bad("expectedVersion 必须是整数");
    const p = req.proposal;
    if (!p || typeof p.outcome !== "string" || !Array.isArray(p.actions)) throw bad("方案需要 outcome 和 actions");
    const owners = new Set<BallOwner>(["human", "agent", "waiting"]);
    const actions = p.actions.map((a) => {
      if (!a || typeof a.title !== "string" || !a.title.trim() || !owners.has(a.owner)) throw bad("每个动作都需要标题和负责方（human / agent / waiting）");
      if (a.effort !== undefined && !isEffort(a.effort)) throw bad(`未知的精力标签 ${String(a.effort)}`);
      return { title: a.title.trim(), owner: a.owner, ...(a.effort ? { effort: a.effort } : {}), ...(a.nextStep ? { nextStep: a.nextStep } : {}) };
    });
    const proposal: ProjectProposal = {
      ...proposalOf(rec, card),
      title: typeof p.title === "string" && p.title.trim() ? p.title.trim() : proposalOf(rec, card).title,
      outcome: p.outcome,
      ...(p.background !== undefined ? { background: p.background } : {}),
      actions,
    };
    const r = context.commitSync(art.cellId, {
      artifact: {
        artifactId: art.artifactId,
        content: { format: "json", title: proposal.title, body: JSON.stringify(proposal, null, 2), data: proposal },
        updatedBy: "human",
        expectedVersion: req.expectedVersion,
      },
    });
    if (!r.ok) {
      return clarifyResult("conflict", false, "方案在你编辑时被更新了，请看一下最新版本再保存", cardId, { current: artifactDTO(kernel, art.artifactId, now())! });
    }
    return clarifyResult("saved", true, `已保存方案 v${r.artifactVersion}`, cardId);
  }

  async function extend(cardId: string, req: ExtendRequest): Promise<ClarifyMutationResponse> {
    const { rec, card } = pendingCard(cardId);
    if (card?.cardType !== "escalation" && rec.action.type !== "custom") throw wrongState("只有受阻 / 超时的卡可以“继续”");
    const t = now();
    const reason = card?.cardType === "escalation" ? card.escalation.reason : null;
    const note = typeof req?.note === "string" ? req.note : undefined;
    let message: string;
    let r: ResolveApprovalResult;
    if (reason === "waiting_timeout") {
      const until = req?.until ?? t + DAY;
      if (!Number.isFinite(until) || until <= t) throw bad("等待时间必须在将来");
      r = await kernel.resolveApproval(cardId, { decision: "continue", until, ...(note ? { note } : {}) });
      message = `好的，再等到 ${whenText(until, t)}`;
    } else {
      const raise = req?.raise;
      if (raise !== undefined && (typeof raise !== "object" || [raise.tokens, raise.cents].some((v) => v !== undefined && (!Number.isFinite(v) || v < 0)))) {
        throw bad("raise 需要非负的 tokens / cents");
      }
      r = await kernel.resolveApproval(cardId, { decision: "continue", ...(raise ? { raise } : {}), ...(note ? { note } : {}) });
      message = reason === "budget_exhausted" ? "已追加额度，继续推进" : reason === "retry_limit" ? "已重新开始处理" : "好的，继续推进";
    }
    if (r.status !== "continued") return kernelRefusal(r, cardId);
    return clarifyResult("continued", true, message, cardId);
  }

  async function resolveOffline(cardId: string, req: NoteRequest): Promise<ClarifyMutationResponse> {
    approval(cardId);
    const r = await kernel.resolveApproval(cardId, { decision: "resolve_offline", ...(req?.note ? { note: req.note } : {}) });
    if (r.status !== "resolved_offline") return kernelRefusal(r, cardId);
    settleClosedCells(r.closedCellIds, "done");
    const n = r.closedCellIds.length;
    return clarifyResult("resolved_offline", true, n > 0 ? `已完结，并结束了 ${n} 项相关后台任务` : "已完结", cardId);
  }

  async function toHuman(cardId: string, req: ToHumanRequest): Promise<ClarifyMutationResponse> {
    const { rec, card } = pendingCard(cardId);
    if (req?.effort !== undefined && !isEffort(req.effort)) throw bad(`未知的精力标签 ${String(req.effort)}`);
    const t = now();
    const title = card?.title ?? rec.card.title ?? rec.action.summary;
    const projectCellId = approvalProjectId(kernel, rec);
    const isReply = rec.action.type === "channel.send" && card?.cardType === "response";
    let nextStep = req?.nextStep;
    let artifactId: string | undefined;
    if (card?.cardType === "response") {
      nextStep ??= `改好草稿后发给 ${card.reply.targetLabel}`;
      artifactId = card.draft.artifactId;
    } else if (card?.cardType === "project_proposal") {
      nextStep ??= card.proposal.actions.find((a) => a.owner === "human")?.nextStep ?? `自己推进：${card.proposal.outcome}`;
      artifactId = rec.artifactId ?? card.draft?.artifactId;
    } else if (card?.cardType === "escalation") {
      nextStep ??= card.escalation.explanation.split("\n")[0];
      artifactId = card.escalation.nudgeDraft?.artifactId;
    }
    const action: ActionRecord & { approvalActionId?: string } = {
      id: newId("act", clock),
      title,
      owner: "human",
      status: "open",
      ...(projectCellId ? { projectCellId } : {}),
      ...(nextStep ? { nextStep } : {}),
      effort: req?.effort ?? (isReply ? "15m" : "45m"),
      ...(artifactId ? { artifactId } : {}),
      ...(card?.prep.checked.length ? { references: card.prep.checked } : {}),
      ...(card?.source ? { source: card.source } : {}),
      createdAt: t,
      updatedAt: t,
      // A reply stays a pending approval behind the Engage item, so "定稿发送" still sends the exact reviewed version.
      ...(isReply ? { approvalActionId: rec.actionId } : {}),
    };
    if (!isReply) {
      const r = await kernel.resolveApproval(cardId, { decision: "dismiss", reason: "the owner handles it personally" });
      if (r.status !== "dismissed") return kernelRefusal(r, cardId);
    }
    withTx(kernel.db, () => {
      commitState(rec.cellId, { [gtdKeys.action(action.id)]: action });
      if (!isReply) wakeBookkeeper(rec.cellId);
    });
    return clarifyResult("to_human", true, "已转给你处理，在专注工作区里", cardId, { engageItem: { cellId: rec.cellId, actionId: action.id } });
  }

  async function dismiss(cardId: string, req: NoteRequest): Promise<ClarifyMutationResponse> {
    const { rec, card } = pendingCard(cardId);
    const r = await kernel.resolveApproval(cardId, { decision: "dismiss", reason: req?.note || "dismissed by the owner" });
    if (r.status !== "dismissed") return kernelRefusal(r, cardId);
    wakeBookkeeper(rec.cellId);
    const env = originalEnvelope(card?.source.envelopeId);
    addActivity({
      kind: "card_withdrawn",
      title: card?.title ?? rec.card.title ?? rec.action.summary,
      detail: "你选择了不处理",
      ...(card?.source ? { source: card.source } : {}),
      ...(card?.rawInput.text ? { rawInput: card.rawInput.text } : {}),
      ...(env ? { envelope: env } : {}),
      actionId: rec.actionId,
      restorable: env !== null,
    });
    return clarifyResult("dismissed", true, env ? "已归档，可在记录里移回待确认" : "已归档", cardId);
  }

  async function deny(cardId: string, req: NoteRequest): Promise<ClarifyMutationResponse> {
    approval(cardId);
    const r = await kernel.resolveApproval(cardId, { decision: "deny", ...(req?.note ? { reason: req.note } : {}) });
    if (r.status !== "denied") return kernelRefusal(r, cardId);
    return clarifyResult("denied", true, "已拒绝", cardId);
  }

  async function verify(cardId: string, req: VerifyRequest): Promise<ClarifyMutationResponse> {
    if (req?.verdict !== "sent" && req?.verdict !== "failed") throw bad("verdict 必须是 sent 或 failed");
    const rec = approval(cardId);
    if (rec.status !== "unknown") throw wrongState("这条消息的发送结果不是“未知”");
    const r = kernel.resolveUnknownSend(cardId, req.verdict, req.note);
    if (r !== "resolved") throw wrongState("这条消息的发送结果不是“未知”");
    return clarifyResult("verified", true, req.verdict === "sent" ? "已记录：对方收到了" : "已记录：对方没收到，可以重新发送", cardId);
  }

  async function abandon(cardId: string, _req: NoteRequest): Promise<ClarifyMutationResponse> {
    const rec = approval(cardId);
    if (rec.status !== "failed") throw wrongState("只有发送失败的消息可以放弃");
    const card = asClarifyCard(rec.card.data);
    addActivity({
      kind: "card_withdrawn",
      title: card?.title ?? rec.card.title ?? rec.action.summary,
      detail: "发送失败后你选择了不再发送",
      ...(card?.source ? { source: card.source } : {}),
      actionId: rec.actionId,
      restorable: true,
    });
    return clarifyResult("abandoned", true, "已放弃发送", cardId);
  }

  // ==================== 🎯 Engage ====================

  function engageResult(outcome: EngageOutcome, ok: boolean, message: string, extra: Partial<EngageMutationResponse> = {}): EngageMutationResponse {
    return { ok, outcome, message, view: engage(), status: status(), ...extra };
  }

  /** The cells that existed only for this action: not a root, not a project root, nothing else open in them. */
  function dedicatedCells(a: Located<ActionRecord>): string[] {
    const cell = kernel.getCell(a.cellId);
    if (!cell || cell.status === "closed" || cell.parentId === null) return [];
    if (context.readStateSync(a.cellId, gtdKeys.project) !== null) return [];
    const others = readActions(kernel).some((x) => x.cellId === a.cellId && x.record.id !== a.record.id && x.record.status === "open");
    return others ? [] : [a.cellId];
  }

  async function completeAction(a: Located<ActionRecord>, detail: string, activityId?: string): Promise<number> {
    const toClose = dedicatedCells(a);
    withTx(kernel.db, () => {
      finishActions([a], "done");
      const rec = { kind: "action_completed" as const, title: a.record.title, detail, ...(a.record.source ? { source: a.record.source } : {}), restorable: false };
      if (activityId) commitState(desk, { [gtdKeys.activity(activityId)]: { ...rec, id: activityId, at: now() } satisfies ActivityRecord });
      else addActivity(rec);
      // An item root keeps its project's books: tell it, so the item completes when this was its last open action.
      wakeBookkeeper(a.cellId);
    });
    let closed = 0;
    for (const id of toClose) closed += (await kernel.closeCell(id, "completed")).closed.length;
    return closed;
  }

  async function done(cellId: string, actionId: string, req: DoneRequest): Promise<EngageMutationResponse> {
    const a = findAction(cellId, actionId);
    if (a.record.status !== "open") return engageResult("already_done", true, "这件事已经办完了");
    const linked = linkedApprovalId(a.record);
    if (linked && gate.getApprovalSync(linked)?.status === "pending") {
      await kernel.resolveApproval(linked, { decision: "dismiss", reason: "the owner handled it personally" });
    }
    const closedTasks = await completeAction(a, req?.note || "你勾选了已办完");
    return engageResult("done", true, closedTasks > 0 ? `已办完，并结束了 ${closedTasks} 项相关后台任务` : "已办完", { closedTasks });
  }

  async function engageSend(cellId: string, actionId: string, req: EngageSendRequest): Promise<EngageMutationResponse> {
    const a = findAction(cellId, actionId);
    const linked = linkedApprovalId(a.record);
    if (!linked) throw wrongState("这件事没有待发送的草稿");
    if (a.record.status !== "open") return engageResult("already_done", true, "这件事已经办完了");
    if (!Number.isInteger(req?.seenVersion)) throw bad("seenVersion 必须是整数");
    const r = await runApprove(linked, req.seenVersion);
    let closedTasks = 0;
    // An unknown send is the channel's problem to verify (it stays in Clarify); the owner's part is done.
    // Same activity id as the desk's own record of a sent reply, so one send is one entry in the drawer.
    if (r.outcome === "sent" || r.outcome === "unknown") closedTasks = await completeAction(a, r.outcome === "sent" ? "定稿已发送" : "定稿已发出，结果待核实", `sent-${linked}`);
    const ok = r.outcome === "sent";
    return engageResult(r.outcome, ok, r.outcome === "unknown" ? `${r.message}（在待确认里核实）` : r.message, {
      closedTasks,
      ...(r.currentVersion !== undefined ? { currentVersion: r.currentVersion } : {}),
      ...(r.error ? { error: r.error } : {}),
    });
  }

  // ==================== drafts ====================

  function saveArtifact(artifactId: string, req: ArtifactSaveRequest): ArtifactSaveResponse {
    const art = context.getArtifactSync(artifactId);
    if (!art) throw missing(`没有这份草稿 ${artifactId}`);
    if (!Number.isInteger(req?.expectedVersion) || req.expectedVersion < 1) throw bad("expectedVersion 必须是正整数");
    if (typeof req.body !== "string") throw bad("body 必须是文本");
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
    return { ok: true, outcome: "saved", message: `已保存 v${r.artifactVersion}`, artifact: artifact(artifactId) };
  }

  function dismissParked(artifactId: string, parkedId: string): ArtifactDTO {
    if (!context.listParkedSync(artifactId).some((p) => p.id === parkedId)) throw missing("这条补充信息已经移除了");
    context.dismissParkedSync(parkedId);
    return artifact(artifactId);
  }

  // ==================== 🧭 Radar ====================

  function projectRecord(projectId: string): ProjectRecord & { proposal?: ProjectProposal } {
    const v = context.readStateSync<ProjectRecord & { proposal?: ProjectProposal }>(projectId, gtdKeys.project);
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

  /** Cards about the project held outside its own cells (e.g. by the desk) go with it. */
  async function withdrawProjectCards(projectId: string, reason: string): Promise<void> {
    const rec = gate.findPendingBySubjectSync(subjectKeys.project(projectId));
    if (rec) await kernel.resolveApproval(rec.actionId, { decision: "dismiss", reason });
  }

  function setLifecycle(projectId: string, record: ProjectRecord, lifecycle: ProjectRecord["lifecycle"]): void {
    const t = now();
    const { stalledSince: _s, ...rest } = record;
    commitState(projectId, { [gtdKeys.project]: { ...rest, lifecycle, updatedAt: t, ...(lifecycle === "completed" ? { completedAt: t } : {}) } });
  }

  async function projectOp(projectId: string, op: "pause" | "resume" | "cancel" | "complete" | "someday" | "activate"): Promise<ProjectMutationResponse> {
    const record = projectRecord(projectId);
    const cell = kernel.getCell(projectId);
    const open = cell !== undefined && cell.status !== "closed";
    const control = (action: "pause" | "resume" | "cancel") => kernel.control(projectId, { action });
    switch (op) {
      case "pause": {
        if (!open) return projectResult("not_applied", false, "这个项目没有在运行的任务");
        const r = control("pause");
        return r.applied ? projectResult("paused", true, `已暂停「${record.title}」`) : projectResult("not_applied", false, r.reason ?? "暂停没有生效");
      }
      case "resume": {
        if (!open) return projectResult("not_applied", false, "这个项目没有可以继续的任务");
        const r = control("resume");
        return r.applied ? projectResult("resumed", true, `「${record.title}」继续推进`) : projectResult("not_applied", false, r.reason ?? "继续没有生效");
      }
      case "cancel": {
        if (open) {
          const r = control("cancel");
          if (!r.applied) return projectResult("not_applied", false, r.reason ?? "取消没有生效");
        }
        setLifecycle(projectId, record, "cancelled");
        finishActions(projectActions(projectId), "cancelled");
        await withdrawProjectCards(projectId, "the project was cancelled");
        return projectResult("cancelled", true, `已取消「${record.title}」，后台任务已全部停止`);
      }
      case "complete": {
        if (open) await kernel.closeCell(projectId, "completed");
        setLifecycle(projectId, record, "completed");
        finishActions(projectActions(projectId), "done");
        await withdrawProjectCards(projectId, "the project was completed");
        return projectResult("completed", true, `「${record.title}」已完结`);
      }
      case "someday": {
        if (record.lifecycle === "someday") return projectResult("someday", true, "已经在以后再说里了");
        if (open && cell.status === "active") control("pause");
        setLifecycle(projectId, record, "someday");
        return projectResult("someday", true, `「${record.title}」已移进以后再说，后台任务已暂停`);
      }
      case "activate": {
        if (record.lifecycle !== "someday") return projectResult("not_applied", false, "这个项目不在以后再说里");
        if (open) {
          if (cell.status === "paused") control("resume");
          setLifecycle(projectId, record, "active");
          return projectResult("activated", true, `「${record.title}」重新开始推进`);
        }
        const cardId = repropose(projectId, record);
        return projectResult("reproposed", true, "已重新放进待确认，确认后 Agent 开工", { cardId });
      }
    }
  }

  /** A someday project that never started goes back to Clarify as a proposal card, so the agent plans it for real. */
  function repropose(projectId: string, record: ProjectRecord & { proposal?: ProjectProposal }): string {
    const parentId = kernel.getCell(projectId)?.parentId ?? desk;
    const holder = kernel.getCell(parentId);
    if (!holder || holder.status === "closed") throw wrongState("原来负责这个项目的主台已经不在了");
    const t = now();
    const proposal: ProjectProposal = record.proposal ?? { title: record.title, outcome: record.outcome ?? record.title, actions: [] };
    const artifactId = newId("art", clock);
    const subjectKey = subjectKeys.cell(projectId);
    const source: ItemSource = { label: "以后再说", at: t };
    return withTx(kernel.db, () => {
      const saved = context.commitSync(parentId, {
        artifact: { artifactId, content: { format: "json", title: proposal.title, body: JSON.stringify(proposal, null, 2), data: proposal }, updatedBy: "human" },
      });
      if (!saved.ok) throw new Error("could not save the plan");
      const version = saved.artifactVersion ?? 1;
      const card: ProjectProposalCard = {
        cardType: "project_proposal",
        subjectKey,
        title: proposal.title,
        source,
        rawInput: { text: record.outcome ?? record.title, kind: "system" },
        prep: { summary: "你把它从“以后再说”里重新拿了出来，确认后按这个方案开工。", checked: [] },
        proposal,
        draft: { artifactId, version },
      };
      const r = gate.authorizeSync(
        {
          type: "project.start",
          proposal,
          summary: `重新启动：${proposal.title}`,
          subjectKey,
          sideEffect: "external",
          artifactId,
          card: { format: "card", title: proposal.title, body: `${proposal.title}\n\n${proposal.outcome}`, data: card },
        },
        { cellId: parentId, principalId: owner, epoch: holder.epoch, artifactVersion: version },
      );
      if (r.type !== "defer") throw wrongState(r.type === "deny" ? `无法重新提出：${r.feedback}` : "已有自动规则放行立项，请在待确认之外处理");
      // The holder's record is replaced by the card; the approved project gets a fresh cell.
      commitState(projectId, { [gtdKeys.project]: null });
      return r.actionId;
    });
  }

  async function addProjectAction(projectId: string, req: AddActionRequest): Promise<ProjectMutationResponse> {
    const record = projectRecord(projectId);
    const title = typeof req?.title === "string" ? req.title.trim() : "";
    if (!title) throw bad("下一步需要一个标题");
    if (req.effort !== undefined && !isEffort(req.effort)) throw bad(`未知的精力标签 ${String(req.effort)}`);
    const t = now();
    const action: ActionRecord = {
      id: newId("act", clock),
      title,
      owner: "human",
      status: "open",
      projectCellId: projectId,
      nextStep: typeof req.nextStep === "string" && req.nextStep.trim() ? req.nextStep.trim() : title,
      ...(req.effort ? { effort: req.effort } : {}),
      createdAt: t,
      updatedAt: t,
    };
    const { stalledSince: _s, ...rest } = record;
    commitState(projectId, { [gtdKeys.action(action.id)]: action, ...(record.stalledSince !== undefined ? { [gtdKeys.project]: { ...rest, updatedAt: t } } : {}) });
    return projectResult("action_added", true, `已补上下一步：${title}`);
  }

  // ==================== weekly review ====================

  function reviewResult(outcome: ReviewMutationResponse["outcome"], ok: boolean, message: string): ReviewMutationResponse {
    return { ok, outcome, message, view: review(), status: status() };
  }

  function acceptSkill(slug: string): ReviewMutationResponse {
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

  function dismissSkill(slug: string): ReviewMutationResponse {
    const key = `${SKILL_SUGGESTION_PREFIX}${slug}`;
    if (context.readStateSync(desk, key) === null) throw missing("这条技能建议已经不在了");
    commitState(desk, { [key]: null });
    return reviewResult("dismissed", true, "好的，不保存");
  }

  function enableRule(req: EnableRuleRequest): ReviewMutationResponse {
    if (typeof req?.actionClass !== "string") throw bad("需要 actionClass");
    const maxUses = req.maxUses ?? 20;
    if (!Number.isInteger(maxUses) || maxUses < 1) throw bad("maxUses 必须是正整数");
    const rule = ruleInputForClass(req.actionClass, { createdBy: owner, maxUses, note: "周回顾中开启的自动执行" });
    if (!rule) throw bad("这类操作不能改成自动执行");
    gate.upsertPolicyRuleSync(rule);
    gate.markTrustSuggestedSync([req.actionClass]);
    return reviewResult("rule_enabled", true, `已改成自动执行（最多 ${maxUses} 次）`);
  }

  function dismissRule(req: EnableRuleRequest): ReviewMutationResponse {
    if (typeof req?.actionClass !== "string") throw bad("需要 actionClass");
    gate.markTrustSuggestedSync([req.actionClass]);
    return reviewResult("dismissed", true, "好的，这类操作仍然每次请你确认");
  }

  /** A script check runs bash, which the kernel refuses on the owner's real directory: it gets its own worktree. */
  function sensorBounds(entry: string | undefined): { isolation: "none" | "git_worktree"; tools: ReadonlySet<ToolKind> } {
    return entry?.startsWith(SCRIPT_PREFIX)
      ? { isolation: "git_worktree", tools: new Set<ToolKind>(["read", "bash"]) }
      : { isolation: "none", tools: new Set<ToolKind>(["read"]) };
  }

  function checkEntry(entry: unknown): string {
    if (typeof entry !== "string" || !entry.trim()) throw bad("需要脚本路径或检查名");
    const e = entry.trim();
    if (e.startsWith(SCRIPT_PREFIX)) {
      if (e.length === SCRIPT_PREFIX.length) throw bad("script: 后面需要脚本路径");
      return e;
    }
    if (!kernel.registry.codeProcessors.has(e)) throw bad(`没有名为 ${e} 的检查`);
    return e;
  }

  function sensorToCode(sensorId: string, req: SensorToCodeRequest): ReviewMutationResponse {
    const src = context.readStateSync<SourceRecord>(sensorId, gtdKeys.source);
    const cell = kernel.getCell(sensorId);
    if (!src || !cell || cell.status === "closed") throw missing("找不到这个信源");
    const entry = checkEntry(req?.entry);
    kernel.updateCell(sensorId, { processor: { kind: "code", entry }, bounds: sensorBounds(entry) });
    commitState(sensorId, { [gtdKeys.source]: { ...src, processor: "code", updatedAt: now() } });
    commitState(desk, { [`${SENSOR_SUGGESTION_PREFIX}${sensorId}`]: null });
    return reviewResult("switched_to_code", true, `「${src.title}」已改为零 Token 的脚本检查`);
  }

  // ==================== activity drawer ====================

  function restoreActivity(cellId: string, activityId: string): ActivityMutationResponse {
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
    const original = r.envelope ?? (r.actionId ? originalEnvelope(asClarifyCard(gate.getApprovalSync(r.actionId)?.card.data)?.source.envelopeId) : null);
    if (original) {
      const handback = createEnvelope<HandbackPayload>(
        {
          id: `${original.id}#restore#${activityId}`,
          from: KERNEL_FROM.router,
          principalId: owner,
          kind: "event",
          type: PAYLOAD.handback,
          payload: { original, fromCellId: desk, reason: RESTORE_REASON },
        },
        clock,
      );
      context.commitSync(cellId, { statePatches: { [key]: restored }, inboxOut: [{ to: inboxAddr(desk), envelope: handback }] });
      return result("restored", true, "已移回待确认，Agent 正在准备卡片");
    }
    // An abandoned failed send has no message to re-triage: un-hiding the card is the whole restore.
    if (r.actionId && gate.getApprovalSync(r.actionId)?.status === "failed") {
      commitState(cellId, { [key]: restored });
      return result("restored", true, "已移回待确认");
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
    if (!Number.isInteger(m) || m < 1) throw bad("everyMinutes 必须是正整数");
    if (m < 60) return { cron: `*/${m} * * * *` };
    if (m % 60 === 0 && m <= 24 * 60) return { cron: m === 24 * 60 ? "0 0 * * *" : `0 */${m / 60} * * *` };
    throw bad("everyMinutes 需小于 60，或是 60 的整数倍（最多 1440）");
  }

  function createSource(req: CreateSourceRequest): SourcesMutationResponse {
    const title = typeof req?.title === "string" ? req.title.trim() : "";
    if (!title) throw bad("信源需要一个名字");
    const schedule = cronOf(req.schedule);
    const check = req.check;
    if (!check || typeof check !== "object") throw bad("需要说明检查方式");
    let processor: { kind: "code"; entry: string } | undefined;
    let instruction = typeof req.description === "string" && req.description.trim() ? req.description.trim() : title;
    if (check.kind === "script") {
      if (typeof check.path !== "string" || !check.path.trim()) throw bad("需要脚本路径");
      processor = { kind: "code", entry: `${SCRIPT_PREFIX}${check.path.trim()}` };
    } else if (check.kind === "code") {
      processor = { kind: "code", entry: checkEntry(check.entry) };
    } else if (check.kind === "llm") {
      if (typeof check.instruction !== "string" || !check.instruction.trim()) throw bad("需要说明要检查什么");
      instruction = check.instruction.trim();
    } else {
      throw bad("检查方式必须是 script / code / llm");
    }
    const mode = req.mode === "observe" ? "observe" : "active";
    const id = newId("src", clock);
    const t = now();
    const record: SourceRecord = {
      title,
      ...(typeof req.description === "string" && req.description ? { description: req.description } : {}),
      kind: "cron",
      schedule,
      mode,
      status: "ok",
      processor: processor ? "code" : "llm",
      runCount: 0,
      hitCount: 0,
      createdAt: t,
      updatedAt: t,
    };
    const { runCount: _r, hitCount: _h, status: _s, createdAt: _c, updatedAt: _u, ...init } = record;
    withTx(kernel.db, () => {
      // Same shape as the desk's own add_source: the first task runs the check once; meta.gtd.source seeds the record.
      kernel.spawnCell(
        desk,
        { id, preset: "sensor", title, schedules: [schedule], ...(processor ? { processor } : {}), bounds: sensorBounds(processor?.entry), meta: { gtd: { source: init } } },
        { instruction, title },
      );
      commitState(id, { [gtdKeys.source]: record });
    });
    return sourcesResult("created", true, `已添加信源「${title}」`, id);
  }

  function sourceRecord(sensorId: string): SourceRecord {
    const src = context.readStateSync<SourceRecord>(sensorId, gtdKeys.source);
    const cell = kernel.getCell(sensorId);
    if (!src || !cell || cell.status === "closed") throw missing("找不到这个信源");
    return src;
  }

  function pauseSource(sensorId: string, pause: boolean): SourcesMutationResponse {
    const src = sourceRecord(sensorId);
    const r = kernel.control(sensorId, { action: pause ? "pause" : "resume" });
    if (!r.applied) throw wrongState(r.reason ?? "操作没有生效");
    commitState(sensorId, { [gtdKeys.source]: { ...src, status: pause ? "paused" : "ok", updatedAt: now() } });
    return sourcesResult(pause ? "paused" : "resumed", true, pause ? `已暂停「${src.title}」` : `「${src.title}」恢复运行`, sensorId);
  }

  function setSourceMode(sensorId: string, req: SourceModeRequest): SourcesMutationResponse {
    if (req?.mode !== "active" && req?.mode !== "observe") throw bad("mode 必须是 active 或 observe");
    const src = sourceRecord(sensorId);
    commitState(sensorId, { [gtdKeys.source]: { ...src, mode: req.mode, updatedAt: now() } });
    return sourcesResult(
      "mode_changed",
      true,
      req.mode === "observe" ? `「${src.title}」改为只记观察笔记，不再弹卡` : `「${src.title}」命中时会投进信箱`,
      sensorId,
    );
  }

  async function deleteSource(sensorId: string): Promise<SourcesMutationResponse> {
    const src = sourceRecord(sensorId);
    const parentId = kernel.getCell(sensorId)?.parentId;
    // Closed as its parent: a deleted source is not news the desk needs to be woken for.
    await kernel.closeCell(sensorId, "cancelled", parentId ? { principalId: cellPrincipal(parentId) } : {});
    return sourcesResult("deleted", true, `已删除信源「${src.title}」`, sensorId);
  }

  return {
    status,
    clarify,
    clarifyCard: (cardId: string) => clarifyCardById(input(), cardId),
    radar,
    review,
    sources,
    activity,
    engage,
    engageDetail,
    artifact,
    capture,
    focus,
    approve,
    revise,
    snooze,
    someday,
    savePlan,
    extend,
    resolveOffline,
    toHuman,
    dismiss,
    deny,
    verify,
    abandon,
    done,
    engageSend,
    saveArtifact,
    dismissParked,
    projectOp,
    addProjectAction,
    acceptSkill,
    dismissSkill,
    enableRule,
    dismissRule,
    sensorToCode,
    restoreActivity,
    createSource,
    pauseSource,
    setSourceMode,
    deleteSource,
  };
}
