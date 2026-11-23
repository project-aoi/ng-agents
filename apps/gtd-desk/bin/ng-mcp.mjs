#!/usr/bin/env node
// MCP server (stdio) for an external main agent — Claude Code, Codex CLI, Antigravity, or any MCP client — to drive
// a running ng-agents workbench (docs/05 principle 1: the second entrance). It is a thin proxy: the tool list, the
// server instructions and every call are served by the workbench's own agent API (`/api/agent/tools`), so this file
// never goes out of date with the server it talks to.
//
//   NG_DESK_URL           base URL of the workbench   (default http://127.0.0.1:8790)
//   NG_MCP_TIMEOUT_MS     how long one call may take  (default 120000)
//   NG_WORKBENCH_CELL_ID  set by the workbench on every background CLI it starts: this server then runs inside one of
//                         the workbench's own cells and offers none of the owner's tools (see `insideCell` below)
//
// Each run of this server is one session of the owner's agent: it names it with its own conversation id (sent as the
// x-ng-conversation-id header), so the desk can tell two terminals apart.
//
// Plain ESM without dependencies: any Node >= 18 runs it straight from the source tree, e.g.
//   claude mcp add ng-desk -- node /path/to/ng-agents/apps/gtd-desk/bin/ng-mcp.mjs
//   codex  mcp add ng-desk -- node /path/to/ng-agents/apps/gtd-desk/bin/ng-mcp.mjs
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const base = (process.env.NG_DESK_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CALL_TIMEOUT_MS = Number(process.env.NG_MCP_TIMEOUT_MS) || 120_000;
const CELL_ID = (process.env.NG_WORKBENCH_CELL_ID || "").trim();
const SESSION = randomUUID().replace(/-/g, "").slice(0, 12);
let clientName = "mcp";
/** This session's conversation with the owner: the client's name and a random part, e.g. "codex-mcp-client-3f9a…". */
const conversationId = () => `${clientName}-${SESSION}`;

/**
 * The owner's control plane is the owner's. A background CLI the workbench started (one of its own cells) may load the
 * owner's plugins too; then this server answers, but offers nothing that acts on the workbench: one inert tool that
 * says why, and no HTTP call at all (the system must not hand its own cells the owner's rights).
 */
const insideCell = CELL_ID
  ? `The ng-desk tools are the owner's control plane of the ng-agents workbench. This process runs inside the workbench's own background cell ${CELL_ID}, where that control plane is not available: you are not the owner's main agent here, and the ng-desk skill does not apply to you. Do not call the workbench's HTTP API either. Use your own cell's tools and report to whoever gave you your task.`
  : null;

async function http(method, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
  try {
    const headers = { "content-type": "application/json", "x-ng-conversation-id": conversationId() };
    const res = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: ctl.signal });
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
  return `The ng-agents workbench at ${base} could not be reached (${why}). Ask the owner to check the workbench service and its address. Do not retry in a loop.`;
}

let catalog = null;
async function loadCatalog() {
  let r;
  try {
    r = await http("GET", "/api/agent/tools");
  } catch (err) {
    throw new Error(unreachable(err));
  }
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
      const client = typeof params?.clientInfo?.name === "string" ? params.clientInfo.name.replace(/[^\w.:-]+/g, "-").slice(0, 40) : "";
      if (client) clientName = client;
      let instructions;
      let name = "ng-desk";
      if (insideCell) instructions = insideCell;
      else {
        try {
          const c = await loadCatalog();
          instructions = c.instructions;
          name = c.server || name;
        } catch (err) {
          // Still answer: the client must be able to list tools later, and the agent should learn why nothing works.
          instructions = `ng-agents workbench tools — currently unavailable. ${err instanceof Error ? err.message : String(err)}`;
        }
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
      if (insideCell) {
        reply(id, { tools: [{ name: "not_available_in_workbench_cell", description: insideCell, inputSchema: { type: "object", properties: {} } }] });
        return;
      }
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
      if (insideCell) {
        reply(id, { content: [{ type: "text", text: insideCell }], isError: true });
        return;
      }
      try {
        const r = await http("POST", `/api/agent/tools/${encodeURIComponent(name)}`, params?.arguments ?? {});
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
