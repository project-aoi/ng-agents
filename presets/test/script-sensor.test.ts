import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys } from "../src/shared/keys";
import {  PAYLOAD, systemClock} from "@ng/protocol";
import { createFakeRun } from "@ng/loop/testing";
import { createScriptSensor, sensorProcessor } from "../src";
import { scriptCommand } from "../src/shared/script-command";

import { createDesk } from "../../apps/gtd-desk/src/server/desk";
import { DEFAULT_SETTINGS } from "../../apps/gtd-desk/src/server/projections/common";
import { boot, cleanupAll, tempDir } from "./helpers";

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
    expect(ports.state.get(gtdKeys.source)).toMatchObject({ runCount: 1, status: exitCode ? "error" : "ok" });
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

  it("quotes script paths and env safely", () => {
    expect(scriptCommand("~/check.sh", {})).toBe(`bash '${homedir()}/check.sh'`);
    expect(() => sensorProcessor("script:  ")).toThrow("需要脚本路径");
    expect(scriptCommand("it's.mjs", { A: "x'y" })).toBe(`A='x'\\''y' node 'it'\\''s.mjs'`);
    expect(scriptCommand("/abs/run", {})).toBe(`'/abs/run'`);
  });
});

it("delivers the scheduled envelope to an actual script created through the workbench", async () => {
  const {kernel, clock, ui} = await boot();
  const desk = createDesk({kernel, ui, settings: DEFAULT_SETTINGS});
  const path = join(tempDir("checks"), "check owner's report.mjs");
  writeFileSync(path, `
    const trigger = JSON.parse(process.env.NG_TRIGGER_JSON);
    process.stdout.write(JSON.stringify({ cell: process.env.NG_CELL_ID, id: trigger.id, type: trigger.type }));
  `);
  const { sensorId } = desk.createSource({
    title: "最新报告", schedule: {everyMinutes: 1}, check: {kind: "script", path}, mode: "observe",
  }, {principalId: "owner"});
  await kernel.idle();
  expect(kernel.context.readStateSync(sensorId!, gtdKeys.source)).toMatchObject({runCount: 0});
  clock.advance(60_000);
  await kernel.idle();
  const source = kernel.context.readStateSync<{lastCheckKey: string}>(sensorId!, gtdKeys.source)!;
  expect(source).toMatchObject({status: "ok", hitCount: 1, runCount: 1});
  const [trigger] = kernel.inbox.listMessagesSync({cellId: sensorId!, envelopeId: source.lastCheckKey});
  expect(trigger).toMatchObject({status: "done"});
  const note = kernel.context.getKnowledgeSync({cellId: sensorId!, scope: "cell", kind: "reference", name: "观察笔记"});
  expect(note?.body).toContain(JSON.stringify({cell: sensorId, id: trigger!.envelope.id, type: trigger!.envelope.type}));
  expect(kernel.humanItems.list()).toEqual([]);
});
