import type { ReactNode } from "react";
import type { ApiFailure } from "../api";

export function Loading({ label }: { label: string }) {
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <span className="pulse" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Never a blank screen: the server's message, and a way to try again. */
export function ErrorState({ error, onRetry, title, extra }: { error: ApiFailure; onRetry(): void; title?: string; extra?: ReactNode }) {
  return (
    <div className="state state-error" role="alert">
      <h2>{title ?? "没能载入"}</h2>
      <p>{error.message}</p>
      <div className="state-actions">
        <button type="button" className="btn primary" onClick={onRetry}>
          重试
        </button>
        {extra}
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p className="state-title">{title}</p>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}
