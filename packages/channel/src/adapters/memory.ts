import { PAYLOAD, newId, type ChannelCapabilities, type Deliverable, type Envelope, type UserMessagePayload } from "@ng/protocol";
import { BaseChannel, type BaseChannelOptions } from "../base";
import type { DeliveryRequest, DeliveryResult, EditRequest } from "../types";

export type MemoryOutcome = "sent" | "failed" | "unknown" | "hang" | "throw";

export interface MemoryDelivery {
  target: string;
  content: Deliverable;
  idempotencyKey: string;
  attempt: number;
  outcome: MemoryOutcome;
  externalId: string | null;
}

export interface MemoryEdit {
  target: string;
  externalId: string;
  content: Deliverable;
}

export interface MemoryChannelOptions extends Partial<Pick<BaseChannelOptions, "id" | "clock" | "ownerIds" | "ownerPrincipal" | "sendTimeoutMs">> {
  capabilities?: Partial<ChannelCapabilities>;
}

export interface InjectInput {
  /** Counterpart's external user id; principal becomes `<channelId>:<from>` (or the owner if listed in ownerIds). */
  from: string;
  text?: string;
  /** Override the payload type/payload (default `user.message` built from `text`). */
  type?: string;
  payload?: unknown;
  threads?: string[];
  /** Reply target on this channel (default: the counterpart id). */
  replyTarget?: string;
  /** Transport id; reuse it to simulate a redelivered webhook. */
  id?: string;
  kind?: Envelope["kind"];
  delivery?: Envelope["delivery"];
}

/**
 * In-memory channel for tests and the demo: records every delivery attempt, lets a test inject inbound messages as a
 * named counterpart, and can be scripted to answer `failed`, `unknown`, hang (until the hub's timeout aborts it), or
 * throw.
 */
export class MemoryChannel extends BaseChannel {
  readonly kind = "memory";
  readonly capabilities: ChannelCapabilities;
  readonly deliveries: MemoryDelivery[] = [];
  readonly edits: MemoryEdit[] = [];
  readonly previews: Array<{ target: string; chunk: string }> = [];
  #script: Array<{ outcome: MemoryOutcome; error?: string }> = [];
  #default: { outcome: MemoryOutcome; error?: string } = { outcome: "sent" };
  #seq = 0;

  constructor(opts: MemoryChannelOptions = {}) {
    super({ ...opts, id: opts.id ?? "memory" });
    this.capabilities = { idempotentSend: true, withdrawOrEdit: true, streamingPreview: true, ...opts.capabilities };
  }

  /** Successful deliveries only. */
  get sent(): MemoryDelivery[] {
    return this.deliveries.filter((d) => d.outcome === "sent");
  }

  /** Script the next `times` deliveries (default 1); afterwards the default outcome applies again. */
  respondWith(outcome: MemoryOutcome, opts: { times?: number; error?: string } = {}): this {
    const step = opts.error === undefined ? { outcome } : { outcome, error: opts.error };
    for (let i = 0; i < (opts.times ?? 1); i++) this.#script.push(step);
    return this;
  }

  /** Outcome for every delivery not covered by `respondWith`. */
  setDefault(outcome: MemoryOutcome, error?: string): this {
    this.#default = error === undefined ? { outcome } : { outcome, error };
    return this;
  }

  reset(): void {
    this.deliveries.length = 0;
    this.edits.length = 0;
    this.previews.length = 0;
    this.#script = [];
    this.#default = { outcome: "sent" };
  }

  async inject(input: InjectInput): Promise<Omit<Envelope, "to">> {
    const replyTo = this.addr(input.replyTarget ?? input.from);
    let payload: unknown = input.payload;
    if (payload === undefined) {
      const p: UserMessagePayload = { text: input.text ?? "", replyTo, sender: { id: input.from } };
      payload = p;
    }
    const env: Omit<Envelope, "to"> = {
      id: this.envelopeId(input.id ?? newId("mem", this.clock)),
      from: replyTo,
      principalId: this.principalFor(input.from),
      kind: input.kind ?? "event",
      type: input.type ?? PAYLOAD.userMessage,
      payload,
      createdAt: this.clock.now(),
    };
    if (input.threads?.length) env.threads = input.threads;
    if (input.delivery) env.delivery = input.delivery;
    await this.emitIngress(env);
    return env;
  }

  protected async transmit(req: DeliveryRequest): Promise<DeliveryResult> {
    const step = this.#script.shift() ?? this.#default;
    const externalId = step.outcome === "sent" ? `mem-${++this.#seq}` : null;
    this.deliveries.push({ target: req.target, content: req.content, idempotencyKey: req.idempotencyKey, attempt: req.attempt, outcome: step.outcome, externalId });
    switch (step.outcome) {
      case "sent":
        return { status: "sent", externalId };
      case "failed":
        return { status: "failed", error: step.error ?? "memory channel scripted failure" };
      case "unknown":
        return { status: "unknown", error: step.error ?? "memory channel scripted unknown" };
      case "throw":
        throw new Error(step.error ?? "memory channel scripted transport error");
      case "hang":
        return new Promise<DeliveryResult>((resolve) => {
          const done = () => resolve({ status: "unknown", error: "aborted while hanging" });
          if (req.signal.aborted) done();
          else req.signal.addEventListener("abort", done, { once: true });
        });
    }
  }

  async edit(req: EditRequest): Promise<DeliveryResult> {
    if (!this.capabilities.withdrawOrEdit) return { status: "failed", error: "edit not supported" };
    this.edits.push({ target: req.target, externalId: req.externalId, content: req.content });
    return { status: "sent" };
  }

  async streamPreview(target: string, chunk: string): Promise<void> {
    this.previews.push({ target, chunk });
  }
}
