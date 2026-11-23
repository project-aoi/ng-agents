import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys } from "../src/shared/keys";
import { PAYLOAD, systemClock, type SourceHitPayload } from "@ng/protocol";
import { createFakeRun } from "@ng/loop/testing";
import { createScriptSensor, sensorProcessor } from "../src";
import { sensorToolset } from "../src/shared/sensor";

const tool = (name: string) => sensorToolset().tools.find((t) => t.name === name)!;
import { scriptCommand } from "../src/shared/script-command";

import { cleanupAll } from "./helpers";

afterEach(cleanupAll);

describe("the registered script sensor", () => {
  it.each([
    ["active", 0, "", 0],
    ["active", 0, "hit", 1],
    ["observe", 0, "observed", 0],
    ["active", 2, "connection refused", 0],
  ] as const)("runs %s checks with exit %i and output %s", async (mode, exitCode, output, hits) => {
    const processor = sensorProcessor("script:checks/pay.sh");
    const { ports, snapshot, controller } = createFakeRun({
      cellId: "sensor",
      batch: ["check"],
      spec: { title: "payments", processor, meta: { gtd: { source: { title: "payments", kind: "cron", mode, processor: "code" } } } },
      exec: () => ({ exitCode, output }),
    });
    const outcome = await createScriptSensor().run({
      ports,
      snapshot,
      args: processor.args!,
      clock: systemClock,
      signal: controller.signal,
    });
    expect(outcome).toBe("completed");
    expect(ports.log.execs[0]?.args).toMatchObject({ command: expect.stringContaining("bash 'checks/pay.sh'") });
    expect(ports.log.emitted.filter((e) => e.type === PAYLOAD.sourceHit)).toHaveLength(hits);
    const state = ports.state.get(gtdKeys.source);
    expect(state).toMatchObject({runCount:1});
    if (exitCode) expect(state).toMatchObject({lastError: expect.stringContaining(`exit ${exitCode}`)});
    else expect(state).not.toHaveProperty("lastError");
  });
  it("records a replayed observation once and passes the trigger to the script", async () => {
    const processor = sensorProcessor("script:~/check.sh");
    const fixture = createFakeRun({
      cellId: "sensor",
      batch: ["changed"],
      spec: { processor, meta: { gtd: { source: { title: "reports", kind: "watch", mode: "observe", processor: "code" } } } },
      exec: () => ({ exitCode: 0, output: "one observation" }),
    });
    const input = { ports: fixture.ports, snapshot: fixture.snapshot, args: processor.args!, clock: systemClock, signal: fixture.controller.signal };
    await createScriptSensor().run(input);
    await createScriptSensor().run({ ...input, snapshot: { ...input.snapshot, runId: "new-claim" } });
    expect(fixture.ports.log.execs).toHaveLength(1);
    const command = (fixture.ports.log.execs[0]!.args as { command: string }).command;
    expect(command).toContain(scriptCommand("~/check.sh", {}).trim());
    expect(command).toContain(`NG_TRIGGER_JSON='${JSON.stringify(input.snapshot.batch.envelopes[0])}'`);
    expect(fixture.ports.log.knowledge).toHaveLength(1);
    expect(fixture.ports.state.get(gtdKeys.source)).toMatchObject({ runCount: 1, hitCount: 1 });
  });

  it("E13: an unchanged hit is reported once until a check finds nothing; a hit says which source, script and report it came from", async () => {
    const processor = sensorProcessor("script:bin/check-nightly.sh");
    let output = "夜间工程报告 2026-11-23 失败：lint；详情 /home/owner/dev/eng-report/reports/nightly.json";
    const fixture = createFakeRun({
      cellId: "src_nightly",
      batch: ["tick"],
      spec: { title: "夜间报告", cwd: "/home/owner/dev/eng-report", processor, meta: { gtd: { source: { title: "夜间报告", kind: "cron", mode: "active", processor: "code" } } } },
      exec: () => ({ exitCode: 0, output }),
    });
    const check = async (n: number) => {
      const trigger = { ...fixture.snapshot.batch.envelopes[0]!, id: `tick_${n}` };
      const snapshot = { ...fixture.snapshot, runId: `run_${n}`, batch: { ...fixture.snapshot.batch, envelopes: [trigger] } };
      await createScriptSensor().run({ ports: fixture.ports, snapshot, args: processor.args!, clock: systemClock, signal: fixture.controller.signal });
    };
    const hits = () => fixture.ports.log.emitted.filter((e) => e.type === PAYLOAD.sourceHit).map((e) => e.payload as SourceHitPayload);
    await check(1);
    await check(2);
    await check(3);
    expect(hits()).toHaveLength(1);
    expect(fixture.ports.state.get(gtdKeys.source)).toMatchObject({ runCount: 3, hitCount: 1, lastHitRepeats: 2 });
    const [hit] = hits();
    expect(hit!.uri).toBe("/home/owner/dev/eng-report/reports/nightly.json");
    expect(hit!.data).toEqual({ origin: { sourceTitle: "夜间报告", sourceCellId: "src_nightly", check: "script:bin/check-nightly.sh", cwd: "/home/owner/dev/eng-report", location: "/home/owner/dev/eng-report/reports/nightly.json" } });
    expect(hit!.summary).toContain("（信源「夜间报告」，脚本 bin/check-nightly.sh，在 /home/owner/dev/eng-report 运行；报告位置：/home/owner/dev/eng-report/reports/nightly.json）");
    // Recovery: the next failure is news again, also when it reads the same.
    output = "";
    await check(4);
    output = "夜间工程报告 2026-11-23 失败：lint；详情 /home/owner/dev/eng-report/reports/nightly.json";
    await check(5);
    expect(hits()).toHaveLength(2);
    // A different failure while one is reported is a new hit.
    output = "夜间工程报告 2026-11-24 失败：build";
    await check(6);
    expect(hits()).toHaveLength(3);
    expect(fixture.ports.state.get(gtdKeys.source)).toMatchObject({ runCount: 6, hitCount: 3 });
  });

  it("E13: an llm source's identical report is counted, not posted again", async () => {
    const report = tool("report_hit");
    const fixture = createFakeRun({ cellId: "src_llm", batch: ["tick"], spec: { title: "群消息", meta: { gtd: { source: { title: "群消息", kind: "watch", mode: "active", processor: "llm" } } } } });
    const call = async (n: number) => {
      const trigger = { ...fixture.snapshot.batch.envelopes[0]!, id: `tick_${n}` };
      const snapshot = { ...fixture.snapshot, runId: `run_${n}`, batch: { ...fixture.snapshot.batch, envelopes: [trigger] } };
      const r = await report.handler({ title: "支付报错", summary: "有人说付款页面白屏" }, { ports: fixture.ports, snapshot, signal: fixture.controller.signal, toolUseId: `t${n}`, clock: systemClock });
      return typeof r === "string" ? r : (r as { output: string }).output;
    };
    expect(await call(1)).toBe("Reported to the desk.");
    expect(await call(2)).toContain("counted, not reported again");
    const posted = fixture.ports.log.emitted.filter((e) => e.type === PAYLOAD.sourceHit).map((e) => e.payload as SourceHitPayload);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.data).toMatchObject({ origin: { sourceTitle: "群消息", sourceCellId: "src_llm", check: "model" } });
  });

  it("quotes script paths and env safely", () => {
    expect(scriptCommand(" ~/check.sh ", {})).toBe(`bash '${homedir()}/check.sh'`);
    expect(() => sensorProcessor("script:  ")).toThrow("需要脚本路径");
    expect(scriptCommand("it's.mjs", { A: "x'y" })).toBe(`A='x'\\''y' node 'it'\\''s.mjs'`);
    for (const [file, runner] of [["-check.sh","bash"], ["-report.js","node"], ["-daily.py","python3"]] as const)
      expect(scriptCommand(file, {})).toBe(`${runner} './${file}'`);
    expect(scriptCommand("/abs/run", {})).toBe(`'/abs/run'`);
  });
});
