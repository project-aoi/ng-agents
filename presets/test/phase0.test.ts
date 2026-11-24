import { afterEach, describe, expect, it } from "vitest";
import { createEnvelope, KERNEL_FROM, PAYLOAD } from "@ng/protocol";
import { itemSource } from "../src/shared/records";
import { boot, cleanupAll, HOUR, tool } from "./helpers";

afterEach(cleanupAll);

describe("reminders and input attribution", () => {
  it("BUG-021: remind_me writes NO desk:reminder:* shadow state (Inbox timer envelope is sole SSOT)", async () => {
    const h = await boot();
    h.script.add("desk", tool("remind_me", { text: "记得喝水", inMinutes: 10 }), { text: "好的" });
    await h.ui.capture({ text: "10 分钟后提醒我喝水" }, "owner");
    await h.kernel.idle();

    const reminderState = h.kernel.context.listStateSync("desk", "desk:reminder:");
    expect(reminderState).toEqual([]);
    const scheduled = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.timerFired });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.envelope.payload).toMatchObject({ label: "提醒：记得喝水" });

    // Advancing clock fires the Inbox timer directly without any shadow state resurrection.
    h.clock.advance(HOUR);
    await h.kernel.idle();
    expect(h.notices().some((n) => n.includes("记得喝水"))).toBe(true);
  });

  it("BUG-022: itemSource identifies KERNEL_FROM.control for both agent:* and owner", () => {
    const agentEnv = createEnvelope(
      { id: "s1", from: KERNEL_FROM.control, principalId: "agent:main", kind: "event", type: PAYLOAD.controlSteer, payload: { message: "改一下" } },
      { now: () => 100 },
    );
    const ownerEnv = createEnvelope(
      { id: "s2", from: KERNEL_FROM.control, principalId: "owner", kind: "event", type: PAYLOAD.controlSteer, payload: { message: "停一下" } },
      { now: () => 200 },
    );
    expect(itemSource(agentEnv, 100)).toMatchObject({ label: "编码助手", principalId: "agent:main", envelopeId: "s1", at: 100 });
    expect(itemSource(ownerEnv, 200)).toMatchObject({ label: "对话", principalId: "owner", envelopeId: "s2", at: 200 });
  });
});
