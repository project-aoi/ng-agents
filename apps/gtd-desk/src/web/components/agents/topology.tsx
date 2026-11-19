import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { TopologyDTO, TopologyNodeDTO } from "../../../shared/api";
import { useNavigate } from "../../state";
import { Empty } from "../states";
import { NODE_FILTERS, columnGroups, dirBase, edgePath, filterTree, navTarget, sharedTrees, treeOf, treeOrder, type NodeFilter, type TreeEntry } from "./model";

// The left pane: who is there. Three columns of plain buttons (focusable, arrow keys walk the tree) over one SVG layer
// that draws parent→child curves and dashed waits from the cards' measured boxes. No graph library: the tree is at
// most three levels deep, so columns by level are the whole layout.

export type TopoMode = "graph" | "list";

const MODE_KEY = "ng-desk-agents-mode";
const NARROW = "(max-width: 960px)";
const COLUMN_LABELS = ["信源与总助理", "项目与中枢", "执行与盯梢"] as const;
const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

function initialMode(): TopoMode {
  try {
    const v = sessionStorage.getItem(MODE_KEY);
    if (v === "graph" || v === "list") return v;
  } catch {
    // per-tab convenience only
  }
  return typeof window !== "undefined" && window.matchMedia(NARROW).matches ? "list" : "graph";
}

export function TopologyPane(props: {
  topo: TopologyDTO;
  selectedId: string | null;
  onSelect(cellId: string): void;
  includeArchived: boolean;
  onIncludeArchived(on: boolean): void;
  /** Arrived from a project's "分身" link: only its part of the tree is shown. */
  project: { id: string; title: string | null } | null;
  onClearProject(): void;
}) {
  const { topo } = props;
  const [mode, setMode] = useState<TopoMode>(initialMode);
  const [filter, setFilter] = useState<NodeFilter>("all");
  const [showShared, setShowShared] = useState(false);
  const [hoverRoot, setHoverRoot] = useState<string | null>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(MODE_KEY, mode);
    } catch {
      // per-tab convenience only
    }
  }, [mode]);

  const all = useMemo(() => treeOrder(topo.nodes), [topo.nodes]);
  const { entries, context } = useMemo(() => filterTree(all, filter, topo.deskCellId), [all, filter, topo.deskCellId]);
  const shared = useMemo(() => sharedTrees(topo), [topo]);
  // Hovering (or focusing) a node that shares its work tree wins over the checkbox for as long as it lasts.
  const hoverTree = hoverRoot ? treeOf(topo, hoverRoot) : null;
  const footer = hoverTree && hoverTree.count > 1 ? [hoverTree] : showShared ? shared : [];
  const highlight = new Set(footer.map((t) => t.gitRoot));

  const c = topo.counts;
  return (
    <section className="ag-left" aria-label="分身拓扑">
      <div className="topo-toolbar">
        <div className="topo-tools">
          <span className="tool-label" id="topo-mode-label">
            展示
          </span>
          <div className="segmented sm" role="radiogroup" aria-labelledby="topo-mode-label">
            <button type="button" role="radio" aria-checked={mode === "graph"} className={mode === "graph" ? "on" : ""} onClick={() => setMode("graph")}>
              拓扑图
            </button>
            <button type="button" role="radio" aria-checked={mode === "list"} className={mode === "list" ? "on" : ""} onClick={() => setMode("list")}>
              树状列表
            </button>
          </div>
          <label className="tool-label">
            筛选
            <select value={filter} onChange={(e) => setFilter(e.target.value as NodeFilter)} className="tool-select">
              {NODE_FILTERS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="topo-tools">
          <label className="check-inline">
            <input type="checkbox" checked={props.includeArchived} onChange={(e) => props.onIncludeArchived(e.target.checked)} /> 含已归档
          </label>
          <label className="check-inline">
            <input type="checkbox" checked={showShared} onChange={(e) => setShowShared(e.target.checked)} /> 标出同目录协作
          </label>
          {props.project && (
            <span className="filter-chip">
              只看「{props.project.title ?? "这个项目"}」
              <button type="button" aria-label="显示全部" title="显示全部" onClick={props.onClearProject}>
                ×
              </button>
            </span>
          )}
        </div>
        <p className="topo-counts muted small">
          {c.running} 个在跑 · {c.waiting} 个等待外部 · {c.dormant} 个待命{c.archived > 0 ? ` · ${c.archived} 个已归档` : ""}
        </p>
      </div>

      <div className="topo-body">
        {entries.length === 0 ? (
          <Empty title={topo.nodes.length === 0 ? "还没有分身" : "没有符合筛选的分身"}>{topo.nodes.length === 0 ? "总助理接手事情后，派出的分身会出现在这里。" : "换个筛选条件看看。"}</Empty>
        ) : mode === "graph" ? (
          <Canvas {...props} entries={entries} context={context} highlight={highlight} onHover={setHoverRoot} />
        ) : (
          <TreeList {...props} entries={entries} context={context} highlight={highlight} onHover={setHoverRoot} />
        )}
      </div>

      {(showShared || footer.length > 0) && (
        <div className="topo-foot" aria-live="polite">
          {footer.length === 0 ? (
            <p className="muted small">目前没有多个分身在同一目录里工作。</p>
          ) : (
            footer.map((t) => (
              <p key={t.gitRoot} className="small" title={t.gitRoot}>
                <span className="dir-badge on">{t.label}</span> {t.count} 个活跃节点位于 {t.label}
              </p>
            ))
          )}
        </div>
      )}
    </section>
  );
}

interface ViewProps {
  topo: TopologyDTO;
  entries: TreeEntry[];
  context: Set<string>;
  highlight: Set<string>;
  selectedId: string | null;
  includeArchived: boolean;
  onSelect(cellId: string): void;
  onIncludeArchived(on: boolean): void;
  onHover(gitRoot: string | null): void;
}

/**
 * Roving focus over the node buttons: one tab stop, the arrow keys walk the tree. The selected node is scrolled into
 * view when it changes (arriving from a project link, or from the breadcrumb).
 */
function useTreeKeys(entries: TreeEntry[], selectedId: string | null) {
  const [focusId, setFocusId] = useState<string | null>(selectedId);
  useEffect(() => {
    setFocusId(selectedId);
    if (!selectedId) return;
    const el = document.querySelector<HTMLElement>(`.ag-left [data-nav="${CSS.escape(selectedId)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);
  const stop = entries.some((e) => e.node.cellId === focusId) ? focusId : (entries.find((e) => e.node.cellId === selectedId) ?? entries[0])?.node.cellId;
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (!NAV_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
      const here = e.target instanceof HTMLElement ? (e.target.dataset["nav"] ?? null) : null;
      if (!here) return;
      e.preventDefault();
      const next = navTarget(entries, here, e.key);
      if (!next) return;
      setFocusId(next);
      e.currentTarget.querySelector<HTMLElement>(`[data-nav="${CSS.escape(next)}"]`)?.focus();
    },
    [entries],
  );
  return { stop, onKeyDown, setFocusId };
}

// ==================== graph ====================

interface DrawnEdge {
  key: string;
  kind: "tree" | "wait";
  d: string;
  title: string | null;
  fresh: boolean;
}

function Canvas(props: ViewProps) {
  const { entries, topo } = props;
  const canvasRef = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [geo, setGeo] = useState<{ w: number; h: number; edges: DrawnEdge[] }>({ w: 0, h: 0, edges: [] });
  const keys = useTreeKeys(entries, props.selectedId);
  const uid = useId().replace(/:/g, "");
  const cols = useMemo(() => columnGroups(entries), [entries]);

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Boxes relative to the canvas itself, so scrolling the pane never changes them.
    const base = canvas.getBoundingClientRect();
    const box = (id: string) => {
      const el = cards.current.get(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
    };
    const edges: DrawnEdge[] = [];
    for (const e of entries) {
      const p = e.node.parentId;
      const a = p ? box(p) : null;
      const b = a ? box(e.node.cellId) : null;
      if (!a || !b) continue;
      edges.push({ key: `t:${p}>${e.node.cellId}`, kind: "tree", d: edgePath(a, b, "tree").d, title: null, fresh: e.node.unpulledCount > 0 });
    }
    for (const w of topo.waits) {
      const a = box(w.fromCellId);
      const b = w.targetCellId ? box(w.targetCellId) : null;
      if (!a || !b) continue;
      edges.push({ key: `w:${w.fromCellId}>${w.targetCellId}`, kind: "wait", d: edgePath(a, b, "wait").d, title: `${w.description}（等「${w.targetLabel}」）`, fresh: false });
    }
    const next = { w: canvas.scrollWidth, h: canvas.scrollHeight, edges };
    setGeo((prev) => (prev.w === next.w && prev.h === next.h && prev.edges.length === edges.length && prev.edges.every((x, i) => x.d === edges[i]!.d && x.key === edges[i]!.key && x.fresh === edges[i]!.fresh) ? prev : next));
  }, [entries, topo.waits]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // Any card growing (a longer state line, a wrapped title) moves the others: watch them all.
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    for (const el of cards.current.values()) ro.observe(el);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [measure]);

  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) cards.current.set(id, el);
    else cards.current.delete(id);
  };
  const drawnWaits = new Set(geo.edges.filter((e) => e.kind === "wait").map((e) => e.key.slice(2).split(">")[0]!));

  return (
    <div className="topo-scroll">
      <div className="topo-canvas" ref={canvasRef} onKeyDown={keys.onKeyDown}>
        <svg className="topo-edges" width={geo.w} height={geo.h} aria-hidden="true">
          <defs>
            <marker id={`${uid}-a`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0.5L7.5 4L0 7.5z" className="topo-arrow" />
            </marker>
            <marker id={`${uid}-w`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0.5L7.5 4L0 7.5z" className="topo-arrow wait" />
            </marker>
          </defs>
          {geo.edges.map((e) =>
            e.kind === "tree" ? (
              <path key={e.key} d={e.d} className={`topo-edge${e.fresh ? " fresh" : ""}`} markerEnd={`url(#${uid}-a)`} />
            ) : (
              <g key={e.key} className="topo-wait-edge">
                <path d={e.d} className="topo-edge wait" markerEnd={`url(#${uid}-w)`} />
                <path d={e.d} className="topo-edge-hit">
                  <title>{e.title}</title>
                </path>
              </g>
            ),
          )}
        </svg>
        <div className="topo-cols">
          {cols.map((groups, layer) => (
            <div key={layer} className="topo-col" role="group" aria-label={COLUMN_LABELS[layer]}>
              <p className="topo-col-head" aria-hidden="true">
                {COLUMN_LABELS[layer]}
              </p>
              {groups.map((g) => (
                <div key={g.key} className="topo-group">
                  {g.entries.map((e) => (
                    <NodeCard key={e.node.cellId} {...props} node={e.node} tabStop={keys.stop === e.node.cellId} onFocusNode={keys.setFocusId} cardRef={register(e.node.cellId)} waitDrawn={drawnWaits.has(e.node.cellId)} />
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ==================== list ====================

function TreeList(props: ViewProps) {
  const keys = useTreeKeys(props.entries, props.selectedId);
  return (
    <ul className="topo-list" onKeyDown={keys.onKeyDown}>
      {props.entries.map((e) => (
        <li key={e.node.cellId} style={{ paddingLeft: `${Math.min(e.depth, 6) * 18}px` }}>
          <NodeCard {...props} node={e.node} row tabStop={keys.stop === e.node.cellId} onFocusNode={keys.setFocusId} waitDrawn={false} />
        </li>
      ))}
    </ul>
  );
}

// ==================== one node ====================

function NodeCard(
  props: ViewProps & {
    node: TopologyNodeDTO;
    row?: boolean;
    tabStop: boolean;
    waitDrawn: boolean;
    onFocusNode(id: string): void;
    cardRef?: (el: HTMLElement | null) => void;
  },
) {
  const { node: n } = props;
  const navigate = useNavigate();
  const selected = props.selectedId === n.cellId;
  const dir = n.gitRoot ?? n.cwd;
  const lit = n.gitRoot !== null && props.highlight.has(n.gitRoot);
  const waits = props.waitDrawn ? [] : props.topo.waits.filter((w) => w.fromCellId === n.cellId);
  const dirTitle = n.cwd && n.gitRoot && n.cwd !== n.gitRoot ? `${n.cwd}\n（仓库 ${n.gitRoot}）` : (dir ?? undefined);
  const hasLinks = n.pendingCardId !== null || n.engageItem !== null || (n.archivedChildren > 0 && !props.includeArchived);

  return (
    <div
      ref={props.cardRef}
      className={`topo-node st-${n.state}${selected ? " selected" : ""}${props.context.has(n.cellId) ? " context" : ""}${props.row ? " row" : ""}`}
      onMouseEnter={() => props.onHover(n.gitRoot)}
      onMouseLeave={() => props.onHover(null)}
    >
      {n.unpulledCount > 0 && (
        <span className="topo-unpulled" title="所属项目还没看过的新动态">
          未汇总 +{n.unpulledCount}
        </span>
      )}
      <button
        type="button"
        className="topo-node-main"
        data-nav={n.cellId}
        tabIndex={props.tabStop ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={() => props.onSelect(n.cellId)}
        onFocus={() => {
          props.onFocusNode(n.cellId);
          props.onHover(n.gitRoot);
        }}
        onBlur={() => props.onHover(null)}
      >
        <span className="topo-node-top">
          <span className="topo-role">{n.roleLabel}</span>
          {n.hadDirectUserChat && <span className="topo-mark">直连对话</span>}
        </span>
        <span className="topo-title">{n.title}</span>
        <span className="topo-state">
          <span className={`agent-dot ${n.state}`} aria-hidden="true" />
          {n.stateLabel}
        </span>
        {n.stateDetail && (
          <span className="topo-detail" title={n.stateDetail}>
            {n.stateDetail}
          </span>
        )}
        {(dir || waits.length > 0) && (
          <span className="topo-meta">
            {dir && (
              <span className={`dir-badge${lit ? " on" : ""}`} title={dirTitle}>
                {dirBase(dir)}
              </span>
            )}
            {waits.map((w) => (
              <span key={`${w.targetCellId ?? w.targetLabel}`} className="topo-wait" title={w.description}>
                ⇢ {w.targetLabel}
              </span>
            ))}
          </span>
        )}
      </button>
      {hasLinks && (
        <div className="topo-links">
          {n.pendingCardId && (
            <button type="button" className="link-btn" tabIndex={props.tabStop ? 0 : -1} onClick={() => navigate({ view: "clarify", cardId: n.pendingCardId! })}>
              去拍板 →
            </button>
          )}
          {n.engageItem && (
            <button type="button" className="link-btn" tabIndex={props.tabStop ? 0 : -1} onClick={() => navigate({ view: "engage", item: n.engageItem! })}>
              去处理 →
            </button>
          )}
          {n.archivedChildren > 0 && !props.includeArchived && (
            <button type="button" className="topo-archived" tabIndex={props.tabStop ? 0 : -1} onClick={() => props.onIncludeArchived(true)} title="显示已归档的分身">
              已归档 ({n.archivedChildren})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
