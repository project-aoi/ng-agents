import type { Kernel } from "@ng/cell";
import {
  cellPrincipal,
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
  type ProjectProposal,
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

function proposalOf(data: unknown, fallback: ProjectProposal): ProjectProposal {
  const p = data as Partial<ProjectProposal> | undefined;
  if (p && typeof p.title === "string" && typeof p.outcome === "string" && Array.isArray(p.actions) && p.actions.length > 0) return p as ProjectProposal;
  return fallback;
}

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
  const proposal = proposalOf(art?.content.data, action.proposal);
  const brief = ["主人在立项卡上确认了这份方案（可能亲手改过），按它开始推进。", proposal.background ?? ""].filter(Boolean).join("\n");
  return {
    id: projectIdForApproval(approvalId),
    title: proposal.title,
    outcome: proposal.outcome,
    brief,
    proposal,
    plan: proposal.actions.map((a) => ({ title: a.title, owner: a.owner, ...(a.nextStep ? { nextStep: a.nextStep } : {}), ...(a.effort ? { effort: a.effort } : {}) })),
    source: remembered?.source ?? { label: "立项", at: clock.now() },
    ...(remembered?.rawInput.text ? { rawInput: remembered.rawInput.text } : {}),
    ...(remembered?.cwd ? { cwd: remembered.cwd } : {}),
    ...(remembered?.repos?.length ? { repos: remembered.repos } : {}),
    ...(remembered?.phases?.length ? { phases: remembered.phases } : {}),
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
  const action = rec.action as ProjectStartAction;
  const art = action.artifactId ? kernel.context.getArtifactSync(action.artifactId) : null;
  const remembered = action.artifactId ? kernel.context.readStateSync<ProposalItem>(rec.cellId, KEYS.proposal(action.artifactId)) : null;
  const init = approvedProjectInit(approvalId, action, art, remembered, kernel.clock);
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
    if (await ports.context.readState(self, key)) {
      await ports.context.commit(self, { statePatches: { [KEYS.reminder(data.id)]: null } });
      return;
    }
    const action = newAction(
      { id: data.id, title: data.text, owner: "human", nextStep: data.text, effort: data.effort ?? "15m", dueAt: data.remindAt ?? now, source: { label: "定时提醒", ...(envelopeId ? { envelopeId } : {}), at: now } },
      now,
    );
    await ports.context.commit(self, { statePatches: { [key]: action, [KEYS.reminder(data.id)]: null } });
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
        const action = p.action as ProjectStartAction;
        const art = action.artifactId ? await ports.context.getArtifact(action.artifactId) : null;
        const remembered = action.artifactId ? await ports.context.readState<ProposalItem>(self, KEYS.proposal(action.artifactId)) : null;
        const init = approvedProjectInit(p.actionId, action, art, remembered, clock);
        const r = await launchProject(ports, init, clock);
        if (r.started) {
          await notifyOwner(ports, cfg.ownerAddress, `已立项：${init.title}，后台开始推进`, `project:${p.actionId}`);
          out.push(`项目「${init.title}」已按确认的安排启动（${r.projectId}）`);
        }
        return true;
      } else if (p.action.type === "custom") {
        return p.action.name === ACKNOWLEDGE_ACTION;
      } else if (p.action.type === "channel.send") {
        const key = KEYS.reply(p.action.subjectKey);
        const item = await ports.context.readState<ReplyItem>(self, key);
        if (!item || item.actionId !== p.actionId) return false;
        if (item.status !== "pending") return true;
        if (p.status === "executed") {
          const done: ActivityRecord = newActivity(
            { id: `sent-${p.actionId}`, kind: "action_completed", title: `已回复${item.targetLabel}：${item.title}`, source: item.source, rawInput: item.rawInput.text, actionId: p.actionId, restorable: false },
            now,
          );
          const linked = await closeLinkedActions(ports, p.actionId, "done", now);
          await ports.context.commit(self, { statePatches: { [key]: { ...item, status: "sent", updatedAt: now }, [gtdKeys.activity(done.id)]: done, ...linked } });
          out.push(`回复已发出：${item.title}`);
        } else if (p.status === "denied" || p.status === "cancelled") {
          await ports.context.commit(self, { statePatches: { [key]: { ...item, status: "closed", updatedAt: now } } });
        }
        return true;
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
  // Reminders whose wake-up passed without a desk tool call are applied now.
  for (const e of await ports.context.listState(self, KEYS.reminderPrefix)) {
    const data = e.value as ReminderData;
    if (data.remindAt !== undefined && data.remindAt <= now) {
      try {
        await reminderDue(data);
      } catch (err) {
        out.push(`${SETTLE_ERROR}${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { lines: out, consumedAll: consumedAll && !out.some((l) => l.startsWith(SETTLE_ERROR)) };
}

export async function readReplyItems(ports: RunPorts): Promise<ReplyItem[]> {
  return (await ports.context.listState(ports.self.cellId, KEYS.replyPrefix)).map((e) => e.value as ReplyItem);
}
