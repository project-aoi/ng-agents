// Provider-neutral model messages. Context builds them (history + tail); Loop's ModelClient implementations
// translate them to a provider's wire format (Anthropic, OpenAI-compatible, scripted).

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;                           // unique within the conversation; echoed by the matching tool_result
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/**
 * Invariants Context guarantees for `[...snapshot.history, ...snapshot.tail.messages]` after
 * `mergeAdjacentMessages`: starts with a user message, roles alternate, every tool_use in an assistant message is
 * answered by a tool_result in the following user message, and tool_result blocks precede text blocks in that message.
 */
export interface ModelMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** Merge consecutive same-role messages, keeping tool_result blocks ahead of other blocks in user messages. */
export function mergeAdjacentMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = orderBlocks(m.role, [...last.content, ...m.content]);
    } else {
      out.push({ role: m.role, content: orderBlocks(m.role, [...m.content]) });
    }
  }
  return out;
}

function orderBlocks(role: ModelMessage["role"], blocks: ContentBlock[]): ContentBlock[] {
  if (role !== "user") return blocks;
  const results = blocks.filter((b) => b.type === "tool_result");
  if (results.length === 0) return blocks;
  return [...results, ...blocks.filter((b) => b.type !== "tool_result")];
}

export function textMessage(role: ModelMessage["role"], text: string): ModelMessage {
  return { role, content: [{ type: "text", text }] };
}

/** Concatenated text blocks of a message (tool blocks ignored). */
export function messageText(message: ModelMessage): string {
  return message.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ==================== [ext] ModelClient: the provider-neutral model call (implemented in @ng/loop) ====================
// Declared here so other packages (e.g. an injected Context summariser) can type against it without depending on
// @ng/loop. Implementations: AnthropicModelClient, OpenAICompatibleModelClient, ScriptedModelClient.

export type ModelTier = "fast" | "strong";

/** A tool as the model sees it (name, description, JSON Schema with `type: "object"`). */
export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: { [key: string]: unknown };
}

/**
 * Provider-native rendering of an assistant turn (e.g. Anthropic content including thinking blocks with signatures).
 * Only the client whose `provider` matches replays it, verbatim; every other client uses the neutral `content`.
 * Lives only in memory for the duration of one Run — never persisted to evidence.
 */
export interface NativeAssistantContent {
  provider: string;
  content: unknown;
}

export interface ModelTurnMessage extends ModelMessage {
  native?: NativeAssistantContent;
}

export interface ModelRequest {
  tier: ModelTier;
  system: string;
  /** Starts with a user message, roles alternate, ends with a user message (no prefill). */
  messages: ModelTurnMessage[];
  /** Same definitions, same order, for every Run of a cell (prefix caching). */
  tools: ModelToolSpec[];
  maxOutputTokens?: number;
  /**
   * `stablePrefixEnd`: the last block of the part of `messages` that the next Run will reproduce byte-for-byte
   * (the snapshot's history). Clients with explicit prompt caching put a breakpoint there.
   */
  cacheHints?: { stablePrefixEnd?: { message: number; block: number } };
  metadata?: { cellId?: string; runId?: string };
}

export type ModelStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

/**
 * Dual ledger: `tokens` = every token the provider processed (uncached input + cache reads + cache writes + output),
 * so a subscription/zero-priced provider still counts against maxTokens; `billedCents` from the client's price table.
 * `priced: false` means the model had no price entry (cents reported as 0).
 */
export interface ModelUsage {
  inputTokens: number;                  // uncached input
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokens: number;
  billedCents: number;
  priced: boolean;
}

export interface ModelResponse {
  model: string;                        // the model that actually served the response
  content: Array<TextBlock | ToolUseBlock>; // provider-neutral, in output order (what evidence records)
  native?: NativeAssistantContent;
  stopReason: ModelStopReason;
  usage: ModelUsage;
}

export interface ModelClient {
  /** Matches NativeAssistantContent.provider for the content this client produces. */
  readonly provider: string;
  /** The model id a tier maps to (configuration). */
  modelFor(tier: ModelTier): string;
  /** Rejects on transport/API errors; rejects promptly when `signal` aborts. */
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
