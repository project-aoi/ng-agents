import { TOOL_KINDS, type Address, type BoundsInit, type ToolKind } from "@ng/protocol";

/**
 * What a root cell (the desk) holds when its creator does not say otherwise. The desk delegates, so it holds the
 * top-level authority (every tool, any channel with Gate approval) while its own processor exposes only read-only
 * tools; isolation "none" is a floor children can raise (workers ask for git_worktree). Budgets are cumulative and
 * must be positive: a zero budget is exhausted from the start (the owner raises them from an escalation card).
 */
export const DEFAULT_ROOT_BOUNDS: Readonly<Required<Omit<BoundsInit, "secretRefs">>> & Pick<BoundsInit, "secretRefs"> = {
  tools: [...TOOL_KINDS],
  canSendTo: ["channel:*", "inbox:*"] as Address[],
  isolation: "none",
  maxConcurrentChildren: 16,
  maxTokens: 20_000_000,
  maxCents: 5_000,
  maxDepth: 3,
};

/** `ProposedAction.custom.name` of the escalation cards the kernel itself raises (dead letters, budget stops). */
export const KERNEL_ESCALATION = "kernel.escalation";
/** Principal recorded on kernel-raised escalation approvals. */
export const KERNEL_ESCALATION_PRINCIPAL = "kernel:escalation";
/** `timer.fired` payload.data.kernel marker of a snoozed card's resurfacing wake-up (handled by the kernel, no Run). */
export const RESURFACE_MARKER = "approval.resurface";

/** Tools that change files or run processes; refused on isolation "none" unless allowHostWrites. */
export const HOST_MUTATING_TOOLS: ReadonlySet<ToolKind> = new Set<ToolKind>(["write", "edit", "bash", "code_rpc"]);

export const DEFAULTS = {
  ownerPrincipal: "owner",
  deskCellId: "desk",
  maxConcurrentRuns: 8,
  leaseMs: 10 * 60_000,
  maxAttempts: 5,
  retryBackoffMs: 5_000,
  maxRetryBackoffMs: 5 * 60_000,
  idleTimeoutMs: 15_000,
} as const;

export function hostWriteRefusal(what: string): string {
  return (
    `${what} is refused: this cell has no isolated workspace (isolation "none" works directly in the owner's real directory). ` +
    `Delegate the change to a worker with an isolated workspace — spawn_cell with preset "worker" ` +
    `(isolation "git_worktree") — and have it report back.`
  );
}
