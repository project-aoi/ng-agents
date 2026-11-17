import { useState, type ReactNode } from "react";
import { setToken, type ApiFailure } from "../api";

export function Loading({ label }: { label: string }) {
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <span className="pulse" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Never a blank screen: the server's message, and a way to try again (or to enter the access token). */
export function ErrorState({ error, onRetry, title, extra }: { error: ApiFailure; onRetry(): void; title?: string; extra?: ReactNode }) {
  const [value, setValue] = useState("");
  if (error.unauthorized) {
    return (
      <div className="state state-error" role="alert">
        <h2>需要访问令牌</h2>
        <p className="muted">这个工作台设置了访问令牌。请粘贴令牌（也可以用 <code>#token=…</code> 打开链接），它只保存在这个标签页里。</p>
        <form
          className="token-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            setToken(value);
            window.location.reload();
          }}
        >
          <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="访问令牌" aria-label="访问令牌" />
          <button type="submit" className="btn primary">
            进入工作台
          </button>
        </form>
      </div>
    );
  }
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
