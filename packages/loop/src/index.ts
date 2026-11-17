// @ng/loop — primitive ④: one bounded Run (`llm` with a tool loop, or zero-token `code`), the ModelClient
// implementations, and the standard toolsets presets list by name in `processor.toolsets`.

export { createAgentLoop, raceAbort, BUDGET_STOP_OUTPUT, TRUNCATED_CALL_OUTPUT, type AgentLoopOptions } from "./loop";
export { Conversation } from "./conversation";
export { runScriptEntry, scriptCommand, shellQuote, SCRIPT_PREFIX } from "./script";

export {
  AnthropicModelClient,
  buildAnthropicParams,
  parseAnthropicMessage,
  ANTHROPIC_DEFAULT_MODELS,
  ANTHROPIC_DEFAULT_EFFORT,
  ANTHROPIC_DEFAULT_MAX_OUTPUT,
  SERVER_FALLBACK_BETA,
  type AnthropicEffort,
  type AnthropicModelClientOptions,
} from "./models/anthropic";
export { OpenAICompatibleModelClient, parseChatCompletion, type OpenAICompatibleModelClientOptions } from "./models/openai";
export {
  ScriptedModelClient,
  say,
  call,
  scriptContext,
  type Script,
  type ScriptTurn,
  type ScriptResponder,
  type ScriptContext,
  type ScriptedModelClientOptions,
} from "./models/scripted";
export { createModelClientFromEnv, type ModelProvider } from "./models/env";
export { ANTHROPIC_PRICES, findAnthropicPrice, costCents, toModelUsage, addUsage, ZERO_USAGE, type ModelPrice, type TokenCounts } from "./models/pricing";

export { STANDARD_TOOLSETS, standardToolsets, registerStandardToolsets, type StandardToolsetOptions } from "./tools/standard";
export { workspaceToolset, WORKSPACE_TOOLSET } from "./tools/workspace";
export { cellsToolset, CELLS_TOOLSET } from "./tools/cells";
export { contextToolset, CONTEXT_TOOLSET } from "./tools/context";
export { commsToolset, COMMS_TOOLSET, DEFAULT_OWNER_ADDRESSES, type CommsToolsetOptions, type HandbackPort } from "./tools/comms";
export { scheduleToolset, SCHEDULE_TOOLSET } from "./tools/schedule";

// CLI agents (Claude Code, Codex CLI, Antigravity CLI) as the executor of llm Runs, and the per-Run routing loop.
export * from "./cli";
