import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, PAYLOAD, type ActionRecord, type HandbackPayload, type ProjectRecord } from "@ng/protocol";
import type {
  ActivityMutationResponse,
  ApproveResponse,
  ArtifactSaveResponse,
  CaptureResponse,
  ClarifyMutationResponse,
  ClarifyQueueDTO,
  EngageDetailDTO,
  EngageListDTO,
  EngageMutationResponse,
  HumanItemDTO,
  ProjectMutationResponse,
  RadarDTO,
  StatusDTO,
} from "../src/shared/api";
import { RESTORE_REASON } from "../src/server/desk";
import {
  agentRedraft,
  bootDesk,
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

describe("Clarify — the other buttons", () => {
  it("snooze hides the card and it resurfaces when the clock passes the time", async () => {
    const d = await bootDesk();
    const { actionId } = makeReviewCard(d.kernel);
    const until = d.clock.now() + 3 * HOUR;
    const r = await d.post<ClarifyMutationResponse>(`/api/clarify/${actionId}/snooze`, { until, seenItemRevision: 1 });
    expect(r).toMatchObject({ outcome: "snoozed", card: null, view: { remaining: 0, snoozed: 1, inboxZero: true } });
    expect(r.status.clarify).toEqual({ pending: 0, snoozed: 1 });

    d.clock.advance(3 * HOUR - 1);
    await d.kernel.idle();
    expect((await d.get<ClarifyQueueDTO>("/api/clarify")).remaining).toBe(0);
    d.clock.advance(1);
    await d.kernel.idle();
    const back = await d.get<ClarifyQueueDTO>("/api/clarify");
    expect(back.cards.map((c) => c.id)).toEqual([actionId]);
    expect(back.snoozed).toBe(0);
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
    const r = await d.post<ClarifyMutationResponse>(`/api/clarify/${actionId}/revise`, { instruction: "语气再正式一点", voice: true, seenItemRevision: 1 });
    expect(r).toMatchObject({ outcome: "revising", card: { state: "revising" } });
    expect(r.card!.sourceBar.statusText).toContain("正在按你的意见重拟");
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
    d.kernel.spawnCell(projectId, {id:workerId, preset:"worker"});
    const {actionId} = makeReviewCard(d.kernel, {cellId:workerId});
    d.kernel.control(workerId, {action:"pause"});
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
    expect((await d.req("POST", "/api/human-items/absent/decide", {optionId:"system.someday", seenItemRevision:1})).status).toBe(404);
  });

  it("cancels a personal action and restores it through its activity entry", async () => {
    const d = await bootDesk();
    const original = d.kernel.humanItems.create({
      title: "核对周会议程", subjectKey: "meeting:agenda", category: "action",
      options: [{ id: "done", label: "已办完", effect: "complete" }],
    }, null);
    const result = await d.post<{ status: string; activityId: string }>(`/api/human-items/${original.id}/decide`, {
      optionId: "system.deny", seenItemRevision: original.itemRevision,
    });
    expect(result.status).toBe("cancelled");
    expect((await d.get<{ items: HumanItemDTO[] }>("/api/human-items")).items).toHaveLength(0);
    await d.post(`/api/human-activity/${result.activityId}/undo`);
    const restored = (await d.get<{ items: HumanItemDTO[] }>("/api/human-items")).items;
    expect(restored).toMatchObject([{ id: original.id, title: original.title, status: "pending" }]);
    expect(restored[0]!.itemRevision).toBeGreaterThan(original.itemRevision);
  });
});

describe("Engage", () => {

  it("defers and declines cards without reactivating their parked project", async () => {
    const d=await bootDesk();
    const projectId = makeProject(d.kernel,"下季度计划");
    await d.post(`/api/projects/${projectId}/someday`);
    const item=d.kernel.humanItems.create({title:"确认范围",subjectKey:"scope:parked",options:[{id:"scope",label:"范围",effect:"reply"}]},projectId);
    await d.post(`/api/human-items/${item.id}/decide`,{optionId:"system.defer",seenItemRevision:1});
    await d.post(`/api/human-items/${item.id}/decide`,{optionId:"system.deny",seenItemRevision:2});
    expect(d.kernel.getCell(projectId)).toMatchObject({status:"paused",pauseReason:"parked"});
  });

  it("reassignment and duplicate legacy identifiers keep the same action address within each cell", async () => {
    const d = await bootDesk();
    const id = "pick-up", key = gtdKeys.action(id);
    const first = writeAction(d.kernel,"desk",{id,title:"收材料",owner:"human"});
    d.kernel.spawnCell("desk",{id:"runner",preset:"worker"});
    const other = writeAction(d.kernel,"runner",{id,title:"收材料",owner:"human"});
    writeAction(d.kernel,"runner",{...other,owner:"agent"});
    writeAction(d.kernel,"runner",other);
    const pool = (await d.get<{items:HumanItemDTO[]}>("/api/human-items")).items;
    const runner = pool.find(i => i.actionRefs.some(ref => ref.cellId === "runner" && ref.actionId === id));
    expect(runner).toBeDefined();
    expect(runner!.id).not.toBe(pool.find(i => i.actionRefs.some(ref => ref.cellId === "desk" && ref.actionId === id))?.id);
    const queue = await d.get<EngageListDTO>("/api/engage");
    const done = queue.items.find(i=>i.cellId==="runner")!.buttons.find(b=>b.id==="done")!.endpoint!;
    expect(await d.post(done.path,done.body)).toMatchObject({ok:true});
    expect(d.kernel.context.readStateSync("runner",key)).toMatchObject({status:"done"});
    expect(d.kernel.context.readStateSync("desk",key)).toMatchObject({id:first.id,status:"open"});
  });

  it("quick check-off of a human action finishes it synchronously and closes the cell that existed only for it", async () => {
    const d = await bootDesk();
    const quick = writeAction(d.kernel, "desk", { title: "给牙医回电话", owner: "human", effort: "15m", nextStep: "打 010-1234" });
    d.kernel.spawnCell("desk", { id: "follow-up", preset: "watcher", lifetime: "persistent", title: "盯牙医回电" });
    const tracked = writeAction(d.kernel, "follow-up", { title: "签收快递", owner: "human", effort: "low_energy" });

    const list = await d.get<EngageListDTO>("/api/engage");
    expect(list.counts).toMatchObject({ all: 2, "15m": 1, low_energy: 1 });
    expect((await d.get<EngageListDTO>("/api/engage?effort=15m")).items.map((i) => i.actionId)).toEqual([quick.id]);
    const item = list.items.find((i) => i.actionId === quick.id)!;
    expect(item).toMatchObject({ kind: "quick", effortLabel: "15m 碎片时间", nextStep: "打 010-1234" });
    const done = item.buttons.find((b) => b.id === "done")!;
    expect(done).toMatchObject({ primary: true, endpoint: { method: "POST", path: `/api/engage/desk/${quick.id}/done` } });

    const r = await d.post<EngageMutationResponse>(done.endpoint!.path,done.endpoint!.body);
    expect(r).toMatchObject({ outcome: "done", message: "已办完" });
    expect(d.kernel.context.readStateSync<ActionRecord>("desk", gtdKeys.action(quick.id))).toMatchObject({ status: "done", completedAt: d.clock.now() });

    const r2 = await d.post<EngageMutationResponse>(`/api/engage/follow-up/${tracked.id}/done`,{seenItemRevision:1});
    expect(r2).toMatchObject({ outcome: "done", closedTasks: 0, view: { items: [] } });
    expect(d.kernel.getCell("follow-up")!.status).toBe("active");
    expect(d.kernel.getCell("desk")!.status).toBe("active");
  });

  it("the deep item shows the draft with decisions, parked additions and the context pack", async () => {
    const d = await bootDesk();
    const saved = d.kernel.context.commitSync("desk", {
      artifact: {
        artifactId: "art_plan",
        content: { format: "markdown", body: "# 迁移方案\n\n> [!DECISION] 第 2.3 节：两个迁移方案二选一\n> A：停机迁移\n> B：双写迁移\n\n其余照旧" },
        updatedBy: "agent",
      },
    });
    expect(saved.ok).toBe(true);
    const a = writeAction(d.kernel, "desk", { title: "定迁移方案", owner: "human", effort: "45m", artifactId: "art_plan", references: [{ label: "旧方案", uri: "res://desk/x" }] });
    // the owner saves v2; a late agent update loses and is parked beside it
    await d.req("PUT", "/api/artifacts/art_plan", { expectedVersion: 1, body: "# 迁移方案\n\n选 B" });
    expect(agentRedraft(d.kernel, "art_plan", "# 迁移方案\n\n补充：供应商要求周末停机")).toMatchObject({ ok: false, parked: expect.anything() });

    const detail = await d.get<EngageDetailDTO>(`/api/engage/desk/${a.id}`);
    expect(detail.artifact).toMatchObject({ version: 2, updatedBy: "human", parked: [{ basedOnVersion: 0, body: "# 迁移方案\n\n补充：供应商要求周末停机" }] });
    expect(detail.contextPack.references).toEqual([{ label: "旧方案", uri: "res://desk/x" }]);
    const v1 = await d.get<{ decisions: unknown[] }>("/api/artifacts/art_plan");
    expect(v1.decisions).toEqual([]);
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

describe("Radar", () => {
  it("project cancel closes its cell tree and records the cancellation", async () => {
    const d = await bootDesk();
    const p = makeProject(d.kernel, "竞品调研");
    d.kernel.spawnCell(p, { id: "w1", preset: "worker", title: "扒 A 公司" });
    d.kernel.spawnCell("w1", { id: "w1a", preset: "worker", title: "扒 A 的定价" });
    const a = writeAction(d.kernel, "w1", { title: "整理竞品", owner: "agent", progress: { done: 3, total: 15, label: "正在并发整理竞品资料" } });

    const radar = await d.get<RadarDTO>("/api/radar");
    const row = radar.projects.find((x) => x.id === p)!;
    expect(row.ball).toMatchObject({ owner: "agent", label: "🟢 Agent 处理中", text: "正在并发整理竞品资料 3/15" });
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
    expect((await d.get<EngageListDTO>("/api/engage")).items.map((i) => i.title)).toEqual(["约设计师周三开会"]);
  });

  it("a waiting watch keeps a project from being stalled; someday pauses it and activate resumes it", async () => {
    const d = await bootDesk();
    const p = makeProject(d.kernel, "供应商比价");
    d.kernel.spawnCell(p, { id: "watch-c", preset: "watcher", title: "等 C 报价", watches: [{ threadOrFilter: { thread: "memory:quote-c" } }] });
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

describe("activity: move back to Clarify", () => {
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
