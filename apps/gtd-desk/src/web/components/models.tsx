import { useEffect, useId, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  relativeTimeZh,
  type CellRoleDTO,
  type ModelChoiceDTO,
  type ModelSelectionDTO,
  type ModelsDTO,
  type ModelTierDTO,
  type RoleModelSelectionDTO,
  type RunnerDTO,
  type SetModelRequest,
  type SetRoleModelRequest,
  type StatusDTO,
  type UpdateModelsRequest,
} from "../../shared/api";
import { api } from "../api";
import { toFailure, useNow, useRefresh, useResource } from "../state";
import { whenText } from "../text";
import { Chevron, Spinner, useOutsidePress } from "./controls";
import { ErrorState, Loading } from "./states";

// The owner's model switch (CLI backends). Which models exist and which one the CLI recommends come from the server,
// which asks each enabled CLI itself: nothing here names a model or an effort level.

const TIERS: Array<{ key: ModelTierDTO; label: string }> = [
  { key: "strong", label: "主力（总助理、项目、中枢、执行分身默认）" },
  { key: "fast", label: "轻量（外部盯梢、信源巡检默认）" },
];

const ROLES: Array<{ key: CellRoleDTO; label: string; hint: string; tier: ModelTierDTO }> = [
  { key: "desk", label: "总助理", hint: "对话分拣、全局仲裁", tier: "strong" },
  { key: "project", label: "项目协调", hint: "规划阶段、派工验收", tier: "strong" },
  { key: "worker", label: "执行分身", hint: "写代码、跑测试、调研", tier: "strong" },
  { key: "hub", label: "领域中枢", hint: "专题消息路由", tier: "strong" },
  { key: "checker", label: "外部盯梢", hint: "检查 MR / CI / 条件", tier: "fast" },
  { key: "sensor", label: "信源巡检", hint: "定时观察与过滤", tier: "fast" },
];

/** Select values that are not a model id / an effort the CLI listed. */
const AUTO = "";
const INHERIT = "";
const DEFAULT_EFFORT = "";
const RUNNER_NAMES: Record<RunnerDTO, string> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };

/** "Opus 5.5 · xhigh" */
function choiceText(c: ModelChoiceDTO | null | undefined): string | null {
  if (!c) return null;
  return c.effort ? `${c.label} · ${c.effort}` : c.label;
}

/** The top bar's model label: a button that opens the switch. */
export function ModelSwitch({ status }: { status: StatusDTO }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useOutsidePress(open, wrap, () => setOpen(false));

  const onKey = (e: ReactKeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    // Keys typed in the open panel are for it, not for the view's shortcuts.
    e.stopPropagation();
  };
  const onBlur = (e: ReactFocusEvent) => {
    // Tabbing out of the panel closes it (focus that goes nowhere, e.g. to another window, does not).
    if (open && e.relatedTarget instanceof Node && !wrap.current?.contains(e.relatedTarget)) setOpen(false);
  };

  return (
    <div className="model-switch" ref={wrap} onKeyDown={onKey} onBlur={onBlur}>
      <button
        ref={trigger}
        type="button"
        className="model-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`模型：${status.model ? `${status.backend} · ${status.model}` : status.backend}（切换）`}
        title={`处理事项的 Agent：${status.backend}${status.model ? `，模型 ${status.model}` : ""}（点击配置 Runner 与各层级默认模型）`}
        onClick={() => setOpen((o) => !o)}
      >
        {status.model && <span className="mt-backend">{status.backend}</span>}
        <span className="mt-model">{status.model ?? status.backend}</span>
        <span className="mt-short">模型</span>
        <Chevron open={open} />
      </button>
      {open && <ModelPanel id={panelId} />}
    </div>
  );
}

type Busy = ModelTierDTO | `role:${CellRoleDTO}` | "runner" | "refresh";

function ModelPanel({ id }: { id: string }) {
  const res = useResource<ModelsDTO>("models", () => api.models(), ["models"]);
  const { bump } = useRefresh();
  const now = useNow();
  const [busy, setBusy] = useState<Busy | null>(null);
  // The selection being saved, shown at once so the select does not jump back while the request runs.
  const [pendingTier, setPendingTier] = useState<{ tier: ModelTierDTO; selection: ModelSelectionDTO } | null>(null);
  const [pendingRole, setPendingRole] = useState<{ role: CellRoleDTO; selection: RoleModelSelectionDTO } | null>(null);
  const [failure, setFailure] = useState<{ where: Busy; message: string } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => panel.current?.focus(), []);

  const save = async (req: UpdateModelsRequest) => {
    if (busy) return;
    const where: Busy = "role" in req ? `role:${req.role}` : "runner" in req ? "runner" : req.tier;
    setBusy(where);
    if ("role" in req) {
      const sel: RoleModelSelectionDTO = req.mode === "inherit"
        ? { mode: "inherit" }
        : { mode: "custom", runner: req.runner, ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}) };
      setPendingRole({ role: req.role, selection: sel });
    } else if ("tier" in req) {
      setPendingTier({ tier: req.tier, selection: req });
    }
    setFailure(null);
    try {
      const engine = res.data?.engine;
      const payload = "tier" in req && engine ? { ...req, engine } : req;
      res.set(await api.setModel(payload));
      bump(["status", "agents"]);
    } catch (err) {
      setFailure({ where, message: toFailure(err).message });
    } finally {
      setBusy(null);
      setPendingTier(null);
      setPendingRole(null);
    }
  };

  const refresh = async () => {
    if (busy) return;
    setBusy("refresh");
    setFailure(null);
    try {
      res.set(await api.models(true));
      bump(["status", "agents"]);
    } catch (err) {
      setFailure({ where: "refresh", message: toFailure(err).message });
    } finally {
      setBusy(null);
    }
  };

  const m = res.data;
  const customRoleCount = m ? ROLES.filter((r) => m.roles?.[r.key]?.mode === "custom").length : 0;

  return (
    <div className="model-panel" id={id} role="dialog" aria-label="Runner 与模型默认配置" ref={panel} tabIndex={-1}>
      <div className="mp-head">
        <h2>Runner 与模型默认配置</h2>
        {m?.available && (
          <button type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === "refresh"} onClick={() => void refresh()} title="重新向所有已启用的 CLI 询问可用模型">
            {busy === "refresh" && <Spinner />}刷新列表
          </button>
        )}
      </div>
      {!m ? (
        res.error && !res.loading ? (
          <ErrorState error={res.error} onRetry={res.reload} title="模型列表没能载入" />
        ) : (
          <Loading label="正在向 CLI 询问可用的模型…" />
        )
      ) : !m.available ? (
        <p className="mp-none">当前的 Agent 不是由 CLI Agent 运行的，没有可切换的模型。</p>
      ) : (
        <>
          <p className="mp-meta" title={m.fetchedAt ? whenText(m.fetchedAt, now) : undefined}>
            已启用 Runner：{m.runners.map((r) => RUNNER_NAMES[r]).join("、")}
            {m.fetchedAt ? ` · ${relativeTimeZh(m.fetchedAt, now)}更新` : " · 还没拿到列表"}
          </p>
          {failure?.where === "refresh" && (
            <p className="mp-error" role="alert">
              刷新失败：{failure.message}
            </p>
          )}

          <section className="mp-section">
            <h3 className="mp-sec-title">全局默认（未单独配置层级的兜底）</h3>
            <label className="field">
              <span>默认 Runner {busy === "runner" && <Spinner label="正在切换" />}</span>
              <select
                value={m.engine ?? ""}
                disabled={busy !== null || m.runners.length < 2}
                onChange={(e) => {
                  const runner = m.runners.find((option) => option === e.target.value);
                  if (runner) void save({ runner });
                }}
              >
                {m.runners.map((runner) => (
                  <option key={runner} value={runner}>
                    {RUNNER_NAMES[runner]}
                  </option>
                ))}
              </select>
            </label>
            {failure?.where === "runner" && <p className="mp-error" role="alert">{failure.message}</p>}
            {m.error && (
              <p className="mp-warn" role="alert">
                没能向 {m.engine} 询问模型列表：{m.error}
                {m.models.length > 0 ? "（先沿用上次的列表）" : ""}
              </p>
            )}
            {TIERS.map((t) => (
              <TierSettings
                key={t.key}
                tier={t.key}
                label={t.label}
                m={m}
                selection={pendingTier?.tier === t.key ? pendingTier.selection : m.selection[t.key]}
                busy={busy === t.key}
                disabled={busy !== null}
                error={failure?.where === t.key ? failure.message : null}
                onSave={(req) => void save(req)}
              />
            ))}
          </section>

          <section className="mp-section">
            <div className="mp-sec-head">
              <h3 className="mp-sec-title">
                按层级默认
                {customRoleCount > 0 && <span className="mp-badge on">{customRoleCount} 个自定义</span>}
              </h3>
            </div>
            <p className="mp-hint">可为每个层级单独指定默认 Runner、模型和推理强度；未指定的层级跟随上方全局默认。</p>
            <div className="mp-roles">
              {ROLES.map((r) => (
                <RoleSettings
                  key={r.key}
                  role={r.key}
                  label={r.label}
                  hint={r.hint}
                  tier={r.tier}
                  m={m}
                  selection={pendingRole?.role === r.key ? pendingRole.selection : (m.roles?.[r.key] ?? { mode: "inherit" })}
                  busy={busy === `role:${r.key}`}
                  disabled={busy !== null}
                  error={failure?.where === `role:${r.key}` ? failure.message : null}
                  onSave={(req) => void save(req)}
                />
              ))}
            </div>
          </section>

          <p className="mp-note">新建节点未显式指定参数时按层级默认启动；已有未固定参数的节点从下次运行开始生效，正在进行的工作不会被打断。</p>
        </>
      )}
    </div>
  );
}

function TierSettings(props: {
  tier: ModelTierDTO;
  label: string;
  m: ModelsDTO;
  selection: ModelSelectionDTO;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onSave(req: SetModelRequest): void;
}) {
  const { tier, m, selection } = props;
  const headId = useId();
  const fixed = selection.mode === "fixed" ? selection : null;
  const info = fixed ? m.models.find((x) => x.id === fixed.model) : undefined;
  const efforts = info?.efforts ?? [];
  const effective = m.effective[tier];
  const recommended = choiceText(m.recommended);
  // Auto is not the same for both tiers: the fast one runs on a lighter choice picked from the CLI's list.
  const autoChoice = tier === "fast" ? choiceText(m.recommendedFast ?? null) : recommended;
  const autoText = !autoChoice
    ? "自动（跟随 CLI 的默认）"
    : tier === "fast"
      ? `自动（轻快：${autoChoice}）`
      : `自动（推荐：${autoChoice}）`;
  const autoTitle =
    tier === "fast" ? "CLI 的列表里有轻量快速的模型时用它，推理强度取中档；没有时用 CLI 推荐的模型，但调低推理强度" : undefined;
  const description = m.models.find((x) => x.id === (fixed?.model ?? effective?.model))?.description;
  // A fixed model without an effort runs at the effort the server prefers for it; the effective choice names it.
  const defaultEffort = fixed && !fixed.effort && effective?.model === fixed.model ? effective.effort : undefined;

  return (
    <section className="mp-tier" aria-labelledby={headId} aria-busy={props.busy}>
      <h4 id={headId}>
        {props.label}
        {props.busy && <Spinner label="正在保存" />}
      </h4>
      <div className={`mp-row${fixed && efforts.length > 0 ? "" : " single"}`}>
        <label className="field">
          <span>模型</span>
          <select
            value={fixed ? fixed.model : AUTO}
            disabled={props.disabled}
            onChange={(e) => {
              const v = e.target.value;
              props.onSave(v === AUTO ? { tier, mode: "auto" } : { tier, mode: "fixed", model: v });
            }}
          >
            <option value={AUTO} title={autoTitle}>
              {autoText}
            </option>
            {fixed && !info && <option value={fixed.model}>{fixed.model}（不在当前列表里）</option>}
            {m.models.map((x) => (
              <option key={x.id} value={x.id} title={x.description}>
                {x.label}
                {x.id === m.recommended?.model ? "（CLI 推荐）" : ""}
              </option>
            ))}
          </select>
        </label>
        {fixed && efforts.length > 0 && (
          <label className="field">
            <span>推理强度</span>
            <select
              value={fixed.effort ?? DEFAULT_EFFORT}
              disabled={props.disabled}
              onChange={(e) => {
                const effort = e.target.value;
                props.onSave({ tier, mode: "fixed", model: fixed.model, ...(effort !== DEFAULT_EFFORT ? { effort } : {}) });
              }}
            >
              <option value={DEFAULT_EFFORT}>{defaultEffort ? `默认（${defaultEffort}）` : "默认"}</option>
              {fixed.effort && !efforts.includes(fixed.effort) && <option value={fixed.effort}>{fixed.effort}</option>}
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {description && <p className="mp-desc">{description}</p>}
      <p className="mp-effective">
        兜底生效：<strong>{choiceText(effective) ?? "CLI 自己的默认模型"}</strong>
      </p>
      {props.error && (
        <p className="mp-error" role="alert">
          没能切换：{props.error}
        </p>
      )}
    </section>
  );
}

function RoleSettings(props: {
  role: CellRoleDTO;
  label: string;
  hint: string;
  tier: ModelTierDTO;
  m: ModelsDTO;
  selection: RoleModelSelectionDTO;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onSave(req: SetRoleModelRequest): void;
}) {
  const { role, tier, m, selection } = props;
  const custom = selection.mode === "custom" ? selection : null;
  const cat = custom ? m.catalogs?.[custom.runner] : undefined;
  const models = cat?.models ?? [];
  const fixedModelId = custom?.model;
  const autoEffective = cat?.effective[tier] ?? null;
  const activeModelId = fixedModelId ?? autoEffective?.model;
  const modelInfo = activeModelId ? models.find((x) => x.id === activeModelId) : undefined;
  const efforts = modelInfo?.efforts ?? [];
  const effectiveRole = m.effectiveRoles?.[role] ?? null;
  const effectiveSummary = effectiveRole
    ? `${RUNNER_NAMES[effectiveRole.runner]}${effectiveRole.choice ? ` · ${choiceText(effectiveRole.choice)}` : ""}`
    : "CLI 默认";
  const autoModelText = autoEffective ? `自动（${choiceText(autoEffective)}）` : "自动（跟随该 Runner 默认）";
  const defaultEffort = !custom?.effort && effectiveRole?.choice?.model === activeModelId ? effectiveRole?.choice?.effort : undefined;

  return (
    <div className={`mp-role${custom ? " custom" : ""}`} aria-busy={props.busy}>
      <div className="mp-role-head">
        <div className="mp-role-title">
          <strong>{props.label}</strong>
          <span className="mp-role-hint">{props.hint}</span>
          {props.busy && <Spinner label="正在保存" />}
        </div>
        <span className={`mp-badge${custom ? " on" : ""}`} title={`下次运行：${effectiveSummary}`}>
          {effectiveSummary}
        </span>
      </div>
      <div className={`mp-role-row${custom ? (efforts.length > 0 ? " cols-3" : " cols-2") : " cols-1"}`}>
        <label className="field">
          <span>Runner</span>
          <select
            aria-label={`${props.label} Runner`}
            value={custom ? custom.runner : INHERIT}
            disabled={props.disabled}
            onChange={(e) => {
              const v = e.target.value;
              if (v === INHERIT) {
                props.onSave({ role, mode: "inherit" });
                return;
              }
              const runner = m.runners.find((r) => r === v);
              if (runner) props.onSave({ role, mode: "custom", runner });
            }}
          >
            <option value={INHERIT}>跟随全局默认</option>
            {m.runners.map((r) => (
              <option key={r} value={r}>
                {RUNNER_NAMES[r]}
              </option>
            ))}
          </select>
        </label>
        {custom && (
          <label className="field">
            <span>模型</span>
            <select
              aria-label={`${props.label} 模型`}
              value={fixedModelId ?? AUTO}
              disabled={props.disabled}
              onChange={(e) => {
                const v = e.target.value;
                props.onSave(v === AUTO ? { role, mode: "custom", runner: custom.runner } : { role, mode: "custom", runner: custom.runner, model: v });
              }}
            >
              <option value={AUTO}>{autoModelText}</option>
              {fixedModelId && !models.some((x) => x.id === fixedModelId) && (
                <option value={fixedModelId}>{fixedModelId}（不在当前列表里）</option>
              )}
              {models.map((x) => (
                <option key={x.id} value={x.id} title={x.description}>
                  {x.label}
                  {x.id === cat?.recommended?.model ? "（推荐）" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {custom && efforts.length > 0 && (
          <label className="field">
            <span>推理强度</span>
            <select
              aria-label={`${props.label} 推理强度`}
              value={custom.effort ?? DEFAULT_EFFORT}
              disabled={props.disabled}
              onChange={(e) => {
                const effort = e.target.value;
                props.onSave({
                  role,
                  mode: "custom",
                  runner: custom.runner,
                  ...(fixedModelId ? { model: fixedModelId } : {}),
                  ...(effort !== DEFAULT_EFFORT ? { effort } : {}),
                });
              }}
            >
              <option value={DEFAULT_EFFORT}>{defaultEffort ? `默认（${defaultEffort}）` : "默认"}</option>
              {custom.effort && !efforts.includes(custom.effort) && <option value={custom.effort}>{custom.effort}</option>}
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {custom && cat?.error && (
        <p className="mp-warn" role="alert">
          {RUNNER_NAMES[custom.runner]} 模型列表加载失败：{cat.error}
        </p>
      )}
      {props.error && (
        <p className="mp-error" role="alert">
          没能保存：{props.error}
        </p>
      )}
    </div>
  );
}
