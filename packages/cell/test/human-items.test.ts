import { afterEach, expect, it } from "vitest";
import { all, PAYLOAD } from "@ng/protocol";
import { boot, cleanupAll, HOUR } from "./helpers";

afterEach(cleanupAll);

it("commits one of two competing choices with its exact callback and preserves the losing choice as a conflict", async () => {
  const { kernel } = await boot();
  const item = kernel.humanItems.create(
    {
      title: "从哪一份材料开始",
      subjectKey: "arb:materials",
      options: [{ id: "first", label: "第一份", effect: "reply", payload: { document: "one" } }],
    },
    "desk",
  );
  const results = await Promise.allSettled([
    kernel.humanItems.decide(item.id, { optionId: "first", seenItemRevision: 1, note: "请保留原稿" }, "owner"),
    kernel.humanItems.decide(item.id, { optionId: "system.deny", seenItemRevision: 1 }, "owner"),
  ]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect(kernel.humanItems.get(item.id)).toMatchObject({ status: "resolved", itemRevision: 2 });
  const receipts = kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved });
  expect(receipts.map((m) => m.envelope.payload)).toEqual([
    expect.objectContaining({ optionId: "first", note: "请保留原稿", payload: { document: "one" } }),
  ]);
  expect(all(kernel.db, "SELECT * FROM approval_stats")).toEqual([]);
});

it("resurfaces a snoozed personal reminder on time without a model turn, then completes it without a callback", async () => {
  const { kernel, clock, script } = await boot();
  const item = kernel.humanItems.create(
    { title: "打电话", subjectKey: "reminder:phone", category: "action", options: [{ id: "done", label: "办完了", effect: "complete" }] },
    null,
  );
  const until = clock.now() + HOUR;
  await kernel.humanItems.decide(item.id, { optionId: "system.defer", seenItemRevision: 1, until }, "owner");
  expect(kernel.humanItems.list()).toEqual([]);
  clock.set(until);
  await kernel.idle();
  const [due] = kernel.humanItems.list();
  expect(due).toMatchObject({ id: item.id, status: "pending", itemRevision: 3 });
  await kernel.humanItems.decide(item.id, { optionId: "done", seenItemRevision: 3 }, "owner");
  expect(kernel.humanItems.list()).toEqual([]);
  expect(script.callsOf("desk")).toHaveLength(0);
  expect(kernel.context.listEvidenceSync("desk").some(e => e.record.kind === "inbound" && e.record.envelope.type === PAYLOAD.timerFired)).toBe(false);
  expect(kernel.inbox.listMessagesSync({ type: PAYLOAD.approvalResolved })).toEqual([]);
});

it("checks callback restrictions and restricts destructive options to the named project", async () => {
  const { kernel } = await boot();
  expect(() =>
    kernel.humanItems.create({ title: "卡", subjectKey: "arb:x", options: [{ id: "done", label: "完成", effect: "complete" }] }, "desk"),
  ).toThrow();
  expect(() =>
    kernel.humanItems.create({ title: "卡", subjectKey: "arb:x", options: [{ id: "send", label: "发送", effect: "execute" }] }, "desk"),
  ).toThrow();
  expect(() =>
    kernel.humanItems.create(
      {
        title: "卡",
        subjectKey: "arb:x",
        options: [{ id: "end", label: "停工", effect: "terminate", terminateMode: "cancel_task", targetCellIds: ["desk"] }],
      },
      "desk",
    ),
  ).toThrow();
});

it("a declined root ledger stays held across later messages", async () => {
  const h = await boot();
  const ledger = h.kernel.gate.usageSync("desk");
  h.kernel.gate.meter("desk", { tokens: ledger.limitTokens + 1, billedCents: 0 });
  await h.ui.capture({ text: "待办一" });
  await h.kernel.idle();
  const denied = h.kernel.humanItems.list().find((item) => item.subjectKey === "kernel:budget:desk")!;
  expect(denied).toBeDefined();
  await h.kernel.humanItems.decide(denied.id, { optionId: "system.deny", seenItemRevision: denied.itemRevision }, "agent:helper");
  await h.ui.capture({ text: "待办二" });
  await h.kernel.idle();
  expect(h.kernel.humanItems.list().filter((item) => item.subjectKey === denied.subjectKey)).toHaveLength(0);
  expect(h.kernel.getCell("desk")?.status).toBe("active");
  expect(h.kernel.inbox.listMessagesSync({ type: PAYLOAD.approvalResolved })).toHaveLength(0);
  expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", status: ["pending"], type: PAYLOAD.userMessage })).toHaveLength(2);
});

it("withdraws an unread reply; after a claim and crash release it sends one correction", async () => {
  const { kernel } = await boot({ start: false });
  const create = () =>
    kernel.humanItems.create(
      { title: "确认安排", subjectKey: "arb:plan", options: [{ id: "yes", label: "同意", effect: "reply" }] },
      "desk",
    );
  const first = create();
  const accepted = await kernel.humanItems.decide(first.id, { optionId: "yes", seenItemRevision: 1 }, "owner");
  if (!("activityId" in accepted) || !accepted.activityId) throw new Error("missing undo activity");
  expect((await kernel.humanItems.undo(accepted.activityId, "owner")).status).toBe("undone");
  expect(kernel.humanItems.get(first.id)?.status).toBe("pending");
  expect(kernel.inbox.listMessagesSync({ type: PAYLOAD.approvalResolved })[0]).toMatchObject({ status: "cancelled", firstClaimedAt: null });
  const again = await kernel.humanItems.decide(first.id, { optionId: "yes", seenItemRevision: 3 }, "owner");
  if (!("activityId" in again) || !again.activityId) throw new Error("missing correction activity");
  const claim = kernel.inbox.claimNextRunSync("desk", "test", "serial_coalesce", 10_000)!;
  kernel.inbox.releaseSync(claim.claimId, "recovered", { countAttempt: false });
  expect((await kernel.humanItems.undo(again.activityId, "owner")).status).toBe("corrected");
  expect(kernel.humanItems.get(first.id)?.status).toBe("resolved");
  expect(kernel.inbox.listMessagesSync({ type: PAYLOAD.cellMessage })).toHaveLength(1);
  await expect(kernel.humanItems.undo(again.activityId!, "owner")).rejects.toThrow();
});

it("reopens only worker generations that closed with the project", async () => {
  const { kernel } = await boot({ start: false });
  kernel.spawnCell("desk", { id: "project", preset: "project" });
  for (const id of ["old", "together"]) kernel.spawnCell("project", { id, preset: "worker", lifetime: "wakeable" });
  await kernel.closeCell("old", "cancelled");
  await kernel.closeCell("project", "completed");
  expect(await kernel.reopenProject("project", "owner")).toEqual(["project", "together"]);
  expect(kernel.getCell("old")?.status).toBe("closed");
  expect(kernel.getCell("together")?.status).toBe("active");
  expect(kernel.inbox.listMessagesSync({ cellId: "project", type: PAYLOAD.cellMessage, status: ["pending"] })).toHaveLength(1);
});

it("finishes old epoch cleanup without killing a job started after reopening, then sends a second closure notice", async () => {
  const { kernel, dataDir } = await boot({ start: false });
  kernel.spawnCell("desk", { id: "project", preset: "project", cwd: dataDir });
  let unblock!: () => void;
  let reached!: () => void;
  const entered = new Promise<void>((r) => {
    reached = r;
  });
  const gate = new Promise<void>((r) => {
    unblock = r;
  });
  const stop = kernel.workspace.stopRuntime.bind(kernel.workspace);
  kernel.workspace.stopRuntime = async (id, stillClosed) => {
    reached();
    await gate;
    await stop(id, stillClosed);
  };
  const closing = kernel.closeCell("project", "completed");
  await entered;
  const opening = kernel.reopenProject("project", "owner");
  try {
    await Promise.resolve();
    expect(kernel.getCell("project")?.status).toBe("closed");
    unblock();
    await opening;
    const port = await kernel.workspace.acquire("project", "none", { cwd: dataDir });
    const job = await port.startJob({ command: "sleep 15" });
    unblock();
    await closing;
    expect(kernel.workspace.getJobSync(job.jobId)?.state).toBe("running");
  } finally {
    unblock();
    kernel.workspace.stopRuntime = stop;
  }
  await kernel.closeCell("project", "cancelled");
  const ids = kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => m.envelope.id);
  expect(new Set(ids).size).toBe(2);
});

it("resolves one referenced wait and escalates the unanswered one exactly once across both monitors", async () => {
  const { kernel, script, ui, clock } = await boot();
  script.add("project", { toolCalls: [{ name: "wait", input: { reason: "等 A", waitingFor: "inbox:desk", waitId: "a", refId: "ra" } }] });
  kernel.spawnCell("desk", { id: "project", preset: "project" }, "等待材料");
  await kernel.idle();
  script.add("project", { toolCalls: [{ name: "wait", input: { reason: "等 B", waitingFor: "inbox:desk", waitId: "b", refId: "rb" } }] });
  kernel.inbox.enqueueSync("project", {
    id: "unrelated",
    from: "channel:memory:x",
    kind: "event",
    type: "user.message",
    principalId: "memory:x",
    createdAt: clock.now(),
    payload: { text: "还有一份材料" },
  });
  await kernel.idle();
  expect(
    kernel
      .listWaits(["project"])
      .map((w) => w.waitId)
      .sort(),
  ).toEqual(["a", "b"]);
  const item = kernel.humanItems.create(
    {
      title: "选择材料",
      subjectKey: "arb:materials",
      relatedProjectIds: ["project"],
      options: [{ id: "accept", label: "采用 A", effect: "reply" }],
    },
    "desk",
  );
  script.add("desk", {
    toolCalls: [{ name: "send_message", input: { to: "inbox:project", refId: "ra", text: "A 已就绪", summary: "答复 A" } }],
  });
  await kernel.humanItems.decide(item.id, { optionId: "accept", seenItemRevision: 1 }, "owner");
  await kernel.idle();
  expect(kernel.listWaits(["project"]).map((w) => w.waitId)).toEqual(["b"]);
  clock.advance(60_000);
  kernel.checkStalls();
  await kernel.idle();
  expect(kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.arbitrationUnanswered })).toHaveLength(1);
  expect(kernel.humanItems.list().filter((i) => i.subjectKey.startsWith("kernel:stalled:"))).toHaveLength(1);
});

it("a direct owner message clears one named wait even when its reference is absent", async () => {
  const { kernel, script } = await boot();
  script.add("worker", {toolCalls:[{name:"wait",input:{reason:"等负责人",waitingFor:"inbox:desk",waitId:"material",refId:"ref-material"}}]});
  kernel.spawnCell("desk",{id:"helper",preset:"worker",lifetime:"wakeable"},"准备材料");
  await kernel.idle();
  expect(kernel.listWaits(["helper"])).toMatchObject([{waitId:"material"}]);
  kernel.directMessage("helper",{text:"我确认这份材料可以用"},{principalId:"owner"});
  await kernel.idle();
  expect(kernel.listWaits(["helper"])).toEqual([]);
});

it("preserves a manual pause when the owner lifts budget limits and releases the declined ledger", async () => {
  const { kernel } = await boot({ start: false });
  kernel.spawnCell("desk", { id: "held", preset: "project" });
  kernel.spawnCell("desk", { id: "manual", preset: "project" });
  kernel.control("manual", { action: "pause" }, { principalId: "owner" });
  kernel.gate.declineBudgetSync("held", "owner");
  expect(kernel.getCell("held")?.pauseReason).toBe("budget_declined");
  expect(kernel.setBudgetLimits(false, { principalId: "owner" }).releasedCells).toContain("held");
  expect(kernel.getCell("held")?.status).toBe("active");
  expect(kernel.gate.budgetDeclinedSync("held")).toBe(false);
  expect(kernel.getCell("manual")?.pauseReason).toBe("manual");
});

it("copies a direct message according to ccParent independently of lifetime", async () => {
  const { kernel } = await boot({ start: false });
  kernel.spawnCell("desk", { id: "listener", preset: "inline", ccParent: true, lifetime: "persistent" });
  kernel.spawnCell("desk", { id: "solo", preset: "worker", ccParent: false, lifetime: "wakeable" });
  expect(kernel.directMessage("listener", { text: "保持监听" }, { principalId: "owner" })).toMatchObject({ ccTo: "desk" });
  expect(kernel.directMessage("solo", { text: "收到" }, { principalId: "owner" })).toMatchObject({ ccTo: null });
});

it("reserves execution for the owner and lets an agent defer, revise and deny an external send", async () => {
  const { kernel } = await boot({ start: false });
  const deferred = kernel.gate.authorizeSync(
    {
      type: "channel.send",
      target: "channel:memory:party",
      content: { format: "text", body: "稿" },
      sideEffect: "external",
      summary: "外发草稿",
      subjectKey: "reply:memory:party",
      cardOptions:[{id:"execute",label:"发送",effect:"execute"},{id:"revise",label:"修改",effect:"revise"}],
    },
    { cellId: "desk", epoch: kernel.getCell("desk")!.epoch, principalId: "cell:desk" },
  );
  if (deferred.type !== "defer") throw Error(deferred.type);
  const item = kernel.humanItems.get(deferred.actionId)!;
  const decide = (optionId:string, rev:number) => kernel.humanItems.decide(item.id,{optionId,seenItemRevision:rev,note:"请更新"}, "agent:helper");
  await expect(decide("execute",1)).rejects.toThrow("主人");
  await expect(decide("system.defer",1)).resolves.toMatchObject({status:"snoozed"});
  await expect(decide("revise",2)).resolves.toMatchObject({status:"revising"});
  await expect(decide("system.deny",3)).resolves.toMatchObject({status:"cancelled"});
});

it("delivers an alternative on a controlled send without approval, and counts owner denials once", async () => {
  const {kernel}=await boot({start:false});
  const make = (subjectKey:string) => {
    const r=kernel.gate.authorizeSync({type:"channel.send",summary:"回复",subjectKey,sideEffect:"external",target:"channel:memory:party",
      content:{format:"text",body:"对外答复"},cardOptions:[{id:"send",label:"确认发送",effect:"execute"},{id:"research",label:"先调研",effect:"reply"}]},
      {cellId:"desk",epoch:0,principalId:"cell:desk"});
    if (r.type!=="defer") throw Error(r.type);
    return r.actionId;
  };
  const id=make("scope");
  await kernel.humanItems.decide(id,{optionId:"research",seenItemRevision:1},"agent:helper");
  expect(kernel.inbox.listMessagesSync({type:PAYLOAD.approvalResolved})[0]!.envelope.payload).toMatchObject({optionId:"research",status:"cancelled"});
  expect(kernel.hub.listOutboxSync({channelId:"memory"})).toEqual([]);
  await kernel.humanItems.decide(make("deny"),{optionId:"system.deny",seenItemRevision:1},"owner");
  expect(kernel.gate.approvalStatsSync()).toMatchObject([{approved:0,denied:1}]);
});

it("shows the exact quota a custom budget option will apply", async () => {
  const { kernel } = await boot({ start: false });
  const before = kernel.gate.usageSync("desk");
  kernel.gate.upsertPolicyRuleSync({ match: { type: "*" }, effect: "allow", createdBy: "owner" });
  const result = kernel.gate.authorizeSync(
    {
      type: "custom",
      name: "escalation.budget_exhausted",
      summary: "继续",
      sideEffect: "external",
      subjectKey: "manual:budget",
      cardOptions: [{ id: "small", label: "继续", effect: "execute", payload: { raise: { tokens: 17, cents: 2 } } }],
    },
    { cellId: "desk", epoch: kernel.getCell("desk")!.epoch, principalId: "cell:desk" },
  );
  if (result.type !== "defer") throw Error(result.type);
  const item = kernel.humanItems.get(result.actionId)!;
  expect(item.options[0]!.label).toContain("17 tokens、2 美分");
  await kernel.humanItems.decide(item.id, { optionId: "small", seenItemRevision: item.itemRevision }, "owner");
  expect(kernel.gate.usageSync("desk")).toMatchObject({ raisedTokens: before.raisedTokens + 17, raisedCents: before.raisedCents + 2 });
});

it("routes a subtree's cancel receipt to desk, restores the reopened epoch, and reports a claimed cancel", async () => {
  const {kernel} = await boot({start:false});
  kernel.spawnCell("desk", {id:"project", preset:"project"});
  kernel.spawnCell("project", {id:"worker", preset:"worker", lifetime:"wakeable"});
  const item = kernel.humanItems.create({
    title:"结束项目", subjectKey:"arb:close", relatedProjectIds:["project"],
    options:[{id:"close", label:"中止", effect:"terminate", terminateMode:"cancel_task", targetCellIds:["project"], confirm:"确认中止项目"}],
  }, "worker");
  async function cancel() {
    const result = await kernel.humanItems.decide(item.id, {
      optionId:"close", seenItemRevision:kernel.humanItems.get(item.id)!.itemRevision, confirmedTargets:["project"],
    }, "owner");
    if (!("activityId" in result) || !result.activityId) throw Error("missing cancel activity");
    return result.activityId;
  }
  const first = await cancel();
  expect(kernel.inbox.listMessagesSync({cellId:"desk", type:PAYLOAD.approvalResolved, status:["pending"]})).toHaveLength(1);
  expect(await kernel.humanItems.undo(first, "owner")).toMatchObject({status:"undone"});
  expect(kernel.getCell("worker")?.status).toBe("active");
  expect(kernel.humanItems.get(item.id)?.epoch).toBe(kernel.getCell("worker")!.epoch);
  const again = await cancel();
  expect(kernel.inbox.claimNextRunSync("desk", "test", "serial_coalesce", 10_000)).toBeTruthy();
  await expect(kernel.humanItems.undo(again, "owner")).rejects.toThrow("reopen_project");
  expect(kernel.getCell("project")?.status).toBe("closed");
});
