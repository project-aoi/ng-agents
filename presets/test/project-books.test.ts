import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys } from "../src/shared/keys";
import type { ProjectRecord } from "../src/shared/product-records";
import { CELL_STATUS_KEY } from "@ng/protocol";
import { startProjectSync, type ProjectTaskInput } from "../src";
import { boot, childrenOf, cleanupAll, continuesRun, gitRepo, lastToolResult, requestText, tool } from "./helpers";

afterEach(cleanupAll);

describe("a project's books are kept before its model runs", () => {
  it("first run: the record and the planned actions from the seed — once, even when the run is retried", async () => {
    const h = await boot();
    const repo = gitRepo("site");
    h.script.add(
      "project",
      (req) => {
        // Already on the books when the model first looks.
        expect(h.project(req.metadata!.cellId!)).toMatchObject({ title: "官网改版", lifecycle: "active" });
        return { error: new Error("model unavailable") };
      },
      (req) => {
        expect(requestText(req)).toContain("## 分阶段");
        expect(requestText(req)).toContain("1. 盘点现有页面");
        return {};
      },
    );
    const { projectId, started } = startProjectSync(h.kernel, {
      id: "proj_site",
      title: "官网改版",
      outcome: "新版官网上线",
      brief: "官网该改版了",
      cwd: repo,
      phases: ["盘点现有页面", "改版上线"],
      plan: [
        { title: "拉一份现有页面清单", owner: "agent", phase: 1 },
        { title: "和市场部对齐风格", owner: "human", nextStep: "约市场部 15 分钟" },
        { title: "等设计稿", owner: "waiting" },
      ],
      source: { label: "工作台收件箱", at: h.clock.now() },
    }, { principalId: h.kernel.ownerPrincipal });
    expect({ projectId, started }).toEqual({ projectId: "proj_site", started: true });
    expect(startProjectSync(h.kernel, { id: "proj_site", title: "官网改版", outcome: "x", brief: "x" }, { principalId: h.kernel.ownerPrincipal })).toEqual({ projectId: "proj_site", started: false });
    const task = h.kernel.inbox.listMessagesSync({ cellId: "proj_site" })[0]!.envelope.payload as { input: ProjectTaskInput };
    expect(h.kernel.getCell(projectId)?.spec.cwd).toBe(repo);
    expect(task.input).toMatchObject({ mode: "now", phases: ["盘点现有页面", "改版上线"], project: { title: "官网改版", proposal: { actions: expect.any(Array) } } });
    await h.kernel.idle();
    h.clock.advance(2_000); // the failed run is retried after its backoff
    await h.kernel.idle();

    expect(h.script.callsOf("project")).toHaveLength(2);
    expect(h.project("proj_site")).toMatchObject({ title: "官网改版", outcome: "新版官网上线", lifecycle: "active", source: { label: "工作台收件箱" }, proposal: { title: "官网改版" } });
    expect(h.kernel.getCell("proj_site")?.spec.cwd).toBe(repo);
    expect(h.state(projectId, CELL_STATUS_KEY)).toMatchObject({ text: "目标：新版官网上线" });
    const acts = h.actions(projectId);
    expect(acts.map((a) => [a.title, a.owner, a.status, a.nextStep ?? null, a.phase ?? null, a.projectCellId])).toEqual(
      expect.arrayContaining([
        ["和市场部对齐风格", "human", "open", "约市场部 15 分钟", null, projectId],
        ["拉一份现有页面清单", "agent", "open", null, 1, projectId],
        ["等设计稿", "waiting", "open", null, null, projectId],
      ]),
    );
    expect(acts).toHaveLength(3);
    const human = acts.find(a => a.owner === "human")!;
    expect(h.kernel.humanItems.get(human.id)).toMatchObject({ category: "action", relatedProjectIds: [projectId] });
    expect(h.kernel.context.readStateSync(projectId, gtdKeys.action(human.id))).toBeNull();
    expect(h.project(projectId)?.proposal?.actions).toContainEqual(expect.objectContaining({title:"和市场部对齐风格",owner:"human"}));
    expect(acts.find((a) => a.owner === "waiting")?.waiting).toMatchObject({ description: "等设计稿", parties: [] });
  });

  it("a child's result closes the action it carried; a failed turn leaves it open with its worker, which rests and can be told what to change; a plain spawn_cell child is put on the books", async () => {
    const h = await boot();
    h.script.add(
      "project",
      {
        toolCalls: [
          { name: "dispatch", input: { title: "写方案", instruction: "写方案" } },
          { name: "dispatch", input: { title: "跑基准", instruction: "跑基准" } },
          { name: "spawn_cell", input: { preset: "worker", title: "顺手查一下日志", instruction: "查日志" } },
          { name: "spawn_cell", input: { preset: "checker", title: "盯一下 CI", instruction: "CI 绿了告诉我" } },
        ],
      },
      {},
    );
    h.script.setDefault("worker", (req) => {
      if (continuesRun(req)) return {};
      const title = h.kernel.getCell(req.metadata!.cellId!)!.title;
      if (title === "写方案") return tool("report_to_parent", { kind: "result", text: "方案已写好", artifactId: "art_plan" });
      if (title === "跑基准") return tool("report_to_parent", { kind: "result", text: "机器上没有基准数据", status: "failed" });
      return tool("wait", { reason: "还在查", waitingFor: "inbox:desk" });
    });
    h.script.setDefault("checker", (req) => (continuesRun(req) ? {} : tool("wait", { reason: "CI 还没跑完", waitingFor: "external" })));
    const { projectId } = startProjectSync(h.kernel, { title: "性能优化", outcome: "p99 降一半", brief: "做性能优化" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    // Its next wake-up: the books have caught up with the children it started without dispatch.
    h.kernel.sendToCell(projectId, { text: "进展如何？" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();

    const byTitle = Object.fromEntries(h.actions(projectId).map((a) => [a.title, a]));
    const cellOf = (title: string) => childrenOf(h, projectId).find((id) => h.kernel.getCell(id)!.title === title)!;
    expect(byTitle["写方案"]).toMatchObject({ status: "done", owner: "agent", artifactId: "art_plan", cellId: cellOf("写方案") });
    // The worker whose turn failed is still there (dormant, with what it learned): the action stays with it.
    expect(byTitle["跑基准"]).toMatchObject({ status: "open", owner: "agent", cellId: cellOf("跑基准") });
    expect(h.kernel.activityOf([cellOf("跑基准")]).get(cellOf("跑基准"))!.state).toBe("dormant");
    expect(byTitle["顺手查一下日志"]).toMatchObject({ status: "open", owner: "agent", cellId: cellOf("顺手查一下日志"), projectCellId: projectId });
    expect(byTitle["盯一下 CI"]).toMatchObject({ status: "open", owner: "waiting", cellId: cellOf("盯一下 CI") });
    expect(h.actions(projectId)).toHaveLength(4);
  });

  it("reopens: a follow-up that beat the close, and a parked project that is resumed", async () => {
    const h = await boot();
    let projectId = "";
    h.script.add(
      "project",
      () => {
        // The owner's follow-up lands while the project is finishing: it must not close over it.
        expect(h.kernel.sendToCell(projectId, { text: "等等，再补一个导出功能" }, { principalId: h.kernel.ownerPrincipal })).toMatchObject({ status: "delivered" });
        return tool("finish_project", { outcome: "completed", summary: "都做完了", retro: "none" });
      },
      (req) => {
        expect(requestText(req)).toContain("再补一个导出功能");
        expect(h.project(projectId)).toMatchObject({ lifecycle: "active" });
        expect(h.project(projectId)!.completedAt).toBeUndefined();
        return tool("finish_project", { outcome: "someday", summary: "导出功能以后再做", retro: "none" });
      },
      (req) => {
        expect(requestText(req)).toContain("现在做导出");
        expect(h.project(projectId)).toMatchObject({ lifecycle: "active" });
        return {};
      },
    );
    projectId = startProjectSync(h.kernel, { title: "报表", outcome: "报表上线", brief: "做报表" }, { principalId: h.kernel.ownerPrincipal }).projectId;
    await h.kernel.idle();
    expect(h.kernel.getCell(projectId)?.status).toBe("paused");
    expect(h.kernel.getCell(projectId)).toMatchObject({status:"paused",pauseReason:"parked"});

    expect(h.kernel.sendToCell(projectId, { text: "现在做导出" }, { principalId: h.kernel.ownerPrincipal })).toMatchObject({ status: "delivered", targetStatus: "paused" });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(1); // parked: the message waits
    h.kernel.control(projectId, { action: "resume" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(h.state<ProjectRecord>(projectId, gtdKeys.project)).toMatchObject({ lifecycle: "active" });
    void lastToolResult;
  });
});

it("tracks a worker spawned during the same project turn", async () => {
  const h = await boot();
  h.script.add("project", tool("spawn_cell", {preset:"worker", title:"查日志", instruction:"查日志"}), () => {
    const [worker] = childrenOf(h, "project", "worker");
    return tool("track_action", {title:"记录排查", owner:"agent", cellId:worker!});
  }, {});
  startProjectSync(h.kernel, {id:"project", title:"排查", outcome:"确认原因", brief:"核对日志"}, { principalId: h.kernel.ownerPrincipal });
  await h.kernel.idle();
  const [worker] = childrenOf(h, "project", "worker");
  expect(h.actions("project")).toContainEqual(expect.objectContaining({title:"记录排查", cellId:worker!}));
  await h.kernel.closeCell(worker!, "completed", { principalId: h.kernel.ownerPrincipal });
  h.script.add("project", tool("track_action", {title:"过期派工", owner:"agent", cellId:worker!}), {});
  h.kernel.sendToCell("project", {text:"记录新动作"}, { principalId: h.kernel.ownerPrincipal });
  await h.kernel.idle();
  expect(h.actions("project").some(a => a.title === "过期派工")).toBe(false);
});
