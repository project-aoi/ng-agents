import type { Hono } from "hono";
import { AGENT_INSTRUCTIONS, AGENT_SERVER_NAME, AGENT_TOOLS, type AgentToolDoc } from "./guide";

// The external main agent's control plane (docs/05 §5.3). One tool registry, two transports:
//   GET  /api/agent/tools            → { server, instructions, tools }   (what the MCP stdio server lists)
//   POST /api/agent/tools/:name      → { text, isError?, data? }         (what it calls; also plain REST for scripts)
// Every call acts as AGENT_PRINCIPAL: it carries the owner's rights, and the separate identity only records which
// entrance an operation came through. The MCP server names its session in CONVERSATION_HEADER, so the desk can tell
// two terminals of the same agent apart (audit E35); a tool's own conversationId argument still wins.

export const AGENT_PRINCIPAL = "agent:local";
export const CONVERSATION_HEADER = "x-ng-conversation-id";
const CONVERSATION_ID = /^[\w.:#@-]{1,120}$/;

/** What the transport knows about a call besides its arguments. */
export interface AgentCallContext {
  /** The conversation the caller's session is (the MCP server's own id), when it said so. */
  conversationId?: string;
}

export interface AgentToolResult {
  /** What the agent reads. Plain text, complete on its own. */
  text: string;
  isError?: boolean;
  /** The same facts, structured (for REST callers and tests). */
  data?: unknown;
}

export interface AgentControlPlane {
  /** Run one tool as `principalId`. Unknown tools and invalid arguments come back as `isError` results, not throws. */
  call(name: string, args: Record<string, unknown>, principalId: `agent:${string}`, call?: AgentCallContext): Promise<AgentToolResult>;
  /** The tools this control plane implements (default: all of AGENT_TOOLS). */
  tools?(): readonly AgentToolDoc[] | Promise<readonly AgentToolDoc[]>;
}

export function mountAgentApi(app: Hono, plane: AgentControlPlane): void {
  app.get("/api/agent/tools", async (c) => c.json({ server: AGENT_SERVER_NAME, instructions: AGENT_INSTRUCTIONS, tools: await (plane.tools?.() ?? AGENT_TOOLS) }));
  app.post("/api/agent/tools/:name", async (c) => {
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
    const conversationId = c.req.header(CONVERSATION_HEADER)?.trim();
    const result = await plane.call(c.req.param("name"), args, AGENT_PRINCIPAL, conversationId && CONVERSATION_ID.test(conversationId) ? { conversationId } : {});
    return c.json(result, 200);
  });
}
