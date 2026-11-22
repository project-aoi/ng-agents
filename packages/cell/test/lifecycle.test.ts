import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  finalResultEnvelopeId,
  isNgError,
  makeBounds,
  PAYLOAD,
  serializeBounds,
  type Address,
  type CellResultPayload,
  type CodeProcessor,
  type Registry,
} from "@ng/protocol";
import { scheduleEnvelopeId } from "../src";
import { boot, cleanupAll, DAY, HOUR, registerTestPresets, T0, tool, TOOLSETS, waitFor } from "./helpers";

afterEach(cleanupAll);

function expectNgError(fn: () => unknown, code: string, pattern?: RegExp): void {
  try {
    fn();
  } catch (err) {
    expect(isNgError(err), String(err)).toBe(true);
    expect((err as { code: string }).code).toBe(code);
    if (pattern) expect((err as Error).message).toMatch(pattern);
    return;
  }
  throw new Error(`expected NgError(${code})`);
}

/** A worker whose code processor starts a long job and parks (the job keeps running between Runs). */
const startJob: CodeProcessor = {
  name: "test.start_job",
  async run({ snapshot, ports, args }) {
    if (snapshot.batch.envelopes.some((e) => e.type === PAYLOAD.cellTask)) {
      await ports.workspace.startJob({ command: String(args["command"] ?? "sleep 30") });
      return "yielded_waiting";
    }
    await ports.context.commit(ports.self.cellId, { statePatches: { [`woke:${snapshot.runId}`]: snapshot.batch.envelopes.map((e) => e.type) } });
    return "completed";
  },
};

/** Spawns a grandchild asking for everything (on its task only); records what it got. */
const greedySpawner: CodeProcessor = {
  name: "test.greedy",
  async run({ snapshot, ports }) {
    // Woken again by the grandchild's result: done (spawning on every wake-up would never end).
    if (!snapshot.batch.envelopes.some((e) => e.type === PAYLOAD.cellTask)) return "completed";
    try {
      const addr = await ports.spawnCell(
        {
          preset: "worker",
          title: "greedy grandchild",
          processor: { kind: "code", entry: "test.idle" },
          bounds: { tools: new Set(["read", "write", "edit", "bash", "code_rpc"]), canSendTo: ["channel:*", "inbox:*"] as unknown as Address[], secretRefs: new Set(["github"]), isolation: "none", maxDepth: 9, maxTokens: 1e12, maxCents: 1e9 },
        },
        "go",
      );
      await ports.context.commit(ports.self.cellId, { statePatches: { spawned: addr } });
    } catch (err) {
      await ports.context.commit(ports.self.cellId, { statePatches: { spawnError: (err as Error).message } });
    }
    return "completed";
  },
};

const idle: CodeProcessor = { name: "test.idle", run: async () => "completed" };

function setupWith(...procs: CodeProcessor[]) {
  return (registry: Registry) => {
    registerTestPresets(registry);
    for (const p of procs) registry.codeProcessors.register(p);
  };
}

describe("root cells", () => {
  it("must have positive budgets; omitted fields come from the kernel's root defaults", async () => {
    const h = await boot({ desk: false });
    expectNgError(() => h.kernel.createRootCell({ id: "r0", preset: "inline" }, { bounds: { maxTokens: 0 } }), "invalid_argument", /positive maxTokens and maxCents/);
    // A full PolicyBounds built with makeBounds() has zero budgets: exactly the trap this guards against.
    expectNgError(() => h.kernel.createRootCell({ id: "r1", preset: "inline" }, { bounds: makeBounds({ tools: ["read"] }) }), "invalid_argument");
    const desk = h.kernel.createRootCell({ id: "desk", preset: "inline" });
    expect(desk.bounds.maxTokens).toBeGreaterThan(0);
    expect(desk.bounds.maxCents).toBeGreaterThan(0);
    expect(desk.bounds.maxDepth).toBe(4); // DEFAULT_ROOT_BOUNDS
    expect(desk.bounds.isolation).toBe("none"); // the owner's machine
    // the preset's defaults (test "inline" desk: every toolset, persistent)
    expect(desk.spec).toMatchObject({ processor: { kind: "llm", toolsets: [TOOLSETS.context, TOOLSETS.comms, TOOLSETS.schedule, TOOLSETS.cells, TOOLSETS.workspace] }, lifetime: "persistent" });
    expect(desk.spec).not.toHaveProperty("cwdMode");
    expect(desk.spec.processor).not.toHaveProperty("allowedTools");
    expect(desk.spec).not.toHaveProperty("cwd"); // nobody gave it a directory
    expect(h.kernel.ensureRootCell({ id: "desk", preset: "inline" }).createdAt).toBe(desk.createdAt);
    expectNgError(() => h.kernel.createRootCell({ id: "desk", preset: "inline" }), "duplicate");
    expectNgError(() => h.kernel.createRootCell({ id: "x", preset: "inline" }, { principalId: "cell:desk" }), "bounds_violation");
    expectNgError(() => h.kernel.createRootCell({ id: "y", processor: { kind: "code", entry: "nope" } }), "not_found", /code processor "nope"/);
  });
});

describe("spawnCell", () => {
  it("attenuates: a child never gets more than its parent, whatever it asks for, and spawning from a Run is held to the same rule", async () => {
    const h = await boot({ setup: setupWith(greedySpawner, idle), desk: false });
    h.kernel.createRootCell(
      { id: "desk", preset: "inline" },
      { bounds: { tools: ["read", "write"], canSendTo: ["channel:ui:*"], isolation: "git_worktree", maxDepth: 2, maxConcurrentChildren: 3, maxTokens: 50_000, maxCents: 100 } },
    );
    h.kernel.spawnCell(
      "desk",
      {
        id: "child",
        preset: "inline",
        // one-shot: the kernel closes it once it is done, which waits for its child (the maxDepth it asks for: it gets 1)
        lifetime: "one_shot",
        processor: { kind: "code", entry: "test.greedy" },
        bounds: { tools: new Set(["read", "write", "bash"]), canSendTo: ["channel:*"] as unknown as Address[], secretRefs: new Set(["github"]), isolation: "none", maxDepth: 7, maxTokens: 1e9, maxCents: 1e6, maxConcurrentChildren: 99 },
      },
      "go",
    );
    const child = h.kernel.getCell("child")!;
    expect(serializeBounds(child.bounds)).toEqual({
      tools: ["read", "write"],
      canSendTo: ["channel:ui:*", "inbox:desk"], // asked for channel:*, got the parent's narrower channel:ui:*
      secretRefs: [],
      isolation: "git_worktree",
      maxConcurrentChildren: 3,
      maxTokens: 50_000,
      maxCents: 100,
      maxDepth: 1,
    });
    expect(child.spec.bounds).toMatchObject({ tools: ["bash", "read", "write"] }); // the request, kept readable

    await h.kernel.idle();
    const addr = h.kernel.context.readStateSync<string>("child", "spawned");
    expect(addr).toMatch(/^inbox:cell_/);
    const grand = h.kernel.getCell(addr!.slice("inbox:".length))!;
    expect(grand.principalId).toBe("cell:child");
    // ⊆ the child: the child's inbox and every inbox pattern the child holds (inherited, asked for or not), plus the
    // intersection of the channels it asked for with what the child may reach
    expect(serializeBounds(grand.bounds)).toMatchObject({
      tools: ["read", "write"],
      canSendTo: ["channel:ui:*", "inbox:child", "inbox:desk"],
      secretRefs: [],
      isolation: "git_worktree",
      maxDepth: 0,
    });
    // the one-shot child closed only after its grandchild's turn was over (closing cascades; it waits for children at
    // work); the grandchild, a dormant worker by then, was archived with it — completed, not cancelled
    expect(grand).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.kernel.getCell("child")).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.of("run.started").filter((e) => e.cellId === "child")).toHaveLength(2);
  });

  it("enforces maxConcurrentChildren on leaf children at work only and frees the slot on close", async () => {
    const h = await boot({ setup: setupWith(idle), desk: false });
    h.kernel.createRootCell({ id: "desk", preset: "inline" }, { bounds: { maxConcurrentChildren: 2 } });
    // a timer of its own keeps each worker "waiting" (not dormant), so it holds a slot
    const spec = { preset: "worker" as const, processor: { kind: "code" as const, entry: "test.idle" }, schedules: [{ deliverAt: T0 + DAY }] };
    const a = h.kernel.spawnCell("desk", spec);
    const b = h.kernel.spawnCell("desk", spec);
    expect([a, b].map((x) => h.kernel.activityOf([x.slice(6)]).get(x.slice(6))!.state)).toEqual(["waiting", "waiting"]);
    expectNgError(() => h.kernel.spawnCell("desk", spec), "bounds_violation", /already has 2 children at work \(maxConcurrentChildren 2\)/);
    // docs/05 §3.1: the cap is on execution — persistent children (projects, hubs) never take a slot ...
    const proj = h.kernel.spawnCell("desk", { preset: "project", processor: { kind: "code", entry: "test.idle" } });
    h.kernel.spawnCell("desk", { preset: "hub", processor: { kind: "code", entry: "test.idle" } });
    expect(h.kernel.getCell(proj.slice(6))!.spec.lifetime).toBe("persistent");
    expectNgError(() => h.kernel.spawnCell("desk", spec), "bounds_violation", /already has 2 children at work/);
    // ... and neither does a paused leaf
    h.kernel.control(a.slice(6), { action: "pause" });
    const c = h.kernel.spawnCell("desk", spec);
    expectNgError(() => h.kernel.spawnCell("desk", spec), "bounds_violation", /already has 2 children at work/);
    await h.kernel.closeCell(b.slice(6), "completed");
    expect(() => h.kernel.spawnCell("desk", spec)).not.toThrow();
    expect(h.kernel.listCells({ parentId: "desk", status: ["active"] }).filter((x) => x.spec.lifetime === "wakeable").map((x) => x.id)).toHaveLength(2);
    expect(h.kernel.getCell(c.slice(6))!.status).toBe("active");
  });

  it("maxDepth 0: no children, and the spawn tools are not even offered to the model", async () => {
    const h = await boot({ desk: false });
    h.kernel.createRootCell({ id: "desk", preset: "inline" }, { bounds: { maxDepth: 1 } });
    h.kernel.spawnCell("desk", { id: "leaf", preset: "worker", processor: { kind: "llm", toolsets: ["kernel.cells", "kernel.comms"] } }, "do it");
    expect(h.kernel.getCell("leaf")!.bounds.maxDepth).toBe(0);
    expectNgError(() => h.kernel.spawnCell("leaf", { preset: "worker" }), "bounds_violation", /maxDepth 0/);
    await h.kernel.idle();
    const [req] = h.script.callsOf("worker");
    expect(req!.tools.map((t) => t.name)).not.toContain("spawn_cell");
  });

  it("a fork_prefix child records the parent's evidence position; meta.projectCellId is inherited", async () => {
    const h = await boot({ setup: setupWith(idle) });
    h.script.add("desk", { text: "let me think" });
    await h.ui.capture({ text: "讨论一下这个 bug" });
    await h.kernel.idle();
    const upto = h.kernel.context.lastEvidenceSeqSync("desk");
    expect(upto).toBeGreaterThan(0);
    h.kernel.spawnCell("desk", { id: "proj", preset: "project", processor: { kind: "code", entry: "test.idle" }, meta: { projectCellId: "proj" } });
    h.kernel.spawnCell("proj", { id: "fix", preset: "worker", contextMode: "fork_prefix", processor: { kind: "code", entry: "test.idle" } });
    expect(h.kernel.getCell("fix")!.spec).toMatchObject({ fork: { fromCellId: "proj", uptoSeq: 0 }, meta: { projectCellId: "proj" }, parentId: "proj" });
    h.kernel.spawnCell("desk", { id: "fork2", preset: "worker", contextMode: "fork_prefix", processor: { kind: "code", entry: "test.idle" } });
    expect(h.kernel.getCell("fork2")!.spec.fork).toEqual({ fromCellId: "desk", uptoSeq: upto });
  });
});

describe("updateCell", () => {
  it("owner may widen within the parent (授权 1 对 1 直连); a cell may only narrow; narrowing cascades down", async () => {
    const h = await boot({ setup: setupWith(idle) });
    // given spawn depth (a worker has none by default) so the narrowing can be seen to cascade
    h.kernel.spawnCell("desk", { id: "w", preset: "inline", processor: { kind: "code", entry: "test.idle" }, bounds: { maxDepth: 1 } });
    h.kernel.spawnCell("w", { id: "ww", preset: "worker", processor: { kind: "code", entry: "test.idle" }, bounds: { tools: new Set(["read", "bash"]) } });
    // the desk holds `inbox:*` (DEFAULT_ROOT_BOUNDS): internal messaging inside the tree is inherited; no channel unasked
    expect(h.kernel.getCell("w")!.bounds.canSendTo).toEqual(["inbox:*"]);
    expect(h.kernel.getCell("ww")!.bounds.canSendTo).toEqual(["inbox:*"]);

    // owner grants the direct line + a thread watch
    h.kernel.updateCell("w", { bounds: { canSendTo: ["inbox:desk", "channel:ui:owner"] }, watches: [{ threadOrFilter: { thread: "ui:direct-w" } }] });
    expect(h.kernel.getCell("w")!.bounds.canSendTo).toEqual(["channel:ui:owner", "inbox:*"]);

    // the parent cell can narrow (the channel is gone) but not widen (channel:memory:* is not granted); the inbox
    // patterns the parent holds stay, whatever it asks
    h.kernel.updateCell("w", { bounds: { canSendTo: ["inbox:desk", "channel:memory:*"] } }, { principalId: "cell:desk" });
    expect(h.kernel.getCell("w")!.bounds.canSendTo).toEqual(["inbox:*"]);
    h.kernel.updateCell("w", { bounds: { tools: new Set(["read"]) } }, { principalId: "cell:desk" });
    expect([...h.kernel.getCell("w")!.bounds.tools]).toEqual(["read"]);
    // ...and the grandchild follows
    expect([...h.kernel.getCell("ww")!.bounds.tools]).toEqual(["read"]);

    // docs/05 §5.1.2: a cell may change its own title/meta/watches/schedules — never what it may do
    expect(h.kernel.updateCell("w", { title: "x", watches: [{ threadOrFilter: { thread: "ui:direct-w2" } }] }, { principalId: "cell:w" }).title).toBe("x");
    expect(h.count("cell_watches WHERE cell_id = 'w' AND active = 1 AND thread = 'ui:direct-w2'")).toBe(1);
    expectNgError(
      () => h.kernel.updateCell("w", { bounds: { canSendTo: ["channel:ui:owner"] } }, { principalId: "cell:w" }),
      "bounds_violation",
      /a cell may change its own title, meta, watches, schedules, cwd only, not bounds/,
    );
    expectNgError(() => h.kernel.updateCell("w", { processor: { kind: "code", entry: "test.idle" } }, { principalId: "cell:w" }), "bounds_violation", /not processor/);
    // ...and nothing of a cell that is not its descendant (a child may not touch its parent)
    expectNgError(() => h.kernel.updateCell("w", { title: "y" }, { principalId: "cell:ww" }), "bounds_violation", /own descendants/);
    expect(h.kernel.getCell("w")!.title).toBe("x");
    expectNgError(() => h.kernel.updateCell("w", { preset: "watcher" }), "invalid_argument", /cannot change "preset"/);
  });

  it("replaces watches; schedules are diffed so an unchanged timer is untouched and a removed one is cancelled", async () => {
    const h = await boot({ setup: setupWith(idle) });
    const keep = { deliverAt: T0 + DAY };
    const drop = { deliverAt: T0 + 2 * DAY, cancelGroup: "x" };
    const cron = { cron: "0 9 * * 1" };
    h.kernel.spawnCell("desk", { id: "s", preset: "worker", processor: { kind: "code", entry: "test.idle" }, schedules: [keep, drop, cron], watches: [{ threadOrFilter: { thread: "memory:a" } }] });
    const keepId = scheduleEnvelopeId("s", keep);
    const keepRow = h.kernel.inbox.listMessagesSync({ cellId: "s", envelopeId: keepId })[0]!;
    expect(keepRow.status).toBe("pending");
    expect(h.kernel.inbox.listSchedulesSync({ cellId: "s", activeOnly: true })).toHaveLength(1);

    const added = { deliverAt: T0 + 3 * DAY };
    h.kernel.updateCell("s", { schedules: [keep, added], watches: [{ threadOrFilter: { thread: "memory:b" } }] });
    expect(h.kernel.inbox.listMessagesSync({ cellId: "s", envelopeId: keepId })[0]).toEqual(keepRow);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "s", envelopeId: scheduleEnvelopeId("s", drop) })[0]!.status).toBe("cancelled");
    expect(h.kernel.inbox.listSchedulesSync({ cellId: "s", activeOnly: true })).toHaveLength(0);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "s", envelopeId: scheduleEnvelopeId("s", added) })[0]!.status).toBe("pending");
    expect(h.count("cell_watches WHERE cell_id = 's' AND active = 1 AND thread = 'memory:b'")).toBe(1);
    expect(h.count("cell_watches WHERE cell_id = 's' AND active = 1")).toBe(1);

    // a removed deliverAt rule that comes back gets a fresh row instead of being swallowed by dedupe
    h.kernel.updateCell("s", { schedules: [keep, added, drop] });
    const again = h.kernel.inbox.listMessagesSync({ cellId: "s", status: ["pending"] }).map((m) => m.envelope.id);
    expect(again).toContain(`${scheduleEnvelopeId("s", drop)}~1`);
  });
});

describe("closeCell", () => {
  it("cascade leaves nothing running: no pending rows, schedules, watches, approvals or jobs; the directory is left as it was; late results are dropped", async () => {
    const h = await boot({ setup: setupWith(startJob, idle) });
    h.kernel.spawnCell("desk", { id: "proj", preset: "project", processor: { kind: "code", entry: "test.idle" }, meta: { projectCellId: "proj" } });
    h.kernel.spawnCell("proj", {
      id: "watch",
      preset: "watcher",
      processor: { kind: "code", entry: "test.idle" },
      watches: [{ threadOrFilter: { thread: "memory:t1" }, cancelGroup: "w" }],
      schedules: [{ deliverAt: T0 + DAY, cancelGroup: "timeout" }, { cron: "*/5 * * * *" }],
    });
    h.kernel.spawnCell("proj", { id: "build", preset: "worker", processor: { kind: "code", entry: "test.start_job", args: { command: "sleep 30" } } }, "build it");
    await h.kernel.idle();
    await waitFor(() => h.kernel.workspace.listJobsSync({ cellId: "build", state: ["running"] }).length === 1, 10_000, "job running");
    // docs/05: a host cell nobody gave a directory works in the kernel's own per-cell directory
    const dir = h.kernel.workspace.getWorkspaceSync("build")!.path!;
    expect(dir).toBe(join(h.dataDir, "cells", "build"));
    expect(existsSync(dir)).toBe(true);
    writeFileSync(join(dir, "work.txt"), "unfinished");
    // a pending card and a queued message in the subtree
    const r = h.kernel.gate.authorizeSync(
      { type: "custom", name: "x", summary: "decide", subjectKey: "project:proj", sideEffect: "external" },
      { cellId: "watch", principalId: "cell:watch", epoch: 0 },
    );
    expect(r.type).toBe("defer");
    h.kernel.control("watch", { action: "pause" });
    await h.memory.inject({ from: "carol", text: "route to desk while paused", threads: ["memory:t1"] });
    const epochs = Object.fromEntries(["proj", "watch", "build"].map((id) => [id, h.kernel.getCell(id)!.epoch]));

    const res = await h.kernel.closeCell("proj", "cancelled");
    expect(res.closed.sort()).toEqual(["build", "proj", "watch"]);
    const ids = ["proj", "watch", "build"];
    for (const id of ids) {
      const c = h.kernel.getCell(id)!;
      expect(c.status).toBe("closed");
      expect(c.epoch).toBeGreaterThan(epochs[id]!);
    }
    const inList = `(${ids.map((i) => `'${i}'`).join(",")})`;
    expect(h.count(`inbox_messages WHERE cell_id IN ${inList} AND status IN ('pending','claimed')`)).toBe(0);
    expect(h.count(`inbox_schedules WHERE cell_id IN ${inList} AND active = 1`)).toBe(0);
    expect(h.count(`cell_watches WHERE cell_id IN ${inList} AND active = 1`)).toBe(0);
    expect(h.count(`approvals WHERE cell_id IN ${inList} AND status = 'pending'`)).toBe(0);
    expect(h.kernel.workspace.listJobsSync({ state: ["running"] })).toEqual([]);
    expect(h.kernel.workspace.listJobsSync({ cellId: "build" }).map((j) => j.state)).toEqual(["cancelled"]);
    // guard 4: closing stops the runtime only — the directory, its files and the workspace record stay
    expect(h.kernel.workspace.getWorkspaceSync("build")!.status).toBe("active");
    expect(readFileSync(join(dir, "work.txt"), "utf8")).toBe("unfinished");

    // the killed job's late result arrived and died on the closed cell; nothing ran again
    await waitFor(() => h.kernel.inbox.listMessagesSync({ cellId: "build", type: PAYLOAD.jobResult }).length === 1, 10_000, "job result");
    const late = h.kernel.inbox.listMessagesSync({ cellId: "build", type: PAYLOAD.jobResult })[0]!;
    expect(["cancelled", "dropped_epoch"]).toContain(late.status);
    // the timers never fire and the watch no longer routes
    const subtreeRuns = () => h.of("run.started").filter((e) => ids.includes(e.cellId)).length;
    const before = subtreeRuns();
    h.clock.advance(2 * DAY);
    await h.memory.inject({ from: "carol", text: "after close", threads: ["memory:t1"] });
    await h.kernel.idle();
    expect(subtreeRuns()).toBe(before);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "watch", status: ["pending"] })).toEqual([]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage }).map((m) => (m.envelope.payload as { text: string }).text)).toEqual([
      "route to desk while paused", "after close",
    ]);
  });

  it("a cancelled worker's Job is killed and its late job.result is dropped by the epoch (control cancel)", async () => {
    const h = await boot({ setup: setupWith(startJob) });
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", processor: { kind: "code", entry: "test.start_job", args: { command: "sleep 30" } } }, "go");
    await h.kernel.idle();
    await waitFor(() => h.kernel.workspace.listJobsSync({ cellId: "w", state: ["running"] }).length === 1, 10_000, "job running");
    const t0 = Date.now();
    expect(h.kernel.control("w", { action: "cancel" })).toMatchObject({ applied: true });
    await h.kernel.idle({ jobs: true });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(h.kernel.getCell("w")).toMatchObject({ status: "closed", closeReason: "cancelled" });
    const [job] = h.kernel.workspace.listJobsSync({ cellId: "w" });
    expect(job!.state).toBe("cancelled");
    await waitFor(() => h.kernel.inbox.listMessagesSync({ cellId: "w", type: PAYLOAD.jobResult }).length === 1, 10_000, "job result");
    expect(h.kernel.inbox.listMessagesSync({ cellId: "w", type: PAYLOAD.jobResult })[0]!.status).not.toBe("done");
    expect(h.of("run.started").filter((e) => e.cellId === "w")).toHaveLength(1);
    // the desk learns that its child went away without a result
    const res = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult });
    expect(res.map((m) => (m.envelope.payload as CellResultPayload).status)).toEqual(["cancelled"]);
  });

  it("a child's reported result reaches the parent even when it is closed right after; only someone else's close is announced", async () => {
    const h = await boot({ setup: setupWith(idle) });
    const results = () => h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => (m.envelope.payload as CellResultPayload).summary);
    // a one-shot probe: the kernel delivers its single final result and closes it in the same transaction
    h.script.add("watcher", tool("report_to_parent", { kind: "result", text: "做完了" }));
    h.kernel.spawnCell("desk", { id: "a", preset: "watcher" }, "work");
    await h.kernel.idle();
    expect(h.kernel.getCell("a")).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => m.envelope.id)).toEqual([finalResultEnvelopeId("a", 0)]);
    expect(await h.kernel.closeCell("a", "completed")).toEqual({ closed: [] });
    expect(results()).toEqual(["做完了"]);

    // a wakeable worker reports its turn and stays; when the owner closes it later the parent is told it is gone, and
    // that its turns were already reported (no result is outstanding)
    h.script.add("worker", tool("report_to_parent", { kind: "result", text: "第一轮完成" }));
    h.kernel.spawnCell("desk", { id: "w", preset: "worker" }, "work");
    await h.kernel.idle();
    expect(h.kernel.getCell("w")!.status).toBe("active");
    await h.kernel.closeCell("w", "completed");
    expect(results()).toEqual(["做完了", "第一轮完成", "Closed (completed) by owner; its turns were already reported."]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", envelopeId: "w:0:closed" })[0]!.envelope.payload).toMatchObject({
      status: "completed",
      childState: "closed",
      data: { closedBy: "owner", synthetic: true },
    });

    // a persistent child reports an interim result at once and stays open; when the owner closes it later the parent is
    // told — an earlier phase report is not the cell's final word
    h.script.add("p", tool("report_to_parent", { kind: "result", text: "阶段一完成" }));
    h.kernel.spawnCell("desk", { id: "p", preset: "worker", lifetime: "persistent", meta: { role: "p" } }, "phase one");
    await h.kernel.idle();
    expect(h.kernel.getCell("p")!.status).toBe("active");
    await h.kernel.closeCell("p", "completed");
    expect(results().slice(3)).toEqual(["阶段一完成", "Closed (completed) by owner before it reported a result."]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", envelopeId: "p:0:closed" })).toHaveLength(1);

    // the parent closing its own child: no synthetic report
    h.kernel.spawnCell("desk", { id: "b", preset: "worker", processor: { kind: "code", entry: "test.idle" } });
    await h.kernel.closeCell("b", "completed", { principalId: "cell:desk" });
    expect(results()).toHaveLength(5);
    // the owner closing it: the parent is told
    h.kernel.spawnCell("desk", { id: "c", preset: "worker", processor: { kind: "code", entry: "test.idle" } });
    await h.kernel.closeCell("c", "completed");
    expect(results()).toHaveLength(6);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", envelopeId: "c:0:closed" })[0]!.envelope.payload).toMatchObject({ status: "completed", data: { synthetic: true } });

    // closing twice is a no-op; a non-ancestor cell may not close
    expect(await h.kernel.closeCell("c")).toEqual({ closed: [] });
    h.kernel.spawnCell("desk", { id: "d", preset: "worker", processor: { kind: "code", entry: "test.idle" } });
    await expect(h.kernel.closeCell("d", "cancelled", { principalId: "cell:a" })).rejects.toThrow(/own descendants/);
    expect(HOUR).toBeGreaterThan(0);
  });
});
