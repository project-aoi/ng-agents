import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ButtonDTO, CellTimelineDTO, ComposerDTO, SendCellMessageRequest, StatusDTO } from "../../../shared/api";
import { api, callButton } from "../../api";
import { serverNow, toFailure, useDeskId, useNavigate, useStatus, useToast, type Tone } from "../../state";
import { clientId, excerpt } from "../../text";
import { ButtonRow, Spinner } from "../controls";
import type { CellTimeline } from "./data";

/** The send box's textarea: "/" focuses it while the Agents view is open. */
export const COMPOSER_INPUT_ID = "agents-composer-input";

const PRIMARY_LABEL: Partial<Record<ComposerDTO["mode"], string>> = {
  desk: "发送",
  wake: "发送并唤醒",
  running: "顺手补充",
  coordinator: "发送",
};

/** Unsent text per node, for the life of the page: switching nodes never carries a draft to the wrong one. */
const drafts = new Map<string, string>();

/** Whatever a quick button answers with: these fields are common to the mutation responses. */
interface QuickResult {
  ok?: boolean;
  message?: string;
  status?: StatusDTO;
  timeline?: CellTimelineDTO | null;
}

/**
 * The box under the timeline, driven entirely by `composer`: its hint, its placeholder, the button labels, the
 * "立即打断" option, the copy to the project and the reply chip. Read-only modes show the hint and quick buttons only.
 */
export function Composer(props: {
  cellId: string;
  title: string;
  composer: ComposerDTO;
  tl: CellTimeline;
  reply: { id: string; text: string } | null;
  onDismissReply(): void;
  /** After a send or a quick action (the topology may have changed). */
  onChanged(): void;
}) {
  const { composer: c, tl, cellId } = props;
  const [text, setText] = useState(() => drafts.get(cellId) ?? "");
  const [wake, setWake] = useState(false);
  const [busy, setBusy] = useState<"enqueue" | "steer" | null>(null);
  const [note, setNote] = useState<{ tone: Tone; text: string } | null>(null);
  // Rotated only after the server took the message, so a retry after a lost answer is stored once (same rule as 随手记).
  const id = useRef(clientId());
  const area = useRef<HTMLTextAreaElement>(null);
  const { setStatus } = useStatus();
  const toast = useToast();
  const navigate = useNavigate();
  const deskId = useDeskId();
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (text) drafts.set(cellId, text);
    else drafts.delete(cellId);
  }, [cellId, text]);

  useLayoutEffect(() => {
    const ta = area.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 200)}px`;
  }, [text]);

  const send = async (mode: "enqueue" | "steer") => {
    const value = text.trim();
    if (!value || busy) return;
    const cid = id.current;
    setBusy(mode);
    setNote(null);
    tl.addPending({ clientId: cid, text: value, mode, at: serverNow(), state: "sending" });
    setText("");
    const req: SendCellMessageRequest = {
      text: value,
      clientId: cid,
      ...(mode === "steer" ? { mode } : {}),
      ...(c.syncTo && wake ? { notifyParent: "wakeup" as const } : {}),
      ...(props.reply ? { replyToId: props.reply.id } : {}),
    };
    const fail = (message: string) => {
      if (!mounted.current) {
        const current = drafts.get(cellId);
        drafts.set(cellId, current ? `${value}\n\n${current}` : value);
        return;
      }
      tl.settlePending(cid, "failed");
      // The text goes back into the box (ahead of anything typed meanwhile) with the reason.
      setText((cur) => (cur.trim() ? `${value}\n\n${cur}` : value));
      setNote({ tone: "error", text: message });
    };
    try {
      const r = await api.sendCellMessage(cellId, req);
      setStatus(r.status);
      if (r.ok) {
        tl.settlePending(cid, "sent");
        if (r.timeline) tl.apply(r.timeline);
        else tl.refresh();
        id.current = clientId();
        setWake(false);
        if (props.reply) props.onDismissReply();
        setNote({ tone: "success", text: r.message });
        props.onChanged();
      } else {
        fail(r.message);
        if (r.timeline) tl.apply(r.timeline);
      }
    } catch (err) {
      fail(`没发出去：${toFailure(err).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void send("enqueue");
    }
  };

  const runQuick = async (b: ButtonDTO, input?: Record<string, unknown>) => {
    if (!b.endpoint) {
      // "去总助理另起新事项" has nothing to send: it is a way to the desk's conversation.
      if (/desk|总助理/i.test(`${b.id} ${b.label}`)) navigate({ view: "agents", cellId: deskId });
      return;
    }
    try {
      const r = await callButton<QuickResult | null>(b, input);
      if (r?.status) setStatus(r.status);
      if (r?.message) toast({ tone: r.ok === false ? "warn" : "success", text: r.message });
      if (r?.timeline) tl.apply(r.timeline);
      else tl.refresh();
    } catch (err) {
      toast({ tone: "error", text: toFailure(err).message });
    }
    props.onChanged();
  };

  const label = PRIMARY_LABEL[c.mode] ?? "发送";
  const empty = !text.trim();
  return (
    <div className={`ag-composer${c.enabled ? "" : " readonly"}`}>
      {c.hint && <p className="composer-hint">{c.hint}</p>}
      {c.quick.length > 0 && <ButtonRow size="sm" buttons={c.quick} onRun={runQuick} className="composer-quick" />}
      {c.enabled && (
        <>
          {props.reply && (
            <div className="reply-chip">
              <span className="reply-chip-text" title={props.reply.text}>
                回复：{excerpt(props.reply.text, 48)}
              </span>
              <button type="button" aria-label="不作为回复发送" title="不作为回复发送" onClick={props.onDismissReply}>
                ×
              </button>
            </div>
          )}
          <div className="composer-box">
            <textarea
              ref={area}
              id={COMPOSER_INPUT_ID}
              rows={2}
              value={text}
              placeholder={c.placeholder}
              aria-label={`给「${props.title}」发话`}
              maxLength={8000}
              enterKeyHint="send"
              onChange={(e) => {
                setText(e.target.value);
                if (note?.tone !== "error") setNote(null);
              }}
              onKeyDown={onKey}
            />
            <div className="composer-actions">
              {c.canSteer && (
                <button type="button" className="btn sm" disabled={empty || busy !== null} onClick={() => void send("steer")} title="立即打断它手上的事，先处理这句话">
                  {busy === "steer" && <Spinner />}立即打断
                </button>
              )}
              <button type="button" className="btn primary sm" disabled={empty || busy !== null} onClick={() => void send("enqueue")}>
                {busy === "enqueue" && <Spinner />}
                {label}
              </button>
            </div>
          </div>
          <div className="composer-foot">
            {c.syncTo ? (
              <span className="composer-sync">
                自动同步给所属项目「{c.syncTo.title}」
                <label className="check-inline">
                  <input type="checkbox" checked={wake} onChange={(e) => setWake(e.target.checked)} /> 同时立即唤醒项目
                </label>
              </span>
            ) : (
              <span />
            )}
            <span className="kbd-hint">Enter 发送 · Shift + Enter 换行</span>
          </div>
          {note && (
            <p className={`composer-note ${note.tone}`} role={note.tone === "error" ? "alert" : "status"}>
              {note.text}
            </p>
          )}
        </>
      )}
    </div>
  );
}
