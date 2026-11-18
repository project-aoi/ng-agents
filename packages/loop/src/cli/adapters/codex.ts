import type { CliAdapter, CliCapabilities, CliDriver, CliEvent, LaunchRequest } from "../types";
import { asRecord, contentText, HOST_UNSANDBOXED, num, str, tomlInlineTable, tomlValue } from "./util";

/**
 * OpenAI Codex CLI (`codex exec --json`), prompt on stdin.
 *
 * - Kernel tools: `-c mcp_servers.<name>.*` overrides for this invocation only (nothing is written to ~/.codex), with
 *   `default_tools_approval_mode="approve"` (exec runs with approval_policy "never", which would otherwise refuse
 *   every MCP call) and a long tool timeout. The owner's config.toml (login, model, MCP servers, skills) always loads.
 * - Sandbox (`-s` on a fresh exec, `-c sandbox_mode` on resume/fork, which take no `-s`), enforced by Codex's Linux
 *   sandbox (bubblewrap + seccomp) for every shell command and patch. Codex's shell and patch tools cannot be switched
 *   off separately, so the mode follows the whole cell:
 *   - read-only cells (both access modes): `read-only` — reads anywhere, no writes, no network for commands.
 *   - host access, writing (docs/05 default): `danger-full-access` — no sandbox: writes, commands and network
 *     anywhere, the owner's execpolicy rules in effect.
 *   - workspace access, writing: `workspace-write` (writes only in the cwd and temp dirs, no network) when write,
 *     edit and bash are all allowed; anything less runs read-only.
 * - `--ignore-rules` whenever a sandbox is on: no user/project execpolicy rules, since a matching allow rule runs its
 *   command outside the sandbox (a read-only cell must not get a write path that way).
 * - Host access: the hosted `web_search` tool in "live" mode when the cell has web (it needs no sandbox network).
 * - Steer: no live input in exec mode — the loop interrupts the process and resumes the session with the steer text.
 * - Usage: `turn.completed.usage` (input incl. cached + output); no cost is reported (cents 0).
 */
export function codexAdapter(): CliAdapter {
  return {
    engine: "codex",
    defaultBin: "codex",
    defaultModels: { strong: "", fast: "" },
    canFork: true,
    mcpToolName: (server, tool) => `mcp__${server}__${tool}`,
    createDriver: (req) => new CodexDriver(req),
    describePermissions,
    readOnlyHowTo: (caps) =>
      `Read with your shell: commands that only read (cat, sed -n, rg, ls, find, git log / show / diff / status) work on any path of this machine. Your sandbox is read-only, so anything that writes fails — that is intended; do not try to work around it.${caps.web ? " Web search is available." : ""}`,
  };
}

/** Linux caps one argv string at 128 KiB; larger system texts travel at the top of the first prompt instead. */
export const CODEX_INLINE_INSTRUCTIONS_MAX = 100_000;

export function codexSandboxMode(caps: CliCapabilities): "read-only" | "workspace-write" | "danger-full-access" {
  if (caps.readOnly) return "read-only";
  if (caps.access === "host") return "danger-full-access";
  return caps.write && caps.edit && caps.bash ? "workspace-write" : "read-only";
}

export function codexArgs(req: LaunchRequest): string[] {
  const mode = codexSandboxMode(req.caps);
  const host = req.caps.access === "host";
  const server = req.mcp.serverName;
  const cfg: string[] = [
    `approval_policy=${tomlValue("never")}`,
    `mcp_servers.${server}.command=${tomlValue(req.mcp.launch.command)}`,
    `mcp_servers.${server}.args=${tomlValue(req.mcp.launch.args)}`,
    `mcp_servers.${server}.env=${tomlInlineTable(req.mcp.launch.env)}`,
    `mcp_servers.${server}.startup_timeout_sec=30`,
    `mcp_servers.${server}.tool_timeout_sec=3600`,
    `mcp_servers.${server}.default_tools_approval_mode=${tomlValue("approve")}`,
  ];
  if (mode === "workspace-write") cfg.push("sandbox_workspace_write.network_access=false");
  if (host && req.caps.web) cfg.push(`web_search=${tomlValue("live")}`);
  if (!req.session && req.system.length <= CODEX_INLINE_INSTRUCTIONS_MAX) cfg.push(`developer_instructions=${tomlValue(req.system)}`);
  const rules = mode === "danger-full-access" ? [] : ["--ignore-rules"];
  const common = ["--json", "--skip-git-repo-check", ...rules, ...cfg.flatMap((c) => ["-c", c])];
  if (req.model) common.push("-m", req.model);
  if (req.effort) common.push("-c", `model_reasoning_effort=${tomlValue(req.effort)}`);
  if (!req.session) return ["exec", ...common, "-C", req.cwd, "-s", mode, ...req.extraArgs, "-"];
  const sub = req.session.mode === "fork" ? "fork" : "resume";
  return ["exec", sub, ...common, "-c", `sandbox_mode=${tomlValue(mode)}`, ...req.extraArgs, req.session.id, "-"];
}

function describePermissions(caps: CliCapabilities): string {
  const mode = codexSandboxMode(caps);
  if (caps.access === "host") {
    const web = caps.web ? "; live web search on" : "";
    if (mode === "danger-full-access") {
      return `codex: host access, writing — sandbox danger-full-access, approval_policy never: reads, writes, commands and network anywhere, the owner's config and execpolicy rules in effect${web}; ${HOST_UNSANDBOXED}.`;
    }
    return `codex: host access, read-only — sandbox read-only, enforced by Codex's OS sandbox for shell commands and patches: reads anywhere, no writes, no network for commands${web}; the owner's execpolicy rules are not loaded (an allow rule would run its command outside the sandbox).`;
  }
  if (mode === "read-only") {
    const note = caps.readOnly ? "" : " (the cell may not use all of write, edit and bash, which Codex cannot separate)";
    return `codex: sandbox read-only${note} — enforced by Codex's OS sandbox for shell commands and patches; reads are not limited to the workspace.`;
  }
  return `codex: sandbox workspace-write — enforced by Codex's OS sandbox: writes only in ${caps.root} and temp dirs, no network; reads are not limited to the workspace.`;
}

class CodexDriver implements CliDriver {
  readonly argv: readonly string[];
  readonly #req: LaunchRequest;
  readonly #started = new Map<string, string>();

  constructor(req: LaunchRequest) {
    this.#req = req;
    this.argv = [req.bin, ...codexArgs(req)];
  }

  start(io: { write(line: string): void; end(): void }): void {
    const req = this.#req;
    const inlineSystem = !req.session && req.system.length > CODEX_INLINE_INSTRUCTIONS_MAX;
    io.write(inlineSystem ? `<instructions>\n${req.system}\n</instructions>\n\n${req.prompt}` : req.prompt);
    io.end();
  }

  steer(): boolean {
    return false;
  }

  interrupt(): void {
    // exec has no control channel; the loop terminates the process.
  }

  finish(): void {
    // stdin is already closed; exec exits after its turn.
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
      case "thread.started":
        if (typeof msg["thread_id"] === "string") out.push({ type: "session", sessionId: msg["thread_id"] });
        break;
      case "item.started":
        this.#itemStarted(asRecord(msg["item"]), out);
        break;
      case "item.completed":
        this.#itemCompleted(asRecord(msg["item"]), out);
        break;
      case "turn.completed": {
        const u = asRecord(msg["usage"]);
        const tokens = num(u["input_tokens"]) + num(u["output_tokens"]);
        if (tokens > 0) out.push({ type: "usage", tokens, cents: 0 });
        out.push({ type: "turn_end", ok: true });
        break;
      }
      case "turn.failed":
        out.push({ type: "turn_end", ok: false, error: str(asRecord(msg["error"])["message"]) ?? "turn failed" });
        break;
      case "error":
        if (typeof msg["message"] === "string") out.push({ type: "notice", text: `codex: ${msg["message"]}` });
        break;
    }
    return out;
  }

  #isOurs(item: Record<string, unknown>): boolean {
    return item["type"] === "mcp_tool_call" && item["server"] === this.#req.mcp.serverName;
  }

  #itemStarted(item: Record<string, unknown>, out: CliEvent[]): void {
    const id = str(item["id"]);
    if (!id || this.#isOurs(item)) return;
    const start = toolStart(item);
    if (!start) return;
    this.#started.set(id, start.name);
    out.push({ type: "tool_start", id, name: start.name, input: start.input });
  }

  #itemCompleted(item: Record<string, unknown>, out: CliEvent[]): void {
    const id = str(item["id"]) ?? "";
    if (item["type"] === "agent_message") {
      const text = str(item["text"]);
      if (text?.trim()) out.push({ type: "text", text });
      return;
    }
    if (this.#isOurs(item)) return;
    if (item["type"] === "error") {
      out.push({ type: "notice", text: `codex: ${str(item["message"]) ?? "error"}` });
      return;
    }
    const start = toolStart(item);
    if (!start) return;
    if (!this.#started.has(id)) out.push({ type: "tool_start", id, name: start.name, input: start.input });
    this.#started.delete(id);
    const failed = item["status"] === "failed" || item["status"] === "declined" || (typeof item["exit_code"] === "number" && item["exit_code"] !== 0);
    out.push({ type: "tool_end", id, name: start.name, output: toolOutput(item), ...(failed ? { isError: true } : {}) });
  }
}

function toolStart(item: Record<string, unknown>): { name: string; input: unknown } | null {
  switch (item["type"]) {
    case "command_execution":
      return { name: "shell", input: { command: item["command"] } };
    case "file_change":
      return { name: "apply_patch", input: { changes: item["changes"] } };
    case "mcp_tool_call":
      return { name: `${str(item["server"]) ?? "mcp"}.${str(item["tool"]) ?? "tool"}`, input: item["arguments"] ?? {} };
    case "web_search":
      return { name: "web_search", input: { query: item["query"] } };
    default:
      return null;
  }
}

function toolOutput(item: Record<string, unknown>): string {
  switch (item["type"]) {
    case "command_execution": {
      const exit = typeof item["exit_code"] === "number" ? `\n[exit code ${item["exit_code"]}]` : "";
      return `${str(item["aggregated_output"]) ?? ""}${exit}`.trim() || "(no output)";
    }
    case "file_change": {
      const changes = Array.isArray(item["changes"]) ? (item["changes"] as unknown[]).map(asRecord) : [];
      const list = changes.map((c) => `${str(c["kind"]) ?? "change"} ${str(c["path"]) ?? "?"}`).join(", ");
      return `${item["status"] === "completed" ? "applied" : String(item["status"] ?? "")}: ${list || "(no files)"}`;
    }
    case "mcp_tool_call": {
      const err = asRecord(item["error"]);
      if (typeof err["message"] === "string") return err["message"];
      return contentText(asRecord(item["result"])["content"]);
    }
    case "web_search":
      return `searched: ${str(item["query"]) ?? ""}`;
    default:
      return "";
  }
}
