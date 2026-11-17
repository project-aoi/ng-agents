import type { ModelClient, ModelTier } from "@ng/protocol";
import { AnthropicModelClient, type AnthropicEffort } from "./anthropic";
import { OpenAICompatibleModelClient } from "./openai";
import type { ModelPrice } from "./pricing";

export type ModelProvider = "anthropic" | "openai";

/**
 * Builds the configured ModelClient from environment variables:
 *
 * - `NG_MODEL_PROVIDER`: `anthropic` (default) | `openai` (any OpenAI-compatible chat-completions endpoint).
 * - `NG_MODEL_STRONG`, `NG_MODEL_FAST`: model ids per tier (anthropic defaults: claude-opus-5-5 / claude-sonnet-5-5).
 * - `NG_MODEL_PRICES`: JSON `{ "<model>": { "input": 1.2, "output": 4, "cacheRead": 0.1 } }` (USD per MTok).
 * - anthropic: credentials through the SDK chain (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ant auth login`),
 *   `ANTHROPIC_BASE_URL`; `NG_EFFORT_STRONG` / `NG_EFFORT_FAST` (`low|medium|high|xhigh|max|default`);
 *   `NG_REFUSAL_FALLBACK=0` disables the server-side refusal fallback.
 * - openai: `NG_OPENAI_BASE_URL` (required), `NG_OPENAI_API_KEY`, `NG_MODEL_STRONG`/`NG_MODEL_FAST` (required),
 *   `NG_OPENAI_MAX_TOKENS_FIELD` (`max_tokens` | `max_completion_tokens`), `NG_OPENAI_REPLAY_REASONING=1`.
 *
 * The demo mode's ScriptedModelClient is chosen by the app, not here.
 */
export function createModelClientFromEnv(env: Record<string, string | undefined> = process.env): ModelClient {
  const provider = (env["NG_MODEL_PROVIDER"] ?? "anthropic").toLowerCase();
  const prices = parsePrices(env["NG_MODEL_PRICES"]);
  const models: Partial<Record<ModelTier, string>> = {};
  if (env["NG_MODEL_STRONG"]) models.strong = env["NG_MODEL_STRONG"];
  if (env["NG_MODEL_FAST"]) models.fast = env["NG_MODEL_FAST"];

  if (provider === "anthropic") {
    const effort: Partial<Record<ModelTier, AnthropicEffort | null>> = {};
    for (const tier of ["strong", "fast"] as const) {
      const v = env[`NG_EFFORT_${tier.toUpperCase()}`];
      if (!v) continue;
      if (v === "default") effort[tier] = null;
      else if (["low", "medium", "high", "xhigh", "max"].includes(v)) effort[tier] = v as AnthropicEffort;
      else throw new Error(`NG_EFFORT_${tier.toUpperCase()}: unknown effort "${v}"`);
    }
    return new AnthropicModelClient({
      models,
      effort,
      ...(prices ? { prices } : {}),
      ...(env["NG_REFUSAL_FALLBACK"] === "0" ? { refusalFallback: false } : {}),
    });
  }
  if (provider === "openai") {
    const baseUrl = env["NG_OPENAI_BASE_URL"];
    if (!baseUrl) throw new Error("NG_OPENAI_BASE_URL is required for NG_MODEL_PROVIDER=openai");
    if (!models.strong || !models.fast) throw new Error("NG_MODEL_STRONG and NG_MODEL_FAST are required for NG_MODEL_PROVIDER=openai");
    const field = env["NG_OPENAI_MAX_TOKENS_FIELD"];
    return new OpenAICompatibleModelClient({
      baseUrl,
      models: { strong: models.strong, fast: models.fast },
      ...(env["NG_OPENAI_API_KEY"] ? { apiKey: env["NG_OPENAI_API_KEY"] } : {}),
      ...(prices ? { prices } : {}),
      ...(field === "max_completion_tokens" || field === "max_tokens" ? { maxTokensField: field } : {}),
      ...(env["NG_OPENAI_REPLAY_REASONING"] === "1" ? { replayReasoning: true } : {}),
    });
  }
  throw new Error(`NG_MODEL_PROVIDER: unknown provider "${provider}" (expected anthropic | openai)`);
}

function parsePrices(raw: string | undefined): Record<string, ModelPrice> | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("NG_MODEL_PRICES must be a JSON object");
  for (const [model, p] of Object.entries(parsed)) {
    const price = p as Partial<ModelPrice>;
    if (typeof price.input !== "number" || typeof price.output !== "number") {
      throw new Error(`NG_MODEL_PRICES["${model}"] needs numeric input and output (USD per MTok)`);
    }
  }
  return parsed as Record<string, ModelPrice>;
}
