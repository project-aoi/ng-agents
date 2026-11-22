import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startProjectSync } from "@ng/presets";
import { gtdKeys, type ProjectRecord } from "@ng/protocol";
import type { ProjectMutationResponse, RadarDTO, SourcesDTO } from "../src/shared/api";
import { bootRealDesk, cellMessages, cleanupAll, requestsOf, tempDir, tool, type TestDesk } from "./helpers";

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
    expect(d.kernel.getCell(projectId)?.pauseReason).toBe("parked");
    // its open action stays on its books (parked, not cancelled)
    expect(d.kernel.humanItems.list().filter(item => item.cellId === projectId)).toMatchObject([{title: "看一眼报告", status: "pending"}]);
    expect(d.kernel.context.getArtifactSync("art_minimal")).not.toBeNull();

    d.script.add("project", tool("update_project", { summary: "按报告开始做第一阶段" }));
    const a = await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/activate`);
    expect(a).toMatchObject({ ok: true, outcome: "activated" });

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
    const human = d.kernel.humanItems.create({ title: "看改动", subjectKey: "project-review", category: "action", options: [{ id: "done", label: "看过了", effect: "reply" }] }, projectId);
    const worker = d.kernel.listCells({ parentId: projectId })[0]!;
    expect(worker.spec.cwd ?? d.kernel.getCell(projectId)!.spec.cwd).toBe(repo);

    const r = await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/cancel`);
    expect(r).toMatchObject({ ok: true, outcome: "cancelled" });
    await d.kernel.idle();
    expect([projectId, worker.id].map((id) => d.kernel.getCell(id)!.status)).toEqual(["closed", "closed"]);
    expect(record(d, projectId).lifecycle).toBe("cancelled");
    expect(d.kernel.humanItems.get(human.id)?.status).toBe("cancelled");
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
