import {
  isEnvelopeOfType,
  parseAddress,
  projectCellIdOf,
  subjectKeys,
  type ApprovalRecord,
  type BusTopics,
  type CellRecord,
  type CustomAction,
  type EscalationCard,
  type EscalationReason,
  type Envelope,
  type ItemSource,
} from "@ng/protocol";
import { KERNEL_ESCALATION, KERNEL_ESCALATION_PRINCIPAL } from "./constants";
import type { KernelCore } from "./core";

/** `action.args` of a kernel-raised escalation card. */
export interface KernelEscalationArgs {
  kernel: true;
  reason: Extract<EscalationReason, "budget_exhausted" | "retry_limit">;
  /** The cell that hit the problem (it may differ from the approval's cellId when that one could not hold the card). */
  cellId: string;
  /** retry_limit: the dead messages to requeue on "continue". */
  envelopeIds?: string[];
  /** budget_exhausted: the cell whose ledger stopped the Run (raise this one). */
  limitedBy?: string | null;
}

export interface Escalations {
  /** inbox.dead → a retry_limit card (never a silent loss). */
  deadLetter(e: BusTopics["inbox.dead"]): ApprovalRecord | null;
  /** A Run ended budget_stopped → a budget_exhausted card. */
  budgetStopped(cellId: string): ApprovalRecord | null;
}

const ITEM_TYPES = new Set(["user.message", "source.hit", "handback"]);

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  ui: "随手记",
  cli: "命令行",
  feishu: "飞书",
  slack: "Slack",
  github: "GitHub",
  webhook: "Webhook",
  email: "邮件",
};

export function isKernelEscalation(action: { type: string; name?: string; args?: unknown }): action is CustomAction & { args: KernelEscalationArgs } {
  return action.type === "custom" && action.name === KERNEL_ESCALATION && typeof action.args === "object" && action.args !== null;
}

function itemOf(env: Envelope): Envelope {
  return isEnvelopeOfType(env, "handback") ? env.payload.original : env;
}

function sourceOf(env: Envelope | undefined, at: number): ItemSource {
  if (!env) return { label: "系统", at };
  const item = itemOf(env);
  const base = { principalId: item.principalId, envelopeId: item.id, at: item.createdAt };
  if (isEnvelopeOfType(item, "source.hit")) return { ...base, label: `信源 · ${item.payload.title}` };
  const from = parseAddress(item.from);
  if (from?.kind === "channel") return { ...base, label: CHANNEL_LABELS[from.channelId] ?? from.channelId, channelId: from.channelId };
  if (from?.kind === "inbox") return { ...base, label: "后台任务" };
  if (item.from.startsWith("timer:")) return { ...base, label: "定时提醒" };
  return { ...base, label: "系统" };
}

function rawInputOf(env: Envelope | undefined, fallback: string): EscalationCard["rawInput"] {
  if (!env) return { text: fallback, kind: "system" };
  const item = itemOf(env);
  if (isEnvelopeOfType(item, "user.message")) return { text: item.payload.text, kind: item.payload.voice ? "voice_transcript" : "message" };
  if (isEnvelopeOfType(item, "source.hit")) return { text: item.payload.rawInput ?? item.payload.summary, kind: "monitor_summary" };
  return { text: fallback, kind: "system" };
}

export function createEscalations(core: KernelCore): Escalations {
  const { cells, gate, inbox, clock } = core;

  function label(cell: CellRecord): string {
    if (cell.title) return `「${cell.title}」`;
    return cell.parentId === null ? "主台" : "一项后台任务";
  }

  /** Same rule as the Loop's default subject: the project, else the inbound item (at a root), else the cell. */
  function subjectOf(cell: CellRecord, envs: Envelope[]): string {
    const project = projectCellIdOf(cell.spec);
    if (project) return subjectKeys.project(project);
    if (cell.parentId === null) {
      const item = envs.find((e) => ITEM_TYPES.has(e.type));
      if (item) return subjectKeys.inbound(itemOf(item).id);
    }
    return subjectKeys.cell(cell.id);
  }

  function raise(cell: CellRecord, args: KernelEscalationArgs, title: string, explanation: string, envs: Envelope[], usage?: EscalationCard["escalation"]["usage"]): ApprovalRecord | null {
    const subjectKey = subjectOf(cell, envs);
    // One card per item: an item that already waits on the owner is not given a second one.
    const existing = gate.findPendingBySubjectSync(subjectKey);
    if (existing) return existing;
    const primary = envs.find((e) => ITEM_TYPES.has(e.type)) ?? envs[0];
    const card: EscalationCard = {
      cardType: "escalation",
      subjectKey,
      title,
      source: sourceOf(primary, clock.now()),
      rawInput: rawInputOf(primary, explanation),
      prep: { summary: explanation, checked: [] },
      escalation: { reason: args.reason, explanation, ...(usage ? { usage } : {}) },
    };
    const action: CustomAction = {
      type: "custom",
      name: KERNEL_ESCALATION,
      args,
      summary: title,
      subjectKey,
      sideEffect: "external",
      card: { format: "card", title, body: `${title}\n\n${explanation}`, data: card },
    };
    // The affected cell holds the card (so closing it withdraws the card); if it cannot (paused, revoked), the nearest
    // ancestor that can.
    for (const holder of [cell, ...cells.ancestors(cell.id)]) {
      if (holder.status === "closed") continue;
      const r = gate.authorizeSync(action, { cellId: holder.id, principalId: KERNEL_ESCALATION_PRINCIPAL, epoch: holder.epoch });
      if (r.type === "defer") return gate.getApprovalSync(r.actionId) ?? null;
    }
    core.onError(new Error(`could not raise a ${args.reason} escalation card for cell "${cell.id}"`), "escalation");
    return null;
  }

  return {
    deadLetter(e) {
      const cell = cells.get(e.cellId);
      if (!cell || cell.status === "closed") return null;
      const seqs = new Set(e.seqs);
      const dead = inbox.listMessagesSync({ cellId: e.cellId, status: ["dead"] }).filter((m) => seqs.has(m.seq));
      const envs = dead.map((m) => m.envelope);
      const attempts = Math.max(1, ...dead.map((m) => m.attempts));
      const title = cell.parentId === null ? "一条消息处理失败，需要你看一下" : `${label(cell)}处理失败，需要你看一下`;
      const explanation = `连续 ${attempts} 次处理失败，已停止自动重试。最后一次错误：${e.reason}`;
      return raise(cell, { kernel: true, reason: "retry_limit", cellId: cell.id, envelopeIds: e.envelopeIds }, title, explanation, envs);
    },

    budgetStopped(cellId) {
      const cell = cells.get(cellId);
      if (!cell || cell.status === "closed") return null;
      const usage = gate.usageSync(cellId);
      const limiter = usage.limitedBy && usage.limitedBy !== cellId ? cells.get(usage.limitedBy) : undefined;
      const lim = limiter ? gate.usageSync(limiter.id) : usage;
      const title = `${label(cell)}的预算已用完`;
      const whose = limiter ? `（上级${label(limiter)}的额度已用完）` : "";
      const explanation =
        `已用 ${lim.subtreeTokens}/${lim.limitTokens} tokens、${lim.subtreeCents}/${lim.limitCents} 美分${whose}，后台已停止推进。` +
        `可以追加额度继续，或标记为线下已解决。`;
      return raise(
        cell,
        { kernel: true, reason: "budget_exhausted", cellId, limitedBy: usage.limitedBy },
        title,
        explanation,
        [],
        { tokens: lim.subtreeTokens, cents: lim.subtreeCents, limitTokens: lim.limitTokens, limitCents: lim.limitCents },
      );
    },
  };
}
