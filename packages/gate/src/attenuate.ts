import {
  ISOLATION_LEVELS,
  ISOLATION_RANK,
  NgError,
  TOOL_KINDS,
  addressCovers,
  boundsViolations,
  inboxAddr,
  parseAddress,
  type Address,
  type IsolationLevel,
  type PolicyBounds,
  type ToolKind,
} from "@ng/protocol";

// Every value that reaches cells.bounds must survive serializeBounds → deserializeBounds (finite, non-negative,
// valid enum members and address patterns); otherwise the stored cell row could no longer be read back.
const MAX_LIMIT = Number.MAX_SAFE_INTEGER;
const STRONGEST_ISOLATION: IsolationLevel = "cow_microvm";

export interface AttenuateOptions {
  /**
   * What the parent cell and every ancestor above it still have left in the ledger (effective limit − subtree usage,
   * minimum over the chain). Caps the child's maxTokens / maxCents.
   */
  remaining?: { tokens: number; cents: number };
}

/** Same rule as the protocol's serialized-bounds schema: `inbox:`/`channel:` prefix wildcard, or a parseable address. */
export function isAddressPattern(value: unknown): value is Address {
  if (typeof value !== "string") return false;
  return value.endsWith("*") ? /^(inbox:|channel:)/.test(value) : parseAddress(value) !== null;
}

function isToolKind(value: unknown): value is ToolKind {
  return typeof value === "string" && (TOOL_KINDS as readonly string[]).includes(value);
}

function isIsolation(value: unknown): value is IsolationLevel {
  return typeof value === "string" && (ISOLATION_LEVELS as readonly string[]).includes(value);
}

/**
 * undefined → null (field omitted). Arrays and Sets → their string members. Anything else (e.g. a Set that went
 * through JSON and became `{}`) → [] so a malformed request narrows instead of falling back to the generous default.
 */
function stringList(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (Array.isArray(value) || value instanceof Set) return [...value].filter((v): v is string => typeof v === "string" && v.length > 0);
  return [];
}

function members(value: unknown): string[] {
  return stringList(value) ?? [];
}

function nonNegInt(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  if (value >= MAX_LIMIT) return MAX_LIMIT;
  return Math.max(0, Math.floor(value));
}

function nonNegNum(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  if (value >= MAX_LIMIT) return MAX_LIMIT;
  return Math.max(0, value);
}

function stronger(a: IsolationLevel, b: IsolationLevel): IsolationLevel {
  return ISOLATION_RANK[a] >= ISOLATION_RANK[b] ? a : b;
}

/**
 * Exact intersection of two address-pattern languages: for each pair, the narrower of the two when one covers the
 * other (an exact address, or the wildcard with the longer prefix); disjoint pairs contribute nothing.
 */
export function intersectPatterns(requested: readonly string[], allowed: readonly string[]): Address[] {
  const out = new Set<string>();
  for (const r of requested) {
    if (!isAddressPattern(r)) continue;
    for (const p of allowed) {
      if (!isAddressPattern(p)) continue;
      if (addressCovers(p, r)) out.add(r);
      else if (addressCovers(r, p)) out.add(p);
    }
  }
  return minimizePatterns([...out] as Address[]);
}

/** Drops entries covered by another entry; sorted for stable storage. */
export function minimizePatterns(patterns: readonly Address[]): Address[] {
  const uniq = [...new Set(patterns)];
  return uniq.filter((x) => !uniq.some((y) => y !== x && addressCovers(y, x))).sort();
}

/** Greatest lower bound of two bounds of the same cell (nothing is decremented). */
export function meetBounds(a: PolicyBounds, b: PolicyBounds): PolicyBounds {
  const bTools = new Set(members(b.tools));
  const bSecrets = new Set(members(b.secretRefs));
  const isoA = isIsolation(a.isolation) ? a.isolation : STRONGEST_ISOLATION;
  const isoB = isIsolation(b.isolation) ? b.isolation : STRONGEST_ISOLATION;
  return {
    tools: new Set(members(a.tools).filter((t): t is ToolKind => isToolKind(t) && bTools.has(t))),
    canSendTo: intersectPatterns(members(a.canSendTo), members(b.canSendTo)),
    secretRefs: new Set(members(a.secretRefs).filter((s) => bSecrets.has(s))),
    isolation: stronger(isoA, isoB),
    maxConcurrentChildren: Math.min(nonNegInt(a.maxConcurrentChildren), nonNegInt(b.maxConcurrentChildren)),
    maxTokens: Math.min(nonNegInt(a.maxTokens), nonNegInt(b.maxTokens)),
    maxCents: Math.min(nonNegNum(a.maxCents), nonNegNum(b.maxCents)),
    maxDepth: Math.min(nonNegInt(a.maxDepth), nonNegInt(b.maxDepth)),
  };
}

/**
 * Derives a child's bounds from its parent's. Never widens; clamps a too-wide or malformed request instead of failing.
 * See the `[ext] attenuate semantics` comment on the Gate contract for the field-by-field rules.
 * Throws NgError("bounds_violation") when the parent has no spawn depth left (maxDepth < 1).
 */
export function attenuateBounds(
  parent: PolicyBounds,
  parentCellId: string,
  requested?: Partial<PolicyBounds> | null,
  opts: AttenuateOptions = {},
): PolicyBounds {
  const parentDepth = typeof parent.maxDepth === "number" && Number.isFinite(parent.maxDepth) ? Math.floor(parent.maxDepth) : 0;
  if (parentDepth < 1) {
    throw new NgError("bounds_violation", `cell "${parentCellId}" has maxDepth ${String(parent.maxDepth)}: it may not spawn children`);
  }
  const req: Partial<PolicyBounds> = requested !== null && typeof requested === "object" ? requested : {};

  const parentTools = members(parent.tools).filter(isToolKind);
  const reqTools = stringList(req.tools);
  const tools = reqTools === null ? parentTools : parentTools.filter((t) => reqTools.includes(t));

  const parentInbox: Address | null = parentCellId && isAddressPattern(`inbox:${parentCellId}`) ? inboxAddr(parentCellId) : null;
  const parentSendable = members(parent.canSendTo).filter(isAddressPattern);
  const sendable = [...parentSendable, ...(parentInbox ? [parentInbox] : [])];
  const reqSend = stringList(req.canSendTo);
  // Internal messaging is free inside the tree: every `inbox:` pattern the parent holds is inherited, requested or not
  // (so, transitively, every ancestor's inbox, e.g. `inbox:desk` for arbitration). `channel:` only on request.
  const canSendTo = minimizePatterns([
    ...(reqSend === null ? [] : intersectPatterns(reqSend, sendable)),
    ...parentSendable.filter((p) => p.startsWith("inbox:")),
    ...(parentInbox ? [parentInbox] : []),
  ]);

  const parentSecrets = members(parent.secretRefs);
  const reqSecrets = stringList(req.secretRefs);
  const secretRefs = reqSecrets === null ? [] : parentSecrets.filter((s) => reqSecrets.includes(s));

  const parentIso = isIsolation(parent.isolation) ? parent.isolation : STRONGEST_ISOLATION;
  const isolation =
    req.isolation === undefined ? parentIso : stronger(parentIso, isIsolation(req.isolation) ? req.isolation : STRONGEST_ISOLATION);

  const clampInt = (value: unknown, cap: number) => (value === undefined ? cap : Math.min(nonNegInt(value), cap));
  const clampNum = (value: unknown, cap: number) => (value === undefined ? cap : Math.min(nonNegNum(value), cap));
  const remTokens = opts.remaining ? nonNegInt(opts.remaining.tokens) : MAX_LIMIT;
  const remCents = opts.remaining ? nonNegNum(opts.remaining.cents) : MAX_LIMIT;

  const result: PolicyBounds = {
    tools: new Set(tools),
    canSendTo,
    secretRefs: new Set(secretRefs),
    isolation,
    maxConcurrentChildren: clampInt(req.maxConcurrentChildren, nonNegInt(parent.maxConcurrentChildren)),
    maxTokens: clampInt(req.maxTokens, Math.min(nonNegInt(parent.maxTokens), remTokens)),
    maxCents: clampNum(req.maxCents, Math.min(nonNegNum(parent.maxCents), remCents)),
    maxDepth: clampInt(req.maxDepth, parentDepth - 1),
  };

  // Defense in depth: the construction above is meant to make this unreachable.
  const violations = boundsViolations(result, parent, parentInbox ? { parentCellId } : {});
  if (violations.length > 0) {
    throw new NgError("bounds_violation", `attenuate produced bounds wider than the parent: ${violations.join("; ")}`);
  }
  return result;
}
