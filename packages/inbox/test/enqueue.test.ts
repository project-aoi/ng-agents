import { describe, expect, it } from "vitest";
import { isNgError, withTx, type InboxWriter } from "@ng/protocol";
import { msg, setup, timer } from "./helpers";

describe("enqueue", () => {
  it("is idempotent on (cellId, envelope id) and stores `to`", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "w1", parentId: "desk" }] });
    const env = msg({ id: "webhook-123" });
    expect(t.inbox.enqueueSync("desk", env)).toBe("accepted");
    expect(t.inbox.enqueueSync("desk", { ...env, payload: { text: "changed" } })).toBe("deduped");
    // the same transport id for a different cell is a different message
    expect(t.inbox.enqueueSync("w1", env)).toBe("accepted");

    const rows = t.inbox.listMessagesSync({ cellId: "desk" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.envelope).toMatchObject({ id: "webhook-123", to: "inbox:desk", payload: { text: env.payload && (env.payload as { text: string }).text } });
    expect(rows[0]!.status).toBe("pending");
    expect(t.takeWakes()).toEqual(["desk:enqueued", "w1:enqueued"]);
  });

  it("dedupes concurrent redelivery inside one outer transaction too", () => {
    const t = setup();
    const env = msg();
    const results = withTx(t.db, () => [t.inbox.enqueueSync("desk", env), t.inbox.enqueueSync("desk", env)]);
    expect(results).toEqual(["accepted", "deduped"]);
    expect(t.inbox.listMessagesSync()).toHaveLength(1);
  });

  it("quarantines unknown types and invalid payloads; they are never delivered", () => {
    const t = setup();
    expect(t.inbox.enqueueSync("desk", msg({ id: "x1", type: "evil.unknown", payload: { cmd: "rm -rf" } }))).toBe("accepted");
    expect(t.inbox.enqueueSync("desk", msg({ id: "x2", type: "user.message", payload: { text: 42 } }))).toBe("accepted");
    const rows = t.inbox.listMessagesSync({ status: ["quarantined"] });
    expect(rows.map((r) => r.envelope.id)).toEqual(["x1", "x2"]);
    expect(rows[0]!.statusReason).toMatch(/^unknown_type/);
    expect(rows[1]!.statusReason).toMatch(/^invalid/);
    expect(t.takeWakes()).toEqual([]);
    expect(t.inbox.dueCellIdsSync()).toEqual([]);
    expect(t.inbox.claimNextRunSync("desk", "w", "serial_coalesce")).toBeNull();
    expect(t.inbox.pendingCountsSync(["desk"])).toEqual({ desk: 0 });
  });

  it("stores already-stale envelopes as dropped_epoch and closed-cell envelopes as cancelled", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "w1", parentId: "desk" }, { id: "w2", parentId: "desk" }] });
    t.cells.bumpEpoch("w1"); // epoch 1
    t.inbox.enqueueSync("w1", msg({ id: "late", kind: "result", expectedEpoch: 0 }));
    t.inbox.enqueueSync("w1", msg({ id: "fresh", expectedEpoch: 1 }));
    t.cells.setStatus("w2", "closed");
    t.inbox.enqueueSync("w2", msg({ id: "to-closed" }));
    const byId = Object.fromEntries(t.inbox.listMessagesSync().map((r) => [r.envelope.id, r.status]));
    expect(byId).toEqual({ late: "dropped_epoch", fresh: "pending", "to-closed": "cancelled" });
    expect(t.takeWakes()).toEqual(["w1:enqueued"]);
  });

  it("announces only claimable work: not future rows, not silent_inject, not paused cells", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "p", status: "paused" }] });
    t.inbox.enqueueSync("desk", msg(), { deliverAt: t.clock.now() + 60_000 });
    t.inbox.enqueueSync("desk", msg({ delivery: "silent_inject" }));
    t.inbox.enqueueSync("p", msg());
    expect(t.takeWakes()).toEqual([]);
    t.inbox.enqueueSync("desk", msg(), { deliverAt: t.clock.now() - 5 }); // past deliverAt = due now
    expect(t.takeWakes()).toEqual(["desk:enqueued"]);
  });

  it("emits nothing when the caller's transaction rolls back (InboxWriter inside Context.commit)", () => {
    const t = setup();
    const writer: InboxWriter = t.inbox;
    expect(() =>
      withTx(t.db, () => {
        writer.enqueueSync("desk", msg({ id: "rolled" }));
        throw new Error("artifact conflict");
      }),
    ).toThrow("artifact conflict");
    expect(t.inbox.listMessagesSync()).toEqual([]);
    expect(t.takeWakes()).toEqual([]);

    withTx(t.db, () => {
      writer.enqueueSync("desk", msg({ id: "kept" }));
      expect(t.takeWakes()).toEqual([]); // not before commit
    });
    expect(t.takeWakes()).toEqual(["desk:enqueued"]);
  });

  it("rejects malformed input", () => {
    const t = setup();
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return isNgError(e) ? e.code : String(e);
      }
      return "no error";
    };
    expect(code(() => t.inbox.enqueueSync("nope", msg()))).toBe("not_found");
    expect(code(() => t.inbox.enqueueSync("desk", msg({ id: "" })))).toBe("invalid_argument");
    expect(code(() => t.inbox.enqueueSync("desk", msg({ kind: "weird" as "event" })))).toBe("invalid_argument");
    expect(code(() => t.inbox.enqueueSync("desk", msg(), { deliverAt: 1, idleSec: 5 }))).toBe("invalid_argument");
    expect(code(() => t.inbox.enqueueSync("desk", msg(), { idleSec: 0 }))).toBe("invalid_argument");
    expect(code(() => t.inbox.enqueueSync("desk", timer("bad-cron"), { cron: "every day" }))).toBe("invalid_argument");
    expect(code(() => t.inbox.enqueueSync("desk", timer("bad-tz"), { cron: "0 9 * * *", tz: "Mars/Olympus" }))).toBe("invalid_argument");
    // a schedule template must be a valid payload: a bad one would quarantine every firing
    expect(code(() => t.inbox.enqueueSync("desk", msg({ type: "nope.nope" }), { cron: "0 9 * * *" }))).toBe("invalid_argument");
    expect(t.inbox.listMessagesSync()).toEqual([]);
    expect(t.inbox.listSchedulesSync()).toEqual([]);
  });

  it("the async contract methods delegate and reject instead of throwing", async () => {
    const t = setup();
    await expect(t.inbox.enqueue("desk", msg({ id: "a" }))).resolves.toBe("accepted");
    await expect(t.inbox.enqueue("desk", msg({ id: "a" }))).resolves.toBe("deduped");
    await expect(t.inbox.enqueue("ghost", msg())).rejects.toMatchObject({ code: "not_found" });
    const batch = await t.inbox.claimNextRun("desk", "w", "serial_coalesce");
    expect(batch?.envelopes.map((e) => e.id)).toEqual(["a"]);
    await t.inbox.complete(batch!.claimId);
    expect(t.inbox.listMessagesSync()[0]!.status).toBe("done");
  });
});
