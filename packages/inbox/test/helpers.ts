import {
  cellsRepo,
  createBus,
  ManualClock,
  openDatabase,
  type BusTopic,
  type BusTopics,
  type CellInsert,
  type Envelope,
} from "@ng/protocol";
import { createInbox, type InboxOptions } from "../src";

export const T0 = Date.UTC(2026, 0, 5, 8, 0, 0); // Monday 08:00:00 UTC

export interface Recorded {
  topic: BusTopic;
  data: unknown;
}

export function setup(opts: Partial<Omit<InboxOptions, "db" | "bus" | "clock">> & { cells?: CellInsert[]; start?: number } = {}) {
  const { cells: seed, start, ...inboxOpts } = opts;
  const db = openDatabase(":memory:");
  const clock = new ManualClock(start ?? T0);
  const bus = createBus();
  const events: Recorded[] = [];
  bus.on("*", (topic, data) => {
    events.push({ topic, data });
  });
  const cells = cellsRepo(db, clock);
  for (const c of seed ?? [{ id: "desk" }]) cells.insert(c);
  const inbox = createInbox({ db, bus, clock, ...inboxOpts });

  function of<K extends BusTopic>(topic: K): Array<BusTopics[K]> {
    return events.filter((e) => e.topic === topic).map((e) => e.data as BusTopics[K]);
  }

  return {
    db,
    clock,
    bus,
    cells,
    inbox,
    events,
    of,
    /** `inbox.enqueued` events as "cellId:reason", and clears the log. */
    takeWakes(): string[] {
      const out = of("inbox.enqueued").map((e) => `${e.cellId}:${e.reason}`);
      events.length = 0;
      return out;
    },
  };
}

let counter = 0;

export function msg(over: Partial<Envelope> = {}): Envelope {
  counter++;
  return {
    id: `m${counter}`,
    from: "channel:ui:owner",
    principalId: "owner",
    kind: "event",
    type: "user.message",
    payload: { text: `hello ${counter}` },
    createdAt: 0,
    ...over,
  };
}

export function timer(id: string, label = id, over: Partial<Envelope> = {}): Envelope {
  return msg({ id, from: `timer:${label}`, principalId: "cell:desk", type: "timer.fired", payload: { label }, ...over });
}

export const texts = (envs: readonly Envelope[]) => envs.map((e) => (e.payload as { text?: string; label?: string }).text ?? (e.payload as { label?: string }).label);
