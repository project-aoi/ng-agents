import { describe, expect, it } from "vitest";
import { withTx, type CellInsert } from "@ng/protocol";
import { msg, setup } from "./helpers";

const MIN = 60_000;

/** An inbox whose monotonic clock the test moves by hand, next to the ManualClock wall time. */
function sleepy(cells: CellInsert[] = [{ id: "desk" }]) {
  let mono = 0;
  const t = setup({ cells, monotonicNow: () => mono });
  return {
    ...t,
    /** Both clocks move: real time passed with the host awake. */
    awake(ms: number) {
      mono += ms;
      t.clock.advance(ms);
    },
    /** The lid was closed: wall time jumps by `wallMs`, the monotonic clock only by `monoMs`. */
    suspend(wallMs: number, monoMs = 1_000) {
      mono += monoMs;
      t.clock.advance(wallMs);
    },
  };
}

describe("host suspend vs. lease expiry", () => {
  it("a 31-minute suspend pushes active leases forward instead of expiring them (the batch is delivered once)", () => {
    const t = sleepy();
    t.inbox.enqueueSync("desk", msg({ id: "m1" }));
    const batch = t.inbox.claimNextRunSync("desk", "kernel", 10 * MIN)!;

    t.suspend(31 * MIN);
    const slept = 31 * MIN - 1_000;
    expect(t.inbox.tickSync().expiredClaims).toBe(0);
    expect(t.inbox.getClaimSync(batch.claimId)).toMatchObject({ status: "active", leaseExpiresAt: batch.leaseExpiresAt + slept });
    expect(t.inbox.listMessagesSync()[0]).toMatchObject({ status: "claimed", attempts: 0 });
    expect(t.inbox.lastSuspendSync()).toEqual({ at: t.clock.now(), sleptMs: slept });
    // The Run lost only the second the host was awake: the rest of its lease is still ahead of it.
    expect(t.inbox.getClaimSync(batch.claimId)!.leaseExpiresAt - t.clock.now()).toBe(10 * MIN - 1_000);

    // Once that awake time is used up without a renewal, the lease expires as usual.
    t.awake(10 * MIN);
    expect(t.inbox.tickSync().expiredClaims).toBe(1);
    expect(t.inbox.getClaimSync(batch.claimId)).toMatchObject({ status: "expired", releaseReason: "lease expired" });
  });

  it("time that really passed (both clocks moved 11 minutes) expires the lease exactly as before", () => {
    const t = sleepy();
    t.inbox.enqueueSync("desk", msg());
    const batch = t.inbox.claimNextRunSync("desk", "kernel", 10 * MIN)!;
    t.awake(11 * MIN);
    expect(t.inbox.tickSync()).toEqual({ fired: 0, dueCellIds: ["desk"], expiredClaims: 1 });
    expect(t.inbox.getClaimSync(batch.claimId)).toMatchObject({ status: "expired", leaseExpiresAt: batch.leaseExpiresAt });
    expect(t.inbox.listMessagesSync()[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(t.inbox.lastSuspendSync()).toBeNull();
  });

  it("a skew of a few seconds is jitter, not a suspend", () => {
    const t = sleepy();
    t.inbox.enqueueSync("desk", msg());
    const batch = t.inbox.claimNextRunSync("desk", "kernel", 10 * MIN)!;
    t.suspend(10 * MIN + 1_000, 10 * MIN - 3_000); // 4 s unexplained
    expect(t.inbox.tickSync().expiredClaims).toBe(1);
    expect(t.inbox.getClaimSync(batch.claimId)!.status).toBe("expired");
    expect(t.inbox.lastSuspendSync()).toBeNull();
  });

  it("the lazy expiry in claimNextRunSync absorbs the suspend too: the cell stays held by its Run", () => {
    const t = sleepy();
    t.inbox.enqueueSync("desk", msg({ id: "first" }));
    const batch = t.inbox.claimNextRunSync("desk", "kernel", 10 * MIN)!;
    t.inbox.enqueueSync("desk", msg({ id: "arrived before the lid closed" }));
    t.suspend(31 * MIN);
    expect(t.inbox.claimNextRunSync("desk", "kernel", 10 * MIN)).toBeNull();
    expect(t.inbox.getClaimSync(batch.claimId)!.status).toBe("active");
    expect(t.inbox.lastSuspendSync()!.sleptMs).toBe(31 * MIN - 1_000);
    // ...and the first tick after that does not add the same suspend a second time.
    const lease = t.inbox.getClaimSync(batch.claimId)!.leaseExpiresAt;
    t.awake(1_000);
    t.inbox.tickSync();
    expect(t.inbox.getClaimSync(batch.claimId)!.leaseExpiresAt).toBe(lease);
  });

  it("a suspend is absorbed even when nothing is due yet, so a long lease keeps the time it slept through", () => {
    const t = sleepy();
    t.inbox.enqueueSync("desk", msg());
    const batch = t.inbox.claimNextRunSync("desk", "kernel", 60 * MIN)!;
    t.suspend(31 * MIN);
    expect(t.inbox.tickSync().expiredClaims).toBe(0); // the lease was not due: the cheap path would have skipped it
    t.awake(30 * MIN); // past the original wall-clock expiry, within the lease's awake time
    expect(t.inbox.tickSync().expiredClaims).toBe(0);
    expect(t.inbox.getClaimSync(batch.claimId)!.status).toBe("active");
  });

  it("a lease renewed right after wake-up is not extended again; the other claims are", () => {
    const t = sleepy([{ id: "desk" }, { id: "a", parentId: "desk" }]);
    t.inbox.enqueueSync("desk", msg());
    t.inbox.enqueueSync("a", msg());
    const d = t.inbox.claimNextRunSync("desk", "kernel", 10 * MIN)!;
    const a = t.inbox.claimNextRunSync("a", "kernel", 10 * MIN)!;
    t.suspend(31 * MIN);
    expect(t.inbox.renewLeaseSync(a.claimId, 10 * MIN)).toBe(true);
    expect(t.inbox.getClaimSync(a.claimId)!.leaseExpiresAt).toBe(t.clock.now() + 10 * MIN);
    expect(t.inbox.getClaimSync(d.claimId)!.leaseExpiresAt).toBe(d.leaseExpiresAt + 31 * MIN - 1_000);
    expect(t.inbox.tickSync().expiredClaims).toBe(0);
    expect(t.inbox.getClaimSync(a.claimId)!.leaseExpiresAt).toBe(t.clock.now() + 10 * MIN);
  });

  it("an extension rolled back with its transaction is found again by the next check", () => {
    const t = sleepy();
    t.inbox.enqueueSync("desk", msg());
    const batch = t.inbox.claimNextRunSync("desk", "kernel", 10 * MIN)!;
    t.suspend(31 * MIN);
    expect(() =>
      withTx(t.db, () => {
        t.inbox.tickSync();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(t.inbox.getClaimSync(batch.claimId)).toMatchObject({ status: "active", leaseExpiresAt: batch.leaseExpiresAt });
    expect(t.inbox.lastSuspendSync()).toBeNull();
    expect(t.inbox.tickSync().expiredClaims).toBe(0);
    expect(t.inbox.getClaimSync(batch.claimId)!.leaseExpiresAt).toBe(batch.leaseExpiresAt + 31 * MIN - 1_000);
  });

  it("with a manual clock and no monotonic source, a wall jump is deliberate and expires leases as it always did", () => {
    const t = setup();
    t.inbox.enqueueSync("desk", msg());
    const batch = t.inbox.claimNextRunSync("desk", "kernel", 10 * MIN)!;
    t.clock.advance(31 * MIN);
    expect(t.inbox.tickSync().expiredClaims).toBe(1);
    expect(t.inbox.getClaimSync(batch.claimId)!.status).toBe("expired");
    expect(t.inbox.lastSuspendSync()).toBeNull();
  });
});
