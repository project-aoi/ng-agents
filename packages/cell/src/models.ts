import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CELL_ROLES,
  CLI_ENGINES,
  cellRoleOf,
  NgError,
  ROLE_DEFAULT_TIER,
  type CellRole,
  type CellSpec,
  type CliEngine,
  type Clock,
  type ModelTier,
  type RunnerOverride,
  type RunnerSelection,
  type RunnerSelectionTarget,
} from "@ng/protocol";
import { fastRecommendation, listCliModels, preferredEffort, type CliModelCatalog, type CliModelChoice, type CliModelInfo } from "@ng/loop";

/**
 * The owner's model switch for one CLI engine.
 *
 * Which models exist is asked from the CLI (never listed here), and so is which one is "best": the default selection
 * is "auto" — for the strong tier the CLI's own first choice at the preferred effort, for the fast tier the lighter
 * choice derived from the same list (its light model, or the first choice at a lower effort) — and it follows the CLI
 * when its list or recommendation changes. A fixed selection stays until the owner changes it. Selections are kept in
 * `<dataDir>/models.json`, per engine (model ids mean nothing across engines).
 */

export type ModelSelection = { mode: "auto" } | { mode: "fixed"; model: string; effort?: string };

export type RoleModelSelection =
  | { mode: "inherit" }
  | { mode: "custom"; runner: CliEngine; model?: string; effort?: string };

export interface EffectiveRunnerChoice {
  runner: CliEngine;
  choice: (CliModelChoice & { label: string }) | null;
  source: "override" | "role" | "default";
}

export interface ModelSettingsView {
  engine: CliEngine;
  /** The CLI's catalogue as last fetched (null until the first fetch succeeds). */
  catalog: CliModelCatalog | null;
  /** Why the last fetch failed, when it did (the previous catalogue, if any, stays in use). */
  error: string | null;
  selection: Record<ModelTier, ModelSelection>;
  /** What a Run of each tier would be launched with right now; null = the CLI's own default (nothing is passed). */
  effective: Record<ModelTier, CliModelChoice | null>;
}

export interface ModelSettings {
  readonly engine: CliEngine;
  /** The catalogue, fetched when missing, stale or `refresh`. Rejects only when there is no catalogue at all. */
  catalog(opts?: { refresh?: boolean; cooldown?: boolean }): Promise<CliModelCatalog>;
  view(): ModelSettingsView;
  /** Change one tier. A fixed model must be in the catalogue (when one is known) and its effort one the model offers. */
  select(tier: ModelTier, selection: ModelSelection): void;
  /** For a Run: the choice to launch with, or undefined to leave it to the static setting / the CLI's default. */
  resolve(tier: ModelTier, opts?: { waitMs?: number }): Promise<CliModelChoice | undefined>;
  /** Start fetching the catalogue in the background (kernel start). */
  warm(): void;
}

export interface ModelSettingsOptions {
  engine: CliEngine;
  dataDir: string;
  clock: Clock;
  bin?: string;
  env?: Record<string, string | undefined>;
  /** Tier → model from static configuration (`NG_<CLI>_MODEL_*`): the starting selection until the owner picks one. */
  initial?: Partial<Record<ModelTier, string>>;
  /** How long a fetched catalogue is used before it is fetched again (default 30 minutes). */
  ttlMs?: number;
  /** How long a Run waits for the first catalogue before it starts with the CLI's default instead (default 20 s). */
  firstFetchWaitMs?: number;
  /** How long to wait after a failed catalogue fetch before retrying automatically (default 5 minutes; explicit refresh bypasses). */
  errorRetryMs?: number;
  /** Injected catalogue source (tests); default: ask the CLI. */
  fetch?: (engine: CliEngine) => Promise<CliModelCatalog>;
  onError?: (err: unknown, where: string) => void;
}

const TIERS: readonly ModelTier[] = ["strong", "fast"];
const FILE = "models.json";
const ROLE_FILE = "role-models.json";

function writeSettings(dataDir: string, file: string, value: unknown): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = join(dataDir, `${file}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, join(dataDir, file));
}

type Stored = Partial<Record<CliEngine, Partial<Record<ModelTier, ModelSelection>>>>;
type StoredRoles = Partial<Record<CellRole, RoleModelSelection>>;

function readStored(dataDir: string): Stored {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, FILE), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Stored) : {};
  } catch {
    return {};
  }
}

function readStoredRoles(dataDir: string): StoredRoles {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, ROLE_FILE), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as StoredRoles) : {};
  } catch {
    return {};
  }
}

function validSelection(v: unknown): ModelSelection | null {
  if (!v || typeof v !== "object") return null;
  const s = v as { mode?: unknown; model?: unknown; effort?: unknown };
  if (s.mode === "auto") return { mode: "auto" };
  if (s.mode === "fixed" && typeof s.model === "string" && s.model.trim()) {
    return typeof s.effort === "string" && s.effort.trim() ? { mode: "fixed", model: s.model.trim(), effort: s.effort.trim() } : { mode: "fixed", model: s.model.trim() };
  }
  return null;
}

function validRoleSelection(v: unknown): RoleModelSelection | null {
  if (!v || typeof v !== "object") return null;
  const s = v as { mode?: unknown; runner?: unknown; model?: unknown; effort?: unknown };
  if (s.mode === "inherit") return { mode: "inherit" };
  if (s.mode === "custom" && typeof s.runner === "string" && (CLI_ENGINES as readonly string[]).includes(s.runner)) {
    const model = typeof s.model === "string" && s.model.trim() ? s.model.trim() : undefined;
    const effort = typeof s.effort === "string" && s.effort.trim() ? s.effort.trim() : undefined;
    return { mode: "custom", runner: s.runner as CliEngine, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  return null;
}

export function createModelSettings(opts: ModelSettingsOptions): ModelSettings {
  const { engine, dataDir, clock } = opts;
  const ttlMs = opts.ttlMs ?? 30 * 60_000;
  const firstFetchWaitMs = opts.firstFetchWaitMs ?? 20_000;
  const errorRetryMs = opts.errorRetryMs ?? 5 * 60_000;
  const fetch = opts.fetch ?? ((e: CliEngine) => listCliModels(e, { ...(opts.bin ? { bin: opts.bin } : {}), ...(opts.env ? { env: opts.env } : {}), now: () => clock.now() }));

  let catalog: CliModelCatalog | null = null;
  let error: string | null = null;
  let lastAttemptAt: number | null = null;
  let inFlight: Promise<CliModelCatalog> | null = null;

  const selection = {} as Record<ModelTier, ModelSelection>;
  const saved = readStored(dataDir)[engine] ?? {};
  for (const tier of TIERS) {
    selection[tier] = validSelection(saved[tier]) ?? (opts.initial?.[tier] ? { mode: "fixed", model: opts.initial[tier]! } : { mode: "auto" });
  }

  function refresh(): Promise<CliModelCatalog> {
    inFlight ??= fetch(engine)
      .then((c) => {
        catalog = c;
        error = null;
        lastAttemptAt = clock.now();
        return c;
      })
      .catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
        lastAttemptAt = clock.now();
        opts.onError?.(err, `list the models of ${engine}`);
        throw err;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  const stale = () => catalog === null || clock.now() - catalog.fetchedAt > ttlMs;
  const retryDue = () => lastAttemptAt === null || clock.now() - lastAttemptAt >= errorRetryMs;
  const info = (id: string): CliModelInfo | undefined => catalog?.models.find((m) => m.id === id);

  function choiceOf(tier: ModelTier, sel: ModelSelection): CliModelChoice | null {
    // Auto for fast work must not inherit the flagship at its highest effort: checkers and sources are quick checks.
    if (sel.mode === "auto") return catalog ? (tier === "fast" ? fastRecommendation(catalog) : catalog.recommended) : null;
    const effort = sel.effort ?? preferredEffort(info(sel.model)?.efforts ?? []);
    return effort ? { model: sel.model, effort } : { model: sel.model };
  }

  return {
    engine,
    async catalog(o = {}) {
      if (o.refresh) {
        try {
          return await refresh();
        } catch (err) {
          if (catalog) return catalog; // the last good list beats none
          throw err;
        }
      }
      if (stale()) {
        if (o.cooldown && catalog === null && !inFlight && !retryDue()) {
          throw new Error(error ?? `model list for ${engine} is unavailable`);
        }
        if (o.cooldown && catalog !== null && !inFlight && !retryDue()) {
          return catalog;
        }
        try {
          return await refresh();
        } catch (err) {
          if (catalog) return catalog;
          throw err;
        }
      }
      return catalog!;
    },
    view() {
      return {
        engine,
        catalog,
        error,
        selection: { strong: selection.strong, fast: selection.fast },
        effective: { strong: choiceOf("strong", selection.strong), fast: choiceOf("fast", selection.fast) },
      };
    },
    select(tier, sel) {
      if (!TIERS.includes(tier)) throw new NgError("invalid_argument", `unknown model tier "${String(tier)}"`);
      const next = validSelection(sel);
      if (!next) throw new NgError("invalid_argument", 'a model selection is { mode: "auto" } or { mode: "fixed", model, effort? }');
      if (next.mode === "fixed" && catalog) {
        const m = info(next.model);
        if (!m) throw new NgError("invalid_argument", `${engine} does not list a model "${next.model}" (it lists: ${catalog.models.map((x) => x.id).join(", ")})`);
        if (next.effort && !m.efforts.includes(next.effort)) {
          throw new NgError("invalid_argument", `${m.label} does not offer effort "${next.effort}" (it offers: ${m.efforts.join(", ") || "none"})`);
        }
      }
      writeSettings(dataDir, FILE, { ...readStored(dataDir), [engine]: { ...selection, [tier]: next } });
      selection[tier] = next;
    },
    async resolve(tier, o = {}) {
      const sel = selection[tier] ?? selection.strong;
      const waitMs = o.waitMs !== undefined ? Math.min(o.waitMs, firstFetchWaitMs) : firstFetchWaitMs;
      if (catalog === null) {
        if (inFlight || retryDue()) {
          // First Run after a start: give the CLI a moment to answer, then go on without (its own default model).
          const first = (inFlight ?? refresh()).catch(() => null);
          await Promise.race([first, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
        }
      } else if (stale() && retryDue()) {
        void refresh().catch(() => undefined); // keep using what we have; the next Run sees the new list
      }
      return choiceOf(tier, sel) ?? undefined;
    },
    warm() {
      if (catalog === null && retryDue()) void refresh().catch(() => undefined);
    },
  };
}

const DESCRIBE_WAIT_MS = 3_000;

export function createRunnerSettings(opts: {
  dataDir: string;
  runners: readonly CliEngine[];
  initial: CliEngine | null;
  modelSettings(engine: CliEngine): ModelSettings | null;
}) {
  const { dataDir, runners, modelSettings } = opts;
  const file = "default-runner.json";
  let current = opts.initial;
  try {
    const saved: unknown = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
    current = runners.find((runner) => runner === saved) ?? current;
  } catch {
    // An absent or unreadable selection uses the host's default.
  }

  const roleSelections = {} as Record<CellRole, RoleModelSelection>;
  const savedRoles = readStoredRoles(dataDir);
  for (const role of CELL_ROLES) {
    roleSelections[role] = validRoleSelection(savedRoles[role]) ?? { mode: "inherit" };
  }

  function enabled(value: string): CliEngine {
    const runner = runners.find((candidate) => candidate === value);
    if (!runner) throw new NgError("invalid_argument", `Runner「${value}」未启用。可选：${runners.join(", ") || "无"}`);
    return runner;
  }

  function activeRole(role: CellRole): RoleModelSelection {
    const sel = roleSelections[role];
    return sel.mode === "custom" && runners.includes(sel.runner) ? sel : { mode: "inherit" };
  }

  function engineFor(role: CellRole | null): CliEngine | null {
    if (role) {
      const sel = activeRole(role);
      if (sel.mode === "custom") return sel.runner;
    }
    return current;
  }

  function choiceWithLabel(engine: CliEngine, choice: CliModelChoice | null): (CliModelChoice & { label: string }) | null {
    if (!choice) return null;
    const label = modelSettings(engine)?.view().catalog?.models.find((m) => m.id === choice.model)?.label ?? choice.model;
    return { model: choice.model, label, ...(choice.effort ? { effort: choice.effort } : {}) };
  }

  function choiceForRoleSync(engine: CliEngine, tier: ModelTier, role: CellRole | null, hasExplicitEngine: boolean): CliModelChoice | null {
    const view = modelSettings(engine)?.view();
    const cat = view?.catalog ?? null;
    if (!hasExplicitEngine && role && tier === ROLE_DEFAULT_TIER[role]) {
      const sel = activeRole(role);
      if (sel.mode === "custom" && sel.runner === engine) {
        if (sel.model) {
          const info = cat?.models.find((m) => m.id === sel.model);
          const effort = sel.effort ?? preferredEffort(info?.efforts ?? []);
          return effort ? { model: sel.model, effort } : { model: sel.model };
        }
        const base = view?.effective[tier] ?? null;
        if (sel.effort && base) {
          const info = cat?.models.find((m) => m.id === base.model);
          if (!info || info.efforts.includes(sel.effort)) return { model: base.model, effort: sel.effort };
        }
        return base;
      }
    }
    return view?.effective[tier] ?? null;
  }

  async function catalog(engine: CliEngine, waitMs?: number) {
    const settings = modelSettings(engine);
    await settings?.resolve("strong", waitMs !== undefined ? { waitMs } : {});
    return settings?.view().catalog;
  }

  async function resolveRunModel(
    engine: CliEngine,
    tier: ModelTier,
    role: CellRole | null,
    hasExplicitEngine: boolean,
  ): Promise<CliModelChoice | undefined> {
    const base = await modelSettings(engine)?.resolve(tier);
    if (!hasExplicitEngine && role && tier === ROLE_DEFAULT_TIER[role]) {
      const sel = activeRole(role);
      if (sel.mode === "custom" && sel.runner === engine) {
        const cat = modelSettings(engine)?.view().catalog;
        if (sel.model) {
          const info = cat?.models.find((m) => m.id === sel.model);
          const effort = sel.effort ?? preferredEffort(info?.efforts ?? []);
          return effort ? { model: sel.model, effort } : { model: sel.model };
        }
        if (sel.effort && base) {
          const info = cat?.models.find((m) => m.id === base.model);
          if (!info || info.efforts.includes(sel.effort)) return { model: base.model, effort: sel.effort };
        }
      }
    }
    return base;
  }

  function effectiveForRole(role: CellRole): EffectiveRunnerChoice | null {
    const sel = activeRole(role);
    const runner = sel.mode === "custom" ? sel.runner : current;
    if (!runner) return null;
    const choice = choiceForRoleSync(runner, ROLE_DEFAULT_TIER[role], role, false);
    return { runner, choice: choiceWithLabel(runner, choice), source: sel.mode === "custom" ? "role" : "default" };
  }

  function effectiveForSpec(spec: Pick<CellSpec, "preset" | "meta" | "processor">): EffectiveRunnerChoice | null {
    if (spec.processor.kind !== "llm") return null;
    const role = cellRoleOf(spec);
    const tier: ModelTier = spec.processor.modelTier ?? (role ? ROLE_DEFAULT_TIER[role] : "strong");
    const explicitEngine = spec.processor.engine;
    const runner = explicitEngine ?? engineFor(role);
    if (!runner) return null;
    if (spec.processor.model) {
      const c: CliModelChoice = spec.processor.effort ? { model: spec.processor.model, effort: spec.processor.effort } : { model: spec.processor.model };
      return { runner, choice: choiceWithLabel(runner, c), source: "override" };
    }
    const customRole = !explicitEngine && role !== null && activeRole(role).mode === "custom";
    const c = choiceForRoleSync(runner, tier, role, Boolean(explicitEngine));
    return { runner, choice: choiceWithLabel(runner, c), source: explicitEngine ? "override" : customRole ? "role" : "default" };
  }

  return {
    get current() { return current; },
    engineFor,
    effectiveForRole,
    effectiveForSpec,
    resolveRunModel,
    roleSelections(): Record<CellRole, RoleModelSelection> {
      const out = {} as Record<CellRole, RoleModelSelection>;
      for (const role of CELL_ROLES) out[role] = activeRole(role);
      return out;
    },
    select(runner: string) {
      const next = enabled(runner);
      if (next === current) return;
      writeSettings(dataDir, file, next);
      current = next;
    },
    selectRole(role: CellRole, raw: RoleModelSelection) {
      if (!(CELL_ROLES as readonly string[]).includes(role)) {
        throw new NgError("invalid_argument", `未知层级「${String(role)}」（可选：${CELL_ROLES.join(", ")}）`);
      }
      const next = validRoleSelection(raw);
      if (!next) {
        throw new NgError("invalid_argument", '层级配置必须是 { mode: "inherit" } 或 { mode: "custom", runner, model?, effort? }');
      }
      if (next.mode === "custom") {
        enabled(next.runner);
        const settings = modelSettings(next.runner);
        const view = settings?.view();
        const cat = view?.catalog;
        if (cat) {
          if (next.model) {
            const m = cat.models.find((x) => x.id === next.model);
            if (!m) {
              throw new NgError("invalid_argument", `${next.runner} 的模型列表里没有 "${next.model}"（现有：${cat.models.map((x) => x.id).join(", ")}）`);
            }
            if (next.effort && !m.efforts.includes(next.effort)) {
              throw new NgError("invalid_argument", `${m.label} 不提供推理强度 "${next.effort}"（可选：${m.efforts.join(", ") || "无"}）`);
            }
          } else if (next.effort) {
            const base = view?.effective[ROLE_DEFAULT_TIER[role]];
            const m = base ? cat.models.find((x) => x.id === base.model) : undefined;
            if (m && !m.efforts.includes(next.effort)) {
              throw new NgError("invalid_argument", `${m.label} 不提供推理强度 "${next.effort}"（可选：${m.efforts.join(", ") || "无"}）`);
            }
          }
        }
      }
      const stored = readStoredRoles(dataDir);
      if (next.mode === "inherit") delete stored[role];
      else stored[role] = next;
      writeSettings(dataDir, ROLE_FILE, stored);
      roleSelections[role] = next;
    },
    async describe(): Promise<string> {
      if (runners.length === 0) return "No CLI runner overrides are available. Leave runner, model and effort unset.";
      const lists = await Promise.all(runners.map(async (engine) => {
        const models = (await catalog(engine, DESCRIBE_WAIT_MS))?.models ?? [];
        const choices = models.map(({ id, efforts }) => `${JSON.stringify(id)}${efforts.length ? ` (effort: ${efforts.map((effort) => JSON.stringify(effort)).join(", ")})` : ""}`);
        return `- ${engine}: ${choices.join("; ") || "model list unavailable, omit model and effort"}`;
      }));
      const roleSummary = CELL_ROLES.map((role) => {
        const eff = effectiveForRole(role);
        if (!eff) return `${role}=none`;
        const modelPart = eff.choice ? ` (${eff.choice.model}${eff.choice.effort ? ` · ${eff.choice.effort}` : ""})` : "";
        return `${role}=${eff.runner}${modelPart}`;
      }).join(", ");
      return [
        `Optional runner overrides for new model-backed cells. Default runner: ${current}. Role defaults: ${roleSummary}. Omit all fields to follow the workbench's role defaults; pass runner alone to use that runner's default model; pass effort alone (or runner + effort) to keep the default model while tuning reasoning effort; pass model (with optional runner and effort) to pin an exact model.`,
        ...lists,
      ].join("\n");
    },
    async resolve({ runner, model, effort }: RunnerSelection, target?: RunnerSelectionTarget): Promise<RunnerOverride> {
      const role = target?.role ?? null;
      const tier: ModelTier = target?.tier ?? (role ? ROLE_DEFAULT_TIER[role] : "strong");
      const engine = runner === undefined ? engineFor(role) : enabled(runner);
      if (!engine) throw new NgError("unsupported", "No CLI runner is available.");
      if (!model && !effort) return { engine };
      if (!model && effort) {
        const base = await resolveRunModel(engine, tier, role, runner !== undefined);
        if (!base?.model) {
          throw new NgError("invalid_argument", `The default model for ${engine} is unavailable. Specify a model when choosing effort.`);
        }
        const list = modelSettings(engine)?.view().catalog;
        if (list?.models.length) {
          const info = list.models.find((m) => m.id === base.model);
          if (!info) throw new NgError("invalid_argument", `Runner ${engine} does not list model "${base.model}".`);
          if (!info.efforts.includes(effort)) {
            throw new NgError("invalid_argument", `${base.model} on ${engine} does not offer effort "${effort}" (available: ${info.efforts.join(", ") || "none"}).`);
          }
        }
        return { engine, model: base.model, effort };
      }
      const list = await catalog(engine, DESCRIBE_WAIT_MS);
      if (!list?.models.length) throw new NgError("invalid_argument", `The model list for ${engine} is unavailable. Omit model and effort to use its configured defaults.`);
      const info = list.models.find((m) => m.id === model);
      if (!info) throw new NgError("invalid_argument", `Runner ${engine} does not list model "${model}".`);
      if (effort && !info.efforts.includes(effort)) {
        throw new NgError("invalid_argument", `${model} on ${engine} does not offer effort "${effort}" (available: ${info.efforts.join(", ") || "none"}).`);
      }
      const chosen = effort ?? preferredEffort(info.efforts);
      return { engine, model: model!, ...(chosen ? { effort: chosen } : {}) };
    },
  };
}
