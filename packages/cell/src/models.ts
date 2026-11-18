import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NgError, type CliEngine, type Clock, type ModelTier } from "@ng/protocol";
import { listCliModels, preferredEffort, type CliModelCatalog, type CliModelChoice, type CliModelInfo } from "@ng/loop";

/**
 * The owner's model switch for one CLI engine.
 *
 * Which models exist is asked from the CLI (never listed here), and so is which one is "best": the default selection
 * is "auto" — the CLI's own first choice at the preferred effort — and it follows the CLI when a new model becomes
 * its recommendation. A fixed selection stays until the owner changes it. Selections are kept in
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

  function persist(): void {
    const all = readStored(dataDir);
    all[engine] = { ...selection };
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const tmp = join(dataDir, `${FILE}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, join(dataDir, FILE));
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

  function choiceOf(sel: ModelSelection): CliModelChoice | null {
    if (sel.mode === "auto") return catalog?.recommended ?? null;
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
        effective: { strong: choiceOf(selection.strong), fast: choiceOf(selection.fast) },
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
      selection[tier] = next;
      persist();
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
      return choiceOf(sel) ?? undefined;
    },
    warm() {
      if (catalog === null) void refresh().catch(() => undefined);
    },
  };
}
