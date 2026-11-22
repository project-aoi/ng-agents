import { describe, expect, it } from "vitest";
import { isNgError, type HandbackPayload } from "@ng/protocol";
import { msg, setup, texts } from "./helpers";

describe("serial_coalesce", () => {
  it("coalesces a burst into one batch in seq order and holds the cell lock", () => {
    const t = setup();
    for (let i = 1; i <= 4; i++) t.inbox.enqueueSync("desk", msg({ id: `b${i}`, payload: { text: `burst ${i}` } }));
    const batch = t.inbox.claimNextRunSync("desk", "kernel", 30_000)!;
    expect(texts(batch.envelopes)).toEqual(["burst 1", "burst 2", "burst 3", "burst 4"]);
    expect(batch.seqs).toEqual([...batch.seqs].sort((a, b) => a - b));
    expect(batch).toMatchObject({ cellId: "desk", epoch: 0, workerId: "kernel", leaseExpiresAt: batch.claimedAt + 30_000 });
    expect(batch.claimId).toMatch(/^run_/);

    // single writer: nobody else gets the cell while the Run is in flight, in either mode
    t.inbox.enqueueSync("desk", msg({ id: "during", payload: { text: "arrived mid-run" } }));
    expect(t.inbox.claimNextRunSync("desk", "other")).toBeNull();
    expect(t.inbox.dueCellIdsSync()).toEqual([]);

    t.takeWakes();
    t.inbox.completeSync(batch.claimId);
    expect(t.takeWakes()).toEqual(["desk:released"]); // the message that arrived mid-run is now claimable
    const next = t.inbox.claimNextRunSync("desk", "kernel")!;
    expect(texts(next.envelopes)).toEqual(["arrived mid-run"]);
    t.inbox.completeSync(next.claimId);
    expect(t.takeWakes()).toEqual([]);
    expect(t.inbox.listMessagesSync().map((r) => r.status)).toEqual(Array(5).fill("done"));
  });

  it("silent_inject rows never make a cell due but ride along with the next batch", () => {
    const t = setup();
    t.inbox.enqueueSync("desk", msg({ id: "s1", delivery: "silent_inject", payload: { text: "progress 1/3" } }));
    t.inbox.enqueueSync("desk", msg({ id: "s2", delivery: "silent_inject", payload: { text: "progress 2/3" } }));
    expect(t.inbox.claimNextRunSync("desk", "k")).toBeNull();
    expect(t.inbox.dueCellIdsSync()).toEqual([]);
    expect(t.inbox.pendingCountsSync()).toEqual({ desk: 2 });

    t.inbox.enqueueSync("desk", msg({ id: "w", payload: { text: "wake up" } }));
    const batch = t.inbox.claimNextRunSync("desk", "k")!;
    expect(texts(batch.envelopes)).toEqual(["progress 1/3", "progress 2/3", "wake up"]);
  });

  it("does not hand out future rows early", () => {
    const t = setup();
    t.inbox.enqueueSync("desk", msg({ id: "later" }), { deliverAt: t.clock.now() + 1000 });
    t.inbox.enqueueSync("desk", msg({ id: "now" }));
    expect(t.inbox.claimNextRunSync("desk", "k")!.envelopes.map((e) => e.id)).toEqual(["now"]);
  });

  it("paused and closed cells are not claimable", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "a", parentId: "desk" }, { id: "b", parentId: "desk" }] });
    t.inbox.enqueueSync("a", msg());
    t.inbox.enqueueSync("b", msg());
    t.cells.setStatus("a", "paused");
    t.cells.setStatus("b", "closed");
    expect(t.inbox.claimNextRunSync("a", "k")).toBeNull();
    expect(t.inbox.dueCellIdsSync()).toEqual([]);
    expect(() => t.inbox.claimNextRunSync("ghost", "k")).toThrow(/not found/);
  });

  it("drops rows whose expectedEpoch is stale at claim time", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "w", parentId: "desk" }] });
    t.inbox.enqueueSync("w", msg({ id: "job-result", kind: "result", expectedEpoch: 0 }));
    t.inbox.enqueueSync("w", msg({ id: "plain" }));
    t.cells.bumpEpoch("w"); // e.g. closeCell/cancel elsewhere
    expect(t.inbox.dueCellIdsSync()).toEqual(["w"]); // `plain` carries no epoch precondition
    expect(t.inbox.pendingCountsSync(["w"])).toEqual({ w: 1 });
    const batch = t.inbox.claimNextRunSync("w", "k")!;
    expect(batch.envelopes.map((e) => e.id)).toEqual(["plain"]);
    expect(batch.epoch).toBe(1);
    expect(t.inbox.listMessagesSync({ envelopeId: "job-result" })[0]).toMatchObject({ status: "dropped_epoch", statusReason: "expected epoch 0, cell is at 1" });
  });
});


describe("leases, release and dead letters", () => {
  it("expired leases return rows to pending with attempts + 1 (tick and lazily at claim)", () => {
    const t = setup();
    t.inbox.enqueueSync("desk", msg({ id: "a" }));
    const first = t.inbox.claimNextRunSync("desk", "k1", 1000)!;
    expect(t.inbox.nextWakeAtSync()).toBe(first.leaseExpiresAt);
    t.clock.advance(999);
    expect(t.inbox.tickSync().expiredClaims).toBe(0);
    t.clock.advance(1);
    t.takeWakes();
    const report = t.inbox.tickSync();
    expect(report).toEqual({ fired: 0, dueCellIds: ["desk"], expiredClaims: 1 });
    expect(t.takeWakes()).toEqual(["desk:released"]);
    expect(t.inbox.getClaimSync(first.claimId)).toMatchObject({ status: "expired", releaseReason: "lease expired" });
    expect(t.inbox.listMessagesSync()[0]).toMatchObject({ status: "pending", attempts: 1, claimId: null });
    // the late Run cannot complete a batch that went back to the queue
    expect(() => t.inbox.completeSync(first.claimId)).toThrow(/expired/);

    // lazy path: no tick ran, but the next claim still sees the expired lease
    const second = t.inbox.claimNextRunSync("desk", "k2", 1000)!;
    t.clock.advance(5000);
    const third = t.inbox.claimNextRunSync("desk", "k3", 1000)!;
    expect(third.envelopes.map((e) => e.id)).toEqual(["a"]);
    expect(t.inbox.getClaimSync(second.claimId)!.status).toBe("expired");
    expect(t.inbox.listMessagesSync()[0]!.attempts).toBe(2);
  });

  it("renewLease keeps a long Run's claim alive", () => {
    const t = setup();
    t.inbox.enqueueSync("desk", msg());
    const b = t.inbox.claimNextRunSync("desk", "k", 1000)!;
    t.clock.advance(800);
    expect(t.inbox.renewLeaseSync(b.claimId, 1000)).toBe(true);
    t.clock.advance(800);
    expect(t.inbox.tickSync().expiredClaims).toBe(0);
    t.inbox.completeSync(b.claimId);
    t.inbox.completeSync(b.claimId); // idempotent
    expect(t.inbox.renewLeaseSync(b.claimId, 1000)).toBe(false);
  });

  it("release requeues (optionally not before retryAt); past maxAttempts rows go dead and are announced", () => {
    const t = setup({ maxAttempts: 3 });
    t.inbox.enqueueSync("desk", msg({ id: "poison" }));
    const b1 = t.inbox.claimNextRunSync("desk", "k")!;
    t.takeWakes();
    expect(t.inbox.releaseSync(b1.claimId, "model error", { retryAt: t.clock.now() + 10_000 })).toEqual({ requeued: 1, dead: 0, cancelled: 0 });
    expect(t.takeWakes()).toEqual([]); // not claimable before retryAt
    expect(t.inbox.claimNextRunSync("desk", "k")).toBeNull();
    expect(t.inbox.nextWakeAtSync()).toBe(t.clock.now() + 10_000);
    t.clock.advance(10_000);
    expect(t.inbox.tickSync().dueCellIds).toEqual(["desk"]);
    expect(t.takeWakes()).toEqual(["desk:due"]);

    const b2 = t.inbox.claimNextRunSync("desk", "k")!;
    expect(t.inbox.releaseSync(b2.claimId, "crash")).toEqual({ requeued: 1, dead: 0, cancelled: 0 });
    expect(t.takeWakes()).toEqual(["desk:released"]);
    const b3 = t.inbox.claimNextRunSync("desk", "k")!;
    expect(t.inbox.releaseSync(b3.claimId, "crash again")).toEqual({ requeued: 0, dead: 1, cancelled: 0 });
    expect(t.inbox.releaseSync(b3.claimId, "double release")).toEqual({ requeued: 0, dead: 0, cancelled: 0 });

    const dead = t.inbox.listMessagesSync({ status: ["dead"] });
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ attempts: 3, statusReason: "crash again", claimId: b3.claimId });
    expect(t.of("inbox.dead")).toEqual([{ cellId: "desk", claimId: b3.claimId, seqs: [dead[0]!.seq], envelopeIds: ["poison"], reason: "crash again" }]);
    expect(t.inbox.claimNextRunSync("desk", "k")).toBeNull();
  });

  it("release with countAttempt:false (pause, shutdown) requeues without moving toward the dead-letter limit", () => {
    const t = setup({ maxAttempts: 2 });
    t.inbox.enqueueSync("desk", msg({ id: "paused-often" }));
    for (let i = 0; i < 5; i++) {
      const b = t.inbox.claimNextRunSync("desk", "k")!;
      expect(t.inbox.releaseSync(b.claimId, "paused", { countAttempt: false })).toEqual({ requeued: 1, dead: 0, cancelled: 0 });
    }
    expect(t.inbox.listMessagesSync()[0]).toMatchObject({ status: "pending", attempts: 0, statusReason: "paused" });
    expect(t.of("inbox.dead")).toHaveLength(0);
    // an ordinary failure still counts
    const b = t.inbox.claimNextRunSync("desk", "k")!;
    t.inbox.releaseSync(b.claimId, "model error");
    expect(t.inbox.listMessagesSync()[0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("lease expiry counts toward the dead-letter limit", () => {
    const t = setup({ maxAttempts: 2 });
    t.inbox.enqueueSync("desk", msg({ id: "slow" }));
    for (let i = 0; i < 2; i++) {
      expect(t.inbox.claimNextRunSync("desk", "k", 100)).not.toBeNull();
      t.clock.advance(100);
      t.inbox.tickSync();
    }
    expect(t.inbox.listMessagesSync()[0]).toMatchObject({ status: "dead", attempts: 2, statusReason: "lease expired" });
    expect(t.of("inbox.dead")).toHaveLength(1);
  });

  it("recoverClaims releases claims orphaned by a previous process", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "pool" }, { id: "other-cell" }] });
    t.inbox.enqueueSync("desk", msg());
    t.inbox.enqueueSync("pool", msg());
    t.inbox.enqueueSync("other-cell", msg());
    t.inbox.claimNextRunSync("desk", "old-kernel");
    t.inbox.claimNextRunSync("pool", "old-kernel");
    t.inbox.claimNextRunSync("other-cell", "other");
    t.takeWakes();
    expect(t.inbox.recoverClaimsSync({ workerId: "old-kernel" })).toBe(2);
    expect(t.takeWakes().sort()).toEqual(["desk:released", "pool:released"]);
    expect(t.inbox.listClaimsSync({ status: ["active"] }).map((c) => c.workerId)).toEqual(["other"]);
    expect(t.inbox.pendingCountsSync()).toEqual({ desk: 1, pool: 1 });
  });
});

describe("handback", () => {
  it("re-enqueues the off-topic envelope to the desk with the original sender and reason, and marks it handed_back", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "proj", parentId: "desk" }, { id: "watcher", parentId: "proj" }] });
    const original = msg({
      id: "memory-evt-9",
      from: "channel:memory:oc_123",
      principalId: "memory:ou_alice",
      threads: ["memory:oc_123"],
      payload: { text: "顺便问下，下周团建去哪？" },
    });
    t.inbox.enqueueSync("watcher", original);
    t.inbox.enqueueSync("watcher", msg({ id: "on-topic" }));
    const batch = t.inbox.claimNextRunSync("watcher", "k")!;
    t.takeWakes();

    t.inbox.handbackSync(batch.claimId, "memory-evt-9", "unrelated to the quote follow-up");
    expect(t.takeWakes()).toEqual(["desk:enqueued"]);
    const [handed] = t.inbox.listMessagesSync({ cellId: "desk" });
    expect(handed!.envelope).toMatchObject({
      id: "memory-evt-9#handback#watcher",
      from: "kernel:handback",
      to: "inbox:desk",
      principalId: "memory:ou_alice",
      type: "handback",
      threads: ["memory:oc_123"],
    });
    const payload = handed!.envelope.payload as HandbackPayload;
    expect(payload).toMatchObject({ fromCellId: "watcher", reason: "unrelated to the quote follow-up" });
    expect(payload.original).toMatchObject({ id: "memory-evt-9", from: "channel:memory:oc_123", principalId: "memory:ou_alice" });
    expect(handed!.status).toBe("pending");

    t.inbox.completeSync(batch.claimId);
    const statuses = Object.fromEntries(t.inbox.listMessagesSync({ cellId: "watcher" }).map((r) => [r.envelope.id, r.status]));
    expect(statuses).toEqual({ "memory-evt-9": "handed_back", "on-topic": "done" });
  });

  it("uses the injected resolveDesk, falls back to the tree root, and rejects bad calls", () => {
    const t = setup({ cells: [{ id: "root" }, { id: "child", parentId: "root" }] }); // no `desk` cell
    t.inbox.enqueueSync("child", msg({ id: "x" }));
    const b = t.inbox.claimNextRunSync("child", "k")!;
    expect(() => t.inbox.handbackSync(b.claimId, "not-in-batch", "r")).toThrow(/not held/);
    t.inbox.handbackSync(b.claimId, "x", "r");
    expect(t.inbox.listMessagesSync({ cellId: "root" }).map((r) => r.envelope.id)).toEqual(["x#handback#child"]);

    t.inbox.enqueueSync("root", msg({ id: "y" }));
    const own = t.inbox.claimNextRunSync("root", "k")!;
    try {
      t.inbox.handbackSync(own.claimId, own.envelopes[0]!.id, "r");
      expect.unreachable();
    } catch (e) {
      expect(isNgError(e, "invalid_argument")).toBe(true);
    }

    const custom = setup({ cells: [{ id: "desk" }, { id: "triage" }, { id: "w", parentId: "desk" }], resolveDesk: () => "triage" });
    custom.inbox.enqueueSync("w", msg({ id: "z" }));
    const cb = custom.inbox.claimNextRunSync("w", "k")!;
    custom.inbox.handbackSync(cb.claimId, "z", "r");
    expect(custom.inbox.listMessagesSync({ cellId: "triage" })).toHaveLength(1);
  });
});
