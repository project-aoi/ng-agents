import type {
  Bus,
  CellRecord,
  CellSpec,
  CellsRepo,
  ChildSummary,
  Envelope,
  Clock,
  Db,
  InboxWriter,
  ModelMessage,
  Registry,
} from "@ng/protocol";

/** Input handed to the summariser when older history is folded into one summary record. */
export interface SummaryInput {
  cellId: string;
  /** The summary currently standing in for even older history (fold it in), or null on the first compaction. */
  previousSummary: string | null;
  /** The messages being folded, merged (mergeAdjacentMessages), oldest first. */
  messages: ModelMessage[];
  /** Prose and reference list target. Complete reference addresses take precedence when they alone exceed this size. */
  maxChars: number;
  /** Number of compactions already performed on this cell (0 = first compaction). */
  compactions?: number;
}

/** May be async (e.g. a model call); the sync hydrate path never calls an injected summariser (see ContextStoreOptions). */
export type Summarizer = (input: SummaryInput) => string | Promise<string>;

export interface ContextLimits {
  /** tool_result.output / external.text longer than this (UTF-16 chars) is spilled to a resource. */
  inlineChars: number;
  /** Chars kept inline from the start / end of a spilled text (head + tail must not exceed inlineChars). */
  spillHeadChars: number;
  spillTailChars: number;
  /** Cap on the level-1 skills index in the frozen system prefix (lines). */
  skillIndexMaxLines: number;
  /** Compact when the rendered history exceeds this many chars… */
  compactAtChars: number;
  /** …keeping roughly this much of the most recent history verbatim (the boundary moves in big steps). */
  keepRecentChars: number;
  /** Target size of a summary. */
  summaryMaxChars: number;
  /** Default number of searchHistory hits. */
  searchLimit: number;
}

export const DEFAULT_LIMITS: ContextLimits = {
  inlineChars: 4000,
  spillHeadChars: 3000,
  spillTailChars: 800,
  skillIndexMaxLines: 200,
  compactAtChars: 240_000,
  keepRecentChars: 128_000,
  summaryMaxChars: 8000,
  searchLimit: 20,
};

export interface ContextStoreOptions {
  runtimeVersion?: string;
  db: Db;
  bus: Bus;
  clock: Clock;
  /** Same-transaction enqueue for `commit({ inboxOut })` (the Inbox's enqueueSync). */
  inbox: InboxWriter;
  /** Skill files live under `<dataDir>/skills`. */
  dataDir: string;
  /** Resolves `spec.processor.prompt` (Registry.prompts). Required if any cell names a prompt and no resolvePrompt is given. */
  registry?: Registry;
  /** Overrides the registry lookup. Return the preset/system prompt text for a cell ("" for none). */
  resolvePrompt?: (spec: CellSpec, cell: CellRecord) => string;
  /**
   * In-flight children roster for the volatile tail. Default: active/paused children + their `cell:status` state.
   * A provider may return a whole subtree in tree order (`depth` > 1 entries are indented under their parent).
   */
  rosterProvider?: (cellId: string) => ChildSummary[];
  /**
   * [docs/05] Extra volatile notes for the tail (active workspaces, open waits): each non-blank note becomes one user
   * text message, verbatim, after the roster and before the batch, and is listed in `tail.notes`. Never persisted.
   */
  tailNotesProvider?: (cellId: string, incoming?: readonly Envelope[], runId?: string) => string[];
  /**
   * Compaction summariser. Default: a deterministic truncating summary (no model). When one is injected, only the
   * async paths (`hydrate`, `compact`) compact; `hydrateSync` never calls it and leaves an over-budget history as is.
   */
  summarize?: Summarizer;
  limits?: Partial<ContextLimits>;
  /** Scan `<dataDir>/skills` when the store is created so manual edits made while down are indexed. Default true. */
  rescanSkillsOnCreate?: boolean;
}

/** What the internal modules share. */
export interface Deps {
  db: Db;
  bus: Bus;
  clock: Clock;
  cells: CellsRepo;
  limits: ContextLimits;
  dataDir: string;
}
