import { describe, expect, it, vi } from "vitest";
import { ManualClock, createBus, newId, systemClock } from "../src";

describe("bus", () => {
  it("delivers to topic and wildcard handlers, and unsubscribes", () => {
    const bus = createBus();
    const got: string[] = [];
    const off = bus.on("inbox.enqueued", (d) => got.push(`topic:${d.cellId}:${d.reason}`));
    bus.on("*", (topic, d) => got.push(`*:${topic}:${JSON.stringify(d)}`));
    bus.emit("inbox.enqueued", { cellId: "desk", reason: "enqueued" });
    off();
    bus.emit("inbox.enqueued", { cellId: "w1", reason: "due" });
    expect(got).toEqual([
      "topic:desk:enqueued",
      '*:inbox.enqueued:{"cellId":"desk","reason":"enqueued"}',
      '*:inbox.enqueued:{"cellId":"w1","reason":"due"}',
    ]);
  });

  it("isolates a throwing handler", () => {
    const onError = vi.fn();
    const bus = createBus({ onError });
    const later = vi.fn();
    bus.on("state.changed", () => {
      throw new Error("bad handler");
    });
    bus.on("state.changed", later);
    bus.emit("state.changed", { cellId: "desk", keys: ["k"] });
    expect(later).toHaveBeenCalledWith({ cellId: "desk", keys: ["k"] });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("ManualClock", () => {
  it("advances, sets, notifies and refuses to go back", () => {
    const c = new ManualClock(100);
    const seen: number[] = [];
    const off = c.subscribe((t) => seen.push(t));
    expect(c.advance(50)).toBe(150);
    c.set(1_000);
    off();
    c.advance(1);
    expect(c.now()).toBe(1_001);
    expect(seen).toEqual([150, 1_000]);
    expect(() => c.set(10)).toThrow(RangeError);
    expect(() => c.advance(-1)).toThrow(RangeError);
  });

  it("systemClock reads wall time", () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1_000);
  });
});

describe("newId", () => {
  it("is prefixed, unique and sorts in creation order even within one millisecond", () => {
    const c = new ManualClock(1_700_000_000_000);
    const ids = Array.from({ length: 500 }, () => newId("env", c));
    c.advance(1);
    ids.push(newId("env", c));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]).toMatch(/^env_[0-9a-z]{22}$/);
    expect(() => newId("Bad-Prefix")).toThrow();
  });
});
