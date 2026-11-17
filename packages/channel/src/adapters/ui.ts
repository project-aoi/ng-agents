import { NgError, PAYLOAD, newId, type Bus, type DeliverableAttachment, type Envelope, type UserMessagePayload } from "@ng/protocol";
import { BaseChannel, type BaseChannelOptions } from "../base";
import type { DeliveryRequest, DeliveryResult, EditRequest } from "../types";

export const UI_CHANNEL_ID = "ui";
/** Adapter-level target for "the owner, in the workbench". */
export const UI_OWNER_TARGET = "owner";

export interface UiChannelOptions extends Partial<Pick<BaseChannelOptions, "id" | "clock" | "ownerPrincipal" | "sendTimeoutMs">> {
  /** When given, streaming-preview chunks are also announced as `channel.preview` for the app's SSE stream. */
  bus?: Bus;
}

export interface CaptureInput {
  text: string;
  attachments?: DeliverableAttachment[];
  threads?: string[];
  voice?: boolean;
  /** Client-generated id: a retried submit of the same capture dedupes in the Inbox. */
  clientId?: string;
}

/**
 * The workbench itself. Ingress is 随手记 (`capture`, always the owner). Outbound notifications need no transport:
 * the hub's outbox row is the notification and `outbox.changed` announces it, so delivery just confirms.
 */
export class UiChannel extends BaseChannel {
  readonly kind = "ui";
  readonly capabilities = { idempotentSend: true, withdrawOrEdit: true, streamingPreview: true } as const;
  readonly #bus: Bus | undefined;
  readonly #previewListeners = new Set<(target: string, chunk: string) => void>();

  constructor(opts: UiChannelOptions = {}) {
    super({ ...opts, id: opts.id ?? UI_CHANNEL_ID });
    this.#bus = opts.bus;
  }

  /** Persists a 随手记 entry through the hub's ingress sink; resolves once it is durably enqueued. */
  async capture(input: CaptureInput): Promise<Omit<Envelope, "to">> {
    const text = input.text.trim();
    if (!text && !input.attachments?.length) throw new NgError("invalid_argument", "capture: empty input");
    const replyTo = this.addr(UI_OWNER_TARGET);
    const payload: UserMessagePayload = { text, replyTo, sender: { id: this.ownerPrincipal } };
    if (input.attachments?.length) payload.attachments = input.attachments;
    if (input.voice) payload.voice = true;
    const env: Omit<Envelope, "to"> = {
      id: this.envelopeId(input.clientId ?? newId("cap", this.clock)),
      from: replyTo,
      principalId: this.ownerPrincipal,
      kind: "event",
      type: PAYLOAD.userMessage,
      payload,
      createdAt: this.clock.now(),
    };
    if (input.threads?.length) env.threads = input.threads;
    await this.emitIngress(env);
    return env;
  }

  protected async transmit(req: DeliveryRequest): Promise<DeliveryResult> {
    return { status: "sent", externalId: req.idempotencyKey };
  }

  /** The UI renders the outbox row, which the hub rewrites on a successful edit. */
  async edit(_req: EditRequest): Promise<DeliveryResult> {
    return { status: "sent" };
  }

  async streamPreview(target: string, chunk: string): Promise<void> {
    for (const l of [...this.#previewListeners]) l(target, chunk);
    this.#bus?.emit("channel.preview", { channelId: this.id, target, chunk });
  }

  onPreview(listener: (target: string, chunk: string) => void): () => void {
    this.#previewListeners.add(listener);
    return () => this.#previewListeners.delete(listener);
  }
}
