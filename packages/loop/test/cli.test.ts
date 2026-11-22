import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, makeBounds, TOOL_KINDS, type Address, type CliEngine, type PolicyBounds, type Registry, type RunOutcome, type Usage } from "@ng/protocol";
import {
  CLI_FORK_SESSION_KEY,
  CLI_SESSION_KEY,
  createCliAgentLoop,
  registerStandardToolsets,
  RUN_ALREADY_ENDED,
  RUN_ENDED_NOTICE,
  STANDARD_TOOLSETS,
  type CliDebugEvent,
  type CliSessionRecord,
} from "../src";
import { createFakeRun, installFakeCli, type FakeCli, type FakeCliTurn, type FakeRun, type FakeRunOptions } from "../src/testing";
import { FORK_NOTE_PREFIX, HISTORY_HEADER } from "../src/cli/render";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `ngcli-${prefix}-`)));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const TOOLSETS = [STANDARD_TOOLSETS.context, STANDARD_TOOLSETS.comms, STANDARD_TOOLSETS.workspace, STANDARD_TOOLSETS.schedule];

function registry(): Registry {
  const r = createRegistry();
  registerStandardToolsets(r);
  return r;
}

interface Setup {
  fake: FakeCli;
  root: string;
  debug: CliDebugEvent[];
  loop: ReturnType<typeof createCliAgentLoop>;
  run(opts?: Partial<FakeRunOptions>): ReturnType<typeof createFakeRun>;
}

function setup(engine: CliEngine, turns: FakeCliTurn[], loopOpts: { endRunGraceMs?: number; runTimeoutMs?: number } = {}): Setup {
  const fake = installFakeCli(tempDir(`${engine}-bin`), engine, turns);
  const root = tempDir(`${engine}-ws`);
  const debug: CliDebugEvent[] = [];
  const loop = createCliAgentLoop({
    engine,
    registry: registry(),
    bin: fake.bin,
    env: fake.env,
    pollMs: 30,
    killGraceMs: 500,
    endRunGraceMs: 4_000,
    ...loopOpts,
    onDebug: (e) => debug.push(e),
  });
  return {
    fake,
    root,
    debug,
    loop,
    run: (opts = {}) =>
      createFakeRun({
        workspaceRoot: root,
        spec: { processor: { kind: "llm", toolsets: TOOLSETS, allowedTools: ["read"] } },
        batch: ["please note that I saw it"],
        ...opts,
      }),
  };
}

function watchCursor(r:FakeRun) {
  const confirmations:number[] = [];
  r.ports.confirmCliInput = (_,seq) => confirmations.push(seq);
  return confirmations;
}
async function recordBatch(r:FakeRun) {
  for(const envelope of r.snapshot.batch.envelopes)
    await r.ports.context.appendEvidence(r.snapshot.cellId,{kind:"inbound",envelope,runId:r.snapshot.runId,at:0});
}
const launches = (s: Setup) => s.debug.filter((d): d is Extract<CliDebugEvent, { type: "launch" }> => d.type === "launch");

async function runOf(s: Setup, r: ReturnType<typeof createFakeRun>): Promise<RunOutcome> {
  return s.loop.run(r.snapshot, r.ports, r.controller.signal);
}

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function writerBounds(): PolicyBounds {
  return makeBounds({ tools: TOOL_KINDS, canSendTo: ["channel:*", "inbox:*"] as Address[], isolation: "git_worktree", maxConcurrentChildren: 4, maxDepth: 2, maxTokens: 10_000_000, maxCents: 100_000 });
}

/** A writing cell on the owner's machine (isolation none, docs/05 default). */
function hostBounds(): PolicyBounds {
  return makeBounds({ ...writerBounds(), tools: [...writerBounds().tools], isolation: "none" });
}

/**
 * The system text the CLI was handed, in launch order: claude's --append-system-prompt-file on every launch (logged by
 * the fake; the file itself is removed after the run), codex's developer_instructions and agy's session/new
 * systemPrompt on fresh sessions only.
 */
function systemTexts(s: Setup): string[] {
  const log = s.fake.log();
  const texts =
    s.fake.engine === "claude"
      ? log.filter((e) => e.type === "claude_system").map((e) => e["text"])
      : s.fake.engine === "codex"
        ? log.filter((e) => e.type === "codex_config").map((e) => e["developerInstructions"])
        : log.filter((e) => e.type === "acp_session").map((e) => e["systemPrompt"]);
  return texts.filter((t): t is string => typeof t === "string");
}

/** What a Run handed the kernel's meter, without the zero-usage budget probe it starts with. */
function meteredOf(r: FakeRun): Usage[] {
  return r.ports.log.metered.filter((u) => u.tokens > 0 || u.billedCents > 0);
}

function sessionOf(r: FakeRun): CliSessionRecord {
  return r.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord;
}

const ENGINES: CliEngine[] = ["claude", "codex", "agy"];

describe.each(ENGINES)("CLI loop with a fake %s", (engine) => {
  it("runs a kernel tool through the MCP bridge, mirrors the transcript, meters usage and records the session (read-only cell)", async () => {
    const s = setup(engine, [
      {
        actions: [
          { text: "Let me record that." },
          { mcp: "set_state", args: { patches: { seen: true } } },
          { native: "Read", kind: "read", input: { file_path: "notes.md" }, output: "file body" },
          { usage: { tokens: 1_000, costUsd: 0.02 } },
          { text: "Recorded." },
        ],
      },
    ]);
    const r = s.run();
    expect(await runOf(s, r)).toBe("completed");

    expect(r.ports.state.get("seen")).toBe(true);
    const ev = r.ports.log.evidence;
    expect(ev.some((e) => e.kind === "assistant_text" && e.text === "Let me record that.")).toBe(true);
    const call = ev.find((e) => e.kind === "tool_call" && e.name === "set_state");
    expect(call).toBeDefined();
    const result = ev.find((e) => e.kind === "tool_result" && e.name === "set_state");
    expect(result && "output" in result && result.output).toBe("Saved seen.");
    expect(ev.some((e) => e.kind === "tool_call" && e.name !== "set_state")).toBe(true); // the native tool
    expect(ev.findIndex((e) => e.kind === "assistant_text" && e.text === "Recorded.")).toBeGreaterThan(ev.indexOf(result!));

    const total = r.ports.totalUsage();
    expect(total.tokens).toBeGreaterThanOrEqual(1_000);
    expect(total.billedCents).toBeCloseTo(engine === "claude" ? 2 : 0, 5);

    const rec = r.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord;
    expect(rec.engine).toBe(engine);
    expect(rec.cwd).toBe(s.root);
    expect(rec.runs).toBe(1);

    // read-only mapping, the bridge's tool list (no native-replaced workspace tools) and the workspace cwd
    const launch = launches(s)[0]!;
    expect(launch.cwd).toBe(s.root);
    expect(launch.caps.readOnly).toBe(true);
    const argv = launch.argv.join(" ");
    if (engine === "claude") {
      expect(argv).toContain("--tools Read,Grep,Glob ");
      expect(argv).toContain("--permission-mode dontAsk");
      expect(argv).toContain("--permission-prompts none");
      expect(argv).toContain("--strict-mcp-config");
      expect(argv).toContain("--restricted");
      expect(argv).not.toContain("--settings");
    } else if (engine === "codex") {
      expect(argv).toContain("-s read-only");
      expect(argv).toContain('approval_policy="never"');
      expect(argv).toContain('default_tools_approval_mode="approve"');
      expect(argv).toContain("--ignore-rules");
    } else {
      expect(launch.argv.slice(1)).toEqual(["acp"]);
      const perm = s.fake.log().find((e) => e.type === "permission");
      expect(perm?.["allowed"]).toBe(true); // a read inside the workspace
    }
    const ready = s.fake.log().find((e) => e.type === "mcp_ready")!;
    const tools = ready["tools"] as string[];
    expect(tools).toContain("set_state");
    expect(tools).not.toContain("read");
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("job_start"); // job tools need bash, which a read-only cell lacks
    // secrets and kernel configuration never reach the CLI
    for (const e of s.fake.log().filter((x) => x.type === "argv")) expect(e["envNames"]).toEqual([]);
  });

  it("maps a writing worker onto the CLI's write permissions and sandbox, keeping job tools on MCP", async () => {
    const s = setup(engine, [
      {
        actions: [
          { native: "Write", kind: "edit", path: "src/a.ts", input: { file_path: "src/a.ts" } },
          { native: "Bash", kind: "execute", input: { command: "npm test" } },
          { native: "Edit", kind: "edit", path: "/etc/passwd", input: {} },
          { mcp: "job_start", args: { command: "sleep 1" } },
          { text: "Started the tests." },
        ],
      },
    ]);
    // an explicitly isolated (git_worktree) writer: the pre-docs/05 confinement ("workspace" access)
    const r = s.run({ bounds: writerBounds(), spec: { processor: { kind: "llm", toolsets: TOOLSETS } } });
    // job_start arranged a wake-up, so a run that would complete yields instead (same as the API loop)
    expect(await runOf(s, r)).toBe("yielded_waiting");
    expect(r.ports.log.jobs.map((j) => j.command)).toEqual(["sleep 1"]);
    const launch = launches(s)[0]!;
    expect(launch.caps).toMatchObject({ readOnly: false, write: true, edit: true, bash: true, isolation: "git_worktree", access: "workspace", web: false });
    const argv = launch.argv.join(" ");
    if (engine === "claude") {
      expect(argv).toContain("--tools Read,Grep,Glob,Write,Edit,NotebookEdit,Bash ");
      expect(argv).toContain("--permission-mode acceptEdits");
      expect(argv).toContain("--settings ");
    } else if (engine === "codex") {
      expect(argv).toContain("-s workspace-write");
      expect(argv).toContain("sandbox_workspace_write.network_access=false");
    } else {
      expect(launch.argv).toContain("--sandbox");
      const perms = s.fake.log().filter((e) => e.type === "permission").map((e) => [e["tool"], e["allowed"]]);
      expect(perms).toEqual([
        ["Write", true],
        ["Bash", true],
        ["Edit", false], // outside the workspace
      ]);
    }
    const tools = s.fake.log().find((e) => e.type === "mcp_ready")!["tools"] as string[];
    expect(tools).toEqual(expect.arrayContaining(["job_start", "job_observe"]));
    // code_rpc is for API models without a shell: a CLI agent has its own and is not offered it.
    expect(tools).not.toContain("code_rpc");
    expect(tools).not.toEqual(expect.arrayContaining(["write"]));
  });

  it("runs a writing cell on the host (isolation none) unsandboxed with web tools, keeping job tools on MCP", async () => {
    const s = setup(engine, [
      {
        actions: [
          { native: "Edit", kind: "edit", path: "/etc/hosts", input: {} },
          { mcp: "job_start", args: { command: "sleep 1" } },
          { text: "Started." },
        ],
      },
    ]);
    const r = s.run({ bounds: hostBounds(), spec: { processor: { kind: "llm", toolsets: TOOLSETS } } });
    expect(await runOf(s, r)).toBe("yielded_waiting");
    expect(r.ports.log.jobs.map((j) => j.command)).toEqual(["sleep 1"]);
    const launch = launches(s)[0]!;
    expect(launch.cwd).toBe(s.root);
    // capabilitiesOf: host access, and web on for every host cell even though the loop's web option is off
    expect(launch.caps).toEqual({ root: s.root, isolation: "none", write: true, edit: true, bash: true, readOnly: false, web: true, access: "host" });
    const argv = launch.argv;
    if (engine === "claude") {
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
      for (const f of ["--restricted", "--strict-mcp-config", "--tools", "--settings"]) expect(argv).not.toContain(f);
    } else if (engine === "codex") {
      expect(argv[argv.indexOf("-s") + 1]).toBe("danger-full-access");
      expect(argv.join(" ")).not.toContain("network_access=false");
      expect(argv).not.toContain("--ignore-rules");
    } else {
      expect(argv).not.toContain("--sandbox");
      // an edit outside the cwd is the owner's machine: allowed for a writing host cell
      expect(s.fake.log().filter((e) => e.type === "permission").map((e) => [e["tool"], e["allowed"]])).toEqual([["Edit", true]]);
    }
    const tools = s.fake.log().find((e) => e.type === "mcp_ready")!["tools"] as string[];
    expect(tools).toEqual(expect.arrayContaining(["job_start", "job_observe"]));
    // code_rpc is for API models without a shell: a CLI agent has its own and is not offered it.
    expect(tools).not.toContain("code_rpc");
  });

  it("tells the CLI how it runs as a cell: kernel tools over MCP, no ask-the-user or plan approval, its own sub-agents allowed, a shared directory", async () => {
    const s = setup(engine, [{ actions: [{ text: "ok" }] }]);
    const r = s.run({ bounds: hostBounds(), spec: { processor: { kind: "llm", toolsets: TOOLSETS } } });
    expect(await runOf(s, r)).toBe("completed");
    const [system] = systemTexts(s);
    expect(system).toBeDefined();
    // the cell's frozen system text first, then the kernel's note
    expect(system!.startsWith("You are a test cell.\n\n## How this cell runs\n")).toBe(true);
    expect(system).toContain('- Kernel tools: the MCP server "ng" provides them (');
    expect(system).toContain(`this client names them like ${engine === "agy" ? "mcp_ng_" : "mcp__ng__"}`);
    // nobody is at the terminal: the CLI's ask-the-user / plan-approval features are ruled out
    expect(system).toContain("- Nobody is at this terminal. Never use this CLI's ask-the-user or plan-approval features");
    expect(system).toContain("To ask the owner something, use the kernel tools");
    // docs/05-proposals/02 §二: the CLI's own sub-agents are the cell's business
    expect(system).toContain("This CLI's own sub-agents are yours to use for your own work");
    expect(system).not.toMatch(/(do not|don't|never) use (this CLI's own )?sub-?agents/i);
    // docs/05-proposals/03: nothing reserves a directory — no write-queue promise, no "read" cell note
    expect(system).toContain(`- Directory: \`${s.root}\`. You work with this CLI's own file and shell tools`);
    expect(system).toContain("Nothing reserves this directory for you: another cell, or the owner, may be working in it at the same time.");
    expect(system).not.toContain("no other cell writes in this work tree");
    expect(system).not.toContain("You are here to look");
    expect(system).toContain("When a kernel tool result says the run has ended, stop at once");
  });

  it("launches a cell whose spec still carries the deprecated cwdMode exactly like one without it", async () => {
    const turn = (text: string): FakeCliTurn => ({ actions: [{ native: "Edit", kind: "edit", path: "/etc/hosts", input: {} }, { text }] });
    const s = setup(engine, [turn("Looked."), turn("Changed.")]);
    const legacy = s.run({ bounds: hostBounds(), spec: { processor: { kind: "llm", toolsets: TOOLSETS }, cwdMode: "read" } });
    expect(await runOf(s, legacy)).toBe("completed");
    const plain = s.run({ bounds: hostBounds(), spec: { processor: { kind: "llm", toolsets: TOOLSETS } } });
    expect(await runOf(s, plain)).toBe("completed");
    const [ll, lp] = launches(s);
    expect(ll!.caps).toEqual(lp!.caps);
    expect(ll!.caps).not.toHaveProperty("cwdMode");
    expect(ll!.permissions).toBe(lp!.permissions);
    expect(ll!.cwd).toBe(lp!.cwd);
    // run-specific values (temp dirs, the bridge port) set aside
    const normalize = (argv: readonly string[]) =>
      argv.map((a) => a.replace(/ng-(cli-[a-z]+|bridge)-[A-Za-z0-9]+/g, "<tmp>").replace(/NG_BRIDGE_PORT = "\d+"/, "NG_BRIDGE_PORT = <port>"));
    expect(normalize(ll!.argv)).toEqual(normalize(lp!.argv));
    if (engine === "claude") expect(ll!.argv[ll!.argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    else if (engine === "codex") expect(ll!.argv[ll!.argv.indexOf("-s") + 1]).toBe("danger-full-access");
    else {
      expect(ll!.argv).not.toContain("--sandbox");
      expect(s.fake.log().filter((e) => e.type === "permission").map((e) => [e["tool"], e["allowed"]])).toEqual([["Edit", true], ["Edit", true]]);
    }
    const ready = s.fake.log().filter((e) => e.type === "mcp_ready").map((e) => e["tools"] as string[]);
    expect(ready).toHaveLength(2);
    expect(ready[0]).toEqual(ready[1]);
    // the very same system text
    const systems = systemTexts(s);
    expect(systems).toHaveLength(2);
    expect(systems[0]).toBe(systems[1]);
  });

  it("tells a read-only cell its workspace is read-only, and hands the CLI's cache reads to the meter as cachedTokens", async () => {
    const s = setup(engine, [{ actions: [{ native: "Read", kind: "read", input: { file_path: "a.md" }, output: "a" }, { usage: { tokens: 700, cached: 300 } }, { text: "read it" }] }]);
    const r = s.run();
    expect(await runOf(s, r)).toBe("completed");
    const [system] = systemTexts(s);
    expect(system).toContain(`- Directory: \`${s.root}\`. This workspace is read-only`);
    expect(system).toContain("Never use this CLI's ask-the-user or plan-approval features");
    // cache reads reach the kernel's meter as cachedTokens, whichever CLI reported them
    expect(r.ports.totalUsage().cachedTokens).toBe(300);
  });

  it("ends the Run when a kernel tool says so, refuses later calls and stops the CLI", async () => {
    const s = setup(engine, [
      {
        actions: [
          { mcp: "wait", args: { reason: "nothing to do" } },
          { mcp: "set_state", args: { patches: { late: true } } },
          { sleep: 30_000 },
        ],
      },
    ]);
    const r = s.run();
    await recordBatch(r);
    const cursor = watchCursor(r);
    const t0 = Date.now();
    expect(await runOf(s, r)).toBe("yielded_waiting");
    expect(cursor.at(-1)).toBe(1);
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(r.ports.state.has("late")).toBe(false);
    const results = s.fake.log().filter((e) => e.type === "mcp_result");
    expect(results[0]?.["text"]).toContain(RUN_ENDED_NOTICE);
    if (results[1]) {
      expect(results[1]["text"]).toBe(RUN_ALREADY_ENDED);
      expect(results[1]["isError"]).toBe(true);
    }
  });

  it("ends with deferred_for_approval when a card is raised, stopping a CLI that keeps going after the grace period", async () => {
    const s = setup(engine, [
      {
        actions: [
          { mcp: "request_approval", args: { kind: "action", title: "Merge PR", summary: "merge #12", action: { name: "merge" } } },
          { sleep: 30_000 },
        ],
      },
    ], { endRunGraceMs: 1_000 });
    const r = s.run();
    await recordBatch(r);
    const cursor = watchCursor(r);
    const t0 = Date.now();
    expect(await runOf(s, r)).toBe("deferred_for_approval");
    expect(cursor.at(-1)).toBe(1);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(5_000);
    expect(r.ports.log.authorizations[0]?.result.type).toBe("defer");
  });

  it("replays a post-settlement system note once, and confirms only the input seen by this session", async () => {
    const s = setup(engine, [{actions:[{text:"first"}]}, {actions:[{text:"second"}]}]);
    const first = s.run();
    await runOf(s, first);
    const own = first.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord;
    const next = s.run({runId:"second", batch:["next task"]});
    next.snapshot.historyUptoSeq = 101;
    next.snapshot.summaryUptoSeq = 101;
    next.ports.state.set(CLI_SESSION_KEY, {...own,lastDeliveredEvidenceSeq:100});
    const evidence = [
      {seq:100,cellId:next.snapshot.cellId,record:{runId:"history",kind:"system_note" as const,text:"already received",at:0}},
      {seq:101,cellId:next.snapshot.cellId,record:{runId:"history",kind:"system_note" as const,text:"closure was deferred",at:1}},
      {seq:102,cellId:next.snapshot.cellId,record:{runId:"history",kind:"inbound" as const,envelope:next.snapshot.batch.envelopes[0]!,at:2}},
      {seq:103,cellId:next.snapshot.cellId,record:{runId:"history",kind:"system_note" as const,text:"late note",at:3}},
    ];
    next.ports.listEvidence = opts => evidence.filter(e => e.seq > (opts?.afterSeq ?? 0));
    const confirmed: number[] = [];
    next.ports.confirmCliInput = (session, seq) => { expect(session).toBe(own.sessionId); confirmed.push(seq); };
    await runOf(s,next);
    const prompt = s.fake.prompts()[1]!;
    expect(prompt.match(/closure was deferred/g)).toHaveLength(1);
    expect(prompt).not.toMatch(/already received|late note/);
    expect(confirmed.at(-1)).toBe(102);
  });

  it("resumes its session on the next Run with only the new input", async () => {
    const s = setup(engine, [{ actions: [{ text: "first" }] }, { actions: [{ text: "second" }] }]);
    const r1 = s.run({ runId: "run_1", batch: ["hello there"] });
    expect(await runOf(s, r1)).toBe("completed");
    const rec = r1.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord;

    const r2 = s.run({
      runId: "run_2",
      batch: ["what next?"],
      history: [
        { role: "user", content: [{ type: "text", text: "[user.message from channel:ui:owner] hello there" }] },
        { role: "assistant", content: [{ type: "text", text: "first" }] },
      ],
    });
    r2.ports.state.set(CLI_SESSION_KEY, rec);
    expect(await runOf(s, r2)).toBe("completed");

    const [l1, l2] = launches(s);
    expect(l1!.session).toBeUndefined();
    expect(l2!.session).toEqual({ id: rec.sessionId, mode: "resume" });
    const prompts = s.fake.prompts();
    expect(prompts[1]).toBe("[user.message from channel:ui:owner] what next?");
    expect(prompts[1]).not.toContain("hello there");
    expect((r2.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord).sessionId).toBe(rec.sessionId);
    expect((r2.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord).runs).toBe(2);

    // the frozen system text goes in through the CLI's own mechanism on the fresh session only
    if (engine === "claude") {
      expect(l1!.argv).toContain("--append-system-prompt-file");
    } else if (engine === "codex") {
      const cfg = s.fake.log().filter((e) => e.type === "codex_config");
      expect(cfg[0]!["developerInstructions"]).toContain("You are a test cell.");
      expect(cfg[1]!["developerInstructions"]).toBeNull();
    } else {
      const sessions = s.fake.log().filter((e) => e.type === "acp_session");
      expect(sessions[0]).toMatchObject({ method: "session/new" });
      expect(sessions[0]!["systemPrompt"]).toContain("You are a test cell.");
      expect(sessions[1]).toMatchObject({ method: "session/resume" });
    }
  });

  it("falls back to a fresh session primed with the history when the session is gone", async () => {
    const s = setup(engine, [{ actions: [{ text: "recovered" }] }]);
    const r = s.run({
      batch: ["continue please"],
      history: [
        { role: "user", content: [{ type: "text", text: "earlier question" }] },
        { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
      ],
    });
    const stale: CliSessionRecord = { engine, sessionId: "00000000-0000-4000-8000-000000000000", model: null, cwd: s.root, systemHash: r.snapshot.system.hash, createdAt: 0, updatedAt: 0, runs: 3 };
    r.ports.state.set(CLI_SESSION_KEY, stale);
    expect(await runOf(s, r)).toBe("completed");
    const ls = launches(s);
    expect(ls).toHaveLength(2);
    expect(ls[0]!.session).toEqual({ id: stale.sessionId, mode: "resume" });
    expect(ls[1]!.session).toBeUndefined();
    const prompt = s.fake.prompts().at(-1)!;
    expect(prompt).toContain(HISTORY_HEADER);
    expect(prompt).toContain("earlier answer");
    expect(prompt).toContain("continue please");
    const rec = r.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord;
    expect(rec.sessionId).not.toBe(stale.sessionId);
    expect(r.ports.log.evidence.some((e) => e.kind === "assistant_text" && e.text === "recovered")).toBe(true);
  });

  it("stops a subscription CLI reporting $0 on the token ledger (budget_stopped)", async () => {
    // claude reports usage mid-turn (stopped at once, while the fake would sleep on); codex/agy only when the turn ends
    const s = setup(engine, [{ actions: engine === "claude" ? [{ usage: { tokens: 50_000, costUsd: 0 } }, { sleep: 30_000 }] : [{ usage: { tokens: 50_000, costUsd: 0 } }] }]);
    const bounds = makeBounds({ tools: ["read"], canSendTo: ["inbox:*"] as Address[], isolation: "git_worktree", maxConcurrentChildren: 1, maxDepth: 0, maxTokens: 10_000, maxCents: 100_000 });
    const r = s.run({ bounds });
    const t0 = Date.now();
    expect(await runOf(s, r)).toBe("budget_stopped");
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(r.ports.totalUsage().billedCents).toBe(0);
    expect(r.ports.totalUsage().tokens).toBeGreaterThanOrEqual(10_000);
  });

  it("kills the whole process tree promptly on abort (cancelled)", async () => {
    const s = setup(engine, [{ actions: [{ sleep: 60_000 }] }]);
    const r = s.run();
    const p = runOf(s, r);
    await waitFor(() => s.fake.prompts().length > 0, "the fake to receive its prompt");
    const pid = s.fake.log().find((e) => e.type === "argv")!.pid;
    const t0 = Date.now();
    r.controller.abort();
    expect(await p).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("delivers a steer message mid-run", async () => {
    const s = setup(engine, [{ actions: [{ sleep: engine === "claude" ? 1_000 : 20_000 }, { text: "first part" }] }, { actions: [{ text: "steered!" }] }]);
    const r = s.run();
    const p = runOf(s, r);
    await waitFor(() => s.fake.prompts().length > 0 && s.debug.some((d) => d.type === "launch"), "the first prompt");
    await new Promise((res) => setTimeout(res, 200));
    r.ports.pushSteer("use the other repo");
    expect(await p).toBe("completed");
    const ev = r.ports.log.evidence;
    expect(ev.some((e) => e.kind === "system_note" && e.text.includes("use the other repo"))).toBe(true);
    expect(ev.some((e) => e.kind === "assistant_text" && e.text === "steered!")).toBe(true);
    expect(s.fake.prompts()[1]).toContain("use the other repo");
    if (engine === "codex") {
      // no live input: interrupted and resumed with the steer text
      expect(launches(s).map((l) => l.session?.mode ?? "fresh")).toEqual(["fresh", "resume"]);
    } else {
      expect(launches(s)).toHaveLength(1);
    }
    if (engine === "agy") expect(s.fake.log().some((e) => e.type === "cancel")).toBe(true);
  }, 30_000);

  it("rebuilds from the SQLite fork point when the parent CLI advanced",async()=>{
    const s=setup(engine,[{actions:[{text:"child"}]}]);
    const child=s.run({cellId:"child",parentId:"parent",spec:{processor:{kind:"llm",toolsets:TOOLSETS},contextMode:"fork_prefix",fork:{fromCellId:"parent",uptoSeq:100}},
      history:[{role:"user",content:[{type:"text",text:"original parent evidence"}]},{role:"user",content:[{type:"text",text:FORK_NOTE_PREFIX+" parent"}]}],batch:["child task"]});
    child.ports.state.set(CLI_FORK_SESSION_KEY,{engine,sessionId:"stale",model:null,cwd:s.root,lastDeliveredEvidenceSeq:100});
    child.ports.canForkSession=()=>false;
    await runOf(s,child);
    expect(launches(s)[0]!.session).toBeUndefined();
    expect(s.fake.prompts()[0]).toContain("original parent evidence");
  });

  it("continues a fork_prefix child from the parent's CLI session when the CLI can fork", async () => {
    const s = setup(engine, [{ actions: [{ text: "parent" }] }, { actions: [{ text: "child" }] }]);
    const parent = s.run({ cellId: "parent", runId: "run_p" });
    expect(await runOf(s, parent)).toBe("completed");
    const parentRec = parent.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord;

    const forkNote = `${FORK_NOTE_PREFIX} "parent" up to the moment it created this cell. You are now "child".`;
    const child = s.run({
      cellId: "child",
      runId: "run_c",
      parentId: "parent",
      spec: { processor: { kind: "llm", toolsets: TOOLSETS, allowedTools: ["read"] }, contextMode: "fork_prefix",fork:{fromCellId:"parent",uptoSeq:1} },
      batch: ["do the subtask"],
      history: [
        { role: "user", content: [{ type: "text", text: "parent's own question" }] },
        { role: "assistant", content: [{ type: "text", text: "parent's answer" }] },
        { role: "user", content: [{ type: "text", text: forkNote }] },
      ],
    });
    child.ports.state.set(CLI_FORK_SESSION_KEY, parentRec);
    expect(await runOf(s, child)).toBe("completed");
    const l = launches(s)[1]!;
    const prompt = s.fake.prompts()[1]!;
    if (engine === "agy") {
      expect(l.session).toBeUndefined();
      expect(prompt).toContain("parent's answer"); // rendered history instead
    } else {
      expect(l.session).toEqual({ id: parentRec.sessionId, mode: "fork" });
      expect(prompt.startsWith("### Input")).toBe(true);
      expect(prompt).toContain(FORK_NOTE_PREFIX);
      expect(prompt).not.toContain("parent's answer");
      const rec = child.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord;
      expect(rec.forkedFrom).toBe(parentRec.sessionId);
      expect(rec.sessionId).not.toBe(parentRec.sessionId);
      expect(child.ports.state.has(CLI_FORK_SESSION_KEY)).toBe(false);
    }
  });
});

describe("CLI usage metering (BUG-002)", () => {
  const usageTurn = (tokens: number, cached = 0): FakeCliTurn => ({ actions: [{ usage: { tokens, cached } }, { text: `used ${tokens}` }] });

  /** Runs one cell `n` times in a row, handing each Run the CLI session record the previous one left (as the kernel does). */
  async function runInSequence(s: Setup, n: number, first?: CliSessionRecord): Promise<FakeRun[]> {
    const runs: FakeRun[] = [];
    let rec = first;
    for (let i = 1; i <= n; i++) {
      const r = s.run({ runId: `run_${i}`, batch: [`step ${i}`] });
      if (rec) r.ports.state.set(CLI_SESSION_KEY, rec);
      expect(await runOf(s, r)).toBe("completed");
      runs.push(r);
      rec = sessionOf(r);
    }
    return runs;
  }

  it("codex: meters only what each resumed turn added to the session's running total (1000, 500, 2000 — not 1000, 1500, 3500)", async () => {
    const s = setup("codex", [usageTurn(1_000, 200), usageTurn(500, 100), usageTurn(2_000, 1_500)]);
    const runs = await runInSequence(s, 3);
    expect(launches(s).map((l) => l.session?.mode ?? "fresh")).toEqual(["fresh", "resume", "resume"]);
    const rec = sessionOf(runs[2]!);
    expect(launches(s).slice(1).map((l) => l.session?.id)).toEqual([rec.sessionId, rec.sessionId]);
    // the fake reports the session's totals (1000, 1500, 3500), like the real CLI after `exec resume`
    expect(runs.map(meteredOf)).toEqual([
      [{ tokens: 1_000, billedCents: 0, cachedTokens: 200 }],
      [{ tokens: 500, billedCents: 0, cachedTokens: 100 }],
      [{ tokens: 2_000, billedCents: 0, cachedTokens: 1_500 }],
    ]);
    // the totals already metered travel with the session
    expect(runs.map((r) => sessionOf(r).reported)).toEqual([
      { tokens: 1_000, cached: 200 },
      { tokens: 1_500, cached: 300 },
      { tokens: 3_500, cached: 1_800 },
    ]);
    expect(rec.runs).toBe(3);
  });

  it("codex: a running total below the one already metered means the counters restarted — all of it is new", async () => {
    const s = setup("codex", [usageTurn(1_000), usageTurn(500)]);
    const [first] = await runInSequence(s, 1);
    const rec = { ...sessionOf(first!), reported: { tokens: 9_000, cached: 0 } };
    const [second] = await runInSequence(s, 1, rec);
    expect(launches(s)[1]!.session).toEqual({ id: rec.sessionId, mode: "resume" });
    expect(meteredOf(second!)).toEqual([{ tokens: 1_500, billedCents: 0 }]);
    expect(sessionOf(second!).reported).toEqual({ tokens: 1_500, cached: 0 });
  });

  it("codex: a session rebuilt after a failed resume is metered from its own total, not the lost session's", async () => {
    const s = setup("codex", [usageTurn(700, 100)]);
    const stale: CliSessionRecord = {
      engine: "codex",
      sessionId: "00000000-0000-4000-8000-000000000000",
      model: null,
      cwd: s.root,
      systemHash: "fake",
      createdAt: 0,
      updatedAt: 0,
      runs: 4,
      reported: { tokens: 200, cached: 50 },
    };
    const [r] = await runInSequence(s, 1, stale);
    expect(launches(s).map((l) => l.session?.mode ?? "fresh")).toEqual(["resume", "fresh"]);
    // not 500 / 50: the new session's counters start at zero
    expect(meteredOf(r!)).toEqual([{ tokens: 700, billedCents: 0, cachedTokens: 100 }]);
    const rec = sessionOf(r!);
    expect(rec.sessionId).not.toBe(stale.sessionId);
    expect(rec.reported).toEqual({ tokens: 700, cached: 100 });
    expect(rec.runs).toBe(1);
  });

  it("codex: a fork_prefix child starts from its parent's metered total (the fork's figures include the parent's)", async () => {
    const s = setup("codex", [usageTurn(1_000, 400), usageTurn(300, 100)]);
    const parent = s.run({ cellId: "parent", runId: "run_p" });
    expect(await runOf(s, parent)).toBe("completed");
    const parentRec = sessionOf(parent);
    expect(parentRec.reported).toEqual({ tokens: 1_000, cached: 400 });
    const child = s.run({
      cellId: "child",
      runId: "run_c",
      parentId: "parent",
      spec: { processor: { kind: "llm", toolsets: TOOLSETS, allowedTools: ["read"] }, contextMode: "fork_prefix",fork:{fromCellId:"parent",uptoSeq:1} },
      batch: ["do the subtask"],
      history: [{ role: "user", content: [{ type: "text", text: `${FORK_NOTE_PREFIX} "parent" up to the moment it created this cell. You are now "child".` }] }],
    });
    child.ports.state.set(CLI_FORK_SESSION_KEY, parentRec);
    expect(await runOf(s, child)).toBe("completed");
    expect(launches(s)[1]!.session).toEqual({ id: parentRec.sessionId, mode: "fork" });
    expect(meteredOf(child)).toEqual([{ tokens: 300, billedCents: 0, cachedTokens: 100 }]);
    expect(sessionOf(child).reported).toEqual({ tokens: 1_300, cached: 500 });
  });

  it.each(["claude", "agy"] as const)("%s: meters each turn as reported (its figures are per turn) and keeps no session total", async (engine) => {
    const s = setup(engine, [usageTurn(1_000, 200), usageTurn(500, 100)]);
    const runs = await runInSequence(s, 2);
    expect(launches(s).map((l) => l.session?.mode ?? "fresh")).toEqual(["fresh", "resume"]);
    const sum = (us: Usage[], k: "tokens" | "cachedTokens") => us.reduce((n, u) => n + (u[k] ?? 0), 0);
    // the fake claude also counts 2 tokens for each assistant message (here: the usage and the text message)
    const overhead = engine === "claude" ? 4 : 0;
    expect(runs.map((r) => sum(meteredOf(r), "tokens"))).toEqual([1_000 + overhead, 500 + overhead]);
    expect(runs.map((r) => sum(meteredOf(r), "cachedTokens"))).toEqual([200, 100]);
    for (const r of runs) expect(sessionOf(r).reported).toBeUndefined();
  });
});

describe("CLI loop with a fake codex: hidden tool items (BUG-008)", () => {
  const exec = (callId: string, input: string, rest: Record<string, unknown> = {}) => ({ item: { type: "custom_tool_call", call_id: callId, name: "exec", input, ...rest } });

  it("mirrors code-mode custom_tool_call items into the evidence as tool calls with their results", async () => {
    const s = setup("codex", [
      {
        actions: [
          exec("call_1", "1 + 1", { output: "2", status: "completed" }),
          exec("call_2", "await tools.shell('ls')", { status: "completed" }),
          { item: { type: "custom_tool_call_output", call_id: "call_2", output: "README.md" } },
          { item: { type: "reasoning", text: "thinking" } },
          { text: "computed" },
        ],
      },
    ]);
    const r = s.run();
    expect(await runOf(s, r)).toBe("completed");
    const ev = r.ports.log.evidence.flatMap((e) =>
      e.kind === "tool_call" ? [{ id: e.toolUseId, step: ["call", e.name, e.input] }] : e.kind === "tool_result" ? [{ id: e.toolUseId, step: ["result", e.name, e.output] }] : [],
    );
    expect(ev.map((e) => e.step)).toEqual([
      ["call", "exec", { input: "1 + 1" }],
      ["result", "exec", "2"],
      ["call", "exec", { input: "await tools.shell('ls')" }],
      ["result", "exec", "README.md"],
    ]);
    // each result is paired with its call
    expect(ev[1]!.id).toBe(ev[0]!.id);
    expect(ev[3]!.id).toBe(ev[2]!.id);
    expect(ev[2]!.id).not.toBe(ev[0]!.id);
    expect(r.ports.log.evidence.some((e) => e.kind === "assistant_text" && e.text === "computed")).toBe(true);
  });

  it("counts them as steps: a turn of many exec calls stops at maxSteps", async () => {
    const s = setup("codex", [{ actions: [1, 2, 3, 4].map((n) => exec(`call_${n}`, `step(${n})`, { output: "ok", status: "completed" })) }]);
    const r = s.run({ spec: { processor: { kind: "llm", toolsets: TOOLSETS, allowedTools: ["read"], maxSteps: 2 } } });
    await recordBatch(r);
    const cursor = watchCursor(r);
    expect(await runOf(s, r)).toBe("step_limit");
    expect(cursor.at(-1)).toBe(1);
    expect(r.ports.log.evidence.some((e) => e.kind === "system_note" && e.text.includes("run stopped after 2 tool calls (step limit)"))).toBe(true);
  });
});

describe("CLI loop errors", () => {
  it.each(["cancelled", "timeout"])("does not confirm the initial steer when Claude acknowledges %s", async reason => {
    const s = setup("claude", [
      {actions:[{text:"working"},{sleep:20_000}], acknowledgeInterrupt:true},
      {actions:[{text:"continued"}]},
    ], reason === "timeout" ? {runTimeoutMs:3_000} : {});
    const first = s.run();
    const steer = "review the red folder";
    first.ports.pushSteer(steer);
    const old = await first.ports.context.appendEvidence(first.snapshot.cellId, {kind:"system_note", text:"already in the fresh prompt", runId:null, at:0});
    first.snapshot.historyUptoSeq = old.seq;
    await recordBatch(first);
    const cursor = watchCursor(first);
    const outcome = runOf(s, first);
    if (reason === "cancelled") {
      await waitFor(() => first.ports.log.evidence.some(e => e.kind === "assistant_text"), "the first text");
      first.controller.abort();
      expect(await outcome).toBe("cancelled");
    } else await expect(outcome).rejects.toThrow(/exceeded/);
    expect(s.fake.prompts()[0]).toContain(steer);
    expect(s.fake.log().some(e => e.type === "interrupt_ack")).toBe(true);
    expect(cursor).toEqual([]);
    expect(first.ports.state.get(CLI_SESSION_KEY)).toMatchObject({ lastDeliveredEvidenceSeq:old.seq });
    const history = first.ports.listEvidence!({});
    expect(history.some(e => e.record.kind === "system_note" && e.record.text.includes(steer))).toBe(false);

    const next = s.run({runId:"next", batch:[steer]});
    next.snapshot.historyUptoSeq = history.at(-1)!.seq;
    next.ports.listEvidence = filter => history.filter(e => e.seq > (filter?.afterSeq ?? 0));
    next.ports.state.set(CLI_SESSION_KEY, first.ports.state.get(CLI_SESSION_KEY));
    expect(await runOf(s, next)).toBe("completed");
    expect(launches(s).at(-1)?.session?.mode).toBe("resume");
    expect(s.fake.prompts().at(-1)?.split(steer)).toHaveLength(2);
  }, 15_000);

  it("confirms a waiting tool's input when stdout reports the new session after its MCP result", async () => {
    const s = setup("claude", [{actions:[
      {mcp:"wait", args:{reason:"nothing left"}},
      {sleep:10_000},
    ]}], {endRunGraceMs:300});
    s.fake.env["FAKECLI_DELAY_INIT"] = "1";
    const r = s.run();
    await recordBatch(r);
    const confirmed = watchCursor(r);
    expect(await runOf(s,r)).toBe("yielded_waiting");
    expect(confirmed).toEqual([1]);
    expect(r.ports.state.get(CLI_SESSION_KEY)).toMatchObject({engine:"claude"});
  });

  it("pairs the MCP call which crosses the step limit with an error result", async () => {
    const s = setup("claude", [{actions:[
      {mcp:"set_state", args:{patches:{first:true}}},
      {mcp:"set_state", args:{patches:{overflow:true}}},
    ]}]);
    const r = s.run({spec:{processor:{kind:"llm",toolsets:TOOLSETS,maxSteps:1}}});
    expect(await runOf(s,r)).toBe("step_limit");
    const calls = r.ports.log.evidence.filter(e=>e.kind === "tool_call");
    const results = r.ports.log.evidence.filter(e=>e.kind === "tool_result");
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({toolUseId:calls[1]!.toolUseId, isError:true});
    expect(r.ports.state.has("overflow")).toBe(false);
  });

  it("surfaces a failing CLI as an error (the kernel retries the claim)", async () => {
    const s = setup("codex", [{ actions: [{ fail: "model overloaded" }] }]);
    const first = s.run();
    await expect(runOf(s, first)).rejects.toThrow(/model overloaded/);
    expect(first.ports.state.get(CLI_SESSION_KEY)).toBeFalsy();
  });

  it("refuses container workspaces instead of running the CLI on the host", async () => {
    const s = setup("claude", []);
    const r = s.run({ bounds: makeBounds({ ...writerBounds(), tools: [...writerBounds().tools], isolation: "container" }) });
    await expect(runOf(s, r)).rejects.toThrow(/container/);
    expect(launches(s)).toHaveLength(0);
  });
});

  it("requeues an unconfirmed live steer and delivers it once on the next resume", async () => {
    const s = setup("claude", [{ actions: [{sleep:600}, {mcp:"wait",args:{reason:"waiting for input"}}, {exit:0}] },
      {actions:[{text:"continued"}]}],{endRunGraceMs:100});
    const first = s.run();
    await recordBatch(first);
    const cursor = watchCursor(first);
    const outcome = runOf(s,first);
    await waitFor(()=>s.fake.prompts().length>0,"the first prompt");
    first.ports.pushSteer("review the red folder");
    expect(await outcome).toBe("yielded_waiting");
    expect(first.ports.log.requeued.flatMap(r=>r.envelopeIds)).toHaveLength(1);
    const history = first.ports.listEvidence!({});
    expect(history.some(({record})=>record.kind==="system_note" && record.text.includes("red folder"))).toBe(false);
    const next = s.run({runId:"next",batch:["review the red folder"]});
    next.snapshot.historyUptoSeq = history.at(-1)!.seq;
    next.ports.listEvidence = filter=>history.filter(e=>e.seq>(filter?.afterSeq ?? 0));
    next.ports.state.set(CLI_SESSION_KEY,{...first.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord,lastDeliveredEvidenceSeq:cursor.at(-1)});
    expect(await runOf(s,next)).toBe("completed");
    expect(launches(s).at(-1)?.session?.mode).toBe("resume");
    expect(s.fake.prompts().at(-1)?.match(/review the red folder/g)).toHaveLength(1);
  });
