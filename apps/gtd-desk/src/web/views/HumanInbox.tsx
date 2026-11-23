import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CardOption } from "@ng/protocol";
import { EFFORT_LABELS, type Effort, type HumanItemDTO as Item, type StatusDTO } from "../../shared/api";
import { References } from "../components/bits";
import { PlanEditor, hasUnsavedPlan, retainUnsavedPlans } from "../components/PlanEditor";
import { Parked } from "../components/Parked";
import { dueText } from "../text";
import { api } from "../api";
import { DraftEditor, DraftRefreshNotice, retainUnsaved, useDraft } from "../components/draft";
import { Empty, ErrorState, Loading } from "../components/states";
import { serverTimeForLocalDate, toFailure, useNavigate, useNow, useResource, useStatus, useToast, useViewKeys } from "../state";

const pool = api.humanItems;

export function HumanInbox({ cardId }: { cardId?: string | undefined }) {
  const res = useResource("human-inbox", pool, ["inbox", "radar", "status"]);
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(cardId ?? null);
  const editingItem = useRef<Item | null>(null);
  useLayoutEffect(() => {
    if (cardId) setSelectedId(cardId);
  }, [cardId]);
  const items = (res.data?.items ?? [])
    .filter(i => filter === "all" || i.category === filter || i.id === cardId)
    .sort((a, b) => b.category.localeCompare(a.category) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
  const editingFallback = editing && editingItem.current?.proposal && editingItem.current.id === editing ? editingItem.current : undefined;
  const item = items.find(i => i.id === selectedId) ?? editingFallback ?? items[0];
  useLayoutEffect(() => { if (item) setSelectedId(item.id); }, [item?.id]);
  useEffect(() => {
    if (res.data) {
      retainUnsaved(res.data.openArtifactIds);
      retainUnsavedPlans(res.data.openArtifactIds, editing);
    }
  }, [res.data, editing]);
  const focused = !!item && editing === item.id;
  const choose = (id: string) => {
    setEditing(null);
    setSelectedId(id);
    navigate({ view: "inbox", cardId: id });
  };
  useViewKeys((e) => {
    if (e.key === "Escape" && focused && !item?.proposal && !e.isComposing) {
      setEditing(null);
      return true;
    }
    if (!focused && e.key.toLowerCase() === "n" && items.length) {
      choose(items[(items.findIndex((i) => i.id === item?.id) + 1) % items.length]!.id);
      return true;
    }
    return false;
  });
  if (!res.data)
    return res.error ? <ErrorState title="待办未能载入" error={res.error} onRetry={res.reload} /> : <Loading label="正在载入待办" />;
  return (
    <div className={focused ? "human-inbox editing" : "human-inbox"}>
      {!focused && (
        <aside className="human-list">
          <div className="section-head">
            <h2>待我处理</h2>
            <select aria-label="筛选事项" value={filter} onChange={e => {
              setFilter(e.target.value);
              if (cardId) navigate({ view: "inbox" });
            }}>
              <option value="all">全部</option>
              <option value="decision">需拍板</option>
              <option value="action">待我动手</option>
            </select>
          </div>
          {[true, false].map((waiting) => {
            const group = items.filter((i) => (i.category === "decision") === waiting);
            return (
              group.length > 0 && (
                <section key={String(waiting)}>
                  <h3>{waiting ? "后台正等着" : "待我动手"}</h3>
                  {group.map((i) => (
                    <button type="button" className="inbox-row" key={i.id} aria-current={i.id === item?.id} onClick={() => choose(i.id)}>
                      <strong>{i.title}</strong>
                      {i.project && (
                        <small>
                          {i.project.title}
                          {i.project.parked ? " · 已停靠" : i.project.paused && " · 已暂停"}
                        </small>
                      )}
                    </button>
                  ))}
                </section>
              )
            );
          })}
        </aside>
      )}
      {item ? (
        <Detail
          key={item.id}
          item={item}
          focused={focused}
          toggle={() => {
            editingItem.current = focused ? null : item;
            setEditing(focused ? null : item.id);
          }}
          refresh={res.reload}
          reloadItem={async () => {
            const latest = await pool();
            res.set(latest);
            return latest.items.find(i => i.id === item.id);
          }}
        />
      ) : (
        <Empty title="待办已清空">有新的事项时会出现在这里。</Empty>
      )}
    </div>
  );
}

function Detail({
  item,
  focused,
  toggle,
  refresh,
  reloadItem,
}: {
  item: Item;
  focused: boolean;
  toggle(): void;
  refresh(): void;
  reloadItem(): Promise<Item | undefined>;
}) {
  const draft = useDraft(item.artifact);
  const now = useNow();
  const toast = useToast();
  const { setStatus } = useStatus();
  const [editingChoice, setEditingChoice] = useState<{ itemId: string; optionId: string } | null>(null);
  const [reviewedRevision, setReviewedRevision] = useState(item.itemRevision);
  const itemChanged = reviewedRevision < item.itemRevision;
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [message, setMessage] = useState("");
  const plan = item.proposal;
  const [confirm, setConfirm] = useState<{ id: string; scope: string; text: string } | null>(null);
  useEffect(() => {
    if (!focused || plan) return;
    const save = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('dialog[open], [role="dialog"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void draft?.save();
      }
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, [focused, draft, plan]);
  const [postponeTo, setPostponeTo] = useState("");
  function cancelChoice() {
    setEditingChoice(null);
    setConfirm(null);
    setNotes({});
    setPostponeTo("");
    setMessage("");
  }
  async function decide(o: CardOption) {
    if (submitting.current) return;
    if (itemChanged) {
      setMessage("请先核对最新事项");
      return;
    }
    if (o.effect === "defer" && postponeTo && !(serverTimeForLocalDate(postponeTo) > now)) {
      setMessage("请选择将来的提醒时间");
      return;
    }
    const note = notes[o.id] ?? "";
    if ((o.effect === "defer" || (o.input && o.input.mode !== "none")) && (editingChoice?.itemId !== item.id || editingChoice.optionId !== o.id)) {
      setEditingChoice({ itemId: item.id, optionId: o.id });
      setConfirm(null);
      setMessage("");
      return;
    }
    if (o.input?.mode === "required" && !note.trim()) {
      setMessage("请填写说明");
      return;
    }
    if (hasUnsavedPlan(item.id) || draft?.dirty || draft?.conflict || draft?.saving) {
      setMessage("请先保存并核对当前版本");
      return;
    }
    if (draft?.refreshedTo != null || (draft && item.artifact && draft.base.version < item.artifact.version)) {
      setMessage("请先核对新版草稿");
      return;
    }
    const resume = item.resumeTarget && o.effect !== "defer" && o.effect !== "terminate";
    const closure = o.terminateMode === "cancel_task" ? item.closeTargets[o.id] ?? [] : [];
    const scope = JSON.stringify([item.itemRevision, resume ? item.resumeTarget?.id : null, o.targetCellIds, closure.map(t => t.id)]);
    const prompt = [
      o.confirm,
      o.terminateMode === "cancel_task" && "将关闭以下任务：" + closure.map(t => t.title).join("、"),
      resume && `恢复「${item.resumeTarget?.title}」并处理这件事？`,
    ]
      .filter(Boolean)
      .join("\n");
    if (prompt && (confirm?.id !== o.id || confirm.scope !== scope || confirm.text !== prompt)) {
      setConfirm({ id: o.id, scope, text: prompt });
      return;
    }
    setConfirm(null);
    submitting.current = true;
    setBusy(true);
    try {
      const result = await api.decide(item.id, {
        optionId: o.id,
        seenItemRevision: item.itemRevision,
        ...(draft ? { seenArtifactVersion: draft.base.version } : {}),
        note,
        ...(o.effect === "defer" && postponeTo ? { until: serverTimeForLocalDate(postponeTo) } : {}),
        ...(resume && item.resumeTarget ? { resumeProjectId: item.resumeTarget.id } : {}),
        ...(o.terminateMode === "cancel_task"
          ? { confirmedTargets: o.targetCellIds, confirmedClosure: closure.map(t => t.id) }
          : {}),
      });
      setStatus(result.deskStatus);
      if (result.status === "revising") setReviewedRevision(item.itemRevision + 1);
      const id = result.activityId;
      toast({
        tone: "success",
        text: result.status === "revising" ? "修改意见已送达" : "已处理",
        ...(id
          ? {
              action: {
                label: "撤销",
                run: () => {
                  void api.undo(id)
                    .then((r) => {
                      setStatus(r.deskStatus);
                      toast({ tone: "info", text: r.message });
                      refresh();
                    })
                    .catch((err) => toast({ tone: "error", text: toFailure(err).message }));
                },
              },
            }
          : {}),
      });
      cancelChoice();
    } catch (err) {
      const failure = toFailure(err);
      const text = failure.code === "bounds_violation"
        ? "没有权限执行这项操作"
        : failure.status === 404 ? "事项已移除"
        : failure.status === 409 && failure.message === "事项已变动" ? "事项已经更新，请核对最新选项后重新提交。"
        : /[㐀-鿿]/.test(failure.message) ? failure.message
        : failure.status === 409 ? "事项内容已变动，请核对后重新提交"
        : failure.status === 400 ? "请检查填写的说明和选项" : "提交失败，请稍后重试";
      setMessage(text);
      toast({ tone: "warn", text });
    } finally {
      submitting.current = false;
      setBusy(false);
      refresh();
    }
  }
  const renderChoice = (o: CardOption) => (
    <div className="inbox-choice" key={o.id}>
      <button
        type="button"
        disabled={busy}
        className={o.primary || item.options[0] === o ? "btn primary" : "btn"}
        onClick={() => void decide(o)}
      >
        {o.label}
      </button>
      {o.hint && <small>{o.hint}</small>}
      {!itemChanged && confirm?.id === o.id && (
        <div role="alert">
          <p>{confirm.text}</p>
          <button type="button" className="btn" onClick={() => setConfirm(null)}>
            返回
          </button>
          <button type="button" className="btn primary" onClick={() => void decide(o)}>
            确认{o.label}
          </button>
        </div>
      )}
      {editingChoice?.itemId === item.id && editingChoice.optionId === o.id && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void decide(o);
          }}
        >
          {o.effect === "defer" && (
            <label>
              再次提醒时间
              <input type="datetime-local" value={postponeTo} onChange={(e) => setPostponeTo(e.target.value)} />
            </label>
          )}
          {o.input && o.input.mode !== "none" && (
            <input
              autoFocus
              aria-label={o.input?.placeholder ?? "备注"}
              placeholder={o.input?.placeholder ?? (o.input?.mode === "optional" ? "备注可留空，回车提交" : "填写说明后回车")}
              value={notes[o.id] ?? ""}
              onChange={(e) => setNotes({ ...notes, [o.id]: e.target.value })}
            />
          )}
          <button type="submit" className="btn sm" disabled={busy || itemChanged}>
            {o.effect !== "defer" ? "提交" : postponeTo ? "按选定时间提醒" : "明天提醒"}
          </button>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={cancelChoice}>取消</button>
        </form>
      )}
    </div>
  );
  const reference = (
    <>
      {item.source && (
        <p>
          来源 ·{" "}
          {item.source.uri && /^https?:\/\//i.test(item.source.uri) ? <a href={item.source.uri} target="_blank" rel="noreferrer noopener">{item.source.label}</a> : item.source.label}
        </p>
      )}
      {item.rawInput?.text && <blockquote>{item.rawInput.text}</blockquote>}
      {item.prep && (
        <>
          <p>{item.prep.summary}</p>
          <References items={item.prep.checked} />
        </>
      )}
      {item.dueAt && <p>到期 · {dueText(item.dueAt, now)}</p>}
      {item.effort && <p>预计投入 · {EFFORT_LABELS[item.effort as Effort] ?? item.effort}</p>}
    </>
  );
  return (
    <article className={focused ? "inbox-detail split split-8-4" : "inbox-detail"}>
      <section className="inbox-paper">
        <h1>{item.title}</h1>
        {itemChanged && <div className="banner warn" role="alert">
          <strong>事项已更新，请核对最新内容和选项。</strong>
          <button type="button" className="btn sm" onClick={() => {
            setReviewedRevision(item.itemRevision);
            setConfirm(null);
            setMessage("");
          }}>已核对最新事项</button>
          {(editingChoice || confirm) && <button type="button" className="btn sm ghost" onClick={cancelChoice}>取消</button>}
        </div>}
        {!focused && reference}
        {item.project && (
          <p>
            {item.project.title}
            {item.project.parked ? " · 所属项目已停靠" : item.project.paused && " · 所属项目已暂停"}
          </p>
        )}
        {item.projects
          .filter((p) => p.id !== item.project?.id)
          .map((p) => (
            <p key={p.id}>
              <a href={`#/agents/${encodeURIComponent(p.id)}`}>{p.title}</a>
            </p>
          ))}
        {item.description && item.description !== item.title && <p className="preserve-lines">{item.description}</p>}
        {plan && (
          <section>
            <p>{plan.outcome}</p>
            {plan.background && <p>{plan.background}</p>}
            {plan.runnerOverride && <p>项目 Runner <code>{[plan.runnerOverride.engine, plan.runnerOverride.model, plan.runnerOverride.effort].filter(Boolean).join(" · ")}</code></p>}
            {plan.cwd && (
              <p>
                工作目录 <code>{plan.cwd}</code>
              </p>
            )}
            {plan.repos?.map((r) => (
              <div key={r.cwd}>
                {r.name} · <code>{r.cwd}</code>
              </div>
            ))}
            {plan.phases?.join(" → ")}
            <ol>
              {plan.actions?.map((a, i) => (
                <li key={i}>{a.title} · {{ human: "主人", agent: "分身", waiting: "等回复" }[a.owner]}{a.effort && ` · ${EFFORT_LABELS[a.effort]}`}{a.nextStep && ` · ${a.nextStep}`}</li>
              ))}
            </ol>
          </section>
        )}
        {item.artifact && (
          <>
            <button className="btn" type="button" onClick={toggle}>
              {focused ? "回到事项" : "展开专注编辑"}
            </button>
            {!focused && hasUnsavedPlan(item.id) && <p role="status">方案有未保存的修改，请展开编辑后保存或放弃。</p>}
            {!focused && draft && <DraftRefreshNotice draft={draft} />}
            {plan ? (
              focused && (
                <PlanEditor
                  item={item}
                  onClose={toggle}
                  onSaved={(result) => {
                    if (result.ok) draft?.saved(result.artifact);
                    cancelChoice();
                    toggle();
                    refresh();
                  }}
                  reloadItem={reloadItem}
                />
              )
            ) : focused && draft ? (
              <DraftEditor draft={draft} roomy minRows={16} />
            ) : (
              <pre className="draft-preview">{draft?.text ?? item.artifact.body}</pre>
            )}
          </>
        )}
      </section>
      <aside className="inbox-actions">
        {focused && (
          <>
            <h2>参考资料</h2>
            {reference}
          </>
        )}
        {draft && <Parked draft={draft} structured={!!plan} />}
        {!(focused && plan) && item.options.filter((o) => o.group !== "more").map(renderChoice)}
        {!(focused && plan) && item.options.some((o) => o.group === "more") && (
          <details>
            <summary>更多</summary>
            {!(focused && plan) && item.options.filter((o) => o.group === "more").map(renderChoice)}
          </details>
        )}
        {message && (
          <p role="alert">
            {message}{" "}
            <button
              className="btn sm"
              onClick={refresh}
            >
              查看最新选项
            </button>
          </p>
        )}
      </aside>
    </article>
  );
}
