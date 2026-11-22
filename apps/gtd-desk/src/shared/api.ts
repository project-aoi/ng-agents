// The contract between the GTD desk server and its web client: every request body, response body and SSE event.
// Self-contained on purpose (no imports): the web bundle can import it without pulling in server code, and nothing
// here uses kernel vocabulary — the client draws every view from these shapes alone (docs/03 铁律 1).
//
// Conventions:
// - Times are epoch milliseconds from the server clock. Every view carries `generatedAt` (the server's "now"), so
//   relative labels ("12 分钟前") are computed against it with `relativeTimeZh`, not against the browser clock.
// - Every mutation answers with the refreshed view the caller needs (`view`) plus the top bar (`status`), so a click
//   never needs a second request to re-render.
// - User-facing strings (labels, messages, status text) are Chinese and ready to display.
// - Errors: non-2xx with `ApiError`. 401 = missing/wrong bearer token, 403 = cross-site or foreign Host,
//   415 = a write without a JSON body, 404 = unknown id, 409 = the item is no longer in a state that allows this,
//   400 = malformed input. Exceptions that carry a full result body instead: approve and the Agents view's cell
//   messages / control / trigger (always 200, the outcome — not_found included — is in the body), and the two
//   version-protected saves (409 with ArtifactSaveResponse / PlanSaveResponse).

import type { HumanItem, ProjectProposal, ClarifyCard } from "@ng/protocol";

export interface HumanItemDTO extends HumanItem {
  resumeTarget: {id:string; title:string} | null;
  proposal: ProjectProposal | null;
  projects: Array<{id:string; title:string}>;
  closeTargets: Record<string, Array<{id:string; title:string}>>;
  project: {id:string; title:string; paused:boolean; parked:boolean} | null;
  artifact: ArtifactDTO | null;
  ownerOnly: boolean;
}

// ==================== shared vocabulary ====================

/** 🔵 我来处理 · 🟢 Agent 处理中 · 🟡 等待外部 (the action's title says what is awaited) */
export type BallOwner = "human" | "agent" | "waiting";
export type Effort = "15m" | "45m" | "low_energy";
export type ViewName = "inbox" | "radar" | "agents" | "review" | "status" | "sources" | "activity";
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export const BALL_LABEL: Readonly<Record<BallOwner, string>> = {
  human: "🔵 我来处理",
  agent: "🟢 Agent 处理中",
  waiting: "🟡 等待外部",
};

export const EFFORT_LABELS: Readonly<Record<Effort, string>> = {
  "15m": "15m 碎片时间",
  "45m": "45m 整块时间",
  low_energy: "低精力杂事",
};

export interface ApiError {
  error: { code: string; message: string };
}

/**
 * A button the client renders as-is. `endpoint` absent = client-only (e.g. "下一张 →" or opening an editor).
 * `body` is the request body to send (pre-filled, e.g. the draft version the card shows); `input` names the one field
 * the client must collect from the user and add to `body` before sending.
 */
export interface ButtonDTO {
  id: string;
  label: string;
  primary: boolean;
  /** "main" = the card's fixed button row; "more" = secondary actions behind a menu. */
  group: "main" | "more";
  endpoint?: { method: HttpMethod; path: string; body?: Record<string, unknown> };
  input?: { field: string; kind: "instruction" | "text" | "datetime"; placeholder: string };
  /** Client-only behaviour when there is no endpoint. */
  /** One line shown under/next to the button, e.g. "到 今天 14:00 回到待确认". */
  hint?: string;
  /** Ask for confirmation first (destructive actions). */
  confirm?: string;
  /** Client-only navigation (no endpoint): a hash route to open, e.g. "#/agents/desk". */
  href?: string;
}

export interface SourceInfoDTO {
  /** "工作台", "随手记", "信源 · 指标巡检", "定时提醒", "后台分身", "系统" */
  label: string;
  at: number;
  channelId?: string;
  uri?: string;
}

export interface ReferenceDTO {
  label: string;
  uri: string;
  detail?: string;
}

/** "已回 2/3 · 剩 供应商 C 明天到期" */
export interface WaitingDTO {
  description: string;
  replied: number;
  total: number;
  join: "all" | "any";
  dueAt: number | null;
  text: string;
  parties: Array<{ label: string; replied: boolean; repliedAt: number | null; dueAt: number | null }>;
}

export interface ProgressDTO {
  done: number;
  total: number;
  label: string | null;
  /** "正在并发整理竞品资料 11/15" */
  text: string;
}

export interface ParkedDTO {
  id: string;
  /** The version the background thought it was editing. */
  basedOnVersion: number;
  format: "text" | "markdown" | "json" | "card";
  title?: string;
  body: string;
  note?: string;
  createdAt: number;
  /** Removes it from the reference column. */
  dismiss: ButtonDTO;
}

/** A passage the owner must decide on (marked `> [!DECISION] <label>` in markdown drafts), highlighted in the editor. */
export interface DecisionDTO {
  label: string;
  text: string;
  /** 0-based line range in `body`, inclusive. */
  startLine: number;
  endLine: number;
}

/** A draft document (reply draft, proposal, plan). `version` is always the current one. */
export interface ArtifactDTO {
  artifactId: string;
  version: number;
  format: "text" | "markdown" | "json" | "card";
  title?: string;
  body: string;
  /** Structured value (json drafts, e.g. a project plan). */
  data?: unknown;
  updatedBy: "agent" | "human";
  updatedByLabel: string;
  updatedAt: number;
  /** "v3 · 你在 5 分钟前修改" — computed at generatedAt. */
  versionText: string;
  versions: Array<{ version: number; updatedBy: "agent" | "human"; createdAt: number }>;
  /** Background additions that arrived while the owner was editing and were kept aside instead of overwriting. */
  parked: ParkedDTO[];
  decisions: DecisionDTO[];
  /** PUT /api/artifacts/:artifactId with `{ expectedVersion: version, ... }`. */
  save: { method: "PUT"; path: string };
}

// ==================== top bar (GET /api/status) ====================

export interface NotificationDTO {
  id: string;
  title?: string;
  text: string;
  at: number;
}

// ---------- the owner's model switch (CLI backends) ----------

export interface ModelInfoDTO {
  id: string;
  label: string;
  description?: string;
  /** Reasoning efforts the model offers, weakest first; empty = none to choose. */
  efforts: string[];
}
export interface ModelChoiceDTO {
  model: string;
  label: string;
  effort?: string;
}
/**
 * "auto" follows the CLI: the strong tier takes its own first choice (`recommended`), the fast tier the lighter choice
 * picked from its list (`recommendedFast`). Both change when the CLI's list does.
 */
export type ModelSelectionDTO = { mode: "auto" } | { mode: "fixed"; model: string; effort?: string };
export type ModelTierDTO = "strong" | "fast";

/** GET /api/models (`?refresh=1` asks the CLI again) and the answer of PUT /api/models. */
export interface ModelsDTO {
  available: boolean;
  engine: "claude" | "codex" | "agy" | null;
  /** As the CLI lists them, its first choice first. Never hard-coded. */
  models: ModelInfoDTO[];
  recommended: ModelChoiceDTO | null;
  /** What "auto" runs the fast tier on: the list's light model, or the first choice at a lower effort. Absent when there is nothing to switch. */
  recommendedFast?: ModelChoiceDTO | null;
  fetchedAt: number | null;
  /** Why asking the CLI failed last time (the previous list, if any, is still shown). */
  error: string | null;
  /** strong: the desk, projects, hubs, workers. fast: light checkers and sources. */
  selection: Record<ModelTierDTO, ModelSelectionDTO>;
  /** What the next run of each tier is launched with; null = the CLI's own default. */
  effective: Record<ModelTierDTO, ModelChoiceDTO | null>;
}
/** PUT /api/models */
export type SetModelRequest = { tier: ModelTierDTO; mode: "auto" } | { tier: ModelTierDTO; mode: "fixed"; model: string; effort?: string };

export interface StatusDTO {
  humanPending: number;
  humanSnoozed: number;
  generatedAt: number;
  backend: string;
  /** The model the main agents run on right now, e.g. "Opus 5.5 · xhigh" (CLI backends, once the CLI has listed its models). */
  model?: string;
  auth: { tokenRequired: boolean };
  background: {
    /** Background clones doing something right now (a run or a long command). */
    running: number;
    /** Long-running commands in flight. */
    jobs: number;
    /** Clones waiting on someone/something (a reply, a timer). */
    waiting: number;
    /** All background clones alive (running + waiting + idle + paused). */
    total: number;
    paused: number;
  };
  /** Since local midnight. */
  today: { archivedNotifications: number; notesSaved: number; remindersSet: number; cardsWithdrawn: number; since: number };
  radar: { activeProjects: number; stalledProjects: number; somedayProjects: number; nextReviewAt: number };
  /** Ready-made status-line text per view (docs/04 §一 右上角状态提示). */
  statusLine: {
    inbox: string;
    radar: string;
    /** "2 个分身在跑 · 3 个待命可唤醒" */
    agents?: string;
  };
  notifications: NotificationDTO[];
}

// ==================== ⚡ 随手记 (POST /api/capture) ====================

export interface CaptureRequest {
  text: string;
  /** The text is a voice transcript. */
  voice?: boolean;
  /** Client-generated id; a retried submit with the same id is accepted once. */
  clientId?: string;
  attachments?: Array<{ label: string; uri: string }>;
}

export interface CaptureResponse {
  ok: true;
  id: string;
  acceptedAt: number;
  message: string;
  status: StatusDTO;
}

export interface MutationResult<V, O extends string = string> {
  ok: boolean;
  outcome: O;
  /** Ready-to-show result line. */
  message: string;
  view: V;
  status: StatusDTO;
}

export interface PlanSaveRequest {
  expectedVersion: number;
  proposal: {
    title?: string;
    outcome: string;
    background?: string;
    actions: Array<{ title: string; owner: BallOwner; effort?: Effort; nextStep?: string }>;
  };
}

export type PlanSaveResponse =
  | { ok: true; outcome: "saved"; message: string }
  | { ok: false; outcome: "conflict"; message: string; current: ArtifactDTO };

// ==================== drafts (GET/PUT /api/artifacts/:artifactId) ====================

export interface ArtifactSaveRequest {
  /** The version the editor was based on (`artifact.version` when it was opened or last saved). */
  expectedVersion: number;
  body: string;
  title?: string;
  format?: "text" | "markdown" | "json";
  /** For json drafts: the structured value (body should be its JSON text). */
  data?: unknown;
}

/**
 * saved     → `artifact` is the new version (written by you).
 * conflict  → nothing was written; `artifact` is the current version (with its parked additions). Your text is
 *             not lost: keep it in the editor, show the banner, merge, and save again with `artifact.version`.
 */
export interface ArtifactSaveResponse {
  ok: boolean;
  outcome: "saved" | "conflict";
  message: string;
  artifact: ArtifactDTO;
}

// ==================== 🧭 Radar (GET /api/radar) ====================

export interface ProjectActionDTO {
  cellId: string;
  actionId: string;
  title: string;
  owner: BallOwner;
  ownerLabel: string;
  /** human: the next step · agent: progress · waiting: who/until when. */
  text: string;
  progress: ProgressDTO | null;
  waiting: WaitingDTO | null;
  dueAt: number | null;
}

/** A cell working for a project right now (a worker, a watcher): detail of the project's row, never a row itself. */
export interface ProjectWorkerDTO {
  cellId: string;
  title: string;
  preset: string | null;
  /** running: a Run or a background command is in flight · waiting: a watch or a timer · paused · idle: asleep. */
  state: "running" | "waiting" | "paused" | "idle";
  /** Its own one-line status (what it reported last), if any. */
  statusLine: string | null;
}

export interface ProjectRowDTO {
  id: string;
  title: string;
  outcome: string | null;
  /** The project's own one-line account of where things stand (it keeps it current). */
  summary: string | null;
  /** The directory the project's work happens in. */
  cwd: string | null;
  lifecycle: "active" | "completed" | "cancelled" | "someday";
  paused: boolean;
  /** The single ball label the row shows (🔵 > 🟢 > 🟡); null when nothing is open. */
  ball: { owner: BallOwner; label: string; text: string; cardId?: string } | null;
  /** Aggregated progress ("11/15", "已回 2/3"). */
  progress: ProgressDTO | null;
  waiting: WaitingDTO | null;
  openActions: ProjectActionDTO[];
  /** A card about this project waits in Clarify. */
  pendingCardId: string | null;
  /**
   * Nothing moves it: no work running or queued, no watch or timer, no wait on a live cell, no card and no open action
   * of the owner's — the kernel's five-anchor check (it stamps the record with `stalledSince`). Flagged red.
   */
  stalled: boolean;
  stalledText: string | null;
  /** Since when it is stalled (null when it is not). */
  stalledSince: number | null;
  running: number;
  waitingOn: number;
  /** The cells working for it now. */
  workers: ProjectWorkerDTO[];
  /** Its reports and drafts (research report, plan, review), newest first — each opens in the report drawer. */
  artifacts: ArtifactRefDTO[];
  /** Entry to the Agents view: how many cells it has (resting ones included) and how many are at work. */
  agents: { total: number; running: number; href: string; label: string };
  createdAt: number;
  updatedAt: number;
  buttons: ButtonDTO[];
}

export interface RadarDTO {
  generatedAt: number;
  projects: ProjectRowDTO[];
  someday: ProjectRowDTO[];
  counts: { active: number; stalled: number; someday: number; completedThisWeek: number };
  /** Right column. */
  review: WeeklyReviewDTO;
}

export type ProjectOutcome = "paused" | "resumed" | "cancelled" | "completed" | "someday" | "activated" | "action_added" | "not_applied";

export interface ProjectMutationResponse extends MutationResult<RadarDTO, ProjectOutcome> {
  /** action_added: the new action. */
  actionId?: string;
}

/** POST /api/projects/:projectId/actions — "补上下一步" */
export interface AddActionRequest {
  title: string;
  nextStep?: string;
  effort?: Effort;
}

// ==================== 分身实况 Agents (GET /api/agents/topology, /api/cells/:cellId/timeline, …) ====================
// The fourth view: who is there, what each one did, and a box to talk to it. Three views are about matters and
// decisions; this one is about the cells and what is happening. Everything is projected into plain words — a state is
// "待命可唤醒", never the machinery behind it — while what a cell actually touched (paths, branches, commits, file
// names, commands, test output) is passed through verbatim for monospace display.

/** A report or draft, as a button that opens the shared report drawer (GET /api/artifacts/:artifactId). */
export interface ArtifactRefDTO {
  artifactId: string;
  title: string;
  version: number;
  updatedAt: number;
}

/**
 * running: a turn or a background command is in flight (or a message is about to start one) · waiting: a timer, a
 * watch, an answer from another cell · blocked_human: a card or an action of the owner's · dormant: its turn is over,
 * nothing runs, a message wakes it with everything it knows · paused · archived: closed (with its project, or done).
 */
export type AgentVisualState = "running" | "waiting" | "blocked_human" | "dormant" | "paused" | "archived";

export interface TopologyNodeDTO {
  cellId: string;
  parentId: string | null;
  /** The project it belongs to (itself, for a project node); null for the desk, sources and hubs. */
  projectId: string | null;
  preset: string | null;
  /** "总助理" | "项目协调" | "执行分身" | "外部盯梢" | "信源巡检" | "领域中枢" */
  roleLabel: string;
  title: string;
  /** Column of the three-layer canvas: 0 = sources and the desk, 1 = projects and hubs, 2 = workers and watchers. */
  layer: 0 | 1 | 2;
  state: AgentVisualState;
  /** "运行中" | "等待外部" | "等你拍板" | "已待命 · 发消息即唤醒" | "已暂停" | "已归档" */
  stateLabel: string;
  /** What exactly it runs or waits for ("正在执行：pnpm test", "每 2 分钟查一次 MR#142", "等「总助理」回信"); null when there is nothing to add. */
  stateDetail: string | null;
  processorType: "llm" | "code";
  /** The box at the bottom of the right pane accepts text for this node (false: script probes, archived cells). */
  canChat: boolean;
  /** "claude" | "codex" | "agy" | "api"; null for a script. */
  engine: string | null;
  modelTier: "strong" | "fast" | null;
  cwd: string | null;
  /** The work tree its directory belongs to (same value on every cell sharing it); null when it has no directory. */
  gitRoot: string | null;
  /** Its own one-line status, verbatim. */
  statusLine: string | null;
  lastEvidenceSeq: number;
  /** Records its parent has not looked at yet (shown on the edge as "未汇总 +N"); 0 for non-leaf nodes. */
  unpulledCount: number;
  /** The owner has spoken to it directly at some point. */
  hadDirectUserChat: boolean;
  pendingCardId: string | null;
  humanItemId: string | null;
  /** Closed children folded into this node ("已归档 (N)"); they are listed as nodes only with includeArchived=1. */
  archivedChildren: number;
  updatedAt: number | null;
}

export interface TopologyDTO {
  generatedAt: number;
  deskCellId: string;
  counts: { running: number; waiting: number; dormant: number; archived: number };
  /** Parents before children; siblings in creation order. */
  nodes: TopologyNodeDTO[];
  /** A cell is waiting for another party (dashed amber arrow); `targetCellId` null = a person or something outside. */
  waits: Array<{ fromCellId: string; targetCellId: string | null; targetLabel: string; description: string; since: number }>;
  /** Work trees with more than zero active cells right now — the "同目录协作" highlight. */
  workspaces: Array<{ gitRoot: string; label: string; activeCellIds: string[] }>;
}

/** One native or workbench tool call inside a folded group. `brief`, `output` verbatim (monospace). */
export interface ToolStepDTO {
  seq: number;
  at: number;
  /** Tool name as recorded ("Bash", "Edit", "shell", "apply_patch", "save_artifact", …). */
  name: string;
  /** The command, path or patch target — what the call was about, one line. */
  brief: string;
  /** null while no result is recorded. */
  ok: boolean | null;
  /** Head of the output (already clipped by the server); null when none. */
  output: string | null;
  /** The full output was stored separately: GET /api/resources?uri=… pages through it. */
  spillUri: string | null;
  durationMs: number | null;
}

interface TimelineItemBase {
  /** Stable id of the item (also what a reply refers to: SendCellMessageRequest.replyToId). */
  id: string;
  /** Evidence position: items are ordered by it and `afterSeq`/`beforeSeq` page by it. */
  seq: number;
  at: number;
}

export type TimelineItemDTO =
  /** The task it was started with. `fromLabel`: "项目协调「支付重试改造」". */
  | (TimelineItemBase & { kind: "dispatch_brief"; fromLabel: string; text: string })
  /**
   * Something a person said to this cell. `direct`: typed in this view or passed on by the owner's agent (right-hand
   * bubble); `syncedTo`: the project that was given a copy ("已同步给所属项目「…」"), null when there is none.
   */
  | (TimelineItemBase & { kind: "user_chat"; text: string; senderLabel: string; direct: boolean; mode: "enqueue" | "steer"; syncedTo: string | null; replyToId: string | null })
  /** What another cell or the system told it (a project's follow-up, the desk's ruling, a job's result), one block. */
  | (TimelineItemBase & { kind: "peer_message"; fromLabel: string; text: string })
  /** What the cell said (Markdown). `toOwner`: it was sent to the owner as a message, not only said in the turn. `question`: it ends in a question the owner can answer here. */
  | (TimelineItemBase & { kind: "assistant_reply"; text: string; toOwner: boolean; question: boolean })
  /** Consecutive tool calls folded into one line: "执行了 6 步操作：读取 3 个文件 · 修改 src/retry.ts · 运行 pnpm test（通过）". */
  | (TimelineItemBase & { kind: "tool_group"; toSeq: number; summary: string; failed: number; steps: ToolStepDTO[] })
  | (TimelineItemBase & { kind: "artifact_event"; verb: "created" | "revised"; artifact: ArtifactRefDTO })
  /** A turn ended and the project was told; a project was started / finished; a card was raised. */
  | (TimelineItemBase & { kind: "milestone"; text: string; tone: "ok" | "warn" | "info" })
  /** Everything else worth a grey line ("系统巡检唤醒", "额度用完，已暂停推进"). */
  | (TimelineItemBase & { kind: "system_event"; text: string });

/** What the box under the timeline does for the selected node (proposal part 4 §3.3). */
export interface ComposerDTO {
  /** false: read-only, show `hint` and `quick` only. */
  enabled: boolean;
  /**
   * desk: the main conversation · wake: dormant, a message wakes it on its record · running: "顺手补充" by default,
   * "立即打断" as a second button · coordinator: an instruction to a project or hub · script: a deterministic probe,
   * no conversation · archived: closed with a finished project · paused.
   */
  mode: "desk" | "wake" | "running" | "coordinator" | "script" | "archived" | "paused";
  /** The line above the box ("该分身正在运行 — 默认顺手补充，本轮收尾时处理"). */
  hint: string;
  placeholder: string;
  /** Show the secondary "立即打断" button (send with mode "steer"). */
  canSteer: boolean;
  /** The project that gets a copy of what is typed here ("自动同步给所属项目「…」", with the "立即唤醒项目" checkbox). */
  syncTo: { cellId: string; title: string } | null;
  /** Buttons that replace or accompany the box ("立即触发一次检查", "重新启动所属项目", "去总助理另起新事项"). */
  quick: ButtonDTO[];
}

export interface CellJobDTO {
  jobId: string;
  command: string;
  startedAt: number;
  /** Last lines of its output so far (verbatim); null when it is not previewed. */
  tail: string | null;
}

/** GET /api/cells/:cellId/timeline?afterSeq=&beforeSeq=&limit= */
export interface CellTimelineDTO {
  generatedAt: number;
  node: TopologyNodeDTO;
  /** "总助理 › 支付重试改造 › 分身：核心退避编码" — every entry is clickable. */
  breadcrumb: Array<{ cellId: string; label: string }>;
  /** Current branch of `node.cwd` when it is a git repository. */
  branch: string | null;
  /** Reports and drafts of the node and of its project. */
  artifacts: ArtifactRefDTO[];
  /** A project's own notes (its whiteboard), verbatim Markdown; null for other nodes or when it has none. */
  notes: string | null;
  /** A project: what its workers did that it has not looked at yet. */
  unpulled: Array<{ cellId: string; title: string; count: number; preview: string | null; hadDirectUserChat: boolean }>;
  /** Background commands of the node that are running now. */
  jobs: CellJobDTO[];
  /** The node's latest unanswered question to the owner: a reply typed now is sent with `replyToId = id`. */
  pendingQuestion: { id: string; text: string } | null;
  /** pause / resume / cancel as the server would accept them now (POST /api/cells/:cellId/control). */
  controls: ButtonDTO[];
  composer: ComposerDTO;
  /** Oldest first. With `afterSeq`: only items after it (may be empty). */
  items: TimelineItemDTO[];
  /** Range of evidence covered by `items` (0/0 when empty), and whether older records exist before `firstSeq`. */
  firstSeq: number;
  lastSeq: number;
  hasEarlier: boolean;
}

/** GET /api/resources?uri=res://…&offset=0&limit=16000 */
export interface ResourcePageDTO {
  uri: string;
  content: string;
  offset: number;
  limit: number;
  totalChars: number;
  hasMore: boolean;
}

/** POST /api/cells/:cellId/messages */
export interface SendCellMessageRequest {
  text: string;
  /** Idempotent message id (/^[\w.:-]{1,80}$/): a retry after a dropped connection never sends twice. */
  clientId: string;
  /** Default "enqueue" (顺手补充); "steer" = 立即打断插话. */
  mode?: "enqueue" | "steer";
  /** Default "silent": the project gets a copy without being woken; "wakeup" = 同时立即唤醒项目协调器. */
  notifyParent?: "silent" | "wakeup";
  /** The timeline item this answers (CellTimelineDTO.pendingQuestion.id). */
  replyToId?: string;
}

export type SendCellMessageOutcome = "delivered" | "duplicate" | "reopened" | "refused_script" | "refused_archived" | "not_found";

export interface SendCellMessageResponse {
  ok: boolean;
  outcome: SendCellMessageOutcome;
  /** Ready to show: "已发送，分身已被唤醒", "已顺手补充，本轮收尾时处理", "这是确定性脚本探针，不接受自然语言对话". */
  message: string;
  /** Id of the message as stored (equals clientId). */
  id: string | null;
  /** The cell's timeline tail after the send (items after the caller's last seq are enough to append). */
  timeline: CellTimelineDTO | null;
  status: StatusDTO;
}

/** POST /api/cells/:cellId/control */
export interface CellControlRequest {
  action: "pause" | "resume" | "cancel";
}

export interface CellControlResponse {
  ok: boolean;
  outcome: "paused" | "resumed" | "cancelled" | "not_applied" | "not_found";
  message: string;
  node: TopologyNodeDTO | null;
  status: StatusDTO;
}

/** POST /api/cells/:cellId/trigger — "立即触发一次检查" on a script probe (ComposerDTO.quick of a script node). */
export interface CellTriggerResponse {
  ok: boolean;
  outcome: "triggered" | "not_applied" | "not_found";
  message: string;
  node: TopologyNodeDTO | null;
  status: StatusDTO;
}

// ==================== weekly review (GET /api/review; also inside RadarDTO) ====================

export interface WeeklyReviewDTO {
  generatedAt: number;
  weekStart: number;
  nextReviewAt: number;
  completed: Array<{ kind: "action" | "project" | "reply"; title: string; at: number; project: string | null }>;
  overdueWaits: Array<{ cellId: string; actionId: string; title: string; project: string | null; dueAt: number; text: string }>;
  /** Drafts you edited before approving this week (raw material for new checklists). */
  editedDrafts: number;
  skillSuggestions: Array<{ name: string; description: string; reason: string; body: string; buttons: ButtonDTO[] }>;
  /** "这类操作你已连续 N 次原样确认 — 改成有上限的自动执行？" */
  /** Sources that run a model for a fixed check — offer a zero-token script instead. */
  sensorSuggestions: Array<{ sensorId: string; title: string; runCount: number; hitCount: number; reason: string; entry: string | null; buttons: ButtonDTO[] }>;
}

/** POST /api/review/rules */
export interface SensorToCodeRequest {
  /** `script:<path>` run in the source's workspace, or a registered check name. */
  entry: string;
}

export type ReviewOutcome = "skill_saved" | "dismissed" | "switched_to_code" | "not_found";

export type ReviewMutationResponse = MutationResult<WeeklyReviewDTO, ReviewOutcome>;

// ==================== activity drawer (GET /api/activity?kind=…) ====================

export type ActivityKind = "notification_archived" | "note_saved" | "reminder_set" | "card_withdrawn" | "action_completed";

export interface ActivityItemDTO {
  cellId: string;
  id: string;
  kind: ActivityKind;
  kindLabel: string;
  title: string;
  detail: string | null;
  at: number;
  source: SourceInfoDTO | null;
  rawInput: string | null;
  remindAt: number | null;
  restorable: boolean;
  restoredAt: number | null;
  buttons: ButtonDTO[];
}

export interface ActivityListDTO {
  generatedAt: number;
  items: ActivityItemDTO[];
  counts: Record<ActivityKind, number>;
}

export type ActivityOutcome = "restored" | "not_restorable" | "not_found";

export interface ActivityMutationResponse extends MutationResult<ActivityListDTO, ActivityOutcome> {}

// ==================== ⚡ 信源 drawer (GET /api/sources) ====================

export interface SensorSourceDTO {
  id: string;
  title: string;
  description: string | null;
  kind: "cron" | "watch";
  /** "每周一 09:00" / "cron 0 9 * * 1" / "每 30 分钟" */
  scheduleText: string;
  mode: "active" | "observe";
  modeLabel: string;
  status: "ok" | "error" | "paused";
  statusLabel: string;
  processor: "code" | "llm";
  processorLabel: string;
  lastRunAt: number | null;
  lastHitAt: number | null;
  lastError: string | null;
  runCount: number;
  hitCount: number;
  buttons: ButtonDTO[];
}

export interface SourcesDTO {
  generatedAt: number;
  sensors: SensorSourceDTO[];
}

/** POST /api/sources */
export interface CreateSourceRequest {
  title: string;
  description?: string;
  schedule: { cron: string; tz?: string } | { everyMinutes: number };
  check: { kind: "script"; path: string } | { kind: "code"; entry: string } | { kind: "llm"; instruction: string };
  /** observe = only write observation notes, never post to the inbox (default active). */
  mode?: "active" | "observe";
}

/** PUT /api/sources/:sensorId/mode */
export interface SourceModeRequest {
  mode: "active" | "observe";
}

export type SourceOutcome = "created" | "paused" | "resumed" | "deleted" | "mode_changed" | "not_found";

export interface SourcesMutationResponse extends MutationResult<SourcesDTO, SourceOutcome> {
  sensorId?: string;
}

// ==================== live updates (GET /api/events, text/event-stream) ====================

/**
 * SSE events (the `event:` field, data is JSON):
 * - `hello`        { status: StatusDTO } once on connect.
 * - `refresh`      { views: ViewName[] } — something behind these views changed; refetch the visible ones.
 * - `artifact`     { artifactId, version, updatedBy, parked } — a draft changed (the open editor shows the banner).
 * - `notification` NotificationDTO — a light top-bar notice for the owner.
 * - `ping`         {} every 25 s (keeps proxies from closing the stream).
 * With a bearer token configured, EventSource cannot send headers: pass `?token=` on this endpoint only.
 */
export type DeskEvent =
  | { event: "hello"; data: { status: StatusDTO } }
  | { event: "refresh"; data: { views: ViewName[] } }
  | { event: "artifact"; data: { artifactId: string; version: number; updatedBy: "agent" | "human"; parked: boolean } }
  | { event: "notification"; data: NotificationDTO }
  /** New records on one cell's timeline (debounced per cell): fetch `timeline?afterSeq=<what you have>` if it is the open one. */
  | { event: "cell_tail"; data: { cellId: string; lastSeq: number } }
  | { event: "ping"; data: Record<string, never> };

export type DeskEventName = DeskEvent["event"];

// ==================== pure helpers (usable on both sides) ====================

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "刚刚" · "12 分钟前" · "3 小时前" · "2 天前"; future times: "5 分钟后" · "明天" etc. are left to `dueText`. */
export function relativeTimeZh(at: number, now: number): string {
  const d = now - at;
  if (d < 0) {
    const f = -d;
    if (f < MINUTE) return "马上";
    if (f < HOUR) return `${Math.round(f / MINUTE)} 分钟后`;
    if (f < DAY) return `${Math.round(f / HOUR)} 小时后`;
    return `${Math.round(f / DAY)} 天后`;
  }
  if (d < MINUTE) return "刚刚";
  if (d < HOUR) return `${Math.floor(d / MINUTE)} 分钟前`;
  if (d < DAY) return `${Math.floor(d / HOUR)} 小时前`;
  return `${Math.floor(d / DAY)} 天前`;
}

/** "工作台 · 12 分钟前" */
export function sourceLine(source: SourceInfoDTO, now: number): string {
  return `${source.label} · ${relativeTimeZh(source.at, now)}`;
}
