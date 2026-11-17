import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ModelTier,
  ModelTurnMessage,
  TextBlock,
  ToolUseBlock,
} from "@ng/protocol";
import { toModelUsage, type ModelPrice } from "./pricing";

export interface OpenAICompatibleModelClientOptions {
  /** e.g. `https://api.deepseek.com` or `https://api.openai.com/v1` — `/chat/completions` is appended. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <key>`; a function is called per request (rotating tokens). */
  apiKey?: string | (() => string | Promise<string>);
  models: Record<ModelTier, string>;
  /** USD per MTok by model id. A model without an entry is reported with 0 cents (tokens still count). */
  prices?: Record<string, ModelPrice>;
  maxOutputTokens?: Partial<Record<ModelTier, number>>;
  /** OpenAI's newer models want `max_completion_tokens`; DeepSeek-style endpoints use `max_tokens` (default). */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /**
   * Replay `reasoning_content` of this Run's assistant turns (DeepSeek thinking mode with tool calls needs it back
   * inside the tool loop; older reasoners reject it). Default false.
   */
  replayReasoning?: boolean;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Extra JSON fields merged into every request body (e.g. `{ temperature: 0 }`, provider switches). */
  extraBody?: Record<string, unknown>;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatCompletion {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: ChatToolCall[] | null; reasoning_content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;             // DeepSeek
    prompt_tokens_details?: { cached_tokens?: number } | null; // OpenAI
  };
}

const FINISH: Readonly<Record<string, ModelStopReason>> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

/**
 * Chat Completions over plain `fetch` (DeepSeek and other OpenAI-compatible endpoints). Non-streaming; prefix caching
 * on these endpoints is automatic, so there are no cache hints to send. Tool results become `role: "tool"` messages
 * placed before the user text of the same turn.
 */
export class OpenAICompatibleModelClient implements ModelClient {
  readonly provider = "openai";
  readonly #opts: OpenAICompatibleModelClientOptions;

  constructor(opts: OpenAICompatibleModelClientOptions) {
    if (!opts.baseUrl) throw new Error("OpenAICompatibleModelClient: baseUrl is required");
    this.#opts = opts;
  }

  modelFor(tier: ModelTier): string {
    return this.#opts.models[tier];
  }

  buildBody(req: ModelRequest): Record<string, unknown> {
    const messages: ChatMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push(...toChatMessages(m, this.#opts.replayReasoning === true));
    const body: Record<string, unknown> = {
      model: this.modelFor(req.tier),
      messages,
      [this.#opts.maxTokensField ?? "max_tokens"]: req.maxOutputTokens ?? this.#opts.maxOutputTokens?.[req.tier] ?? 8192,
      stream: false,
      ...this.#opts.extraBody,
    };
    if (req.tools.length) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      body["tool_choice"] = "auto";
    }
    return body;
  }

  async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const headers: Record<string, string> = { "content-type": "application/json", ...this.#opts.headers };
    const key = typeof this.#opts.apiKey === "function" ? await this.#opts.apiKey() : this.#opts.apiKey;
    if (key) headers["authorization"] = `Bearer ${key}`;
    const doFetch = this.#opts.fetch ?? fetch;
    const res = await doFetch(`${this.#opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(this.buildBody(req)),
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`chat/completions ${res.status}: ${text.slice(0, 500)}`);
    return parseChatCompletion(JSON.parse(text) as ChatCompletion, this.modelFor(req.tier), this.#opts.prices);
  }
}

function toChatMessages(m: ModelTurnMessage, replayReasoning: boolean): ChatMessage[] {
  if (m.role === "assistant") {
    if (m.native?.provider === "openai" && m.native.content && typeof m.native.content === "object") {
      const native = { ...(m.native.content as Extract<ChatMessage, { role: "assistant" }>) };
      if (!replayReasoning) delete native.reasoning_content;
      return [native];
    }
    const text = m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n");
    const calls: ChatToolCall[] = m.content
      .filter((b): b is ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    return [{ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }];
  }
  const out: ChatMessage[] = [];
  const texts: string[] = [];
  for (const b of m.content) {
    if (b.type === "tool_result") {
      out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.isError ? `[error] ${b.content}` : b.content || "(no output)" });
    } else if (b.type === "text") {
      if (b.text) texts.push(b.text);
    }
  }
  if (texts.length) out.push({ role: "user", content: texts.join("\n\n") });
  return out;
}

export function parseChatCompletion(body: ChatCompletion, requestedModel: string, prices?: Record<string, ModelPrice>): ModelResponse {
  const choice = body.choices?.[0];
  const message = choice?.message ?? {};
  const content: Array<TextBlock | ToolUseBlock> = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
  }
  const model = body.model ?? requestedModel;
  const prompt = body.usage?.prompt_tokens ?? 0;
  const cached = body.usage?.prompt_cache_hit_tokens ?? body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const native: Extract<ChatMessage, { role: "assistant" }> = {
    role: "assistant",
    content: message.content ?? null,
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
  };
  const finish = choice?.finish_reason ?? "";
  return {
    model,
    content,
    native: { provider: "openai", content: native },
    stopReason: FINISH[finish] ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "other"),
    usage: toModelUsage(
      { inputTokens: Math.max(0, prompt - cached), cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: body.usage?.completion_tokens ?? 0 },
      prices?.[model] ?? prices?.[requestedModel],
    ),
  };
}

/** Malformed arguments are passed through as a string so the tool's schema check reports it to the model. */
function parseArguments(args: string): unknown {
  try {
    return args ? JSON.parse(args) : {};
  } catch {
    return args;
  }
}
