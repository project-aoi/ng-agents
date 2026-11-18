// The app's endpoints and projections against the real presets (the other app tests mostly use stand-in presets): the
// places where a preset's record shape, subject key or card meets an app button — under docs/05, where every item is
// a persistent `project` cell that dispatches one-shot workers and decides itself what happens next.

import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, type ProjectRecord } from "@ng/protocol";
import type { ActivityListDTO, ClarifyMutationResponse, ClarifyQueueDTO, EngageListDTO, EngageMutationResponse, ProjectMutationResponse, RadarDTO } from "../src/shared/api";
import { bootRealDesk, cellMessages, cleanupAll, requestsOf, tool, type TestDesk } from "./helpers";

afterEach(cleanupAll);

const deskCalls = (d: TestDesk) => d.script.requests.filter((r) => r.role === "desk").length;
const texts = (d: TestDesk, cellId: string) => cellMessages(d.kernel, cellId).map((e) => (e.payload as { text: string }).text);

async function proposal(d: TestDesk, actions: Array<{ title: string; owner: "agent" | "human" | "waiting"; effort?: "15m" | "45m"; nextStep?: string }>): Promise<string> {
  d.script.add("desk", tool("propose_project", { title: "官网改版", outcome: "新版官网上线", actions }));
  await d.post("/api/capture", { text: "官网该改版了，帮我规划一下" });
  await d.kernel.idle();
  const q = await d.get<ClarifyQueueDTO>("/api/clarify");
  return q.cards.find((c) => c.cardType === "project_proposal")!.id;
}

/** A project started by the desk (start_project); returns its id once its first run is over. */
async function deskProject(d: TestDesk, title: string): Promise<string> {
  d.script.add("desk", tool("start_project", { title, outcome: `${title}：完成`, brief: `主人的原话：${title}` }));
  await d.post("/api/capture", { text: title });
  await d.kernel.idle();
  return d.kernel.listCells({ parentId: "desk" }).find((c) => c.title === title && c.spec.meta?.["role"] === "project")!.id;
}

describe("app × real presets", () => {
  it("“✓ 确认立项并让 Agent 开工” creates the project cell in the same request; the desk's model is not woken for it", async () => {
    const d = await bootRealDesk();
    const cardId = await proposal(d, [{ title: "和市场部对齐风格", owner: "human", effort: "15m" }]);
    const calls = deskCalls(d);
    const r = await d.post<ClarifyMutationResponse>(`/api/clarify/${cardId}/approve`, { seenVersion: 1 });
    expect(r).toMatchObject({ ok: true, outcome: "approved", message: "已确认立项，Agent 开始推进" });
    // No idle(): the project cell exists when the response is out.
    const projects = d.kernel.listCells({ parentId: "desk" }).filter((c) => c.spec.meta?.["role"] === "project");
    expect(projects.map((c) => [c.title, c.preset])).toEqual([["官网改版", "project"]]);
    await d.kernel.idle();
    expect(deskCalls(d)).toBe(calls);
    const radar = await d.get<RadarDTO>("/api/radar");
    expect(radar.projects.map((p) => [p.title, p.ball?.text])).toEqual([["官网改版", "和市场部对齐风格"]]);
  });

  it("ticking off a project's human action in Engage wakes the project with the owner's words (its wait on the owner is answered); the project decides it is done", async () => {
    const d = await bootRealDesk();
    const cardId = await proposal(d, [{ title: "和市场部对齐风格", owner: "human", effort: "15m", nextStep: "约市场部聊 15 分钟" }]);
    // The project's first run: it waits for the owner.
    d.script.add("project", tool("wait", { reason: "等主人和市场部对齐风格", waitingFor: "human" }));
    await d.post(`/api/clarify/${cardId}/approve`, { seenVersion: 1 });
    await d.kernel.idle();
    const [item] = (await d.get<EngageListDTO>("/api/engage")).items;
    expect(item).toMatchObject({ title: "和市场部对齐风格", project: { title: "官网改版" } });
    const projectId = item!.project!.id;
    expect(d.kernel.listWaits([projectId]).map((w) => w.waitingFor)).toEqual(["human"]);

    // What the project does when it hears it: everything it took on is done.
    d.script.add("project", tool("finish_project", { outcome: "completed", summary: "风格已对齐，新版官网方案定稿", retro: "none — 没有新的做事习惯" }));
    const r = await d.post<EngageMutationResponse>(`/api/engage/${item!.cellId}/${item!.actionId}/done`, { note: "市场部同意用新配色" });
    expect(r).toMatchObject({ ok: true, outcome: "done" });
    expect(texts(d, projectId)).toEqual([expect.stringContaining("主人已完成：和市场部对齐风格")]);
    expect(texts(d, projectId)[0]).toContain("市场部同意用新配色");
    await d.kernel.idle();
    expect(d.kernel.listWaits([projectId])).toEqual([]);
    expect(requestsOf(d.script, projectId).at(-1)).toContain("主人已完成：和市场部对齐风格");
    const radar = await d.get<RadarDTO>("/api/radar");
    expect(radar.projects).toEqual([]);
    expect(radar.counts.completedThisWeek).toBe(1);
    expect(d.kernel.getCell(projectId)).toMatchObject({ status: "closed", closeReason: "completed" });
  });

  it("checking off the desk's own quick to-do tells no project", async () => {
    const d = await bootRealDesk();
    d.script.add("desk", tool("remind_me", { text: "给牙医打电话", inMinutes: 5 }));
    await d.post("/api/capture", { text: "5 分钟后提醒我给牙医打电话" });
    await d.kernel.idle();
    d.clock.advance(5 * 60_000);
    await d.kernel.idle();
    const [item] = (await d.get<EngageListDTO>("/api/engage")).items;
    expect(item).toMatchObject({ title: "给牙医打电话", project: null, cellId: "desk" });
    await d.post(`/api/engage/${item!.cellId}/${item!.actionId}/done`);
    expect(d.kernel.inbox.listMessagesSync({ type: "cell.message" })).toEqual([]);
  });

  it("a project's worker blocked on the owner: its card is decided in Clarify, the action it carries is no to-do in Engage, Radar points at the card", async () => {
    const d = await bootRealDesk();
    d.script.add("project", tool("dispatch", { title: "整理上线检查清单", instruction: "整理上线检查清单，用 markdown", cwdMode: "read" }));
    d.script.add("worker", tool("request_approval", { kind: "escalation", title: "清单要不要包含回滚演练？", summary: "需要主人决定范围", escalation: { reason: "blocked", explanation: "回滚演练要停服 10 分钟，要不要写进清单？" } }));
    const projectId = await deskProject(d, "整理上线检查清单");
    await d.kernel.idle();
    const card = (await d.get<ClarifyQueueDTO>("/api/clarify")).cards[0]!;
    expect(card).toMatchObject({ cardType: "escalation", projectId, escalation: { reason: "blocked" } });
    expect((await d.get<EngageListDTO>("/api/engage")).items).toEqual([]);
    const [row] = (await d.get<RadarDTO>("/api/radar")).projects;
    expect(row).toMatchObject({ id: projectId, ball: { owner: "human", cardId: card.id }, stalled: false });
    expect(row!.workers.map((w) => w.title)).toEqual(["整理上线检查清单"]);
  });

  it("“转给我来处理” on a project's card makes it the owner's action on the project's books; the project hears both the takeover and the check-off", async () => {
    const d = await bootRealDesk();
    d.script.add("project", tool("request_approval", { kind: "action", title: "第一阶段完成，开始第二阶段？", summary: "阶段确认", action: { name: "phase.next" } }));
    const projectId = await deskProject(d, "极简模式第一阶段");
    const card = (await d.get<ClarifyQueueDTO>("/api/clarify")).cards[0]!;
    expect(card.projectId).toBe(projectId);
    const t = await d.post<ClarifyMutationResponse>(`/api/clarify/${card.id}/to-human`, { nextStep: "自己和设计师过一遍第二阶段的范围" });
    expect(t).toMatchObject({ outcome: "to_human", view: { remaining: 0 } });
    const [item] = (await d.get<EngageListDTO>("/api/engage")).items;
    expect(item).toMatchObject({ title: card.title, project: { id: projectId }, nextStep: "自己和设计师过一遍第二阶段的范围" });
    expect(texts(d, projectId)).toEqual([expect.stringContaining(`主人决定亲自处理这件事：${card.title}`)]);
    expect(texts(d, projectId)[0]).toContain(item!.actionId);
    expect((await d.get<RadarDTO>("/api/radar")).projects.map((p) => p.ball?.owner)).toEqual(["human"]);
    await d.post(`/api/engage/${item!.cellId}/${item!.actionId}/done`);
    expect(texts(d, projectId)[1]).toContain(`主人已完成：${card.title}`);
    await d.kernel.idle();
    // the project decides what is next; it is not completed behind its back
    expect(d.kernel.getCell(projectId)!.status).toBe("active");
  });

  it("a project moved to “以后再说” takes its actions out of Engage; activating the same cell brings them back and tells it", async () => {
    const d = await bootRealDesk();
    const cardId = await proposal(d, [
      { title: "和市场部对齐风格", owner: "human", effort: "15m" },
      { title: "拉一份现有页面清单", owner: "agent" },
    ]);
    await d.post(`/api/clarify/${cardId}/approve`, { seenVersion: 1 });
    await d.kernel.idle();
    const projectId = (await d.get<RadarDTO>("/api/radar")).projects[0]!.id;
    expect((await d.get<EngageListDTO>("/api/engage")).items.map((i) => i.title)).toEqual(["和市场部对齐风格"]);
    expect((await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/someday`)).outcome).toBe("someday");
    expect(d.kernel.getCell(projectId)!.status).toBe("paused");
    expect((await d.get<EngageListDTO>("/api/engage")).items).toEqual([]);
    expect((await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/activate`)).outcome).toBe("activated");
    expect(d.kernel.getCell(projectId)!.status).toBe("active");
    expect(d.kernel.context.readStateSync<ProjectRecord>(projectId, gtdKeys.project)!.lifecycle).toBe("active");
    expect((await d.get<EngageListDTO>("/api/engage")).items.map((i) => i.title)).toEqual(["和市场部对齐风格"]);
    expect(texts(d, projectId)).toEqual([expect.stringContaining("主人点了启动")]);
  });

  it("a reply taken over in Engage and sent from there is one entry in the activity drawer", async () => {
    const d = await bootRealDesk();
    d.script.add("desk", tool("draft_reply", { text: "下周二上线。", title: "回复 Alice：上线时间", targetLabel: "Alice" }));
    await d.memory.inject({ from: "alice", text: "接口什么时候上线？", threads: ["memory:dm-alice"] });
    await d.kernel.idle();
    const card = (await d.get<ClarifyQueueDTO>("/api/clarify")).cards[0]!;
    await d.post(`/api/clarify/${card.id}/to-human`);
    const [item] = (await d.get<EngageListDTO>("/api/engage")).items;
    const sent = await d.post<EngageMutationResponse>(`/api/engage/${item!.cellId}/${item!.actionId}/send`, { seenVersion: 1 });
    expect(sent.outcome).toBe("sent");
    await d.kernel.idle();
    const acts = (await d.get<ActivityListDTO>("/api/activity")).items.filter((a) => a.kind === "action_completed");
    expect(acts).toHaveLength(1);
    // The app (on the click) and the desk (on its wake-up) both record the send, under the same id.
    expect(acts[0]!.title).toContain("回复 Alice：上线时间");
    expect(d.memory.sent.map((x) => x.content.body)).toEqual(["下周二上线。"]);
  });
});
