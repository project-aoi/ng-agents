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

export type ModelTier = "fast" | "strong";

/** A tool as the model sees it (name, description, JSON Schema with `type: "object"`). */
export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: { [key: string]: unknown };
}

export interface ModelRequest {
  tier: ModelTier;
  system: string;
  /** Starts with a user message, roles alternate, ends with a user message (no prefill). */
  messages: ModelMessage[];
  /** Same definitions, same order, for every Run of a cell (prefix caching). */
  tools: ModelToolSpec[];
  /**
   * `stablePrefixEnd`: the last block of the part of `messages` that the next Run will reproduce byte-for-byte
   * (the snapshot's history). Clients with explicit prompt caching put a breakpoint there.
   */
  cacheHints?: { stablePrefixEnd?: { message: number; block: number } };
  metadata?: { cellId?: string; runId?: string };
}

export type ModelStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ModelResponse {
  model: string;                        // the model that actually served the response
  content: Array<TextBlock | ToolUseBlock>; // provider-neutral, in output order (what evidence records)
  stopReason: ModelStopReason;
}

export interface ModelClient {
  /** Rejects on transport/API errors; rejects promptly when `signal` aborts. */
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
