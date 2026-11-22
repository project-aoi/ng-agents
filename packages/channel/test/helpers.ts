import { ManualClock, cellsRepo, createBus, openDatabase, textDeliverable, type BusTopic, type BusTopics, type Db, type Envelope } from "@ng/protocol";
import { createChannelHub, MemoryChannel, type ChannelHubOptions } from "../src";

export interface BusEvent {
  topic: BusTopic;
  data: BusTopics[BusTopic];
}

export function setup(opts: Partial<Omit<ChannelHubOptions, "db" | "bus">> & { db?: Db; clock?: ManualClock } = {}) {
  const db = opts.db ?? openDatabase(":memory:");
  const clock = opts.clock ?? new ManualClock(1_700_000_000_000);
  if (!cellsRepo(db, clock).get("desk")) cellsRepo(db, clock).insert({ id: "desk" });
  const bus = createBus();
  const events: BusEvent[] = [];
  bus.on("*", (topic, data) => events.push({ topic, data }));
  const hub = createChannelHub({ ...opts, db, bus, clock });
  const mem = new MemoryChannel({ clock, ownerIds: ["boss"] });
  hub.register(mem);
  const received: Array<{ env: Omit<Envelope, "to">; channelId: string }> = [];
  hub.onIngress(async (env, channelId) => {
    received.push({ env, channelId });
  });
  return { db, clock, bus, events, hub, mem, received };
}

export const text = textDeliverable;
