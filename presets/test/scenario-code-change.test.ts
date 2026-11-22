import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, PAYLOAD, type ProjectRecord } from "@ng/protocol";
import { startProjectSync } from "../src";
import { boot, childrenOf, cleanupAll, gitRepo, lastToolResult, projects, requestText, systemOf, tool } from "./helpers";

afterEach(cleanupAll);

describe("docs/05 scenario 2 — a small code change, follow-ups in the same directory, a merge to wait for", () => {
  it("start → worker → follow-up via the desk goes to the same worker → checker + screencast → finish refused while a child is still at work → completed, preference visible to the next cell", async () => {
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
    // 2. The worker's turn is over and the project is told: the books already closed its action. The ball goes to the owner.
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
    expect(h.kernel.getCell(project!)).toMatchObject({ preset: "project", status: "active", spec: { cwd: repo, lifetime: "persistent" } });
    expect(h.project(project!)).toMatchObject({ title: "表格复制改为 Markdown 源码", lifecycle: "active", cwd: repo, summary: "代码已改好（分支 feat/md-copy），还没提 MR", source: { label: "随手记" } });
    // The worker is not closed: it rests, with everything it knows about the change.
    expect(h.kernel.getCell(writer1)).toMatchObject({ preset: "worker", status: "active", parentId: project, spec: { cwd: repo, lifetime: "wakeable" } });
    expect(h.kernel.activityOf([writer1]).get(writer1)!.state).toBe("dormant");
    expect(h.kernel.getCell(writer1)!.bounds).toMatchObject({ isolation: "none", maxDepth: 0 });
    expect(h.actions(project)).toEqual([
      expect.objectContaining({ title: "修改表格复制逻辑", owner: "agent", status: "done", cellId: writer1, projectCellId: project }),
      expect.objectContaining({ title: "看一下改动，决定下一步", owner: "human", status: "open", nextStep: "看一下分支 feat/md-copy 的改动，决定要不要提 MR" }),
    ]);
    expect(h.kernel.anchorsOf(project!)).toMatchObject({ human: true, stalled: false });
    expect(h.notices()).toContain("已立项：表格复制改为 Markdown 源码，后台开始推进");

    // 3. "继续用 /ship-mr 跟进": the desk passes it on. It is more work on what the worker just did, so the project sends
    // it to that worker — recorded as a new action carried by it — instead of starting another one from nothing.
    h.script.add("desk", tool("steer_item", { itemId: project, message: "继续用 /ship-mr 跟进" }), tool("wait", { reason: "passed on" }));
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("继续用 /ship-mr 跟进");
        const mine = h.actions(project).find((a) => a.owner === "human" && a.status === "open")!;
        return tool("track_action", { id: mine.id, status: "done" });
      },
      tool("track_action", { title: "用 /ship-mr 提 MR", owner: "agent", cellId: writer1 }),
      (req) => {
        expect(lastToolResult(req)).toMatch(/Recorded action \S+「用 \/ship-mr 提 MR」: agent, open\.$/);
        return tool("send_message", { to: `inbox:${writer1}`, summary: "提 MR", text: "用 /ship-mr 推分支并建 MR，报告 MR 链接。" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain(`Delivered to ${writer1}.`);
        return {};
      },
    );
    h.script.add("worker", (req) => {
      // The same cell, woken on its own record: its first turn is in front of it.
      expect(req.metadata!.cellId).toBe(writer1);
      expect(requestText(req)).toContain("已改好：分支 feat/md-copy");
      expect(requestText(req)).toContain("用 /ship-mr 推分支并建 MR");
      return tool("report_to_parent", { kind: "result", text: "MR 已创建：https://git.example.com/tui/-/merge_requests/12" });
    });
    // 4. The MR exists and the owner also wants a screencast: a checker for the merge and a third writer, side by side.
    let checker = "";
    let screencast = "";
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("merge_requests/12");
        // The books closed the follow-up's action when the worker's second turn ended well.
        expect(h.actions(project).find((a) => a.title === "用 /ship-mr 提 MR")).toMatchObject({ status: "done", cellId: writer1 });
        return {
          toolCalls: [
            { name: "dispatch", input: { preset: "checker", title: "等 MR !12 合入", instruction: "检查 MR !12 是否已合入：先看当前状态，未合入则每 10 分钟再看；合入后报告合入时间。" } },
            { name: "dispatch", input: { title: "补录屏", instruction: "现场：分支 feat/md-copy。录一段复制表格的演示，附到 MR !12。" } },
          ],
        };
      },
      {},
    );
    h.script.add("checker", (req) => {
      checker = req.metadata!.cellId!;
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
    // so the kernel refuses to settle and nothing is recorded (open actions alone would not stop it, and neither does
    // the first worker, which only rests).
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("已于 10:32 合入");
        return tool("finish_project", { outcome: "completed", summary: "已合入", retro: "none" });
      },
      (req) => {
        const out = lastToolResult(req);
        expect(out).toContain(`Nothing was recorded or closed: 1 child cell(s) are still at work (${screencast} "补录屏": `);
        expect(out).toContain("before you finish");
        expect(out).toContain("Call again with closeChildren: true if stopping them is what you mean.");
        expect(h.project(project!)).toMatchObject({ lifecycle: "active", summary: "代码已改好（分支 feat/md-copy），还没提 MR" });
        return {};
      },
    );
    await h.ui.capture({ text: "继续用 /ship-mr 跟进，另外补个录屏" });
    await h.kernel.idle();

    // One worker did both the change and the MR, in two turns.
    expect(h.of("run.started").filter((e) => e.cellId === writer1)).toHaveLength(2);
    expect(h.kernel.activityOf([writer1]).get(writer1)!.state).toBe("dormant");
    // The checker reported once and was closed; it looked from the project's directory.
    expect(h.kernel.getCell(checker)).toMatchObject({ preset: "checker", status: "closed", spec: { cwd: repo, lifetime: "one_shot" } });
    expect(h.kernel.getCell(screencast)).toMatchObject({ status: "active", spec: { cwd: repo } });
    expect(h.project(project!)).toMatchObject({ lifecycle: "active" });
    const byTitle = Object.fromEntries(h.actions(project).map((a) => [a.title, a]));
    expect(byTitle["等 MR !12 合入"]).toMatchObject({ owner: "waiting", status: "done", cellId: checker });
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

    expect(h.kernel.getCell(project!)).toMatchObject({ status: "closed", closeReason: "completed" });
    // The resting workers are archived with it — completed, not cancelled.
    expect(h.kernel.getCell(screencast)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.kernel.getCell(writer1)).toMatchObject({ status: "closed", closeReason: "completed" });
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
    expect(childrenOf(h, project!)).toEqual([writer1, checker, screencast]);
  });
});
