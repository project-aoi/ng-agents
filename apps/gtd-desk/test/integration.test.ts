// The app's endpoints and projections against the real presets (the other app tests mostly use stand-in presets): the
// places where a preset's record shape, subject key or card meets an app button — under docs/05, where every item is
// a persistent `project` cell that dispatches one-shot workers and decides itself what happens next.

import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys } from "@ng/presets";
import type { ProjectRecord } from "@ng/presets/records";
import type { HumanItemDTO, ProjectMutationResponse, RadarDTO } from "../src/shared/api";
import { bootRealDesk, cellMessages, cleanupAll, requestsOf, tool, type TestDesk } from "./helpers";

afterEach(cleanupAll);

const deskCalls = (d: TestDesk) => d.script.requests.filter((r) => r.role === "desk").length;
const texts = (d: TestDesk, cellId: string) => cellMessages(d.kernel, cellId).map((e) => (e.payload as { text: string }).text);

const itemsOf = async (d: TestDesk) => (await d.get<{items: HumanItemDTO[]}>("/api/human-items")).items;
async function approve(d: TestDesk, id: string) {
  const item = (await itemsOf(d)).find(i => i.id === id)!;
  return d.post(`/api/human-items/${id}/decide`, {
    optionId: "system.execute", seenItemRevision: item.itemRevision, seenArtifactVersion: item.artifactVersion,
  });
}

async function proposal(d: TestDesk, actions: Array<{ title: string; owner: "agent" | "human" | "waiting"; effort?: "15m" | "45m"; nextStep?: string }>): Promise<string> {
  d.script.add("desk", tool("propose_project", { title: "官网改版", outcome: "新版官网上线", actions }));
  await d.post("/api/capture", { text: "官网该改版了，帮我规划一下" });
  await d.kernel.idle();
  return (await itemsOf(d)).find(item => item.action?.type === "project.start")!.id;
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
    const cardId = await proposal(d, [{ title: "盘点现有网页", owner: "agent", effort: "15m" }]);
    const calls = deskCalls(d);
    const r = await approve(d, cardId);
    expect(r).toMatchObject({ status: "approved" });
    // No idle(): the project cell exists when the response is out.
    const projects = d.kernel.listCells({ parentId: "desk" }).filter((c) => c.spec.meta?.["role"] === "project");
    expect(projects.map((c) => [c.title, c.preset])).toEqual([["官网改版", "project"]]);
    await d.kernel.idle();
    expect(deskCalls(d)).toBe(calls);
    const radar = await d.get<RadarDTO>("/api/radar");
    expect(radar.projects.map(p=>p.title)).toEqual(["官网改版"]);
    expect(d.kernel.humanItems.list()).toHaveLength(0);
    expect(d.kernel.context.readStateSync<ProjectRecord>(projects[0]!.id,gtdKeys.project)?.proposal?.actions[0]?.title).toBe("盘点现有网页");
  });

  it("ticking off a project's human action wakes the project with the owner's words (its wait on the owner is answered); the project decides it is done", async () => {
    const d = await bootRealDesk();
    const cardId = await proposal(d, [{ title: "和市场部对齐风格", owner: "human", effort: "15m", nextStep: "约市场部聊 15 分钟" }]);
    // The project's first run: it waits for the owner.
    d.script.add("project", tool("wait", { reason: "等主人和市场部对齐风格", waitingFor: "human" }));
    await approve(d, cardId);
    await d.kernel.idle();
    const items = await itemsOf(d);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ title: "和市场部对齐风格", project: { title: "官网改版" } });
    const projectId = item!.project!.id;
    expect(d.kernel.listWaits([projectId]).map((w) => w.waitingFor)).toEqual(["human"]);

    // What the project does when it hears it: everything it took on is done.
    d.script.add("project", tool("finish_project", { outcome: "completed", summary: "风格已对齐，新版官网方案定稿", retro: "none — 没有新的做事习惯" }));
    const r = await d.post(`/api/human-items/${item!.id}/decide`, { optionId: item!.options[0]!.id,  note: "市场部同意用新配色",seenItemRevision:item!.itemRevision });
    expect(r).toMatchObject({ status: "resolved" });
    expect(d.kernel.inbox.listMessagesSync({cellId:projectId,type:"approval.resolved"}).at(-1)?.envelope.payload).toMatchObject({note:"市场部同意用新配色"});
    await d.kernel.idle();
    expect(d.kernel.listWaits([projectId])).toEqual([]);
    expect(requestsOf(d.script, projectId).at(-1)).toContain("市场部同意用新配色");
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
    const [item] = (await itemsOf(d));
    expect(item).toMatchObject({ title: "给牙医打电话", project: null, cellId: null });
    await d.post(`/api/human-items/${item!.id}/decide`, { optionId: item!.options[0]!.id, seenItemRevision: 1});
    expect(d.kernel.humanItems.get(item!.id)?.status).toBe("resolved");
    expect(d.kernel.inbox.listMessagesSync({ type: "cell.message" })).toEqual([]);
  });

  it("a project's worker blocked on the owner: its decision is the only inbox item and Radar points at the card", async () => {
    const d = await bootRealDesk();
    d.script.add("project", tool("dispatch", { title: "整理上线检查清单", instruction: "整理上线检查清单，用 markdown" }));
    d.script.add("worker", tool("request_approval", { kind: "escalation", title: "清单要不要包含回滚演练？", summary: "需要主人决定范围", escalation: { reason: "blocked", explanation: "回滚演练要停服 10 分钟，要不要写进清单？" } }));
    const projectId = await deskProject(d, "整理上线检查清单");
    await d.kernel.idle();
    const card = (await itemsOf(d))[0]!;
    expect(card).toMatchObject({ category: "decision", relatedProjectIds: [projectId], title: "清单要不要包含回滚演练？" });
    expect((await itemsOf(d)).filter(item => item.category === "action")).toEqual([]);
    const [row] = (await d.get<RadarDTO>("/api/radar")).projects;
    expect(row).toMatchObject({ id: projectId, ball: { owner: "human", cardId: card.id }, stalled: false });
    expect(row!.workers.map((w) => w.title)).toEqual(["整理上线检查清单"]);
  });

  it("replying to a project decision wakes that project with the owner's words", async () => {
    const d = await bootRealDesk();
    d.script.add("project", tool("request_approval", { kind: "action", title: "第一阶段完成，开始第二阶段？", summary: "阶段确认", action: { name: "phase.next" } }));
    const projectId = await deskProject(d, "极简模式第一阶段");
    const card = (await itemsOf(d))[0]!;
    expect(card.project?.id).toBe(projectId);
    const [item] = d.kernel.humanItems.list();
    expect(item).toMatchObject({id:card.id,relatedProjectIds:[projectId]});
    await d.post(`/api/human-items/${card.id}/decide`, {optionId:"system.reply",seenItemRevision:item!.itemRevision,note:"自己和设计师过一遍第二阶段的范围"});
    expect(d.kernel.inbox.listMessagesSync({cellId:projectId,type:"approval.resolved"}).at(-1)?.envelope).toMatchObject({delivery:"wakeup",payload:{note:"自己和设计师过一遍第二阶段的范围"}});
    await d.kernel.idle();
    // the project decides what is next; it is not completed behind its back
    expect(d.kernel.getCell(projectId)!.status).toBe("active");
  });

  it("a project moved to “以后再说” keeps its actions linked and identifies the project to resume", async () => {
    const d = await bootRealDesk();
    const cardId = await proposal(d, [
      { title: "和市场部对齐风格", owner: "human", effort: "15m" },
      { title: "拉一份现有页面清单", owner: "agent" },
    ]);
    await approve(d, cardId);
    await d.kernel.idle();
    const projectId = (await d.get<RadarDTO>("/api/radar")).projects[0]!.id;
    expect((await itemsOf(d)).map((i) => i.title)).toEqual(["和市场部对齐风格"]);
    expect((await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/someday`)).outcome).toBe("someday");
    expect(d.kernel.getCell(projectId)!.status).toBe("paused");
    expect(await itemsOf(d)).toMatchObject([{ title: "和市场部对齐风格", resumeTarget: { id: projectId }, project: { id: projectId, parked: true } }]);
    expect((await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/activate`)).outcome).toBe("activated");
    expect(d.kernel.getCell(projectId)!.status).toBe("active");
    expect(d.kernel.context.readStateSync<ProjectRecord>(projectId, gtdKeys.project)!.lifecycle).toBe("active");
    expect((await itemsOf(d)).map((i) => i.title)).toEqual(["和市场部对齐风格"]);
    expect(texts(d, projectId)).toEqual([expect.stringContaining("主人点了启动")]);
  });

});
