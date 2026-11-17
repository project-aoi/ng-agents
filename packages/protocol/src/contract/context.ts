import type { CellSpec, CellStatus, PresetName } from "./cell";
import type { Deliverable } from "./deliverable";
import type { Envelope, InboxAddr, PolicyBounds } from "./envelope";
import type { ClaimedBatch, ScheduleRule } from "./inbox";
import type { RunOutcome } from "./loop";
import type { ModelMessage } from "./model";
import type { Usage } from "./gate";

// docs/02 §二 — ③ Context, verbatim (comments translated). Extensions follow the `[ext]` marker.

// ==================== ③ Context: business state, versioned draft Artifacts, FTS5 and skills ====================
export interface VersionedArtifact {    // human-visible deliverables: reply drafts, proposal docs, PR summaries
  artifactId: string;
  version: number;                      // optimistic-lock version: stops background writes silently overwriting human edits, and blind-sending a newer version at confirm time
  content: Deliverable;
  updatedBy: "agent" | "human";
  // [ext]
  cellId: string;                       // owning cell (set at creation, never changes)
  createdAt: number;
  updatedAt: number;
}

export interface ContextStore {
  // 1. Business state (transactional reads/writes relying on the per-Cell serial lock) and version-protected draft Artifact commits
  readState<T = unknown>(cellId: string, key: string): Promise<T | null>;
  commit(cellId: string, tx: {
    statePatches?: Record<string, unknown>;
    artifact?: { artifactId: string; content: Deliverable; updatedBy: "agent" | "human"; expectedVersion?: number };
    inboxOut?: Array<{ to: InboxAddr; envelope: Envelope; schedule?: ScheduleRule }>; // cross-Cell messages delivered in the same DB transaction
  }): Promise<CommitResult>; // [ext] doc's inline union, plus the optional `parked` on failure (see CommitResult)

  // 2. Prefix-stable prompt snapshot (incl. in-flight children summary) and SQLite FTS5 search (code/skill search goes through Workspace ripgrep)
  hydrate(cellId: string, batch: ClaimedBatch, mode: "isolated" | "fork_prefix"): Promise<PromptSnapshot>;
  appendEvidence(cellId: string, record: StepOrExternalEvidence): Promise<EvidenceAppendResult>; // [ext] doc returns void; the result is additive
  readResource(cellId: string, uri: string, page?: { offset: number; limit: number }): Promise<string>; // Inline & Spill
  searchHistory(cellId: string, query: string): Promise<Snippet[]>;

  // 3. Long-term preferences and SKILL.md maintenance (physically separate from business state)
  upsertSkillOrNote(cellId: string, patch: KnowledgePatch): Promise<void>;

  // ---------- [ext] additional reads (also exposed to Loops through CellPorts.context) ----------
  listState(cellId: string, keyPrefix: string): Promise<StateEntry[]>;
  /** Cross-cell read for UI projections, e.g. every `gtd:action:` key in the system. */
  queryState(q: StateQuery): Promise<StateEntry[]>;
  getArtifact(artifactId: string): Promise<VersionedArtifact | null>;
  listArtifacts(cellId: string): Promise<VersionedArtifact[]>;

  // ---------- [ext] sync twins (the async methods delegate to these) ----------
  readStateSync<T = unknown>(cellId: string, key: string): T | null;
  commitSync(cellId: string, tx: CommitTx): CommitResult;
  hydrateSync(cellId: string, batch: ClaimedBatch, mode: ContextMode): PromptSnapshot;
  appendEvidenceSync(cellId: string, record: StepOrExternalEvidence): EvidenceAppendResult;
  readResourceSync(cellId: string, uri: string, page?: ResourcePage): string;
  searchHistorySync(cellId: string, query: string, opts?: { limit?: number }): Snippet[];
  upsertSkillOrNoteSync(cellId: string, patch: KnowledgePatch): void;
  listStateSync(cellId: string, keyPrefix: string): StateEntry[];
  queryStateSync(q: StateQuery): StateEntry[];
  getArtifactSync(artifactId: string): VersionedArtifact | null;
  listArtifactsSync(cellId: string): VersionedArtifact[];

  // ---------- [ext] sync-only (UI / kernel) ----------
  listArtifactVersionsSync(artifactId: string): ArtifactVersionRecord[];
  /** Agent content that lost a version race against a human edit ("reference zone" shown beside the editor). */
  listParkedSync(artifactId: string, opts?: { includeDismissed?: boolean }): ParkedAddition[];
  dismissParkedSync(parkedId: string): void;
  getKnowledgeSync(q: { kind: KnowledgeKind; name: string; scope: KnowledgeScope; cellId?: string }): KnowledgeRecord | null;
  listKnowledgeSync(filter?: { kind?: KnowledgeKind; cellId?: string; includeGlobal?: boolean }): KnowledgeRecord[];
  /** Store a large text as a resource and return its `res://` URI (used for job logs and explicit spills). */
  writeResourceSync(cellId: string, content: string, meta?: { runId?: string; mime?: string; source?: string }): string;
  /**
   * Last evidence seq folded into this cell's history (0 if none) — its own last record, or the inherited fork point
   * if it has none yet. The kernel records it as `spec.fork.uptoSeq` for fork_prefix children.
   */
  lastEvidenceSeqSync(cellId: string): number;

  // ---------- [ext, @ng/context] further sync-only operations ----------
  getArtifactVersionSync(artifactId: string, version: number): ArtifactVersionRecord | null;
  /**
   * Explicitly park agent content beside an artifact (reference zone) instead of overwriting it, e.g. when a Loop
   * decides not to redo its edit after a conflict. Throws NgError("not_found") for an unknown artifact.
   * (commit already parks automatically when an agent write loses against a human-authored current version.)
   */
  parkAdditionSync(artifactId: string, addition: ParkInput): ParkedAddition;
  /** Level-1 skills index visible to a cell (nearest scope wins on a name clash); global skills only when cellId is omitted. */
  listSkillsSync(cellId?: string): SkillIndexEntry[];
  /** Re-read `<dataDir>/skills/**\/SKILL.md` and bring the `knowledge` skill rows in line with the files (manual edits). */
  rescanSkillsSync(): SkillRescanReport;
  /** The cell's own append-only records in seq order (UI transcript, debugging). */
  listEvidenceSync(cellId: string, opts?: { afterSeq?: number; limit?: number; runId?: string }): EvidenceEntry[];
  /**
   * Rebuild the cell's frozen system prefix from current inputs (prompt, skills, bounds, preferences) on its next
   * hydrate. Breaks the provider cache once; the kernel calls it after updateCell changes processor/bounds.
   * Compaction state is kept.
   */
  refreshPrefixSync(cellId: string): void;
  /**
   * Fold older history into one summary record if it is over budget (or always with `force`), using the injected
   * summariser (may be async). Returns null when nothing was compacted. Async `hydrate` calls this first.
   */
  compact(cellId: string, opts?: { force?: boolean; mode?: ContextMode }): Promise<CompactionResult | null>;
}

// ==================== [ext] types ====================

export type ArtifactAuthor = VersionedArtifact["updatedBy"];
export type ContextMode = "isolated" | "fork_prefix";
/**
 * Resources are addressed `res://<cellId>/<id>`. `offset`/`limit` count UTF-16 characters (JS string indices);
 * default page is the first 8000 chars. A cell may read its own resources, its ancestors' (fork_prefix history
 * can reference them) and its descendants' (a child's report may point at its spilled output); anything else throws
 * NgError("not_found").
 * Other URIs readResource serves (same paging): `skill://<name>` (SKILL.md body), `note://<name>`,
 * `preference://<name>` (nearest visible scope: the cell, then its ancestors, then global) and
 * `artifact://<id>[@<version>]` (the Deliverable body; same tree rule as res://).
 */
export type ResourcePage = { offset: number; limit: number };
export const RESOURCE_URI_PREFIX = "res://";
export const DEFAULT_RESOURCE_PAGE_CHARS = 8000;

/**
 * hydrate inputs (all read from the shared DB): the cell row via cellsRepo (spec, bounds, epoch); the system prompt
 * text from Registry.prompts[spec.processor.prompt] (code processors get an empty prompt); skills and preferences
 * from `knowledge` (global, ancestors' cell scope, this cell — nearest wins on a name clash); the roster from
 * cellsRepo.children(cellId, { status: ["active","paused"] }) plus each child's CELL_STATUS_KEY state. hydrate writes
 * only `prompt_prefixes` (the first time, on refresh, or when it compacts).
 */
export type HydrateMode = ContextMode;

/**
 * Commit semantics (all-or-nothing, one SQLite transaction, nests inside a caller's `withTx`):
 * - `statePatches`: key → JSON value; `null`/`undefined` deletes the key. Keys are free-form; GTD keys live in gtd.ts.
 * - `artifact`: creates (version 1) when the id does not exist (`expectedVersion` must be absent or 0); otherwise
 *   `expectedVersion` must equal the current version. An *agent* write without `expectedVersion` is accepted only if
 *   the current version was also written by the agent. On mismatch the whole commit is rejected with
 *   `{ ok:false, currentArtifact }`; additionally, if the losing write was by the agent and the current version is
 *   human-authored, the agent content is parked (ParkedAddition, returned as `parked`; the parked row is the only
 *   write that survives the rejected commit) — the human draft is never overwritten.
 *   An artifact can only be committed through its owning cellId.
 * - `inboxOut`: enqueued via the injected InboxWriter in the same transaction (cellId parsed from `to`).
 * - Emits `state.changed` / `artifact.changed` after commit.
 */
export interface CommitTx {
  statePatches?: Record<string, unknown>;
  artifact?: ArtifactWrite;
  inboxOut?: Array<{ to: InboxAddr; envelope: Envelope; schedule?: ScheduleRule }>;
}
export interface ArtifactWrite {
  artifactId: string;
  content: Deliverable;
  updatedBy: ArtifactAuthor;
  expectedVersion?: number;
}
/** `parked` is set when the losing agent content was parked beside the human-authored current version. */
export type CommitResult =
  | { ok: true; artifactVersion?: number }
  | { ok: false; currentArtifact: VersionedArtifact; parked?: ParkedAddition };

export interface StateEntry {
  cellId: string;
  key: string;
  value: unknown;
  updatedAt: number;
}

/** Prefix match on keys, optionally restricted to some cells. */
export interface StateQuery {
  keyPrefix: string;
  cellIds?: readonly string[];
}

export interface ArtifactVersionRecord {
  artifactId: string;
  version: number;
  content: Deliverable;
  updatedBy: ArtifactAuthor;
  createdAt: number;
}

export interface ParkedAddition {
  id: string;
  artifactId: string;
  basedOnVersion: number;               // the version the agent thought it was editing
  content: Deliverable;
  note?: string;                        // [ext] why it was parked / what it adds (shown with it in the reference zone)
  createdAt: number;
  dismissedAt: number | null;
}

export interface ParkInput {
  content: Deliverable;
  basedOnVersion: number;
  note?: string;
}

// ---------- Evidence (append-only transcript) ----------

export type EvidenceKind =
  | "inbound"
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "external"
  | "system_note"
  | "run_boundary";

interface EvidenceBase {
  runId: string | null;                 // null for records written outside a Run (UI notes, kernel bookkeeping)
  at: number;
  spillUri?: string;                    // set by Context when the large part of this record was spilled to a resource
}

/**
 * Who writes what:
 * - kernel (@ng/cell): after `hydrate` returns and before `Loop.run`: `run_boundary` start, then one `inbound` per
 *   batch envelope (so the batch is in the tail now and in history next time, never both); after the Run:
 *   `run_boundary` end.
 * - Loop: `assistant_text`, `tool_call`, `tool_result` in the order they happen; `system_note` with
 *   `steerNoteText(msg)` for each drained steer message.
 * - anyone with a reason (sensors, UI, tools): `external` (fetched/observed material), `system_note`.
 * Context rebuilds `history` from these: inbound/external/system_note → user text; consecutive
 * assistant_text/tool_call → one assistant message; consecutive tool_result → one user message;
 * run_boundary → not rendered. A tool_call without a recorded result (crashed Run) gets a synthetic error result.
 */
export type StepOrExternalEvidence =
  | (EvidenceBase & { kind: "inbound"; envelope: Envelope })
  | (EvidenceBase & { kind: "assistant_text"; text: string; model?: string })
  | (EvidenceBase & { kind: "tool_call"; toolUseId: string; name: string; input: unknown })
  | (EvidenceBase & { kind: "tool_result"; toolUseId: string; name: string; output: string; isError?: boolean })
  | (EvidenceBase & { kind: "external"; source: string; title?: string; text: string; uri?: string })
  | (EvidenceBase & { kind: "system_note"; text: string })
  | (EvidenceBase & { kind: "run_boundary"; phase: "start" | "end"; epoch: number; outcome?: RunOutcome | "error"; usage?: Usage; error?: string });

export type EvidenceOf<K extends EvidenceKind> = Extract<StepOrExternalEvidence, { kind: K }>;

/**
 * Inline & Spill: when a record's large text (tool_result.output, external.text) exceeds Context's inline limit,
 * Context stores the full text as a resource, keeps an inline head, and reports it here.
 */
export interface EvidenceAppendResult {
  seq: number;
  spill?: { uri: string; totalChars: number; inlineChars: number };
  /**
   * For tool_result/external: the exact text history will show the model for this record (inline head + spill notice).
   * The Loop feeds the model this text in the current Run so the next hydrate reproduces the same prefix.
   */
  modelText?: string;
}

/** Shared wording for spilled output so Context (history) and Loop (current Run) render identically. */
export function spillNotice(uri: string, totalChars: number, inlineChars: number): string {
  return `\n…[output truncated: showing ${inlineChars} of ${totalChars} chars; read the rest with read_resource("${uri}", offset, limit)]`;
}

/**
 * Steer messages drained mid-Run: the Loop appends a `system_note` whose text is `steerNoteText(msg)` and feeds the
 * model the same text as a user text block; Context renders system_note text verbatim, so both match.
 */
export function steerNoteText(message: string): string {
  return `[steer from the user while you were working] ${message}`;
}

/** A stored evidence record as read back (large text already cut to its inline form, `spillUri` set if spilled). */
export interface EvidenceEntry {
  seq: number;
  cellId: string;
  record: StepOrExternalEvidence;
}

/**
 * A search hit. `source: "evidence"` → an append-only record (seq = evidence seq, kind = EvidenceKind);
 * `source: "knowledge"` → a note/skill/preference (seq = knowledge row seq, kind = KnowledgeKind, cellId = null for
 * global knowledge, `uri` = note://, skill:// or preference://<name>, `title` = its name).
 * searchHistory scope: the cell's own evidence (plus its fork_prefix inheritance up to the fork point), knowledge of
 * the cell and its ancestors, and global knowledge. Queries are split on whitespace; terms of >= 3 characters use the
 * FTS5 trigram index, shorter ones a substring LIKE.
 */
export interface Snippet {
  seq: number;
  cellId: string | null;                // [ext] null only for global knowledge
  runId: string | null;
  kind: EvidenceKind | KnowledgeKind;   // [ext] KnowledgeKind for knowledge hits
  text: string;                         // excerpt around the match
  at: number;
  spillUri?: string;
  rank?: number;                        // lower is better (FTS5 bm25); absent for LIKE-only matches
  source: "evidence" | "knowledge";     // [ext]
  uri?: string;                         // [ext] readable with readResource (knowledge hits; spilled evidence → spillUri)
  title?: string;                       // [ext] knowledge name, or an external record's title
}

// ---------- Knowledge (SKILL.md, notes, preferences) ----------

export type KnowledgeKind = "skill" | "note" | "preference";
export type KnowledgeScope = "global" | "cell";

/**
 * - upsert: create or replace description/body/tags (description + body required).
 * - append: append `body` to the existing body (creates it if missing).
 * - delete: remove (only kind/name/scope matter).
 * `scope: "cell"` means the cellId passed to upsertSkillOrNote.
 */
export interface KnowledgePatch {
  kind: KnowledgeKind;
  name: string;                         // unique per (kind, scope[, cell]); skills use a slug, e.g. "weekly-review"
  description?: string;                 // one line; this is what the skills index shows
  body?: string;                        // SKILL.md body / note / preference text (markdown)
  scope: KnowledgeScope;
  tags?: string[];
  mode: "upsert" | "append" | "delete";
}

export interface KnowledgeRecord {
  id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  cellId: string | null;                // set when scope = "cell"
  name: string;
  description: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SkillIndexEntry {
  name: string;
  description: string;
  scope: KnowledgeScope;
  tags: string[];
}

/**
 * Skill files: global skills at `<dataDir>/skills/<name>/SKILL.md`, cell-scoped skills at
 * `<dataDir>/skills/_cells/<encodeURIComponent(cellId)>/<name>/SKILL.md`. YAML front matter carries `name`,
 * `description` and optional `tags`; other front matter keys are preserved on rewrite. Skill names are slugs
 * (`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 chars) and the directory name is authoritative.
 */
export interface SkillRescanReport {
  added: string[];                      // "<name>" for global, "<cellId>/<name>" for cell scope
  updated: string[];
  removed: string[];
  unchanged: number;
  errors: Array<{ path: string; message: string }>; // unreadable/invalid files; their existing rows are left untouched
}

export interface CompactionResult {
  cellId: string;
  summaryUptoSeq: number;               // evidence up to here is now represented by the summary
  foldedMessages: number;
  charsBefore: number;
  charsAfter: number;
  compactions: number;                  // how many times this cell has been compacted
}

// ---------- Prompt snapshot ----------

/** One line per child in the volatile tail ("in-flight children roster"). */
export interface ChildSummary {
  cellId: string;
  title: string | null;
  preset: PresetName | null;
  status: CellStatus;
  epoch: number;
  lastRunAt: number | null;
  statusLine: string | null;            // from the child's `cell:status` state key (CELL_STATUS_KEY), if any
}

/** Conventional state key a cell writes to describe itself in its parent's roster. Value: CellStatusLine. */
export const CELL_STATUS_KEY = "cell:status";
export interface CellStatusLine {
  text: string;
  at: number;
  progress?: { done: number; total: number; label?: string };
}

/**
 * Everything a Loop needs for one bounded Run, laid out for prompt-cache prefix stability:
 *
 *   system  — frozen per cell (preset prompt + skills index + inlined `processor.skills` + bounds summary +
 *             long-term preferences); stored in `prompt_prefixes` on first hydrate and reused verbatim until
 *             compaction or refreshPrefixSync. A fork_prefix child freezes a copy of its parent's system instead (so
 *             the provider cache can hit); its own prompt and bounds go into the fork note below.
 *   history — provider-neutral messages rebuilt from evidence; append-only across Runs (between compactions,
 *             `history` of one Run is an element-wise prefix of the next Run's).
 *             fork_prefix: the parent's history up to `spec.fork.uptoSeq` (frozen at the child's first hydrate),
 *             then one user "fork note" naming the child, its task prompt and bounds, then the child's own records.
 *             After a compaction: one user summary message, then the records after the summary boundary.
 *   tail    — volatile, never persisted as-is: the in-flight children roster summary (if any children) followed by
 *             the new batch rendered as a user message. Next Run, the batch reappears in history from its `inbound`
 *             evidence rendered identically; the roster does not.
 *
 * Send to the model as: system, then `mergeAdjacentMessages([...history, ...tail.messages])`.
 */
export interface PromptSnapshot {
  cellId: string;
  epoch: number;
  runId: string;                        // === batch.claimId
  mode: ContextMode;
  spec: CellSpec;                       // resolved spec as stored in cells.spec (preset defaults applied)
  bounds: PolicyBounds;                 // effective bounds of the cell
  batch: ClaimedBatch;
  system: { text: string; hash: string };
  history: ModelMessage[];
  historyUptoSeq: number;               // last evidence seq folded into history
  tail: {
    roster: ChildSummary[];
    messages: ModelMessage[];
  };
  skills: SkillIndexEntry[];            // the index embedded in `system` (bodies are read on demand)
  createdAt: number;
}
