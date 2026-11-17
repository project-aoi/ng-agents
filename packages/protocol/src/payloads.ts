import { z } from "zod";
import { NgError } from "./errors";
import { deliverableSchema, type Deliverable, type DeliverableAttachment } from "./contract/deliverable";
import type { ChannelAddr, Envelope } from "./contract/envelope";
import type { ApprovalOutcome, ApprovalStatus, ProposedAction } from "./contract/gate";
import type { Progress } from "./gtd";

// ==================== registry ====================
// Process-wide: Envelope.type must be registered or the Inbox quarantines the message ("未知类型隔离处理").
// Presets/apps register their own types at startup; kernel types below are registered when this module loads.

const registry = new Map<string, z.ZodType>();
const TYPE_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

export function registerPayloadType(type: string, schema: z.ZodType, opts: { replace?: boolean } = {}): void {
  if (!TYPE_NAME.test(type)) throw new NgError("invalid_argument", `invalid payload type name "${type}"`);
  const existing = registry.get(type);
  if (existing && existing !== schema && !opts.replace) {
    throw new NgError("duplicate", `payload type "${type}" is already registered with a different schema`);
  }
  registry.set(type, schema);
}

export function isRegisteredPayloadType(type: string): boolean {
  return registry.has(type);
}

export function listPayloadTypes(): string[] {
  return [...registry.keys()].sort();
}

export type PayloadValidation =
  | { ok: true }
  | { ok: false; reason: "unknown_type"; message: string }
  | { ok: false; reason: "invalid"; message: string };

/** Checks `env.payload` against the schema registered for `env.type`. Never mutates the envelope. */
export function validatePayload(env: Pick<Envelope, "type" | "payload">): PayloadValidation {
  const schema = registry.get(env.type);
  if (!schema) return { ok: false, reason: "unknown_type", message: `unregistered payload type "${env.type}"` };
  const r = schema.safeParse(env.payload);
  return r.success ? { ok: true } : { ok: false, reason: "invalid", message: z.prettifyError(r.error) };
}

// ==================== built-in kernel payload types ====================

export const PAYLOAD = {
  userMessage: "user.message",
  timerFired: "timer.fired",
  jobResult: "job.result",
  cellTask: "cell.task",
  cellResult: "cell.result",
  cellProgress: "cell.progress",
  approvalResolved: "approval.resolved",
  approvalRevise: "approval.revise",
  controlSteer: "control.steer",
  handback: "handback",
  sourceHit: "source.hit",
} as const;

/** A human (owner or external sender) said something through a Channel, or typed into 随手记. */
export interface UserMessagePayload {
  text: string;
  replyTo?: ChannelAddr;                // where an answer would go (Gate still decides)
  sender?: { id: string; displayName?: string };
  attachments?: DeliverableAttachment[];
  voice?: boolean;                      // text is a voice transcript
  raw?: unknown;                        // adapter-specific original event
}

/** A deliverAt reminder, a cron tick or an idleSec wakeup. */
export interface TimerFiredPayload {
  label: string;                        // e.g. "提醒：给牙医打电话", "weekly-metrics-check"
  data?: unknown;
  subjectKey?: string;
  scheduleId?: string;                  // set by the Inbox for cron/idleSec firings
  firedAt?: number;
}

/** Enqueued by Workspace when a Job ends; the envelope carries expectedEpoch = the job's start epoch. */
export interface JobResultPayload {
  jobId: string;
  command: string;
  state: "succeeded" | "failed" | "cancelled";
  exitCode: number | null;
  tail: string;                         // last lines of output
  logUri?: string;                      // res:// URI of the full log, if stored
  durationMs?: number;
}

/** First message of a spawned cell (spawnCell's initialPayload: a string becomes `instruction`, anything else `input`). */
export interface CellTaskPayload {
  parentCellId: string;
  title?: string;
  instruction?: string;
  input?: unknown;
}

/** A child's final report to its parent (kind "result"). */
export interface CellResultPayload {
  childCellId: string;
  status: "completed" | "failed" | "cancelled" | "budget_stopped";
  summary: string;
  deliverable?: Deliverable;
  artifactId?: string;
  data?: unknown;
}

/** Intermediate report (e.g. "2/3 quotes back"); parents usually take it silently (delivery silent_inject). */
export interface CellProgressPayload {
  childCellId: string;
  text: string;
  progress?: Progress;
  data?: unknown;
}

/** Sent by the kernel to the owning cell whenever an approval is decided (and, for channel.send, executed). */
export interface ApprovalResolvedPayload {
  actionId: string;
  status: ApprovalStatus;
  action: ProposedAction;
  approverId?: string;
  humanEdited?: boolean;
  artifactVersion?: number;             // the version that was approved/sent
  outcome?: ApprovalOutcome;
  note?: string;
}

/** "🎙 按住口述修改意见": redraft the card's artifact from its current version. */
export interface ApprovalRevisePayload {
  actionId: string;
  instruction: string;
  artifactId?: string;
  artifactVersion?: number;
  voice?: boolean;
}

export interface ControlSteerPayload {
  message: string;
}

/** An off-topic item a cell handed back to the desk for re-triage. */
export interface HandbackPayload {
  original: Envelope;
  fromCellId: string;
  reason: string;
}

/** A sensor found something worth an item (posted to the desk; never in observe mode). */
export interface SourceHitPayload {
  sourceCellId: string;
  title: string;
  summary: string;
  rawInput?: string;
  uri?: string;
  data?: unknown;
}

export interface KernelPayloadMap {
  "user.message": UserMessagePayload;
  "timer.fired": TimerFiredPayload;
  "job.result": JobResultPayload;
  "cell.task": CellTaskPayload;
  "cell.result": CellResultPayload;
  "cell.progress": CellProgressPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "approval.revise": ApprovalRevisePayload;
  "control.steer": ControlSteerPayload;
  handback: HandbackPayload;
  "source.hit": SourceHitPayload;
}

export type KernelPayloadType = keyof KernelPayloadMap;

/** Type guard on `env.type` only (validation happens at enqueue). */
export function isEnvelopeOfType<K extends KernelPayloadType>(env: Envelope, type: K): env is Envelope<KernelPayloadMap[K]> {
  return env.type === type;
}

// Loose objects: extra fields pass through, so producers can add detail without a schema change.
const attachmentSchema = z.object({ label: z.string(), uri: z.string() });
const progressSchema = z.looseObject({ done: z.number(), total: z.number(), label: z.string().optional() });
const envelopeShape = z.looseObject({
  id: z.string(),
  from: z.string(),
  principalId: z.string(),
  kind: z.enum(["event", "result"]),
  type: z.string(),
  payload: z.unknown(),
  createdAt: z.number(),
});
const actionShape = z.looseObject({ type: z.string(), summary: z.string(), subjectKey: z.string(), sideEffect: z.string() });

export const kernelPayloadSchemas = {
  "user.message": z.looseObject({
    text: z.string(),
    replyTo: z.string().startsWith("channel:").optional(),
    sender: z.looseObject({ id: z.string(), displayName: z.string().optional() }).optional(),
    attachments: z.array(attachmentSchema).optional(),
    voice: z.boolean().optional(),
    raw: z.unknown().optional(),
  }),
  "timer.fired": z.looseObject({
    label: z.string(),
    data: z.unknown().optional(),
    subjectKey: z.string().optional(),
    scheduleId: z.string().optional(),
    firedAt: z.number().optional(),
  }),
  "job.result": z.looseObject({
    jobId: z.string(),
    command: z.string(),
    state: z.enum(["succeeded", "failed", "cancelled"]),
    exitCode: z.number().int().nullable(),
    tail: z.string(),
    logUri: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  "cell.task": z.looseObject({
    parentCellId: z.string(),
    title: z.string().optional(),
    instruction: z.string().optional(),
    input: z.unknown().optional(),
  }),
  "cell.result": z.looseObject({
    childCellId: z.string(),
    status: z.enum(["completed", "failed", "cancelled", "budget_stopped"]),
    summary: z.string(),
    deliverable: deliverableSchema.optional(),
    artifactId: z.string().optional(),
    data: z.unknown().optional(),
  }),
  "cell.progress": z.looseObject({
    childCellId: z.string(),
    text: z.string(),
    progress: progressSchema.optional(),
    data: z.unknown().optional(),
  }),
  "approval.resolved": z.looseObject({
    actionId: z.string(),
    status: z.enum(["pending", "approved", "denied", "cancelled", "superseded", "executed", "failed", "unknown"]),
    action: actionShape,
    approverId: z.string().optional(),
    humanEdited: z.boolean().optional(),
    artifactVersion: z.number().int().optional(),
    outcome: z.looseObject({}).optional(),
    note: z.string().optional(),
  }),
  "approval.revise": z.looseObject({
    actionId: z.string(),
    instruction: z.string(),
    artifactId: z.string().optional(),
    artifactVersion: z.number().int().optional(),
    voice: z.boolean().optional(),
  }),
  "control.steer": z.looseObject({ message: z.string() }),
  handback: z.looseObject({ original: envelopeShape, fromCellId: z.string(), reason: z.string() }),
  "source.hit": z.looseObject({
    sourceCellId: z.string(),
    title: z.string(),
    summary: z.string(),
    rawInput: z.string().optional(),
    uri: z.string().optional(),
    data: z.unknown().optional(),
  }),
} as const satisfies Record<KernelPayloadType, z.ZodType>;

for (const [type, schema] of Object.entries(kernelPayloadSchemas)) registerPayloadType(type, schema);
