import { afterEach, describe, expect, it } from "vitest";
import {
  createEnvelope,
  get,
  run,
  PAYLOAD,
  type Envelope,
  type HandbackPayload,
  type UserMessagePayload,
} from "@ng/protocol";
import { boot, cleanupAll, HOUR, requestText, T0, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

const GRACE = 2_000;

function project(h: Harness, id = "proj", parked = false): void {
  h.kernel.spawnCell("desk", { id, preset: "project", title: "Harness 对比", meta: { role: id, projectCellId: id } }, undefined, { principalId: h.kernel.ownerPrincipal });
  if (parked) h.kernel.control(id, {action: "pause", pauseReason: "parked"}, { principalId: h.kernel.ownerPrincipal });
}

function addWait(h: Harness, from: string, to: string, id = to, registration = id): void {
  run(h.kernel.db, `INSERT INTO cell_waits(cell_id, wait_id, registration_id, waiting_for, reason, epoch, created_at)
    VALUES (?,?,?,?,?,?,?)`, [from, id, registration, `inbox:${to}`, "await reply", h.kernel.getCell(from)!.epoch, h.clock.now()]);
}

const stall = (h: Harness) => get<{ since: number; notified_at: number | null }>(h.kernel.db, "SELECT since, notified_at FROM cell_stalls WHERE cell_id = 'proj'");
const checks = (h: Harness, cellId = "proj") => h.kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.stalledCheck });

// docs/05 guard 2 — an active project always has one of five anchors, and when it has none it is told exactly once.
describe("stall check", () => {
  it("a project with nothing moving it is stamped and woken exactly once; an idle wake-up does not earn a second one; a new stall does", async () => {
    const h = await boot();
    project(h);
    await h.kernel.idle();

    expect(h.kernel.anchorsOf("proj")).toMatchObject({ agent: false, external: false, internal: false, human: false, parked: false, stalled: true });
    expect(stall(h)).toMatchObject({ since: T0, notified_at: T0 });
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
    const escalation = h.kernel.humanItems.list().find(item => item.subjectKey.startsWith("kernel:stalled:"))!;
    expect(escalation.relatedProjectIds).toEqual(["proj"]);
    expect(h.kernel.anchorsOf("proj")).toMatchObject({ human: true, stalled: false });
    h.clock.advance(6 * HOUR);
    h.kernel.checkStalls();
    await h.ui.capture({ text: "无关的一条随手记" }, "owner");
    await h.kernel.idle();
    expect(checks(h)).toHaveLength(1);
    expect(h.script.callsOf("proj")).toHaveLength(1);
    expect(h.kernel.humanItems.list().filter(item => item.subjectKey.startsWith("kernel:stalled:"))).toHaveLength(1);

    // A real anchor (the owner now has an open action) lifts the stall and re-arms the notice…
    const task = h.kernel.humanItems.create({
      title: "审阅代码", subjectKey: "review:code", relatedProjectIds: ["proj"], category: "action",
      options: [{ id: "done", label: "已审阅", effect: "reply" }],
    }, "proj");
    await h.kernel.humanItems.decide(escalation.id, {optionId:"reply", seenItemRevision:escalation.itemRevision}, "owner");
    await h.kernel.idle();
    expect(h.kernel.anchorsOf("proj")).toMatchObject({ human: true, stalled: false });
    expect(stall(h)).toBeUndefined();
    // …so when that anchor goes away without anything taking its place, the project is told once more.
    const again = h.clock.now();
    await h.kernel.humanItems.decide(task.id, {optionId: "done", seenItemRevision: task.itemRevision}, "owner");
    await h.kernel.idle();
    expect(stall(h)).toMatchObject({ since: again, notified_at: again });
    expect(checks(h).map(m => m.envelope.payload)).toMatchObject([{stalledSince:T0}, {stalledSince:again}]);
    expect(new Set(checks(h).map(m => m.envelope.id)).size).toBe(2);
  });

  it("a stall that is over before the grace period ends never reaches the model", async () => {
    const h = await boot();
    project(h);
    await h.kernel.idle();
    expect(checks(h)).toHaveLength(1);

    // Within the grace period the project gets a checker with a timer: an external anchor.
    h.kernel.spawnCell("proj", { id: "mr-watch", preset: "checker", title: "盯 MR !12", schedules: [{ deliverAt: T0 + HOUR }] }, undefined, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.kernel.anchorsOf("proj")).toMatchObject({ external: true, stalled: false });
    // The notice is withdrawn together with the stall it was about.
    expect(checks(h)[0]!.status).toBe("cancelled");
    h.clock.advance(GRACE);
    await h.kernel.idle();
    expect(h.script.callsOf("proj")).toHaveLength(0);
    expect(stall(h)).toBeUndefined();
  });

  it("each of the five anchors counts; paused and non-active projects are parked, never stalled", async () => {
    const h = await boot();
    project(h, "p-agent");
    project(h, "p-human");
    project(h, "p-wait");
    project(h, "p-someday", true);
    project(h, "p-paused");
    h.kernel.control("p-paused", { action: "pause" }, { principalId: h.kernel.ownerPrincipal });

    // @Agent: a worker with work queued; @Human: a pending card; @Waiting(internal): an open wait on a live cell.
    h.kernel.spawnCell("p-agent", { id: "w", preset: "worker", meta: { role: "w" } }, "分析 trae 代码", { principalId: h.kernel.ownerPrincipal });
    h.script.add("w", tool("wait", { reason: "等编译" }));
    h.script.add("p-human", tool("request_approval", { kind: "escalation", title: "需要你确认", summary: "blocked", escalation: { reason: "blocked", explanation: "仓库里有你没提交的改动" } }));
    h.kernel.sendToCell("p-human", { text: "go" }, { principalId: h.kernel.ownerPrincipal });
    h.script.add("p-wait", tool("wait", { reason: "等 desk 裁决", waitingFor: "inbox:desk" }));
    h.kernel.sendToCell("p-wait", { text: "go" }, { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.anchorsOf("p-agent")).toMatchObject({ agent: true, stalled: false });
    await h.kernel.idle();

    expect(h.kernel.anchorsOf("p-human")).toMatchObject({ human: true, stalled: false });
    expect(h.kernel.anchorsOf("p-wait")).toMatchObject({ internal: false, stalled: true });
    expect(h.kernel.anchorsOf("p-someday")).toMatchObject({ parked: true, stalled: false });
    expect(h.kernel.anchorsOf("p-paused")).toMatchObject({ parked: true, stalled: false });
    // The worker ended its turn with a bare wait: nothing will ever wake it, so its project has no anchor left.
    expect(h.kernel.anchorsOf("p-agent")).toMatchObject({ agent: false, stalled: true });
    expect(Object.fromEntries(["p-agent", "p-human", "p-wait", "p-someday", "p-paused"].map((id) => [id, checks(h, id).length]))).toEqual({
      "p-agent": 1,
      "p-human": 0,
      "p-wait": 1,
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
    h.kernel.sendToCell("proj", { text: "start" }, { principalId: h.kernel.ownerPrincipal });
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
    await h.ui.capture({ text: "告诉 proj 可以继续了" }, "owner");
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
    h.kernel.spawnCell("proj", { id: "w1", preset: "worker", meta: { role: "w1" } }, "task", { principalId: h.kernel.ownerPrincipal });
    h.script.add("w1", tool("wait", { reason: "等 proj 的补充说明", waitingFor: "inbox:proj" }));
    h.script.add("proj", tool("wait", { reason: "等 w1 交卷", waitingFor: "inbox:w1" }));
    h.kernel.sendToCell("proj", { text: "go" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.kernel.anchorsOf("proj")).toMatchObject({ internal: false, stalled: true });

    await h.kernel.closeCell("w1", "cancelled", { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.listWaits(["w1"])).toEqual([]);
    // The closure notice informs the parent without answering its outstanding question.
    h.script.add("proj", { text: "w1 被关了" });
    await h.kernel.idle();
    expect(h.kernel.listWaits(["proj"])).toMatchObject([{waitingFor:"inbox:w1"}]);
    expect(h.kernel.anchorsOf("proj")).toMatchObject({ internal: false, stalled: true });
  });
});

// docs/05 §3.3 / §5.3 — direct routing with declarative operators and a fixed batching window.
describe("hub: operator watches, coalescing, absorption", () => {
  let seq = 0;
  function memory(text: string, extra: Partial<UserMessagePayload> = {}): Omit<Envelope, "to"> {
    return createEnvelope({ id: `fs-${++seq}`, from: "channel:memory:chat-review", principalId: "memory:ou_mary", kind: "event", type: PAYLOAD.userMessage, payload: { text, ...extra } });
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
        { threadOrFilter: { from: "channel:memory:chat-review", "payload.text": { $anyKeyword: ["帮忙排查", "线上报错"] } }, coalesceMs: 60_000 },
      ],
    }, undefined, { principalId: h.kernel.ownerPrincipal });

    const r1 = await h.kernel.ingest(memory("@ng-bot 看下 MR !41", { mentions: ["NG-Bot"], eventKind: "mention" }), "memory");
    expect(r1).toMatchObject({ routedBy: "watch", cellIds: ["review-hub"], coalesced: ["review-hub"] });
    h.clock.advance(20_000);
    await h.kernel.ingest(memory("@ng-bot 还有 MR !42", { mentions: ["ng-bot"], eventKind: "mention" }), "memory");
    // Not a mention, not a keyword: the desk's business as before.
    expect(await h.kernel.ingest(memory("中午吃什么"), "memory")).toMatchObject({ routedBy: "desk", cellIds: ["desk"] });
    // The second subscription has its own window.
    h.clock.advance(30_000);
    expect(await h.kernel.ingest(memory("线上报错了，帮忙排查一下 order-service"), "memory")).toMatchObject({ routedBy: "watch", coalesced: ["review-hub"] });
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
      await h.kernel.ingest(memory("@ng-bot 帮我订个会议室", { mentions: ["ng-bot"], eventKind: "mention" }), "memory");
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
    const bad = (filter: Record<string, unknown>) => () => h.kernel.spawnCell("desk", { preset: "hub", watches: [{ threadOrFilter: filter }] }, undefined, { principalId: h.kernel.ownerPrincipal });
    expect(bad({ "payload.text": { $regex: "x" } })).toThrow(/unknown operator/);
    expect(bad({ "payload.text": { $anyKeyword: [] } })).toThrow(/non-empty array/);
    expect(bad({ "payload.text": { $contains: 3 } })).toThrow(/non-empty string/);
    expect(bad({ "payload.mentions": { $in: ["a"], $contains: "b" } })).toThrow(/unknown operator/);
  });
});

// docs/05 §5.3, proposal 07 — the external main agent operates the control plane as the owner does.
describe("agent principal on the control plane", () => {
  const AGENT = "agent:main";

  it("may spawn, message, steer, pause/resume and close any cell and create roots, which cells and outsiders may not; narrows bounds like an ancestor", async () => {
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
    const before = h.kernel.getCell("proj")!.bounds.maxConcurrentChildren;
    h.kernel.updateCell("proj", { bounds: { maxConcurrentChildren: before * 10 } }, { principalId: AGENT });
    expect(h.kernel.getCell("proj")!.bounds.maxConcurrentChildren).toBe(before);
    for (const principalId of ["cell:desk", "cell:proj", "external:mail:someone", "mail:someone"]) {
      for (const create of [h.kernel.createRootCell, h.kernel.ensureRootCell]) {
        expect(() => create({ id: "desk2", preset: "inline" }, { principalId }), principalId).toThrow(expect.objectContaining({ code: "bounds_violation" }));
      }
    }
    expect(h.kernel.getCell("desk2")).toBeUndefined();
    expect(h.kernel.createRootCell({ id: "desk2", preset: "inline" }, { principalId: AGENT })).toMatchObject({ id: "desk2", parentId: null, principalId: AGENT });
    expect(h.kernel.ensureRootCell({ id: "desk2", preset: "inline" }, { principalId: AGENT }).id).toBe("desk2");
    expect(h.kernel.ensureRootCell({ id: "desk3", preset: "inline" }, { principalId: AGENT })).toMatchObject({ id: "desk3", principalId: AGENT });
    expect((await h.kernel.closeCell("proj", "cancelled", { principalId: AGENT })).closed).toEqual(["proj"]);
  });

});

describe("preferences reach cells that are already alive", () => {
  it("a preference saved after a cell's first Run is in that cell's system prompt at its next Run", async () => {
    const h = await boot();
    h.script.add("desk", { text: "ok" });
    await h.ui.capture({ text: "第一条" }, "owner");
    await h.kernel.idle();
    expect(h.script.callsOf("desk")[0]!.system).not.toContain("ship-mr");

    h.kernel.context.upsertSkillOrNoteSync("desk", { kind: "preference", name: "code-change-followup", description: "改完代码用 /ship-mr 提 MR", body: "改完代码后直接用 /ship-mr 提 MR，不用再问。", scope: "global", mode: "upsert" });
    h.script.add("desk", { text: "ok" });
    await h.ui.capture({ text: "第二条" }, "owner");
    await h.kernel.idle();
    expect(h.script.callsOf("desk")[1]!.system).toContain("/ship-mr");
  });
});

it("rechecks an orphaned worker wait outside projects", async () => {
  const h = await boot();
  h.kernel.spawnCell("desk", {id:"detached",preset:"worker",meta:{role:"detached"}}, undefined, { principalId: h.kernel.ownerPrincipal });
  h.script.add("detached",tool("wait",{waitingFor:"inbox:desk",waitId:"missing-reply",reason:"waiting for an answer"}));
  h.kernel.sendToCell("detached",{text:"wait for instructions"}, { principalId: h.kernel.ownerPrincipal });
  await h.kernel.idle();
  expect(checks(h,"detached").filter(m=>m.status==="pending")).toHaveLength(1);
});

it("requires a real source beyond an internal wait chain and rejects cycles of three cells", async () => {
  const h = await boot({ start: false });
  project(h);
  for (const id of ["a","b","c"]) h.kernel.spawnCell("proj", { id, preset: "worker" }, undefined, { principalId: h.kernel.ownerPrincipal });
  addWait(h, "a", "proj");
  expect(h.kernel.anchorsOf("proj").internal).toBe(false);
  addWait(h, "a", "b");
  addWait(h, "b", "c");
  expect(h.kernel.anchorsOf("proj").internal).toBe(false);
  h.kernel.updateCell("c", { watches: [{ threadOrFilter: { thread: "memory:result" } }] }, { principalId: h.kernel.ownerPrincipal });
  expect(h.kernel.anchorsOf("proj").internal).toBe(true);
  addWait(h, "c", "a");
  expect(h.kernel.anchorsOf("proj").internal).toBe(false);
});

it("arbitrates each affected project separately and re-arms a resolved incident for a new wait registration", async () => {
  const h = await boot();
  for (const id of ["a", "b", "c"]) {
    project(h,id);
    addWait(h,id,"desk","answer");
  }
  const decision = (subjectKey: string, projects: string[]) => h.kernel.humanItems.create({
    title: "需要裁决", subjectKey, relatedProjectIds: projects, options: [{ id: "ok", label: "答复", effect: "reply" }],
  }, "desk");
  const accept = async (item: { id: string; itemRevision: number }, optionId: string) => {
    await h.kernel.humanItems.decide(item.id, { optionId, seenItemRevision: item.itemRevision }, "owner");
    await h.kernel.idle();
  };
  decision("arb:a", ["a"]);
  h.kernel.spawnCell("desk", { id: "fixer", preset: "worker", meta: {relatedProjectIds:["c"]},
    watches: [{ threadOrFilter: {thread:"memory:fixer"} }] }, undefined, { principalId: h.kernel.ownerPrincipal });
  h.kernel.humanItems.create({category:"action", title:"普通待办", subjectKey:"action:b", relatedProjectIds:["b"],
    options:[{id:"done",label:"完成",effect:"reply"}]}, "b");
  const cause = "arb:shared";
  const escalations = () => h.kernel.humanItems.list().filter(i => i.subjectKey.startsWith(`kernel:stalled:${cause}:`));
  await accept(decision(cause, ["a", "b", "c"]), "ok");
  expect(escalations()).toMatchObject([{relatedProjectIds:["b"]}]);
  await accept(escalations()[0]!, "reply");
  expect(escalations()).toEqual([]);
  h.kernel.directMessage("b", {text:"这一轮结束"}, {principalId:"owner"});
  await h.kernel.idle();
  expect(h.kernel.listWaits(["b"])).toEqual([]);
  addWait(h,"b","desk","answer","second");
  await accept(decision(cause,["a","b","c"]), "ok");
  expect(escalations()).toMatchObject([{relatedProjectIds:["b"]}]);
  expect(h.kernel.inbox.listMessagesSync({cellId:"desk",type:PAYLOAD.arbitrationUnanswered})).toHaveLength(2);
});

it("settles multiple waits on an owner's direct answer even when the new run defers for approval", async () => {
  const h = await boot();
  project(h);
  addWait(h, "proj", "desk", "first");
  addWait(h, "proj", "desk", "second");
  h.script.add("proj", tool("request_approval", {kind:"escalation", title:"请确认", summary:"需要决定",
    escalation:{reason:"blocked",explanation:"请主人给出处理决定"}}));
  h.kernel.directMessage("proj", {text:"两项都确认"}, {principalId:"agent:main"});
  await h.kernel.idle();
  expect(h.of("run.finished").filter(e => e.cellId === "proj")).toMatchObject([{outcome:"deferred_for_approval"}]);
  expect(h.kernel.listWaits(["proj"])).toEqual([]);

  addWait(h,"proj","desk","named");
  h.kernel.inbox.enqueueSync("proj", {id:"answer", from:"inbox:desk", principalId:"cell:desk", kind:"event",
    type:PAYLOAD.cellMessage, payload:{ fromCellId:"desk", text:"answered", replyToId:"transport-message" }, createdAt:h.clock.now()});
  await h.kernel.idle();
  expect(h.kernel.listWaits(["proj"])).toMatchObject([{waitId:"named"}]);
  h.kernel.inbox.enqueueSync("proj", {id:"matched-answer", from:"inbox:desk", principalId:"cell:desk", kind:"event",
    type:PAYLOAD.cellMessage, payload:{fromCellId:"desk",text:"确认",replyToId:"named"},createdAt:h.clock.now()});
  await h.kernel.idle();
  expect(h.kernel.listWaits(["proj"])).toEqual([]);
});

it("shows a coordinator a human edit on a descendant's shared artifact", async () => {
  const h = await boot();
  project(h);
  h.kernel.spawnCell("proj", {id:"worker",preset:"worker"}, undefined, { principalId: h.kernel.ownerPrincipal });
  h.kernel.sendToCell("worker",{text:"continue"}, { principalId: h.kernel.ownerPrincipal });
  await h.kernel.idle();
  const draft = (body: string) => ({format:"text" as const, body});
  h.kernel.context.commitSync("worker",{artifact:{artifactId:"art_report",content:draft("draft"),updatedBy:"agent"}});
  h.kernel.context.commitSync("worker",{artifact:{artifactId:"art_report",expectedVersion:1,content:draft("reviewed"),updatedBy:"human"}});
  h.kernel.sendToCell("proj",{text:"查看共享文档"}, { principalId: h.kernel.ownerPrincipal });
  await h.kernel.idle();
  const prompt = requestText(h.script.callsOf("proj").at(-1)!);
  expect(prompt).toContain("[human-edited artifacts]");
  expect(prompt).toContain("art_report v2");
});

it("grounds a detached leaf on its own decision at the desk", async () => {
  const h = await boot({start:false});
  h.kernel.spawnCell("desk", {id:"leaf",preset:"worker"}, undefined, { principalId: h.kernel.ownerPrincipal });
  addWait(h, "leaf", "desk", "scope");
  const decision = {title:"选择范围", options:[{id:"reply",label:"回复",effect:"reply" as const}]};
  h.kernel.humanItems.create({...decision, category:"action", subjectKey:"scope"}, "desk");
  h.kernel.humanItems.create({...decision, subjectKey:"cell:another"}, "desk");
  expect(h.kernel.anchorsOf("leaf")).toMatchObject({internal:false,stalled:true});
  h.kernel.humanItems.create({...decision, subjectKey:"cell:leaf"}, "desk");
  expect(h.kernel.anchorsOf("leaf")).toMatchObject({internal:true,stalled:false});
});

it("defers a project self-check while desk arbitration owns a subset of its waits", async () => {
  const h = await boot({start:false});
  project(h);
  addWait(h, "proj", "desk", "budget");
  addWait(h, "proj", "other", "review");
  const waiter = {cellId:"proj", waitId:"budget", registrationId:"budget"};
  const wake = createEnvelope({from:"kernel:stall", principalId:"owner", kind:"event", type:PAYLOAD.arbitrationUnanswered,
    payload:{causeKey:"budget", waiters:[waiter]}}, h.clock);
  h.kernel.inbox.enqueueSync("desk", wake, {deliverAt: T0 + GRACE * 2});
  run(h.kernel.db, `INSERT INTO stall_incidents(incident_id,cause_key,wait_ids,wake_envelope_id,updated_at)
    VALUES(?,?,?,?,?)`, ["pending-budget", "budget", JSON.stringify([waiter]), wake.id, T0]);
  await h.kernel.start();
  await h.kernel.idle();
  h.clock.advance(GRACE);
  await h.kernel.idle();
  expect(checks(h).map(m => m.status)).toEqual(["done"]);
  expect(h.kernel.humanItems.list()).toHaveLength(0);
  h.clock.advance(GRACE);
  await h.kernel.idle();
  expect(h.kernel.humanItems.list()).toMatchObject([{relatedProjectIds:["proj"]}]);
  expect(get(h.kernel.db, "SELECT 1 FROM stall_incidents WHERE incident_id='pending-budget'")).toBeUndefined();
});

it("connects a desk arbitration escalation only to the detached leaf registration that triggered it", async () => {
  const h = await boot();
  for (const id of ["leaf", "other"]) {
    h.kernel.spawnCell("desk", {id, preset:"worker"}, undefined, { principalId: h.kernel.ownerPrincipal });
    addWait(h, id, "desk", "scope", id+"-first");
  }
  const wake = createEnvelope({from:"kernel:stall", principalId:"owner", kind:"event", type:PAYLOAD.arbitrationUnanswered,
    payload:{causeKey:"scope", waiters:[{cellId:"leaf", waitId:"scope", registrationId:"leaf-first"}]}}, h.clock);
  h.kernel.inbox.enqueueSync("desk", wake);
  await h.kernel.idle();
  expect(h.kernel.humanItems.list().filter(i => i.subjectKey.startsWith("kernel:stalled:scope:"))).toHaveLength(1);
  expect(h.kernel.anchorsOf("leaf")).toMatchObject({human:true, internal:true, stalled:false});
  expect(h.kernel.anchorsOf("other")).toMatchObject({human:false, internal:false, stalled:true});
  run(h.kernel.db, "UPDATE cell_waits SET registration_id='next' WHERE cell_id='leaf'");
  expect(h.kernel.anchorsOf("leaf")).toMatchObject({human:false, internal:false, stalled:true});
});

it("keeps concurrent escalations with the same cause separate by wait registration", async () => {
  const h = await boot();
  for (const id of ["alpha","beta"]) {
    project(h,id);
    addWait(h,id,"desk","review");
    const decision = h.kernel.humanItems.create({
      title:"选择范围", subjectKey:"shared-review", relatedProjectIds:[id],
      options:[{id:"ok",label:"确认",effect:"reply"}],
    }, "desk");
    await h.kernel.humanItems.decide(decision.id, {optionId:"ok",seenItemRevision:decision.itemRevision}, "owner");
    await h.kernel.idle();
  }
  const open = h.kernel.humanItems.list().filter(i => i.subjectKey.startsWith("kernel:stalled:shared-review:"));
  expect(open.map(i => i.relatedProjectIds[0]).sort()).toEqual(["alpha","beta"]);
});

it("settles a self-park before escalating a stalled check and separates same-clock stall episodes", async () => {
  const h = await boot();
  project(h);
  await h.kernel.idle();
  h.kernel.control("proj",{action:"pause"}, { principalId: h.kernel.ownerPrincipal });
  await h.kernel.idle();
  h.kernel.control("proj",{action:"resume"}, { principalId: h.kernel.ownerPrincipal });
  await h.kernel.idle();
  const episodes = checks(h);
  expect(episodes.map(m => m.status)).toEqual(["cancelled","pending"]);
  expect(episodes[0]!.envelope.id).not.toBe(episodes[1]!.envelope.id);
  h.script.add("proj", tool("pause_self", {reason:"稍后继续"}));
  h.clock.advance(GRACE);
  await h.kernel.idle();
  expect(h.kernel.getCell("proj")).toMatchObject({status:"paused",pauseReason:"parked"});
  expect(h.kernel.humanItems.list(true)).toHaveLength(0);
});

it("matches a chat reply to an unnamed human wait and keeps a named backend wait until referenced", async () => {
  const h = await boot();
  project(h);
  h.script.add("proj", tool("wait", {waitingFor:"human",reason:"需要意见"}));
  h.kernel.sendToCell("proj",{text:"核对草稿"}, { principalId: h.kernel.ownerPrincipal });
  await h.kernel.idle();
  expect(h.kernel.listWaits(["proj"])).toMatchObject([{waitingFor:"human"}]);
  h.kernel.directMessage("proj",{text:"核对完了",replyToId:"timeline-entry"}, { principalId: h.kernel.ownerPrincipal });
  await h.kernel.idle();
  expect(h.kernel.listWaits(["proj"])).toEqual([]);
  addWait(h,"proj","desk","budget");
  run(h.kernel.db,"UPDATE cell_waits SET ref_id=? WHERE cell_id=?",["estimate","proj"]);
  h.kernel.inbox.enqueueSync("proj",createEnvelope({from:"inbox:desk",principalId:"cell:desk",kind:"event",type:PAYLOAD.cellMessage,
    payload:{fromCellId:"desk",text:"日常消息"}},h.clock));
  await h.kernel.idle();
  expect(h.kernel.listWaits(["proj"])).toMatchObject([{refId:"estimate"}]);
});

// Audit 2026-11-23 E03: a project that put the question to the owner (an action recorded as theirs, then wait "human")
// can answer the worker waiting on it once the owner acts — that is not a stall.
it("grounds a worker's wait on a project that itself waits for the owner with an open action", async () => {
  const h = await boot({ start: false });
  project(h);
  h.kernel.spawnCell("proj", { id: "w", preset: "worker" }, undefined, { principalId: h.kernel.ownerPrincipal });
  addWait(h, "w", "proj");
  h.kernel.humanItems.create({ category: "action", title: "确认未提交的改动怎么处理", subjectKey: "action:proj:dirty",
    options: [{ id: "done", label: "已办完", effect: "reply" }] }, "proj");
  // The open action alone does not cover a wait nobody will answer (P-SAFE-6: an unrelated to-do must not mask it)…
  const stranded = h.kernel.anchorsOf("proj");
  expect(stranded).toMatchObject({ internal: false, human: false, stalled: true });
  expect(stranded.detail).toContain("w waits for inbox:proj");
  expect(stranded.detail).not.toContain("the owner has no card or open action");
  // …but once the project itself waits for the owner on it, the chain worker → project → owner is whole.
  run(h.kernel.db, `INSERT INTO cell_waits(cell_id, wait_id, registration_id, waiting_for, reason, epoch, created_at)
    VALUES ('proj','human','human','human','等主人确认',?,?)`, [h.kernel.getCell("proj")!.epoch, h.clock.now()]);
  expect(h.kernel.anchorsOf("proj")).toMatchObject({ internal: true, human: true, stalled: false });
});

// Audit 2026-11-23 E04: the instant a shared fixer's turn ends, its result sits in the desk's inbox (or is being
// handled by the desk's run); the projects waiting on the desk are about to be answered.
it("grounds waits on the desk while a related fixer's result is pending or claimed there", async () => {
  const h = await boot({ start: false });
  project(h);
  project(h, "other");
  addWait(h, "proj", "desk", "ci");
  addWait(h, "other", "desk", "ci");
  h.kernel.spawnCell("desk", { id: "fixer", preset: "worker", meta: { relatedProjectIds: ["proj"] } }, undefined, { principalId: h.kernel.ownerPrincipal });
  h.kernel.inbox.cancelScheduledSync({ cellId: "fixer" });
  for (const m of h.kernel.inbox.listMessagesSync({ cellId: "fixer", status: ["pending"] })) h.kernel.inbox.consumePendingSync("fixer", m.envelope.id, h.kernel.getCell("fixer")!.epoch);
  expect(h.kernel.anchorsOf("proj")).toMatchObject({ internal: false, stalled: true });
  h.kernel.inbox.enqueueSync("desk", createEnvelope({ from: "inbox:fixer", to: "inbox:desk", principalId: "cell:fixer", kind: "result", type: PAYLOAD.cellResult,
    payload: { childCellId: "fixer", status: "completed", summary: "ci 已修复", childState: "dormant" } }, h.clock));
  expect(h.kernel.anchorsOf("proj")).toMatchObject({ internal: true, stalled: false });
  // The fixer was started for "proj" only: its result says nothing about "other".
  expect(h.kernel.anchorsOf("other")).toMatchObject({ internal: false, stalled: true });
});
