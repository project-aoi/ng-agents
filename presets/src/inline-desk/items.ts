import type { Kernel } from "@ng/cell";
import {
  asClarifyCard, cellPrincipal,
  gtdKeys,
  PAYLOAD,
  isChannelAddr,
  isEnvelopeOfType,
  isNgError,
  type ActionRecord,
  type ActivityRecord,
  type ApprovalResolvedPayload,
  type CellResultPayload,
  type ChannelAddr,
  type Clock,
  type Envelope,
  type ItemSource,
  type PrepareRunInput,
  isProjectProposal,
  type ProjectRecord,
  type ProjectStartAction,
  type RunPorts,
  type ToolContext,
  type UserMessagePayload,
  type VersionedArtifact,
} from "@ng/protocol";
import { projectLaunch, startProjectSync, type ProjectInit, type RepoRef } from "../project/launch";
import { KEYS, RESTORE_REASON, ROLES, type PresetsConfig } from "../shared/config";
import { notifyOwner } from "../shared/notify";
import { newAction, newActivity, patchAction, primaryItem, type RawInput } from "../shared/records";

// Desk-side bookkeeping shared by the desk's tools: what an inbound item is, the reply drafts the desk keeps cards for,
// and the deterministic follow-ups of background events (a reminder came due, a proposal was approved, a reply was
// sent, a project finished). The model decides what to do with an item; these keep the books.

/** A reply the desk drafted and keeps one card for (`desk:reply:<subjectKey>`). */
export interface ReplyItem {
  subjectKey: string;
  title: string;
  target: ChannelAddr;
  targetLabel: string;
  artifactId: string;
  actionId?: string;
  status: "pending" | "sent" | "withdrawn" | "closed";
  source: ItemSource;
  rawInput: RawInput;
  envelope?: Envelope;
  threads?: string[];
  createdAt: number;
  updatedAt: number;
}

/** What the desk remembers about a proposal until the owner decides (`desk:proposal:<artifactId>`). */
export interface ProposalItem {
  source: ItemSource;
  rawInput: RawInput;
  envelope?: Envelope;
  cwd?: string;
  repos?: RepoRef[];
  phases?: string[];
}

export interface ReminderData {
  kind: "reminder";
  id: string;
  text: string;
  effort?: "15m" | "45m" | "low_energy";
  remindAt?: number;
}

export function currentItem(ctx: ToolContext): Envelope | undefined {
  return primaryItem(ctx.snapshot.batch.envelopes);
}

/** The owner moved this item back from the archive ("移回待确认"): it must get a card. */
export function isRestored(ctx: ToolContext): boolean {
  return ctx.snapshot.batch.envelopes.some((e) => isEnvelopeOfType(e, "handback") && e.payload.reason === RESTORE_REASON);
}

/** Human actions the app linked to a reply card ("转给我处理" keeps the card pending behind them). */
export async function closeLinkedActions(ports: RunPorts, approvalActionId: string, status: "done" | "cancelled", now: number): Promise<Record<string, unknown>> {
  const patches: Record<string, unknown> = {};
  for (const e of await ports.context.listState(ports.self.cellId, gtdKeys.actionPrefix)) {
    const a = e.value as ActionRecord;
    if (a.approvalActionId === approvalActionId && a.status === "open") patches[e.key] = patchAction(a, { status }, now);
  }
  return patches;
}

export const WEEKLY_REVIEW_TIMER = "gtd-weekly-review";

/** Prefix of a settle line that reports a failure (apply_updates then returns an error result). */
export const SETTLE_ERROR = "⚠ 未能完成：";

/** The desk keeps its own weekly-review wake-up (re-enqueueing the same template id is a no-op). */
async function ensureWeeklyReview(cfg: PresetsConfig, ports: RunPorts): Promise<void> {
  if (!cfg.weeklyReview || ports.self.parentId !== null) return;
  await ports.scheduleSelf(
    { id: WEEKLY_REVIEW_TIMER, type: PAYLOAD.timerFired, payload: { label: "每周回顾：看看本周的改稿习惯和信源，有值得沉淀的就提建议", data: { gtd: { kind: "weekly_review" } } } },
    { cron: cfg.weeklyReview, tz: cfg.timeZone },
  );
}

export function replyAddressOf(env: Envelope | undefined): ChannelAddr | undefined {
  if (!env || !isEnvelopeOfType(env, "user.message")) return undefined;
  const r = (env.payload as UserMessagePayload).replyTo;
  return r && isChannelAddr(r) ? r : undefined;
}

/** The project an approval starts: derived from the approval id, so every path that starts it starts the same cell once. */
export const projectIdForApproval = (approvalId: string) => `proj_${approvalId.replace(/^act_/, "")}`;

/** `custom` action of present_to_owner cards: confirming only files the item as seen. */
export const ACKNOWLEDGE_ACTION = "gtd.acknowledge";

/**
 * The project an approved proposal starts: the plan version the owner saw (the json artifact, edits included), the
 * item it came from, and an id derived from the approval.
 */
export function approvedProjectInit(
  approvalId: string,
  action: ProjectStartAction,
  art: Pick<VersionedArtifact, "content"> | null,
  remembered: ProposalItem | null,
  clock: Clock,
): ProjectInit {
  const card = asClarifyCard(action.card?.data);
  const proposal = action.artifactId ? art?.content.data : action.proposal;
  if (!isProjectProposal(proposal)) throw new Error("立项方案的内容不完整，请修改方案后再确认");
  const brief = ["主人在立项卡上确认了这份方案（可能亲手改过），按它开始推进。", proposal.background ?? ""].filter(Boolean).join("\n");
  return {
    id: projectIdForApproval(approvalId),
    title: proposal.title,
    outcome: proposal.outcome,
    brief,
    proposal,
    plan: proposal.actions.map((a) => ({ title: a.title, owner: a.owner, ...(a.nextStep ? { nextStep: a.nextStep } : {}), ...(a.effort ? { effort: a.effort } : {}) })),
    source: card?.source ?? remembered?.source ?? { label: "立项", at: clock.now() },
    ...((card?.rawInput.text ?? remembered?.rawInput.text) ? {rawInput:(card?.rawInput.text ?? remembered?.rawInput.text)!} : {}),
    ...((proposal.cwd ?? remembered?.cwd) ? { cwd: (proposal.cwd ?? remembered?.cwd)! } : {}),
    ...((proposal.repos ?? remembered?.repos) ? { repos: (proposal.repos ?? remembered?.repos)! } : {}),
    ...((proposal.phases ?? remembered?.phases) ? { phases: (proposal.phases ?? remembered?.phases)! } : {}),
  };
}

/**
 * docs/04 §2.2 B "✓ 确认立项并让 Agent 开工" as a synchronous transaction: right after the owner approved a proposal the
 * desk raised, create the project cell (as the desk would — same builder, same id). Idempotent with the desk's own
 * catch-up. Returns null when the approval is not an approved desk proposal.
 */
export function startApprovedProjectSync(
  kernel: Pick<Kernel, "gate" | "context" | "getCell" | "spawnCell" | "clock" | "deskCellId">,
  approvalId: string,
): { projectId: string; started: boolean } | null {
  const rec = kernel.gate.getApprovalSync(approvalId);
  if (!rec || rec.action.type !== "project.start" || rec.status !== "approved") return null;
  const holder = kernel.getCell(rec.cellId);
  if (!holder || holder.status === "closed" || holder.spec.meta?.["role"] !== ROLES.desk) return null;
  const action = {...rec.action,card:rec.card} as ProjectStartAction;
  const art = action.artifactId && rec.boundVersion ? kernel.context.getArtifactVersionSync(action.artifactId,rec.boundVersion) : null;
  const init = approvedProjectInit(approvalId, action, art, null, kernel.clock);
  return startProjectSync(kernel, init, { parentId: rec.cellId, principalId: cellPrincipal(rec.cellId) });
}

/** Start a project from inside a desk Run (same builder as startProjectSync). "exists": that id is already taken. */
export async function launchProject(ports: RunPorts, init: ProjectInit, clock: Clock): Promise<{ projectId: string; started: boolean }> {
  const launch = projectLaunch(init, clock);
  try {
    await ports.spawnCell(launch.spec, launch.task);
    return { projectId: launch.projectId, started: true };
  } catch (err) {
    if (isNgError(err, "duplicate")) return { projectId: launch.projectId, started: false };
    throw err;
  }
}

/**
 * The desk's bookkeeping, run by the kernel at the start of every desk Run (PresetDef.prepareRun) — so a reminder that
 * came due, an approved proposal or a sent reply is in the records even when the model does nothing useful with the
 * wake-up. A batch of nothing but such events never reaches the model; a cell's result always does. What it applied
 * is kept for the Run's apply_updates.
 */
export function createDeskBooks(cfg: PresetsConfig) {
  const applied = new Map<string, string[]>();
  return {
    personalReminder(env: Envelope) {
      if (!isEnvelopeOfType(env, "timer.fired")) return;
      const data = (env.payload.data as { gtd?: ReminderData } | undefined)?.gtd;
      if (data?.kind !== "reminder" || !data.id || !data.text || env.id !== `gtd-reminder:${data.id}`) return;
      return {
        id: data.id, notify: cfg.ownerAddress, draft: {
          title: data.text, subjectKey: `reminder:${data.id}`, category: "action" as const, effort: data.effort ?? "15m",
          ...(data.remindAt !== undefined ? { dueAt: data.remindAt } : {}),
          options: [{ id: "done", label: "已办完", effect: "complete" as const, input: { mode: "optional" as const } }],
        },
      };
    },
    async prepareRun({ snapshot, ports, signal, clock }: PrepareRunInput): Promise<"handled" | void> {
      // Other cells on the inline preset (light helpers) have no books.
      if (ports.self.spec.meta?.["role"] !== ROLES.desk) return;
      const ctx: ToolContext = { ports, snapshot, signal, clock, toolUseId: `prepare_${snapshot.runId}` };
      const r = await settleDeskBatch(cfg, ctx);
      if (r.consumedAll) return "handled";
      if (r.lines.length) {
        applied.set(snapshot.runId, r.lines);
        // Bounded: entries are taken by the Run's own tools; a Run that never calls one leaves its entry behind.
        if (applied.size > 50) applied.delete(applied.keys().next().value!);
      }
    },
    /** Lines prepareRun applied for this Run (once). */
    take(runId: string): string[] {
      const lines = applied.get(runId) ?? [];
      applied.delete(runId);
      return lines;
    },
  };
}

export type DeskBooks = ReturnType<typeof createDeskBooks>;

/**
 * Deterministic follow-ups of this wake-up's background events. Idempotent (every tool of the desk runs it first),
 * returns one Chinese line per thing it did, for the model to relay if useful.
 */
export async function settleDesk(cfg: PresetsConfig, ctx: ToolContext): Promise<string[]> {
  return (await settleDeskBatch(cfg, ctx)).lines;
}

/**
 * settleDesk plus whether every envelope of the batch was pure bookkeeping (nothing left for the model: a reminder that
 * came due, a decided proposal or reply card, a progress note). A `cell.result` is never pure bookkeeping: a fixer's
 * result must reach the model so it can tell the cells that wait on it.
 */
export async function settleDeskBatch(cfg: PresetsConfig, ctx: ToolContext): Promise<{ lines: string[]; consumedAll: boolean }> {
  const { ports, clock } = ctx;
  const self = ports.self.cellId;
  const now = clock.now();
  const out: string[] = [];
  await ensureWeeklyReview(cfg, ports);

  /** A reminder came due: a quick to-do for the owner and the reminder itself. Once per reminder. */
  async function reminderDue(data: ReminderData, envelopeId?: string): Promise<void> {
    const key = gtdKeys.action(data.id);
    if (await ports.context.readState(self, key)) return;
    const action = newAction(
      { id: data.id, title: data.text, owner: "human", nextStep: data.text, effort: data.effort ?? "15m", dueAt: data.remindAt ?? now, source: { label: "定时提醒", ...(envelopeId ? { envelopeId } : {}), at: now } },
      now,
    );
    await ports.context.commit(self, { statePatches: { [key]: action } });
    await notifyOwner(ports, cfg.ownerAddress, `⏰ 提醒：${data.text}`, `reminder:${data.id}`);
    out.push(`提醒已到：${data.text}（已放进专注工作区，主人已收到提醒）`);
  }

  /** A project of the desk finished: one line in the "后台已处理" drawer. Once per project. */
  async function projectFinished(p: CellResultPayload): Promise<void> {
    if (p.status !== "completed") return;
    const project = await ports.context.readState<ProjectRecord>(p.childCellId, gtdKeys.project).catch(() => null);
    if (!project || project.lifecycle !== "completed") return;
    const id = `done-${p.childCellId}`;
    if (await ports.context.readState(self, gtdKeys.activity(id))) return;
    await notifyOwner(ports, cfg.ownerAddress, `「${project.title}」已完成：${p.summary.split("\n")[0]!.slice(0, 120)}`, `finished:${p.childCellId}:${id}`);
    const a: ActivityRecord = newActivity({ id, kind: "action_completed", title: `已完成：${project.title}`, detail: p.summary, ...(project.source ? { source: project.source } : {}), restorable: false }, now);
    await ports.context.commit(self, { statePatches: { [gtdKeys.activity(id)]: a } });
    out.push(`项目已完成：${project.title}`);
  }

  /** True when the envelope needs nothing from the model. */
  async function settleOne(env: Envelope): Promise<boolean> {
    if (isEnvelopeOfType(env, "timer.fired")) {
      const data = (env.payload.data as { gtd?: ReminderData } | undefined)?.gtd;
      if (data?.kind !== "reminder") return false;
      await reminderDue(data, env.id);
      return true;
    } else if (isEnvelopeOfType(env, "approval.resolved")) {
      const p = env.payload as ApprovalResolvedPayload;
      if (p.action.type === "project.start") {
        if (p.status !== "approved") return true;
        const decision = ports.listOwnDecisions().find(d=>d.record.actionId===p.actionId);
        const action = {...p.action,...(decision ? {card:decision.record.card} : {})} as ProjectStartAction;
        const version = p.artifactVersion ?? decision?.record.boundVersion;
        const art = action.artifactId && version ? await ports.context.getArtifactVersion(action.artifactId,version) : null;
        const init = approvedProjectInit(p.actionId, action, art, null, clock);
        const r = await launchProject(ports, init, clock);
        {
          await notifyOwner(ports, cfg.ownerAddress, `已立项：${init.title}，后台开始推进`, `project:${p.actionId}`);
          out.push(`项目「${init.title}」已按确认的安排启动（${r.projectId}）`);
        }
        return true;
      } else if (p.action.type === "custom") {
        return p.action.name === ACKNOWLEDGE_ACTION;
      } else if (p.action.type === "channel.send") {
        if (p.status === "unknown" || p.status === "failed") return false;
        const item = (await readReplyItems(ports)).find(i => i.actionId === p.actionId);
        if (!item) return false;
        if (p.status === "executed") {
          if (await ports.context.readState(self,gtdKeys.activity(`sent-${p.actionId}`))) return true;
          const done: ActivityRecord = newActivity(
            { id: `sent-${p.actionId}`, kind: "action_completed", title: `已回复${item.targetLabel}：${item.title}`, source: item.source, rawInput: item.rawInput.text, actionId: p.actionId, restorable: false },
            now,
          );
          const linked = await closeLinkedActions(ports, p.actionId, "done", now);
          await ports.context.commit(self, { statePatches: { [gtdKeys.activity(done.id)]: done, ...linked } });
          out.push(`回复已发出：${item.title}`);
          return true;
        } else if (p.status === "denied" || p.status === "cancelled") {
          return !p.action.relatedProjectIds?.length;
        }
        // failed / unknown: never swallow at 0-Token (BUG-032) — hand to the desk model so the failure/unknown is surfaced.
        return false;
      }
      return false;
    } else if (isEnvelopeOfType(env, "cell.result")) {
      await projectFinished(env.payload as CellResultPayload);
      return false;
    } else if (isEnvelopeOfType(env, "cell.progress")) {
      return true;
    }
    return false;
  }
  let consumedAll = ctx.snapshot.batch.envelopes.length > 0;
  for (const env of ctx.snapshot.batch.envelopes) {
    try {
      if (!(await settleOne(env))) consumedAll = false;
    } catch (err) {
      // One follow-up failing (e.g. a project that cannot start now) must not block every other desk tool.
      consumedAll = false;
      out.push(`${SETTLE_ERROR}${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { lines: out, consumedAll: consumedAll && !out.some((l) => l.startsWith(SETTLE_ERROR)) };
}

export async function readReplyItems(ports: RunPorts): Promise<ReplyItem[]> {
  return ports.listOwnDecisions().flatMap(({record, envelope}) => {
    const card = asClarifyCard(record.card.data);
    if (record.action.type !== "channel.send" || card?.cardType !== "response" || !record.artifactId) return [];
    const status: ReplyItem["status"] = record.status === "executed" ? "sent" : record.status === "cancelled" ? "withdrawn" : record.status === "denied" ? "closed" : "pending";
    return [{subjectKey:record.subjectKey, title:card.title, target:record.action.target, targetLabel:card.reply.targetLabel,
      status, artifactId:record.artifactId, actionId:record.actionId, source:card.source, rawInput:card.rawInput,
      ...(envelope ? {envelope, ...(envelope.threads ? {threads:envelope.threads} : {})} : {}),createdAt:record.createdAt,updatedAt:record.updatedAt}];
  });
}
