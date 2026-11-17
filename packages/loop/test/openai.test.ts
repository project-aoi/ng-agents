import { describe, expect, it } from "vitest";
import { textMessage } from "@ng/protocol";
import { AnthropicModelClient, createAgentLoop, createModelClientFromEnv, OpenAICompatibleModelClient } from "../src";
import { createFakeRun } from "../src/testing";
import { makeRegistry } from "./helpers";

// No API key here: request shaping and response parsing are checked against a fake fetch only.

function fakeFetch(replies: Array<Record<string, unknown> | { status: number; text: string }>) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const r = replies.shift()!;
    if ("status" in r && typeof r.status === "number") return new Response(String(r["text"]), { status: r.status });
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { requests, fn };
}

const completion = (message: Record<string, unknown>, finish: string, usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 20 }) => ({
  model: "deepseek-chat",
  choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }],
  usage,
});

describe("OpenAICompatibleModelClient", () => {
  it("shapes chat-completions requests, maps tool calls and replays this Run's turns", async () => {
    const { requests, fn } = fakeFetch([
      completion(
        {
          content: null,
          reasoning_content: "thinking about it",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "set_state", arguments: '{"patches":{"k":1}}' } }],
        },
        "tool_calls",
        { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800 },
      ),
      completion({ content: "好了" }, "stop"),
    ]);
    const client = new OpenAICompatibleModelClient({
      baseUrl: "https://api.deepseek.example/",
      apiKey: "sk-test",
      models: { strong: "deepseek-reasoner", fast: "deepseek-chat" },
      prices: { "deepseek-chat": { input: 0.3, output: 1.2, cacheRead: 0.03 } },
      fetch: fn,
    });
    const { ports, snapshot, controller } = createFakeRun({
      spec: { processor: { kind: "llm", modelTier: "fast", toolsets: ["kernel.context"] } },
      history: [textMessage("user", "earlier"), textMessage("assistant", "noted")],
      batch: ["记一下 k=1"],
    });
    expect(await createAgentLoop({ model: client, registry: makeRegistry() }).run(snapshot, ports, controller.signal)).toBe("completed");

    const [first, second] = requests;
    expect(first!.url).toBe("https://api.deepseek.example/chat/completions");
    expect(first!.headers["authorization"]).toBe("Bearer sk-test");
    expect(first!.body).toMatchObject({ model: "deepseek-chat", max_tokens: 8192, stream: false, tool_choice: "auto" });
    expect(first!.body["messages"].slice(0, 3)).toEqual([
      { role: "system", content: "You are a test cell." },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "noted" },
    ]);
    expect(first!.body["tools"][0]).toMatchObject({ type: "function", function: { name: "read_state", parameters: { type: "object" } } });

    const msgs = second!.body["messages"];
    // replayed assistant turn (reasoning_content stripped by default), then the tool result as a tool message
    expect(msgs.at(-2)).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "set_state", arguments: '{"patches":{"k":1}}' } }] });
    expect(msgs.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "Saved k." });
    expect(ports.state.get("k")).toBe(1);
    // usage: cached prompt tokens priced as cache reads; tokens count everything
    expect(ports.log.metered[1]).toEqual({ tokens: 1050, billedCents: ((200 * 0.3 + 800 * 0.03 + 50 * 1.2) / 1e6) * 100 });
  });

  it("puts tool results before the user text of the same turn, passes malformed arguments through, and surfaces HTTP errors", async () => {
    const { requests, fn } = fakeFetch([
      completion({ content: "x", tool_calls: [{ id: "c9", type: "function", function: { name: "echo", arguments: "{oops" } }] }, "tool_calls"),
      { status: 429, text: "rate limited" },
    ]);
    const client = new OpenAICompatibleModelClient({ baseUrl: "https://h", models: { strong: "m", fast: "m" }, fetch: fn, maxTokensField: "max_completion_tokens" });
    const body = client.buildBody({
      tier: "strong",
      system: "",
      tools: [],
      messages: [
        textMessage("user", "q"),
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "echo", input: { text: "a" } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "boom", isError: true }, { type: "text", text: "[steer] stop" }] },
      ],
    });
    expect(body["max_completion_tokens"]).toBe(8192);
    expect(body["tools"]).toBeUndefined();
    expect(body["messages"]).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "[error] boom" },
      { role: "user", content: "[steer] stop" },
    ]);
    const r = await client.complete({ tier: "strong", system: "", tools: [], messages: [textMessage("user", "q")] });
    expect(r.content[1]).toEqual({ type: "tool_use", id: "c9", name: "echo", input: "{oops" });
    expect(r.usage.priced).toBe(false);
    expect(r.usage.billedCents).toBe(0);
    expect(r.usage.tokens).toBe(120);
    await expect(client.complete({ tier: "strong", system: "", tools: [], messages: [textMessage("user", "q")] })).rejects.toThrow("429");
    expect(requests).toHaveLength(2);
  });
});

describe("createModelClientFromEnv", () => {
  it("builds the anthropic client by default with tier/effort overrides", () => {
    const c = createModelClientFromEnv({ ANTHROPIC_API_KEY: "k", NG_MODEL_FAST: "claude-haiku-5-5", NG_EFFORT_STRONG: "xhigh" });
    expect(c).toBeInstanceOf(AnthropicModelClient);
    expect(c.modelFor("fast")).toBe("claude-haiku-5-5");
    expect(c.modelFor("strong")).toBe("claude-opus-5-5");
    expect(() => createModelClientFromEnv({ ANTHROPIC_API_KEY: "k", NG_EFFORT_FAST: "turbo" })).toThrow("unknown effort");
  });

  it("builds an OpenAI-compatible client and validates its required settings", () => {
    const c = createModelClientFromEnv({
      NG_MODEL_PROVIDER: "openai",
      NG_OPENAI_BASE_URL: "https://api.deepseek.com",
      NG_MODEL_STRONG: "deepseek-reasoner",
      NG_MODEL_FAST: "deepseek-chat",
      NG_MODEL_PRICES: '{"deepseek-chat":{"input":0.3,"output":1.2}}',
    });
    expect(c).toBeInstanceOf(OpenAICompatibleModelClient);
    expect(c.modelFor("strong")).toBe("deepseek-reasoner");
    expect(() => createModelClientFromEnv({ NG_MODEL_PROVIDER: "openai", NG_MODEL_STRONG: "a", NG_MODEL_FAST: "b" })).toThrow("NG_OPENAI_BASE_URL");
    expect(() => createModelClientFromEnv({ NG_MODEL_PROVIDER: "openai", NG_OPENAI_BASE_URL: "https://h", NG_MODEL_STRONG: "a" })).toThrow("NG_MODEL_FAST");
    expect(() => createModelClientFromEnv({ NG_MODEL_PROVIDER: "openai", NG_OPENAI_BASE_URL: "https://h", NG_MODEL_STRONG: "a", NG_MODEL_FAST: "b", NG_MODEL_PRICES: '{"a":{}}' })).toThrow(
      "numeric input",
    );
    expect(() => createModelClientFromEnv({ NG_MODEL_PROVIDER: "gemini" })).toThrow("unknown provider");
  });
});
