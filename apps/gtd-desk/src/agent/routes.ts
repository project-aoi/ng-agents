import type { Context, Hono } from "hono";
import { AGENT_INSTRUCTIONS, AGENT_SERVER_NAME, AGENT_TOOLS, type AgentToolDoc } from "./guide";

// The external main agent's control plane (docs/05 §5.3). One tool registry, two transports:
//   GET  /api/agent/tools            → { server, instructions, tools }   (what the MCP stdio server lists)
//   POST /api/agent/tools/:name      → { text, isError?, data? }         (what it calls; also plain REST for scripts)
// Authentication and the caller's `agent:<id>` principal are resolved by the app's guard (security.ts agentAuthFor);
// every handler acts as that principal, so the kernel's own rules — not this file — decide what an agent may do.

export interface AgentToolResult {
  /** What the agent reads. Plain text, complete on its own. */
  text: string;
  isError?: boolean;
  /** The same facts, structured (for REST callers and tests). */
  data?: unknown;
}

export interface AgentControlPlane {
  /** Run one tool as `principalId`. Unknown tools and invalid arguments come back as `isError` results, not throws. */
  call(name: string, args: Record<string, unknown>, principalId: `agent:${string}`): Promise<AgentToolResult>;
  /** The tools this control plane implements (default: all of AGENT_TOOLS). */
  tools?(): readonly AgentToolDoc[] | Promise<readonly AgentToolDoc[]>;
}

export function mountAgentApi(app: Hono, plane: AgentControlPlane, principalOf: (c: Context) => `agent:${string}` | null): void {
  app.get("/api/agent/tools", async (c) => c.json({ server: AGENT_SERVER_NAME, instructions: AGENT_INSTRUCTIONS, tools: await (plane.tools?.() ?? AGENT_TOOLS) }));
  app.post("/api/agent/tools/:name", async (c) => {
    const principalId = principalOf(c);
    if (!principalId) return c.json({ error: { code: "unauthorized", message: "no agent identity" } }, 401);
    let args: Record<string, unknown> = {};
    const raw = await c.req.text();
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        args = parsed as Record<string, unknown>;
      } catch {
        return c.json({ text: "The request body must be a JSON object with the tool's arguments.", isError: true } satisfies AgentToolResult, 400);
      }
    }
    const result = await plane.call(c.req.param("name"), args, principalId);
    return c.json(result, 200);
  });
}
