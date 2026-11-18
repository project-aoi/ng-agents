import { afterEach, describe, expect, it } from "vitest";
import { finalResultEnvelopeId, ManualClock, PAYLOAD, type CodeProcessor, type JobResultPayload, type Registry } from "@ng/protocol";
import { boot, cleanupAll, HOUR, registerTestPresets, T0, tempDir, tool, waitFor } from "./helpers";

afterEach(cleanupAll);

/** cell.task → start a job and park; job.result → record it. */
const jobWorker: CodeProcessor = {
  name: "test.job_worker",
  async run({ snapshot, ports }) {
    for (const env of snapshot.batch.envelopes) {
      if (env.type === PAYLOAD.cellTask) {
        await ports.workspace.startJob({ command: "sleep 0.4; echo survived-restart" });
        return "yielded_waiting";
      }
      if (env.type === PAYLOAD.jobResult) {
        const p = env.payload as JobResultPayload;
        await ports.context.commit(ports.self.cellId, { statePatches: { job: { state: p.state, tail: p.tail.trim() } } });
      }
    }
    return "completed";
  },
};

/** Counts its wake-ups by envelope type (a sensor on a cron, a reminder). */
const counter: CodeProcessor = {
  name: "test.counter",
  async run({ snapshot, ports }) {
    const self = ports.self.cellId;
    for (const env of snapshot.batch.envelopes) {
      const key = `n:${env.type}`;
      const n = ((await ports.context.readState<number>(self, key)) ?? 0) + 1;
      await ports.context.commit(self, { statePatches: { [key]: n } });
    }
    return "completed";
  },
};

function setup(registry: Registry): void {
  registerTestPresets(registry);
  registry.codeProcessors.register(jobWorker);
  registry.codeProcessors.register(counter);
}

describe("restart on the same database", () => {
  it("picks up where it stopped: interrupted Runs, a stale claim, a running Job, timers and cron", async () => {
    const dataDir = tempDir("restart");
    const clock = new ManualClock(T0);

    // ---------- first life ----------
    const a = await boot({ dataDir, clock, setup });
    a.kernel.spawnCell("desk", { id: "job", preset: "worker", processor: { kind: "code", entry: "test.job_worker" } }, "build");
    // a sensor lives on its cron (a one-shot cell would be closed — its cron cancelled — after its first Run)
    a.kernel.spawnCell("desk", { id: "sensor", preset: "worker", lifetime: "persistent", processor: { kind: "code", entry: "test.counter" }, schedules: [{ cron: "0 * * * *" }] });
    a.script.add("desk", tool("set_reminder", { label: "给牙医打电话", inSeconds: 2 * 3600 }), { text: "reminder set" });
    await a.ui.capture({ text: "两小时后提醒我给牙医打电话" });
    await a.kernel.idle();
    await waitFor(() => a.kernel.workspace.listJobsSync({ cellId: "job", state: ["running"] }).length === 1, 10_000, "job");
    // a Run in flight when the process stops
    a.script.add("desk", { text: "never answered", delayMs: 60_000 });
    await a.ui.capture({ text: "interrupted message" });
    await waitFor(() => a.kernel.activeRuns().length === 1, 5_000, "in-flight run");
    await a.kernel.close();

    // ---------- second life, same files ----------
    const b = await boot({ dataDir, clock, setup, desk: false, start: false });
    expect(b.kernel.getCell("desk")).toBeDefined();
    const pending = b.kernel.inbox.listMessagesSync({ cellId: "desk", status: ["pending"], type: PAYLOAD.userMessage });
    expect(pending.map((m) => [(m.envelope.payload as { text?: string }).text, m.attempts])).toEqual([["interrupted message", 0]]); // graceful stop: no attempt used
    // a claim left behind by a crashed process
    b.kernel.inbox.enqueueSync("sensor", { id: "orphan", from: "inbox:desk", principalId: "cell:desk", kind: "event", type: PAYLOAD.userMessage, payload: { text: "orphaned" }, createdAt: clock.now() });
    expect(b.kernel.inbox.claimNextRunSync("sensor", "dead-kernel", "serial_coalesce")).not.toBeNull();

    b.script.add("desk", { text: "handled after restart" });
    await b.kernel.start();
    await b.kernel.idle();
    expect(b.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage }).map((m) => m.status)).toEqual(["done", "done"]);
    expect(b.kernel.context.readStateSync("sensor", "n:user.message")).toBe(1);
    expect(b.kernel.inbox.listClaimsSync({ status: ["active"] })).toEqual([]);

    // the job outlived the first kernel; its result reaches the cell through the second one
    await waitFor(() => b.kernel.workspace.listJobsSync({ cellId: "job", state: ["running"] }).length === 0, 10_000, "job end");
    await b.kernel.idle({ jobs: true });
    await b.kernel.idle();
    expect(b.kernel.context.readStateSync("job", "job")).toEqual({ state: "succeeded", tail: "survived-restart" });
    // the one-shot job worker then settled through the second kernel: one final result, closed
    expect(b.kernel.getCell("job")).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(b.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => m.envelope.id)).toEqual([finalResultEnvelopeId("job", 0)]);

    // timers and cron set by the first life fire in the second
    clock.advance(2 * HOUR);
    await b.kernel.idle();
    expect(b.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.timerFired }).map((m) => m.status)).toEqual(["done"]);
    expect(b.kernel.context.readStateSync("sensor", "n:timer.fired")).toBeGreaterThanOrEqual(1);
  });
});
