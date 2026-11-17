import { ManualClock, cellsRepo, createBus, openDatabase, textDeliverable, type BusTopic, type BusTopics, type Db, type Envelope } from "@ng/protocol";
import { createChannelHub, MemoryChannel, type ChannelHubOptions, type FetchLike } from "../src";

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
  const statuses = (key?: string) =>
    events
      .filter((e) => e.topic === "outbox.changed")
      .map((e) => e.data as BusTopics["outbox.changed"])
      .filter((d) => key === undefined || d.idempotencyKey === key)
      .map((d) => d.status);
  return { db, clock, bus, events, hub, mem, received, statuses };
}

export const text = textDeliverable;

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  rawBody: string;
  body: unknown;
}

/** A fake `fetch` that records calls; the responder returns a Response or throws to simulate transport errors. */
export function fakeFetch(responder: (call: FetchCall, init: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn: FetchLike = async (url, init) => {
    const rawBody = typeof init.body === "string" ? init.body : "";
    const call: FetchCall = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      rawBody,
      body: rawBody ? (JSON.parse(rawBody) as unknown) : undefined,
    };
    calls.push(call);
    return responder(call, init);
  };
  return { fn, calls };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** An error shaped like undici's `TypeError: fetch failed` with a socket-level cause code. */
export function netError(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return new TypeError("fetch failed", { cause });
}
