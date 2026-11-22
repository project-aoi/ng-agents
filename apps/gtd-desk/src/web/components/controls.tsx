import { useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { serverTimeForLocalDate } from "../state";
import type { ButtonDTO } from "../../shared/api";

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

// ==================== confirm dialog ====================

export function ConfirmDialog(props: { open: boolean; text: string; confirmLabel?: string; danger?: boolean; onConfirm(): void; onCancel(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
      onClick={(e) => {
        if (e.target === ref.current) props.onCancel();
      }}
    >
      <p id={titleId} className="dialog-text">
        {props.text}
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          返回
        </button>
        <button type="button" className={`btn ${props.danger ? "danger" : "primary"}`} onClick={props.onConfirm} autoFocus>
          {props.confirmLabel ?? "确定"}
        </button>
      </div>
    </dialog>
  );
}

// ==================== popovers ====================

/** While `open`, a pointer press outside `wrap` calls `onOutside` (how menus and panels close on an outside click). */
export function useOutsidePress(open: boolean, wrap: RefObject<HTMLElement | null>, onOutside: () => void): void {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) cb.current();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, wrap]);
}

// ==================== menu ====================

export function Menu(props: { label: ReactNode; title?: string; children: (close: () => void) => ReactNode; align?: "start" | "end"; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useOutsidePress(open, wrap, () => setOpen(false));
  useEffect(() => {
    if (open) wrap.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...(wrap.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
      next?.focus();
    }
  };
  return (
    <div className="menu-wrap" ref={wrap} onKeyDown={onKey}>
      <button
        ref={trigger}
        type="button"
        className="btn ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={props.title}
        disabled={props.disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {props.label}
      </button>
      {open && (
        <div className={`menu ${props.align === "start" ? "start" : "end"}`} role="menu" id={menuId}>
          {props.children(close)}
        </div>
      )}
    </div>
  );
}

// ==================== a row of server-described buttons ====================

export interface ButtonRowHandle {
  /** Activates a button by id as if clicked (confirm / input flows included). False when it is not there. */
  trigger(id: string): boolean;
  triggerPrimary(): boolean;
  has(id: string): boolean;
}

export type RunButton = (button: ButtonDTO, input?: Record<string, unknown>) => Promise<unknown> | void;

const SUBMIT_LABEL: Record<string, string> = {
  instruction: "交给 Agent 重拟",
  text: "确定",
  datetime: "确定",
};

/**
 * Renders `ButtonDTO`s as they come from the server: the "main" group inline (primary first as ordered), the "more"
 * group behind a menu, `confirm` through a dialog, `input` through an inline field. While one runs, the row is
 * disabled so a double click cannot send twice.
 */
export function ButtonRow(props: {
  buttons: readonly ButtonDTO[];
  onRun: RunButton;
  disabled?: boolean;
  size?: "sm" | "md";
  /** Ids rendered elsewhere (or not at all). */
  hide?: readonly string[];
  /** Show the hovered/focused button's hint under the row. */
  hints?: boolean;
  /** Extra note under an input field, keyed by input kind. */
  inputNote?: Partial<Record<"instruction" | "text" | "datetime", string>>;
  handleRef?: Ref<ButtonRowHandle>;
  className?: string;
}) {
  const visible = props.buttons.filter((b) => !props.hide?.includes(b.id));
  const main = visible.filter((b) => b.group === "main");
  const more = visible.filter((b) => b.group === "more");
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<ButtonDTO | null>(null);
  const [inputFor, setInputFor] = useState<ButtonDTO | null>(null);
  const [value, setValue] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async (b: ButtonDTO, input?: Record<string, unknown>) => {
    setBusy(b.id);
    try {
      await props.onRun(b, input);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const activate = (b: ButtonDTO) => {
    if (busy || props.disabled) return;
    if (b.input) {
      setInputFor((cur) => (cur?.id === b.id ? null : b));
      setValue("");
      return;
    }
    if (b.confirm) {
      setAsking(b);
      return;
    }
    void run(b);
  };

  useImperativeHandle(
    props.handleRef,
    () => ({
      trigger(id) {
        const b = visible.find((x) => x.id === id);
        if (!b) return false;
        activate(b);
        return true;
      },
      triggerPrimary() {
        const b = visible.find((x) => x.primary) ?? main[0];
        if (!b) return false;
        activate(b);
        return true;
      },
      has(id) {
        return visible.some((x) => x.id === id);
      },
    }),
  );

  useEffect(() => {
    if (inputFor) inputRef.current?.focus();
  }, [inputFor]);

  const submitInput = async () => {
    const b = inputFor;
    if (!b?.input) return;
    const raw = value.trim();
    if (!raw) {
      inputRef.current?.focus();
      return;
    }
    let v: unknown = raw;
    if (b.input.kind === "datetime") {
      const t = serverTimeForLocalDate(raw);
      if (!Number.isFinite(t)) return;
      v = t;
    }
    await run(b, { [b.input.field]: v });
    if (mounted.current) {
      setInputFor(null);
      setValue("");
    }
  };

  const onInputKey = (e: ReactKeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setInputFor(null);
      return;
    }
    const multiline = inputFor?.input?.kind === "instruction";
    if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submitInput();
    }
  };

  const showHint = (b: ButtonDTO | null) => props.hints && setHint(b?.hint ?? null);
  const size = props.size === "sm" ? " sm" : "";

  const render = (b: ButtonDTO) => (
    <button
      key={b.id}
      type="button"
      className={`btn${b.primary ? " primary" : ""}${size}${inputFor?.id === b.id ? " active" : ""}`}
      disabled={props.disabled || (busy !== null && busy !== b.id)}
      aria-busy={busy === b.id}
      aria-expanded={b.input ? inputFor?.id === b.id : undefined}
      title={b.hint}
      onClick={() => activate(b)}
      onMouseEnter={() => showHint(b)}
      onMouseLeave={() => showHint(null)}
      onFocus={() => showHint(b)}
      onBlur={() => showHint(null)}
    >
      {busy === b.id && <Spinner />}
      {b.label}
    </button>
  );

  return (
    <div className={`button-row-wrap ${props.className ?? ""}`}>
      <div className="button-row">
        {main.map(render)}
        {more.length > 0 && (
          <span className="button-row-end">
            {more.length > 0 && (
              <Menu label="⋯ 更多" title="更多操作" disabled={props.disabled || busy !== null}>
                {(close) =>
                  more.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        close();
                        activate(b);
                      }}
                    >
                      <span>{b.label}</span>
                      {b.hint && <small>{b.hint}</small>}
                    </button>
                  ))
                }
              </Menu>
            )}
          </span>
        )}
      </div>
      {props.hints && (
        <p className="button-hint" aria-live="polite">
          {hint ?? " "}
        </p>
      )}
      {inputFor?.input && (
        <div className="input-row">
          {inputFor.input.kind === "instruction" ? (
            <textarea
              ref={inputRef}
              rows={3}
              value={value}
              placeholder={inputFor.input.placeholder}
              aria-label={inputFor.label}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onInputKey}
            />
          ) : (
            <input
              ref={inputRef}
              type={inputFor.input.kind === "datetime" ? "datetime-local" : "text"}
              value={value}
              placeholder={inputFor.input.placeholder}
              aria-label={inputFor.label}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onInputKey}
            />
          )}
          {props.inputNote?.[inputFor.input.kind] && <p className="input-note">{props.inputNote[inputFor.input.kind]}</p>}
          <div className="input-actions">
            <span className="kbd-hint">{inputFor.input.kind === "instruction" ? "Ctrl / ⌘ + Enter 提交 · Esc 取消" : "Enter 提交 · Esc 取消"}</span>
            <button type="button" className="btn sm" onClick={() => setInputFor(null)}>
              取消
            </button>
            <button type="button" className="btn primary sm" disabled={busy !== null || !value.trim()} onClick={() => void submitInput()}>
              {busy === inputFor.id && <Spinner />}
              {SUBMIT_LABEL[inputFor.input.kind] ?? "确定"}
            </button>
          </div>
        </div>
      )}
      {asking && (
        <ConfirmDialog
          open
          text={asking.confirm ?? ""}
          confirmLabel={stripIcon(asking.label)}
          danger={asking.id === "cancel" || asking.id === "delete"}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const b = asking;
            setAsking(null);
            void run(b);
          }}
        />
      )}
    </div>
  );
}

/** "✕ 取消项目" → "取消项目" for a dialog's confirm button. */
export function stripIcon(label: string): string {
  return label.replace(/^[^\p{L}\p{N}“"]+/u, "").trim() || label;
}

// ==================== small pieces ====================

/** Drawn, not a text glyph: ▾/▸ fall back to tiny dots in several CJK fonts. */
export function Chevron({ open, dir = "down" }: { open?: boolean; dir?: "down" | "right" }) {
  const rotate = dir === "right" ? (open ? 90 : 0) : open ? 180 : 0;
  const base = dir === "right" ? "M4.5 2.5L8 6l-3.5 3.5" : "M2.5 4.5L6 8l3.5-3.5";
  return (
    <svg className="chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" style={{ transform: `rotate(${rotate}deg)` }}>
      <path d={base} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function BallChip({ owner, label }: { owner: "human" | "agent" | "waiting"; label: string }) {
  return <span className={`ball ball-${owner}`}>{label}</span>;
}

export function ProgressBar({ done, total, label }: { done: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={label ?? `${done}/${total}`}>
      <span className="progress-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}
