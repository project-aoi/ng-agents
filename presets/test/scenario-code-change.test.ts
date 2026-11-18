import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, PAYLOAD, type ProjectRecord } from "@ng/protocol";
import { startProjectSync } from "../src";
import { boot, childrenOf, cleanupAll, gitRepo, lastToolResult, projects, requestText, systemOf, tool } from "./helpers";

afterEach(cleanupAll);

describe("docs/05 scenario 2 — a small code change, follow-ups in the same directory, a merge to wait for", () => {
  it("start → writer → follow-up via the desk → second writer → watcher + screencast → finish refused while a child cell is still open → completed, preference visible to the next cell", async () => {
    const h = await boot();
    const repo = gitRepo("tui");

    // 1. The owner's /todo, with the path already given: the desk starts a project in that repository.
    h.script.add(
      "desk",
      tool("start_project", {
        title: "表格复制改为 Markdown 源码",
        outcome: "在 TUI 里复制 Markdown 表格时得到 Markdown 源码",
        brief: "修改 markdown 表格复制的行为：复制出 Markdown 源码格式，而不是 Unicode 制表符。",
        cwd: repo,
      }),
      tool("wait", { reason: "started" }),
    );
    let writer1 = "";
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("复制出 Markdown 源码格式");
        expect(requestText(req)).toContain(repo);
        return tool("dispatch", { title: "修改表格复制逻辑", instruction: `在 ${repo} 修改表格复制逻辑，提交到新分支 feat/md-copy，跑测试，报告分支与验证结果。` });
      },
      (req) => {
        expect(lastToolResult(req)).toContain("Started worker");
        return {};
      },
    );
    h.script.add("worker", (req) => {
      writer1 = req.metadata!.cellId!;
      expect(requestText(req)).toContain("feat/md-copy");
      return tool("report_to_parent", { kind: "result", text: "已改好：分支 feat/md-copy，提交 a1b2c3；单测通过。未创建 MR。" });
    });
    // 2. The worker's result wakes the project: the books already closed its action. The ball goes to the owner.
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("分支 feat/md-copy");
        return tool("update_project", { summary: "代码已改好（分支 feat/md-copy），还没提 MR" });
      },
      tool("track_action", { title: "看一下改动，决定下一步", owner: "human", nextStep: "看一下分支 feat/md-copy 的改动，决定要不要提 MR" }),
      tool("wait", { reason: "等主人看改动", waitingFor: "human" }),
    );
    await h.ui.capture({ text: `/todo 修改markdown表格复制的时候复制markdown格式而不是Unicode字符，代码在 ${repo}` });
    await h.kernel.idle();

    const [project] = projects(h);
    expect(h.kernel.getCell(project!)).toMatchObject({ preset: "project", status: "active", spec: { cwd: repo, cwdMode: "read", lifetime: "persistent" } });
    expect(h.project(project!)).toMatchObject({ title: "表格复制改为 Markdown 源码", lifecycle: "active", cwd: repo, summary: "代码已改好（分支 feat/md-copy），还没提 MR", source: { label: "随手记" } });
    expect(h.kernel.getCell(writer1)).toMatchObject({ preset: "worker", status: "closed", parentId: project, spec: { cwd: repo, cwdMode: "write", lifetime: "one_shot" } });
    expect(h.kernel.getCell(writer1)!.bounds.isolation).toBe("none");
    expect(h.actions(project)).toEqual([
      expect.objectContaining({ title: "修改表格复制逻辑", owner: "agent", status: "done", cellId: writer1, projectCellId: project }),
      expect.objectContaining({ title: "看一下改动，决定下一步", owner: "human", status: "open", nextStep: "看一下分支 feat/md-copy 的改动，决定要不要提 MR" }),
    ]);
    expect(h.kernel.anchorsOf(project!)).toMatchObject({ human: true, stalled: false });
    expect(h.notices()).toContain("已立项：表格复制改为 Markdown 源码，后台开始推进");

    // 3. "继续用 /ship-mr 跟进": the desk passes it on; the project dispatches a second writer into the same directory.
    let writer2 = "";
    h.script.add("desk", tool("steer_item", { itemId: project, message: "继续用 /ship-mr 跟进" }), tool("wait", { reason: "passed on" }));
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("继续用 /ship-mr 跟进");
        const mine = h.actions(project).find((a) => a.owner === "human" && a.status === "open")!;
        return tool("track_action", { id: mine.id, status: "done" });
      },
      tool("dispatch", { title: "用 /ship-mr 提 MR", instruction: "现场：分支 feat/md-copy，改动已提交。用 /ship-mr 推分支并建 MR，报告 MR 链接。" }),
      {},
    );
    h.script.add("worker", (req) => {
      writer2 = req.metadata!.cellId!;
      return tool("report_to_parent", { kind: "result", text: "MR 已创建：https://git.example.com/tui/-/merge_requests/12" });
    });
    // 4. The MR exists and the owner also wants a screencast: a watcher for the merge and a third writer, side by side.
    let watcher = "";
    let screencast = "";
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("merge_requests/12");
        return {
          toolCalls: [
            { name: "dispatch", input: { preset: "watcher", title: "等 MR !12 合入", instruction: "检查 MR !12 是否已合入：先看当前状态，未合入则每 10 分钟再看；合入后报告合入时间。" } },
            { name: "dispatch", input: { title: "补录屏", instruction: "现场：分支 feat/md-copy。录一段复制表格的演示，附到 MR !12。" } },
          ],
        };
      },
      {},
    );
    h.script.add("checker", (req) => {
      watcher = req.metadata!.cellId!;
      return tool("report_to_parent", { kind: "result", text: "MR !12 已于 10:32 合入 main。" });
    });
    h.script.add(
      "worker",
      (req) => {
        screencast = req.metadata!.cellId!;
        return tool("job_start", { command: "sleep 0.3; echo recorded" });
      },
      {},
    );
    // The merge is reported while the screencast is still recording: closing would take the recording child with it,
    // so the kernel refuses to settle and nothing is recorded (open actions alone would not stop it).
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("已于 10:32 合入");
        return tool("finish_project", { outcome: "completed", summary: "已合入", retro: "none" });
      },
      (req) => {
        const out = lastToolResult(req);
        expect(out).toContain(`Nothing was recorded or closed: 1 child cell(s) are still open (${screencast} "补录屏").`);
        expect(out).toContain("before you finish");
        expect(out).toContain("Call again with closeChildren: true if stopping them is what you mean.");
        expect(h.project(project!)).toMatchObject({ lifecycle: "active", summary: "代码已改好（分支 feat/md-copy），还没提 MR" });
        return {};
      },
    );
    await h.ui.capture({ text: "继续用 /ship-mr 跟进，另外补个录屏" });
    await h.kernel.idle();

    expect(h.kernel.getCell(writer2)).toMatchObject({ status: "closed", spec: { cwd: repo, cwdMode: "write" } });
    expect(h.kernel.getCell(watcher)).toMatchObject({ preset: "watcher", status: "closed", spec: { cwdMode: "write", lifetime: "one_shot" } });
    expect(h.kernel.getCell(watcher)!.spec.cwd).toBeUndefined(); // a watcher keeps to its own directory
    expect(h.kernel.getCell(screencast)).toMatchObject({ status: "active", spec: { cwd: repo } });
    expect(h.project(project!)).toMatchObject({ lifecycle: "active" });
    const byTitle = Object.fromEntries(h.actions(project).map((a) => [a.title, a]));
    expect(byTitle["等 MR !12 合入"]).toMatchObject({ owner: "waiting", status: "done", cellId: watcher });
    expect(byTitle["补录屏"]).toMatchObject({ owner: "agent", status: "open", cellId: screencast });

    // 5. The screencast reports: the project looks back, saves the habit, and finishes.
    h.script.add("worker", (req) => {
      expect(requestText(req)).toContain("recorded");
      return tool("report_to_parent", { kind: "result", text: "录屏已附到 MR !12。" });
    });
    h.script.add(
      "project",
      tool("save_note", { name: "code-change-followup", kind: "preference", scope: "global", body: "改完代码后直接用 /ship-mr 提 MR，并附一段验证录屏，不用再等主人说。" }),
      // finish_project ends the Run: nothing after it is asked of the model.
      tool("finish_project", { outcome: "completed", summary: "MR !12 已合入，录屏已附上。", retro: "保存了偏好 code-change-followup：改完代码直接 /ship-mr 并附录屏" }),
    );
    await h.kernel.idle({ jobs: true });
    await h.kernel.idle();

    expect(h.kernel.getCell(screencast)?.status).toBe("closed");
    expect(h.kernel.getCell(project!)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.project(project!)).toMatchObject({ lifecycle: "completed", completedAt: expect.any(Number), summary: "MR !12 已合入，录屏已附上。" });
    expect(h.state<ProjectRecord & { retro: string }>(project!, gtdKeys.project)?.retro).toContain("code-change-followup");
    expect(h.actions(project).every((a) => a.status === "done")).toBe(true);
    expect(h.notices()).toContain("「表格复制改为 Markdown 源码」已完成：MR !12 已合入，录屏已附上。");
    // The desk heard the final result (never swallowed) and noted the finished project.
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => m.envelope.payload)).toEqual([
      expect.objectContaining({ childCellId: project, status: "completed", summary: "MR !12 已合入，录屏已附上。" }),
    ]);
    expect(h.activities()).toContainEqual(expect.objectContaining({ kind: "action_completed", title: "已完成：表格复制改为 Markdown 源码" }));

    // 6. The habit reaches the next cell: a new project's system prompt carries it.
    const next = startProjectSync(h.kernel, { title: "另一个改动", outcome: "改完", brief: "再改一处", cwd: repo });
    await h.kernel.idle();
    expect(systemOf(h, next.projectId)).toContain("改完代码后直接用 /ship-mr 提 MR");
    expect(childrenOf(h, project!).length).toBe(4);
  });
});
