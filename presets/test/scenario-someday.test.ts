import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD } from "@ng/protocol";
import { boot, childrenOf, cleanupAll, lastToolResult, projects, requestText, tool } from "./helpers";

afterEach(cleanupAll);

const artifactIdIn = (text: string) => /Saved (\S+) v\d+/.exec(text)?.[1] ?? "";

describe("docs/05 scenario 5 — an idea for later: research, park, bring it back, build it one phase at a time", () => {
  it("research_then_park → someday (paused, everything kept) → reactivate_item → active again → phase 2 only after the owner's go-ahead", async () => {
    const h = await boot();
    h.script.add(
      "desk",
      tool("start_project", { title: "极简模式", outcome: "弄清极简模式该做成什么样", brief: "用户在意 Token 消耗，想做个极简模式，先随手记一下。", mode: "research_then_park" }),
      tool("wait", { reason: "noted" }),
    );
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("先调研，再停靠");
        expect(requestText(req)).toContain('finish_project（outcome "someday"）');
        return tool("dispatch", { title: "调研其他产品的极简模式", instruction: "调研其他产品如何做极简/省 Token 模式，存成调研报告 artifact，报告它的 id。" });
      },
      {},
    );
    let report = "";
    h.script.add(
      "worker",
      tool("save_artifact", { title: "极简模式调研报告", body: "# 极简模式调研\n- 产品 A：只保留摘要输出\n- 产品 B：关闭工具调用说明" }),
      (req) => {
        report = artifactIdIn(lastToolResult(req));
        return tool("report_to_parent", { kind: "result", text: `调研完成，报告 ${report}`, artifactId: report });
      },
    );
    h.script.add(
      "project",
      tool("update_project", { summary: "调研完成：主流做法是只保留摘要输出" }),
      tool("finish_project", { outcome: "someday", summary: "调研报告已完成，先放进以后再说", retro: "none：这次没有新的习惯" }),
    );
    await h.ui.capture({ text: "/todo 做个极简模式（以后再说）" });
    await h.kernel.idle();

    const [project] = projects(h);
    expect(h.notices()).toContain("已记下：极简模式，先做个调研，完成后放进以后再说");
    expect(h.kernel.getCell(project!)).toMatchObject({ status: "paused" });
    expect(h.project(project!)).toMatchObject({ lifecycle: "someday", summary: "调研报告已完成，先放进以后再说" });
    expect(h.kernel.anchorsOf(project!)).toMatchObject({ parked: true, stalled: false });
    expect(h.kernel.context.getArtifactSync(report)).toMatchObject({ version: 1 });

    // Weeks later the owner brings it up again: the desk finds the old project and its report, and brings it back.
    h.script.add(
      "desk",
      tool("search_history", { query: "极简模式", scope: "global" }),
      (req) => {
        expect(lastToolResult(req)).toContain("极简模式调研");
        return tool("reactivate_item", { itemId: project, message: "主人确认现在正式开做：分两个阶段，先做阶段 1（只输出摘要），阶段 2 再做配置开关。" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain(`Resumed ${project}`);
        return tool("wait", { reason: "resumed" });
      },
    );
    let phase2 = "";
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("正式开做");
        expect(h.project(project!)).toMatchObject({ lifecycle: "active" }); // the books reopened it before the model ran
        return tool("read_artifact", { artifactId: report });
      },
      tool("track_action", { title: "阶段 1：只输出摘要", owner: "agent", phase: 1 }),
      (req) => {
        expect(lastToolResult(req)).toContain("dispatch it with this actionId");
        return tool("track_action", { title: "阶段 2：配置开关", owner: "agent", phase: 2 });
      },
      (req) => {
        phase2 = /Recorded action (\S+)「/.exec(lastToolResult(req))![1]!;
        const phase1 = h.actions(project).find((a) => a.phase === 1)!;
        return tool("dispatch", { title: "阶段 1：只输出摘要", instruction: `按调研报告 ${report} 实现阶段 1`, actionId: phase1.id, phase: 1 });
      },
      {},
    );
    h.script.add("worker", tool("report_to_parent", { kind: "result", text: "阶段 1 完成：新增 --minimal 输出摘要" }));
    h.script.add(
      "project",
      tool("request_approval", { kind: "action", title: "阶段 1 完成，是否开始阶段 2", summary: "阶段 1 已交付 --minimal；阶段 2 做配置开关", action: { name: "gtd.next_phase", args: { phase: 2 } } }),
    );
    await h.ui.capture({ text: "/todo 要做个极简模式" });
    await h.kernel.idle();

    expect(h.kernel.getCell(project!)).toMatchObject({ status: "active" });
    expect(h.project(project!)).toMatchObject({ lifecycle: "active" });
    expect(h.project(project!)!.completedAt).toBeUndefined();
    const [card] = h.kernel.gate.listPendingSync({ includeSnoozed: true });
    expect(card).toMatchObject({ cellId: project, subjectKey: expect.stringContaining(`action:${project}:`) });
    expect(h.actions(project).find((a) => a.id === phase2)).toMatchObject({ status: "open", owner: "agent" });
    expect(h.actions(project).find((a) => a.id === phase2)!.cellId).toBeUndefined(); // not started before the go-ahead
    expect(childrenOf(h, project!, "worker")).toHaveLength(2);

    // The owner says go: phase 2 starts.
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain(PAYLOAD.approvalResolved);
        return tool("dispatch", { title: "阶段 2：配置开关", instruction: "实现阶段 2：配置开关", actionId: phase2, phase: 2 });
      },
      {},
    );
    h.script.setDefault("worker", () => tool("wait", { reason: "working", waitingFor: "inbox:desk" }));
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner" })).toMatchObject({ status: "approved" });
    await h.kernel.idle();
    expect(childrenOf(h, project!, "worker")).toHaveLength(3);
    expect(h.actions(project).find((a) => a.id === phase2)).toMatchObject({ status: "open", phase: 2, cellId: childrenOf(h, project!, "worker")[2] });
  });
});
