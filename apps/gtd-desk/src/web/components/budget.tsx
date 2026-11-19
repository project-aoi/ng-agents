import { useEffect, useId, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { StatusDTO } from "../../shared/api";
import { api } from "../api";
import { toFailure, useStatus, useToast } from "../state";
import { Chevron, ConfirmDialog, Spinner, useOutsidePress } from "./controls";

// The owner's budget-limits switch, next to the model switch in the top bar and of the same weight: a label that opens
// a small panel with one switch. Turning limits off is the risky direction, so only that asks first.

const OFF_CONFIRM = "关闭后，所有任务都不再因额度暂停，直到你重新开启。确定关闭？";

/** A server that does not send the switch yet means limits apply (the safe reading). */
export function budgetState(status: StatusDTO | null): { enforced: boolean; label: string } {
  const b = status?.budgetLimits;
  if (!b || typeof b.enforced !== "boolean") return { enforced: true, label: "额度限制：开" };
  return { enforced: b.enforced, label: b.label || (b.enforced ? "额度限制：开" : "额度限制：已关闭") };
}

export function BudgetSwitch({ status }: { status: StatusDTO }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const b = budgetState(status);
  useOutsidePress(open, wrap, () => setOpen(false));

  const onKey = (e: ReactKeyboardEvent) => {
    if (!open || document.querySelector("dialog[open]")) return; // the confirm dialog handles its own Esc
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    e.stopPropagation();
  };
  const onBlur = (e: ReactFocusEvent) => {
    if (open && e.relatedTarget instanceof Node && !wrap.current?.contains(e.relatedTarget)) setOpen(false);
  };

  return (
    <div className="model-switch budget-switch" ref={wrap} onKeyDown={onKey} onBlur={onBlur}>
      <button
        ref={trigger}
        type="button"
        className={`model-trigger${b.enforced ? "" : " budget-off"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={`${b.label}（点击设置）`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="mt-model">{b.label}</span>
        <span className="mt-short">额度</span>
        <Chevron open={open} />
      </button>
      {open && <BudgetPanel id={panelId} enforced={b.enforced} />}
    </div>
  );
}

function BudgetPanel({ id, enforced }: { id: string; enforced: boolean }) {
  const { setStatus } = useStatus();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const headId = useId();
  useEffect(() => panel.current?.focus(), []);

  const save = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.setBudgetLimits(next);
      setStatus(r.status);
      toast({ tone: r.ok ? "success" : "warn", text: r.message });
    } catch (err) {
      // Nothing changed: the switch keeps showing the state the server last reported.
      const message = toFailure(err).message;
      setError(message);
      toast({ tone: "error", text: `额度限制没能${next ? "开启" : "关闭"}：${message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="model-panel budget-panel" id={id} role="dialog" aria-labelledby={headId} ref={panel} tabIndex={-1}>
      <div className="mp-head">
        <h2 id={headId}>额度</h2>
        {busy && <Spinner label="正在保存" />}
      </div>
      <label className="switch-line">
        <input
          type="checkbox"
          role="switch"
          checked={enforced}
          disabled={busy}
          onChange={(e) => {
            if (e.target.checked) void save(true);
            else setAsking(true);
          }}
        />
        <span className="switch-track" aria-hidden="true" />
        <span className="switch-label">额度限制</span>
      </label>
      <p className="mp-desc">{enforced ? "任务用到额度上限会暂停并请你确认" : "不限额度：任务不会因额度暂停，用量照常统计"}</p>
      {error && (
        <p className="mp-error" role="alert">
          没能切换：{error}
        </p>
      )}
      {asking && (
        <ConfirmDialog
          open
          text={OFF_CONFIRM}
          confirmLabel="关闭额度限制"
          danger
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void save(false);
          }}
        />
      )}
    </div>
  );
}
