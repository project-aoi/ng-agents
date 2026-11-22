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
  FocusResponse,
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
  makeReplyCard,
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

describe("Clarify — approve", () => {
  it("happy path: sent, and the card leaves the queue", async () => {
    const d = await bootDesk();
    const { actionId } = makeReplyCard(d.kernel);
    const q = await d.get<ClarifyQueueDTO>("/api/clarify");
    expect(q.remaining).toBe(1);
    const confirm = q.cards[0]!.buttons.find((b) => b.id === "confirm")!;
    expect(confirm.endpoint).toEqual({ method: "POST", path: `/api/clarify/${actionId}/approve`, body: { seenVersion: 1, seenItemRevision: 1 } });

    const r = await d.post<ApproveResponse>(confirm.endpoint!.path, confirm.endpoint!.body);
    expect(r).toMatchObject({ ok: true, outcome: "sent", message: "已发送", card: null });
    expect(r.view).toMatchObject({ remaining: 0, inboxZero: true });
    expect(r.status.clarify.pending).toBe(0);
    expect(d.memory.sent.map((s) => [s.target, s.content.body])).toEqual([["alice", "您好，接口下周二上线。"]]);
  });

  it("a stale seen-version gets version_mismatch with the current version, then succeeds on the refreshed one", async () => {
    const d = await bootDesk();
    const { actionId, artifactId } = makeReplyCard(d.kernel);
    expect(agentRedraft(d.kernel, artifactId, "您好，接口推迟到下周四上线。", 1)).toMatchObject({ ok: true, artifactVersion: 2 });

    const stale = await d.post<ApproveResponse>(`/api/clarify/${actionId}/approve`, { seenVersion: 1, seenItemRevision: 1 });
    expect(stale).toMatchObject({ ok: false, outcome: "version_mismatch", message: "草稿已更新，请重看", currentVersion: 2 });
    expect(stale.card?.draft).toMatchObject({ version: 2, body: "您好，接口推迟到下周四上线。" });
    expect(d.memory.deliveries).toEqual([]);

    const again = stale.card!.buttons.find((b) => b.id === "confirm")!.endpoint!;
    expect(again.body).toEqual({ seenVersion: 2, seenItemRevision: 2 });
    const ok = await d.post<ApproveResponse>(again.path, again.body);
    expect(ok.outcome).toBe("sent");
    expect(d.memory.sent.map((s) => s.content.body)).toEqual(["您好，接口推迟到下周四上线。"]);
  });

  it("BUG-020: stale seenItemRevision is rejected across approve / revise / snooze / deny with currentRevision", async () => {
    const d = await bootDesk();
    const { actionId } = makeReplyCard(d.kernel);
    const q = await d.get<ClarifyQueueDTO>("/api/clarify");
    expect(q.cards[0]!.itemRevision).toBe(1);

    // Revise succeeds at rev 1 -> bumps to rev 2.
    const rev = await d.post<ClarifyMutationResponse>(`/api/clarify/${actionId}/revise`, { instruction: "更简短一点", seenItemRevision: 1 });
    expect(rev).toMatchObject({ ok: true, outcome: "revising" });
    expect(rev.card!.itemRevision).toBe(2);

    // Old rev 1 is now rejected on approve / snooze / deny / revise.
    expect(await d.post<ApproveResponse>(`/api/clarify/${actionId}/approve`, { seenVersion: 1, seenItemRevision: 1 })).toMatchObject({
      ok: false,
      outcome: "revision_mismatch",
      currentRevision: 2,
    });
    expect(await d.post<ClarifyMutationResponse>(`/api/clarify/${actionId}/snooze`, { seenItemRevision: 1 })).toMatchObject({
      ok: false,
      outcome: "revision_mismatch",
      currentRevision: 2,
    });
    expect(await d.post<ClarifyMutationResponse>(`/api/clarify/${actionId}/deny`, { seenItemRevision: 1 })).toMatchObject({
      ok: false,
      outcome: "revision_mismatch",
      currentRevision: 2,
    });
    expect(d.memory.deliveries).toEqual([]);
  });

  it("an unknown send keeps the card visible, is never retried, and can be verified", async () => {
    const d = await bootDesk();
    const { actionId } = makeReplyCard(d.kernel);
    d.memory.respondWith("unknown");
    const r = await d.post<ApproveResponse>(`/api/clarify/${actionId}/approve`, { seenVersion: 1, seenItemRevision: 1 });
    expect(r).toMatchObject({ ok: false, outcome: "unknown", message: "发送结果未知，请核实" });
    expect(r.card).toMatchObject({ id: actionId, state: "send_unknown", outcome: { state: "send_unknown", message: "发送结果未知，请核实" } });
    expect(r.card!.buttons.map((b) => b.id)).toEqual(["verify_sent", "verify_failed", "skip"]);

    // clicking approve again reports the same receipt and does not send twice
    const second = await d.post<ApproveResponse>(`/api/clarify/${actionId}/approve`, { seenVersion: 1, seenItemRevision: r.card!.itemRevision });
    expect(second.outcome).toBe("unknown");
    await d.kernel.idle();
    expect(d.memory.deliveries).toHaveLength(1);
    expect((await d.get<ClarifyQueueDTO>("/api/clarify")).cards.map((c) => c.state)).toEqual(["send_unknown"]);

    const v = await d.post<ClarifyMutationResponse>(`/api/clarify/${actionId}/verify`, r.card!.buttons.find(b => b.id === "verify_sent")!.endpoint!.body);
    expect(v).toMatchObject({ outcome: "verified", card: null, view: { remaining: 0 } });
  });

  it("rejects a first-attempt verification after a second unknown send and shows the actual sent body", async () => {
    const d = await bootDesk();
    const { actionId, artifactId } = makeReplyCard(d.kernel, { text: "actually sent" });
    const base = `/api/clarify/${actionId}`;
    expect((await d.req("POST", base + "/approve", { seenVersion: 1 })).status).toBe(400);
    d.memory.respondWith("unknown", { times: 2 });
    const first = await d.post<ApproveResponse>(base + "/approve", { seenVersion: 1, seenItemRevision: 1 });
    const old = first.card!.buttons.find(b => b.id === "verify_sent")!.endpoint!.body!;
    const verified = await d.post<ClarifyMutationResponse>(base + "/verify", { ...old, verdict: "failed" });
    const retry = verified.card!.buttons.find(b => b.id === "retry_send")!.endpoint!;
    const second = await d.post<ApproveResponse>(retry.path, retry.body);
    const current = second.card!.buttons.find(b => b.id === "verify_sent")!.endpoint!.body!;
    expect(current["seenAttempt"]).toBe(2);
    expect(await d.post(base + "/verify", old)).toMatchObject({ ok: false, outcome: "revision_mismatch" });
    expect(await d.post(base + "/verify", { ...current, seenAttempt: 1 })).toMatchObject({ ok: false, outcome: "revision_mismatch" });
    agentRedraft(d.kernel, artifactId, "different unsent revision", 1);
    const queue = await d.get<ClarifyQueueDTO>("/api/clarify");
    expect(queue.cards[0]?.outcome?.attemptedBody).toBe("actually sent");
    expect(await d.post(base + "/verify", current)).toMatchObject({ ok: true, outcome: "verified" });
    expect(d.memory.deliveries).toHaveLength(2);
  });

  it("abandon fences a stale retry even after restore, until the owner uses the restored card", async () => {
    const d = await bootDesk();
    const { actionId } = makeReplyCard(d.kernel);
    const base = `/api/clarify/${actionId}`;
    d.memory.respondWith("failed");
    const failure = await d.post<ApproveResponse>(base + "/approve", { seenVersion: 1, seenItemRevision: 1 });
    const oldRetry = failure.card!.buttons.find(b => b.id === "retry_send")!.endpoint!;
    const abandon = failure.card!.buttons.find(b => b.id === "abandon")!.endpoint!;
    expect(await d.post(abandon.path, abandon.body)).toMatchObject({ ok: true });
    expect(await d.post(oldRetry.path, oldRetry.body)).toMatchObject({ ok: false });
    expect(d.kernel.gate.getApprovalSync(actionId)?.status).toBe("cancelled");
    const activity = await d.get<{ items: Array<{ id: string; cellId: string }> }>("/api/activity");
    const [item] = activity.items;
    expect(await d.post(`/api/activity/${item!.cellId}/${item!.id}/restore`)).toMatchObject({ outcome: "restored" });
    expect(await d.post(oldRetry.path, oldRetry.body)).toMatchObject({ outcome: "revision_mismatch" });
    expect(d.memory.deliveries).toHaveLength(1);
    const queue = await d.get<ClarifyQueueDTO>("/api/clarify");
    const retry = queue.cards[0]!.buttons.find(b => b.id === "retry_send")!.endpoint!;
    expect(await d.post(retry.path, retry.body)).toMatchObject({ outcome: "sent" });
    expect(d.memory.deliveries).toHaveLength(2);
  });

  it("upgrades an explicitly abandoned legacy send and preserves its restoration across restart", async () => {
    const dataDir = tempDir("legacy-send");
    const opts = { dataDir, kernel: { db: join(dataDir, "ng.db") } };
    const old = await bootDesk(opts);
    const { actionId } = makeReplyCard(old.kernel);
    old.memory.respondWith("failed");
    const base = `/api/clarify/${actionId}`;
    const failed = await old.post<ApproveResponse>(base + "/approve", { seenVersion: 1, seenItemRevision: 1 });
    const retry = failed.card!.buttons.find(b => b.id === "retry_send")!.endpoint!;
    const activity = writeActivity(old.kernel, {
      kind: "card_withdrawn", title: "不再发送", detail: "发送失败后你选择了不再发送", actionId, restorable: true,
    });
    await old.server.close();
    const next = await bootDesk(opts);
    expect(next.kernel.gate.getApprovalSync(actionId)).toMatchObject({ status: "cancelled", statusReason: `abandoned:${activity.id}` });
    expect(await next.post(retry.path, retry.body)).toMatchObject({ ok: false });
    expect(await next.post(`/api/activity/desk/${activity.id}/restore`)).toMatchObject({ outcome: "restored" });
    await next.server.close();
    const again = await bootDesk(opts);
    expect((await again.get<ClarifyQueueDTO>("/api/clarify")).cards).toMatchObject([{ id: actionId, state: "send_failed" }]);
    expect(await again.post(retry.path, retry.body)).toMatchObject({ outcome: "revision_mismatch" });
    expect(again.memory.deliveries).toHaveLength(0);
  });

  it("an unverified send of an item blocks a newer draft for the same item", async () => {
    const d = await bootDesk();
    const first = makeReplyCard(d.kernel, { subjectKey: "msg:one" });
    d.memory.respondWith("unknown");
    await d.post(`/api/clarify/${first.actionId}/approve`, { seenVersion: 1, seenItemRevision: 1 });
    const next = makeReplyCard(d.kernel, { subjectKey: "msg:one", text: "补充一句" });
    const q = await d.get<ClarifyQueueDTO>("/api/clarify");
    expect(q.cards.map((c) => [c.id, c.state])).toEqual([[first.actionId, "send_unknown"]]);
    const current = d.kernel.humanItems.get(first.actionId)!;
    expect(d.kernel.humanItems.list().map(i => i.id)).toEqual([first.actionId]);
    await d.kernel.humanItems.decide(first.actionId,{
      optionId:"system.sent", seenItemRevision:current.itemRevision, seenAttempt:current.attempt!, seenArtifactVersion:current.artifactVersion!,
    },"owner");
    expect(d.kernel.humanItems.list().map(i => i.id)).toEqual([next.actionId]);
  });
});

describe("Clarify — the other buttons", () => {
  it("snooze hides the card and it resurfaces when the clock passes the time", async () => {
    const d = await bootDesk();
    const { actionId } = makeReplyCard(d.kernel);
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

  it("the snooze button carries the next afternoon slot", async () => {
    const d = await bootDesk();
    makeReplyCard(d.kernel);
    const q = await d.get<ClarifyQueueDTO>("/api/clarify");
    const snooze = q.cards[0]!.buttons.find((b) => b.id === "snooze")!;
    const until = (snooze.endpoint!.body as { until: number }).until;
    expect(until).toBeGreaterThan(d.clock.now());
    expect(new Date(until).getHours()).toBe(14);
    expect(snooze.hint).toMatch(/^到 (今天|明天) 14:00 回到待确认$/);
  });

  it("revise wakes the owning cell with the instruction and marks the card as revising", async () => {
    const d = await bootDesk();
    const { actionId } = makeReplyCard(d.kernel);
    const r = await d.post<ClarifyMutationResponse>(`/api/clarify/${actionId}/revise`, { instruction: "语气再正式一点", voice: true, seenItemRevision: 1 });
    expect(r).toMatchObject({ outcome: "revising", card: { state: "revising" } });
    expect(r.card!.sourceBar.statusText).toContain("正在按你的意见重拟");
    await d.kernel.idle();
    const text = d.script.requests.filter((x) => x.cellId === "desk").map((x) => requestText(x.req)).join("\n");
    expect(text).toContain("语气再正式一点");
  });

  it("edits and sends the same inbox card with the reviewed draft version", async () => {
    const d = await bootDesk();
    const {actionId,artifactId} = makeReplyCard(d.kernel);
    const path = `/api/human-items/${actionId}/decide`;
    const before = d.kernel.humanItems.get(actionId)!;
    const saved = await d.req<ArtifactSaveResponse>("PUT", `/api/artifacts/${artifactId}`, {expectedVersion:1,body:"您好，接口下周二上线。"});
    expect(saved.json).toMatchObject({outcome:"saved",artifact:{version:2,updatedBy:"human"}});
    const choice = {optionId:"system.execute",seenItemRevision:before.itemRevision};
    expect((await d.req("POST",path,{...choice,seenArtifactVersion:1})).status).toBe(409);
    const fresh = d.kernel.humanItems.get(actionId)!;
    await d.post(path,{...choice,seenItemRevision:fresh.itemRevision,seenArtifactVersion:2});
    expect(d.memory.sent.map(s=>s.content.body)).toEqual(["您好，接口下周二上线。"]);
    expect(d.kernel.humanItems.list()).toHaveLength(0);
  });

  it("confirms resuming the paused card issuer before sending, even when its project is active", async () => {
    const d = await bootDesk();
    const projectId = makeProject(d.kernel, "交付项目");
    const workerId = "issuer";
    d.kernel.spawnCell(projectId, {id:workerId, preset:"worker", bounds:{canSendTo:["channel:memory:*"]}});
    const {actionId} = makeReplyCard(d.kernel, {cellId:workerId});
    d.kernel.control(workerId, {action:"pause"});
    const item = (await d.get<{items:HumanItemDTO[]}>("/api/human-items")).items.find(i => i.id === actionId)!;
    expect(item.project?.paused).toBe(false);
    expect(item.resumeTarget?.id).toBe(workerId);
    const decision = {optionId:"system.execute", seenItemRevision:item.itemRevision, seenArtifactVersion:item.artifactVersion};
    const path = `/api/human-items/${actionId}/decide`;
    expect((await d.req("POST", path, decision)).status).toBe(409);
    expect(d.memory.sent).toHaveLength(0);
    expect(d.kernel.humanItems.get(actionId)?.itemRevision).toBe(item.itemRevision);
    expect(await d.post(path, {...decision, resumeProjectId:workerId})).toMatchObject({status:"sent"});
    expect(d.kernel.getCell(workerId)?.status).toBe("active");
    expect(d.memory.sent).toHaveLength(1);
  });

  it("returns a conflict when Gate cancels a card from an earlier epoch", async () => {
    const d = await bootDesk();
    const {actionId} = makeReplyCard(d.kernel);
    d.kernel.db.prepare("UPDATE human_items SET epoch=epoch-1 WHERE action_id=?").run(actionId);
    const reply = await d.req("POST", `/api/human-items/${actionId}/decide`,
      {optionId:"system.execute", seenItemRevision:1, seenArtifactVersion:1});
    expect(reply.status).toBe(409);
    expect((await d.req("POST", "/api/human-items/absent/decide", {optionId:"system.someday", seenItemRevision:1})).status).toBe(404);
    expect(d.memory.sent).toHaveLength(0);
  });

  it("dismiss archives the card; it can be moved back to Clarify from the activity list", async () => {
    const d = await bootDesk();
    const env = inboundEnvelope(d.kernel, "顺便问下周会改到几点？");
    d.kernel.inbox.enqueueSync("desk", env);
    await d.kernel.idle();
    const { actionId } = makeReplyCard(d.kernel, { envelopeId: env.id });
    const r = await d.post<ClarifyMutationResponse>(`/api/clarify/${actionId}/dismiss`, { seenItemRevision: 1 });
    expect(r).toMatchObject({ outcome: "dismissed", view: { remaining: 0 } });
    const acts = await d.get<{ items: Array<{ id: string; cellId: string; kind: string; restorable: boolean }> }>("/api/activity");
    expect(acts.items[0]).toMatchObject({ kind: "card_withdrawn", restorable: true });
    const restored = await d.post<ActivityMutationResponse>(`/api/activity/${acts.items[0]!.cellId}/${acts.items[0]!.id}/restore`);
    expect(restored.outcome).toBe("restored");
    const handbacks = d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.handback });
    expect((handbacks[0]!.envelope.payload as HandbackPayload).original.id).toBe(env.id);
  });
});

describe("Engage", () => {
  it("keeps a budget-declined project paused on a bare resume", async () => {
    const d = await bootDesk();
    const id = makeProject(d.kernel, "额度不足的项目");
    d.kernel.gate.declineBudgetSync(id, "owner");
    const r = await d.post<ProjectMutationResponse>(`/api/projects/${id}/resume`);
    expect(r).toMatchObject({ok:false, outcome:"not_applied", message:expect.stringContaining("追加额度")});
    expect(d.kernel.getCell(id)?.pauseReason).toBe("budget_declined");
  });

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

describe("focus (DND)", () => {
  it("focus on buffers an owner notification; focus off flushes it", async () => {
    const d = await bootDesk();
    const on = await d.post<FocusResponse>("/api/focus", { on: true });
    expect(on).toMatchObject({ focus: { on: true, buffered: 0 }, flushed: null });

    d.script.add("desk", tool("send_message", { to: "channel:ui:owner", text: "已设好周五 15:00 的提醒", summary: "notify the owner" }));
    await d.post("/api/capture", { text: "周五下午 3 点提醒我打电话" });
    await d.kernel.idle();
    const s = await d.get<StatusDTO>("/api/status");
    expect(s.focus).toEqual({ on: true, manual:true,editors:0, buffered: 1 });
    expect(s.statusLine.engage).toBe("免打扰已开启：已暂存 1 条非紧急外部通知");
    expect(s.notifications).toMatchObject([{ text: "已设好周五 15:00 的提醒", state: "held" }]);

    const off = await d.post<FocusResponse>("/api/focus", { on: false });
    expect(off).toMatchObject({ focus: { on: false, buffered: 0 }, flushed: { sent: 1, failed: 0, unknown: 0 } });
    expect(off.status.notifications).toMatchObject([{ text: "已设好周五 15:00 的提醒", state: "delivered" }]);
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
