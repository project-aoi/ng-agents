// @ng/gtd-desk — the GTD workbench: HTTP API + projections over the kernel (src/server), the external main agent's
// control plane (src/agent, also served over MCP by bin/ng-mcp.mjs), the shared DTO contract (src/shared/api.ts) and
// the web client (src/web).

export { createDeskServer, DEFAULT_PORT, type DeskServer, type DeskServerOptions } from "./server/boot";
export { selectBackend, BackendConfigError, type BackendChoice, type SelectBackendOptions } from "./server/backend";
export { createDesk, DeskError, type Desk, type DeskActor, type ProjectOp } from "./server/desk";
export { createAgentControlPlane, type AgentControlPlaneDeps } from "./agent/tools";
export { AGENT_INSTRUCTIONS, AGENT_SERVER_NAME, AGENT_TOOLS, type AgentToolDoc } from "./agent/guide";
export { mountAgentApi, type AgentControlPlane, type AgentToolResult } from "./agent/routes";
export { createDeskApp } from "./server/app";
export * from "./server/projections";
export type * from "./shared/api";
