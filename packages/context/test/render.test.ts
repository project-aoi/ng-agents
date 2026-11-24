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

// Audit 2026-11-23 rerun L06: a handed-back message showed the hub's reason first and the owner's sentence as a field
// deep inside a JSON dump of the original envelope.
describe("renderEnvelope: a handed-back message", () => {
  const original: Envelope = {
    id: "msg_owner_7",
    from: "channel:ui:owner",
    principalId: "owner",
    kind: "event",
    type: "user.message",
    payload: { text: "帮我订周五下午的会议室" },
    threads: ["ui:owner"],
    createdAt: AT - 60_000,
  };

  it("shows the original words first under a header of their own, and the reason after them", () => {
    const env = envelope("handback", { original, fromCellId: "proj_release", reason: "订会议室不归这个项目管" });
    const text = renderEnvelope(env);
    expect(text.startsWith("[handback · from kernel:control · principal agent:local · at 2026-11-23T09:00:00.000Z]\n")).toBe(true);
    const head = text.indexOf("[original user.message · from channel:ui:owner · principal owner · id msg_owner_7 · thread ui:owner]");
    const words = text.indexOf("\n帮我订周五下午的会议室\n");
    const reason = text.indexOf("订会议室不归这个项目管");
    expect(head).toBeGreaterThan(0);
    expect(words).toBeGreaterThan(head);
    expect(reason).toBeGreaterThan(words);
    expect(text.slice(words, reason)).toContain("handed back by proj_release");
    // Not as a JSON dump of the envelope.
    expect(text).not.toContain('"payload"');
    expect(text).not.toContain('"original"');
  });

  it("is a pure function of the envelope", () => {
    const env = envelope("handback", { original, fromCellId: "proj_release", reason: "不归我管" });
    const before = structuredClone(env);
    const first = renderEnvelope(env);
    expect(renderEnvelope(env)).toBe(first);
    expect(renderEnvelope(structuredClone(env))).toBe(first);
    expect(env).toEqual(before);
  });

  it("shows a non-text original payload as JSON in the same place, and falls back to the plain rendering without an original", () => {
    const jsonPayload = renderEnvelope(envelope("handback", { original: { ...original, type: "source.hit", payload: { url: "https://example.com/x" } }, fromCellId: "w1", reason: "不归我管" }));
    expect(jsonPayload.indexOf('"url": "https://example.com/x"')).toBeGreaterThan(jsonPayload.indexOf("[original source.hit"));
    expect(jsonPayload.indexOf('"url": "https://example.com/x"')).toBeLessThan(jsonPayload.indexOf("不归我管"));
    const bare = renderEnvelope(envelope("handback", { fromCellId: "w1", reason: "不归我管" }));
    expect(bare).toMatch(/\]\n不归我管\n\{\n {2}"fromCellId": "w1"\n\}$/);
  });
});
