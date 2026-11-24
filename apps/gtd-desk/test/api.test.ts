import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, RESTORE_REASON, writeActionRecordSync } from "@ng/presets";
import type { ProjectRecord } from "@ng/presets/records";
import { PAYLOAD, type ActionRecord } from "@ng/protocol";
import type {
  ActivityMutationResponse,
  ArtifactSaveResponse,
  CaptureResponse,
  HumanItemDTO,
  ProjectMutationResponse,
  RadarDTO,
} from "../src/shared/api";
import {
  agentRedraft,
  bootDesk,
  bootRealDesk,
  cleanupAll,
  HOUR,
  inboundEnvelope,
  makeProject,
  makeReviewCard,
  requestText,
  tempDir,
  tool,
  writeAction,
  writeActivity,
} from "./helpers";

afterEach(cleanupAll);

describe("capture", () => {
  it("reaches the desk through the ui channel and answers with the top bar", async () => {
    const d = await bootDesk();
    const r = await d.req<CaptureResponse>("POST", "/api/capture", { text: "周五下午 3 点提醒我给牙医打电话", clientId: "c-1" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, message: "已收进信箱" });
    expect(r.json.status.generatedAt).toBe(d.clock.now());
    await d.kernel.idle();
    const [msg] = d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage });
    expect(msg?.envelope).toMatchObject({ id: r.json.id, principalId: "owner", from: "channel:ui:owner", payload: { text: "周五下午 3 点提醒我给牙医打电话" } });
    const desk = d.script.requests.filter((x) => x.cellId === "desk");
    expect(desk.length).toBeGreaterThan(0);
    expect(requestText(desk[0]!.req)).toContain("给牙医打电话");

    // the same clientId is accepted once
    await d.post("/api/capture", { text: "周五下午 3 点提醒我给牙医打电话", clientId: "c-1" });
    expect(d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage })).toHaveLength(1);
  });

  it("rejects empty input", async () => {
    const d = await bootDesk();
    const r = await d.req("POST", "/api/capture", { text: "   " });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: { code: "invalid_argument" } });
  });
});

describe("review options", () => {
  it("snooze hides the card and it resurfaces when the clock passes the time", async () => {
    const d = await bootDesk();
    const { actionId } = makeReviewCard(d.kernel);
    const until = d.clock.now() + 3 * HOUR;
    const item = d.kernel.humanItems.get(actionId)!;
    const r = await d.post(`/api/human-items/${actionId}/decide`, {
      optionId: "system.defer", until, seenItemRevision: item.itemRevision, seenArtifactVersion: item.artifactVersion,
    });
    expect(r).toMatchObject({ status: "snoozed" });
    d.clock.advance(3 * HOUR - 1);
    await d.kernel.idle();
    expect((await d.get<{items: HumanItemDTO[]}>("/api/human-items")).items).toEqual([]);
    d.clock.advance(1);
    await d.kernel.idle();
    expect((await d.get<{items: HumanItemDTO[]}>("/api/human-items")).items).toMatchObject([{ id: actionId, status: "pending" }]);
  });

  it("defers a review from its current card options to tomorrow", async () => {
    const d = await bootDesk();
    const { actionId } = makeReviewCard(d.kernel);
    const { items } = await d.get<{ items: HumanItemDTO[] }>("/api/human-items");
    const item = items.find(item => item.id === actionId)!;
    const defer = item.options.find(option => option.effect === "defer")!;
    const result = await d.post(`/api/human-items/${item.id}/decide`, { optionId: defer.id, seenItemRevision: item.itemRevision, seenArtifactVersion: item.artifactVersion });
    expect(result).toMatchObject({ status: "snoozed" });
    expect(d.kernel.humanItems.get(item.id)?.snoozedUntil).toBe(d.clock.now() + 24 * HOUR);
  });

  it("revise wakes the owning cell with the instruction and marks the card as revising", async () => {
    const d = await bootDesk();
    const { actionId } = makeReviewCard(d.kernel);
    const item = d.kernel.humanItems.get(actionId)!;
    const r = await d.post(`/api/human-items/${actionId}/decide`, {
      optionId: "system.revise", note: "语气再正式一点", seenItemRevision: item.itemRevision, seenArtifactVersion: item.artifactVersion,
    });
    expect(r).toMatchObject({ status: "revising" });
    expect(d.kernel.humanItems.get(actionId)?.itemRevision).toBe(item.itemRevision + 1);
    await d.kernel.idle();
    const text = d.script.requests.filter((x) => x.cellId === "desk").map((x) => requestText(x.req)).join("\n");
    expect(text).toContain("语气再正式一点");
  });

  it("approves the same inbox card with the reviewed draft version", async () => {
    const d = await bootDesk();
    const {actionId,artifactId} = makeReviewCard(d.kernel);
    const path = `/api/human-items/${actionId}/decide`;
    const before = d.kernel.humanItems.get(actionId)!;
    const saved = await d.req<ArtifactSaveResponse>("PUT", `/api/artifacts/${artifactId}`, {expectedVersion:1,body:"您好，接口下周二上线。"});
    expect(saved.json).toMatchObject({outcome:"saved",artifact:{version:2,updatedBy:"human"}});
    const choice = {optionId:"system.reply",seenItemRevision:before.itemRevision};
    expect((await d.req("POST",path,{...choice,seenArtifactVersion:1})).status).toBe(409);
    const fresh = d.kernel.humanItems.get(actionId)!;
    await d.post(path,{...choice,seenItemRevision:fresh.itemRevision,seenArtifactVersion:2});
    expect(d.kernel.humanItems.list()).toHaveLength(0);
  });

  it("confirms resuming the paused card issuer before approval, even when its project is active", async () => {
    const d = await bootDesk();
    const projectId = makeProject(d.kernel, "交付项目");
    const workerId = "issuer";
    d.kernel.spawnCell(projectId, {id:workerId, preset:"worker"}, undefined, { principalId: d.kernel.ownerPrincipal });
    const {actionId} = makeReviewCard(d.kernel, {cellId:workerId});
    d.kernel.control(workerId, {action:"pause"}, { principalId: d.kernel.ownerPrincipal });
    const item = (await d.get<{items:HumanItemDTO[]}>("/api/human-items")).items.find(i => i.id === actionId)!;
    expect(item.project?.paused).toBe(false);
    expect(item.resumeTarget?.id).toBe(workerId);
    const decision = {optionId:"system.reply", seenItemRevision:item.itemRevision, seenArtifactVersion:item.artifactVersion};
    const path = `/api/human-items/${actionId}/decide`;
    expect((await d.req("POST", path, decision)).status).toBe(409);
    expect(d.kernel.humanItems.get(actionId)?.itemRevision).toBe(item.itemRevision);
    expect(await d.post(path, {...decision, resumeProjectId:workerId})).toMatchObject({status:"resolved"});
    expect(d.kernel.getCell(workerId)?.status).toBe("active");
  });

  it("returns a conflict when Gate cancels a card from an earlier epoch", async () => {
    const d = await bootDesk();
    const {actionId} = makeReviewCard(d.kernel);
    d.kernel.db.prepare("UPDATE human_items SET epoch=epoch-1 WHERE action_id=?").run(actionId);
    const reply = await d.req("POST", `/api/human-items/${actionId}/decide`,
      {optionId:"system.reply", seenItemRevision:1, seenArtifactVersion:1});
    expect(reply.status).toBe(409);
    expect(d.kernel.gate.getApprovalSync(actionId)?.status).toBe("cancelled");
    expect((await d.req("POST", "/api/human-items/absent/decide", {optionId:"system.someday", seenItemRevision:1})).status).toBe(404);
  });

  it("moves a personal action to its project and delivers its completion to the new owner", async () => {
    const d = await bootDesk();
    const project = makeProject(d.kernel, "文稿整理");
    const other = makeProject(d.kernel, "另一个项目");
    const task = writeAction(d.kernel, d.kernel.deskCellId, {title:"提供材料", owner:"human"});
    const assigned = {...task, projectCellId:project};
    expect(() => writeActionRecordSync(d.kernel, other, assigned)).toThrow();
    writeActionRecordSync(d.kernel, d.kernel.deskCellId, assigned);
    const item = d.kernel.humanItems.get(task.id)!;
    expect(item).toMatchObject({cellId:project, relatedProjectIds:[project]});
    await d.kernel.humanItems.decide(item.id,{optionId:"done",seenItemRevision:item.itemRevision},"owner");
    const messages = d.kernel.inbox.listMessagesSync({type:PAYLOAD.approvalResolved});
    expect(messages.filter(m => (m.envelope.payload as {actionId: string}).actionId === item.id).map(m => m.cellId)).toEqual([project]);
  });

  it("restores a cancelled personal action through HTTP and rejects a second undo", async () => {
    const d = await bootDesk({port:0});
    const {url} = await d.server.listen();
    const original = d.kernel.humanItems.create({
      title: "核对周会议程", subjectKey: "meeting:agenda", category: "action",
      options: [{ id: "done", label: "已办完", effect: "complete" }],
    }, null);
    const result = await d.post<{ status: string; activityId: string }>(`/api/human-items/${original.id}/decide`, {
      optionId: "system.deny", seenItemRevision: original.itemRevision,
    });
    expect(result.status).toBe("cancelled");
    expect((await d.get<{ items: HumanItemDTO[] }>("/api/human-items")).items).toHaveLength(0);
    const undo = () => fetch(`${url}/api/human-activity/${result.activityId}/undo`, {
      method:"POST", headers:{"content-type":"application/json"}, body:"{}",
    });
    const first = await undo();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({status:"undone", deskStatus:{generatedAt:d.clock.now()}});
    expect((await undo()).status).toBe(409);
    const restored = (await d.get<{ items: HumanItemDTO[] }>("/api/human-items")).items;
    expect(restored).toMatchObject([{ id: original.id, title: original.title, status: "pending" }]);
    expect(restored[0]!.itemRevision).toBeGreaterThan(original.itemRevision);
  });
});

describe("human actions", () => {

  it("defers and declines cards without reactivating their parked project", async () => {
    const d=await bootDesk();
    const projectId = makeProject(d.kernel,"下季度计划");
    await d.post(`/api/projects/${projectId}/someday`);
    const item=d.kernel.humanItems.create({title:"确认范围",subjectKey:"scope:parked",options:[{id:"scope",label:"范围",effect:"reply"}]},projectId);
    await d.post(`/api/human-items/${item.id}/decide`,{optionId:"system.defer",seenItemRevision:1});
    await d.post(`/api/human-items/${item.id}/decide`,{optionId:"system.deny",seenItemRevision:2});
    expect(d.kernel.getCell(projectId)).toMatchObject({status:"paused",pauseReason:"parked"});
  });

  it("completes personal actions and routes project replies to their issuing cell", async () => {
    const d = await bootDesk();
    const cellId = makeProject(d.kernel, "复核交付");
    const personal = d.kernel.humanItems.create({ title: "给牙医回电话", subjectKey: "dentist", category: "action", effort: "15m",
      options: [{ id: "done", label: "已办完", effect: "complete" }] }, null);
    const tracked = d.kernel.humanItems.create({ title: "签收快递", subjectKey: "delivery", category: "action", relatedProjectIds: [cellId],
      options: [{ id: "done", label: "已签收", effect: "reply" }] }, cellId);
    const {items} = await d.get<{items: HumanItemDTO[]}>("/api/human-items");
    expect(items.find(i => i.id === personal.id)).toMatchObject({effort: "15m", cellId: null});
    expect(items.find(i => i.id === tracked.id)).toMatchObject({project: {id: cellId}});
    for (const item of items) {
      const reply = await d.post(`/api/human-items/${item.id}/decide`, { optionId: "done", seenItemRevision: item.itemRevision });
      expect(reply).toMatchObject({status: "resolved"});
    }
    expect(d.kernel.inbox.listMessagesSync({type: PAYLOAD.approvalResolved}).map(m => m.cellId)).toEqual([cellId]);
    expect((await d.get<{items: HumanItemDTO[]}>("/api/human-items")).items).toEqual([]);
    expect(d.kernel.getCell(cellId)?.status).toBe("active");
  });

  it("artifact save with a stale expectedVersion returns the conflict with the current version and parked additions", async () => {
    const d = await bootDesk();
    d.kernel.context.commitSync("desk", { artifact: { artifactId: "art_x", content: { format: "text", body: "v1" }, updatedBy: "agent" } });
    // the owner opened v1; the background moved it to v2 meanwhile
    agentRedraft(d.kernel, "art_x", "v2 from the agent", 1);
    const r = await d.req<ArtifactSaveResponse>("PUT", "/api/artifacts/art_x", { expectedVersion: 1, body: "my edit" });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, outcome: "conflict", artifact: { version: 2, body: "v2 from the agent", parked: [] } });
    expect(d.kernel.context.getArtifactSync("art_x")!.content.body).toBe("v2 from the agent");

    // merged save on the current version wins; a later agent write is parked, never overwriting it
    const ok = await d.req<ArtifactSaveResponse>("PUT", "/api/artifacts/art_x", { expectedVersion: 2, body: "my merged edit" });
    expect(ok.json).toMatchObject({ outcome: "saved", artifact: { version: 3, updatedBy: "human" } });
    agentRedraft(d.kernel, "art_x", "agent addition");
    const stale = await d.req<ArtifactSaveResponse>("PUT", "/api/artifacts/art_x", { expectedVersion: 2, body: "again" });
    expect(stale.status).toBe(409);
    expect(stale.json.artifact).toMatchObject({ version: 3, body: "my merged edit", parked: [{ body: "agent addition" }] });
    const dismissed = await d.post<{ parked: unknown[] }>(`/api/artifacts/art_x/parked/${stale.json.artifact.parked[0]!.id}/dismiss`);
    expect(dismissed.parked).toEqual([]);
  });
});

describe("project HTTP routes", () => {
  it("lists closed projects, restores them once, and returns 403 for a revoked project", async () => {
    const d = await bootDesk({port:0});
    const {url} = await d.server.listen();
    const project = makeProject(d.kernel,"发布计划");
    const revoked = makeProject(d.kernel,"临时验证");
    d.kernel.gate.revokeSync(revoked);
    await d.kernel.closeCell(project, "completed", { principalId: d.kernel.ownerPrincipal });
    await d.kernel.closeCell(revoked, "cancelled", { principalId: d.kernel.ownerPrincipal });

    const closed = async () => {
      const response = await fetch(url + "/api/projects/closed");
      expect(response.status).toBe(200);
      return (await response.json() as {projects: {id:string; title:string}[]}).projects;
    };
    const reopen = (id:string) => fetch(`${url}/api/projects/${id}/reopen`, {
      method:"POST", headers:{"content-type":"application/json"}, body:"{}",
    });
    expect(await closed()).toEqual(expect.arrayContaining([
      expect.objectContaining({id:project,title:"发布计划"}), expect.objectContaining({id:revoked,title:"临时验证"}),
    ]));
    const restored = await reopen(project);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({restored:[project],deskStatus:{generatedAt:d.clock.now()}});
    expect((await closed()).map(p => p.id)).not.toContain(project);
    expect((await reopen(project)).status).toBe(409);
    const forbidden = await reopen(revoked);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({error:{code:"bounds_violation"}});
    expect(d.kernel.getCell(revoked)?.status).toBe("closed");
  });

  it("saves a proposal and returns the current plan on a stale HTTP write", async () => {
    const d = await bootRealDesk({port:0});
    const {url} = await d.server.listen();
    d.script.add("desk", tool("propose_project", {title:"验收发布", outcome:"发布完成", actions:[{title:"核对清单",owner:"human"}]}));
    await d.post("/api/capture", {text:"为这次发布制定计划"});
    await d.kernel.idle();
    const list = await fetch(url + "/api/human-items");
    const {items} = await list.json() as {items:HumanItemDTO[]};
    const proposal = items.find(i => i.proposal)!;
    const save = (outcome: string) => fetch(`${url}/api/human-items/${proposal.id}/plan`, {
      method:"PUT", headers:{"content-type":"application/json"},
      body:JSON.stringify({expectedVersion:proposal.artifactVersion, proposal:{...proposal.proposal,outcome}}),
    });
    expect((await save("   ")).status).toBe(400);
    expect((await d.req("PUT", `/api/human-items/${proposal.id}/plan`, {
      expectedVersion:proposal.artifactVersion, proposal:{...proposal.proposal, background:{unexpected:true}},
    })).status).toBe(400);
    expect((await d.req("PUT", `/api/artifacts/${proposal.artifactId}`, { expectedVersion: proposal.artifactVersion, body: "invalid json" })).status).toBe(400);
    const saved = await save("交付日志并获得验收签字");
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ok:true,outcome:"saved",deskStatus:{generatedAt:d.clock.now()}});
    const stale = await save("覆盖新稿");
    expect(stale.status).toBe(409);
    const conflict = await stale.json();
    expect(conflict).toMatchObject({ok:false,outcome:"conflict",current:{version:proposal.artifactVersion! + 1}});
    expect(JSON.parse(conflict.current.body).outcome).toBe("交付日志并获得验收签字");
    const refreshed = await d.get<{items:HumanItemDTO[]}>("/api/human-items");
    expect(refreshed.items.find(i => i.id === proposal.id)?.proposal?.outcome).toBe("交付日志并获得验收签字");
  });
});

describe("Radar", () => {
  it("project cancel closes its cell tree and records the cancellation", async () => {
    const d = await bootDesk();
    const p = makeProject(d.kernel, "竞品调研");
    d.kernel.spawnCell(p, { id: "w1", preset: "inline", title: "扒 A 公司" }, undefined, { principalId: d.kernel.ownerPrincipal });
    d.kernel.spawnCell("w1", { id: "w1a", preset: "worker", title: "扒 A 的定价" }, undefined, { principalId: d.kernel.ownerPrincipal });
    const a = writeAction(d.kernel, "w1", { title: "整理竞品", owner: "agent", progress: { done: 3, total: 15, label: "正在并发整理竞品资料" } });

    const radar = await d.get<RadarDTO>("/api/radar");
    const row = radar.projects.find((x) => x.id === p)!;
    expect(row.ball).toMatchObject({ owner: "agent", label: "🟢 Agent 处理中", text: "正在并发整理竞品资料 3/15", targetCellId: "w1" });
    const cancel = row.buttons.find((b) => b.id === "cancel")!;
    expect(cancel.confirm).toBeTruthy();

    const r = await d.post<ProjectMutationResponse>(cancel.endpoint!.path);
    expect(r.outcome).toBe("cancelled");
    expect(r.view.projects.map((x) => x.id)).not.toContain(p);
    await d.kernel.idle();
    expect([p, "w1", "w1a"].map((id) => d.kernel.getCell(id)!.status)).toEqual(["closed", "closed", "closed"]);
    expect(d.kernel.context.readStateSync<ProjectRecord>(p, gtdKeys.project)).toMatchObject({ lifecycle: "cancelled" });
    expect(d.kernel.context.readStateSync<ActionRecord>("w1", gtdKeys.action(a.id))).toMatchObject({ status: "cancelled" });
  });

  it("stalled-project detection: flagged red until a next step is added", async () => {
    const d = await bootDesk();
    const p = makeProject(d.kernel, "官网改版");
    writeAction(d.kernel, p, { title: "出设计稿", owner: "agent" });
    let row = (await d.get<RadarDTO>("/api/radar")).projects.find((x) => x.id === p)!;
    expect(row).toMatchObject({ stalled: true, running: 0, waitingOn: 0 });
    expect(row.stalledText).toContain("补上下一步");
    const add = row.buttons.find((b) => b.id === "add_action")!;
    expect(add).toMatchObject({ primary: true, input: { field: "title" } });

    const r = await d.post<ProjectMutationResponse>(add.endpoint!.path, { title: "约设计师周三开会", effort: "15m" });
    row = r.view.projects.find((x) => x.id === p)!;
    expect(row).toMatchObject({ stalled: false, ball: { owner: "human", text: "约设计师周三开会" } });
    expect(r.status.radar.stalledProjects).toBe(0);
    expect((await d.get<{items: HumanItemDTO[]}>("/api/human-items")).items.map((i) => i.title)).toEqual(["约设计师周三开会"]);
  });

  it("a waiting watch keeps a project from being stalled; someday pauses it and activate resumes it", async () => {
    const d = await bootDesk();
    const p = makeProject(d.kernel, "供应商比价");
    d.kernel.spawnCell(p, { id: "watch-c", preset: "checker", title: "等 C 报价", watches: [{ threadOrFilter: { thread: "memory:quote-c" } }] }, undefined, { principalId: d.kernel.ownerPrincipal });
    let row = (await d.get<RadarDTO>("/api/radar")).projects.find((x) => x.id === p)!;
    expect(row).toMatchObject({ stalled: false, waitingOn: 1, ball: { owner: "waiting" } });

    const s = await d.post<ProjectMutationResponse>(`/api/projects/${p}/someday`);
    expect(s.outcome).toBe("someday");
    expect(s.view.someday.map((x) => x.id)).toEqual([p]);
    expect(d.kernel.getCell("watch-c")!.status).toBe("paused");
    const a = await d.post<ProjectMutationResponse>(`/api/projects/${p}/activate`);
    expect(a.outcome).toBe("activated");
    expect(d.kernel.getCell("watch-c")!.status).toBe("active");
    row = a.view.projects.find((x) => x.id === p)!;
    expect(row.lifecycle).toBe("active");
  });
});

describe("activity restore", () => {
  it("re-delivers a silently archived notification to the desk as a handback that asks for a card", async () => {
    const d = await bootDesk();
    const env = inboundEnvelope(d.kernel, "【通知】周五全员会改到下午 4 点", "hr");
    const act = writeActivity(d.kernel, { kind: "notification_archived", title: "全员会改时间", envelope: env, rawInput: "【通知】周五全员会改到下午 4 点", restorable: true });
    const list = await d.get<{ items: Array<{ id: string; buttons: Array<{ id: string; endpoint?: { path: string } }> }> }>("/api/activity");
    const restore = list.items.find((i) => i.id === act.id)!.buttons.find((b) => b.id === "restore")!;
    expect(restore.endpoint!.path).toBe(`/api/activity/desk/${act.id}/restore`);

    const r = await d.post<ActivityMutationResponse>(restore.endpoint!.path);
    expect(r).toMatchObject({ ok: true, outcome: "restored" });
    expect(r.view.items.find((i) => i.id === act.id)).toMatchObject({ restorable: false, restoredAt: d.clock.now(), buttons: [] });
    const [hb] = d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.handback });
    expect(hb!.envelope.payload).toMatchObject({ original: { id: env.id }, fromCellId: "desk", reason: RESTORE_REASON });
    await d.kernel.idle();
    expect(d.script.requests.some((x) => x.cellId === "desk" && requestText(x.req).includes("全员会改到下午 4 点"))).toBe(true);

    const twice = await d.post<ActivityMutationResponse>(restore.endpoint!.path);
    expect(twice).toMatchObject({ ok: false, outcome: "not_restorable" });
  });
});


it("requires the full current subtree for a destructive decision and preserves it on conflict", async () => {
  const d = await bootDesk();
  const project = makeProject(d.kernel, "验收项目");
  d.kernel.spawnCell(project, {id: "child", preset: "worker"}, undefined, { principalId: d.kernel.ownerPrincipal });
  const item = d.kernel.humanItems.create({
    title: "结束项目", subjectKey: "arb:close", relatedProjectIds: [project],
    options: [{id: "close", label: "停止", effect: "terminate", terminateMode: "cancel_task",
      targetCellIds: [project], confirm: "确认停止"}],
  }, "desk");
  const path = `/api/human-items/${item.id}/decide`;
  const choice = {optionId: "close", seenItemRevision: item.itemRevision, confirmedTargets: [project]};
  expect((await d.req("POST", path, {...choice, confirmedClosure: [project]})).status).toBe(409);
  expect(d.kernel.getCell("child")?.status).toBe("active");
  expect(d.kernel.humanItems.get(item.id)?.itemRevision).toBe(item.itemRevision);
  expect((await d.req("POST", path, {...choice, confirmedClosure: [project, "child"].sort((a,b) => a.localeCompare(b))})).status).toBe(200);
  expect(d.kernel.getCell("child")?.status).toBe("closed");
});

it("reopens the human action cancelled by this closure and leaves an already completed one alone", async () => {
  const d = await bootDesk();
  const project = makeProject(d.kernel, "材料校对");
  const active = writeAction(d.kernel, project, {title:"核对原件", owner:"human"});
  const completed = writeAction(d.kernel, project, {title:"确认收件", owner:"human", status:"done"});
  await d.kernel.closeCell(project, "cancelled", { principalId: d.kernel.ownerPrincipal });
  expect(d.kernel.humanItems.get(active.id)?.status).toBe("cancelled");
  await d.kernel.reopenProject(project, "owner");
  expect(d.kernel.humanItems.get(active.id)).toMatchObject({status:"pending", epoch:d.kernel.getCell(project)!.epoch});
  expect(d.kernel.humanItems.get(completed.id)?.status).toBe("resolved");
});

it("completes the human and waiting actions together when the owner finishes a project", async () => {
  const d = await bootRealDesk();
  const project = makeProject(d.kernel, "发布验收");
  const add = (owner: string) => d.post<{actionId: string}>(`/api/projects/${project}/actions`, { title: owner, owner });
  const human = await add("human");
  await add("waiting");
  await d.post(`/api/projects/${project}/complete`);
  expect(d.kernel.humanItems.get(human.actionId)?.status).toBe("resolved");
  expect((await d.req("POST", `/api/projects/${project}/actions`, { title: "收尾后追加", owner: "waiting" })).status).toBe(409);
});

it.each(["active","observe"] as const)("runs a batch through the real script source in %s mode and retains every trigger", async mode => {
  const d = await bootRealDesk();
  const path = join(tempDir("checks"), "check owner's report.mjs");
  writeFileSync(path, `
    import {readFileSync} from "node:fs";
    const file = process.env.NG_TRIGGER_FILE;
    const input = JSON.parse(file ? readFileSync(file,"utf8") : process.env.NG_TRIGGER_JSON);
    console.log(JSON.stringify({id: input.id, ...(file && {file})}));
  `);
  const {sensorId} = await d.post<{sensorId:string}>("/api/sources", {
    title:"报告", schedule:{everyMinutes:1}, check:{kind:"script", path}, mode,
  });
  await d.kernel.idle();
  expect(d.kernel.context.readStateSync(sensorId, gtdKeys.source)).toMatchObject({runCount:0});
  d.kernel.control(sensorId, {action:"pause"}, { principalId: d.kernel.ownerPrincipal });
  d.kernel.sendToCell(sensorId, {id:"small-input",text:"资料"}, { principalId: d.kernel.ownerPrincipal });
  d.kernel.sendToCell(sensorId, {id:"large-input",text:"x".repeat(160_000)}, { principalId: d.kernel.ownerPrincipal });
  d.kernel.control(sensorId, {action:"resume"}, { principalId: d.kernel.ownerPrincipal });
  await d.kernel.idle();
  expect(d.kernel.context.readStateSync(sensorId, gtdKeys.source)).toMatchObject({runCount:2, hitCount:2});
  expect((await d.get<{sensors:{status:string}[]}>("/api/sources")).sensors[0]?.status).toBe("ok");
  const hits = d.kernel.inbox.listMessagesSync({cellId:"desk", type:PAYLOAD.sourceHit});
  expect(hits).toHaveLength(mode === "observe" ? 0 : 2);
  const text = mode === "observe" ? d.kernel.context.getKnowledgeSync({cellId:sensorId,scope:"cell",kind:"reference",name:"观察笔记"})!.body
    : hits.map(h => (h.envelope.payload as {summary:string}).summary).join("\n");
  expect(text).toContain("small-input");
  expect(text).toContain("large-input");
  const file = /"file":"([^"]+)"/.exec(text)?.[1];
  expect(file).toBeTruthy();
  expect(existsSync(file!)).toBe(false);
});
