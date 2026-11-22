import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvelope, createRegistry, ManualClock, PAYLOAD, steerNoteText, type CliEngine, type Registry, type RunOutcome } from "@ng/protocol";
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
    const release = join(tempDir("first-turn"), "release");
    const s = setup(engine, [
      { actions: [{ text: "working on the first thing" }, { waitFile: release }, { text: "first thing done" }] },
      { actions: [{ text: "follow-up handled too" }] },
    ]);
    const done = s.go();
    await waitFor(() => s.fake.prompts().length === 1, "the first prompt");
    s.run.ports.pushInbound("also do the second thing");
    // Still mid-turn after several poll intervals: the follow-up has not been taken, nothing was signalled.
    await waitFor(() => s.fake.log().some(e => e.type === "waiting_file"), "first turn is blocked");
    expect(s.run.ports.log.drained).toHaveLength(0);
    expect(s.fake.prompts()).toHaveLength(1);

    writeFileSync(release, "go");
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
    const release = join(tempDir("steer"), "release");
    const s = setup(engine, [{ actions: [{ text: "heading the wrong way" }, { waitFile: release }, { text: "end of the first turn" }] }, { actions: [{ text: "corrected" }] }]);
    const done = s.go();
    await waitFor(() => s.fake.prompts().length === 1, "the first prompt");
    await waitFor(() => s.fake.log().some(e => e.type === "waiting_file"), "first turn is blocked");
    s.run.ports.pushSteer("stop: use the develop branch");
    if (engine === "claude") {
      await waitFor(() => s.run.ports.log.evidence.some(e => e.kind === "system_note" && e.envelopeId === "steer_1"), "steer written");
      writeFileSync(release, "go");
    }
    expect(await done).toBe("completed");
    expect(s.fake.prompts()[1]).toContain("use the develop branch");
    const said = s.run.ports.log.evidence.filter((e) => e.kind === "assistant_text").map((e) => (e as { text: string }).text).join("\n");
    const notes = s.run.ports.log.evidence.filter(e => e.kind === "system_note" && e.text.includes("use the develop branch"));
    expect(notes).toHaveLength(1);
    const correction = s.run.ports.log.evidence.findIndex(e => e.kind === "assistant_text" && e.text.includes("corrected"));
    expect(correction).toBeGreaterThan(s.run.ports.log.evidence.indexOf(notes[0]!));
    if (engine === "claude") {
      // Claude Code takes a mid-turn user message on stdin and answers it after the current turn.
      expect(said).toContain("end of the first turn");
    } else {
      // No live input (codex) or cancel-then-prompt (agy): the turn in flight is abandoned for the correction.
      expect(said).not.toContain("end of the first turn");
      expect(s.fake.log().some(e => engine === "agy" ? e.type === "cancel" : e.type === "sigterm")).toBe(true);
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
    caps: { root: "/tmp", write: false, edit: false, bash: false, readOnly: true, web: true },
    model: undefined,
    system: "sys",
    systemFile: join(tempDir("sys"), "system.md"),
    prompt: "do it",
    mcp: { serverName: "ng", launch: { command: "node", args: [], env: {} } },
    tmpDir: tempDir("tmp"),
    extraArgs: [],
  });
  const io = { write: () => true, end: () => undefined };
  const turnEnds = (events: CliEvent[]) => events.filter((e): e is Extract<CliEvent, { type: "turn_end" }> => e.type === "turn_end");

  it("claude: an assistant message with stop_reason refusal makes the result a refused turn, not an error", () => {
    const d = cliAdapterFor("claude").createDriver(req("claude"));
    d.onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }), io);
    d.onLine(JSON.stringify({ type: "assistant", message: { id: "m1", stop_reason: "refusal", content: [{ type: "text", text: "I can't help with that." }] } }), io);
    const out = d.onLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s1" }), io);
    expect(turnEnds(out)).toEqual([{ type: "turn_end", ok: false, refused: true }]);
    // The next turn starts clean.
    d.onLine(JSON.stringify({ type: "assistant", message: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } }), io);
    expect(turnEnds(d.onLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s1" }), io))).toEqual([{ type: "turn_end", ok: true }]);
  });

  it("agy holds a correction received during model selection until the original prompt has run", () => {
    const d = cliAdapterFor("agy").createDriver({...req("agy"), model:"chosen"});
    const frames: Array<{id:number; method:string; params:{prompt?: Array<{text:string}>}}> = [];
    const io = {write(line:string) { frames.push(JSON.parse(line)); return true; }, end() {}};
    const answer = (method:string, result:unknown) => d.onLine(JSON.stringify({id:frames.find(f=>f.method===method)!.id,result}), io);
    const prompts = () => frames.filter(f=>f.method==="session/prompt").map(f=>f.params.prompt![0]!.text);
    d.start(io);
    answer("initialize", {protocolVersion:1});
    answer("session/new", {sessionId:"s1"});
    expect(d.steer("use the other branch", io)).toBe(true);
    expect(prompts()).toEqual([]);
    answer("session/set_model", {});
    expect(prompts()).toEqual(["do it"]);
    answer("session/prompt", {stopReason:"end_turn"});
    expect(prompts()).toEqual(["do it","use the other branch"]);
  });

  it.each([
    { response: {error:{message:"process failed"}}, event: {ok:false, more:false, error:"process failed"} },
    { response: {result:{stopReason:"refusal"}}, event: {ok:false, more:false, refused:true} },
    { response: {result:{stopReason:"cancelled"}}, event: {ok:true, more:true, stopped:true} },
  ])("AGY starts the queued correction only after an acknowledged stop: $event", ({response, event}) => {
    const driver = cliAdapterFor("agy").createDriver(req("agy"));
    const sent: Array<{ id?: number; method?: string }> = [];
    const rec = { write: (line: string) => (sent.push(JSON.parse(line)), true), end() {} };
    const answer = (method: string, body: object) =>
      driver.onLine(JSON.stringify({ id: sent.find(m => m.method === method)!.id, ...body }), rec);
    const prompts = () => sent.filter(m => m.method === "session/prompt");
    driver.start(rec);
    answer("initialize", {result:{protocolVersion:1}});
    answer("session/new", {result:{sessionId:"one"}});
    expect(driver.steer("correct the current task", rec)).toBe(true);
    const result = answer("session/prompt", response);
    expect(turnEnds(result)).toEqual([{type:"turn_end", ...event}]);
    expect(prompts()).toHaveLength(event.more ? 2 : 1);
  });
});

describe("BUG-026: CLI steer & follow-up anti-loss and fresh rebuild anti-duplication", () => {
  it("resumes with the exact steer when Claude exits before starting its queued turn", async () => {
    const s = setup("claude", [
      { actions: [{ awaitQueuedInput: true }], exitAfterTurn: true },
      { actions: [{ text: "correction processed" }] },
    ]);
    const done = s.go();
    await waitFor(() => s.fake.prompts().length === 1, "the first turn");
    const correction = "use the validated revision";
    s.run.ports.pushSteer(correction);
    expect(await done).toBe("completed");
    expect(s.fake.launches()).toHaveLength(2);
    expect(s.fake.launches()[1]).toContain("--resume");
    expect(s.fake.prompts()).toEqual([expect.stringContaining("do the first thing"), steerNoteText(correction)]);
    expect(s.run.ports.log.evidence.filter(e => e.kind === "system_note" && e.text === steerNoteText(correction))).toHaveLength(1);
    expect(s.run.ports.log.requeued).toEqual([]);
  });

  it.each([true, false])("failed resume rebuilds both absorbed follow-ups exactly once (prior text: %s)", async priorText => {
    const clock = new ManualClock(1_000);
    const release = join(tempDir("codex-rebuild-gate"),"release");
    const fake = installFakeCli(tempDir("codex-rebuild-bin"), "codex", [
      // Turn 1: fresh session works, produces session id.
      { actions: [...(priorText ? [{ text: "step 1 done" }] : []), { waitFile: release }] },
      // Turn 2 (after we wipe the session store, resume fails with unknown session → fresh rebuild runs Turn 2!):
      { actions: [{ text: "rebuilt and handled all" }] },
    ]);
    const root = tempDir("codex-rebuild-ws");
    const loop = createCliAgentLoop({ engine: "codex", registry: registry(), bin: fake.bin, env: fake.env, pollMs: 25, killGraceMs: 500, endRunGraceMs: 4_000 });
    const env1 = createEnvelope({ id: "env_orig_1", from: "inbox:desk", principalId: "owner", kind: "event", type: PAYLOAD.userMessage, payload: { text: "first task" } }, clock);
    const run = createFakeRun({
      workspaceRoot: root,
      spec: { processor: { kind: "llm", toolsets: TOOLSETS }, lifetime: "one_shot", parentId: "desk" },
      batch: [env1],
      roster: [{ cellId:"child-proof", title:"查阅记录", preset:"worker", status:"active", epoch:0, lastRunAt:null, statusLine:null }],
      tailNotes: ["Current board entry: release pending"],
    });
    // Mirror what real dispatcher.ts does before loop.run(): record initial batch inbound in SQLite evidence!
    await run.ports.context.appendEvidence(run.snapshot.cellId, { runId: run.snapshot.runId, at: clock.now(), kind: "inbound", envelope: env1 });
    const origDrain = run.ports.drainInbound!.bind(run.ports);
    run.ports.drainInbound = () => {
      const envs = origDrain();
      if (envs.length > 0) {
        // Turn 1 has finished cleanly; delete only the saved session file now so Leg 2's `codex exec resume` fails!
        const storeDir = join(fake.dir, "codex-store");
        for (const f of readdirSync(storeDir)) if (f !== "turn") rmSync(join(storeDir, f), { recursive: true, force: true });
      }
      return envs;
    };
    const done = loop.run(run.snapshot, run.ports, run.controller.signal);
    await waitFor(() => fake.prompts().length === 1, "first prompt");
    // Push TWO distinct envelopes with the EXACT SAME text mid-run!
    const dupA = createEnvelope({ id: "env_dup_a", from: "inbox:desk", principalId: "owner", kind: "event", type: PAYLOAD.userMessage, payload: { text: "same ping text" } }, clock);
    const dupB = createEnvelope({ id: "env_dup_b", from: "inbox:desk", principalId: "owner", kind: "event", type: PAYLOAD.userMessage, payload: { text: "same ping text" } }, clock);
    run.ports.pushInbound(dupA);
    run.ports.pushInbound(dupB);
    writeFileSync(release,"go");
    expect(await done).toBe("completed");
    // Launch 1 = initial fresh, Launch 2 = failed resume, Launch 3 = fresh rebuild!
    expect(fake.launches()).toHaveLength(3);
    expect(fake.launches()[1]).toContain("resume");
    expect(fake.launches()[2]).not.toContain("resume");
    const rebuilt = fake.prompts().at(-1)!;
    // env1 appears once in prior conversation (not duplicated), and BOTH identical-text envelopes appear!
    expect(rebuilt.match(/Current board entry: release pending/g)).toHaveLength(1);
    expect(rebuilt.match(/child-proof/g)).toHaveLength(1);
    expect(rebuilt.match(/first task/g)?.length).toBe(1);
    expect(rebuilt.match(/same ping text/g)?.length).toBe(2);
  });

  it("lets Claude finish a long queued turn when the previous result omitted the queue count", async () => {
    const s = setup("claude", [
      { actions: [{awaitQueuedInput:true}], omitQueuedTurnCount:true },
      { actions: [{sleep:5_400},{text:"second turn complete"}] },
    ]);
    const done = s.go();
    await waitFor(() => s.fake.prompts().length === 1, "the first prompt");
    s.run.ports.pushSteer("review the correction");
    expect(await done).toBe("completed");
    expect(s.run.ports.log.evidence.some(e => e.kind === "assistant_text" && e.text === "second turn complete")).toBe(true);
    expect(s.fake.launches()).toHaveLength(1);
  }, 15_000);

  it("does not acknowledge a cancelled AGY correction when a later correction succeeds", async () => {
    const waiting = join(tempDir("agy-cancel"), "until-cancelled");
    const s = setup("agy", [
      { actions: [{waitFile: waiting}] },
      { actions: [{waitFile: waiting}, { text: "first correction completed" }] },
      { actions: [{ text: "second correction completed" }] },
      { actions: [{ text: "retried first correction" }] },
    ]);
    const done = s.go();
    await waitFor(() => s.fake.prompts().length === 1, "the initial prompt");
    s.run.ports.pushSteer("handle alpha");
    await waitFor(() => s.fake.prompts().length === 2, "the first correction");
    s.run.ports.pushSteer("handle beta");
    expect(await done).toBe("completed");
    const prompts = s.fake.prompts();
    expect(prompts.filter(p => p.includes("handle alpha"))).toHaveLength(2);
    expect(prompts.filter(p => p.includes("handle beta"))).toHaveLength(1);
  });

  it("Review fix (agy): multiple follow-ups arriving in one turn are joined into a single steer prompt without self-cancellation", async () => {
    const release = join(tempDir("agy-batch"), "release");
    const s = setup("agy", [
      { actions: [{ text: "turn 1" }, { waitFile: release }] },
      { actions: [{ text: "handled both follow-ups" }] },
    ]);
    const done = s.go();
    await waitFor(() => s.fake.prompts().length === 1, "first prompt");
    s.run.ports.pushInbound("follow-up alpha");
    s.run.ports.pushInbound("follow-up beta");
    writeFileSync(release,"go");
    expect(await done).toBe("completed");
    expect(s.fake.log().filter((e) => e.type === "cancel")).toEqual([]);
    const prompts = s.fake.prompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("follow-up alpha");
    expect(prompts[1]).toContain("follow-up beta");
  });
});
