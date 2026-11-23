import type { TimelineItemDTO, TopologyDTO, TopologyNodeDTO } from "../../../shared/api";

// Pure helpers of the Agents view (no React, no DOM): tree order, filtering, the three-column layout, edge geometry,
// timeline merging and the small display formats. Kept apart so they stay easy to reason about and to test.

// ==================== the tree ====================

export interface TreeEntry {
  node: TopologyNodeDTO;
  depth: number;
}

/**
 * Depth-first, roots and siblings in the order the server sent them (parents before children, siblings in creation
 * order). A node whose parent is not in the list is a root; a cycle cannot loop.
 */
export function treeOrder(nodes: readonly TopologyNodeDTO[]): TreeEntry[] {
  const ids = new Set(nodes.map((n) => n.cellId));
  const kids = new Map<string | null, TopologyNodeDTO[]>();
  for (const n of nodes) {
    const p = n.parentId && n.parentId !== n.cellId && ids.has(n.parentId) ? n.parentId : null;
    const list = kids.get(p);
    if (list) list.push(n);
    else kids.set(p, [n]);
  }
  const out: TreeEntry[] = [];
  const seen = new Set<string>();
  const walk = (n: TopologyNodeDTO, depth: number) => {
    if (seen.has(n.cellId)) return;
    seen.add(n.cellId);
    out.push({ node: n, depth });
    for (const c of kids.get(n.cellId) ?? []) walk(c, depth + 1);
  };
  for (const r of kids.get(null) ?? []) walk(r, 0);
  for (const n of nodes) walk(n, 0);
  return out;
}

export type NodeFilter = "all" | "running" | "attention" | "waiting";

export const NODE_FILTERS: ReadonlyArray<{ key: NodeFilter; label: string }> = [
  { key: "all", label: "活跃与待命" },
  { key: "running", label: "正在运行" },
  { key: "attention", label: "等你拍板" },
  { key: "waiting", label: "等待外部" },
];

const MATCH: Record<NodeFilter, (n: TopologyNodeDTO) => boolean> = {
  all: () => true,
  running: (n) => n.state === "running",
  attention: (n) => n.state === "blocked_human",
  waiting: (n) => n.state === "waiting",
};

/**
 * Keeps the matching nodes plus their ancestors (so the tree stays connected) and the desk. `context` = kept only to
 * connect the tree; the view shows those quieter.
 */
export function filterTree(entries: readonly TreeEntry[], filter: NodeFilter, deskId: string | null): { entries: TreeEntry[]; context: Set<string> } {
  if (filter === "all") return { entries: [...entries], context: new Set() };
  const byId = new Map(entries.map((e) => [e.node.cellId, e.node]));
  const keep = new Set<string>();
  const matched = new Set<string>();
  for (const e of entries) {
    if (!MATCH[filter](e.node)) continue;
    matched.add(e.node.cellId);
    let cur: TopologyNodeDTO | undefined = e.node;
    while (cur && !keep.has(cur.cellId)) {
      keep.add(cur.cellId);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  if (deskId && byId.has(deskId)) keep.add(deskId);
  const context = new Set([...keep].filter((id) => !matched.has(id)));
  return { entries: entries.filter((e) => keep.has(e.node.cellId)), context };
}

/** Where the arrow keys go in tree order: ↑/↓ previous/next, ← parent, → first child, Home/End. */
export function navTarget(entries: readonly TreeEntry[], current: string | null, key: string): string | null {
  if (entries.length === 0) return null;
  const i = entries.findIndex((e) => e.node.cellId === current);
  const at = (k: number) => entries[Math.max(0, Math.min(entries.length - 1, k))]!.node.cellId;
  switch (key) {
    case "ArrowDown":
      return i < 0 ? at(0) : at(i + 1);
    case "ArrowUp":
      return i < 0 ? at(0) : at(i - 1);
    case "Home":
      return at(0);
    case "End":
      return at(entries.length - 1);
    case "ArrowLeft": {
      const parent = i >= 0 ? entries[i]!.node.parentId : null;
      return parent && entries.some((e) => e.node.cellId === parent) ? parent : null;
    }
    case "ArrowRight": {
      const next = i >= 0 ? entries[i + 1] : undefined;
      return next && next.node.parentId === current ? next.node.cellId : null;
    }
    default:
      return null;
  }
}

// ==================== the three columns ====================

export interface ColumnGroup {
  key: string;
  parentId: string | null;
  entries: TreeEntry[];
}

/**
 * Column per `node.layer` (0 sources + desk, 1 projects + hubs, 2 workers + checkers), in tree order, with
 * consecutive siblings grouped so each project's workers sit together.
 */
export function columnGroups(entries: readonly TreeEntry[]): [ColumnGroup[], ColumnGroup[], ColumnGroup[]] {
  const cols: [ColumnGroup[], ColumnGroup[], ColumnGroup[]] = [[], [], []];
  for (const e of entries) {
    const layer = e.node.layer === 1 || e.node.layer === 2 ? e.node.layer : 0;
    const col = cols[layer];
    const last = col.at(-1);
    if (last && last.parentId === e.node.parentId) last.entries.push(e);
    else col.push({ key: `${layer}:${e.node.cellId}`, parentId: e.node.parentId, entries: [e] });
  }
  return cols;
}

// ==================== edge geometry ====================

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

export interface EdgeGeometry {
  /** SVG path data of one cubic Bézier. */
  d: string;
  /** The curve's midpoint (t = 0.5). */
  mid: Pt;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A cubic Bézier from box `a` to box `b`, in the coordinates the boxes were measured in. Across columns it leaves the
 * side facing `b` and enters the side facing `a`, with horizontal tangents. Within one column, tree edges loop out on
 * the left and waits on the right, so the two never sit on top of each other and neither runs behind a card.
 */
export function edgePath(a: Box, b: Box, kind: "tree" | "wait" = "tree"): EdgeGeometry {
  const aR = a.x + a.w;
  const bR = b.x + b.w;
  const ay = a.y + a.h / 2;
  const by = b.y + b.h / 2;
  let p0: Pt, p1: Pt, p2: Pt, p3: Pt;
  if (b.x >= aR - 1) {
    p0 = { x: aR, y: ay };
    p3 = { x: b.x, y: by };
    const dx = Math.max(16, (p3.x - p0.x) / 2);
    p1 = { x: p0.x + dx, y: p0.y };
    p2 = { x: p3.x - dx, y: p3.y };
  } else if (bR <= a.x + 1) {
    p0 = { x: a.x, y: ay };
    p3 = { x: bR, y: by };
    const dx = Math.max(16, (p0.x - p3.x) / 2);
    p1 = { x: p0.x - dx, y: p0.y };
    p2 = { x: p3.x + dx, y: p3.y };
  } else if (kind === "wait") {
    p0 = { x: aR, y: ay };
    p3 = { x: bR, y: by };
    const out = Math.max(aR, bR) + 22;
    p1 = { x: out, y: p0.y };
    p2 = { x: out, y: p3.y };
  } else {
    p0 = { x: a.x, y: ay };
    p3 = { x: b.x, y: by };
    const out = Math.min(a.x, b.x) - 14;
    p1 = { x: out, y: p0.y };
    p2 = { x: out, y: p3.y };
  }
  const mid = { x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8, y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8 };
  return {
    d: `M${r1(p0.x)} ${r1(p0.y)} C${r1(p1.x)} ${r1(p1.y)} ${r1(p2.x)} ${r1(p2.y)} ${r1(p3.x)} ${r1(p3.y)}`,
    mid: { x: r1(mid.x), y: r1(mid.y) },
  };
}

// ==================== same work tree ====================

export interface SharedTree {
  gitRoot: string;
  label: string;
  count: number;
}

/** Work trees where more than one active node works right now (the "标出同目录协作" highlight). */
export function sharedTrees(topo: TopologyDTO): SharedTree[] {
  return topo.workspaces.filter((w) => w.activeCellIds.length > 1).map((w) => ({ gitRoot: w.gitRoot, label: w.label, count: w.activeCellIds.length }));
}

/** The line for one work tree (hovering a node): the server's count when it has one, else the nodes listed with it. */
export function treeOf(topo: TopologyDTO, gitRoot: string): SharedTree {
  const w = topo.workspaces.find((x) => x.gitRoot === gitRoot);
  if (w) return { gitRoot, label: w.label, count: w.activeCellIds.length };
  return { gitRoot, label: dirBase(gitRoot), count: topo.nodes.filter((n) => n.gitRoot === gitRoot && n.state !== "archived").length };
}

// ==================== selection ====================

/**
 * What the right pane shows: the route's node ("desk" = the desk), else the project's first running node (tree
 * order) or the project itself, else the desk. Null while that cannot be known yet.
 */
export function resolveSelection(topo: TopologyDTO | null, cellId: string | undefined, projectId: string | undefined): string | null {
  if (cellId) {
    if (cellId !== "desk") return cellId;
    if (!topo) return null;
    return topo.nodes.some((n) => n.cellId === "desk") ? "desk" : topo.deskCellId;
  }
  if (!topo) return null;
  if (projectId) {
    const order = treeOrder(topo.nodes);
    const running = order.find((e) => e.node.projectId === projectId && e.node.state === "running");
    if (running) return running.node.cellId;
    const project = topo.nodes.find((n) => n.cellId === projectId);
    if (project) return project.cellId;
  }
  return topo.deskCellId;
}

// ==================== the timeline ====================

export type Density = "brief" | "steps" | "chat";

export const DENSITIES: ReadonlyArray<{ key: Density; label: string }> = [
  { key: "brief", label: "精简实况" },
  { key: "steps", label: "全量步骤" },
  { key: "chat", label: "纯对话" },
];

/** 纯对话 keeps the conversation and the deliveries; tool steps, other cells' messages and grey system lines go. */
export function visibleItems(items: readonly TimelineItemDTO[], density: Density): TimelineItemDTO[] {
  if (density !== "chat") return [...items];
  return items.filter((it) => it.kind !== "tool_group" && it.kind !== "system_event" && it.kind !== "peer_message");
}

/** The last evidence position an item covers (a tool group spans several). */
export function itemEnd(it: TimelineItemDTO): number {
  return it.kind === "tool_group" ? Math.max(it.seq, it.toSeq) : it.seq;
}

/**
 * Adds a page to what is shown: an item already there (same id — e.g. a tool group that grew, a step whose result
 * came in) is replaced in place, new ones are added, and the whole stays in evidence order.
 */
export function mergeItems(existing: readonly TimelineItemDTO[], incoming: readonly TimelineItemDTO[]): TimelineItemDTO[] {
  if (incoming.length === 0) return existing as TimelineItemDTO[];
  const at = new Map(existing.map((it, i) => [it.id, i]));
  const out = existing.slice();
  for (const it of incoming) {
    const i = at.get(it.id);
    if (i !== undefined) out[i] = it;
    else {
      at.set(it.id, out.length);
      out.push(it);
    }
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i - 1]!.seq > out[i]!.seq) return out.sort((a, b) => a.seq - b.seq);
  }
  return out;
}

// ==================== display formats ====================

/** "~/dev/pay-core" → "pay-core" (the full path goes in the title attribute). */
export function dirBase(path: string): string {
  const t = path.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i >= 0 ? t.slice(i + 1) || t : t;
}

/** "codex · GPT-6 Codex · high", "零算力脚本"; null when nothing is known. */
export function engineText(node: Pick<TopologyNodeDTO, "processorType" | "engine" | "modelTier" | "modelOverride" | "effectiveModel">): string | null {
  if (node.processorType === "code") return "零算力脚本";
  const tier = node.modelTier === "strong" ? "高能力" : node.modelTier === "fast" ? "快速" : null;
  if (node.modelOverride) {
    const parts = [node.engine, node.modelOverride.model, node.modelOverride.effort].filter((x): x is string => Boolean(x));
    return parts.length ? parts.join(" · ") : null;
  }
  if (node.effectiveModel) {
    const parts = [node.engine, node.effectiveModel.label, node.effectiveModel.effort].filter((x): x is string => Boolean(x));
    return parts.length ? parts.join(" · ") : null;
  }
  const parts = [node.engine, tier].filter((x): x is string => Boolean(x));
  return parts.length ? parts.join(" · ") : null;
}

/** Compact badge for topology cards ("codex · GPT-6 Codex" or "claude"). */
export function engineBadgeText(node: Pick<TopologyNodeDTO, "processorType" | "engine" | "modelOverride" | "effectiveModel">): string | null {
  if (node.processorType === "code" || !node.engine) return null;
  const model = node.modelOverride?.model ?? node.effectiveModel?.label ?? null;
  return model ? `${node.engine} · ${model}` : node.engine;
}

/** "0.4 秒" · "12 秒" · "3 分 5 秒" */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.max(0.1, Math.round(ms / 100) / 10)} 秒`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}



/** Ids the send box generates must match /^[\w.:-]{1,80}$/ (the server's idempotency key). */
export function isValidClientId(id: string): boolean {
  return /^[\w.:-]{1,80}$/.test(id);
}
