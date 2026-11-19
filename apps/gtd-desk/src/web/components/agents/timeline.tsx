import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { relativeTimeZh, type CellJobDTO, type TimelineItemDTO, type ToolStepDTO, type TopologyNodeDTO } from "../../../shared/api";
import { api } from "../../api";
import { toFailure, useOpenReport } from "../../state";
import { clockText } from "../../text";
import { Chevron, Spinner } from "../controls";
import { Markdown } from "../markdown";
import type { CellTimeline, PendingMessage } from "./data";
import { durationText, visibleItems, type Density } from "./model";

/** Oldest first; follows the newest record while it is at the bottom and not paused. */
export function Timeline(props: { tl: CellTimeline; node: TopologyNodeDTO; density: Density; paused: boolean; now: number; onReply(q: { id: string; text: string }): void }) {
  const { tl, density, paused } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** Distance from the bottom to restore after older records were put on top. */
  const anchor = useRef<number | null>(null);
  const [behind, setBehind] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const items = useMemo(() => visibleItems(tl.items, density), [tl.items, density]);
  const last = items.at(-1);
  // Changes when something is added at the end or the last item grows (a tool group that took more steps).
  const tailKey = `${items.length}:${last?.id ?? ""}:${last?.kind === "tool_group" ? last.steps.length : ""}:${tl.pending.length}`;

  useEffect(() => setOpen({}), [density]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
      return;
    }
    if (atBottom.current && !paused) el.scrollTop = el.scrollHeight;
    else if (items.length > 0) setBehind(true);
  }, [tailKey, density]);

  useEffect(() => {
    // Resuming follows the tail again right away.
    const el = scroller.current;
    if (!paused && el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [paused]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    if (atBottom.current) setBehind(false);
  };

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setBehind(false);
  };

  const earlier = () => {
    const el = scroller.current;
    if (el) anchor.current = el.scrollHeight - el.scrollTop;
    void tl.loadEarlier();
  };

  const toolsOpen = (id: string) => open[id] ?? density === "steps";

  return (
    <div className="tl-wrap">
      <div className="tl-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="工作实况" role="log" aria-live="off">
        {tl.hasEarlier && (
          <div className="tl-earlier">
            <button type="button" className="btn sm ghost" onClick={earlier} disabled={tl.loadingEarlier}>
              {tl.loadingEarlier && <Spinner />}加载更早的记录
            </button>
          </div>
        )}
        {items.length === 0 && tl.pending.length === 0 ? (
          <p className="tl-empty muted small">{tl.items.length === 0 ? "还没有记录。" : "这一档下没有内容，换个密度看看。"}</p>
        ) : (
          <ol className="tl-items">
            {items.map((it) => (
              <li key={it.id} className={`tl-item k-${it.kind}`}>
                <Item it={it} node={props.node} now={props.now} open={toolsOpen(it.id)} onToggle={() => setOpen((o) => ({ ...o, [it.id]: !toolsOpen(it.id) }))} onReply={props.onReply} />
              </li>
            ))}
            {tl.pending.map((p) => (
              <li key={p.clientId} className="tl-item k-user_chat pending">
                <PendingBubble p={p} now={props.now} />
              </li>
            ))}
          </ol>
        )}
        {tl.tailError && <p className="stale-note">{tl.tailError}（显示的是已载入的内容）</p>}
      </div>
      {behind && (
        <button type="button" className="tl-behind" onClick={toBottom}>
          ↓ 有新动态
        </button>
      )}
    </div>
  );
}

function Item(props: { it: TimelineItemDTO; node: TopologyNodeDTO; now: number; open: boolean; onToggle(): void; onReply(q: { id: string; text: string }): void }) {
  const { it, now } = props;
  const openReport = useOpenReport();
  const at = clockText(it.at, now);
  switch (it.kind) {
    case "dispatch_brief":
      return (
        <article className="tl-brief">
          <p className="tl-label">
            派单说明 · 来自 {it.fromLabel} · {at}
          </p>
          <Markdown text={it.text} />
        </article>
      );
    case "user_chat":
      return (
        <div className={`tl-chat${it.direct ? " mine" : ""}`}>
          <p className="tl-label">
            {it.senderLabel}
            {it.mode === "steer" ? " · 立即打断" : ""} · {at}
          </p>
          <div className="tl-bubble">{it.text}</div>
          {it.syncedTo && <p className="tl-sync">已同步给所属项目「{it.syncedTo}」</p>}
        </div>
      );
    case "assistant_reply":
      return (
        <article className={`tl-reply${it.question ? " question" : ""}`}>
          <p className="tl-label">
            {props.node.roleLabel} · {at}
            {it.toOwner ? " · 已发给你" : ""}
          </p>
          <Markdown text={it.text} />
          {it.question && (
            <button type="button" className="link-btn tl-reply-to" onClick={() => props.onReply({ id: it.id, text: it.text })}>
              回复这条
            </button>
          )}
        </article>
      );
    case "peer_message":
      return <Quiet label={`${it.fromLabel} · ${at}`} text={it.text} />;
    case "system_event":
      return (
        <p className="tl-system">
          {it.text} <span className="tl-time">· {at}</span>
        </p>
      );
    case "milestone":
      return (
        <div className="tl-center">
          <span className={`tl-milestone ${it.tone}`}>
            {it.text} <span className="tl-time">· {at}</span>
          </span>
        </div>
      );
    case "artifact_event":
      return (
        <div className="tl-center">
          <button type="button" className="tl-artifact" onClick={() => openReport(it.artifact)}>
            {it.verb === "created" ? "产出了" : "修订了"}「{it.artifact.title}」v{it.artifact.version} · 查看 <span className="tl-time">· {at}</span>
          </button>
        </div>
      );
    case "tool_group":
      return (
        <div className={`tl-tools${it.failed > 0 ? " has-failed" : ""}`}>
          <button type="button" className="tl-tools-head" aria-expanded={props.open} onClick={props.onToggle}>
            <Chevron dir="right" open={props.open} />
            <span className="tl-tools-summary">{it.summary}</span>
            {it.failed > 0 && <span className="badge danger-soft">{it.failed} 步失败</span>}
            <span className="tl-time">{at}</span>
          </button>
          {props.open && (
            <ol className="tl-steps">
              {it.steps.map((s) => (
                <ToolStep key={s.seq} step={s} />
              ))}
            </ol>
          )}
        </div>
      );
  }
}

/** Another cell's or the system's message: one quiet block, long ones folded. */
function Quiet({ label, text }: { label: string; text: string }) {
  const long = text.length > 280 || text.split("\n").length > 5;
  const [more, setMore] = useState(false);
  return (
    <div className="tl-quiet">
      <p className="tl-label">{label}</p>
      <p className={`tl-quiet-text${long && !more ? " clamp" : ""}`}>{text}</p>
      {long && (
        <button type="button" className="link-btn" onClick={() => setMore((m) => !m)}>
          {more ? "收起" : "展开全文"}
        </button>
      )}
    </div>
  );
}

function PendingBubble({ p, now }: { p: PendingMessage; now: number }) {
  return (
    <div className="tl-chat mine">
      <p className="tl-label">
        你{p.mode === "steer" ? " · 立即打断" : ""} · {clockText(p.at, now)}
      </p>
      <div className="tl-bubble">{p.text}</div>
      <p className="tl-sync">{p.state === "sending" ? "发送中…" : "已送达，等它接收"}</p>
    </div>
  );
}

// ==================== one tool call ====================

const PAGE_CHARS = 16_000;

interface FullOutput {
  content: string;
  next: number;
  total: number;
  hasMore: boolean;
}

function ToolStep({ step: s }: { step: ToolStepDTO }) {
  const [full, setFull] = useState<FullOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = s.ok === true ? "ok" : s.ok === false ? "failed" : "open";

  const loadMore = async () => {
    if (!s.spillUri || loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await api.resource(s.spillUri, full?.next ?? 0, PAGE_CHARS);
      setFull((f) => ({ content: (f?.content ?? "") + page.content, next: page.offset + page.content.length, total: page.totalChars, hasMore: page.hasMore }));
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setLoading(false);
    }
  };

  const output = full ? full.content : s.output;
  return (
    <li className={`tl-step ${state}`}>
      <div className="tl-step-head">
        <span className={`step-mark ${state}`} role="img" aria-label={state === "ok" ? "成功" : state === "failed" ? "失败" : "还没有结果"}>
          {state === "ok" ? "✓" : state === "failed" ? "✕" : "…"}
        </span>
        <code className="step-name">{s.name}</code>
        {s.durationMs !== null && <span className="tl-time">{durationText(s.durationMs)}</span>}
      </div>
      {s.brief && <pre className="step-brief">{s.brief}</pre>}
      {output && <pre className="step-output">{output}</pre>}
      {s.spillUri && (!full || full.hasMore) && (
        <div className="step-more">
          <button type="button" className="link-btn" onClick={() => void loadMore()} disabled={loading}>
            {loading && <Spinner />}
            {full ? `继续加载（已载入 ${full.content.length} / ${full.total} 字）` : "加载完整输出"}
          </button>
          {error && <span className="step-error">{error}</span>}
        </div>
      )}
    </li>
  );
}

// ==================== live strip ====================

/** What runs right now: the background commands with the tail of their output, or the node's own state line. */
export function LiveStrip({ node, jobs, now }: { node: TopologyNodeDTO; jobs: readonly CellJobDTO[]; now: number }) {
  if (jobs.length === 0 && node.state !== "running") return null;
  return (
    <section className="ag-live" aria-label="运行中实时预览">
      {jobs.length === 0 ? (
        <p className="ag-live-line">
          <span className="agent-dot running" aria-hidden="true" />
          <span className="ag-live-text">{node.stateDetail ?? node.statusLine ?? "正在处理…"}</span>
        </p>
      ) : (
        jobs.map((j) => (
          <div key={j.jobId} className="ag-job">
            <p className="ag-live-line">
              <span className="agent-dot running" aria-hidden="true" />
              <span className="ag-live-text">正在执行</span>
              <code className="ag-job-cmd" title={j.command || undefined}>
                {j.command || "后台命令"}
              </code>
              <span className="tl-time">{relativeTimeZh(j.startedAt, now)}开始</span>
            </p>
            {j.tail && <JobTail text={j.tail} />}
          </div>
        ))
      )}
    </section>
  );
}

function JobTail({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre ref={ref} className="ag-job-tail">
      {text}
    </pre>
  );
}
