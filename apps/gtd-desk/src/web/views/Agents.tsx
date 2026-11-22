import { useCallback, useEffect, useRef, useState } from "react";
import type { TopologyDTO } from "../../shared/api";
import { api } from "../api";
import { Composer } from "../components/agents/composer";
import { useCellTimeline } from "../components/agents/data";
import { NodeHeader } from "../components/agents/header";
import { DENSITIES, resolveSelection, type Density } from "../components/agents/model";
import { TopologyPane } from "../components/agents/topology";
import { LiveStrip, Timeline } from "../components/agents/timeline";
import { Empty, ErrorState, Loading } from "../components/states";
import { rememberDeskId, syncServerClock, useDebouncedRefresh, useNavigate, useNow, useResource } from "../state";

const DENSITY_KEY = "ng-desk-agents-density";

function savedDensity(): Density {
  try {
    const v = sessionStorage.getItem(DENSITY_KEY);
    if (DENSITIES.some((d) => d.key === v)) return v as Density;
  } catch {
    // per-tab convenience only
  }
  return "brief";
}

export function AgentsView({ cellId, projectId }: { cellId?: string | undefined; projectId?: string | undefined }) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const topo = useResource<TopologyDTO>(`agents:${includeArchived ? 1 : 0}:${projectId ?? ""}`, () => api.topology({ includeArchived, projectId }), []);
  const navigate = useNavigate();
  // Busy cells fire refreshes in bursts: one refetch when they settle.
  useDebouncedRefresh(["agents"], 300, topo.reload);

  useEffect(() => {
    if (!topo.data) return;
    syncServerClock(topo.data.generatedAt);
    rememberDeskId(topo.data.deskCellId);
  }, [topo.data]);

  let selected = resolveSelection(topo.data, cellId, projectId);
  // Without the topology an explicit node can still be opened (the desk by its alias, too).
  if (!selected && topo.error && !topo.loading && cellId) selected = cellId;

  const select = useCallback((id: string) => navigate({ view: "agents", cellId: id, ...(projectId ? { projectId } : {}) }), [navigate, projectId]);
  const project = projectId
    ? { id: projectId, title: topo.data?.nodes.find((n) => n.cellId === projectId)?.title ?? null }
    : null;

  return (
    <div className="agents">
      {topo.data ? (
        <TopologyPane
          topo={topo.data}
          selectedId={selected}
          onSelect={select}
          includeArchived={includeArchived}
          onIncludeArchived={setIncludeArchived}
          project={project}
          onClearProject={() => navigate({ view: "agents", ...(selected ? { cellId: selected } : {}) })}
        />
      ) : (
        <section className="ag-left" aria-label="分身关系图">
          {topo.error && !topo.loading ? <ErrorState error={topo.error} onRetry={topo.reload} title="分身关系图没能载入" /> : <Loading label="正在载入分身关系图…" />}
        </section>
      )}
      {selected ? (
        <NodePane key={selected} cellId={selected} onSelect={select} onChanged={topo.reload} />
      ) : (
        <section className="ag-right" aria-label="选中的分身">
          {topo.error && !topo.loading ? <Empty title="还没选中分身">分身列表载入后会默认打开总助理的对话。</Empty> : <Loading label="正在打开总助理…" />}
        </section>
      )}
      {topo.data && topo.error && <p className="stale-note ag-stale">分身列表刷新失败：{topo.error.message}（显示的是上次载入的内容）</p>}
    </div>
  );
}

// ==================== the right pane ====================

function NodePane({ cellId, onSelect, onChanged }: { cellId: string; onSelect(id: string): void; onChanged(): void }) {
  const tl = useCellTimeline(cellId);
  const now = useNow();
  const [density, setDensity] = useState<Density>(savedDensity);
  const [paused, setPaused] = useState(false);
  const [reply, setReply] = useState<{ id: string; text: string } | null>(null);
  const dismissed = useRef<string | null>(null);
  const question = tl.head?.pendingQuestion ?? null;

  useEffect(() => {
    try {
      sessionStorage.setItem(DENSITY_KEY, density);
    } catch {
      // per-tab convenience only
    }
  }, [density]);

  const autoReplyId = useRef<string | null>(null);
  // The node's open question becomes the reply target, unless the owner set it aside; once it is answered it goes.
  useEffect(() => {
    const previous = autoReplyId.current;
    autoReplyId.current = question?.id ?? null;
    if (question && question.id !== dismissed.current) setReply(question);
    else if (previous) setReply(r => r?.id === previous ? null : r);
  }, [question?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismissReply = () => {
    dismissed.current = reply?.id ?? null;
    setReply(null);
  };

  if (!tl.head) {
    return (
      <section className="ag-right" aria-label="选中的分身">
        {tl.error && !tl.loading ? (
          <ErrorState error={tl.error} onRetry={tl.reload} title={tl.error.status === 404 ? "找不到这个分身" : "工作实况没能载入"} />
        ) : (
          <Loading label="正在载入工作实况…" />
        )}
      </section>
    );
  }

  const head = tl.head;
  const node = head.node;
  return (
    <section className="ag-right" aria-label={`选中的分身：${node.title}`}>
      <NodeHeader
        head={head}
        onSelect={onSelect}
        onNode={tl.setNode}
        onChanged={() => {
          tl.refresh();
          onChanged();
        }}
      />
      <div className="ag-density">
        <div className="segmented sm" role="radiogroup" aria-label="阅读密度">
          {DENSITIES.map((d) => (
            <button key={d.key} type="button" role="radio" aria-checked={density === d.key} className={density === d.key ? "on" : ""} onClick={() => setDensity(d.key)}>
              {d.label}
            </button>
          ))}
        </div>
        <button type="button" className={`btn sm ghost${paused ? " active" : ""}`} aria-pressed={paused} onClick={() => setPaused((p) => !p)} title="暂停后不再自动滚到最新的记录">
          {paused ? "继续跟随" : "暂停"}
        </button>
      </div>
      <Timeline tl={tl} node={node} density={density} paused={paused} now={now} onReply={setReply} />
      <LiveStrip node={node} jobs={tl.jobs} now={now} />
      <Composer key={cellId} cellId={cellId} title={node.title} composer={head.composer} tl={tl} reply={reply} onDismissReply={dismissReply} onChanged={onChanged} />
    </section>
  );
}
