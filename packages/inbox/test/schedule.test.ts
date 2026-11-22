import { describe, expect, it, vi } from "vitest";
import { cellsRepo, createBus, openDatabase, systemClock, type TimerFiredPayload } from "@ng/protocol";
import { createInbox } from "../src";
import { msg, setup, T0, timer } from "./helpers";

const MIN = 60_000;

describe("deliverAt", () => {
  it("is not claimable early, becomes claimable after the clock advances, and the tick announces it once", () => {
    const t = setup();
    t.inbox.enqueueSync("desk", timer("remind-dentist", "提醒：给牙医打电话"), { deliverAt: T0 + 30 * MIN });
    expect(t.takeWakes()).toEqual([]);
    expect(t.inbox.dueCellIdsSync()).toEqual([]);
    expect(t.inbox.nextWakeAtSync()).toBe(T0 + 30 * MIN);
    expect(t.inbox.listMessagesSync({ deliverAfter: t.clock.now() }).map((r) => r.envelope.id)).toEqual(["remind-dentist"]);

    t.clock.advance(30 * MIN - 1);
    expect(t.inbox.claimNextRunSync("desk", "k")).toBeNull();
    expect(t.inbox.tickSync().dueCellIds).toEqual([]);

    t.clock.advance(1);
    expect(t.inbox.dueCellIdsSync()).toEqual(["desk"]);
    expect(t.inbox.tickSync()).toEqual({ fired: 0, dueCellIds: ["desk"], expiredClaims: 0 });
    expect(t.takeWakes()).toEqual(["desk:due"]);
    expect(t.inbox.tickSync().dueCellIds).toEqual([]); // announced once
    expect(t.takeWakes()).toEqual([]);
    expect(t.inbox.nextWakeAtSync()).toBeNull();

    const batch = t.inbox.claimNextRunSync("desk", "k")!;
    expect(batch.envelopes.map((e) => e.id)).toEqual(["remind-dentist"]);
  });

  it("announces a timer created after a wall-clock rollback once", () => {
    let wall = T0;
    const t = setup();
    t.clock.now=()=>wall;
    t.inbox.tickSync();
    wall-=60_000;
    t.inbox.enqueueSync("desk",timer("rolled","wake"),{deliverAt:wall+5000});
    expect(t.inbox.nextWakeAtSync()).toBe(wall+5000);
    wall+=5000;
    expect(t.inbox.tickSync().dueCellIds).toEqual(["desk"]);
    expect(t.inbox.tickSync().dueCellIds).toEqual([]);
  });

  it.each(["immediate", "retried"])("announces an %s envelope after the clock catches up to its creation time", (mode) => {
    const t = setup();
    let wall = T0;
    t.clock.now = () => wall;
    t.inbox.tickSync();
    t.inbox.enqueueSync("desk", msg({ id: mode }));
    const claim = mode === "retried" && t.inbox.claimNextRunSync("desk", "k");
    wall -= MIN;
    if (claim) t.inbox.releaseSync(claim.claimId, "retry", { retryAt: wall + 1000 });
    expect(t.inbox.dueCellIdsSync()).toEqual([]);
    expect(t.inbox.nextWakeAtSync()).toBe(T0);
    wall = T0;
    expect(t.inbox.tickSync().dueCellIds).toEqual(["desk"]);
    expect(t.inbox.tickSync().dueCellIds).toEqual([]);
    expect(t.inbox.claimNextRunSync("desk", "k")?.envelopes[0]?.id).toBe(mode);
  });

  it("is cheap and quiet when nothing is due", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "w", parentId: "desk" }] });
    expect(t.inbox.nextWakeAtSync()).toBeNull();
    expect(t.inbox.dueCellIdsSync()).toEqual([]);
    expect(t.inbox.tickSync()).toEqual({ fired: 0, dueCellIds: [], expiredClaims: 0 });
    expect(t.events).toEqual([]);
  });

  it("orders dueCellIds by the oldest waiting message", () => {
    const t = setup({ cells: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    t.inbox.enqueueSync("b", msg());
    t.inbox.enqueueSync("c", msg());
    t.inbox.enqueueSync("a", msg());
    t.inbox.enqueueSync("b", msg());
    expect(t.inbox.dueCellIdsSync()).toEqual(["b", "c", "a"]);
  });
});

describe("cancelScheduled", () => {
  it("a cancelGroup clears a pending timeout nudge when the other side replies early", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "watch", parentId: "desk" }] });
    t.inbox.enqueueSync("watch", timer("nudge-1", "超时催问：报价"), { deliverAt: T0 + 24 * 60 * MIN, cancelGroup: "quote:acme" });
    t.inbox.enqueueSync("watch", timer("nudge-2", "二次催问"), { deliverAt: T0 + 48 * 60 * MIN, cancelGroup: "quote:acme" });
    t.inbox.enqueueSync("watch", timer("other", "无关提醒"), { deliverAt: T0 + 24 * 60 * MIN, cancelGroup: "quote:other" });

    expect(t.inbox.cancelScheduledSync({ cellId: "watch", cancelGroup: "quote:acme" })).toBe(2);
    t.clock.advance(48 * 60 * MIN);
    t.inbox.tickSync();
    const batch = t.inbox.claimNextRunSync("watch", "k")!;
    expect(batch.envelopes.map((e) => e.id)).toEqual(["other"]);
    const cancelled = t.inbox.listMessagesSync({ cellId: "watch", status: ["cancelled"] });
    expect(cancelled.map((r) => r.envelope.id)).toEqual(["nudge-1", "nudge-2"]);
  });

  it("matches by envelopeId (message or schedule template), and with no filter clears everything pending", () => {
    const t = setup();
    t.inbox.enqueueSync("desk", timer("r1"), { deliverAt: T0 + MIN });
    t.inbox.enqueueSync("desk", timer("r2"), { deliverAt: T0 + MIN });
    t.inbox.enqueueSync("desk", timer("poll"), { cron: "*/5 * * * *", tz: "UTC" });
    t.inbox.enqueueSync("desk", msg({ id: "chat" }));

    expect(t.inbox.cancelScheduledSync({ cellId: "desk", envelopeId: "r1" })).toBe(1);
    t.clock.advance(5 * MIN);
    t.inbox.tickSync(); // `poll` fires once
    expect(t.inbox.cancelScheduledSync({ cellId: "desk", envelopeId: "poll" })).toBe(2); // the rule + its pending firing
    expect(t.inbox.listSchedulesSync({ activeOnly: true })).toEqual([]);
    expect(t.inbox.cancelScheduledSync({ cellId: "desk", envelopeId: "nothing" })).toBe(0);
    expect(t.inbox.cancelScheduledSync({ cellId: "desk" })).toBe(2); // r2 + chat
    expect(t.inbox.pendingCountsSync()).toEqual({});
  });
});

describe("cron", () => {
  it("fires at each occurrence of the injected clock, with deterministic ids and the schedule stamped into timer.fired", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "sensor", parentId: "desk" }] });
    expect(t.inbox.enqueueSync("sensor", timer("sensor:schedule:0", "早 9 点查指标"), { cron: "0 9 * * *", tz: "UTC" })).toBe("accepted");
    expect(t.inbox.enqueueSync("sensor", timer("sensor:schedule:0", "早 9 点查指标"), { cron: "0 9 * * *", tz: "UTC" })).toBe("deduped");
    const [rule] = t.inbox.listSchedulesSync({ cellId: "sensor" });
    expect(rule).toMatchObject({ cron: "0 9 * * *", tz: "UTC", active: true, nextFireAt: T0 + 60 * MIN });
    expect(t.inbox.nextWakeAtSync()).toBe(T0 + 60 * MIN);

    t.clock.advance(59 * MIN);
    expect(t.inbox.tickSync().fired).toBe(0);
    t.clock.advance(MIN);
    expect(t.inbox.tickSync()).toEqual({ fired: 1, dueCellIds: ["sensor"], expiredClaims: 0 });
    expect(t.takeWakes()).toEqual(["sensor:due"]);
    expect(t.inbox.tickSync().fired).toBe(0); // a second tick at the same instant cannot double-fire

    const fireAt = T0 + 60 * MIN;
    const batch = t.inbox.claimNextRunSync("sensor", "k")!;
    expect(batch.envelopes).toHaveLength(1);
    const env = batch.envelopes[0]!;
    expect(env.id).toBe(`sensor:schedule:0@${fireAt}`);
    expect(env.to).toBe("inbox:sensor");
    expect(env.payload as TimerFiredPayload).toEqual({ label: "早 9 点查指标", scheduleId: rule!.id, firedAt: fireAt });
    t.inbox.completeSync(batch.claimId);

    expect(t.inbox.listSchedulesSync()[0]).toMatchObject({ lastFiredAt: fireAt, nextFireAt: fireAt + 24 * 60 * MIN });
    t.clock.advance(24 * 60 * MIN);
    expect(t.inbox.tickSync().fired).toBe(1);
    expect(t.inbox.listMessagesSync({ cellId: "sensor" }).map((r) => r.envelope.id)).toEqual([
      `sensor:schedule:0@${fireAt}`,
      `sensor:schedule:0@${fireAt + 24 * 60 * MIN}`,
    ]);
  });

  it("coalesces missed occurrences into one firing and honours tz", () => {
    const t = setup();
    // 09:00 in Shanghai = 01:00 UTC; T0 is 08:00 UTC, so the first occurrence is tomorrow 01:00 UTC
    t.inbox.enqueueSync("desk", timer("cn-morning"), { cron: "0 9 * * *", tz: "Asia/Shanghai" });
    expect(t.inbox.nextWakeAtSync()).toBe(Date.UTC(2026, 0, 6, 1, 0, 0));

    t.inbox.enqueueSync("desk", timer("every5"), { cron: "*/5 * * * *", tz: "UTC" });
    t.clock.advance(60 * MIN); // twelve occurrences missed (e.g. the process was down)
    expect(t.inbox.tickSync().fired).toBe(1);
    expect(t.inbox.listMessagesSync({ type: "timer.fired" }).map((r) => r.envelope.id)).toEqual([`every5@${T0 + 5 * MIN}`]);
    const every5 = t.inbox.listSchedulesSync().find((s) => s.template.id === "every5")!;
    expect(every5.nextFireAt).toBe(T0 + 65 * MIN);
  });

  it("skips firings while the cell is paused and stops for a closed cell", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "s", parentId: "desk" }] });
    t.inbox.enqueueSync("s", timer("tick"), { cron: "*/10 * * * *", tz: "UTC" });
    t.cells.setStatus("s", "paused");
    t.clock.advance(10 * MIN);
    expect(t.inbox.tickSync().fired).toBe(0);
    expect(t.inbox.listSchedulesSync()[0]!.nextFireAt).toBe(T0 + 20 * MIN);
    t.cells.setStatus("s", "active");
    t.clock.advance(10 * MIN);
    expect(t.inbox.tickSync().fired).toBe(1);
    t.cells.setStatus("s", "closed");
    t.clock.advance(10 * MIN);
    expect(t.inbox.tickSync().fired).toBe(0);
    expect(t.inbox.listSchedulesSync()[0]!.active).toBe(false);
    expect(t.inbox.nextWakeAtSync()).toBeNull();
  });

  it("a deactivated schedule can be re-created under the same template id", () => {
    const t = setup();
    t.inbox.enqueueSync("desk", timer("desk:schedule:0"), { cron: "0 * * * *", tz: "UTC" });
    t.inbox.cancelScheduledSync({ cellId: "desk", envelopeId: "desk:schedule:0" });
    expect(t.inbox.enqueueSync("desk", timer("desk:schedule:0"), { cron: "30 * * * *", tz: "UTC" })).toBe("accepted");
    const rules = t.inbox.listSchedulesSync();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ cron: "30 * * * *", active: true, nextFireAt: T0 + 30 * MIN });
  });
});


describe("start()/stop() with the system clock", () => {
  it("re-arms an immediate row when the wall clock rolls back between its announcement and its claim", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const db = openDatabase(":memory:");
    const bus = createBus();
    cellsRepo(db, systemClock).insert({id:"desk"});
    const inbox = createInbox({db,bus,clock:systemClock});
    const reasons: string[] = [];
    bus.on("inbox.enqueued", event => reasons.push(event.reason));
    try {
      inbox.start();
      inbox.enqueueSync("desk", msg({id:"immediate"}));
      vi.setSystemTime(T0 - MIN);
      expect(inbox.claimNextRunSync("desk","k")).toBeNull();
      vi.advanceTimersByTime(MIN);
      expect(reasons.at(-1)).toBe("due");
      expect(inbox.claimNextRunSync("desk","k")?.envelopes[0]?.id).toBe("immediate");
    } finally {
      inbox.stop();
      db.close();
      vi.useRealTimers();
    }
  });

  it("sleeps until the next wake-up with one timer and announces the delayed message", async () => {
    const db = openDatabase(":memory:");
    const bus = createBus();
    cellsRepo(db, systemClock).insert({ id: "desk" });
    const inbox = createInbox({ db, bus, clock: systemClock });
    const wakes: string[] = [];
    bus.on("inbox.enqueued", (e) => wakes.push(`${e.cellId}:${e.reason}`));
    inbox.start();
    try {
      // scheduled after start(): the running timer must be re-armed to the earlier instant
      inbox.enqueueSync("desk", timer("soon"), { deliverAt: Date.now() + 40 });
      inbox.enqueueSync("desk", timer("cron"), { cron: "0 0 1 1 *", tz: "UTC" });
      expect(wakes).toEqual([]);
      await new Promise((r) => setTimeout(r, 150));
      expect(wakes).toEqual(["desk:due"]);
      expect(inbox.claimNextRunSync("desk", "k")!.envelopes.map((e) => e.id)).toEqual(["soon"]);
    } finally {
      inbox.stop();
      db.close();
    }
  });
});

describe("start()/stop() with a ManualClock", () => {
  it("ticks by itself when the injected clock passes the next wake-up, announces leftovers on start, and stops", () => {
    const t = setup({ cells: [{ id: "desk" }, { id: "w", parentId: "desk" }] });
    t.inbox.enqueueSync("w", msg({ id: "left-over" })); // e.g. written before this process started
    t.inbox.enqueueSync("desk", timer("r"), { deliverAt: T0 + MIN });
    t.takeWakes();

    t.inbox.start();
    expect(t.takeWakes()).toEqual(["w:due"]);
    t.clock.advance(MIN);
    expect(t.takeWakes()).toEqual(["desk:due"]);

    t.inbox.stop();
    t.inbox.enqueueSync("desk", timer("r2"), { deliverAt: t.clock.now() + MIN });
    t.clock.advance(MIN);
    expect(t.takeWakes()).toEqual([]);
  });
});
