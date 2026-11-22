import type { CliAdapter, CliCapabilities, CliDriver, CliEvent, DriverIO, LaunchRequest } from "../types";
import { asRecord, contentText, HOST_UNSANDBOXED, str } from "./util";

/**
 * Google Antigravity CLI through its Agent Client Protocol server (`agy acp`, JSON-RPC over stdio). Print mode has no
 * per-invocation MCP or system-prompt option (only global/workspace config files), ACP has both:
 *
 * - `session/new` (or `session/resume`) carries `cwd`, the bridge as a stdio MCP server, and the frozen system text
 *   as `_meta.antigravity.systemPrompt.append`. Nothing is written to ~/.gemini or the workspace; the owner's agy
 *   login and settings load as usual.
 * - Permissions: in the default mode agy asks the client before every edit, command and MCP call
 *   (`session/request_permission`); this client answers from the cell's capabilities (`agyPermissionAllowed`). The
 *   kernel's MCP tools are always allowed; the owner's own allow rules in agy's settings.json still apply first.
 *   - Host access, writing (docs/05 default): everything is approved — edits/deletes/moves anywhere, commands, web
 *     fetches, the ACP catch-all kinds (`switch_mode`, `other`, e.g. the owner's own MCP tools). No `--sandbox`.
 *   - Host access, read-only: reads/searches anywhere and web fetches approved; edits/deletes/moves, commands, mode
 *     switches (a switch could stop agy from asking) and unclassified requests rejected. No `--sandbox`.
 * - Steer: `session/cancel` the running prompt, then `session/prompt` with the steer text (same process and session).
 */
export function agyAdapter(): CliAdapter {
  return {
    engine: "agy",
    defaultBin: "agy",
    defaultModels: { strong: "", fast: "" },
    canFork: false,
    mcpToolName: (server, tool) => `mcp_${server}_${tool}`,
    createDriver: (req) => new AgyDriver(req),
    describePermissions,
    readOnlyHowTo: (caps) =>
      `Read with your file viewing and search tools (any path on this machine)${caps.web ? ", and fetch web pages when needed" : ""}. Requests to edit files or to run commands are rejected in this session.`,
  };
}

export function agyArgs(req: LaunchRequest): string[] {
  return ["acp", ...req.extraArgs];
}

function describePermissions(caps: CliCapabilities): string {
  const web = caps.web ? "web fetches, " : "";
  if (!caps.readOnly) {
    return `agy: host access, writing — the kernel's ACP client approves every permission request (edits/deletes/moves anywhere, commands, ${web}MCP tools, mode switches); no --sandbox; ${HOST_UNSANDBOXED}.`;
  }
  return `agy: host access, read-only — the kernel's ACP client approves reads and searches anywhere, ${web}and the kernel's MCP tools, and rejects every edit/delete/move, command, mode switch and unclassified request (enforced per call by the client; relies on agy asking, which its default mode does unless the owner's agy settings pre-allow a rule); no --sandbox.`;
}

type Pending = "initialize" | "session" | "model" | "prompt";

const PERMISSION_KINDS_READ = new Set(["read", "search", "think"]);

/**
 * Decide one `session/request_permission` from the cell's capabilities (exported for tests). ACP tool kinds: read,
 * edit, delete, move, search, execute, think, fetch, switch_mode, other.
 */
function isBridgeTool(toolCall: Record<string, unknown>, serverName: string): boolean {
  const prefix = `mcp_${serverName}_`;
  return (str(toolCall["name"]) ?? "").startsWith(prefix) || (str(toolCall["title"]) ?? "").startsWith(`Run ${prefix}`);
}

export function agyPermissionAllowed(toolCall: Record<string, unknown>, caps: CliCapabilities, serverName: string): boolean {
  if (isBridgeTool(toolCall, serverName)) return true;
  const kind = str(toolCall["kind"]) ?? "other";
  if (kind === "fetch") return caps.web;
  // A writing cell on the host may do anything the owner could; a read-only one reads/searches anywhere.
  return !caps.readOnly || PERMISSION_KINDS_READ.has(kind);
}

class AgyDriver implements CliDriver {
  readonly argv: readonly string[];
  readonly #req: LaunchRequest;
  readonly #pending = new Map<number, Pending>();
  readonly #native = new Map<string, string>();
  readonly #finished = new Set<string>();
  #nextId = 1;
  #sessionId: string | null = null;
  #promptId: number | null = null;
  #initialPromptSent = false;
  #queued: string[] = [];
  #text = "";
  #cancelled = false;

  constructor(req: LaunchRequest) {
    this.#req = req;
    this.argv = [req.bin, ...agyArgs(req)];
  }

  #request(io: DriverIO, method: string, params: unknown, kind: Pending): number | null {
    const id = this.#nextId++;
    this.#pending.set(id, kind);
    if (!io.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }))) {
      this.#pending.delete(id);
      return null;
    }
    return id;
  }

  #prompt(io: DriverIO, text: string): boolean {
    this.#cancelled = false;
    const id = this.#request(io, "session/prompt", { sessionId: this.#sessionId, prompt: [{ type: "text", text }] }, "prompt");
    if (id === null) return false;
    this.#promptId = id;
    return true;
  }

  start(io: DriverIO): void {
    this.#request(io, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, "initialize");
  }

  steer(text: string, io: DriverIO): boolean {
    if (!this.#initialPromptSent) {
      this.#queued.push(text);
      return true;
    }
    if (this.#promptId !== null) {
      const ok = this.#sendCancel(io);
      if (!ok) return false;
      this.#queued.push(text);
      return true;
    }
    return this.#prompt(io, text);
  }

  #sendCancel(io: DriverIO): boolean {
    if (this.#promptId === null || !this.#sessionId) return false;
    if (this.#cancelled) return true;
    const ok = io.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.#sessionId } }));
    if (ok) this.#cancelled = true;
    return ok;
  }

  interrupt(io: DriverIO): void {
    this.#sendCancel(io);
  }

  finish(io: DriverIO): void {
    io.end();
  }

  onLine(line: string, io: DriverIO): CliEvent[] {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    const out: CliEvent[] = [];
    const method = str(msg["method"]);
    if (method && msg["id"] !== undefined) {
      this.#agentRequest(msg, method, io, out);
      return out;
    }
    if (method === "session/update") {
      this.#update(asRecord(asRecord(msg["params"])["update"]), out);
      return out;
    }
    if (method) return out;
    const id = typeof msg["id"] === "number" ? msg["id"] : Number(msg["id"]);
    const kind = this.#pending.get(id);
    if (!kind) return out;
    this.#pending.delete(id);
    const error = msg["error"] !== undefined ? asRecord(msg["error"]) : null;
    const result = asRecord(msg["result"]);
    switch (kind) {
      case "initialize":
        if (error) {
          out.push({ type: "turn_end", ok: false, error: `agy acp initialize failed: ${str(error["message"]) ?? "error"}` });
          break;
        }
        this.#openSession(io);
        break;
      case "session":
        if (error) {
          const message = str(error["message"]) ?? "session error";
          out.push(this.#req.session ? { type: "resume_failed", message } : { type: "turn_end", ok: false, error: message });
          break;
        }
        this.#sessionId = str(result["sessionId"]) ?? this.#req.session?.id ?? null;
        if (!this.#sessionId) {
          out.push({ type: "turn_end", ok: false, error: "agy acp returned no session id" });
          break;
        }
        out.push({ type: "session", sessionId: this.#sessionId, ...(str(asRecord(result["models"])["currentModelId"]) ? { model: str(asRecord(result["models"])["currentModelId"])! } : {}) });
        if (this.#req.model) this.#request(io, "session/set_model", { sessionId: this.#sessionId, modelId: this.#req.model }, "model");
        else this.#initialPromptSent = this.#prompt(io, this.#req.prompt);
        break;
      case "model":
        if (error) out.push({ type: "notice", text: `agy: could not select model ${this.#req.model}: ${str(error["message"]) ?? "error"}; using the default` });
        else out.push({ type: "session", sessionId: this.#sessionId!, model: this.#req.model! });
        this.#initialPromptSent = this.#prompt(io, this.#req.prompt);
        break;
      case "prompt": {
        this.#flushText(out);
        this.#promptId = null;
        const stopped = this.#cancelled || result["stopReason"] === "cancelled";
        if (stopped && !this.#cancelled && !error) {
          this.#queued.length = 0;
          out.push({ type: "turn_end", ok: false, error: "agy stopped the prompt before completion" });
          break;
        }
        if (error || result["stopReason"] === "refusal") {
          this.#queued.length = 0;
          out.push(error
            ? { type: "turn_end", ok: false, more: false, error: str(error["message"]) ?? "prompt failed" }
            : { type: "turn_end", ok: false, more: false, refused: true });
          break;
        }
        if (io.acceptingPrompts?.() === false) this.#queued.length = 0;
        const next = this.#queued.shift();
        if (next !== undefined && !this.#prompt(io, next)) {
          this.#queued.length = 0;
          out.push({ type: "turn_end", ok: false, more: false, error: "stdin closed before queued prompt could be sent" });
          break;
        }
        out.push({ type: "turn_end", ok: true, ...(stopped ? { stopped } : {}), ...(next !== undefined ? { more: true } : {}) });
        break;
      }
    }
    return out;
  }

  #openSession(io: DriverIO): void {
    const mcpServers = [
      {
        name: this.#req.mcp.serverName,
        command: this.#req.mcp.launch.command,
        args: this.#req.mcp.launch.args,
        env: Object.entries(this.#req.mcp.launch.env).map(([name, value]) => ({ name, value })),
      },
    ];
    const base = { cwd: this.#req.cwd, mcpServers };
    if (this.#req.session) this.#request(io, "session/resume", { ...base, sessionId: this.#req.session.id }, "session");
    else this.#request(io, "session/new", { ...base, _meta: { antigravity: { systemPrompt: { append: this.#req.system } } } }, "session");
  }

  #agentRequest(msg: Record<string, unknown>, method: string, io: DriverIO, out: CliEvent[]): void {
    const id = msg["id"];
    if (method === "session/request_permission") {
      const params = asRecord(msg["params"]);
      const toolCall = asRecord(params["toolCall"]);
      const options = (Array.isArray(params["options"]) ? (params["options"] as unknown[]) : []).map(asRecord);
      const allowed = agyPermissionAllowed(toolCall, this.#req.caps, this.#req.mcp.serverName);
      const pick = options.find((o) => o["kind"] === (allowed ? "allow_once" : "reject_once")) ?? options.find((o) => String(o["kind"]).startsWith(allowed ? "allow" : "reject"));
      const outcome = pick ? { outcome: "selected", optionId: pick["optionId"] } : { outcome: "cancelled" };
      io.write(JSON.stringify({ jsonrpc: "2.0", id, result: { outcome } }));
      if (!allowed) {
        out.push({ type: "notice", text: `agy: refused ${str(toolCall["kind"]) ?? "tool"} "${str(toolCall["title"]) ?? str(toolCall["name"]) ?? "?"}" (outside this cell's permissions)` });
      }
      return;
    }
    io.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not supported by this client: ${method}` } }));
  }

  #update(update: Record<string, unknown>, out: CliEvent[]): void {
    switch (update["sessionUpdate"]) {
      case "agent_message_chunk": {
        const c = asRecord(update["content"]);
        if (typeof c["text"] === "string") this.#text += c["text"];
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.#flushText(out);
        const id = str(update["toolCallId"]);
        if (!id || this.#finished.has(id)) break;
        const name = str(update["name"]) ?? str(update["title"]) ?? "tool";
        if (isBridgeTool(update, this.#req.mcp.serverName)) break;
        if (!this.#native.has(id)) {
          this.#native.set(id, name);
          out.push({ type: "tool_start", id, name, input: update["rawInput"] ?? update["args"] ?? {} });
        }
        const status = update["status"];
        if (status === "completed" || status === "failed") {
          this.#native.delete(id);
          this.#finished.add(id);
          const output = contentText(update["content"]) || (update["rawOutput"] !== undefined ? contentText(update["rawOutput"]) : "") || String(status);
          out.push({ type: "tool_end", id, name, output, ...(status === "failed" ? { isError: true } : {}) });
        }
        break;
      }
    }
  }

  #flushText(out: CliEvent[]): void {
    if (this.#text.trim()) out.push({ type: "text", text: this.#text });
    this.#text = "";
  }
}
