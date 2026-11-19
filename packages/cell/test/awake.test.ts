import { EventEmitter } from "node:events";
import type { SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "@ng/protocol";
import { createKeepAwake, type KeepAwakeOptions } from "../src/awake";

class FakeChild extends EventEmitter {
  readonly signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
  unref(): void {}
}

const GRACE = 30_000;

function rig(over: Partial<KeepAwakeOptions> = {}) {
  const bus = createBus();
  const active = new Set<string>();
  const spawned: Array<{ command: string; args: string[]; options: SpawnOptions; child: FakeChild }> = [];
  const errors: unknown[] = [];
  const awake = createKeepAwake({
    bus,
    platform: "darwin",
    isBusy: () => active.size > 0,
    spawn: (command, args, options) => {
      const child = new FakeChild();
      spawned.push({ command, args, options, child });
      return child;
    },
    onError: (err) => errors.push(err),
    ...over,
  });
  let n = 0;
  return {
    bus,
    awake,
    spawned,
    errors,
    active,
    /** Like the dispatcher: the Run is counted before run.started and still counted while run.finished is emitted. */
    startRun(): string {
      const runId = `run_${++n}`;
      active.add(runId);
      bus.emit("run.started", { cellId: "c", runId, epoch: 0 });
      return runId;
    },
    finishRun(runId: string): void {
      bus.emit("run.finished", { cellId: "c", runId, epoch: 0, outcome: "completed" });
      active.delete(runId);
    },
    job(jobId: string, state: "running" | "succeeded"): void {
      if (state === "running") active.add(jobId);
      else active.delete(jobId);
      bus.emit("job.changed", { jobId, cellId: "c", state });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("keep awake (macOS caffeinate)", () => {
  it("holds one `caffeinate -i -w <pid>` while Runs are in flight, not one per Run, and drops it after the grace period", () => {
    const t = rig();
    t.awake.start();
    expect(t.spawned).toHaveLength(0);
    const a = t.startRun();
    const b = t.startRun();
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]).toMatchObject({ command: "caffeinate", args: ["-i", "-w", String(process.pid)], options: { detached: false, stdio: "ignore" } });
    const child = t.spawned[0]!.child;

    t.finishRun(a);
    vi.advanceTimersByTime(GRACE * 2);
    expect(child.signals).toEqual([]); // b is still running

    t.finishRun(b);
    vi.advanceTimersByTime(GRACE - 1);
    expect(child.signals).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(t.errors).toEqual([]);
    t.awake.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("work that resumes within the grace period keeps the same process; a later busy spell gets a new one", () => {
    const t = rig();
    t.awake.start();
    t.finishRun(t.startRun());
    vi.advanceTimersByTime(GRACE / 2);
    const r = t.startRun();
    vi.advanceTimersByTime(GRACE * 3);
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]!.child.signals).toEqual([]);
    t.finishRun(r);
    vi.advanceTimersByTime(GRACE);
    expect(t.spawned[0]!.child.signals).toEqual(["SIGTERM"]);
    t.startRun();
    expect(t.spawned).toHaveLength(2);
  });

  it("a running Job keeps the machine awake like a Run; jobs already running at start() are picked up", () => {
    const t = rig();
    t.active.add("job_reattached");
    t.awake.start();
    expect(t.spawned).toHaveLength(1);
    t.job("job_new", "running");
    t.job("job_reattached", "succeeded");
    vi.advanceTimersByTime(GRACE);
    expect(t.spawned[0]!.child.signals).toEqual([]);
    t.job("job_new", "succeeded");
    vi.advanceTimersByTime(GRACE);
    expect(t.spawned[0]!.child.signals).toEqual(["SIGTERM"]);
    expect(t.spawned).toHaveLength(1);
  });

  it("stop() kills it at once and stops listening", () => {
    const t = rig();
    t.awake.start();
    t.startRun();
    t.awake.stop();
    expect(t.spawned[0]!.child.signals).toEqual(["SIGTERM"]);
    t.startRun();
    vi.advanceTimersByTime(GRACE * 2);
    expect(t.spawned).toHaveLength(1);
  });

  it("a spawn that throws is reported once and never retried", () => {
    let calls = 0;
    const t = rig({
      spawn: () => {
        calls++;
        throw new Error("spawn caffeinate EACCES");
      },
    });
    t.awake.start();
    for (let i = 0; i < 5; i++) t.finishRun(t.startRun());
    t.job("j", "running");
    vi.advanceTimersByTime(GRACE * 2);
    expect(calls).toBe(1);
    expect(t.errors.map(String)).toEqual(["Error: spawn caffeinate EACCES"]);
  });

  it("a caffeinate that is missing (async spawn error) or exits by itself is reported once and not respawned", () => {
    const t = rig();
    t.awake.start();
    const r = t.startRun();
    t.spawned[0]!.child.emit("error", Object.assign(new Error("spawn caffeinate ENOENT"), { code: "ENOENT" }));
    t.finishRun(r);
    for (let i = 0; i < 5; i++) t.startRun();
    vi.advanceTimersByTime(GRACE * 2);
    expect(t.spawned).toHaveLength(1);
    expect(t.errors).toHaveLength(1);

    const u = rig();
    u.awake.start();
    u.startRun();
    u.spawned[0]!.child.emit("exit", 1, null);
    u.startRun();
    expect(u.spawned).toHaveLength(1);
    expect(u.errors.map(String)).toEqual(["Error: caffeinate exited on its own (code 1)"]);
  });

  it("a caffeinate stopped from outside (by a signal) is replaced at the next busy moment, silently", () => {
    const t = rig();
    t.awake.start();
    t.startRun();
    t.spawned[0]!.child.emit("exit", null, "SIGTERM");
    t.startRun();
    expect(t.spawned).toHaveLength(2);
    expect(t.errors).toEqual([]);
  });

  it("does nothing on other platforms", () => {
    for (const platform of ["linux", "win32"] as const) {
      const t = rig({ platform });
      t.awake.start();
      t.finishRun(t.startRun());
      t.job("j", "running");
      vi.advanceTimersByTime(GRACE * 2);
      t.awake.stop();
      expect(t.spawned).toHaveLength(0);
      expect(t.errors).toEqual([]);
    }
  });
});
