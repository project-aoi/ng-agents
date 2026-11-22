import { useEffect, useState } from "react";
import type { CardOption } from "@ng/protocol";
import { EFFORT_LABELS, type Effort, type HumanItemDTO as Item } from "../../shared/api";
import { References } from "../components/bits";
import { PlanEditor } from "../components/PlanEditor";
import { Parked } from "../components/Parked";
import { clientId, prettyTarget, dueText } from "../text";
import { request } from "../api";
import { DraftEditor, DraftRefreshNotice, forgetUnsaved, useDraft } from "../components/draft";
import { Empty, ErrorState, Loading } from "../components/states";
import { toFailure, useNavigate, useNow, useResource, useToast, useViewKeys } from "../state";

const pool = () => request<{ items: Item[] }>("GET", "/api/human-items");

function useEditorLease(open: boolean) {
  const toast = useToast();
  useEffect(() => {
    if (!open) return;
    const id = clientId();
    let pending = Promise.resolve();
    const send = (active: boolean) => {
      pending = pending.then(async () => {
        try {
          await request("POST", `/api/editor-leases/${id}`, { active }, { keepalive: !active });
        } catch (err) {
          if (active) toast({ tone: "warn", text: toFailure(err).message });
        }
      });
    };
    send(true);
    const timer = window.setInterval(() => send(true), 12_000);
    const leave = () => send(false);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.clearInterval(timer);
      send(false);
    };
  }, [open, toast]);
}

export function HumanInbox({ cardId, actionRef }: { cardId?: string | undefined; actionRef?: Item["actionRefs"][number] | undefined }) {
  const res = useResource("human-inbox", pool, ["clarify", "engage", "radar", "status"]);
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<string | null>(null);
  const items = (res.data?.items ?? [])
    .filter((i) => filter === "all" || i.category === filter)
    .sort((a, b) => b.category.localeCompare(a.category) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
  const [editingChoice, setEditingChoice] = useState<Item | null>(null);
  const linked = actionRef && items.find(i => i.actionRefs.some(ref => ref.cellId === actionRef.cellId && ref.actionId === actionRef.actionId));
  const item = editingChoice ?? linked ?? items.find(i => i.id === (cardId ?? actionRef?.actionId)) ?? items[0];
  useEffect(() => setEditingChoice(null), [cardId, actionRef?.cellId, actionRef?.actionId]);
  const focused = !!item && editing === item.id;
  useEditorLease(focused);
  const choose = (id: string) => {
    setEditing(null);
    setEditingChoice(null);
    navigate({ view: "clarify", cardId: id });
  };
  useViewKeys((e) => {
    if (e.key === "Escape" && focused) {
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
            <select aria-label="筛选事项" value={filter} onChange={(e) => setFilter(e.target.value)}>
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
                          {i.project.paused && " · 已暂停"}
                        </small>
                      )}
                      {i.status === "unknown" && <small>需要核实发送结果</small>}
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
          pin={setEditingChoice}
          focused={focused}
          toggle={() => setEditing(focused ? null : item.id)}
          refresh={res.reload}
        />
      ) : (
        <Empty title="待办已清空">有新的事项时会出现在这里。</Empty>
      )}
    </div>
  );
}

function Detail({
  item,
  pin,
  focused,
  toggle,
  refresh,
}: {
  item: Item;
  pin: (item: Item | null) => void;
  focused: boolean;
  toggle(): void;
  refresh(): void;
}) {
  const draft = useDraft(item.artifact);
  const now = useNow();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const plan = item.proposal;
  const [confirm, setConfirm] = useState<{ id: string; revision: number; text: string } | null>(null);
  useEffect(() => {
    if (!focused || plan) return;
    const save = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void draft?.save();
      }
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, [focused, draft, plan]);
  const [postponeTo, setPostponeTo] = useState("");
  async function decide(o: CardOption) {
    if (busy) return;
    const note = notes[o.id] ?? "";
    if ((o.effect === "defer" || (o.input && o.input.mode !== "none")) && selected !== o.id) {
      pin(item);
      setSelected(o.id);
      return;
    }
    if (o.input?.mode === "required" && !note.trim()) {
      setMessage("请填写说明");
      return;
    }
    if (draft?.dirty || draft?.conflict || draft?.saving) {
      setMessage("请先保存并核对当前版本");
      return;
    }
    if (draft?.refreshedTo != null) {
      setMessage("请先核对新版草稿");
      return;
    }
    const resume = item.resumeTarget && o.effect !== "defer" && o.effect !== "terminate";
    const prompt = [
      o.confirm,
      o.terminateMode === "cancel_task" && "将关闭以下任务：" + (item.closeTargets[o.id] ?? []).map((t) => t.title + " · " + t.id).join("、"),
      resume && `恢复「${item.resumeTarget?.title}」并处理这件事？`,
    ]
      .filter(Boolean)
      .join("\n");
    if (prompt && (confirm?.id !== o.id || confirm.revision !== item.itemRevision || confirm.text !== prompt)) {
      setConfirm({ id: o.id, revision: item.itemRevision, text: prompt });
      return;
    }
    setConfirm(null);
    setBusy(true);
    try {
      const result = await request<{ status: string; activityId?: string }>("POST", `/api/human-items/${encodeURIComponent(item.id)}/decide`, {
        optionId: o.id,
        seenItemRevision: item.itemRevision,
        ...(draft ? { seenArtifactVersion: draft.base.version } : {}),
        ...(item.attempt !== null ? { seenAttempt: item.attempt } : {}),
        note,
        ...(o.effect === "defer" && postponeTo ? { until: new Date(postponeTo).getTime() } : {}),
        ...(resume && item.resumeTarget ? { resumeProjectId: item.resumeTarget.id } : {}),
        ...(o.terminateMode === "cancel_task"
          ? { confirmedTargets: o.targetCellIds, confirmedClosure: item.closeTargets[o.id]?.map((t) => t.id) }
          : {}),
      });
      forgetUnsaved(item.artifactId);
      const id = result.activityId;
      toast({
        tone: result.status === "failed" || result.status === "unknown" ? "warn" : "success",
        text:
          result.status === "failed"
            ? "发送失败，请检查后重试"
            : result.status === "unknown"
              ? "请核实对方是否收到"
              : result.status === "revising"
                ? "修改意见已送达"
                : "已处理",
        ...(id
          ? {
              action: {
                label: "撤销",
                run: () => {
                  void request<{ message: string }>("POST", `/api/human-activity/${encodeURIComponent(id)}/undo`)
                    .then((r) => {
                      toast({ tone: "info", text: r.message });
                      refresh();
                    })
                    .catch((err) => toast({ tone: "error", text: toFailure(err).message }));
                },
              },
            }
          : {}),
      });
      pin(null);
      setSelected(null);
      setMessage("");
    } catch (err) {
      pin(null);
      const failure = toFailure(err);
      const text = failure.status === 403 || failure.code === "bounds_violation"
        ? "此操作需要主人确认"
        : failure.status === 404 ? "事项已移除"
        : failure.status === 409 && failure.message === "item changed" ? "事项已经更新，请核对最新选项后重新提交。"
        : failure.status === 409 || /[㐀-鿿]/.test(failure.message) ? failure.message
        : failure.status === 400 ? "请检查填写的说明和选项" : "提交失败，请稍后重试";
      setMessage(text);
      toast({ tone: "warn", text });
    } finally {
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
      {confirm?.id === o.id && (
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
      {selected === o.id && (
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
          {
            <button type="submit" className="btn sm" disabled={busy}>
              {o.effect !== "defer" ? "提交" : postponeTo ? "按选定时间提醒" : "明天提醒"}
            </button>
          }
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
        {!focused && reference}
        {item.project && (
          <p>
            {item.project.title}
            {item.project.paused && " · 所属项目已暂停"}
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
        {item.action?.type === "channel.send" && (
          <p>
            <strong>收件地址</strong> {prettyTarget(item.action.target)}
          </p>
        )}
        {item.attempted && (
          <blockquote>
            上次尝试发送至 {prettyTarget(item.attempted.target)}
            <p>{item.attempted.body}</p>
          </blockquote>
        )}
        {plan && (
          <section>
            <p>{plan.outcome}</p>
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
                <li key={i}>{a.title}</li>
              ))}
            </ol>
          </section>
        )}
        {item.artifact && (
          <>
            <button className="btn" type="button" onClick={toggle}>
              {focused ? "回到事项" : "展开专注编辑"}
            </button>
            {!focused && draft && <DraftRefreshNotice draft={draft} />}
            {plan ? (
              focused && (
                <PlanEditor
                  item={item}
                  onClose={toggle}
                  onSaved={(r) => {
                    if (r.card?.draft) draft?.accept(r.card.draft);
                    pin(null);
                    toggle();
                    refresh();
                  }}
                  onConflictView={refresh}
                />
              )
            ) : focused && draft ? (
              <DraftEditor draft={draft} roomy minRows={16} />
            ) : (
              <pre className="draft-preview">{draft?.base.body ?? item.artifact.body}</pre>
            )}
          </>
        )}
      </section>
      <aside className="inbox-actions">
        {focused && (
          <>
            <h2>参考资料</h2>
            {reference}
            {draft && !plan && <Parked draft={draft} />}
          </>
        )}
        {item.options.length === 0 && <p role="status">正在发送，送达结果会显示在这里。</p>}
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
              onClick={() => {
                pin(null);
                refresh();
              }}
            >
              查看最新选项
            </button>
          </p>
        )}
      </aside>
    </article>
  );
}
