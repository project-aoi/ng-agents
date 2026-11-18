import { isAbsolute, relative, resolve } from "node:path";
import type { CliAdapter, CliCapabilities, CliDriver, CliEvent, DriverIO, LaunchRequest } from "../types";
import { asRecord, contentText, HOST_UNSANDBOXED, num, str } from "./util";

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
 *   - Workspace access: reads allowed, edits/deletes/moves only for writing cells and only inside the workspace,
 *     commands only with bash, web only when enabled, everything else rejected. Writing cells with bash run with
 *     `--sandbox` (agy's terminal sandbox: Linux namespaces, project folder writable, no network; agy silently runs
 *     without it when user namespaces are unavailable).
 * - Steer: `session/cancel` the running prompt, then `session/prompt` with the steer text (same process and session).
 * - Usage: `session/prompt` result `usage.totalTokens` per turn; no cost is reported (cents 0). No native fork.
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
  const { caps } = req;
  return ["acp", ...(caps.access === "workspace" && !caps.readOnly && caps.bash ? ["--sandbox"] : []), ...req.extraArgs];
}

function describePermissions(caps: CliCapabilities): string {
  if (caps.access === "host") {
    const web = caps.web ? "web fetches, " : "";
    if (!caps.readOnly) {
      return `agy: host access, writing — the kernel's ACP client approves every permission request (edits/deletes/moves anywhere, commands, ${web}MCP tools, mode switches); no --sandbox; ${HOST_UNSANDBOXED}.`;
    }
    return `agy: host access, read-only — the kernel's ACP client approves reads and searches anywhere, ${web}and the kernel's MCP tools, and rejects every edit/delete/move, command, mode switch and unclassified request (enforced per call by the client; relies on agy asking, which its default mode does unless the owner's agy settings pre-allow a rule); no --sandbox.`;
  }
  if (caps.readOnly) {
    return `agy: read-only — every edit/command permission request is rejected by the kernel's ACP client (enforced per call by the client; relies on agy asking, which its default mode does unless the owner's agy settings pre-allow a rule).`;
  }
  const allowed = [caps.write || caps.edit ? "file edits inside the workspace" : null, caps.bash ? "commands" : null].filter(Boolean).join(" and ");
  const sandbox = caps.bash ? " Commands run in agy's terminal sandbox (--sandbox; OS namespaces, writes only in the project folder, no network — skipped by agy when unavailable)." : "";
  return `agy: writing — the kernel's ACP client approves ${allowed || "nothing beyond reads"} and rejects the rest.${sandbox}`;
}

type Pending = "initialize" | "session" | "model" | "prompt";

const PERMISSION_KINDS_READ = new Set(["read", "search", "think"]);
const PERMISSION_KINDS_WRITE = new Set(["edit", "delete", "move"]);

/**
 * Decide one `session/request_permission` from the cell's capabilities (exported for tests). ACP tool kinds: read,
 * edit, delete, move, search, execute, think, fetch, switch_mode, other.
 */
export function agyPermissionAllowed(toolCall: Record<string, unknown>, caps: CliCapabilities, serverName: string): boolean {
  const prefix = `mcp_${serverName}_`;
  if ((str(toolCall["name"]) ?? "").startsWith(prefix) || (str(toolCall["title"]) ?? "").startsWith(`Run ${prefix}`)) return true;
  const kind = str(toolCall["kind"]) ?? "other";
  if (caps.access === "host") {
    if (kind === "fetch") return caps.web;
    // A writing cell on the host may do anything the owner could; a read-only one reads/searches anywhere.
    return !caps.readOnly || PERMISSION_KINDS_READ.has(kind);
  }
  const paths = locationPaths(toolCall);
  const inside = paths.every((p) => isInside(caps.root, p));
  if (PERMISSION_KINDS_READ.has(kind)) return inside || caps.isolation === "none";
  if (PERMISSION_KINDS_WRITE.has(kind)) return !caps.readOnly && (caps.write || caps.edit) && inside;
  if (kind === "execute") return !caps.readOnly && caps.bash;
  if (kind === "fetch") return caps.web;
  return false;
}

function locationPaths(toolCall: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const l of Array.isArray(toolCall["locations"]) ? (toolCall["locations"] as unknown[]) : []) {
    const p = str(asRecord(l)["path"]);
    if (p) out.push(p);
  }
  const raw = asRecord(toolCall["rawInput"]);
  for (const k of ["path", "file_path", "filePath", "AbsolutePath", "TargetFile"]) {
    const p = str(raw[k]);
    if (p) out.push(p);
  }
  return out;
}

function isInside(root: string, p: string): boolean {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
  #queued: string[] = [];
  #text = "";
  #cancelled = false;

  constructor(req: LaunchRequest) {
    this.#req = req;
    this.argv = [req.bin, ...agyArgs(req)];
  }

  #request(io: DriverIO, method: string, params: unknown, kind: Pending): number {
    const id = this.#nextId++;
    this.#pending.set(id, kind);
    io.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return id;
  }

  #prompt(io: DriverIO, text: string): void {
    this.#cancelled = false;
    this.#promptId = this.#request(io, "session/prompt", { sessionId: this.#sessionId, prompt: [{ type: "text", text }] }, "prompt");
  }

  start(io: DriverIO): void {
    this.#request(io, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, "initialize");
  }

  steer(text: string, io: DriverIO): boolean {
    if (!this.#sessionId) {
      this.#queued.push(text);
      return true;
    }
    if (this.#promptId !== null) {
      this.#queued.push(text);
      this.interrupt(io);
    } else {
      this.#prompt(io, text);
    }
    return true;
  }

  interrupt(io: DriverIO): void {
    if (this.#promptId === null || !this.#sessionId || this.#cancelled) return;
    this.#cancelled = true;
    io.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.#sessionId } }));
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
        else this.#prompt(io, this.#req.prompt);
        break;
      case "model":
        if (error) out.push({ type: "notice", text: `agy: could not select model ${this.#req.model}: ${str(error["message"]) ?? "error"}; using the default` });
        else out.push({ type: "session", sessionId: this.#sessionId!, model: this.#req.model! });
        this.#prompt(io, this.#req.prompt);
        break;
      case "prompt": {
        this.#flushText(out);
        this.#promptId = null;
        const usage = asRecord(result["usage"]);
        const tokens = num(usage["totalTokens"]) || num(usage["inputTokens"]) + num(usage["outputTokens"]) + num(usage["cachedReadTokens"]) + num(usage["cachedWriteTokens"]) + num(usage["thoughtTokens"]);
        if (tokens > 0) out.push({ type: "usage", tokens, cents: 0 });
        const stopped = this.#cancelled || result["stopReason"] === "cancelled";
        const next = this.#queued.shift();
        if (next !== undefined) {
          this.#prompt(io, next);
          out.push({ type: "turn_end", ok: true, more: true, ...(stopped ? { stopped } : {}) });
          break;
        }
        if (error) out.push({ type: "turn_end", ok: false, error: str(error["message"]) ?? "prompt failed" });
        else if (result["stopReason"] === "refusal") out.push({ type: "turn_end", ok: false, refused: true });
        else out.push({ type: "turn_end", ok: true, ...(stopped ? { stopped } : {}) });
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
        if (name.startsWith(`mcp_${this.#req.mcp.serverName}_`)) break;
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
