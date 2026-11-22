import type { createHumanItems } from "./human-items";
import type { ChannelHubImpl, ChannelHubOptions } from "@ng/channel";
import type { ContextStoreOptions } from "@ng/context";
import type { GateOptions, GateService, SecretStore } from "@ng/gate";
import type { InboxService } from "@ng/inbox";
import type { AgentBackendSetting, AgentLoopOptions, CliAgentLoopOptions } from "@ng/loop";
import type {
  AgentEngine,
  AgentLoop,
  BoundsInit,
  Bus,
  CliEngine,
  CellRecord,
  CellSpec,
  CellStatus,
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
  ModelClient,
  PresetName,
  CellMessageDraft,
  CellInspection,
  InspectCellOptions,
  ProcessorSpec,
  Progress,
  Registry,
  RunOutcome,
  SendToCellResult,
  WorkspaceOccupancy,
} from "@ng/protocol";
import type { ModelSettings, ModelSettingsOptions } from "./models";
import type { WaitRecord } from "./waits";
import type { WorkspaceManager, WorkspaceManagerOptions } from "@ng/workspace";

/** A spec as callers write it: `processor` may come from the preset's defaults. */
export type CellSpecInput = Omit<CellSpec, "processor"> & { processor?: ProcessorSpec };

// ==================== construction ====================

export interface KernelOptions {
  /**
   * Everything of the kernel's own on disk lives here: the database (`ng.db`), skills (`skills/`), job logs and
   * explicit isolated workspaces (`workspace/`), the per-cell directories of cells nobody gave a `cwd` (`cells/`) and
   * the records of running CLI agents (`cli-procs/`). The directories cells work in are the owner's and are never
   * created or removed here. Default: a fresh directory under the OS temp dir that `close()` removes — fine for
   * tests; pass a real directory to persist.
   */
  dataDir?: string;
  /** An open database, or a path (":memory:" works). Default `<dataDir>/ng.db`. */
  db?: Db | string;
  /**
   * The model behind `llm` processors that run on the API engine. Required unless `loop` is given or `agentBackend`
   * resolves to a CLI (then only cells with `processor.engine: "api"` need it).
   */
  model?: ModelClient;
  /** A ready-made AgentLoop used instead of building one around `model` (no engine routing then). */
  loop?: AgentLoop;
  /**
   * Who executes `llm` Runs whose processor names no `engine`: `api` (the built-in tool loop over `model`), a CLI agent
   * (`claude`, `codex`, `agy`), or `auto` = the first installed of claude, codex, agy, else `api` when `model` is given.
   * Default: `api` when `model` is given, else `auto`. Every cell may override it with `processor.engine`; code
   * processors always run in-process. See resolveAgentBackendFromEnv for the `NG_AGENT_BACKEND` variable.
   */
  agentBackend?: AgentBackendSetting;
  /** Per-CLI loop settings (binary, tier models, env pass-through, timeouts, ...). */
  cli?: Partial<Record<CliEngine, Omit<CliAgentLoopOptions, "engine" | "registry" | "clock">>>;
  /**
   * The owner's model switch for CLI engines: each Run asks it which model and effort to launch with, the catalogue
   * comes from the CLI itself, and the default ("auto") is the CLI's own first choice. Off unless given — a bare
   * kernel launches CLIs with `cli[engine].models` or their own default. `true` = defaults.
   */
  modelSwitch?: boolean | Pick<ModelSettingsOptions, "ttlMs" | "firstFetchWaitMs" | "fetch">;
  clock?: Clock;
  bus?: Bus;
  /**
   * Presets, prompts, toolsets and code processors (referenced by name from persisted specs). The standard toolsets
   * are registered into it unless already present. Default: a new registry, available as `kernel.registry`.
   */
  registry?: Registry;
  /** The human owner's principal. Default "owner". */
  ownerPrincipal?: string;
  /** Owner-facing channel patterns, handed identically to the Gate and the comms toolset. Default `channel:ui:*`, `channel:cli:*`. */
  ownerAddresses?: readonly string[];
  /** Cell that receives unrouted ingress and handbacks. Default "desk". */
  deskCellId?: string;
  /** @deprecated host work is the default. Ignored. */
  allowHostWrites?: boolean;
  /** Bounds a root cell gets for every field its own `bounds` leaves out. Default DEFAULT_ROOT_BOUNDS. */
  rootBounds?: BoundsInit;
  /** Channels registered on the hub at construction (more can be added with `kernel.hub.register`). */
  channels?: readonly Channel[];
  /** Secret values for the Gate's proxy. Default: `NG_SECRET_<REF>` environment variables. */
  secrets?: SecretStore;
  /**
   * Default working directory of cells that have no `cwd` anywhere up their tree (e.g. the owner's main repository).
   * Absent: each such cell gets the kernel's own per-cell directory under `<dataDir>/cells/`.
   */
  repoPath?: string;
  workspace?: Omit<WorkspaceManagerOptions, "db" | "bus" | "clock" | "dataDir" | "inbox" | "resources" | "injectSecret" | "defaultRepoPath">;
  context?: Pick<ContextStoreOptions, "summarize" | "limits" | "rescanSkillsOnCreate">;
  loopOptions?: Omit<AgentLoopOptions, "model" | "registry" | "clock">;
  gate?: Pick<GateOptions, "tokenTtlMs" | "warnRatio" | "trustStreak" | "cacheReadWeight" | "wrapUp">;
  hubOptions?: Pick<ChannelHubOptions, "sendTimeoutMs" | "requireToken">;
  /**
   * The owner's switch for budget limits. `false`: no cell is ever stopped, held or refused for its token or cost
   * budget (usage is still counted and shown). Given, it applies to this process and is remembered; absent, the
   * choice last made (also through `setBudgetLimits`) applies; default on. See Kernel.setBudgetLimits.
   */
  budgetLimits?: boolean;
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
 * Who is asking. Default: the owner. Cells act as `cell:<id>` and may only touch their own descendants (and, for
 * watches/schedules/title/meta, themselves). An external main agent acts as `agent:<id>`: it may orchestrate any cell
 * but never widens bounds, raises budgets or approves outward sends (docs/05 §5.3).
 */
export interface ActorOptions {
  principalId?: string;
}

export interface RootCellOptions extends ActorOptions {
  /** Merged over the kernel's `rootBounds`; the result must have positive maxTokens and maxCents. */
  bounds?: BoundsInit;
}

export interface SpawnOptions extends ActorOptions {}

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

// ==================== approvals (docs/04 §2, IMPL_BRIEF §2.7) ====================

/**
 * The owner's decision on a Clarify card.
 * - approve: Gate.approve with the version the owner saw; a `channel.send` is executed right away by the kernel.
 * - deny: refuse it; the owning cell gets `approval.resolved` (denied, note = reason).
 * - snooze: hide the card until `until`; it resurfaces by itself (an epoch-guarded wake-up at `until`).
 * - revise: "🎙 按住口述修改意见" — the owning cell gets `approval.revise` and redrafts a new version.
 * - continue: card C "⏱ 追加额度继续 / 再等 1 天". Budget escalations raise the budget (`raise`, default +50% of the
 *   limiting cell's limit) of the cell that hit the limit; kernel retry-limit escalations requeue the failed messages;
 *   other escalation (custom) cards are acknowledged; any other card (e.g. a watcher's nudge) is withdrawn instead of
 *   executed. The owning cell gets `approval.resolved` with `decision: "continue"` (and `until`, `note`) to go on.
 * - resolve_offline: "✓ 线下已解决，直接完结" — withdraw the card and close the affected cell (completed). A root cell
 *   is never closed this way; it just gets `approval.resolved` (cancelled, decision resolve_offline).
 * - dismiss: withdraw the card; the owning cell learns it silently (no wake-up).
 */
export type ApprovalDecision =
  | { decision: "approve"; approverId: string; seenArtifactVersion?: number; seenItemRevision?: number }
  | { decision: "deny"; approverId: string; reason?: string; seenItemRevision?: number }
  | { decision: "snooze"; until: number; approverId: string; seenItemRevision?: number }
  | { decision: "revise"; instruction: string; voice?: boolean; approverId: string; seenArtifactVersion?: number; seenItemRevision?: number }
  | { decision: "continue"; approverId: string; seenArtifactVersion?: number; budgetLedgerId?:string; raise?: { tokens?: number; cents?: number }; until?: number; note?: string; seenItemRevision?: number }
  | { decision: "resolve_offline"; approverId: string; note?: string; seenItemRevision?: number }
  | { decision: "dismiss"; approverId: string; reason?: string; seenItemRevision?: number };

/**
 * What the UI shows verbatim.
 * - sent | failed | unknown: an approved `channel.send` was executed; `unknown` keeps the card's outcome visible and
 *   is never retried automatically ("发送结果未知，请核实"). Approving again after `failed` retries the send.
 * - approved: a non-send action was approved and handed back to the owning cell.
 * - version_mismatch: the draft changed since the owner looked ("草稿已更新，请重看"); `currentVersion` is what to show.
 * - revision_mismatch: the card changed since the caller looked (card-level optimistic lock); `currentRevision` is what to show.
 * - already_cancelled: the task was cancelled/closed, or the card was withdrawn.
 * - not_pending: the card was already decided (deny/snooze/revise/continue/resolve_offline/dismiss on a decided card).
 */
export type ResolveApprovalResult =
  | { status: "sent" | "failed" | "unknown"; actionId: string; artifactVersion: number | null; error?: string }
  | { status: "approved"; actionId: string }
  | { status: "version_mismatch"; actionId: string; currentVersion: number | null }
  | { status: "revision_mismatch"; actionId: string; currentRevision: number }
  | { status: "already_cancelled" | "not_found" | "not_pending"; actionId: string; reason?: string }
  | { status: "denied" | "snoozed" | "revising" | "continued" | "dismissed"; actionId: string }
  | { status: "resolved_offline"; actionId: string; closedCellIds: string[] };

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
  /** Cards visible in Clarify now (snoozed ones excluded). */
  pendingApprovals: number;
  snoozedApprovals: number;
  /** Owner notifications held back by focus mode (DND). */
  bufferedNotifications: number;
  focus: boolean;
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
  readonly hub: ChannelHubImpl;
  readonly loop: AgentLoop;
  /** Engine of llm cells without `processor.engine` (null: none available — such Runs fail with a clear error). */
  readonly agentBackend: AgentEngine | null;
  /**
   * The model switch of a CLI engine (default: the backend engine); null when the switch is off (`modelSwitch`) or
   * the engine is not a CLI.
   */
  modelSettings(engine?: CliEngine): ModelSettings | null;
  readonly dataDir: string;
  readonly deskCellId: string;
  readonly ownerPrincipal: string;
  readonly ownerAddresses: readonly string[];

  /** Recover (stale claims, interrupted sends, jobs, half-executed approvals), then dispatch. Idempotent. */
  start(): Promise<void>;
  /** Graceful: abort Runs and release their claims without counting an attempt; Jobs keep running for recover(). */
  stop(): Promise<void>;
  /** Stop, close owned storage and release the data directory for the next kernel, removing it if temporary. */
  close(): Promise<void>;
  /** Resolves once no Run is in flight, nothing is due now and no kernel cleanup is pending. */
  idle(opts?: IdleOptions): Promise<void>;

  // ---------- cell lifecycle (the DB part commits before these return) ----------
  createRootCell(spec: CellSpecInput, opts?: RootCellOptions): CellRecord;
  /** createRootCell unless a cell with `spec.id` exists (then it is returned unchanged). */
  ensureRootCell(spec: CellSpecInput & { id: string }, opts?: RootCellOptions): CellRecord;
  spawnCell(parentId: string, spec: CellSpecInput, initialPayload?: unknown, opts?: SpawnOptions): InboxAddr;
  updateCell(cellId: string, patch: Partial<CellSpec>, opts?: ActorOptions): CellRecord;
  /**
   * Cascade over the subtree in one transaction (epochs, status, pending messages, schedules, watches, waits,
   * approvals, tokens, GTD records); the returned promise settles after Runs are aborted and the runtime is stopped
   * (Jobs cancelled and confirmed gone, an explicit container removed). Nothing on disk is touched.
   */
  closeCell(cellId: string, reason?: CloseReason, opts?: ActorOptions): Promise<CloseResult>;
  /** Inbox.control as the owner (or `opts.principalId`); the kernel aborts Runs / cancels Jobs / closes on cancel. */
  control(cellId: string, cmd: { action: ControlAction; steerMessage?: string;pauseReason?:"manual"|"parked" }, opts?: ActorOptions): ControlResult;

  // ---------- ingress and approvals ----------
  /** The hub's ingress sink: route by watches (thread / filter), else to the desk; durably enqueued before it resolves. */
  ingest(raw: Omit<Envelope, "to">, channelId: string): Promise<IngestResult>;
  reopenProject(cellId: string, principalId: string): Promise<string[]>;
  resolveApproval(actionId: string, decision: ApprovalDecision): Promise<ResolveApprovalResult>;
  /** Engage focus (DND) on/off. Leaving focus delivers what was held back and returns the receipts' counts. */
  setFocus(on: boolean): Promise<{ sent: number; failed: number; unknown: number } | null>;
  /** The owner checked an `unknown` send on the external side: record it on the outbox row and the approval. */
  resolveUnknownSend(actionId: string, verdict: "sent" | "failed", opts: { approverId: string; seenItemRevision: number; seenAttempt: number; note?: string }): "resolved" | "not_unknown" | "revision_mismatch" | "not_found";

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
  directMessage(cellId: string, message: DirectMessage, opts?: ActorOptions): DirectMessageResult;
  /** RunPorts.inspectCell for the control plane: nobody's cursor moves. */
  inspectCell(cellId: string, opts?: InspectCellOptions): CellInspection;
  /** The five anchors of a (project) cell's subtree; `stalled` = none of them holds. */
  anchorsOf(cellId: string): AnchorReport;
  /** Open waits of these cells (all cells when omitted). */
  listWaits(cellIds?: readonly string[]): WaitRecord[];
  /**
   * Cell-to-cell message as `principalId` (default: the owner) — the control plane's twin of RunPorts.sendToCell:
   * `closed` / `not_found` are answers, not errors. From the owner or an agent to a leaf below a coordinator, the
   * coordinator gets the same carbon copy as with directMessage (which is what a chat surface should call).
   */
  sendToCell(cellId: string, message: CellMessageDraft, opts?: ActorOptions): SendToCellResult;
  /** Re-evaluate the stall check now (tests, and the app after it changed GTD records itself). */
  checkStalls(): void;

  // ---------- budget limits ----------
  /** Whether budget limits are enforced right now. */
  budgetLimits(): { enforced: boolean };
  /**
   * Switch budget limits on or off — the owner only (an agent or a cell is refused with `bounds_violation`): off
   * removes every stop a budget would cause, which is a wider grant than raising any single budget. Switching off
   * starts the cells that were held at their budget stop and answers the budget cards that were waiting with
   * "continue" (nothing is left to decide on them; the cells they were about go on); switching on applies the limits again from the next decision (a ledger
   * that is over its limit stops its cells at their next step or wake-up). Remembered across restarts.
   */
  setBudgetLimits(enforced: boolean, opts?: ActorOptions): { enforced: boolean; changed: boolean; releasedCells: string[]; continuedCards: string[] };
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
  state: "working" | "waiting" | "dormant" | "idle" | "paused" | "budget_paused" | "closed";
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
}

export type DirectMessageResult =
  | {
      status: "delivered";
      envelopeId: string;
      /** The retried send of a message that was already delivered: nothing was sent again. */
      duplicate: boolean;
      /** The cell had been closed and was brought back for this message. */
      reopened: boolean;
      targetStatus: "active" | "paused";
      /** The parent that got the carbon copy, when there is one. */
      ccTo: string | null;
    }
  | { status: "not_found" }
  /** `code`: a deterministic script cell takes no conversation; `archived`: closed with a closed or finished parent. */
  | { status: "refused"; reason: "code" | "archived" | "not_allowed"; detail: string };

/** RunOutcome plus "error" (the Run threw), as reported on `run.finished`. */
export type RunResult = RunOutcome | "error";
