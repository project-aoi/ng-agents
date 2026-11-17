import { afterEach, describe, expect, it } from "vitest";
import { subjectKeys } from "@ng/protocol";
import { KEYS, type CoordinatorState } from "../src";
import { boot, cleanupAll, continuesRun, requestText, roots, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

const workerOf = (h: Harness, root: string) => h.kernel.listCells({ parentId: root })[0]!;

describe("docs/03 §四 row 4 — discuss, then fix in the background; steer and stop at any time", () => {
  it("delegates at once with the discussion carried over; the Job outlives the run; a steer reaches it mid-job; stop cancels everything and the records say so", async () => {
    const h = await boot();
    // 1. Discussion with the desk.
    h.script.add(
      "desk",
      tool("send_message", { to: "channel:ui:owner", text: "大概率是连接池太小（默认 10），高峰时排队超时。要我直接修吗？", summary: "diagnosis" }),
      tool("wait", { reason: "asked" }),
    );
    await h.ui.capture({ text: "登录接口偶发超时，我怀疑是数据库连接池太小" });
    await h.kernel.idle();

    // 2. "开修吧" → delegated immediately, continuing the conversation.
    h.script.add(
      "desk",
      tool("delegate", { title: "修复登录接口偶发超时", instruction: "把连接池调到 50，补一个并发登录测试，跑全量测试后汇报", continueConversation: true }),
      tool("wait", { reason: "delegated" }),
    );
    h.script.add(
      "worker",
      (req) => {
        // fork_prefix through the item root: the worker sees the discussion it continues.
        expect(requestText(req)).toContain("数据库连接池太小");
        expect(requestText(req)).toContain("把连接池调到 50");
        return tool("job_start", { command: "sleep 30; echo tests-ok" });
      },
      { text: "测试在跑，等结果" },
    );
    await h.ui.capture({ text: "好，开修吧" });
    await h.kernel.idle();

    const [root] = roots(h);
    const worker = workerOf(h, root!);
    expect(h.kernel.getCell(root!)).toMatchObject({ preset: "worker", status: "active", spec: { contextMode: "fork_prefix", processor: { kind: "code", entry: "gtd.join_all" } } });
    expect(worker).toMatchObject({ preset: "worker", status: "active", spec: { contextMode: "fork_prefix" } });
    expect(worker.bounds.isolation).toBe("git_worktree");
    expect(worker.bounds.tools.has("write")).toBe(true);
    expect(worker.bounds.canSendTo).toEqual([`inbox:${root}`]); // reports only to its parent
    expect(h.project(root!)).toMatchObject({ title: "修复登录接口偶发超时", lifecycle: "active", source: { label: "随手记" } });
    expect(h.actions(root)).toEqual([expect.objectContaining({ title: "修复登录接口偶发超时", owner: "agent", status: "open", projectCellId: root })]);
    expect(h.kernel.workspace.listJobsSync({ cellId: worker.id }).map((j) => j.state)).toEqual(["running"]);
    expect(h.notices()).toContain("已交给后台处理：修复登录接口偶发超时");
    expect(h.cards()).toEqual([]);
    // The desk's own model never saw write/edit/bash.
    const deskTools = h.script.callsOf("desk")[0]!.tools.map((t) => t.name);
    expect(deskTools).toContain("read");
    expect(deskTools.filter((n) => ["write", "edit", "bash", "job_start", "code_rpc"].includes(n))).toEqual([]);

    // 3. Steer while the job runs.
    h.script.add("desk", tool("steer_item", { itemId: root, message: "顺便把超时日志级别改成 warn" }), tool("wait", { reason: "steered" }));
    h.script.add("worker", (req) => {
      expect(requestText(req)).toContain("顺便把超时日志级别改成 warn");
      return { text: "好的，测试跑完一起改" };
    });
    await h.ui.capture({ text: "顺便把超时日志级别改成 warn" });
    await h.kernel.idle();
    expect(h.script.pending("worker")).toBe(0);
    expect(h.kernel.workspace.listJobsSync({ cellId: worker.id }).map((j) => j.state)).toEqual(["running"]);

    // 4. Stop: the root closes the worker (job cancelled), marks the records, the desk closes the root.
    h.script.add("desk", tool("stop_item", { itemId: root, reason: "主人叫停" }), tool("wait", { reason: "stopping" }));
    await h.ui.capture({ text: "算了，先停下" });
    await h.kernel.idle();

    expect(h.kernel.getCell(worker.id)).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect(h.kernel.getCell(root!)).toMatchObject({ status: "closed", closeReason: "cancelled" });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.kernel.workspace.listJobsSync({ cellId: worker.id }).map((j) => j.state)).toEqual(["cancelled"]);
    expect(h.project(root!)).toMatchObject({ lifecycle: "cancelled" });
    expect(h.actions(root)).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(h.state<CoordinatorState>(root!, KEYS.coordinator)).toMatchObject({ finished: "cancelled" });
    expect(h.cards()).toEqual([]);
    expect(h.kernel.stats().backgroundCells).toBe(0);
  });

  it("a blocked worker asks the owner; “✓ 线下已解决” completes the item without another card", async () => {
    const h = await boot();
    h.script.add("desk", tool("delegate", { title: "申请测试环境账号", instruction: "申请测试环境账号", research: true }), tool("wait", { reason: "ok" }));
    h.script.add("worker", tool("request_approval", { kind: "escalation", title: "需要主人审批：测试环境账号", summary: "blocked", escalation: { reason: "blocked", explanation: "账号申请需要主管在 OA 上审批，我没有权限" } }));
    await h.ui.capture({ text: "帮我申请一个测试环境账号" });
    await h.kernel.idle();
    const [root] = roots(h);
    const [card] = h.cards();
    expect(card).toMatchObject({ cellId: workerOf(h, root!).id, subjectKey: subjectKeys.project(root!) });
    expect(card!.clarify).toMatchObject({ cardType: "escalation", escalation: { reason: "blocked" } });

    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "resolve_offline" })).toMatchObject({ status: "resolved_offline" });
    await h.kernel.idle();
    expect(h.cards()).toEqual([]);
    expect(h.actions(root)).toEqual([expect.objectContaining({ status: "done" })]);
    expect(h.project(root!)).toMatchObject({ lifecycle: "completed" });
    expect(h.kernel.getCell(root!)?.status).toBe("closed");
  });

  it("finishes: the job result wakes the worker, its report flips the ball to the owner with one result card; a voice revise redrafts it in place; accepting completes the item", async () => {
    const h = await boot();
    h.script.add("desk", tool("delegate", { title: "整理上线检查清单", instruction: "整理一份上线前检查清单并汇报" }), tool("wait", { reason: "ok" }));
    h.script.add(
      "worker",
      tool("job_start", { command: "sleep 0.2; echo lint-ok" }),
      { text: "等检查跑完" },
      (req) => {
        expect(requestText(req)).toContain("lint-ok");
        return tool("report_to_parent", { kind: "result", text: "清单已整理：1. 配置检查 2. 回滚预案 3. 监控告警" });
      },
      { text: "已汇报" },
    );
    await h.ui.capture({ text: "帮我整理一份上线检查清单" });
    await h.kernel.idle({ jobs: true });
    await h.kernel.idle();

    const [root] = roots(h);
    const worker = workerOf(h, root!);
    expect(h.kernel.getCell(worker.id)?.status).toBe("closed"); // reported → closed by its root, workspace reclaimed
    const [a] = h.actions(root);
    expect(a).toMatchObject({ owner: "human", status: "open", nextStep: "在待确认里查看结果并确认", effort: "15m" });
    let cards = h.cards();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({ cellId: root, subjectKey: subjectKeys.project(root!), boundVersion: 1 });
    expect(card.clarify).toMatchObject({
      cardType: "response",
      confirmVerb: "accept",
      title: "整理上线检查清单：已完成",
      reply: { target: "channel:ui:owner", targetLabel: "我" },
      rawInput: { text: "帮我整理一份上线检查清单" },
      draft: { version: 1 },
    });
    expect(h.kernel.context.getArtifactSync(card.artifactId!)?.content.body).toBe("清单已整理：1. 配置检查 2. 回滚预案 3. 监控告警");
    // The root never called a model.
    expect(h.script.requests.filter((r) => r.cellId === root)).toEqual([]);

    // 🎙 revise: the root's helper rewrites, the same card shows v2.
    h.script.add("editor", (req) => {
      expect(requestText(req)).toContain("加上数据库迁移检查");
      expect(requestText(req)).toContain("回滚预案");
      return tool("submit_draft", { text: "清单：1. 配置检查 2. 数据库迁移检查 3. 回滚预案 4. 监控告警" });
    });
    await h.kernel.resolveApproval(card.actionId, { decision: "revise", instruction: "加上数据库迁移检查" });
    await h.kernel.idle();
    cards = h.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ actionId: card.actionId, boundVersion: 2 });
    expect(h.kernel.context.getArtifactSync(card.artifactId!)).toMatchObject({ version: 2, content: { body: "清单：1. 配置检查 2. 数据库迁移检查 3. 回滚预案 4. 监控告警" } });
    expect(h.kernel.listCells({ parentId: root! }).every((c) => c.status === "closed")).toBe(true);

    expect(await h.kernel.resolveApproval(card.actionId, { decision: "approve", seenArtifactVersion: 2 })).toEqual({ status: "approved", actionId: card.actionId });
    await h.kernel.idle();
    expect(h.actions(root)).toEqual([expect.objectContaining({ status: "done", owner: "human" })]);
    expect(h.project(root!)).toMatchObject({ lifecycle: "completed", completedAt: h.clock.now() });
    expect(h.kernel.getCell(root!)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.cards()).toEqual([]);
    expect(h.kernel.stats().backgroundCells).toBe(0);
    void continuesRun;
  });
});
