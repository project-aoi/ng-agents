import { afterEach, describe, expect, it } from "vitest";
import {
  createEnvelope,
  gtdKeys,
  isNgError,
  PAYLOAD,
  type ActionRecord,
  type Envelope,
  type HandbackPayload,
  type ProjectRecord,
  type UserMessagePayload,
} from "@ng/protocol";
import { boot, cleanupAll, HOUR, requestText, T0, tool, waitFor, type Harness } from "./helpers";

afterEach(cleanupAll);

const GRACE = 2_000;

function project(h: Harness, id = "proj", lifecycle: ProjectRecord["lifecycle"] = "active"): void {
  h.kernel.spawnCell("desk", { id, preset: "project", title: "Harness 对比", meta: { role: id, projectCellId: id } });
  const now = h.clock.now();
  h.kernel.context.commitSync(id, { statePatches: { [gtdKeys.project]: { title: "Harness 对比", lifecycle, createdAt: now, updatedAt: now } satisfies ProjectRecord } });
}

const record = (h: Harness, id = "proj") => h.kernel.context.readStateSync<ProjectRecord>(id, gtdKeys.project)!;
const checks = (h: Harness, cellId = "proj") => h.kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.stalledCheck });

function action(h: Harness, cellId: string, id: string, patch: Partial<ActionRecord>): void {
  const now = h.clock.now();
  h.kernel.context.commitSync(cellId, {
    statePatches: { [gtdKeys.action(id)]: { id, title: "要回 Doubao 代码", owner: "human", status: "open", projectCellId: cellId, createdAt: now, updatedAt: now, ...patch } satisfies ActionRecord },
  });
}

// docs/05 guard 2 — an active project always has one of five anchors, and when it has none it is told exactly once.
describe("stall check", () => {
  it("a project with nothing moving it is stamped and woken exactly once; an idle wake-up does not earn a second one; a new stall does", async () => {
    const h = await boot();
    project(h);
    await h.kernel.idle();

    expect(h.kernel.anchorsOf("proj")).toMatchObject({ agent: false, external: false, internal: false, human: false, parked: false, stalled: true });
    expect(record(h)).toMatchObject({ stalledSince: T0, stalledNotifiedAt: T0 });
    expect(checks(h).map((m) => [m.status, m.deliverAt])).toEqual([["pending", T0 + GRACE]]);
    expect(h.script.callsOf("proj")).toHaveLength(0);

    // The wake-up arrives after the grace period; the model looks, does nothing useful, and ends its turn.
    h.script.add("proj", (req) => {
      expect(requestText(req)).toContain("Nothing is moving this project forward");
      return { text: "嗯，我再想想。" };
    });
    h.clock.advance(GRACE);
    await h.kernel.idle();
    expect(h.script.callsOf("proj")).toHaveLength(1);
    // Still stalled, still stamped — and that is all: the check's own Run and message were never an anchor, and the
    // notice is not repeated however much time passes or however often the check runs.
    expect(h.kernel.anchorsOf("proj").stalled).toBe(true);
    h.clock.advance(6 * HOUR);
    h.kernel.checkStalls();
    await h.ui.capture({ text: "无关的一条随手记" });
    await h.kernel.idle();
    expect(checks(h)).toHaveLength(1);
    expect(h.script.callsOf("proj")).toHaveLength(1);
    expect(record(h)).toMatchObject({ stalledSince: T0, stalledNotifiedAt: T0 });

    // A real anchor (the owner now has an open action) lifts the stall and re-arms the notice…
    action(h, "proj", "a1", {});
    await h.kernel.idle();
    expect(h.kernel.anchorsOf("proj")).toMatchObject({ human: true, stalled: false });
    expect(record(h).stalledSince).toBeUndefined();
    expect(record(h).stalledNotifiedAt).toBeUndefined();
    // …so when that anchor goes away without anything taking its place, the project is told once more.
    const again = h.clock.now();
    action(h, "proj", "a1", { status: "done" });
    await h.kernel.idle();
    expect(record(h)).toMatchObject({ stalledSince: again, stalledNotifiedAt: again });
    expect(checks(h).map((m) => m.envelope.id)).toEqual([`proj:stalled:${T0}`, `proj:stalled:${again}`]);
  });

  it("a stall that is over before the grace period ends never reaches the model", async () => {
    const h = await boot();
    project(h);
    await h.kernel.idle();
    expect(checks(h)).toHaveLength(1);

    // Within the grace period the project gets a watcher with a timer: an external anchor.
    h.kernel.spawnCell("proj", { id: "mr-watch", preset: "watcher", title: "盯 MR !12", schedules: [{ deliverAt: T0 + HOUR }] });
    await h.kernel.idle();
    expect(h.kernel.anchorsOf("proj")).toMatchObject({ external: true, stalled: false });
    // The notice is withdrawn together with the stall it was about.
    expect(checks(h)[0]!.status).toBe("cancelled");
    h.clock.advance(GRACE);
    await h.kernel.idle();
    expect(h.script.callsOf("proj")).toHaveLength(0);
    expect(record(h).stalledSince).toBeUndefined();
  });

  it("each of the five anchors counts; paused and non-active projects are parked, never stalled", async () => {
    const h = await boot();
    project(h, "p-agent");
    project(h, "p-human");
    project(h, "p-wait");
    project(h, "p-someday", "someday");
    project(h, "p-paused");
    h.kernel.control("p-paused", { action: "pause" });

    // @Agent: a worker with work queued; @Human: a pending card; @Waiting(internal): an open wait on a live cell.
    h.kernel.spawnCell("p-agent", { id: "w", preset: "worker", meta: { role: "w" } }, "分析 trae 代码");
    h.script.add("w", tool("wait", { reason: "等编译" }));
    h.script.add("p-human", tool("request_approval", { kind: "escalation", title: "需要你确认", summary: "blocked", escalation: { reason: "blocked", explanation: "仓库里有你没提交的改动" } }));
    h.kernel.sendToCell("p-human", { text: "go" });
    h.script.add("p-wait", tool("wait", { reason: "等 desk 裁决", waitingFor: "inbox:desk" }));
    h.kernel.sendToCell("p-wait", { text: "go" });
    expect(h.kernel.anchorsOf("p-agent")).toMatchObject({ agent: true, stalled: false });
    await h.kernel.idle();

    expect(h.kernel.anchorsOf("p-human")).toMatchObject({ human: true, stalled: false });
    expect(h.kernel.anchorsOf("p-wait")).toMatchObject({ internal: true, stalled: false });
    expect(h.kernel.anchorsOf("p-someday")).toMatchObject({ parked: true, stalled: false });
    expect(h.kernel.anchorsOf("p-paused")).toMatchObject({ parked: true, stalled: false });
    // The worker ended its turn with a bare wait: nothing will ever wake it, so its project has no anchor left.
    expect(h.kernel.anchorsOf("p-agent")).toMatchObject({ agent: false, stalled: true });
    expect(Object.fromEntries(["p-agent", "p-human", "p-wait", "p-someday", "p-paused"].map((id) => [id, checks(h, id).length]))).toEqual({
      "p-agent": 1,
      "p-human": 0,
      "p-wait": 0,
      "p-someday": 0,
      "p-paused": 0,
    });
  });
});

describe("waits (the internal anchor)", () => {
  it("a wait is closed only by the party it names — an unrelated wake-up leaves it open — or by its timeout", async () => {
    const h = await boot();
    project(h);
    h.script.add("proj", tool("wait", { reason: "等 desk 裁决工作区冲突", waitingFor: "inbox:desk", timeoutMinutes: 30 }));
    h.kernel.sendToCell("proj", { text: "start" });
    await h.kernel.idle();
    expect(h.kernel.listWaits(["proj"])).toMatchObject([{ waitingFor: "inbox:desk", timeoutAt: T0 + 30 * 60_000 }]);

    // A colleague drops in a remark (an outside sender, not the party it named): the project wakes, but it is still
    // waiting for the desk. (The owner writing to it directly would have answered any wait.)
    let sawOpenWait = false;
    h.script.add("proj", (req) => {
      sawOpenWait = requestText(req).includes("waiting for inbox:desk");
      return tool("wait", { reason: "还在等" });
    });
    h.kernel.inbox.enqueueSync("proj", { id: "remark", from: "channel:memory:carol", principalId: "memory:carol", kind: "event", type: PAYLOAD.userMessage, payload: { text: "顺便说一句，周五前要" }, createdAt: h.clock.now() });
    await h.kernel.idle();
    expect(sawOpenWait).toBe(true);
    expect(h.kernel.listWaits(["proj"])).toHaveLength(1);

    // The desk answers: the wait closes and its timeout is cancelled.
    h.script.add("desk", tool("send_message", { to: "inbox:proj", text: "按主人拍板执行：stash 后继续", summary: "裁决" }));
    h.script.add("proj", tool("wait", { reason: "继续推进", waitingFor: "inbox:desk", timeoutMinutes: 10 }));
    await h.ui.capture({ text: "告诉 proj 可以继续了" });
    await h.kernel.idle();
    const timers = () => h.kernel.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.waitTimeout }).map((m) => m.status);
    expect(timers()).toEqual(["cancelled", "pending"]);

    // Nobody answers the second wait: the timeout wakes the project with the wait named, and the wait is gone.
    h.script.add("proj", (req) => {
      expect(requestText(req)).toContain("Nobody answered the wait below in time");
      expect(requestText(req)).toContain("inbox:desk");
      return { text: "超时了，我自己查一下现状。" };
    });
    h.clock.advance(10 * 60_000);
    await h.kernel.idle();
    expect(timers()).toEqual(["cancelled", "done"]);
    expect(h.kernel.listWaits(["proj"])).toEqual([]);
  });

  it("a wait on a cell that has closed is no anchor, and closing a cell drops its own waits", async () => {
    const h = await boot();
    project(h);
    h.kernel.spawnCell("proj", { id: "w1", preset: "worker", meta: { role: "w1" } }, "task");
    h.script.add("w1", tool("wait", { reason: "等 proj 的补充说明", waitingFor: "inbox:proj" }));
    h.script.add("proj", tool("wait", { reason: "等 w1 交卷", waitingFor: "inbox:w1" }));
    h.kernel.sendToCell("proj", { text: "go" });
    await h.kernel.idle();
    expect(h.kernel.anchorsOf("proj")).toMatchObject({ internal: true, stalled: false });

    await h.kernel.closeCell("w1", "cancelled");
    expect(h.kernel.listWaits(["w1"])).toEqual([]);
    // The project's own wait on the dead worker was answered by the synthetic close report; nothing holds it now.
    h.script.add("proj", { text: "w1 被关了" });
    await h.kernel.idle();
    expect(h.kernel.listWaits(["proj"])).toEqual([]);
    expect(h.kernel.anchorsOf("proj")).toMatchObject({ internal: false, stalled: true });
  });
});

// docs/05 §3.3 / §5.3 — direct routing with declarative operators and a fixed batching window.
describe("hub: operator watches, coalescing, absorption", () => {
  let seq = 0;
  function feishu(text: string, extra: Partial<UserMessagePayload> = {}): Omit<Envelope, "to"> {
    return createEnvelope({ id: `fs-${++seq}`, from: "channel:feishu:chat-review", principalId: "feishu:ou_mary", kind: "event", type: PAYLOAD.userMessage, payload: { text, ...extra } });
  }

  it("mentions/keywords route past the desk into the hub, a burst inside the window is one batch, noise is handed back, and what arrives mid-run is absorbed", async () => {
    const h = await boot();
    h.kernel.spawnCell("desk", {
      id: "review-hub",
      preset: "hub",
      title: "Code Review 直通",
      meta: { role: "hub" },
      watches: [
        { threadOrFilter: { "payload.mentions": { $contains: "ng-bot" }, "payload.eventKind": { $in: ["mention", "review_requested"] } }, coalesceMs: 60_000 },
        { threadOrFilter: { from: "channel:feishu:chat-review", "payload.text": { $anyKeyword: ["帮忙排查", "线上报错"] } }, coalesceMs: 60_000 },
      ],
    });

    const r1 = await h.kernel.ingest(feishu("@ng-bot 看下 MR !41", { mentions: ["NG-Bot"], eventKind: "mention" }), "feishu");
    expect(r1).toMatchObject({ routedBy: "watch", cellIds: ["review-hub"], coalesced: ["review-hub"] });
    h.clock.advance(20_000);
    await h.kernel.ingest(feishu("@ng-bot 还有 MR !42", { mentions: ["ng-bot"], eventKind: "mention" }), "feishu");
    // Not a mention, not a keyword: the desk's business as before.
    expect(await h.kernel.ingest(feishu("中午吃什么"), "feishu")).toMatchObject({ routedBy: "desk", cellIds: ["desk"] });
    // The second subscription has its own window.
    h.clock.advance(30_000);
    expect(await h.kernel.ingest(feishu("线上报错了，帮忙排查一下 order-service"), "feishu")).toMatchObject({ routedBy: "watch", coalesced: ["review-hub"] });
    await h.kernel.idle();
    expect(h.script.callsOf("hub")).toHaveLength(0);
    const at = Object.fromEntries(h.kernel.inbox.listMessagesSync({ cellId: "review-hub" }).map((m) => [m.envelope.id, m.deliverAt - T0]));
    expect(at).toEqual({ "fs-1": 60_000, "fs-2": 60_000, "fs-4": 110_000 });

    // The first window closes: one Run, both review requests in it.
    let absorbed = "";
    h.script.add("hub", async (req) => {
      const text = requestText(req);
      expect(text).toContain("MR !41");
      expect(text).toContain("MR !42");
      expect(text).not.toContain("order-service");
      // While the hub is working, an unrelated mention lands: it is delivered at once and joins this very Run.
      await h.kernel.ingest(feishu("@ng-bot 帮我订个会议室", { mentions: ["ng-bot"], eventKind: "mention" }), "feishu");
      return tool("set_state", { patches: { "hub:topics": ["MR !41", "MR !42"] } });
    });
    h.script.add("hub", (req) => {
      absorbed = requestText(req);
      return tool("handback", { envelopeId: "fs-5", reason: "不是代码评审的事" });
    });
    h.script.add("hub", { text: "已分派。" });
    h.clock.advance(10_000);
    await h.kernel.idle();
    expect(absorbed).toContain("帮我订个会议室");
    expect(h.of("run.started").filter((e) => e.cellId === "review-hub")).toHaveLength(1);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "review-hub", envelopeId: "fs-5" })[0]!.status).toBe("handed_back");
    const back = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.handback })[0]!.envelope.payload as HandbackPayload;
    expect(back).toMatchObject({ fromCellId: "review-hub", reason: "不是代码评审的事", original: { id: "fs-5" } });

    // The keyword window closes later, on its own schedule.
    h.script.add("hub", (req) => {
      expect(requestText(req)).toContain("order-service");
      return { text: "排查已派。" };
    });
    h.clock.advance(50_000);
    await h.kernel.idle();
    expect(h.of("run.started").filter((e) => e.cellId === "review-hub")).toHaveLength(2);
  });

  it("a malformed operator is refused when the watch is created", async () => {
    const h = await boot();
    const bad = (filter: Record<string, unknown>) => () => h.kernel.spawnCell("desk", { preset: "hub", watches: [{ threadOrFilter: filter }] });
    expect(bad({ "payload.text": { $regex: "x" } })).toThrow(/unknown operator/);
    expect(bad({ "payload.text": { $anyKeyword: [] } })).toThrow(/non-empty array/);
    expect(bad({ "payload.text": { $contains: 3 } })).toThrow(/non-empty string/);
    expect(bad({ "payload.mentions": { $in: ["a"], $contains: "b" } })).toThrow(/unknown operator/);
  });
});

// docs/05 §5.3 — the external main agent orchestrates like the owner but is never the owner.
describe("agent principal on the control plane", () => {
  const AGENT = "agent:main";

  it("may spawn, message, steer, pause/resume and close any cell; may not create roots or widen bounds", async () => {
    const h = await boot();
    h.kernel.spawnCell("desk", { id: "proj", preset: "project", title: "改 TUI 表格复制", meta: { role: "proj" } }, "coordinate", { principalId: AGENT });
    expect(h.kernel.getCell("proj")!.principalId).toBe(AGENT);
    h.script.add("proj", tool("wait", { reason: "等指示" }));
    await h.kernel.idle();

    expect(h.kernel.sendToCell("proj", { text: "仓库在 /srv/tui" }, { principalId: AGENT })).toMatchObject({ status: "delivered" });
    expect(h.kernel.control("proj", { action: "pause" }, { principalId: AGENT })).toMatchObject({ applied: true });
    expect(h.kernel.control("proj", { action: "resume" }, { principalId: AGENT })).toMatchObject({ applied: true });
    h.kernel.updateCell("proj", { title: "改 TUI 表格复制（进行中）" }, { principalId: AGENT });
    // Asking for more than the cell has is clamped, as it would be for an ancestor cell.
    const before = h.kernel.getCell("proj")!.bounds.maxTokens;
    h.kernel.updateCell("proj", { bounds: { maxTokens: before * 10 } }, { principalId: AGENT });
    expect(h.kernel.getCell("proj")!.bounds.maxTokens).toBe(before);
    expect(() => h.kernel.createRootCell({ id: "desk2", preset: "inline" }, { principalId: AGENT })).toThrow(/only the owner/);
    expect((await h.kernel.closeCell("proj", "cancelled", { principalId: AGENT })).closed).toEqual(["proj"]);
  });

  it("cannot approve an outward send or continue past an exhausted budget; can decide ordinary cards", async () => {
    const h = await boot();
    // An outward message waiting on its card.
    h.script.add("desk", tool("send_message", { to: "channel:memory:alice", text: "稍后回复你", summary: "reply to Alice" }));
    await h.memory.inject({ from: "alice", text: "问个问题" });
    await h.kernel.idle();
    const [send] = h.kernel.gate.listPendingSync();
    await expect(h.kernel.resolveApproval(send!.actionId, { decision: "approve", approverId: AGENT, seenArtifactVersion: 1 })).rejects.toSatisfy((e) => isNgError(e, "bounds_violation"));
    expect(h.kernel.gate.getApprovalSync(send!.actionId)!.status).toBe("pending");
    expect(h.memory.sent).toHaveLength(0);
    // Declining is no escalation of privilege.
    expect(await h.kernel.resolveApproval(send!.actionId, { decision: "deny", approverId: AGENT, reason: "先别发" })).toMatchObject({ status: "denied" });

    // A cell that ran out of budget.
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", title: "修 CI", meta: { role: "w" }, bounds: { maxTokens: 1_000 } }, "fix");
    h.script.add("w", { text: "working", usage: { inputTokens: 900, outputTokens: 200 } });
    await h.kernel.idle();
    const budget = h.kernel.gate.listPendingSync().find((c) => c.cellId === "w")!;
    await expect(h.kernel.resolveApproval(budget.actionId, { decision: "continue", approverId: AGENT })).rejects.toSatisfy((e) => isNgError(e, "bounds_violation"));
    expect(h.kernel.gate.usageSync("w").limitTokens).toBe(1_000);
    expect(h.kernel.gate.getApprovalSync(budget.actionId)!.status).toBe("pending");
    // The owner can.
    expect(await h.kernel.resolveApproval(budget.actionId, { decision: "continue" })).toMatchObject({ status: "continued" });

    // An ordinary blocked card is the agent's to answer on the owner's behalf.
    h.kernel.spawnCell("desk", { id: "p", preset: "project", meta: { role: "p" } }, "go");
    h.script.add("p", tool("request_approval", { kind: "escalation", title: "目录里有未提交改动", summary: "blocked", escalation: { reason: "blocked", explanation: "等你提交 / stash / 另开目录" } }));
    await waitFor(() => h.kernel.gate.listPendingSync().some((c) => c.cellId === "p"), 5_000, "the blocked card");
    const blocked = h.kernel.gate.listPendingSync().find((c) => c.cellId === "p")!;
    expect(await h.kernel.resolveApproval(blocked.actionId, { decision: "continue", approverId: AGENT, note: "主人说 stash 后继续" })).toMatchObject({ status: "continued" });
    expect(h.kernel.gate.getApprovalSync(blocked.actionId)!.approverId).toBe(AGENT);
  });
});

describe("preferences reach cells that are already alive", () => {
  it("a preference saved after a cell's first Run is in that cell's system prompt at its next Run", async () => {
    const h = await boot();
    h.script.add("desk", { text: "ok" });
    await h.ui.capture({ text: "第一条" });
    await h.kernel.idle();
    expect(h.script.callsOf("desk")[0]!.system).not.toContain("ship-mr");

    h.kernel.context.upsertSkillOrNoteSync("desk", { kind: "preference", name: "code-change-followup", description: "改完代码用 /ship-mr 提 MR", body: "改完代码后直接用 /ship-mr 提 MR，不用再问。", scope: "global", mode: "upsert" });
    h.script.add("desk", { text: "ok" });
    await h.ui.capture({ text: "第二条" });
    await h.kernel.idle();
    expect(h.script.callsOf("desk")[1]!.system).toContain("/ship-mr");
  });
});
