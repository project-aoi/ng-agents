import { z } from "zod";
import { addressCovers, parseAddress } from "./address";
import { NgError } from "./errors";
import {
  ISOLATION_LEVELS,
  TOOL_KINDS,
  type Address,
  type IsolationLevel,
  type PolicyBounds,
  type ToolKind,
} from "./contract/envelope";

/**
 * Isolation is a floor: a child may run at the parent's level or a stronger one, never weaker.
 * none (host) < shared_ro (read-only view of the shared tree) < git_worktree < container < cow_microvm.
 */
export const ISOLATION_RANK: Readonly<Record<IsolationLevel, number>> = {
  none: 0,
  shared_ro: 1,
  git_worktree: 2,
  container: 3,
  cow_microvm: 4,
};

/** JSON form of PolicyBounds (what `cells.bounds` stores). Arrays are sorted for stable output. */
export interface SerializedBounds {
  tools: ToolKind[];
  canSendTo: Address[];
  secretRefs: string[];
  isolation: IsolationLevel;
  maxConcurrentChildren: number;
  maxTokens: number;
  maxCents: number;
  maxDepth: number;
}

const addressPattern = z.string().refine((s) => (s.endsWith("*") ? /^(inbox:|channel:)/.test(s) : parseAddress(s) !== null), {
  message: "not an address or address pattern",
});

export const serializedBoundsSchema = z.object({
  tools: z.array(z.enum(TOOL_KINDS)),
  canSendTo: z.array(addressPattern),
  secretRefs: z.array(z.string().min(1)),
  isolation: z.enum(ISOLATION_LEVELS),
  maxConcurrentChildren: z.number().int().min(0),
  maxTokens: z.number().int().min(0),
  maxCents: z.number().min(0),
  maxDepth: z.number().int().min(0),
});

export function serializeBounds(b: PolicyBounds): SerializedBounds {
  return {
    tools: [...b.tools].sort(),
    canSendTo: [...new Set(b.canSendTo)].sort(),
    secretRefs: [...b.secretRefs].sort(),
    isolation: b.isolation,
    maxConcurrentChildren: b.maxConcurrentChildren,
    maxTokens: b.maxTokens,
    maxCents: b.maxCents,
    maxDepth: b.maxDepth,
  };
}

/** Accepts a JSON string or an already-parsed object; throws NgError("invalid_argument") on malformed input. */
export function deserializeBounds(input: string | unknown): PolicyBounds {
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  const parsed = serializedBoundsSchema.safeParse(raw);
  if (!parsed.success) throw new NgError("invalid_argument", `invalid PolicyBounds: ${z.prettifyError(parsed.error)}`);
  const s = parsed.data;
  return {
    tools: new Set(s.tools),
    canSendTo: s.canSendTo as Address[],
    secretRefs: new Set(s.secretRefs),
    isolation: s.isolation,
    maxConcurrentChildren: s.maxConcurrentChildren,
    maxTokens: s.maxTokens,
    maxCents: s.maxCents,
    maxDepth: s.maxDepth,
  };
}

export interface BoundsInit {
  tools?: Iterable<ToolKind>;
  canSendTo?: readonly Address[];
  secretRefs?: Iterable<string>;
  isolation?: IsolationLevel;
  maxConcurrentChildren?: number;
  maxTokens?: number;
  maxCents?: number;
  maxDepth?: number;
}

/** Builds bounds from a partial description; every omitted field takes its most restrictive value (isolation "none"). */
export function makeBounds(init: BoundsInit = {}): PolicyBounds {
  return deserializeBounds({
    tools: [...(init.tools ?? [])],
    canSendTo: [...(init.canSendTo ?? [])],
    secretRefs: [...(init.secretRefs ?? [])],
    isolation: init.isolation ?? "none",
    maxConcurrentChildren: init.maxConcurrentChildren ?? 0,
    maxTokens: init.maxTokens ?? 0,
    maxCents: init.maxCents ?? 0,
    maxDepth: init.maxDepth ?? 0,
  });
}

export function emptyBounds(): PolicyBounds {
  return makeBounds();
}

export interface SubsetOptions {
  /**
   * The parent's own inbox `inbox:<parentCellId>` is always allowed in the child's canSendTo: the parent owns that
   * inbox, so letting a child report back never widens authority (this is how a worker's default
   * `canSendTo: [inbox:<parent>]` stays ⊆ even when the parent cannot itself send to its own inbox).
   */
  parentCellId?: string;
  /**
   * "child" (default): a derived child — requires child.maxDepth ≤ parent.maxDepth − 1 (so a parent with maxDepth 0
   * has no valid child). "narrowing": the same cell's bounds being tightened — requires child.maxDepth ≤ parent.maxDepth.
   */
  relation?: "child" | "narrowing";
}

/** Human-readable reasons why `child ⊄ parent`; empty array means child ⊆ parent. */
export function boundsViolations(child: PolicyBounds, parent: PolicyBounds, opts: SubsetOptions = {}): string[] {
  const out: string[] = [];
  for (const t of child.tools) if (!parent.tools.has(t)) out.push(`tool "${t}" not in parent`);
  const parentInbox = opts.parentCellId ? `inbox:${opts.parentCellId}` : null;
  for (const a of child.canSendTo) {
    if (a === parentInbox) continue;
    if (!parent.canSendTo.some((p) => addressCovers(p, a))) out.push(`canSendTo "${a}" not covered by parent`);
  }
  for (const s of child.secretRefs) if (!parent.secretRefs.has(s)) out.push(`secretRef "${s}" not in parent`);
  if (ISOLATION_RANK[child.isolation] < ISOLATION_RANK[parent.isolation]) {
    out.push(`isolation "${child.isolation}" weaker than parent "${parent.isolation}"`);
  }
  if (child.maxConcurrentChildren > parent.maxConcurrentChildren) out.push("maxConcurrentChildren exceeds parent");
  if (child.maxTokens > parent.maxTokens) out.push("maxTokens exceeds parent");
  if (child.maxCents > parent.maxCents) out.push("maxCents exceeds parent");
  const depthCap = (opts.relation ?? "child") === "child" ? parent.maxDepth - 1 : parent.maxDepth;
  if (child.maxDepth > depthCap) out.push(`maxDepth ${child.maxDepth} exceeds ${depthCap}`);
  return out;
}

/** Pure `child ⊆ parent` check used by Gate.attenuate and by tests everywhere. */
export function isSubsetBounds(child: PolicyBounds, parent: PolicyBounds, opts: SubsetOptions = {}): boolean {
  return boundsViolations(child, parent, opts).length === 0;
}

/** Compact English summary embedded in the frozen system prefix. */
export function describeBounds(b: PolicyBounds): string {
  const list = (xs: Iterable<string>) => {
    const a = [...xs].sort();
    return a.length ? a.join(", ") : "none";
  };
  return [
    `Tools: ${list(b.tools)}.`,
    `May send to: ${list(b.canSendTo)}.`,
    `Secrets (injected by proxy, never visible): ${list(b.secretRefs)}.`,
    `Isolation: ${b.isolation}.`,
    `Children: up to ${b.maxConcurrentChildren} concurrent, ${b.maxDepth} more level(s) of spawning.`,
    `Budget (shared with subtree): ${b.maxTokens} tokens, ${b.maxCents} cents.`,
  ].join("\n");
}
