import type { Deliverable } from "./deliverable";
import type { HumanItemDraft } from "../human-item";
import type { Clock } from "../clock";
import type { ContextStore, EvidenceEntry, PromptSnapshot } from "./context";
import type { Envelope, EnvelopeDraft, EnvelopeKind, InboxAddr, IsolationLevel, PolicyBounds, Delivery, ToolKind } from "./envelope";
import type { AuthorizeResult, ProposedAction } from "./gate";
import type { ControlAction, ControlResult, EnqueueResult, Inbox, ScheduleRule } from "./inbox";
import type { ProcessorSpec } from "./loop";
import type { WorkspacePort } from "./workspace";

// docs/02 §二 — ⑦ Cell, verbatim (comments translated). Extensions follow the `[ext]` marker.

// ==================== ⑦ Cell: preset templates and the dynamic assembly container ====================
export interface CellSpec {
  stallPolicy?: "monitor";
  id?: string;
  parentId?: string;                    // forms the supervision tree; closing/cancelling the parent recursively reclaims the subtree
  preset?: string;
  watches?: Array<{ threadOrFilter: Record<string, unknown>; cancelGroup?: string; coalesceMs?: number /* [ext] */ }>;
  schedules?: ScheduleRule[];
  contextMode?: "isolated" | "fork_prefix";
  processor: ProcessorSpec;
  bounds?: Partial<PolicyBounds>;
  // [ext]
  title?: string;
  meta?: Record<string, unknown>;       // free-form, JSON-serializable (conventions: meta.workspace = WorkspaceAcquireOptions)
  /** Set by the kernel (never trusted from callers) for fork_prefix children: history = parent's up to this seq. */
  fork?: { fromCellId: string; uptoSeq: number };
  /**
   * [ext] docs/05 — the directory this cell works in, on the owner's real machine (absolute path). The kernel never
   * creates, snapshots or removes it. A child without `cwd` inherits its parent's. Absent everywhere up the tree = the
   * kernel's `repoPath` (or its process cwd).
   */
  cwd?: string;
  /**
   * [ext] How long the cell lives and how its parent hears from it.
   * - `"wakeable"` (the `worker` preset's default): a leaf that is never closed for finishing a turn. When a Run ends
   *   `completed` (or `refused`) with the inbox drained, no wait open, no Job running and no card pending, the kernel
   *   tells the parent — a `cell.result` carrying `turn` (id `${cellId}:${runId}:settled`, so every settled turn is
   *   announced, also the third one after the owner woke it twice) — and the cell stays `active` and dormant: no
   *   process, no timer, nothing that would wake it by itself. Any message wakes it again on its CLI session. It is
   *   closed with its parent (or by an explicit close).
   * - `"one_shot"` (the `watcher` preset's default): a probe. When a Run ends `completed` (or `refused`) with the
   *   inbox drained, the kernel delivers the cell's single final `cell.result` (id `${cellId}:${epoch}:cell.result`)
   *   and closes the cell — with its watches and timers — in the transaction that completes the claim.
   * - `"persistent"` (default): the cell lives until someone closes it (or it calls complete_self).
   */
  ccParent?: boolean;
  lifetime?: "one_shot" | "wakeable" | "persistent";
  /**
   * [ext] docs/05 §3.3 — the running Loop takes messages that arrive mid-Run into the same Run (`RunPorts.drainInbound`)
   * instead of leaving them for the next one. On for hubs; a one_shot or wakeable cell absorbs what arrives before it
   * settles anyway (so a follow-up is never answered with a stale result).
   */
  absorbInbound?: boolean;
}

export interface CellPorts {            // the controlled capability surface a Loop sees at run time
  workspace: WorkspacePort;
  notifyOwner(content: Deliverable, idempotencyKey: string): Promise<void>;
  context: Pick<ContextStore, "readState" | "commit" | "appendEvidence" | "readResource" | "searchHistory" | "upsertSkillOrNote"
    | "listState" | "getArtifact" | "getArtifactVersion" | "listArtifacts">; // [ext] listState/getArtifact/listArtifacts
  cancelScheduled: Inbox["cancelScheduled"];
  spawnCell(spec: SpawnSpec /* [ext] the processor may come from the preset */, initialPayload?: unknown): Promise<InboxAddr>;
  updateCell(cellId: string, patch: Partial<CellSpec>): Promise<void>; // [ext] own id allowed for watches/schedules/title/meta
  closeCell(cellId: string, reason?: "completed" | "cancelled"): Promise<void>;
}

/** [ext] A spec as a spawner writes it: `processor` may be left to the preset's defaults. */
export type SpawnSpec = Omit<CellSpec, "processor"> & { processor?: ProcessorSpec };

// ==================== [ext] ====================
// How the kernel materializes a spec (conventions every package relies on):
// - watches: `threadOrFilter: { thread: "<channelId>:<externalThreadId>" }` is the exact fast path
//   (cell_watches.thread, matched when Envelope.threads contains it); any other keys are equality filters on
//   top-level envelope fields (`type`, `principalId`, `from`) or `payload.<key>` paths. Matching ingress is routed to
//   the watching cell instead of the desk.
//   A watch's `cancelGroup` is removed together with the cell's timers of that group (RunPorts.cancelScheduled).
// - schedules[i]: enqueue(cellId, timer.fired{ label: `schedule:${i}` } with envelope id
//   `${cellId}:schedule:<first 12 hex of sha256(stableStringify(rule))>`, rule, expectedEpoch = the cell's epoch).
//   The id is content-derived so updateCell can replace schedules without touching the unchanged ones (a deliverAt
//   row that already fired must not fire again, and a cancelled row id cannot be reused).
// - bounds: the request handed to Gate.attenuate (the stored, effective bounds live in cells.bounds, not here).
// - spawnCell's initialPayload becomes the child's first message `cell.task` (id `${childId}:task`): a string is the
//   `instruction`; an object with a string `instruction` (and optional `input`/`title`) is spread; anything else is
//   `input`. No initialPayload → no cell.task (the child sleeps until a watch, schedule or message wakes it).
// - meta.projectCellId is copied from the parent when the child does not set it (gtd.ts projectCellIdOf).
// - [docs/05] watch filters: besides plain equality, a filter value may be an operator object:
//   `{ $in: [...] }` (the field equals one of them), `{ $contains: "x" }` (string field contains it, or array field
//   has it as an element, case-insensitive for strings) and `{ $anyKeyword: [...] }` (string field contains at least
//   one of them, case-insensitive). `coalesceMs` on a watch batches what it routes: see ScheduleRule.coalesce.
// - [docs/05] cwd is inherited from the parent when absent; lifetime comes from the preset's defaults.

export type PresetName = NonNullable<CellSpec["preset"]>;
export type CellLifetime = NonNullable<CellSpec["lifetime"]>;
/** A leaf executor (wakeable worker or one-shot probe), as opposed to a persistent coordinator. */
export function isLeafLifetime(lifetime: CellSpec["lifetime"]): lifetime is "one_shot" | "wakeable" {
  return lifetime === "one_shot" || lifetime === "wakeable";
}
export type CellStatus = "active" | "paused" | "closed";
export type CloseReason = "completed" | "cancelled";
export type CellWatch = NonNullable<CellSpec["watches"]>[number];

/** Identity of the running cell, as seen by its Loop. */
export interface RunSelf {
  cellId: string;
  epoch: number;
  runId: string;
  principalId: `cell:${string}`;
  parentId: string | null;
  depth: number;
  bounds: PolicyBounds;
  spec: CellSpec;
}

export interface ActionStore {
  db: import("../db/sqlite").Db;
  clock: Clock;
  bus: import("../bus").Bus;
  context: ContextStore;
  deskCellId: string;
}

export interface ActionBooks {
  list(): import("../gtd").ActionRecord[];
  write(record: import("../gtd").ActionRecord): void;
  commit(records: import("../gtd").ActionRecord[], statePatches: Record<string, unknown>): void;
}

export interface RunPorts extends CellPorts {
  actionBooks?: ActionBooks;
  isDirectChild(id: string): boolean;
  createHumanItem?(draft: HumanItemDraft): { id: string; itemRevision: number };

  readonly self: RunSelf;
  /** Gate.authorize bound to self (cellId, epoch, principal). */
  authorize(action: ProposedAction, opts?: { artifactVersion?: number }): Promise<AuthorizeResult>;
  /** Steer messages that arrived since the Run started; the Loop checks between model steps and appends them as user text. */
  drainSteer(): DrainedSteerItem[];
  /**
   * [ext] Return unconfirmed envelopes belonging to this Run's claim back to `pending` (e.g. a CLI exited before
   * confirming a live-written steer or follow-up). Optional in the type only so hand-written fakes stay valid.
   */
  requeueEnvelopes?(envelopeIds: readonly string[], reason: string): number;
  /**
   * [ext] Read this cell's append-only SQLite evidence (e.g. when a CLI session falls back to a fresh rebuild and needs
   * the exact SQLite-recorded inbound/turn evidence). Optional in the type only so hand-written fakes stay valid.
   */
  confirmCliInput?(sessionId: string, throughSeq: number): void;
  listEvidence?(opts?: { afterSeq?: number; limit?: number; runId?: string }): EvidenceEntry[];
  /** Confirm the native parent session still represents exactly the creation-time evidence. */
  canForkSession(parentId:string, uptoSeq:number, sessionId:string, delivered:number): boolean;
  listOwnDecisions(): Array<{ record: import("./gate").ApprovalRecord; envelope?: Envelope }>;
  /**
   * Commit with inboxOut to `inbox:<parentId>` (envelope from `inbox:<selfId>`, expectedEpoch = parent's epoch). Throws
   * for root cells. [docs/05] A `cell.result` from a leaf (`one_shot` / `wakeable`) cell is not sent from here: it is
   * stored as the cell's result candidate and delivered by the kernel when the turn settles (CELL_RESULT_CANDIDATE_KEY).
   */
  emitToParent(type: string, payload: unknown, opts?: EmitOptions): Promise<void>;
  /** Enqueue to this cell's own inbox (reminders, timeout nudges with cancelGroup, cron); expectedEpoch = self.epoch. */
  scheduleSelf(env: EnvelopeDraft, rule: ScheduleRule): Promise<EnqueueResult>;
  /** Inbox.control on a descendant as principal `cell:<selfId>` (steer a child, pause/cancel it). */
  controlCell(cellId: string, cmd: { action: ControlAction; steerMessage?: string }): Promise<ControlResult>;
  /**
   * [ext] Inbox.handback for an envelope of this Run's batch (claim = runId): the row ends `handed_back` and the desk
   * receives a `handback` envelope. Optional in the type only so hand-written fakes stay valid; the kernel always
   * provides it.
   */
  handback?(envelopeId: string, reason: string): Promise<void>;
  /**
   * [ext] Acquire the cell's workspace now (idempotent, same isolation and options as `workspace.exec`) and say what an
   * external agent process working directly in it may do. For Loops that hand the directory to another program (CLI
   * agents) instead of going through `workspace.exec`. Optional in the type only so hand-written fakes stay valid.
   */
  workspaceAccess(): Promise<WorkspaceAccess>;

  // ---------- [ext] docs/05 (optional in the type only so hand-written fakes stay valid; the kernel provides all) ----------
  /**
   * Deliver a message to another cell's inbox (`cell.message`, wakeup) — a parent forwarding a follow-up to a child, a
   * worker asking `inbox:desk` to arbitrate, the desk answering it. Checked and enqueued in one transaction:
   * `"closed"` when the target is closed (nothing is stored: re-dispatch instead), `"not_found"` for an unknown cell,
   * `"refused"` when the address is outside this cell's `canSendTo`. Idempotent per `id`.
   */
  sendToCell?(to: InboxAddr, message: CellMessageDraft): Promise<SendToCellResult>;
  /**
   * Take the wakeup messages that reached this cell since the Run started into this Run: each row joins the active
   * claim (so `handback` and a crash-release cover it), gets its `inbound` evidence and is appended to
   * `snapshot.batch.envelopes`. Returns the rendered texts to feed the model, [] when nothing arrived. Steer messages
   * are not taken here (drainSteer).
   */
  drainInbound?(): DrainedInbound[];
  /**
   * Record that this cell is waiting on `waitingFor` (an address such as `inbox:desk`, a child's `inbox:<id>`, or the
   * literals `"human"` / `"external"`). The record survives unrelated wake-ups and is cleared only by a message from
   * that party, a timeout (`timeoutAt` → a `kernel.wait_timeout` wake-up) or `clearWait`. `"human"` is answered by the
   * owner (or their agent) speaking or deciding a card; `"external"` by an outside message, a source hit, or one of the
   * cell's own arranged events (a timer, a job result, a child's result). A wait on a live cell is one of the five
   * anchors of the stall check.
   */
  registerWait?(wait: { waitingFor: string; reason: string; waitId?: string; refId?: string; timeoutAt?: number }): Promise<void>;
  clearWait?(waitingFor: string): Promise<boolean>;
  /**
   * What the kernel does with this cell when the Run has settled (after it left the run table, in the claim's
   * transaction). `complete` / `cancel`: close the cell (refused with a thrown `conflict` when it still has open
   * children, unless `force`); `pause`: status → paused. The last call of a Run wins; the Run should end right after.
   */
  settleSelf?(request: SelfSettleRequest): Promise<void>;
  /** Directory occupancy across the whole kernel: which cells are active in which work tree right now. */
  activeWorkspaces?(): WorkspaceOccupancy[];
  /**
   * What another cell did and was told since `afterSeq` (default: since this cell last inspected it): inbound
   * messages — the owner's direct ones marked as such —, what it said, the files it changed and commands it ran, the
   * artifacts it touched. Same account whatever engine ran the cell. Inspecting one of this cell's descendants moves
   * this cell's cursor for it (the "new since your last inspect" figure in the roster) to the end of what was returned.
   */
  inspectCell?(cellId: string, opts?: InspectCellOptions): Promise<CellInspection>;
}

export interface InspectCellOptions {
  /** Evidence seq to start after. Default: this cell's cursor for the target (0 = from the beginning). */
  afterSeq?: number;
  /** `summary` (default): one line per step; `full`: tool inputs and outputs as recorded (large outputs as res:// links). */
  detail?: "summary" | "full";
  /** Upper bound of the returned text in characters (default 12 000 for summary, 40 000 for full). */
  maxChars?: number;
}

export interface CellInspection {
  cellId: string;
  title: string | null;
  /** Where the cell stands now: working, dormant, waiting, …, or closed. */
  state: string;
  /** Records covered: `fromSeq`..`toSeq` (both 0 when nothing is new). */
  fromSeq: number;
  toSeq: number;
  /** More records exist after `toSeq` (or a middle stretch was omitted): call again with `afterSeq: resumeAfterSeq ?? toSeq`. */
  more: boolean;
  /** When `more` is true due to head+tail truncation, pass this cursor as `afterSeq` to read the omitted middle. */
  resumeAfterSeq?: number;
  directChats: number;
  artifactIds: string[];
  text: string;
}

/** [ext] RunPorts.sendToCell input. */
export interface CellMessageDraft {
  text: string;
  summary?: string;
  data?: unknown;
  /** Idempotency id (default derived from the Run and a counter). */
  id?: string;
  threads?: string[];
}
export type SendToCellResult =
  | { status: "delivered"; envelopeId: string; targetStatus: "active" | "paused" }
  | { status: "closed"; closeReason: CloseReason | null }
  | { status: "not_found" }
  | { status: "refused"; reason: string };

export interface DrainedSteerItem {
  envelopeId: string;
  message: string;
  envelope?: Envelope;
}

export interface DrainedInbound {
  envelope: Envelope;
  /** The envelope rendered exactly as the next hydrate will show it. */
  text: string;
}

export interface SelfSettleRequest {
  /** Preset-owned changes committed only if the requested transition actually happens. */
  statePatches?: Record<string, unknown>;
  pauseReason?: "parked";
  action: "complete" | "cancel" | "pause";
  /** Final text for the parent's `cell.result` when the cell closes without a stashed candidate. */
  summary?: string;
  force?: boolean;
}

/**
 * One work tree and the cells active in it right now. `key` = `git rev-parse --show-toplevel` of the cwd, else its
 * real path. A fact the kernel shows, not a lock it holds: cells and their coordinators decide how to share a
 * directory (message the cell already there, wait for it, look without changing, or work in a `git worktree`).
 */
export interface WorkspaceOccupancy {
  key: string;
  /** Cells with a Run or a background Job in flight whose directory is in this work tree. */
  active: WorkspaceUser[];
}
export interface WorkspaceUser {
  cellId: string;
  title: string | null;
  preset: PresetName | null;
  parentId: string | null;
  /** The project the cell belongs to (meta.projectCellId), with its title, when it has one. */
  projectCellId: string | null;
  projectTitle: string | null;
  cwd: string;
  state: "running" | "job";
  statusLine: string | null;
}

/**
 * [ext] State key on a wakeable leaf: what its parent has already been told. `settledSeq` = last evidence seq covered
 * by a turn-settled notice (the next notice starts after it).
 */
export const CELL_TURN_KEY = "cell:turn";
export interface CellTurnState {
  settledSeq: number;
  settledAt: number;
  notices: number;
}

/**
 * [ext] State key on a cell the owner (or their agent) has spoken to directly, past its parent. `unsettled` counts the
 * messages since the last turn-settled notice; `seen` holds recent client message ids (a retried send is not delivered
 * twice).
 */
export const CELL_DIRECT_CHAT_KEY = "cell:direct_chat";
export interface CellDirectChatState {
  total: number;
  unsettled: number;
  lastAt: number;
  seen: string[];
}

/** [ext] State key in an inspecting cell: the last evidence seq of `targetCellId` it has seen through inspect_cell. */
export function pullCursorKey(targetCellId: string): string {
  return `pull:${targetCellId}`;
}

/**
 * [ext] docs/05 guard 1 — state key where a leaf cell's `report_to_parent(kind: "result")` stashes its candidate
 * result (CellResultCandidate). The kernel reads it when the turn settles and is the only sender of the cell's
 * `cell.result` (a wakeable cell's candidate is cleared once delivered: the next turn reports for itself).
 */
export const CELL_RESULT_CANDIDATE_KEY = "cell:result";
export interface CellResultCandidate {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  artifactId?: string;
  data?: unknown;
  at: number;
}

/** [ext] Id of the single final result a cell delivers to its parent. */
export function finalResultEnvelopeId(cellId: string, epoch: number): string {
  return `${cellId}:${epoch}:cell.result`;
}

/** [ext] See RunPorts.workspaceAccess. */
export interface WorkspaceAccess {
  /** Absolute host path of the working directory. */
  root: string;
  isolation: IsolationLevel;
  /** Native capabilities granted by the current bounds. */
  tools: ToolKind[];
}

export interface EmitOptions {
  id?: string;                          // idempotency id; default derived from runId + type + a counter
  kind?: EnvelopeKind;                  // default "result" for cell.result, otherwise "event"
  delivery?: Delivery;
  threads?: string[];
  producerModel?: string;
}

/**
 * How a preset turns a partial spec into the stored, resolved spec. The kernel merges `defaults` under the caller's
 * spec (caller wins field by field; `processor` is replaced as a whole when given; `meta` is merged shallowly). The
 * bounds request is the preset's (`requestBounds(...)` if defined, else `defaults.bounds`) with the caller's `bounds`
 * fields laid over it field by field — a caller narrowing one field keeps e.g. the preset's isolation — and that
 * request goes through Gate.attenuate, so nothing a preset or caller asks for can exceed the parent.
 */
export interface PresetDef {
  /** This preset coordinates an independently reopenable project. */
  projectRoot?: boolean;
  onCellClosed?(cell:CellRecord, reason:CloseReason, store:ContextStore, clock:Clock):void;
  onCellReopened?(cell:CellRecord, store:ContextStore, clock:Clock):void;
  actionBooks?(store: ActionStore, cellId: string): ActionBooks;

  /** Synchronous preset plan applied in the same transaction as a confirmed action. */
  approvedSpawn?(record: import("./gate").ApprovalRecord, store: Pick<ContextStore, "getArtifactVersionSync" | "readStateSync">, clock: Clock):
    { spec: CellSpec; task: unknown } | undefined;

  personalReminder?(envelope: Envelope): { id: string; draft: HumanItemDraft } | undefined;

  name: PresetName;
  description: string;
  defaults: Partial<Omit<CellSpec, "id" | "parentId" | "preset" | "fork">>;
  requestBounds?(ctx: { parentCellId: string; parentBounds: PolicyBounds }): Partial<PolicyBounds>;
  /**
   * [ext] docs/05 — false: cells of this preset do not inherit their parent's `cwd` (sensors: they check things with
   * commands in a private directory of their own). Default true.
   */
  inheritCwd?: boolean;
  /**
   * [ext] Deterministic bookkeeping the kernel runs at the start of every Run of a cell of this preset, after the
   * batch is recorded and before the Loop — whichever engine executes it — so records that follow mechanically from
   * the batch's events never depend on a model deciding to call a tool. Same ports as the Run. Must be idempotent (a
   * retried batch runs it again) and quick. `"handled"` = nothing in this batch needs the Loop: the Run completes
   * without it. A thrown error is reported through the kernel's onError and the Loop runs anyway.
   */
  prepareRun?(input: PrepareRunInput): Promise<"handled" | void> | "handled" | void;
}

/** [ext] See PresetDef.prepareRun. */
export interface PrepareRunInput {
  snapshot: PromptSnapshot;
  ports: RunPorts;
  signal: AbortSignal;
  clock: Clock;
}

/** A row of `cells`, decoded. Read it through `cellsRepo(db)`. */
export interface CellRecord {
  id: string;
  parentId: string | null;
  rootId: string;
  depth: number;
  preset: PresetName | null;
  title: string | null;
  spec: CellSpec;                       // resolved spec
  bounds: PolicyBounds;                 // effective bounds (after attenuate)
  epoch: number;
  status: CellStatus;
  closeReason: CloseReason | null;
  pauseReason: "manual" | "parked" | null;
  principalId: string;                  // principal that created the cell
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  closedAt: number | null;
}
