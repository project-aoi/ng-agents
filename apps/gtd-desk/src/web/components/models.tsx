import { useEffect, useId, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { relativeTimeZh, type ModelChoiceDTO, type ModelSelectionDTO, type ModelsDTO, type ModelTierDTO, type RunnerDTO, type SetModelRequest, type SetRunnerRequest, type StatusDTO } from "../../shared/api";
import { api } from "../api";
import { toFailure, useNow, useRefresh, useResource } from "../state";
import { whenText } from "../text";
import { Chevron, Spinner, useOutsidePress } from "./controls";
import { ErrorState, Loading } from "./states";

// The owner's model switch (CLI backends). Which models exist and which one the CLI recommends come from the server,
// which asks the CLI itself: nothing here names a model or an effort level.

const TIERS: Array<{ key: ModelTierDTO; label: string }> = [
  { key: "strong", label: "主力（主台、项目、分身）" },
  { key: "fast", label: "轻量（监听、信源）" },
];

/** Select values that are not a model id / an effort the CLI listed. */
const AUTO = "";
const DEFAULT_EFFORT = "";
const RUNNER_NAMES: Record<RunnerDTO, string> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };

/** "Opus 5.5 · xhigh" */
function choiceText(c: ModelChoiceDTO | null): string | null {
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
        title={`处理事项的 Agent：${status.backend}${status.model ? `，模型 ${status.model}` : ""}（点击切换模型）`}
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

type Busy = ModelTierDTO | "runner" | "refresh";

function ModelPanel({ id }: { id: string }) {
  const res = useResource<ModelsDTO>("models", () => api.models(), ["models"]);
  const { bump } = useRefresh();
  const now = useNow();
  const [busy, setBusy] = useState<Busy | null>(null);
  // The selection being saved, shown at once so the select does not jump back while the request runs.
  const [pending, setPending] = useState<{ tier: ModelTierDTO; selection: ModelSelectionDTO } | null>(null);
  const [failure, setFailure] = useState<{ where: Busy; message: string } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => panel.current?.focus(), []);

  const save = async (req: SetModelRequest | SetRunnerRequest) => {
    if (busy) return;
    const where = "runner" in req ? "runner" : req.tier;
    setBusy(where);
    if ("tier" in req) setPending({ tier: req.tier, selection: req });
    setFailure(null);
    try {
      const engine = res.data?.engine;
      res.set(await api.setModel("tier" in req && engine ? { ...req, engine } : req));
      bump(["status", "agents"]);
    } catch (err) {
      setFailure({ where, message: toFailure(err).message });
    } finally {
      setBusy(null);
      setPending(null);
    }
  };

  const refresh = async () => {
    if (busy) return;
    setBusy("refresh");
    setFailure(null);
    try {
      res.set(await api.models(true));
      bump(["status"]);
    } catch (err) {
      setFailure({ where: "refresh", message: toFailure(err).message });
    } finally {
      setBusy(null);
    }
  };

  const m = res.data;
  return (
    <div className="model-panel" id={id} role="dialog" aria-label="模型" ref={panel} tabIndex={-1}>
      <div className="mp-head">
        <h2>默认 Runner 和模型</h2>
        {m?.available && (
          <button type="button" className="btn sm" disabled={busy !== null} aria-busy={busy === "refresh"} onClick={() => void refresh()} title="重新向 CLI 询问可用的模型">
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
              {m.runners.map((runner) => <option key={runner} value={runner}>{RUNNER_NAMES[runner]}</option>)}
            </select>
          </label>
          {failure?.where === "runner" && <p className="mp-error" role="alert">{failure.message}</p>}
          <p className="mp-meta" title={m.fetchedAt ? whenText(m.fetchedAt, now) : undefined}>
            {m.engine} 列出的模型 · {m.fetchedAt ? `${relativeTimeZh(m.fetchedAt, now)}更新` : "还没拿到列表"}
          </p>
          {m.error && (
            <p className="mp-warn" role="alert">
              没能向 CLI 询问模型列表：{m.error}
              {m.models.length > 0 ? "（先沿用上次的列表）" : ""}
            </p>
          )}
          {failure?.where === "refresh" && (
            <p className="mp-error" role="alert">
              刷新失败：{failure.message}
            </p>
          )}
          {TIERS.map((t) => (
            <TierSettings
              key={t.key}
              tier={t.key}
              label={t.label}
              m={m}
              selection={pending?.tier === t.key ? pending.selection : m.selection[t.key]}
              busy={busy === t.key}
              disabled={busy !== null}
              error={failure?.where === t.key ? failure.message : null}
              onSave={(req) => void save(req)}
            />
          ))}
          <p className="mp-note">改动从各个 Agent 的下一次运行开始生效，正在进行的工作不会被打断。</p>
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
      ? `自动（从 CLI 的列表里挑轻快的：${autoChoice}）`
      : `自动（跟随 CLI 推荐：${autoChoice}）`;
  const autoTitle =
    tier === "fast" ? "CLI 的列表里有轻量快速的模型时用它，推理强度取中档；没有时用 CLI 推荐的模型，但调低推理强度" : undefined;
  const description = m.models.find((x) => x.id === (fixed?.model ?? effective?.model))?.description;
  // A fixed model without an effort runs at the effort the server prefers for it; the effective choice names it.
  const defaultEffort = fixed && !fixed.effort && effective?.model === fixed.model ? effective.effort : undefined;

  return (
    <section className="mp-tier" aria-labelledby={headId} aria-busy={props.busy}>
      <h3 id={headId}>
        {props.label}
        {props.busy && <Spinner label="正在保存" />}
      </h3>
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
        下次运行用：<strong>{choiceText(effective) ?? "CLI 自己的默认模型"}</strong>
      </p>
      {props.error && (
        <p className="mp-error" role="alert">
          没能切换：{props.error}
        </p>
      )}
    </section>
  );
}
