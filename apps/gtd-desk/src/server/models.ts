import type { Kernel, ModelSelection, ModelSettings, RoleModelSelection } from "@ng/cell";
import { fastRecommendation } from "@ng/loop";
import { CELL_ROLES, NgError, type CellRole, type ModelTier } from "@ng/protocol";
import type {
  CellRoleDTO,
  ModelChoiceDTO,
  ModelsDTO,
  RoleEffectiveDTO,
  RoleModelSelectionDTO,
  RunnerCatalogDTO,
  RunnerDTO,
  UpdateModelsRequest,
} from "../shared/api";

/**
 * The owner's model switch over HTTP (`/api/models`). The list and the recommendation come from each enabled backend
 * CLI itself (`kernel.modelSettings`); nothing here names a model.
 */
export interface ModelSwitch {
  view(opts?: { refresh?: boolean }): Promise<ModelsDTO>;
  set(req: UpdateModelsRequest): Promise<ModelsDTO>;
  /** "Opus 5.5 · xhigh" for the top bar; null when there is no switch or nothing is known yet. */
  label(): string | null;
}

const TIERS: readonly ModelTier[] = ["strong", "fast"];

function catalogDto(settings: ModelSettings): RunnerCatalogDTO {
  const v = settings.view();
  const labelOf = (id: string) => v.catalog?.models.find((m) => m.id === id)?.label ?? id;
  const choice = (c: { model: string; effort?: string } | null): ModelChoiceDTO | null =>
    c ? { model: c.model, label: labelOf(c.model), ...(c.effort ? { effort: c.effort } : {}) } : null;
  return {
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

function emptyRoles(): Record<CellRoleDTO, RoleModelSelectionDTO> {
  return {
    desk: { mode: "inherit" },
    project: { mode: "inherit" },
    worker: { mode: "inherit" },
    hub: { mode: "inherit" },
    checker: { mode: "inherit" },
    sensor: { mode: "inherit" },
  };
}

function emptyEffectiveRoles(): Record<CellRoleDTO, RoleEffectiveDTO | null> {
  return { desk: null, project: null, worker: null, hub: null, checker: null, sensor: null };
}

const NONE: ModelsDTO = {
  available: false,
  engine: null,
  runners: [],
  models: [],
  recommended: null,
  fetchedAt: null,
  error: null,
  selection: { strong: { mode: "auto" }, fast: { mode: "auto" } },
  effective: { strong: null, fast: null },
  catalogs: {},
  roles: emptyRoles(),
  effectiveRoles: emptyEffectiveRoles(),
};

type ModelSwitchKernel = Pick<Kernel, "modelSettings" | "cliRunners" | "setDefaultRunner"> &
  Partial<Pick<Kernel, "roleModelSettings" | "setRoleModel" | "effectiveRunnerForRole">>;

export function createModelSwitch(kernel: ModelSwitchKernel): ModelSwitch {
  const settings = (engine?: RunnerDTO) => kernel.modelSettings(engine);

  function buildDto(active: ModelSettings): ModelsDTO {
    const primary = catalogDto(active);
    const catalogs: Partial<Record<RunnerDTO, RunnerCatalogDTO>> = { [primary.engine]: primary };
    for (const r of kernel.cliRunners) {
      if (r === primary.engine) continue;
      const ms = settings(r);
      if (ms) catalogs[r] = catalogDto(ms);
    }
    const roles = kernel.roleModelSettings ? kernel.roleModelSettings() : emptyRoles();
    const effectiveRoles = emptyEffectiveRoles();
    for (const role of CELL_ROLES) {
      if (kernel.effectiveRunnerForRole) {
        const eff = kernel.effectiveRunnerForRole(role);
        effectiveRoles[role] = eff ? { runner: eff.runner, choice: eff.choice, inherited: eff.source !== "role" } : null;
      } else {
        const tier: ModelTier = role === "checker" || role === "sensor" ? "fast" : "strong";
        effectiveRoles[role] = { runner: primary.engine, choice: primary.effective[tier], inherited: true };
      }
    }
    return {
      available: true,
      engine: primary.engine,
      runners: kernel.cliRunners,
      models: primary.models,
      recommended: primary.recommended,
      recommendedFast: primary.recommendedFast,
      fetchedAt: primary.fetchedAt,
      error: primary.error,
      selection: primary.selection,
      effective: primary.effective,
      catalogs,
      roles,
      effectiveRoles,
    };
  }

  async function view(opts: { refresh?: boolean } = {}): Promise<ModelsDTO> {
    const s = settings();
    if (!s) return NONE;
    const targets = new Map<RunnerDTO, ModelSettings>([[s.engine, s]]);
    for (const r of kernel.cliRunners) {
      const ms = settings(r);
      if (ms) targets.set(r, ms);
    }
    await Promise.all([...targets.values()].map((ms) => ms.catalog(opts.refresh ? { refresh: true } : { cooldown: true }).catch(() => undefined)));
    return buildDto(settings() ?? s);
  }

  return {
    view,
    async set(req) {
      const s = settings();
      // Messages here are shown to the owner as they are (the panel prints them under the select).
      if (!s) throw new NgError("unsupported", "当前不是由 CLI Agent 驱动，没有可切换的模型");
      if (!req || typeof req !== "object") throw new NgError("invalid_argument", "请提供 runner 或模型设置");
      if ("role" in req) {
        if (!kernel.setRoleModel) throw new NgError("unsupported", "当前环境不支持按层级配置模型");
        const role = req.role as CellRole;
        if (!(CELL_ROLES as readonly string[]).includes(role)) {
          throw new NgError("invalid_argument", `未知层级「${String(req.role)}」（可选：${CELL_ROLES.join(", ")}）`);
        }
        if (req.mode === "inherit") {
          kernel.setRoleModel(role, { mode: "inherit" });
          return buildDto(settings() ?? s);
        }
        if (req.mode !== "custom") {
          throw new NgError("invalid_argument", 'mode 必须是 "inherit" 或 "custom"');
        }
        if (typeof req.runner !== "string" || !kernel.cliRunners.includes(req.runner)) {
          throw new NgError("invalid_argument", `Runner「${String(req.runner)}」未启用。可选：${kernel.cliRunners.join(", ") || "无"}`);
        }
        const target = settings(req.runner);
        await target?.catalog().catch(() => null);
        const model = typeof req.model === "string" && req.model.trim() ? req.model.trim() : undefined;
        const effort = typeof req.effort === "string" && req.effort.trim() ? req.effort.trim() : undefined;
        const next: RoleModelSelection = { mode: "custom", runner: req.runner, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
        kernel.setRoleModel(role, next);
        return buildDto(settings() ?? s);
      }
      if ("runner" in req) {
        if (typeof req.runner !== "string") throw new NgError("invalid_argument", "请选择已启用的 runner");
        kernel.setDefaultRunner(req.runner);
        return view();
      }
      if (!TIERS.includes(req.tier)) throw new NgError("invalid_argument", "tier 必须是 strong（主力）或 fast（轻量）");
      if (req.engine !== undefined && req.engine !== s.engine) throw new NgError("conflict", "默认 runner 已切换，请核对模型后重试");
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
      if (req.engine !== undefined && settings()?.engine !== s.engine) throw new NgError("conflict", "默认 runner 已切换，请核对模型后重试");
      s.select(req.tier, sel);
      return buildDto(settings() ?? s);
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
