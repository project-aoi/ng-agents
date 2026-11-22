import { afterEach, describe, expect, it } from "vitest";
import {
  asClarifyCard,
  CELL_RESULT_CANDIDATE_KEY,
  finalResultEnvelopeId,
  PAYLOAD,
  type CellResultPayload,
  type CodeProcessor,
  type Envelope,
  type Registry,
} from "@ng/protocol";
import { isKernelEscalation } from "../src";
import { boot, cleanupAll, lastToolResult, registerTestPresets, requestText, tool, waitFor, type Harness } from "./helpers";

afterEach(cleanupAll);

// docs/05 guard 1 — "排空即关 · 已关明拒 · 幂等交付": a leaf's result — a one-shot probe's final one, a wakeable
// worker's notice for each settled turn — has exactly one sender (the dispatcher's settle transaction), it is sent only
// when the inbox is drained, and a cell that has closed says so to whoever writes.

const results = (h: Harness, parent = "desk") =>
  h.kernel.inbox.listMessagesSync({ cellId: parent, type: PAYLOAD.cellResult }).map((m) => ({ id: m.envelope.id, ...(m.envelope.payload as CellResultPayload) }));

/** A worker (wakeable leaf) with its own script queue (the role is what RoleScript keys on). */
function worker(h: Harness, id: string, task = "do it", extra: Record<string, unknown> = {}): void {
  h.kernel.spawnCell("desk", { id, preset: "worker", title: id, meta: { role: id }, ...extra }, task);
}

/** A one-shot probe (the watcher preset) with its own script queue. */
function probe(h: Harness, id: string, task = "check it"): void {
  h.kernel.spawnCell("desk", { id, preset: "watcher", title: id, meta: { role: id } }, task);
}

const runsOf = (h: Harness, cellId: string) => h.of("run.started").filter((e) => e.cellId === cellId).map((e) => e.runId);

function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

describe("leaf settlement", () => {
  it("delivers a one-shot probe's explicit result even when it arranged a wakeup earlier in this run", async () => {
    const h = await boot();
    probe(h, "probe");
    h.script.add("probe", tool("set_reminder", { label: "check later", inSeconds: 3600 }), tool("report_to_parent", { kind: "result", text: "all clear" }));
    await h.kernel.idle();
    expect(h.of("run.finished").filter(e => e.cellId === "probe")).toMatchObject([{ outcome: "yielded_waiting" }]);
    expect(results(h)).toMatchObject([{ childCellId: "probe", summary: "all clear" }]);
    expect(h.kernel.getCell("probe")?.status).toBe("closed");
  });

  it("two sibling workers report: one notice each under its own turn's id, both stay, nothing synthetic", async () => {
    const h = await boot();
    worker(h, "w1");
    worker(h, "w2");
    h.script.add("w1", tool("report_to_parent", { kind: "result", text: "w1 done", artifactId: "art_1" }));
    h.script.add("w2", tool("report_to_parent", { kind: "result", text: "w2 failed", status: "failed" }));
    await h.kernel.idle();

    const [r1] = runsOf(h, "w1");
    const [r2] = runsOf(h, "w2");
    expect(results(h).sort((a, b) => a.id.localeCompare(b.id))).toMatchObject([
      { id: `w1:${r1}:settled`, childCellId: "w1", status: "completed", summary: "w1 done", artifactId: "art_1", childState: "dormant", turn: { runId: r1, outcome: "completed", artifactIds: ["art_1"] } },
      { id: `w2:${r2}:settled`, childCellId: "w2", status: "failed", summary: "w2 failed", childState: "dormant", turn: { runId: r2, outcome: "failed" } },
    ]);
    expect([h.kernel.getCell("w1")!.status, h.kernel.getCell("w2")!.status]).toEqual(["active", "active"]);
    // The tool itself sent nothing: only the kernel's settle transaction did.
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk" }).filter((m) => m.envelope.id.endsWith(":closed"))).toEqual([]);
    // A replay of the same delivery (same cell, same turn) cannot produce a second result.
    const again = { ...(h.kernel.inbox.listMessagesSync({ cellId: "desk", envelopeId: `w1:${r1}:settled` })[0]!.envelope as Envelope) };
    expect(h.kernel.inbox.enqueueSync("desk", again)).toBe("deduped");
  });

  it("a follow-up that lands after a one-shot probe's report but before the settle: no stale result goes out, the probe stays, takes it, reports once and only then closes", async () => {
    const h = await boot();
    probe(h, "p1");
    h.script.add("p1", () => {
      // More to check arrives while the probe is producing its report (delivered: the probe is still open).
      expect(h.kernel.sendToCell("p1", { text: "also check the staging deploy" })).toMatchObject({ status: "delivered", targetStatus: "active" });
      return tool("report_to_parent", { kind: "result", text: "v1: prod deploy is green" });
    });
    h.script.add("p1", (req) => {
      expect(requestText(req)).toContain("also check the staging deploy");
      // Between the two Runs the parent saw nothing, and the first candidate is still on record.
      expect(results(h)).toEqual([]);
      expect(h.kernel.context.readStateSync("p1", CELL_RESULT_CANDIDATE_KEY)).toMatchObject({ summary: "v1: prod deploy is green" });
      return tool("report_to_parent", { kind: "result", text: "v2: prod and staging deploys are green" });
    });
    await h.kernel.idle();

    expect(runsOf(h, "p1")).toHaveLength(2);
    expect(results(h)).toEqual([{ id: finalResultEnvelopeId("p1", 0), childCellId: "p1", status: "completed", summary: "v2: prod and staging deploys are green", childState: "closed" }]);
    expect(h.kernel.getCell("p1")).toMatchObject({ status: "closed", closeReason: "completed" });
  });

  it("a follow-up that lands while the worker is still working is absorbed into the same Run (same claim, on record, answerable by handback)", async () => {
    const h = await boot();
    worker(h, "w1");
    h.script.add("w1", () => {
      h.kernel.sendToCell("w1", { text: "use the develop branch", id: "follow-1" });
      return tool("set_state", { patches: { step: 1 } });
    });
    h.script.add("w1", (req) => {
      // Fed to the model right after the step, not held back for another Run.
      expect(requestText(req)).toContain("use the develop branch");
      return tool("report_to_parent", { kind: "result", text: "done on develop" });
    });
    await h.kernel.idle();

    expect(h.of("run.started").filter((e) => e.cellId === "w1")).toHaveLength(1);
    const row = h.kernel.inbox.listMessagesSync({ cellId: "w1", envelopeId: "follow-1" })[0]!;
    const task = h.kernel.inbox.listMessagesSync({ cellId: "w1", type: PAYLOAD.cellTask })[0]!;
    expect(row).toMatchObject({ status: "done", claimId: task.claimId });
    const inbound = h.kernel.context.listEvidenceSync("w1").filter((e) => e.record.kind === "inbound");
    expect(inbound.map((e) => (e.record as { envelope: Envelope }).envelope.type)).toEqual([PAYLOAD.cellTask, PAYLOAD.cellMessage]);
    expect(results(h).map((r) => r.summary)).toEqual(["done on develop"]);
  });

  it("writing to a worker that has closed is answered 'closed' — to the control plane and to a cell's send_message — and stores nothing", async () => {
    const h = await boot();
    worker(h, "w1");
    h.script.add("w1", tool("report_to_parent", { kind: "result", text: "done" }));
    await h.kernel.idle();
    // The worker rests after its turn; its parent closes it.
    await h.kernel.closeCell("w1", "completed", { principalId: "cell:desk" });
    expect(h.kernel.getCell("w1")!.status).toBe("closed");
    const before = h.kernel.inbox.listMessagesSync({ cellId: "w1" }).length;

    expect(h.kernel.sendToCell("w1", { text: "one more thing" })).toEqual({ status: "closed", closeReason: "completed" });
    expect(h.kernel.sendToCell("ghost", { text: "?" })).toEqual({ status: "not_found" });

    let told = "";
    h.script.add("desk", tool("send_message", { to: "inbox:w1", text: "please also add tests", summary: "follow-up" }));
    h.script.add("desk", (req) => {
      told = lastToolResult(req);
      return { text: "ok" };
    });
    await h.ui.capture({ text: "让 w1 再补一下测试" });
    await h.kernel.idle();
    expect(told).toMatch(/NOT DELIVERED/);
    expect(told).toMatch(/closed/);
    expect(told).toMatch(/spawn_cell/);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "w1" })).toHaveLength(before);
    // control is refused the same way
    expect(h.kernel.control("w1", { action: "steer", steerMessage: "x" })).toMatchObject({ applied: false });
  });

  it("a worker whose turn simply ends is reported with its last words as the result and rests; one that set up a wait is not reported", async () => {
    const h = await boot();
    worker(h, "plain");
    worker(h, "waiting");
    h.script.add("plain", { text: "改好了：tui/table.ts 复制时输出 Markdown 源码。" });
    h.script.add("waiting", tool("wait", { reason: "等 desk 裁决", waitingFor: "inbox:desk" }));
    await h.kernel.idle();

    const [run] = runsOf(h, "plain");
    expect(results(h)).toMatchObject([
      { id: `plain:${run}:settled`, childCellId: "plain", status: "completed", summary: "改好了：tui/table.ts 复制时输出 Markdown 源码。", childState: "dormant", turn: { steps: 0, preview: "改好了：tui/table.ts 复制时输出 Markdown 源码。" } },
    ]);
    expect(h.kernel.getCell("plain")!.status).toBe("active");
    expect(h.kernel.activityOf(["plain", "waiting"])).toEqual(
      new Map([
        ["plain", expect.objectContaining({ state: "dormant" })],
        ["waiting", expect.objectContaining({ state: "waiting" })],
      ]),
    );
    expect(h.kernel.listWaits(["waiting"])).toMatchObject([{ waitingFor: "inbox:desk", reason: "等 desk 裁决" }]);
  });

  it("a one-shot cell with a child still at work is not closed by its own report; it closes once the child's turn is over", async () => {
    const h = await boot();
    // a one-shot worker given spawn depth
    worker(h, "w1", "do it", {preset:"inline", lifetime: "one_shot", bounds: { maxDepth: 1 } });
    const g = gate();
    h.script.add("w1", tool("spawn_cell", { preset: "worker", title: "helper", instruction: "help", meta: { role: "helper" } }));
    h.script.add("w1", tool("report_to_parent", { kind: "result", text: "premature" }));
    h.script.add("helper", async () => {
      await g.wait;
      return tool("report_to_parent", { kind: "result", text: "helped" });
    });
    // woken by the helper's result
    h.script.add("w1", tool("report_to_parent", { kind: "result", text: "final, with the helper's part" }));
    await waitFor(() => h.script.callsOf("w1").length === 2 && h.kernel.activeRuns().some((r) => r.cellId !== "w1"), 5_000, "w1 reported while its helper runs");
    await new Promise((r) => setTimeout(r, 30));
    expect(h.kernel.getCell("w1")!.status).toBe("active");
    expect(results(h)).toEqual([]);
    g.open();
    await h.kernel.idle();
    expect(h.kernel.getCell("w1")!.status).toBe("closed");
    expect(results(h).map((r) => r.summary)).toEqual(["final, with the helper's part"]);
    // the helper — a worker, dormant once it had reported — was archived with it
    const [helper] = h.kernel.listCells({ parentId: "w1" });
    expect(helper).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(results(h, "w1").map((r) => [r.summary, r.childState])).toEqual([["helped", "dormant"]]);
  });
});

describe("step limit and refusal are never 'completed'", () => {
  it("step_limit: the kernel queues a continuation each time, then asks the owner instead of looping; 'continue' grants one more", async () => {
    const h = await boot({ kernel: { maxStepContinuations: 2 } });
    h.kernel.spawnCell("desk", { id: "w1", preset: "worker", meta: { role: "w1" }, processor: { kind: "llm", toolsets: ["kernel.context", "kernel.comms"], maxSteps: 1 } }, "long job");
    // Every Run uses its single step on a tool call and is cut off before it can say anything.
    for (let i = 0; i < 6; i++) h.script.add("w1", tool("set_state", { patches: { n: i } }));
    await h.kernel.idle();

    const outcomes = () => h.of("run.finished").filter((e) => e.cellId === "w1").map((e) => e.outcome);
    expect(outcomes()).toEqual(["step_limit", "step_limit", "step_limit"]);
    const continues = h.kernel.inbox.listMessagesSync({ cellId: "w1", type: PAYLOAD.runContinue });
    expect(continues.map((m) => (m.envelope.payload as { count: number }).count)).toEqual([1, 2]);
    // Not closed, nothing reported: the parent was never told a half-done job is done.
    expect(h.kernel.getCell("w1")!.status).toBe("active");
    expect(results(h)).toEqual([]);
    // The third stop raised a card instead of a third continuation.
    const [card] = h.kernel.gate.listPendingSync();
    expect(isKernelEscalation(card!.action) && card!.action.args).toMatchObject({ reason: "retry_limit", cellId: "w1", stepLimit: true });
    expect(asClarifyCard(card!.card.data)).toMatchObject({ cardType: "escalation" });

    const item = h.kernel.humanItems.get(card!.actionId)!;
    expect(item.subjectKey).toBe("kernel:w1:step_limit");
    expect(item.options[0]?.effect).toBe("execute");
    expect(await h.kernel.humanItems.decide(item.id, {optionId:item.options[0]!.id, seenItemRevision:item.itemRevision}, "owner")).toMatchObject({status:"continued"});
    await h.kernel.idle();
    // The owner's go-ahead is itself continuation #1, so one more follows before the next card.
    expect(outcomes().slice(3)).toEqual(["step_limit", "step_limit"]);
    expect(h.kernel.gate.listPendingSync()).toHaveLength(1);
  });

  it("refused: a worker tells its parent the turn failed and stays; a one-shot probe delivers a failed result and closes; a coordinator raises a blocked card and stays", async () => {
    const h = await boot();
    worker(h, "w1");
    probe(h, "p1");
    h.kernel.spawnCell("desk", { id: "proj", preset: "project", title: "对比任务", meta: { role: "proj" } }, "coordinate");
    h.script.add("w1", { text: "I can't help with that.", stopReason: "refusal" });
    h.script.add("p1", { text: "I can't check that.", stopReason: "refusal" });
    h.script.add("proj", { text: "I won't do this.", stopReason: "refusal" });
    await h.kernel.idle();

    expect(h.of("run.finished").filter((e) => ["w1", "p1", "proj"].includes(e.cellId)).map((e) => e.outcome)).toEqual(["refused", "refused", "refused"]);
    const byChild = Object.fromEntries(results(h).map((r) => [r.childCellId, r]));
    expect(Object.keys(byChild).sort()).toEqual(["p1", "w1"]);
    expect(byChild["w1"]).toMatchObject({ status: "failed", childState: "dormant", turn: { outcome: "refused" } });
    expect(byChild["w1"]!.summary).toMatch(/refused.*I can't help with that\./);
    expect(byChild["p1"]).toMatchObject({ id: finalResultEnvelopeId("p1", 0), status: "failed", childState: "closed" });
    expect(byChild["p1"]!.summary).toMatch(/refused.*I can't check that\./);
    expect(h.kernel.getCell("w1")!.status).toBe("active");
    expect(h.kernel.getCell("p1")!.status).toBe("closed");
    expect(h.kernel.getCell("proj")!.status).toBe("active");
    const cards = h.kernel.gate.listPendingSync();
    expect(cards).toHaveLength(1);
    expect(isKernelEscalation(cards[0]!.action) && cards[0]!.action.args).toMatchObject({ reason: "blocked", cellId: "proj", refused: true });
  });
});

describe("complete_self / pause_self (persistent cells)", () => {
  const idle: CodeProcessor = { name: "test.idle", run: async () => "yielded_waiting" };
  const setup = (registry: Registry) => {
    registerTestPresets(registry);
    registry.codeProcessors.register(idle);
  };

  it("complete_self is refused while a child is at work; once its turn is over the project closes after its Run with one result, archiving the dormant worker", async () => {
    const h = await boot({ setup });
    h.kernel.spawnCell("desk", { id: "proj", preset: "project", title: "TUI 表格复制", meta: { role: "proj" } }, "coordinate");
    let refusal = "";
    h.script.add("proj", tool("spawn_cell", { preset: "worker", title: "改代码", instruction: "fix", meta: { role: "w" } }));
    h.script.add("proj", tool("complete_self", { summary: "too early" }));
    h.script.add("proj", (req) => {
      refusal = lastToolResult(req);
      return tool("wait", { reason: "等 worker" });
    });
    const g = gate();
    h.script.add("w", async () => {
      await g.wait;
      return tool("report_to_parent", { kind: "result", text: "MR !12 已建" });
    });
    // woken by the worker's result
    h.script.add("proj", tool("complete_self", { summary: "MR !12 已合入，事项完成" }));
    await waitFor(() => refusal !== "", 5_000, "the refusal");
    expect(refusal).toMatch(/1 child cell\(s\) are still at work/);
    expect(refusal).toMatch(/改代码/);
    expect(h.kernel.getCell("proj")!.status).toBe("active");
    g.open();
    await h.kernel.idle();

    expect(h.kernel.getCell("proj")).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(results(h)).toEqual([{ id: finalResultEnvelopeId("proj", 0), childCellId: "proj", status: "completed", summary: "MR !12 已合入，事项完成", childState: "closed" }]);
    const [w] = h.kernel.listCells({ parentId: "proj" });
    expect(w).toMatchObject({ status: "closed", closeReason: "completed" });
  });

  it("complete_self with a message already waiting does not close: the project handles it first", async () => {
    const h = await boot({ setup });
    h.kernel.spawnCell("desk", { id: "proj", preset: "project", meta: { role: "proj" } }, "coordinate");
    h.script.add("proj", () => {
      h.kernel.sendToCell("proj", { text: "等等，还要补一个录屏" });
      return tool("complete_self", { summary: "done" });
    });
    h.script.add("proj", (req) => {
      expect(requestText(req)).toContain("还要补一个录屏");
      return tool("wait", { reason: "去补录屏" });
    });
    await h.kernel.idle();
    expect(h.kernel.getCell("proj")!.status).toBe("active");
    expect(results(h)).toEqual([]);
  });

  it("pause_self parks the cell after its Run (everything kept); resume brings it back and what arrived meanwhile is delivered", async () => {
    const h = await boot({ setup });
    h.kernel.spawnCell("desk", { id: "idea", preset: "project", title: "极简模式", meta: { role: "idea" } }, "research then park");
    h.script.add("idea", tool("save_artifact", { title: "竞品调研", body: "# 调研\n…" }));
    h.script.add("idea", tool("pause_self", { reason: "调研完成，等主人决定是否开做" }));
    await h.kernel.idle();

    expect(h.kernel.getCell("idea")!.status).toBe("paused");
    expect(h.kernel.context.listArtifactsSync("idea")).toHaveLength(1);
    expect(results(h)).toEqual([]);
    // Parked cells cost nothing and take no child slot: sixteen of them do not block the next one.
    for (let i = 0; i < 20; i++) {
      h.kernel.spawnCell("desk", { id: `parked${i}`, preset: "project", processor: { kind: "code", entry: "test.idle" } });
      h.kernel.control(`parked${i}`, { action: "pause" });
    }
    h.kernel.spawnCell("desk", { id: "one-more", preset: "worker", processor: { kind: "code", entry: "test.idle" } });

    expect(h.kernel.sendToCell("idea", { text: "要做个极简模式，现在开做" })).toMatchObject({ status: "delivered", targetStatus: "paused" });
    await h.kernel.idle();
    expect(h.script.callsOf("idea")).toHaveLength(2);
    h.script.add("idea", (req) => {
      expect(requestText(req)).toContain("现在开做");
      return tool("wait", { reason: "拆阶段" });
    });
    h.kernel.control("idea", { action: "resume" });
    await h.kernel.idle();
    expect(h.kernel.getCell("idea")!.status).toBe("active");
    expect(h.script.callsOf("idea")).toHaveLength(3);
  });

  it("an explicit finish stands even when the same turn arranged a wake-up, and kernel notices on the way never keep a finished cell open", async () => {
    const h = await boot({ setup });
    // (a) dispatch-then-cancel in one turn: the Run is reported as waiting (it spawned), the request still applies.
    h.kernel.spawnCell("desk", { id: "p1", preset: "project", meta: { role: "p1" } }, "go");
    // The child is a persistent cell: it settles nothing by itself, so only the cancel below ends it.
    h.script.add("p1", tool("spawn_cell", { preset: "hub", title: "w", instruction: "x", code: { entry: "test.idle" } }));
    h.script.add("p1", (req) => {
      const child = /cell id (\S+)\./.exec(lastToolResult(req))![1]!;
      return tool("close_cell", { cellId: child, reason: "cancelled" });
    });
    h.script.add("p1", tool("complete_self", { summary: "主人说不做了", cancelled: true }));
    await h.kernel.idle();
    expect(h.of("run.finished").filter((e) => e.cellId === "p1").map((e) => e.outcome)).toEqual(["yielded_waiting"]);
    expect(h.kernel.getCell("p1")).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect(results(h).filter((r) => r.childCellId === "p1")).toMatchObject([{ status: "cancelled", summary: "主人说不做了" }]);

    // (b) a wait's timeout and a stall notice are still on their way when the cell finishes: neither counts as work.
    h.kernel.spawnCell("desk", { id: "p2", preset: "project", meta: { role: "p2", projectCellId: "p2" } });
    h.kernel.context.commitSync("p2", { statePatches: { "gtd:project": { title: "p2", lifecycle: "active", createdAt: 1, updatedAt: 1 } } });
    await h.kernel.idle();
    expect(h.kernel.inbox.listMessagesSync({ cellId: "p2", type: PAYLOAD.stalledCheck, status: ["pending"] })).toHaveLength(1);
    h.script.add("p2", tool("wait", { reason: "等 desk", waitingFor: "inbox:desk", timeoutMinutes: 60 }));
    h.kernel.sendToCell("p2", { text: "start" });
    await h.kernel.idle();
    // The wait is an anchor again, so the stall notice was withdrawn with the stall.
    expect(h.kernel.inbox.listMessagesSync({ cellId: "p2", type: PAYLOAD.stalledCheck }).map((m) => m.status)).toEqual(["cancelled"]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "p2", type: PAYLOAD.waitTimeout, status: ["pending"] })).toHaveLength(1);
    h.script.add("p2", tool("complete_self", { summary: "done after all" }));
    h.kernel.sendToCell("p2", { text: "其实已经做完了，收尾吧" });
    await h.kernel.idle();
    expect(h.kernel.getCell("p2")).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.kernel.context.readStateSync<{ lifecycle: string }>("p2", "gtd:project")!.lifecycle).toBe("completed");
  });

  it("a one-shot probe is not reported and closed by a wake-up that needed no Run (its snoozed card coming back)", async () => {
    const h = await boot({ setup });
    probe(h, "w1");
    h.script.add("w1", tool("request_approval", { kind: "escalation", title: "需要你确认", summary: "blocked", escalation: { reason: "blocked", explanation: "目录里有未提交改动" } }));
    await h.kernel.idle();
    const [card] = h.kernel.gate.listPendingSync();
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "snooze", approverId: "owner", until: h.clock.now() + 60_000 })).toMatchObject({ status: "snoozed" });
    h.clock.advance(60_000);
    await h.kernel.idle();
    // The card is back; the probe still waits behind it, unreported.
    expect(h.kernel.getCell("w1")!.status).toBe("active");
    expect(results(h)).toEqual([]);
    expect(h.kernel.gate.listPendingSync()).toHaveLength(1);
    expect(h.script.callsOf("w1")).toHaveLength(1);
  });

  it("a root cell cannot close or park itself, and a leaf (a worker) is not offered the tools", async () => {
    const h = await boot();
    let deskTools: string[] = [];
    let workerTools: string[] = [];
    h.script.add("desk", (_req, ctx) => {
      deskTools = ctx.toolNames;
      return { text: "ok" };
    });
    worker(h, "w1");
    h.script.add("w1", (_req, ctx) => {
      workerTools = ctx.toolNames;
      return { text: "done" };
    });
    await h.ui.capture({ text: "hi" });
    await h.kernel.idle();
    expect(deskTools).not.toContain("complete_self");
    expect(workerTools).not.toContain("complete_self");
    expect(workerTools).not.toContain("pause_self");
    expect(workerTools).toContain("report_to_parent");
  });
});
