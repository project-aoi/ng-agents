import { z } from "zod";
import {
  anyCovers,
  CELL_STATUS_KEY,
  createEnvelope,
  defineTool,
  DESK_CELL_ID,
  inboxAddr,
  isChannelAddr,
  KERNEL_FROM,
  newId,
  PAYLOAD,
  type AuthorizeResult,
  type CardPrep,
  type CellProgressPayload,
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
import { defaultSubjectKey, itemRawInput, itemSource, primaryEnvelope, selfId } from "./util";

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

const hasParent = ({ spec }: { spec?: CellSpec }) => spec === undefined || Boolean(spec.parentId);
const canReachChannels = ({ bounds }: { bounds: PolicyBounds }) => bounds.canSendTo.some((a) => a.startsWith("channel:"));

/**
 * `kernel.comms`: send_message, request_approval, report_to_parent, handback, wait.
 * send_message and request_approval always go through `authorize` (allow → act with the token; deny → feedback to the
 * model; defer → the card is pending in Gate and the Run ends `deferred_for_approval`).
 */
export function commsToolset(opts: CommsToolsetOptions = {}): Toolset {
  const ownerAddresses = opts.ownerAddresses ?? DEFAULT_OWNER_ADDRESSES;
  const deskCellId = opts.deskCellId ?? DESK_CELL_ID;

  const sendMessage = defineTool({
    name: "send_message",
    kind: "kernel",
    availableFor: canReachChannels,
    description: [
      "Send a message to a person through a channel address (channel:<channelId>:<target>).",
      "Messages to the owner go out directly. Messages to anyone else are saved as a versioned draft and normally wait on an approval card for the owner — the run then ends and you are woken with the outcome.",
      "To revise a draft you already saved, pass its artifactId instead of text.",
    ].join(" "),
    input: z.object({
      to: z.string().describe("channel:<channelId>:<target>"),
      text: z.string().min(1).optional(),
      artifactId: z.string().min(1).optional().describe("send the current version of this draft"),
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
      if (!isChannelAddr(args.to)) {
        return { output: `"${args.to}" is not a channel address (channel:<channelId>:<target>). Use report_to_parent for your parent cell.`, isError: true };
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
    description:
      "Report to the cell that started you. kind result: your final outcome (once, when done or failed); kind progress: a short status update that the parent reads at its next wake-up without being woken.",
    input: z.object({
      kind: z.enum(["result", "progress"]),
      text: z.string().min(1).describe("result: what you did and found; progress: one line"),
      status: z.enum(["completed", "failed"]).optional().describe("result only; default completed"),
      artifactId: z.string().optional().describe("the deliverable you saved, if any"),
      progress: z.object({ done: z.number().int().min(0), total: z.number().int().min(1), label: z.string().optional() }).optional(),
      data: z.unknown().optional().describe("structured result for the parent"),
    }),
    async handler(args, ctx) {
      const childCellId = selfId(ctx);
      if (args.kind === "result") {
        const payload: CellResultPayload = {
          childCellId,
          status: args.status ?? "completed",
          summary: args.text,
          ...(args.artifactId ? { artifactId: args.artifactId } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
        };
        await ctx.ports.emitToParent(PAYLOAD.cellResult, payload);
      } else {
        const payload: CellProgressPayload = {
          childCellId,
          text: args.text,
          ...(args.progress ? { progress: args.progress } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
        };
        await ctx.ports.emitToParent(PAYLOAD.cellProgress, payload, { delivery: "silent_inject" });
      }
      const status: CellStatusLine = { text: args.text.split("\n")[0]!.slice(0, 200), at: ctx.clock.now(), ...(args.progress ? { progress: args.progress } : {}) };
      await ctx.ports.context.commit(childCellId, { statePatches: { [CELL_STATUS_KEY]: status } });
      return args.kind === "result" ? "Result delivered to your parent." : "Progress noted.";
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
      envelopeId: z.string().optional().describe("which message of this wake-up; defaults to the main one"),
    }),
    async handler(args, ctx) {
      const envs = ctx.snapshot.batch.envelopes;
      const env = args.envelopeId ? envs.find((e) => e.id === args.envelopeId) : (envs.find((e) => e.type === "user.message") ?? primaryEnvelope(ctx.snapshot));
      if (!env) return { output: `No message ${args.envelopeId ?? ""} in this wake-up.`, isError: true };
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
    description:
      "End this run without doing anything more: nothing needs attention now, or you are waiting for a reply, a job or a child. You are woken by the next message.",
    input: z.object({ reason: z.string().min(1) }),
    handler: () => ({ output: "Waiting.", endRun: "yielded_waiting" }),
  });

  return {
    name: COMMS_TOOLSET,
    description: "Messages to people (Gate-checked), approval requests, reports to the parent, handback, wait.",
    tools: [sendMessage, requestApproval, reportToParent, handback, wait],
  };
}
