import {
  NgError,
  OWNER_PRINCIPAL,
  channelAddr,
  externalPrincipal,
  systemClock,
  threadId,
  type ChannelAddr,
  type ChannelCapabilities,
  type ChannelSendRequest,
  type Clock,
  type Envelope,
  type IngressEmit,
  type SendReceipt,
} from "@ng/protocol";
import type { ChannelAdapter, ChannelStatus, DeliveryRequest, DeliveryResult } from "./types";
import { DEFAULT_SEND_TIMEOUT_MS, errorMessage, runWithTimeout } from "./util";

export interface BaseChannelOptions {
  /** Channel id: the `<channelId>` in `channel:<channelId>:<target>`, in principals and thread ids. No ":". */
  id: string;
  clock?: Clock;
  /** External user ids on this channel that are the human owner; their messages get principal `ownerPrincipal`. */
  ownerIds?: readonly string[];
  ownerPrincipal?: string;
  /** Deadline for a direct `send` (the hub applies its own when it drives `deliver`). */
  sendTimeoutMs?: number;
}

/**
 * Shared adapter plumbing: ingress wiring, principal mapping, status counters, and `send` as raw delivery.
 * Subclasses implement `transmit`. DND, outbox idempotency and token checks are the hub's job, so a direct
 * `send` here ignores `respectDnd` and `actionToken` — always send through `ChannelHub`.
 */
export abstract class BaseChannel implements ChannelAdapter {
  readonly id: string;
  abstract readonly kind: string;
  abstract readonly capabilities: ChannelCapabilities;
  protected readonly clock: Clock;
  protected readonly ownerIds: ReadonlySet<string>;
  protected readonly ownerPrincipal: string;
  protected readonly sendTimeoutMs: number;
  #emit: IngressEmit | null = null;
  #lastIngressAt: number | null = null;
  #lastDeliveryAt: number | null = null;
  #lastError: string | null = null;

  constructor(opts: BaseChannelOptions) {
    if (!opts.id || opts.id.includes(":")) throw new NgError("invalid_argument", `invalid channel id "${opts.id}"`);
    this.id = opts.id;
    this.clock = opts.clock ?? systemClock;
    this.ownerIds = new Set(opts.ownerIds ?? []);
    this.ownerPrincipal = opts.ownerPrincipal ?? OWNER_PRINCIPAL;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  }

  onIngress(emit: IngressEmit): void {
    this.#emit = emit;
  }

  async send(req: ChannelSendRequest): Promise<SendReceipt> {
    const r = await runWithTimeout(
      (signal) => this.deliver({ target: req.target, content: req.content, idempotencyKey: req.idempotencyKey, attempt: 1, signal }),
      this.sendTimeoutMs,
    );
    return r.status;
  }

  async deliver(req: DeliveryRequest): Promise<DeliveryResult> {
    let result: DeliveryResult;
    try {
      result = await this.transmit(req);
    } catch (err) {
      result = { status: "unknown", error: `transport error: ${errorMessage(err)}` };
    }
    if (result.status === "sent") this.#lastDeliveryAt = this.clock.now();
    else this.#lastError = `${result.status}: ${result.error}`;
    return result;
  }

  protected abstract transmit(req: DeliveryRequest): Promise<DeliveryResult>;

  status(): ChannelStatus {
    const s = this.state();
    const out: ChannelStatus = {
      state: s.state,
      lastIngressAt: this.#lastIngressAt,
      lastDeliveryAt: this.#lastDeliveryAt,
      lastError: this.#lastError,
    };
    if (s.detail !== undefined) out.detail = s.detail;
    return out;
  }

  protected state(): { state: ChannelStatus["state"]; detail?: string } {
    return { state: "ready" };
  }

  protected noteError(message: string): void {
    this.#lastError = message;
  }

  /** `owner` for configured owner ids, else `<channelId>:<externalUserId>`. */
  protected principalFor(externalUserId: string): string {
    return this.ownerIds.has(externalUserId) ? this.ownerPrincipal : externalPrincipal(this.id, externalUserId);
  }

  protected addr(target: string): ChannelAddr {
    return channelAddr(this.id, target);
  }

  protected thread(externalThreadId: string): string {
    return threadId(this.id, externalThreadId);
  }

  /** Transport-stable envelope id, namespaced by channel so two channels never collide in the Inbox dedupe key. */
  protected envelopeId(transportId: string): string {
    return `${this.id}:${transportId}`;
  }

  /**
   * Hands the envelope to the hub and resolves only after the kernel has durably enqueued it — HTTP adapters
   * answer 200 after this resolves and non-2xx if it throws, so the sender redelivers.
   */
  protected async emitIngress(raw: Omit<Envelope, "to">): Promise<void> {
    if (!this.#emit) throw new NgError("unsupported", `channel "${this.id}": not registered with a hub`);
    try {
      await this.#emit(raw);
      this.#lastIngressAt = this.clock.now();
    } catch (err) {
      this.#lastError = `ingress: ${errorMessage(err)}`;
      throw err;
    }
  }
}
