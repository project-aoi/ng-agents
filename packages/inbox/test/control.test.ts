import { describe, expect, it } from "vitest";
import type { ControlAuthorizer } from "@ng/protocol";
import type { ControlEvent } from "../src";
import { msg, setup, T0, timer } from "./helpers";

const tree = [
  { id: "desk" },
  { id: "proj", parentId: "desk" },
  { id: "w1", parentId: "proj" },
  { id: "w2", parentId: "proj" },
  { id: "other", parentId: "desk" },
];

describe("control: cancel", () => {
  it("bumps the epoch of the cell and its subtree, cancels their queued work, and late results are dropped", () => {
    const t = setup({ cells: tree });
    t.inbox.enqueueSync("proj", msg({ id: "p-msg" }));
    t.inbox.enqueueSync("w1", timer("w1-nudge"), { deliverAt: T0 + 60_000, cancelGroup: "g" });
    t.inbox.enqueueSync("w2", timer("w2-poll"), { cron: "*/5 * * * *", tz: "UTC" });
    t.inbox.enqueueSync("other", msg({ id: "untouched" }));
    t.cells.setStatus("w2", "paused");
    t.events.length = 0;

    const res = t.inbox.controlSync("proj", { action: "cancel", principalId: "owner" });
    expect(res).toEqual({ applied: true, epoch: 1 });
    expect(["desk", "proj", "w1", "w2", "other"].map((id) => t.cells.getEpoch(id))).toEqual([0, 1, 1, 1, 0]);
    const statusById = Object.fromEntries(t.inbox.listMessagesSync().map((r) => [r.envelope.id, r.status]));
    expect(statusById).toEqual({ "p-msg": "cancelled", "w1-nudge": "cancelled", untouched: "pending" });
    expect(t.inbox.listSchedulesSync({ activeOnly: true })).toEqual([]);
    expect(t.of("inbox.control")).toEqual([
      { cellId: "proj", action: "cancel", epoch: 1, principalId: "owner" },
      { cellId: "w1", action: "cancel", epoch: 1, principalId: "owner" },
      { cellId: "w2", action: "cancel", epoch: 1, principalId: "owner" },
    ]);
    expect(t.of("cell.changed").map((c) => c.cellId)).toEqual(["proj", "w1", "w2"]);

    // a Job started under epoch 0 reports late: dropped, never wakes the cancelled worker
    t.inbox.enqueueSync("w1", msg({ id: "job-1:result", from: "kernel:workspace", kind: "result", type: "job.result", expectedEpoch: 0,
      payload: { jobId: "job-1", command: "pnpm test", state: "succeeded", exitCode: 0, tail: "ok" } }));
    expect(t.inbox.listMessagesSync({ envelopeId: "job-1:result" })[0]!.status).toBe("dropped_epoch");
    expect(t.inbox.claimNextRunSync("w1", "k")).toBeNull();
  });

  it("stale rows that slipped in before the bump are dropped at claim; a Run released after cancel does not retry its batch", () => {
    const t = setup({ cells: tree });
    t.inbox.enqueueSync("w1", msg({ id: "task", expectedEpoch: 0 }));
    const run = t.inbox.claimNextRunSync("w1", "k")!;
    t.inbox.controlSync("w1", { action: "cancel", principalId: "cell:proj" });
    // the control bypass did not wait for the cell's lock; the kernel now aborts the Run and gives the claim back
    expect(t.inbox.releaseSync(run.claimId, "aborted by cancel")).toEqual({ requeued: 0, dead: 0, cancelled: 1 });
    expect(t.inbox.listMessagesSync({ envelopeId: "task" })[0]).toMatchObject({ status: "cancelled" });
    expect(t.inbox.claimNextRunSync("w1", "k")).toBeNull();

    // the same holds when the aborted Run simply vanishes and its lease runs out
    t.inbox.enqueueSync("w2", msg({ id: "t2" }));
    t.inbox.claimNextRunSync("w2", "k", 1000);
    t.inbox.controlSync("w2", { action: "cancel", principalId: "owner" });
    t.clock.advance(1000);
    t.inbox.tickSync();
    expect(t.inbox.listMessagesSync({ envelopeId: "t2" })[0]!.status).toBe("cancelled");
  });
});

describe("control: authorization and refusal", () => {
  it("runs the injected authorizer and refuses closed/unknown cells", () => {
    const calls: string[] = [];
    const authorizeControl: ControlAuthorizer = (cellId, principalId, action) => {
      calls.push(`${principalId}->${cellId}:${action}`);
      return principalId === "owner" ? { ok: true } : { ok: false, reason: "not allowed by policy" };
    };
    const t = setup({ cells: tree, authorizeControl });
    expect(t.inbox.controlSync("w1", { action: "pause", principalId: "memory:ou_x" })).toEqual({ applied: false, epoch: 0, reason: "not allowed by policy" });
    expect(t.cells.get("w1")!.status).toBe("active");
    expect(t.of("inbox.control")).toEqual([]);
    expect(calls).toEqual(["memory:ou_x->w1:pause"]);

    t.cells.setStatus("w2", "closed");
    expect(t.inbox.controlSync("w2", { action: "cancel", principalId: "owner" })).toEqual({ applied: false, epoch: 0, reason: "closed" });
    expect(t.inbox.controlSync("ghost", { action: "cancel", principalId: "owner" })).toEqual({ applied: false, epoch: -1, reason: "not_found" });
    expect(() => t.inbox.controlSync("w1", { action: "steer", principalId: "owner" })).toThrow(/steerMessage/);
  });

  it("default authorizer: owner anywhere except pausing/cancelling root, a cell only over its strict descendants", () => {
    const t = setup({ cells: tree });
    expect(t.inbox.controlSync("w1", { action: "pause", principalId: "cell:proj" }).applied).toBe(true);
    expect(t.inbox.controlSync("w1", { action: "resume", principalId: "cell:desk" }).applied).toBe(true);
    expect(t.inbox.controlSync("proj", { action: "pause", principalId: "cell:proj" })).toMatchObject({ applied: false });
    expect(t.inbox.controlSync("proj", { action: "pause", principalId: "cell:w1" })).toMatchObject({ applied: false });
    expect(t.inbox.controlSync("other", { action: "cancel", principalId: "member:bob" })).toMatchObject({ applied: false });
    expect(t.inbox.controlSync("desk", { action: "pause", principalId: "owner" })).toMatchObject({ applied: false });
    expect(t.inbox.controlSync("desk", { action: "cancel", principalId: "owner" })).toMatchObject({ applied: false });
    expect(t.inbox.controlSync("other", { action: "pause", principalId: "owner" }).applied).toBe(true);
  });

  it("BUG-020: physically forbids pausing or cancelling the root cell even with a permissive custom authorizer", () => {
    const t = setup({ cells: tree, authorizeControl: () => ({ ok: true }) });
    expect(t.inbox.controlSync("desk", { action: "pause", principalId: "owner" })).toMatchObject({ applied: false, reason: /root cell/ });
    expect(t.inbox.controlSync("desk", { action: "cancel", principalId: "owner" })).toMatchObject({ applied: false, reason: /root cell/ });
    expect(t.cells.get("desk")!.status).toBe("active");
    expect(t.inbox.controlSync("desk", { action: "steer", principalId: "owner", steerMessage: "still ok" }).applied).toBe(true);
  });
});

describe("control: pause / resume", () => {
  it("pauses the subtree (claims return null) and resume re-announces cells with pending work", () => {
    const t = setup({ cells: tree });
    t.inbox.enqueueSync("proj", msg());
    t.inbox.enqueueSync("w1", msg());
    t.inbox.enqueueSync("w2", timer("later"), { deliverAt: T0 + 60_000 });
    t.events.length = 0;

    expect(t.inbox.controlSync("proj", { action: "pause", principalId: "owner" })).toEqual({ applied: true, epoch: 0 });
    expect(["proj", "w1", "w2", "other"].map((id) => t.cells.get(id)!.status)).toEqual(["paused", "paused", "paused", "active"]);
    expect(t.inbox.claimNextRunSync("proj", "k")).toBeNull();
    expect(t.inbox.claimNextRunSync("w1", "k")).toBeNull();
    expect(t.inbox.dueCellIdsSync()).toEqual([]);
    expect(t.of("inbox.control").map((e) => `${e.cellId}:${e.action}`)).toEqual(["proj:pause", "w1:pause", "w2:pause"]);

    t.clock.advance(60_000);
    t.events.length = 0;
    expect(t.inbox.tickSync().dueCellIds).toEqual([]); // came due while paused: not announced yet
    expect(t.takeWakes()).toEqual([]);

    expect(t.inbox.controlSync("proj", { action: "resume", principalId: "owner" })).toEqual({ applied: true, epoch: 0 });
    expect(["proj", "w1", "w2"].map((id) => t.cells.get(id)!.status)).toEqual(["active", "active", "active"]);
    const wakes = t.takeWakes();
    expect(wakes).toEqual(["proj:resumed", "w1:resumed", "w2:resumed"]);
    expect(t.inbox.claimNextRunSync("w2", "k")!.envelopes.map((e) => e.id)).toEqual(["later"]);
  });
});

describe("control: steer", () => {
  it("is taken mid-run by drainSteer and does not start a second Run", () => {
    const t = setup({ cells: tree });
    const seen: ControlEvent[] = [];
    const order: string[] = [];
    t.inbox.onControl((e) => {
      seen.push(e);
      order.push("listener");
    });
    t.bus.on("inbox.control", () => order.push("bus"));

    t.inbox.enqueueSync("w1", msg({ id: "fix-bug" }));
    const run = t.inbox.claimNextRunSync("w1", "kernel")!;
    expect(t.inbox.drainSteerSync("w1", run.claimId)).toEqual([]);

    const res = t.inbox.controlSync("w1", { action: "steer", principalId: "owner", steerMessage: "先别改测试，只修实现" });
    expect(res).toEqual({ applied: true, epoch: 0 });
    expect(order).toEqual(["listener", "bus"]);
    expect(seen[0]).toMatchObject({ cellId: "w1", action: "steer", steerMessage: "先别改测试，只修实现", cells: [{ cellId: "w1", epoch: 0 }] });
    expect(seen[0]!.steerEnvelopeId).toMatch(/^steer_/);
    // the Run holds the lock: the steer is not a new batch
    expect(t.inbox.claimNextRunSync("w1", "kernel")).toBeNull();

    t.inbox.controlSync("w1", { action: "steer", principalId: "owner", steerMessage: "还有，用中文写 commit" });
    const drained = t.inbox.drainSteerSync("w1", run.claimId);
    expect(drained.map((s) => s.message)).toEqual(["先别改测试，只修实现", "还有，用中文写 commit"]);
    expect(t.inbox.drainSteerSync("w1", run.claimId)).toEqual([]);
    const steerRows = t.inbox.listMessagesSync({ type: "control.steer" });
    // BUG-026: claimed by the active run (not prematurely done) until the run finishes cleanly.
    expect(steerRows.map((r) => [r.status, r.claimId])).toEqual([
      ["claimed", run.claimId],
      ["claimed", run.claimId],
    ]);
    expect(steerRows[0]!.envelope).toMatchObject({ from: "kernel:control", principalId: "owner", expectedEpoch: 0, to: "inbox:w1" });

    t.inbox.completeSync(run.claimId);
    expect(t.inbox.listMessagesSync({ type: "control.steer" }).map((r) => r.status)).toEqual(["done", "done"]);
    expect(t.inbox.claimNextRunSync("w1", "kernel")).toBeNull();
  });

  it("wakes an idle cell normally and becomes its next batch", () => {
    const t = setup({ cells: tree });
    t.inbox.controlSync("w2", { action: "steer", principalId: "cell:proj", steerMessage: "换个方向：先查日志" });
    expect(t.takeWakes()).toEqual(["w2:enqueued"]);
    expect(t.inbox.drainSteerSync("w2", "no-run")).toEqual([]); // no Run in flight: leave it for the normal wake-up
    const batch = t.inbox.claimNextRunSync("w2", "k")!;
    expect(batch.envelopes.map((e) => [e.type, (e.payload as { message: string }).message])).toEqual([["control.steer", "换个方向：先查日志"]]);
  });

  it("a steer queued after a cancel is not drained into the Run being aborted", () => {
    const t = setup({ cells: tree });
    t.inbox.enqueueSync("w1", msg());
    const old = t.inbox.claimNextRunSync("w1", "k")!;
    t.inbox.controlSync("w1", { action: "cancel", principalId: "owner" });
    t.inbox.controlSync("w1", { action: "steer", principalId: "owner", steerMessage: "重新开始" });
    expect(t.inbox.drainSteerSync("w1", old.claimId)).toEqual([]);
    t.inbox.completeSync(old.claimId);
    const next = t.inbox.claimNextRunSync("w1", "k")!;
    expect(next.epoch).toBe(1);
    expect(next.envelopes.map((e) => e.type)).toEqual(["control.steer"]);
  });

  it("BUG-026: requeueClaimedSync returns unconfirmed claimed steers to pending without touching confirmed ones", () => {
    const t = setup({ cells: tree });
    t.inbox.enqueueSync("w1", msg({ id: "task" }));
    const run = t.inbox.claimNextRunSync("w1", "k")!;
    t.inbox.controlSync("w1", { action: "steer", principalId: "owner", steerMessage: "steer-1" });
    t.inbox.controlSync("w1", { action: "steer", principalId: "owner", steerMessage: "steer-2" });
    const drained = t.inbox.drainSteerSync("w1", run.claimId);
    expect(drained).toHaveLength(2);
    // Suppose steer-1 was confirmed, steer-2 failed to write to stdin and must be requeued.
    expect(t.inbox.requeueClaimedSync(run.claimId, [drained[1]!.envelope.id], "stdin closed")).toBe(1);
    t.inbox.completeSync(run.claimId);
    expect(t.inbox.listMessagesSync({ envelopeId: drained[0]!.envelope.id })[0]!.status).toBe("done");
    expect(t.inbox.listMessagesSync({ envelopeId: drained[1]!.envelope.id })[0]!.status).toBe("pending");
    const next = t.inbox.claimNextRunSync("w1", "k")!;
    expect(next.envelopes.map((e) => e.id)).toEqual([drained[1]!.envelope.id]);
  });
});
