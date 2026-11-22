import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CELL_RESULT_CANDIDATE_KEY,
  PAYLOAD,
  subjectKeys,
  type ActivityRecord,
  type CellResultCandidate,
  type CellResultPayload,
  type CodeProcessor,
  type Registry,
} from "@ng/protocol";
import { boot, cleanupAll, registerTestPresets, T0, tool } from "./helpers";

afterEach(cleanupAll);

describe("docs/03 §四 — five granularities through the real primitives", () => {
  it("① a personal zero-side-effect item: done directly, light owner notice, no card", async () => {
    const h = await boot();
    const activity: ActivityRecord = { id: "a1", kind: "note_saved", title: "阅读清单：https://example.com/post", at: T0, restorable: true };
    h.script.add(
      "desk",
      tool("set_state", { patches: { "memo:a1": activity } }),
      tool("send_message", { to:"channel:ui:owner", text: "已存入阅读清单", summary: "note saved" }),
      { text: "done" },
    );
    await h.ui.capture({ text: "把这篇链接存进阅读清单 https://example.com/post" });
    await h.kernel.idle();

    expect(h.kernel.gate.listPendingSync({ includeSnoozed: true })).toEqual([]);
    expect(h.kernel.context.readStateSync("desk", "memo:a1")).toMatchObject({ kind: "note_saved" });
    const notices = h.kernel.hub.listNotificationsSync();
    expect(notices.map((n) => n.content.body)).toEqual(["已存入阅读清单"]);
    expect(h.of("run.finished").map((e) => e.outcome)).toEqual(["completed"]);
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
        // this ends the Run; the kernel tells the desk the worker's turn settled, with this as its result
        return tool("report_to_parent", { kind: "result", text: "测试全部通过 (built-ok)" });
      },
    );
    // nothing left for the desk to clean up: it just takes note
    h.script.add("desk", { text: "收到" });

    await h.ui.capture({ text: "帮我把全量测试跑一下" });
    await h.kernel.idle({ jobs: true });
    await h.kernel.idle();

    const worker = h.kernel.getCell(workerId())!;
    // the worker rests: active, nothing in flight, ready to be woken with everything it knows
    expect(worker).toMatchObject({ status: "active", preset: "worker" });
    expect(h.kernel.activityOf([worker.id]).get(worker.id)!.state).toBe("dormant");
    // docs/05: on the host, in the kernel's own directory for it (nobody gave it one) — no scratch repository, no
    // worktree; the directory and the workspace record stay with it
    expect(worker.bounds.isolation).toBe("none");
    expect(existsSync(join(h.dataDir, "base-repo"))).toBe(false);
    const ws = h.kernel.workspace.getWorkspaceSync(worker.id)!;
    expect(ws).toMatchObject({ status: "active", path: join(h.dataDir, "cells", worker.id) });
    expect(existsSync(ws.path!)).toBe(true);

    const jobs = h.kernel.workspace.listJobsSync({ cellId: worker.id });
    expect(jobs.map((j) => j.state)).toEqual(["succeeded"]);
    const runs = h.of("run.started").filter((e) => e.cellId === worker.id).map((e) => e.runId);
    const results = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult });
    expect(results.map((m) => [m.envelope.id, (m.envelope.payload as CellResultPayload).summary, (m.envelope.payload as CellResultPayload).childState, m.status])).toEqual([
      [`${worker.id}:${runs[1]}:settled`, "测试全部通过 (built-ok)", "dormant", "done"],
    ]);
    // worker: task Run (yielded: a job will wake it — no notice) + job.result Run (completed: its turn settled)
    expect(h.of("run.finished").filter((e) => e.cellId === worker.id).map((e) => e.outcome)).toEqual(["yielded_waiting", "completed"]);
    expect(h.script.queues.get("worker")).toEqual([]); // report_to_parent ended the Run: no further model call
    // desk: spawn + "已派出" (yielded: the child will wake it), then "收到" on the result
    expect(h.script.callsOf("desk")).toHaveLength(3);
    expect(h.of("run.finished").filter((e) => e.cellId === "desk").map((e) => e.outcome)).toEqual(["yielded_waiting", "completed"]);
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
      async run({ snapshot, ports, clock }) {
        const task = snapshot.batch.envelopes.find((e) => e.type === PAYLOAD.cellTask);
        if (!task) return "completed";
        const i = (task.payload as { input: { i: number } }).input.i;
        // A child stages its result; the kernel delivers it once when its turn settles (docs/05 guard 1).
        const candidate: CellResultCandidate = { status: "completed", summary: `item ${i}`, at: clock.now() };
        await ports.context.commit(ports.self.cellId, { statePatches: { [CELL_RESULT_CANDIDATE_KEY]: candidate } });
        if (i === 0) {
          // a second report through the raw port: for a leaf it only refreshes the staged candidate
          const dup: CellResultPayload = { childCellId: ports.self.cellId, status: "completed", summary: `item ${i}` };
          await ports.emitToParent(PAYLOAD.cellResult, dup);
        }
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
      // a project coordinates and persists (a one-shot cell would be closed — its card revoked — by its next completed Run)
      { id: "proj1", preset: "project", title: "竞品调研", processor: { kind: "code", entry: "test.join_all", args: { n: N } }, meta: { projectCellId: "proj1" } },
      "fan out",
    );
    await h.kernel.idle();

    const pending = h.kernel.gate.listPendingSync({ includeSnoozed: true });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ cellId: "proj1", subjectKey: "project:proj1" });
    const children = h.kernel.listCells({ parentId: "proj1" });
    expect(children).toHaveLength(N);
    expect(children.every((c) => c.status === "closed" && c.spec.meta?.["projectCellId"] === "proj1")).toBe(true);
    expect(h.kernel.context.listStateSync("proj1", "result:").map((e) => e.value).sort()).toEqual(["item 0", "item 1", "item 2"]);
    // exactly one result per child, under the id of its one settled turn — the double report of child 0 produced no
    // second message
    const runsOf = (cellId: string) => h.of("run.started").filter((e) => e.cellId === cellId).map((e) => e.runId);
    expect(children.map((c) => runsOf(c.id).length)).toEqual(Array(N).fill(1));
    const got = h.kernel.inbox.listMessagesSync({ cellId: "proj1", type: PAYLOAD.cellResult }).map((m) => m.envelope.id);
    expect(got.sort()).toEqual(children.map((c) => `${c.id}:${runsOf(c.id)[0]}:settled`).sort());

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
    expect(h.kernel.gate.listPendingSync({ includeSnoozed: true }).map((a) => a.actionId)).toEqual([pending[0]!.actionId]);
    expect(h.kernel.getCell("proj1")!.status).toBe("active");
    // zero tokens: the join never called the model
    expect(h.script.requests.filter((r) => r.cellId === "proj1")).toEqual([]);
  });

});
