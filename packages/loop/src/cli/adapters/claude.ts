import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliAdapter, CliCapabilities, CliDriver, CliEvent, LaunchRequest } from "../types";
import { asRecord, contentText, HOST_UNSANDBOXED, num, str } from "./util";

/**
 * Claude Code (`claude -p`), stream-json in and out.
 *
 * - Both access modes: the kernel's tools come from our bridge via `--mcp-config <file>`, allowed without prompting by
 *   `--allowedTools mcp__<server>`; `--permission-prompts none` denies anything that would still prompt (a headless
 *   Run never blocks).
 * - Host access (`caps.access` "host", docs/05 default): the owner's own Claude Code — user/project/local settings,
 *   login, skills and slash commands, and the owner's MCP servers next to ours (no `--restricted`, no
 *   `--strict-mcp-config`).
 *   - Writing: every built-in tool (no `--tools`) and `--permission-mode bypassPermissions`: reads, writes, commands
 *     and network anywhere, no OS sandbox. Only the owner's deny rules and the CLI's own safety checks still refuse
 *     (a safety check that asks is denied by `--permission-prompts none`).
 *   - Read-only: `--tools Read,Grep,Glob,WebFetch,WebSearch` (no Bash/Edit/Write exist in the session) and
 *     `--permission-mode dontAsk` with those tools allowed outright, plus `Read(//**)` so reads outside the working
 *     directory (which would otherwise prompt, i.e. be denied) are allowed too.
 * - Workspace access (an explicitly isolated cell): `--strict-mcp-config` (only our bridge) and `--restricted`
 *   (ignores user/project/local settings files — no foreign allow rules or hooks from the worktree —, confines the
 *   file tools to the working directory, refuses bypassPermissions).
 *   - Read-only: `--tools Read,Grep,Glob` (+ web tools when enabled) and `--permission-mode dontAsk`.
 *   - Writing: the allowed built-ins only (Write for write, Edit/NotebookEdit for edit, Bash for bash),
 *     `--permission-mode acceptEdits`, and for Bash the OS sandbox via `--settings` (bubblewrap on Linux: writes
 *     limited to the cwd and TMPDIR, no network, no unsandboxed retry; the CLI refuses to start if the sandbox is
 *     unavailable).
 * - Steer: stream-json input stays open, so a steer is written as another user message mid-run.
 * - Usage: per assistant message (partial) and per result (`model_usage_since_last_result`, incl. `costUSD`).
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
  if (caps.access === "host" && !caps.readOnly) return null;
  const tools = ["Read", "Grep", "Glob"];
  if (!caps.readOnly) {
    if (caps.write) tools.push("Write");
    if (caps.edit) tools.push("Edit", "NotebookEdit");
    if (caps.bash) tools.push("Bash");
  }
  if (caps.web) tools.push("WebFetch", "WebSearch");
  return tools;
}

/** Bubblewrap sandbox for Bash: no unsandboxed fallback, fail closed when the sandbox cannot start. */
export const CLAUDE_SANDBOX_SETTINGS = {
  sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true },
} as const;

/** Only a writing workspace cell with Bash runs under the bubblewrap sandbox settings. */
function bashSandboxed(caps: CliCapabilities): boolean {
  return caps.access === "workspace" && !caps.readOnly && caps.bash;
}

/** `--allowedTools`: what runs without a prompt under the chosen permission mode. */
function allowedTools(req: LaunchRequest): string[] {
  const { caps } = req;
  const kernel = `mcp__${req.mcp.serverName}`;
  if (caps.access === "workspace") return [kernel, ...(caps.readOnly || !caps.bash ? [] : ["Bash"])];
  if (!caps.readOnly) return [kernel]; // bypassPermissions allows the rest
  // dontAsk denies whatever no rule allows: the bare names allow each tool outright, and `Read(//**)` (any absolute
  // path; Read rules also govern Grep and Glob) allows reads outside the working directory, which ask by default.
  // Unverified without a live run: whether the bare `Read` rule alone would already cover those (kept both).
  return [kernel, ...(claudeBuiltinTools(caps) ?? []), "Read(//**)"];
}

export function claudeArgs(req: LaunchRequest, files: { mcpConfig: string; settings?: string }): string[] {
  const { caps } = req;
  const host = caps.access === "host";
  const tools = claudeBuiltinTools(caps);
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--mcp-config", files.mcpConfig,
    ...(host ? [] : ["--strict-mcp-config", "--restricted"]),
    ...(tools ? ["--tools", tools.join(",")] : []),
    "--allowedTools", allowedTools(req).join(","),
    "--permission-prompts", "none",
    "--permission-mode", caps.readOnly ? "dontAsk" : host ? "bypassPermissions" : "acceptEdits",
    "--append-system-prompt-file", req.systemFile,
  ];
  if (files.settings && bashSandboxed(caps)) args.push("--settings", files.settings);
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
  if (caps.access === "host") {
    if (!caps.readOnly) {
      return `claude: host access, writing — every built-in tool (incl. Bash, web tools, skills and slash commands) under --permission-mode bypassPermissions: reads, writes, commands and network anywhere; the owner's settings, login and MCP servers are loaded; ${HOST_UNSANDBOXED}.`;
    }
    return `claude: host access, read-only — built-in tools limited to ${tools} (enforced: no write/shell tool exists in the session), reading any path the user can read${caps.web ? " and the web" : ""}; the owner's settings, login and MCP servers are loaded (an owner MCP tool runs only if the owner's own allow rules pre-approve it); anything else that would prompt is denied.`;
  }
  if (caps.readOnly) {
    return `claude: read-only — built-in tools limited to ${tools} (enforced: no write/shell tool exists in the session); file tools confined to ${caps.root} by --restricted; anything that would prompt is denied.`;
  }
  const sandbox = caps.bash
    ? ` Bash runs in Claude Code's bubblewrap sandbox (enforced by the OS: writes only in the working directory and TMPDIR, no network; the CLI exits if the sandbox cannot start).`
    : "";
  return `claude: writing — built-in tools ${tools}; Edit/Write auto-accepted inside ${caps.root} only (enforced by Claude Code's permission check, not by the OS).${sandbox}`;
}

class ClaudeDriver implements CliDriver {
  readonly argv: readonly string[];
  readonly #req: LaunchRequest;
  readonly #mcpPrefix: string;
  readonly #native = new Map<string, string>();
  readonly #seenText = new Set<string>();
  /** Tokens already reported per assistant message id (stream figures are partial; the result reconciles). */
  readonly #msgTokens = new Map<string, number>();
  readonly #msgCached = new Map<string, number>();
  #turnTokens = 0;
  #turnCached = 0;
  #controlSeq = 0;
  #stopping = false;
  /** stop_reason of the latest top-level assistant message ("refusal" → the turn is reported as refused). */
  #lastStop: string | null = null;

  constructor(req: LaunchRequest) {
    this.#req = req;
    this.#mcpPrefix = `mcp__${req.mcp.serverName}__`;
    const mcpConfig = join(req.tmpDir, "claude-mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [req.mcp.serverName]: { type: "stdio", ...req.mcp.launch } } }), { mode: 0o600 });
    let settings: string | undefined;
    if (bashSandboxed(req.caps)) {
      settings = join(req.tmpDir, "claude-settings.json");
      writeFileSync(settings, JSON.stringify(CLAUDE_SANDBOX_SETTINGS), { mode: 0o600 });
    }
    this.argv = [req.bin, ...claudeArgs(req, { mcpConfig, ...(settings ? { settings } : {}) })];
  }

  start(io: { write(line: string): void }): void {
    io.write(userLine(this.#req.prompt));
  }

  steer(text: string, io: { write(line: string): void }): boolean {
    io.write(userLine(text));
    return true;
  }

  interrupt(io: { write(line: string): void }): void {
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
        if (msg["parent_tool_use_id"]) break; // subagent traffic: its usage reaches the result totals
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
        const u = asRecord(message["usage"]);
        const tokens = num(u["input_tokens"]) + num(u["output_tokens"]) + num(u["cache_read_input_tokens"]) + num(u["cache_creation_input_tokens"]);
        const prev = this.#msgTokens.get(id) ?? 0;
        if (tokens > prev) {
          const cachedNow = Math.min(num(u["cache_read_input_tokens"]), tokens);
          const cached = Math.max(0, Math.min(tokens - prev, cachedNow - (this.#msgCached.get(id) ?? 0)));
          this.#msgTokens.set(id, tokens);
          this.#msgCached.set(id, Math.max(cachedNow, this.#msgCached.get(id) ?? 0));
          this.#turnTokens += tokens - prev;
          this.#turnCached += cached;
          out.push({ type: "usage", tokens: tokens - prev, cents: 0, ...(cached > 0 ? { cached } : {}) });
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
        const { tokens, cached, costUsd } = resultUsage(msg);
        const rest = Math.max(0, tokens - this.#turnTokens);
        const restCached = Math.min(rest, Math.max(0, cached - this.#turnCached));
        this.#turnTokens = 0;
        this.#turnCached = 0;
        this.#msgTokens.clear();
        this.#msgCached.clear();
        if (rest > 0 || costUsd > 0) out.push({ type: "usage", tokens: rest, cents: costUsd * 100, ...(restCached > 0 ? { cached: restCached } : {}) });
        const isError = msg["is_error"] === true;
        const subtype = str(msg["subtype"]) ?? "";
        if (isError && this.#req.session && num(msg["num_turns"]) === 0 && subtype === "error_during_execution") {
          out.push({ type: "resume_failed", message: `claude could not ${this.#req.session.mode} session ${this.#req.session.id}` });
          break;
        }
        const more = num(msg["queued_turn_count"]) > 0;
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

/** This turn's usage: `model_usage_since_last_result` (per turn) when present, else the result's own totals. */
function resultUsage(msg: Record<string, unknown>): { tokens: number; cached: number; costUsd: number } {
  const since = asRecord(msg["model_usage_since_last_result"]);
  const models = Object.values(since).map(asRecord);
  if (models.length > 0) {
    let tokens = 0;
    let cached = 0;
    let costUsd = 0;
    for (const m of models) {
      tokens += num(m["inputTokens"]) + num(m["outputTokens"]) + num(m["cacheReadInputTokens"]) + num(m["cacheCreationInputTokens"]);
      cached += num(m["cacheReadInputTokens"]);
      costUsd += num(m["costUSD"]);
    }
    return { tokens, cached, costUsd };
  }
  const u = asRecord(msg["usage"]);
  return {
    tokens: num(u["input_tokens"]) + num(u["output_tokens"]) + num(u["cache_read_input_tokens"]) + num(u["cache_creation_input_tokens"]),
    cached: num(u["cache_read_input_tokens"]),
    costUsd: num(msg["total_cost_usd"]),
  };
}

function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}
