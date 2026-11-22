import type { Kernel } from "@ng/cell";
import { gtdKeys } from "../shared/keys";
import {
  asDecisionCard, cellPrincipal,
  PAYLOAD,
  isEnvelopeOfType,
  isNgError,
  type ActivityRecord,
  type ApprovalResolvedPayload,
  type CellResultPayload,
  type Clock,
  type Envelope,
  type ItemSource,
  type PrepareRunInput,
  isProjectProposal,
  type ProjectRecord,
  type ProjectStartAction,
  type RunPorts,
  type ToolContext,
  type VersionedArtifact,
} from "@ng/protocol";
import { projectLaunch, startProjectSync, type ProjectInit, type RepoRef } from "../project/launch";
import { RESTORE_REASON, ROLES, type PresetsConfig } from "../shared/config";
import { notifyOwner } from "../shared/notify";
import { newActivity, primaryItem, type RawInput } from "../shared/records";

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

/** The owner moved this item back from the archive ("交回主台"): it must get a card. */
export function isRestored(ctx: ToolContext): boolean {
  return ctx.snapshot.batch.envelopes.some((e) => isEnvelopeOfType(e, "handback") && e.payload.reason === RESTORE_REASON);
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

/** The project an approval starts: derived from the approval id, so every path that starts it starts the same cell once. */
export const projectIdForApproval = (approvalId: string) => `proj_${approvalId.replace(/^act_/, "")}`;

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
  const card = asDecisionCard(action.card?.data);
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
 * came due, an approved proposal  is in the records even when the model does nothing useful with the
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
        id: data.id, draft: {
          source: { label: "定时提醒", envelopeId: env.id, at: env.createdAt },
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
 * came due, a decided proposal, a progress note). A `cell.result` is never pure bookkeeping: a fixer's
 * result must reach the model so it can tell the cells that wait on it.
 */
export async function settleDeskBatch(cfg: PresetsConfig, ctx: ToolContext): Promise<{ lines: string[]; consumedAll: boolean }> {
  const { ports, clock } = ctx;
  const self = ports.self.cellId;
  const now = clock.now();
  const out: string[] = [];
  await ensureWeeklyReview(cfg, ports);

  /** A project of the desk finished: one line in the "后台已处理" drawer. Once per project. */
  async function projectFinished(p: CellResultPayload): Promise<void> {
    if (p.status !== "completed") return;
    const project = await ports.context.readState<ProjectRecord>(p.childCellId, gtdKeys.project).catch(() => null);
    if (!project || project.lifecycle !== "completed") return;
    const id = `done-${p.childCellId}`;
    if (await ports.context.readState(self, gtdKeys.activity(id))) return;
    await notifyOwner(ports, `「${project.title}」已完成：${p.summary.split("\n")[0]!.slice(0, 120)}`, `finished:${p.childCellId}:${id}`);
    const a: ActivityRecord = newActivity({ id, kind: "action_completed", title: `已完成：${project.title}`, detail: p.summary, ...(project.source ? { source: project.source } : {}), restorable: false }, now);
    await ports.context.commit(self, { statePatches: { [gtdKeys.activity(id)]: a } });
    out.push(`项目已完成：${project.title}`);
  }

  /** True when the envelope needs nothing from the model. */
  async function settleOne(env: Envelope): Promise<boolean> {
    if (isEnvelopeOfType(env, "approval.resolved")) {
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
          await notifyOwner(ports, `已立项：${init.title}，后台开始推进`, `project:${p.actionId}`);
          out.push(`项目「${init.title}」已按确认的安排启动（${r.projectId}）`);
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
  return { lines: out, consumedAll: consumedAll && !out.some((l) => l.startsWith(SETTLE_ERROR)) };
}
