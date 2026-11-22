import type { Kernel } from "@ng/cell";
import {
  get, gtdKeys,
  type ActionRecord,
  type ActivityRecord,
  type ApprovalRecord,
  type BallOwner,
  type ProjectRecord,
  type SourceRecord,
} from "@ng/protocol";

/** What the projections read: the kernel's stores and read models, never its mutating methods. */
export type DeskKernel = Pick<
  Kernel,
  | "humanItems"
  | "context"
  | "gate"
  | "hub"
  | "inbox"
  | "clock"
  | "registry"
  | "getCell"
  | "listCells"
  | "tree"
  | "stats"
  | "deskCellId"
  | "ownerPrincipal"
  | "db"
  | "workspace"
  | "agentBackend"
  | "activityOf"
  | "activeWorkspaces"
  | "listWaits"
>;

export interface DeskSettings {
  backend: string;
  tokenRequired: boolean;
  /** Weekly review slot in local time: weekday 0 = Sunday … 5 = Friday. */
  weeklyReview: { weekday: number; hour: number };
  /** "⏱ 推迟到下午" lands at this local hour. */
  snoozeAfternoonHour: number;
}

export const DEFAULT_SETTINGS: DeskSettings = {
  backend: "unknown",
  tokenRequired: false,
  weeklyReview: { weekday: 5, hour: 16 },
  snoozeAfternoonHour: 14,
};

export interface ProjectionInput {
  kernel: DeskKernel;
  settings: DeskSettings;
  /** The instant every derived value is computed against (normally kernel.clock.now()). */
  now: number;
}

export function inputOf(kernel: DeskKernel, settings: DeskSettings = DEFAULT_SETTINGS): ProjectionInput {
  return { kernel, settings, now: kernel.clock.now() };
}

/**
 * State key under which a weekly-review helper (a preset cell) can leave a proposed SKILL.md for the owner
 * (`desk:suggestion:skill:<slug>` in the desk cell → SkillSuggestion). Not part of gtd.ts; the desk app owns it.
 */
export const SKILL_SUGGESTION_PREFIX = "desk:suggestion:skill:";
/** `desk:suggestion:sensor:<sensorCellId>` → SensorSuggestion: a prepared zero-token check for an llm source. */
export const SENSOR_SUGGESTION_PREFIX = "desk:suggestion:sensor:";

export interface SkillSuggestion {
  name: string;
  description: string;
  body: string;
  reason?: string;
  createdAt?: number;
}

export interface SensorSuggestion {
  entry?: string;
  reason?: string;
  createdAt?: number;
}

// ==================== tolerant record readers ====================
// Records are written by Loops through set_state, so a malformed value must not break a whole view.

const OWNERS = new Set<BallOwner>(["human", "agent", "waiting"]);
const ACTION_STATUSES = new Set(["open", "done", "cancelled"]);
const LIFECYCLES = new Set(["active", "completed", "cancelled", "someday"]);
const ACTIVITY_KINDS = new Set(["notification_archived", "note_saved", "reminder_set", "card_withdrawn", "action_completed"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export interface Located<T> {
  cellId: string;
  key: string;
  record: T;
  updatedAt: number;
}

export function asAction(key: string, value: unknown, updatedAt: number): ActionRecord | null {
  if (!isObj(value) || typeof value["title"] !== "string") return null;
  const owner = value["owner"] as BallOwner;
  const status = value["status"] as string;
  if (!OWNERS.has(owner) || !ACTION_STATUSES.has(status)) return null;
  const id = typeof value["id"] === "string" && value["id"] ? value["id"] : key.slice(gtdKeys.actionPrefix.length);
  return {
    ...(value as unknown as ActionRecord),
    id,
    createdAt: num(value["createdAt"], updatedAt),
    updatedAt: num(value["updatedAt"], updatedAt),
  };
}

export function asProject(value: unknown, updatedAt: number): ProjectRecord | null {
  if (!isObj(value) || typeof value["title"] !== "string" || !LIFECYCLES.has(value["lifecycle"] as string)) return null;
  return { ...(value as unknown as ProjectRecord), createdAt: num(value["createdAt"], updatedAt), updatedAt: num(value["updatedAt"], updatedAt) };
}

export function asActivity(key: string, value: unknown, updatedAt: number): ActivityRecord | null {
  if (!isObj(value) || typeof value["title"] !== "string" || !ACTIVITY_KINDS.has(value["kind"] as string)) return null;
  const id = typeof value["id"] === "string" && value["id"] ? value["id"] : key.slice(gtdKeys.activityPrefix.length);
  return { ...(value as unknown as ActivityRecord), id, at: num(value["at"], updatedAt), restorable: value["restorable"] === true };
}

export function asSource(value: unknown, updatedAt: number): SourceRecord | null {
  if (!isObj(value) || typeof value["title"] !== "string") return null;
  return {
    ...(value as unknown as SourceRecord),
    kind: (["cron", "watch"] as const).includes(value["kind"] as never) ? (value["kind"] as SourceRecord["kind"]) : "cron",
    mode: value["mode"] === "observe" ? "observe" : "active",
    status: value["status"] === "error" || value["status"] === "paused" ? value["status"] : "ok",
    processor: value["processor"] === "code" ? "code" : "llm",
    runCount: num(value["runCount"], 0),
    hitCount: num(value["hitCount"], 0),
    createdAt: num(value["createdAt"], updatedAt),
    updatedAt: num(value["updatedAt"], updatedAt),
  };
}

export function readActions(kernel: DeskKernel): Array<Located<ActionRecord>> {
  const out: Array<Located<ActionRecord>> = [];
  for (const e of kernel.context.queryStateSync({ keyPrefix: gtdKeys.actionPrefix })) {
    const record = asAction(e.key, e.value, e.updatedAt);
    if (record) out.push({ cellId: e.cellId, key: e.key, record, updatedAt: e.updatedAt });
  }
  for (const item of kernel.humanItems.list()) {
    if (item.cellId !== null || !item.subjectKey.startsWith("reminder:")) continue;
    const at = item.dueAt ?? 0;
    out.push({ cellId: kernel.deskCellId, key: item.subjectKey, updatedAt: at, record: {
      id: item.id, title: item.title, nextStep: item.description ?? item.title, owner: "human", status: "open",
      ...(item.effort === "45m" || item.effort === "15m" || item.effort === "low_energy" ? { effort: item.effort } : {}),
      ...(item.dueAt !== undefined ? { dueAt: item.dueAt } : {}), createdAt: at, updatedAt: at, source: { label: "定时提醒", at },
    } });
  }
  return out;
}

export function readProjects(kernel: DeskKernel): Array<Located<ProjectRecord>> {
  const out: Array<Located<ProjectRecord>> = [];
  for (const e of kernel.context.queryStateSync({ keyPrefix: gtdKeys.project })) {
    if (e.key !== gtdKeys.project) continue;
    const record = asProject(e.value, e.updatedAt);
    if (record) out.push({ cellId: e.cellId, key: e.key, record, updatedAt: e.updatedAt });
  }
  return out;
}

export function readActivities(kernel: DeskKernel): Array<Located<ActivityRecord>> {
  const out: Array<Located<ActivityRecord>> = [];
  for (const e of kernel.context.queryStateSync({ keyPrefix: gtdKeys.activityPrefix })) {
    const record = asActivity(e.key, e.value, e.updatedAt);
    if (record) out.push({ cellId: e.cellId, key: e.key, record, updatedAt: e.updatedAt });
  }
  return out;
}

export function readSources(kernel: DeskKernel): Array<Located<SourceRecord>> {
  const out: Array<Located<SourceRecord>> = [];
  for (const e of kernel.context.queryStateSync({ keyPrefix: gtdKeys.source })) {
    if (e.key !== gtdKeys.source) continue;
    const record = asSource(e.value, e.updatedAt);
    if (record) out.push({ cellId: e.cellId, key: e.key, record, updatedAt: e.updatedAt });
  }
  return out;
}

/**
 * The project an action belongs to: its own `projectCellId`, else the owning cell's `meta.projectCellId`, else the
 * owning cell itself when that cell holds the project record.
 */
export function projectOfAction(kernel: DeskKernel, a: Located<ActionRecord>, projectCells: ReadonlySet<string>): string | null {
  if (a.record.projectCellId) return a.record.projectCellId;
  const meta = kernel.getCell(a.cellId)?.spec.meta?.["projectCellId"];
  if (typeof meta === "string" && meta) return meta;
  return projectCells.has(a.cellId) ? a.cellId : null;
}

/** Cards converted to "我来处理" keep their approval pending, linked from the human action (`approvalActionId`). */
export function linkedApprovalId(a: ActionRecord): string | null {
  const v = (a as ActionRecord & { approvalActionId?: unknown }).approvalActionId;
  return typeof v === "string" && v ? v : null;
}

/** Project subject keys look like `project:<cellId>` (gtd.ts subjectKeys.project). */
export function projectIdOfSubject(subjectKey: string): string | null {
  return subjectKey.startsWith("project:") ? subjectKey.slice("project:".length) || null : null;
}

export function approvalProjectId(kernel: DeskKernel, rec: ApprovalRecord): string | null {
  const fromSubject = projectIdOfSubject(rec.subjectKey);
  if (fromSubject) return fromSubject;
  const meta = kernel.getCell(rec.cellId)?.spec.meta?.["projectCellId"];
  return typeof meta === "string" && meta ? meta : null;
}

/**
 * Open actions whose owner part is a Clarify card: the cell carrying the action (`ActionRecord.cellId` — a worker or a
 * watcher of a project) holds a pending card, e.g. a reply watcher's follow-up or a worker that is blocked on the
 * owner's decision. The card is where the owner acts, so such an action is no to-do of its own (not in Engage; Radar
 * points at the card). Keyed by `cellId + action id`.
 */
export function cardBackedActions(kernel: DeskKernel, actions: ReadonlyArray<Located<ActionRecord>>): Set<string> {
  const out = new Set<string>();
  const carded = new Set(kernel.gate.listPendingSync({ includeSnoozed: true }).map((r) => r.cellId));
  for (const a of actions) {
    if (a.record.status !== "open" || !a.record.cellId) continue;
    if (carded.has(a.record.cellId)) out.add(`${a.cellId}\u0000${a.record.id}`);
  }
  return out;
}

/** Cells that hold a project record (`gtd:project`): one Radar row each. */
export function projectCellIds(kernel: DeskKernel): Set<string> {
  return new Set(readProjects(kernel).map((p) => p.cellId));
}

export function humanItemForAction(kernel:DeskKernel, cellId:string, actionId:string) {
  const origin = get<{item_id:string}>(kernel.db,"SELECT item_id FROM human_item_origins WHERE cell_id=? AND key=?",
    [cellId,gtdKeys.action(actionId)]);
  return kernel.humanItems.get(origin?.item_id ?? actionId);
}

export const actionKey = (a: Located<ActionRecord>) => `${a.cellId}\u0000${a.record.id}`;
