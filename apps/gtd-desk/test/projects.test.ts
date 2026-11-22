// docs/05 §3.1 — the project lifecycle as Radar drives it: a project is one persistent cell; parking it is a pause,
// bringing it back resumes the same cell with its records, reports and history; closing never touches a directory;
// a parked item from before docs/05 (its cell closed) is migrated, never rebuilt from a deleted record.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY, startProjectSync } from "@ng/presets";
import { gtdKeys, type ActionRecord, type ProjectRecord } from "@ng/protocol";
import type { ProjectMutationResponse, RadarDTO, SourcesDTO } from "../src/shared/api";
import { bootRealDesk, cellMessages, cleanupAll, requestsOf, tempDir, tool, writeAction, type TestDesk } from "./helpers";

afterEach(cleanupAll);

const texts = (d: TestDesk, cellId: string) => cellMessages(d.kernel, cellId).map((e) => (e.payload as { text: string }).text);
const record = (d: TestDesk, id: string) => d.kernel.context.readStateSync<ProjectRecord>(id, gtdKeys.project)!;

describe("someday and back", () => {
  it("someday → activate keeps the same cell, its report and its history; the project continues from them", async () => {
    const d = await bootRealDesk();
    // Its first run: a report, then it waits for the owner.
    d.script.add(
      "project",
      tool("save_artifact", { artifactId: "art_minimal", title: "极简模式调研报告", body: "## 结论\n先做极简档" }),
      tool("track_action", { title: "看一眼报告", owner: "human", nextStep: "读调研报告，决定要不要做" }),
    );
    const { projectId } = startProjectSync(d.kernel, { title: "极简模式", outcome: "一份调研报告", brief: "先调研其他产品的做法" });
    await d.kernel.idle();
    expect(d.kernel.context.getArtifactSync("art_minimal")).toMatchObject({ version: 1, cellId: projectId });
    const firstRun = requestsOf(d.script, projectId);
    expect(firstRun.length).toBeGreaterThan(0);

    const epoch = d.kernel.getCell(projectId)!.epoch;
    const s = await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/someday`);
    expect(s).toMatchObject({ ok: true, outcome: "someday" });
    expect(s.view.someday.map((p) => p.id)).toEqual([projectId]);
    expect(d.kernel.getCell(projectId)!.status).toBe("paused");
    expect(record(d, projectId).lifecycle).toBe("someday");
    // its open action stays on its books (parked, not cancelled)
    expect(d.kernel.context.listStateSync(projectId, gtdKeys.actionPrefix).map((e) => (e.value as ActionRecord).status)).toEqual(["open"]);
    expect(d.kernel.context.getArtifactSync("art_minimal")).not.toBeNull();

    d.script.add("project", tool("update_project", { summary: "按报告开始做第一阶段" }));
    const a = await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/activate`);
    expect(a).toMatchObject({ ok: true, outcome: "activated" });
    expect(a.projectId).toBeUndefined();
    expect(a.view.projects.map((p) => p.id)).toEqual([projectId]);
    expect(d.kernel.getCell(projectId)).toMatchObject({ status: "active", epoch });
    expect(d.kernel.listCells({ parentId: "desk" }).filter((c) => c.spec.meta?.["role"] === "project").map((c) => c.id)).toEqual([projectId]);
    expect(texts(d, projectId)).toEqual([expect.stringContaining("主人点了启动：「极简模式」")]);
    await d.kernel.idle();
    // Same conversation: the report it saved before is in the history the activated run sees, with the go-ahead.
    const run = requestsOf(d.script, projectId).at(-1)!;
    expect(run).toContain("art_minimal");
    expect(run).toContain("主人点了启动");
    expect(record(d, projectId)).toMatchObject({ lifecycle: "active", summary: "按报告开始做第一阶段" });
    expect(d.kernel.context.getArtifactSync("art_minimal")).toMatchObject({ version: 1, content: { body: "## 结论\n先做极简档" } });
  });

  it("a parked item from before docs/05 (its cell closed) is migrated: a new project gets its plan and names its reports; the old record ends, it is not deleted", async () => {
    const d = await bootRealDesk();
    // Pre-docs/05 data: a closed holder cell with a report and a someday record (written after the close, as the old
    // app did — today's kernel would settle a record it finds on close).
    d.kernel.spawnCell("desk", { id: "proj_legacy", preset: "worker", title: "报表导出性能优化", meta: { projectCellId: "proj_legacy" } });
    d.kernel.context.commitSync("proj_legacy", { artifact: { artifactId: "art_legacy", content: { format: "markdown", title: "慢查询分析", body: "瓶颈在一次性加载全部明细" }, updatedBy: "agent" } });
    await d.kernel.closeCell("proj_legacy", "cancelled");
    const t = d.clock.now();
    const proposal = { title: "报表导出性能优化", outcome: "1 万行导出 10 秒内完成", actions: [{ title: "分析导出慢查询", owner: "agent" as const }, { title: "和王敏确认上限", owner: "human" as const }] };
    d.kernel.context.commitSync("proj_legacy", { statePatches: { [gtdKeys.project]: { title: proposal.title, outcome: proposal.outcome, lifecycle: "someday", proposal, createdAt: t, updatedAt: t } satisfies ProjectRecord } });
    let radar = await d.get<RadarDTO>("/api/radar");
    expect(radar.someday.map((p) => p.id)).toEqual(["proj_legacy"]);

    const a = await d.post<ProjectMutationResponse>("/api/projects/proj_legacy/activate");
    expect(a).toMatchObject({ ok: true, outcome: "migrated", projectId: expect.stringMatching(/^proj_/) });
    const next = a.projectId!;
    expect(next).not.toBe("proj_legacy");
    expect(d.kernel.getCell(next)).toMatchObject({ preset: "project", status: "active", parentId: "desk" });
    // the old record says where it went; it is still there
    expect(record(d, "proj_legacy")).toMatchObject({ lifecycle: "cancelled", migratedTo: next, proposal: { title: "报表导出性能优化" } });
    radar = a.view;
    expect(radar.someday).toEqual([]);
    await d.kernel.idle();
    expect(record(d, next)).toMatchObject({ lifecycle: "active", title: "报表导出性能优化", outcome: "1 万行导出 10 秒内完成", proposal: { actions: [{}, {}] } });
    // its brief names the old plan and the report by id, to be read instead of redone
    const brief = requestsOf(d.script, next)[0]!;
    expect(brief).toContain("art_legacy");
    expect(brief).toContain("慢查询分析");
    expect(brief).toContain("和王敏确认上限");
    expect((await d.get<RadarDTO>("/api/radar")).projects.map((p) => p.id)).toEqual([next]);
  });
});

describe("someday from before docs/05: the old item root", () => {
  it("a parked item root of the old zero-token coordinator is not resumed (it would only wind itself down): it is closed and migrated with its workers' reports", async () => {
    const d = await bootRealDesk();
    d.kernel.spawnCell("desk", { id: "proj_old", title: "竞品权限模型", processor: { kind: "code", entry: LEGACY.joinAll }, meta: { projectCellId: "proj_old" } });
    d.kernel.spawnCell("proj_old", { id: "slot_a", preset: "worker", title: "账无忧" });
    d.kernel.context.commitSync("slot_a", { artifact: { artifactId: "art_slot_a", content: { format: "markdown", title: "账无忧的权限模型", body: "角色 + 数据范围" }, updatedBy: "agent" } });
    d.kernel.control("proj_old", { action: "pause" });
    const t = d.clock.now();
    d.kernel.context.commitSync("proj_old", { statePatches: { [gtdKeys.project]: { title: "竞品权限模型", outcome: "对比 6 家", lifecycle: "someday", createdAt: t, updatedAt: t } satisfies ProjectRecord } });
    const a = await d.post<ProjectMutationResponse>("/api/projects/proj_old/activate");
    expect(a).toMatchObject({ ok: true, outcome: "migrated" });
    await d.kernel.idle();
    expect(d.kernel.getCell("proj_old")!.status).toBe("closed");
    expect(record(d, "proj_old")).toMatchObject({ lifecycle: "cancelled", migratedTo: a.projectId });
    expect(d.kernel.context.getArtifactSync("art_slot_a")).not.toBeNull();
    expect(requestsOf(d.script, a.projectId!)[0]).toContain("art_slot_a");
    // the old root never ran: nobody was woken just to wind it down
    expect(d.script.requests.filter((r) => r.cellId === "proj_old")).toEqual([]);
  });
});

describe("closing and the directory", () => {
  it("cancel closes the project's cells and the kernel settles its records; its working directory and files are left as they are", async () => {
    const d = await bootRealDesk();
    const repo = tempDir("repo");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    d.script.add("project", tool("dispatch", { title: "改 a.ts", instruction: "把 a 改成 2" }));
    d.script.add("worker", tool("wait", { reason: "等 CI" }));
    const { projectId } = startProjectSync(d.kernel, { title: "改 a", outcome: "a = 2", brief: "改 a", cwd: repo });
    await d.kernel.idle();
    const human = writeAction(d.kernel, projectId, { title: "看改动", owner: "human", nextStep: "看一眼" });
    const worker = d.kernel.listCells({ parentId: projectId })[0]!;
    expect(worker.spec.cwd ?? d.kernel.getCell(projectId)!.spec.cwd).toBe(repo);

    const r = await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/cancel`);
    expect(r).toMatchObject({ ok: true, outcome: "cancelled" });
    await d.kernel.idle();
    expect([projectId, worker.id].map((id) => d.kernel.getCell(id)!.status)).toEqual(["closed", "closed"]);
    expect(record(d, projectId).lifecycle).toBe("cancelled");
    expect(d.kernel.context.readStateSync<ActionRecord>(projectId, gtdKeys.action(human.id))!.status).toBe("cancelled");
    expect(existsSync(repo)).toBe(true);
    expect(readFileSync(join(repo, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    // a finished project cannot be cancelled again
    expect((await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/cancel`)).outcome).toBe("not_applied");
  });
});

describe("hubs are sources", () => {
  it("a hub is listed in the sources drawer through its source record, never as a project", async () => {
    const d = await bootRealDesk();
    d.script.add(
      "desk",
      tool("add_hub", {
        title: "代码评审直通",
        repos: [{ name: "backend", cwd: "/srv/code/backend" }],
        rules: "评审群里 @我 的 MR 派只读 worker 评审",
        watch: { thread: "memory:review" },
      }),
    );
    await d.post("/api/capture", { text: "评审群 @我 的 MR 以后直接派人看" });
    await d.kernel.idle();
    const hub = d.kernel.listCells({ parentId: "desk" }).find((c) => c.spec.meta?.["role"] === "hub")!;
    expect(hub).toBeDefined();
    const sources = await d.get<SourcesDTO>("/api/sources");
    expect(sources.sensors.map((s) => [s.id, s.title, s.kind])).toEqual([[hub.id, "代码评审直通", "watch"]]);
    const radar = await d.get<RadarDTO>("/api/radar");
    expect([...radar.projects, ...radar.someday]).toEqual([]);
  });
});
