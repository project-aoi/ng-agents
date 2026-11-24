import {
  CELL_DIRECT_CHAT_KEY,
  createEnvelope,
  inboxAddr,
  KERNEL_FROM,
  newId,
  NgError,
  parsePrincipal,
  PAYLOAD,
  projectCellIdOf,
  withTx,
  type CellDirectChatPayload,
  type CellDirectChatState,
  type CellMessageDraft,
  type CellMessagePayload,
  type CellRecord,
  type Envelope,
  type SendToCellResult,
  type UserMessagePayload,
  speaks,
} from "@ng/protocol";
import { AGENT_NOTE_LABEL } from "@ng/context";
import { isProjectRoot, type KernelCore } from "./core";
import type { DirectMessage, DirectMessageResult } from "./types";

type MessageCore = Pick<KernelCore, "registry" | "db" | "cells" | "inbox" | "clock" | "context" | "ownerPrincipal">;

const clip = (text: string) => (text.length > 400 ? `${text.slice(0, 400)}…` : text);

/** The owner, or an agent on the control plane speaking for them — as opposed to a cell or an outside sender. */
export function isPersonPrincipal(core: Pick<KernelCore, "registry" | "ownerPrincipal">, principalId: string): boolean {
  const kind = parsePrincipal(principalId, core.ownerPrincipal).kind;
  return kind === "owner" || kind === "agent";
}

/** The message `id` in this cell's inbox, when a person (the owner, their agent) sent it: what may be passed on as the owner's word. */
export function ownerMessageIn(core: Pick<KernelCore, "registry" | "ownerPrincipal" | "inbox">, cellId: string, id: string): Envelope | null {
  const env = core.inbox.listMessagesSync({ cellId, envelopeId: id, limit: 1 })[0]?.envelope;
  return env && isPersonPrincipal(core, env.principalId) && speaks(env) ? env : null;
}

/** The person whose words an envelope carries: its sender, or — passed on by another cell — the sender of the message it names. */
export function spokenBy(core: Pick<KernelCore, "registry" | "ownerPrincipal" | "inbox">, env: Envelope): string | null {
  if (isPersonPrincipal(core, env.principalId) && speaks(env)) return env.principalId;
  const p = env.payload as { ownerMessageId?: unknown } | null;
  const from = parsePrincipal(env.principalId, core.ownerPrincipal);
  if (env.type !== PAYLOAD.cellMessage || from.kind !== "cell" || typeof p?.ownerMessageId !== "string") return null;
  return ownerMessageIn(core, from.cellId, p.ownerMessageId)?.principalId ?? null;
}

/**
 * A person spoke to `target` directly. When the target is a leaf below a coordinator, the coordinator gets the words
 * too — in the caller's transaction, so there is no moment in which the worker knows something its project cannot
 * find out. Background by default: five messages to a worker do not wake the project five times; they are all in
 * front of it when the worker's turn settles (or whenever else it wakes). Returns the parent that was copied.
 */
export function ccDirectChat(
  core: MessageCore,
  target: CellRecord,
  o: { text: string; mode: "enqueue" | "steer"; messageId: string; principalId: string; notifyParent?: "silent" | "wakeup"; replyToId?: string; replyToText?: string; conversationId?: string; agentContext?: string },
): string | null {
  const now = core.clock.now();
  const prev = core.context.readStateSync<CellDirectChatState>(target.id, CELL_DIRECT_CHAT_KEY);
  const state: CellDirectChatState = {
    total: (prev?.total ?? 0) + 1,
    unsettled: (prev?.unsettled ?? 0) + 1,
    lastAt: now,
    seen: [...(prev?.seen ?? []), o.messageId].slice(-50),
  };
  core.context.commitSync(target.id, { statePatches: { [CELL_DIRECT_CHAT_KEY]: state } });
  if (!target.parentId || !target.spec.ccParent) return null;
  const parent = core.cells.get(target.parentId);
  if (!parent || parent.status === "closed") return null;
  const project = projectCellIdOf(target.spec);
  const payload: CellDirectChatPayload = {
    childCellId: target.id,
    ...(target.title ? { childTitle: target.title } : {}),
    text: o.text,
    mode: o.mode,
    messageId: o.messageId,
    ...(o.replyToId ? { replyToId: o.replyToId } : {}),
    ...(o.conversationId ? { conversationId: o.conversationId } : {}),
    ...(o.agentContext ? { agentContext: o.agentContext } : {}),
    ...(project ? { projectCellId: project } : {}),
    at: now,
  };
  core.inbox.enqueueSync(
    parent.id,
    createEnvelope<CellDirectChatPayload>(
      {
        id: `${o.messageId}:cc`,
        from: KERNEL_FROM.control,
        to: inboxAddr(parent.id),
        // The copy keeps the speaker: the parent sees who said it, not "the kernel".
        principalId: o.principalId,
        kind: "event",
        type: PAYLOAD.cellDirectChat,
        payload,
        expectedEpoch: parent.epoch,
        delivery: o.notifyParent === "wakeup" ? "wakeup" : "silent_inject",
      },
      core.clock,
    ),
  );
  return parent.id;
}

/**
 * One cell (or the control plane) talking to another (docs/05 guard 1 "已关明拒"). The target's state is read and the
 * message enqueued in one transaction, so the answer is exact: `delivered` means it is in a live cell's queue (a leaf
 * that has not settled yet will take it before its turn is reported — its settle transaction counts pending wake-ups
 * after this one committed; a dormant one is woken by it), `closed` means nothing was stored.
 */
export function sendCellMessage(
  core: MessageCore,
  o: { from: Envelope["from"]; principalId: string; sender: string; toCellId: string; id: string; message: CellMessageDraft; replyToId?: string; replyToText?: string; conversationId?: string; agentContext?: string; notifyParent?: "silent" | "wakeup" },
): SendToCellResult {
  return withTx(core.db, () => {
    const target = core.cells.get(o.toCellId);
    if (!target) return { status: "not_found" };
    if (target.status === "closed") return { status: "closed", closeReason: target.closeReason };
    const sender = core.cells.get(o.sender);
    const projectId = sender && (isProjectRoot(core.registry, sender) ? sender.id : projectCellIdOf(sender.spec));
    const payload: CellMessagePayload = {
      ...(sender?.title ? { fromTitle: sender.title } : {}),
      ...(projectId ? { fromProjectCellId: projectId } : {}),
      fromCellId: o.sender,
      text: o.message.text,
      ...(o.message.summary ? { summary: o.message.summary } : {}),
      ...(o.message.data !== undefined ? { data: o.message.data } : {}),
      ...(o.replyToId ? { replyToId: o.replyToId } : {}),
      ...(o.replyToText ? { replyToText: clip(o.replyToText) } : {}),
      ...(o.conversationId ? { conversationId: o.conversationId } : {}),
      ...(o.agentContext ? { agentContext: o.agentContext } : {}),
      ...(o.message.ownerMessageId ? { ownerMessageId: o.message.ownerMessageId } : {}),
    };
    const envelope = createEnvelope<CellMessagePayload>(
      {
        id: o.id,
        from: o.from,
        to: inboxAddr(target.id),
        principalId: o.principalId,
        kind: "event",
        type: PAYLOAD.cellMessage,
        payload,
        expectedEpoch: target.epoch,
        ...(o.message.quiet ? { delivery: "silent_inject" as const } : {}),
        ...(o.message.threads?.length ? { threads: o.message.threads } : {}),
      },
      core.clock,
    );
    const accepted = core.inbox.enqueueSync(target.id, envelope) === "accepted";
    // A retried send (same id) is not copied twice either.
    if (accepted && isPersonPrincipal(core, o.principalId)) {
      ccDirectChat(core, target, { text: o.message.text, mode: "enqueue", messageId: envelope.id, principalId: o.principalId, ...(o.notifyParent ? { notifyParent: o.notifyParent } : {}), ...(o.replyToId ? { replyToId: o.replyToId } : {}), ...(o.conversationId ? { conversationId: o.conversationId } : {}), ...(o.agentContext ? { agentContext: o.agentContext } : {}) });
    }
    return { status: "delivered", envelopeId: envelope.id, targetStatus: target.status };
  });
}

/** Kernel.directMessage — see the interface for the contract. */
export function directMessage(
  core: Pick<KernelCore, "registry" | "db" | "cells" | "inbox" | "clock" | "context" | "ownerPrincipal" | "lifecycle">,
  cellId: string,
  message: DirectMessage,
  principalId: string,
): DirectMessageResult {
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!text) throw new NgError("invalid_argument", "a message needs text");
  if (!isPersonPrincipal(core, principalId)) {
    return { status: "refused", reason: "not_allowed", detail: `${principalId} is not the owner or an agent on the control plane; cells talk to cells with send_message` };
  }
  const agentContext = typeof message.agentContext === "string" && message.agentContext.trim() ? message.agentContext.trim() : undefined;
  const mode = message.mode ?? "enqueue";
  if (mode !== "enqueue" && mode !== "steer") throw new NgError("invalid_argument", `unknown mode "${String(mode)}" (enqueue | steer)`);
  return withTx(core.db, (): DirectMessageResult => {
    let target = core.cells.get(cellId);
    if (!target) return { status: "not_found" };
    if (target.spec.processor.kind === "code") {
      return { status: "refused", reason: "code", detail: "this cell runs a deterministic script, not a model: it takes no conversation (trigger, pause or resume it instead)" };
    }
    const id = message.clientId ?? newId("msg", core.clock);
    const seen = core.context.readStateSync<CellDirectChatState>(cellId, CELL_DIRECT_CHAT_KEY)?.seen ?? [];
    if (seen.includes(id) || (message.clientId && core.inbox.listMessagesSync({ cellId, envelopeId: id }).some(m => m.envelope.from === KERNEL_FROM.control))) {
      return { status: "delivered", envelopeId: id, duplicate: true, reopened: false, targetStatus: target.status, ccTo: null };
    }
    let reopened = false;
    if (target.status === "closed") {
      // "Three seconds too late" must not exist for the owner: a worker that was closed under an open project comes back.
      if (!core.lifecycle.reopenLeafSync(cellId)) {
        if (core.cells.ancestors(cellId).some(c => c.status === "paused"))
          return { status: "refused", reason: "paused_parent", detail: "resume the parent before messaging this archived worker" };
        return { status: "refused", reason: "archived", detail: "this cell was closed with its project (or is not a worker that can be brought back); start the work again from its project or the desk" };
      }
      reopened = true;
      target = core.cells.require(cellId);
    }
    const refs = {
      ...(message.replyToId ? { replyToId: message.replyToId } : {}),
      ...(message.replyToText ? { replyToText: clip(message.replyToText) } : {}),
      ...(message.conversationId ? { conversationId: message.conversationId } : {}),
      ...(agentContext ? { agentContext } : {}),
    };
    const common = { text, mode, messageId: id, principalId, ...(message.notifyParent ? { notifyParent: message.notifyParent } : {}), ...refs };
    let ccTo: string | null;
    if (mode === "steer") {
      // A steer carries one text: the agent's note rides in it under the same label the other messages render it with.
      const steerMessage = agentContext ? `${text}\n\n${AGENT_NOTE_LABEL}\n${agentContext}` : text;
      const r = core.inbox.controlSync(cellId, { action: "steer", principalId, steerMessage, steerEnvelopeId: id, ...(message.replyToId && { steerReplyToId: message.replyToId }) });
      if (!r.applied) return { status: "refused", reason: "not_allowed", detail: r.reason ?? "the steer was refused" };
      ccTo = ccDirectChat(core, target, common);
    } else if (target.parentId === null) {
      // The root is the owner's own counterpart: what they type there is a user message like any other entry point's,
      // so the desk's books treat it as an item (and can tell which question it answers).
      const payload: UserMessagePayload & { replyToId?: string; replyToText?: string; conversationId?: string } = { text, sender: { id: principalId }, ...refs };
      core.inbox.enqueueSync(
        cellId,
        createEnvelope<UserMessagePayload>({ id, from: KERNEL_FROM.control, to: inboxAddr(cellId), principalId, kind: "event", type: PAYLOAD.userMessage, payload, expectedEpoch: target.epoch }, core.clock),
      );
      ccTo = ccDirectChat(core, target, common);
    } else {
      const r = sendCellMessage(core, {
        from: KERNEL_FROM.control,
        principalId,
        sender: principalId,
        toCellId: cellId,
        id,
        message: { text },
        ...refs,
        ...(message.notifyParent ? { notifyParent: message.notifyParent } : {}),
      });
      if (r.status !== "delivered") return { status: "refused", reason: "not_allowed", detail: `not delivered (${r.status})` };
      ccTo = target.parentId && target.spec.ccParent && core.cells.get(target.parentId)?.status !== "closed" ? target.parentId : null;
    }
    return { status: "delivered", envelopeId: id, duplicate: false, reopened, targetStatus: target.status === "paused" ? "paused" : "active", ccTo };
  });
}
