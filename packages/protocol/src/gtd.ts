import type { CellSpec } from "./contract/cell";
import { isRunnerOverride, type RunnerOverride } from "./contract/loop";

// Wire contracts shared by the workbench, its presets and the kernel.

// ==================== keys ====================

/** The issuer and subject identify an active decision together. */
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

export type BallOwner = "human" | "agent" | "waiting";

// ==================== records ====================

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

/** In the cell that owns the action. */
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
  /** The project closure that cancelled this previously open action. */
  closedEpoch?: number;
  /** [docs/05] The child cell (worker / checker) carrying this action while its owner is "agent" or "waiting". */
  cellId?: string;
  /** [docs/05] Phase of a staged project this action belongs to (1-based); later phases start after the owner's go-ahead. */
  phase?: number;
}

// ==================== Project proposals and escalations ====================

export type DecisionCardType = "project_proposal" | "escalation";

export interface DraftRef {
  artifactId: string;
  version: number;                      // version the card was built against; the UI always shows the artifact's current version
}

/** Block 3 of every card: what the agent checked in the background before asking. */
export interface CardPrep {
  summary: string;
  checked: ReferenceLink[];             // code, docs, data, history it looked at
}

interface DecisionCardBase {
  cardType: DecisionCardType;
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
  runnerOverride?: RunnerOverride;
  /** Optional spec for the project root cell (preset, processor, bounds request); the kernel fills the rest. */
  rootSpec?: Partial<CellSpec>;
}

/** B. Complex item → project proposal. */
export function isProjectProposal(value: unknown): value is ProjectProposal {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<ProjectProposal>;
  const text = (v:unknown): v is string => typeof v==="string" && v.trim().length>0;
  return text(p.title) && text(p.outcome) && Array.isArray(p.actions) &&
    p.actions.every(a=>a && text(a.title) && ["human","agent","waiting"].includes(a.owner) &&
      (a.effort === undefined || ["15m", "45m", "low_energy"].includes(a.effort)) && (a.nextStep===undefined || typeof a.nextStep==="string")) &&
    (p.cwd===undefined || text(p.cwd)) && (p.background===undefined || typeof p.background==="string") &&
    (p.phases===undefined || Array.isArray(p.phases) && p.phases.every(text)) &&
    (p.runnerOverride === undefined || isRunnerOverride(p.runnerOverride)) &&
    (p.repos===undefined || Array.isArray(p.repos) && p.repos.every(r=>r && text(r.name) && text(r.cwd) && (r.defaultBranch===undefined || text(r.defaultBranch))));
}

export interface ProjectProposalCard extends DecisionCardBase {
  cardType: "project_proposal";
  proposal: ProjectProposal;
  /** The proposal is also kept as an artifact (format json) so "手动改一下安排" saves with version protection. */
  draft?: DraftRef;
}

export type EscalationReason = "waiting_timeout" | "retry_limit" | "blocked";

/** C. Waiting timeout / blocked escalation. */
export interface EscalationCard extends DecisionCardBase {
  cardType: "escalation";
  escalation: {
    reason: EscalationReason;
    explanation: string;                // what happened and where it is stuck
    waiting?: WaitingSet;
  };
}

export type DecisionCard = ProjectProposalCard | EscalationCard;

/** `approvalCard.data` → DecisionCard, or null if the card is not a GTD card. */
export function asDecisionCard(data: unknown): DecisionCard | null {
  if (!data || typeof data !== "object") return null;
  const t = (data as { cardType?: unknown }).cardType;
  return t === "project_proposal" || t === "escalation" ? (data as DecisionCard) : null;
}
