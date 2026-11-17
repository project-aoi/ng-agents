import type { Clock } from "../clock";
import type { Channel } from "./channel";
import type { ContextStore, PromptSnapshot } from "./context";
import type { EnvelopeDraft, EnvelopeKind, InboxAddr, IsolationLevel, PolicyBounds, Delivery, ToolKind } from "./envelope";
import type { AuthorizeResult, MeterResult, ProposedAction, Usage } from "./gate";
import type { ControlAction, ControlResult, EnqueueResult, Inbox, ScheduleRule } from "./inbox";
import type { ProcessorSpec } from "./loop";
import type { WorkspacePort } from "./workspace";

// docs/02 §二 — ⑦ Cell, verbatim (comments translated). Extensions follow the `[ext]` marker.

// ==================== ⑦ Cell: preset templates and the dynamic assembly container ====================
export interface CellSpec {
  id?: string;
  parentId?: string;                    // forms the supervision tree; closing/cancelling the parent recursively reclaims the subtree
  preset?: "inline" | "worker" | "watcher" | "sensor";
  watches?: Array<{ threadOrFilter: Record<string, unknown>; cancelGroup?: string }>;
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
}

export interface CellPorts {            // the controlled capability surface a Loop sees at run time
  workspace: WorkspacePort;
  notifyChannel: Channel["send"];       // [ext] here `target` is a full ChannelAddr; the kernel routes via ChannelHub
  streamPreview: NonNullable<Channel["streamPreview"]>;
  context: Pick<ContextStore, "readState" | "commit" | "appendEvidence" | "readResource" | "searchHistory" | "upsertSkillOrNote"
    | "listState" | "getArtifact" | "listArtifacts">; // [ext] listState/getArtifact/listArtifacts
  cancelScheduled: Inbox["cancelScheduled"];
  spawnCell(spec: CellSpec, initialPayload?: unknown): Promise<InboxAddr>;
  updateCell(cellId: string, patch: Partial<CellSpec>): Promise<void>;
  closeCell(cellId: string, reason?: "completed" | "cancelled"): Promise<void>;
}

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

export type PresetName = NonNullable<CellSpec["preset"]>;
export const PRESET_NAMES = ["inline", "worker", "watcher", "sensor"] as const satisfies readonly PresetName[];
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
  /** Commit with inboxOut to `inbox:<parentId>` (envelope from `inbox:<selfId>`, expectedEpoch = parent's epoch). Throws for root cells. */
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
}

/** [ext] See RunPorts.workspaceAccess. */
export interface WorkspaceAccess {
  /** Absolute host path of the working directory (the worktree, or the owner's directory for none/shared_ro). */
  root: string;
  isolation: IsolationLevel;
  /**
   * Workspace tool kinds the kernel's own workspace port would allow this Run right now: `bounds.tools`, minus the
   * mutating kinds (write, edit, bash, code_rpc) on isolation "none" without the kernel's allowHostWrites, and minus
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
