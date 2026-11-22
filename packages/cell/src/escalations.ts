import {
  afterCommit, hashAction, run,
  isEnvelopeOfType,
  parseAddress,
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
import { isProjectRoot, type KernelCore } from "./core";

/** `action.args` of a kernel-raised escalation card. */
export interface KernelEscalationArgs {
  kernel: true;
  reason: Extract<EscalationReason, "retry_limit" | "blocked">;
  /** The cell that hit the problem (it may differ from the approval's cellId when that one could not hold the card). */
  cellId: string;
  /** retry_limit: the dead messages to requeue on "continue". */
  envelopeIds?: string[];

  /** docs/05 guard 1: a retry_limit card raised because a cell kept hitting its step limit; "continue" queues one more continuation. */
  stepLimit?: boolean;
  /** docs/05 guard 1: a blocked card raised because the model refused; "continue" wakes the cell to try another way. */
  refused?: boolean;
}

export interface Escalations {
  /** inbox.dead → a retry_limit card (never a silent loss). */
  deadLetter(e: BusTopics["inbox.dead"]): ApprovalRecord | null;
  /** docs/05 guard 1: a cell hit its step limit `times` Runs in a row → a card instead of another silent continuation. */
  stepLimit(cellId: string, times: number): ApprovalRecord | null;
  /** docs/05 guard 1: a coordinating cell's model refused → a blocked card (a one-shot cell reports `failed` instead). */
  refused(cellId: string, said: string | null): ApprovalRecord | null;
}

const ITEM_TYPES = new Set(["user.message", "source.hit", "handback"]);

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
  if (from?.kind === "channel") return { ...base, label: from.channelId === "ui" ? "随手记" : from.channelId, channelId: from.channelId };
  if (from?.kind === "inbox") return { ...base, label: "后台任务" };
  if (item.from.startsWith("timer:")) return { ...base, label: "定时提醒" };
  if (item.from === "kernel:control" && isEnvelopeOfType(item, "user.message")) return { ...base, label: item.principalId.startsWith("agent:") ? "外部助手" : "对话" };
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

  function raise(cell: CellRecord, args: KernelEscalationArgs, title: string, explanation: string, envs: Envelope[]): ApprovalRecord | null {
    const subjectKey = `kernel:${cell.id}:${args.stepLimit ? "step_limit" : args.reason}`;
    // One card per item: an item that already waits on the owner is not given a second one.
    const existing = [cell, ...cells.ancestors(cell.id)].map(c => gate.findPendingBySubjectSync(subjectKey, c.id)).find(Boolean);
    const projectId = [cell, ...cells.ancestors(cell.id)].find(c => isProjectRoot(core.registry, c))?.id;
    function associate(rec: ApprovalRecord) {
      if (projectId && run(core.db, `UPDATE human_items SET related_project_ids=json_insert(related_project_ids,'$[#]',?),
        item_revision=item_revision+1 WHERE action_id=? AND NOT EXISTS (SELECT 1 FROM json_each(related_project_ids) WHERE value=?)`,
        [projectId,rec.actionId,projectId]).changes) afterCommit(core.db, () => core.bus.emit("approval.changed", {
          actionId:rec.actionId, cellId:rec.cellId, subjectKey:rec.subjectKey, status:rec.status,
        }));
      return gate.getApprovalSync(rec.actionId) ?? rec;
    }
    if (existing) {
      if (args.envelopeIds && isKernelEscalation(existing.action)) {
        const previous = existing.action.args.envelopeIds ?? [];
        const envelopeIds = [...new Set([...previous, ...args.envelopeIds])];
        if (envelopeIds.length !== previous.length) {
          const action = { ...existing.action, args: { ...existing.action.args, envelopeIds } };
          run(core.db, "UPDATE human_items SET action=?, action_hash=?, updated_at=?, item_revision=item_revision+1 WHERE action_id=?",
            [JSON.stringify(action), hashAction(action), clock.now(), existing.actionId]);
          afterCommit(core.db, () => core.bus.emit("approval.changed", {
            actionId: existing.actionId, cellId: existing.cellId, subjectKey, status: existing.status,
          }));
        }
      }
      return associate(existing);
    }
    const primary = envs.find((e) => ITEM_TYPES.has(e.type)) ?? envs[0];
    const card: EscalationCard = {
      cardType: "escalation",
      subjectKey,
      title,
      source: sourceOf(primary, clock.now()),
      rawInput: rawInputOf(primary, explanation),
      prep: { summary: explanation, checked: [] },
      escalation: { reason: args.reason, explanation },
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
      if (r.type === "defer") return associate(gate.getApprovalSync(r.actionId)!);
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

    stepLimit(cellId, times) {
      const cell = cells.get(cellId);
      if (!cell || cell.status === "closed") return null;
      const title = `${label(cell)}连续多轮都没做完，需要你看一下`;
      const explanation = `已经连续 ${times} 轮在单轮步数上限处停下，仍未收尾，后台已暂停自动续跑。可以让它再继续一轮，或标记为线下已解决。`;
      return raise(cell, { kernel: true, reason: "retry_limit", cellId, stepLimit: true }, title, explanation, []);
    },
    refused(cellId, said) {
      const cell = cells.get(cellId);
      if (!cell || cell.status === "closed") return null;
      const title = `${label(cell)}被模型拒绝执行，需要你决定怎么办`;
      const explanation = `模型拒绝了这一步${said ? `，原话是：${said.slice(0, 600)}` : "，没有给出说明"}。可以调整要求后让它继续，或标记为线下已解决。`;
      return raise(cell, { kernel: true, reason: "blocked", cellId, refused: true }, title, explanation, []);
    },
  };
}
