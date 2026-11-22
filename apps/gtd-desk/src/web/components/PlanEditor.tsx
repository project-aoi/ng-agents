import { useState, useEffect, useRef } from "react";
import {
  BALL_LABEL,
  EFFORT_LABELS,
  type BallOwner,
  type Effort,
  type ArtifactDTO,
  type ClarifyMutationResponse,
  type HumanItemDTO,
} from "../../shared/api";
import { request } from "../api";
import { useToast, toFailure } from "../state";
import { Spinner } from "./controls";

interface PlanForm {
  title: string;
  outcome: string;
  background: string;
  actions: Array<{ title: string; owner: BallOwner; effort: Effort | ""; nextStep: string }>;
}

function formOf(p: NonNullable<HumanItemDTO["proposal"]>): PlanForm {
  return {
    title: p.title,
    outcome: p.outcome,
    background: p.background ?? "",
    actions: p.actions.map((a) => ({ title: a.title, owner: a.owner, effort: a.effort ?? "", nextStep: a.nextStep ?? "" })),
  };
}

const OWNERS: BallOwner[] = ["human", "agent", "waiting"];
const EFFORTS: Effort[] = ["15m", "45m", "low_energy"];

/** "✎ 手动改一下安排": edits the plan in place; saved with the version it was opened on (409 keeps the form). */
export function PlanEditor(props: {
  item: HumanItemDTO;
  onClose(): void;
  onSaved(r: ClarifyMutationResponse): void;
  onConflictView(r: ClarifyMutationResponse): void;
}) {
  const card = props.item;
  const toast = useToast();
  const opened = card.artifactVersion;
  const [form, setForm] = useState<PlanForm>(() => formOf(card.proposal!));
  const [expected, setExpected] = useState<number | null>(opened ?? null);
  const [conflict, setConflict] = useState<ArtifactDTO | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);

  const moved = card.artifactVersion !== null && expected !== null && card.artifactVersion > expected && !conflict;

  const save = async (version: number | null) => {
    if (version === null) {
      setError("这张卡的方案没有可保存的版本");
      return;
    }
    const actions = form.actions.filter((a) => a.title.trim());
    if (!form.outcome.trim()) {
      setError("请写下完成的样子");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await request<ClarifyMutationResponse>("PUT", `/api/clarify/${encodeURIComponent(card.id)}/plan`, {
        expectedVersion: version,
        proposal: {
          title: form.title.trim() || undefined,
          outcome: form.outcome.trim(),
          ...(form.background.trim() ? { background: form.background.trim() } : {}),
          actions: actions.map((a) => ({
            title: a.title.trim(),
            owner: a.owner,
            ...(a.effort ? { effort: a.effort } : {}),
            ...(a.nextStep.trim() ? { nextStep: a.nextStep.trim() } : {}),
          })),
        },
      });
      if (r.outcome === "conflict") {
        setConflict(r.current ?? null);
        props.onConflictView(r);
        return;
      }
      if (!r.ok) {
        setError(r.message);
        return;
      }
      props.onSaved(r);
    } catch (err) {
      const f = toFailure(err);
      setError(f.message);
      toast({ tone: "error", text: f.message });
    } finally {
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
        void save(expected);
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          if (!saving && !conflict) void save(expected);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="plan-head">
        <h3 className="block-label">手动改一下安排</h3>
        {expected !== null && <span className="draft-version">基于 v{expected}</span>}
      </div>

      {moved && (
        <div className="banner warn" role="status">
          方案已在后台更新到 v{card.artifactVersion}。你的修改还在下面；保存时会提示你合并。
        </div>
      )}
      {conflict && (
        <div className="banner conflict" role="alert">
          <div>
            <strong>
              方案在你编辑时已更新到 v{conflict.version}（{conflict.updatedByLabel}）。
            </strong>
            <span>你的修改还在下面，没有丢，也还没保存。对照最新方案后决定：</span>
          </div>
          {card.proposal && (
            <details className="theirs-plan">
              <summary>看 v{conflict.version} 的方案</summary>
              <p>
                {card.proposal.outcome} · {card.proposal.actions.map((a) => a.title).join("、")}
              </p>
            </details>
          )}
          <div className="banner-actions">
            <button type="button" className="btn sm ghost" onClick={props.onClose}>
              放弃我的修改
            </button>
            <button
              type="button"
              className="btn sm primary"
              disabled={saving}
              onClick={() => {
                setExpected(conflict.version);
                setConflict(null);
                void save(conflict.version);
              }}
            >
              按我的修改保存为 v{conflict.version + 1}
            </button>
          </div>
        </div>
      )}

      <label className="field">
        <span>项目名称</span>
        <input ref={firstRef} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </label>
      <label className="field">
        <span>完成的样子</span>
        <textarea rows={2} value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} />
      </label>
      <label className="field">
        <span>背景（可选）</span>
        <textarea rows={2} value={form.background} onChange={(e) => setForm({ ...form, background: e.target.value })} />
      </label>

      <fieldset className="plan-edit-actions">
        <legend>推进安排</legend>
        {form.actions.map((a, i) => (
          <div className="plan-edit-row" key={i}>
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
        <button type="button" className="btn" onClick={props.onClose}>
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
