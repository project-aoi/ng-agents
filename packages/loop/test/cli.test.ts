import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvelope, createRegistry, makeBounds, TOOL_KINDS, type Address, type CliEngine, type PolicyBounds, type Registry, type RunOutcome, type Envelope } from "@ng/protocol";
import {
  CLI_FORK_SESSION_KEY,
  CLI_SESSION_KEY,
  createCliAgentLoop,
  registerStandardToolsets,
  RUN_ALREADY_ENDED,
  RUN_ENDED_NOTICE,
  STANDARD_TOOLSETS,
  WORKBENCH_CELL_ENV,
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
  return makeBounds({ tools: TOOL_KINDS, canSendTo: ["channel:*", "inbox:*"] as Address[], maxConcurrentChildren: 4, maxDepth: 2 });
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

const ENGINES: CliEngine[] = ["claude", "codex", "agy"];

describe.each(ENGINES)("CLI loop with a fake %s", (engine) => {
  it("runs a kernel tool through the MCP bridge, mirrors the transcript and records the session (read-only cell)", async () => {
    const s = setup(engine, [
      {
        actions: [
          { text: "Let me record that." },
          { mcp: "set_state", args: { patches: { seen: true } } },
          { native: "Read", kind: "read", input: { file_path: "notes.md" }, output: "file body" },
          { text: "Recorded." },
        ],
      },
    ]);
    Object.assign(s.fake.env, { NG_DESK_TOKEN: "fixture", ANTHROPIC_API_KEY: "fixture", CLAUDECODE: "1" });
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
      expect(argv).toContain("--tools Read,Grep,Glob,WebFetch,WebSearch ");
      expect(argv).toContain("--permission-mode dontAsk");
      expect(argv).toContain("--permission-prompts none");
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
    // secrets and kernel configuration never reach the CLI — only the mark that a workbench cell started it
    for (const e of s.fake.log().filter((x) => x.type === "argv")) expect(e["envNames"]).toEqual([WORKBENCH_CELL_ENV]);
  });


  it("runs a writing cell on the host unsandboxed with web tools, keeping job tools on MCP", async () => {
    const s = setup(engine, [
      {
        actions: [
          { native: "Edit", kind: "edit", path: "/etc/hosts", input: {} },
          { mcp: "job_start", args: { command: "sleep 1" } },
          { text: "Started." },
        ],
      },
    ]);
    const r = s.run({ bounds: writerBounds(), spec: { processor: { kind: "llm", toolsets: TOOLSETS } } });
    expect(await runOf(s, r)).toBe("yielded_waiting");
    expect(r.ports.log.jobs.map((j) => j.command)).toEqual(["sleep 1"]);
    const launch = launches(s)[0]!;
    expect(launch.cwd).toBe(s.root);
    // capabilitiesOf: host access, and web on for every host cell even though the loop's web option is off
    expect(launch.caps).toEqual({ root: s.root, write: true, edit: true, bash: true, readOnly: false, web: true });
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
  });

  it("tells the CLI how it runs as a cell: kernel tools over MCP, no ask-the-user or plan approval, its own sub-agents allowed, a shared directory", async () => {
    const s = setup(engine, [{ actions: [{ text: "ok" }] }]);
    const r = s.run({ bounds: writerBounds(), spec: { processor: { kind: "llm", toolsets: TOOLSETS } } });
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


  it("tells a read-only cell its workspace is read-only", async () => {
    const s = setup(engine, [{ actions: [{ native: "Read", kind: "read", input: { file_path: "a.md" }, output: "a" }, { text: "read it" }] }]);
    const r = s.run();
    expect(await runOf(s, r)).toBe("completed");
    const [system] = systemTexts(s);
    expect(system).toContain(`- Directory: \`${s.root}\`. This workspace is read-only`);
    expect(system).toContain("Never use this CLI's ask-the-user or plan-approval features");
  });

  it("ends the Run when a kernel tool says so, refuses later calls and stops the CLI", async () => {
    const gateCall = {
      mcp: "request_approval",
      args: { kind: "escalation", title: "确认", summary: "等确认", escalation: { reason: "blocked", explanation: "需要确认" } },
    };
    const s = setup(engine, [
      {
        actions: [
          gateCall,
          { mcp: "set_state", args: { patches: { late: true } } },
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

  it("replays system notes and external evidence once, and confirms only the input seen by this session", async () => {
    const s = setup(engine, [{actions:[{text:"first"}]}, {actions:[{text:"second"}]}]);
    const first = s.run();
    await runOf(s, first);
    const own = first.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord;
    const next = s.run({runId:"second", batch:["next task"]});
    next.snapshot.historyUptoSeq = 102;
    next.snapshot.summaryUptoSeq = 102;
    next.ports.state.set(CLI_SESSION_KEY, {...own,lastDeliveredEvidenceSeq:100});
    const evidence = [
      {seq:100,cellId:next.snapshot.cellId,record:{runId:"history",kind:"system_note" as const,text:"already received",at:0}},
      {seq:101,cellId:next.snapshot.cellId,record:{runId:"history",kind:"system_note" as const,text:"closure was deferred",at:1}},
      {seq:102,cellId:next.snapshot.cellId,record:{runId:null,kind:"external" as const,source:"sensor",title:"release",text:"observed while asleep",at:1}},
      {seq:103,cellId:next.snapshot.cellId,record:{runId:"history",kind:"inbound" as const,envelope:next.snapshot.batch.envelopes[0]!,at:2}},
      {seq:104,cellId:next.snapshot.cellId,record:{runId:null,kind:"external" as const,source:"sensor",text:"late observation",at:3}},
    ];
    next.ports.listEvidence = opts => evidence.filter(e => e.seq > (opts?.afterSeq ?? 0));
    const confirmed: number[] = [];
    next.ports.confirmCliInput = (session, seq) => { expect(session).toBe(own.sessionId); confirmed.push(seq); };
    await runOf(s,next);
    const prompt = s.fake.prompts()[1]!;
    expect(prompt.match(/closure was deferred/g)).toHaveLength(1);
    expect(prompt.match(/observed while asleep/g)).toHaveLength(1);
    expect(prompt).not.toMatch(/already received|late observation/);
    expect(confirmed.at(-1)).toBe(103);
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
    const stale: CliSessionRecord = { engine, sessionId: "00000000-0000-4000-8000-000000000000", model: null, cwd: s.root, systemHash: r.snapshot.system.hash, lastDeliveredEvidenceSeq: 0, createdAt: 0, updatedAt: 0, runs: 3 };
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

  it("replays the fork history when the parent's working directory differs", async () => {
    const s = setup(engine,[{actions:[{text:"fresh child"}]}]);
    const child = s.run({
      cellId:"child", parentId:"parent", spec:{processor:{kind:"llm",toolsets:TOOLSETS},contextMode:"fork_prefix",fork:{fromCellId:"parent",uptoSeq:1}},
      history:[{role:"user",content:[{type:"text",text:"from the parent's history"}]}, {role:"user",content:[{type:"text",text:FORK_NOTE_PREFIX+" parent"}]}],
    });
    child.ports.state.set(CLI_FORK_SESSION_KEY,{engine,sessionId:"parent",model:null,cwd:tempDir("another-workdir"),systemHash:"parent",lastDeliveredEvidenceSeq:1});
    expect(await runOf(s,child)).toBe("completed");
    expect(launches(s)[0]!.session).toBeUndefined();
    expect(s.fake.prompts()[0]).toContain("from the parent's history");
  });
  // Audit 2026-11-23 E11: a forked project in its own directory ran under the desk's role prompt, its real role only
  // in a user message.
  it("gives a fork_prefix child that cannot continue the parent's session its own system prompt", async () => {
    const s = setup(engine,[{actions:[{text:"fresh child"}]}]);
    const child = s.run({
      cellId:"child", parentId:"parent", system:"You are the owner's desk.",
      spec:{processor:{kind:"llm",toolsets:TOOLSETS},contextMode:"fork_prefix",fork:{fromCellId:"parent",uptoSeq:1}},
      history:[{role:"user",content:[{type:"text",text:"from the parent's history"}]}, {role:"user",content:[{type:"text",text:`${FORK_NOTE_PREFIX} "parent" …\n\n## Your instructions\nYou are a project.`}]}],
    });
    child.snapshot.system.own = "You are a project.";
    child.ports.state.set(CLI_FORK_SESSION_KEY,{engine,sessionId:"parent",model:null,cwd:tempDir("another-workdir"),systemHash:"parent",lastDeliveredEvidenceSeq:1});
    expect(await runOf(s,child)).toBe("completed");
    expect(launches(s)[0]!.session).toBeUndefined();
    const [system] = systemTexts(s);
    expect(system).toContain("You are a project.");
    expect(system).not.toContain("You are the owner's desk.");
    const prompt = s.fake.prompts()[0]!;
    // The parent's context is still there as background; the role is no longer repeated in a user message.
    expect(prompt).toContain("from the parent's history");
    expect(prompt).toContain(`${FORK_NOTE_PREFIX} "parent"`);
    expect(prompt).not.toContain("## Your instructions");
  });

  // Audit 2026-11-23 E09: the kernel asked for one closing sentence and then threw it away — the desk's "方案已提交，
  // 等你确认" never reached the owner.
  const endGate = {
    mcp: "request_approval",
    args: { kind: "escalation", title: "确认", summary: "等主人确认", escalation: { reason: "blocked", explanation: "需要确认" } },
  };
  it("keeps what the model says after the tool that ended the run", async () => {
    const s = setup(engine, [{ actions: [endGate, { text: "方案已提交到待我处理，等你确认后开始。" }] }]);
    const r = s.run();
    expect(await runOf(s, r)).toBe("deferred_for_approval");
    expect(r.ports.log.evidence.filter((e) => e.kind === "assistant_text").map((e) => e.text)).toEqual(["方案已提交到待我处理，等你确认后开始。"]);
  });

  // Audit 2026-11-23 rerun M15: with nothing left to say, the model answered the notice with "OK" (or repeated what it
  // had already sent) — and that became the turn's last words on the record the owner reads.
  it("does not keep a bare acknowledgement after the tool that ended the run, and tells the model not to repeat itself", async () => {
    // The acknowledgement the notice asks for, however it is dressed; a sentence that starts with it is still kept.
    const closings: Array<[string, boolean]> = [
      ["OK", false],
      ['"OK."', false],
      ["**OK**", false],
      ["OK，方案已提交到待我处理。", true],
    ];
    for (const [closing, kept] of closings) {
      const s = setup(engine, [{ actions: [endGate, { text: closing }] }]);
      const r = s.run();
      expect(await runOf(s, r)).toBe("deferred_for_approval");
      const said = r.ports.log.evidence.filter((e) => e.kind === "assistant_text").map((e) => e.text);
      expect(said, closing).toEqual(kept ? [closing] : []);
      // What the model read in the result of the tool that ended its run.
      const notice = String(s.fake.log().find((e) => e.type === "mcp_result")?.["text"]);
      expect(notice).toContain("do not repeat");
      expect(notice).toContain('nothing but "OK"');
    }
  });

  // Live rerun (uc23, uc06): a project woken by a worker's result said what it did, called an endRun tool from a script
  // that swallowed the tool result (so it never read the request to keep quiet), and then wrote the same account again —
  // on the record the owner reads, every turn. Words after the end are an answer only when a person is being
  // answered, or when they are the only thing the turn said.
  it("keeps closing words for a person or when nothing was said before; drops a recap in a turn nobody is talking in", async () => {
    const fromWorker = () => createEnvelope({ id: "res_1", from: "inbox:w1", to: "inbox:cell_1", principalId: "cell:w1", kind: "result", type: "cell.result",
      payload: { childCellId: "w1", status: "completed", summary: "改好了", childState: "dormant" } });
    const turn = [{ actions: [{ text: "分身交付了，我去通知主人并等验收。" }, endGate, { text: "已通知主人，现在等待验收：改动在 feat/x。" }] }];
    const said = (r: ReturnType<ReturnType<typeof setup>["run"]>) => r.ports.log.evidence.filter((e) => e.kind === "assistant_text").map((e) => e.text);

    // Woken by a cell: the recap after the end is not kept.
    const quiet = setup(engine, turn);
    const r1 = quiet.run({ batch: [fromWorker()] });
    expect(await runOf(quiet, r1)).toBe("deferred_for_approval");
    expect(said(r1)).toEqual(["分身交付了，我去通知主人并等验收。"]);

    // The same turn in answer to the owner: what it says after the end is their answer.
    const chat = setup(engine, turn);
    const r2 = chat.run({ batch: ["验收前先说说现在到哪了"] });
    expect(await runOf(chat, r2)).toBe("deferred_for_approval");
    expect(said(r2)).toEqual(["分身交付了，我去通知主人并等验收。", "已通知主人，现在等待验收：改动在 feat/x。"]);

    // Woken by a cell and silent until the end: the closing words are all there is, and they are kept.
    const only = setup(engine, [{ actions: [endGate, { text: "已通知主人，等验收。" }] }]);
    const r3 = only.run({ batch: [fromWorker()] });
    expect(await runOf(only, r3)).toBe("deferred_for_approval");
    expect(said(r3)).toEqual(["已通知主人，等验收。"]);
  });

  // Live rerun round 7 (uc73): the desk asked its question, ended the run, and said the question again as its closing
  // words — both were on its record and both went to the owner's agent.
  it("does not record closing words that only repeat what the turn already said, also when a person is listening", async () => {
    const said = (r: ReturnType<ReturnType<typeof setup>["run"]>) => r.ports.log.evidence.filter((e) => e.kind === "assistant_text").map((e) => e.text);
    const asked = setup(engine, [{ actions: [{ text: "这份手册要针对 harness-a、harness-b，还是两者都包括？" }, endGate, { text: "这份手册要针对 harness-a、harness-b,还是两者都包括?" }] }]);
    const r1 = asked.run({ batch: ["先出方案：写一份权限上线手册"] });
    expect(await runOf(asked, r1)).toBe("deferred_for_approval");
    expect(said(r1)).toEqual(["这份手册要针对 harness-a、harness-b，还是两者都包括？"]);

    // New words after it are kept.
    const added = setup(engine, [{ actions: [{ text: "已交给分身。" }, endGate, { text: "大约十分钟有结果。" }] }]);
    const r2 = added.run({ batch: ["手册进展如何"] });
    expect(await runOf(added, r2)).toBe("deferred_for_approval");
    expect(said(r2)).toEqual(["已交给分身。", "大约十分钟有结果。"]);
  });

  // Live round 11 (uc02): woken by a worker's result, the project sent the owner a notice, ended, and said it again — in
  // every turn. What a tool reports as sent (ToolResult.sent) counts as said.
  it("what the turn sent counts as said: a recap of it is not recorded, unless a person is still waiting for an answer", async () => {
    const said = (r: ReturnType<ReturnType<typeof setup>["run"]>) => r.ports.log.evidence.filter((e) => e.kind === "assistant_text").map((e) => e.text);
    const result = () => createEnvelope({ id: "res_1", from: "inbox:w1", to: "inbox:cell_1", principalId: "cell:w1", kind: "result", type: "cell.result",
      payload: { childCellId: "w1", status: "completed", summary: "改好了", childState: "dormant" } });
    const send = (to: string) => ({ mcp: "send_message", args: { to, text: "修复已提交 MR !1，main 没有改动。", summary: "交付" } });
    const closing = { text: "修复已提交，等待验收和维护者合并。" };
    const outcome = async (actions: object[], batch: Array<string | Envelope>) => {
      const s = setup(engine, [{ actions: actions as never }]);
      const r = s.run({ batch });
      expect(await runOf(s, r)).toBe("deferred_for_approval");
      return said(r);
    };
    // Nobody is talking: whatever was sent, to the owner or to a cell, the closing words recap it.
    expect(await outcome([send("channel:ui:owner"), endGate, closing], [result()])).toEqual([]);
    expect(await outcome([send("inbox:w1"), endGate, closing], [result()])).toEqual([]);
    // A person spoke and was answered by the notice: the same.
    expect(await outcome([send("channel:ui:owner"), endGate, closing], ["现在到哪了"])).toEqual([]);
    // A person spoke and only a worker was written to: these words are their answer.
    expect(await outcome([send("inbox:w1"), endGate, closing], ["现在到哪了"])).toEqual([closing.text]);
  });

  // Audit 2026-11-26 B2: wait is a pure state registration (no RUN_ENDED_NOTICE, no 10s interrupt), and normal text
  // without endRun deduplicates exact repeats of send_message text.
  it("B2: wait registers state without RUN_ENDED_NOTICE or grace kill, and normal text deduplicates send_message echo", async () => {
    const s = setup(engine, [
      {
        actions: [
          { mcp: "send_message", args: { to: "channel:ui:owner", text: "一阶段已完成，请确认范围。", summary: "确认范围" } },
          { mcp: "wait", args: { reason: "等主人答复", waitingFor: "human" } },
          { sleep: 250 },
          { text: "一阶段已完成,请确认范围!" },
        ],
      },
    ], { endRunGraceMs: 80 });
    const r = s.run();
    expect(await runOf(s, r)).toBe("yielded_waiting");
    const mcpResults = s.fake.log().filter((e) => e.type === "mcp_result").map((e) => String(e["text"]));
    expect(mcpResults.some((t) => t.includes(RUN_ENDED_NOTICE))).toBe(false);
    const said = r.ports.log.evidence.filter((e) => e.kind === "assistant_text").map((e) => e.text);
    expect(said).toEqual([]);
  });

  // Audit 2026-11-26 A3: cold fresh rebuild omits [original task] when history already carries it or cell.task,
  // while keeping an updated [project goal] anchor.
  it("A3: cold fresh session deduplicates [original task] already in history while keeping updated [project goal]", async () => {
    const s = setup(engine, [{ actions: [{ text: "cold1" }] }, { actions: [{ text: "cold2" }] }]);
    const orig = "[original task] (as first given — later messages may have changed it) parent=desk build v1";
    const r1 = s.run({
      runId: "cold_1",
      history: [{ role: "user", content: [{ type: "text", text: `[summary]\n${orig}` }] }],
      tailNotes: [orig],
      batch: ["continue"],
    });
    r1.snapshot.tail.originalTask = orig;
    expect(await runOf(s, r1)).toBe("completed");
    expect(s.fake.prompts()[0]!.split(orig).length - 1).toBe(1);

    const updatedGoal = '[project goal] (current — updated since initial task) parent=desk title="v2" outcome="ship v2"';
    const r2 = s.run({
      runId: "cold_2",
      history: [{ role: "user", content: [{ type: "text", text: "[cell.task · from inbox:desk · principal owner · at 2026-11-26T00:00:00.000Z]\nbuild v1" }] }],
      tailNotes: [updatedGoal],
      batch: ["continue v2"],
    });
    r2.snapshot.tail.originalTask = updatedGoal;
    expect(await runOf(s, r2)).toBe("completed");
    expect(s.fake.prompts()[1]).toContain(updatedGoal);
  });

  // Audit 2026-11-23 E33: a kernel killed in the middle of a cell's first turn lost the CLI session (it was put on
  // record only when the Run ended), so the next Run primed a second session with the same task.
  it("puts a new session on record as soon as it has made progress, not only when the run ends", async () => {
    const hold = join(tempDir("first-turn"), "release");
    const s = setup(engine, [{ actions: [{ mcp: "set_state", args: { patches: { step: 1 } } }, { waitFile: hold }, { text: "done" }] }]);
    const r = s.run();
    const outcome = runOf(s, r);
    await waitFor(() => r.ports.log.evidence.some((e) => e.kind === "tool_result" && e.name === "set_state"), "first progress");
    await waitFor(() => r.ports.state.has(CLI_SESSION_KEY), "the session record while the run is still in flight");
    const mid = r.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord;
    expect(mid).toMatchObject({ engine, runs: 0 });
    writeFileSync(hold, "");
    expect(await outcome).toBe("completed");
    expect(r.ports.state.get(CLI_SESSION_KEY)).toMatchObject({ sessionId: mid.sessionId, runs: 1 });
  });

  // Audit 2026-11-23 E15: the first task was sent again at every wake-up of a session that already held it.
  it("leaves the original-task reminder out when it continues a session", async () => {
    const s = setup(engine, [{ actions: [{ text: "one" }] }, { actions: [{ text: "two" }] }, { actions: [{ text: "three" }] }]);
    const reminder = "[original task] (as first given — later messages may have changed it) parent=proj do five retries";
    const withTask = (opts: Partial<FakeRunOptions>) => {
      const r = s.run({ tailNotes: [reminder], ...opts });
      r.snapshot.tail.originalTask = reminder;
      return r;
    };
    const first = withTask({ runId: "run_1" });
    expect(await runOf(s, first)).toBe("completed");
    expect(s.fake.prompts()[0]).toContain(reminder);
    const second = withTask({ runId: "run_2", batch: ["make it three retries"] });
    second.ports.state.set(CLI_SESSION_KEY, first.ports.state.get(CLI_SESSION_KEY));
    expect(await runOf(s, second)).toBe("completed");
    expect(launches(s)[1]!.session?.mode).toBe("resume");
    expect(s.fake.prompts()[1]).toContain("make it three retries");
    expect(s.fake.prompts()[1]).not.toContain("[original task]");
    // A session that has to be built anew gets it back.
    const third = withTask({ runId: "run_3", batch: ["and add a test"] });
    expect(await runOf(s, third)).toBe("completed");
    expect(launches(s)[2]!.session).toBeUndefined();
    expect(s.fake.prompts()[2]).toContain(reminder);
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
    const note = history.map(e => e.record).find(e => e.kind === "system_note" && e.text.includes(steer));
    expect(note).toMatchObject({envelopeId:"steer_1"});

    const envelope = createEnvelope({id:"steer_1", from:"kernel:control", principalId:"owner", kind:"event", type:"control.steer", payload:{message:steer}});
    const next = s.run({runId:"next", batch:[envelope]});
    next.snapshot.historyUptoSeq = history.at(-1)!.seq;
    next.ports.listEvidence = filter => history.filter(e => e.seq > (filter?.afterSeq ?? 0));
    next.ports.state.set(CLI_SESSION_KEY, first.ports.state.get(CLI_SESSION_KEY));
    expect(await runOf(s, next)).toBe("completed");
    expect(launches(s).at(-1)?.session?.mode).toBe("resume");
    expect(s.fake.prompts().at(-1)?.split(steer)).toHaveLength(2);
  }, 15_000);

  it("confirms a waiting tool's input when stdout reports the new session after its MCP result", async () => {
    const s = setup("claude", [{actions:[
      {mcp:"request_approval", args:{kind:"escalation", title:"确认", summary:"确认", escalation:{reason:"blocked", explanation:"等确认"}}},
      {sleep:10_000},
    ]}], {endRunGraceMs:300});
    s.fake.env["FAKECLI_DELAY_INIT"] = "1";
    const r = s.run();
    await recordBatch(r);
    const confirmed = watchCursor(r);
    expect(await runOf(s,r)).toBe("deferred_for_approval");
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

  it("advances the delivered input cursor for an AGY refusal", async () => {
    const s = setup("agy", [{actions:[], refused:true}]);
    const run = s.run();
    await recordBatch(run);
    const cursor = watchCursor(run);
    expect(await runOf(s,run)).toBe("refused");
    expect(cursor).toEqual([1]);
  });

  it("surfaces a failing CLI as an error (the kernel retries the claim)", async () => {
    const s = setup("codex", [{ actions: [{ fail: "model overloaded" }] }]);
    const first = s.run();
    await expect(runOf(s, first)).rejects.toThrow(/model overloaded/);
    expect(first.ports.state.get(CLI_SESSION_KEY)).toBeFalsy();
  });

  it.each(["claude", "agy"] as const)("%s requeues an unconfirmed live steer and delivers it once on resume", async engine => {
    const hold = join(tempDir("cancelled-turn"), "release");
    const gateArgs = {kind:"escalation", title:"确认", summary:"waiting for input", escalation:{reason:"blocked", explanation:"waiting"}};
    const turns: FakeCliTurn[] = [{acknowledgeCancelDuringTool: true, actions:[{mcp:"request_approval",args:gateArgs}]}];
    if (engine === "agy") turns.push({actions: [{waitFile: hold}]});
    turns.push({actions: [{text: "continued"}]});
    const s = setup(engine, turns, {endRunGraceMs:100});
    const first = s.run();
    await recordBatch(first);
    const cursor = watchCursor(first);
    let releaseAuth!: () => void;
    const authBarrier = new Promise<void>(resolve => { releaseAuth = resolve; });
    const origAuthorize = first.ports.authorize.bind(first.ports);
    first.ports.authorize = async (action, opts) => {
      await authBarrier;
      return origAuthorize(action, opts);
    };
    const outcome = runOf(s,first);
    await waitFor(() => first.ports.log.evidence.some(e => e.kind === "tool_call" && e.name === "request_approval"), "request_approval tool entered");
    first.ports.pushSteer("review the red folder");
    await waitFor(() => first.ports.log.evidence.some(e => e.kind === "system_note" && e.envelopeId === "steer_1"), "steer written during tool");
    if (engine === "agy") await waitFor(() => s.fake.log().some(e => e.type === "waiting_file" && e.path === hold), "steer started its next turn");
    releaseAuth();
    expect(await outcome).toBe("deferred_for_approval");
    expect(first.ports.log.requeued.flatMap(r=>r.envelopeIds)).toEqual(["steer_1"]);
    expect(cursor.at(-1)).toBe(1);
    const history = first.ports.listEvidence!({});
    expect(history.map(e => e.record)).toContainEqual(expect.objectContaining({kind:"system_note", envelopeId:"steer_1"}));
    expect(history.some(e => e.record.kind === "assistant_text" && e.record.text === "continued")).toBe(false);
    const envelope = createEnvelope({id:"steer_1", from:"kernel:control", principalId:"owner", kind:"event", type:"control.steer", payload:{message:"review the red folder"}});
    const next = s.run({runId:"next",batch:[envelope]});
    next.snapshot.historyUptoSeq = history.at(-1)!.seq;
    next.ports.listEvidence = filter=>history.filter(e=>e.seq>(filter?.afterSeq ?? 0));
    next.ports.state.set(CLI_SESSION_KEY,{...first.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord,lastDeliveredEvidenceSeq:cursor.at(-1)});
    expect(await runOf(s,next)).toBe("completed");
    expect(launches(s).at(-1)?.session?.mode).toBe("resume");
    expect(s.fake.prompts().at(-1)?.match(/review the red folder/g)).toHaveLength(1);
  });

  // Audit 2026-11-26 B3: active runs reset the idle watchdog; progressed runs that stall idle return "timeout" continuation.
  it("B3: resets idle timeout on active tool progress, and returns 'timeout' continuation when stalling after progress", async () => {
    const active = setup("codex", [
      {
        actions: [
          { sleep: 250 },
          { mcp: "set_state", args: { patches: { a: 1 } } },
          { sleep: 250 },
          { mcp: "set_state", args: { patches: { b: 2 } } },
          { sleep: 250 },
          { text: "finished active work" },
        ],
      },
    ], { runTimeoutMs: 450 });
    const rActive = active.run();
    expect(await runOf(active, rActive)).toBe("completed");
    expect(rActive.ports.state.get("b")).toBe(2);

    const stalled = setup("codex", [
      {
        actions: [
          { mcp: "set_state", args: { patches: { step: 1 } } },
          { sleep: 5_000 },
        ],
      },
    ], { runTimeoutMs: 400 });
    const rStalled = stalled.run();
    rStalled.ports.pushSteer("initial correction already in prompt");
    await recordBatch(rStalled);
    const cursor = watchCursor(rStalled);
    expect(await runOf(stalled, rStalled)).toBe("timeout");
    expect(cursor.at(-1)).toBeGreaterThanOrEqual(1);
    expect(rStalled.ports.log.requeued).toEqual([]);
    expect(rStalled.ports.log.evidence.some((e) => e.kind === "system_note" && e.text.includes("(idle timeout); the kernel wakes you to continue"))).toBe(true);

    // B2 edge guard: when a person is waiting in chat and send_message only went to an internal inbox, keep the owner's first reply even if worded identically.
    const internalAndChat = setup("codex", [
      {
        actions: [
          { mcp: "send_message", args: { to: "inbox:w1", text: "已暂停构建", summary: "暂停" } },
          { text: "已暂停构建" },
        ],
      },
    ]);
    const rChat = internalAndChat.run({ batch: ["先暂停构建"] });
    expect(await runOf(internalAndChat, rChat)).toBe("completed");
    expect(rChat.ports.log.evidence.filter((e) => e.kind === "assistant_text").map((e) => e.text)).toEqual(["已暂停构建"]);
  });
});
