import { t } from "../i18n";
import { useCaptureImages, clipboardImages, CaptureImageGrid, CaptureAttachments } from "./capture-images";
import { useLayoutEffect, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ButtonDTO, CreateSourceRequest, SensorSourceDTO, SourcesDTO, SourcesMutationResponse } from "../../shared/api";
import { api, callButton } from "../api";
import { toFailure, useNow, useResource, useStatus, useToast } from "../state";
import { ago, clientId } from "../text";
import { ButtonRow, Spinner } from "./controls";
import { Empty, ErrorState, Loading } from "./states";

export type DrawerTab = "capture" | "sources";

/** ⚡ 随手记 / 信源: a light side sheet over the current view. */
export function Drawer(props: { open: boolean; tab: DrawerTab; onTab(t: DrawerTab): void; onClose(): void }) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (props.open) {
      opener.current = document.activeElement;
      panel.current?.focus();
    } else if (opener.current instanceof HTMLElement) {
      opener.current.focus();
      opener.current = null;
    }
  }, [props.open]);

  if (!props.open) return null;
  return (
    <div className="drawer-layer">
      <div className="drawer-scrim" onClick={props.onClose} aria-hidden="true" />
      <div className="drawer" id="drawer" role="dialog" aria-modal="true" aria-label="随手记 / 信源" ref={panel} tabIndex={-1}>
        <div className="drawer-head">
          <div className="segmented" role="tablist" aria-label="随手记 / 信源">
            <button type="button" role="tab" aria-selected={props.tab === "capture"} className={props.tab === "capture" ? "on" : ""} onClick={() => props.onTab("capture")}>
              ⚡ 随手记
            </button>
            <button type="button" role="tab" aria-selected={props.tab === "sources"} className={props.tab === "sources" ? "on" : ""} onClick={() => props.onTab("sources")}>
              信源
            </button>
          </div>
          <button type="button" className="btn ghost sm" onClick={props.onClose} aria-label="关闭">
            关闭 <span className="kbd-hint">Esc</span>
          </button>
        </div>
        <div className="drawer-body">{props.tab === "capture" ? <CapturePanel /> : <SourcesPanel />}</div>
      </div>
    </div>
  );
}

// ==================== 随手记 ====================

export function CapturePanel() {
  const images = useCaptureImages();
  const pasteCursor = useRef<number | null>(null);
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Array<{ id: string; text: string; attachments: Array<{label:string;uri:string}> }>>([]);
  const id = useRef(clientId());
  const submitting = useRef(false);
  const lastAttempt = useRef<{key:string;clientId:string} | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  const { setStatus } = useStatus();
  useEffect(() => ref.current?.focus(), []);
  useLayoutEffect(() => { if(pasteCursor.current!==null) {ref.current?.setSelectionRange(pasteCursor.current,pasteCursor.current);pasteCursor.current=null;} },[text]);

  const draftAttachments = [...images.attachments, ...(link.trim() ? [{label:link.trim(),uri:link.trim()}] : [])];
  const draftKey = JSON.stringify({text:text.trim(),attachments:draftAttachments});
  const editedAfterFailure = unconfirmed && lastAttempt.current?.key !== draftKey;
  const submit = async () => {
    const value = text.trim(), uri=link.trim();
    if ((!value && !uri && !images.images.length) || submitting.current || !images.ready) return;
    const attachments=draftAttachments.map(a=>({...a}));
    const key=JSON.stringify({text:value,attachments});
    const changed=lastAttempt.current !== null && lastAttempt.current.key !== key;
    if(changed) id.current=clientId();
    const submittedId=id.current;
    lastAttempt.current={key,clientId:submittedId};
    submitting.current=true;setBusy(true);
    try {
      const r = await api.capture({text:value,clientId:submittedId,...(attachments.length ? {attachments}:{})});
      setStatus(r.status);
      toast({tone:"success",text:changed ? `${r.message} · ${t("上次未确认的提交可能也已保存，请核对信箱", "The previous unconfirmed note may also have been saved; check the inbox")}` : r.message});
      setSent(l=>[{id:r.id,text:value || uri,attachments},...l].slice(0,5));
      images.clear();setText("");setLink("");setUnconfirmed(false);lastAttempt.current=null;
      id.current=clientId();ref.current?.focus();
    } catch (err) {
      setUnconfirmed(true);
      toast({tone:"error",text:`${t("没收进去", "Could not save")}: ${toFailure(err).message}`});
    } finally {submitting.current=false;setBusy(false);}
  };

  const paste = (e: import("react").ClipboardEvent<HTMLTextAreaElement>) => {
    const files=clipboardImages(e); if(!files.length || busy) return;
    e.preventDefault();
    const pasted=e.clipboardData.getData("text/plain");
    if(pasted) { const start=e.currentTarget.selectionStart,end=e.currentTarget.selectionEnd;
      setText(v=>v.slice(0,start)+pasted+v.slice(end)); pasteCursor.current=start+pasted.length; }
    images.add(files);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="capture">
      <p className="drawer-note">{t("随手敲一句丢进信箱，不用选分类、填日期。纯收藏和个人提醒会直接办好，只在顶栏轻提示一句；需要你拍板的事，主台会准备好材料。", "Drop a note into the inbox without categories or dates. Notes and reminders are handled directly; decisions are prepared for your review.")}</p>
      <textarea ref={ref} disabled={busy} onPaste={paste} rows={5} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder={t("比如：周五下午 3 点提醒我给牙医打电话", "For example: remind me to call the dentist on Friday at 3 PM")} aria-label={t("随手记内容", "Note content")} />
      <p className="drawer-note">{t("可粘贴最多5张图片，单张输入不超过10MB。图片会缩小并转换保存，GIF动画不保留。", "Paste up to 5 images, at most 10 MB each. Images are resized and converted; GIF animation is not preserved.")}</p>
      <CaptureImageGrid images={images.images} disabled={busy} remove={images.remove} retry={images.retry} />
      {images.error && <p className="draft-message error" role="alert">{images.error}</p>}
      <input disabled={busy} type="url" value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={onKey} placeholder={t("附一个链接（可选）", "Add a link (optional)")} aria-label={t("附带链接", "Attached link")} />
      {unconfirmed && <p className="draft-message" role="status">{t("上次提交结果未确认，可能已收进信箱。原内容可按同一请求重试；修改后再次提交会新建一条，请先核对原记录。", "The last result is unconfirmed and the note may already be saved. Retry unchanged content with the same request; submitting edited content creates a new note. Check the previous record first.")}</p>}
      <div className="capture-foot">
        <span className="kbd-hint">Ctrl / ⌘ + Enter · {t("收进信箱", "Save note")}</span>
        <button type="button" className="btn primary" disabled={busy || !images.ready || (!text.trim() && !link.trim() && !images.images.length)} onClick={() => void submit()}>
          {busy && <Spinner />}{editedAfterFailure ? t("提交修改后的随手记", "Save edited note") : t("收进信箱", "Save note")}
        </button>
      </div>
      {sent.length > 0 && (
        <div className="capture-sent">
          <h4>{t("刚收进去的", "Recently saved")}</h4>
          <ul>
            {sent.map((s) => (
              <li key={s.id}>{s.text}<CaptureAttachments items={s.attachments} /></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ==================== 信源 ====================

function SourcesPanel() {
  const res = useResource<SourcesDTO>("sources", api.sources, ["sources"]);
  const { setStatus } = useStatus();
  const toast = useToast();
  const now = useNow();
  const [adding, setAdding] = useState(false);

  const run = async (b: ButtonDTO, input?: Record<string, unknown>) => {
    try {
      const r = await callButton<SourcesMutationResponse>(b, input);
      res.set(r.view);
      setStatus(r.status);
      toast({ tone: r.ok ? "success" : "warn", text: r.message });
    } catch (err) {
      toast({ tone: "error", text: toFailure(err).message });
      res.reload();
    }
  };

  if (!res.data) return res.error && !res.loading ? <ErrorState error={res.error} onRetry={res.reload} title="信源没能载入" /> : <Loading label="正在载入信源…" />;
  const s = res.data;
  return (
    <div className="sources">
      <p className="drawer-note">信源只在命中目标时往信箱投信，平时安静运行，不会出现在项目列表里。</p>

      <section className="src-section">
        <div className="src-section-head">
          <h3>定时 / 条件监控</h3>
          <button type="button" className="btn sm" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
            {adding ? "收起" : "＋ 添加信源"}
          </button>
        </div>
        {adding && (
          <AddSource
            onDone={(r) => {
              res.set(r.view);
              setStatus(r.status);
              toast({ tone: "success", text: r.message });
              setAdding(false);
            }}
          />
        )}
        {s.sensors.length === 0 ? (
          <Empty title="还没有监控信源">比如“每周一 9 点看一眼核心指标”“盯着研发群里有没有人反馈支付报错”。</Empty>
        ) : (
          <ul className="src-list">
            {s.sensors.map((x) => (
              <SensorRow key={x.id} s={x} now={now} onRun={run} />
            ))}
          </ul>
        )}
      </section>
      {res.error && <p className="stale-note">刷新失败：{res.error.message}</p>}
    </div>
  );
}

function SensorRow({ s, now, onRun }: { s: SensorSourceDTO; now: number; onRun(b: ButtonDTO, input?: Record<string, unknown>): Promise<void> }) {
  return (
    <li className={`src sensor status-${s.status}`}>
      <div className="src-head">
        <span className={`state-dot ${s.status === "ok" ? "ready" : s.status === "paused" ? "stopped" : "error"}`} aria-hidden="true" />
        <strong>{s.title}</strong>
        <span className="muted small">{s.statusLabel}</span>
      </div>
      {s.description && <p className="small">{s.description}</p>}
      <p className="muted small">
        {s.scheduleText} · {s.processorLabel} · {s.modeLabel}
      </p>
      <p className="muted small">
        上次运行 {ago(s.lastRunAt, now)} · 上次命中 {ago(s.lastHitAt, now)} · 共运行 {s.runCount} 次，{s.mode === "observe" ? "记下" : "记下或报出"} {s.hitCount} 次{s.lastCheckText ? ` · ${s.lastCheckText}` : ""}
      </p>
      {s.lastError && <p className="src-error">{s.lastError}</p>}
      <ButtonRow buttons={s.buttons} onRun={onRun} size="sm" />
    </li>
  );
}

type CheckKind = "script" | "llm" | "code";

function AddSource({ onDone }: { onDone(r: SourcesMutationResponse): void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [freq, setFreq] = useState<"every" | "cron">("every");
  const [every, setEvery] = useState("60");
  const [cron, setCron] = useState("0 9 * * 1");
  const [check, setCheck] = useState<CheckKind>("llm");
  const [detail, setDetail] = useState("");
  const [observe, setObserve] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!title.trim()) return setError("给信源起个名字");
    if (!detail.trim()) return setError(check === "llm" ? "说说要检查什么" : check === "script" ? "填写脚本路径" : "填写检查名");
    const schedule: CreateSourceRequest["schedule"] = freq === "every" ? { everyMinutes: Number(every) } : { cron: cron.trim() };
    const req: CreateSourceRequest = {
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      schedule,
      check: check === "llm" ? { kind: "llm", instruction: detail.trim() } : check === "script" ? { kind: "script", path: detail.trim() } : { kind: "code", entry: detail.trim() },
      mode: observe ? "observe" : "active",
    };
    setBusy(true);
    try {
      onDone(await api.createSource(req));
    } catch (err) {
      setError(toFailure(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="add-source"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        <span>名称</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="比如：每周一指标巡检" autoFocus />
      </label>
      <label className="field">
        <span>说明（可选）</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="命中时想让 Agent 做什么" />
      </label>
      <fieldset className="field">
        <legend>多久检查一次</legend>
        <div className="radio-line">
          <label>
            <input type="radio" name="freq" checked={freq === "every"} onChange={() => setFreq("every")} /> 每隔
          </label>
          <input className="num" type="number" min={1} max={1440} value={every} onChange={(e) => setEvery(e.target.value)} disabled={freq !== "every"} aria-label="间隔分钟数" /> 分钟
        </div>
        <div className="radio-line">
          <label>
            <input type="radio" name="freq" checked={freq === "cron"} onChange={() => setFreq("cron")} /> 按时间表
          </label>
          <input className="mono" value={cron} onChange={(e) => setCron(e.target.value)} disabled={freq !== "cron"} aria-label="时间表（cron 表达式）" placeholder="0 9 * * 1" />
          <span className="muted small">分 时 日 月 周，例：0 9 * * 1 = 每周一 09:00</span>
        </div>
      </fieldset>
      <fieldset className="field">
        <legend>怎么检查</legend>
        <div className="radio-line">
          <label>
            <input type="radio" name="check" checked={check === "llm"} onChange={() => setCheck("llm")} /> 让模型初筛
          </label>
          <label>
            <input type="radio" name="check" checked={check === "script"} onChange={() => setCheck("script")} /> 脚本（零 Token）
          </label>
          <label>
            <input type="radio" name="check" checked={check === "code"} onChange={() => setCheck("code")} /> 内置检查
          </label>
        </div>
        {check === "llm" ? (
          <textarea rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="比如：看研发群里有没有人反馈支付报错，有就投一封信" aria-label="检查说明" />
        ) : (
          <input className="mono" value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={check === "script" ? "checks/metrics.sh（退出码 0 且无输出 = 没事）" : "检查名"} aria-label={check === "script" ? "脚本路径" : "检查名"} />
        )}
      </fieldset>
      <label className="check-line">
        <input type="checkbox" checked={observe} onChange={(e) => setObserve(e.target.checked)} /> 先只记观察笔记，不弹卡（看准了再改成命中时投进信箱）
      </label>
      {error && (
        <p className="draft-message error" role="alert">
          {error}
        </p>
      )}
      <div className="add-foot">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy && <Spinner />}添加信源
        </button>
      </div>
    </form>
  );
}
