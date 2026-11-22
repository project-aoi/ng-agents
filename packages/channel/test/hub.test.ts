import { describe, expect, it } from "vitest";
import { withTx, type Envelope, type IngressEmit } from "@ng/protocol";
import { setup, text } from "./helpers";

describe("站内通知", () => {
  it("commits one notice and one event when the same operation is retried", () => {
    const { hub, events, clock } = setup();
    const notice = { cellId: "desk", content: text("已存入阅读清单"), idempotencyKey: "capture-7" };
    hub.notifyOwner(notice);
    hub.notifyOwner(notice);
    const [stored] = hub.listNotificationsSync();
    expect(hub.listNotificationsSync()).toHaveLength(1);
    expect(stored).toMatchObject({ cellId: "desk", content: notice.content, createdAt: clock.now() });
    expect(events).toEqual([{ topic: "owner.notified", data: stored }]);
  });

  it("publishes nothing when the enclosing operation rolls back", () => {
    const { db, hub, events } = setup();
    expect(() => withTx(db, () => {
      hub.notifyOwner({ cellId: "desk", content: text("提醒"), idempotencyKey: "reminder" });
      throw new Error("aborted");
    })).toThrow("aborted");
    expect(hub.listNotificationsSync()).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("channel ingress", () => {
  it("rejects forged origins and principals before delivering an envelope", async () => {
    const { hub, received, clock } = setup();
    let emit!: IngressEmit;
    hub.register({ id: "test", onIngress(handler) { emit = handler; } });
    const message: Envelope = {
      id: "m1", from: "channel:test:owner", to: "inbox:target", principalId: "owner",
      kind: "event", type: "user.message", payload: { text: "记录" }, createdAt: clock.now(),
    };

    await expect(emit({ ...message, from: "channel:ui:owner" })).rejects.toThrow(/rejected/);
    await expect(emit({ ...message, principalId: "cell:desk" })).rejects.toThrow(/principal/);
    expect(received).toEqual([]);
    await emit(message);
    const { to: _destination, ...accepted } = message;
    expect(received).toEqual([{ env: accepted, channelId: "test" }]);
  });

  it("keeps the original channel when a duplicate is registered", () => {
    const { hub, mem } = setup();
    expect(() => hub.register({ id: mem.id, onIngress() {} })).toThrow(/already registered/);
    expect(hub.get(mem.id)).toBe(mem);
    expect(hub.list()).toEqual([mem]);
  });
});
