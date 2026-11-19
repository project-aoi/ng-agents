import type { Clock } from "../clock";
import type { Channel } from "./channel";
import type { ContextStore, PromptSnapshot } from "./context";
import type { Envelope, EnvelopeDraft, EnvelopeKind, InboxAddr, IsolationLevel, PolicyBounds, Delivery, ToolKind } from "./envelope";
import type { AuthorizeResult, MeterResult, ProposedAction, Usage } from "./gate";
import type { ControlAction, ControlResult, EnqueueResult, Inbox, ScheduleRule } from "./inbox";
import type { ProcessorSpec } from "./loop";
import type { WorkspacePort } from "./workspace";

// docs/02 §二 — ⑦ Cell, verbatim (comments translated). Extensions follow the `[ext]` marker.

// ==================== ⑦ Cell: preset templates and the dynamic assembly container ====================
export interface CellSpec {
  id?: string;
  parentId?: string;                    // forms the supervision tree; closing/cancelling the parent recursively reclaims the subtree
  preset?: "inline" | "worker" | "watcher" | "sensor" | "project" | "hub"; // [ext] project, hub (docs/05)
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
   * [ext] How the dispatcher claims this cell's inbox. Default `serial_coalesce`: one Run at a time, every due message
   * coalesced into it. `competing_workers`: up to `maxParallelRuns` Runs at once, one wakeup message each (a pool).
   */
  claimMode?: "serial_coalesce" | "competing_workers";
  maxParallelRuns?: number;
  /**
   * [ext] docs/05 — the directory this cell works in, on the owner's real machine (absolute path). The kernel never
   * creates, snapshots or removes it. A child without `cwd` inherits its parent's. Absent everywhere up the tree = the
   * kernel's `repoPath` (or its process cwd).
   */
  cwd?: string;
  /**
   * @deprecated Accepted and stored for specs written before the kernel stopped scheduling by it; it has no effect.
   * The kernel no longer queues writers per work tree and no longer tells a cell it is "read-only" by this field:
   * every dispatched cell starts at once, who is active in which directory is shown to the cells
   * (WorkspaceOccupancy, the "active workspaces" note), and the prompts say how to share a directory.
   */
  cwdMode?: "read" | "write";
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
  notifyChannel: Channel["send"];       // [ext] here `target` is a full ChannelAddr; the kernel routes via ChannelHub
  streamPreview: NonNullable<Channel["streamPreview"]>;
  context: Pick<ContextStore, "readState" | "commit" | "appendEvidence" | "readResource" | "searchHistory" | "upsertSkillOrNote"
    | "listState" | "getArtifact" | "listArtifacts">; // [ext] listState/getArtifact/listArtifacts
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
export const PRESET_NAMES = ["inline", "worker", "watcher", "sensor", "project", "hub"] as const satisfies readonly PresetName[];
export type CwdMode = NonNullable<CellSpec["cwdMode"]>;
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

/**
 * What the kernel actually hands a Loop for one Run. Every port is already bound to this cell, epoch and
 * principal; the kernel enforces bounds on workspace exec (tool ∈ bounds.tools), sends (target ∈ canSendTo, valid
 * actionToken) and spawns (attenuate, maxConcurrentChildren). Tools still call `authorize` for anything with a side
 * effect so Gate can defer it.
 */
export interface RunPorts extends CellPorts {
  readonly self: RunSelf;
  /** Gate.authorize bound to self (cellId, epoch, principal). */
  authorize(action: ProposedAction, opts?: { artifactVersion?: number }): Promise<AuthorizeResult>;
  /** Gate.meter for this cell; the Loop calls it after every model call and stops with budget_stopped on hard_stop. */
  meter(usage: Usage): MeterResult;
  /** Steer messages that arrived since the Run started; the Loop checks between model steps and appends them as user text. */
  drainSteer(): string[];
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
   * [ext] Withdraw one of this cell's own pending cards (docs/04 §2.1 rule 3: someone already answered in the group →
   * the card is taken down and archived): pending → cancelled with `reason`. Cards raised by other cells are never
   * touched ("not_pending"). Optional in the type only so hand-written fakes stay valid; the kernel always provides it.
   */
  withdrawApproval?(ref: { actionId?: string; subjectKey?: string }, reason: string): Promise<"cancelled" | "not_pending">;
  /**
   * [ext] Acquire the cell's workspace now (idempotent, same isolation and options as `workspace.exec`) and say what an
   * external agent process working directly in it may do. For Loops that hand the directory to another program (CLI
   * agents) instead of going through `workspace.exec`. Optional in the type only so hand-written fakes stay valid.
   */
  workspaceAccess?(): Promise<WorkspaceAccess>;

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
  registerWait?(wait: { waitingFor: string; reason: string; timeoutAt?: number }): Promise<void>;
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
  /** More records exist after `toSeq` (the text limit was reached): call again with `afterSeq: toSeq`. */
  more: boolean;
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

export interface DrainedInbound {
  envelope: Envelope;
  /** The envelope rendered exactly as the next hydrate will show it. */
  text: string;
}

export interface SelfSettleRequest {
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
  status: "completed" | "failed" | "cancelled" | "budget_stopped";
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
  /** Absolute host path of the working directory (the cell's `cwd`; a container's mount source). */
  root: string;
  isolation: IsolationLevel;
  /**
   * Workspace tool kinds the kernel's own workspace port would allow this Run right now: `bounds.tools`, minus
   * everything but read on "shared_ro". `processor.allowedTools` is not applied here (the Loop applies it).
   */
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
  principalId: string;                  // principal that created the cell
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  closedAt: number | null;
}
