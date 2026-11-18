import { all, type EvidenceKind, type KnowledgeKind, type SearchScope, type Snippet, type SqlParam } from "@ng/protocol";
import type { Deps } from "./deps";
import { charCount, excerpt, ftsPhrase, likePattern } from "./text";

/** Evidence a cell's history draws on: its own log, plus (fork_prefix) each fork source's log up to the fork point. */
export function historySources(deps: Deps, cellId: string): Array<{ cellId: string; uptoSeq: number }> {
  const out: Array<{ cellId: string; uptoSeq: number }> = [{ cellId, uptoSeq: Number.MAX_SAFE_INTEGER }];
  const seen = new Set([cellId]);
  let cell = deps.cells.get(cellId);
  let cap = Number.MAX_SAFE_INTEGER;
  while (cell?.spec.fork && !seen.has(cell.spec.fork.fromCellId)) {
    const { fromCellId, uptoSeq } = cell.spec.fork;
    cap = Math.min(cap, uptoSeq);
    out.push({ cellId: fromCellId, uptoSeq: cap });
    seen.add(fromCellId);
    cell = deps.cells.get(fromCellId);
  }
  return out;
}

interface EvidenceHit {
  seq: number;
  cell_id: string;
  run_id: string | null;
  kind: EvidenceKind;
  text: string;
  at: number;
  spill_uri: string | null;
  content: string;
  rank: number | null;
}

interface KnowledgeHit {
  seq: number;
  kind: KnowledgeKind;
  cell_id: string | null;
  name: string;
  description: string;
  body: string;
  updated_at: number;
  rank: number | null;
}

interface ArtifactHit {
  artifact_id: string;
  cell_id: string;
  version: number;
  title: string | null;
  body: string | null;
  updated_at: number;
  rank: number | null;
}

interface StateHit {
  cell_id: string;
  key: string;
  value: string;
  text: string | null;
  updated_at: number;
  rank: number | null;
}

interface ResourceHit {
  uri: string;
  cell_id: string;
  run_id: string | null;
  source: string | null;
  content: string;
  created_at: number;
  rank: number | null;
}

const LIKE = "LIKE ? ESCAPE '\\'";
const IN_JSON = "IN (SELECT value FROM json_each(?))";

/** Bookkeeping keys, not content: CLI session records and the cell's final result. */
const SEARCHABLE_STATE = "s.key NOT GLOB 'cli:*' AND s.key NOT GLOB 'cell:result*'";

/** A WHERE fragment and its parameters. */
interface Clause {
  where: string;
  params: SqlParam[];
}

interface Terms {
  words: string[];
  long: string[];
  short: string[];
  /** FTS5 expression over the long terms. */
  match: string;
}

/** One searchable source: the same rows through its FTS index (long terms) or by recency (short terms only). */
interface SourceQuery extends Clause {
  select: string;
  fts: string;
  ftsFrom: string;
  likeFrom: string;
  /** SQL text the short terms must occur in. */
  text: string;
  recency: string;
}

function runSource<T>(deps: Deps, t: Terms, limit: number, q: SourceQuery): T[] {
  const likes = t.short.map(() => ` AND ${q.text} ${LIKE}`).join("");
  const likeParams = t.short.map(likePattern);
  if (t.long.length) {
    return all<T>(
      deps.db,
      `SELECT ${q.select}, ${q.fts}.rank AS rank
       FROM ${q.ftsFrom}
       WHERE ${q.fts} MATCH ? AND ${q.where}${likes}
       ORDER BY ${q.fts}.rank LIMIT ?`,
      [t.match, ...q.params, ...likeParams, limit],
    );
  }
  return all<T>(
    deps.db,
    `SELECT ${q.select}, NULL AS rank
     FROM ${q.likeFrom} WHERE ${q.where}${likes}
     ORDER BY ${q.recency} LIMIT ?`,
    [...q.params, ...likeParams, limit],
  );
}

/** Which rows a scope covers. `owned` filters artifacts/state/resources by their cell; null (lineage) skips them. */
interface ScopeFilter {
  evidence: Clause;
  knowledge: Clause;
  owned: ((alias: string) => Clause) | null;
}

const EVERYTHING: Clause = { where: "1 = 1", params: [] };

function scopeFilter(deps: Deps, chain: readonly string[], cellId: string, scope: SearchScope): ScopeFilter {
  if (scope === "global") return { evidence: EVERYTHING, knowledge: EVERYTHING, owned: () => EVERYTHING };
  const sources = historySources(deps, cellId);
  const lineage = sources.map(() => "(e.cell_id = ? AND e.seq <= ?)").join(" OR ");
  const lineageParams = sources.flatMap((s) => [s.cellId, s.uptoSeq]);
  const knowledge = { where: `(k.scope = 'global' OR k.cell_id IN (${chain.map(() => "?").join(",")}))`, params: [...chain] };
  if (scope === "lineage") return { evidence: { where: `(${lineage})`, params: lineageParams }, knowledge, owned: null };
  // Closed descendants included: a finished worker's trace stays searchable from its project.
  const descendants = deps.cells.descendants(cellId).map((c) => c.id);
  const subtree = JSON.stringify([cellId, ...descendants]);
  return {
    evidence: { where: `(${lineage} OR e.cell_id ${IN_JSON})`, params: [...lineageParams, JSON.stringify(descendants)] },
    knowledge,
    owned: (alias) => ({ where: `${alias}.cell_id ${IN_JSON}`, params: [subtree] }),
  };
}

export function searchHistory(
  deps: Deps,
  chain: readonly string[],
  cellId: string,
  query: string,
  opts: { limit: number; scope: SearchScope },
): Snippet[] {
  const { limit } = opts;
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || limit <= 0) return [];
  // The trigram tokenizer needs >= 3 characters per term; shorter terms fall back to a substring LIKE.
  const long = words.filter((w) => charCount(w) >= 3);
  const t: Terms = { words, long, short: words.filter((w) => charCount(w) < 3), match: long.map(ftsPhrase).join(" ") };
  const filter = scopeFilter(deps, chain, cellId, opts.scope);

  const hits: Snippet[] = [
    ...searchEvidence(deps, t, limit, filter.evidence),
    ...searchKnowledge(deps, t, limit, filter.knowledge),
  ];
  if (filter.owned) {
    hits.push(
      ...searchArtifacts(deps, t, limit, filter.owned("a")),
      ...searchState(deps, t, limit, filter.owned("s")),
      ...searchResources(deps, t, limit, filter.owned("r")),
    );
  }
  // A resource that is the spill of an evidence hit adds nothing: that hit already points at it (spillUri).
  const spilled = new Set(hits.flatMap((s) => (s.source === "evidence" && s.spillUri ? [s.spillUri] : [])));
  const merged = hits.filter((s) => s.source !== "resource" || !spilled.has(s.uri!));
  // bm25 ranks are treated as comparable across indexes; LIKE-only hits are ordered newest first.
  merged.sort((a, b) => (long.length ? (a.rank ?? 0) - (b.rank ?? 0) : b.at - a.at) || b.seq - a.seq || b.at - a.at);
  return merged.slice(0, limit);
}

function searchEvidence(deps: Deps, t: Terms, limit: number, scope: Clause): Snippet[] {
  const rows = runSource<EvidenceHit>(deps, t, limit, {
    select: "e.seq, e.cell_id, e.run_id, e.kind, e.text, e.at, e.spill_uri, e.content",
    fts: "evidence_fts",
    ftsFrom: "evidence_fts JOIN evidence e ON e.seq = evidence_fts.rowid",
    likeFrom: "evidence e",
    text: "e.text",
    ...scope,
    recency: "e.seq DESC",
  });
  return rows.map((r) => {
    const s: Snippet = {
      seq: r.seq,
      cellId: r.cell_id,
      runId: r.run_id,
      kind: r.kind,
      text: excerpt(r.text, t.words),
      at: r.at,
      source: "evidence",
    };
    if (r.rank !== null) s.rank = r.rank;
    if (r.spill_uri) {
      s.spillUri = r.spill_uri;
      s.uri = r.spill_uri;
    }
    if (r.kind === "external") {
      const title = (JSON.parse(r.content) as { title?: unknown }).title;
      if (typeof title === "string" && title) s.title = title;
    }
    return s;
  });
}

function searchKnowledge(deps: Deps, t: Terms, limit: number, scope: Clause): Snippet[] {
  const rows = runSource<KnowledgeHit>(deps, t, limit, {
    select: "k.seq, k.kind, k.cell_id, k.name, k.description, k.body, k.updated_at",
    fts: "knowledge_fts",
    ftsFrom: "knowledge_fts JOIN knowledge k ON k.seq = knowledge_fts.rowid",
    likeFrom: "knowledge k",
    text: "(k.name || ' ' || k.description || ' ' || k.body)",
    ...scope,
    recency: "k.updated_at DESC",
  });
  return rows.map((r) => {
    const s: Snippet = {
      seq: r.seq,
      cellId: r.cell_id,
      runId: null,
      kind: r.kind,
      text: excerpt(`${r.description}\n${r.body}`, t.words),
      at: r.updated_at,
      source: "knowledge",
      uri: `${r.kind}://${r.name}`,
      title: r.name,
    };
    if (r.rank !== null) s.rank = r.rank;
    return s;
  });
}

// artifact_fts/state_fts keep their own copy of the indexed text, so the short-term LIKE runs on those columns.

function searchArtifacts(deps: Deps, t: Terms, limit: number, scope: Clause): Snippet[] {
  const from = "artifact_fts JOIN artifacts a ON a.rowid = artifact_fts.rowid";
  const rows = runSource<ArtifactHit>(deps, t, limit, {
    select: "a.artifact_id, a.cell_id, a.version, a.title, artifact_fts.body, a.updated_at",
    fts: "artifact_fts",
    ftsFrom: from,
    likeFrom: from,
    text: "(COALESCE(artifact_fts.title, '') || ' ' || COALESCE(artifact_fts.body, ''))",
    ...scope,
    recency: "a.updated_at DESC, a.artifact_id",
  });
  return rows.map((r) => {
    const s: Snippet = {
      seq: r.version,
      cellId: r.cell_id,
      runId: null,
      kind: "artifact",
      text: excerpt(r.body ?? "", t.words),
      at: r.updated_at,
      source: "artifact",
      uri: `artifact://${r.artifact_id}`,
    };
    if (r.title) s.title = r.title;
    if (r.rank !== null) s.rank = r.rank;
    return s;
  });
}

function searchState(deps: Deps, t: Terms, limit: number, scope: Clause): Snippet[] {
  const from = "state_fts JOIN cell_state s ON s.seq = state_fts.rowid";
  const rows = runSource<StateHit>(deps, t, limit, {
    select: "s.cell_id, s.key, s.value, state_fts.text, s.updated_at",
    fts: "state_fts",
    ftsFrom: from,
    likeFrom: from,
    text: "(state_fts.key || ' ' || COALESCE(state_fts.text, ''))",
    where: `${scope.where} AND ${SEARCHABLE_STATE}`,
    params: scope.params,
    recency: "s.updated_at DESC, s.seq DESC",
  });
  return rows.map((r) => {
    const s: Snippet = {
      seq: 0,
      cellId: r.cell_id,
      runId: null,
      kind: "state",
      // A value without string leaves (numbers, booleans) is shown as its JSON.
      text: excerpt(r.text || r.value, t.words),
      at: r.updated_at,
      source: "state",
      title: r.key,
    };
    if (r.rank !== null) s.rank = r.rank;
    return s;
  });
}

function searchResources(deps: Deps, t: Terms, limit: number, scope: Clause): Snippet[] {
  const rows = runSource<ResourceHit>(deps, t, limit, {
    select: "r.uri, r.cell_id, r.run_id, r.source, r.content, r.created_at",
    fts: "resource_fts",
    ftsFrom: "resource_fts JOIN resources r ON r.rowid = resource_fts.rowid",
    likeFrom: "resources r",
    text: "r.content",
    ...scope,
    recency: "r.created_at DESC, r.uri",
  });
  return rows.map((r) => {
    const s: Snippet = {
      seq: 0,
      cellId: r.cell_id,
      runId: r.run_id,
      kind: "resource",
      text: excerpt(r.content, t.words),
      at: r.created_at,
      source: "resource",
      uri: r.uri,
    };
    if (r.source) s.title = r.source;
    if (r.rank !== null) s.rank = r.rank;
    return s;
  });
}
