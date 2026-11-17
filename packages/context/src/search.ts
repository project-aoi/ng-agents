import { all, type EvidenceKind, type KnowledgeKind, type Snippet } from "@ng/protocol";
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

const LIKE = "LIKE ? ESCAPE '\\'";

export function searchHistory(deps: Deps, chain: readonly string[], cellId: string, query: string, limit: number): Snippet[] {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0 || limit <= 0) return [];
  // The trigram tokenizer needs >= 3 characters per term; shorter terms fall back to a substring LIKE.
  const long = terms.filter((t) => charCount(t) >= 3);
  const short = terms.filter((t) => charCount(t) < 3);
  const match = long.map(ftsPhrase).join(" ");
  const sources = historySources(deps, cellId);
  const scope = sources.map(() => "(e.cell_id = ? AND e.seq <= ?)").join(" OR ");
  const scopeParams = sources.flatMap((s) => [s.cellId, s.uptoSeq]);

  const evidenceRows = long.length
    ? all<EvidenceHit>(
        deps.db,
        `SELECT e.seq, e.cell_id, e.run_id, e.kind, e.text, e.at, e.spill_uri, e.content, evidence_fts.rank AS rank
         FROM evidence_fts JOIN evidence e ON e.seq = evidence_fts.rowid
         WHERE evidence_fts MATCH ? AND (${scope})${short.map(() => ` AND e.text ${LIKE}`).join("")}
         ORDER BY evidence_fts.rank LIMIT ?`,
        [match, ...scopeParams, ...short.map(likePattern), limit],
      )
    : all<EvidenceHit>(
        deps.db,
        `SELECT e.seq, e.cell_id, e.run_id, e.kind, e.text, e.at, e.spill_uri, e.content, NULL AS rank
         FROM evidence e WHERE (${scope})${short.map(() => ` AND e.text ${LIKE}`).join("")}
         ORDER BY e.seq DESC LIMIT ?`,
        [...scopeParams, ...short.map(likePattern), limit],
      );

  const owners = `(k.scope = 'global' OR k.cell_id IN (${chain.map(() => "?").join(",")}))`;
  const knowledgeText = "(k.name || ' ' || k.description || ' ' || k.body)";
  const knowledgeRows = long.length
    ? all<KnowledgeHit>(
        deps.db,
        `SELECT k.seq, k.kind, k.cell_id, k.name, k.description, k.body, k.updated_at, knowledge_fts.rank AS rank
         FROM knowledge_fts JOIN knowledge k ON k.seq = knowledge_fts.rowid
         WHERE knowledge_fts MATCH ? AND ${owners}${short.map(() => ` AND ${knowledgeText} ${LIKE}`).join("")}
         ORDER BY knowledge_fts.rank LIMIT ?`,
        [match, ...chain, ...short.map(likePattern), limit],
      )
    : all<KnowledgeHit>(
        deps.db,
        `SELECT k.seq, k.kind, k.cell_id, k.name, k.description, k.body, k.updated_at, NULL AS rank
         FROM knowledge k WHERE ${owners}${short.map(() => ` AND ${knowledgeText} ${LIKE}`).join("")}
         ORDER BY k.updated_at DESC LIMIT ?`,
        [...chain, ...short.map(likePattern), limit],
      );

  const hits: Snippet[] = [];
  for (const r of evidenceRows) {
    const s: Snippet = {
      seq: r.seq,
      cellId: r.cell_id,
      runId: r.run_id,
      kind: r.kind,
      text: excerpt(r.text, terms),
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
    hits.push(s);
  }
  for (const r of knowledgeRows) {
    const s: Snippet = {
      seq: r.seq,
      cellId: r.cell_id,
      runId: null,
      kind: r.kind,
      text: excerpt(`${r.description}\n${r.body}`, terms),
      at: r.updated_at,
      source: "knowledge",
      uri: `${r.kind}://${r.name}`,
      title: r.name,
    };
    if (r.rank !== null) s.rank = r.rank;
    hits.push(s);
  }
  // bm25 ranks from the two indexes are on comparable scales; LIKE-only hits are ordered newest first.
  hits.sort((a, b) => (long.length ? (a.rank ?? 0) - (b.rank ?? 0) : b.at - a.at) || b.seq - a.seq);
  return hits.slice(0, limit);
}
