import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock, PAYLOAD, run, type CodeProcessor, type Registry } from "@ng/protocol";
import { forgetWorkTreeKeys } from "../src";
import { boot, cleanupAll, git, initRepo, lastToolResult, registerTestPresets, T0, tempDir, tool, waitFor, type Harness } from "./helpers";

afterEach(async () => {
  await cleanupAll();
  forgetWorkTreeKeys();
});

// docs/05 §3.2 — one writer per work tree, decided by the dispatcher at run time: planners spawn freely, a second
// writer simply does not start until the first one's Run and background Jobs are gone, and a cell that sleeps holds
// nothing.

/** Code processors whose Runs the test opens one by one. */
function gated() {
  const gates = new Map<string, { started: Promise<void>; markStarted(): void; release(): void; wait: Promise<void> }>();
  const of = (id: string) => {
    let g = gates.get(id);
    if (!g) {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((r) => (markStarted = r));
      const wait = new Promise<void>((r) => (release = r));
      gates.set(id, (g = { started, markStarted, release, wait }));
    }
    return g;
  };
  const proc: CodeProcessor = {
    name: "test.gated",
    async run({ snapshot, ports, signal }) {
      if (!snapshot.batch.envelopes.some((e) => e.type === PAYLOAD.cellTask)) return "yielded_waiting";
      const g = of(ports.self.cellId);
      g.markStarted();
      await Promise.race([g.wait, new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
      return "completed";
    },
  };
  /** Starts a Job on its task and yields (the Job outlives the Run). */
  const job: CodeProcessor = {
    name: "test.job",
    async run({ snapshot, ports, args }) {
      if (snapshot.batch.envelopes.some((e) => e.type === PAYLOAD.cellTask)) {
        await ports.workspace.startJob({ command: String(args["command"] ?? "sleep 30") });
        return "yielded_waiting";
      }
      return "completed";
    },
  };
  return { of, proc, job };
}

function setupWith(...procs: CodeProcessor[]) {
  return (registry: Registry) => {
    registerTestPresets(registry);
    for (const p of procs) registry.codeProcessors.register(p);
  };
}

/** Cells with a Run in flight, the desk aside (a worker's result wakes it for a moment). */
const running = (h: Harness) => h.kernel.activeRuns().map((r) => r.cellId).filter((id) => id !== "desk").sort();

/**
 * No process of the group is left. In these tests the "previous kernel" is this very process, so a killed job leader
 * stays a zombie until Node reaps it — hence a short wait rather than a single probe.
 */
async function groupGone(pid: number): Promise<void> {
  await waitFor(() => {
    try {
      process.kill(-pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5_000, `process group ${pid} to disappear`);
}
const started = (h: Harness) => h.of("run.started").map((e) => e.cellId);

describe("write slot per work tree", () => {
  it("the repository root and a sub-directory of it queue; a separate worktree of the same repository runs in parallel; readers never queue", async () => {
    const g = gated();
    const h = await boot({ setup: setupWith(g.proc) });
    const repo = initRepo();
    mkdirSync(join(repo, "packages", "ui"), { recursive: true });
    const other = join(tempDir("wt"), "ci-fix");
    git(repo, "worktree", "add", "-q", "-b", "ci-fix", other);

    const spec = (id: string, cwd: string, cwdMode: "read" | "write" = "write") => ({ id, preset: "worker" as const, title: id, cwd, cwdMode, processor: { kind: "code" as const, entry: "test.gated" } });
    h.kernel.spawnCell("desk", spec("a", repo), "go");
    await g.of("a").started;
    h.kernel.spawnCell("desk", spec("b", join(repo, "packages", "ui")), "go");
    h.kernel.spawnCell("desk", spec("c", repo), "go");
    h.kernel.spawnCell("desk", spec("elsewhere", other), "go");
    h.kernel.spawnCell("desk", spec("reader", repo, "read"), "go");
    await Promise.all([g.of("elsewhere").started, g.of("reader").started]);
    await new Promise((r) => setTimeout(r, 30));

    // Spawning never failed, and nothing of b/c was claimed: their tasks are still pending, in order.
    expect(running(h)).toEqual(["a", "elsewhere", "reader"]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "b" })[0]!.status).toBe("pending");
    const occ = h.kernel.activeWorkspaces();
    const tree = occ.find((o) => o.key === repo)!;
    expect(tree.holder).toMatchObject({ cellId: "a", state: "running", cwdMode: "write" });
    expect(tree.queued.map((u) => u.cellId)).toEqual(["b", "c"]);
    expect(tree.others.map((u) => [u.cellId, u.cwdMode])).toEqual([["reader", "read"]]);
    expect(occ.find((o) => o.key === other)!.holder).toMatchObject({ cellId: "elsewhere" });

    g.of("a").release();
    await g.of("b").started;
    expect(running(h)).toEqual(["b", "elsewhere", "reader"]);
    g.of("b").release();
    await g.of("c").started;
    // Strictly one at a time, in arrival order.
    expect(started(h).filter((id) => ["a", "b", "c"].includes(id))).toEqual(["a", "b", "c"]);
    for (const id of ["c", "elsewhere", "reader"]) g.of(id).release();
    await h.kernel.idle();
    expect(h.kernel.activeWorkspaces()).toEqual([]);
  });

  it("a worker that asks the desk to arbitrate and sleeps releases the tree: the fixer sent into the same directory runs at once, then the worker is woken", async () => {
    const h = await boot();
    const repo = initRepo();
    h.kernel.spawnCell("desk", { id: "feat", preset: "worker", title: "feature", cwd: repo, meta: { role: "feat" } }, "implement");
    h.script.add("feat", tool("send_message", { to: "inbox:desk", text: "cwd: repo\nbranch: feat/x\n公共 CI 挂了", summary: "公共受阻请求裁决" }));
    h.script.add("feat", tool("wait", { reason: "等待 desk 裁决公共 CI", waitingFor: "inbox:desk" }));
    // The desk is woken by the request and sends a fixer into the very same tree.
    h.script.add("desk", tool("spawn_cell", { preset: "worker", title: "修公共 CI", instruction: "fix ci", cwd: repo, meta: { role: "fixer" } }));
    h.script.add("desk", tool("wait", { reason: "等修复" }));
    let fixerSaw: string[] = [];
    h.script.add("fixer", () => {
      // The requester sleeps with an open wait and holds nothing, so this Run was not queued behind it.
      fixerSaw = running(h);
      return tool("report_to_parent", { kind: "result", text: "CI 已修复" });
    });
    // The fixer's result wakes the desk, which tells the sleeper.
    let delivered = "";
    h.script.add("desk", tool("send_message", { to: "inbox:feat", text: "ci已修复，可以 rebase develop 然后继续推进", summary: "唤醒" }));
    h.script.add("desk", (req) => {
      delivered = lastToolResult(req);
      return { text: "done" };
    });
    h.script.add("feat", tool("report_to_parent", { kind: "result", text: "rebased and merged" }));
    await h.kernel.idle();

    expect(fixerSaw).toEqual([h.kernel.listCells({ parentId: "desk" }).find((c) => c.title === "修公共 CI")!.id]);
    expect(delivered).toMatch(/^Delivered to feat/);
    expect(h.kernel.getCell("feat")!.status).toBe("closed");
    // The wait was closed by the desk's answer — and only by it: the task itself did not clear it earlier.
    expect(h.kernel.listWaits()).toEqual([]);
    expect(started(h).filter((id) => id === "feat")).toHaveLength(2);
  });

  it("a background Job keeps the tree after its Run ended; closing the cell frees it only once the Job's processes are gone", async () => {
    const g = gated();
    const h = await boot({ setup: setupWith(g.proc, g.job) });
    const repo = initRepo();
    h.kernel.spawnCell("desk", { id: "builder", preset: "worker", cwd: repo, processor: { kind: "code", entry: "test.job", args: { command: "trap '' TERM; sleep 30" } } }, "build");
    await waitFor(() => h.kernel.workspace.listJobsSync({ state: ["running"] }).length === 1, 10_000, "the job");
    await h.kernel.idle();
    expect(running(h)).toEqual([]);

    h.kernel.spawnCell("desk", { id: "next", preset: "worker", cwd: repo, processor: { kind: "code", entry: "test.gated" } }, "go");
    await h.kernel.idle();
    expect(started(h)).not.toContain("next");
    const tree = h.kernel.activeWorkspaces().find((o) => o.key === repo)!;
    expect(tree.holder).toMatchObject({ cellId: "builder", state: "job" });
    expect(tree.queued.map((u) => u.cellId)).toEqual(["next"]);

    // The Job ignores SIGTERM: for the grace period it is "cancelling" (still running) and the tree stays taken.
    const closing = h.kernel.closeCell("builder", "cancelled");
    await new Promise((r) => setTimeout(r, 100));
    expect(h.kernel.getCell("builder")!.status).toBe("closed");
    expect(h.kernel.workspace.listJobsSync({ state: ["running"] })).toHaveLength(1);
    expect(started(h)).not.toContain("next");
    await closing;
    expect(h.kernel.workspace.listJobsSync({ state: ["running"] })).toHaveLength(0);
    await g.of("next").started;
    g.of("next").release();
    await h.kernel.idle();
    // The repository itself was never touched by the kernel.
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("a Job that finishes by itself hands the tree to the next writer in line", async () => {
    const g = gated();
    const h = await boot({ setup: setupWith(g.proc, g.job) });
    const dir = tempDir("plain");
    h.kernel.spawnCell("desk", { id: "builder", preset: "worker", lifetime: "persistent", cwd: dir, processor: { kind: "code", entry: "test.job", args: { command: "sleep 0.4" } } }, "build");
    await waitFor(() => h.kernel.workspace.listJobsSync({ state: ["running"] }).length === 1, 10_000, "the job");
    h.kernel.spawnCell("desk", { id: "next", preset: "worker", cwd: dir, processor: { kind: "code", entry: "test.gated" } }, "go");
    await h.kernel.idle();
    expect(started(h)).not.toContain("next");
    await g.of("next").started;
    expect(h.kernel.workspace.listJobsSync({ state: ["running"] })).toHaveLength(0);
    g.of("next").release();
    await h.kernel.idle({ jobs: true });
  });
});

describe("the queue survives a restart", () => {
  it("a Job left running by the previous kernel still holds its tree; one whose cancel was interrupted is killed before anything is dispatched", async () => {
    const g1 = gated();
    const dataDir = tempDir("data");
    const clock = new ManualClock(T0);
    const repo = initRepo();
    const dir2 = tempDir("second");
    const first = await boot({ setup: setupWith(g1.proc, g1.job), dataDir, clock });
    first.kernel.spawnCell("desk", { id: "builder", preset: "worker", lifetime: "persistent", cwd: repo, processor: { kind: "code", entry: "test.job", args: { command: "sleep 30" } } }, "build");
    first.kernel.spawnCell("desk", { id: "doomed", preset: "worker", lifetime: "persistent", cwd: dir2, processor: { kind: "code", entry: "test.job", args: { command: "sleep 30" } } }, "build");
    await waitFor(() => first.kernel.workspace.listJobsSync({ state: ["running"] }).length === 2, 10_000, "both jobs");
    await first.kernel.idle();
    const jobs = first.kernel.workspace.listJobsSync({ state: ["running"] });
    const doomed = jobs.find((j) => j.cellId === "doomed")!;
    // Writers queued behind both trees, then the kernel dies: one job mid-cancel (request recorded, no signal sent).
    first.kernel.spawnCell("desk", { id: "after-builder", preset: "worker", cwd: repo, processor: { kind: "code", entry: "test.gated" } }, "go");
    first.kernel.spawnCell("desk", { id: "after-doomed", preset: "worker", cwd: dir2, processor: { kind: "code", entry: "test.gated" } }, "go");
    await first.kernel.idle();
    run(first.kernel.db, "UPDATE jobs SET cancel_requested_at = ?, error = 'cancelled with the cell' WHERE job_id = ?", [T0, doomed.jobId]);
    await first.kernel.stop(); // Runs are released, Jobs keep running: the next kernel's recover() takes over

    const g2 = gated();
    const second = await boot({ setup: setupWith(g2.proc, g2.job), dataDir, clock, desk: false });
    // start() returned: the interrupted cancel was finished first — its process is gone and recorded as cancelled.
    expect(second.kernel.workspace.getJobSync(doomed.jobId)).toMatchObject({ state: "cancelled" });
    await groupGone(doomed.pid!);
    await g2.of("after-doomed").started;
    // The other Job was re-attached and still holds its tree across the restart.
    await new Promise((r) => setTimeout(r, 60));
    expect(second.of("run.started").map((e) => e.cellId)).not.toContain("after-builder");
    expect(second.kernel.activeWorkspaces().find((o) => o.key === repo)).toMatchObject({ holder: { cellId: "builder", state: "job" }, queued: [{ cellId: "after-builder" }] });

    await second.kernel.closeCell("builder", "cancelled");
    await g2.of("after-builder").started;
    g2.of("after-builder").release();
    g2.of("after-doomed").release();
    await second.kernel.idle();
  });

  it("a cell closed just before the previous kernel died does not leave a Job writing: its runtime is stopped at startup", async () => {
    const g1 = gated();
    const dataDir = tempDir("data");
    const clock = new ManualClock(T0);
    const dir = tempDir("tree");
    const first = await boot({ setup: setupWith(g1.proc, g1.job), dataDir, clock });
    first.kernel.spawnCell("desk", { id: "builder", preset: "worker", lifetime: "persistent", cwd: dir, processor: { kind: "code", entry: "test.job", args: { command: "sleep 30" } } }, "build");
    await waitFor(() => first.kernel.workspace.listJobsSync({ state: ["running"] }).length === 1, 10_000, "the job");
    await first.kernel.idle();
    const job = first.kernel.workspace.listJobsSync({ state: ["running"] })[0]!;
    // The close committed (status, epoch) but the process died before the runtime was stopped.
    run(first.kernel.db, "UPDATE cells SET status = 'closed', close_reason = 'cancelled', epoch = epoch + 1 WHERE id = 'builder'");
    await first.kernel.stop();

    const second = await boot({ setup: setupWith(g1.proc, g1.job), dataDir, clock, desk: false });
    expect(second.kernel.workspace.getJobSync(job.jobId)).toMatchObject({ state: "cancelled" });
    await groupGone(job.pid!);
    expect(second.kernel.activeWorkspaces()).toEqual([]);
  });
});
