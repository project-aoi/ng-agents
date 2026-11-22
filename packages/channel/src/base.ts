import { NgError, OWNER_PRINCIPAL, channelAddr, systemClock, type Channel, type ChannelAddr, type Clock, type Envelope, type IngressEmit } from "@ng/protocol";

export interface BaseChannelOptions {
  id: string;
  clock?: Clock;
  ownerPrincipal?: string;
}

export class BaseChannel implements Channel {
  readonly id: string;
  protected readonly clock: Clock;
  protected readonly ownerPrincipal: string;
  #emit?: IngressEmit;

  constructor(opts: BaseChannelOptions) {
    this.id = opts.id;
    this.clock = opts.clock ?? systemClock;
    this.ownerPrincipal = opts.ownerPrincipal ?? OWNER_PRINCIPAL;
  }

  onIngress(emit: IngressEmit): void { this.#emit = emit; }
  protected addr(target: string): ChannelAddr { return channelAddr(this.id, target); }
  protected envelopeId(id: string): string { return `${this.id}:${id}`; }
  protected async emitIngress(raw: Omit<Envelope, "to">): Promise<void> {
    if (!this.#emit) throw new NgError("unsupported", `channel "${this.id}" has no ingress handler`);
    await this.#emit(raw);
  }
}
