import type {
  Bus,
  ClaimMode,
  Clock,
  ControlAction,
  ControlAuthorizer,
  Db,
  Inbox,
  ReleaseOptions,
} from "@ng/protocol";

declare module "@ng/protocol" {
  interface BusTopics {
    /**
     * Messages that exceeded the retry limit (release or lease expiry) and became `dead`. The kernel escalates them
     * (e.g. a card on the desk); they are never retried automatically.
     */
    "inbox.dead": { cellId: string; claimId: string; seqs: number[]; envelopeIds: string[]; reason: string };
  }
}

export interface InboxOptions {
  db: Db;
  bus: Bus;
  clock: Clock;
  /** Wire to `Gate.authorizeControlSync`. Default: the owner may control any cell; `cell:<id>` only its strict descendants. */
  authorizeControl?: ControlAuthorizer;
  /** Where `handback` re-enqueues. Default: the `desk` cell if it exists (and is not the caller), else the root of the cell's tree. */
  resolveDesk?: (cellId: string) => string;
  /** Owner principal for the default control authorizer. Default `owner`. */
  ownerPrincipal?: string;
  /** Lease when `claimNextRun` is called without one. Default 10 minutes; long Runs renew with `renewLeaseSync`. */
  defaultLeaseMs?: number;
  /** A message whose claim is released/expired this many times becomes `dead`. Default 5. */
  maxAttempts?: number;
  /** `start()` with a real clock: longest single sleep before re-checking `nextWakeAtSync()`. Default 60 000. */
  maxTimerDelayMs?: number;
  /** Errors thrown by background ticks started with `start()`. Default: console.error. */
  onError?: (err: unknown) => void;
}

export type InboxClaimStatus = "active" | "completed" | "released" | "expired";

export interface InboxClaimRecord {
  claimId: string;
  cellId: string;
  workerId: string;
  mode: ClaimMode;
  epoch: number;
  status: InboxClaimStatus;
  claimedAt: number;
  leaseExpiresAt: number;
  finishedAt: number | null;
  releaseReason: string | null;
}

export interface ReleaseResult {
  requeued: number;
  dead: number;
  cancelled: number;
}

/** Passed synchronously to `onControl` listeners after the control transaction commits. */
export interface ControlEvent {
  cellId: string;
  action: ControlAction;
  principalId: string;
  epoch: number;
  /** Every cell the action changed, target first (cancel/pause/resume act on the subtree), each with its epoch after the change. */
  cells: Array<{ cellId: string; epoch: number }>;
  steerMessage?: string;
  steerEnvelopeId?: string;
}

export type ControlListener = (event: ControlEvent) => void;

/**
 * `countAttempt: false` gives the batch back without counting it as a failed attempt — for Runs stopped on purpose
 * (pause, graceful shutdown), which must never push a message toward the dead-letter limit. Default true.
 */
export interface InboxReleaseOptions extends ReleaseOptions {
  countAttempt?: boolean;
}

export interface InboxService extends Inbox {
  releaseSync(claimId: string, reason: string, opts?: InboxReleaseOptions): ReleaseResult;
  /** Listeners run synchronously after the control transaction commits, before `inbox.control` is emitted. */
  onControl(listener: ControlListener): () => void;
  getClaimSync(claimId: string): InboxClaimRecord | undefined;
  listClaimsSync(filter?: { cellId?: string; status?: readonly InboxClaimStatus[]; limit?: number }): InboxClaimRecord[];
  /**
   * Kernel startup: release every active claim (optionally only one worker's) — their Runs died with the previous
   * process. Counts as a failed attempt. Returns the number of claims released.
   */
  recoverClaimsSync(opts?: { workerId?: string; reason?: string }): number;
}
