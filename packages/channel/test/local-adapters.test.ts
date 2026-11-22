import { describe, expect, it } from "vitest";
import { validatePayload } from "@ng/protocol";
import { UiChannel } from "../src";
import { setup } from "./helpers";

describe("UiChannel", () => {
  it("capture() enqueues a user.message from the owner and waits for the sink", async () => {
    const { hub, clock, received } = setup();
    const ui = new UiChannel({ clock });
    hub.register(ui);
    const env = await ui.capture({ text: "  周五下午 3 点提醒我给牙医打电话 ", clientId: "c-1", voice: true, attachments: [{ label: "图", uri: "res://1" }] }, "owner");
    expect(env).toEqual({
      id: "ui:c-1",
      from: "channel:ui:owner",
      principalId: "owner",
      kind: "event",
      type: "user.message",
      payload: {
        text: "周五下午 3 点提醒我给牙医打电话",
        replyTo: "channel:ui:owner",
        sender: { id: "owner" },
        attachments: [{ label: "图", uri: "res://1" }],
        voice: true,
      },
      createdAt: clock.now(),
    });
    expect(validatePayload(env)).toEqual({ ok: true });
    expect(received.map((r) => r.channelId)).toEqual(["ui"]);
    await expect(ui.capture({ text: "   " }, "owner")).rejects.toThrow(/empty/);
  });

  it("a failing sink makes capture reject, so the UI can tell the user it was not saved", async () => {
    const { hub, clock } = setup();
    const ui = new UiChannel({ clock });
    hub.register(ui);
    hub.onIngress(async () => {
      throw new Error("disk full");
    });
    await expect(ui.capture({ text: "x" }, "owner")).rejects.toThrow("disk full");
  });

});
