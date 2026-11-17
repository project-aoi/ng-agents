import { useEffect, useState } from "react";
import { EFFORT_LABELS, relativeTimeZh, type ButtonDTO, type EngageDetailDTO, type EngageItemDTO, type EngageListDTO, type EngageMutationResponse, type Effort } from "../../shared/api";
import { api, callButton, request } from "../api";
import { References, SourceText } from "../components/bits";
import { ButtonRow, Spinner } from "../components/controls";
import { DraftEditor, forgetUnsaved, useDraft, type DraftApi } from "../components/draft";
import { Empty, ErrorState, Loading } from "../components/states";
import { syncServerClock, toFailure, useArtifactEvents, useNavigate, useNow, useResource, useStatus, useToast, useViewKeys } from "../state";
import { dueText, prettyTarget } from "../text";

type Filter = Effort | "all";
const FILTERS: Filter[] = ["all", "15m", "45m", "low_energy"];
const FILTER_KEY = "ng-desk-engage-filter";

function savedFilter(): Filter {
  try {
    const v = sessionStorage.getItem(FILTER_KEY);
    return FILTERS.includes(v as Filter) ? (v as Filter) : "all";
  } catch {
    return "all";
  }
}

export function EngageView({ item }: { item?: { cellId: string; actionId: string } | undefined }) {
  return item ? <Workspace key={`${item.cellId}/${item.actionId}`} cellId={item.cellId} actionId={item.actionId} /> : <EngageList />;
}

/** Shared outcome handling for "✓ 已办完" and "定稿发送" (list and workspace). */
function useEngageOutcome() {
  const toast = useToast();
  const { setStatus } = useStatus();
  return (r: EngageMutationResponse): "left" | "stay" => {
    setStatus(r.status);
    const detail = r.error ? `（${r.error}）` : "";
    switch (r.outcome) {
      case "done":
      case "already_done":
      case "sent":
        toast({ tone: "success", text: r.message });
        return "left";
      case "unknown":
        toast({ tone: "warn", text: `${r.message}${detail}` });
        return "left";
      case "version_mismatch":
        toast({ tone: "warn", text: "草稿已更新，请重看：已载入最新版本，确认后再发送" });
        return "stay";
      case "failed":
        toast({ tone: "error", text: `${r.message}${detail}` });
        return "stay";
      default:
        toast({ tone: r.ok ? "success" : "info", text: r.message });
        return r.ok ? "left" : "stay";
    }
  };
}

// ==================== the list ====================

function EngageList() {
  const [filter, setFilter] = useState<Filter>(savedFilter);
  const res = useResource<EngageListDTO>(`engage:${filter}`, () => api.engage(filter), ["engage"]);
  const navigate = useNavigate();
  const toast = useToast();
  const outcome = useEngageOutcome();
  const now = useNow();

  useEffect(() => {
    try {
      sessionStorage.setItem(FILTER_KEY, filter);
    } catch {
      // per-tab convenience only
    }
  }, [filter]);
  useEffect(() => {
    if (res.data) syncServerClock(res.data.generatedAt);
  }, [res.data]);

  const run = async (item: EngageItemDTO, b: ButtonDTO, input?: Record<string, unknown>) => {
    if (b.client === "open_editor" || b.client === "open_engage") {
      navigate({ view: "engage", item: { cellId: item.cellId, actionId: item.actionId } });
      return;
    }
    try {
      const r = await callButton<EngageMutationResponse>(b, input);
      if (outcome(r) === "left") forgetUnsaved(item.artifact?.artifactId);
      // The answer carries the unfiltered list; a filtered view asks again.
      if (filter === "all") res.set(r.view);
      else res.reload();
    } catch (err) {
      toast({ tone: "error", text: toFailure(err).message });
      res.reload();
    }
  };

  const counts = res.data?.counts;
  return (
    <div className="stage-wide engage">
      <div className="view-head">
        <div className="segmented" role="radiogroup" aria-label="按时间和精力挑一件事">
          {FILTERS.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "全部" : EFFORT_LABELS[f]}
              {counts && <span className="count">{counts[f]}</span>}
            </button>
          ))}
        </div>
        {res.data?.focus.on && (
          <span className="dnd-badge" title={res.data.focus.text}>
            免打扰中{res.data.focus.buffered > 0 ? ` · 已暂存 ${res.data.focus.buffered} 条` : ""}
          </span>
        )}
      </div>

      {!res.data ? (
        res.error && !res.loading ? (
          <ErrorState error={res.error} onRetry={res.reload} title="专注工作区没能载入" />
        ) : (
          <Loading label="正在载入要你动手的事…" />
        )
      ) : res.data.items.length === 0 ? (
        res.data.counts.all === 0 ? (
          <Empty title="需要你亲自动手的事都办完了">从待确认里“转给我来处理”的事，和项目里需要你动手的下一步，会出现在这里。</Empty>
        ) : (
          <Empty title={`“${filter === "all" ? "全部" : EFFORT_LABELS[filter]}”下没有合适的事`}>
            <button type="button" className="btn sm" onClick={() => setFilter("all")}>
              看全部 {res.data.counts.all} 件
            </button>
          </Empty>
        )
      ) : (
        <ul className="items">
          {res.data.items.map((it) => (
            <li key={`${it.cellId}/${it.actionId}`} className={`item item-${it.kind}${it.overdue ? " overdue" : ""}`}>
              <div className="item-main">
                {it.kind === "deep" ? (
                  <button type="button" className="item-title link-like" onClick={() => navigate({ view: "engage", item: { cellId: it.cellId, actionId: it.actionId } })}>
                    {it.title}
                  </button>
                ) : (
                  <span className="item-title">{it.title}</span>
                )}
                {it.nextStep && it.nextStep !== it.title && <p className="item-next">下一步：{it.nextStep}</p>}
                <ItemMeta item={it} now={now} />
              </div>
              <ButtonRow buttons={it.buttons} onRun={(b, input) => run(it, b, input)} size="sm" className="item-buttons" />
            </li>
          ))}
        </ul>
      )}
      {res.data && res.error && <p className="stale-note">刷新失败：{res.error.message}（显示的是上次载入的内容）</p>}
    </div>
  );
}

function ItemMeta({ item, now }: { item: EngageItemDTO; now: number }) {
  return (
    <div className="meta-line">
      {item.effortLabel && <span className="tag">{item.effortLabel}</span>}
      {item.project && <span className="tag tag-project">{item.project.title}</span>}
      {item.dueAt !== null && <span className={item.overdue ? "due overdue" : "due"}>{dueText(item.dueAt, now)}</span>}
      {item.artifact && (
        <span className="muted">
          草稿 v{item.artifact.version}
          {item.artifact.updatedBy === "human" ? "（你改过）" : ""}
        </span>
      )}
      {item.send && (
        <span className={item.send.state === "send_failed" ? "due overdue" : "muted"}>
          {item.send.state === "send_failed" ? "上次发送失败 · " : ""}发给 {prettyTarget(item.send.targetLabel)}（{item.send.channelLabel}）
        </span>
      )}
      {item.source && <span className="muted">来自 <SourceText source={item.source} now={now} /></span>}
    </div>
  );
}

// ==================== the 8/4 workspace ====================

function Workspace({ cellId, actionId }: { cellId: string; actionId: string }) {
  const res = useResource<EngageDetailDTO>(`engage-detail:${cellId}/${actionId}`, () => api.engageDetail(cellId, actionId), ["engage"]);
  const navigate = useNavigate();
  const toast = useToast();
  const outcome = useEngageOutcome();
  const now = useNow();
  const detail = res.data;
  const draft = useDraft(detail?.artifact ?? null);

  useArtifactEvents(detail?.artifact?.artifactId, () => res.reload());
  useEffect(() => {
    if (detail) syncServerClock(detail.generatedAt);
  }, [detail]);

  const back = () => navigate({ view: "engage" });

  useViewKeys((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      if (draft?.dirty) void draft.save();
      return true;
    }
    if (e.key === "Escape") {
      back();
      return true;
    }
    return false;
  });

  if (!detail) {
    return (
      <div className="stage-wide">
        <BackLink onBack={back} />
        {res.error && !res.loading ? (
          <ErrorState error={res.error} onRetry={res.reload} title={res.error.status === 404 ? "这件事不在专注工作区里了" : "没能打开这件事"} extra={<button type="button" className="btn ghost" onClick={back}>返回列表</button>} />
        ) : (
          <Loading label="正在打开工作区…" />
        )}
      </div>
    );
  }

  const item = detail.item;

  const run = async (b: ButtonDTO, input?: Record<string, unknown>) => {
    if (b.client === "open_editor" || b.client === "open_engage") return;
    const extra: Record<string, unknown> = { ...input };
    if (b.id === "send" && draft) {
      if (draft.conflict) {
        toast({ tone: "warn", text: "草稿有更新的版本：先对照合并，再发送" });
        return;
      }
      const seen = draft.dirty ? await draft.save() : draft.base;
      if (!seen) return;
      extra["seenVersion"] = seen.version;
    }
    if (b.id === "done" && draft?.dirty) {
      toast({ tone: "warn", text: "草稿还有没保存的修改：先保存或撤销，再标记已办完" });
      return;
    }
    try {
      const r = await callButton<EngageMutationResponse>(b, extra);
      if (outcome(r) === "left") {
        forgetUnsaved(detail.artifact?.artifactId);
        back();
      } else res.reload();
    } catch (err) {
      toast({ tone: "error", text: toFailure(err).message });
      res.reload();
    }
  };

  const sendLabel = item.send && draft?.dirty ? "保存并定稿发送" : null;
  const buttons = sendLabel ? item.buttons.map((b) => (b.id === "send" ? { ...b, label: `✓ ${sendLabel}给 ${prettyTarget(item.send!.targetLabel)}` } : b)) : item.buttons;

  return (
    <div className="stage-wide workspace">
      <div className="ws-head">
        <BackLink onBack={back} />
        <h2 className="ws-title">{item.title}</h2>
        {item.nextStep && item.nextStep !== item.title && <p className="item-next">下一步：{item.nextStep}</p>}
        <ItemMeta item={item} now={now} />
      </div>

      <div className="split split-8-4">
        <div className="split-main">
          {draft ? (
            <DraftEditor draft={draft} roomy minRows={14} label={<span className="draft-kind">{detail.artifact?.title ?? "初稿"}</span>} />
          ) : (
            <div className="no-draft">
              <p>这件事没有需要编辑的草稿。</p>
              {item.nextStep && <p className="muted">下一步：{item.nextStep}</p>}
            </div>
          )}
          <div className="ws-actions">
            <ButtonRow buttons={buttons} onRun={run} hide={["open"]} />
            {draft && <span className="kbd-hint">Ctrl / ⌘ + S 保存 · Esc 返回列表</span>}
          </div>
        </div>
        <aside className="split-side" aria-label="参考资料">
          {draft && <Parked detail={detail} draft={draft} onArtifact={(a) => res.set({ ...detail, artifact: a })} now={now} />}
          <ContextPack detail={detail} now={now} />
        </aside>
      </div>
      {res.error && <p className="stale-note">刷新失败：{res.error.message}（显示的是上次载入的内容）</p>}
    </div>
  );
}

function BackLink({ onBack }: { onBack(): void }) {
  return (
    <button type="button" className="back-link" onClick={onBack}>
      ← 返回专注工作区
    </button>
  );
}

function Parked(props: { detail: EngageDetailDTO; draft: DraftApi; onArtifact(a: NonNullable<EngageDetailDTO["artifact"]>): void; now: number }) {
  const parked = props.detail.artifact?.parked ?? [];
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (parked.length === 0) return null;
  const dismiss = async (id: string, b: ButtonDTO) => {
    if (!b.endpoint) return;
    setBusy(id);
    try {
      const a = await request<NonNullable<EngageDetailDTO["artifact"]>>(b.endpoint.method, b.endpoint.path, b.endpoint.body ?? {});
      props.onArtifact(a);
    } catch (err) {
      toast({ tone: "error", text: toFailure(err).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="side-block parked">
      <h3 className="side-title">
        后台补充的新信息 <span className="count">{parked.length}</span>
      </h3>
      <p className="side-note">你修改草稿后，后台又收到了这些内容。它们没有覆盖你的草稿，合并完可以移除。</p>
      {parked.map((p) => (
        <article key={p.id} className="parked-item">
          <div className="parked-meta">
            {p.title && <strong>{p.title}</strong>}
            <span className="muted">
              {relativeTimeZh(p.createdAt, props.now)}
              {p.basedOnVersion > 0 ? ` · 基于 v${p.basedOnVersion}` : ""}
            </span>
          </div>
          {p.note && <p className="parked-note">{p.note}</p>}
          <pre className="parked-body">{p.body}</pre>
          <div className="parked-actions">
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => props.draft.setText(`${props.draft.text.replace(/\s*$/, "")}\n\n${p.body}\n`)}
              disabled={props.draft.conflict !== null}
            >
              追加到草稿末尾
            </button>
            <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void dismiss(p.id, p.dismiss)}>
              {busy === p.id && <Spinner />}
              {p.dismiss.label}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function ContextPack({ detail, now }: { detail: EngageDetailDTO; now: number }) {
  const cp = detail.contextPack;
  const empty = !cp.rawInput && !cp.prepSummary && cp.references.length === 0 && cp.skills.length === 0;
  return (
    <section className="side-block context-pack">
      <h3 className="side-title">手边的资料</h3>
      {empty && <p className="side-note">这件事没有附带参考资料。</p>}
      {cp.rawInput && (
        <div className="cp-part">
          <h4>
            原始消息 <span className="muted">· <SourceText source={cp.rawInput.source} now={now} /></span>
          </h4>
          <div className="raw-text small">{cp.rawInput.text}</div>
        </div>
      )}
      {cp.prepSummary && (
        <div className="cp-part">
          <h4>Agent 的备注</h4>
          <p>{cp.prepSummary}</p>
        </div>
      )}
      {cp.references.length > 0 && (
        <div className="cp-part">
          <References items={cp.references} title="参考资料" />
        </div>
      )}
      {cp.skills.length > 0 && (
        <div className="cp-part">
          <h4>检查清单</h4>
          <ul className="skills">
            {cp.skills.map((s) => (
              <li key={s.name}>
                <span className="skill-name">{s.name}</span>
                <span className="muted">{s.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
