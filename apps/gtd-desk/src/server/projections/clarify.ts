import {
  asClarifyCard,
  cardButtons,
  PAYLOAD,
  type ApprovalRecord,
  type ApprovalRevisePayload,
  type ClarifyCard,
  type EscalationReason,
  type ProjectProposal,
} from "@ng/protocol";
import type { ArtifactDTO, ButtonDTO, ClarifyCardDTO, ClarifyCardState, ClarifyQueueDTO, ProposalDTO } from "../../shared/api";
import { approvalProjectId, linkedApprovalId, readActions, readActivities, type ProjectionInput } from "./common";
import { artifactDTO, button, channelLabelOfAddress, effortLabel, enc, ownerLabel, post, sourceInfo, waitingDTO } from "./format";
import { afternoonSlot, whenText } from "./time";

const DAY = 24 * 3_600_000;

export const REASON_LABEL: Readonly<Record<EscalationReason, string>> = {
  waiting_timeout: "等待超时",
  budget_exhausted: "预算已用完",
  retry_limit: "多次处理失败",
  blocked: "推进受阻",
};

export const OUTCOME_MESSAGE = {
  send_unknown: "发送结果未知，请核实",
  send_failed: "发送失败，对方没有收到",
} as const;

/** Approvals whose state still needs the owner, before the one-card-per-item rule. */
interface Candidates {
  pending: ApprovalRecord[];
  outcomes: ApprovalRecord[];
  hidden: Set<string>;
  revising: Set<string>;
}

function candidates(input: ProjectionInput): Candidates {
  const { kernel, now } = input;
  const pending = kernel.gate.listPendingSync({ now });
  const actions = readActions(kernel).filter((a) => a.record.status === "open" && a.record.owner === "human");
  // A card the owner took over ("转给我来处理") lives on as an Engage item until it is sent or checked off.
  const hidden = new Set(actions.map((a) => linkedApprovalId(a.record)).filter((id): id is string => id !== null));
  const abandoned = new Set(
    readActivities(kernel)
      .filter((a) => a.record.kind === "card_withdrawn" && a.record.actionId && !a.record.restoredAt)
      .map((a) => a.record.actionId!),
  );
  const outcomes = kernel.gate
    .listApprovalsSync({ status: ["unknown", "failed"] })
    .filter((r) => r.action.type === "channel.send")
    // A failed send of an Engage item is retried from Engage; an unknown one always needs verification here.
    .filter((r) => r.status === "unknown" || (!abandoned.has(r.actionId) && !hidden.has(r.actionId)));
  const revising = new Set<string>();
  for (const cellId of new Set(pending.map((p) => p.cellId))) {
    for (const m of kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.approvalRevise, status: ["pending", "claimed"] })) {
      const id = (m.envelope.payload as Partial<ApprovalRevisePayload>).actionId;
      if (typeof id === "string") revising.add(id);
    }
  }
  return { pending: pending.filter((p) => !hidden.has(p.actionId)), outcomes, hidden, revising };
}

function stateOf(rec: ApprovalRecord, revising: ReadonlySet<string>): ClarifyCardState {
  if (rec.status === "unknown") return "send_unknown";
  if (rec.status === "failed") return "send_failed";
  return revising.has(rec.actionId) ? "revising" : "pending";
}

const RANK: Readonly<Record<ClarifyCardState, number>> = { send_unknown: 0, revising: 1, pending: 1, send_failed: 2 };

/** Pending cards plus sends that ended unknown/failed, at most one per item (an unverified send blocks a new draft). */
export function projectClarify(input: ProjectionInput): ClarifyQueueDTO {
  const { kernel, now } = input;
  const c = candidates(input);
  const bySubject = new Map<string, { rec: ApprovalRecord; state: ClarifyCardState }>();
  for (const rec of [...c.pending, ...c.outcomes]) {
    const state = stateOf(rec, c.revising);
    const cur = bySubject.get(rec.subjectKey);
    if (!cur || RANK[state] < RANK[cur.state] || (RANK[state] === RANK[cur.state] && rec.updatedAt > cur.rec.updatedAt)) {
      bySubject.set(rec.subjectKey, { rec, state });
    }
  }
  const chosen = [...bySubject.values()].sort(
    (a, b) => (a.state === "send_unknown" ? 0 : 1) - (b.state === "send_unknown" ? 0 : 1) || a.rec.createdAt - b.rec.createdAt || a.rec.actionId.localeCompare(b.rec.actionId),
  );
  const cards = chosen.map(({ rec, state }) => buildCard(input, rec, state));
  const stats = kernel.stats();
  const snoozed = kernel.gate.listPendingSync({ includeSnoozed: true }).filter((p) => p.snoozedUntil !== null && p.snoozedUntil > now && !c.hidden.has(p.actionId)).length;
  return {
    generatedAt: now,
    remaining: cards.length,
    cards,
    snoozed,
    inboxZero: cards.length === 0,
    background: { running: stats.busyCells, jobs: stats.runningJobs, waiting: stats.waitingCells, text: backgroundText(stats.busyCells, stats.waitingCells) },
  };
}

export function backgroundText(running: number, waiting: number): string {
  if (running === 0 && waiting === 0) return "后台没有在途任务";
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} 项后台分身运行中`);
  if (waiting > 0) parts.push(`${waiting} 项在等外部`);
  return parts.join(" · ");
}

/** The card for one approval, or null when it is not something the Clarify view shows. */
export function clarifyCardById(input: ProjectionInput, actionId: string): ClarifyCardDTO | null {
  const q = projectClarify(input);
  return q.cards.find((c) => c.id === actionId) ?? null;
}

function proposalOf(card: ClarifyCard, draft: ArtifactDTO | null): ProjectProposal | null {
  if (card.cardType !== "project_proposal") return null;
  const d = draft?.data as Partial<ProjectProposal> | undefined;
  if (d && typeof d.outcome === "string" && Array.isArray(d.actions)) return { ...card.proposal, ...d } as ProjectProposal;
  return card.proposal;
}

function proposalDTO(p: ProjectProposal): ProposalDTO {
  return {
    title: p.title,
    outcome: p.outcome,
    ...(p.background ? { background: p.background } : {}),
    actions: (p.actions ?? []).map((a) => ({
      title: a.title,
      owner: a.owner,
      ownerLabel: ownerLabel(a.owner),
      ...(a.effort ? { effort: a.effort, effortLabel: effortLabel(a.effort)! } : {}),
      ...(a.nextStep ? { nextStep: a.nextStep } : {}),
    })),
  };
}

function draftIdOf(rec: ApprovalRecord, card: ClarifyCard | null): string | null {
  if (rec.artifactId) return rec.artifactId;
  if (!card) return null;
  if (card.cardType === "response") return card.draft.artifactId;
  if (card.cardType === "project_proposal") return card.draft?.artifactId ?? null;
  return card.escalation.nudgeDraft?.artifactId ?? null;
}

function statusText(card: ClarifyCard | null, state: ClarifyCardState, draft: ArtifactDTO | null, draftUpdated: boolean): string {
  if (state === "send_unknown") return OUTCOME_MESSAGE.send_unknown;
  if (state === "send_failed") return "发送失败 · 未送达";
  const v = draft ? ` v${draft.version}` : "";
  if (state === "revising") return `正在按你的意见重拟 · 当前${v || " 版本"}`;
  if (!card) return "等待确认";
  switch (card.cardType) {
    case "response":
      if (draftUpdated) return `草稿已更新为${v} · 请重看`;
      if (draft?.updatedBy === "human") return `你已改到${v} · 等待确认`;
      if (card.confirmVerb === "accept") return `结果已备好${v} · 等你收下`;
      return `已备好初稿${v} · 等待确认`;
    case "project_proposal":
      return `已拟好立项方案${v} · 等待确认`;
    case "escalation":
      switch (card.escalation.reason) {
        case "waiting_timeout":
          return draftUpdated ? `催问草稿已更新为${v} · 请重看` : `等待超时 · 已拟好催问${v}`;
        case "budget_exhausted":
          return "预算已用完 · 后台已暂停";
        case "retry_limit":
          return "多次处理失败 · 已停止重试";
        default:
          return "推进受阻 · 等你拍板";
      }
  }
}

function buttonsFor(input: ProjectionInput, rec: ApprovalRecord, card: ClarifyCard | null, state: ClarifyCardState, version: number | null): ButtonDTO[] {
  const { now, settings } = input;
  const base = `/api/clarify/${enc(rec.actionId)}`;
  const skip = button({ id: "skip", label: "下一张 →", client: "skip" });
  if (state === "send_unknown") {
    return [
      button({ id: "verify_sent", label: "✓ 已核实：对方收到了", primary: true, endpoint: post(`${base}/verify`, { verdict: "sent" }) }),
      button({ id: "verify_failed", label: "✗ 已核实：对方没收到", endpoint: post(`${base}/verify`, { verdict: "failed" }), hint: "之后可以重新发送" }),
      skip,
    ];
  }
  if (state === "send_failed") {
    return [
      button({ id: "retry_send", label: "↻ 重新发送", primary: true, endpoint: post(`${base}/approve`, { seenVersion: version }) }),
      button({ id: "abandon", label: "不发了", endpoint: post(`${base}/abandon`), confirm: "放弃发送这条消息？" }),
      skip,
    ];
  }
  const main: ButtonDTO[] = [];
  const defs = card ? cardButtons(card) : [{ id: "confirm" as const, label: "✓ 确认执行", primary: true }, { id: "deny" as const, label: "✗ 不同意" }, { id: "skip" as const, label: "下一张 →" }];
  for (const d of defs) {
    const primary = d.primary === true;
    switch (d.id) {
      case "confirm":
        main.push(button({ id: "confirm", label: d.label, primary, endpoint: post(`${base}/approve`, { seenVersion: version }) }));
        break;
      case "deny":
        main.push(button({ id: "deny", label: d.label, primary, endpoint: post(`${base}/deny`) }));
        break;
      case "revise_voice":
        main.push(
          button({
            id: "revise_voice",
            label: d.label,
            primary,
            endpoint: post(`${base}/revise`, { voice: true }),
            input: { field: "instruction", kind: "instruction", placeholder: "说说要怎么改，比如“语气再正式一点”" },
            ...(state === "revising" ? { hint: "正在按上一条意见重拟，新版本到了会自动刷新" } : {}),
          }),
        );
        break;
      case "snooze": {
        const until = afternoonSlot(now, settings.snoozeAfternoonHour);
        main.push(button({ id: "snooze", label: d.label, primary, endpoint: post(`${base}/snooze`, { until }), hint: `到 ${whenText(until, now)} 回到待确认` }));
        break;
      }
      case "edit_plan":
        main.push(
          button({
            id: "edit_plan",
            label: d.label,
            primary,
            client: "open_plan_editor",
            endpoint: { method: "PUT", path: `${base}/plan`, body: { expectedVersion: version } },
          }),
        );
        break;
      case "someday":
        main.push(button({ id: "someday", label: d.label, primary, endpoint: post(`${base}/someday`), hint: "不占用任何后台资源，可在项目全局里重新启动" }));
        break;
      case "extend": {
        const waiting = card?.cardType === "escalation" && card.escalation.reason === "waiting_timeout";
        main.push(
          button({
            id: "extend",
            label: d.label,
            primary,
            endpoint: post(`${base}/extend`, waiting ? { until: now + DAY } : {}),
            hint: waiting ? `到 ${whenText(now + DAY, now)} 再检查` : card?.cardType === "escalation" && card.escalation.reason === "budget_exhausted" ? "额度追加 50% 后继续" : "继续推进",
          }),
        );
        break;
      }
      case "resolve_offline":
        main.push(
          button({ id: "resolve_offline", label: d.label, primary, endpoint: post(`${base}/resolve-offline`), confirm: "确认已在线下解决？相关后台任务会一并结束。" }),
        );
        break;
      case "skip":
        main.push(skip);
        break;
    }
  }
  const more: ButtonDTO[] = [
    button({ id: "to_human", label: "转给我来处理", group: "more", endpoint: post(`${base}/to-human`), hint: "放进专注工作区，由你亲自处理" }),
    button({ id: "dismiss", label: "不需要处理（归档）", group: "more", endpoint: post(`${base}/dismiss`), hint: "归档后可在顶栏记录里移回待确认" }),
  ];
  return [...main, ...more];
}

function buildCard(input: ProjectionInput, rec: ApprovalRecord, state: ClarifyCardState): ClarifyCardDTO {
  const { kernel, now } = input;
  const card = asClarifyCard(rec.card.data);
  const draftId = draftIdOf(rec, card);
  const draft = draftId ? artifactDTO(kernel, draftId, now) : null;
  const version = draft?.version ?? null;
  const draftUpdated = draft !== null && rec.boundVersion !== null && draft.version !== rec.boundVersion && draft.updatedBy === "agent";

  let reply: ClarifyCardDTO["reply"] = null;
  if (card?.cardType === "response") {
    reply = { targetLabel: card.reply.targetLabel, channelLabel: channelLabelOfAddress(card.reply.target), confirmVerb: card.confirmVerb };
  } else if (rec.action.type === "channel.send") {
    const target = card?.cardType === "escalation" ? (card.escalation.nudgeTarget ?? rec.action.target) : rec.action.target;
    reply = { targetLabel: target, channelLabel: channelLabelOfAddress(target), confirmVerb: "send" };
  }

  const proposal = card ? proposalOf(card, draft) : null;
  const esc = card?.cardType === "escalation" ? card.escalation : null;
  const usage = esc?.usage
    ? {
        ...esc.usage,
        text: `已用 ${esc.usage.tokens.toLocaleString("en-US")}/${esc.usage.limitTokens.toLocaleString("en-US")} tokens · ${esc.usage.cents}/${esc.usage.limitCents} 美分`,
      }
    : null;
  const outcomeError = rec.outcome?.error;

  return {
    id: rec.actionId,
    cardType: card?.cardType ?? "generic",
    state,
    title: card?.title ?? rec.card.title ?? rec.action.summary,
    projectId: approvalProjectId(kernel, rec),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    sourceBar: {
      source: sourceInfo(card?.source) ?? { label: "系统", at: rec.createdAt },
      statusText: statusText(card, state, draft, draftUpdated),
      version,
      draftUpdated,
    },
    rawInput: card?.rawInput ?? { text: rec.card.body, kind: "system" },
    prep: { summary: card?.prep?.summary ?? "", checked: card?.prep?.checked ?? [] },
    draft,
    reply,
    proposal: proposal ? proposalDTO(proposal) : null,
    escalation: esc
      ? { reason: esc.reason, reasonLabel: REASON_LABEL[esc.reason] ?? esc.reason, explanation: esc.explanation, waiting: waitingDTO(esc.waiting, now), usage }
      : null,
    outcome:
      state === "send_unknown" || state === "send_failed"
        ? { state, message: OUTCOME_MESSAGE[state], ...(outcomeError ? { error: outcomeError } : {}) }
        : null,
    buttons: buttonsFor(input, rec, card, state, version),
  };
}
