import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry, type CliEngine, type Registry, type RunOutcome } from "@ng/protocol";
import { cliAdapterFor, createCliAgentLoop, registerStandardToolsets, STANDARD_TOOLSETS, type CliEvent, type LaunchRequest } from "../src";
import { createFakeRun, installFakeCli, type FakeCliTurn } from "../src/testing";

// docs/05 §3.3 — the two ways extra input reaches a running CLI agent are different on purpose:
//   - a follow-up (an ordinary message absorbed into the Run) waits for the turn to end by itself and is then handed
//     over on the same session — nothing that is compiling or testing is ever killed for it;
//   - a steer (the owner or a parent says the work is off course) may cut the turn short.
// And §3.4 guard 1: a step limit or a refusal is never reported as "completed".

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `ngcli-fu-${prefix}-`)));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const TOOLSETS = [STANDARD_TOOLSETS.context, STANDARD_TOOLSETS.comms, STANDARD_TOOLSETS.schedule];
function registry(): Registry {
  const r = createRegistry();
  registerStandardToolsets(r);
  return r;
}

function setup(engine: CliEngine, turns: FakeCliTurn[], maxSteps?: number) {
  const fake = installFakeCli(tempDir(`${engine}-bin`), engine, turns);
  const root = tempDir(`${engine}-ws`);
  const loop = createCliAgentLoop({ engine, registry: registry(), bin: fake.bin, env: fake.env, pollMs: 30, killGraceMs: 500, endRunGraceMs: 4_000 });
  const run = createFakeRun({
    workspaceRoot: root,
    spec: { processor: { kind: "llm", toolsets: TOOLSETS, ...(maxSteps !== undefined ? { maxSteps } : {}) }, lifetime: "one_shot", parentId: "desk" },
    batch: ["do the first thing"],
  });
  return { fake, loop, run, go: (): Promise<RunOutcome> => loop.run(run.snapshot, run.ports, run.controller.signal) };
}

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const ENGINES: CliEngine[] = ["claude", "codex", "agy"];

describe.each(ENGINES)("follow-ups with a fake %s", (engine) => {
  it("a message that arrives mid-turn is delivered when the turn ends by itself — on the same session, without interrupting anything", async () => {
    const s = setup(engine, [
      { actions: [{ text: "working on the first thing" }, { sleep: 400 }, { text: "first thing done" }] },
      { actions: [{ text: "follow-up handled too" }] },
    ]);
    const done = s.go();
    await waitFor(() => s.fake.prompts().length === 1, "the first prompt");
    s.run.ports.pushInbound("also do the second thing");
    // Still mid-turn after several poll intervals: the follow-up has not been taken, nothing was signalled.
    await new Promise((r) => setTimeout(r, 150));
    expect(s.run.ports.log.drained).toHaveLength(0);
    expect(s.fake.prompts()).toHaveLength(1);

    expect(await done).toBe("completed");
    const log = s.fake.log();
    expect(log.filter((e) => e.type === "interrupt" || e.type === "cancel" || e.type === "sigterm")).toEqual([]);
    expect(s.run.ports.log.drained.map((e) => (e.payload as { text: string }).text)).toEqual(["also do the second thing"]);
    const prompts = s.fake.prompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("also do the second thing");
    // The first turn ran to its end before the second began.
    // (agy reports a turn's text in one piece, so compare positions rather than the exact split.)
    const said = s.run.ports.log.evidence.filter((e) => e.kind === "assistant_text").map((e) => (e as { text: string }).text).join("\n");
    expect(said.indexOf("working on the first thing")).toBeGreaterThanOrEqual(0);
    expect(said.indexOf("first thing done")).toBeGreaterThan(said.indexOf("working on the first thing"));
    expect(said.indexOf("follow-up handled too")).toBeGreaterThan(said.indexOf("first thing done"));
    // One session throughout: live input for claude/agy, a resume of the same thread for codex (which has none).
    const sessions = new Set(log.filter((e) => e.type === "prompt").map((e) => e["session"]));
    expect(sessions.size).toBe(1);
    expect(s.fake.launches()).toHaveLength(engine === "codex" ? 2 : 1);
    if (engine === "codex") expect(s.fake.launches()[1]).toContain("resume");
  });

  it("a steer is the urgent channel: codex and agy cut the turn short, claude queues it on its live input — and it always reaches the model", async () => {
    const s = setup(engine, [{ actions: [{ text: "heading the wrong way" }, { sleep: 1_500 }, { text: "end of the first turn" }] }, { actions: [{ text: "corrected" }] }]);
    const done = s.go();
    await waitFor(() => s.fake.prompts().length === 1, "the first prompt");
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    s.run.ports.pushSteer("stop: use the develop branch");
    expect(await done).toBe("completed");
    const took = Date.now() - t0;
    expect(s.fake.prompts()[1]).toContain("use the develop branch");
    const said = s.run.ports.log.evidence.filter((e) => e.kind === "assistant_text").map((e) => (e as { text: string }).text).join("\n");
    expect(said).toContain("corrected");
    if (engine === "claude") {
      // Claude Code takes a mid-turn user message on stdin and answers it after the current turn.
      expect(said).toContain("end of the first turn");
    } else {
      // No live input (codex) or cancel-then-prompt (agy): the turn in flight is abandoned for the correction.
      expect(said).not.toContain("end of the first turn");
      expect(took).toBeLessThan(1_400);
    }
  });

  it("the step limit ends the Run as step_limit, not completed", async () => {
    const s = setup(
      engine,
      [{ actions: [{ native: "Read", kind: "read", input: { file_path: "a" } }, { native: "Read", kind: "read", input: { file_path: "b" } }, { sleep: 3_000 }, { native: "Read", kind: "read", input: { file_path: "c" } }, { text: "all read" }] }],
      2,
    );
    expect(await s.go()).toBe("step_limit");
    expect(s.run.ports.log.evidence.some((e) => e.kind === "system_note" && (e as { text: string }).text.includes("step limit"))).toBe(true);
  });
});

describe("a refusal is reported as refused by the adapters", () => {
  const req = (engine: CliEngine): LaunchRequest => ({
    engine,
    bin: engine,
    cwd: "/tmp",
    caps: { root: "/tmp", isolation: "none", write: false, edit: false, bash: false, readOnly: true, web: true, access: "host" },
    model: undefined,
    system: "sys",
    systemFile: join(tempDir("sys"), "system.md"),
    prompt: "do it",
    mcp: { serverName: "ng", launch: { command: "node", args: [], env: {} } },
    tmpDir: tempDir("tmp"),
    extraArgs: [],
  });
  const io = { write: () => undefined, end: () => undefined };
  const turnEnds = (events: CliEvent[]) => events.filter((e): e is Extract<CliEvent, { type: "turn_end" }> => e.type === "turn_end");

  it("claude: an assistant message with stop_reason refusal makes the result a refused turn, not an error", () => {
    const d = cliAdapterFor("claude").createDriver(req("claude"));
    d.onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }), io);
    d.onLine(JSON.stringify({ type: "assistant", message: { id: "m1", stop_reason: "refusal", content: [{ type: "text", text: "I can't help with that." }], usage: {} } }), io);
    const out = d.onLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s1" }), io);
    expect(turnEnds(out)).toEqual([{ type: "turn_end", ok: false, refused: true }]);
    // The next turn starts clean.
    d.onLine(JSON.stringify({ type: "assistant", message: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: {} } }), io);
    expect(turnEnds(d.onLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s1" }), io))).toEqual([{ type: "turn_end", ok: true }]);
  });

  it("agy: a prompt result with stopReason refusal is a refused turn", () => {
    const d = cliAdapterFor("agy").createDriver(req("agy"));
    const sent: Array<{ id?: number; method?: string }> = [];
    const rec = { write: (line: string) => void sent.push(JSON.parse(line) as { id?: number; method?: string }), end: () => undefined };
    d.start(rec);
    const answer = (method: string, result: unknown) => d.onLine(JSON.stringify({ jsonrpc: "2.0", id: sent.find((m) => m.method === method)!.id, result }), rec);
    answer("initialize", { protocolVersion: 1 });
    answer("session/new", { sessionId: "sess-1" });
    const out = answer("session/prompt", { stopReason: "refusal" });
    expect(turnEnds(out)).toEqual([{ type: "turn_end", ok: false, refused: true }]);
  });
});
