// renderEnvelope: what the owner's coding agent adds on its own travels beside the owner's words (payload
// `agentContext`) and is shown after them as a labelled block of its own — never as the owner's words (audit E02).

import { describe, expect, it } from "vitest";
import type { Envelope } from "@ng/protocol";
import { AGENT_NOTE_LABEL, renderEnvelope } from "../src/render";

const AT = Date.UTC(2026, 10, 23, 9, 0, 0);

function envelope(type: string, payload: Record<string, unknown>): Envelope {
  return { id: "m1", from: "kernel:control", principalId: "agent:local", kind: "event", type, payload, createdAt: AT };
}

describe("renderEnvelope: the agent's note", () => {
  it("labels it exactly and puts it after the owner's text and the message's own fields", () => {
    const env = envelope("user.message", {
      text: "现在开始实现吗？我还没想好范围",
      sender: { id: "agent:local" },
      conversationId: "codex-1a2b",
      agentContext: "  工作台之前停靠过一份报告：只用本地资料。  ",
    });
    expect(AGENT_NOTE_LABEL).toBe("[note added by the owner's coding agent — not the owner's words]");
    expect(renderEnvelope(env)).toBe(
      `[user.message · from kernel:control · principal agent:local · at 2026-11-23T09:00:00.000Z · id m1]\n` +
        `现在开始实现吗？我还没想好范围\n` +
        `{\n  "conversationId": "codex-1a2b",\n  "sender": {\n    "id": "agent:local"\n  }\n}\n\n` +
        `${AGENT_NOTE_LABEL}\n工作台之前停靠过一份报告：只用本地资料。`,
    );
  });

  it("does the same for a message to a cell and for the copy its parent gets", () => {
    const direct = renderEnvelope(envelope("cell.message", { fromCellId: "agent:local", text: "把上限改成 3", agentContext: "主人说的“上限”是重试次数" }));
    expect(direct).toMatch(/\n把上限改成 3\n\{\n  "fromCellId": "agent:local"\n\}\n\n\[note added by the owner's coding agent — not the owner's words\]\n主人说的“上限”是重试次数$/);
    expect(direct).not.toContain('"agentContext"');
    const copy = renderEnvelope(envelope("cell.direct_chat", { childCellId: "w1", text: "把上限改成 3", mode: "enqueue", messageId: "m1", at: AT, agentContext: "主人说的“上限”是重试次数" }));
    expect(copy.indexOf("把上限改成 3")).toBeLessThan(copy.indexOf(AGENT_NOTE_LABEL));
    expect(copy.endsWith(`${AGENT_NOTE_LABEL}\n主人说的“上限”是重试次数`)).toBe(true);
  });

  it("renders exactly as before when there is no note, and leaves other payload types alone", () => {
    expect(renderEnvelope(envelope("user.message", { text: "买牛奶" }))).toBe(
      "[user.message · from kernel:control · principal agent:local · at 2026-11-23T09:00:00.000Z · id m1]\n买牛奶",
    );
    expect(renderEnvelope(envelope("user.message", { text: "买牛奶", agentContext: "   " }))).toMatch(/\n买牛奶$/);
    const other = renderEnvelope(envelope("cell.progress", { childCellId: "w1", text: "一半了", agentContext: "x" }));
    expect(other).toContain('"agentContext": "x"');
    expect(other).not.toContain(AGENT_NOTE_LABEL);
  });
});
