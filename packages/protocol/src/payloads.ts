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
  jobWarning: "job.warning",
  cellTask: "cell.task",
  cellResult: "cell.result",
  cellProgress: "cell.progress",
  approvalResolved: "approval.resolved",
  approvalRevise: "approval.revise",
  controlSteer: "control.steer",
  handback: "handback",
  sourceHit: "source.hit",
  // [docs/05]
  cellMessage: "cell.message",
  cellDirectChat: "cell.direct_chat",
  stalledCheck: "kernel.stalled_check",
  arbitrationUnanswered: "kernel.arbitration_unanswered",
  runContinue: "kernel.continue",
  waitTimeout: "kernel.wait_timeout",
} as const;

/** An input captured by the workbench, with its author and source. */
export interface UserMessagePayload {
  text: string;
  replyTo?: ChannelAddr;                // where an answer would go (Gate still decides)
  sender?: { id: string; displayName?: string };
  attachments?: DeliverableAttachment[];
  voice?: boolean;                      // text is a voice transcript
  raw?: unknown;                        // adapter-specific original event
  // [docs/05 §5.3] the standard structured part every channel adapter fills when it can, so watches can route on it
  /** Who is @-mentioned: adapter-level ids or names (e.g. a bot's open_id, "@all"). */
  mentions?: string[];
  /** What kind of event this is, e.g. "message", "mention", "review_requested", "mr.merged", "ci.failed", "doc.updated". */
  eventKind?: string;
  /** Free labels the adapter derived (chat name, repo, label names…). */
  tags?: string[];
}

/** A deliverAt reminder, or a cron tick. */
export interface TimerFiredPayload {
  label: string;                        // e.g. "提醒：给牙医打电话", "weekly-metrics-check"
  data?: unknown;
  subjectKey?: string;
  scheduleId?: string;                  // set by the Inbox for cron firings
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
  error?: string;                       // infrastructure or timeout error reason, if any
}

/** First message of a spawned cell (spawnCell's initialPayload: a string becomes `instruction`, anything else `input`). */
export interface CellTaskPayload {
  parentCellId: string;
  title?: string;
  instruction?: string;
  input?: unknown;
}

/**
 * A child's report to its parent (kind "result"): the final result of a one-shot or persistent child, or — with
 * `turn` — the kernel's notice that a wakeable worker's turn has settled and it is dormant again.
 */
export interface CellResultPayload {
  childCellId: string;
  status: "completed" | "failed" | "cancelled";
  /** What the child reported (report_to_parent), else the last thing it said, else a placeholder. */
  summary: string;
  deliverable?: Deliverable;
  artifactId?: string;
  data?: unknown;
  /** Where the child is after this: "dormant" = still there, any message wakes it on its session; "closed" = gone. */
  childState?: "dormant" | "closed";
  /** Facts about the settled turn, gathered by the kernel without a model (wakeable children only). */
  turn?: SettledTurn;
}

export interface SettledTurn {
  runId: string;
  /** The child's evidence this notice covers; `inspect_cell` with `afterSeq: fromSeq - 1` shows exactly it. */
  fromSeq: number;
  toSeq: number;
  /** The owner (or their agent) spoke to the child directly, past its parent, during this turn — and how often. */
  hadDirectUserChat: boolean;
  directChats: number;
  /** Artifacts the child created or revised in this turn. */
  artifactIds: string[];
  /** Tool calls made (native CLI tools and kernel tools alike). */
  steps: number;
  outcome: "completed" | "failed" | "refused";
  /** The last thing the child said, shortened; null when it said nothing. */
  preview: string | null;
}

/** Intermediate report (e.g. "2/3 quotes back"); parents usually take it silently (delivery silent_inject). */
export interface CellProgressPayload {
  childCellId: string;
  text: string;
  progress?: Progress;
  data?: unknown;
}

/** Sent by the kernel to the owning cell whenever an approval is decided. */
export interface ApprovalResolvedPayload {
  actionId: string;
  status: ApprovalStatus;
  action: ProposedAction;
  approverId?: string;
  humanEdited?: boolean;
  humanDiff?: string;                   // compact diff of human edits when humanEdited === true
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
  humanEdited?: boolean;
  humanDiff?: string;                   // compact diff of human edits when humanEdited === true
  voice?: boolean;
}

export interface ControlSteerPayload {
  replyToId?: string;
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

/** [docs/05] One cell talking to another (RunPorts.sendToCell): a forwarded follow-up, a request for arbitration, a ruling. */
export interface CellMessagePayload {
  fromProjectCellId?: string;
  fromTitle?: string;
  fromCellId: string;
  text: string;
  summary?: string;
  data?: unknown;
  /** Set when a person wrote it (the owner in the workbench, or their agent passing it on): in which conversation, answering what. */
  replyToId?: string;
  replyToText?: string;
  conversationId?: string;
}

/**
 * The owner (or their agent on the control plane) spoke directly to one of this cell's children, past this cell.
 * Written to the parent's inbox in the transaction that delivers the message itself — by default as background
 * (`silent_inject`): it wakes nobody, and is in front of the parent at its next wake-up, in the owner's words.
 */
export interface CellDirectChatPayload {
  childCellId: string;
  childTitle?: string;
  text: string;
  /** "enqueue": handed over at the end of the child's current step; "steer": interrupted it. */
  mode: "enqueue" | "steer";
  /** Id of the message as the child received it (its envelope id), and of the message it answers, when known. */
  messageId: string;
  replyToId?: string;
  conversationId?: string;
  projectCellId?: string;
  at: number;
}

/**
 * [docs/05 guard 2] Sent once by the kernel when an active project has none of the five anchors left (nothing running
 * or queued, no watch/timer, no open wait, no card or human action): look at the project and either move it forward,
 * record what it is waiting for, park it, or finish it.
 */
export interface StalledCheckPayload {
  projectCellId: string;
  stalledSince: number;
  detail: string;
}

/** [docs/05 guard 1] The previous Run stopped at its step limit with work left; continue where it stopped. */
export interface RunContinuePayload {
  reason: "step_limit";
  /** Consecutive continuations so far (1 = first). */
  count: number;
}

/** [docs/05 guard 2] A wait registered with a timeout ran out without an answer from `waitingFor`. */
export interface WaitTimeoutPayload {
  waitId?: string;
  registrationId?: string;
  waitingFor: string;
  reason: string;
  since: number;
}

export interface KernelPayloadMap {
  "user.message": UserMessagePayload;
  "timer.fired": TimerFiredPayload;
  "job.result": JobResultPayload;
  "job.warning": { jobId: string; reason: "quiet" | "identity_unknown" | "termination_pending"; message: string };
  "cell.task": CellTaskPayload;
  "cell.result": CellResultPayload;
  "cell.progress": CellProgressPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "approval.revise": ApprovalRevisePayload;
  "control.steer": ControlSteerPayload;
  handback: HandbackPayload;
  "source.hit": SourceHitPayload;
  "cell.message": CellMessagePayload;
  "cell.direct_chat": CellDirectChatPayload;
  "kernel.stalled_check": StalledCheckPayload;
  "kernel.arbitration_unanswered": { causeKey: string; waiters: Array<{cellId: string; waitId: string; registrationId: string | null}> };
  "kernel.continue": RunContinuePayload;
  "kernel.wait_timeout": WaitTimeoutPayload;
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
    mentions: z.array(z.string()).optional(),
    eventKind: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  "timer.fired": z.looseObject({
    label: z.string(),
    data: z.unknown().optional(),
    subjectKey: z.string().optional(),
    scheduleId: z.string().optional(),
    firedAt: z.number().optional(),
  }),
  "job.warning": z.looseObject({ jobId: z.string(), reason: z.enum(["quiet", "identity_unknown", "termination_pending"]), message: z.string() }),
  "job.result": z.looseObject({
    jobId: z.string(),
    command: z.string(),
    state: z.enum(["succeeded", "failed", "cancelled"]),
    exitCode: z.number().int().nullable(),
    tail: z.string(),
    logUri: z.string().optional(),
    durationMs: z.number().optional(),
    error: z.string().optional(),
  }),
  "cell.task": z.looseObject({
    parentCellId: z.string(),
    title: z.string().optional(),
    instruction: z.string().optional(),
    input: z.unknown().optional(),
  }),
  "cell.result": z.looseObject({
    childCellId: z.string(),
    status: z.enum(["completed", "failed", "cancelled"]),
    summary: z.string(),
    deliverable: deliverableSchema.optional(),
    artifactId: z.string().optional(),
    data: z.unknown().optional(),
    childState: z.enum(["dormant", "closed"]).optional(),
    turn: z
      .looseObject({
        runId: z.string(),
        fromSeq: z.number().int(),
        toSeq: z.number().int(),
        hadDirectUserChat: z.boolean(),
        directChats: z.number().int(),
        artifactIds: z.array(z.string()),
        steps: z.number().int(),
        outcome: z.enum(["completed", "failed", "refused"]),
        preview: z.string().nullable(),
      })
      .optional(),
  }),
  "cell.progress": z.looseObject({
    childCellId: z.string(),
    text: z.string(),
    progress: progressSchema.optional(),
    data: z.unknown().optional(),
  }),
  "approval.resolved": z.looseObject({
    actionId: z.string(),
    status: z.enum(["pending", "approved", "denied", "cancelled", "superseded", "executed"]),
    action: actionShape,
    approverId: z.string().optional(),
    humanEdited: z.boolean().optional(),
    humanDiff: z.string().optional(),
    artifactVersion: z.number().int().optional(),
    outcome: z.looseObject({}).optional(),
    note: z.string().optional(),
  }),
  "approval.revise": z.looseObject({
    actionId: z.string(),
    instruction: z.string(),
    artifactId: z.string().optional(),
    artifactVersion: z.number().int().optional(),
    humanEdited: z.boolean().optional(),
    humanDiff: z.string().optional(),
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
  "cell.message": z.looseObject({ fromCellId: z.string(), text: z.string(), summary: z.string().optional(), data: z.unknown().optional() }),
  "cell.direct_chat": z.looseObject({
    childCellId: z.string(),
    childTitle: z.string().optional(),
    text: z.string(),
    mode: z.enum(["enqueue", "steer"]),
    messageId: z.string(),
    replyToId: z.string().optional(),
    conversationId: z.string().optional(),
    projectCellId: z.string().optional(),
    at: z.number(),
  }),
  "kernel.arbitration_unanswered": z.looseObject({causeKey: z.string(), waiters: z.array(z.object({cellId:z.string(),waitId:z.string(),registrationId:z.string().nullable()}))}),
  "kernel.stalled_check": z.looseObject({ projectCellId: z.string(), stalledSince: z.number(), detail: z.string() }),
  "kernel.continue": z.looseObject({ reason: z.enum(["step_limit"]), count: z.number().int() }),
  "kernel.wait_timeout": z.looseObject({ waitingFor: z.string(), reason: z.string(), since: z.number() }),
} as const satisfies Record<KernelPayloadType, z.ZodType>;

for (const [type, schema] of Object.entries(kernelPayloadSchemas)) registerPayloadType(type, schema);
