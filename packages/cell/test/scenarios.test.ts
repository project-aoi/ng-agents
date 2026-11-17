import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PAYLOAD,
  asClarifyCard,
  gtdKeys,
  subjectKeys,
  type ActivityRecord,
  type CellResultPayload,
  type CodeProcessor,
  type Registry,
} from "@ng/protocol";
import { boot, cleanupAll, DAY, registerTestPresets, T0, tool } from "./helpers";

afterEach(cleanupAll);

describe("docs/03 §四 — five granularities through the real primitives", () => {
  it("① a personal zero-side-effect item: done directly, light owner notice, no card", async () => {
    const h = await boot();
    const activity: ActivityRecord = { id: "a1", kind: "note_saved", title: "阅读清单：https://example.com/post", at: T0, restorable: true };
    h.script.add(
      "desk",
      tool("set_state", { patches: { [gtdKeys.activity("a1")]: activity } }),
      tool("send_message", { to: "channel:ui:owner", text: "已存入阅读清单", summary: "note saved" }),
      { text: "done" },
    );
    await h.ui.capture({ text: "把这篇链接存进阅读清单 https://example.com/post" });
    await h.kernel.idle();

    expect(h.kernel.gate.listPendingSync({ includeSnoozed: true })).toEqual([]);
    expect(h.kernel.context.readStateSync("desk", gtdKeys.activity("a1"))).toMatchObject({ kind: "note_saved" });
    const notices = h.kernel.hub.listOutboxSync({ channelId: "ui" });
    expect(notices.map((n) => [n.status, n.content.body])).toEqual([["sent", "已存入阅读清单"]]);
    expect(h.of("run.finished").map((e) => e.outcome)).toEqual(["completed"]);
  });

  it("② an outward reply: draft → one card bound to v1; a stale click is refused, the current version is sent", async () => {
    const h = await boot();
    h.script.add("desk", tool("send_message", { to: "channel:memory:alice", text: "议程草稿 v1", summary: "reply to Alice", targetLabel: "Alice" }));
    await h.memory.inject({ from: "alice", text: "能帮我看下明天会议的议程吗？" });
    await h.kernel.idle();

    const [card] = h.kernel.gate.listPendingSync();
    expect(card).toBeDefined();
    expect(h.kernel.gate.listPendingSync()).toHaveLength(1);
    expect(asClarifyCard(card!.card.data)?.cardType).toBe("response");
    expect(card!.boundVersion).toBe(1);
    expect(h.of("run.finished").map((e) => e.outcome)).toEqual(["deferred_for_approval"]);
    expect(h.memory.deliveries).toEqual([]);

    // The owner edits the draft (Engage editor) → v2; a click carrying the old version must not send anything.
    const artifactId = card!.artifactId!;
    expect(h.kernel.context.commitSync("desk", { artifact: { artifactId, content: { format: "text", body: "议程 v2（我改过）" }, updatedBy: "human", expectedVersion: 1 } })).toEqual({ ok: true, artifactVersion: 2 });
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", seenArtifactVersion: 1 })).toEqual({
      status: "version_mismatch",
      actionId: card!.actionId,
      currentVersion: 2,
    });
    expect(h.memory.deliveries).toEqual([]);

    h.script.add("desk", { text: "noted" });
    const r = await h.kernel.resolveApproval(card!.actionId, { decision: "approve", seenArtifactVersion: 2 });
    expect(r).toEqual({ status: "sent", actionId: card!.actionId, artifactVersion: 2 });
    expect(h.memory.sent.map((d) => [d.target, d.content.body])).toEqual([["alice", "议程 v2（我改过）"]]);
    expect(h.kernel.gate.getApprovalSync(card!.actionId)).toMatchObject({ status: "executed", humanEdited: true, outcome: { receipt: "sent" } });

    // The owning cell learns the outcome and runs once more.
    await h.kernel.idle();
    const resolved = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved });
    expect(resolved.map((m) => [m.status, (m.envelope.payload as { status: string }).status])).toEqual([["done", "executed"]]);

    // A second click is idempotent: same receipt, nothing re-sent.
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", seenArtifactVersion: 2 })).toMatchObject({ status: "sent" });
    expect(h.memory.deliveries).toHaveLength(1);
  });

  it("③ slow work: the desk spawns a worker at once; its Job outlives the Run; the result wakes it; it reports to the parent", async () => {
    const h = await boot();
    const workerId = () => h.kernel.listCells({ parentId: "desk" })[0]!.id;
    h.script.add("desk", tool("spawn_cell", { preset: "worker", title: "跑全量测试", instruction: "run the suite and report" }), { text: "已派出" });
    h.script.add(
      "worker",
      tool("job_start", { command: "sleep 0.2; echo built-ok" }),
      { text: "job started" },
      // woken by job.result
      (req) => {
        const text = JSON.stringify(req.messages);
        expect(text).toContain("built-ok");
        return tool("report_to_parent", { kind: "result", text: "测试全部通过 (built-ok)" });
      },
      { text: "reported" },
    );
    h.script.add("desk", () => tool("close_cell", { cellId: workerId(), reason: "completed" }), { text: "closed" });

    await h.ui.capture({ text: "帮我把全量测试跑一下" });
    await h.kernel.idle({ jobs: true });
    await h.kernel.idle();

    const worker = h.kernel.getCell(workerId())!;
    expect(worker).toMatchObject({ status: "closed", closeReason: "completed", preset: "worker" });
    expect(worker.bounds.isolation).toBe("git_worktree");
    // The worktree branched from the lazily created scratch base repository and was removed on close.
    expect(existsSync(join(h.dataDir, "base-repo", ".git"))).toBe(true);
    const ws = h.kernel.workspace.getWorkspaceSync(worker.id)!;
    expect(ws.status).toBe("destroyed");
    expect(existsSync(ws.path!)).toBe(false);

    const jobs = h.kernel.workspace.listJobsSync({ cellId: worker.id });
    expect(jobs.map((j) => j.state)).toEqual(["succeeded"]);
    const results = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult });
    expect(results.map((m) => [(m.envelope.payload as CellResultPayload).summary, m.status])).toEqual([["测试全部通过 (built-ok)", "done"]]);
    // worker: task Run (yielded) + job.result Run — the latter may be cut short by the parent's close once it reported
    const outcomes = h.of("run.finished").filter((e) => e.cellId === worker.id).map((e) => e.outcome);
    expect(outcomes[0]).toBe("yielded_waiting");
    expect(["completed", "cancelled"]).toContain(outcomes[1]);
    expect(outcomes).toHaveLength(2);
  });

  it("④ fan-out N workers + a zero-token code join: exactly one card, duplicates and late results tolerated", async () => {
    const N = 3;
    const join: CodeProcessor = {
      name: "test.join_all",
      async run({ snapshot, ports, args }) {
        const self = ports.self.cellId;
        const n = Number(args["n"]);
        for (const env of snapshot.batch.envelopes) {
          if (env.type === PAYLOAD.cellTask) {
            for (let i = 0; i < n; i++) await ports.spawnCell({ preset: "worker", title: `调研 ${i}`, processor: { kind: "code", entry: "test.echo" } }, { instruction: "research", input: { i } });
          }
          if (env.type === PAYLOAD.cellResult) {
            const p = env.payload as CellResultPayload;
            await ports.context.commit(self, { statePatches: { [`result:${p.childCellId}`]: p.summary } });
          }
        }
        const got = await ports.context.listState(self, "result:");
        const carded = await ports.context.readState(self, "carded");
        if (got.length < n || carded) return "completed";
        const r = await ports.authorize({
          type: "custom",
          name: "summary",
          summary: `${got.length} 份调研已收齐`,
          subjectKey: subjectKeys.project(self),
          sideEffect: "external",
        });
        await ports.context.commit(self, { statePatches: { carded: true } });
        for (const c of ports.self.depth >= 0 ? got : []) await ports.closeCell(c.key.slice("result:".length), "completed");
        return r.type === "defer" ? "deferred_for_approval" : "completed";
      },
    };
    const echo: CodeProcessor = {
      name: "test.echo",
      async run({ snapshot, ports }) {
        const task = snapshot.batch.envelopes.find((e) => e.type === PAYLOAD.cellTask);
        if (!task) return "completed";
        const i = (task.payload as { input: { i: number } }).input.i;
        const result: CellResultPayload = { childCellId: ports.self.cellId, status: "completed", summary: `item ${i}` };
        await ports.emitToParent(PAYLOAD.cellResult, result);
        if (i === 0) await ports.emitToParent(PAYLOAD.cellResult, result); // a duplicate report
        return "completed";
      },
    };
    const h = await boot({
      setup(registry: Registry) {
        registerTestPresets(registry);
        registry.codeProcessors.register(join);
        registry.codeProcessors.register(echo);
      },
    });
    h.kernel.spawnCell(
      "desk",
      { id: "proj1", preset: "worker", title: "竞品调研", processor: { kind: "code", entry: "test.join_all", args: { n: N } }, meta: { projectCellId: "proj1" } },
      "fan out",
    );
    await h.kernel.idle();

    const pending = h.kernel.gate.listPendingSync({ includeSnoozed: true });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ cellId: "proj1", subjectKey: "project:proj1" });
    const children = h.kernel.listCells({ parentId: "proj1" });
    expect(children).toHaveLength(N);
    expect(children.every((c) => c.status === "closed" && c.spec.meta?.["projectCellId"] === "proj1")).toBe(true);
    expect(h.kernel.context.listStateSync("proj1", "result:")).toHaveLength(N);

    // A late duplicate after the card: still exactly one card.
    h.kernel.inbox.enqueueSync("proj1", {
      id: "late-dup",
      from: `inbox:${children[1]!.id}`,
      principalId: `cell:${children[1]!.id}`,
      kind: "result",
      type: PAYLOAD.cellResult,
      payload: { childCellId: children[1]!.id, status: "completed", summary: "item 1" },
      createdAt: h.clock.now(),
    });
    await h.kernel.idle();
    expect(h.kernel.gate.listApprovalsSync({ cellIds: ["proj1"] })).toHaveLength(1);
    // zero tokens: the join never called the model
    expect(h.script.requests.filter((r) => r.cellId === "proj1")).toEqual([]);
  });

  it("⑤ a watcher: thread reply bypasses the desk, cancels the timeout, reports once; the timeout never fires", async () => {
    const h = await boot();
    const watcherId = () => h.kernel.listCells({ parentId: "desk", preset: "watcher" })[0]!.id;
    h.script.add(
      "desk",
      tool("spawn_cell", {
        preset: "watcher",
        title: "等 Bob 回复报价",
        instruction: "wait for Bob's quote; nudge after a day",
        watches: [{ thread: "memory:thread-42", cancelGroup: "wait" }],
        schedules: [{ at: new Date(T0 + DAY).toISOString(), cancelGroup: "timeout" }],
      }),
      { text: "已安排跟进" },
    );
    h.script.add(
      "watcher",
      tool("wait", { reason: "waiting for Bob" }),
      // woken by Bob's reply
      tool("cancel_scheduled", { cancelGroup: "timeout" }),
      tool("report_to_parent", { kind: "result", text: "Bob 已回复：明天给报价" }),
      { text: "done" },
    );
    h.script.add("desk", { text: "记下了" });

    await h.ui.capture({ text: "帮我盯一下 Bob 的报价" });
    await h.kernel.idle();
    const w = watcherId();
    expect(h.kernel.inbox.listSchedulesSync({ cellId: w })).toEqual([]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: w, status: ["pending"] })).toHaveLength(1); // the timeout

    const before = h.of("run.finished").length;
    await h.memory.inject({ from: "bob", text: "收到，明天给你报价", threads: ["memory:thread-42"] });
    await h.kernel.idle();

    // routed by the watch: the desk never saw Bob's message
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage })).toHaveLength(1);
    expect(h.kernel.inbox.listMessagesSync({ cellId: w, type: PAYLOAD.userMessage }).map((m) => m.status)).toEqual(["done"]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: w, type: PAYLOAD.timerFired }).map((m) => m.status)).toEqual(["cancelled"]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => m.status)).toEqual(["done"]);
    expect(h.of("run.finished").length - before).toBe(2); // watcher + desk

    const runs = h.of("run.finished").length;
    h.clock.advance(2 * DAY);
    await h.kernel.idle();
    expect(h.of("run.finished").length).toBe(runs);
  });
});
