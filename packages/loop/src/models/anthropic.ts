import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolUnion,
  BetaMessageStreamParams,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ModelTier,
  ModelTurnMessage,
  ModelUsage,
  TextBlock,
  ToolUseBlock,
} from "@ng/protocol";
import { addUsage, findAnthropicPrice, toModelUsage, ZERO_USAGE, type ModelPrice } from "./pricing";

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Defaults (2026-11): the strong tier runs Claude Opus 5.5, the fast tier Claude Sonnet 5.5. Effort is set
 * explicitly because Opus 5.5 defaults to `medium`; thinking is left to the models' adaptive default (it cannot be
 * disabled on these models).
 */
export const ANTHROPIC_DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = { strong: "claude-opus-5-5", fast: "claude-sonnet-5-5" };
export const ANTHROPIC_DEFAULT_EFFORT: Readonly<Record<ModelTier, AnthropicEffort | null>> = { strong: "high", fast: "medium" };
export const ANTHROPIC_DEFAULT_MAX_OUTPUT: Readonly<Record<ModelTier, number>> = { strong: 32_000, fast: 16_000 };

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). Haiku 5.5 has none. */
const SERVER_FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicModelClientOptions {
  /** A ready SDK client (tests, custom middleware). Otherwise one is built from the fields below. */
  client?: Anthropic;
  /** Default: the SDK's credential chain (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, `ant auth login` profile, ...). */
  apiKey?: string;
  baseURL?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  maxRetries?: number;
  timeoutMs?: number;
  models?: Partial<Record<ModelTier, string>>;
  /** `null` omits `output_config.effort` (model default). */
  effort?: Partial<Record<ModelTier, AnthropicEffort | null>>;
  maxOutputTokens?: Partial<Record<ModelTier, number>>;
  /**
   * Server-side refusal fallback (beta `server-side-fallback-2026-07-01`, `fallbacks: "default"`): when the model
   * declines, the API re-runs the request on a fallback model inside the same call. Default true; only sent for
   * models that support it.
   */
  refusalFallback?: boolean;
  /** Extra/overriding prices (USD per MTok) by model id. */
  prices?: Record<string, ModelPrice>;
}

type StreamParams = BetaMessageStreamParams;

/**
 * Claude through `@anthropic-ai/sdk` (beta Messages endpoint, streamed and collected with `finalMessage()` so long
 * agent turns do not hit HTTP timeouts).
 *
 * Prompt caching: tools + system end in one breakpoint (frozen per cell), a second breakpoint marks the end of the
 * snapshot's history (`cacheHints.stablePrefixEnd`, reproduced byte-for-byte by the next Run), and top-level automatic
 * caching covers the growing in-Run tail.
 *
 * Thinking blocks: assistant turns produced in this Run are replayed verbatim from `native` (thinking blocks with
 * signatures must come back unchanged inside a tool loop). Evidence never stores them, so later Runs send history
 * without any thinking blocks — removing all of them is an allowed edit under the preserved-thinking prefix check.
 */
export class AnthropicModelClient implements ModelClient {
  readonly provider = "anthropic";
  readonly #client: Anthropic;
  readonly #opts: AnthropicModelClientOptions;

  constructor(opts: AnthropicModelClientOptions = {}) {
    this.#opts = opts;
    this.#client =
      opts.client ??
      new Anthropic({
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
        ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      });
  }

  modelFor(tier: ModelTier): string {
    return this.#opts.models?.[tier] ?? ANTHROPIC_DEFAULT_MODELS[tier];
  }

  buildParams(req: ModelRequest): StreamParams {
    return buildAnthropicParams(req, { ...this.#opts, model: this.modelFor(req.tier) });
  }

  async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const params = this.buildParams(req);
    const stream = this.#client.beta.messages.stream(params, signal ? { signal } : undefined);
    const message = await stream.finalMessage();
    return parseAnthropicMessage(message, this.#opts.prices);
  }
}

export function buildAnthropicParams(
  req: ModelRequest,
  opts: Pick<AnthropicModelClientOptions, "effort" | "maxOutputTokens" | "refusalFallback"> & { model: string },
): StreamParams {
  const ephemeral = { type: "ephemeral" as const };
  const system: BetaTextBlockParam[] = req.system ? [{ type: "text", text: req.system, cache_control: ephemeral }] : [];
  const tools: BetaToolUnion[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as { type: "object"; [k: string]: unknown },
  }));
  const lastTool = tools[tools.length - 1];
  // Tools render before system, so without a system prompt the frozen-prefix breakpoint moves to the last tool.
  if (system.length === 0 && lastTool) (lastTool as { cache_control?: typeof ephemeral }).cache_control = ephemeral;

  const stable = req.cacheHints?.stablePrefixEnd;
  const messages = req.messages.map((m, i) => toAnthropicMessage(m, stable && stable.message === i ? stable.block : undefined));

  const effort = opts.effort && req.tier in opts.effort ? opts.effort[req.tier] : ANTHROPIC_DEFAULT_EFFORT[req.tier];
  const params: StreamParams = {
    model: opts.model,
    max_tokens: req.maxOutputTokens ?? opts.maxOutputTokens?.[req.tier] ?? ANTHROPIC_DEFAULT_MAX_OUTPUT[req.tier],
    messages,
    cache_control: ephemeral,
  };
  if (system.length) params.system = system;
  if (tools.length) params.tools = tools;
  if (effort) params.output_config = { effort };
  if (opts.refusalFallback !== false && SERVER_FALLBACK_MODELS.has(opts.model)) {
    params.betas = [SERVER_FALLBACK_BETA];
    params.fallbacks = "default";
  }
  return params;
}

function toAnthropicMessage(m: ModelTurnMessage, breakpointBlock: number | undefined): BetaMessageParam {
  if (m.role === "assistant" && m.native?.provider === "anthropic" && Array.isArray(m.native.content)) {
    return { role: "assistant", content: m.native.content as BetaContentBlockParam[] };
  }
  const out: BetaContentBlockParam[] = [];
  let markAt = -1;
  m.content.forEach((b, i) => {
    switch (b.type) {
      case "text":
        if (b.text !== "") out.push({ type: "text", text: b.text });
        break;
      case "tool_use":
        out.push({ type: "tool_use", id: b.id, name: b.name, input: asObject(b.input) });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          tool_use_id: b.toolUseId,
          content: b.content === "" ? "(no output)" : b.content,
          ...(b.isError ? { is_error: true } : {}),
        });
        break;
    }
    if (i === breakpointBlock) markAt = out.length - 1;
  });
  if (out.length === 0) {
    out.push({ type: "text", text: "(empty)" });
    if (breakpointBlock !== undefined) markAt = 0;
  }
  const marked = out[markAt];
  if (marked) (marked as { cache_control?: { type: "ephemeral" } }).cache_control = { type: "ephemeral" };
  return { role: m.role, content: out };
}

function asObject(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : { value: input };
}

const STOP_REASONS: Readonly<Record<string, ModelStopReason>> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  model_context_window_exceeded: "max_tokens",
  refusal: "refusal",
};

export function parseAnthropicMessage(message: BetaMessage, prices?: Record<string, ModelPrice>): ModelResponse {
  // Plain JSON copy: drops the SDK's non-enumerable helper properties so the replay is exactly what the API sent.
  const raw = JSON.parse(JSON.stringify(message.content)) as BetaMessage["content"];
  const content: Array<TextBlock | ToolUseBlock> = [];
  for (const b of raw) {
    if (b.type === "text" && b.text !== "") content.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
  }
  return {
    model: message.model,
    content,
    native: { provider: "anthropic", content: raw },
    stopReason: (message.stop_reason && STOP_REASONS[message.stop_reason]) ?? "other",
    usage: anthropicUsage(message, prices),
  };
}

interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  model?: unknown;
}

/** With a server-side fallback the per-model split lives in `usage.iterations`; each entry is priced at its own model. */
function anthropicUsage(message: BetaMessage, prices?: Record<string, ModelPrice>): ModelUsage {
  const usage = message.usage as BetaMessage["usage"] & { iterations?: RawUsage[] | null };
  const entries: RawUsage[] = usage.iterations && usage.iterations.length > 0 ? usage.iterations : [usage];
  return entries.reduce<ModelUsage>((acc, e) => {
    const model = typeof e.model === "string" && e.model ? e.model : message.model;
    const counts = {
      inputTokens: e.input_tokens ?? 0,
      outputTokens: e.output_tokens ?? 0,
      cacheWriteTokens: e.cache_creation_input_tokens ?? 0,
      cacheReadTokens: e.cache_read_input_tokens ?? 0,
    };
    return addUsage(acc, toModelUsage(counts, findAnthropicPrice(model, prices)));
  }, ZERO_USAGE);
}
