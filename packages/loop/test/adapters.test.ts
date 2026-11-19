import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CliEngine } from "@ng/protocol";
import { agyAdapter, agyArgs, agyPermissionAllowed } from "../src/cli/adapters/agy";
import { CLAUDE_SANDBOX_SETTINGS, claudeAdapter, claudeArgs, claudeBuiltinTools } from "../src/cli/adapters/claude";
import { codexAdapter, codexArgs, codexSandboxMode } from "../src/cli/adapters/codex";
import { HOST_UNSANDBOXED } from "../src/cli/adapters/util";
import type { CliCapabilities, CliDriver, CliEvent, LaunchRequest } from "../src/cli/types";

// Argument builders and permission answers per access mode (docs/05). No CLI is launched: the claude driver only
// writes its MCP config (and, for a sandboxed workspace writer, its settings file) into the request's tmpDir.

const tmpRoot = mkdtempSync(join(tmpdir(), "ngcli-adapters-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const ROOT = "/work/repo";
const SERVER = "ng";

type CaseName = "workspace-write" | "workspace-read" | "host-write" | "host-read";

function capsOf(name: CaseName): CliCapabilities {
  const host = name.startsWith("host");
  const readOnly = name.endsWith("read");
  return {
    root: ROOT,
    isolation: host ? "none" : "git_worktree",
    write: !readOnly,
    edit: !readOnly,
    bash: !readOnly,
    readOnly,
    // capabilitiesOf turns web on for every host cell; workspace cells keep the loop option (off here).
    web: host,
    access: host ? "host" : "workspace",
  };
}

function launch(engine: CliEngine, caps: CliCapabilities, over: Partial<LaunchRequest> = {}): LaunchRequest {
  const dir = mkdtempSync(join(tmpRoot, `${engine}-`));
  return {
    engine,
    bin: engine,
    cwd: caps.root,
    caps,
    model: undefined,
    system: "SYSTEM TEXT",
    systemFile: join(dir, "system.md"),
    prompt: "hello",
    mcp: { serverName: SERVER, launch: { command: "node", args: ["/opt/ng/mcp-shim.mjs"], env: { NG_BRIDGE_URL: "http://127.0.0.1:1" } } },
    tmpDir: dir,
    extraArgs: [],
    ...over,
  };
}

/** The value following `flag` (first occurrence), or undefined. */
function after(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Every `-c` override of a codex argv. */
function codexConfig(argv: readonly string[]): string[] {
  return argv.flatMap((a, i) => (i > 0 && argv[i - 1] === "-c" ? [a] : []));
}

describe("claude adapter", () => {
  interface Row {
    name: CaseName;
    present: string[];
    absent: string[];
    tools: string | null;
    allowed: string;
    mode: string;
    sandboxSettings: boolean;
  }
  const rows: Row[] = [
    {
      name: "workspace-write",
      present: ["--restricted", "--strict-mcp-config", "--permission-prompts"],
      absent: [],
      tools: "Read,Grep,Glob,Write,Edit,NotebookEdit,Bash",
      allowed: "mcp__ng,Bash",
      mode: "acceptEdits",
      sandboxSettings: true,
    },
    {
      name: "workspace-read",
      present: ["--restricted", "--strict-mcp-config", "--permission-prompts"],
      absent: ["--settings"],
      tools: "Read,Grep,Glob",
      allowed: "mcp__ng",
      mode: "dontAsk",
      sandboxSettings: false,
    },
    {
      name: "host-write",
      present: ["--permission-prompts", "--mcp-config"],
      absent: ["--restricted", "--strict-mcp-config", "--tools", "--settings", "--dangerously-skip-permissions"],
      tools: null,
      allowed: "mcp__ng",
      mode: "bypassPermissions",
      sandboxSettings: false,
    },
    {
      name: "host-read",
      present: ["--permission-prompts", "--mcp-config"],
      absent: ["--restricted", "--strict-mcp-config", "--settings", "--add-dir"],
      tools: "Read,Grep,Glob,WebFetch,WebSearch",
      allowed: "mcp__ng,Read,Grep,Glob,WebFetch,WebSearch,Read(//**)",
      mode: "dontAsk",
      sandboxSettings: false,
    },
  ];

  it.each(rows)("$name: permission flags", (row) => {
    const req = launch("claude", capsOf(row.name));
    const argv = claudeAdapter().createDriver(req).argv;
    expect(argv[0]).toBe("claude");
    for (const f of row.present) expect(argv).toContain(f);
    for (const f of row.absent) expect(argv).not.toContain(f);
    expect(after(argv, "--tools")).toBe(row.tools ?? undefined);
    expect(claudeBuiltinTools(req.caps)).toEqual(row.tools === null ? null : row.tools.split(","));
    expect(after(argv, "--allowedTools")).toBe(row.allowed);
    expect(after(argv, "--permission-mode")).toBe(row.mode);
    expect(after(argv, "--permission-prompts")).toBe("none");
    expect(after(argv, "--append-system-prompt-file")).toBe(req.systemFile);

    // Our bridge always loads from the generated MCP config.
    const mcpConfig = JSON.parse(readFileSync(after(argv, "--mcp-config")!, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcpConfig.mcpServers)).toEqual([SERVER]);

    const settingsFile = join(req.tmpDir, "claude-settings.json");
    expect(existsSync(settingsFile)).toBe(row.sandboxSettings);
    if (row.sandboxSettings) {
      expect(after(argv, "--settings")).toBe(settingsFile);
      expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual(CLAUDE_SANDBOX_SETTINGS);
    }
  });

  it("host read-only offers no write or shell tool", () => {
    const argv = claudeAdapter().createDriver(launch("claude", capsOf("host-read"))).argv;
    const offered = [...after(argv, "--tools")!.split(","), ...after(argv, "--allowedTools")!.split(",")];
    for (const t of ["Bash", "Write", "Edit", "NotebookEdit"]) expect(offered).not.toContain(t);
  });

  it("keeps session, model and extra args in every mode", () => {
    for (const name of ["workspace-write", "host-write", "host-read"] as const) {
      const req = launch("claude", capsOf(name), { model: "sonnet", session: { id: "sess-1", mode: "fork" }, extraArgs: ["--effort", "high"] });
      const argv = claudeAdapter().createDriver(req).argv;
      expect(after(argv, "--model")).toBe("sonnet");
      expect(after(argv, "--resume")).toBe("sess-1");
      expect(argv).toContain("--fork-session");
      expect(argv.slice(-2)).toEqual(["--effort", "high"]);
    }
  });

  it("describes each mode truthfully", () => {
    const d = (name: CaseName) => claudeAdapter().describePermissions(capsOf(name));
    expect(d("host-write")).toContain("host access, writing");
    expect(d("host-write")).toContain("bypassPermissions");
    expect(d("host-write")).toContain(HOST_UNSANDBOXED);
    expect(d("host-read")).toContain("host access, read-only");
    expect(d("host-read")).toContain("Read, Grep, Glob, WebFetch, WebSearch");
    expect(d("host-read")).not.toContain("unsandboxed");
    expect(d("workspace-write")).toContain("bubblewrap sandbox");
    expect(d("workspace-read")).toContain(`confined to ${ROOT} by --restricted`);
  });
});

describe("codex adapter", () => {
  interface Row {
    name: CaseName;
    mode: "read-only" | "workspace-write" | "danger-full-access";
    ignoreRules: boolean;
    networkOff: boolean;
    webSearch: boolean;
  }
  const rows: Row[] = [
    { name: "workspace-write", mode: "workspace-write", ignoreRules: true, networkOff: true, webSearch: false },
    { name: "workspace-read", mode: "read-only", ignoreRules: true, networkOff: false, webSearch: false },
    { name: "host-write", mode: "danger-full-access", ignoreRules: false, networkOff: false, webSearch: true },
    // --ignore-rules stays on for a read-only host cell: an execpolicy allow rule would run its command unsandboxed.
    { name: "host-read", mode: "read-only", ignoreRules: true, networkOff: false, webSearch: true },
  ];

  it.each(rows)("$name: fresh exec", (row) => {
    const req = launch("codex", capsOf(row.name));
    expect(codexSandboxMode(req.caps)).toBe(row.mode);
    const argv = codexArgs(req);
    expect(codexAdapter().createDriver(req).argv).toEqual(["codex", ...argv]);
    expect(argv[0]).toBe("exec");
    expect(after(argv, "-s")).toBe(row.mode);
    expect(after(argv, "-C")).toBe(ROOT);
    expect(argv.at(-1)).toBe("-");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv.includes("--ignore-rules")).toBe(row.ignoreRules);
    const cfg = codexConfig(argv);
    expect(cfg).toContain('approval_policy="never"');
    expect(cfg).toContain('mcp_servers.ng.command="node"');
    expect(cfg).toContain('mcp_servers.ng.default_tools_approval_mode="approve"');
    expect(cfg).toContain('developer_instructions="SYSTEM TEXT"');
    expect(cfg.includes("sandbox_workspace_write.network_access=false")).toBe(row.networkOff);
    expect(cfg.includes('web_search="live"')).toBe(row.webSearch);
  });

  it.each(rows)("$name: resume and fork carry the same sandbox as config", (row) => {
    for (const mode of ["resume", "fork"] as const) {
      const argv = codexArgs(launch("codex", capsOf(row.name), { session: { id: "thread-1", mode } }));
      expect(argv.slice(0, 2)).toEqual(["exec", mode]);
      expect(argv).not.toContain("-s");
      expect(argv.slice(-2)).toEqual(["thread-1", "-"]);
      expect(argv.includes("--ignore-rules")).toBe(row.ignoreRules);
      const cfg = codexConfig(argv);
      expect(cfg).toContain(`sandbox_mode="${row.mode}"`);
      expect(cfg.includes('web_search="live"')).toBe(row.webSearch);
      expect(cfg.some((c) => c.startsWith("developer_instructions="))).toBe(false);
    }
  });

  it("describes each mode truthfully", () => {
    const d = (name: CaseName) => codexAdapter().describePermissions(capsOf(name));
    expect(d("host-write")).toContain("host access, writing");
    expect(d("host-write")).toContain("danger-full-access");
    expect(d("host-write")).toContain(HOST_UNSANDBOXED);
    expect(d("host-read")).toContain("host access, read-only");
    expect(d("host-read")).toContain("sandbox read-only");
    expect(d("host-read")).not.toContain("unsandboxed");
    expect(d("workspace-write")).toContain("workspace-write");
    expect(d("workspace-read")).toContain("sandbox read-only");
  });
});

describe("agy adapter", () => {
  it.each([
    { name: "workspace-write" as const, sandbox: true },
    { name: "workspace-read" as const, sandbox: false },
    { name: "host-write" as const, sandbox: false },
    { name: "host-read" as const, sandbox: false },
  ])("$name: --sandbox $sandbox", ({ name, sandbox }) => {
    const req = launch("agy", capsOf(name), { extraArgs: ["--disable-telemetry"] });
    const argv = agyArgs(req);
    expect(argv[0]).toBe("acp");
    expect(argv.includes("--sandbox")).toBe(sandbox);
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv.at(-1)).toBe("--disable-telemetry");
    expect(agyAdapter().createDriver(req).argv).toEqual(["agy", ...argv]);
  });

  const inside = `${ROOT}/src/a.ts`;
  const outside = "/home/owner/other-repo/b.ts";
  // [label, toolCall, workspace-write, workspace-read, host-write, host-read]
  const calls: [string, Record<string, unknown>, boolean, boolean, boolean, boolean][] = [
    ["kernel MCP tool", { kind: "other", name: "mcp_ng_set_state" }, true, true, true, true],
    ["kernel MCP tool by title", { kind: "execute", title: "Run mcp_ng_wait" }, true, true, true, true],
    ["read inside", { kind: "read", locations: [{ path: inside }] }, true, true, true, true],
    ["read outside", { kind: "read", locations: [{ path: outside }] }, false, false, true, true],
    ["search outside", { kind: "search", rawInput: { path: "/etc" } }, false, false, true, true],
    ["think", { kind: "think" }, true, true, true, true],
    ["edit inside", { kind: "edit", locations: [{ path: inside }] }, true, false, true, false],
    ["edit outside", { kind: "edit", rawInput: { file_path: outside } }, false, false, true, false],
    ["edit ~/.gitconfig", { kind: "edit", locations: [{ path: "/home/owner/.gitconfig" }] }, false, false, true, false],
    ["delete outside", { kind: "delete", locations: [{ path: outside }] }, false, false, true, false],
    ["move outside", { kind: "move", locations: [{ path: inside }, { path: outside }] }, false, false, true, false],
    ["execute", { kind: "execute", title: "git push origin HEAD" }, true, false, true, false],
    ["fetch", { kind: "fetch", title: "https://example.com" }, false, false, true, true],
    ["switch_mode", { kind: "switch_mode" }, false, false, true, false],
    ["other", { kind: "other", name: "mcp_github_create_pr" }, false, false, true, false],
    ["no kind", { title: "something" }, false, false, true, false],
  ];
  const names: CaseName[] = ["workspace-write", "workspace-read", "host-write", "host-read"];

  it.each(calls)("permission: %s", (_label, toolCall, ...expected) => {
    const got = names.map((n) => agyPermissionAllowed(toolCall, capsOf(n), SERVER));
    expect(got).toEqual(expected);
  });

  it("follows the web flag for fetches on the host", () => {
    expect(agyPermissionAllowed({ kind: "fetch" }, { ...capsOf("host-write"), web: false }, SERVER)).toBe(false);
    expect(agyPermissionAllowed({ kind: "fetch" }, { ...capsOf("host-read"), web: false }, SERVER)).toBe(false);
  });

  it("describes each mode truthfully", () => {
    const d = (name: CaseName) => agyAdapter().describePermissions(capsOf(name));
    expect(d("host-write")).toContain("host access, writing");
    expect(d("host-write")).toContain("approves every permission request");
    expect(d("host-write")).toContain(HOST_UNSANDBOXED);
    expect(d("host-read")).toContain("host access, read-only");
    expect(d("host-read")).toContain("rejects every edit/delete/move, command");
    expect(d("host-read")).not.toContain("unsandboxed");
    expect(d("workspace-write")).toContain("--sandbox");
    expect(d("workspace-read")).toContain("read-only");
  });
});

describe("reasoning effort (the owner's model switch)", () => {
  const files = { mcpConfig: "/tmp/ng-mcp.json" };

  it("claude: --effort <x> when the request carries an effort, nothing when it does not", () => {
    for (const name of ["workspace-write", "host-write", "host-read"] as const) {
      const argv = claudeArgs(launch("claude", capsOf(name), { model: "opus", effort: "xhigh" }), files);
      expect(after(argv, "--effort")).toBe("xhigh");
      expect(after(argv, "--model")).toBe("opus");
      expect(argv.filter((a) => a === "--effort")).toHaveLength(1);
      expect(claudeArgs(launch("claude", capsOf(name), { model: "opus" }), files)).not.toContain("--effort");
      expect(claudeArgs(launch("claude", capsOf(name), { model: "opus", effort: undefined }), files)).not.toContain("--effort");
    }
    const resumed = claudeAdapter().createDriver(launch("claude", capsOf("workspace-write"), { effort: "high", session: { id: "sess-1", mode: "resume" } })).argv;
    expect(after(resumed, "--effort")).toBe("high");
    expect(after(resumed, "--resume")).toBe("sess-1");
  });

  it('codex: -c model_reasoning_effort="<x>" when the request carries an effort, fresh or resumed; nothing when it does not', () => {
    for (const session of [undefined, { id: "thread-1", mode: "resume" as const }, { id: "thread-1", mode: "fork" as const }]) {
      const over = session ? { session } : {};
      const argv = codexArgs(launch("codex", capsOf("workspace-write"), { model: "gpt-6-codex", effort: "high", ...over }));
      expect(codexConfig(argv)).toContain('model_reasoning_effort="high"');
      expect(after(argv, "-m")).toBe("gpt-6-codex");
      const plain = codexArgs(launch("codex", capsOf("workspace-write"), { model: "gpt-6-codex", ...over }));
      expect(codexConfig(plain).some((c) => c.startsWith("model_reasoning_effort"))).toBe(false);
      expect(plain.join(" ")).not.toContain("reasoning_effort");
    }
  });
});

// ---------- stream parsing: what each driver reports, line by line ----------

/** An io that records what the driver writes to the CLI. */
function recordingIo(): { written: Array<Record<string, unknown>>; write(line: string): void; end(): void } {
  const written: Array<Record<string, unknown>> = [];
  return { written, write: (line) => void written.push(JSON.parse(line) as Record<string, unknown>), end: () => undefined };
}

function feeder(driver: CliDriver, io = recordingIo()) {
  return (...msgs: unknown[]): CliEvent[] => msgs.flatMap((m) => driver.onLine(JSON.stringify(m), io));
}

describe("codex driver: items and usage", () => {
  const codex = () => feeder(codexAdapter().createDriver(launch("codex", capsOf("host-write"))));
  const completed = (item: Record<string, unknown>) => ({ type: "item.completed", item });
  const started = (item: Record<string, unknown>) => ({ type: "item.started", item });

  it("mirrors a code-mode custom_tool_call with its output inline as one tool call (keyed by call_id)", () => {
    const feed = codex();
    expect(feed(completed({ id: "item_3", type: "custom_tool_call", call_id: "call_a", name: "exec", input: "const n = 1 + 1; n", output: "2", status: "completed" }))).toEqual([
      { type: "tool_start", id: "call_a", name: "exec", input: { input: "const n = 1 + 1; n" } },
      { type: "tool_end", id: "call_a", name: "exec", output: "2" },
    ]);
  });

  it("keeps a custom_tool_call open until its separate custom_tool_call_output arrives, matched by call_id", () => {
    const feed = codex();
    const call = { id: "item_1", type: "custom_tool_call", call_id: "call_b", name: "exec", input: "await tools.shell('ls')" };
    expect(feed(started({ ...call, status: "in_progress" }))).toEqual([{ type: "tool_start", id: "call_b", name: "exec", input: { input: "await tools.shell('ls')" } }]);
    // completed without an output: nothing yet (and no second tool_start)
    expect(feed(completed({ ...call, status: "completed" }))).toEqual([]);
    expect(feed(completed({ id: "item_2", type: "custom_tool_call_output", call_id: "call_b", output: "README.md\nsrc" }))).toEqual([
      { type: "tool_end", id: "call_b", name: "exec", output: "README.md\nsrc" },
    ]);

    // the same without an item.started; a structured output is rendered as its text
    const again = codex();
    expect(again(completed({ ...call, call_id: "call_c" }))).toEqual([{ type: "tool_start", id: "call_c", name: "exec", input: { input: "await tools.shell('ls')" } }]);
    expect(again(completed({ id: "item_4", type: "custom_tool_call_output", call_id: "call_c", output: { content: [{ type: "text", text: "ok" }] } }))).toEqual([
      { type: "tool_end", id: "call_c", name: "exec", output: "ok" },
    ]);
  });

  it("reports a failed custom_tool_call as an error result", () => {
    const feed = codex();
    expect(feed(completed({ id: "item_5", type: "custom_tool_call", call_id: "call_d", name: "exec", input: "JSON.parse('{')", output: "SyntaxError: Unexpected end of JSON input", status: "failed" }))).toEqual([
      { type: "tool_start", id: "call_d", name: "exec", input: { input: "JSON.parse('{')" } },
      { type: "tool_end", id: "call_d", name: "exec", output: "SyntaxError: Unexpected end of JSON input", isError: true },
    ]);
    // failed without any output: the status is the output, and the call is not left open
    expect(feed(completed({ id: "item_6", type: "custom_tool_call", call_id: "call_e", name: "exec", input: "x", status: "failed" }))).toEqual([
      { type: "tool_start", id: "call_e", name: "exec", input: { input: "x" } },
      { type: "tool_end", id: "call_e", name: "exec", output: "failed", isError: true },
    ]);
  });

  it("mirrors an item type it has never seen as a tool call named after its type", () => {
    const feed = codex();
    expect(feed(completed({ id: "item_7", type: "image_generation_call", status: "completed", prompt: "a lighthouse", result: "saved /tmp/lighthouse.png" }))).toEqual([
      { type: "tool_start", id: "item_7", name: "image_generation_call", input: { prompt: "a lighthouse" } },
      { type: "tool_end", id: "item_7", name: "image_generation_call", output: "saved /tmp/lighthouse.png" },
    ]);
    // a generic call with arguments (function_call) shows them as its input, its output item closes it
    expect(feed(completed({ id: "item_8", type: "function_call", call_id: "fc_1", name: "view_image", arguments: { path: "/tmp/lighthouse.png" } }))).toEqual([
      { type: "tool_start", id: "fc_1", name: "view_image", input: { path: "/tmp/lighthouse.png" } },
    ]);
    expect(feed(completed({ id: "item_9", type: "function_call_output", call_id: "fc_1", output: "[image]" }))).toEqual([{ type: "tool_end", id: "fc_1", name: "view_image", output: "[image]" }]);
  });

  it("does not mirror conversation and bookkeeping items, nor its own kernel MCP calls", () => {
    const feed = codex();
    for (const item of [
      { id: "i1", type: "reasoning", text: "**Planning the fix**" },
      { id: "i2", type: "todo_list", items: [{ text: "run tests", completed: false }] },
      { id: "i3", type: "user_message", text: "hello" },
      { id: "i4", type: "agent_message", text: "   " },
      { id: "i5", type: "mcp_tool_call", server: SERVER, tool: "set_state", arguments: {}, status: "completed" },
    ]) {
      expect(feed(started(item))).toEqual([]);
      expect(feed(completed(item))).toEqual([]);
    }
    expect(feed(completed({ id: "i6", type: "agent_message", text: "Done." }))).toEqual([{ type: "text", text: "Done." }]);
    expect(feed(completed({ id: "i7", type: "error", message: "stream disconnected" }))).toEqual([{ type: "notice", text: "codex: stream disconnected" }]);
    // another MCP server's call is the agent's own tool: mirrored
    expect(feed(completed({ id: "i8", type: "mcp_tool_call", server: "github", tool: "get_pr", arguments: { n: 1 }, result: { content: [{ type: "text", text: "PR #1" }] }, status: "completed" }))).toEqual([
      { type: "tool_start", id: "i8", name: "github.get_pr", input: { n: 1 } },
      { type: "tool_end", id: "i8", name: "github.get_pr", output: "PR #1" },
    ]);
  });

  it("reports turn.completed usage as the session's running total, with the cached input among the tokens", () => {
    const feed = codex();
    expect(feed({ type: "turn.completed", usage: { input_tokens: 120_000, cached_input_tokens: 96_000, output_tokens: 3_000 } })).toEqual([
      { type: "usage", tokens: 123_000, cents: 0, cached: 96_000, sessionTotal: true },
      { type: "turn_end", ok: true },
    ]);
    expect(feed({ type: "turn.completed", usage: { input_tokens: 500, output_tokens: 20 } })).toEqual([
      { type: "usage", tokens: 520, cents: 0, cached: 0, sessionTotal: true },
      { type: "turn_end", ok: true },
    ]);
    // nothing reported, nothing metered
    expect(feed({ type: "turn.completed", usage: {} })).toEqual([{ type: "turn_end", ok: true }]);
  });
});

describe("claude driver: cache reads on usage", () => {
  const assistant = (id: string, usage: Record<string, number>, parent: string | null = null) => ({
    type: "assistant",
    message: { id, role: "assistant", content: [], usage },
    parent_tool_use_id: parent,
  });

  it("passes cache reads on partial and result usage events without counting them twice", () => {
    const feed = feeder(claudeAdapter().createDriver(launch("claude", capsOf("host-write"))));
    expect(feed(assistant("m1", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 }))).toEqual([
      { type: "usage", tokens: 1_015, cents: 0, cached: 1_000 },
    ]);
    // the same message streamed again with more output: only the increment, the cache reads were already reported
    expect(feed(assistant("m1", { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 }))).toEqual([
      { type: "usage", tokens: 45, cents: 0 },
    ]);
    expect(feed(assistant("m2", { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 }))).toEqual([
      { type: "usage", tokens: 2_030, cents: 0, cached: 2_000 },
    ]);
    // a sub-agent's messages reach the result totals only
    expect(feed(assistant("m3", { input_tokens: 99, output_tokens: 1, cache_read_input_tokens: 400 }, "toolu_task"))).toEqual([]);
    // the result reconciles: what the partials did not cover (cache writes, the sub-agent) is reported once, with its cost
    const result = (cacheRead: number, extra: number, costUSD: number) => ({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: "done",
      model_usage_since_last_result: { "claude-x": { inputTokens: 30 + 99, outputTokens: 60 + 1, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: extra, costUSD } },
    });
    expect(feed(result(3_400, 500, 0.25))).toEqual([
      { type: "usage", tokens: 1_000, cents: 25, cached: 400 },
      { type: "turn_end", ok: true },
    ]);
  });

  it("reports cache reads that only the result carries, and none when there are none", () => {
    const feed = feeder(claudeAdapter().createDriver(launch("claude", capsOf("host-read"))));
    const result = (usage: Record<string, number>) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok", usage, total_cost_usd: 0 });
    expect(feed(result({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 880, cache_creation_input_tokens: 0 }))).toEqual([
      { type: "usage", tokens: 1_000, cents: 0, cached: 880 },
      { type: "turn_end", ok: true },
    ]);
    expect(feed(result({ input_tokens: 100, output_tokens: 20 }))).toEqual([
      { type: "usage", tokens: 120, cents: 0 },
      { type: "turn_end", ok: true },
    ]);
  });
});

describe("agy driver: cache reads on usage", () => {
  /** Drive the ACP handshake up to the first session/prompt; returns the feeder and that request's id. */
  function prompting() {
    const io = recordingIo();
    const driver = agyAdapter().createDriver(launch("agy", capsOf("host-write")));
    const feed = feeder(driver, io);
    driver.start(io);
    const reply = (method: string, result: unknown) => feed({ jsonrpc: "2.0", id: io.written.find((w) => w["method"] === method)!["id"], result });
    reply("initialize", { protocolVersion: 1 });
    expect(reply("session/new", { sessionId: "s1" })).toEqual([{ type: "session", sessionId: "s1" }]);
    const promptId = io.written.find((w) => w["method"] === "session/prompt")!["id"];
    return { feed, promptId };
  }

  it("passes cachedReadTokens on as cached, among the turn's total", () => {
    const { feed, promptId } = prompting();
    expect(
      feed({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 4_000, cachedWriteTokens: 0, thoughtTokens: 10, totalTokens: 4_160 } } }),
    ).toEqual([
      { type: "usage", tokens: 4_160, cents: 0, cached: 4_000 },
      { type: "turn_end", ok: true },
    ]);
  });

  it("sums the parts when there is no total, and reports no cached figure without cache reads", () => {
    const a = prompting();
    expect(a.feed({ jsonrpc: "2.0", id: a.promptId, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 300, thoughtTokens: 10 } } })).toEqual([
      { type: "usage", tokens: 460, cents: 0, cached: 300 },
      { type: "turn_end", ok: true },
    ]);
    const b = prompting();
    expect(b.feed({ jsonrpc: "2.0", id: b.promptId, result: { stopReason: "end_turn", usage: { inputTokens: 70, outputTokens: 30, totalTokens: 100 } } })).toEqual([
      { type: "usage", tokens: 100, cents: 0 },
      { type: "turn_end", ok: true },
    ]);
  });
});
