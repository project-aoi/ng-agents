import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { relativeTimeZh, type ActivityKind, type ActivityListDTO, type StatusDTO } from "../../shared/api";
import { api } from "../api";
import { toFailure, useNow, useResource, useStatus, useToast, useToasts, type ViewKey } from "../state";
import { clientId, whenText } from "../text";
import { SourceText } from "./bits";
import { ButtonRow, Chevron, Kbd, Spinner, useOutsidePress } from "./controls";
import { ModelSwitch } from "./models";
import { ErrorState, Loading } from "./states";

// ==================== top bar ====================

const TABS: Array<{ key: ViewKey; icon: string; zh: string; en: string; n: string }> = [
  { key: "clarify", icon: "📥", zh: "待确认", en: "Clarify", n: "1" },
  { key: "engage", icon: "🎯", zh: "专注工作区", en: "Engage", n: "2" },
  { key: "radar", icon: "🧭", zh: "项目全局", en: "Radar", n: "3" },
];

export function TopBar(props: { view: ViewKey; status: StatusDTO | null; onView(v: ViewKey): void; drawerOpen: boolean; onDrawer(): void }) {
  const { status } = props;
  return (
    <header className="topbar">
      <nav className="tabs" aria-label="视图">
        {TABS.map((t) => {
          const count = t.key === "clarify" ? status?.clarify.pending : undefined;
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
              {t.key === "engage" && status?.focus.on && <span className="focus-dot" title="免打扰已开启" aria-label="免打扰已开启" />}
            </button>
          );
        })}
      </nav>
      <div className="topbar-right">
        {status && (status.demo ? <span className="mode-badge" title={`后端：${status.backend}`}>演示模式</span> : <ModelSwitch status={status} />)}
        <button type="button" className={`drawer-trigger${props.drawerOpen ? " on" : ""}`} aria-expanded={props.drawerOpen} aria-controls="drawer" onClick={props.onDrawer} title="随手记 / 信源（快捷键 4）">
          <span aria-hidden="true">⚡</span> <span className="dt-label">随手记 / 信源</span>
        </button>
      </div>
    </header>
  );
}

// ==================== the one-line status under it ====================

export function StatusLine(props: { view: ViewKey; status: StatusDTO | null; connected: boolean; open: boolean; onToggle(): void; onClose(): void }) {
  const { status } = props;
  const text = status ? status.statusLine[props.view] : "正在连接工作台…";
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
  const held = status.notifications.filter((n) => n.state === "held");
  const delivered = status.notifications.filter((n) => n.state === "delivered");
  const t = status.today;
  const bg = status.background;

  return (
    <div className="status-panel" id="status-panel" role="region" aria-label="后台记录">
      <div className="sp-summary">
        {view === "clarify" && (
          <>
            <p>
              今天：静默归档 {t.archivedNotifications} 条通知 · 存好 {t.notesSaved} 条随手笔记 · 设好 {t.remindersSet} 个提醒 · 撤下 {t.cardsWithdrawn} 张卡
            </p>
            <p className="muted">
              后台：{bg.running} 项分身运行中 · {bg.waiting} 项在等外部回复{bg.jobs > 0 ? ` · ${bg.jobs} 个长任务` : ""}
              {bg.paused > 0 ? ` · ${bg.paused} 项已暂停` : ""}
              {status.clarify.snoozed > 0 ? ` · ${status.clarify.snoozed} 张卡已推迟` : ""}
            </p>
          </>
        )}
        {view === "engage" && (
          <>
            <p>{status.statusLine.engage}</p>
            <p className="muted">只暂存面向你的非紧急外部通知；后台分身之间的汇报照常进行，不受影响。</p>
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
      </div>

      {held.length > 0 && (
        <section className="sp-section">
          <h3>暂存的通知 <span className="muted small">（退出专注后统一送达）</span></h3>
          <ul className="notes">
            {held.map((n) => (
              <li key={n.id}>
                {n.title && <strong>{n.title} </strong>}
                <span>{n.text}</span>
                <span className="muted small"> · {relativeTimeZh(n.at, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
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

export function BottomBar({ view, inputRef, workspace }: { view: ViewKey; inputRef: RefObject<HTMLInputElement | null>; workspace: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useRef(clientId());
  const toast = useToast();
  const { setStatus } = useStatus();

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

  return (
    <footer className="bottombar">
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
      <div className="hints" aria-label="快捷键">
        <span>
          <Kbd>1</Kbd>
          <Kbd>2</Kbd>
          <Kbd>3</Kbd> 切换视图
        </span>
        <span>
          <Kbd>/</Kbd> 随手记
        </span>
        <span>
          <Kbd>4</Kbd> 信源
        </span>
        {view === "clarify" && (
          <>
            <span>
              <Kbd>Enter</Kbd> 确认
            </span>
            <span>
              <Kbd>N</Kbd> 下一张
            </span>
            <span>
              <Kbd>E</Kbd> 编辑
            </span>
            <span>
              <Kbd>S</Kbd> 推迟
            </span>
            <span>
              <Kbd>R</Kbd> 修改意见
            </span>
          </>
        )}
        {view === "engage" && workspace && (
          <span>
            <Kbd>Ctrl/⌘ S</Kbd> 保存
          </span>
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
