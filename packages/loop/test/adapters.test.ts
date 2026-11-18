import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CliEngine } from "@ng/protocol";
import { agyAdapter, agyArgs, agyPermissionAllowed } from "../src/cli/adapters/agy";
import { CLAUDE_SANDBOX_SETTINGS, claudeAdapter, claudeArgs, claudeBuiltinTools } from "../src/cli/adapters/claude";
import { codexAdapter, codexArgs, codexSandboxMode } from "../src/cli/adapters/codex";
import { HOST_UNSANDBOXED } from "../src/cli/adapters/util";
import type { CliCapabilities, LaunchRequest } from "../src/cli/types";

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
