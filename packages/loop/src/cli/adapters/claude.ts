import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliAdapter, CliCapabilities, CliDriver, CliEvent, LaunchRequest } from "../types";
import { asRecord, contentText, HOST_UNSANDBOXED, num, str } from "./util";

/**
 * Claude Code (`claude -p`), stream-json in and out.
 *
 * - The kernel's tools come from our bridge via `--mcp-config <file>`, allowed without prompting by
 *   `--allowedTools mcp__<server>`; `--permission-prompts none` denies anything that would still prompt (a headless
 *   Run never blocks).
 * - Host access: the owner's own Claude Code — user/project/local settings,
 *   login, skills and slash commands, and the owner's MCP servers next to ours (no `--restricted`, no
 *   `--strict-mcp-config`).
 *   - Writing: every built-in tool (no `--tools`) and `--permission-mode bypassPermissions`: reads, writes, commands
 *     and network anywhere, no OS sandbox. Only the owner's deny rules and the CLI's own safety checks still refuse
 *     (a safety check that asks is denied by `--permission-prompts none`).
 *   - Read-only: `--tools Read,Grep,Glob,WebFetch,WebSearch` (no Bash/Edit/Write exist in the session) and
 *     `--permission-mode dontAsk` with those tools allowed outright, plus `Read(//**)` so reads outside the working
 *     directory (which would otherwise prompt, i.e. be denied) are allowed too.
 * - Steer: stream-json input stays open, so a steer is written as another user message mid-run.
 */
export function claudeAdapter(): CliAdapter {
  return {
    engine: "claude",
    defaultBin: "claude",
    defaultModels: { strong: "", fast: "" },
    canFork: true,
    mcpToolName: (server, tool) => `mcp__${server}__${tool}`,
    createDriver: (req) => new ClaudeDriver(req),
    describePermissions,
    readOnlyHowTo: (caps) => `Read with Read, Grep and Glob (any path on this machine)${caps.web ? ", and use WebFetch / WebSearch for the web" : ""}. There is no shell and no edit tool in this session.`,
    // Claude Code defers MCP tool schemas behind a search tool when there are many. A cell's kernel tools are its only
    // way to act, and a call made from the tool's name alone (wrong field names) costs a failed step — load them all.
    env: { ENABLE_TOOL_SEARCH: "false" },
  };
}

/** The built-in tools offered (`--tools`); `null` = no restriction, the CLI's full default set (host writing cells). */
export function claudeBuiltinTools(caps: CliCapabilities): string[] | null {
  if (!caps.readOnly) return null;
  const tools = ["Read", "Grep", "Glob"];
  if (caps.web) tools.push("WebFetch", "WebSearch");
  return tools;
}

/** `--allowedTools`: what runs without a prompt under the chosen permission mode. */
function allowedTools(req: LaunchRequest): string[] {
  const { caps } = req;
  const kernel = `mcp__${req.mcp.serverName}`;
  if (!caps.readOnly) return [kernel]; // bypassPermissions allows the rest
  // dontAsk denies whatever no rule allows: the bare names allow each tool outright, and `Read(//**)` (any absolute
  // path; Read rules also govern Grep and Glob) allows reads outside the working directory, which ask by default.
  // Unverified without a live run: whether the bare `Read` rule alone would already cover those (kept both).
  return [kernel, ...(claudeBuiltinTools(caps) ?? []), "Read(//**)"];
}

export function claudeArgs(req: LaunchRequest, files: { mcpConfig: string }): string[] {
  const { caps } = req;
  const tools = claudeBuiltinTools(caps);
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--mcp-config", files.mcpConfig,
    ...(tools ? ["--tools", tools.join(",")] : []),
    "--allowedTools", allowedTools(req).join(","),
    "--permission-prompts", "none",
    "--permission-mode", caps.readOnly ? "dontAsk" : "bypassPermissions",
    "--append-system-prompt-file", req.systemFile,
  ];
  if (req.model) args.push("--model", req.model);
  if (req.effort) args.push("--effort", req.effort);
  if (req.session) {
    args.push("--resume", req.session.id);
    if (req.session.mode === "fork") args.push("--fork-session");
  }
  args.push(...req.extraArgs);
  return args;
}

function describePermissions(caps: CliCapabilities): string {
  const tools = claudeBuiltinTools(caps)?.join(", ") ?? "all";
  if (!caps.readOnly) {
    return `claude: host access, writing — every built-in tool (incl. Bash, web tools, skills and slash commands) under --permission-mode bypassPermissions: reads, writes, commands and network anywhere; the owner's settings, login and MCP servers are loaded; ${HOST_UNSANDBOXED}.`;
  }
  return `claude: host access, read-only — built-in tools limited to ${tools} (enforced: no write/shell tool exists in the session), reading any path the user can read${caps.web ? " and the web" : ""}; the owner's settings, login and MCP servers are loaded (an owner MCP tool runs only if the owner's own allow rules pre-approve it); anything else that would prompt is denied.`;
}

class ClaudeDriver implements CliDriver {
  readonly argv: readonly string[];
  readonly #req: LaunchRequest;
  readonly #mcpPrefix: string;
  readonly #native = new Map<string, string>();
  readonly #seenText = new Set<string>();
  #controlSeq = 0;
  #stopping = false;
  #completedTurns = 0;
  /** stop_reason of the latest top-level assistant message ("refusal" → the turn is reported as refused). */
  #lastStop: string | null = null;

  constructor(req: LaunchRequest) {
    this.#req = req;
    this.#mcpPrefix = `mcp__${req.mcp.serverName}__`;
    const mcpConfig = join(req.tmpDir, "claude-mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [req.mcp.serverName]: { type: "stdio", ...req.mcp.launch } } }), { mode: 0o600 });
    this.argv = [req.bin, ...claudeArgs(req, { mcpConfig })];
  }

  start(io: { write(line: string): boolean }): void {
    io.write(userLine(this.#req.prompt));
  }

  steer(text: string, io: { write(line: string): boolean }): boolean {
    return io.write(userLine(text));
  }

  interrupt(io: { write(line: string): boolean }): void {
    if (this.#stopping) return;
    this.#stopping = true;
    io.write(JSON.stringify({ type: "control_request", request_id: `ng_interrupt_${++this.#controlSeq}`, request: { subtype: "interrupt" } }));
  }

  finish(io: { end(): void }): void {
    io.end();
  }

  onLine(line: string): CliEvent[] {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    const out: CliEvent[] = [];
    switch (msg["type"]) {
      case "system":
        if (msg["subtype"] === "init" && typeof msg["session_id"] === "string") {
          out.push({ type: "session", sessionId: msg["session_id"], ...(typeof msg["model"] === "string" ? { model: msg["model"] } : {}) });
        }
        break;
      case "assistant": {
        if (msg["parent_tool_use_id"]) break; // only top-level replies belong to this run
        const message = asRecord(msg["message"]);
        const id = str(message["id"]) ?? "";
        if (typeof message["stop_reason"] === "string") this.#lastStop = message["stop_reason"];
        for (const block of Array.isArray(message["content"]) ? (message["content"] as unknown[]) : []) {
          const b = asRecord(block);
          if (b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim()) {
            const key = `${id}:${b["text"]}`;
            if (this.#seenText.has(key)) continue;
            this.#seenText.add(key);
            out.push({ type: "text", text: b["text"] });
          } else if (b["type"] === "tool_use" && typeof b["id"] === "string" && typeof b["name"] === "string") {
            if (b["name"].startsWith(this.#mcpPrefix) || this.#native.has(b["id"])) continue;
            this.#native.set(b["id"], b["name"]);
            out.push({ type: "tool_start", id: b["id"], name: b["name"], input: b["input"] ?? {} });
          }
        }
        break;
      }
      case "user": {
        if (msg["parent_tool_use_id"]) break;
        const message = asRecord(msg["message"]);
        for (const block of Array.isArray(message["content"]) ? (message["content"] as unknown[]) : []) {
          const b = asRecord(block);
          if (b["type"] !== "tool_result" || typeof b["tool_use_id"] !== "string") continue;
          const name = this.#native.get(b["tool_use_id"]);
          if (!name) continue;
          this.#native.delete(b["tool_use_id"]);
          out.push({ type: "tool_end", id: b["tool_use_id"], name, output: contentText(b["content"]), ...(b["is_error"] === true ? { isError: true } : {}) });
        }
        break;
      }
      case "result": {
        const isError = msg["is_error"] === true;
        const subtype = str(msg["subtype"]) ?? "";
        if (isError && this.#completedTurns === 0 && this.#req.session && num(msg["num_turns"]) === 0 && subtype === "error_during_execution") {
          out.push({ type: "resume_failed", message: `claude could not ${this.#req.session.mode} session ${this.#req.session.id}` });
          break;
        }
        this.#completedTurns++;
        const more = !isError && num(msg["queued_turn_count"]) > 0;
        const stopped = this.#stopping;
        this.#stopping = false;
        const refused = this.#lastStop === "refusal" || str(msg["stop_reason"]) === "refusal";
        this.#lastStop = null;
        if (refused && !stopped) {
          out.push({ type: "turn_end", ok: false, refused: true, ...(more ? { more } : {}) });
          break;
        }
        out.push({
          type: "turn_end",
          ok: !isError,
          ...(isError ? { error: str(msg["result"]) ?? (Array.isArray(msg["errors"]) ? (msg["errors"] as unknown[]).join("; ") : subtype || "error") } : {}),
          ...(more ? { more } : {}),
          ...(stopped ? { stopped } : {}),
        });
        break;
      }
    }
    return out;
  }
}

function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}
