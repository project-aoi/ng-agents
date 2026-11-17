import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** MCP protocol revisions the bridge can speak (newest first). Tools-only servers behave the same in all of them. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** Absolute path of the stdio shim a CLI spawns as its MCP server (`node <path>`). */
export const MCP_SHIM_PATH = join(dirname(fileURLToPath(import.meta.url)), "mcp-shim.mjs");

export interface BridgeToolSpec {
  name: string;
  description: string;
  inputSchema: { [key: string]: unknown };
}

export interface BridgeCallResult {
  text: string;
  isError?: boolean;
}

export interface ToolBridgeOptions {
  /** Server name the CLI is configured with (tool names appear to the model as e.g. `mcp__<name>__<tool>`). */
  serverName?: string;
  serverVersion?: string;
  /** Optional MCP `instructions` returned from initialize. */
  instructions?: string;
  tools: readonly BridgeToolSpec[];
  /**
   * Executes one tools/call. Calls are serialized by the bridge (one at a time, in arrival order), like the API loop
   * runs a step's tool calls in order. A thrown error becomes an isError result.
   */
  call(name: string, args: unknown, meta: { requestId: string; signal: AbortSignal }): Promise<BridgeCallResult>;
  /** Interpreter for the shim. Default: the kernel's own Node binary. */
  nodePath?: string;
  /** Diagnostics (handshakes, refused connections, protocol errors). */
  onLog?(event: BridgeLogEvent): void;
}

export type BridgeLogEvent =
  | { type: "connected"; connections: number }
  | { type: "auth_failed"; reason: string }
  | { type: "initialize"; protocolVersion: string; clientInfo?: unknown }
  | { type: "request"; method: string }
  | { type: "protocol_error"; message: string };

export interface McpServerLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ToolBridge {
  readonly serverName: string;
  readonly port: number;
  /** Directory (0700) holding the token file; removed by close(). */
  readonly dir: string;
  readonly tokenFile: string;
  /** How a CLI must start the stdio side: `node mcp-shim.mjs` with the bridge address and token file. */
  readonly launch: McpServerLaunch;
  /** Number of authenticated MCP sessions so far (a CLI may restart its server). */
  sessions(): number;
  /** Refuse further tools/call requests with this message (the Run has ended); listing still works. */
  refuseCalls(message: string): void;
  /** Close every connection, stop listening and delete the token. Idempotent. */
  close(): Promise<void>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const AUTH_TIMEOUT_MS = 5_000;
const MAX_LINE_CHARS = 16 * 1024 * 1024;

/**
 * Per-Run MCP server reachable only on 127.0.0.1 with a per-Run random credential. The CLI agent spawns the stdio shim
 * (`launch`), which authenticates with the token from a 0600 file and relays newline-delimited JSON-RPC; the bridge
 * speaks MCP (initialize, tools/list, tools/call, ping, cancellation) and runs the calls in the kernel process, so
 * every tool executes against this Run's ports.
 */
export async function startToolBridge(opts: ToolBridgeOptions): Promise<ToolBridge> {
  const serverName = opts.serverName ?? "ng";
  const token = randomBytes(32).toString("hex");
  const tokenBuf = Buffer.from(token);
  const dir = mkdtempSync(join(tmpdir(), "ng-bridge-"));
  chmodSync(dir, 0o700);
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, token, { mode: 0o600 });

  const sockets = new Set<Socket>();
  const callAborts = new Map<string, AbortController>();
  let sessions = 0;
  let refusal: string | null = null;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const log = (e: BridgeLogEvent) => {
    try {
      opts.onLog?.(e);
    } catch {
      // diagnostics never break the bridge
    }
  };

  const server: Server = createServer((socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    let authed = false;
    let buf = "";
    const authTimer = setTimeout(() => {
      if (!authed) {
        log({ type: "auth_failed", reason: "timeout" });
        socket.destroy();
      }
    }, AUTH_TIMEOUT_MS);
    socket.on("close", () => {
      clearTimeout(authTimer);
      sockets.delete(socket);
    });
    socket.on("error", () => undefined);

    const send = (msg: object) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    };

    socket.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE_CHARS) {
        log({ type: "protocol_error", message: "message too large" });
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          if (!authed) {
            socket.destroy();
            return;
          }
          send({ id: null, error: { code: -32700, message: "Parse error" } });
          continue;
        }
        if (!authed) {
          const given = typeof (msg as { ngBridgeAuth?: unknown }).ngBridgeAuth === "string" ? Buffer.from((msg as { ngBridgeAuth: string }).ngBridgeAuth) : null;
          if (!given || given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) {
            log({ type: "auth_failed", reason: "bad token" });
            socket.destroy();
            return;
          }
          authed = true;
          clearTimeout(authTimer);
          sessions++;
          log({ type: "connected", connections: sessions });
          continue;
        }
        handle(msg, send);
      }
    });
  });

  function handle(msg: JsonRpcMessage, send: (m: object) => void): void {
    const { id, method } = msg;
    if (method === undefined) return; // a response to nothing we asked: ignore
    const isRequest = id !== undefined && id !== null;
    if (!isRequest) {
      if (method === "notifications/cancelled") {
        const requestId = (msg.params as { requestId?: unknown } | undefined)?.requestId;
        if (requestId !== undefined) callAborts.get(String(requestId))?.abort(new Error("cancelled by the client"));
      }
      return;
    }
    log({ type: "request", method });
    switch (method) {
      case "initialize": {
        const params = (msg.params ?? {}) as { protocolVersion?: unknown; clientInfo?: unknown };
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[1];
        log({ type: "initialize", protocolVersion, clientInfo: params.clientInfo });
        send({
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: serverName, version: opts.serverVersion ?? "1.0.0" },
            ...(opts.instructions ? { instructions: opts.instructions } : {}),
          },
        });
        return;
      }
      case "ping":
        send({ id, result: {} });
        return;
      case "tools/list":
        send({ id, result: { tools: opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } });
        return;
      case "resources/list":
        send({ id, result: { resources: [] } });
        return;
      case "resources/templates/list":
        send({ id, result: { resourceTemplates: [] } });
        return;
      case "prompts/list":
        send({ id, result: { prompts: [] } });
        return;
      case "tools/call": {
        const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === "string" ? params.name : "";
        const requestId = String(id);
        const ac = new AbortController();
        callAborts.set(requestId, ac);
        const run = async (): Promise<BridgeCallResult> => {
          if (refusal !== null) return { text: refusal, isError: true };
          if (!opts.tools.some((t) => t.name === name)) {
            return { text: `Unknown tool "${name}". Available: ${opts.tools.map((t) => t.name).join(", ") || "none"}.`, isError: true };
          }
          try {
            return await opts.call(name, params.arguments ?? {}, { requestId, signal: ac.signal });
          } catch (err) {
            return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        };
        const p = queue.then(run, run);
        queue = p.catch(() => undefined);
        void p.then((r) => {
          callAborts.delete(requestId);
          send({ id, result: { content: [{ type: "text", text: r.text }], isError: r.isError === true } });
        });
        return;
      }
      default:
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("tool bridge: no TCP address");
  const port = address.port;

  return {
    serverName,
    port,
    dir,
    tokenFile,
    launch: {
      command: opts.nodePath ?? process.execPath,
      args: [MCP_SHIM_PATH],
      env: { NG_BRIDGE_PORT: String(port), NG_BRIDGE_TOKEN_FILE: tokenFile },
    },
    sessions: () => sessions,
    refuseCalls(message) {
      refusal = message;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const ac of callAborts.values()) ac.abort(new Error("run ended"));
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
