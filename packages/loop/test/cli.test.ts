import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, makeBounds, TOOL_KINDS, type Address, type CliEngine, type PolicyBounds, type Registry, type RunOutcome } from "@ng/protocol";
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
import { createFakeRun, installFakeCli, type FakeCli, type FakeCliTurn, type FakeRunOptions } from "../src/testing";
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

function setup(engine: CliEngine, turns: FakeCliTurn[], loopOpts: { endRunGraceMs?: number } = {}): Setup {
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
    endRunGraceMs: loopOpts.endRunGraceMs ?? 4_000,
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
    const r = s.run({ bounds: writerBounds(), spec: { processor: { kind: "llm", toolsets: TOOLSETS } } });
    // job_start arranged a wake-up, so a run that would complete yields instead (same as the API loop)
    expect(await runOf(s, r)).toBe("yielded_waiting");
    expect(r.ports.log.jobs.map((j) => j.command)).toEqual(["sleep 1"]);
    const launch = launches(s)[0]!;
    expect(launch.caps).toMatchObject({ readOnly: false, write: true, edit: true, bash: true });
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
    expect(tools).toEqual(expect.arrayContaining(["job_start", "job_observe", "code_rpc"]));
    expect(tools).not.toEqual(expect.arrayContaining(["write"]));
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
    const t0 = Date.now();
    expect(await runOf(s, r)).toBe("yielded_waiting");
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
    const t0 = Date.now();
    expect(await runOf(s, r)).toBe("deferred_for_approval");
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(5_000);
    expect(r.ports.log.authorizations[0]?.result.type).toBe("defer");
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
      spec: { processor: { kind: "llm", toolsets: TOOLSETS, allowedTools: ["read"] }, contextMode: "fork_prefix" },
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

describe("CLI loop errors", () => {
  it("surfaces a failing CLI as an error (the kernel retries the claim)", async () => {
    const s = setup("codex", [{ actions: [{ fail: "model overloaded" }] }]);
    await expect(runOf(s, s.run())).rejects.toThrow(/model overloaded/);
  });

  it("refuses container workspaces instead of running the CLI on the host", async () => {
    const s = setup("claude", []);
    const r = s.run({ bounds: makeBounds({ ...writerBounds(), tools: [...writerBounds().tools], isolation: "container" }) });
    await expect(runOf(s, r)).rejects.toThrow(/container/);
    expect(launches(s)).toHaveLength(0);
  });
});
