import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD, pullCursorKey, type CellResultPayload } from "@ng/protocol";
import { startProjectSync } from "../src";
import { boot, childrenOf, cleanupAll, gitRepo, lastToolResult, MIN, requestText, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

// docs/05-proposals 02 + 03: a worker rests when its turn is over and can be woken again; the project is told every
// time a turn settles and pulls what happened (inspect_cell); a resting worker does not keep the project open.

const notices = (h: Harness, project: string) =>
  h.kernel.inbox.listMessagesSync({ cellId: project, type: PAYLOAD.cellResult }).map((m) => ({ id: m.envelope.id, ...(m.envelope.payload as CellResultPayload) }));
const runsOf = (h: Harness, cellId: string) => h.of("run.started").filter((e) => e.cellId === cellId).length;

describe("the project and its resting workers", () => {
  it("the owner talks to a worker directly: the project wakes once, when the turn settles, pulls what happened with inspect_cell, and its books stay as they were", async () => {
    const h = await boot();
    const repo = gitRepo("pay");
    let worker = "";
    h.script.add(
      "project",
      tool("dispatch", { title: "实现退避重试", instruction: "实现指数退避重试，最多 5 次，提交到新分支 feat/retry，报告提交号。" }),
      (req) => {
        worker = /^Started worker (\S+)/.exec(lastToolResult(req))![1]!;
        return {};
      },
      (req) => {
        expect(requestText(req)).toContain("退避已实现，最大重试 5 次");
        return tool("save_note", { kind: "working_note", scope: "cell", name: "board", description: "项目白板", body: `- ${worker}（待命）：退避已实现，最大 5 次，提交 9f2c1` });
      },
      {},
    );
    h.script.add("worker", { text: "退避已实现，最大重试 5 次，提交 9f2c1" });
    const { projectId } = startProjectSync(h.kernel, { title: "支付重试", outcome: "支付回调失败自动重试", brief: "做支付重试", cwd: repo });
    await h.kernel.idle();
    expect(h.actions(projectId)).toEqual([expect.objectContaining({ title: "实现退避重试", status: "done", cellId: worker })]);
    const projectRuns = runsOf(h, projectId);

    // The owner opens the worker in the workbench and changes the requirement there.
    h.script.add("worker", (req) => {
      expect(requestText(req)).toContain("把最大重试次数从 5 改成 3");
      return { text: "改成 3 次了，单测 14/14 通过，提交 7aa01" };
    });
    let woken = "";
    let pulled = "";
    h.script.add(
      "project",
      (req) => {
        woken = requestText(req);
        return tool("inspect_cell", { cellId: worker });
      },
      (req) => {
        pulled = lastToolResult(req);
        return {
          toolCalls: [
            { name: "update_project", input: { summary: "退避重试已实现；主人把最大重试改成了 3 次" } },
            { name: "save_note", input: { kind: "working_note", scope: "cell", name: "board", description: "项目白板", body: `- ${worker}（待命，记录已看完）：退避已实现；主人直接让它把最大重试从 5 改成 3（提交 7aa01）` } },
          ],
        };
      },
      {},
    );
    expect(h.kernel.directMessage(worker, { text: "把最大重试次数从 5 改成 3" })).toMatchObject({ status: "delivered", ccTo: projectId });
    await h.kernel.idle();

    // One wake-up of the project, for the settled turn — the copy of the owner's words came with it, not before it.
    expect(runsOf(h, projectId)).toBe(projectRuns + 1);
    expect(woken).toContain("The owner said this directly to one of your cells");
    expect(woken).toContain("把最大重试次数从 5 改成 3");
    expect(woken).toContain("改成 3 次了，单测 14/14 通过，提交 7aa01");
    expect(woken).toMatch(/"hadDirectUserChat": true/);
    // What the worker was told and said, the owner's words marked.
    expect(pulled).toContain("the owner, directly (owner): 把最大重试次数从 5 改成 3");
    expect(pulled).toContain("said: 改成 3 次了");
    expect(h.state<number>(projectId, pullCursorKey(worker))).toBe(h.kernel.context.lastEvidenceSeqSync(worker));
    // The books: still the one action, still done — the second notice neither reopened nor duplicated it.
    expect(h.actions(projectId)).toEqual([expect.objectContaining({ title: "实现退避重试", status: "done", cellId: worker })]);
    expect(h.project(projectId)).toMatchObject({ summary: "退避重试已实现；主人把最大重试改成了 3 次", lifecycle: "active" });
    expect(notices(h, projectId).map((n) => [n.childState, n.turn?.hadDirectUserChat])).toEqual([
      ["dormant", false],
      ["dormant", true],
    ]);

    // Its next wake-up has the board in front of it, whatever happened to the conversation.
    let next = "";
    h.script.add("project", (req) => {
      next = requestText(req);
      return {};
    });
    h.kernel.sendToCell(projectId, { text: "进展如何？" });
    await h.kernel.idle();
    expect(next).toContain("主人直接让它把最大重试从 5 改成 3（提交 7aa01）");
  });

  it("a follow-up goes to the same worker with send_message: the same cell runs again, no second cell, and later notices neither reopen nor duplicate the action", async () => {
    const h = await boot();
    const repo = gitRepo("pay");
    let worker = "";
    let followUp = "";
    h.script.add(
      "project",
      tool("dispatch", { title: "实现退避重试", instruction: "实现指数退避重试，提交到新分支 feat/retry。" }),
      (req) => {
        worker = /^Started worker (\S+)/.exec(lastToolResult(req))![1]!;
        return {};
      },
      // Turn 1 is over: a small addition to the same change goes to the worker that wrote it.
      () => tool("send_message", { to: `inbox:${worker}`, summary: "补测试", text: "再补一个边界测试：重试次数为 0。" }),
      (req) => {
        expect(lastToolResult(req)).toContain(`Delivered to ${worker}.`);
        return {};
      },
      // Turn 2 is over: a larger follow-up, recorded as its own action carried by the same worker.
      () => tool("track_action", { title: "补并发测试", owner: "agent", cellId: worker }),
      (req) => {
        followUp = /Recorded action (\S+)「补并发测试」/.exec(lastToolResult(req))![1]!;
        return tool("send_message", { to: `inbox:${worker}`, summary: "补并发测试", text: "再补并发场景的测试。" });
      },
      {},
      {}, // turn 3 is over
    );
    h.script.add(
      "worker",
      { text: "已实现，提交 9f2c1" },
      (req) => {
        expect(requestText(req)).toContain("已实现，提交 9f2c1");
        expect(requestText(req)).toContain("重试次数为 0");
        return { text: "边界测试已补，提交 a0b1c" };
      },
      (req) => {
        expect(requestText(req)).toContain("再补并发场景的测试");
        return tool("report_to_parent", { kind: "result", text: "并发测试已补，提交 c3d4e" });
      },
    );
    const { projectId } = startProjectSync(h.kernel, { title: "支付重试", outcome: "支付回调失败自动重试", brief: "做支付重试", cwd: repo });
    await h.kernel.idle();

    expect(h.script.pending("project")).toBe(0);
    expect(h.script.pending("worker")).toBe(0);
    expect(childrenOf(h, projectId)).toEqual([worker]);
    expect(runsOf(h, worker)).toBe(3);
    const all = notices(h, projectId);
    expect(all.map((n) => n.summary)).toEqual(["已实现，提交 9f2c1", "边界测试已补，提交 a0b1c", "并发测试已补，提交 c3d4e"]);
    expect(new Set(all.map((n) => n.id)).size).toBe(3);
    // The dispatch action was closed by the first turn and stayed closed; the follow-up recorded with the worker as
    // its carrier was closed by the turn that did it. Nothing else was added.
    const acts = h.actions(projectId);
    expect(acts).toHaveLength(2);
    expect(acts.find((a) => a.title === "实现退避重试")).toMatchObject({ status: "done", cellId: worker });
    expect(acts.find((a) => a.id === followUp)).toMatchObject({ title: "补并发测试", status: "done", cellId: worker });
    expect(h.kernel.getCell(worker)!.status).toBe("active");
  });

  it("finish_project is refused while a watcher is still watching — not because of a resting worker — and succeeds once the watcher has reported", async () => {
    const h = await boot();
    const repo = gitRepo("pay");
    let worker = "";
    let watcher = "";
    h.script.add(
      "project",
      {
        toolCalls: [
          { name: "dispatch", input: { title: "实现退避重试", instruction: "实现退避重试并提交。" } },
          { name: "dispatch", input: { preset: "watcher", title: "等发布标记", instruction: "等仓库里出现 RELEASED 文件。", check: { command: "test -f RELEASED", everySec: 60 } } },
        ],
      },
      (req) => {
        const ids = [...lastToolResult(req).matchAll(/Started (?:worker|checker) (\S+)/g)].map((m) => m[1]!);
        worker = ids[0]!;
        watcher = ids[1]!;
        return {};
      },
      // The worker's turn is over; the watcher still watches.
      () => tool("finish_project", { outcome: "completed", summary: "退避重试已上线" }),
      (req) => {
        const out = lastToolResult(req);
        expect(out).toContain("Nothing was recorded or closed: 1 child cell(s) are still at work");
        expect(out).toContain(`${watcher} "等发布标记"`);
        expect(out).not.toContain(worker);
        return {};
      },
    );
    h.script.add("worker", { text: "已实现，提交 9f2c1" });
    const { projectId } = startProjectSync(h.kernel, { title: "支付重试", outcome: "上线", brief: "做支付重试", cwd: repo });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(h.kernel.activityOf([worker]).get(worker)!.state).toBe("dormant");
    expect(h.project(projectId)).toMatchObject({ lifecycle: "active" });

    // The watcher reports; now the only cell left is the resting worker, and finishing goes through.
    h.script.add("project", (req) => {
      expect(requestText(req)).toContain("条件已满足");
      return tool("finish_project", { outcome: "completed", summary: "退避重试已上线，发布标记已出现" });
    });
    writeFileSync(join(repo, "RELEASED"), "");
    h.clock.advance(MIN);
    await h.kernel.idle();
    expect(h.kernel.getCell(projectId)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.project(projectId)).toMatchObject({ lifecycle: "completed", summary: "退避重试已上线，发布标记已出现" });
    // The worker is archived with the project — completed, not cancelled; the watcher closed when it reported.
    expect(h.kernel.getCell(worker)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.kernel.getCell(watcher)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.actions(projectId).map((a) => a.status)).toEqual(["done", "done"]);
  });
});
