import { Fragment, useState } from "react";
import type { ButtonDTO, CellControlResponse, CellTimelineDTO, CellControlRequest, TopologyNodeDTO } from "../../../shared/api";
import { callButton, request } from "../../api";
import { toFailure, useNavigate, useOpenReport, useStatus, useToast } from "../../state";
import { budgetState } from "../budget";
import { ButtonRow, Chevron, ProgressBar } from "../controls";
import { Markdown } from "../markdown";
import { compactCount, engineText, isCoordinator, tokensText } from "./model";

const CONTROL_ACTIONS = new Set<CellControlRequest["action"]>(["pause", "resume", "cancel"]);

/** The selected node at a glance: where it sits, what state it is in, where it works, what it produced, and its controls. */
export function NodeHeader(props: { head: CellTimelineDTO; onSelect(cellId: string): void; onNode(node: TopologyNodeDTO): void; onChanged(): void }) {
  const { head } = props;
  const n = head.node;
  const navigate = useNavigate();
  const openReport = useOpenReport();
  const { status, setStatus } = useStatus();
  const toast = useToast();
  const [boardOpen, setBoardOpen] = useState(false);
  const engine = engineText(n);
  const board = isCoordinator(n) || head.notes !== null || head.unpulled.length > 0;
  const unpulledTotal = head.unpulled.reduce((s, u) => s + u.count, 0);
  // No limit applies (none set, or the owner switched limits off): usage alone, without a bar.
  const limit = budgetState(status).enforced ? n.tokensLimit : null;

  const runControl = async (b: ButtonDTO) => {
    try {
      // The server describes the endpoint; a bare pause/resume/cancel button still knows where to go.
      const r = b.endpoint
        ? await callButton<CellControlResponse>(b)
        : CONTROL_ACTIONS.has(b.id as CellControlRequest["action"])
          ? await request<CellControlResponse>("POST", `/api/cells/${encodeURIComponent(n.cellId)}/control`, { action: b.id as CellControlRequest["action"] } satisfies CellControlRequest)
          : null;
      if (!r) return;
      setStatus(r.status);
      toast({ tone: r.ok ? "success" : "warn", text: r.message });
      if (r.node) props.onNode(r.node);
    } catch (err) {
      toast({ tone: "error", text: toFailure(err).message });
    }
    props.onChanged();
  };

  return (
    <header className="ag-head">
      <div className="ag-head-top">
        <nav className="ag-crumbs" aria-label="所在层级">
          {head.breadcrumb.map((b, i) => {
            const last = i === head.breadcrumb.length - 1;
            return (
              <Fragment key={b.cellId}>
                {i > 0 && (
                  <span className="crumb-sep" aria-hidden="true">
                    ›
                  </span>
                )}
                {last ? (
                  <span className="crumb on" aria-current="page">
                    {b.label}
                  </span>
                ) : (
                  <button type="button" className="crumb" onClick={() => props.onSelect(b.cellId)}>
                    {b.label}
                  </button>
                )}
              </Fragment>
            );
          })}
          {head.breadcrumb.length === 0 && <span className="crumb on">{n.title}</span>}
        </nav>
        {head.controls.length > 0 && <ButtonRow size="sm" buttons={head.controls} onRun={runControl} className="ag-controls" />}
      </div>

      <div className="ag-facts">
        <span className={`status-pill st-${n.state}`}>
          <span className={`agent-dot ${n.state}`} aria-hidden="true" />
          {n.stateLabel}
        </span>
        {n.cwd && (
          <code className="ag-cwd" title={head.branch ? `${n.cwd}（分支 ${head.branch}）` : n.cwd}>
            {n.cwd}
            {head.branch && <span className="ag-branch"> ({head.branch})</span>}
          </code>
        )}
        {engine && <span className="ag-fact">{engine}</span>}
        {limit !== null ? (
          <span className="ag-fact ag-tokens" title="它和它派出的分身一共用掉的额度 / 上限">
            用量 {tokensText(n.tokensUsed, limit)}
            <ProgressBar done={Math.min(n.tokensUsed, limit)} total={limit} label={`额度用了 ${tokensText(n.tokensUsed, limit)}`} />
          </span>
        ) : (
          <span className="ag-fact" title="它和它派出的分身一共用掉的额度（没有上限）">
            已用 {compactCount(n.tokensUsed)}
          </span>
        )}
      </div>
      {(n.stateDetail || n.statusLine) && (
        <p className="ag-detail">
          {n.stateDetail}
          {n.statusLine && n.statusLine !== n.stateDetail && <span className="muted">{n.stateDetail ? " · " : ""}{n.statusLine}</span>}
        </p>
      )}

      {(head.artifacts.length > 0 || n.pendingCardId || n.engageItem) && (
        <div className="ag-assets">
          {head.artifacts.map((a) => (
            <button key={a.artifactId} type="button" className="btn sm report-btn" onClick={() => openReport(a)}>
              查看报告：{a.title} (v{a.version})
            </button>
          ))}
          {n.pendingCardId && (
            <button type="button" className="link-btn" onClick={() => navigate({ view: "clarify", cardId: n.pendingCardId! })}>
              去拍板 →
            </button>
          )}
          {n.engageItem && (
            <button type="button" className="link-btn" onClick={() => navigate({ view: "engage", item: n.engageItem! })}>
              去处理 →
            </button>
          )}
        </div>
      )}

      {board && (
        <div className="ag-board">
          <button type="button" className="disclosure small" aria-expanded={boardOpen} onClick={() => setBoardOpen((o) => !o)}>
            <Chevron dir="right" open={boardOpen} />
            项目常驻白板
            {unpulledTotal > 0 && <span className="badge warn-soft">未汇总 +{unpulledTotal}</span>}
          </button>
          {boardOpen && (
            <div className="ag-board-body">
              {head.notes ? <Markdown text={head.notes} className="ag-notes" /> : <p className="muted small">白板上还没有记东西。</p>}
              {head.unpulled.length > 0 && (
                <div className="ag-unpulled">
                  <h4>还没汇总的分身动态</h4>
                  <ul>
                    {head.unpulled.map((u) => (
                      <li key={u.cellId}>
                        <button type="button" className="link-btn" onClick={() => props.onSelect(u.cellId)}>
                          {u.title}
                        </button>
                        <span className="badge warn-soft">+{u.count}</span>
                        {u.hadDirectUserChat && <span className="topo-mark">直连对话</span>}
                        {u.preview && <p className="muted small">{u.preview}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
