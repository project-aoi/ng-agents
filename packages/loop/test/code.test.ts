import { describe, expect, it } from "vitest";
import { gtdKeys, isNgError, PAYLOAD, type CodeProcessor, type SourceRecord } from "@ng/protocol";
import { createAgentLoop, scriptCommand } from "../src";
import { createFakeRun, ScriptedModelClient } from "../src/testing";
import { clock, makeRegistry } from "./helpers";

const source = (mode: SourceRecord["mode"]): SourceRecord => ({
  title: "支付成功率巡检",
  kind: "cron",
  mode,
  status: "ok",
  processor: "code",
  runCount: 4,
  hitCount: 1,
  createdAt: 0,
  updatedAt: 0,
});

describe("code runs", () => {
  it("runs a registered code processor with its args, without any model call or metering", async () => {
    const registry = makeRegistry();
    const seen: unknown[] = [];
    const join: CodeProcessor = {
      name: "join_all_test",
      async run({ args, snapshot, ports }) {
        seen.push(args, snapshot.batch.envelopes.length);
        await ports.context.commit(ports.self.cellId, { statePatches: { joined: true } });
        return "yielded_waiting";
      },
    };
    registry.codeProcessors.register(join);
    const model = new ScriptedModelClient([]);
    const { ports, snapshot, controller } = createFakeRun({ spec: { processor: { kind: "code", entry: "join_all_test", args: { expect: 3 } } }, batch: ["a", "b"] });
    const outcome = await createAgentLoop({ model, registry }).run(snapshot, ports, controller.signal);
    expect(outcome).toBe("yielded_waiting");
    expect(seen).toEqual([{ expect: 3 }, 2]);
    expect(ports.state.get("joined")).toBe(true);
    expect(model.calls).toHaveLength(0);
    expect(ports.log.metered).toHaveLength(0);
  });

  it("fails loudly for an unregistered entry, and reports cancelled when aborted mid-processor", async () => {
    const registry = makeRegistry();
    const loop = createAgentLoop({ model: new ScriptedModelClient([]), registry });
    const a = createFakeRun({ spec: { processor: { kind: "code", entry: "missing" } } });
    await expect(loop.run(a.snapshot, a.ports, a.controller.signal)).rejects.toSatisfy((e) => isNgError(e, "not_found"));

    registry.codeProcessors.register({ name: "slow", run: () => new Promise(() => undefined) });
    const b = createFakeRun({ spec: { processor: { kind: "code", entry: "slow" } } });
    const p = loop.run(b.snapshot, b.ports, b.controller.signal);
    setTimeout(() => b.controller.abort(), 5);
    expect(await p).toBe("cancelled");
  });

  it("script entry: output becomes a source.hit to the parent and updates the source record", async () => {
    const c = clock();
    const { ports, snapshot, controller } = createFakeRun({
      clock: c,
      cellId: "sensor1",
      spec: { title: "指标巡检", processor: { kind: "code", entry: "script:checks/pay.sh", args: { threshold: 0.99 } } },
      exec: () => ({ output: "支付成功率 97.2% 低于阈值\n详情见看板\n", exitCode: 0 }),
    });
    ports.state.set(gtdKeys.source, source("active"));
    const outcome = await createAgentLoop({ model: new ScriptedModelClient([]), registry: makeRegistry(), clock: c }).run(snapshot, ports, controller.signal);

    expect(outcome).toBe("completed");
    const exec = ports.log.execs[0]!;
    expect(exec.tool).toBe("bash");
    expect((exec.args as { command: string }).command).toBe(
      `NG_CELL_ID='sensor1' NG_RUN_ID='run_1' NG_ARGS='{"threshold":0.99}' bash 'checks/pay.sh'`,
    );
    expect(ports.log.emitted).toEqual([
      {
        type: PAYLOAD.sourceHit,
        payload: { sourceCellId: "sensor1", title: "支付成功率巡检", summary: "支付成功率 97.2% 低于阈值\n详情见看板", rawInput: "支付成功率 97.2% 低于阈值\n详情见看板" },
      },
    ]);
    expect(ports.log.evidence).toMatchObject([{ kind: "external", source: "script:checks/pay.sh" }]);
    expect(ports.state.get(gtdKeys.source)).toMatchObject({ runCount: 5, hitCount: 2, lastHitAt: c.now(), lastRunAt: c.now(), status: "ok" });
    expect(ports.log.metered).toHaveLength(0);
  });

  it("script entry: empty output is a silent run; observe mode records without posting", async () => {
    const registry = makeRegistry();
    const quiet = createFakeRun({ spec: { processor: { kind: "code", entry: "script:check.py" } }, exec: () => ({ output: "  \n", exitCode: 0 }) });
    quiet.ports.state.set(gtdKeys.source, source("active"));
    expect(await createAgentLoop({ model: new ScriptedModelClient([]), registry }).run(quiet.snapshot, quiet.ports, quiet.controller.signal)).toBe("completed");
    expect(quiet.ports.log.emitted).toHaveLength(0);
    expect(quiet.ports.log.evidence).toHaveLength(0);
    expect(quiet.ports.state.get(gtdKeys.source)).toMatchObject({ runCount: 5, hitCount: 1 });

    const observe = createFakeRun({ spec: { processor: { kind: "code", entry: "script:check.py" } }, exec: () => ({ output: "群里有人反馈支付报错", exitCode: 0 }) });
    observe.ports.state.set(gtdKeys.source, source("observe"));
    await createAgentLoop({ model: new ScriptedModelClient([]), registry }).run(observe.snapshot, observe.ports, observe.controller.signal);
    expect(observe.ports.log.emitted).toHaveLength(0);
    expect(observe.ports.log.evidence).toMatchObject([{ kind: "external", text: "群里有人反馈支付报错" }]);
  });

  it("script entry: a non-zero exit records a note, marks the source errored and throws", async () => {
    const { ports, snapshot, controller } = createFakeRun({
      spec: { processor: { kind: "code", entry: "script:bin/check" } },
      exec: () => ({ output: "connection refused", exitCode: 2 }),
    });
    ports.state.set(gtdKeys.source, source("active"));
    await expect(createAgentLoop({ model: new ScriptedModelClient([]), registry: makeRegistry() }).run(snapshot, ports, controller.signal)).rejects.toThrow(
      "exited with code 2",
    );
    expect(ports.log.evidence).toMatchObject([{ kind: "system_note" }]);
    expect(ports.state.get(gtdKeys.source)).toMatchObject({ status: "error", lastError: "exit 2: connection refused" });
    expect((ports.log.execs[0]!.args as { command: string }).command.endsWith("'./bin/check'")).toBe(true);
  });

  it("quotes script paths and env safely", () => {
    expect(scriptCommand("it's.mjs", { A: "x'y" })).toBe(`A='x'\\''y' node 'it'\\''s.mjs'`);
    expect(scriptCommand("/abs/run", {})).toBe(`'/abs/run'`);
  });
});
