import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ArtifactDTO, ArtifactRefDTO } from "../../shared/api";
import { api } from "../api";
import { useArtifactEvents, useResource } from "../state";
import { Markdown } from "./markdown";
import { ErrorState, Loading } from "./states";

/**
 * Reading a report or draft (research report, plan, review) without leaving the view: one side drawer shared by
 * Radar and Agents. Read-only — editing happens in the Engage workspace.
 */
export function ReportDrawer({ report, onClose }: { report: ArtifactRefDTO | null; onClose(): void }) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const open = report !== null;

  useEffect(() => {
    if (open) {
      opener.current ??= document.activeElement;
      panel.current?.focus();
    } else if (opener.current instanceof HTMLElement) {
      opener.current.focus();
      opener.current = null;
    }
  }, [open, report?.artifactId]);

  if (!report) return null;

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="drawer-layer">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div className="drawer report-drawer" role="dialog" aria-modal="true" aria-label={`报告：${report.title}`} ref={panel} tabIndex={-1} onKeyDown={onKey}>
        <div className="drawer-head">
          <div className="report-head-title">
            <h2>{report.title}</h2>
          </div>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="关闭">
            关闭 <span className="kbd-hint">Esc</span>
          </button>
        </div>
        <div className="drawer-body">
          <ReportBody key={report.artifactId} artifactId={report.artifactId} />
        </div>
      </div>
    </div>
  );
}

function ReportBody({ artifactId }: { artifactId: string }) {
  const res = useResource<ArtifactDTO>(`report:${artifactId}`, () => api.artifact(artifactId), []);
  // A newer version written while the drawer is open replaces what is shown (it is read-only, nothing to lose).
  useArtifactEvents(artifactId, () => res.reload());

  if (!res.data) return res.error && !res.loading ? <ErrorState error={res.error} onRetry={res.reload} title="报告没能打开" /> : <Loading label="正在打开报告…" />;
  const a = res.data;
  return (
    <article className="report">
      <p className="report-meta">
        <span className="draft-version">{a.versionText}</span>
        {a.updatedByLabel && <span className="muted small"> · {a.updatedByLabel}</span>}
      </p>
      <ReportText artifact={a} />
      {res.error && <p className="stale-note">刷新失败：{res.error.message}（显示的是上次载入的内容）</p>}
    </article>
  );
}

function ReportText({ artifact: a }: { artifact: ArtifactDTO }) {
  if (a.format === "markdown") return <Markdown text={a.body} className="report-md" />;
  if (a.format === "json") {
    const text = a.data !== undefined ? JSON.stringify(a.data, null, 2) : a.body;
    return <pre className="report-pre mono">{text}</pre>;
  }
  return <div className="report-plain">{a.body}</div>;
}
