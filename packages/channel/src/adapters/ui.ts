import { NgError, PAYLOAD, newId, type DeliverableAttachment, type Envelope, type UserMessagePayload } from "@ng/protocol";
import { BaseChannel, type BaseChannelOptions } from "../base";

export const UI_CHANNEL_ID = "ui";
/** Adapter-level target for "the owner, in the workbench". */
export const UI_OWNER_TARGET = "owner";

export type UiChannelOptions = Partial<BaseChannelOptions>;

export interface CaptureInput {
  text: string;
  attachments?: DeliverableAttachment[];
  threads?: string[];
  voice?: boolean;
  /** Client-generated id: a retried submit of the same capture dedupes in the Inbox. */
  clientId?: string;
}

export class UiChannel extends BaseChannel {
  constructor(opts: UiChannelOptions = {}) {
    super({ ...opts, id: opts.id ?? UI_CHANNEL_ID });
  }

  /** Persists a 随手记 entry through the hub's ingress sink; resolves once it is durably enqueued. */
  async capture(input: CaptureInput): Promise<Omit<Envelope,"to">> {
    const env=this.captureEnvelope(input,this.ownerPrincipal);
    await this.emitIngress(env);
    return env;
  }

  captureEnvelope(input: CaptureInput, principalId: string): Omit<Envelope,"to"> {
    const text = input.text.trim();
    if (!text && !input.attachments?.length) throw new NgError("invalid_argument", "capture: empty input");
    if (!principalId.trim()) throw new NgError("invalid_argument","capture requires principalId");
    const replyTo = this.addr(UI_OWNER_TARGET);
    const payload: UserMessagePayload = { text, replyTo, sender: { id: principalId, ...(principalId.startsWith("agent:") ? {displayName:"主 Agent"} : {}) } };
    if (input.attachments?.length) payload.attachments = input.attachments;
    if (input.voice) payload.voice = true;
    const env: Omit<Envelope, "to"> = {
      id: this.envelopeId((principalId===this.ownerPrincipal ? "" : principalId+":")+(input.clientId ?? newId("cap", this.clock))),
      from: replyTo,
      principalId,
      kind: "event",
      type: PAYLOAD.userMessage,
      payload,
      createdAt: this.clock.now(),
    };
    if (input.threads?.length) env.threads = input.threads;
    return env;
  }
}
