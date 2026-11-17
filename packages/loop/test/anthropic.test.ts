import { describe, expect, it } from "vitest";
import { textMessage, type ModelRequest } from "@ng/protocol";
import { AnthropicModelClient, buildAnthropicParams, costCents, createAgentLoop, findAnthropicPrice, SERVER_FALLBACK_BETA } from "../src";
import { createFakeRun } from "../src/testing";
import { makeRegistry } from "./helpers";

// No API key here: these tests check request shaping and response parsing against a fake transport only.

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; signature: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function sse(model: string, blocks: Block[], stopReason: string, usage: Record<string, unknown>): Response {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
  ];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else if (b.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage });
  events.push({ type: "message_stop" });
  const body = events.map((e) => `event: ${e["type"]}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
}

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

function fakeTransport(responses: Array<() => Response>) {
  const captured: Captured[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  };
  return { captured, fetchFn };
}

const baseRequest = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  tier: "strong",
  system: "frozen system prompt",
  messages: [textMessage("user", "hi")],
  tools: [{ name: "save_note", description: "save", inputSchema: { type: "object", properties: { name: { type: "string" } } } }],
  ...over,
});

describe("AnthropicModelClient request shaping", () => {
  it("places cache breakpoints on system and on the end of the stable history, plus top-level auto caching", () => {
    const req = baseRequest({
      messages: [
        textMessage("user", "old question"),
        { role: "assistant", content: [{ type: "text", text: "old answer" }, { type: "tool_use", id: "t1", name: "save_note", input: { name: "a" } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "" }, { type: "text", text: "history tail" }, { type: "text", text: "new batch" }] },
      ],
      cacheHints: { stablePrefixEnd: { message: 2, block: 1 } },
    });
    const p = buildAnthropicParams(req, { model: "claude-opus-5-5" }) as unknown as Record<string, any>;
    expect(p["model"]).toBe("claude-opus-5-5");
    expect(p["max_tokens"]).toBe(32_000);
    expect(p["system"]).toEqual([{ type: "text", text: "frozen system prompt", cache_control: { type: "ephemeral" } }]);
    expect(p["cache_control"]).toEqual({ type: "ephemeral" });
    expect(p["tools"]).toEqual([{ name: "save_note", description: "save", input_schema: { type: "object", properties: { name: { type: "string" } } } }]);
    expect(p["output_config"]).toEqual({ effort: "high" });
    expect(p["thinking"]).toBeUndefined();
    expect(p["betas"]).toEqual([SERVER_FALLBACK_BETA]);
    expect(p["fallbacks"]).toBe("default");
    const last = p["messages"][2];
    expect(last.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "(no output)" },
      { type: "text", text: "history tail", cache_control: { type: "ephemeral" } },
      { type: "text", text: "new batch" },
    ]);
    expect(p["messages"][1].content[1]).toEqual({ type: "tool_use", id: "t1", name: "save_note", input: { name: "a" } });
    const markers = JSON.stringify(p).match(/cache_control/g) ?? [];
    expect(markers.length).toBeLessThanOrEqual(4);
  });

  it("maps tiers to models/effort and skips the refusal fallback where unsupported or disabled", () => {
    const fast = buildAnthropicParams(baseRequest({ tier: "fast" }), { model: "claude-haiku-5-5", effort: { fast: null } }) as unknown as Record<string, any>;
    expect(fast["fallbacks"]).toBeUndefined();
    expect(fast["betas"]).toBeUndefined();
    expect(fast["output_config"]).toBeUndefined();
    expect(fast["max_tokens"]).toBe(16_000);
    const off = buildAnthropicParams(baseRequest(), { model: "claude-opus-5-5", refusalFallback: false }) as unknown as Record<string, any>;
    expect(off["fallbacks"]).toBeUndefined();
    const noSystem = buildAnthropicParams(baseRequest({ system: "" }), { model: "claude-opus-5-5" }) as unknown as Record<string, any>;
    expect(noSystem["system"]).toBeUndefined();
    expect(noSystem["tools"][0].cache_control).toEqual({ type: "ephemeral" });
    expect(new AnthropicModelClient({ apiKey: "k", models: { fast: "claude-haiku-5-5" } }).modelFor("fast")).toBe("claude-haiku-5-5");
    expect(new AnthropicModelClient({ apiKey: "k" }).modelFor("strong")).toBe("claude-opus-5-5");
  });

  it("streams over the fake transport, keeps thinking blocks only in native, and replays them in the next step", async () => {
    const { captured, fetchFn } = fakeTransport([
      () =>
        sse(
          "claude-opus-5-5",
          [
            { type: "thinking", signature: "sig_1" },
            { type: "text", text: "Saving it." },
            { type: "tool_use", id: "toolu_1", name: "save_note", input: { name: "reading-list", body: "https://a.example" } },
          ],
          "tool_use",
          { output_tokens: 120, input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500 },
        ),
      () => sse("claude-opus-5-5", [{ type: "thinking", signature: "sig_2" }, { type: "text", text: "Saved." }], "end_turn", { output_tokens: 10, input_tokens: 50 }),
    ]);
    const client = new AnthropicModelClient({ apiKey: "test-key", fetch: fetchFn, maxRetries: 0 });
    const { ports, snapshot, controller } = createFakeRun({
      spec: { processor: { kind: "llm", toolsets: ["kernel.context"] } },
      batch: ["把这篇加到阅读清单"],
    });
    const outcome = await createAgentLoop({ model: client, registry: makeRegistry() }).run(snapshot, ports, controller.signal);
    expect(outcome).toBe("completed");

    expect(captured).toHaveLength(2);
    const [first, second] = captured as [Captured, Captured];
    expect(first.url).toMatch(/\/v1\/messages(\?beta=true)?$/);
    expect(first.headers.get("authorization") ?? `Bearer ${first.headers.get("x-api-key")}`).toBe("Bearer test-key");
    expect(first.headers.get("anthropic-beta")).toContain(SERVER_FALLBACK_BETA);
    expect(first.body["stream"]).toBe(true);
    expect(first.body["tools"].map((t: { name: string }) => t.name)).toContain("save_note");

    // step 2 replays the assistant turn verbatim, thinking block (with signature) included
    const replayed = second.body["messages"][1];
    expect(replayed.role).toBe("assistant");
    expect(replayed.content.map((b: { type: string }) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(replayed.content[0]).toMatchObject({ type: "thinking", signature: "sig_1" });
    expect(replayed.content[2]).toMatchObject({ id: "toolu_1", input: { name: "reading-list", body: "https://a.example" } });
    expect(second.body["messages"][2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    // tools + system are byte-identical between steps (prefix caching)
    expect(second.body["tools"]).toEqual(first.body["tools"]);
    expect(second.body["system"]).toEqual(first.body["system"]);

    // evidence never contains thinking; usage counts every token class, priced at Opus 5.5 rates
    expect(ports.log.evidence.map((e) => e.kind)).toEqual(["assistant_text", "tool_call", "tool_result", "assistant_text"]);
    const firstCallCents = (1000 * 4 + 120 * 20 + 500 * 5 + 4000 * 0.2) / 1e6 * 100;
    expect(ports.log.metered[1]!.tokens).toBe(1000 + 120 + 4000 + 500);
    expect(ports.log.metered[1]!.billedCents).toBeCloseTo(firstCallCents, 10);
  });

  it("prices server-side fallback iterations at the serving model's rates", async () => {
    const { fetchFn } = fakeTransport([
      () =>
        sse("claude-opus-4-8", [{ type: "text", text: "ok" }], "end_turn", {
          output_tokens: 30,
          input_tokens: 200,
          iterations: [
            { type: "message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          ],
        }),
    ]);
    const r = await new AnthropicModelClient({ apiKey: "k", fetch: fetchFn, maxRetries: 0 }).complete(baseRequest());
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.usage.tokens).toBe(230);
    expect(r.usage.billedCents).toBeCloseTo(((100 * 4 + 10 * 20) + (100 * 5 + 20 * 25)) / 1e6 * 100, 10);
    expect(r.stopReason).toBe("end_turn");
  });

  it("rejects promptly on abort", async () => {
    const fetchFn = (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const client = new AnthropicModelClient({ apiKey: "k", fetch: fetchFn, maxRetries: 0 });
    const ac = new AbortController();
    const p = client.complete(baseRequest(), ac.signal);
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toThrow();
  });
});

describe("pricing", () => {
  it("resolves dated / prefixed ids to their family and applies long-context rates", () => {
    expect(findAnthropicPrice("claude-sonnet-5-5-20261001")).toEqual(findAnthropicPrice("claude-sonnet-5-5"));
    expect(findAnthropicPrice("anthropic.claude-opus-5-5")?.input).toBe(4);
    expect(findAnthropicPrice("claude-opus-9")?.input).toBe(4);
    expect(findAnthropicPrice("gpt-x")).toBeUndefined();
    const haiku = findAnthropicPrice("claude-haiku-5-5")!;
    expect(costCents({ inputTokens: 100_000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }, haiku)).toBeCloseTo((100_000 * 0.1 + 1000 * 0.5) / 1e4, 10);
    expect(costCents({ inputTokens: 100_001, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }, haiku)).toBeCloseTo((100_001 * 0.5 + 1000 * 2.5) / 1e4, 10);
  });
});
