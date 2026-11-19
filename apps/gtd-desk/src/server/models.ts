import type { Kernel, ModelSelection, ModelSettings } from "@ng/cell";
import { fastRecommendation } from "@ng/loop";
import { NgError, type ModelTier } from "@ng/protocol";
import type { ModelChoiceDTO, ModelsDTO, SetModelRequest } from "../shared/api";

/**
 * The owner's model switch over HTTP (`/api/models`). The list and the recommendation come from the backend CLI
 * itself (kernel.modelSettings); nothing here names a model.
 */
export interface ModelSwitch {
  view(opts?: { refresh?: boolean }): Promise<ModelsDTO>;
  set(req: SetModelRequest): Promise<ModelsDTO>;
  /** "Opus 5.5 · xhigh" for the top bar; null when there is no switch or nothing is known yet. */
  label(): string | null;
}

const TIERS: readonly ModelTier[] = ["strong", "fast"];

function dto(settings: ModelSettings): ModelsDTO {
  const v = settings.view();
  const labelOf = (id: string) => v.catalog?.models.find((m) => m.id === id)?.label ?? id;
  const choice = (c: { model: string; effort?: string } | null): ModelChoiceDTO | null =>
    c ? { model: c.model, label: labelOf(c.model), ...(c.effort ? { effort: c.effort } : {}) } : null;
  return {
    available: true,
    engine: v.engine,
    models: v.catalog?.models ?? [],
    recommended: choice(v.catalog?.recommended ?? null),
    recommendedFast: choice(v.catalog ? fastRecommendation(v.catalog) : null),
    fetchedAt: v.catalog?.fetchedAt ?? null,
    error: v.error,
    selection: v.selection,
    effective: { strong: choice(v.effective.strong), fast: choice(v.effective.fast) },
  };
}

const NONE: ModelsDTO = {
  available: false,
  engine: null,
  models: [],
  recommended: null,
  fetchedAt: null,
  error: null,
  selection: { strong: { mode: "auto" }, fast: { mode: "auto" } },
  effective: { strong: null, fast: null },
};

export function createModelSwitch(kernel: Pick<Kernel, "modelSettings">): ModelSwitch {
  const settings = () => kernel.modelSettings();
  return {
    async view(opts = {}) {
      const s = settings();
      if (!s) return NONE;
      // A failed fetch is reported in the view (`error`), not thrown: the switch still shows the selection.
      await s.catalog(opts.refresh ? { refresh: true } : {}).catch(() => undefined);
      return dto(s);
    },
    async set(req) {
      const s = settings();
      // Messages here are shown to the owner as they are (the panel prints them under the select).
      if (!s) throw new NgError("unsupported", "当前不是由 CLI Agent 驱动，没有可切换的模型");
      if (!req || !TIERS.includes(req.tier)) throw new NgError("invalid_argument", "tier 必须是 strong（主力）或 fast（轻量）");
      const sel: ModelSelection =
        req.mode === "auto" ? { mode: "auto" } : { mode: "fixed", model: String(req.model ?? ""), ...(req.effort ? { effort: String(req.effort) } : {}) };
      // Check against the CLI's current list (fetched if we have none yet).
      const catalog = await s.catalog().catch(() => null);
      if (sel.mode === "fixed" && catalog) {
        const m = catalog.models.find((x) => x.id === sel.model);
        if (!m) throw new NgError("invalid_argument", `${s.engine} 的模型列表里没有 "${sel.model}"（现有：${catalog.models.map((x) => x.id).join(", ")}）。可以先刷新列表。`);
        if (sel.effort && !m.efforts.includes(sel.effort)) {
          throw new NgError("invalid_argument", `${m.label} 不提供推理强度 "${sel.effort}"（可选：${m.efforts.join(", ") || "无"}）`);
        }
      }
      s.select(req.tier, sel);
      return dto(s);
    },
    label() {
      const s = settings();
      if (!s) return null;
      const v = s.view();
      const c = v.effective.strong;
      if (!c) return null;
      const name = v.catalog?.models.find((m) => m.id === c.model)?.label ?? c.model;
      return c.effort ? `${name} · ${c.effort}` : name;
    },
  };
}
