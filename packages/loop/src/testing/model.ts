import type { ModelMessage, ModelTier, TextBlock, ToolUseBlock } from "@ng/protocol";

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
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
