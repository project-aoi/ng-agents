#!/usr/bin/env node
// MCP server (stdio) for an external main agent — Claude Code, Codex CLI, Antigravity, or any MCP client — to drive
// a running ng-agents workbench (docs/05 principle 1: the second entrance). It is a thin proxy: the tool list, the
// server instructions and every call are served by the workbench's own agent API (`/api/agent/tools`), so this file
// never goes out of date with the server it talks to.
//
//   NG_DESK_URL     base URL of the workbench            (default http://127.0.0.1:8790)
//   NG_AGENT_TOKEN  the agent's bearer token             (not needed for a token-less loopback workbench)
//
// Plain ESM without dependencies: any Node >= 18 runs it straight from the source tree, e.g.
//   claude mcp add ng-desk -- node /path/to/ng-agents/apps/gtd-desk/bin/ng-mcp.mjs
//   codex  mcp add ng-desk -- node /path/to/ng-agents/apps/gtd-desk/bin/ng-mcp.mjs
import { createInterface } from "node:readline";

const base = (process.env.NG_DESK_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
const token = process.env.NG_AGENT_TOKEN || "";
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CALL_TIMEOUT_MS = Number(process.env.NG_MCP_TIMEOUT_MS) || 120_000;

const headers = () => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function http(method, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, { method, headers: headers(), ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: ctl.signal });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { text };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** A failure the agent can act on, never a stack trace. */
function unreachable(err) {
  const why = err && err.name === "AbortError" ? `no answer within ${Math.round(CALL_TIMEOUT_MS / 1000)} s` : err instanceof Error ? err.message : String(err);
  return `The ng-agents workbench at ${base} could not be reached (${why}). It has to be running for these tools to work: start it with \`pnpm start\` in the ng-agents directory (or set NG_DESK_URL if it listens elsewhere). Tell the owner; do not retry in a loop.`;
}

let catalog = null;
async function loadCatalog() {
  let r;
  try {
    r = await http("GET", "/api/agent/tools");
  } catch (err) {
    throw new Error(unreachable(err));
  }
  if (r.status === 401) throw new Error(`the workbench refused this agent (${r.json?.error?.message ?? "unauthorized"}): set NG_AGENT_TOKEN to the agent token configured on the workbench`);
  if (r.status !== 200 || !Array.isArray(r.json?.tools)) throw new Error(`unexpected answer from ${base}/api/agent/tools (HTTP ${r.status})`);
  catalog = r.json;
  return catalog;
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize": {
      let instructions;
      let name = "ng-desk";
      try {
        const c = await loadCatalog();
        instructions = c.instructions;
        name = c.server || name;
      } catch (err) {
        // Still answer: the client must be able to list tools later, and the agent should learn why nothing works.
        instructions = `ng-agents workbench tools — currently unavailable. ${err instanceof Error ? err.message : String(err)}`;
      }
      const requested = params?.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version: "0.1.0" },
        instructions,
      });
      return;
    }
    case "ping":
      if (isRequest) reply(id, {});
      return;
    case "tools/list": {
      try {
        const c = await loadCatalog();
        reply(id, { tools: c.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      } catch (err) {
        // An empty list would look like "this server has no tools"; one tool that explains the problem is more useful.
        reply(id, {
          tools: [{ name: "workbench_overview", description: `Unavailable right now. ${err instanceof Error ? err.message : unreachable(err)}`, inputSchema: { type: "object", properties: {} } }],
        });
      }
      return;
    }
    case "tools/call": {
      const name = params?.name;
      if (typeof name !== "string" || !name) return fail(id, -32602, "tools/call needs a tool name");
      try {
        const r = await http("POST", `/api/agent/tools/${encodeURIComponent(name)}`, params?.arguments ?? {});
        if (r.status === 401) return reply(id, { content: [{ type: "text", text: `Not authorised: ${r.json?.error?.message ?? "the workbench refused this agent"}. Set NG_AGENT_TOKEN for this MCP server.` }], isError: true });
        const text = typeof r.json?.text === "string" ? r.json.text : (r.json?.error?.message ?? `HTTP ${r.status}`);
        reply(id, { content: [{ type: "text", text }], ...(r.json?.isError || r.status >= 400 ? { isError: true } : {}) });
      } catch (err) {
        reply(id, { content: [{ type: "text", text: unreachable(err) }], isError: true });
      }
      return;
    }
    case "resources/list":
      if (isRequest) reply(id, { resources: [] });
      return;
    case "prompts/list":
      if (isRequest) reply(id, { prompts: [] });
      return;
    default:
      // Notifications (notifications/initialized, cancelled, …) need no answer; unknown requests get a proper error.
      if (isRequest) fail(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = Promise.resolve();
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  // In order: a client may pipeline initialize and tools/list.
  pending = pending.then(() => handle(msg)).catch((err) => {
    if (msg && msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, err instanceof Error ? err.message : String(err));
  });
});
rl.on("close", () => {
  pending.finally(() => process.exit(0));
});
