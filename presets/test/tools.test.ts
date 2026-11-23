import type { ModelRequest } from "@ng/loop/testing";
import { writeActionRecordSync } from "../src";
import { renderBrief } from "../src/project/launch";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys } from "../src/shared/keys";
import type { ProjectRecord } from "../src/shared/product-records";
import { run, PAYLOAD, type ActionRecord } from "@ng/protocol";
import { BUILTIN_SKILLS, seedBuiltinSkills, startApprovedProjectSync, startProjectSync } from "../src";
import { boot, childrenOf, cleanupAll, gitRepo, lastToolResult, projects, systemOf, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

describe("project tools", () => {
  it("dispatch: a missing or relative directory is refused with what to do; an action id that is not on the books records a new action", async () => {
    const h = await boot();
    let worker = "";
    let actionId = "";
    h.script.add("worker", tool("report_to_parent", { kind: "result", text: "改好了" }));
    h.script.add(
      "project",
      tool("dispatch", { title: "改代码", instruction: "改", cwd: "/no/such/repo" }),
      (req) => {
        expect(lastToolResult(req)).toContain("is not an existing directory");
        expect(lastToolResult(req)).toContain("Ask the owner for the right absolute path");
        return tool("dispatch", { title: "改代码", instruction: "改", cwd: "relative/path" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain("absolute");
        expect(childrenOf(h, projectId)).toEqual([]);
        expect(h.actions(projectId)).toEqual([]);
        // Not refused: the work is started and put on the books as a new action.
        return tool("dispatch", { title: "改代码", instruction: "改", actionId: "act_nope" });
      },
      (req) => {
        const m = /^Started worker (\S+) for action (\S+)「改代码」 \(recorded as being handled by an agent\)\./.exec(lastToolResult(req));
        expect(m, lastToolResult(req)).not.toBeNull();
        worker = m![1]!;
        actionId = m![2]!;
        // an id that is not on the books is not taken over: the new action gets an id of its own
        expect(actionId).toMatch(/^act_/);
        expect(actionId).not.toBe("act_nope");
        expect(h.actions(projectId)).toEqual([expect.objectContaining({ id: actionId, title: "改代码", owner: "agent", status: "open", cellId: worker })]);
        return {};
      },
      {}, // woken by the worker's result
    );
    const { projectId } = startProjectSync(h.kernel, { title: "t", outcome: "o", brief: "b" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(h.script.pending("worker")).toBe(0);
    expect(childrenOf(h, projectId)).toEqual([worker]);
    // the worker's result closed the action it carried
    expect(h.actions(projectId)).toEqual([expect.objectContaining({ id: actionId, status: "done", cellId: worker })]);
  });

  it("dispatch with the id of a closed action reopens that action and attaches the new child to it", async () => {
    const h = await boot();
    let id = "";
    let worker = "";
    h.script.add("worker", tool("report_to_parent", { kind: "result", text: "测试补上了" }));
    h.script.add(
      "project",
      tool("track_action", { title: "补测试", owner: "agent" }),
      (req) => {
        id = /Recorded action (\S+)「/.exec(lastToolResult(req))![1]!;
        return tool("track_action", { id, status: "done" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain("It is closed.");
        expect(h.state<ActionRecord>(projectId, gtdKeys.action(id))).toMatchObject({ status: "done", completedAt: expect.any(Number) });
        return tool("dispatch", { title: "补测试（第二轮）", instruction: "边界情况也补上", actionId: id });
      },
      (req) => {
        const m = /^Started worker (\S+) for action (\S+)「补测试（第二轮）」/.exec(lastToolResult(req));
        expect(m, lastToolResult(req)).not.toBeNull();
        worker = m![1]!;
        expect(m![2]).toBe(id);
        const a = h.state<ActionRecord>(projectId, gtdKeys.action(id))!;
        expect(a).toMatchObject({ id, title: "补测试（第二轮）", owner: "agent", status: "open", cellId: worker });
        expect(a.completedAt).toBeUndefined();
        return {};
      },
      {}, // woken by the worker's result
    );
    const { projectId } = startProjectSync(h.kernel, { title: "t", outcome: "o", brief: "b" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(childrenOf(h, projectId)).toEqual([worker]);
    // still one action: the same one, closed again by the new child's result
    expect(h.actions(projectId)).toEqual([expect.objectContaining({ id, status: "done", cellId: worker })]);
  });

  it("dispatch: a worker and a checker work in the project's directory by default, an explicit cwd is passed through, and nothing is queued", async () => {
    const h = await boot();
    const repo = gitRepo("w");
    const other = gitRepo("w2");
    const started: string[] = [];
    const startedBy = (req: ModelRequest) => {
      const out = lastToolResult(req);
      started.push(/^Started (?:worker|checker) (\S+)/.exec(out)![1]!);
      return out;
    };
    h.script.add(
      "project",
      tool("dispatch", { preset: "checker", title: "等 CI", instruction: "CI 绿了报告" }),
      (req) => {
        startedBy(req);
        return tool("dispatch", { preset: "checker", title: "看另一个仓库里的发布标记", instruction: "仓库出现 v2 tag 就报告", cwd: other });
      },
      (req) => {
        startedBy(req);
        return tool("dispatch", { title: "读代码", instruction: "数一数入口。当前有人在这个仓库改代码：只做查阅，不要改文件、不要切分支" });
      },
      (req) => {
        // it starts at once; nothing says it waits for anyone
        expect(startedBy(req)).toContain("It is running now; you are woken when its turn is over — then inspect_cell shows what it did, and send_message continues it.");
        return {};
      },
    );
    h.script.setDefault("worker", () => tool("wait", { reason: "reading" }));
    h.script.setDefault("checker", () => tool("wait", { reason: "not yet", waitingFor: "external" }));
    const { projectId } = startProjectSync(h.kernel, { title: "t", outcome: "o", brief: "b", cwd: repo }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    const [byDefault, explicit, reader] = started.map((id) => h.kernel.getCell(id)!);
    // The checker sees the project's repository, remotes and tools (no private directory any more).
    expect(byDefault!.spec).toMatchObject({ preset: "checker", cwd: repo, lifetime: "one_shot" });
    expect(explicit!.spec).toMatchObject({ preset: "checker", cwd: other });
    expect(reader!.spec).toMatchObject({ preset: "worker", cwd: repo, lifetime: "wakeable" });
    for (const c of [byDefault!, explicit!, reader!]) {
      expect(c.bounds.maxDepth).toBe(0);
    }
    expect(childrenOf(h, projectId)).toEqual(started);
  });

  it("track_action: an owner's action without nextStep is recorded, with a hint to add the concrete step", async () => {
    const h = await boot();
    let id = "";
    h.script.add(
      "project",
      tool("track_action", { title: "确认需求", owner: "human" }),
      (req) => {
        const out = lastToolResult(req);
        id = /Recorded action (\S+)「确认需求」: the owner, open\./.exec(out)![1]!;
        expect(out).toContain("It has no nextStep yet: the owner sees it on their list without knowing what to do — add the concrete step.");
        expect(out).toContain('Tell the owner once (send_message), then wait with waitingFor "human"');
        const a = h.actions(projectId).find(record => record.id === id)!;
        expect(a).toMatchObject({ title: "确认需求", owner: "human", status: "open" });
        expect(a.nextStep).toBeUndefined();
        return tool("track_action", { id, nextStep: "回复邮件确认需求范围" });
      },
      (req) => {
        expect(lastToolResult(req)).not.toContain("no nextStep");
        expect(lastToolResult(req)).toContain('Tell the owner once (send_message), then wait with waitingFor "human"');
        return {};
      },
    );
    const { projectId } = startProjectSync(h.kernel, { title: "t", outcome: "o", brief: "b" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(h.actions(projectId)).toEqual([expect.objectContaining({ id, owner: "human", nextStep: "回复邮件确认需求范围", status: "open" })]);
  });

  it("keeps a project and its owner action open when the coordinator requests completion with work outstanding", async () => {
    const h = await boot();
    h.script.add(
      "project",
      tool("track_action", { title: "确认需求", owner: "human", nextStep: "回复确认需求" }),
      tool("track_action", { title: "写文档", owner: "agent" }),
      tool("finish_project", { outcome: "completed", summary: "改版上线了\n细节见 MR" }),
    );
    const { projectId } = startProjectSync(h.kernel, { title: "官网改版", outcome: "o", brief: "b" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(h.kernel.getCell(projectId)?.status).toBe("active");
    expect(h.project(projectId)?.lifecycle).toBe("active");
    const actions = h.actions(projectId);
    expect(actions.map(a => a.status)).toEqual(["open", "open"]);
    expect(h.kernel.humanItems.get(actions.find(a => a.owner === "human")!.id)?.status).toBe("pending");
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult })).toHaveLength(0);
  });

  it("finish_project: refused only while a child cell is still at work (nothing recorded); closeChildren or cancelled stops it; cancelled closes the books", async () => {
    const h = await boot();
    const repo = gitRepo("x");
    let worker = "";
    // Still at work: it asked the desk something and waits for the answer. (A worker that simply ends its turn is
    // dormant, and a dormant worker is no reason to keep a project open.)
    h.script.setDefault("worker", () => tool("wait", { reason: "等 desk 回复", waitingFor: "inbox:desk" }));
    const stillActive = () => {
      expect(h.kernel.getCell(projectId)).toMatchObject({ status: "active" });
      expect(h.project(projectId)).toMatchObject({ lifecycle: "active" });
      expect(h.actions(projectId).map((a) => a.status)).toEqual(["open", "open"]);
    };
    h.script.add(
      "project",
      tool("track_action", { title: "确认需求", owner: "human", nextStep: "回复确认需求" }),
      tool("dispatch", { title: "实现", instruction: "实现" }),
      (req) => {
        worker = /^Started worker (\S+)/.exec(lastToolResult(req))![1]!;
        return {};
      },
      // Woken later (a Run that dispatched cannot also settle the project: see the kernel note in the report).
      (req) => {
        expect(lastToolResult(req) + JSON.stringify(req.messages)).toContain("不做了");
        return tool("finish_project", { outcome: "completed", summary: "完成" });
      },
      (req) => {
        // the open action alone would not stop it; a child still at work does (it waits for something)
        expect(lastToolResult(req)).toContain("Nothing was recorded or closed: 1 child cell(s) are still at work");
        expect(lastToolResult(req)).toContain(`${worker} "实现"`);
        expect(lastToolResult(req)).toContain("before you finish");
        expect(lastToolResult(req)).toContain("Call again with closeChildren: true if stopping them is what you mean.");
        stillActive();
        return tool("finish_project", { outcome: "someday", summary: "以后再说", retro: "none" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain("Nothing was recorded or closed: 1 child cell(s) are still at work");
        expect(lastToolResult(req)).toContain("before you park");
        stillActive();
        // cancelled needs no closeChildren: it always stops what runs below
        return tool("finish_project", { outcome: "cancelled", summary: "主人不要了", retro: "none：没有新习惯" });
      },
    );
    const { projectId } = startProjectSync(h.kernel, { title: "取消测试", outcome: "o", brief: "b", cwd: repo }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.kernel.getCell(worker)).toMatchObject({ status: "active" });
    h.kernel.sendToCell(projectId, { text: "主人：这个不做了" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(childrenOf(h, projectId)).toEqual([worker]);
    expect(h.kernel.getCell(worker)).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect(h.kernel.getCell(projectId)).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect(h.project(projectId)).toMatchObject({ lifecycle: "cancelled", summary: "主人不要了", retro: "none：没有新习惯" });
    expect(h.actions(projectId).map((a) => a.status)).toEqual(["cancelled", "cancelled"]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => m.envelope.payload)).toEqual([
      expect.objectContaining({ childCellId: projectId, status: "cancelled", summary: "主人不要了" }),
    ]);
  });

  it("finish_project with closeChildren: true stops the open children and completes", async () => {
    const h = await boot();
    const repo = gitRepo("y");
    let worker = "";
    h.script.setDefault("worker", () => tool("wait", { reason: "busy", waitingFor: "inbox:desk" }));
    h.script.add(
      "project",
      tool("dispatch", { title: "实现", instruction: "实现" }),
      (req) => {
        worker = /^Started worker (\S+)/.exec(lastToolResult(req))![1]!;
        return {};
      },
      tool("finish_project", { outcome: "completed", summary: "够用了", closeChildren: true }),
    );
    const { projectId } = startProjectSync(h.kernel, { title: "收尾测试", outcome: "o", brief: "b", cwd: repo }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    h.kernel.sendToCell(projectId, { text: "主人：够用了，收尾吧" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(h.kernel.getCell(worker)).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect(h.kernel.getCell(projectId)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.project(projectId)).toMatchObject({ lifecycle: "completed", summary: "够用了" });
  });

  it("update_project keeps the record and the board line; track_action updates and reopens", async () => {
    const h = await boot();
    const repo=gitRepo("updated");
    let id = "";
    h.script.add(
      "project",
      tool("update_project", { summary: "方案已定", title: "新标题", cwd: repo }),
      tool("track_action", { title: "写测试", owner: "agent" }),
      (req) => {
        id = /Recorded action (\S+)「/.exec(lastToolResult(req))![1]!;
        return tool("track_action", { id, status: "done" });
      },
      () => tool("track_action", { id, status: "open", owner: "human", nextStep: "看一下测试", dueAt: "2026-11-20T15:00:00+08:00" }),
      {},
    );
    const { projectId } = startProjectSync(h.kernel, { title: "旧标题", outcome: "o", brief: "b" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.project(projectId)).toMatchObject({ title: "新标题", summary: "方案已定" });
    expect(h.kernel.getCell(projectId)?.spec.cwd).toBe(repo);
    expect(h.kernel.getCell(projectId)?.title).toBe("新标题");
    expect(h.state(projectId, "cell:status")).toMatchObject({ text: "方案已定" });
    const a = h.actions(projectId).find(record => record.id === id)!;
    expect(a).toMatchObject({ status: "open", owner: "human", nextStep: "看一下测试", dueAt: Date.parse("2026-11-20T15:00:00+08:00") });
    expect(a.completedAt).toBeUndefined();
  });
});

describe("desk tools for projects in flight", () => {
  it("start_project with a missing directory asks for the path; steer/stop/reactivate say clearly when an item has closed", async () => {
    const h = await boot();
    h.script.add(
      "desk",
      tool("start_project", { title: "改 TUI", outcome: "o", brief: "b", cwd: "/no/such/tui" }),
      (req) => {
        expect(lastToolResult(req)).toContain("Ask the owner for the absolute path");
        return tool("wait", { reason: "asked" });
      },
    );
    await h.ui.capture({ text: "改一下 TUI" }, "owner");
    await h.kernel.idle();
    expect(projects(h)).toEqual([]);
    // The control plane gets the kernel's own refusal to word for its audience.
    expect(() => startProjectSync(h.kernel, { title: "改 TUI", outcome: "o", brief: "b", cwd: "/no/such/tui" }, { principalId: "agent:main" })).toThrow(/not an existing directory/);

    const done = startProjectSync(h.kernel, { title: "已完成的", outcome: "o", brief: "b" }, { principalId: h.kernel.ownerPrincipal }).projectId;
    await h.kernel.idle();
    await h.kernel.closeCell(done, "completed", { principalId: h.kernel.ownerPrincipal });
    const live = startProjectSync(h.kernel, { title: "进行中的", outcome: "o", brief: "b" }, { principalId: h.kernel.ownerPrincipal }).projectId;
    await h.kernel.idle();

    h.script.add(
      "desk",
      tool("steer_item", { itemId: done, message: "再加一点" }),
      (req) => {
        expect(lastToolResult(req)).toContain(`${done} has finished`);
        expect(lastToolResult(req)).toContain("start_project");
        return tool("steer_item", { itemId: live, message: "方向改一下", urgent: true });
      },
      (req) => {
        expect(lastToolResult(req)).toContain(`Passed on to ${live} at once`);
        return tool("stop_item", { itemId: live, reason: "不需要了" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain(`Stopped ${live}`);
        return tool("stop_item", { itemId: live });
      },
      (req) => {
        expect(lastToolResult(req)).toContain("had already ended (cancelled)");
        return tool("steer_item", { itemId: "nope", message: "x" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain("There is no item nope");
        return tool("wait", { reason: "done" });
      },
    );
    await h.ui.capture({ text: "几件事" }, "owner");
    await h.kernel.idle();
    expect(h.script.pending("desk")).toBe(0);
    expect(h.kernel.getCell(live)).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect(h.project(live)).toMatchObject({ lifecycle: "cancelled" });
  });

  it("an approved proposal starts a project cell with the approved plan; the sync start and the desk's books start the same one once", async () => {
    const h = await boot();
    const repo = gitRepo("site");
    h.script.add("desk", tool("propose_project", { title: "官网改版", outcome: "新版官网上线", actions: [{ title: "盘点页面", owner: "agent" }, { title: "对齐风格", owner: "human", nextStep: "约市场部" }], cwd: repo, phases: ["盘点", "上线"] }));
    await h.ui.capture({ text: "官网该改版了" }, "owner");
    await h.kernel.idle();
    const [card] = h.cards();
    expect(card?.decision.cardType).toBe("project_proposal");
    const deskCalls = h.script.callsOf("desk").length;
    // Root cell cannot be paused (BUG-020); approve and synchronously start before the desk's microtask runs, then verify idempotency + desk wakeup.
    expect(h.kernel.control("desk", { action: "pause" }, { principalId: h.kernel.ownerPrincipal })).toMatchObject({ applied: false });
    const resolving = h.kernel.humanItems.decide(card!.actionId, { optionId: "system.execute", seenItemRevision: h.kernel.humanItems.get(card!.actionId)!.itemRevision, seenArtifactVersion: 1 }, "owner");
    const id = h.kernel.gate.getApprovalSync(card!.actionId)!.artifactId!;
    h.kernel.context.commitSync("desk",{artifact:{artifactId:id,expectedVersion:1,updatedBy:"human",content:{format:"json",body:"{}",data:{}}}});
    const started = startApprovedProjectSync(h.kernel, card!.actionId);
    await resolving;
    expect(started).toEqual({ projectId: `proj_${card!.actionId.replace(/^act_/, "")}`, started: false });
    expect(startApprovedProjectSync(h.kernel, card!.actionId)).toEqual({ projectId: started!.projectId, started: false });
    await h.kernel.idle();
    expect(projects(h)).toEqual([started!.projectId]);
    expect(h.script.callsOf("desk")).toHaveLength(deskCalls); // the approval wake-up was pure bookkeeping
    expect(h.kernel.getCell(started!.projectId)).toMatchObject({ preset: "project", spec: { cwd: repo } });
    expect(h.project(started!.projectId)).toMatchObject({ title: "官网改版", lifecycle: "active", source: { label: "随手记" }, proposal: { outcome: "新版官网上线" } });
    expect(h.actions(started!.projectId).map((a) => [a.title, a.owner])).toEqual([["盘点页面", "agent"], ["对齐风格", "human"]]);
  });
});

describe("audit 2026-11-23: desk and project tools", () => {
  const owner = (h: Harness) => ({ principalId: h.kernel.ownerPrincipal });
  const toolOutput = (h: Harness, cellId: string, name: string) =>
    h.kernel.context.listEvidenceSync(cellId).map((e) => e.record).filter((r) => r.kind === "tool_result" && r.name === name).map((r) => (r as { output: string }).output);

  it("E07: a draft card is bound to the draft's current version; the owner's edit comes back with the decision", async () => {
    const h = await boot();
    let artifactId = "";
    h.script.add(
      "desk",
      tool("save_artifact", { title: "给房东的短信", body: "房东您好，下周三上午可以来修热水器吗？" }),
      (req) => {
        artifactId = /Saved (\S+) v1/.exec(lastToolResult(req))![1]!;
        return tool("present_to_owner", { title: "短信草稿", summary: "改好再定稿", artifactId: "art_nope" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain("There is no artifact art_nope");
        return tool("present_to_owner", { title: "短信草稿", summary: "改好再定稿", artifactId });
      },
    );
    await h.ui.capture({ text: "做成草稿卡，我要改了再定稿" }, "owner");
    await h.kernel.idle();
    const [card] = h.kernel.humanItems.list();
    expect(card).toMatchObject({ title: "短信草稿", artifactId, artifactVersion: 1 });
    expect(card!.options.find((o) => o.id === "final")?.label).toBe("定稿");
    expect(toolOutput(h, "desk", "present_to_owner").at(-1)).toContain(`bound to ${artifactId} v1`);

    // "请修改": the desk redrafts under the card's subjectKey — the same card, bound to the new version.
    h.script.add(
      "desk",
      tool("save_artifact", { artifactId, expectedVersion: 1, body: "房东您好，下周三或周四上午可以来修热水器吗？" }),
      tool("present_to_owner", { title: "短信草稿（改）", summary: "按你的意见改了", artifactId, subjectKey: card!.subjectKey }),
    );
    expect(card!.options.find((o) => o.effect === "revise")?.label).toBe("请修改");
    await h.kernel.humanItems.decide(card!.id, { optionId: "revise", seenItemRevision: card!.itemRevision, seenArtifactVersion: 1, note: "加上周四" }, "owner");
    await h.kernel.idle();
    expect(h.kernel.humanItems.list()).toEqual([expect.objectContaining({ id: card!.id, title: "短信草稿（改）", artifactVersion: 2 })]);

    let decision = "";
    h.script.add("desk", (req) => {
      decision = JSON.stringify(req.messages);
      return tool("wait", { reason: "ok" });
    });
    h.kernel.context.commitSync("desk", { artifact: { artifactId, expectedVersion: 2, updatedBy: "human", content: { format: "markdown", body: "房东您好，下周四上午可以来修热水器吗？" } } });
    const current = h.kernel.humanItems.get(card!.id)!;
    await h.kernel.humanItems.decide(card!.id, { optionId: "final", seenItemRevision: current.itemRevision, seenArtifactVersion: 3 }, "owner");
    await h.kernel.idle();
    expect(decision).toContain("approval.resolved");
    expect(decision).toMatch(/"?humanEdited"?\\?"?: ?true/);
  });

  it("E13/E17: start_project takes over a card (it is withdrawn); withdraw_card on a decided card changes nothing", async () => {
    const h = await boot();
    h.script.add("desk", tool("present_to_owner", { title: "夜间工程报告失败", summary: "夜间报告失败，详情见脚本输出" }));
    await h.ui.capture({ text: "夜间报告又挂了" }, "owner");
    await h.kernel.idle();
    const [card] = h.kernel.humanItems.list();
    h.script.add(
      "desk",
      tool("start_project", { title: "查明夜间报告失败", outcome: "找到原因并修好", brief: "查明夜间报告失败的原因，修好后请主人验收", itemId: card!.id }),
      (req) => {
        expect(lastToolResult(req)).toContain(`Card ${card!.id} was withdrawn: the project carries it now.`);
        return tool("withdraw_card", { id: card!.id, reason: "不再需要" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain("no longer waiting for the owner");
        return tool("wait", { reason: "ok" });
      },
    );
    await h.ui.capture({ text: "查一下原因并修好，修好我验收" }, "owner");
    await h.kernel.idle();
    expect(h.script.pending("desk")).toBe(0);
    expect(h.kernel.humanItems.get(card!.id)).toMatchObject({ status: "cancelled" });
    expect(projects(h)).toHaveLength(1);
  });

  it("E17: track_action on one of the project's cards says so and points to withdraw_card, which takes it back", async () => {
    const h = await boot();
    h.script.add("project", tool("request_approval", { kind: "action", title: "阶段 1 完成，是否开始阶段 2", summary: "阶段 1 已交付", options: [{ id: "go", label: "开始阶段 2", effect: "reply" }] }));
    const { projectId } = startProjectSync(h.kernel, { title: "分阶段", outcome: "o", brief: "b" }, owner(h));
    await h.kernel.idle();
    const [card] = h.kernel.humanItems.list();
    h.script.add(
      "project",
      tool("track_action", { id: card!.id, status: "cancelled" }),
      (req) => {
        expect(lastToolResult(req)).toContain(`${card!.id} is one of your cards, not an action on the books`);
        expect(lastToolResult(req)).toContain("withdraw_card");
        return tool("withdraw_card", { id: card!.id, reason: "主人改了计划，不再分阶段" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain(`Withdrew ${card!.id}`);
        return tool("wait", { reason: "ok" });
      },
    );
    h.kernel.sendToCell(projectId, { text: "不用分阶段了，一次做完" }, owner(h));
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(h.kernel.humanItems.get(card!.id)).toMatchObject({ status: "cancelled" });
  });

  it("E31: steering a parked project queues the words once; reactivate_item without a message resumes it with them", async () => {
    const h = await boot();
    const { projectId } = startProjectSync(h.kernel, { title: "笔记导入", outcome: "o", brief: "b" }, owner(h));
    await h.kernel.idle();
    expect(h.kernel.control(projectId, { action: "pause", pauseReason: "parked" }, owner(h))).toMatchObject({ applied: true });
    let seen = "";
    h.script.add("project", (req) => {
      seen = JSON.stringify(req.messages);
      return {};
    });
    h.script.add(
      "desk",
      tool("steer_item", { itemId: projectId, message: "主人：现在开始做，只做导入预览" }),
      (req) => {
        expect(lastToolResult(req)).toContain("call reactivate_item without a message");
        return tool("reactivate_item", { itemId: projectId });
      },
      (req) => {
        expect(lastToolResult(req)).toContain(`Resumed ${projectId}`);
        return tool("wait", { reason: "ok" });
      },
    );
    await h.ui.capture({ text: "之前那个笔记导入现在开始做吧，只做导入预览" }, "owner");
    await h.kernel.idle();
    expect(h.kernel.getCell(projectId)?.status).toBe("active");
    expect(seen.split("只做导入预览").length - 1).toBe(1);
  });

  it("E31: reactivate_item with the owner's words queues them before it resumes the project", async () => {
    const h = await boot();
    const { projectId } = startProjectSync(h.kernel, { title: "笔记导入", outcome: "o", brief: "b" }, owner(h));
    await h.kernel.idle();
    h.kernel.control(projectId, { action: "pause", pauseReason: "parked" }, owner(h));
    // What the project's inbox holds at the moment it is resumed.
    let queuedAtResume: string[] | undefined;
    h.kernel.bus.on("*", (topic, data) => {
      const d = data as { cellId?: string; action?: string };
      if (topic === "inbox.control" && d.cellId === projectId && d.action === "resume") {
        queuedAtResume = h.kernel.inbox.listMessagesSync({ cellId: projectId, type: PAYLOAD.cellMessage }).map((m) => (m.envelope.payload as { text: string }).text);
      }
    });
    h.script.add("desk", tool("reactivate_item", { itemId: projectId, message: "主人：开始做吧" }), tool("wait", { reason: "ok" }));
    await h.ui.capture({ text: "开始做吧" }, "owner");
    await h.kernel.idle();
    expect(queuedAtResume).toEqual(["主人：开始做吧"]);
  });

  it("E34: finish_project someday with closeChildren pauses the children with the project and says so", async () => {
    const h = await boot();
    let worker = "";
    h.script.setDefault("worker", () => tool("wait", { reason: "等 desk 回复", waitingFor: "inbox:desk" }));
    h.script.add(
      "project",
      tool("dispatch", { title: "调研", instruction: "调研" }),
      (req) => {
        worker = /^Started worker (\S+)/.exec(lastToolResult(req))![1]!;
        return {};
      },
      tool("finish_project", { outcome: "someday", summary: "先放着", closeChildren: true }),
    );
    const { projectId } = startProjectSync(h.kernel, { title: "以后再说", outcome: "o", brief: "b" }, owner(h));
    await h.kernel.idle();
    h.kernel.sendToCell(projectId, { text: "主人：先放一放" }, owner(h));
    await h.kernel.idle();
    expect(toolOutput(h, projectId, "finish_project").at(-1)).toContain("paused with the project, not closed");
    expect(h.kernel.getCell(projectId)).toMatchObject({ status: "paused" });
    expect(h.kernel.getCell(worker)).toMatchObject({ status: "paused" });
  });

  it("E29: a project's normal end is bookkeeping for the desk, its notice cut on a boundary; a fixer's result still reaches the desk", async () => {
    const h = await boot();
    const hash = "9f2c1ab7e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9";
    h.script.add("project", tool("finish_project", { outcome: "completed", summary: `${"说明".repeat(50)} ${hash} 已合入` }));
    startProjectSync(h.kernel, { title: "改重试", outcome: "o", brief: "b" }, owner(h));
    await h.kernel.idle();
    expect(h.script.callsOf("desk")).toHaveLength(0);
    expect(h.notices()).toContain(`「改重试」已完成：${"说明".repeat(50)}…`);

    h.script.add("worker", { text: "ci 已修好，修复在分支 fix/ci" });
    h.script.add("desk", tool("wait", { reason: "ok" }));
    h.kernel.spawnCell("desk", { preset: "worker", title: "修公共 CI" }, "修公共 CI", owner(h));
    await h.kernel.idle();
    expect(h.script.callsOf("desk")).toHaveLength(1);
  });

  it("E18: the triggering message is quoted only when the brief does not already carry it, and labelled as what it is", () => {
    const words = "在 /home/owner/dev/tui-table。";
    expect(renderBrief({ title: "t", outcome: "o", brief: `主人说：把表格对齐修好。${words}`, rawInput: words })).not.toContain("触发这次立项的消息");
    const brief = renderBrief({ title: "t", outcome: "o", brief: "把表格对齐修好", rawInput: words });
    expect(brief).toContain(`触发这次立项的消息（可能只是几条消息中的最后一条）：${words}`);
    expect(brief).not.toContain("原话");
  });
});

describe("built-in skills", () => {
  it("seedBuiltinSkills installs the playbooks as global SKILL.md files once and never overwrites the owner's edits", async () => {
    const h = await boot();
    const created = seedBuiltinSkills(h.kernel.context, "desk");
    expect(created).toEqual(BUILTIN_SKILLS.map((s) => s.name));
    const file = join(h.kernel.dataDir, "skills", "project-relay", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("# Project relay");

    // The owner edits one playbook; seeding again keeps it.
    h.kernel.context.upsertSkillOrNoteSync("desk", { kind: "skill", name: "domain-hub", description: "我自己的版本", body: "# 我的评审路由", scope: "global", mode: "upsert" });
    expect(seedBuiltinSkills(h.kernel.context, "desk")).toEqual([]);
    expect(h.kernel.context.getKnowledgeSync({ kind: "skill", name: "domain-hub", scope: "global" })).toMatchObject({ description: "我自己的版本", body: "# 我的评审路由" });

    // A project carries its playbook inline; the desk sees the index.
    const { projectId } = startProjectSync(h.kernel, { title: "p", outcome: "o", brief: "b" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(systemOf(h, projectId)).toContain("# Skill: project-relay");
    const relay = BUILTIN_SKILLS.find((skill) => skill.name === "project-relay")!;
    expect(systemOf(h, projectId)).toContain(relay.body.trim());
    h.script.add("desk", tool("wait", { reason: "ok" }));
    await h.ui.capture({ text: "hi" }, "owner");
    await h.kernel.idle();
    expect(systemOf(h, "desk")).toContain("- workspace-arbitration:");
    expect(systemOf(h, "desk")).not.toContain("# Skill: workspace-arbitration");
  });

  it("brings a built-in playbook that nobody edited up to date, and leaves an edited one alone", async () => {
    const h = await boot();
    const tagOf = (body: string) => `builtin-hash:${createHash("sha256").update(body.trim()).digest("hex").slice(0, 16)}`;
    const install = (name: string, body: string, tags: string[]) =>
      h.kernel.context.upsertSkillOrNoteSync("desk", { kind: "skill", name, description: "旧版", body, tags, scope: "global", mode: "upsert" });
    // As an earlier release installed them: project-relay untouched since, domain-hub edited by the owner afterwards.
    install("project-relay", "# Project relay (an older built-in)", ["builtin", tagOf("# Project relay (an older built-in)")]);
    install("domain-hub", "# 我改过的评审路由", ["builtin", tagOf("# Domain hub (an older built-in)")]);
    expect(seedBuiltinSkills(h.kernel.context, "desk")).toEqual(["project-relay", "workspace-arbitration", "habit-and-routine-discovery"]);
    const relay = BUILTIN_SKILLS.find((s) => s.name === "project-relay")!;
    expect(h.kernel.context.getKnowledgeSync({ kind: "skill", name: "project-relay", scope: "global" })?.body.trim()).toBe(relay.body.trim());
    expect(h.kernel.context.getKnowledgeSync({ kind: "skill", name: "domain-hub", scope: "global" })?.body).toBe("# 我改过的评审路由");
    expect(seedBuiltinSkills(h.kernel.context, "desk")).toEqual([]);
  });


});


it("reopens the same reassigned human action in the project's current epoch and clears its snooze", async () => {
  const h = await boot();
  const {projectId} = startProjectSync(h.kernel, {id:"reassign", title:"跟进", outcome:"办妥", brief:"跟进"}, { principalId: h.kernel.ownerPrincipal });
  await h.kernel.idle();
  const record: ActionRecord = {id:"call", title:"打电话", owner:"human", status:"open", projectCellId:projectId, createdAt:h.clock.now(), updatedAt:h.clock.now()};
  const write = (owner:ActionRecord["owner"]) => writeActionRecordSync(h.kernel, projectId, {...record, owner});
  write("human");
  const item = h.kernel.humanItems.list().find(i => i.title === record.title)!;
  await h.kernel.humanItems.decide(item.id, {optionId:"system.defer", seenItemRevision:item.itemRevision, until:h.clock.now()+60_000}, "owner");
  write("agent");
  await h.kernel.closeCell(projectId, "cancelled", { principalId: h.kernel.ownerPrincipal });
  await h.kernel.reopenProject(projectId, "owner");
  write("human");
  const reopened = h.kernel.humanItems.get(item.id)!;
  expect(reopened).toMatchObject({status:"pending", epoch:h.kernel.getCell(projectId)!.epoch, snoozedUntil:null});
  expect(reopened.epoch).toBeGreaterThan(item.epoch!);
  await expect(h.kernel.humanItems.decide(item.id, {optionId:"done", seenItemRevision:reopened.itemRevision}, "owner")).resolves.toMatchObject({status:"resolved"});
});
