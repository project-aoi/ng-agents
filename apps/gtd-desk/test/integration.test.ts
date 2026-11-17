// The app's endpoints and projections against the real presets (the other app tests use stand-in presets): the
// places where a preset's record shape, subject key or card meets an app button.

import { afterEach, describe, expect, it } from "vitest";
import { registerPresets } from "@ng/presets";
import type { ActivityListDTO, ClarifyMutationResponse, ClarifyQueueDTO, EngageListDTO, EngageMutationResponse, ProjectMutationResponse, RadarDTO } from "../src/shared/api";
import { bootDesk, cleanupAll, tool, type TestDesk } from "./helpers";

afterEach(cleanupAll);

async function boot(): Promise<TestDesk> {
  return bootDesk({ registerPresets: (registry, opts) => registerPresets(registry, { ...opts, weeklyReview: false }) });
}

const deskCalls = (d: TestDesk) => d.script.requests.filter((r) => r.role === "desk").length;

async function proposal(d: TestDesk, actions: Array<{ title: string; owner: "agent" | "human" | "waiting"; effort?: "15m" | "45m" }>): Promise<string> {
  d.script.add("desk", tool("propose_project", { title: "官网改版", outcome: "新版官网上线", actions, research: true }));
  await d.post("/api/capture", { text: "官网该改版了，帮我规划一下" });
  await d.kernel.idle();
  const q = await d.get<ClarifyQueueDTO>("/api/clarify");
  const card = q.cards.find((c) => c.cardType === "project_proposal")!;
  return card.id;
}

describe("app × real presets", () => {
  it("“✓ 确认立项并让 Agent 开工” creates the project in the same request; the desk's model is not woken for it", async () => {
    const d = await boot();
    const cardId = await proposal(d, [{ title: "和市场部对齐风格", owner: "human", effort: "15m" }]);
    const calls = deskCalls(d);
    const r = await d.post<ClarifyMutationResponse>(`/api/clarify/${cardId}/approve`, { seenVersion: 1 });
    expect(r).toMatchObject({ ok: true, outcome: "approved", message: "已确认立项，Agent 开始推进" });
    // No idle(): the root exists when the response is out.
    const roots = d.kernel.listCells({ parentId: "desk" }).filter((c) => c.spec.meta?.["role"] === "coordinator");
    expect(roots.map((c) => c.title)).toEqual(["官网改版"]);
    await d.kernel.idle();
    expect(deskCalls(d)).toBe(calls);
    const radar = await d.get<RadarDTO>("/api/radar");
    expect(radar.projects.map((p) => [p.title, p.ball?.text])).toEqual([["官网改版", "和市场部对齐风格"]]);
  });

  it("checking off a project's last action in Engage completes the project", async () => {
    const d = await boot();
    const cardId = await proposal(d, [{ title: "和市场部对齐风格", owner: "human", effort: "15m" }]);
    await d.post(`/api/clarify/${cardId}/approve`, { seenVersion: 1 });
    await d.kernel.idle();
    const [item] = (await d.get<EngageListDTO>("/api/engage")).items;
    expect(item).toMatchObject({ title: "和市场部对齐风格", project: { title: "官网改版" } });
    const r = await d.post<EngageMutationResponse>(`/api/engage/${item!.cellId}/${item!.actionId}/done`);
    expect(r).toMatchObject({ ok: true, outcome: "done" });
    await d.kernel.idle();
    const radar = await d.get<RadarDTO>("/api/radar");
    expect(radar.projects).toEqual([]);
    expect(radar.counts.completedThisWeek).toBe(1);
    expect(d.kernel.getCell(item!.project!.id)).toMatchObject({ status: "closed", closeReason: "completed" });
  });

  it("an item waiting on its result card is decided in Clarify, not listed as a to-do in Engage; Radar points at the card", async () => {
    const d = await boot();
    d.script.add("desk", tool("delegate", { title: "整理上线检查清单", instruction: "整理", research: true }), tool("wait", { reason: "ok" }));
    d.script.add("worker", tool("report_to_parent", { kind: "result", text: "清单已整理：1. 配置检查 2. 回滚预案" }));
    await d.post("/api/capture", { text: "帮我整理一份上线检查清单" });
    await d.kernel.idle();
    const card = (await d.get<ClarifyQueueDTO>("/api/clarify")).cards[0]!;
    expect(card).toMatchObject({ cardType: "response", reply: { confirmVerb: "accept" } });
    expect((await d.get<EngageListDTO>("/api/engage")).items).toEqual([]);
    const [row] = (await d.get<RadarDTO>("/api/radar")).projects;
    expect(row!.ball).toMatchObject({ owner: "human", cardId: card.id });
    expect(row!.stalled).toBe(false);
    await d.post(`/api/clarify/${card.id}/approve`, { seenVersion: 1 });
    await d.kernel.idle();
    expect((await d.get<RadarDTO>("/api/radar")).projects).toEqual([]);
  });

  it("“不需要处理（归档）” on a result card completes the item; “转给我来处理” turns it into an Engage item that completes it when checked off", async () => {
    const d = await boot();
    const delegate = async (title: string) => {
      d.script.add("desk", tool("delegate", { title, instruction: title, research: true }), tool("wait", { reason: "ok" }));
      d.script.add("worker", tool("report_to_parent", { kind: "result", text: `${title}：已完成` }));
      await d.post("/api/capture", { text: title });
      await d.kernel.idle();
      return (await d.get<ClarifyQueueDTO>("/api/clarify")).cards.find((c) => c.title.startsWith(title))!;
    };
    const a = await delegate("整理上线检查清单");
    await d.post(`/api/clarify/${a.id}/dismiss`);
    await d.kernel.idle();
    expect(d.kernel.getCell(a.projectId!)).toMatchObject({ status: "closed", closeReason: "completed" });

    const b = await delegate("整理值班手册");
    await d.post(`/api/clarify/${b.id}/to-human`);
    await d.kernel.idle();
    const [item] = (await d.get<EngageListDTO>("/api/engage")).items;
    expect(item).toMatchObject({ title: b.title, kind: "deep", project: { id: b.projectId } });
    expect((await d.get<RadarDTO>("/api/radar")).projects.map((p) => p.ball?.owner)).toEqual(["human"]);
    await d.post(`/api/engage/${item!.cellId}/${item!.actionId}/done`);
    await d.kernel.idle();
    expect(d.kernel.getCell(b.projectId!)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect((await d.get<RadarDTO>("/api/radar")).projects).toEqual([]);
  });

  it("a project moved to “以后再说” takes its actions out of Engage; reactivating brings them back", async () => {
    const d = await boot();
    const cardId = await proposal(d, [
      { title: "和市场部对齐风格", owner: "human", effort: "15m" },
      { title: "拉一份现有页面清单", owner: "agent" },
    ]);
    d.script.add("worker", tool("wait", { reason: "working" }));
    await d.post(`/api/clarify/${cardId}/approve`, { seenVersion: 1 });
    await d.kernel.idle();
    const projectId = (await d.get<RadarDTO>("/api/radar")).projects[0]!.id;
    expect((await d.get<EngageListDTO>("/api/engage")).items.map((i) => i.title)).toEqual(["和市场部对齐风格"]);
    expect((await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/someday`)).outcome).toBe("someday");
    expect((await d.get<EngageListDTO>("/api/engage")).items).toEqual([]);
    expect((await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/activate`)).outcome).toBe("activated");
    expect((await d.get<EngageListDTO>("/api/engage")).items.map((i) => i.title)).toEqual(["和市场部对齐风格"]);
  });

  it("a reply taken over in Engage and sent from there is one entry in the activity drawer", async () => {
    const d = await boot();
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
