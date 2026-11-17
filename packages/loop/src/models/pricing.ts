import type { ModelUsage } from "@ng/protocol";

/** USD per million tokens. Cache prices default to 1.25× (write, 5-minute TTL) and 0.1× (read) of `input`. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
  /** Prompts (uncached + cache read + cache write) above `aboveInputTokens` are billed at these rates instead. */
  longContext?: { aboveInputTokens: number; input: number; output: number; cacheWrite?: number; cacheRead?: number };
}

/**
 * Anthropic first-party list prices (USD / MTok), as of 2026-11. Cache writes are priced for the 5-minute TTL the
 * client uses. Override or extend through the client's `prices` option.
 */
export const ANTHROPIC_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-mythos-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longContext: { aboveInputTokens: 100_000, input: 0.5, output: 2.5 } },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Unknown Anthropic ids (dated snapshots, new point releases) are priced like the current model of their family. */
const ANTHROPIC_FAMILY_FALLBACK: ReadonlyArray<[prefix: string, model: string]> = [
  ["claude-fable", "claude-fable-5-2"],
  ["claude-mythos", "claude-mythos-5-2"],
  ["claude-opus", "claude-opus-5-5"],
  ["claude-sonnet", "claude-sonnet-5-5"],
  ["claude-haiku", "claude-haiku-5-5"],
];

export function findAnthropicPrice(model: string, overrides?: Readonly<Record<string, ModelPrice>>): ModelPrice | undefined {
  const table = { ...ANTHROPIC_PRICES, ...overrides };
  const bare = model.replace(/^(anthropic\.|us\.anthropic\.)/, "").replace(/-\d{8}$/, "").replace(/@.*$/, "");
  const exact = table[model] ?? table[bare];
  if (exact) return exact;
  const family = ANTHROPIC_FAMILY_FALLBACK.find(([prefix]) => bare.startsWith(prefix));
  return family ? table[family[1]] : undefined;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costCents(counts: TokenCounts, price: ModelPrice): number {
  const prompt = counts.inputTokens + counts.cacheReadTokens + counts.cacheWriteTokens;
  const long = price.longContext && prompt > price.longContext.aboveInputTokens ? price.longContext : undefined;
  const input = long?.input ?? price.input;
  const output = long?.output ?? price.output;
  const cacheWrite = long ? (long.cacheWrite ?? long.input * 1.25) : (price.cacheWrite ?? price.input * 1.25);
  const cacheRead = long ? (long.cacheRead ?? long.input * 0.1) : (price.cacheRead ?? price.input * 0.1);
  const usd =
    (counts.inputTokens * input +
      counts.outputTokens * output +
      counts.cacheWriteTokens * cacheWrite +
      counts.cacheReadTokens * cacheRead) /
    1_000_000;
  return usd * 100;
}

export function toModelUsage(counts: TokenCounts, price: ModelPrice | undefined): ModelUsage {
  return {
    ...counts,
    tokens: counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens,
    billedCents: price ? costCents(counts, price) : 0,
    priced: price !== undefined,
  };
}

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    tokens: a.tokens + b.tokens,
    billedCents: a.billedCents + b.billedCents,
    priced: a.priced && b.priced,
  };
}

export const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  tokens: 0,
  billedCents: 0,
  priced: true,
};
