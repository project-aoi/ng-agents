import { systemClock, type Clock } from "../clock";
import { newId } from "../ids";

// docs/02 §二 — section 0, verbatim (comments translated). Extensions follow the `[ext]` marker.

// ==================== 0. Unified message envelope and monotonic permission bounds ====================
export type InboxAddr = `inbox:${string}`;
export type ChannelAddr = `channel:${string}:${string}`;
export type Address = InboxAddr | ChannelAddr;
export type ToolKind = "read" | "write" | "edit" | "bash";

export interface Envelope<T = unknown> {
  id: string;                           // transport idempotency id (stays the same across retries)
  from: Address | `timer:${string}` | `kernel:${string}`;
  to?: InboxAddr;                       // may be empty for external ingress; the kernel routes it to the target Cell via the in-flight watches table
  principalId: string;                  // real initiator identity, verified by a trusted Channel or bound by the kernel
  kind: "event" | "result";             // external/internal event | result of an async Job or a child Cell
  type: string;                         // registered payload type (unknown types are quarantined)
  threads?: string[];                   // related external thread ids (group thread / PR / email) — enables watch pass-through that bypasses the desk
  expectedEpoch?: number;               // precondition on the target Cell's epoch (if the Cell was cancelled/reopened and its epoch advanced, a late envelope is dropped)
  delivery?: "wakeup" | "silent_inject";// wake the Cell and run | only inject as background, read on the next wakeup
  producerModel?: string;               // optional id of the model that produced this (lets a parent Cell decide on translation/format post-processing by rule)
  payload: T;
  createdAt: number;
}

export interface PolicyBounds {         // one permission set; deriving a child Cell must strictly satisfy child ⊆ parent
  tools: ReadonlySet<ToolKind>;         // upper bound of authorized workspace tool kinds
  canSendTo: readonly Address[];        // permitted destinations for workbench notifications
  isolation: "none";
  maxConcurrentChildren: number;        // cap on simultaneously active children / child sandboxes (prevents unbounded fan-out)
  maxDepth: number;                     // remaining levels of spawnCell allowed (minus 1 per level; 0 forbids further spawning)
}

// ==================== [ext] ====================

export const TOOL_KINDS = ["read", "write", "edit", "bash"] as const satisfies readonly ToolKind[];

export type IsolationLevel = PolicyBounds["isolation"];
export const ISOLATION_LEVELS = ["none"] as const satisfies readonly IsolationLevel[];

/** Thread ids in `Envelope.threads` are namespaced by channel: `${channelId}:${externalThreadId}` (e.g. `ui:desk`). */
export function threadId(channelId: string, externalThreadId: string): string {
  return `${channelId}:${externalThreadId}`;
}

export type EnvelopeFrom = Envelope["from"];
export type EnvelopeKind = Envelope["kind"];
export type Delivery = NonNullable<Envelope["delivery"]>;

/**
 * What a Loop/preset supplies when it asks the kernel to send an envelope on its behalf
 * (RunPorts.scheduleSelf / emitToParent). The kernel fills id (if absent), from, to, principalId,
 * expectedEpoch and createdAt. Supplying `id` makes the send idempotent across retries.
 */
export interface EnvelopeDraft<T = unknown> {
  id?: string;
  type: string;
  payload: T;
  kind?: EnvelopeKind;          // default "event"
  delivery?: Delivery;          // default "wakeup"
  threads?: string[];
  producerModel?: string;
}

export type EnvelopeInit<T = unknown> = Omit<Envelope<T>, "id" | "createdAt"> & { id?: string; createdAt?: number };

/** Builds a complete envelope, generating `id` (prefix `env`) and `createdAt` from the clock when absent. */
export function createEnvelope<T>(init: EnvelopeInit<T>, clock: Clock = systemClock): Envelope<T> {
  const env: Envelope<T> = {
    id: init.id ?? newId("env", clock),
    from: init.from,
    principalId: init.principalId,
    kind: init.kind,
    type: init.type,
    payload: init.payload,
    createdAt: init.createdAt ?? clock.now(),
  };
  if (init.to !== undefined) env.to = init.to;
  if (init.threads !== undefined) env.threads = init.threads;
  if (init.expectedEpoch !== undefined) env.expectedEpoch = init.expectedEpoch;
  if (init.delivery !== undefined) env.delivery = init.delivery;
  if (init.producerModel !== undefined) env.producerModel = init.producerModel;
  return env;
}
