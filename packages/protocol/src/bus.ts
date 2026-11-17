import type { CellStatus } from "./contract/cell";
import type { OutboxStatus } from "./contract/channel";
import type { ArtifactAuthor, KnowledgeKind, KnowledgeScope } from "./contract/context";
import type { ApprovalStatus, MeterResult } from "./contract/gate";
import type { ControlAction } from "./contract/inbox";
import type { RunOutcome } from "./contract/loop";
import type { JobState } from "./contract/workspace";

/**
 * Topic → payload. Emit only after commit (use `afterCommit(db, () => bus.emit(...))`), never inside an open
 * transaction. Packages may add topics by module augmentation:
 *   declare module "@ng/protocol" { interface BusTopics { "my.topic": { ... } } }
 */
export interface BusTopics {
  /** The cell may have claimable work now (new due message, a deliverAt that came due, a released claim, a resume). */
  "inbox.enqueued": { cellId: string; reason: "enqueued" | "due" | "released" | "resumed" };
  /** Control bypass applied; the kernel aborts the in-flight Run/Jobs on cancel/pause and delivers steer. */
  "inbox.control": { cellId: string; action: ControlAction; epoch: number; principalId: string };
  "artifact.changed": { cellId: string; artifactId: string; version: number; updatedBy: ArtifactAuthor; parked?: boolean };
  "approval.changed": { actionId: string; cellId: string; subjectKey: string; status: ApprovalStatus };
  "outbox.changed": { id: string; idempotencyKey: string; channelId: string; status: OutboxStatus };
  "channel.focus": { on: boolean; buffered: number };
  "cell.changed": { cellId: string; change: "created" | "updated" | "status" | "epoch"; status?: CellStatus; epoch?: number };
  "job.changed": { jobId: string; cellId: string; state: JobState };
  /** Output chunk of a job started with streamPreview; the kernel/app forwards it to Channel.streamPreview or SSE. */
  "job.output": { jobId: string; cellId: string; chunk: string };
  "run.started": { cellId: string; runId: string; epoch: number };
  "run.finished": { cellId: string; runId: string; epoch: number; outcome: RunOutcome | "error"; error?: string };
  "state.changed": { cellId: string; keys: string[] };
  "knowledge.changed": { kind: KnowledgeKind; name: string; scope: KnowledgeScope; cellId: string | null };
  "ledger.alert": { cellId: string; level: Exclude<MeterResult, "ok"> };
}

export type BusTopic = keyof BusTopics;
export type BusHandler<K extends BusTopic> = (data: BusTopics[K]) => void;
export type BusWildcardHandler = <K extends BusTopic>(topic: K, data: BusTopics[K]) => void;

export interface Bus {
  emit<K extends BusTopic>(topic: K, data: BusTopics[K]): void;
  on<K extends BusTopic>(topic: K, handler: BusHandler<K>): () => void;
  on(topic: "*", handler: BusWildcardHandler): () => void;
}

export interface BusOptions {
  /** Called when a handler throws; handlers never break the emitter or each other. Default: console.error. */
  onError?: (err: unknown, topic: BusTopic) => void;
}

/** Synchronous in-process pub/sub. Handlers run in subscription order during `emit`. */
export function createBus(opts: BusOptions = {}): Bus {
  const handlers = new Map<string, Set<(...args: never[]) => void>>();
  const onError = opts.onError ?? ((err, topic) => console.error(`[bus] handler for "${topic}" threw:`, err));

  function subscribe(topic: string, handler: (...args: never[]) => void): () => void {
    let set = handlers.get(topic);
    if (!set) handlers.set(topic, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  return {
    emit(topic, data) {
      for (const h of [...(handlers.get(topic) ?? [])]) {
        try {
          (h as BusHandler<typeof topic>)(data);
        } catch (err) {
          onError(err, topic);
        }
      }
      for (const h of [...(handlers.get("*") ?? [])]) {
        try {
          (h as BusWildcardHandler)(topic, data);
        } catch (err) {
          onError(err, topic);
        }
      }
    },
    on(topic: string, handler: (...args: never[]) => void) {
      return subscribe(topic, handler);
    },
  } as Bus;
}
