import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NgError, type CliEngine, type Clock, type ModelTier, type RunnerOverride, type RunnerSelection } from "@ng/protocol";
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
  catalog(opts?: { refresh?: boolean }): Promise<CliModelCatalog>;
  view(): ModelSettingsView;
  /** Change one tier. A fixed model must be in the catalogue (when one is known) and its effort one the model offers. */
  select(tier: ModelTier, selection: ModelSelection): void;
  /** For a Run: the choice to launch with, or undefined to leave it to the static setting / the CLI's default. */
  resolve(tier: ModelTier): Promise<CliModelChoice | undefined>;
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
  /** Injected catalogue source (tests); default: ask the CLI. */
  fetch?: (engine: CliEngine) => Promise<CliModelCatalog>;
  onError?: (err: unknown, where: string) => void;
}

const TIERS: readonly ModelTier[] = ["strong", "fast"];
const FILE = "models.json";

function writeSettings(dataDir: string, file: string, value: unknown): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = join(dataDir, `${file}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, join(dataDir, file));
}

type Stored = Partial<Record<CliEngine, Partial<Record<ModelTier, ModelSelection>>>>;

function readStored(dataDir: string): Stored {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, FILE), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Stored) : {};
  } catch {
    return {};
  }
}

function validSelection(v: unknown): ModelSelection | null {
  if (!v || typeof v !== "object") return null;
  const s = v as { mode?: unknown; model?: unknown; effort?: unknown };
  if (s.mode === "auto") return { mode: "auto" };
  if (s.mode === "fixed" && typeof s.model === "string" && s.model.trim()) {
    return typeof s.effort === "string" && s.effort.trim() ? { mode: "fixed", model: s.model, effort: s.effort } : { mode: "fixed", model: s.model };
  }
  return null;
}

export function createModelSettings(opts: ModelSettingsOptions): ModelSettings {
  const { engine, dataDir, clock } = opts;
  const ttlMs = opts.ttlMs ?? 30 * 60_000;
  const firstFetchWaitMs = opts.firstFetchWaitMs ?? 20_000;
  const fetch = opts.fetch ?? ((e: CliEngine) => listCliModels(e, { ...(opts.bin ? { bin: opts.bin } : {}), ...(opts.env ? { env: opts.env } : {}), now: () => clock.now() }));

  let catalog: CliModelCatalog | null = null;
  let error: string | null = null;
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
        return c;
      })
      .catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
        opts.onError?.(err, `list the models of ${engine}`);
        throw err;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  const stale = () => catalog === null || clock.now() - catalog.fetchedAt > ttlMs;
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
      if (o.refresh || stale()) {
        try {
          return await refresh();
        } catch (err) {
          if (catalog) return catalog; // the last good list beats none
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
    async resolve(tier) {
      const sel = selection[tier] ?? selection.strong;
      if (catalog === null) {
        // First Run after a start: give the CLI a moment to answer, then go on without (its own default model).
        const first = refresh().catch(() => null);
        await Promise.race([first, new Promise((r) => setTimeout(r, firstFetchWaitMs).unref?.())]);
      } else if (stale()) {
        void refresh().catch(() => undefined); // keep using what we have; the next Run sees the new list
      }
      return choiceOf(tier, sel) ?? undefined;
    },
    warm() {
      if (catalog === null) void refresh().catch(() => undefined);
    },
  };
}

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

  function enabled(value: string): CliEngine {
    const runner = runners.find((candidate) => candidate === value);
    if (!runner) throw new NgError("invalid_argument", `Runner「${value}」未启用。可选：${runners.join(", ") || "无"}`);
    return runner;
  }

  async function catalog(engine: CliEngine) {
    const settings = modelSettings(engine);
    await settings?.resolve("strong");
    return settings?.view().catalog;
  }

  return {
    get current() { return current; },
    select(runner: string) {
      const next = enabled(runner);
      if (next === current) return;
      writeSettings(dataDir, file, next);
      current = next;
    },
    async describe(): Promise<string> {
      if (runners.length === 0) return "No CLI runner overrides are available. Leave runner, model and effort unset.";
      const lists = await Promise.all(runners.map(async (engine) => {
        const models = (await catalog(engine))?.models ?? [];
        const choices = models.map(({ id, efforts }) => `${JSON.stringify(id)}${efforts.length ? ` (effort: ${efforts.map((effort) => JSON.stringify(effort)).join(", ")})` : ""}`);
        return `- ${engine}: ${choices.join("; ") || "model list unavailable, omit model and effort"}`;
      }));
      return [
        `Optional runner overrides for model-backed cells. Default runner: ${current}. Omit all fields to follow the workbench defaults. A model override fixes the runner for this cell. Specify model to use effort.`,
        ...lists,
      ].join("\n");
    },
    async resolve({ runner, model, effort }: RunnerSelection): Promise<RunnerOverride> {
      const engine = runner === undefined ? current : enabled(runner);
      if (!engine) throw new NgError("unsupported", "No CLI runner is available.");
      if (effort && !model) throw new NgError("invalid_argument", "Specify a model when choosing effort.");
      if (!model) return { engine };
      const list = await catalog(engine);
      if (!list?.models.length) throw new NgError("invalid_argument", `The model list for ${engine} is unavailable. Omit model and effort to use its configured defaults.`);
      const info = list.models.find((m) => m.id === model);
      if (!info) throw new NgError("invalid_argument", `Runner ${engine} does not list model "${model}".`);
      if (effort && !info.efforts.includes(effort)) {
        throw new NgError("invalid_argument", `${model} on ${engine} does not offer effort "${effort}" (available: ${info.efforts.join(", ") || "none"}).`);
      }
      const chosen = effort ?? preferredEffort(info.efforts);
      return { engine, model, ...(chosen ? { effort: chosen } : {}) };
    },
  };
}
