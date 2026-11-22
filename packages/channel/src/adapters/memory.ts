import { PAYLOAD, externalPrincipal, newId, type Envelope, type UserMessagePayload } from "@ng/protocol";
import { BaseChannel, type BaseChannelOptions } from "../base";

export interface MemoryChannelOptions extends Partial<BaseChannelOptions> {
  ownerIds?: readonly string[];
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
  /** Transport id; reuse it to retry an input. */
  id?: string;
  kind?: Envelope["kind"];
  delivery?: Envelope["delivery"];
}

export class MemoryChannel extends BaseChannel {
  readonly #owners: ReadonlySet<string>;

  constructor(opts: MemoryChannelOptions = {}) {
    super({ ...opts, id: opts.id ?? "memory" });
    this.#owners = new Set(opts.ownerIds ?? []);
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
      principalId: this.#owners.has(input.from) ? this.ownerPrincipal : externalPrincipal(this.id, input.from),
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
}
