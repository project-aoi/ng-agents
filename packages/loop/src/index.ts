// @ng/loop — primitive ④: one bounded Run (`llm` with a tool loop, or zero-token `code`), the ModelClient
// implementations, and the standard toolsets presets list by name in `processor.toolsets`.

export { createAgentLoop, raceAbort, TRUNCATED_CALL_OUTPUT, type AgentLoopOptions } from "./loop";
export { Conversation } from "./conversation";

export { STANDARD_TOOLSETS, standardToolsets, registerStandardToolsets, type StandardToolsetOptions } from "./tools/standard";
export { workspaceToolset, WORKSPACE_TOOLSET } from "./tools/workspace";
export { cellsToolset, CELLS_TOOLSET } from "./tools/cells";
export { contextToolset, CONTEXT_TOOLSET } from "./tools/context";
export { commsToolset, COMMS_TOOLSET, type CommsToolsetOptions, type HandbackPort } from "./tools/comms";
export { scheduleToolset, SCHEDULE_TOOLSET } from "./tools/schedule";

// CLI agents (Claude Code, Codex CLI, Antigravity CLI) as the executor of llm Runs, and the per-Run routing loop.
export * from "./cli";
