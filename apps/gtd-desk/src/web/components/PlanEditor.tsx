import { useState, useEffect, useRef } from "react";
import {
  BALL_LABEL,
  EFFORT_LABELS,
  type BallOwner,
  type Effort,
  type ArtifactDTO,
  type ModelsDTO,
  type PlanSaveResponse,
  type HumanItemDTO,
  type RunnerDTO,
} from "../../shared/api";
import { api } from "../api";
import { useResource, useStatus, useToast, toFailure } from "../state";
import { Spinner } from "./controls";

const RUNNER_NAMES: Record<RunnerDTO, string> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };

interface PlanForm {
  title: string;
  outcome: string;
  background: string;
  runner: RunnerDTO | "";
  model: string;
  effort: string;
  actions: Array<{ title: string; owner: BallOwner; effort: Effort | ""; nextStep: string }>;
}

function formOf(p: NonNullable<HumanItemDTO["proposal"]>): PlanForm {
  return {
    title: p.title,
    outcome: p.outcome,
    background: p.background ?? "",
    runner: p.runnerOverride?.engine ?? "",
    model: p.runnerOverride?.model ?? "",
    effort: p.runnerOverride?.effort ?? "",
    actions: p.actions.map((a) => ({ title: a.title, owner: a.owner, effort: a.effort ?? "", nextStep: a.nextStep ?? "" })),
  };
}

const unsavedPlans = new Map<string, {initial: PlanForm; form: PlanForm; version: number | null; artifactId: string}>();
const warnAboutPlan = (e: BeforeUnloadEvent) => { if (unsavedPlans.size) e.preventDefault(); };
function forgetPlan(id: string) {
  unsavedPlans.delete(id);
  if (!unsavedPlans.size) window.removeEventListener("beforeunload", warnAboutPlan);
}

export function hasUnsavedPlan(id: string): boolean { return unsavedPlans.has(id); }
export function retainUnsavedPlans(openArtifacts: string[], editing: string | null) {
  const open = new Set(openArtifacts);
  for (const [id, draft] of unsavedPlans)
    if (id !== editing && !open.has(draft.artifactId)) forgetPlan(id);
}

const OWNERS: BallOwner[] = ["human", "agent", "waiting"];
const EFFORTS: Effort[] = ["15m", "45m", "low_energy"];

/** "✎ 手动改一下安排": edits the plan in place; saved with the version it was opened on (409 keeps the form). */
export function PlanEditor(props: {
  item: HumanItemDTO;
  onClose(): void;
  onSaved(r: PlanSaveResponse): void;
  reloadItem(): Promise<HumanItemDTO | undefined>;
}) {
  const card = props.item;
  const toast = useToast();
  const { setStatus } = useStatus();
  const modelsRes = useResource<ModelsDTO>("models", () => api.models(), ["models"]);
  const [seed] = useState(() => unsavedPlans.get(card.id));
  const [initial] = useState(() => seed?.initial ?? formOf(card.proposal!));
  const [form, setForm] = useState<PlanForm>(seed?.form ?? initial);
  const [expected] = useState(seed ? seed.version : card.artifactVersion);
  const [conflict, setConflict] = useState<{ artifact: ArtifactDTO; proposal: HumanItemDTO["proposal"] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useEffect(() => {
    if (!dirty) { forgetPlan(card.id); return; }
    unsavedPlans.set(card.id, {initial, form, version: expected, artifactId: card.artifact!.artifactId});
    window.addEventListener("beforeunload", warnAboutPlan);
  }, [dirty, card.id, initial, form, expected]);
  function discard() {
    forgetPlan(card.id);
    props.onClose();
  }

  async function loadComparison() {
    setError(null);
    const remote = await props.reloadItem();
    if (!remote?.artifact || !remote.proposal || remote.artifact.artifactId !== card.artifact?.artifactId) {
      setError("这份方案已不在待办中，你的修改仍在下方。");
      return;
    }
    const baseline = { artifact: remote.artifact, proposal: remote.proposal };
    setConflict(cur => cur && cur.artifact.version > baseline.artifact.version ? cur : baseline);
  }

  const moved = card.artifactVersion !== null && expected !== null && card.artifactVersion > expected && !conflict;

  const save = async (version: number | null) => {
    if (saveInFlight.current) return;
    if (version === null) {
      setError("这张卡的方案没有可保存的版本");
      return;
    }
    const actions = form.actions.filter((a) => a.title.trim());
    if (!form.outcome.trim()) {
      setError("请写下完成的样子");
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const runnerOverride = form.runner
        ? {
            engine: form.runner,
            ...(form.model ? { model: form.model } : {}),
            ...(form.model && form.effort ? { effort: form.effort } : {}),
          }
        : null;
      const r = await api.savePlan(card.id, {
        expectedVersion: version,
        proposal: {
          ...(form.title.trim() && {title: form.title.trim()}),
          outcome: form.outcome.trim(),
          background: form.background.trim(),
          ...(modelsRes.data?.available ? { runnerOverride } : {}),
          actions: actions.map((a) => ({
            title: a.title.trim(),
            owner: a.owner,
            ...(a.effort ? { effort: a.effort } : {}),
            ...(a.nextStep.trim() ? { nextStep: a.nextStep.trim() } : {}),
          })),
        },
      });
      if (r.outcome === "conflict") {
        setConflict({ artifact: r.current, proposal: null });
        await loadComparison();
        return;
      }
      setStatus(r.deskStatus);
      forgetPlan(card.id);
      props.onSaved(r);
    } catch (err) {
      const f = toFailure(err);
      setError(f.message);
      toast({ tone: "error", text: f.message });
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const setAction = (i: number, patch: Partial<PlanForm["actions"][number]>) =>
    setForm((f) => ({ ...f, actions: f.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) }));

  return (
    <form
      className="plan-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!conflict) void save(expected);
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          if (!saving && !conflict) void save(expected);
        }
        if (e.key === "Escape") {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) { e.stopPropagation(); return; }
          e.preventDefault();
          e.stopPropagation();
          if (!dirty || window.confirm("放弃这次对方案的修改？")) discard();
        }
      }}
    >
      <div className="plan-head">
        <h3 className="block-label">手动改一下安排</h3>
        {expected !== null && <span className="draft-version">基于 v{expected}</span>}
      </div>

      {moved && (
        <div className="banner warn" role="status">
          方案已在后台更新到 v{card.artifactVersion}。你可以继续编辑，保存时会显示两个版本供你对照。
        </div>
      )}
      {conflict && (
        <div className="banner conflict" role="alert">
          <div>
            <strong>
              方案在你编辑时已更新到 v{conflict.artifact.version}，由{conflict.artifact.updatedByLabel}修改。
            </strong>
            <span>你的修改仍在下方。请对照最新方案后保存。</span>
          </div>
          {conflict.proposal && (
            <details className="theirs-plan" open>
              <summary>看 v{conflict.artifact.version} 的方案</summary>
              <strong>{conflict.proposal.title}</strong>
              <p>{conflict.proposal.outcome}</p>
              {conflict.proposal.background && <p>{conflict.proposal.background}</p>}
              <ul>{conflict.proposal.actions.map((a, i) => <li key={i}>{a.title} · {BALL_LABEL[a.owner]}
                {a.effort && ` · ${EFFORT_LABELS[a.effort]}`}{a.nextStep && ` · ${a.nextStep}`}
              </li>)}</ul>
            </details>
          )}
          <div className="banner-actions">
            <button type="button" className="btn sm ghost" onClick={discard}>
              放弃我的修改
            </button>
            {conflict.proposal ? (
              <button type="button" className="btn sm primary" disabled={saving} onClick={() => void save(conflict.artifact.version)}>
                按我的修改保存为 v{conflict.artifact.version + 1}
              </button>
            ) : (
              <button type="button" className="btn sm ghost" disabled={saving}
                onClick={() => { void loadComparison().catch(err => setError(toFailure(err).message)); }}>
                重新读取最新方案
              </button>
            )}
          </div>
        </div>
      )}

      <label className="field">
        <span>项目名称</span>
        <input disabled={saving} ref={firstRef} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </label>
      <label className="field">
        <span>完成的样子</span>
        <textarea disabled={saving} rows={2} value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} />
      </label>
      <label className="field">
        <span>背景（可选）</span>
        <textarea disabled={saving} rows={2} value={form.background} onChange={(e) => setForm({ ...form, background: e.target.value })} />
      </label>

      {modelsRes.data?.available && (() => {
        const md = modelsRes.data;
        const cat = form.runner ? md.catalogs?.[form.runner] : undefined;
        const models = cat?.models ?? [];
        const modelInfo = form.model ? models.find((x) => x.id === form.model) : undefined;
        const efforts = modelInfo?.efforts ?? [];
        return (
          <fieldset disabled={saving} className="plan-runner">
            <legend>项目 Runner（新建项目用，可选）</legend>
            <div className={`mp-role-row${form.runner ? (form.model && efforts.length > 0 ? " cols-3" : " cols-2") : " cols-1"}`}>
              <label className="field">
                <span>Runner</span>
                <select
                  value={form.runner}
                  onChange={(e) => {
                    const next = md.runners.find((r) => r === e.target.value) ?? "";
                    setForm({ ...form, runner: next, model: "", effort: "" });
                  }}
                >
                  <option value="">跟随「项目协调」默认</option>
                  {md.runners.map((r) => (
                    <option key={r} value={r}>
                      {RUNNER_NAMES[r]}
                    </option>
                  ))}
                </select>
              </label>
              {form.runner && (
                <label className="field">
                  <span>模型</span>
                  <select
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value, effort: "" })}
                  >
                    <option value="">自动（跟随该 Runner 默认）</option>
                    {form.model && !modelInfo && <option value={form.model}>{form.model}</option>}
                    {models.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {form.runner && form.model && efforts.length > 0 && (
                <label className="field">
                  <span>推理强度</span>
                  <select
                    value={form.effort}
                    onChange={(e) => setForm({ ...form, effort: e.target.value })}
                  >
                    <option value="">默认</option>
                    {form.effort && !efforts.includes(form.effort) && <option value={form.effort}>{form.effort}</option>}
                    {efforts.map((ef) => (
                      <option key={ef} value={ef}>
                        {ef}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </fieldset>
        );
      })()}

      <fieldset disabled={saving} className="plan-edit-actions">
        <legend>推进安排</legend>
        {form.actions.map((a, i) => (
          <div className="plan-edit-row" data-owner={a.owner} key={i}>
            <input
              aria-label={`动作 ${i + 1}`}
              placeholder="要做的事"
              value={a.title}
              onChange={(e) => setAction(i, { title: e.target.value })}
            />
            <select aria-label={`动作 ${i + 1} 由谁推进`} value={a.owner} onChange={(e) => setAction(i, { owner: e.target.value as BallOwner })}>
              {OWNERS.map((o) => (
                <option key={o} value={o}>
                  {BALL_LABEL[o]}
                </option>
              ))}
            </select>
            <select
              aria-label={`动作 ${i + 1} 需要的时间`}
              value={a.effort}
              onChange={(e) => setAction(i, { effort: e.target.value as Effort | "" })}
            >
              <option value="">不限时间</option>
              {EFFORTS.map((x) => (
                <option key={x} value={x}>
                  {EFFORT_LABELS[x]}
                </option>
              ))}
            </select>
            <input
              className="wide"
              aria-label={`动作 ${i + 1} 的下一步`}
              placeholder="具体下一步（可选）"
              value={a.nextStep}
              onChange={(e) => setAction(i, { nextStep: e.target.value })}
            />
            <button
              type="button"
              className="btn sm ghost"
              aria-label={`删掉动作 ${i + 1}`}
              onClick={() => setForm((f) => ({ ...f, actions: f.actions.filter((_, j) => j !== i) }))}
            >
              删掉
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => setForm((f) => ({ ...f, actions: [...f.actions, { title: "", owner: "human", effort: "", nextStep: "" }] }))}
        >
          ＋ 加一个动作
        </button>
      </fieldset>

      {error && (
        <p className="draft-message error" role="alert">
          {error}
        </p>
      )}
      <div className="plan-editor-foot">
        <button type="button" className="btn" onClick={discard}>
          取消
        </button>
        <button type="submit" className="btn primary" disabled={saving || conflict !== null}>
          {saving && <Spinner />}
          保存方案
        </button>
      </div>
    </form>
  );
}
