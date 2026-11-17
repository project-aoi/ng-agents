import { describe, expect, it } from "vitest";
import { textMessage, type ModelRequest } from "@ng/protocol";
import { call, say, ScriptedModelClient } from "../src";

const req = (text: string, extra: Partial<ModelRequest> = {}): ModelRequest => ({
  tier: "fast",
  system: "sys",
  messages: [textMessage("user", text)],
  tools: [{ name: "save_note", description: "", inputSchema: { type: "object" } }],
  metadata: { runId: "run_9" },
  ...extra,
});

describe("ScriptedModelClient", () => {
  it("plays a fixed sequence, records requests, estimates usage and ids tool calls uniquely per run", async () => {
    const m = new ScriptedModelClient([call("save_note", { name: "x" }), say("done", { usage: { inputTokens: 7, outputTokens: 3 } })], {
      price: { input: 1, output: 2 },
    });
    const a = await m.complete(req("hello"));
    expect(a.content).toEqual([{ type: "tool_use", id: "toolu_run_9_0_0", name: "save_note", input: { name: "x" } }]);
    expect(a.stopReason).toBe("tool_use");
    expect(a.usage.inputTokens).toBeGreaterThan(0);
    const b = await m.complete(req("next"));
    expect(b).toMatchObject({ content: [{ type: "text", text: "done" }], stopReason: "end_turn", model: "scripted-fast" });
    expect(b.usage).toMatchObject({ inputTokens: 7, outputTokens: 3, tokens: 10, billedCents: (7 + 6) / 1e4, priced: true });
    expect(m.calls.map((r) => r.messages[0]!.content[0])).toEqual([{ type: "text", text: "hello" }, { type: "text", text: "next" }]);
    expect(m.remaining).toBe(0);
    await expect(m.complete(req("more"))).rejects.toThrow("script exhausted");
    const lenient = new ScriptedModelClient([], { onExhausted: "end_turn" });
    expect((await lenient.complete(req("x"))).content).toEqual([]);
  });

  it("answers from a function of the request (demo mode)", async () => {
    const m = new ScriptedModelClient((r, ctx) => {
      if (ctx.toolResults.length) return say(`saved (${ctx.toolResults[0]!.content})`);
      if (ctx.lastUserText.includes("记") && ctx.toolNames.includes("save_note")) return call("save_note", { name: "memo", body: ctx.lastUserText });
      return say(`echo: ${ctx.lastUserText} / ${r.system}`);
    });
    expect((await m.complete(req("记一下牙医电话"))).content[0]).toMatchObject({ type: "tool_use", name: "save_note" });
    const after = req("", {
      messages: [
        textMessage("user", "记一下"),
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "save_note", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "t", content: "ok" }] },
      ],
    });
    expect((await m.complete(after)).content[0]).toEqual({ type: "text", text: "saved (ok)" });
    expect((await m.complete(req("hi"))).content[0]).toEqual({ type: "text", text: "echo: hi / sys" });
  });

  it("honours abort during a simulated delay", async () => {
    const m = new ScriptedModelClient([{ text: "slow", delayMs: 5_000 }]);
    const ac = new AbortController();
    const p = m.complete(req("x"), ac.signal);
    ac.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});
