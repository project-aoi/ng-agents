import type { CellSpec } from "./contract/cell";
import type { Envelope } from "./contract/envelope";

// GTD records are Context state under conventional keys (IMPL_BRIEF §2.8) — the kernel has no project/task tables.
// The three UI views are projections over cells + cell_state + human_items + artifacts + inbox_messages.

// ==================== keys ====================

export const gtdKeys = {
  /** In a project root cell → ProjectRecord. */
  project: "gtd:project",
  /** In a sensor cell → SourceRecord. */
  source: "gtd:source",
  /** In the cell that owns the action → ActionRecord. */
  action: (id: string) => `gtd:action:${id}`,
  actionPrefix: "gtd:action:",
  /** In the desk cell → ActivityRecord. */
  activity: (id: string) => `gtd:activity:${id}`,
  activityPrefix: "gtd:activity:",
} as const;

/**
 * Gate keeps at most one pending card per subjectKey ("同一事项至多一张卡"). Everything inside a project shares the
 * project's subject, so a project never shows two cards at once; a one-off inbound item uses its envelope id.
 */
export const subjectKeys = {
  project: (projectCellId: string) => `project:${projectCellId}`,
  inbound: (envelopeId: string) => `msg:${envelopeId}`,
  cell: (cellId: string) => `cell:${cellId}`,
} as const;

/**
 * Convention: every cell spawned inside a project carries `spec.meta.projectCellId` (the kernel copies it from the
 * parent on spawn), so any cell can build `subjectKeys.project(...)` and `ActionRecord.projectCellId` without walking
 * ancestors.
 */
export function projectCellIdOf(spec: Pick<CellSpec, "meta">): string | undefined {
  const v = spec.meta?.["projectCellId"];
  return typeof v === "string" && v ? v : undefined;
}

// ==================== ball owner (docs/03 principle 3, docs/04 §4) ====================

/**
 * human = 🔵 我来处理 (@Human) · agent = 🟢 Agent 处理中 (@Agent) · waiting = 🟡 等待外部 (@Waiting: a CI gate, a merge, a
 * colleague's reply, a lock to be released — the action's own title says what exactly is awaited).
 */
export type BallOwner = "human" | "agent" | "waiting";

/** Display priority when aggregating a project's open actions: 🔵 > 🟢 > 🟡. */
const BALL_OWNER_PRIORITY: readonly BallOwner[] = ["human", "agent", "waiting"];

export const BALL_OWNER_LABEL: Readonly<Record<BallOwner, string>> = {
  human: "🔵 我来处理",
  agent: "🟢 Agent 处理中",
  waiting: "🟡 等待外部",
};

export function compareBallOwner(a: BallOwner, b: BallOwner): number {
  return BALL_OWNER_PRIORITY.indexOf(a) - BALL_OWNER_PRIORITY.indexOf(b);
}

/** The ball owner a project row shows: the highest-priority owner among its open actions (null if none open). */
export function topBallOwner(actions: Iterable<Pick<ActionRecord, "owner" | "status">>): BallOwner | null {
  let best: BallOwner | null = null;
  for (const a of actions) {
    if (a.status !== "open") continue;
    if (best === null || compareBallOwner(a.owner, best) < 0) best = a.owner;
  }
  return best;
}

// ==================== records ====================

export type ProjectLifecycle = "active" | "completed" | "cancelled" | "someday";
export type Effort = "15m" | "45m" | "low_energy";

export interface Progress {
  done: number;
  total: number;
  label?: string;                       // e.g. "正在并发整理竞品资料", "报价已回"
}

/** Where an item came from (card source bar: "工作台 · 12 分钟前"). */
export interface ItemSource {
  label: string;                        // e.g. "工作台", "随手记", "指标巡检"
  channelId?: string;
  principalId?: string;
  envelopeId?: string;
  uri?: string;
  at: number;
}

export interface ReferenceLink {
  label: string;
  uri: string;
  detail?: string;
}

/** `gtd:project` in a project root cell. */
export interface ProjectRecord {
  title: string;
  outcome?: string;                     // what "done" looks like
  lifecycle: ProjectLifecycle;
  source?: ItemSource;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Set by the stall check when the project has none of the five anchors left (docs/05 guard 2); cleared when one returns. */
  stalledSince?: number;
  /** When the single `kernel.stalled_check` wake-up for this stall was sent; while set, no second one goes out. */
  stalledNotifiedAt?: number;
  /** [docs/05] Where the project's work happens (shown in Radar; children inherit the cell's cwd). */
  cwd?: string;
  /** [docs/05] One line on where things stand, kept by the project cell. */
  summary?: string;
  /** [docs/05] The approved plan the project was started from (kept so a someday project can be reactivated as is). */
  proposal?: ProjectProposal;
}

export interface WaitingParty {
  id: string;                           // stable key, e.g. a principal or supplier name
  label: string;                        // "供应商 C"
  replied: boolean;
  repliedAt?: number;
  dueAt?: number;                       // per-party deadline, if different
}

/** "等待供应商报价回信 (已回 2/3 · 剩 C 明天到期)" */
export interface WaitingSet {
  description: string;
  parties: WaitingParty[];
  join: "all" | "any";
  dueAt?: number;
  cancelGroup?: string;                 // the timeout nudges to cancel when everyone has replied
}

export type ActionStatus = "open" | "done" | "cancelled";

/** `gtd:action:<id>` in the cell that owns the action. */
export interface ActionRecord {
  id: string;
  title: string;
  owner: BallOwner;
  status: ActionStatus;
  projectCellId?: string;               // the project root cell (avoids ancestor walks in projections)
  nextStep?: string;                    // the concrete next physical step (required for owner "human" in Radar)
  progress?: Progress;
  waiting?: WaitingSet;                 // owner "waiting"
  effort?: Effort;
  artifactId?: string;
  references?: ReferenceLink[];
  dueAt?: number;
  source?: ItemSource;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** [docs/05] The child cell (worker / watcher) carrying this action while its owner is "agent" or "waiting". */
  cellId?: string;
  /** [docs/05] Phase of a staged project this action belongs to (1-based); later phases start after the owner's go-ahead. */
  phase?: number;
}

export type ActivityKind =
  | "notification_archived"             // pure notification filtered silently
  | "note_saved"                        // zero-side-effect capture stored directly
  | "reminder_set"
  | "card_withdrawn"                    // e.g. someone already answered in the group
  | "action_completed";

/** `gtd:activity:<id>` in the desk cell — the "后台已静默归档 N 条通知" drawer; records the original item for restoration. */
export interface ActivityRecord {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  at: number;
  source?: ItemSource;
  rawInput?: string;
  envelope?: Envelope;                  // original inbound envelope, re-enqueued to the desk on "移回待确认"
  actionId?: string;                    // the withdrawn approval, for card_withdrawn
  remindAt?: number;                    // for reminder_set
  restorable: boolean;
  restoredAt?: number;
}

/** `gtd:source` in a sensor cell — shown in the 信源 drawer, never in the project list. */
export interface SourceRecord {
  title: string;
  description?: string;
  kind: "cron" | "watch";
  schedule?: { cron?: string; tz?: string };
  mode: "active" | "observe";           // observe = write observation notes only, never post to the desk
  status: "ok" | "error" | "paused";
  processor: "code" | "llm";
  lastRunAt?: number;
  lastHitAt?: number;
  lastError?: string;
  runCount: number;
  hitCount: number;
  createdAt: number;
  updatedAt: number;
}

// ==================== Project proposals and escalations ====================

export type ClarifyCardType = "project_proposal" | "escalation";

export interface DraftRef {
  artifactId: string;
  version: number;                      // version the card was built against; the UI always shows the artifact's current version
}

/** Block 3 of every card: what the agent checked in the background before asking. */
export interface CardPrep {
  summary: string;
  checked: ReferenceLink[];             // code, docs, data, history it looked at
}

interface ClarifyCardBase {
  cardType: ClarifyCardType;
  subjectKey: string;
  title: string;
  /** Block 1: source & status bar. The status/version text is derived by the UI from the approval + artifact. */
  source: ItemSource;
  /** Block 2: grey box — original message, voice transcript, or the monitor summary that triggered it. */
  rawInput: { text: string; kind: "message" | "voice_transcript" | "monitor_summary" | "system" };
  /** Block 3: agent prep. */
  prep: CardPrep;
}

export interface ProposedProjectAction {
  title: string;
  owner: BallOwner;
  effort?: Effort;
  nextStep?: string;
}

/** The plan a project_proposal card carries; approving it = ProposedAction "project.start". */
export interface ProjectProposal {
  cwd?: string;
  repos?: { name: string; cwd: string; defaultBranch?: string }[];
  phases?: string[];
  title: string;
  outcome: string;
  background?: string;
  actions: ProposedProjectAction[];
  /** Optional spec for the project root cell (preset, processor, bounds request); the kernel fills the rest. */
  rootSpec?: Partial<CellSpec>;
}

/** B. Complex item → project proposal. */
export function isProjectProposal(value: unknown): value is ProjectProposal {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<ProjectProposal>;
  const text = (v:unknown): v is string => typeof v==="string" && v.trim().length>0;
  return text(p.title) && text(p.outcome) && Array.isArray(p.actions) &&
    p.actions.every(a=>a && text(a.title) && ["human","agent","waiting"].includes(a.owner) && (a.nextStep===undefined || typeof a.nextStep==="string")) &&
    (p.cwd===undefined || text(p.cwd)) && (p.background===undefined || typeof p.background==="string") &&
    (p.phases===undefined || Array.isArray(p.phases) && p.phases.every(text)) &&
    (p.repos===undefined || Array.isArray(p.repos) && p.repos.every(r=>r && text(r.name) && text(r.cwd) && (r.defaultBranch===undefined || text(r.defaultBranch))));
}

export interface ProjectProposalCard extends ClarifyCardBase {
  cardType: "project_proposal";
  proposal: ProjectProposal;
  /** The proposal is also kept as an artifact (format json) so "手动改一下安排" saves with version protection. */
  draft?: DraftRef;
}

export type EscalationReason = "waiting_timeout" | "retry_limit" | "blocked";

/** C. Waiting timeout / blocked escalation. */
export interface EscalationCard extends ClarifyCardBase {
  cardType: "escalation";
  escalation: {
    reason: EscalationReason;
    explanation: string;                // what happened and where it is stuck
    waiting?: WaitingSet;
  };
}

export type ClarifyCard = ProjectProposalCard | EscalationCard;

/** `approvalCard.data` → ClarifyCard, or null if the card is not a GTD card. */
export function asClarifyCard(data: unknown): ClarifyCard | null {
  if (!data || typeof data !== "object") return null;
  const t = (data as { cardType?: unknown }).cardType;
  return t === "project_proposal" || t === "escalation" ? (data as ClarifyCard) : null;
}
