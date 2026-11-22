import { describe, expect, it } from "vitest";
import { gtdKeys, PAYLOAD, systemClock } from "@ng/protocol";
import { createFakeRun } from "@ng/loop/testing";
import { createScriptSensor, sensorProcessor } from "../src";
import { scriptCommand } from "../src/shared/script-command";

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
    expect(ports.state.get(gtdKeys.source)).toMatchObject({ runCount: 1, status: exitCode ? "error" : "ok" });
    expect(ports.log.metered).toHaveLength(0);
  });
  it("quotes script paths and env safely", () => {
    expect(scriptCommand("it's.mjs", { A: "x'y" })).toBe(`A='x'\\''y' node 'it'\\''s.mjs'`);
    expect(scriptCommand("/abs/run", {})).toBe(`'/abs/run'`);
  });
});
