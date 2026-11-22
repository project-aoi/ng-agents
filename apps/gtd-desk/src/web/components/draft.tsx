import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import type { ArtifactDTO } from "../../shared/api";
import { api } from "../api";
import { toFailure, type Tone } from "../state";
import { lineOffsets, parseDecisions } from "../text";
import { Spinner } from "./controls";

// The owner's text is never replaced behind their back (docs/04 §三 "绝不覆盖手写改动"): a newer server version is
// adopted only while the editor holds no unsaved edits; otherwise it is kept aside as a conflict to merge.

export interface DraftApi {
  /** The version the editor text is based on. */
  base: ArtifactDTO;
  text: string;
  dirty: boolean;
  /** A newer version that arrived while there were unsaved edits (or that a save ran into). */
  conflict: ArtifactDTO | null;
  /** A newer agent version was swapped in while on screen: ask the owner to look again. */
  refreshedTo: number | null;
  saving: boolean;
  message: { tone: Tone; text: string } | null;
  setText(text: string): void;
  revert(): void;
  /** Saves unsaved edits (no-op when clean). Null when it did not save (conflict or error). */
  save(): Promise<ArtifactDTO | null>;
  /** "我已合并": save the editor text on top of the newer version. */
  saveOverConflict(): Promise<ArtifactDTO | null>;
  /** Drop the local edits and take the newer version. */
  takeTheirs(): void;
  acknowledgeRefresh(): void;
  /** A server copy of this draft (e.g. after removing a parked addition). */
  accept(a: ArtifactDTO): void;
}

interface DraftInner {
  base: ArtifactDTO;
  text: string;
  conflict: ArtifactDTO | null;
  refreshedTo: number | null;
}

/**
 * Unsaved text outlives the editor that held it (moving to the next card, leaving the workspace): it is kept here
 * for the life of the page, keyed by draft, and comes back — reconciled against the server's version — on reopen.
 */
const unsaved = new Map<string, { text: string; base: ArtifactDTO }>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (unsaved.size > 0) e.preventDefault();
  });
}

/** Keep drafts that still belong to an open or snoozed item. */
export function retainUnsaved(openArtifactIds: readonly string[]): void {
  const open = new Set(openArtifactIds);
  for (const artifactId of unsaved.keys()) {
    if (!open.has(artifactId)) unsaved.delete(artifactId);
  }
}

function restore(a: ArtifactDTO): DraftInner {
  const kept = unsaved.get(a.artifactId);
  const fresh: DraftInner = { base: a, text: a.body, conflict: null, refreshedTo: null };
  return kept ? reconcile({ base: kept.base, text: kept.text, conflict: null, refreshedTo: null }, a) : fresh;
}

function reconcile(s: DraftInner, incoming: ArtifactDTO): DraftInner {
  if (incoming.artifactId !== s.base.artifactId) return restore(incoming);
  if (incoming.version < s.base.version) return s;
  if (incoming.version === s.base.version) return { ...s, base: incoming };
  // Newer. Identical to what the editor already shows (e.g. our own save echoed back): just move the base.
  if (incoming.body === s.text) return { ...s, base: incoming, conflict: null };
  const dirty = s.text !== s.base.body;
  // Swapped in under the owner's eyes (by the agent or another window): they must look again before confirming.
  if (!dirty) return { base: incoming, text: incoming.body, conflict: null, refreshedTo: incoming.version };
  return { ...s, conflict: s.conflict && s.conflict.version > incoming.version ? s.conflict : incoming };
}

export function useDraft(artifact: ArtifactDTO | null): DraftApi | null {
  const [inner, setInner] = useState<DraftInner | null>(() => (artifact ? restore(artifact) : null));
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const [message, setMessage] = useState<DraftApi["message"]>(null);
  const innerRef = useRef(inner);
  innerRef.current = inner;

  useEffect(() => {
    if (!artifact) {
      setInner(null);
      return;
    }
    setInner((s) => (s ? reconcile(s, artifact) : restore(artifact)));
  }, [artifact]);

  useEffect(() => {
    if (!inner) return;
    const id = inner.base.artifactId;
    if (inner.text !== inner.base.body || inner.conflict) unsaved.set(id, { text: inner.text, base: inner.base });
    else unsaved.delete(id);
  }, [inner]);

  const doSave = useCallback(async (expectedVersion: number): Promise<ArtifactDTO | null> => {
    const s = innerRef.current;
    if (!s || saveInFlight.current) return null;
    saveInFlight.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const r = await api.saveArtifact(s.base.save, { expectedVersion, body: s.text });
      if (r.ok && r.outcome === "saved") {
        setInner((cur) => (cur ? { base: r.artifact, text: cur.text, conflict: null, refreshedTo: null } : cur));
        setMessage({ tone: "success", text: r.message });
        return r.artifact;
      }
      setInner((cur) => (cur ? { ...cur, conflict: r.artifact } : cur));
      setMessage({ tone: "warn", text: r.message });
      return null;
    } catch (err) {
      setMessage({ tone: "error", text: `没有保存：${toFailure(err).message}` });
      return null;
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, []);

  if (!inner) return null;
  const dirty = inner.text !== inner.base.body;
  return {
    base: inner.base,
    text: inner.text,
    dirty,
    conflict: inner.conflict,
    refreshedTo: inner.refreshedTo,
    saving,
    message,
    setText: (text) => {
      setInner((s) => (s ? { ...s, text, refreshedTo: null } : s));
      setMessage(null);
    },
    revert: () => setInner((s) => (s ? { ...s, text: (s.conflict ?? s.base).body, base: s.conflict ?? s.base, conflict: null } : s)),
    save: async () => {
      const s = innerRef.current;
      if (!s) return null;
      if (s.conflict) {
        setMessage({ tone: "warn", text: "草稿有更新的版本，请先合并再保存" });
        return null;
      }
      if (s.text === s.base.body) return s.base;
      return doSave(s.base.version);
    },
    saveOverConflict: async () => {
      const s = innerRef.current;
      if (!s?.conflict) return s?.base ?? null;
      return doSave(s.conflict.version);
    },
    takeTheirs: () => {
      setInner((s) => (s?.conflict ? { base: s.conflict, text: s.conflict.body, conflict: null, refreshedTo: null } : s));
      setMessage(null);
    },
    acknowledgeRefresh: () => setInner((s) => (s ? { ...s, refreshedTo: null } : s)),
    accept: (a) => setInner((s) => (s ? reconcile(s, a) : restore(a))),
  };
}

// ==================== textarea with highlighted decision passages ====================

/**
 * A plain textarea over a backdrop that paints the `> [!DECISION]` passages. Both share font metrics and width,
 * and the textarea grows with its content, so the painted lines stay under the text without scroll syncing.
 */
export function HighlightedTextarea(props: {
  value: string;
  onChange?(v: string): void;
  readOnly?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onKeyDown?(e: ReactKeyboardEvent<HTMLTextAreaElement>): void;
  ariaLabel: string;
  minRows?: number;
  highlight?: boolean;
  mono?: boolean;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = props.textareaRef ?? own;
  const decisions = useMemo(() => (props.highlight ? parseDecisions(props.value) : []), [props.value, props.highlight]);
  const lines = useMemo(() => props.value.split("\n"), [props.value]);
  const marks = useMemo(() => {
    const m = new Map<number, string>();
    for (const d of decisions) {
      for (let i = d.startLine; i <= d.endLine; i++) {
        m.set(i, `dl${i === d.startLine ? " dl-start" : ""}${i === d.endLine ? " dl-end" : ""}`);
      }
    }
    return m;
  }, [decisions]);

  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  }, [props.value, ref]);

  useEffect(() => {
    const ta = ref.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    // Width changes rewrap the text: recompute the height.
    const ro = new ResizeObserver(() => {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight + 2}px`;
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [ref]);

  return (
    <div className={`hl-editor${props.readOnly ? " readonly" : ""}${props.mono ? " mono" : ""}`}>
      {marks.size > 0 && (
        <div className="hl-backdrop" aria-hidden="true">
          {lines.map((l, i) => (
            <div key={i} className={marks.get(i) ?? undefined}>
              {l || "​"}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="hl-textarea"
        value={props.value}
        readOnly={props.readOnly}
        rows={props.minRows ?? 4}
        spellCheck={false}
        aria-label={props.ariaLabel}
        onChange={(e) => props.onChange?.(e.target.value)}
        onKeyDown={props.onKeyDown}
      />
    </div>
  );
}

// ==================== the editor block ====================

export function DraftRefreshNotice({draft}: {draft: DraftApi}) {
  if (draft.refreshedTo === null || draft.conflict) return null;
  return <div className="banner warn" role="status">
    <span>草稿已更新到 v{draft.refreshedTo}，请核对后再确认。</span>
    <button type="button" className="btn sm ghost" onClick={draft.acknowledgeRefresh}>已核对新版</button>
  </div>;
}

export function DraftEditor(props: {
  draft: DraftApi;
  label?: ReactNode;
  readOnly?: boolean;
  readOnlyNote?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  minRows?: number;
  /** Larger editor (Engage workspace). */
  roomy?: boolean;
}) {
  const { draft } = props;
  const own = useRef<HTMLTextAreaElement>(null);
  const taRef = props.textareaRef ?? own;
  const [showTheirs, setShowTheirs] = useState(false);
  const highlight = draft.base.format === "markdown" || draft.base.format === "text";
  const decisions = useMemo(() => (highlight ? parseDecisions(draft.text) : []), [draft.text, highlight]);

  const jumpTo = (startLine: number, endLine: number) => {
    const ta = taRef.current;
    if (!ta) return;
    const [s, e] = lineOffsets(draft.text, startLine, endLine);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(s, e);
    const line = ta.parentElement?.querySelector(".hl-backdrop")?.children[startLine];
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    (line ?? ta).scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void draft.save();
    }
  };

  const c = draft.conflict;
  return (
    <section className={`draft${props.roomy ? " roomy" : ""}`} aria-label="草稿">
      <header className="draft-head">
        <div className="draft-title">
          {props.label}
          <span className="draft-version" title="草稿版本">
            {draft.base.versionText}
          </span>
          {draft.dirty && <span className="badge warn-soft">未保存的修改</span>}
        </div>
        {!props.readOnly && (
          <div className="draft-actions">
            {draft.saving && <Spinner label="正在保存" />}
            {draft.dirty && !c && (
              <>
                <button type="button" className="btn sm ghost" onClick={draft.revert} disabled={draft.saving}>
                  撤销修改
                </button>
                <button type="button" className="btn sm" onClick={() => void draft.save()} disabled={draft.saving} title="Ctrl / ⌘ + S">
                  保存为 v{draft.base.version + 1}
                </button>
              </>
            )}
          </div>
        )}
      </header>

      <DraftRefreshNotice draft={draft} />

      {c && (
        <div className="banner conflict" role="alert">
          <div>
            <strong>草稿在你编辑时已更新到 v{c.version}（{c.updatedByLabel}）。</strong>
            <span>你的修改还在编辑框里，没有丢，也还没有保存。对照新版本合并后再保存。</span>
          </div>
          <div className="banner-actions">
            <button type="button" className="btn sm ghost" onClick={() => setShowTheirs((v) => !v)} aria-expanded={showTheirs}>
              {showTheirs ? "收起新版本" : `对照 v${c.version}`}
            </button>
            <button type="button" className="btn sm ghost" onClick={draft.takeTheirs}>
              放弃我的修改，用 v{c.version}
            </button>
            <button type="button" className="btn sm primary" onClick={() => void draft.saveOverConflict()} disabled={draft.saving}>
              我已合并，保存为 v{c.version + 1}
            </button>
          </div>
          {showTheirs && <pre className="theirs">{c.body}</pre>}
        </div>
      )}

      {decisions.length > 0 && (
        <div className="decisions">
          <span className="decisions-label">需要你拍板</span>
          {decisions.map((d) => (
            <button key={`${d.startLine}-${d.label}`} type="button" className="decision-chip" onClick={() => jumpTo(d.startLine, d.endLine)}>
              {d.label}
            </button>
          ))}
        </div>
      )}

      <HighlightedTextarea
        value={draft.text}
        onChange={draft.setText}
        readOnly={props.readOnly}
        textareaRef={taRef}
        onKeyDown={onKeyDown}
        ariaLabel="草稿内容"
        minRows={props.minRows ?? 4}
        highlight={highlight}
        mono={draft.base.format === "json"}
      />

      {(props.readOnly && props.readOnlyNote) || draft.message ? (
        <p className={`draft-message ${draft.message?.tone ?? "muted"}`} role="status">
          {draft.message?.text ?? props.readOnlyNote}
        </p>
      ) : null}
    </section>
  );
}
