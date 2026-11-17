import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliAdapter, CliCapabilities, CliDriver, CliEvent, LaunchRequest } from "../types";
import { asRecord, contentText, num, str } from "./util";

/**
 * Claude Code (`claude -p`), stream-json in and out.
 *
 * - Kernel tools: `--mcp-config <file> --strict-mcp-config` (only our bridge; the owner's MCP servers are not loaded),
 *   allowed without prompting by `--allowedTools mcp__<server>`.
 * - `--restricted`: ignores user/project/local settings files (no foreign allow rules or hooks from the worktree),
 *   confines the file tools to the working directory, refuses bypassPermissions. `--permission-prompts none`: anything
 *   that would prompt is denied (a headless Run never blocks).
 * - Read-only: `--tools Read,Grep,Glob` (no Bash/Edit/Write exist in the session) and `--permission-mode dontAsk`.
 * - Writing: the allowed built-ins only (Write for write, Edit/NotebookEdit for edit, Bash for bash),
 *   `--permission-mode acceptEdits`, and for Bash the OS sandbox via `--settings` (bubblewrap on Linux: writes limited
 *   to the cwd and TMPDIR, no network, no unsandboxed retry; the CLI refuses to start if the sandbox is unavailable).
 * - Steer: stream-json input stays open, so a steer is written as another user message mid-run.
 * - Usage: per assistant message (partial) and per result (`model_usage_since_last_result`, incl. `costUSD`).
 */
export function claudeAdapter(): CliAdapter {
  return {
    engine: "claude",
    defaultBin: "claude",
    defaultModels: { strong: "", fast: "sonnet" },
    canFork: true,
    mcpToolName: (server, tool) => `mcp__${server}__${tool}`,
    createDriver: (req) => new ClaudeDriver(req),
    describePermissions,
  };
}

export function claudeBuiltinTools(caps: CliCapabilities): string[] {
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

export function claudeArgs(req: LaunchRequest, files: { mcpConfig: string; settings?: string }): string[] {
  const { caps } = req;
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--mcp-config", files.mcpConfig,
    "--strict-mcp-config",
    "--restricted",
    "--tools", claudeBuiltinTools(caps).join(","),
    "--allowedTools", [`mcp__${req.mcp.serverName}`, ...(caps.readOnly || !caps.bash ? [] : ["Bash"])].join(","),
    "--permission-prompts", "none",
    "--permission-mode", caps.readOnly ? "dontAsk" : "acceptEdits",
    "--append-system-prompt-file", req.systemFile,
  ];
  if (files.settings) args.push("--settings", files.settings);
  if (req.model) args.push("--model", req.model);
  if (req.session) {
    args.push("--resume", req.session.id);
    if (req.session.mode === "fork") args.push("--fork-session");
  }
  args.push(...req.extraArgs);
  return args;
}

function describePermissions(caps: CliCapabilities): string {
  const tools = claudeBuiltinTools(caps).join(", ");
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
  #turnTokens = 0;
  #controlSeq = 0;
  #stopping = false;

  constructor(req: LaunchRequest) {
    this.#req = req;
    this.#mcpPrefix = `mcp__${req.mcp.serverName}__`;
    const mcpConfig = join(req.tmpDir, "claude-mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [req.mcp.serverName]: { type: "stdio", ...req.mcp.launch } } }), { mode: 0o600 });
    let settings: string | undefined;
    if (!req.caps.readOnly && req.caps.bash) {
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
          this.#msgTokens.set(id, tokens);
          this.#turnTokens += tokens - prev;
          out.push({ type: "usage", tokens: tokens - prev, cents: 0 });
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
        const { tokens, costUsd } = resultUsage(msg);
        const rest = Math.max(0, tokens - this.#turnTokens);
        this.#turnTokens = 0;
        this.#msgTokens.clear();
        if (rest > 0 || costUsd > 0) out.push({ type: "usage", tokens: rest, cents: costUsd * 100 });
        const isError = msg["is_error"] === true;
        const subtype = str(msg["subtype"]) ?? "";
        if (isError && this.#req.session && num(msg["num_turns"]) === 0 && subtype === "error_during_execution") {
          out.push({ type: "resume_failed", message: `claude could not ${this.#req.session.mode} session ${this.#req.session.id}` });
          break;
        }
        const more = num(msg["queued_turn_count"]) > 0;
        const stopped = this.#stopping;
        this.#stopping = false;
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
function resultUsage(msg: Record<string, unknown>): { tokens: number; costUsd: number } {
  const since = asRecord(msg["model_usage_since_last_result"]);
  const models = Object.values(since).map(asRecord);
  if (models.length > 0) {
    let tokens = 0;
    let costUsd = 0;
    for (const m of models) {
      tokens += num(m["inputTokens"]) + num(m["outputTokens"]) + num(m["cacheReadInputTokens"]) + num(m["cacheCreationInputTokens"]);
      costUsd += num(m["costUSD"]);
    }
    return { tokens, costUsd };
  }
  const u = asRecord(msg["usage"]);
  return {
    tokens: num(u["input_tokens"]) + num(u["output_tokens"]) + num(u["cache_read_input_tokens"]) + num(u["cache_creation_input_tokens"]),
    costUsd: num(msg["total_cost_usd"]),
  };
}

function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}
