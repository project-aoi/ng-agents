import {
  TOOL_KINDS,
  actionTargetOf,
  addressCovers,
  anyCovers,
  deliverableSchema,
  parseAddress,
  type PolicyBounds,
  type PolicyRule,
  type PolicyRuleInput,
  type ProposedAction,
  type ProposedActionType,
  type SideEffect,
  type ToolKind,
} from "@ng/protocol";

// Pure decision helpers. Everything here is a function of the request plus state the caller read from the database.

export const ACTION_TYPES = [
  "channel.send",
  "workspace.exec",
  "job.start",
  "cell.spawn",
  "cell.control",
  "secret.use",
  "project.start",
  "custom",
] as const satisfies readonly ProposedActionType[];

export const SIDE_EFFECTS = ["none", "internal", "notify_owner", "external"] as const satisfies readonly SideEffect[];
const SIDE_EFFECT_RANK: Readonly<Record<SideEffect, number>> = { none: 0, internal: 1, notify_owner: 2, external: 3 };
const CONTROL_ACTIONS = ["cancel", "pause", "resume", "steer"] as const;
const MUTATING_TOOLS: ReadonlySet<ToolKind> = new Set(["write", "edit", "bash", "code_rpc"]);
const SHARED_RO_REJECTS: ReadonlySet<ToolKind> = new Set(["write", "edit", "bash"]);

export function maxSideEffect(a: SideEffect, b: SideEffect): SideEffect {
  return SIDE_EFFECT_RANK[a] >= SIDE_EFFECT_RANK[b] ? a : b;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Shape check of the common fields; returns model-facing feedback, or null when well-formed. */
export function actionShapeFeedback(action: unknown): string | null {
  if (!isObject(action)) return "invalid action: expected an object";
  if (!(ACTION_TYPES as readonly unknown[]).includes(action["type"])) return `invalid action: unknown type ${JSON.stringify(action["type"])}`;
  if (typeof action["summary"] !== "string") return "invalid action: summary must be a string";
  if (!isNonEmptyString(action["subjectKey"])) return "invalid action: subjectKey must be a non-empty string (the item this action belongs to)";
  if (!(SIDE_EFFECTS as readonly unknown[]).includes(action["sideEffect"])) {
    return `invalid action: sideEffect must be one of ${SIDE_EFFECTS.join(", ")}`;
  }
  if (action["artifactId"] !== undefined && !isNonEmptyString(action["artifactId"])) return "invalid action: artifactId must be a non-empty string";
  if (action["urgent"] !== undefined && typeof action["urgent"] !== "boolean") return "invalid action: urgent must be a boolean";
  return null;
}

/**
 * The side effect the Gate attributes to an action regardless of what the caller declared; the effective side effect
 * is the max of the two, so a mislabelled action can only become stricter.
 * `_bounds` is kept for signature stability: no derived side effect depends on the cell's isolation any more.
 */
export function derivedSideEffect(action: ProposedAction, _bounds: PolicyBounds, ownerAddresses: readonly string[]): SideEffect {
  switch (action.type) {
    case "channel.send":
      return anyCovers(ownerAddresses, action.target) ? "notify_owner" : "external";
    case "workspace.exec":
      // docs/05: host work in the owner's real directories (isolation "none", the default) is guarded by cwdMode, the
      // dispatcher's per-directory write queue and the prompts' red lines, not by a card per command.
      return MUTATING_TOOLS.has(action.tool) ? "internal" : "none";
    case "job.start":
      return "internal";
    case "project.start":
      // docs/04 card B: a project only starts after the human confirms the proposal.
      return "external";
    case "cell.spawn":
    case "cell.control":
    case "secret.use":
      return "internal";
    case "custom":
      return "none";
  }
}

export function effectiveSideEffect(action: ProposedAction, bounds: PolicyBounds, ownerAddresses: readonly string[]): SideEffect {
  return maxSideEffect(action.sideEffect, derivedSideEffect(action, bounds, ownerAddresses));
}

// `custom` names of budget-exhausted escalation cards: the Loop's request_approval, and the kernel's own card
// (packages/cell constants KERNEL_ESCALATION, with `args.reason`).
const BUDGET_EXHAUSTED = "budget_exhausted";
const LOOP_BUDGET_ESCALATION = `escalation.${BUDGET_EXHAUSTED}`;
const KERNEL_ESCALATION = "kernel.escalation";

function isBudgetEscalation(action: ProposedAction): boolean {
  // Same precedence as the kernel's escalation handling: the card's own escalation reason first, then the action.
  const data = isObject(action.card) ? action.card["data"] : undefined;
  if (isObject(data) && data["cardType"] === "escalation" && isObject(data["escalation"]) && data["escalation"]["reason"] === BUDGET_EXHAUSTED) {
    return true;
  }
  if (action.type !== "custom") return false;
  if (action.name === LOOP_BUDGET_ESCALATION) return true;
  return action.name === KERNEL_ESCALATION && isObject(action.args) && action.args["reason"] === BUDGET_EXHAUSTED;
}

/**
 * Why approving `action` is the owner's decision alone, or null when an external main agent (`agent:*`) may approve it
 * too (docs/05 guard 3): a send that leaves the owner's own channels, and continuing past an exhausted budget.
 * Everything else (project proposals, custom actions, blocked / retry_limit / waiting_timeout escalations) an agent may
 * approve; denying or snoozing is never owner-only. Pass the card too (`{ ...record.action, card: record.card }`):
 * a budget escalation may be recognisable only by its card.
 */
export function ownerOnlyApproval(action: ProposedAction, ownerAddresses: readonly string[]): string | null {
  if (action.type === "channel.send") {
    const target: unknown = action.target;
    if (typeof target !== "string" || !anyCovers(ownerAddresses, target)) {
      return `it sends to ${String(target)}, outside the owner's own channels`;
    }
  }
  if (isBudgetEscalation(action)) return "it continues past an exhausted budget";
  return null;
}

export interface BoundsContext {
  cellId: string;
  bounds: PolicyBounds;
  /** Direct children that are not closed (spawn concurrency). */
  openChildren: number;
  isStrictDescendant(cellId: string): boolean;
  secretConfigured(ref: string): boolean;
}

/** Type-specific shape + bounds check. Returns model-facing feedback, or null when the action is within bounds. */
export function boundsFeedback(action: ProposedAction, ctx: BoundsContext): string | null {
  const b = ctx.bounds;
  const tools = [...b.tools].sort().join(", ") || "none";
  switch (action.type) {
    case "channel.send": {
      const parsed = typeof action.target === "string" ? parseAddress(action.target) : null;
      if (!parsed || parsed.kind !== "channel" || action.target.endsWith("*")) {
        return `channel.send target must be a channel address "channel:<channelId>:<target>", got ${JSON.stringify(action.target)}`;
      }
      if (!anyCovers(b.canSendTo, action.target)) {
        return `this cell may not send to ${action.target} (allowed: ${b.canSendTo.join(", ") || "none"}); report to your parent instead`;
      }
      if (action.content !== undefined && !deliverableSchema.safeParse(action.content).success) {
        return "channel.send content must be a Deliverable {format, body, ...}";
      }
      return null;
    }
    case "workspace.exec": {
      if (!(TOOL_KINDS as readonly unknown[]).includes(action.tool)) return `unknown tool ${JSON.stringify(action.tool)}`;
      if (!b.tools.has(action.tool)) return `tool "${action.tool}" is outside this cell's bounds (allowed: ${tools})`;
      if (b.isolation === "shared_ro" && SHARED_RO_REJECTS.has(action.tool)) {
        return `tool "${action.tool}" is not available in a read-only workspace`;
      }
      return null;
    }
    case "job.start": {
      if (!isNonEmptyString(action.command)) return "job.start command must be a non-empty string";
      if (!b.tools.has("bash")) return `starting jobs needs the "bash" tool, which is outside this cell's bounds (allowed: ${tools})`;
      if (b.isolation === "shared_ro") return "jobs cannot run in a read-only workspace";
      return null;
    }
    case "cell.spawn": {
      if (!isObject(action.spec)) return "cell.spawn spec must be an object";
      if (action.spec.parentId !== undefined && action.spec.parentId !== ctx.cellId) {
        return "cell.spawn may only create children of the requesting cell";
      }
      if (b.maxDepth < 1) return "this cell may not spawn children (maxDepth 0); do the work yourself or report to your parent";
      if (ctx.openChildren >= b.maxConcurrentChildren) {
        return `this cell already has ${ctx.openChildren} open children (max ${b.maxConcurrentChildren}); wait for one to finish or close one`;
      }
      return null;
    }
    case "cell.control": {
      if (!isNonEmptyString(action.targetCellId)) return "cell.control targetCellId must be a non-empty string";
      if (!(CONTROL_ACTIONS as readonly unknown[]).includes(action.action)) return `unknown control action ${JSON.stringify(action.action)}`;
      if (!ctx.isStrictDescendant(action.targetCellId)) return `cell "${action.targetCellId}" is not a descendant of this cell`;
      return null;
    }
    case "secret.use": {
      if (!isNonEmptyString(action.secretRef)) return "secret.use secretRef must be a non-empty string";
      if (!b.secretRefs.has(action.secretRef)) return `secret "${action.secretRef}" is outside this cell's bounds`;
      if (action.tool !== undefined && !b.tools.has(action.tool)) return `tool "${String(action.tool)}" is outside this cell's bounds (allowed: ${tools})`;
      if (!ctx.secretConfigured(action.secretRef)) return `secret "${action.secretRef}" is not configured on the host; ask the owner to configure it`;
      return null;
    }
    case "project.start": {
      if (!isObject(action.proposal) || !isNonEmptyString(action.proposal.title)) return "project.start proposal must have a title";
      return null;
    }
    case "custom": {
      if (!isNonEmptyString(action.name)) return "custom action name must be a non-empty string";
      return null;
    }
  }
}

// ==================== policy rules ====================

/** `chain` = [cellId, parentId, …, rootId]. */
export function ruleApplies(rule: PolicyRule, action: ProposedAction, chain: readonly string[]): boolean {
  if (!rule.enabled) return false;
  if (rule.match.type !== "*" && rule.match.type !== action.type) return false;
  if (rule.scopeCellId !== null && !chain.includes(rule.scopeCellId)) return false;
  if (rule.match.target !== undefined && rule.match.target !== null) {
    const target = actionTargetOf(action);
    if (target === null || !addressCovers(rule.match.target, target)) return false;
  }
  if (rule.effect === "allow" && rule.maxUses !== null && rule.uses >= rule.maxUses) return false;
  return true;
}

const EFFECT_RANK: Readonly<Record<PolicyRule["effect"], number>> = { allow: 0, defer: 1, deny: 2 };

/** Higher sorts first: nearer scope, exact type, exact/longer target, then the stricter effect. */
export function ruleSpecificity(rule: PolicyRule, chain: readonly string[]): number[] {
  const scope = rule.scopeCellId === null ? 0 : chain.length - chain.indexOf(rule.scopeCellId);
  const target = rule.match.target ?? null;
  const targetKind = target === null ? 0 : target.endsWith("*") ? 1 : 2;
  return [scope, rule.match.type === "*" ? 0 : 1, targetKind, target === null ? 0 : target.length, EFFECT_RANK[rule.effect]];
}

export function pickRule(rules: readonly PolicyRule[], action: ProposedAction, chain: readonly string[]): PolicyRule | undefined {
  const candidates = rules.filter((r) => ruleApplies(r, action, chain));
  candidates.sort((a, b) => {
    const sa = ruleSpecificity(a, chain);
    const sb = ruleSpecificity(b, chain);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i]! - sa[i]!;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return candidates[0];
}

/** Splits `actionClassOf` output: `channel.send|channel:feishu:*` → type + target pattern. */
export function parseActionClass(actionClass: string): { type: string; target: string | null } {
  const i = actionClass.indexOf("|");
  return i < 0 ? { type: actionClass, target: null } : { type: actionClass.slice(0, i), target: actionClass.slice(i + 1) };
}

/**
 * The auto-allow rule the weekly review offers for a trust candidate ("改成有预算上限的自动执行"): global scope,
 * capped at `maxUses` (default 20). Null when the class cannot be expressed as a rule target without widening it
 * (cell.control classes are keyed by verb, rule targets by cell id).
 */
export function ruleInputForClass(
  actionClass: string,
  opts: { createdBy: string; maxUses?: number | null; note?: string },
): PolicyRuleInput | null {
  const { type, target } = parseActionClass(actionClass);
  if (!(ACTION_TYPES as readonly string[]).includes(type) || type === "cell.control") return null;
  const match: PolicyRuleInput["match"] = { type: type as ProposedActionType };
  if (target !== null) match.target = target;
  return { match, effect: "allow", createdBy: opts.createdBy, maxUses: opts.maxUses === undefined ? 20 : opts.maxUses, note: opts.note ?? null };
}

/**
 * Whether a cell with `bounds` (child of `parentCellId`) may deliver to `addr` — for the kernel's inboxOut /
 * emitToParent / notifyChannel checks. The parent's own inbox is always reachable (a child can always report back);
 * other inboxes (e.g. `inbox:desk` for arbitration) through the `inbox:` patterns attenuate passes down the tree.
 */
export function deliveryAllowed(bounds: Pick<PolicyBounds, "canSendTo">, parentCellId: string | null, addr: string): boolean {
  if (typeof addr !== "string" || addr.endsWith("*") || parseAddress(addr) === null) return false;
  if (parentCellId && addr === `inbox:${parentCellId}`) return true;
  return anyCovers(bounds.canSendTo, addr);
}
