import {
  afterCommit,
  all,
  DEFAULT_RESOURCE_PAGE_CHARS,
  get,
  MAX_RESOURCE_PAGE_CHARS,
  newId,
  NgError,
  RESOURCE_URI_PREFIX,
  run,
  spillNotice,
  EXPLICIT_READ_TOOLS,
  EXPLICIT_READ_INLINE_CHARS,
  withTx,
  type EvidenceAppendResult,
  type EvidenceEntry,
  type EvidenceKind,
  type ResourcePage,
  type StepOrExternalEvidence,
} from "@ng/protocol";
import type { Deps } from "./deps";
import { renderEnvelope, renderExternal } from "./render";
import { safeHead, safeTail } from "./text";

export interface StoredEvidence {
  seq: number;
  cellId: string;
  record: StepOrExternalEvidence;
}

interface EvidenceRow {
  seq: number;
  cell_id: string;
  content: string;
}

const KINDS: readonly EvidenceKind[] = ["inbound", "assistant_text", "tool_call", "tool_result", "external", "system_note", "run_boundary"];

function bad(msg: string): never {
  throw new NgError("invalid_argument", `evidence: ${msg}`);
}

function str(v: unknown, field: string): void {
  if (typeof v !== "string") bad(`${field} must be a string`);
}

function validate(r: StepOrExternalEvidence): void {
  if (!r || typeof r !== "object") bad("record must be an object");
  if (!KINDS.includes(r.kind)) bad(`unknown kind "${String((r as { kind?: unknown }).kind)}"`);
  if (r.runId !== null && r.runId !== undefined && typeof r.runId !== "string") bad("runId must be a string or null");
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) bad("at must be a finite number");
  switch (r.kind) {
    case "inbound":
      if (!r.envelope || typeof r.envelope !== "object") bad("inbound.envelope is required");
      str(r.envelope.id, "envelope.id");
      str(r.envelope.type, "envelope.type");
      break;
    case "assistant_text":
      str(r.text, "assistant_text.text");
      break;
    case "tool_call":
      str(r.toolUseId, "tool_call.toolUseId");
      str(r.name, "tool_call.name");
      break;
    case "tool_result":
      str(r.toolUseId, "tool_result.toolUseId");
      str(r.name, "tool_result.name");
      str(r.output, "tool_result.output");
      break;
    case "external":
      str(r.source, "external.source");
      str(r.text, "external.text");
      break;
    case "system_note":
      str(r.text, "system_note.text");
      break;
    case "run_boundary":
      if (r.phase !== "start" && r.phase !== "end") bad("run_boundary.phase must be start|end");
      if (typeof r.epoch !== "number") bad("run_boundary.epoch must be a number");
      break;
  }
}

/** Plain text indexed by FTS5 (inline form only: a spilled body's full text is indexed with its resource, resource_fts). */
function searchableText(r: StepOrExternalEvidence, spilledInline: string | null): string {
  switch (r.kind) {
    case "inbound":
      return renderEnvelope(r.envelope);
    case "assistant_text":
      return r.text;
    case "tool_call":
      return `${r.name} ${JSON.stringify(r.input ?? {})}`;
    case "tool_result":
      return `${r.name}\n${spilledInline ?? r.output}`;
    case "external":
      return [r.title ?? "", r.source, spilledInline ?? r.text].filter(Boolean).join("\n");
    case "system_note":
      return r.text;
    case "run_boundary":
      return r.error ?? "";
  }
}

export interface EvidenceModule {
  append(cellId: string, record: StepOrExternalEvidence): EvidenceAppendResult;
  list(cellId: string, opts?: { afterSeq?: number; uptoSeq?: number; limit?: number; runId?: string }): StoredEvidence[];
  lastSeq(cellId: string): number;
  writeResource(cellId: string, content: string, meta?: { runId?: string; mime?: string; source?: string }): string;
  /** [docs/05] Any cell may read any cell's resource; throws NgError("not_found") for an unknown URI. */
  readResource(uri: string, page?: ResourcePage): string;
}

export function pageOf(text: string, page: ResourcePage | undefined): string {
  const offset = page?.offset ?? 0;
  const limit = page?.limit ?? DEFAULT_RESOURCE_PAGE_CHARS;
  if (!Number.isInteger(offset) || offset < 0) throw new NgError("invalid_argument", "page.offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit <= 0) throw new NgError("invalid_argument", "page.limit must be a positive integer");
  return text.slice(offset, offset + limit);
}

/** Room left after a read_resource page for its paging line ("…[characters a–b shown; more follows: read_resource(…)]"). */
const PAGE_NOTE_CHARS = 2_000;

/**
 * inspect_cell bounds its own answer (at most 40 000 characters for detail "full", with a marker that says how to read
 * an omitted middle) — an explicit read like read_resource: cutting it again would only make the caller read it twice.
 * Kept here because EXPLICIT_READ_TOOLS (protocol) does not list it.
 */
const SELF_BOUNDED_READS: Readonly<Record<string, number>> = {
  read_resource: MAX_RESOURCE_PAGE_CHARS + PAGE_NOTE_CHARS,
  inspect_cell: 40_000 + PAGE_NOTE_CHARS,
};

const isExplicitRead = (tool: string) => EXPLICIT_READ_TOOLS.has(tool) || Object.hasOwn(SELF_BOUNDED_READS, tool);

export function createEvidence(deps: Deps): EvidenceModule {
  const { db, bus, clock, limits } = deps;

  /**
   * How much of an explicit read stays inline. read_resource bounds its own result (one page of at most
   * MAX_RESOURCE_PAGE_CHARS plus its paging line), so a page the agent asked for is never cut again; other explicit
   * reads (a whole artifact) stay whole up to EXPLICIT_READ_INLINE_CHARS. Never below the normal inline limit.
   */
  function explicitReadInlineChars(tool: string): number {
    return Math.max(limits.inlineChars, Object.hasOwn(SELF_BOUNDED_READS, tool) ? SELF_BOUNDED_READS[tool]! : EXPLICIT_READ_INLINE_CHARS);
  }

  function writeResource(cellId: string, content: string, meta: { runId?: string; mime?: string; source?: string } = {}): string {
    if (typeof content !== "string") throw new NgError("invalid_argument", "resource content must be a string");
    if (!cellId || cellId.includes("/")) throw new NgError("invalid_argument", `invalid cellId "${cellId}" for a resource`);
    const uri = `${RESOURCE_URI_PREFIX}${cellId}/${newId("res", clock)}`;
    run(
      db,
      `INSERT INTO resources (uri, cell_id, run_id, mime, source, content, size_chars, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uri, cellId, meta.runId ?? null, meta.mime ?? "text/plain", meta.source ?? null, content, content.length, clock.now()],
    );
    return uri;
  }

  function append(cellId: string, record: StepOrExternalEvidence): EvidenceAppendResult {
    validate(record);
    return withTx(db, () => {
      if (record.kind === "system_note" && record.envelopeId) {
        const prior = get<{seq: number}>(db, "SELECT seq FROM evidence WHERE cell_id=? AND kind='system_note' AND json_extract(content,'$.envelopeId')=? LIMIT 1", [cellId, record.envelopeId]);
        if (prior) return {seq: prior.seq};
      }
      let stored: StepOrExternalEvidence = record;
      let spill: EvidenceAppendResult["spill"];
      let spilledInline: string | null = null;
      if (record.kind === "tool_result" || record.kind === "external") {
        const big = record.kind === "tool_result" ? record.output : record.text;
        const inlineLimit = record.kind === "tool_result" && isExplicitRead(record.name) ? explicitReadInlineChars(record.name) : limits.inlineChars;
        if (big.length > inlineLimit) {
          const uri = writeResource(cellId, big, {
            ...(record.runId ? { runId: record.runId } : {}),
            source: record.kind === "tool_result" ? `tool:${record.name}` : `external:${record.source}`,
          });
          const head = safeHead(big, limits.spillHeadChars);
          const tail = safeTail(big, limits.spillTailChars);
          const inlineChars = head.length + tail.length;
          const inline = `${head}${spillNotice(uri, big.length, head.length, tail.length)}${tail ? `\n${tail}` : ""}`;
          spilledInline = tail ? `${head}\n${tail}` : head;
          stored =
            record.kind === "tool_result" ? { ...record, output: inline, spillUri: uri } : { ...record, text: inline, spillUri: uri };
          spill = { uri, totalChars: big.length, inlineChars };
        }
      }
      const { lastInsertRowid: seq } = run(
        db,
        `INSERT INTO evidence (cell_id, run_id, kind, content, text, spill_uri, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [cellId, stored.runId ?? null, stored.kind, JSON.stringify(stored), searchableText(stored, spilledInline), stored.spillUri ?? null, stored.at],
      );
      // After the outermost commit (also when appended inside a caller's transaction), so the row is readable by then.
      const appended = { cellId, seq, kind: stored.kind, runId: stored.runId ?? null };
      afterCommit(db, () => bus.emit("evidence.appended", appended));
      const result: EvidenceAppendResult = { seq };
      if (spill) result.spill = spill;
      if (stored.kind === "tool_result") result.modelText = stored.output;
      else if (stored.kind === "external") result.modelText = renderExternal(stored);
      return result;
    });
  }

  function list(cellId: string, opts: { afterSeq?: number; uptoSeq?: number; limit?: number; runId?: string } = {}): StoredEvidence[] {
    const where = ["cell_id = ?", "seq > ?"];
    const params: Array<string | number> = [cellId, opts.afterSeq ?? 0];
    if (opts.uptoSeq !== undefined) {
      where.push("seq <= ?");
      params.push(opts.uptoSeq);
    }
    if (opts.runId !== undefined) {
      where.push("run_id = ?");
      params.push(opts.runId);
    }
    let sql = `SELECT seq, cell_id, content FROM evidence WHERE ${where.join(" AND ")} ORDER BY seq`;
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    return all<EvidenceRow>(db, sql, params).map((r) => ({
      seq: r.seq,
      cellId: r.cell_id,
      record: JSON.parse(r.content) as StepOrExternalEvidence,
    }));
  }

  return {
    append,
    list,
    lastSeq(cellId) {
      return get<{ m: number | null }>(db, "SELECT MAX(seq) AS m FROM evidence WHERE cell_id = ?", [cellId])?.m ?? 0;
    },
    writeResource,
    readResource(uri, page) {
      const row = get<{ content: string }>(db, "SELECT content FROM resources WHERE uri = ?", [uri]);
      if (!row) throw new NgError("not_found", `resource "${uri}" not found`);
      return pageOf(row.content, page);
    },
  };
}

export function toEntry(s: StoredEvidence): EvidenceEntry {
  return { seq: s.seq, cellId: s.cellId, record: s.record };
}
