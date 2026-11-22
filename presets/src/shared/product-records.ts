import type { CellRecord, Envelope, ItemSource, ProjectProposal } from "@ng/protocol";

export type ProjectLifecycle = "active" | "completed" | "cancelled";
/** In a project root cell. */
export interface ProjectRecord {
  title: string;
  outcome?: string;                     // what "done" looks like
  lifecycle: ProjectLifecycle;
  source?: ItemSource;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** [docs/05] One line on where things stand, kept by the project cell. */
  summary?: string;
  /** [docs/05] The approved plan the project was started from (kept so a someday project can be reactivated as is). */
  proposal?: ProjectProposal;
}

export type ActivityKind =
  | "notification_archived"             // pure notification filtered silently
  | "note_saved"                        // zero-side-effect capture stored directly
  | "reminder_set"
  | "card_withdrawn"                    // e.g. someone already answered in the group
  | "action_completed";

/** In the desk cell — the "后台已静默归档 N 条通知" drawer; records the original item for restoration. */
export interface ActivityRecord {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  at: number;
  source?: ItemSource;
  rawInput?: string;
  envelope?: Envelope;                  // original inbound envelope, re-enqueued to the desk on "交回主台"
  actionId?: string;                    // the withdrawn approval, for card_withdrawn
  remindAt?: number;                    // for reminder_set
  restorable: boolean;
  restoredAt?: number;
}

/** In a sensor cell — shown in the 信源 drawer, never in the project list. */
export interface SourceState {
  title: string;
  description?: string;
  mode: "active" | "observe";           // observe = write observation notes only, never post to the desk
  lastRunAt?: number;
  lastCheckKey?: string;
  lastHitAt?: number;
  lastError?: string;
  runCount: number;
  hitCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SourceRecord extends SourceState {
  kind: "cron" | "watch";
  schedule?: { cron: string; tz?: string };
  status: "ok" | "error" | "paused";
  processor: "code" | "llm";
}

export function sourceRecordFor(cell: CellRecord, state: SourceState): SourceRecord {
  const rule = cell.spec.schedules?.find(s => s.cron);
  return {
    ...state,
    title: cell.title ?? state.title,
    kind: rule?.cron || !cell.spec.watches?.length ? "cron" : "watch",
    ...(rule?.cron && {schedule: {cron: rule.cron, ...(rule.tz && {tz: rule.tz})}}),
    status: cell.status === "paused" ? "paused" : state.lastError ? "error" : "ok",
    processor: cell.spec.processor.kind,
  };
}
