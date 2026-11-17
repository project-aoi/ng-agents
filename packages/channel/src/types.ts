import type { Channel, ChannelCapabilities, Deliverable } from "@ng/protocol";

/** What the hub hands an adapter once idempotency, the token check and DND have been applied. */
export interface DeliveryRequest {
  target: string;                       // adapter-level target (after `channel:<id>:`)
  content: Deliverable;
  idempotencyKey: string;
  attempt: number;                      // 1 on the first delivery, +1 per explicit retry
  signal: AbortSignal;                  // aborted when the hub's send timeout fires
}

/**
 * - `sent`: the external system confirmed receipt.
 * - `failed`: definitely not delivered (rejected request, connection refused, bad target) — safe to retry.
 * - `unknown`: may or may not have arrived (timeout, reset after the request left, 5xx) — never retried automatically.
 */
export type DeliveryResult =
  | { status: "sent"; externalId?: string | null }
  | { status: "failed"; error: string }
  | { status: "unknown"; error: string };

export interface EditRequest {
  target: string;
  externalId: string;                   // OutboxRecord.externalId of the message being edited
  content: Deliverable;
  signal: AbortSignal;
}

export interface ChannelStatus {
  state: "ready" | "stopped" | "error";
  detail?: string;
  lastIngressAt: number | null;
  lastDeliveryAt: number | null;
  lastError: string | null;
}

/** One row of the 信源 drawer's channel list. */
export interface ChannelInfo {
  id: string;
  kind: string;
  capabilities: ChannelCapabilities;
  status: ChannelStatus;
}

/**
 * A Channel the hub can drive directly. `deliver` is the raw transport: no DND, no outbox, no token check (the hub
 * applies those uniformly). A plain `Channel` without `deliver` can still be registered; the hub then calls its
 * `send` with `respectDnd: false`.
 */
export interface ChannelAdapter extends Channel {
  readonly kind: string;
  deliver(req: DeliveryRequest): Promise<DeliveryResult>;
  /** Present only when `capabilities.withdrawOrEdit` is true. */
  edit?(req: EditRequest): Promise<DeliveryResult>;
  status(): ChannelStatus;
}

// ==================== framework-neutral HTTP ====================

export interface HttpRequestLike {
  method: string;
  /** Header names in any case; array values (repeated headers) use the first entry. */
  headers: Record<string, string | string[] | undefined>;
  /** The exact bytes received: signatures are computed over them, so never pass a re-serialized body. */
  rawBody: string | Uint8Array;
  query?: Record<string, string | undefined>;
}

export interface HttpResponseLike {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

/** An adapter with an inbound webhook endpoint; the app mounts it at `/hooks/<channelId>`. */
export interface HttpChannelAdapter extends ChannelAdapter {
  handleRequest(req: HttpRequestLike): Promise<HttpResponseLike>;
}

/** The subset of the global `fetch` the adapters use (inject a fake in tests). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Supplies a credential at call time (bearer token, tenant token, signing secret). Wired by the app to the Gate's
 * secret proxy, so adapters never keep long-lived secrets in their config.
 */
export type SecretProvider = () => string | Promise<string>;

export function isChannelAdapter(ch: Channel): ch is ChannelAdapter {
  return typeof (ch as Partial<ChannelAdapter>).deliver === "function";
}

export function isHttpChannel(ch: Channel): ch is HttpChannelAdapter {
  return isChannelAdapter(ch) && typeof (ch as Partial<HttpChannelAdapter>).handleRequest === "function";
}
