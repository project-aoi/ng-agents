import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { BALL_LABEL, relativeTimeZh, type ActivityKind, type ActivityListDTO, type StatusDTO } from "../../shared/api";
import { api } from "../api";
import { routeHash, toFailure, useDeskId, useNavigate, useNow, useResource, useStatus, useToast, useToasts, type ViewKey } from "../state";
import { clientId, whenText } from "../text";
import { SourceText } from "./bits";
import { ButtonRow, Chevron, Kbd, Spinner, stripIcon, useOutsidePress } from "./controls";
import { ModelSwitch } from "./models";
import { ErrorState, Loading } from "./states";

// ==================== top bar ====================

const TABS: Array<{ key: ViewKey; icon: string; zh: string; en: string; n: string }> = [
  { key: "inbox", icon: "📥", zh: "待我处理", en: "", n: "1" },
  { key: "radar", icon: "🧭", zh: "项目全局", en: "", n: "2" },
  { key: "agents", icon: "👥", zh: "分身实况", en: "", n: "3" },
];

/** "等待外部" — the waiting ball's own words, without its icon (BUG-011: not only replies are waited for). */
const WAITING_WORDS = stripIcon(BALL_LABEL.waiting);

export function TopBar(props: { view: ViewKey; status: StatusDTO | null; onView(v: ViewKey): void; drawerOpen: boolean; onDrawer(): void }) {
  const { status } = props;
  const {setStatus} = useStatus();
  const toast = useToast();
  return (
    <header className="topbar">
      <nav className="tabs" aria-label="视图">
        {TABS.map((t) => {
          const count = t.key === "inbox" ? status?.humanPending : undefined;
          // From the status the app already keeps current: no extra request for the live count.
          const live = t.key === "agents" ? (status?.background.running ?? 0) : 0;
          const on = props.view === t.key;
          return (
            <button
              key={t.key}
              type="button"
              className={`tab${on ? " on" : ""}`}
              aria-current={on ? "page" : undefined}
              onClick={() => props.onView(t.key)}
              title={`${t.zh}（快捷键 ${t.n}）`}
            >
              <span className="tab-icon" aria-hidden="true">
                {t.icon}
              </span>
              <span className="tab-n" aria-hidden="true">
                {t.n}.
              </span>
              <span className="tab-zh">{t.zh}</span>
              <span className="tab-en">{t.en}</span>
              {count !== undefined && (
                <span className={`tab-count${count > 0 ? "" : " zero"}`} aria-label={`${count} 张待确认`}>
                  {count}
                </span>
              )}
              {live > 0 && <span className="tab-live">· {live} 在跑</span>}
            </button>
          );
        })}
      </nav>
      <div className="topbar-right">
        {status && <ModelSwitch status={status} />}
        <button type="button" className={`drawer-trigger${props.drawerOpen ? " on" : ""}`} aria-expanded={props.drawerOpen} aria-controls="drawer" onClick={props.onDrawer} title="随手记 / 信源（快捷键 5）">
          <span aria-hidden="true">⚡</span> <span className="dt-label">随手记 / 信源</span>
        </button>
      </div>
    </header>
  );
}

// ==================== the one-line status under it ====================

export function StatusLine(props: { view: ViewKey; status: StatusDTO | null; connected: boolean; open: boolean; onToggle(): void; onClose(): void }) {
  const { status } = props;
  const text = !status ? "正在连接工作台…" : props.view==="inbox" ? `待我处理 ${status.humanPending} 项` : props.view === "agents" ? agentsLine(status) : status.statusLine.radar;
  const wrap = useRef<HTMLDivElement>(null);
  useOutsidePress(props.open, wrap, props.onClose);

  return (
    <div className="statusline" ref={wrap}>
      {!props.connected && (
        <span className="conn" role="status">
          <span className="conn-dot" aria-hidden="true" />
          实时更新已断开，正在重连…
        </span>
      )}
      <button type="button" className="status-toggle" aria-expanded={props.open} aria-controls="status-panel" onClick={props.onToggle}>
        <span className="status-text">{text}</span>
        <Chevron open={props.open} />
      </button>
      {props.open && status && <StatusPanel view={props.view} status={status} />}
    </div>
  );
}

/** The status line has no ready-made text for 分身实况 (StatusDTO.statusLine covers three views): built from the counts. */
function agentsLine(s: StatusDTO): string {
  const bg = s.background;
  if (bg.total === 0) return "后台没有分身在岗";
  return `${bg.running} 个分身在跑 · ${bg.waiting} 个${WAITING_WORDS}${bg.jobs > 0 ? ` · ${bg.jobs} 个长任务` : ""}${bg.paused > 0 ? ` · ${bg.paused} 个已暂停` : ""} · 共 ${bg.total} 个在岗`;
}

const KIND_FILTERS: Array<{ key: ActivityKind | "all"; label: string }> = [
  { key: "all", label: "全部" },
  { key: "notification_archived", label: "静默归档" },
  { key: "note_saved", label: "随手笔记" },
  { key: "reminder_set", label: "提醒" },
  { key: "card_withdrawn", label: "撤下的卡" },
  { key: "action_completed", label: "已办完" },
];

function StatusPanel({ view, status }: { view: ViewKey; status: StatusDTO }) {
  const now = useNow();
  const [kind, setKind] = useState<ActivityKind | "all">("all");
  const res = useResource<ActivityListDTO>(`activity:${kind}`, () => api.activity(kind === "all" ? undefined : kind), ["activity"]);
  const { setStatus } = useStatus();
  const toast = useToast();
  const delivered = status.notifications;
  const t = status.today;
  const bg = status.background;

  return (
    <div className="status-panel" id="status-panel" role="region" aria-label="后台记录">
      <div className="sp-summary">
        {view === "inbox" && (
          <>
            <p>
              今天：静默归档 {t.archivedNotifications} 条通知 · 存好 {t.notesSaved} 条随手笔记 · 设好 {t.remindersSet} 个提醒 · 撤下 {t.cardsWithdrawn} 张卡
            </p>
            <p className="muted">
              后台：{bg.running} 项分身运行中 · {bg.waiting} 项{WAITING_WORDS}{bg.jobs > 0 ? ` · ${bg.jobs} 个长任务` : ""}
              {bg.paused > 0 ? ` · ${bg.paused} 项已暂停` : ""}
              {status.humanSnoozed > 0 ? ` · ${status.humanSnoozed} 张卡已推迟` : ""}
            </p>
          </>
        )}
        {view === "radar" && (
          <>
            <p>
              {status.radar.activeProjects} 个进行中项目 · {status.radar.stalledProjects} 个停滞 · {status.radar.somedayProjects} 个以后再说
            </p>
            <p className="muted">下次周回顾 {whenText(status.radar.nextReviewAt, now)}</p>
          </>
        )}
        {view === "agents" && (
          <>
            <p>{agentsLine(status)}</p>
            <p className="muted">在这里可以看每个分身做了什么，也可以直接给它发话；需要你拍板的事仍在待确认里。</p>
          </>
        )}
      </div>

      {delivered.length > 0 && (
        <section className="sp-section">
          <h3>最近的提示</h3>
          <ul className="notes">
            {delivered.slice(0, 5).map((n) => (
              <li key={n.id}>
                {n.title && <strong>{n.title} </strong>}
                <span>{n.text}</span>
                <span className="muted small"> · {relativeTimeZh(n.at, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="sp-section">
        <div className="sp-head">
          <h3>后台替你处理过的事</h3>
          <div className="chips" role="radiogroup" aria-label="按类型筛选">
            {KIND_FILTERS.map((k) => (
              <button key={k.key} type="button" role="radio" aria-checked={kind === k.key} className={`chip${kind === k.key ? " on" : ""}`} onClick={() => setKind(k.key)}>
                {k.label}
                {k.key !== "all" && res.data ? <span className="count">{res.data.counts[k.key]}</span> : null}
              </button>
            ))}
          </div>
        </div>
        {!res.data ? (
          res.error && !res.loading ? (
            <ErrorState error={res.error} onRetry={res.reload} title="记录没能载入" />
          ) : (
            <Loading label="正在载入记录…" />
          )
        ) : res.data.items.length === 0 ? (
          <p className="muted small">还没有记录。</p>
        ) : (
          <ul className="activity">
            {res.data.items.map((a) => (
              <li key={`${a.cellId}/${a.id}`} className={a.restoredAt ? "restored" : ""}>
                <div className="act-main">
                  <span className="act-kind">{a.kindLabel}</span>
                  <span className="act-title">{a.title}</span>
                  <span className="muted small">
                    {relativeTimeZh(a.at, now)}
                    {a.source && (
                      <>
                        {" · 来自 "}
                        <SourceText source={{ ...a.source, at: 0 }} now={now} />
                      </>
                    )}
                    {a.remindAt !== null && ` · 到 ${whenText(a.remindAt, now)} 提醒`}
                    {a.restoredAt !== null && " · 已移回待确认"}
                  </span>
                  {a.detail && <span className="act-detail">{a.detail}</span>}
                  {a.rawInput && <span className="raw-text small clamp">{a.rawInput}</span>}
                </div>
                {a.buttons.length > 0 && (
                  <ButtonRow
                    size="sm"
                    buttons={a.buttons}
                    onRun={async (b) => {
                      try {
                        const r = await api.restoreActivity(b);
                        res.set(r.view);
                        setStatus(r.status);
                        toast({ tone: r.ok ? "success" : "warn", text: r.message });
                      } catch (err) {
                        toast({ tone: "error", text: toFailure(err).message });
                      }
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ==================== bottom bar ====================

export function BottomBar({ view, inputRef }: { view: ViewKey; inputRef: RefObject<HTMLInputElement | null> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useRef(clientId());
  const toast = useToast();
  const { setStatus } = useStatus();
  const navigate = useNavigate();
  const deskId = useDeskId();
  // 分身实况 has its own box for the selected node: the bar folds to the key hints and leaves the height to the panes.
  const folded = view === "agents";

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      // A retry after a lost answer reuses the id, so the server keeps the note once.
      const r = await api.capture({ text: value, clientId: id.current });
      setStatus(r.status);
      toast({ tone: "success", text: r.message });
      setText("");
      id.current = clientId();
    } catch (err) {
      toast({ tone: "error", text: `没收进去：${toFailure(err).message}` });
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const desk = { view: "agents" as const, cellId: deskId };
  return (
    <footer className={`bottombar${folded ? " folded" : ""}`}>
      {!folded && (
        <form
          className="quick"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <span className="quick-icon" aria-hidden="true">
            ⚡
          </span>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
            onKeyDown={onKey}
            placeholder="随手记一句，回车收进信箱：微事直接办好，重活交给后台分身"
            aria-label="随手记"
            enterKeyHint="send"
            maxLength={4000}
          />
          <button type="submit" className="btn sm" disabled={busy || !text.trim()}>
            {busy && <Spinner />}收进信箱
          </button>
        </form>
      )}
      {!folded && (
        <a
          className="desk-link"
          href={routeHash(desk)}
          onClick={(e) => {
            e.preventDefault();
            navigate(desk);
          }}
        >
          查看与总助理对话
        </a>
      )}
      <div className="hints" aria-label="快捷键">
        <span>
          <Kbd>1</Kbd>
          <Kbd>2</Kbd>
          <Kbd>3</Kbd>
          切换视图
        </span>
        <span>
          <Kbd>/</Kbd> {folded ? "发话" : "随手记"}
        </span>
        <span>
          <Kbd>5</Kbd> 信源
        </span>
        {view === "inbox" && (
          <>
            <span><Kbd>N</Kbd> 下一张</span>
            <span><Kbd>Ctrl/⌘ S</Kbd> 专注编辑时保存</span>
          </>
        )}
        {folded && (
          <>
            <span>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <Kbd>←</Kbd>
              <Kbd>→</Kbd> 在拓扑里移动
            </span>
            <span>
              <Kbd>Enter</Kbd> 发送 · <Kbd>Shift Enter</Kbd> 换行
            </span>
          </>
        )}
        <span>
          <Kbd>Esc</Kbd> 关闭
        </span>
      </div>
    </footer>
  );
}

// ==================== toasts ====================

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <div className="toast-body">
            {t.title && <strong>{t.title}</strong>}
            <span>{t.text}</span>
          </div>
          {t.action && (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
