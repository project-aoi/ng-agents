import type { createHumanItems } from "./human-items";
import type { ChannelHub } from "@ng/protocol";
import type { ContextStoreOptions } from "@ng/context";
import type { GateService } from "@ng/gate";
import type { InboxService } from "@ng/inbox";
import type { AgentBackendSetting, CliAgentLoopOptions } from "@ng/loop";
import type {
  AgentEngine,
  AgentLoop,
  BoundsInit,
  Bus,
  CliEngine,
  CellRecord,
  CellRole,
  CellSpec,
  CellStatus,
  CellUpdatePatch,
  Channel,
  ChildSummary,
  Clock,
  CloseReason,
  ContextStore,
  ControlAction,
  ControlResult,
  Db,
  Envelope,
  InboxAddr,
  PresetName,
  CellMessageDraft,
  CellInspection,
  InspectCellOptions,
  ProcessorSpec,
  Progress,
  Registry,
  RunOutcome,
  RunnerOverride,
  RunnerSelection,
  RunnerSelectionTarget,
  SendToCellResult,
  WorkspaceOccupancy,
} from "@ng/protocol";
import type { EffectiveRunnerChoice, ModelSettings, ModelSettingsOptions, RoleModelSelection } from "./models";
import type { WaitRecord } from "./waits";
import type { WorkspaceManager, WorkspaceManagerOptions } from "@ng/workspace";

/** A spec as callers write it: `processor` may come from the preset's defaults. */
export type CellSpecInput = Omit<CellSpec, "processor"> & { processor?: ProcessorSpec };

// ==================== construction ====================

export interface KernelOptions {
  /**
   * Everything of the kernel's own on disk lives here: the database (`ng.db`), skills (`skills/`), job logs
   * (`workspace/jobs/`), the per-cell directories of cells nobody gave a `cwd` (`cells/`) and
   * the records of running CLI agents (`cli-procs/`). The directories cells work in are the owner's and are never
   * created or removed here. Default: a fresh directory under the OS temp dir that `close()` removes — fine for
   * tests; pass a real directory to persist.
   */
  dataDir?: string;
  /** An open database, or a path (":memory:" works). Default `<dataDir>/ng.db`. */
  db?: Db | string;
  /** Executes local processors and cells without a selected CLI. */
  loop?: AgentLoop;
  /** The installed CLI to use when the processor does not select its own engine. */
  agentBackend?: AgentBackendSetting;
  /** Limits which runners can be selected or launched. The host checks their binaries before boot. */
  cliRunners?: readonly CliEngine[];
  /** Per-CLI loop settings (binary, tier models, env pass-through, timeouts, ...). */
  cli?: Partial<Record<CliEngine, Omit<CliAgentLoopOptions, "engine" | "registry" | "clock" | "processRegistry">>>;
  /**
   * The owner's model switch for CLI engines: each Run asks it which model and effort to launch with, the catalogue
   * comes from the CLI itself, and the default ("auto") is the CLI's own first choice. Off unless given — a bare
   * kernel launches CLIs with `cli[engine].models` or their own default. `true` = defaults.
   */
  modelSwitch?: boolean | Pick<ModelSettingsOptions, "ttlMs" | "firstFetchWaitMs" | "errorRetryMs" | "fetch">;
  clock?: Clock;
  bus?: Bus;
  /**
   * Presets, prompts, toolsets and code processors (referenced by name from persisted specs). The standard toolsets
   * are registered into it unless already present. Default: a new registry, available as `kernel.registry`.
   */
  registry?: Registry;
  /** The human owner's principal. Default "owner". */
  ownerPrincipal?: string;
  /** Cell that receives unrouted ingress and handbacks. Default "desk". */
  deskCellId?: string;
  /** Bounds a root cell gets for every field its own `bounds` leaves out. Default DEFAULT_ROOT_BOUNDS. */
  rootBounds?: BoundsInit;
  /** Channels registered on the hub at construction (more can be added with `kernel.hub.register`). */
  channels?: readonly Channel[];
  /**
   * Default working directory of cells that have no `cwd` anywhere up their tree (e.g. the owner's main repository).
   * Absent: each such cell gets the kernel's own per-cell directory under `<dataDir>/cells/`.
   */
  repoPath?: string;
  workspace?: Omit<WorkspaceManagerOptions, "db" | "bus" | "clock" | "dataDir" | "inbox" | "resources" | "defaultRepoPath">;
  context?: Pick<ContextStoreOptions, "summarize" | "limits" | "rescanSkillsOnCreate">;
  /** Runs in flight across all cells. Default 8. */
  maxConcurrentRuns?: number;
  /** Claim lease; renewed while the Run is alive. Default 10 minutes. */
  leaseMs?: number;
  /** A batch whose Runs fail this many times becomes a dead letter (escalated to the owner). Default 5. */
  maxAttempts?: number;
  /** Retry delay after a failed Run: `retryBackoffMs · 2^attempts`, capped at `maxRetryBackoffMs`. Defaults 5 s / 5 min. */
  retryBackoffMs?: number;
  maxRetryBackoffMs?: number;
  /** docs/05 guard 1: consecutive step-limit continuations of one cell before the owner gets a card. Default 3. */
  maxStepContinuations?: number;
  /** docs/05 guard 2: grace before a project without any anchor gets its single `kernel.stalled_check`. Default 2 s. */
  stallGraceMs?: number;
  /** Background errors (bus handlers, cleanup, timers). Default: console.error. */
  onError?: (err: unknown, where: string) => void;
}

/**
 * Who is asking. All entry points require an explicit principal. Cells act as `cell:<id>` and may only touch their own descendants (and, for
 * watches/schedules/title/meta, themselves). An external main agent acts as `agent:<id>`: it operates the workbench as
 * the owner does (docs/05 §5.3, proposal 07), and narrows a cell's bounds like an ancestor would.
 */
export interface ActorOptions {
  principalId: string;
}

export interface RootCellOptions extends ActorOptions {
  /** Overrides for the kernel's default root bounds. */
  bounds?: BoundsInit;
}

export interface SpawnOptions extends ActorOptions {}

export interface CloseActorOptions extends ActorOptions {
  /** Keep the parent informed without waking it for a routine closure. */
  parentDelivery?: "wakeup" | "silent_inject";
}

export interface CloseResult {
  /** Cells closed by this call (target first, then descendants), empty when the target was already closed. */
  closed: string[];
}

export interface IngestResult {
  envelopeId: string;
  /** "watch": delivered to the cells watching its thread/filter (the desk is bypassed); "desk": nobody watched it. */
  routedBy: "watch" | "desk";
  cellIds: string[];
  /** docs/05 §3.3: cells that got it through a coalescing watch (it waits for the window's edge unless they are running). */
  coalesced?: string[];
}

export interface IdleOptions {
  /** Also wait until no Job is running (jobs finish in real time). Default false. */
  jobs?: boolean;
  /** Real milliseconds before idle() rejects with a diagnostic. Default 15 000. */
  timeoutMs?: number;
}

// ==================== read models ====================

/** One in-flight child, richer than Context's ChildSummary (which is derived from it for the snapshot tail). */
export interface RosterEntry extends ChildSummary {
  /** A Run of this child is executing right now. */
  running: boolean;
  /** From the child's `cell:status` state (report_to_parent progress). */
  progress: Progress | null;
  jobs: Array<{ jobId: string; command: string; startedAt: number }>;
  waitingOn: {
    /** External threads it watches (订阅直通). */
    threads: string[];
    /** Earliest future timer (deliverAt row or schedule firing), if any. */
    nextTimerAt: number | null;
    /** Cards of this child waiting for the owner. */
    pendingApprovals: number;
  };
}

export interface CellNode {
  cellId: string;
  title: string | null;
  preset: PresetName | null;
  status: CellStatus;
  epoch: number;
  depth: number;
  running: boolean;
  runningJobs: number;
  pendingApprovals: number;
  /** Threads it watches (any active watch, incl. filter-only ones, makes `watching` true). */
  threads: string[];
  watching: boolean;
  nextTimerAt: number | null;
  statusLine: string | null;
  lastRunAt: number | null;
  children: CellNode[];
}

/** Top bar ("2 项后台分身运行中") and the expandable status line. */
export interface KernelStats {
  /** Non-closed cells below a root: the background clones the owner has in flight. */
  backgroundCells: number;
  pausedCells: number;
  /** Runs executing right now. */
  runningRuns: number;
  /** Cells with a Run or a Job in flight right now. */
  busyCells: number;
  runningJobs: number;
  /** Non-closed cells holding a watch or a future timer, with nothing in flight (🟡 waiting). */
  waitingCells: number;
  /** Decision cards visible now (snoozed ones excluded). */
  pendingApprovals: number;
  snoozedApprovals: number;
}

export interface RunInfo {
  runId: string;
  cellId: string;
  epoch: number;
  startedAt: number;
}

// ==================== the kernel ====================

export interface Kernel {
  readonly db: Db;
  readonly bus: Bus;
  readonly clock: Clock;
  readonly registry: Registry;
  readonly inbox: InboxService;
  readonly context: ContextStore;
  readonly gate: GateService;
  readonly humanItems: ReturnType<typeof createHumanItems>;
  readonly workspace: WorkspaceManager;
  readonly hub: ChannelHub;
  readonly loop: AgentLoop;
  /** Engine of llm cells without `processor.engine` (null: none available — such Runs fail with a clear error). */
  readonly agentBackend: AgentEngine | null;
  readonly cliRunners: readonly CliEngine[];
  setDefaultRunner(runner: string): void;
  roleModelSettings(): Record<CellRole, RoleModelSelection>;
  setRoleModel(role: CellRole, selection: RoleModelSelection): void;
  effectiveRunnerForRole(role: CellRole): EffectiveRunnerChoice | null;
  effectiveRunnerFor(spec: Pick<CellSpec, "preset" | "meta" | "processor">): EffectiveRunnerChoice | null;
  describeRunnerOptions(): Promise<string>;
  resolveRunnerSelection(selection: RunnerSelection, target?: RunnerSelectionTarget): Promise<RunnerOverride>;
  /**
   * The model switch of a CLI engine (default: the backend engine); null when the switch is off (`modelSwitch`) or
   * the engine is not a CLI.
   */
  modelSettings(engine?: CliEngine): ModelSettings | null;
  readonly dataDir: string;
  readonly deskCellId: string;
  readonly ownerPrincipal: string;

  /** Recover stale claims and jobs, then start dispatching. */
  start(): Promise<void>;
  /** Graceful: abort Runs and release their claims without counting an attempt; Jobs keep running for recover(). */
  stop(): Promise<void>;
  /** Stop, close owned storage and release the data directory for the next kernel, removing it if temporary. */
  close(): Promise<void>;
  /** Resolves once no Run is in flight, nothing is due now and no kernel cleanup is pending. */
  idle(opts?: IdleOptions): Promise<void>;

  // ---------- cell lifecycle (the DB part commits before these return) ----------
  createRootCell(spec: CellSpecInput, opts: RootCellOptions): CellRecord;
  /** createRootCell unless a cell with `spec.id` exists (then it is returned unchanged). */
  ensureRootCell(spec: CellSpecInput & { id: string }, opts: RootCellOptions): CellRecord;
  spawnCell(parentId: string, spec: CellSpecInput, initialPayload: unknown, opts: SpawnOptions): InboxAddr;
  updateCell(cellId: string, patch: CellUpdatePatch, opts: ActorOptions): CellRecord;
  /**
   * Cascade over the subtree in one transaction (epochs, status, pending messages, schedules, watches, waits,
   * pending decisions and project records); the returned promise settles after Runs are aborted and the runtime is stopped
   * (jobs cancelled and their processes confirmed gone). Nothing on disk is touched.
   */
  closeCell(cellId: string, reason: CloseReason | undefined, opts: CloseActorOptions): Promise<CloseResult>;
  /** Inbox.control as `opts.principalId`; the kernel aborts Runs / cancels Jobs / closes on cancel. */
  /** `note`: for pause/resume, the words that came with it (why the owner parked it) — kept on the cell's record. */
  control(cellId: string, cmd: { action: ControlAction; steerMessage?: string; pauseReason?: "manual" | "parked"; note?: string }, opts: ActorOptions): ControlResult;

  // ---------- ingress and approvals ----------
  /** The hub's ingress sink: route by watches (thread / filter), else to the desk; durably enqueued before it resolves. */
  ingest(raw: Omit<Envelope, "to">, channelId: string): Promise<IngestResult>;
  /** `words`: what the owner said with it (the project wakes with them), and their coding agent's own note, if any. */
  reopenProject(cellId: string, principalId: string, words?: { text?: string; agentContext?: string }): Promise<string[]>;

  // ---------- read models ----------
  getCell(cellId: string): CellRecord | undefined;
  listCells(filter?: { status?: readonly CellStatus[]; parentId?: string | null; rootId?: string; preset?: PresetName }): CellRecord[];
  rosterFor(cellId: string): RosterEntry[];
  tree(opts?: { rootId?: string; includeClosed?: boolean }): CellNode[];
  stats(): KernelStats;
  activeRuns(): RunInfo[];

  // ---------- docs/05 ----------
  /** Which cells are active in which work tree right now, kernel-wide. */
  activeWorkspaces(): WorkspaceOccupancy[];
  /** What each cell is doing right now (working, waiting, dormant, …). */
  activityOf(cellIds: readonly string[]): Map<string, CellActivity>;
  /**
   * A person speaks to one cell directly (the workbench's chat box, an agent passing the owner's words on). One
   * transaction: a closed leaf whose parent is still open is brought back; the message is delivered (queued, or as a
   * steer); and when the target is a leaf below a coordinator, that coordinator gets a `cell.direct_chat` copy in the
   * owner's words — background by default — so it is never behind on what its worker was told. Script cells and cells
   * archived with a finished project are refused.
   */
  directMessage(cellId: string, message: DirectMessage, opts: ActorOptions): DirectMessageResult;
  /** RunPorts.inspectCell for the control plane: nobody's cursor moves. */
  inspectCell(cellId: string, opts?: InspectCellOptions): CellInspection;
  /** The five anchors of a (project) cell's subtree; `stalled` = none of them holds. */
  anchorsOf(cellId: string): AnchorReport;
  /** Open waits of these cells (all cells when omitted). */
  listWaits(cellIds?: readonly string[]): WaitRecord[];
  /** `listWaits` without the waits whose answer is already queued for (or being handled by) the waiting cell: what an onlooker should be shown as "waiting". */
  listOpenWaits(cellIds?: readonly string[]): WaitRecord[];
  /**
   * Cell-to-cell message as the explicit `principalId` — the control plane's twin of RunPorts.sendToCell:
   * `closed` / `not_found` are answers, not errors. From the owner or an agent to a leaf below a coordinator, the
   * coordinator gets the same carbon copy as with directMessage (which is what a chat surface should call).
   */
  sendToCell(cellId: string, message: CellMessageDraft, opts: ActorOptions): SendToCellResult;
  /** Re-evaluate the stall check now (tests, and the app after it changed GTD records itself). */
  checkStalls(): void;

}

/** docs/05 guard 2. A stalled_check wake-up and a Run that only it triggered never count as anchors. */
export interface AnchorReport {
  cellId: string;
  /** @Agent: a Run in flight, due work, or a running Job somewhere in the subtree. */
  agent: boolean;
  /** @Waiting(external): an active watch, a future timer/cron, or a message waiting in a batching window. */
  external: boolean;
  /** @Waiting(internal): an open wait on another cell that is not closed. */
  internal: boolean;
  /** @Human: a pending/snoozed card, or an open action whose ball is the owner's. */
  human: boolean;
  /** Paused, or the project's lifecycle is not "active". */
  parked: boolean;
  stalled: boolean;
  /** Human-readable account of what holds (or that nothing does), for the stalled_check message and Radar. */
  detail: string;
}

/** What a cell is doing right now (ReadModel.activityOf). `idle` is a coordinator with nothing in flight; `dormant` a leaf. */
export interface CellActivity {
  state: "working" | "waiting" | "dormant" | "idle" | "paused" | "closed";
  /** What that rests on, for `working` and `waiting`. */
  cause?: "run" | "job" | "message" | "card" | "wait" | "watch" | "timer" | "child";
  /** One plain clause saying why (for refusals and status lines). */
  why: string;
}

/** A message from a person (the owner, or their agent on the control plane) straight to one cell. */
export interface DirectMessage {
  text: string;
  /** Idempotency id of this message: a retried send with the same id is not delivered twice. */
  clientId?: string;
  /** `enqueue` (default): it takes the message when its current step ends, or is woken by it. `steer`: interrupt it now. */
  mode?: "enqueue" | "steer";
  /** How the parent of a leaf learns of it: `silent` (default) = at its next wake-up; `wakeup` = it is woken now. */
  notifyParent?: "silent" | "wakeup";
  /**
   * The message this one answers (a question the cell asked) — its id and, so the cell can tell which question that
   * was without looking anything up, the text it asked — and the conversation this message belongs to.
   */
  replyToId?: string;
  replyToText?: string;
  conversationId?: string;
  /**
   * What the owner's coding agent adds on its own when it passes the owner's words on. It travels beside `text` and
   * is shown to the cell as the agent's note — never as something the owner said.
   */
  agentContext?: string;
}

export type DirectMessageResult =
  | {
      status: "delivered";
      envelopeId: string;
      /** The retried send of a message that was already delivered: nothing was sent again. */
      duplicate: boolean;
      /** The cell had been closed and was brought back for this message. */
      reopened: boolean;
      targetStatus: CellStatus;
      /** The parent that got the carbon copy, when there is one. */
      ccTo: string | null;
    }
  | { status: "not_found" }
  /** `code`: a deterministic script cell takes no conversation; `archived`: closed with a closed or finished parent. */
  | { status: "refused"; reason: "code" | "archived" | "paused_parent" | "not_allowed"; detail: string };

/** RunOutcome plus "error" (the Run threw), as reported on `run.finished`. */
export type RunResult = RunOutcome | "error";
