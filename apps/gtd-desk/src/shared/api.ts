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
//   400 = malformed input. Exceptions that carry a full result body instead: approve (always 200, the outcome is in
//   the body), and the two version-protected saves (409 with ArtifactSaveResponse / ClarifyMutationResponse).

// ==================== shared vocabulary ====================

/** 🔵 我来处理 · 🟢 Agent 处理中 · 🟡 等待回复 */
export type BallOwner = "human" | "agent" | "waiting";
export type Effort = "15m" | "45m" | "low_energy";
export type ViewName = "clarify" | "engage" | "radar" | "review" | "status" | "sources" | "activity";
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export const BALL_LABEL: Readonly<Record<BallOwner, string>> = {
  human: "🔵 我来处理",
  agent: "🟢 Agent 处理中",
  waiting: "🟡 等待回复",
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
  client?: "skip" | "open_plan_editor" | "open_editor" | "open_engage";
  /** One line shown under/next to the button, e.g. "到 今天 14:00 回到待确认". */
  hint?: string;
  /** Ask for confirmation first (destructive actions). */
  confirm?: string;
}

export interface SourceInfoDTO {
  /** "飞书", "随手记", "GitHub", "信源 · 指标巡检", "定时提醒", "后台分身", "系统" */
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
  /** delivered = shown as a light top-bar notice; held = buffered during focus (shown after leaving focus). */
  state: "delivered" | "held";
}

export interface StatusDTO {
  generatedAt: number;
  /** Demo mode (no CLI agent and no API model available, or NG_DESK_DEMO=1): the UI labels itself as a demo. */
  demo: boolean;
  /** What runs the agents: a CLI agent ("claude", "codex", "agy"), an API provider ("anthropic", "openai") or "demo". Display only. */
  backend: string;
  auth: { tokenRequired: boolean };
  focus: { on: boolean; buffered: number };
  clarify: { pending: number; snoozed: number };
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
    clarify: string;
    engage: string;
    radar: string;
  };
  /** Newest first: light notices to the owner (delivered) and the ones held back during focus. */
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

// ==================== focus / DND (POST /api/focus) ====================

export interface FocusRequest {
  on: boolean;
}

export interface FocusResponse {
  ok: true;
  focus: { on: boolean; buffered: number };
  /** Leaving focus delivers what was held back; these are the receipts. */
  flushed: { sent: number; failed: number; unknown: number } | null;
  message: string;
  status: StatusDTO;
}

// ==================== 📥 Clarify (GET /api/clarify) ====================

export type ClarifyCardType = "response" | "project_proposal" | "escalation" | "generic";

/**
 * pending        waiting for the owner
 * revising       the owner asked for changes; a new draft version is being prepared
 * send_unknown   approved, but the channel could not confirm delivery — verify on the other side; never re-sent automatically
 * send_failed    approved, sending failed (nothing delivered) — retry or give up
 */
export type ClarifyCardState = "pending" | "revising" | "send_unknown" | "send_failed";

export interface ProposalDTO {
  title: string;
  outcome: string;
  background?: string;
  actions: Array<{ title: string; owner: BallOwner; ownerLabel: string; effort?: Effort; effortLabel?: string; nextStep?: string }>;
}

export interface ClarifyCardDTO {
  /** Card id (use it in every /api/clarify/:cardId/… path). */
  id: string;
  cardType: ClarifyCardType;
  state: ClarifyCardState;
  title: string;
  /** The project this card belongs to, if any (Radar row id). */
  projectId: string | null;
  createdAt: number;
  updatedAt: number;

  /** Block 1 — source & status bar: "飞书 · 12 分钟前" + "已备好初稿 v2 · 等待确认". */
  sourceBar: {
    source: SourceInfoDTO;
    statusText: string;
    /** Current draft version, if the card has a draft. */
    version: number | null;
    /** True when the draft changed after the card was prepared ("草稿已更新，请重看"). */
    draftUpdated: boolean;
  };
  /** Block 2 — raw input (grey box). */
  rawInput: { text: string; kind: "message" | "voice_transcript" | "monitor_summary" | "system" };
  /** Block 3 — what the agent checked, plus the draft / plan / blocker. */
  prep: { summary: string; checked: ReferenceDTO[] };
  /** response: the reply draft · escalation (waiting_timeout): the nudge draft · project_proposal: the plan document. */
  draft: ArtifactDTO | null;
  /**
   * response cards and nudges: who it goes to. confirmVerb: send = "确认发送" · merge = "确认合入" ·
   * accept = "确认收下" (a background result for the owner; nothing goes out).
   */
  reply: { targetLabel: string; channelLabel: string; confirmVerb: "send" | "merge" | "accept" } | null;
  /** project_proposal: the plan as it stands now (including the owner's edits). */
  proposal: ProposalDTO | null;
  escalation: {
    reason: "waiting_timeout" | "budget_exhausted" | "retry_limit" | "blocked";
    reasonLabel: string;
    explanation: string;
    waiting: WaitingDTO | null;
    usage: { tokens: number; limitTokens: number; cents: number; limitCents: number; text: string } | null;
  } | null;
  /** Last send attempt when the card stays visible because of it. */
  outcome: { state: "send_unknown" | "send_failed"; message: string; error?: string } | null;

  /** Block 4 — the fixed button row (1 primary + 2 adjust/defer + 下一张) and the secondary actions. */
  buttons: ButtonDTO[];
}

export interface ClarifyQueueDTO {
  generatedAt: number;
  /** "剩余 N 张" */
  remaining: number;
  /** Show the first; "下一张 →" cycles client-side. Ordered oldest first, verification-needed cards first. */
  cards: ClarifyCardDTO[];
  /** Cards postponed and not yet back. */
  snoozed: number;
  /** Nothing left to confirm ("收件箱已清空（Inbox Zero）"); background work is reported separately in `background`. */
  inboxZero: boolean;
  background: { running: number; jobs: number; waiting: number; text: string };
}

/** POST /api/clarify/:cardId/approve */
export interface ApproveRequest {
  /** The draft version the owner was looking at (`card.sourceBar.version`); omit for cards without a draft. */
  seenVersion?: number | null;
}

/**
 * sent              delivered (card leaves the queue)
 * approved          confirmed; the agent carries it out (project start, merge, …)
 * failed            sending failed, nothing delivered; approving again retries
 * unknown           "发送结果未知，请核实" — the card stays; verify it, it is never re-sent automatically
 * version_mismatch  "草稿已更新，请重看" — `currentVersion` is what to show; approving that version works
 * already_cancelled the task was stopped or the card withdrawn
 * not_found         no such card
 */
export type ApproveOutcome = "sent" | "approved" | "failed" | "unknown" | "version_mismatch" | "already_cancelled" | "not_found";

export interface MutationResult<V, O extends string = string> {
  ok: boolean;
  outcome: O;
  /** Ready-to-show result line. */
  message: string;
  view: V;
  status: StatusDTO;
}

export interface ApproveResponse extends MutationResult<ClarifyQueueDTO, ApproveOutcome> {
  currentVersion?: number | null;
  error?: string;
  /** The card after the click (null when it left the queue). */
  card: ClarifyCardDTO | null;
}

/** POST /api/clarify/:cardId/revise — "🎙 按住口述修改意见" */
export interface ReviseRequest {
  instruction: string;
  voice?: boolean;
}

/** POST /api/clarify/:cardId/snooze — "⏱ 推迟到下午"; `until` defaults to the next afternoon slot. */
export interface SnoozeRequest {
  until?: number;
}

/** POST /api/clarify/:cardId/extend — "⏱ 再等 1 天" (`until` defaults to +1 day) / "⏱ 追加额度继续" (`raise` defaults to +50%). */
export interface ExtendRequest {
  until?: number;
  raise?: { tokens?: number; cents?: number };
  note?: string;
}

/** POST /api/clarify/:cardId/resolve-offline · /dismiss · /deny · /someday · /abandon */
export interface NoteRequest {
  note?: string;
}

/** POST /api/clarify/:cardId/to-human — "转给我来处理" */
export interface ToHumanRequest {
  effort?: Effort;
  nextStep?: string;
}

/** POST /api/clarify/:cardId/verify — the owner checked an unknown send on the other side. */
export interface VerifyRequest {
  verdict: "sent" | "failed";
  note?: string;
}

/** PUT /api/clarify/:cardId/plan — "✎ 手动改一下安排", saved with version protection. */
export interface PlanSaveRequest {
  expectedVersion: number;
  proposal: {
    title?: string;
    outcome: string;
    background?: string;
    actions: Array<{ title: string; owner: BallOwner; effort?: Effort; nextStep?: string }>;
  };
}

export type ClarifyOutcome =
  | "revising"
  | "snoozed"
  | "someday"
  | "continued"
  | "resolved_offline"
  | "to_human"
  | "dismissed"
  | "denied"
  | "verified"
  | "abandoned"
  | "saved"
  | "conflict"
  | "not_pending"
  | "not_found";

export interface ClarifyMutationResponse extends MutationResult<ClarifyQueueDTO, ClarifyOutcome> {
  card: ClarifyCardDTO | null;
  /** to_human: the new Engage item · someday: the Radar row id. */
  engageItem?: { cellId: string; actionId: string };
  projectId?: string;
  /** plan save conflict: the plan document as it is now. */
  current?: ArtifactDTO;
}

// ==================== 🎯 Engage (GET /api/engage?effort=15m|45m|low_energy) ====================

export interface EngageItemDTO {
  /** Use both in /api/engage/:cellId/:actionId paths. */
  cellId: string;
  actionId: string;
  title: string;
  nextStep: string | null;
  effort: Effort | null;
  effortLabel: string | null;
  dueAt: number | null;
  overdue: boolean;
  project: { id: string; title: string } | null;
  source: SourceInfoDTO | null;
  /** quick = one-click "✓ 已办完"; deep = opens the 8/4 editor. */
  kind: "quick" | "deep";
  artifact: { artifactId: string; version: number; title?: string; updatedBy: "agent" | "human" } | null;
  /** Converted reply cards: "定稿发送" sends the current draft version for real. */
  send: { targetLabel: string; channelLabel: string; state: "ready" | "send_failed" } | null;
  createdAt: number;
  buttons: ButtonDTO[];
}

export interface EngageListDTO {
  generatedAt: number;
  filter: Effort | "all";
  counts: Record<Effort | "all", number>;
  items: EngageItemDTO[];
  focus: { on: boolean; buffered: number; text: string };
}

/** GET /api/engage/:cellId/:actionId — the 8/4 workspace. */
export interface EngageDetailDTO {
  generatedAt: number;
  item: EngageItemDTO;
  /** Left 8/12: the draft (null for items without one). */
  artifact: ArtifactDTO | null;
  /** Right 4/12: the context pack. */
  contextPack: {
    references: ReferenceDTO[];
    /** Checklists (SKILL.md) that apply here (name + one-line description). */
    skills: Array<{ name: string; description: string }>;
    /** The original message this came from. */
    rawInput: { text: string; source: SourceInfoDTO } | null;
    /** What the agent noted while preparing it. */
    prepSummary: string | null;
  };
}

/** POST /api/engage/:cellId/:actionId/done — "✓ 已办完" */
export interface DoneRequest {
  note?: string;
}

/** POST /api/engage/:cellId/:actionId/send — "定稿发送" */
export interface EngageSendRequest {
  seenVersion: number;
}

export type EngageOutcome = "done" | "already_done" | ApproveOutcome;

export interface EngageMutationResponse extends MutationResult<EngageListDTO, EngageOutcome> {
  /** Background tasks stopped because the item is finished. */
  closedTasks?: number;
  currentVersion?: number | null;
  error?: string;
}

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

export interface ProjectRowDTO {
  id: string;
  title: string;
  outcome: string | null;
  lifecycle: "active" | "completed" | "cancelled" | "someday";
  paused: boolean;
  /** The single ball label the row shows (🔵 > 🟢 > 🟡); null when nothing is open. */
  ball: { owner: BallOwner; label: string; text: string; engage?: { cellId: string; actionId: string }; cardId?: string } | null;
  /** Aggregated progress ("11/15", "已回 2/3"). */
  progress: ProgressDTO | null;
  waiting: WaitingDTO | null;
  openActions: ProjectActionDTO[];
  /** A card about this project waits in Clarify. */
  pendingCardId: string | null;
  /** No running work, nothing being waited on, no next step: flagged red. */
  stalled: boolean;
  stalledText: string | null;
  running: number;
  waitingOn: number;
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

export type ProjectOutcome = "paused" | "resumed" | "cancelled" | "completed" | "someday" | "activated" | "reproposed" | "action_added" | "not_applied";

export interface ProjectMutationResponse extends MutationResult<RadarDTO, ProjectOutcome> {
  /** reproposed: the new Clarify card. */
  cardId?: string;
}

/** POST /api/projects/:projectId/actions — "补上下一步" */
export interface AddActionRequest {
  title: string;
  nextStep?: string;
  effort?: Effort;
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
  ruleSuggestions: Array<{ actionClass: string; label: string; streak: number; approved: number; buttons: ButtonDTO[] }>;
  /** Sources that run a model for a fixed check — offer a zero-token script instead. */
  sensorSuggestions: Array<{ sensorId: string; title: string; runCount: number; hitCount: number; reason: string; entry: string | null; buttons: ButtonDTO[] }>;
}

/** POST /api/review/rules */
export interface EnableRuleRequest {
  actionClass: string;
  /** Auto-allow at most this many times (default 20). */
  maxUses?: number;
}

/** POST /api/review/sensors/:sensorId/code */
export interface SensorToCodeRequest {
  /** `script:<path>` run in the source's workspace, or a registered check name. */
  entry: string;
}

export type ReviewOutcome = "skill_saved" | "dismissed" | "rule_enabled" | "switched_to_code" | "not_found";

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

export interface ChannelSourceDTO {
  id: string;
  label: string;
  kind: string;
  state: "ready" | "stopped" | "error";
  stateLabel: string;
  lastIngressAt: number | null;
  lastDeliveryAt: number | null;
  lastError: string | null;
  /** Webhook URL path to configure on the provider side, if it receives webhooks. */
  hookPath: string | null;
}

export interface SensorSourceDTO {
  id: string;
  title: string;
  description: string | null;
  kind: "cron" | "watch" | "channel" | "webhook";
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
  channels: ChannelSourceDTO[];
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

/** "飞书 · 12 分钟前" */
export function sourceLine(source: SourceInfoDTO, now: number): string {
  return `${source.label} · ${relativeTimeZh(source.at, now)}`;
}
