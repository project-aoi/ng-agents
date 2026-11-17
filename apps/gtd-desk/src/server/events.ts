import type { Kernel } from "@ng/cell";
import { gtdKeys, type BusTopic, type BusTopics } from "@ng/protocol";
import type { DeskEvent, NotificationDTO, ViewName } from "../shared/api";
import { SENSOR_SUGGESTION_PREFIX, SKILL_SUGGESTION_PREFIX } from "./projections/common";

const ALL: readonly ViewName[] = ["clarify", "engage", "radar", "review", "status", "sources", "activity"];

function stateViews(keys: readonly string[]): ViewName[] {
  const v = new Set<ViewName>();
  for (const k of keys) {
    if (k.startsWith(gtdKeys.actionPrefix)) ["engage", "radar", "review", "status", "clarify"].forEach((x) => v.add(x as ViewName));
    else if (k === gtdKeys.project) ["radar", "review", "status", "engage"].forEach((x) => v.add(x as ViewName));
    else if (k.startsWith(gtdKeys.activityPrefix)) ["activity", "status", "clarify"].forEach((x) => v.add(x as ViewName));
    else if (k === gtdKeys.source) ["sources", "review"].forEach((x) => v.add(x as ViewName));
    else if (k.startsWith(SKILL_SUGGESTION_PREFIX) || k.startsWith(SENSOR_SUGGESTION_PREFIX)) v.add("review");
    else if (k === "cell:status") ["radar", "status"].forEach((x) => v.add(x as ViewName));
  }
  return [...v];
}

/** Which views a bus event can change (coarse on purpose: the client refetches what it shows). */
export function viewsForBusEvent<K extends BusTopic>(topic: K, data: BusTopics[K]): ViewName[] {
  switch (topic) {
    case "approval.changed":
      return ["clarify", "status", "radar", "engage", "review"];
    case "artifact.changed":
      return ["clarify", "engage"];
    case "state.changed":
      return stateViews((data as BusTopics["state.changed"]).keys);
    case "cell.changed":
    case "inbox.control":
      return ["radar", "status", "sources"];
    case "run.started":
    case "run.finished":
      return ["status", "radar", "clarify"];
    case "job.changed":
      return ["status", "radar"];
    case "outbox.changed":
      return (data as BusTopics["outbox.changed"]).channelId === "ui" ? ["status"] : ["status", "clarify", "sources"];
    case "channel.focus":
      return ["status", "engage"];
    case "ledger.alert":
      return ["status"];
    case "knowledge.changed":
      return ["review", "engage"];
    case "inbox.enqueued":
      return (data as BusTopics["inbox.enqueued"]).reason === "due" ? ["clarify", "status", "radar"] : [];
    default:
      return [];
  }
}

export interface EventHub {
  subscribe(listener: (e: DeskEvent) => void): () => void;
  /** Ends every open stream (server shutdown). */
  close(): void;
  onClose(listener: () => void): () => void;
}

/**
 * One bus subscription for all SSE clients. `refresh` events are coalesced over `debounceMs` so a burst of commits
 * (a Run writing several records) becomes one refetch; drafts and notices are forwarded at once.
 */
export function createEventHub(kernel: Pick<Kernel, "bus" | "hub">, opts: { debounceMs?: number } = {}): EventHub {
  const debounceMs = opts.debounceMs ?? 80;
  const listeners = new Set<(e: DeskEvent) => void>();
  const closers = new Set<() => void>();
  let pending = new Set<ViewName>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const send = (e: DeskEvent) => {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch {
        // a broken stream must not stop the others
      }
    }
  };
  const flush = () => {
    timer = null;
    if (pending.size === 0) return;
    const views = ALL.filter((v) => pending.has(v));
    pending = new Set();
    send({ event: "refresh", data: { views } });
  };

  const off = kernel.bus.on("*", (topic, data) => {
    if (listeners.size === 0) return;
    if (topic === "artifact.changed") {
      const d = data as BusTopics["artifact.changed"];
      send({ event: "artifact", data: { artifactId: d.artifactId, version: d.version, updatedBy: d.updatedBy, parked: d.parked === true } });
    }
    if (topic === "outbox.changed") {
      const d = data as BusTopics["outbox.changed"];
      if (d.channelId === "ui" && d.status === "sent") {
        const row = kernel.hub.getOutboxSync(d.idempotencyKey);
        if (row) {
          const n: NotificationDTO = {
            id: row.id,
            ...(row.content.title !== undefined ? { title: row.content.title } : {}),
            text: row.content.body,
            at: row.sentAt ?? row.updatedAt,
            state: "delivered",
          };
          send({ event: "notification", data: n });
        }
      }
    }
    const views = viewsForBusEvent(topic, data);
    if (views.length === 0) return;
    for (const v of views) pending.add(v);
    timer ??= setTimeout(flush, debounceMs);
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      closers.add(listener);
      return () => closers.delete(listener);
    },
    close() {
      off();
      if (timer) clearTimeout(timer);
      timer = null;
      listeners.clear();
      for (const c of [...closers]) c();
      closers.clear();
    },
  };
}
