import { z } from "zod";
import { registerPayloadType } from "../payloads";
import type { Deliverable } from "./deliverable";
import type { ChannelAddr, Envelope } from "./envelope";

// docs/02 §二 — ① Channel, verbatim (comments translated). Extensions follow the `[ext]` marker.

// ==================== ① Channel: external protocol access, idempotent sends and DND buffering ====================
export interface Channel {
  readonly id: string;
  readonly capabilities: {              // honest declaration of the external channel's limits (e.g. email cannot withdraw, so never promise it)
    idempotentSend: boolean;
    withdrawOrEdit: boolean;
    streamingPreview: boolean;
  };
  onIngress(emit: (raw: Omit<Envelope, "to">) => Promise<void>): void; // verify signature and bind principalId; persist first, then answer 200
  send(req: {
    target: string;
    content: Deliverable;
    idempotencyKey: string;
    actionToken?: string;               // controlled sends must carry a Gate-issued token
    respectDnd?: boolean;               // default true: while the human is in Engage focus, buffer and return buffered_dnd
  }): Promise<"sent" | "buffered_dnd" | "failed" | "unknown">;
  streamPreview?(target: string, chunk: string): Promise<void>;
}

// ==================== [ext] ====================

export type ChannelCapabilities = Channel["capabilities"];
export type ChannelSendRequest = Parameters<Channel["send"]>[0];
/** `unknown` = the external side may or may not have received it; never auto-retried, never shown as success. */
export type SendReceipt = Awaited<ReturnType<Channel["send"]>>;
export type IngressEmit = Parameters<Channel["onIngress"]>[0];
export type OutboxStatus = "pending" | "sent" | "buffered_dnd" | "failed" | "unknown";

/**
 * Send through the hub. Unlike `Channel.send`, `target` is a full ChannelAddr (`channel:<channelId>:<target>`):
 * the hub routes to the adapter, persists the outbox row (idempotent by `idempotencyKey`), applies DND,
 * verifies `actionToken` and records the receipt. Inside `CellPorts.notifyChannel`, `target` is also a ChannelAddr.
 */
export interface HubSendRequest {
  target: ChannelAddr;
  content: Deliverable;
  idempotencyKey: string;
  actionToken?: string;
  respectDnd?: boolean;                 // default true
  urgent?: boolean;                     // urgent sends are never DND-buffered
  cellId?: string;                      // originating cell (audit / UI)
  actionId?: string;                    // approval this send executes, if any
}

export interface OutboxRecord {
  id: string;
  idempotencyKey: string;
  channelId: string;
  target: string;                       // adapter-level target (the part after `channel:<channelId>:`)
  content: Deliverable;
  status: OutboxStatus;
  urgent: boolean;
  /** `failed` because the action token was missing/invalid: the adapter was never called and `retryFailed` refuses it. */
  refused: boolean;
  cellId: string | null;
  actionId: string | null;
  attempts: number;
  error: string | null;
  externalId: string | null;            // message id on the external system (for withdraw/edit when supported)
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

export interface OutboxFilter {
  status?: readonly OutboxStatus[];
  channelId?: string;
  cellId?: string;
  actionId?: string;
  limit?: number;
  order?: "newest" | "oldest";          // default newest first; "oldest" = delivery order
}

/**
 * Checks an action token presented with a send. Injected into the hub by the kernel (wired to
 * `Gate.verifyTokenSync` with a `channel.send` action built from target + content), so @ng/channel never
 * depends on @ng/gate. Tokens are single-use: a successful check consumes it.
 */
export type ActionTokenVerifier = (
  token: string,
  req: { target: ChannelAddr; content: Deliverable },
) => { ok: true } | { ok: false; reason: string };

/**
 * The one object the kernel and the app talk to; owns the `outbox` and `channel_state` tables.
 *
 * Semantics:
 * - `send` with an `idempotencyKey` that already exists returns the stored status without calling the adapter
 *   (a stored `pending` — i.e. a crash mid-send — is reported as `unknown`).
 * - While focus (DND) is on, a non-urgent send with `respectDnd !== false` is stored as `buffered_dnd` and
 *   returns `buffered_dnd`; `setFocusSync(false)` does not send by itself — call `flushBuffered()`.
 * - Internal Cell-to-Cell traffic never passes through here (it goes through the Inbox), so DND never blocks it.
 * - DND holds back notifications aimed at the owner. A send the owner just approved on a card (kernel.resolveApproval)
 *   should pass `respectDnd: false` so the card gets a real `sent | failed | unknown` receipt.
 * - A request carrying `actionToken` is checked with the injected ActionTokenVerifier (refused → `failed`, nothing
 *   sent). A request without one is trusted: only in-process kernel/app code holds the hub, and the kernel's
 *   `notifyChannel` port refuses Loop sends that lack a token.
 */
export interface ChannelHub {
  register(channel: Channel): void;
  get(channelId: string): Channel | undefined;
  list(): Channel[];
  /** Wires every registered (and later registered) channel's ingress to the kernel's router. */
  onIngress(sink: (raw: Omit<Envelope, "to">, channelId: string) => Promise<void>): void;
  send(req: HubSendRequest): Promise<SendReceipt>;
  streamPreview(target: ChannelAddr, chunk: string): Promise<void>;
  /** Retry a `failed` send explicitly (never `unknown`). */
  retryFailed(idempotencyKey: string): Promise<SendReceipt>;
  flushBuffered(): Promise<{ sent: number; failed: number; unknown: number }>;

  setFocusSync(on: boolean): void;
  isFocusSync(): boolean;
  bufferedCountSync(): number;
  listOutboxSync(filter?: OutboxFilter): OutboxRecord[];
  getOutboxSync(idempotencyKey: string): OutboxRecord | undefined;
  /** [ext] Latest outbox row linked to an approval `actionId` (handles `:retry:` keys cleanly). */
  getLatestOutboxByActionSync(actionId: string): OutboxRecord | undefined;
}

// ==================== [ext] ingress payload for non-conversational external events ====================

/** Envelope type for external events that are not something a person said (PR opened, CI finished, generic webhook). */
export const CHANNEL_EVENT_TYPE = "channel.event";

/**
 * Payload of `channel.event`. Human-authored text (a comment, a chat message, a review body) arrives as
 * `user.message` instead; this type is for state changes a watcher reacts to (e.g. `check_suite` `completed`).
 */
export interface ChannelEventPayload {
  channelId: string;
  event: string;                        // provider event name: "pull_request", "check_suite", "workflow_run", "webhook", ...
  action?: string;                      // provider sub-action: "opened", "completed", ...
  summary: string;                      // one human-readable line
  url?: string;
  replyTo?: ChannelAddr;
  sender?: { id: string; displayName?: string };
  data?: unknown;                       // trimmed provider-specific fields (never the full raw payload)
}

export const channelEventPayloadSchema = z.looseObject({
  channelId: z.string(),
  event: z.string(),
  action: z.string().optional(),
  summary: z.string(),
  url: z.string().optional(),
  replyTo: z.string().startsWith("channel:").optional(),
  sender: z.looseObject({ id: z.string(), displayName: z.string().optional() }).optional(),
  data: z.unknown().optional(),
});

registerPayloadType(CHANNEL_EVENT_TYPE, channelEventPayloadSchema);

declare module "../bus" {
  interface BusTopics {
    /** A streaming-preview chunk for an in-process surface (the workbench UI forwards it over SSE). */
    "channel.preview": { channelId: string; target: string; chunk: string };
  }
}
