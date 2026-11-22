import {
  CLI_ENGINES,

  NgError,
  sha256Hex,
  stableStringify,
  type CellRecord,
  type CellSpec,
  type PolicyBounds,
  type Registry,
  type ScheduleRule,
} from "@ng/protocol";
import type { CellSpecInput } from "./types";
import { normalizeCwd } from "./workdir";

/** A spec with the preset's defaults applied, plus the bounds request to hand to Gate.attenuate. */
export interface ResolvedSpec {
  spec: CellSpec;
  boundsRequest: Partial<PolicyBounds> | undefined;
}

function definedEntries<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** JSON keeps Sets as `{}`; the stored spec keeps the bounds request readable (and attenuate accepts arrays). */
export function jsonSafeBounds(b: Partial<PolicyBounds> | undefined): Partial<PolicyBounds> | undefined {
  if (!b || typeof b !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    out[k] = v instanceof Set ? [...v].sort() : v;
  }
  return out as Partial<PolicyBounds>;
}

/**
 * Preset defaults merged under the caller's spec: caller wins field by field, `processor` is replaced as a whole,
 * `meta` is merged shallowly, and the bounds *request* is merged field by field over the preset's (requestBounds() or
 * defaults.bounds) — so a caller that only narrows one field keeps the preset's other bounds. The merged request is still
 * clamped by Gate.attenuate, so the merge can never widen anything. `fork` and `parentId` are the kernel's to set.
 * `meta.projectCellId` is inherited from the parent unless the caller sets it.
 */
export function resolveSpec(registry: Registry, input: CellSpecInput, parent: CellRecord | null): ResolvedSpec {
  if (!input || typeof input !== "object") throw new NgError("invalid_argument", "spec must be an object");
  const { fork: _fork, parentId: _parentId, ...caller } = definedEntries(input) as CellSpec;
  const preset = caller.preset ? registry.presets.get(caller.preset) : undefined;
  if (caller.preset && !preset) throw new NgError("invalid_argument", `unknown preset "${caller.preset}"`);
  const defaults = (preset?.defaults ?? {}) as Partial<CellSpec>;

  const spec = { ...defaults, ...caller } as CellSpec;
  if (defaults.lifetime === "one_shot" || defaults.lifetime === "wakeable") spec.lifetime = defaults.lifetime;
  // docs/05: a cell works where its parent works unless it says otherwise when the preset enables inheritance.
  if (typeof spec.cwd === "string" && spec.cwd) spec.cwd = normalizeCwd(spec.cwd);
  else if (parent?.spec.cwd && preset?.inheritCwd !== false) spec.cwd = parent.spec.cwd;
  else delete spec.cwd;
  const meta = { ...(defaults.meta ?? {}), ...(caller.meta ?? {}) };
  const inherited = parent?.spec.meta?.["projectCellId"];
  if (typeof inherited === "string" && meta["projectCellId"] === undefined) meta["projectCellId"] = inherited;
  if (Object.keys(meta).length > 0) spec.meta = meta;
  else delete spec.meta;
  if (!spec.processor) throw new NgError("invalid_argument", "spec.processor is required (directly or through the preset's defaults)");

  const presetBounds = (preset?.requestBounds && parent ? preset.requestBounds({ parentCellId: parent.id, parentBounds: parent.bounds }) : undefined) ?? defaults.bounds;
  const boundsRequest: Partial<PolicyBounds> | undefined =
    presetBounds || caller.bounds ? { ...definedEntries(presetBounds ?? {}), ...definedEntries(caller.bounds ?? {}) } : undefined;
  if (boundsRequest && presetBounds?.maxDepth===0) boundsRequest.maxDepth=0;
  const safe = jsonSafeBounds(boundsRequest);
  if (safe) spec.bounds = safe;
  else delete spec.bounds;
  return { spec, boundsRequest };
}

/** Fail at spawn/update time rather than as a dead letter on the first Run. */
export function validateSpec(registry: Registry, spec: CellSpec): void {
  const p = spec.processor;
  if (!p || (p.kind !== "llm" && p.kind !== "code")) throw new NgError("invalid_argument", "spec.processor.kind must be llm or code");
  if (p.kind === "llm") {
    if (p.prompt !== undefined && !registry.prompts.has(p.prompt)) throw new NgError("not_found", `prompt "${p.prompt}" is not registered`);
    if (p.engine !== undefined && !(CLI_ENGINES as readonly string[]).includes(p.engine)) {
      throw new NgError("invalid_argument", `unknown processor.engine "${String(p.engine)}" (expected ${CLI_ENGINES.join(" | ")})`);
    }
    registry.resolveTools(p.toolsets ?? []);
  } else {
    if (typeof p.entry !== "string" || !p.entry) throw new NgError("invalid_argument", "code processor entry is required");
    if (!registry.codeProcessors.has(p.entry)) {
      throw new NgError("not_found", `code processor "${p.entry}" is not registered`);
    }
  }
  if (spec.contextMode !== undefined && spec.contextMode !== "isolated" && spec.contextMode !== "fork_prefix") {
    throw new NgError("invalid_argument", `invalid contextMode "${String(spec.contextMode)}"`);
  }
  if (spec.cwd !== undefined && (typeof spec.cwd !== "string" || !spec.cwd.startsWith("/"))) throw new NgError("invalid_argument", "cwd must be an absolute path");
  if (spec.lifetime !== undefined && spec.lifetime !== "one_shot" && spec.lifetime !== "wakeable" && spec.lifetime !== "persistent") {
    throw new NgError("invalid_argument", `invalid lifetime "${String(spec.lifetime)}" (one_shot | wakeable | persistent)`);
  }
  if (spec.absorbInbound !== undefined && typeof spec.absorbInbound !== "boolean") throw new NgError("invalid_argument", "absorbInbound must be a boolean");
  for (const w of spec.watches ?? []) {
    if (!w || typeof w.threadOrFilter !== "object" || w.threadOrFilter === null || Array.isArray(w.threadOrFilter)) {
      throw new NgError("invalid_argument", "each watch needs a threadOrFilter object");
    }
    if (w.coalesceMs !== undefined && (typeof w.coalesceMs !== "number" || !Number.isFinite(w.coalesceMs) || w.coalesceMs < 0)) {
      throw new NgError("invalid_argument", "watch coalesceMs must be a non-negative number of milliseconds");
    }
    for (const [k, v] of Object.entries(w.threadOrFilter)) {
      const bad = operatorProblem(v);
      if (bad) throw new NgError("invalid_argument", `watch filter "${k}": ${bad}`);
    }
    const thread = w.threadOrFilter["thread"];
    if (thread !== undefined && (typeof thread !== "string" || !thread)) throw new NgError("invalid_argument", "watch thread must be a non-empty string");
    if (Object.keys(w.threadOrFilter).length === 0) throw new NgError("invalid_argument", "a watch with an empty filter would capture all ingress");
  }
  const ws = spec.meta?.["workspace"];
  if (ws !== undefined) {
    if (!ws || typeof ws !== "object") throw new NgError("invalid_argument", "meta.workspace must be an object");
    for (const k of ["repoPath", "baseRef", "branch"]) {
      const v = (ws as Record<string, unknown>)[k];
      if (v !== undefined && typeof v !== "string") throw new NgError("invalid_argument", `meta.workspace.${k} must be a string`);
    }
  }
}

/** Content-derived id of `spec.schedules[i]` (see the convention in @ng/protocol contract/cell.ts). */
export function scheduleEnvelopeId(cellId: string, rule: ScheduleRule): string {
  return `${cellId}:schedule:${sha256Hex(stableStringify(rule)).slice(0, 12)}`;
}

const OPERATORS = ["$in", "$contains", "$anyKeyword"] as const;

function operatorOf(expected: unknown): { op: (typeof OPERATORS)[number]; arg: unknown } | null {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) return null;
  const keys = Object.keys(expected);
  if (keys.length !== 1 || !(OPERATORS as readonly string[]).includes(keys[0]!)) return null;
  return { op: keys[0] as (typeof OPERATORS)[number], arg: (expected as Record<string, unknown>)[keys[0]!] };
}

/** Why a filter value that looks like an operator is malformed (null = fine, or a plain equality value). */
function operatorProblem(expected: unknown): string | null {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) return null;
  const keys = Object.keys(expected);
  if (!keys.some((k) => k.startsWith("$"))) return null;
  const o = operatorOf(expected);
  if (!o) return `unknown operator (use one of ${OPERATORS.join(", ")}, alone)`;
  if (o.op === "$contains") return typeof o.arg === "string" && o.arg ? null : "$contains needs a non-empty string";
  if (!Array.isArray(o.arg) || o.arg.length === 0) return `${o.op} needs a non-empty array`;
  if (o.op === "$anyKeyword" && !o.arg.every((k) => typeof k === "string" && k)) return "$anyKeyword needs non-empty strings";
  return null;
}

const lower = (v: string) => v.toLocaleLowerCase();

function operatorMatches(o: { op: (typeof OPERATORS)[number]; arg: unknown }, actual: unknown): boolean {
  switch (o.op) {
    case "$in":
      return Array.isArray(o.arg) && o.arg.some((v) => stableStringify(v) === stableStringify(actual));
    case "$contains": {
      if (typeof o.arg !== "string") return false;
      if (typeof actual === "string") return lower(actual).includes(lower(o.arg));
      // A list field (mentions, tags, threads): one of its elements is the value.
      if (Array.isArray(actual)) return actual.some((v) => (typeof v === "string" ? lower(v) === lower(o.arg as string) : stableStringify(v) === stableStringify(o.arg)));
      return false;
    }
    case "$anyKeyword": {
      if (!Array.isArray(o.arg)) return false;
      const hay = typeof actual === "string" ? [lower(actual)] : Array.isArray(actual) ? actual.filter((v): v is string => typeof v === "string").map(lower) : [];
      return o.arg.some((k) => typeof k === "string" && hay.some((h) => h.includes(lower(k))));
    }
  }
}

/**
 * Filter of a watch over an envelope: top-level fields or `payload.<path>`; a value is compared for equality unless it
 * is an operator object (`$in`, `$contains`, `$anyKeyword` — see the convention in @ng/protocol contract/cell.ts).
 * `thread` is matched separately.
 */
export function watchFilterMatches(filter: Record<string, unknown>, env: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "thread") continue;
    const actual = key.startsWith("payload.") ? readPath(env["payload"], key.slice("payload.".length).split(".")) : env[key];
    const o = operatorOf(expected);
    if (o ? !operatorMatches(o, actual) : stableStringify(actual) !== stableStringify(expected)) return false;
  }
  return true;
}

function readPath(value: unknown, path: string[]): unknown {
  let cur = value;
  for (const p of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
