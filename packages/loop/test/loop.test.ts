import type { ModelRequest } from "../src/testing";
import { describe, expect, it } from "vitest";
import {
  makeBounds,
  steerNoteText,
  textMessage,
  type ToolResultBlock,
} from "@ng/protocol";
import { call, createFakeRun, createScriptedLoop, TRUNCATED_CALL_OUTPUT, say, ScriptedModelClient } from "../src/testing";
import { clock, makeRegistry } from "./helpers";

const llm = (toolsets: string[], extra: Record<string, unknown> = {}) => ({ processor: { kind: "llm" as const, toolsets, ...extra } });

function toolResultsOf(req: ModelRequest): ToolResultBlock[] {
  const last = req.messages[req.messages.length - 1]!;
  return last.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
}

describe("llm run", () => {
  it("runs a multi-step tool loop and records every step as evidence", async () => {
    const model = new ScriptedModelClient([
      call("set_state", { patches: { "plan:step": 1 } }),
      call("read_state", { key: "plan:step" }),
      say("All set."),
    ]);
    const c = clock();
    const loop = createScriptedLoop({ model, registry: makeRegistry(), clock: c });
    const { ports, snapshot, controller } = createFakeRun({ clock: c, spec: llm(["kernel.context"]), batch: ["记一下：第一步完成"] });

    const outcome = await loop.run(snapshot, ports, controller.signal);

    expect(outcome).toBe("completed");
    expect(model.calls).toHaveLength(3);
    expect(ports.state.get("plan:step")).toBe(1);
    expect(toolResultsOf(model.calls[2]!)[0]!.content).toBe("plan:step = 1");
    expect(ports.log.evidence.map((e) => e.kind)).toEqual(["tool_call", "tool_result", "tool_call", "tool_result", "assistant_text"]);
    // the request keeps the frozen system prompt and the batch as the first user message
    expect(model.calls[0]!.system).toBe("You are a test cell.");
    expect(model.calls[0]!.messages[0]!.role).toBe("user");
    expect(model.calls[0]!.metadata).toEqual({ cellId: "cell1", runId: "run_1" });
  });

  it("leaves late steer and inbound messages pending after the last model step", async () => {
    const { ports, snapshot, controller } = createFakeRun({ spec: llm([], { maxSteps: 1 }), batch: ["first"] });
    const model = new ScriptedModelClient([() => {
      ports.pushSteer("correction");
      ports.pushInbound("follow-up");
      return say("first is done");
    }]);
    expect(await createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal)).toBe("completed");
    expect(ports.log.drained).toHaveLength(0);
    expect(ports.drainSteer()).toMatchObject([{ message: "correction" }]);
    expect(ports.drainInbound!()).toHaveLength(1);
  });

  it("filters tools by allowedTools ∩ bounds and by availability, identically on every run", async () => {
    const registry = makeRegistry();
    const model = new ScriptedModelClient([say("ok"), say("ok")]);
    const loop = createScriptedLoop({ model, registry });
    const toolsets = ["workspace", "kernel.cells", "kernel.comms", "kernel.context", "probe"];
    const bounds = makeBounds({ tools: ["read", "bash"], canSendTo: ["inbox:desk"], maxDepth: 0 });
    for (let i = 0; i < 2; i++) {
      const { ports, snapshot, controller } = createFakeRun({ bounds, parentId: null, spec: llm(toolsets, { allowedTools: ["read"] }), batch: ["hi"] });
      await loop.run(snapshot, ports, controller.signal);
    }
    const names = model.calls[0]!.tools.map((t) => t.name);
    expect(names).toContain("peek");
    // complete_self / pause_self need a parent too (and a persistent cell)
    for (const hidden of ["bash", "write", "edit", "job_start", "shell", "spawn_cell", "inspect_cell", "close_cell", "control_cell", "report_to_parent", "handback", "complete_self", "pause_self"]) {
      expect(names).not.toContain(hidden);
    }
    expect(names).toContain("request_approval");
    expect(names).toContain("wait");
    // docs/05: send_message also reaches other cells (inbox:<id>), so it is offered without a channel grant; a cell may
    // always change its own watches/schedules, so update_cell is offered without spawn depth
    expect(names).toContain("send_message");
    expect(names).toContain("update_cell");
    expect(model.calls[1]!.tools).toEqual(model.calls[0]!.tools);

    // a child with depth left and a channel grant sees spawn, inspect, send and the mutating workspace tools (here with
    const model2 = new ScriptedModelClient([say("ok")]);
    const run2 = createFakeRun({ spec: llm(toolsets), batch: ["hi"] });
    await createScriptedLoop({ model: model2, registry }).run(run2.snapshot, run2.ports, run2.controller.signal);
    const names2 = model2.calls[0]!.tools.map((t) => t.name);
    for (const shown of ["job_start", "spawn_cell", "inspect_cell", "send_message", "report_to_parent", "handback", "shell", "complete_self", "pause_self"]) {
      expect(names2).toContain(shown);
    }

    // a leaf child (one-shot or wakeable) reports a result instead of closing itself
    for (const lifetime of ["one_shot", "wakeable"] as const) {
      const model4 = new ScriptedModelClient([say("ok")]);
      const run4 = createFakeRun({ spec: { ...llm(toolsets), lifetime }, batch: ["hi"] });
      await createScriptedLoop({ model: model4, registry }).run(run4.snapshot, run4.ports, run4.controller.signal);
      const names4 = model4.calls[0]!.tools.map((t) => t.name);
      expect(names4).toContain("report_to_parent");
      expect(names4).not.toContain("complete_self");
      expect(names4).not.toContain("pause_self");
    }
  });

  it("refuses a channel send from a cell without any channel grant (send_message is offered for inbox messages)", async () => {
    const model = new ScriptedModelClient([
      call("send_message", { to: "channel:ui:owner", text: "进展", summary: "progress" }),
      (req) => {
        expect(toolResultsOf(req)[0]).toMatchObject({
          isError: true,
          content: "This cell cannot notify the owner. Send to your parent or to the desk.",
        });
        return say("ok");
      },
    ]);
    const bounds = makeBounds({ tools: ["read"], canSendTo: ["inbox:desk"], maxDepth: 0 });
    const { ports, snapshot, controller } = createFakeRun({ bounds, spec: llm(["kernel.comms"]), batch: ["告诉主人进展"] });
    expect(await createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal)).toBe("completed");
    expect(model.calls).toHaveLength(2);
    expect(ports.log.authorizations).toHaveLength(0);
    expect(ports.log.notifications).toHaveLength(0);
    expect(ports.artifacts.size).toBe(0);
  });

  it("takes the parent from RunSelf when the stored spec omits it", async () => {
    const model = new ScriptedModelClient([say("ok")]);
    const run = createFakeRun({ spec: llm(["kernel.comms"]), batch: ["hi"] });
    const { parentId: _drop, ...specWithoutParent } = run.snapshot.spec;
    await createScriptedLoop({ model, registry: makeRegistry() }).run({ ...run.snapshot, spec: specWithoutParent }, run.ports, run.controller.signal);
    expect(model.calls[0]!.tools.map((t) => t.name)).toContain("report_to_parent");
  });

  it("ends the run deferred_for_approval after the step that hit a defer (the rest of the step still runs)", async () => {
    const model = new ScriptedModelClient([
      {
        toolCalls: [
          { name: "request_approval", input: { kind: "action", action: { name: "merge" }, title: "合并修改", summary: "确认合并" } },
          { name: "echo", input: { text: "after" } },
        ],
      },
      say("should never be asked"),
    ]);
    const { ports, snapshot, controller } = createFakeRun({ spec: llm(["kernel.comms", "probe"]), batch: ["张三问方案什么时候好"] });
    const outcome = await createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal);

    expect(outcome).toBe("deferred_for_approval");
    expect(model.calls).toHaveLength(1);
    expect(ports.log.notifications).toHaveLength(0);
    const results = ports.log.evidence.filter((e) => e.kind === "tool_result");
    expect(results.map((r) => r.kind === "tool_result" && r.name)).toEqual(["request_approval", "echo"]);
  });

  it("an abort during the model call or a tool returns cancelled promptly", async () => {
    const registry = makeRegistry();
    const slow = new ScriptedModelClient([{ text: "late", delayMs: 10_000 }]);
    const a = createFakeRun({ spec: llm([]), batch: ["hi"] });
    const p = createScriptedLoop({ model: slow, registry }).run(a.snapshot, a.ports, a.controller.signal);
    setTimeout(() => a.controller.abort(), 10);
    expect(await p).toBe("cancelled");
    expect(a.ports.log.evidence).toHaveLength(0);

    const hanging = new ScriptedModelClient([call("hang"), say("never")]);
    const b = createFakeRun({ spec: llm(["probe"]), batch: ["hi"] });
    const q = createScriptedLoop({ model: hanging, registry }).run(b.snapshot, b.ports, b.controller.signal);
    setTimeout(() => b.controller.abort(), 10);
    expect(await q).toBe("cancelled");
    expect(hanging.calls).toHaveLength(1);

    const pre = createFakeRun({ spec: llm([]), batch: ["hi"] });
    pre.controller.abort();
    expect(await createScriptedLoop({ model: slow, registry }).run(pre.snapshot, pre.ports, pre.controller.signal)).toBe("cancelled");
  });

  it("injects steer messages between steps as user text and system_note evidence", async () => {
    const model = new ScriptedModelClient([
      call("steer_me", { message: "改成周四" }),
      (req) => {
        const last = req.messages[req.messages.length - 1]!;
        expect(last.content.map((b) => b.type)).toEqual(["tool_result", "text"]);
        expect(last.content[1]).toEqual({ type: "text", text: steerNoteText("改成周四") });
        return say("好的，改成周四。");
      },
    ]);
    const { ports, snapshot, controller } = createFakeRun({ spec: llm(["probe"]), batch: ["约周五开会"], steer: ["先别发邀请"] });
    const outcome = await createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal);

    expect(outcome).toBe("completed");
    // the steer that was already queued at run start rides along with the first request
    const first = model.calls[0]!.messages[0]!;
    expect(first.content.at(-1)).toEqual({ type: "text", text: steerNoteText("先别发邀请") });
    expect(ports.log.evidence.filter((e) => e.kind === "system_note").map((e) => e.kind === "system_note" && e.text)).toEqual([
      steerNoteText("先别发邀请"),
      steerNoteText("改成周四"),
    ]);
  });

  it("answers a steer that arrived while the model was finishing instead of ending", async () => {
    let ports!: ReturnType<typeof createFakeRun>["ports"];
    const model = new ScriptedModelClient([
      () => {
        ports.pushSteer("再加一句谢谢");
        return say("草稿好了。");
      },
      (req) => {
        expect(req.messages.at(-1)!.content).toEqual([{ type: "text", text: steerNoteText("再加一句谢谢") }]);
        return say("已加上谢谢。");
      },
    ]);
    const run = createFakeRun({ spec: llm([]), batch: ["写个回复"] });
    ports = run.ports;
    expect(await createScriptedLoop({ model, registry: makeRegistry() }).run(run.snapshot, run.ports, run.controller.signal)).toBe("completed");
    expect(model.calls).toHaveLength(2);
  });

  it("stops at maxSteps with step_limit (work is left: never reported as completed)", async () => {
    const model = new ScriptedModelClient(() => call("echo", { text: "again" }));
    const { ports, snapshot, controller } = createFakeRun({ spec: llm(["probe"], { maxSteps: 3 }), batch: ["loop forever"] });
    const outcome = await createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal);
    expect(outcome).toBe("step_limit");
    expect(model.calls).toHaveLength(3);
    expect(ports.log.evidence.at(-1)).toMatchObject({
      kind: "system_note",
      text: "[run stopped after 3 model calls (step limit); the kernel wakes you to continue]",
    });
    // every call that was made was executed (the cap is checked before a model call, never mid-step)
    expect(ports.log.evidence.filter((e) => e.kind === "tool_result")).toHaveLength(3);
  });

  it("ends refused when the model refuses, leaving the calls of that turn unexecuted", async () => {
    const model = new ScriptedModelClient([
      call("echo", { text: "before" }),
      { toolCalls: [{ name: "echo", input: { text: "declined" } }], stopReason: "refusal" },
      say("never asked"),
    ]);
    const { ports, snapshot, controller } = createFakeRun({ spec: llm(["probe"]), batch: ["do something questionable"] });
    expect(await createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal)).toBe("refused");
    expect(model.calls).toHaveLength(2);
    const results = ports.log.evidence.filter((e) => e.kind === "tool_result");
    expect(results.map((r) => r.kind === "tool_result" && [r.output, r.isError ?? false])).toEqual([
      ["echo: before", false],
      ["Not executed: the model declined this turn.", true],
    ]);
  });

  it("turns tool exceptions, unknown tools and invalid input into error results", async () => {
    const model = new ScriptedModelClient([
      {
        toolCalls: [
          { name: "boom", input: {} },
          { name: "nope", input: {} },
          { name: "echo", input: { text: 42 } },
        ],
      },
      (req) => {
        const [boom, nope, bad] = toolResultsOf(req);
        expect(boom).toMatchObject({ isError: true, content: "Error: kaboom" });
        expect(nope!.content).toContain('Unknown tool "nope"');
        expect(bad!.isError).toBe(true);
        expect(bad!.content).toContain("Invalid input for echo");
        return say("noted");
      },
    ]);
    const { ports, snapshot, controller } = createFakeRun({ spec: llm(["probe"]), batch: ["try"] });
    expect(await createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal)).toBe("completed");
  });

  it("feeds the model Context's spilled modelText, so the next hydrate reproduces it", async () => {
    const model = new ScriptedModelClient([
      call("big"),
      (req) => {
        const r = toolResultsOf(req)[0]!;
        expect(r.content.length).toBeLessThan(5000);
        expect(r.content).toContain('read_resource("res://cell1/');
        return say("ok");
      },
    ]);
    const { ports, snapshot, controller } = createFakeRun({ spec: llm(["probe"]), batch: ["dump"], inlineLimit: 1000 });
    await createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal);
    const ev = ports.log.evidence.find((e) => e.kind === "tool_result");
    expect(ev && ev.kind === "tool_result" && ev.output.length).toBe(10_000);
  });

  it("ends yielded_waiting after wait (without forcing endRun), and after starting a job even if the model then finishes", async () => {
    const registry = makeRegistry();
    const w = createFakeRun({ spec: llm(["kernel.comms"]), batch: ["ask desk"] });
    const waiting = new ScriptedModelClient([call("wait", { reason: "等 desk 答复", waitingFor: "inbox:desk" }), say("Waiting for desk.")]);
    expect(await createScriptedLoop({ model: waiting, registry }).run(w.snapshot, w.ports, w.controller.signal)).toBe("yielded_waiting");
    expect(waiting.calls).toHaveLength(2);

    // job_start (a bash-kind tool) is offered to any cell whose bounds allow bash
    const j = createFakeRun({ spec: llm(["workspace"]), batch: ["run the tests"] });
    const jobs = new ScriptedModelClient([call("job_start", { command: "pnpm test" }), say("Tests are running; I'll report when done.")]);
    expect(await createScriptedLoop({ model: jobs, registry }).run(j.snapshot, j.ports, j.controller.signal)).toBe("yielded_waiting");
    expect(j.ports.log.jobs[0]!.command).toBe("pnpm test");

    // spawn_cell arranges a wake-up the same way (the child reports back): a run that then ends is waiting, not done
    const s = createFakeRun({ spec: llm(["kernel.cells"]), batch: ["delegate it"] });
    const spawns = new ScriptedModelClient([call("spawn_cell", { preset: "worker", title: "do it", instruction: "do it and report" }), say("Delegated.")]);
    expect(await createScriptedLoop({ model: spawns, registry }).run(s.snapshot, s.ports, s.controller.signal)).toBe("yielded_waiting");
    expect(s.ports.log.spawned).toHaveLength(1);
  });

  it("takes messages that arrive mid-run into the same run (drainInbound) before it may end", async () => {
    let ports!: ReturnType<typeof createFakeRun>["ports"];
    const model = new ScriptedModelClient([
      () => {
        ports.pushInbound("顺便把标题也改了");
        return call("echo", { text: "draft" });
      },
      (req) => {
        // absorbed after the step's tool results, rendered exactly as the kernel's hydrate would show it
        expect(req.messages.at(-1)!.content.map((b) => b.type)).toEqual(["tool_result", "text"]);
        expect(req.messages.at(-1)!.content[1]).toEqual({ type: "text", text: "[user.message from channel:ui:owner] 顺便把标题也改了" });
        return say("改好了。");
      },
    ]);
    // a follow-up that arrives while the model answers without tools: the run continues instead of ending
    const model2 = new ScriptedModelClient([
      () => {
        ports.pushInbound("还有作者名");
        return say("草稿好了。");
      },
      (req) => {
        expect(req.messages.at(-1)!.content).toEqual([{ type: "text", text: "[user.message from channel:ui:owner] 还有作者名" }]);
        return say("作者名也改了。");
      },
    ]);
    const run = createFakeRun({ spec: llm(["probe"]), batch: ["写个草稿"] });
    ports = run.ports;
    expect(await createScriptedLoop({ model, registry: makeRegistry() }).run(run.snapshot, run.ports, run.controller.signal)).toBe("completed");
    expect(model.calls).toHaveLength(2);
    expect(run.ports.log.drained.map((e) => (e.payload as { text: string }).text)).toEqual(["顺便把标题也改了"]);
    // the absorbed message joined the claimed batch (the tools and handback see it)
    expect(run.snapshot.batch.envelopes.map((e) => (e.payload as { text: string }).text)).toEqual(["写个草稿", "顺便把标题也改了"]);

    const run2 = createFakeRun({ spec: llm([]), batch: ["写个草稿"] });
    ports = run2.ports;
    expect(await createScriptedLoop({ model: model2, registry: makeRegistry() }).run(run2.snapshot, run2.ports, run2.controller.signal)).toBe("completed");
    expect(model2.calls).toHaveLength(2);
  });

  it("does not execute a tool call cut off by the output limit", async () => {
    const model = new ScriptedModelClient([
      { toolCalls: [{ name: "echo", input: { text: "a" } }, { name: "echo", input: { text: "partial" } }], stopReason: "max_tokens" },
      (req) => {
        const [first, cut] = toolResultsOf(req);
        expect(first!.content).toBe("echo: a");
        expect(cut).toMatchObject({ isError: true, content: TRUNCATED_CALL_OUTPUT });
        return say("ok");
      },
    ]);
    const { ports, snapshot, controller } = createFakeRun({ spec: llm(["probe"]), batch: ["go"] });
    expect(await createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal)).toBe("completed");
  });

  it("marks the end of the snapshot history for prompt caching, even when the tail merges into it", async () => {
    const history = [textMessage("user", "earlier question"), textMessage("assistant", "earlier answer"), textMessage("user", "a late note")];
    const model = new ScriptedModelClient([say("ok")]);
    const { ports, snapshot, controller } = createFakeRun({ spec: llm([]), history, batch: ["new question"] });
    await createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal);
    const req = model.calls[0]!;
    expect(req.messages).toHaveLength(3);
    expect(req.cacheHints?.stablePrefixEnd).toEqual({ message: 2, block: 0 });
    expect(req.messages[2]!.content.map((b) => b.type === "text" && b.text)).toEqual(["a late note", "[user.message from channel:ui:owner] new question"]);
  });

  it("rethrows model errors for the kernel to release the claim", async () => {
    const model = new ScriptedModelClient([{ error: new Error("529 overloaded") }]);
    const { ports, snapshot, controller } = createFakeRun({ spec: llm([]), batch: ["hi"] });
    await expect(createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal)).rejects.toThrow("529 overloaded");
  });

  it("uses the processor's tier and the configured output cap", async () => {
    const model = new ScriptedModelClient([say("ok")], { models: { fast: "m-fast", strong: "m-strong" } });
    const { ports, snapshot, controller } = createFakeRun({ spec: llm([], { modelTier: "fast" }), batch: ["hi"] });
    await createScriptedLoop({ model, registry: makeRegistry() }).run(snapshot, ports, controller.signal);
    expect(model.calls[0]!.tier).toBe("fast");
    expect(ports.log.evidence[0]).toMatchObject({ kind: "assistant_text", text: "ok", model: "m-fast" });
  });
});
