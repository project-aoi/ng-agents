import { z } from "zod";
import {
  anyCovers,
  CELL_RESULT_CANDIDATE_KEY,
  CELL_STATUS_KEY,
  createEnvelope,
  defineTool,
  DESK_CELL_ID,
  inboxAddr,
  isChannelAddr,
  isInboxAddr,
  KERNEL_FROM,
  newId,
  PAYLOAD,
  type AuthorizeResult,
  type CardPrep,
  type CellProgressPayload,
  type CellResultCandidate,
  type CellResultPayload,
  type CellSpec,
  type CellStatusLine,
  type ChannelAddr,
  type ChannelSendAction,
  type Deliverable,
  type DraftRef,
  type EscalationCard,
  type HandbackPayload,
  type PolicyBounds,
  type ProjectProposal,
  type ProjectProposalCard,
  type ProposedAction,
  type ResponseCard,
  type RunPorts,
  type SendReceipt,
  type ToolContext,
  type ToolResult,
  type Toolset,
} from "@ng/protocol";
import { defaultSubjectKey, itemRawInput, itemSource, clip, primaryEnvelope, selfId } from "./util";

export const COMMS_TOOLSET = "kernel.comms";

/** Sends to these address patterns reach the owner themself: `notify_owner`, allowed without a card (docs/03 原则 2). */
export const DEFAULT_OWNER_ADDRESSES: readonly string[] = ["channel:ui:*", "channel:cli:*"];

/**
 * Optional port: `Inbox.handback(claimId = runId, envelopeId, reason)` bound to the Run. RunPorts does not declare it;
 * when the kernel provides it, `handback` uses it (the original row ends `handed_back`). Otherwise the tool falls
 * back to committing the same `handback` envelope (same id convention) to the desk through `context.commit`.
 */
export interface HandbackPort {
  handback(envelopeId: string, reason: string): Promise<void>;
}

export interface CommsToolsetOptions {
  ownerAddresses?: readonly string[];
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

const RECEIPT_TEXT: Readonly<Record<SendReceipt, string>> = {
  sent: "Sent.",
  buffered_dnd: "Held: the owner is in focus mode; it is delivered when they leave it.",
  failed: "Sending failed (the channel reported failure). Nothing was delivered.",
  unknown: "Delivery status unknown: it may or may not have arrived. Do not resend it; tell the owner if it matters.",
};

async function decide(
  ctx: ToolContext,
  action: ProposedAction,
  artifactVersion: number | undefined,
  onAllow: (token: string) => Promise<ToolResult>,
): Promise<ToolResult> {
  const r: AuthorizeResult = await ctx.ports.authorize(action, artifactVersion !== undefined ? { artifactVersion } : undefined);
  switch (r.type) {
    case "deny":
      return { output: `Not allowed: ${r.feedback}`, isError: true, data: { decision: "deny" } };
    case "defer":
      return {
        output: `Waiting for the owner's decision (card ${r.actionId}${r.boundArtifactVersion !== undefined ? `, draft v${r.boundArtifactVersion}` : ""}). This run ends now; you will receive approval.resolved with the outcome.`,
        endRun: "deferred_for_approval",
        data: { decision: "defer", actionId: r.actionId, boundArtifactVersion: r.boundArtifactVersion },
      };
    case "allow":
      return onAllow(r.actionToken);
  }
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
const isOneShot = (spec: CellSpec | undefined) => spec?.lifetime === "one_shot";
/** complete_self / pause_self: for cells that live until they say so (a one-shot cell just reports its result). */
const settlesItself = ({ spec }: { spec?: CellSpec }) => spec !== undefined && Boolean(spec.parentId) && !isOneShot(spec);
const canReachChannels = (bounds: PolicyBounds) => bounds.canSendTo.some((a) => a.startsWith("channel:"));

/** `inbox:<cellId>` → what to tell the model about a cell-to-cell delivery (docs/05 guard 1: a closed target is said out loud). */
async function sendToInbox(ctx: ToolContext, to: `inbox:${string}`, args: { text?: string | undefined; summary: string }): Promise<ToolResult> {
  if (!args.text) return { output: "A message to another cell needs text.", isError: true };
  const send = ctx.ports.sendToCell;
  if (!send) return { output: "Cell-to-cell messages are not available in this environment.", isError: true };
  const target = to.slice("inbox:".length);
  const r = await send.call(ctx.ports, to, { text: args.text, summary: args.summary, id: `${ctx.snapshot.runId}:${ctx.toolUseId}:msg` });
  switch (r.status) {
    case "delivered":
      return {
        output:
          r.targetStatus === "paused"
            ? `Delivered to ${target}, which is paused: it reads the message when it is resumed.`
            : `Delivered to ${target}. It handles the message in its current run or is woken with it; if you need its answer, end your turn with wait (waitingFor "${to}").`,
        data: r,
      };
    case "closed":
      return {
        output: `NOT DELIVERED — ${target} is closed (it already finished${r.closeReason === "cancelled" ? " or was cancelled" : " and reported"}). Nothing was stored. If the work still needs doing, start a new worker with spawn_cell and give it the context it needs (what the previous one did, the branch or artifact it left).`,
        isError: true,
        data: r,
      };
    case "not_found":
      return { output: `NOT DELIVERED — there is no cell "${target}". Check the id in the in-flight list at the end of your wake-up message.`, isError: true, data: r };
    case "refused":
      return { output: `Not allowed: ${r.reason}.`, isError: true, data: r };
  }
}

/**
 * `kernel.comms`: send_message, request_approval, report_to_parent, handback, wait, complete_self, pause_self.
 * send_message and request_approval always go through `authorize` (allow → act with the token; deny → feedback to the
 * model; defer → the card is pending in Gate and the Run ends `deferred_for_approval`).
 */
export function commsToolset(opts: CommsToolsetOptions = {}): Toolset {
  const ownerAddresses = opts.ownerAddresses ?? DEFAULT_OWNER_ADDRESSES;
  const deskCellId = opts.deskCellId ?? DESK_CELL_ID;

  const sendMessage = defineTool({
    name: "send_message",
    kind: "kernel",
    description: [
      "Send a message to a person or to another cell.",
      "To a person — channel:<channelId>:<target>: messages to the owner go out directly; messages to anyone else are saved as a versioned draft and normally wait on an approval card for the owner (the run then ends and you are woken with the outcome). To revise a draft you already saved, pass its artifactId instead of text.",
      "To a cell — inbox:<cellId>: delivered at once, no approval (forward a follow-up to a child that is working, ask inbox:desk to arbitrate, answer a cell that asked you). The result tells you if the cell has already closed — then nothing was delivered and you start a new worker instead.",
    ].join(" "),
    input: z.object({
      to: z.string().describe("channel:<channelId>:<target> for a person, inbox:<cellId> for a cell (inbox:desk = the desk)"),
      text: z.string().min(1).optional(),
      artifactId: z.string().min(1).optional().describe("channel only: send the current version of this draft"),
      format: z.enum(["text", "markdown"]).optional(),
      title: z.string().optional(),
      summary: z.string().min(1).describe("one line saying what this message is, for the card and the audit log"),
      targetLabel: z.string().optional().describe('recipient as the owner would name it, e.g. "张三（飞书）"'),
      urgent: z.boolean().optional().describe("deliver even during the owner's focus time"),
      subjectKey: z.string().optional().describe("the item this belongs to (one pending card per item); defaults to the current item"),
      prep: prepInput.optional(),
      nudge: z
        .object({ explanation: z.string().min(1) })
        .optional()
        .describe("this is a follow-up after a waiting timeout: explain who has not replied and since when"),
    }),
    async handler(args, ctx) {
      if (isInboxAddr(args.to)) return sendToInbox(ctx, args.to, args);
      if (!isChannelAddr(args.to)) {
        return { output: `"${args.to}" is not an address. Use channel:<channelId>:<target> for a person or inbox:<cellId> for a cell.`, isError: true };
      }
      if (!canReachChannels(ctx.ports.self.bounds)) {
        return { output: "This cell has no channel it may send to. Report to your parent (report_to_parent) or ask the desk (send_message to inbox:desk) instead.", isError: true };
      }
      if ((args.text === undefined) === (args.artifactId === undefined)) return { output: "Give exactly one of text or artifactId.", isError: true };
      const to: ChannelAddr = args.to;
      const allowed = ctx.ports.self.bounds.canSendTo;
      if (!anyCovers(allowed, to)) {
        // Checked before saving a draft so a refused send leaves nothing behind; Gate checks again.
        const channels = allowed.filter((a) => a.startsWith("channel:"));
        return { output: `Not allowed: ${to} is outside your send permissions (${channels.join(", ") || "no channels"}).`, isError: true };
      }
      const toOwner = anyCovers(ownerAddresses, to);
      const subjectKey = args.subjectKey ?? defaultSubjectKey(ctx);

      let content: Deliverable;
      let draft: DraftRef | undefined;
      if (args.artifactId) {
        const a = await ctx.ports.context.getArtifact(args.artifactId);
        if (!a) return { output: `No artifact ${args.artifactId}.`, isError: true };
        content = a.content;
        draft = { artifactId: a.artifactId, version: a.version };
      } else {
        content = { format: args.format ?? "text", body: args.text!, ...(args.title ? { title: args.title } : {}) };
        if (!toOwner) {
          // Outward messages always travel as a versioned draft: the human can edit it on the card and Gate binds the approval to that version.
          const artifactId = newId("art", ctx.clock);
          const r = await ctx.ports.context.commit(selfId(ctx), { artifact: { artifactId, content, updatedBy: "agent" } });
          if (!r.ok) return { output: `Could not save the draft: artifact ${artifactId} already exists.`, isError: true };
          draft = { artifactId, version: r.artifactVersion ?? 1 };
        }
      }

      const action: ChannelSendAction = {
        type: "channel.send",
        summary: args.summary,
        subjectKey,
        sideEffect: toOwner ? "notify_owner" : "external",
        target: to,
        content,
        ...(draft ? { artifactId: draft.artifactId } : {}),
        ...(args.urgent ? { urgent: true } : {}),
      };
      if (!toOwner && draft) {
        const title = args.title ?? content.title ?? args.summary;
        const base = { subjectKey, title, source: itemSource(ctx.snapshot), rawInput: itemRawInput(ctx.snapshot), prep: prepOf(args.prep) };
        const card: ResponseCard | EscalationCard = args.nudge
          ? { ...base, cardType: "escalation", escalation: { reason: "waiting_timeout", explanation: args.nudge.explanation, nudgeDraft: draft, nudgeTarget: to } }
          : { ...base, cardType: "response", draft, reply: { target: to, targetLabel: args.targetLabel ?? to }, confirmVerb: "send" };
        action.card = cardDeliverable(title, content.body, card);
      }

      const result = await decide(ctx, action, draft?.version, async (actionToken) => {
        const receipt = await ctx.ports.notifyChannel({
          target: to,
          content,
          idempotencyKey: `${ctx.snapshot.runId}:${ctx.toolUseId}`,
          actionToken,
          respectDnd: !args.urgent,
        });
        return { output: RECEIPT_TEXT[receipt], isError: receipt === "failed" || receipt === "unknown", data: { receipt } };
      });
      if (draft) result.data = { ...(result.data as object), artifactId: draft.artifactId, version: draft.version };
      return result;
    },
  });

  const requestApproval = defineTool({
    name: "request_approval",
    kind: "kernel",
    description: [
      "Ask the owner to decide before you go on (not for sending messages — send_message handles that).",
      "project: propose a multi-step project with its actions; escalation: you are blocked or out of retries/budget and need a decision; action: approve one specific operation (e.g. merging a PR).",
      "Usually becomes an approval card and the run ends; you are woken with approval.resolved. If a standing rule already allows it, you get the go-ahead immediately.",
    ].join(" "),
    input: z.object({
      kind: z.enum(["project", "escalation", "action"]),
      title: z.string().min(1),
      summary: z.string().min(1).describe("one line for the card and the audit log"),
      subjectKey: z.string().optional(),
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
        .object({ reason: z.enum(["blocked", "retry_limit", "budget_exhausted", "waiting_timeout"]), explanation: z.string().min(1) })
        .optional()
        .describe("kind escalation"),
      action: z.object({ name: z.string().min(1), args: z.unknown().optional() }).optional().describe("kind action"),
    }),
    async handler(args, ctx) {
      const subjectKey = args.subjectKey ?? defaultSubjectKey(ctx);
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
        if (!args.action) return { output: "kind action needs action.", isError: true };
        action = {
          type: "custom",
          name: args.action.name,
          ...(args.action.args !== undefined ? { args: args.action.args } : {}),
          summary: args.summary,
          subjectKey,
          sideEffect: "external",
        };
      }
      return decide(ctx, action, artifactVersion, async () => ({
        output: "Approved by a standing rule — go ahead.",
        data: { decision: "allow" },
      }));
    },
  });

  const reportToParent = defineTool({
    name: "report_to_parent",
    kind: "kernel",
    availableFor: hasParent,
    description: [
      "Report to the cell that started you.",
      "kind progress: a short status line your parent reads at its next wake-up without being woken.",
      "kind result: your final outcome, once, when you are done or cannot finish. If you are a one-shot worker this ends your run: the kernel hands the result to your parent and closes you — unless a follow-up message reached you in the meantime, in which case you are woken with it first and report again when that is done too.",
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
      const status: CellStatusLine = { text: args.text.split("\n")[0]!.slice(0, 200), at: ctx.clock.now(), ...(args.progress ? { progress: args.progress } : {}) };
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
      if (isOneShot(ctx.ports.self.spec)) {
        // docs/05 guard 1: nothing is sent from here. The candidate is stored; the kernel delivers it exactly once when
        // the run has settled and the inbox is drained, in the same transaction that closes this cell.
        const candidate: CellResultCandidate = {
          status: args.status ?? "completed",
          summary: args.text,
          ...(args.artifactId ? { artifactId: args.artifactId } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
          at: ctx.clock.now(),
        };
        await ctx.ports.context.commit(childCellId, { statePatches: { [CELL_RESULT_CANDIDATE_KEY]: candidate, [CELL_STATUS_KEY]: status } });
        return {
          output: "Result recorded. Your run ends now; the kernel delivers it to your parent and closes you. If a follow-up message reached you first, you are woken with it instead — handle it, then report the updated result.",
          endRun: "completed",
          data: { staged: true },
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
      return "Result delivered to your parent. You stay open; call complete_self when this cell's whole job is finished.";
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
      "End this run and sleep until the next message wakes you. Sleeping costs nothing and releases your directory's write slot.",
      "Say who you are waiting for with waitingFor, so the wait is on record until exactly that party answers (other wake-ups do not clear it): an address such as \"inbox:desk\" (you asked the desk to arbitrate) or a child's \"inbox:<cellId>\"; \"human\" (the owner must do or decide something — only after you raised a card or recorded an action for them); \"external\" (an outside event — only with a watch or a timer set).",
      "timeoutMinutes wakes you if nothing came by then. Without waitingFor it simply ends the run (a job, a reminder or a reply you already arranged will wake you).",
    ].join(" "),
    input: z.object({
      reason: z.string().min(1).describe("what you are waiting for, in one line"),
      waitingFor: z.string().min(1).optional().describe('"inbox:<cellId>", "human", "external", or a channel address'),
      timeoutMinutes: z.number().positive().max(60 * 24 * 30).optional(),
    }),
    async handler(args, ctx) {
      if (args.waitingFor === undefined) {
        if (args.timeoutMinutes !== undefined) return { output: "timeoutMinutes needs waitingFor (who are you waiting for?). For a plain reminder use the schedule tools.", isError: true };
        return { output: "Waiting.", endRun: "yielded_waiting" };
      }
      const register = ctx.ports.registerWait;
      if (!register) return { output: "Waiting.", endRun: "yielded_waiting" };
      const timeoutAt = args.timeoutMinutes !== undefined ? ctx.clock.now() + Math.round(args.timeoutMinutes * 60_000) : undefined;
      await register.call(ctx.ports, { waitingFor: args.waitingFor, reason: args.reason, ...(timeoutAt !== undefined ? { timeoutAt } : {}) });
      return {
        output: `Waiting for ${args.waitingFor}${timeoutAt !== undefined ? ` (you are woken at ${new Date(timeoutAt).toISOString()} if nothing came)` : ""}. This run ends now.`,
        endRun: "yielded_waiting",
        data: { waitingFor: args.waitingFor, ...(timeoutAt !== undefined ? { timeoutAt } : {}) },
      };
    },
  });
  const completeSelf = defineTool({
    name: "complete_self",
    kind: "kernel",
    availableFor: settlesItself,
    description: [
      "Close this cell because its whole job is finished (or, with cancelled, abandoned). Your parent gets one final result with your summary.",
      "Closing takes every child cell that is still open with it. So when some are open you are told which, and nothing is closed: wait for their results — or call again with closeChildren: true when stopping them is what you mean.",
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
      const status: CellStatusLine = { text: args.summary.split("\n")[0]!.slice(0, 200), at: ctx.clock.now() };
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
      await settle.call(ctx.ports, { action: "pause", summary: args.reason, ...(args.closeChildren ? { force: true } : {}) });
      const status: CellStatusLine = { text: `已停靠：${args.reason}`.slice(0, 200), at: ctx.clock.now() };
      await ctx.ports.context.commit(selfId(ctx), { statePatches: { [CELL_STATUS_KEY]: status } });
      return { output: "Parked after this run. Stop here.", endRun: "completed", data: { action: "pause" } };
    },
  });
  return {
    name: COMMS_TOOLSET,
    description: "Messages to people (Gate-checked) and to other cells, approval requests, reports to the parent, handback, wait, complete_self / pause_self.",
    tools: [sendMessage, requestApproval, reportToParent, handback, wait, completeSelf, pauseSelf],
  };
}
