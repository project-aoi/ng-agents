import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, startProjectSync } from "@ng/presets";
import type { ProjectRecord } from "@ng/presets/records";
import type { AgentToolResult } from "../src/agent/routes";
import type { ProjectMutationResponse } from "../src/shared/api";
import { bootDesk, bootRealDesk, cellMessages, cleanupAll, makeProject, requestsOf, tempDir, tool, type TestDesk } from "./helpers";

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
    const { projectId } = startProjectSync(d.kernel, { title: "极简模式", outcome: "一份调研报告", brief: "先调研其他产品的做法" }, { principalId: d.kernel.ownerPrincipal });
    await d.kernel.idle();
    expect(d.kernel.context.getArtifactSync("art_minimal")).toMatchObject({ version: 1, cellId: projectId });
    const firstRun = requestsOf(d.script, projectId);
    expect(firstRun.length).toBeGreaterThan(0);

    const epoch = d.kernel.getCell(projectId)!.epoch;
    // The parking comes after its first run (the note on being resumed is shown to the first run that starts after it).
    d.clock.advance(1_000);
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
    // Audit 2026-11-23 rerun R01: the project is told who brought it back — the owner, in the workbench.
    expect(texts(d, projectId)).toEqual([expect.stringContaining("主人在工作台里把「极简模式」从以后再说里拿了出来")]);
    await d.kernel.idle();
    // Same conversation: the report it saved before is in the history the activated run sees, with the go-ahead.
    const run = requestsOf(d.script, projectId).at(-1)!;
    expect(run).toContain("art_minimal");
    expect(run).toContain("主人在工作台里把「极简模式」从以后再说里拿了出来");
    // …and, once, who parked and who resumed it, and when.
    expect(run).toContain("[back from a pause — the owner parked this cell for later at ");
    // Rerun round 1, uc04: the owner pressed "start" in the web view; the note says it was them.
    expect(run).toMatch(/The owner resumed it at [^,]+, /);
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
    const { projectId } = startProjectSync(d.kernel, { title: "改 a", outcome: "a = 2", brief: "改 a", cwd: repo }, { principalId: d.kernel.ownerPrincipal });
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

// Rerun round 1, uc04: the owner parked a project while its worker was mid-change; their repository was left on the
// feature branch with uncommitted changes, and nothing they were shown said so.
describe("stopping a project part-way says what is left in its work trees", () => {
  /** git with no user or system configuration (HOME is the repository itself), as the kernel's tests run it. */
  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" } });
  }

  /** A repository with one commit, on main. */
  function repo(prefix: string): string {
    const dir = tempDir(prefix);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "Test User");
    git(dir, "config", "user.email", "test@example.com");
    writeFileSync(join(dir, "README.md"), "hello\n");
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    return dir;
  }

  const owner = (d: TestDesk) => ({ principalId: d.kernel.ownerPrincipal });
  const LEFT = "。仓库留在原样：";

  it("someday names the branch and the number of uncommitted changes of the project's checkout", async () => {
    const d = await bootDesk();
    const dir = repo("export");
    git(dir, "checkout", "-q", "-b", "feat/export");
    writeFileSync(join(dir, "README.md"), "hello, export\n");
    writeFileSync(join(dir, "app.ts"), "export const a = 2;\n");
    const p = makeProject(d.kernel, "导出功能", { cwd: dir });

    const s = await d.post<ProjectMutationResponse>(`/api/projects/${p}/someday`);
    expect(s).toMatchObject({ ok: true, outcome: "someday" });
    expect(s.message).toBe(`「导出功能」已移进以后再说，后台任务已暂停，记录和报告都留着${LEFT}${dir} 现在停在分支 feat/export，有 2 处未提交的改动`);
    // Nothing was touched: the branch and the changes are where they were.
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  it("pause names every checkout the project and its live workers are in, not a closed worker's; the control plane hears the same", async () => {
    const d = await bootDesk();
    const main = repo("main");
    const side = repo("side");
    git(side, "checkout", "-q", "-b", "fix/retry");
    const gone = repo("gone");
    writeFileSync(join(gone, "README.md"), "left behind\n");
    const p = makeProject(d.kernel, "支付重试", { cwd: main });
    d.kernel.spawnCell(p, { id: "w1", preset: "worker", title: "改重试", lifetime: "wakeable", cwd: side, meta: { role: "w1" } }, undefined, owner(d));
    d.kernel.spawnCell(p, { id: "w2", preset: "worker", title: "旧分身", lifetime: "wakeable", cwd: gone, meta: { role: "w2" } }, undefined, owner(d));
    await d.kernel.closeCell("w2", "completed", owner(d));

    const workTrees = [`${main} 现在停在分支 main，没有未提交的改动`, `${side} 现在停在分支 fix/retry，没有未提交的改动`];
    const expected = `已暂停「支付重试」${LEFT}${workTrees.join("；")}`;
    const web = await d.post<ProjectMutationResponse>(`/api/projects/${p}/pause`);
    expect(web).toMatchObject({ ok: true, outcome: "paused", workTrees });
    expect(web.message).toBe(expected);

    await d.post(`/api/projects/${p}/resume`);
    const r = await d.req<AgentToolResult>("POST", "/api/agent/tools/set_project_state", { id: p, state: "pause", note: "等周一" });
    expect(r.json).toMatchObject({ text: expected, data: { workTrees } });
    expect(r.json.isError).toBeFalsy();
  });

  it("a directory that is no git work tree, or no directory at all, adds nothing", async () => {
    const d = await bootDesk();
    const plain = makeProject(d.kernel, "普通目录", { cwd: tempDir("plain") });
    const none = makeProject(d.kernel, "没有目录");
    expect((await d.post<ProjectMutationResponse>(`/api/projects/${plain}/pause`)).message).toBe("已暂停「普通目录」");
    expect((await d.post<ProjectMutationResponse>(`/api/projects/${none}/pause`)).message).toBe("已暂停「没有目录」");
  });
});
