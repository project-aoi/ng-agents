import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CELL_DIRECT_CHAT_KEY,
  CELL_RESULT_CANDIDATE_KEY,
  CELL_TURN_KEY,
  PAYLOAD,
  pullCursorKey,
  type CellDirectChatPayload,
  type CellResultPayload,
  type CodeProcessor,
  type Registry,
} from "@ng/protocol";
import { forgetWorkTreeKeys } from "../src";
import { boot, cleanupAll, lastToolResult, registerTestPresets, requestText, tempDir, tool, waitFor, type Harness } from "./helpers";

afterEach(cleanupAll);

// The wakeable leaf: a worker is never closed for finishing a turn. The kernel tells its parent every time a turn
// settles, the worker stays — dormant, costing nothing —, and any message (its project's or the owner's own) wakes it.
// The owner's direct words reach the parent in the same transaction; the parent pulls what the worker did.

const results = (h: Harness, parent: string) =>
  h.kernel.inbox.listMessagesSync({ cellId: parent, type: PAYLOAD.cellResult }).map((m) => ({ id: m.envelope.id, ...(m.envelope.payload as CellResultPayload) }));
const copies = (h: Harness, parent: string) =>
  h.kernel.inbox.listMessagesSync({ cellId: parent, type: PAYLOAD.cellDirectChat }).map((m) => ({ status: m.status, delivery: m.envelope.delivery, principalId: m.envelope.principalId, ...(m.envelope.payload as CellDirectChatPayload) }));

/** A project under the desk and a worker under the project, each with its own script queue. */
function project(h: Harness, id = "proj"): void {
  h.kernel.spawnCell("desk", { id, preset: "project", title: id, meta: { role: id } }, undefined, { principalId: h.kernel.ownerPrincipal });
}
function worker(h: Harness, id: string, parent = "proj", task: string | undefined = "do it", extra: Record<string, unknown> = {}): void {
  h.kernel.spawnCell(parent, { id, preset: "worker", title: id, meta: { role: id }, ...extra }, task, { principalId: h.kernel.ownerPrincipal });
}
const activity = (h: Harness, id: string) => h.kernel.activityOf([id]).get(id)!.state;

describe("a wakeable worker's turn settles: the parent is told, the worker stays", () => {
  it("keeps a worker waiting on its custom request_approval until the owner replies", async () => {
    const h=await boot();
    project(h); worker(h,"w");
    h.script.add("w",tool("request_approval",{kind:"escalation",title:"选一份材料",summary:"资料待确认",
      escalation:{reason:"blocked",explanation:"需要选定原始资料"},options:[{id:"first",label:"第一份",effect:"reply"}]}));
    await h.kernel.idle();
    const item=h.kernel.humanItems.list().find(i=>i.cellId==="w")!;
    expect(item.description).toBe("需要选定原始资料");
    expect(activity(h,"w")).toBe("waiting");
    expect(results(h,"proj")).toHaveLength(0);
    await h.kernel.humanItems.decide(item.id,{optionId:"first",seenItemRevision:item.itemRevision},"owner");
    await h.kernel.idle();
    expect(results(h,"proj")).toHaveLength(1);
  });

  it("is not closed when its turn ends; the notice carries the facts of the turn and each later turn is announced again", async () => {
    const h = await boot();
    project(h);
    worker(h, "w1");
    h.script.add("w1", tool("set_state", { patches: { step: 1 } }), { text: "退避逻辑已实现，提交 9f2c1" });
    await h.kernel.idle();

    expect(h.kernel.getCell("w1")).toMatchObject({ status: "active", epoch: 0 });
    expect(activity(h, "w1")).toBe("dormant");
    const [first] = results(h, "proj");
    expect(first).toMatchObject({
      childCellId: "w1",
      status: "completed",
      summary: "退避逻辑已实现，提交 9f2c1",
      childState: "dormant",
      turn: { fromSeq: 1, hadDirectUserChat: false, directChats: 0, steps: 1, outcome: "completed", preview: "退避逻辑已实现，提交 9f2c1" },
    });
    expect(first!.id).toBe(`w1:${first!.turn!.runId}:settled`);
    const settled = h.kernel.context.readStateSync<{ settledSeq: number; notices: number }>("w1", CELL_TURN_KEY)!;
    expect(settled).toMatchObject({ settledSeq: first!.turn!.toSeq, notices: 1 });

    // The project sends more work: the same cell wakes — no new cell, no "closed" answer — and its second turn is
    // announced under its own id, covering only what is new.
    h.script.add("w1", (req) => {
      expect(requestText(req)).toContain("also add a test");
      return { text: "测试已补" };
    });
    expect(h.kernel.sendToCell("w1", { text: "also add a test" }, { principalId: "cell:proj" })).toMatchObject({ status: "delivered" });
    await h.kernel.idle();
    const all = results(h, "proj");
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ summary: "测试已补", childState: "dormant", turn: { fromSeq: first!.turn!.toSeq + 1, steps: 0 } });
    expect(all[1]!.id).not.toBe(first!.id);
    expect(h.of("run.started").filter((e) => e.cellId === "w1")).toHaveLength(2);
    expect(h.kernel.getCell("w1")!.status).toBe("active");
  });

  it("report_to_parent is optional: when used, its text and artifact are the notice's, and the next turn does not repeat them", async () => {
    const h = await boot();
    project(h);
    worker(h, "w1");
    h.script.add("w1", tool("report_to_parent", { kind: "result", text: "报告写好了", artifactId: "art_9" }));
    await h.kernel.idle();
    expect(results(h, "proj")[0]).toMatchObject({ summary: "报告写好了", artifactId: "art_9", turn: { artifactIds: ["art_9"] } });
    expect(h.kernel.context.readStateSync("w1", CELL_RESULT_CANDIDATE_KEY)).toBeNull();

    h.script.add("w1", { text: "第二轮：只是回答了一个问题" });
    h.kernel.sendToCell("w1", { text: "why exponential?" }, { principalId: "cell:proj" });
    await h.kernel.idle();
    const second = results(h, "proj")[1]!;
    expect(second.summary).toBe("第二轮：只是回答了一个问题");
    expect(second.artifactId).toBeUndefined();
  });

  it("a turn is not over while the worker waits for someone, has a job running or a card out; a failed report is a failed turn", async () => {
    const h = await boot();
    project(h);
    worker(h, "w1");
    // It asks its project something and waits: no notice — the worker is waiting, not done.
    h.script.add("w1", tool("send_message", { to: "inbox:proj", text: "目录里有陌生改动", summary: "工作区冲突" }), tool("wait", { reason: "等待上级指示", waitingFor: "inbox:proj" }));
    await h.kernel.idle();
    expect(results(h, "proj")).toEqual([]);
    expect(activity(h, "w1")).toBe("waiting");

    // The answer closes the wait; now the turn that follows settles — as failed, because it says so.
    h.script.add("w1", tool("report_to_parent", { kind: "result", status: "failed", text: "没法继续：分支被人占着" }));
    // (The owner answering directly counts as the answer, whoever the worker was waiting for.)
    expect(h.kernel.directMessage("w1", { text: "那就先停" }, { principalId: h.kernel.ownerPrincipal })).toMatchObject({ status: "delivered" });
    await h.kernel.idle();
    expect(h.kernel.listWaits(["w1"])).toEqual([]);
    expect(results(h, "proj")).toHaveLength(1);
    expect(results(h, "proj")[0]).toMatchObject({ status: "failed", childState: "dormant", turn: { outcome: "failed" } });
    expect(h.kernel.getCell("w1")!.status).toBe("active");
  });

  it("a turn that ends with a bare wait — nothing arranged, nobody named — is over: the parent is told", async () => {
    const h = await boot();
    project(h);
    worker(h, "w1");
    h.script.add("w1", { text: "分析完了，结论在上面" }, tool("wait", { reason: "没有别的事了" }));
    h.script.add("w1", tool("wait", { reason: "没有别的事了" }));
    await h.kernel.idle();
    expect(activity(h, "w1")).toBe("dormant");
    expect(results(h, "proj")).toMatchObject([{ childCellId: "w1", childState: "dormant", turn: { outcome: "completed" } }]);
  });

  it("a follow-up that lands before the settle is taken first: one notice, for the turn that answered it", async () => {
    const h = await boot();
    project(h);
    worker(h, "w1");
    h.script.add("w1", () => {
      h.kernel.sendToCell("w1", { text: "also record a screencast" }, { principalId: "cell:proj" });
      return tool("report_to_parent", { kind: "result", text: "v1" });
    });
    h.script.add("w1", (req) => {
      expect(requestText(req)).toContain("also record a screencast");
      expect(results(h, "proj")).toEqual([]);
      return tool("report_to_parent", { kind: "result", text: "v2 with screencast" });
    });
    await h.kernel.idle();
    expect(results(h, "proj").map((r) => r.summary)).toEqual(["v2 with screencast"]);
  });

  it("a one_shot leaf (a checker) still reports once and is closed, with its timers", async () => {
    const h = await boot();
    project(h);
    h.kernel.spawnCell("proj", { id: "wt", preset: "checker", title: "wt", meta: { role: "wt" }, schedules: [{ cron: "0 9 * * *" }] }, "is the MR merged?", { principalId: h.kernel.ownerPrincipal });
    h.script.add("wt", tool("report_to_parent", { kind: "result", text: "merged at 10:02" }));
    await h.kernel.idle();
    expect(h.kernel.getCell("wt")).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(results(h, "proj")).toEqual([{ id: "wt:0:cell.result", childCellId: "wt", status: "completed", summary: "merged at 10:02", childState: "closed" }]);
    expect(h.kernel.inbox.listSchedulesSync({ cellId: "wt", activeOnly: true })).toEqual([]);
  });
});

describe("dormant workers cost nothing and block nothing", () => {
  it("take no slot of maxConcurrentChildren; a worker at work, or one that waits, does", async () => {
    const h = await boot();
    h.kernel.spawnCell("desk", { id: "proj", preset: "project", title: "proj", meta: { role: "proj" }, bounds: { maxConcurrentChildren: 2 } }, undefined, { principalId: h.kernel.ownerPrincipal });
    worker(h, "a");
    worker(h, "b");
    h.script.add("a", { text: "a done" });
    h.script.add("b", { text: "b done" });
    await h.kernel.idle();
    expect([activity(h, "a"), activity(h, "b")]).toEqual(["dormant", "dormant"]);
    // Two finished workers are still there, and two more can start.
    h.kernel.spawnCell("proj", { id: "c", preset: "worker", meta: { role: "c" } }, undefined, { principalId: h.kernel.ownerPrincipal });
    h.kernel.inbox.enqueueSync("c", { id: "c-later", from: "timer:test", principalId: "cell:c", kind: "event", type: PAYLOAD.timerFired, payload: { label: "later" }, createdAt: h.clock.now() }, { deliverAt: h.clock.now() + 3_600_000 });
    h.kernel.spawnCell("proj", { id: "d", preset: "worker", meta: { role: "d" } }, undefined, { principalId: h.kernel.ownerPrincipal });
    h.kernel.inbox.enqueueSync("d", { id: "d-later", from: "timer:test", principalId: "cell:d", kind: "event", type: PAYLOAD.timerFired, payload: { label: "later" }, createdAt: h.clock.now() }, { deliverAt: h.clock.now() + 3_600_000 });
    expect([activity(h, "c"), activity(h, "d")]).toEqual(["waiting", "waiting"]);
    expect(() => h.kernel.spawnCell("proj", { id: "e", preset: "worker" }, "go", { principalId: h.kernel.ownerPrincipal })).toThrow(/already has 2 children at work \(maxConcurrentChildren 2\)/);
  });

  it("do not keep their project from finishing, and are archived with it — a worker still at work does keep it open", async () => {
    const h = await boot();
    project(h);
    worker(h, "w1");
    h.script.add("w1", { text: "done" });
    await h.kernel.idle();
    h.kernel.spawnCell("proj", { id: "w2", preset: "worker", title: "w2", meta: { role: "w2" } }, undefined, { principalId: h.kernel.ownerPrincipal });
    h.kernel.inbox.enqueueSync("w2", { id: "w2-later", from: "timer:test", principalId: "cell:w2", kind: "event", type: PAYLOAD.timerFired, payload: { label: "later" }, createdAt: h.clock.now() }, { deliverAt: h.clock.now() + 3_600_000 });

    h.script.add("proj", tool("complete_self", { summary: "all done" }), (req) => {
      expect(lastToolResult(req)).toMatch(/1 child cell\(s\) are still at work \(w2/);
      return tool("close_cell", { cellId: "w2", reason: "cancelled" });
    });
    h.script.add("proj", tool("complete_self", { summary: "all done" }));
    h.kernel.sendToCell("proj", { text: "wrap up" }, { principalId: "cell:desk" });
    await h.kernel.idle();
    expect(h.kernel.getCell("proj")).toMatchObject({ status: "closed", closeReason: "completed" });
    // Archived, not cancelled: nothing of w1's work was cut short.
    expect(h.kernel.getCell("w1")).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.kernel.getCell("w2")).toMatchObject({ status: "closed", closeReason: "cancelled" });
  });

  it("are not anchors: a project whose only cell is a dormant worker is stalled; nobody wakes the worker", async () => {
    const h = await boot({ kernel: { stallGraceMs: 0 } });
    project(h);
    worker(h, "w1");
    h.script.add("w1", { text: "done" });
    await h.kernel.idle();
    const runs = h.of("run.started").filter((e) => e.cellId === "w1").length;
    h.clock.advance(24 * 3_600_000);
    await h.kernel.idle();
    expect(h.of("run.started").filter((e) => e.cellId === "w1")).toHaveLength(runs);
    expect(h.kernel.anchorsOf("proj")).toMatchObject({ agent: false, external: false, internal: false });
  });
});

describe("the owner talks to a worker directly", () => {
  it("wakes a dormant worker on its record, copies the words to its project in the background, and the settle notice says so", async () => {
    const h = await boot();
    project(h);
    worker(h, "w1");
    h.script.add("w1", { text: "退避已实现，最大重试 5 次" });
    await h.kernel.idle();
    const projRuns = () => h.of("run.started").filter((e) => e.cellId === "proj").length;
    const before = projRuns();

    let woken = 0;
    h.script.add("w1", (req) => {
      woken++;
      // Its earlier turn is in front of it: it continues, it does not start over.
      expect(requestText(req)).toContain("退避已实现，最大重试 5 次");
      expect(requestText(req)).toContain("把最大重试次数从 5 改成 3");
      // The project has the owner's words already — as background: it was not woken for them.
      expect(copies(h, "proj")).toMatchObject([{ status: "pending", delivery: "silent_inject", principalId: "owner", childCellId: "w1", text: "把最大重试次数从 5 改成 3", mode: "enqueue" }]);
      expect(projRuns()).toBe(before);
      return { text: "改成 3 次了，单测 14/14 通过" };
    });
    let projSaw = "";
    h.script.add("proj", (req) => {
      projSaw = requestText(req);
      return {};
    });
    const r = h.kernel.directMessage("w1", { text: "把最大重试次数从 5 改成 3", clientId: "c-1" }, { principalId: h.kernel.ownerPrincipal });
    expect(r).toEqual({ status: "delivered", envelopeId: "c-1", duplicate: false, reopened: false, targetStatus: "active", ccTo: "proj" });
    // A retried send is the same message: not delivered twice, not copied twice.
    expect(h.kernel.directMessage("w1", { text: "把最大重试次数从 5 改成 3", clientId: "c-1" }, { principalId: h.kernel.ownerPrincipal })).toMatchObject({ status: "delivered", duplicate: true });
    await h.kernel.idle();

    expect(woken).toBe(1);
    expect(copies(h, "proj")).toHaveLength(1);
    const notice = results(h, "proj")[1]!;
    expect(notice).toMatchObject({ summary: "改成 3 次了，单测 14/14 通过", turn: { hadDirectUserChat: true, directChats: 1 } });
    // The project's wake-up for the settled turn has the owner's own words in it, and the lead that says not to forward them.
    expect(projSaw).toContain("把最大重试次数从 5 改成 3");
    expect(projSaw).toContain("The owner said this directly to one of your cells");
    expect(h.kernel.context.readStateSync(`w1`, CELL_DIRECT_CHAT_KEY)).toMatchObject({ total: 1, unsettled: 0 });
  });

  it("notifyParent wakeup wakes the project at once; a steer is copied too; an agent keeps its own identity", async () => {
    const h = await boot();
    project(h);
    worker(h, "w1");
    h.script.add("w1", { text: "first" });
    await h.kernel.idle();
    const before = h.of("run.started").filter((e) => e.cellId === "proj").length;
    h.script.add("w1", { text: "stopped the migration" });
    expect(h.kernel.directMessage("w1", { text: "方向错了，停掉迁移", mode: "steer", notifyParent: "wakeup", clientId: "s-1" }, { principalId: "agent:claude" })).toMatchObject({ status: "delivered", envelopeId: "s-1", ccTo: "proj" });
    await h.kernel.idle();
    // The steer is stored under the caller's id, so a conversation view can match it to what was typed.
    expect(h.kernel.inbox.listMessagesSync({ cellId: "w1", envelopeId: "s-1" })).toMatchObject([{ status: "done" }]);
    expect(copies(h, "proj")).toMatchObject([{ delivery: "wakeup", principalId: "agent:claude", mode: "steer", text: "方向错了，停掉迁移" }]);
    expect(h.of("run.started").filter((e) => e.cellId === "proj").length).toBeGreaterThan(before);
    // The plain control-plane calls give the project the same copy.
    h.script.add("w1", { text: "ok" });
    h.kernel.sendToCell("w1", { text: "再跑一遍" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    h.script.add("w1", { text: "ok" });
    h.kernel.control("w1", { action: "steer", steerMessage: "用 pnpm" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(copies(h, "proj").map((c) => [c.mode, c.text])).toEqual([["steer", "方向错了，停掉迁移"], ["enqueue", "再跑一遍"], ["steer", "用 pnpm"]]);
    // A cell writing to a cell is not the owner speaking: no copy.
    h.script.add("w1", { text: "ok" });
    h.kernel.sendToCell("w1", { text: "from the desk" }, { principalId: "cell:desk" });
    await h.kernel.idle();
    expect(copies(h, "proj")).toHaveLength(3);
  });

  it("brings back a worker that was closed under an open project; refuses script cells and cells archived with their project", async () => {
    const code: CodeProcessor = { name: "test.noop", run: async () => "completed" };
    const h = await boot({
      setup: (r: Registry) => {
        registerTestPresets(r);
        r.codeProcessors.register(code);
      },
    });
    project(h);
    worker(h, "w1");
    h.script.add("w1", { text: "v1 done" });
    await h.kernel.idle();
    await h.kernel.closeCell("w1", "completed", { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.sendToCell("w1", { text: "x" }, { principalId: h.kernel.ownerPrincipal })).toMatchObject({ status: "closed" });

    h.script.add("w1", (req) => {
      expect(requestText(req)).toContain("v1 done");
      return { text: "v2 done" };
    });
    expect(h.kernel.directMessage("w1", { text: "再改一处" }, { principalId: h.kernel.ownerPrincipal })).toMatchObject({ status: "delivered", reopened: true, ccTo: "proj" });
    await h.kernel.idle();
    expect(h.kernel.getCell("w1")!.status).toBe("active");
    expect(results(h, "proj").at(-1)).toMatchObject({ summary: "v2 done", childState: "dormant" });

    h.kernel.spawnCell("proj", { id: "probe", preset: "hub", processor: { kind: "code", entry: "test.noop" }, lifetime: "persistent" }, undefined, { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.directMessage("probe", { text: "hello" }, { principalId: h.kernel.ownerPrincipal })).toMatchObject({ status: "refused", reason: "code" });
    expect(h.kernel.directMessage("nope", { text: "hello" }, { principalId: h.kernel.ownerPrincipal })).toEqual({ status: "not_found" });
    expect(h.kernel.directMessage("w1", { text: "hello" }, { principalId: "cell:desk" })).toMatchObject({ status: "refused", reason: "not_allowed" });

    await h.kernel.closeCell("proj", "completed", { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.directMessage("w1", { text: "还在吗" }, { principalId: h.kernel.ownerPrincipal })).toMatchObject({ status: "refused", reason: "archived" });
    expect(h.kernel.getCell("w1")!.status).toBe("closed");
  });

  it("the desk takes it as a user message, with the question it answers", async () => {
    const h = await boot();
    let saw = "";
    h.script.add("desk", (req) => {
      saw = requestText(req);
      return { text: "好的，已立项" };
    });
    expect(h.kernel.directMessage("desk", { text: "在 ~/dev/pay-core", clientId: "m-7", replyToId: "q-3", replyToText: "代码在哪个本地目录下呀？", conversationId: "web-1" }, { principalId: h.kernel.ownerPrincipal })).toMatchObject({ status: "delivered", ccTo: null });
    await h.kernel.idle();
    expect(saw).toContain("user.message");
    expect(saw).toContain("id m-7");
    expect(saw).toContain("在 ~/dev/pay-core");
    expect(saw).toContain("代码在哪个本地目录下呀？");
    expect(saw).toContain("web-1");
  });
});

describe("the parent pulls: inspect_cell", () => {
  it("shows what the worker was told and did since the parent last looked, marks the owner's direct words, and moves only the inspector's cursor", async () => {
    const h = await boot();
    project(h);
    worker(h, "w1", "proj", "implement backoff");
    h.script.add("w1", tool("set_state", { patches: { branch: "feat/retry" } }), { text: "已提交 9f2c1" });
    await h.kernel.idle();

    // The roster a project sees says the worker is dormant and has a record it has not read.
    let roster = "";
    let first = "";
    h.script.add("proj", (req) => {
      roster = requestText(req);
      return tool("inspect_cell", { cellId: "w1" });
    });
    h.script.add("proj", (req) => {
      first = lastToolResult(req);
      return {};
    });
    h.kernel.sendToCell("proj", { text: "status?" }, { principalId: "cell:desk" });
    await h.kernel.idle();
    expect(roster).toMatch(/w1 .*dormant — its turn is over/);
    expect(roster).toMatch(/not inspected yet \(its record runs to #\d+\)/);
    expect(first).toContain("its task: implement backoff");
    expect(first).toContain("set_state");
    expect(first).toContain("said: 已提交 9f2c1");
    const cursor = h.kernel.context.readStateSync<number>("proj", pullCursorKey("w1"))!;
    expect(cursor).toBe(h.kernel.context.lastEvidenceSeqSync("w1"));

    // The owner talks to the worker; the next look shows only the new stretch, with the owner's words marked.
    h.script.add("w1", { text: "改成 3 次了" });
    let second = "";
    h.script.add("proj", tool("inspect_cell", { cellId: "w1" }), (req) => {
      second = lastToolResult(req);
      return {};
    });
    h.kernel.directMessage("w1", { text: "最大重试改成 3" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(second).toContain("the owner, directly (owner): 最大重试改成 3");
    expect(second).toContain("the owner spoke to it directly 1 time(s)");
    expect(second).not.toContain("implement backoff");
    expect(second).toContain(`records #${cursor + 1}–#`);

    // The control plane reads without moving anybody's cursor; so does a cell that is not the worker's ancestor.
    const whole = h.kernel.inspectCell("w1", { afterSeq: 0, detail: "full" });
    expect(whole.text).toContain("implement backoff");
    expect(whole.directChats).toBe(1);
    expect(whole.state).toBe("dormant");
    expect(h.kernel.context.readStateSync<number>("desk", pullCursorKey("w1"))).toBeNull();
    expect(() => h.kernel.inspectCell("nope")).toThrow(/there is no cell/);
  });
});

describe("what a coordinator sees at every wake-up", () => {
  it("its own notes come back in the tail — not in the frozen prefix — and a worker has none", async () => {
    const h = await boot();
    project(h);
    h.script.add("proj", tool("save_note", { kind: "working_note", scope: "cell", name: "board", description: "项目白板", body: "- worker_a1（待命，已看到 #42）：核心退避逻辑已提交 9f2c1" }));
    h.kernel.sendToCell("proj", { text: "start" }, { principalId: "cell:desk" });
    await h.kernel.idle();
    const prefix = h.count("prompt_prefixes WHERE cell_id = 'proj'");

    let saw = "";
    let system = "";
    h.script.add("proj", (req) => {
      saw = requestText(req);
      system = req.system ?? "";
      return {};
    });
    h.kernel.sendToCell("proj", { text: "next" }, { principalId: "cell:desk" });
    await h.kernel.idle();
    expect(saw).toContain("[your notes — kept across every wake-up; update with save_note]");
    expect(saw).toContain("## board\n- worker_a1（待命，已看到 #42）：核心退避逻辑已提交 9f2c1");
    expect(system).not.toContain("worker_a1");
    expect(h.count("prompt_prefixes WHERE cell_id = 'proj'")).toBe(prefix);
  });

  it("who is active in which directory is shown, and nothing is queued: two workers in one work tree run at the same time", async () => {
    const repo = tempDir("repo");
    mkdirSync(join(repo, "sub"), { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    forgetWorkTreeKeys();
    const h = await boot();
    project(h);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let bothRunning = false;
    let tail = "";
    h.script.add("a", async () => {
      await waitFor(() => h.kernel.activeRuns().some((r) => r.cellId === "b"));
      bothRunning = true;
      expect(h.kernel.activeWorkspaces()).toMatchObject([{ active: [{ cellId: "a", state: "running", projectCellId: null }, { cellId: "b", state: "running" }] }]);
      await held;
      return { text: "a done" };
    });
    h.script.add("b", async (req) => {
      await waitFor(() => bothRunning);
      tail = requestText(req);
      release();
      return { text: "b done" };
    });
    worker(h, "a", "proj", "change files", { cwd: repo });
    await waitFor(() => h.kernel.activeRuns().some((r) => r.cellId === "a"));
    worker(h, "b", "proj", "change other files", { cwd: join(repo, "sub") });
    await h.kernel.idle();
    expect(bothRunning).toBe(true);
    // The second worker was told who else is in its work tree; a lock it was not.
    expect(tail).toContain("[others active in your work tree right now");
    expect(tail).toMatch(/- a "a".* — working/);
    expect(h.kernel.activeWorkspaces()).toEqual([]);
  });
});

it.each(["one_shot", "wakeable"] as const)("enforces the leaf boundary for the %s lifetime even on a custom spec", async lifetime => {
  const h = await boot();
  h.kernel.spawnCell("desk", { id: "leaf", preset: "inline", lifetime, bounds: { maxDepth: 3 } }, undefined, { principalId: h.kernel.ownerPrincipal });
  expect(h.kernel.getCell("leaf")?.bounds.maxDepth).toBe(0);
  expect(() => h.kernel.spawnCell("leaf", { preset: "worker" }, undefined, { principalId: h.kernel.ownerPrincipal })).toThrow(/maxDepth 0/);
});
