import { afterEach, expect, it } from "vitest";
import { PAYLOAD } from "@ng/protocol";
import { boot, cleanupAll, HOUR, registerTestPresets } from "./helpers";

afterEach(cleanupAll);

it("scopes matching subjects to their issuer when refreshing or undoing a decision", async () => {
  const { kernel } = await boot({ start: false });
  kernel.spawnCell("desk", { id: "sibling", preset: "worker" }, undefined, { principalId: kernel.ownerPrincipal });
  const draft = { title: "确认", subjectKey: "shared", options: [{ id: "yes", label: "同意", effect: "reply" as const }] };
  const first = kernel.humanItems.create(draft, "desk");
  const other = kernel.humanItems.create({ ...draft, title: "另一项确认" }, "sibling");
  expect(other.id).not.toBe(first.id);
  const updated = kernel.humanItems.create({ ...draft, title: "更新确认" }, "desk");
  expect(updated.id).toBe(first.id);
  expect(kernel.humanItems.get(other.id)).toMatchObject({ title: "另一项确认", itemRevision: 1 });
  const decision = await kernel.humanItems.decide(first.id, { optionId: "yes", seenItemRevision: updated.itemRevision }, "owner");
  await kernel.humanItems.undo(decision.activityId!, "owner");
  expect(kernel.humanItems.get(first.id)?.status).toBe("pending");
  expect(kernel.humanItems.get(other.id)).toMatchObject({ status: "pending", itemRevision: 1 });
});

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
});

it("shares simultaneous identical decisions and rejects background and outside actors and stale draft versions", async () => {
  const { kernel } = await boot({ start: false });
  kernel.context.commitSync("desk", { artifact: { artifactId: "plan", content: { format: "text", body: "first" }, updatedBy: "agent" } });
  const gateResult = kernel.gate.authorizeSync({
    type: "project.start", subjectKey: "proposal:launch", summary: "启动项目", sideEffect: "external", artifactId: "plan",
    proposal: { title: "测试项目", outcome: "交付总结", actions: [] },
  }, { cellId: "desk", epoch: 0, principalId: "cell:desk" });
  if (gateResult.type !== "defer") throw Error("expected a proposal card");
  const item = kernel.humanItems.get(gateResult.actionId)!;
  const choice = { optionId: "system.execute", seenItemRevision: item.itemRevision, seenArtifactVersion: 1 };
  for (const actor of ["cell:desk", "external:mail:someone"])
    await expect(kernel.humanItems.decide(item.id, choice, actor)).rejects.toMatchObject({ code: "bounds_violation" });
  kernel.context.commitSync("desk", { artifact: { artifactId: "plan", expectedVersion: 1, content: { format: "text", body: "revised" }, updatedBy: "human" } });
  await expect(kernel.humanItems.decide(item.id, choice, "owner")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/^草稿已变动：现在是 v\d+/) });
  const reviewed = { ...choice, seenArtifactVersion: 2 };
  const results = await Promise.all([
    kernel.humanItems.decide(item.id, reviewed, "owner"),
    kernel.humanItems.decide(item.id, reviewed, "owner"),
  ]);
  expect(results.map(r => r.status)).toEqual(["approved", "approved"]);
  expect(kernel.getCell(`project-${item.id}`)?.parentId).toBe("desk");
  expect(kernel.inbox.listMessagesSync({ type: PAYLOAD.approvalResolved })).toHaveLength(1);
});

it("starts the project when an external agent approves its card, with the agent on record", async () => {
  const { kernel } = await boot({ start: false });
  const approval = kernel.gate.authorizeSync({ type: "project.start", subjectKey: "proposal:agent", summary: "启动项目", sideEffect: "external",
    proposal: { title: "测试项目", outcome: "交付总结", actions: [] } }, { cellId: "desk", epoch: 0, principalId: "cell:desk" });
  if (approval.type !== "defer") throw Error("expected a proposal card");
  const choice = { optionId: "system.execute", seenItemRevision: 1 };
  await expect(kernel.humanItems.decide(approval.actionId, { ...choice, seenItemRevision: 9 }, "agent:helper")).rejects.toMatchObject({ code: "conflict" });
  await expect(kernel.humanItems.decide(approval.actionId, choice, "agent:helper")).resolves.toEqual({ status: "approved" });
  expect(kernel.getCell(`project-${approval.actionId}`)).toMatchObject({ parentId: "desk", status: "active" });
  expect(kernel.gate.getApprovalSync(approval.actionId)).toMatchObject({ status: "approved", approverId: "agent:helper" });
  expect(kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved }).map(m => m.envelope.payload))
    .toEqual([expect.objectContaining({ status: "approved", approverId: "agent:helper" })]);
  // The same approval again, by the owner: it is decided already, and no second project starts.
  await expect(kernel.humanItems.decide(approval.actionId, choice, "owner")).rejects.toMatchObject({ code: "conflict" });
  expect(kernel.listCells({ parentId: "desk" })).toHaveLength(1);
});

it("lets an external agent undo a decision on a project proposal, and no background cell", async () => {
  const { kernel } = await boot({start:false});
  const approval = kernel.gate.authorizeSync({ type: "project.start", subjectKey: "proposal:undo",
    summary: "立项", sideEffect: "external", proposal: {title: "项目", outcome: "交付记录", actions: []} },
    {cellId: "desk", epoch: 0, principalId: "cell:desk"});
  if (approval.type !== "defer") throw Error("expected a pending proposal");
  const denied = await kernel.humanItems.decide(approval.actionId, { optionId: "system.deny", seenItemRevision: 1 }, "owner");
  expect(denied.activityId).toBeTruthy();
  for (const actor of ["cell:desk", "external:mail:someone"])
    await expect(kernel.humanItems.undo(denied.activityId!, actor)).rejects.toMatchObject({ code: "bounds_violation" });
  expect(kernel.humanItems.get(approval.actionId)?.status).toBe("cancelled");
  await expect(kernel.humanItems.undo(denied.activityId!, "agent:helper")).resolves.toMatchObject({status:"undone"});
  expect(kernel.humanItems.get(approval.actionId)?.status).toBe("pending");
});

it("undoes a completed item whose old snooze expired before the scheduler ran", async () => {
  const {kernel, clock} = await boot({start:false});
  const item = kernel.humanItems.create({title:"核对记录", subjectKey:"review:record",
    options:[{id:"done",label:"完成",effect:"complete"}]}, null);
  const until = clock.now() + HOUR;
  await kernel.humanItems.decide(item.id, {optionId:"system.defer", seenItemRevision:1, until}, "owner");
  clock.set(until + 1);
  const done = await kernel.humanItems.decide(item.id, {optionId:"done", seenItemRevision:2}, "owner");
  expect((await kernel.humanItems.undo(done.activityId!, "owner")).status).toBe("undone");
  expect(kernel.humanItems.list()).toContainEqual(expect.objectContaining({id:item.id, status:"pending", snoozedUntil:null}));
  expect(kernel.inbox.listMessagesSync({cellId:"desk", type:PAYLOAD.timerFired, status:["pending"]})).toHaveLength(0);
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
  const claim = kernel.inbox.claimNextRunSync("desk", "test", 10_000)!;
  kernel.inbox.releaseSync(claim.claimId, "recovered", { countAttempt: false });
  expect((await kernel.humanItems.undo(again.activityId, "owner")).status).toBe("corrected");
  expect(kernel.humanItems.get(first.id)?.status).toBe("resolved");
  expect(kernel.inbox.listMessagesSync({ type: PAYLOAD.cellMessage })).toHaveLength(1);
  await expect(kernel.humanItems.undo(again.activityId!, "owner")).rejects.toThrow();
});

it("reopens only worker generations that closed with the project", async () => {
  const { kernel } = await boot({ start: false });
  kernel.spawnCell("desk", { id: "project", preset: "project" }, undefined, { principalId: kernel.ownerPrincipal });
  for (const id of ["old", "together"]) kernel.spawnCell("project", { id, preset: "worker", lifetime: "wakeable" }, undefined, { principalId: kernel.ownerPrincipal });
  await kernel.closeCell("old", "cancelled", { principalId: kernel.ownerPrincipal });
  await kernel.closeCell("project", "completed", { principalId: kernel.ownerPrincipal });
  expect(await kernel.reopenProject("project", "owner")).toEqual(["project", "together"]);
  expect(kernel.getCell("old")?.status).toBe("closed");
  expect(kernel.getCell("together")?.status).toBe("active");
  expect(kernel.inbox.listMessagesSync({ cellId: "project", type: PAYLOAD.cellMessage, status: ["pending"] })).toHaveLength(1);
});

it("finishes old epoch cleanup without killing a job started after reopening, then sends a second closure notice", async () => {
  const { kernel, dataDir } = await boot({ start: false });
  kernel.spawnCell("desk", { id: "project", preset: "project", cwd: dataDir }, undefined, { principalId: kernel.ownerPrincipal });
  const priorEpoch = kernel.getCell("project")!.epoch;
  const priorWorkspace = await kernel.workspace.acquire("project", { cwd: dataDir });
  const oldJob = await priorWorkspace.startJob({ command: "sleep 30" });
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const hold = new Promise<void>(r => { release = r; });
  const cancelJobs = kernel.workspace.cancelJobsForCell.bind(kernel.workspace);
  const order: string[] = [];
  kernel.workspace.cancelJobsForCell = async id => {
    enter();
    await hold;
    const result = await cancelJobs(id);
    order.push("old jobs stopped");
    return result;
  };
  const closing = kernel.closeCell("project", "completed", { principalId: kernel.ownerPrincipal });
  await entered;
  const opening = kernel.reopenProject("project", "owner").then(() => { order.push("project reopened"); });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(order).toEqual([]);
    expect(kernel.getCell("project")?.status).toBe("closed");
    expect(kernel.workspace.getJobSync(oldJob.jobId)?.state).toBe("running");
  } finally {
    release();
    await Promise.all([closing, opening]);
    kernel.workspace.cancelJobsForCell = cancelJobs;
  }
  expect(order).toEqual(["old jobs stopped", "project reopened"]);
  expect(kernel.getCell("project")!.epoch).toBeGreaterThan(priorEpoch);
  expect(kernel.workspace.getJobSync(oldJob.jobId)?.state).toBe("cancelled");
  const reopenedWorkspace = await kernel.workspace.acquire("project", {cwd:dataDir});
  const newJob = await reopenedWorkspace.startJob({command:"sleep 30"});
  expect(kernel.workspace.getJobSync(newJob.jobId)?.state).toBe("running");
  await kernel.closeCell("project", "cancelled", { principalId: kernel.ownerPrincipal });
  const ids = kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => m.envelope.id);
  expect(new Set(ids).size).toBe(2);
});

it("resolves one referenced wait and escalates the unanswered one exactly once across both monitors", async () => {
  const { kernel, script, clock } = await boot();
  script.add("project", { toolCalls: [{ name: "wait", input: { reason: "等 A", waitingFor: "inbox:desk", waitId: "a", refId: "ra" } }] });
  kernel.spawnCell("desk", { id: "project", preset: "project" }, "等待材料", { principalId: kernel.ownerPrincipal });
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
  kernel.spawnCell("desk",{id:"helper",preset:"worker",lifetime:"wakeable"},"准备材料", { principalId: kernel.ownerPrincipal });
  await kernel.idle();
  expect(kernel.listWaits(["helper"])).toMatchObject([{waitId:"material"}]);
  kernel.directMessage("helper",{text:"我确认这份材料可以用"},{principalId:"owner"});
  await kernel.idle();
  expect(kernel.listWaits(["helper"])).toEqual([]);
});

it("keeps human waits through silent copies and ignores replies addressed to another wait", async () => {
  const {kernel, script, clock} = await boot();
  script.add("project", {toolCalls: [{name: "wait", input: {waitingFor: "human", waitId: "review", reason: "等评审"}}]});
  kernel.spawnCell("desk", {id: "project", preset: "project"}, "review changes", { principalId: kernel.ownerPrincipal });
  kernel.spawnCell("project", {id: "leaf", preset: "worker"}, undefined, { principalId: kernel.ownerPrincipal });
  await kernel.idle();
  kernel.directMessage("leaf", {text: "先继续", clientId: "chat"}, { principalId: kernel.ownerPrincipal });
  kernel.inbox.enqueueSync("project", {id: "wake", from: "timer:project", principalId: "owner", kind: "event",
    type: PAYLOAD.timerFired, payload: {label: "check"}, createdAt: clock.now()});
  await kernel.idle();
  expect(kernel.listWaits(["project"])).toMatchObject([{waitId: "review"}]);
  for (const mode of ["enqueue", "steer"] as const) {
    kernel.directMessage("project", {mode, text: "这是另一件事", replyToId: "another"}, { principalId: kernel.ownerPrincipal });
    await kernel.idle();
    expect(kernel.listWaits(["project"])).toMatchObject([{waitId: "review"}]);
  }
  kernel.directMessage("project", {mode: "steer", text: "评审完了", replyToId: "review"}, { principalId: kernel.ownerPrincipal });
  await kernel.idle();
  expect(kernel.listWaits(["project"])).toEqual([]);
});

it("acknowledges a retried message after the worker closed without reopening it", async () => {
  const {kernel} = await boot({start:false});
  kernel.spawnCell("desk", {id: "worker", preset: "worker"}, undefined, { principalId: kernel.ownerPrincipal });
  const message = {text: "核对交付物", clientId: "same-message"};
  expect(kernel.directMessage("worker", message, { principalId: kernel.ownerPrincipal })).toMatchObject({duplicate: false});
  await kernel.closeCell("worker", "completed", { principalId: kernel.ownerPrincipal });
  const closed = kernel.getCell("worker")!;
  expect(kernel.directMessage("worker", message, { principalId: kernel.ownerPrincipal })).toMatchObject({duplicate:true, reopened:false, targetStatus:"closed"});
  expect(kernel.getCell("worker")).toMatchObject({epoch:closed.epoch, status:"closed"});
  expect(kernel.inbox.listMessagesSync({cellId:"desk",type:PAYLOAD.cellDirectChat})).toHaveLength(1);
});

it("copies a direct message according to ccParent independently of lifetime", async () => {
  const { kernel } = await boot({ start: false });
  kernel.spawnCell("desk", { id: "listener", preset: "inline", ccParent: true, lifetime: "persistent" }, undefined, { principalId: kernel.ownerPrincipal });
  kernel.spawnCell("desk", { id: "solo", preset: "worker", ccParent: false, lifetime: "wakeable" }, undefined, { principalId: kernel.ownerPrincipal });
  expect(kernel.directMessage("listener", { text: "保持监听" }, { principalId: "owner" })).toMatchObject({ ccTo: "desk" });
  expect(kernel.directMessage("solo", { text: "收到" }, { principalId: "owner" })).toMatchObject({ ccTo: null });
});

it("routes a subtree's cancel receipt to desk, restores the reopened epoch, and reports a claimed cancel", async () => {
  const {kernel} = await boot({start:false});
  kernel.spawnCell("desk", {id:"project", preset:"project"}, undefined, { principalId: kernel.ownerPrincipal });
  kernel.spawnCell("project", {id:"worker", preset:"worker", lifetime:"wakeable"}, undefined, { principalId: kernel.ownerPrincipal });
  const item = kernel.humanItems.create({
    title:"结束项目", subjectKey:"arb:close", relatedProjectIds:["project"],
    options:[{id:"close", label:"中止", effect:"terminate", terminateMode:"cancel_task", targetCellIds:["project"], confirm:"确认中止项目"}],
  }, "project");
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
  expect(kernel.humanItems.get(item.id)?.epoch).toBe(kernel.getCell("project")!.epoch);
  const again = await cancel();
  expect(kernel.inbox.claimNextRunSync("desk", "test", 10_000)).toBeTruthy();
  await expect(kernel.humanItems.undo(again, "owner")).rejects.toThrow("重新打开");
  expect(kernel.getCell("project")?.status).toBe("closed");
});

it("requires the project or its ancestor to propose cancellation and preserves independently closed probes on undo", async () => {
  const {kernel} = await boot({start: false});
  kernel.spawnCell("desk", {id: "project", preset: "project"}, undefined, { principalId: kernel.ownerPrincipal });
  kernel.spawnCell("project", {id: "probe", preset: "checker"}, undefined, { principalId: kernel.ownerPrincipal });
  const draft = {title: "结束项目", subjectKey: "review:end", relatedProjectIds: ["project"],
    options: [{id:"end",label:"结束",effect:"terminate" as const,terminateMode:"cancel_task" as const,targetCellIds:["project"],confirm:"确认结束"}]};
  expect(() => kernel.humanItems.create(draft, "probe")).toThrow();
  await kernel.closeCell("probe", "completed", { principalId: kernel.ownerPrincipal });
  const item = kernel.humanItems.create(draft, "project");
  const decision = await kernel.humanItems.decide(item.id, {optionId:"end", seenItemRevision:item.itemRevision, confirmedTargets:["project"]}, "owner");
  expect((await kernel.humanItems.undo(decision.activityId!, "owner")).status).toBe("undone");
  expect(kernel.getCell("project")?.status).toBe("active");
  expect(kernel.getCell("probe")?.status).toBe("closed");
});

it("keeps a closed worker archived when its parent lost spawn authority", async () => {
  const {kernel} = await boot({start:false});
  kernel.spawnCell("desk",{id:"project",preset:"project"}, undefined, { principalId: kernel.ownerPrincipal });
  kernel.spawnCell("project",{id:"worker",preset:"worker"}, undefined, { principalId: kernel.ownerPrincipal });
  await kernel.closeCell("worker","completed", { principalId: kernel.ownerPrincipal });
  kernel.updateCell("project", {bounds: {maxDepth: 0}}, { principalId: kernel.ownerPrincipal });
  expect(kernel.directMessage("worker", {text:"再做一轮"}, { principalId: kernel.ownerPrincipal })).toMatchObject({status:"refused", reason:"archived"});
  expect(kernel.getCell("worker")?.status).toBe("closed");
});

it("removes an early-settled reminder's scheduled resurfacing", async () => {
  const { kernel, clock } = await boot({start:false});
  const item = kernel.humanItems.create({title:"提醒",category:"action",subjectKey:"reminder:early",
    options:[{id:"done",label:"办完",effect:"complete"}]}, null);
  await kernel.humanItems.decide(item.id, {optionId:"system.defer", seenItemRevision:1, until:clock.now()+HOUR}, "owner");
  expect(kernel.inbox.listMessagesSync({cellId:"desk", type:PAYLOAD.timerFired, status:["pending"]})).toHaveLength(1);
  await kernel.humanItems.decide(item.id, {optionId:"done", seenItemRevision:2}, "owner");
  expect(kernel.inbox.listMessagesSync({cellId:"desk", type:PAYLOAD.timerFired, status:["pending"]})).toHaveLength(0);
});

it("retries a failed kernel timer without delivering it to the model", async () => {
  const {kernel,clock,script} = await boot();
  const item = kernel.humanItems.create({title:"提醒",category:"action",subjectKey:"reminder:retry",
    options:[{id:"done", label:"办完",effect:"complete"}]}, null);
  await kernel.humanItems.decide(item.id,{optionId:"system.defer",seenItemRevision:1,until:clock.now()+HOUR},"owner");
  kernel.db.exec("CREATE TEMP TRIGGER fail_resurface BEFORE UPDATE OF snoozed_until ON human_items BEGIN SELECT RAISE(ABORT,'temporary failure'); END");
  clock.advance(HOUR);
  await kernel.idle();
  const [timer] = kernel.inbox.listMessagesSync({cellId:"desk",type:PAYLOAD.timerFired,status:["pending"]});
  expect(timer).toMatchObject({attempts:1});
  expect(timer!.deliverAt).toBeGreaterThan(clock.now());
  expect(script.callsOf("desk")).toHaveLength(0);
  kernel.db.exec("DROP TRIGGER fail_resurface");
  clock.advance(timer!.deliverAt-clock.now());
  await kernel.idle();
  expect(kernel.humanItems.get(item.id)?.status).toBe("pending");
  expect(script.callsOf("desk")).toHaveLength(0);
});

it("retains independent parked branches during an ancestor's pause and resume", async () => {
  const {kernel} = await boot({start:false});
  kernel.spawnCell("desk", {id:"parent", preset:"project"}, undefined, { principalId: kernel.ownerPrincipal });
  kernel.spawnCell("parent", {id:"parked", preset:"project"}, undefined, { principalId: kernel.ownerPrincipal });
  kernel.spawnCell("parked", {id:"inside", preset:"worker"}, undefined, { principalId: kernel.ownerPrincipal });
  kernel.spawnCell("parent", {id:"sibling", preset:"worker"}, undefined, { principalId: kernel.ownerPrincipal });
  kernel.control("parked", {action:"pause",pauseReason:"parked"}, { principalId: kernel.ownerPrincipal });
  kernel.control("parent", {action:"pause"}, { principalId: kernel.ownerPrincipal });
  kernel.control("parent", {action:"resume"}, { principalId: kernel.ownerPrincipal });
  expect(kernel.getCell("sibling")?.status).toBe("active");
  expect(kernel.getCell("parked")).toMatchObject({status:"paused",pauseReason:"parked"});
  expect(kernel.getCell("inside")?.status).toBe("paused");
});

it("binds artifact writes and project associations to the issuing cell's actual tree", async () => {
  const results: string[] = [];
  const {kernel} = await boot({setup(registry) {
    registerTestPresets(registry);
    registry.codeProcessors.register({name:"check.scope", async run({ports}) {
      const proposal = {title: "自己的方案", outcome: "交付记录", actions: []};
      await ports.context.commit(ports.self.cellId, {artifact: {artifactId:"own-plan", updatedBy:"agent",
        content:{format:"json", body: JSON.stringify(proposal), data: proposal}}});
      const own = await ports.authorize({type:"project.start", subjectKey:"own-plan", summary:"立项", sideEffect:"external",
        proposal, artifactId:"own-plan"});
      if (own.type !== "defer") throw Error("expected a bound approval");
      for (const artifactId of ["shared","separate","proposal","own-plan"]) {
        try {
          await ports.context.commit(ports.self.cellId, {artifact:{artifactId, expectedVersion:1, updatedBy:"agent", content:{format:"text",body:"revision"}}});
          results.push("saved");
        } catch (err) { results.push((err as {code:string}).code); }
      }
      return "completed";
    }});
  }});
  for (const id of ["first","second"]) kernel.spawnCell("desk",{id,preset:"project"}, undefined, { principalId: kernel.ownerPrincipal });
  kernel.spawnCell("first",{id:"author",preset:"worker"}, undefined, { principalId: kernel.ownerPrincipal });
  for (const [cellId,artifactId] of [["author","shared"],["second","separate"],["desk","proposal"]] as const)
    kernel.context.commitSync(cellId,{artifact:{artifactId,updatedBy:"agent",content:{format:"text",body:"initial"}}});
  expect(kernel.gate.authorizeSync({type:"project.start", subjectKey:"proposal", summary:"立项", sideEffect:"external",
    proposal:{title:"项目",outcome:"交付",actions:[]}, artifactId:"proposal"}, {cellId:"desk",principalId:"cell:desk",epoch:0}).type).toBe("defer");
  kernel.spawnCell("first",{id:"editor",preset:"worker",processor:{kind:"code",entry:"check.scope"}}, "review", { principalId: kernel.ownerPrincipal });
  await kernel.idle();
  expect(results).toEqual(["saved","bounds_violation","bounds_violation","invalid_argument"]);
  expect(kernel.context.getArtifactSync("own-plan")?.version).toBe(1);
  expect(kernel.context.getArtifactSync("separate")?.version).toBe(1);
  expect(kernel.context.getArtifactSync("proposal")?.version).toBe(1);
  const draft = {title:"核对",subjectKey:"review",relatedProjectIds:["second"],options:[{id:"yes",label:"同意",effect:"reply" as const}]};
  expect(() => kernel.humanItems.create(draft, "author")).toThrow(expect.objectContaining({code:"bounds_violation"}));
  expect(() => kernel.gate.authorizeSync({type:"custom",name:"review",summary:"核对",subjectKey:"review",sideEffect:"external",
    relatedProjectIds:["second"]},{cellId:"author",principalId:"cell:author",epoch:0})).toThrow(expect.objectContaining({code:"bounds_violation"}));
});

it("withdraws a normal card of an earlier generation and refuses reopening beneath a paused parent", async () => {
  const {kernel} = await boot({start:false});
  kernel.spawnCell("desk",{id:"project",preset:"project"}, undefined, { principalId: kernel.ownerPrincipal });
  kernel.spawnCell("project",{id:"leaf",preset:"worker"}, undefined, { principalId: kernel.ownerPrincipal });
  const item = kernel.humanItems.create({subjectKey:"review",title:"核对",options:[{id:"yes",label:"完成",effect:"reply"}]}, "leaf");
  kernel.db.prepare("UPDATE human_items SET epoch=epoch-1 WHERE action_id=?").run(item.id);
  await expect(kernel.humanItems.decide(item.id,{seenItemRevision:1,optionId:"system.defer"},"owner")).rejects.toMatchObject({code:"conflict"});
  expect(kernel.humanItems.get(item.id)?.status).toBe("cancelled");
  expect(kernel.inbox.listMessagesSync({type:PAYLOAD.timerFired})).toEqual([]);
  await kernel.closeCell("leaf","completed", { principalId: kernel.ownerPrincipal });
  kernel.control("project",{action:"pause"}, { principalId: kernel.ownerPrincipal });
  kernel.directMessage("leaf",{text:"继续"}, { principalId: kernel.ownerPrincipal });
  expect(kernel.getCell("leaf")?.status).toBe("closed");
});

// Audit 2026-11-23 E07: a plain card (present_to_owner, request_approval with options) can be about a draft. It is
// bound to the version that exists when it is raised; the owner's decision names the version they saw, and the
// issuing cell is told which version was decided and whether the owner edited it.
it("binds a custom card to its draft's version and reports the owner's edit with the decision", async () => {
  const { kernel } = await boot();
  kernel.context.commitSync("desk", { artifact: { artifactId: "sms", content: { format: "text", body: "初稿" }, updatedBy: "agent" } });
  const reply = { id: "final", label: "定稿", effect: "reply" as const };
  expect(() => kernel.humanItems.create({ title: "短信草稿", subjectKey: "sms", options: [reply], artifactId: "nope" }, "desk")).toThrow(/no artifact/);
  const item = kernel.humanItems.create({ title: "短信草稿", subjectKey: "sms", options: [reply], artifactId: "sms" }, "desk");
  expect(item).toMatchObject({ artifactId: "sms", artifactVersion: 1, humanEdited: false });
  expect(item.options.map((o) => o.id)).toEqual(expect.arrayContaining(["final", "system.revise"]));

  kernel.context.commitSync("desk", { artifact: { artifactId: "sms", expectedVersion: 1, content: { format: "text", body: "主人改过的定稿" }, updatedBy: "human" } });
  const edited = kernel.humanItems.get(item.id)!;
  expect(edited).toMatchObject({ artifactVersion: 2, humanEdited: true });
  // A decision made on the version the owner did not see is refused; on the current one it goes through.
  await expect(kernel.humanItems.decide(item.id, { optionId: "final", seenItemRevision: edited.itemRevision, seenArtifactVersion: 1 }, "owner")).rejects.toThrow(/草稿已变动/);
  await kernel.humanItems.decide(item.id, { optionId: "final", seenItemRevision: edited.itemRevision, seenArtifactVersion: 2 }, "owner");
  const resolved = kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved }).at(-1)!.envelope.payload;
  expect(resolved).toMatchObject({ actionId: item.id, action: { artifactId: "sms" }, artifactVersion: 2, humanEdited: true });
});

// Audit 2026-11-23 E13 / E17: a cell can take back a card of its own (or of a cell below it) that is still undecided.
it("lets a cell withdraw its own undecided card, and nobody else's", async () => {
  const { kernel } = await boot();
  kernel.spawnCell("desk", { id: "proj", preset: "project", meta: { projectCellId: "proj" } }, undefined, { principalId: kernel.ownerPrincipal });
  kernel.spawnCell("desk", { id: "other", preset: "project", meta: { projectCellId: "other" } }, undefined, { principalId: kernel.ownerPrincipal });
  const card = kernel.humanItems.create({ title: "阶段 1 完成，是否开始阶段 2", subjectKey: "phase:2", options: [{ id: "go", label: "开始", effect: "reply" }] }, "proj");
  expect(kernel.humanItems.withdrawOwn(card.id, "other", "not mine")).toBe("not_found");
  expect(kernel.humanItems.get(card.id)!.status).toBe("pending");
  // The desk is above the project: it may close a card the project raised.
  expect(kernel.humanItems.withdrawOwn(card.id, "desk", "计划改了，不再分阶段")).toBe("withdrawn");
  expect(kernel.humanItems.get(card.id)!.status).toBe("cancelled");
  expect(kernel.humanItems.list().some((i) => i.id === card.id)).toBe(false);
  expect(kernel.humanItems.withdrawOwn(card.id, "proj", "again")).toBe("not_pending");
  expect(kernel.humanItems.withdrawOwn("act_missing", "proj", "x")).toBe("not_found");
});

// Audit 2026-11-23 E26: what the owner writes while approving a proposal reached nobody, so it was sent a second time
// as a separate message. It now goes to the project that the approval starts, and stays on the desk's record.
it("hands the owner's note on an approved proposal to the project it starts", async () => {
  const { kernel } = await boot({ start: false });
  const approval = kernel.gate.authorizeSync({ type: "project.start", subjectKey: "proposal:note", summary: "启动项目", sideEffect: "external",
    proposal: { title: "测试项目", outcome: "交付总结", actions: [] } }, { cellId: "desk", epoch: 0, principalId: "cell:desk" });
  if (approval.type !== "defer") throw Error("expected a proposal card");
  await kernel.humanItems.decide(approval.actionId, { optionId: "system.execute", seenItemRevision: 1, note: "无效行沿用 parse 的行为" }, "owner");
  const project = `project-${approval.actionId}`;
  const notes = kernel.inbox.listMessagesSync({ cellId: project, type: PAYLOAD.cellMessage });
  expect(notes.map((m) => [m.envelope.principalId, (m.envelope.payload as { text: string }).text])).toEqual([["owner", "无效行沿用 parse 的行为"]]);
  expect(kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved }).at(-1)!.envelope.payload).toMatchObject({ status: "approved", note: "无效行沿用 parse 的行为" });
});

it("moves revised cards into dedicated revising status, hides them from list(), and reopens on resubmit or idle", async () => {
  const { kernel } = await boot({ start: false });
  kernel.context.commitSync("desk", { artifact: { artifactId: "rep", content: { format: "markdown", body: "v1" }, updatedBy: "agent" } });
  const card = kernel.humanItems.create(
    { title: "验收报告", subjectKey: "rep:review", artifactId: "rep", options: [{ id: "done", label: "通过", effect: "reply" }] },
    "desk",
  );
  expect(kernel.humanItems.list().map((i) => i.id)).toEqual([card.id]);

  // Revise moves card out of pending list into dedicated revising state with revisionNote and empty options.
  const res = await kernel.humanItems.decide(
    card.id,
    { optionId: "system.revise", seenItemRevision: card.itemRevision, seenArtifactVersion: 1, note: "补查上游行为" },
    "owner",
  );
  expect(res).toMatchObject({ status: "revising" });
  expect(kernel.humanItems.list()).toEqual([]);
  expect(kernel.humanItems.listRevising()).toEqual([
    expect.objectContaining({ id: card.id, status: "revising", revisionNote: "补查上游行为", options: [] }),
  ]);
  await expect(
    kernel.humanItems.decide(card.id, { optionId: "done", seenItemRevision: card.itemRevision + 1, seenArtifactVersion: 1 }, "owner"),
  ).rejects.toThrow(/正在由后台按你的意见修改中/);

  // Resubmitting under the same subjectKey returns the card to pending and clears revisionNote.
  kernel.context.commitSync("desk", { artifact: { artifactId: "rep", expectedVersion: 1, content: { format: "markdown", body: "v2" }, updatedBy: "agent" } });
  const reopened = kernel.humanItems.create(
    { title: "验收报告", subjectKey: "rep:review", artifactId: "rep", options: [{ id: "done", label: "通过", effect: "reply" }] },
    "desk",
  );
  expect(reopened).toMatchObject({ id: card.id, status: "pending", artifactVersion: 2 });
  expect(reopened.revisionNote).toBeUndefined();
  expect(kernel.humanItems.listRevising()).toEqual([]);
  expect(kernel.humanItems.list().map((i) => i.id)).toEqual([card.id]);

  // A revising card can still be withdrawn cleanly.
  await kernel.humanItems.decide(
    card.id,
    { optionId: "system.revise", seenItemRevision: reopened.itemRevision, seenArtifactVersion: 2, note: "再改一次" },
    "owner",
  );
  expect(kernel.humanItems.withdrawOwn(card.id, "desk", "不再需要")).toBe("withdrawn");
  expect(kernel.humanItems.get(card.id)?.status).toBe("cancelled");
  expect(kernel.humanItems.listRevising()).toEqual([]);
});
