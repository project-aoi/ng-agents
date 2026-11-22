import { afterEach, describe, expect, it } from "vitest";
import { CELL_STATUS_KEY, PAYLOAD, type CodeProcessor, type Registry } from "@ng/protocol";
import { boot, cleanupAll, DAY, registerTestPresets, T0, waitFor } from "./helpers";

afterEach(cleanupAll);

const longJob: CodeProcessor = {
  name: "test.long_job",
  async run({ snapshot, ports }) {
    if (snapshot.batch.envelopes.some((e) => e.type === PAYLOAD.cellTask)) await ports.workspace.startJob({ command: "sleep 30" });
    return "yielded_waiting";
  },
};

function setup(registry: Registry): void {
  registerTestPresets(registry);
  registry.codeProcessors.register(longJob);
  registry.codeProcessors.register({ name: "test.idle", run: async () => "completed" });
}

describe("read models", () => {
  it("roster, tree and stats describe what is in flight; the roster reaches the parent's snapshot tail", async () => {
    const h = await boot({ setup });
    h.kernel.spawnCell("desk", { id: "proj", preset: "project", title: "官网改版", processor: { kind: "code", entry: "test.idle" }, meta: { projectCellId: "proj" }, bounds: { maxDepth: 1 } }, undefined, { principalId: h.kernel.ownerPrincipal });
    h.kernel.spawnCell("proj", { id: "build", preset: "worker", title: "跑测试", processor: { kind: "code", entry: "test.long_job" } }, "go", { principalId: h.kernel.ownerPrincipal });
    h.kernel.spawnCell("proj", { id: "wait", preset: "checker", title: "等报价", processor: { kind: "code", entry: "test.idle" }, watches: [{ threadOrFilter: { thread: "memory:q" } }], schedules: [{ deliverAt: T0 + DAY }] }, undefined, { principalId: h.kernel.ownerPrincipal });
    h.kernel.context.commitSync("wait", { statePatches: { [CELL_STATUS_KEY]: { text: "已回", at: T0, progress: { done: 2, total: 3, label: "家" } } } });
    await h.kernel.idle();
    await waitFor(() => h.kernel.workspace.listJobsSync({ state: ["running"] }).length === 1, 10_000, "job");

    const roster = h.kernel.rosterFor("proj");
    expect(roster.map((r) => [r.cellId, r.depth, r.parentId])).toEqual([
      ["build", 1, "proj"],
      ["wait", 1, "proj"],
    ]);
    expect(h.kernel.rosterFor("desk").map((r) => [r.cellId, r.depth, r.parentId])).toEqual([
      ["proj", 1, "desk"],
      ["build", 2, "proj"],
      ["wait", 2, "proj"],
    ]);
    // nobody gave them a directory: no cwd in the roster (the kernel's own fallback directory is noise)
    expect(roster.some((r) => "cwd" in r)).toBe(false);
    expect(roster[0]).toMatchObject({ title: "跑测试", running: false, jobs: [expect.objectContaining({ command: "sleep 30" })] });
    expect(roster[1]).toMatchObject({ statusLine: "已回 (2/3 家)", progress: { done: 2, total: 3 }, waitingOn: { threads: ["memory:q"], nextTimerAt: T0 + DAY, pendingApprovals: 0 } });

    const [desk] = h.kernel.tree();
    expect(desk!.cellId).toBe("desk");
    const proj = desk!.children[0]!;
    expect(proj).toMatchObject({ cellId: "proj", title: "官网改版", watching: false, runningJobs: 0 });
    expect(proj.children.map((c) => [c.cellId, c.runningJobs, c.watching, c.nextTimerAt])).toEqual([
      ["build", 1, false, null],
      ["wait", 0, true, T0 + DAY],
    ]);
    expect(h.kernel.stats()).toMatchObject({ backgroundCells: 3, runningJobs: 1, busyCells: 1, waitingCells: 1, runningRuns: 0, pendingApprovals: 0 });

    // the desk's next Run sees its in-flight child (the project) in the volatile tail
    h.kernel.spawnCell("desk", { id: "note", preset: "checker", title: "提醒", processor: { kind: "code", entry: "test.idle" } }, undefined, { principalId: h.kernel.ownerPrincipal });
    h.script.add("desk", (req) => {
      const tail = JSON.stringify(req.messages);
      expect(tail).toContain("in-flight child cells");
      expect(tail).toContain("官网改版");
      return { text: "ok" };
    });
    await h.ui.capture({ text: "项目进展如何？" }, "owner");
    await h.kernel.idle();
    expect(h.script.callsOf("desk")).toHaveLength(1);

    await h.kernel.closeCell("proj", "cancelled", { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.stats()).toMatchObject({ backgroundCells: 1, runningJobs: 0 });
    const children = h.kernel.tree({ includeClosed: true })[0]!.children;
    expect(Object.fromEntries(children.map((c) => [c.cellId, c.status]))).toEqual({ note: "active", proj: "closed" });
  });

  it("a caller narrowing one bounds field keeps the preset's other requests", async () => {
    const h = await boot({
      setup(registry: Registry) {
        setup(registry);
        registry.presets.register({
          name: "sensor",
          description: "sensor with an explicit tool set",
          defaults: { processor: { kind: "code", entry: "test.idle" }, lifetime: "persistent", bounds: { tools: new Set(["read", "bash"]) } },
        });
      },
    });
    h.kernel.spawnCell("desk", { id: "s", preset: "sensor", bounds: { maxConcurrentChildren: 1 } }, undefined, { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.getCell("s")!.bounds).toMatchObject({ maxConcurrentChildren: 1 });
    expect([...h.kernel.getCell("s")!.bounds.tools].sort()).toEqual(["bash", "read"]);
    expect(h.kernel.getCell("s")!.spec.bounds).toEqual({ tools: ["bash", "read"], maxConcurrentChildren: 1 });
    // a preset that asks only for maxDepth 0 (the worker): that and the caller's field
    // (the desk: the host)
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", processor: { kind: "code", entry: "test.idle" }, bounds: { maxConcurrentChildren: 1 } }, undefined, { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.getCell("w")!.bounds).toMatchObject({ maxConcurrentChildren: 1, maxDepth: 0 });
    expect(h.kernel.getCell("w")!.spec.bounds).toEqual({ maxDepth: 0, maxConcurrentChildren: 1 });
  });

  it("tail notes surface card titles, wait refIds, and ISO schedule timestamps with cancelGroup", async () => {
    const h = await boot({ setup });
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", title: "分身W", processor: { kind: "code", entry: "test.idle" } }, undefined, { principalId: h.kernel.ownerPrincipal });
    h.kernel.humanItems.create({
      title: "确认发布窗口",
      subjectKey: "arb:release",
      options: [{ id: "ok", label: "可以发布", effect: "reply" }],
    }, "desk");
    h.kernel.inbox.enqueueSync("desk", {
      id: "sched-check",
      from: "timer:desk",
      principalId: "cell:desk",
      kind: "event",
      type: PAYLOAD.timerFired,
      payload: { label: "巡检" },
      createdAt: T0,
    }, { cron: "0 9 * * *", tz: "Asia/Shanghai", cancelGroup: "daily-check" });
    h.kernel.db.prepare(
      "INSERT INTO cell_waits (cell_id, wait_id, ref_id, registration_id, waiting_for, reason, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("w", "w_ci", "ref_ci", "reg_1", "inbox:desk", "等 CI 修复", 0, T0);

    let prompt = "";
    h.script.add("desk", (req) => {
      prompt = JSON.stringify(req.messages);
      return { text: "ok" };
    });
    await h.ui.capture({ text: "看下现状" }, "owner");
    await h.kernel.idle();
    expect(prompt).toContain("确认发布窗口");
    expect(prompt).toContain("[waitId=w_ci, refId=ref_ci]");
    expect(prompt).toContain('cron \\"0 9 * * *\\" (Asia/Shanghai) cancelGroup \\"daily-check\\"');
    expect(prompt).toMatch(/next 20\d\d-\d\d-\d\dT/);
  });

});
