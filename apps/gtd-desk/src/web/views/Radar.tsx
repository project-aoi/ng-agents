import { useEffect, useState } from "react";
import type { ButtonDTO, ProjectMutationResponse, ProjectRowDTO, RadarDTO, ReviewMutationResponse, StatusDTO, WeeklyReviewDTO } from "../../shared/api";
import { t } from "../i18n";
import { api, callButton, request } from "../api";
import { BallChip, ButtonRow, Chevron, ProgressBar } from "../components/controls";
import { Empty, ErrorState, Loading } from "../components/states";
import { parseRoute, routeHash, syncServerClock, toFailure, useNavigate, useNow, useOpenReport, useResource, useStatus, useToast } from "../state";
import { dueText, whenText } from "../text";

export function RadarView() {
  // The weekly review rides along in /api/radar, so a review-only change refetches the same view.
  const res = useResource<RadarDTO>("radar", api.radar, ["radar", "review"]);
  const ended = useResource("recently-closed", api.closedProjects, ["radar"]);
  const { setStatus } = useStatus();
  const toast = useToast();

  const reopen = async (id: string) => {
    try {
      const result = await api.reopen(id);
      setStatus(result.deskStatus);
      res.reload();
      ended.reload();
      toast({ tone: "success", text: "项目已重新打开" });
    } catch (err) {
      toast({ tone: "error", text: toFailure(err).message });
    }
  };
  const now = useNow();
  const [somedayOpen, setSomedayOpen] = useState(false);

  useEffect(() => {
    if (res.data) syncServerClock(res.data.generatedAt);
  }, [res.data]);

  const runProject = async (b: ButtonDTO, input?: Record<string, unknown>) => {
    try {
      const r = await callButton<ProjectMutationResponse>(b, input);
      res.set(r.view);
      setStatus(r.status);
      const target=b.endpoint?.path.match(/\/projects\/([^/]+)\/(?:complete|cancel)$/)?.[1];
      if (target && r.ok) ended.reload();
      toast({ tone: r.ok ? "success" : "warn", text: r.message,...(r.ok && target ? {action:{label:"重新打开",run:()=>void reopen(decodeURIComponent(target))}} : {}) });
    } catch (err) {
      toast({ tone: "error", text: toFailure(err).message });
      res.reload();
    }
  };

  const runReview = async (b: ButtonDTO, input?: Record<string, unknown>) => {
    try {
      const r = await callButton<ReviewMutationResponse>(b, input);
      if (res.data) res.set({ ...res.data, review: r.view });
      setStatus(r.status);
      toast({ tone: r.ok ? "success" : "warn", text: r.message });
    } catch (err) {
      toast({ tone: "error", text: toFailure(err).message });
    }
  };

  if (!res.data) {
    return <div className="stage-wide">{res.error && !res.loading ? <ErrorState error={res.error} onRetry={res.reload} title="项目全局没能载入" /> : <Loading label="正在载入项目全局…" />}</div>;
  }
  const radar = res.data;

  return (
    <div className="stage-wide radar">
      {!!ended.data?.projects.length && <details><summary>最近结束的项目</summary>{ended.data.projects.map(p=><p key={p.id}>{p.title} <button className="btn sm" onClick={()=>void reopen(p.id)}>重新打开</button></p>)}</details>}
      <div className="split split-7-5">
        <section className="split-main" aria-labelledby="radar-projects">
          <div className="section-head">
            <h2 id="radar-projects">
              进行中的项目 <span className="count">{radar.counts.active}</span>
            </h2>
            {radar.counts.stalled > 0 && <span className="stalled-count">{radar.counts.stalled} 个停滞，需要补上下一步</span>}
          </div>
          {radar.projects.length === 0 ? (
            <Empty title="没有进行中的项目">在「待我处理」批准立项后，可以在这里查看进展。</Empty>
          ) : (
            <ul className="projects">
              {radar.projects.map((p) => (
                <ProjectRow key={p.id} row={p} now={now} onRun={runProject} />
              ))}
            </ul>
          )}

          {radar.someday.length > 0 && (
            <div className="someday">
              <button type="button" className="disclosure" aria-expanded={somedayOpen} onClick={() => setSomedayOpen((o) => !o)}>
                <Chevron dir="right" open={somedayOpen} />
                以后再说 <span className="count">{radar.someday.length}</span>
              </button>
              {somedayOpen && (
                <ul className="projects someday-list">
                  {radar.someday.map((p) => (
                    <ProjectRow key={p.id} row={p} now={now} onRun={runProject} />
                  ))}
                </ul>
              )}
            </div>
          )}
          {res.error && <p className="stale-note">刷新失败：{res.error.message}（显示的是上次载入的内容）</p>}
        </section>

        <aside className="split-side" aria-labelledby="radar-review">
          <WeeklyReview review={radar.review} now={now} completedProjects={radar.counts.completedThisWeek} onRun={runReview} />
        </aside>
      </div>
    </div>
  );
}

// ==================== a project row ====================

function ActionConversation({ projectId, cellId, text, agent }: { projectId: string; cellId?: string | undefined; text: string; agent: boolean }) {
  const navigate = useNavigate();
  if (!cellId || cellId === projectId) {
    return <>{text}{agent && <small className="action-session-note">{t("暂无分身会话", "No worker conversation yet")}</small>}</>;
  }
  const route = { view: "agents", projectId, cellId } as const;
  return (
    <a className="link-btn action-session-link" href={routeHash(route)} onClick={event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(route);
    }}>
      {text}
    </a>
  );
}

function ProjectRow({ row, now, onRun }: { row: ProjectRowDTO; now: number; onRun(b: ButtonDTO, input?: Record<string, unknown>): Promise<void> }) {
  const navigate = useNavigate();
  const openReport = useOpenReport();
  const [open, setOpen] = useState(false);
  const ball = row.ball;
  const hiddenActions = row.openActions.length;
  const { artifacts: reports, agents } = row;

  return (
    <li className={`project${row.stalled ? " stalled" : ""}${row.paused ? " paused" : ""}${row.lifecycle === "someday" ? " is-someday" : ""}`}>
      <div className="project-top">
        <div className="project-name">
          <h3>{row.title}</h3>
          {row.paused && <span className="badge">已暂停</span>}
          {row.lifecycle === "someday" && <span className="badge">已停靠</span>}
        </div>
        {row.outcome && <p className="project-outcome">{row.outcome}</p>}
        {row.summary && <p className="muted small">{row.summary}</p>}
        {row.pausedText && <p className="muted small">{row.pausedText}</p>}
        {row.cwd && <p className="muted small">{row.cwd}</p>}
      </div>

      {row.stalled && (
        <p className="stalled-text" role="note">
          <span className="stalled-dot" aria-hidden="true" />
          {row.stalledText}
        </p>
      )}
      {ball ? (
        <div className="ball-line">
          <BallChip owner={ball.owner} label={ball.label} />
          <span className="ball-text">
            <ActionConversation projectId={row.id} cellId={ball.targetCellId} text={ball.text} agent={ball.owner === "agent"} />
          </span>
          {ball.cardId && (
            <button type="button" className="link-btn" onClick={() => navigate({ view: "inbox", cardId: ball.cardId! })}>
              去处理 →
            </button>
          )}
        </div>
      ) : (
        row.lifecycle === "someday" && <p className="muted small">重新启动后，分身会接着推进。</p>
      )}

      <div className="project-links">
        {reports.map((a) => (
          <button key={a.artifactId} type="button" className="btn sm report-btn" onClick={() => openReport(a)} title={`打开「${a.title}」v${a.version}`}>
            查看报告：{a.title} (v{a.version})
          </button>
        ))}
        <a
          className="link-btn agents-link"
          href={agents.href}
          onClick={(e) => {
            e.preventDefault();
            navigate(parseRoute(agents.href));
          }}
        >
          {agents.label}
        </a>
      </div>

      {(row.progress || row.waiting) && (
        <div className="aggregate">
          {row.progress && (
            <span className="agg">
              <ProgressBar done={row.progress.done} total={row.progress.total} label={row.progress.text} />
              <span className="muted">{row.progress.text}</span>
            </span>
          )}
          {row.waiting && ball?.owner !== "waiting" && (
            <span className="agg">
              <span className="dot waiting" aria-hidden="true" />
              <span className="muted">{row.waiting.text}</span>
            </span>
          )}
        </div>
      )}

      <div className="project-foot">
        {hiddenActions > 1 || (row.openActions[0]?.owner === "agent" && ball?.owner !== "agent") ? (
          <button type="button" className="disclosure small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Chevron dir="right" open={open} />
            {hiddenActions === 1 ? t("查看动作", "View action") : t(`${hiddenActions} 个并行动作`, `${hiddenActions} parallel actions`)}
          </button>
        ) : (
          <span className="muted small">{row.pendingCardId && !ball?.cardId ? "有一件事在「待我处理」" : ""}</span>
        )}
        <ButtonRow buttons={row.buttons} onRun={onRun} size="sm" className="project-buttons" />
      </div>

      {open && (
        <ul className="project-actions">
          {row.openActions.map((a) => (
            <li key={`${a.cellId}/${a.actionId}`}>
              <BallChip owner={a.owner} label={a.ownerLabel} />
              <span className="pa-text">
                {a.owner === "human" ? (
                  <button type="button" className="link-btn" onClick={() => navigate({ view: "inbox", cardId: a.actionId })}>
                    {a.text}
                  </button>
                ) : (
                  <ActionConversation projectId={row.id} cellId={a.targetCellId} text={a.text} agent={a.owner === "agent"} />
                )}
              </span>
              {a.progress && <ProgressBar done={a.progress.done} total={a.progress.total} label={a.progress.text} />}
              {a.dueAt !== null && <span className={a.dueAt < now ? "due overdue" : "due"}>{dueText(a.dueAt, now)}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ==================== weekly review ====================

const COMPLETED_KIND: Record<WeeklyReviewDTO["completed"][number]["kind"], string> = { action: "事项", project: "项目", reply: "回复" };

function WeeklyReview({ review, now, completedProjects, onRun }: { review: WeeklyReviewDTO; now: number; completedProjects: number; onRun(b: ButtonDTO, input?: Record<string, unknown>): Promise<void> }) {
  const navigate = useNavigate();
  const suggestions = review.skillSuggestions.length + review.sensorSuggestions.length;
  return (
    <section className="review">
      <div className="section-head">
        <h2 id="radar-review">15 分钟周回顾</h2>
        <span className="muted small">下次 {whenText(review.nextReviewAt, now)}</span>
      </div>

      <div className="review-block">
        <h3>
          本周完结 <span className="count">{review.completed.length}</span>
        </h3>
        {review.completed.length === 0 ? (
          <p className="muted small">本周还没有完结的事项。</p>
        ) : (
          <ul className="done-list">
            {review.completed.slice(0, 12).map((c, i) => (
              <li key={`${c.kind}-${c.at}-${i}`}>
                <span className="done-mark" aria-hidden="true">
                  ✓
                </span>
                <span className="done-title">{c.title}</span>
                <span className="muted small">
                  {COMPLETED_KIND[c.kind]}
                  {c.project ? ` · ${c.project}` : ""} · {whenText(c.at, now)}
                </span>
              </li>
            ))}
            {review.completed.length > 12 && <li className="muted small">还有 {review.completed.length - 12} 件</li>}
          </ul>
        )}
        {(completedProjects > 0 || review.editedDrafts > 0) && (
          <p className="muted small review-facts">
            {completedProjects > 0 && <>完结 {completedProjects} 个项目</>}
            {completedProjects > 0 && review.editedDrafts > 0 && " · "}
            {review.editedDrafts > 0 && <>你改过 {review.editedDrafts} 份草稿后才确认</>}
          </p>
        )}
      </div>

      <div className="review-block">
        <h3>
          超时未决的跟进 <span className="count">{review.overdueWaits.length}</span>
        </h3>
        {review.overdueWaits.length === 0 ? (
          <p className="muted small">没有超时的等待。</p>
        ) : (
          <ul className="overdue-list">
            {review.overdueWaits.map((w) => (
              <li key={`${w.cellId}/${w.actionId}`}>
                <span className="dot waiting" aria-hidden="true" />
                <div>
                  <span className="done-title">{w.title}</span>
                  <span className="muted small">
                    {w.project ? `${w.project} · ` : ""}
                    {w.text}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="review-block">
        <h3>
          从日常里长出来的建议 <span className="count">{suggestions}</span>
        </h3>
        {suggestions === 0 && <p className="muted small">这周没有新的建议。</p>}

        {review.skillSuggestions.map((s) => (
          <article key={`skill-${s.name}`} className="suggestion">
            <p className="suggestion-kind">保存为检查清单</p>
            <h4>{s.name}</h4>
            <p>{s.description}</p>
            {s.reason && <p className="muted small">{s.reason}</p>}
            <details className="suggestion-body">
              <summary>看清单内容</summary>
              <pre>{s.body}</pre>
            </details>
            <ButtonRow buttons={s.buttons} onRun={onRun} size="sm" />
          </article>
        ))}

        {review.sensorSuggestions.map((s) => (
          <article key={`sensor-${s.sensorId}`} className="suggestion">
            <p className="suggestion-kind">信源换成零 Token 脚本检查</p>
            <h4>{s.title}</h4>
            <p className="muted small">{s.reason}</p>
            {s.entry && (
              <p className="small">
                准备好的检查：<code>{s.entry.replace(/^script:/, "")}</code>
              </p>
            )}
            <ButtonRow buttons={s.buttons} onRun={onRun} size="sm" />
          </article>
        ))}
      </div>

      <p className="muted small review-foot">
        周回顾在 {whenText(review.nextReviewAt, now)} 自动准备好。
        <button type="button" className="link-btn" onClick={() => navigate({ view: "inbox" })}>
          去待我处理 →
        </button>
      </p>
    </section>
  );
}
