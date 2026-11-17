import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PAYLOAD,
  createEnvelope,
  isEnvelopeOfType,
  isNgError,
  isRegisteredPayloadType,
  listPayloadTypes,
  registerPayloadType,
  validatePayload,
} from "../src";
import { ManualClock } from "../src/clock";

describe("payload registry", () => {
  it("registers every built-in kernel type", () => {
    for (const t of Object.values(PAYLOAD)) expect(isRegisteredPayloadType(t), t).toBe(true);
    expect(listPayloadTypes()).toEqual(expect.arrayContaining(["user.message", "job.result", "approval.resolved", "source.hit"]));
  });

  it("validates ok / unknown_type / invalid", () => {
    expect(validatePayload({ type: "user.message", payload: { text: "周五提醒我约牙医", extra: true } })).toEqual({ ok: true });
    expect(validatePayload({ type: "nope.never", payload: {} })).toMatchObject({ ok: false, reason: "unknown_type" });
    const bad = validatePayload({ type: "job.result", payload: { jobId: "j1", state: "exploded" } });
    expect(bad).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("accepts custom registrations and refuses conflicting duplicates", () => {
    const schema = z.object({ n: z.number() });
    registerPayloadType("test.counter", schema);
    registerPayloadType("test.counter", schema); // same schema object: idempotent
    expect(validatePayload({ type: "test.counter", payload: { n: 1 } })).toEqual({ ok: true });
    let caught: unknown;
    try {
      registerPayloadType("test.counter", z.object({ n: z.string() }));
    } catch (e) {
      caught = e;
    }
    expect(isNgError(caught, "duplicate")).toBe(true);
    registerPayloadType("test.counter", z.object({ n: z.string() }), { replace: true });
    expect(validatePayload({ type: "test.counter", payload: { n: "x" } })).toEqual({ ok: true });
    expect(() => registerPayloadType("Bad Name", schema)).toThrow();
  });

  it("builds envelopes with clock time and narrows by type", () => {
    const clock = new ManualClock(5_000);
    const env = createEnvelope(
      { from: "channel:web:owner", principalId: "owner", kind: "event", type: "user.message", payload: { text: "hi" } },
      clock,
    );
    expect(env.createdAt).toBe(5_000);
    expect(env.id).toMatch(/^env_/);
    expect("to" in env).toBe(false);
    if (isEnvelopeOfType(env, "user.message")) expect(env.payload.text).toBe("hi");
    else throw new Error("guard failed");
  });
});
