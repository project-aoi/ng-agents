import { TOOL_KINDS, type Address, type BoundsInit } from "@ng/protocol";

/**
 * What a root cell (the desk) holds when its creator does not say otherwise. The desk delegates, so it holds the
 * top-level authority over its tools and delivery addresses.
 * maxConcurrentChildren counts leaf children that are at work only, so parked projects and dormant workers never fill it.
 */
export const DEFAULT_ROOT_BOUNDS: Readonly<Required<BoundsInit>> = {
  tools: [...TOOL_KINDS],
  canSendTo: ["channel:*", "inbox:*"] as Address[],
  maxConcurrentChildren: 16,
  maxDepth: 4,
};

/** `ProposedAction.custom.name` of the escalation cards the kernel itself raises (dead letters). */
export const KERNEL_ESCALATION = "kernel.escalation";
/** Principal recorded on kernel-raised escalation approvals. */
export const KERNEL_ESCALATION_PRINCIPAL = "kernel:escalation";
/** `timer.fired` payload.data.kernel marker of a snoozed card's resurfacing wake-up (handled by the kernel, no Run). */
export const RESURFACE_MARKER = "approval.resurface";

/** The record a cell keeps when the close or park it asked for was not carried out: what was asked, and what stood in the way. */
export function notCarriedOut(action: "complete" | "cancel" | "pause", because: string): string {
  return `[${action === "pause" ? "parking" : action === "cancel" ? "cancelling" : "closing"} this cell was not carried out: ${because}]`;
}
export const NOT_CARRIED_OUT = /^\[(?:closing|cancelling|parking) this cell was not carried out: /;
export const MESSAGE_ARRIVED = "a message arrived before the turn settled";

export const DEFAULTS = {
  ownerPrincipal: "owner",
  deskCellId: "desk",
  maxConcurrentRuns: 8,
  leaseMs: 10 * 60_000,
  maxAttempts: 5,
  retryBackoffMs: 5_000,
  maxRetryBackoffMs: 5 * 60_000,
  idleTimeoutMs: 15_000,
  /** docs/05 guard 1: consecutive step-limit continuations before the owner is asked. */
  maxStepContinuations: 3,
  /** docs/05 guard 2: how long a project may sit without any anchor before its single stalled_check goes out. */
  stallGraceMs: 2_000,
} as const;

