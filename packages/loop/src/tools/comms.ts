import { z } from "zod";
import {
  isLeafLifetime,
  anyCovers,
  CELL_RESULT_CANDIDATE_KEY,
  CELL_STATUS_KEY,
  createEnvelope,
  defineTool,
  DESK_CELL_ID,
  inboxAddr,
  isInboxAddr,
  KERNEL_FROM,
  newId,
  PAYLOAD,
  type CardPrep,
  type CellProgressPayload,
  type CellResultCandidate,
  type CellResultPayload,
  type CellSpec,
  type CellStatusLine,
  type Deliverable,
  type EscalationCard,
  type HandbackPayload,
  type ProjectProposal,
  type ProjectProposalCard,
  type ProposedAction,
  type ToolContext,
  type RunPorts,
  type ToolResult,
  type Toolset,
} from "@ng/protocol";
import { defaultSubjectKey, itemRawInput, itemSource, clip, clipLine, primaryEnvelope, selfId } from "./util";

export const COMMS_TOOLSET = "kernel.comms";

/**
 * Optional port: `Inbox.handback(claimId = runId, envelopeId, reason)` bound to the Run. RunPorts does not declare it;
 * when the kernel provides it, `handback` uses it (the original row ends `handed_back`). Otherwise the tool falls
 * back to committing the same `handback` envelope (same id convention) to the desk through `context.commit`.
 */
export interface HandbackPort {
  handback(envelopeId: string, reason: string): Promise<void>;
}

export interface CommsToolsetOptions {
  /** Desk cell for the handback fallback. Default `desk`. */
  deskCellId?: string;
}

const prepInput = z
  .object({
    summary: z.string().describe("what you checked before asking, in one or two sentences"),
    checked: z.array(z.object({ label: z.string(), uri: z.string(), detail: z.string().optional() })).optional(),
  })
  .describe("shown on the approval card");

function prepOf(p: z.infer<typeof prepInput> | undefined): CardPrep {
  return {
    summary: p?.summary ?? "",
    checked: (p?.checked ?? []).map((c) => ({ label: c.label, uri: c.uri, ...(c.detail ? { detail: c.detail } : {}) })),
  };
}

function cardDeliverable(title: string, body: string, data: unknown): Deliverable {
  return { format: "card", title, body: body ? `${title}\n\n${body}` : title, data };
}

const STATUS_ALIASES: Readonly<Record<string, "completed" | "failed">> = {
  completed: "completed",
  complete: "completed",
  done: "completed",
  success: "completed",
  succeeded: "completed",
  ok: "completed",
  failed: "failed",
  failure: "failed",
  error: "failed",
  blocked: "failed",
};

function normalizeReport(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if (typeof o["text"] !== "string") {
    for (const alias of ["summary", "result", "message", "report", "content"]) {
      if (typeof o[alias] === "string" && o[alias]) {
        o["text"] = o[alias];
        delete o[alias];
        break;
      }
    }
  }
  if (o["kind"] === undefined) o["kind"] = o["progress"] !== undefined ? "progress" : "result";
  if (typeof o["status"] === "string") {
    const s = STATUS_ALIASES[o["status"].toLowerCase()];
    if (s) o["status"] = s;
  }
  return o;
}

const hasParent = ({ spec }: { spec?: CellSpec }) => spec === undefined || Boolean(spec.parentId);
const isLeaf = (spec: CellSpec | undefined) => isLeafLifetime(spec?.lifetime);
/** complete_self / pause_self: for cells that live until they say so (a leaf's turns are settled by the kernel). */
const settlesItself = ({ spec }: { spec?: CellSpec }) => spec !== undefined && Boolean(spec.parentId) && !isLeaf(spec);

/** `inbox:<cellId>` → what to tell the model about a cell-to-cell delivery (docs/05 guard 1: a closed target is said out loud). */
async function sendToInbox(ctx: ToolContext, to: `inbox:${string}`, args: { text?: string | undefined; refId?:string | undefined; summary: string; quiet?: boolean | undefined }): Promise<ToolResult> {
  if (!args.text) return { output: "A message to another cell needs text.", isError: true };
  const send = ctx.ports.sendToCell;
  if (!send) return { output: "Cell-to-cell messages are not available in this environment.", isError: true };
  const target = to.slice("inbox:".length);
  const r = await send.call(ctx.ports, to, { text: args.text, summary: args.summary, ...(args.refId ? {data:{refId:args.refId}} : {}), ...(args.quiet ? { quiet: true } : {}), id: `${ctx.snapshot.runId}:${ctx.toolUseId}:msg` });
  switch (r.status) {
    case "delivered":
      return {
        output:
          args.quiet
            ? `Left for ${target} as background: it reads it at its next turn, is not woken for it, and no wait of its is answered by it.`
            : r.targetStatus === "paused"
            ? `Delivered to ${target}, which is paused: it reads the message when it is resumed.`
            : `Delivered to ${target}. It handles the message in its current run, or is woken with it (a dormant worker continues with everything it knows).`,
        data: r,
        sent: { to, text: args.text },
      };
    case "closed":
      return {
        output: `NOT DELIVERED — ${target} is closed (${r.closeReason === "cancelled" ? "it was cancelled" : "it was closed, or its project ended"}). Nothing was stored. If the work still needs doing, start a new worker (use dispatch inside a project, or spawn_cell otherwise) and give it the context it needs (what the previous one did, the branch or artifact it left).`,
        isError: true,
        data: r,
      };
    case "not_found":
      return { output: `NOT DELIVERED — there is no cell "${target}". Check the id in the in-flight list at the start of your wake-up message.`, isError: true, data: r };
    case "refused":
      return { output: `Not allowed: ${r.reason}.`, isError: true, data: r };
  }
}

/**
 * `kernel.comms`: send_message, request_approval, withdraw_card, settle_item, report_to_parent, handback, wait, clear_wait, complete_self, pause_self.
 */
export function commsToolset(opts: CommsToolsetOptions = {}): Toolset {
  const deskCellId = opts.deskCellId ?? DESK_CELL_ID;

  const sendMessage = defineTool({
    name: "send_message",
    kind: "kernel",
    description: "Send a message to the owner in the workbench or to a cell. A message to a dormant worker wakes it with its existing context.",
    input: z.object({
      to: z.string().describe("inbox:<cellId> or the owner's workbench address"),
      text: z.string().min(1),
      summary: z.string().min(1),
      refId: z.string().trim().min(1).optional().describe("the reference of the individual wait this answers"),
      quiet: z
        .boolean()
        .optional()
        .describe("to a cell only: a fact for its record that it need not be woken for; it reads it at its next turn. Never a question, an instruction or an answer somebody is waiting for"),
    }),
    async handler(args, ctx) {
      if (isInboxAddr(args.to)) return sendToInbox(ctx, args.to, args);
      if (args.to !== "channel:ui:owner") {
        return { output: "Choose a cell inbox or the owner's workbench address.", isError: true };
      }
      if (!anyCovers(ctx.ports.self.bounds.canSendTo, args.to)) return { output: "This cell cannot notify the owner. Send to your parent or to the desk.", isError: true };
      await ctx.ports.notifyOwner({ format: "text", body: args.text }, `${ctx.snapshot.runId}:${ctx.toolUseId}`);
      return { output: "已通知主人。", sent: { to: args.to, text: args.text } };
    },
  });

  const requestApproval = defineTool({
    name: "request_approval",
    kind: "kernel",
    description: [
      "Ask the owner to decide before you go on (not for plain notifications — send_message handles those).",
      "project: propose a multi-step project (on the desk, prefer propose_project so cwd, repos and phases are preserved); escalation: you are blocked or out of retries and need a decision; action: approve one specific operation (e.g. merging a PR or advancing a phase).",
      "When you pass custom options or relatedProjectIds on an escalation (or an action without execute/action), this creates a workbench decision card with those explicit reply choices.",
      "artifactId (escalation or action): a draft the card is about — the card is bound to its current version, the owner can edit it there, and the decision names the version they saw (humanEdited, artifactVersion).",
      "Raising the card ends your run: write any chat reply or message first. You are woken with approval.resolved (or approval.revise if the owner asks for a revision).",
    ].join(" "),
    input: z.object({
      kind: z.enum(["project", "escalation", "action"]),
      options: z.array(z.object({
        id: z.string().min(1).describe("stable option id returned in approval.resolved.optionId"),
        label: z.string().min(1).describe("short Chinese button label shown to the owner"),
        effect: z.enum(["reply","revise","execute","defer","terminate"]).describe('reply: return the owner\'s choice/note to you; execute: approve a protected action; terminate: decline or cancel a project; revise: ask you to redraft; defer: snooze'),
        primary: z.boolean().optional().describe("highlight as the primary button"),
        group: z.enum(["main","more"]).optional().describe("main button bar or secondary overflow menu"),
        hint: z.string().optional().describe("short Chinese explanation under the choice"),
        input: z.object({ mode: z.enum(["none","optional","required"]), placeholder: z.string().optional() }).optional().describe("whether this option asks the owner for a note"),
        payload: z.record(z.string(), z.unknown()).optional().describe("structured data echoed back to you when chosen"),
        terminateMode: z.enum(["deny","cancel_task"]).optional().describe('for effect "terminate": deny (default) or cancel_task (closes targetCellIds[0], which must be listed in relatedProjectIds)'),
        targetCellIds: z.array(z.string()).optional().describe('for terminateMode "cancel_task": single project cell id to close'),
        confirm: z.string().optional().describe("extra confirmation prompt before executing a destructive choice"),
      })).optional().describe("explicit decision choices shown on the card"),
      relatedProjectIds: z.array(z.string().min(1)).optional().describe("project cell ids this decision affects (links the card to those projects and required for cancel_task targets)"),
      title: z.string().min(1),
      summary: z.string().min(1).describe("one line for the card and the audit log"),
      subjectKey: z.string().optional().describe('stable dedup key (e.g. "arb:<cause>"); reusing the same subjectKey updates an existing open card instead of creating a duplicate'),
      prep: prepInput.optional(),
      proposal: z
        .object({
          outcome: z.string().min(1).describe("what done looks like"),
          background: z.string().optional(),
          actions: z
            .array(
              z.object({
                title: z.string().min(1),
                owner: z.enum(["agent", "human", "waiting"]),
                effort: z.enum(["15m", "45m", "low_energy"]).optional(),
                nextStep: z.string().optional(),
              }),
            )
            .min(1),
        })
        .optional()
        .describe("kind project"),
      escalation: z
        .object({ reason: z.enum(["blocked", "retry_limit", "waiting_timeout"]), explanation: z.string().min(1) })
        .optional()
        .describe("kind escalation"),
      action: z.object({ name: z.string().min(1), args: z.unknown().optional() }).optional().describe("kind action"),
      artifactId: z.string().min(1).optional().describe("escalation or action: the draft (artifact) the card is about; the card is bound to its current version"),
    }),
    async handler(args, ctx) {
      const subjectKey = args.subjectKey ?? defaultSubjectKey(ctx);
      const protectedAction = args.kind === "project";
      // A draft card: bound to the version that exists now (a project proposal keeps its own plan draft).
      const draft = args.artifactId && !protectedAction ? await ctx.ports.context.getArtifact(args.artifactId) : null;
      if (args.artifactId && !protectedAction && !draft) return { output: `There is no artifact ${args.artifactId}: save the draft first (save_artifact), then put its id on the card.`, isError: true };
      const bound = (v: number | undefined) => (draft && v !== undefined ? ` It is bound to ${draft.artifactId} v${v}: when the decision says humanEdited or a newer artifactVersion, read_artifact before you act on it.` : "");
      if (!protectedAction && (args.kind !== "action" || (!args.action && !args.options?.some(o => o.effect === "execute"))) && (args.options || args.relatedProjectIds)) {
        if (!ctx.ports.createHumanItem) return { output: "Custom cards are unavailable.", isError: true };
        const item = ctx.ports.createHumanItem({
          title: args.title, description: args.escalation?.explanation ?? args.summary, prep:prepOf(args.prep), source:itemSource(ctx.snapshot), rawInput:itemRawInput(ctx.snapshot), subjectKey: args.subjectKey ?? `arb:${primaryEnvelope(ctx.snapshot)?.id ?? ctx.snapshot.runId}`,
          options: args.options ?? [{ id: "reply", label: "回复", effect: "reply" }], relatedProjectIds: args.relatedProjectIds ?? [],
          ...(draft ? { artifactId: draft.artifactId } : {}),
        });
        return { output: `Card ${item.id} is waiting for a decision.${bound(draft?.version)}`, data: { ...item, ...(draft ? { artifactId: draft.artifactId, artifactVersion: draft.version } : {}) }, endRun: "deferred_for_approval" };
      }
      const base = { subjectKey, title: args.title, source: itemSource(ctx.snapshot), rawInput: itemRawInput(ctx.snapshot), prep: prepOf(args.prep) };
      let action: ProposedAction;
      let artifactVersion: number | undefined;
      if (args.kind === "project") {
        if (!args.proposal) return { output: "kind project needs proposal.", isError: true };
        const proposal: ProjectProposal = {
          title: args.title,
          outcome: args.proposal.outcome,
          ...(args.proposal.background ? { background: args.proposal.background } : {}),
          actions: args.proposal.actions.map((a) => ({
            title: a.title,
            owner: a.owner,
            ...(a.effort ? { effort: a.effort } : {}),
            ...(a.nextStep ? { nextStep: a.nextStep } : {}),
          })),
        };
        // Kept as a json artifact so "✎ 手动改一下安排" saves with version protection.
        const artifactId = newId("art", ctx.clock);
        const saved = await ctx.ports.context.commit(selfId(ctx), {
          artifact: { artifactId, content: { format: "json", title: args.title, body: JSON.stringify(proposal, null, 2), data: proposal }, updatedBy: "agent" },
        });
        const card: ProjectProposalCard = {
          ...base,
          cardType: "project_proposal",
          proposal,
          ...(saved.ok ? { draft: { artifactId, version: saved.artifactVersion ?? 1 } } : {}),
        };
        artifactVersion = saved.ok ? (saved.artifactVersion ?? 1) : undefined;
        const body = [proposal.outcome, ...proposal.actions.map((a) => `- ${a.title}`)].join("\n");
        action = {
          type: "project.start",
          summary: args.summary,
          subjectKey,
          sideEffect: "external",
          proposal,
          // Binds the approval to the plan version the owner saw ("✎ 手动改一下安排" edits it) and lets the requester
          // read the approved plan back from approval.resolved.
          ...(saved.ok ? { artifactId } : {}),
          card: cardDeliverable(args.title, body, card),
        };
      } else if (args.kind === "escalation") {
        if (!args.escalation) return { output: "kind escalation needs escalation.", isError: true };
        const card: EscalationCard = { ...base, cardType: "escalation", escalation: { reason: args.escalation.reason, explanation: args.escalation.explanation } };
        action = {
          type: "custom",
          name: `escalation.${args.escalation.reason}`,
          args: { explanation: args.escalation.explanation },
          summary: args.summary,
          subjectKey,
          sideEffect: "external",
          card: cardDeliverable(args.title, args.escalation.explanation, card),
        };
      } else {
        if (!args.action && !args.options) return { output: "kind action needs action.", isError: true };
        action = {
          type: "custom",
          name: args.action?.name ?? "request_approval",
          card: cardDeliverable(args.title, args.summary, base),
          ...(args.action?.args !== undefined ? { args: args.action.args } : {}),
          summary: args.summary,
          subjectKey,
          sideEffect: "external",
        };
      }
      if (args.options) action.cardOptions = args.options;
      if (args.relatedProjectIds) action.relatedProjectIds = args.relatedProjectIds;
      if (draft) {
        // Binds the decision to the draft version the owner saw, as for a project proposal.
        action.artifactId = draft.artifactId;
        artifactVersion = draft.version;
      }
      const decision = await ctx.ports.authorize(action, artifactVersion !== undefined ? { artifactVersion } : undefined);
      if (decision.type === "deny") return { output: decision.feedback, isError: true, data: { decision: "deny" } };
      if (decision.type === "allow") return { output: "Approved.", data: { decision: "allow" } };
      return {
        output: `Waiting for the owner's decision (card ${decision.actionId}). You will receive approval.resolved with the outcome.${bound(decision.boundArtifactVersion)}`,
        endRun: "deferred_for_approval",
        data: { decision: "defer", actionId: decision.actionId, boundArtifactVersion: decision.boundArtifactVersion },
      };
    },
  });

  const reportToParent = defineTool({
    name: "report_to_parent",
    kind: "kernel",
    availableFor: hasParent,
    description: [
      "Report to the cell that started you.",
      "kind progress: a short status line your parent reads at its next wake-up without being woken.",
      "kind result: the outcome of your work, when you are done or cannot finish. For a worker this is optional — your parent is told when your turn ends either way and can read what you did — but it is how you hand over a structured result: the artifact id, a clear \"failed\" with the reason, the branch and what was verified. It ends your run. If a follow-up message reached you in the meantime, you are woken with it first.",
    ].join(" "),
    // Lenient on purpose: three different CLI agents call this, sometimes from the name alone. The obvious near-misses
    // (summary/result for text, success/done/error for status, a missing kind) are understood rather than bounced.
    input: z.preprocess(
      normalizeReport,
      z.object({
      kind: z.enum(["result", "progress"]),
      text: z.string().min(1).describe("result: what you did and found, where it is (branch, files, artifact) and how you verified it; progress: one line"),
      status: z.enum(["completed", "failed"]).optional().describe("result only; default completed"),
      artifactId: z.string().optional().describe("the deliverable you saved, if any"),
      progress: z.object({ done: z.number().int().min(0), total: z.number().int().min(1), label: z.string().optional() }).optional(),
      data: z.unknown().optional().describe("structured result for the parent"),
      }),
    ),
    async handler(args, ctx) {
      const childCellId = selfId(ctx);
      const status: CellStatusLine = { text: clipLine(args.text, 200), at: ctx.clock.now(), ...(args.progress ? { progress: args.progress } : {}) };
      if (args.kind === "progress") {
        const payload: CellProgressPayload = {
          childCellId,
          text: args.text,
          ...(args.progress ? { progress: args.progress } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
        };
        await ctx.ports.emitToParent(PAYLOAD.cellProgress, payload, { delivery: "silent_inject" });
        await ctx.ports.context.commit(childCellId, { statePatches: { [CELL_STATUS_KEY]: status } });
        return "Progress noted.";
      }
      if (isLeaf(ctx.ports.self.spec)) {
        // docs/05 guard 1: nothing is sent from here. The candidate is stored; the kernel delivers it when the run has
        // settled and the inbox is drained (and closes a one-shot cell in that same transaction).
        const candidate: CellResultCandidate = {
          runId: ctx.snapshot.runId,
          status: args.status ?? "completed",
          summary: args.text,
          ...(args.artifactId ? { artifactId: args.artifactId } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
          at: ctx.clock.now(),
        };
        await ctx.ports.context.commit(childCellId, { statePatches: { [CELL_RESULT_CANDIDATE_KEY]: candidate, [CELL_STATUS_KEY]: status } });
        return {
          output: "Result recorded. Your run ends now and your parent is told. If a follow-up message reached you first, you are woken with it instead — handle it, then report the updated result.",
          endRun: "completed",
          data: { staged: true },
          sent: { to: inboxAddr(ctx.ports.self.parentId ?? childCellId), text: args.text },
        };
      }
      const payload: CellResultPayload = {
        childCellId,
        status: args.status ?? "completed",
        summary: args.text,
        ...(args.artifactId ? { artifactId: args.artifactId } : {}),
        ...(args.data !== undefined ? { data: args.data } : {}),
      };
      await ctx.ports.emitToParent(PAYLOAD.cellResult, payload);
      await ctx.ports.context.commit(childCellId, { statePatches: { [CELL_STATUS_KEY]: status } });
      return "Result delivered to your parent. You stay open; call finish_project (for a project) or complete_self when this cell's whole job is finished.";
    },
  });
  const handback = defineTool({
    name: "handback",
    kind: "kernel",
    availableFor: hasParent,
    description:
      "Hand a message that is not part of your task back to the desk for re-triage (e.g. someone in your watched thread raised a new, unrelated issue). The original sender is kept.",
    input: z.object({
      reason: z.string().min(1),
      envelopeId: z.string().optional().describe("which message — required when the wake-up brought more than one (the id is in each message's header)"),
    }),
    async handler(args, ctx) {
      const envs = ctx.snapshot.batch.envelopes;
      const messages = envs.filter((e) => e.type === "user.message");
      const listed = () =>
        messages
          .map((e) => {
            const p = e.payload as { text?: unknown; sender?: { id?: unknown; name?: unknown } };
            return `- envelopeId "${e.id}" — ${String(p.sender?.name ?? p.sender?.id ?? e.from)}: ${clip(String(p.text ?? "").replace(/\s+/g, " "), 80)}`;
          })
          .join("\n");
      let env: (typeof envs)[number] | undefined;
      if (args.envelopeId) {
        const wanted = args.envelopeId.trim();
        env = envs.find((e) => e.id === wanted);
        if (!env) {
          // The id as the model retyped it: a unique tail or fragment is enough.
          const near = envs.filter((e) => e.id.endsWith(wanted) || e.id.includes(wanted));
          if (near.length === 1) env = near[0];
        }
        if (!env) return { output: `No message "${wanted}" in this wake-up.${messages.length ? ` The messages are:\n${listed()}` : ""}`, isError: true };
      } else if (messages.length > 1) {
        // A batch (a coalescing window, or messages absorbed while working): guessing would hand back the wrong one.
        return { output: `This wake-up holds ${messages.length} messages; say which one to hand back with envelopeId (once per message):\n${listed()}`, isError: true };
      } else {
        env = messages[0] ?? primaryEnvelope(ctx.snapshot);
      }
      if (!env) return { output: "There is no message in this wake-up to hand back.", isError: true };
      const port = (ctx.ports as RunPorts & Partial<HandbackPort>).handback;
      if (typeof port === "function") {
        await port.call(ctx.ports, env.id, args.reason);
      } else {
        const self = selfId(ctx);
        const payload: HandbackPayload = { original: env, fromCellId: self, reason: args.reason };
        const to = inboxAddr(deskCellId);
        const handed = createEnvelope(
          {
            id: `${env.id}#handback#${self}`,
            from: KERNEL_FROM.handback,
            to,
            principalId: env.principalId,
            kind: "event",
            type: PAYLOAD.handback,
            payload,
            ...(env.threads ? { threads: env.threads } : {}),
          },
          ctx.clock,
        );
        await ctx.ports.context.commit(self, { inboxOut: [{ to, envelope: handed }] });
      }
      return { output: "Handed back to the desk.", data: { envelopeId: env.id } };
    },
  });

  const wait = defineTool({
    name: "wait",
    kind: "kernel",
    description: [
      "Register an explicit wait so the board records who has the ball until that party answers (unrelated wake-ups leave it open): \"inbox:desk\" or your parent's \"inbox:<cellId>\" after asking it a question or arbitration; \"human\" after asking the owner a plain-text question or recording a human action; \"external\" on a checker waiting on a schedule or watch.",
      "timeoutMinutes wakes you if nothing came by then. Never call wait to end an ordinary turn, or to wait for your own dispatched children or job_start — those wake you automatically; simply finish your turn.",
    ].join(" "),
    input: z.object({
      reason: z.string().min(1).describe("what you are waiting for, in one line"),
      waitId: z.string().trim().min(1).optional(),
      refId: z.string().trim().min(1).optional(),
      waitingFor: z.string().min(1).describe('"inbox:<cellId>", "human", or "external"'),
      timeoutMinutes: z.number().positive().max(60 * 24 * 30).optional(),
    }),
    async handler(args, ctx) {
      if (!args.waitingFor) {
        return {
          output: 'wait requires waitingFor ("inbox:<cellId>", "human", or "external"). To end a normal turn — or after dispatch or job_start — simply stop without calling wait.',
          isError: true,
        };
      }
      const register = ctx.ports.registerWait;
      if (!register) return { output: `Waiting for ${args.waitingFor}.`, awaitsWakeup: true, data: { waitingFor: args.waitingFor } };
      const timeoutAt = args.timeoutMinutes !== undefined ? ctx.clock.now() + Math.round(args.timeoutMinutes * 60_000) : undefined;
      await register.call(ctx.ports, { waitingFor: args.waitingFor, reason: args.reason, ...(args.waitId ? { waitId: args.waitId } : {}), ...(args.refId ? { refId: args.refId } : {}), ...(timeoutAt !== undefined ? { timeoutAt } : {}) });
      return {
        output: `Registered wait for ${args.waitingFor}${timeoutAt !== undefined ? ` (timeout at ${new Date(timeoutAt).toISOString()})` : ""}.`,
        awaitsWakeup: true,
        data: { waitingFor: args.waitingFor, ...(timeoutAt !== undefined ? { timeoutAt } : {}) },
      };
    },
  });
  const clearWait = defineTool({
    name: "clear_wait",
    kind: "kernel",
    description: "Remove the open wait and its timeout by waitId.",
    input: z.object({ waitId: z.string().trim().min(1) }),
    async handler({ waitId }, ctx) {
      if (!ctx.ports.clearWait) return { output: "Cannot clear waits in this environment.", isError: true };
      const removed = await ctx.ports.clearWait(waitId);
      return { output: removed ? "Wait cleared." : "No such open wait.", data: { waitId, removed } };
    },
  });
  const withdrawCard = defineTool({
    name: "withdraw_card",
    kind: "kernel",
    description:
      "Take back a card or human action that you (or a cell below you) raised and the owner has not decided yet — the plan changed, a project took it over, or it is no longer needed. It leaves the owner's list.",
    input: z.object({
      id: z.string().trim().min(1).describe("the card's id"),
      reason: z.string().trim().min(1).describe("why, in plain Chinese (the owner can see it)"),
    }),
    async handler(args, ctx) {
      const withdraw = ctx.ports.withdrawHumanItem;
      if (!withdraw) return { output: "Cards cannot be withdrawn in this environment.", isError: true };
      const r = withdraw.call(ctx.ports, args.id, args.reason);
      switch (r) {
        case "withdrawn":
          return { output: `Withdrew ${args.id}: it is off the owner's list.`, data: { id: args.id, result: r } };
        case "not_pending":
          return { output: `${args.id} is no longer waiting for the owner (already decided, done or withdrawn); nothing changed.`, data: { id: args.id, result: r } };
        case "not_found":
          return { output: `There is no card ${args.id} raised by you or a cell below you.`, isError: true, data: { id: args.id, result: r } };
      }
    },
  });
  const settleItem = defineTool({
    name: "settle_item",
    kind: "kernel",
    description:
      'Close an open card, human action or reminder of yours (or of a cell below you) because the owner settled it in conversation: they said it is done, accepted it, or answered what it asked. It is recorded as their decision, with their words. A card that approves an action is settled only on the card itself; an item nobody answered is withdrawn (withdraw_card).',
    input: z.object({
      id: z.string().trim().min(1).describe("the item's id, as your notes list it"),
      ownerWords: z.string().trim().min(1).describe("what the owner said that settles it, verbatim"),
      itemRevision: z.number().int().min(1).describe("the item's revision (rev N in your notes)"),
      artifactVersion: z.number().int().min(1).optional().describe("for an item about a document: the version the owner was talking about"),
    }),
    async handler(args, ctx) {
      const settle = ctx.ports.settleHumanItem;
      if (!settle) return { output: "Items cannot be settled in this environment.", isError: true };
      const r = settle.call(ctx.ports, args.id, {
        ownerWords: args.ownerWords,
        seenItemRevision: args.itemRevision,
        ...(args.artifactVersion !== undefined ? { seenArtifactVersion: args.artifactVersion } : {}),
      });
      const data = { id: args.id, ...r };
      switch (r.status) {
        case "settled":
          return { output: `Recorded: ${args.id} is settled on the owner's word and off their list.`, data };
        case "stale":
          return {
            output: `Not settled: ${args.id} is now rev ${r.itemRevision}${r.artifactVersion !== null ? `, about v${r.artifactVersion} of its document` : ""}. Check that the owner's words hold for what it says now, then call again with those numbers${r.artifactVersion !== null ? "; if the document has changed since they spoke, ask them" : ""}.`,
            isError: true,
            data,
          };
        case "needs_owner":
          return { output: `Not settled: ${args.id} approves an action, which the owner does on the card itself (待我处理).`, isError: true, data };
        case "not_pending":
          return { output: `${args.id} is no longer open (already decided, done or withdrawn); nothing changed.`, data };
        case "not_found":
          return { output: `There is no open item ${args.id} of yours or of a cell below you.`, isError: true, data };
      }
    },
  });
  const completeSelf = defineTool({
    name: "complete_self",
    kind: "kernel",
    availableFor: settlesItself,
    description: [
      "Close this cell because its whole job is finished (or, with cancelled, abandoned). Your parent gets one final result with your summary.",
      "Closing takes every child cell with it. Workers that have finished their turn and are dormant are simply archived; but when a child is still at work (running, waiting, watching) you are told which, and nothing is closed: wait for it — or call again with closeChildren: true when stopping it is what you mean.",
      "The run ends now and the kernel closes you once your inbox is drained — a message that arrived meanwhile wakes you first, and you call this again when that is handled.",
    ].join(" "),
    input: z.object({
      summary: z.string().min(1).describe("the outcome in a few lines: what was delivered and where it is"),
      cancelled: z.boolean().optional().describe("true: abandoned rather than finished"),
      closeChildren: z.boolean().optional().describe("true: also stop the child cells that are still open"),
    }),
    async handler(args, ctx) {
      const settle = ctx.ports.settleSelf;
      if (!settle) return { output: "This environment cannot close a cell from inside.", isError: true };
      await settle.call(ctx.ports, { action: args.cancelled ? "cancel" : "complete", summary: args.summary, ...(args.closeChildren ? { force: true } : {}) });
      const status: CellStatusLine = { text: clipLine(args.summary, 200), at: ctx.clock.now() };
      await ctx.ports.context.commit(selfId(ctx), { statePatches: { [CELL_STATUS_KEY]: status } });
      return { output: "Closing after this run. Stop here.", endRun: "completed", data: { action: args.cancelled ? "cancel" : "complete" } };
    },
  });
  const pauseSelf = defineTool({
    name: "pause_self",
    kind: "kernel",
    availableFor: settlesItself,
    description: [
      "Park this cell: it keeps everything (state, artifacts, history) but does nothing and costs nothing until the owner or the desk resumes it. Use it for work that is deliberately on hold (a someday item whose research is done).",
      "Child cells that are still open would be left without a parent to wake: when some are open you are told which, and nothing is parked — wait for them, or call again with closeChildren: true. The run ends now; messages that arrive while parked wait until you are resumed.",
    ].join(" "),
    input: z.object({
      reason: z.string().min(1).describe("why it is parked and what would bring it back"),
      closeChildren: z.boolean().optional().describe("true: also stop the child cells that are still open"),
    }),
    async handler(args, ctx) {
      const settle = ctx.ports.settleSelf;
      if (!settle) return { output: "This environment cannot park a cell from inside.", isError: true };
      await settle.call(ctx.ports, { action: "pause", pauseReason: "parked", summary: args.reason, ...(args.closeChildren ? { force: true } : {}) });
      const status: CellStatusLine = { text: clipLine(`已停靠：${args.reason}`, 200), at: ctx.clock.now() };
      await ctx.ports.context.commit(selfId(ctx), { statePatches: { [CELL_STATUS_KEY]: status } });
      return { output: "Parked after this run. Stop here.", endRun: "completed", data: { action: "pause" } };
    },
  });
  return {
    name: COMMS_TOOLSET,
    description: "Workbench notifications and messages to other cells, approval requests and withdrawing them, reports to the parent, handback, wait, complete_self / pause_self.",
    tools: [sendMessage, requestApproval, withdrawCard, settleItem, reportToParent, handback, wait, clearWait, completeSelf, pauseSelf],
  };
}
