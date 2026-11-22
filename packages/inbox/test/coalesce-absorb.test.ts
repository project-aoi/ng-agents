import { describe, expect, it } from "vitest";
import { msg, setup, T0, texts, timer } from "./helpers";

const KEY = "coalesce:w1";
const WIN = 60_000;
const coalesce = { coalesce: { key: KEY, windowMs: WIN } };

describe("coalescing window (ScheduleRule.coalesce)", () => {
  it("is a fixed bucket: later arrivals land on the first message's edge and all are claimed as one batch", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "hub", parentId: "desk" }] });
    t.inbox.enqueueSync("hub", msg({ id: "a" }), coalesce);
    t.clock.advance(20_000);
    t.inbox.enqueueSync("hub", msg({ id: "b" }), coalesce);
    t.clock.advance(39_000);
    t.inbox.enqueueSync("hub", msg({ id: "c" }), coalesce);
    // 59 s after the first one: nothing is due, and the stream has not pushed the edge out.
    expect(t.inbox.listMessagesSync({ cellId: "hub" }).map((m) => m.deliverAt)).toEqual([T0 + WIN, T0 + WIN, T0 + WIN]);
    expect(t.inbox.claimNextRunSync("hub", "k", "serial_coalesce")).toBeNull();
    t.clock.advance(1_000);
    t.inbox.tickSync();
    const batch = t.inbox.claimNextRunSync("hub", "k", "serial_coalesce")!;
    expect(batch.envelopes.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("never borrows the time of another key or of an ordinary timer", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "hub", parentId: "desk" }] });
    // Tomorrow's reminder and another subscription's window are already pending.
    t.inbox.enqueueSync("hub", timer("tomorrow"), { deliverAt: T0 + 24 * 3_600_000 });
    t.inbox.enqueueSync("hub", msg({ id: "other" }), { coalesce: { key: "coalesce:w2", windowMs: 10 * WIN } });
    t.inbox.enqueueSync("hub", msg({ id: "mine" }), coalesce);
    const at = Object.fromEntries(t.inbox.listMessagesSync({ cellId: "hub" }).map((m) => [m.envelope.id, m.deliverAt]));
    expect(at).toEqual({ tomorrow: T0 + 24 * 3_600_000, other: T0 + 10 * WIN, mine: T0 + WIN });
  });

  it("a new bucket opens after the previous one was claimed", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "hub", parentId: "desk" }] });
    t.inbox.enqueueSync("hub", msg({ id: "a" }), coalesce);
    t.clock.advance(WIN);
    t.inbox.tickSync();
    const first = t.inbox.claimNextRunSync("hub", "k", "serial_coalesce")!;
    t.inbox.completeSync(first.claimId);
    t.clock.advance(5_000);
    t.inbox.enqueueSync("hub", msg({ id: "b" }), coalesce);
    expect(t.inbox.listMessagesSync({ cellId: "hub", status: ["pending"] })[0]!.deliverAt).toBe(T0 + WIN + 5_000 + WIN);
  });

  it("while a Run is active the message is due at once; a bucket that is due but unclaimed is joined, not restarted", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "hub", parentId: "desk" }] });
    t.inbox.enqueueSync("hub", msg({ id: "a" }));
    const run = t.inbox.claimNextRunSync("hub", "k", "serial_coalesce")!;
    t.inbox.enqueueSync("hub", msg({ id: "during" }), coalesce);
    expect(t.inbox.listMessagesSync({ envelopeId: "during" })[0]!.deliverAt).toBe(T0);
    t.inbox.completeSync(run.claimId);

    // "during" is due and unclaimed (the cell waits for a slot): the next one joins that batch instead of opening a window.
    t.clock.advance(1_000);
    t.inbox.enqueueSync("hub", msg({ id: "late" }), coalesce);
    expect(t.inbox.listMessagesSync({ envelopeId: "late" })[0]!.deliverAt).toBe(T0 + 1_000);
    expect(t.inbox.claimNextRunSync("hub", "k", "serial_coalesce")!.envelopes.map((e) => e.id)).toEqual(["during", "late"]);
  });

  it("cannot be combined with another rule or a different cancel group", () => {
    const t = setup();
    expect(() => t.inbox.enqueueSync("desk", msg(), { ...coalesce, deliverAt: T0 + 1 })).toThrow(/at most one/);
    expect(() => t.inbox.enqueueSync("desk", msg(), { ...coalesce, cancelGroup: "x" })).toThrow(/cancelGroup/);
    expect(() => t.inbox.enqueueSync("desk", msg(), { coalesce: { key: "", windowMs: 1 } })).toThrow(/key/);
  });
});

describe("drainInboundSync (absorbing arrivals into the running claim)", () => {
  it("moves due rows into the claim, in order; they complete with it", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "w", parentId: "desk" }] });
    t.inbox.enqueueSync("w", msg({ id: "task" }));
    const run = t.inbox.claimNextRunSync("w", "k", "serial_coalesce")!;
    expect(t.inbox.drainInboundSync("w", run.claimId)).toEqual([]);

    t.inbox.enqueueSync("w", msg({ id: "note", delivery: "silent_inject" }));
    // A silent note alone starts nothing, exactly like a claim.
    expect(t.inbox.drainInboundSync("w", run.claimId)).toEqual([]);
    t.inbox.enqueueSync("w", msg({ id: "follow-up" }));
    t.inbox.enqueueSync("w", timer("later"), { deliverAt: T0 + 60_000 });
    const got = t.inbox.drainInboundSync("w", run.claimId);
    expect(got.map((g) => g.envelope.id)).toEqual(["note", "follow-up"]);
    expect(t.inbox.listMessagesSync({ claimId: run.claimId }).map((m) => [m.envelope.id, m.status])).toEqual([
      ["task", "claimed"],
      ["note", "claimed"],
      ["follow-up", "claimed"],
    ]);
    t.inbox.completeSync(run.claimId);
    expect(t.inbox.listMessagesSync({ cellId: "w", status: ["done"] })).toHaveLength(3);
    expect(t.inbox.listMessagesSync({ envelopeId: "later" })[0]!.status).toBe("pending");
  });

  it("an absorbed message can be handed back, and a crash gives everything back to the queue", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "hub", parentId: "desk" }] });
    t.inbox.enqueueSync("hub", msg({ id: "a" }));
    const run = t.inbox.claimNextRunSync("hub", "k", "serial_coalesce")!;
    t.inbox.enqueueSync("hub", msg({ id: "off-topic" }));
    t.inbox.enqueueSync("hub", msg({ id: "b" }));
    t.inbox.drainInboundSync("hub", run.claimId);
    t.inbox.handbackSync(run.claimId, "off-topic", "not ours");
    expect(t.inbox.listMessagesSync({ envelopeId: "off-topic" })[0]!.status).toBe("handed_back");
    expect(t.inbox.listMessagesSync({ cellId: "desk" }).map((m) => m.envelope.type)).toEqual(["handback"]);

    expect(t.inbox.releaseSync(run.claimId, "crashed")).toMatchObject({ requeued: 2 });
    const again = t.inbox.claimNextRunSync("hub", "k", "serial_coalesce")!;
    expect(again.envelopes.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("leaves steer messages to drainSteerSync, and takes nothing for a dead or foreign claim", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "w", parentId: "desk" }, { id: "x", parentId: "desk" }] });
    t.inbox.enqueueSync("w", msg({ id: "task" }));
    const run = t.inbox.claimNextRunSync("w", "k", "serial_coalesce")!;
    t.inbox.controlSync("w", { action: "steer", principalId: "owner", steerMessage: "use pnpm" });
    expect(t.inbox.drainInboundSync("w", run.claimId)).toEqual([]);
    expect(t.inbox.drainSteerSync("w", run.claimId).map((s) => s.message)).toEqual(["use pnpm"]);

    t.inbox.enqueueSync("w", msg({ id: "more" }));
    expect(t.inbox.drainInboundSync("x", run.claimId)).toEqual([]);
    // Cancelled mid-run: the epoch moved, so the old Run takes nothing more.
    t.inbox.enqueueSync("x", msg({ id: "x-task" }));
    const xr = t.inbox.claimNextRunSync("x", "k", "serial_coalesce")!;
    t.inbox.controlSync("x", { action: "cancel", principalId: "owner" });
    expect(t.inbox.drainInboundSync("x", xr.claimId)).toEqual([]);
    t.inbox.releaseSync(run.claimId, "stopped");
    expect(t.inbox.drainInboundSync("w", run.claimId)).toEqual([]);
    // The claimed steer was not completed before releaseSync, so it returns to pending along with task + more (3).
    expect(texts(t.inbox.claimNextRunSync("w", "k", "serial_coalesce")!.envelopes)).toHaveLength(3);
  });
});

describe("settle-time counts", () => {
  it("pendingWakeupCountSync counts what would wake the cell: due wakeups and waiting non-timer messages, never silent notes or its own future timers", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "w", parentId: "desk" }] });
    expect(t.inbox.pendingWakeupCountSync("w")).toBe(0);
    t.inbox.enqueueSync("w", msg({ id: "silent", delivery: "silent_inject" }));
    t.inbox.enqueueSync("w", timer("reminder"), { deliverAt: T0 + 3_600_000 });
    expect(t.inbox.pendingWakeupCountSync("w")).toBe(0);
    t.inbox.enqueueSync("w", msg({ id: "windowed" }), coalesce);
    expect(t.inbox.pendingWakeupCountSync("w")).toBe(1);
    t.inbox.enqueueSync("w", msg({ id: "now" }));
    expect(t.inbox.pendingWakeupCountSync("w")).toBe(2);
    t.inbox.enqueueSync("w", msg({ id: "stale", expectedEpoch: 7 }));
    expect(t.inbox.pendingWakeupCountSync("w")).toBe(2);
    t.clock.advance(3_600_000);
    expect(t.inbox.pendingWakeupCountSync("w")).toBe(3);
  });

  it("activeClaimCountSync can leave out the settling Run's own claim", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "pool", parentId: "desk" }] });
    t.inbox.enqueueSync("pool", msg({ id: "a" }));
    t.inbox.enqueueSync("pool", msg({ id: "b" }));
    const a = t.inbox.claimNextRunSync("pool", "k", "competing_workers")!;
    const b = t.inbox.claimNextRunSync("pool", "k", "competing_workers")!;
    expect(t.inbox.activeClaimCountSync("pool")).toBe(2);
    expect(t.inbox.activeClaimCountSync("pool", a.claimId)).toBe(1);
    t.inbox.completeSync(b.claimId);
    expect(t.inbox.activeClaimCountSync("pool", a.claimId)).toBe(0);
  });
});
