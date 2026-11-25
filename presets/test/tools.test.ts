import type { ModelRequest } from "@ng/loop/testing";
import { writeActionRecordSync } from "../src";
import { renderBrief } from "../src/project/launch";
import { approvedProjectInit } from "../src/inline-desk/items";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys } from "../src/shared/keys";
import type { ProjectRecord } from "../src/shared/product-records";
import { CELL_STATUS_KEY, createEnvelope, run, ManualClock, PAYLOAD, type ActionRecord, type CellStatusLine, type ItemSource, type ProjectStartAction } from "@ng/protocol";
import { CELL_PAUSE_KEY, type CellPauseState } from "@ng/cell";
import { BUILTIN_SKILLS, seedBuiltinSkills, startApprovedProjectSync, startProjectSync } from "../src";
import { boot, childrenOf, cleanupAll, continuesRun, gitRepo, lastToolResult, MIN, projects, requestText, systemOf, T0, tool, type Harness } from "./helpers";

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

  it("track_action: an owner's action without nextStep is recorded, with a hint to add the concrete step; adding it later is not a second 'tell the owner' (L06)", async () => {
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
        // Audit 2026-11-23 rerun L06: an update is not a new item for the owner — no second "tell the owner once".
        expect(lastToolResult(req)).not.toContain("no nextStep");
        expect(lastToolResult(req)).not.toContain("Tell the owner once");
        expect(lastToolResult(req)).toContain("The owner's list shows the change.");
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

  it("E29/M14: a project's normal end is bookkeeping for the desk, and the owner gets the project's summary once, uncut; a fixer's result still reaches the desk", async () => {
    const h = await boot();
    const hash = "9f2c1ab7e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9";
    const summary = `${"说明".repeat(50)} ${hash} 已合入`;
    h.script.add("project", tool("finish_project", { outcome: "completed", summary }));
    startProjectSync(h.kernel, { title: "改重试", outcome: "o", brief: "b" }, owner(h));
    await h.kernel.idle();
    expect(h.script.callsOf("desk")).toHaveLength(0);
    // Audit 2026-11-23 rerun M14: one notice, from the project, with the whole summary (no cut copy from the desk).
    expect(h.notices().filter((n) => n.includes("「改重试」已完成"))).toEqual([`「改重试」已完成：${summary}`]);

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
    // R07 changed the label: it is the owner's own words, quoted in 「」, and still said to be possibly only the last message.
    expect(brief).toContain(`主人的原话（触发这次立项的消息，可能只是几条消息中的最后一条）：「${words}」`);
  });

  // Live rerun round 4 (uc43, uc45, uc48): the brief quoted the owner twice — the desk's 「…」 and the raw message again.
  it("round 4: a brief that quotes the message without its command prefix, or quotes the part that concerns this project, is not given the message a second time", () => {
    const raw = "/todo 写一份 harness-a 和 harness-b 的对比报告，重点看重试、权限、上下文压缩。";
    const noPrefix = renderBrief({ title: "t", outcome: "o", brief: "用户原话：「写一份 harness-a 和 harness-b 的对比报告，重点看重试、权限、上下文压缩。」", rawInput: raw });
    expect(noPrefix).not.toContain("触发这次立项的消息");
    const two = "两件互不相干的事，交给后台：第一件，~/dev/pay-core 的 MAX_RETRY 从 5 改成 3；第二件，~/dev/report-gen 的 total 遇到没有 amount 的行要跳过。";
    const half = renderBrief({ title: "t", outcome: "o", brief: "主人说：「~/dev/pay-core 的 MAX_RETRY 从 5 改成 3」", rawInput: two });
    expect(half).not.toContain("触发这次立项的消息");
    // Round 5 (uc55): the desk shortened its quote in the middle.
    const elided = renderBrief({ title: "t", outcome: "o", brief: "主人说：「两件互不相干的事，交给后台：第一件……MAX_RETRY 从 5 改成 3」", rawInput: two });
    expect(elided).not.toContain("触发这次立项的消息");
    // A short or unrelated quote does not count as carrying it.
    const other = renderBrief({ title: "t", outcome: "o", brief: "主人说过：「尽快」。把重试上限改掉", rawInput: two });
    expect(other).toContain("触发这次立项的消息");
  });
});

describe("audit 2026-11-23 rerun: desk and project tools", () => {
  const owner = (h: Harness) => ({ principalId: h.kernel.ownerPrincipal });
  /** The text blocks of the newest user message: what this wake-up (or this step) brought, without the history. */
  const latest = (req: ModelRequest) =>
    ([...req.messages].reverse().find((m) => m.role === "user")?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
  const relayed = (h: Harness, cellId: string) =>
    h.kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.cellMessage }).map((m) => m.envelope.payload as { text: string; ownerMessageId?: string });

  // Audit 2026-11-23 rerun R07
  it("R07: the brief's heading says who wrote it; the owner's words are quoted, the agent's background stands apart, the directory line is the workbench's", () => {
    const raw = "把表格对齐修好，改好提个 MR";
    const base = { title: "t", outcome: "o", brief: "主台补充：仓库的测试用 pnpm test 跑", rawInput: raw };
    const quoted = `主人的原话（触发这次立项的消息，可能只是几条消息中的最后一条）：「${raw}」`;

    // briefBy "desk" (the default): the desk retold it; the owner's words come first, in 「」.
    const desk = renderBrief(base);
    expect(renderBrief({ ...base, briefBy: "desk" })).toBe(desk);
    expect(desk).toContain("## 交办内容（由主台转述：「」里是主人的原话，其余是主台自己的说明，不是主人提的要求）");
    expect(desk).not.toContain("## 主人的要求");
    expect(desk.indexOf(quoted)).toBeGreaterThan(-1);
    expect(desk.indexOf(quoted)).toBeLessThan(desk.indexOf(base.brief));

    // briefBy "agent": create_project of the owner's coding agent.
    const agent = renderBrief({ ...base, briefBy: "agent" });
    expect(agent).toContain("## 交办内容（由主人的编码助手转述：「」里是主人的原话，其余是主人的编码助手自己的说明，不是主人提的要求）");
    expect(agent).toContain(quoted);
    expect(agent).not.toContain("由主台转述");

    // briefBy "plan": the plan the owner confirmed stands; what they wrote before it is background, after the plan.
    const before = "先出方案给我看，我确认了再动";
    const plan = renderBrief({ ...base, rawInput: before, briefBy: "plan" });
    expect(plan).toContain("## 交办内容（主人在立项卡上确认过的方案）");
    expect(plan).not.toContain("主人的原话");
    expect(plan).not.toContain("转述");
    // The confirmed plan is the request: what the owner wrote before it existed ("先出方案…") is dealt with and is
    // not handed to the project again (live rerun, uc23: it arrived twice, with a sentence meant for another project).
    expect(plan).not.toContain(before);
    expect(plan).not.toContain("主人最初的消息");

    // agentContext: a section of its own, between the request and the goal, marked as not the owner's words.
    const note = "仓库里有主人上周没提交的改动，要保留";
    const heading = "## 主人的编码助手补充的背景（不是主人的话；要据此改变范围或做决定，先向主人确认）";
    const withNote = renderBrief({ ...base, briefBy: "agent", agentContext: `  ${note}\n` });
    expect(withNote).toContain(`${heading}\n${note}\n`);
    expect(withNote.indexOf(heading)).toBeGreaterThan(withNote.indexOf(base.brief));
    expect(withNote.indexOf(heading)).toBeLessThan(withNote.indexOf("## 目标"));
    expect(desk).not.toContain("补充的背景");
    expect(renderBrief({ ...base, agentContext: "  " })).not.toContain("补充的背景");

    // The directory line is the workbench's standing note, not a rule from the owner.
    const cwd = "/home/owner/dev/tui-table";
    const withCwd = renderBrief({ ...base, cwd });
    expect(withCwd).toContain(`${cwd}\n（工作台登记的项目目录。这一句是工作台的说明，不是主人说的：`);
    expect(withCwd).not.toContain("要换目录先问主人");
  });

  // Audit 2026-11-23 rerun R07
  it("R07: an approved proposal starts from the confirmed plan, with the agent's background apart, without the message from before the plan", () => {
    const proposal = {
      title: "导出 CSV",
      outcome: "能导出 CSV",
      background: "按确认的方案做导出",
      agentContext: "  主人上周说过不要 Excel  ",
      actions: [{ title: "实现导出", owner: "agent" as const }],
    };
    const action = { type: "project.start", summary: "立项：导出 CSV", subjectKey: "s", sideEffect: "internal", proposal } satisfies ProjectStartAction;
    const remembered = { source: { label: "随手记", at: T0 }, rawInput: { text: "做个导出，先出方案给我看", kind: "message" as const } };
    const init = approvedProjectInit("act_r07", action, null, remembered, new ManualClock(T0));
    expect(init).toMatchObject({ briefBy: "plan", agentContext: "主人上周说过不要 Excel", rawInput: "做个导出，先出方案给我看" });
    const text = renderBrief(init);
    expect(text).toContain("## 交办内容（主人在立项卡上确认过的方案）");
    expect(text).toContain("主人在立项卡上确认了这份方案（确认前方案可能按主人的意思改过），按它开始推进。");
    expect(text).toContain("## 主人的编码助手补充的背景（不是主人的话；要据此改变范围或做决定，先向主人确认）\n主人上周说过不要 Excel\n");
    expect(text).not.toContain("主人最初的消息");
    // Without a note of the agent's there is no such section.
    expect(approvedProjectInit("act_r07b", { ...action, proposal: { ...proposal, agentContext: " " } }, null, remembered, new ManualClock(T0))).not.toHaveProperty("agentContext");
  });

  // Audit 2026-11-23 rerun M14
  it("M14: finish_project sends the owner its summary in full (completed and someday); the desk sends nothing and files one record per closing", async () => {
    const h = await boot();
    const first = `导出已完成，在分支 feat/export 上。${"细节".repeat(70)}\nmain 没有改动，合并由你决定；Excel 格式没有验证。`;
    const second = "重开后补了 Excel 导出，仍在分支 feat/export 上，main 没有改动。";
    h.script.add("project", tool("finish_project", { outcome: "completed", summary: first }));
    const { projectId } = startProjectSync(h.kernel, { title: "导出", outcome: "o", brief: "b" }, owner(h));
    await h.kernel.idle();
    const done = () => h.notices().filter((n) => n.includes("「导出」"));
    const records = () => h.activities().filter((a) => a.id.startsWith(`done-${projectId}`)).sort((a, b) => a.at - b.at);
    expect(done()).toEqual([`「导出」已完成：${first}`]);
    expect(h.script.callsOf("desk")).toHaveLength(0);
    expect(records()).toEqual([expect.objectContaining({ id: `done-${projectId}`, kind: "action_completed", title: "已完成：导出", detail: first })]);

    // Reopened, it finishes again with another account: a second record. A cell waiting on the desk makes that result
    // reach the desk's model, whose first try fails — so the desk's books run twice on the same result.
    h.script.setDefault("worker", () => tool("wait", { reason: "等主台答复", waitingFor: "inbox:desk" }));
    h.kernel.spawnCell("desk", { preset: "worker", title: "等主台的分身" }, "问主台一件事", owner(h));
    await h.kernel.idle();
    h.script.add("project", tool("finish_project", { outcome: "completed", summary: second }));
    h.script.add("desk", { error: new Error("model unavailable") }, {});
    await h.kernel.reopenProject(projectId, h.kernel.ownerPrincipal);
    await h.kernel.idle();
    h.clock.advance(2_000); // the failed desk run is retried after its backoff
    await h.kernel.idle();
    expect(h.script.pending("desk")).toBe(0);
    expect(h.script.pending("project")).toBe(0);
    // Both desk runs had the second result in their batch: the books saw it twice.
    const deskRuns = h.script.callsOf("desk").map((req) => latest(req));
    expect(deskRuns).toHaveLength(2);
    for (const text of deskRuns) expect(text).toContain(second);
    expect(h.kernel.getCell(projectId)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(done()).toEqual([`「导出」已完成：${first}`, `「导出」已完成：${second}`]);
    const filed = records();
    expect(filed).toHaveLength(2);
    expect(filed[0]).toMatchObject({ id: `done-${projectId}`, detail: first });
    expect(filed[1]).toMatchObject({ id: expect.stringMatching(new RegExp(`^done-${projectId}-[0-9a-f]{10}$`)), detail: second });

    // someday: the owner is told too, in full; nothing comes from the desk.
    const later = "调研报告《导出方案对比》已存好：推荐先做 CSV。\n以后重新提起时从报告接着做。";
    h.script.add("project", tool("finish_project", { outcome: "someday", summary: later }));
    const parked = startProjectSync(h.kernel, { title: "导出格式调研", outcome: "o", brief: "b", mode: "research_then_park" }, owner(h)).projectId;
    await h.kernel.idle();
    expect(h.kernel.getCell(parked)).toMatchObject({ status: "paused" });
    expect(h.notices().filter((n) => n.includes("「导出格式调研」"))).toEqual([`「导出格式调研」已放进以后再说：${later}`]);
  });

  // Audit 2026-11-23 rerun M16
  it("M16: a worker that asked the project something on the way keeps its action open after that turn (with a note); one that did not is closed; a later plain turn closes it", async () => {
    const h = await boot();
    let asker = "";
    let plain = "";
    let projectId = "";
    const seen: Array<{ note: string; askerStatus?: string; plainStatus?: string }> = [];
    const actionOf = (cellId: string) => h.actions(projectId).find((a) => a.cellId === cellId);
    h.script.add(
      "project",
      {
        toolCalls: [
          { name: "dispatch", input: { title: "看一下目录", instruction: "看一下目录里的改动，然后实现导出" } },
          { name: "dispatch", input: { title: "写文档", instruction: "写导出的文档" } },
        ],
      },
      (req) => {
        const ids = [...lastToolResult(req).matchAll(/Started worker (\S+)/g)].map((m) => m[1]!);
        asker = ids[0]!;
        plain = ids[1]!;
        return {};
      },
    );
    h.script.setDefault("project", (req) => {
      if (continuesRun(req)) return {};
      const now = latest(req);
      const calls: Array<{ name: string; input: unknown }> = [];
      if (now.includes("目录里有别人未提交的改动")) calls.push({ name: "send_message", input: { to: `inbox:${asker}`, summary: "答复", text: "先只做查阅，不要改文件" } });
      if (now.includes("只看了一下")) {
        seen.push({ note: now, askerStatus: actionOf(asker)?.status, plainStatus: actionOf(plain)?.status });
        calls.push({ name: "send_message", input: { to: `inbox:${asker}`, summary: "继续", text: "改动是我的，现在可以实现导出了" } });
      }
      if (now.includes("导出已实现")) seen.push({ note: now, askerStatus: actionOf(asker)?.status });
      return calls.length ? { toolCalls: calls } : {};
    });
    h.script.setDefault("worker", (req) => {
      if (continuesRun(req)) return {};
      // By title: a dispatched worker may run before the project's next step has learnt its id.
      const now = latest(req);
      if (h.kernel.getCell(req.metadata!.cellId!)!.title === "写文档") return { text: "文档写好了" };
      if (now.includes("先只做查阅")) return { text: "只看了一下，没有动手" };
      if (now.includes("现在可以实现导出了")) return { text: "导出已实现，提交 a1b2c" };
      return {
        toolCalls: [
          { name: "send_message", input: { to: `inbox:${projectId}`, summary: "工作区冲突，请指示", text: "目录里有别人未提交的改动，我该怎么做？" } },
          { name: "wait", input: { reason: "等项目确认这些改动归谁", waitingFor: `inbox:${projectId}` } },
        ],
      };
    });
    projectId = startProjectSync(h.kernel, { title: "导出", outcome: "o", brief: "b" }, owner(h)).projectId;
    await h.kernel.idle();

    const askerAction = actionOf(asker)!;
    // The turn that only dealt with the answer: the action stayed open, and the project was told why.
    expect(seen[0]).toMatchObject({ askerStatus: "open" });
    expect(seen[0]!.note).toContain("[actions left open at this wake-up");
    expect(seen[0]!.note).toContain(`- ${askerAction.id} "看一下目录" (cell ${asker})`);
    // The worker that asked nothing had its action closed as before, and is not in that note.
    expect(actionOf(plain)).toMatchObject({ status: "done" });
    expect(seen[0]!.note).not.toContain(`(cell ${plain})`);
    // Its next turn, with no question in between, closes it.
    expect(seen[1]).toMatchObject({ askerStatus: "done" });
    expect(seen[1]!.note).not.toContain("[actions left open at this wake-up");
    expect(seen[1]!.note).toContain("[actions closed for you at this wake-up");
    expect(seen).toHaveLength(2);
    expect(askerAction).toMatchObject({ status: "done" });
  });

  // Audit 2026-11-23 rerun M16
  it("M16: steer_item and reactivate_item say which owner message they relay — only when the desk's batch holds one", async () => {
    const h = await boot();
    const live = startProjectSync(h.kernel, { title: "进行中的", outcome: "o", brief: "b" }, owner(h)).projectId;
    const parked = startProjectSync(h.kernel, { title: "停靠的", outcome: "o", brief: "b" }, owner(h)).projectId;
    await h.kernel.idle();
    expect(h.kernel.control(parked, { action: "pause", pauseReason: "parked" }, owner(h))).toMatchObject({ applied: true });
    h.script.setDefault("project", () => ({}));

    // The owner writes in the workbench.
    h.script.add("desk", { toolCalls: [{ name: "steer_item", input: { itemId: live, message: "主人：「顺便把导出也做了」", fromOwner: true } }, { name: "reactivate_item", input: { itemId: parked, message: "主人：「现在开始做」" } }] }, {});
    const said = await h.ui.capture({ text: "顺便把导出也做了；停靠的那个现在开始做" }, "owner");
    await h.kernel.idle();
    expect(relayed(h, live)).toEqual([expect.objectContaining({ text: "主人：「顺便把导出也做了」", ownerMessageId: said.id })]);
    expect(relayed(h, parked)).toEqual([expect.objectContaining({ text: "主人：「现在开始做」", ownerMessageId: said.id })]);

    // The owner's coding agent passes the owner's words to the desk: also the owner speaking.
    h.script.add("desk", tool("steer_item", { itemId: live, message: "主人：「导出用 UTF-8」", fromOwner: true }), {});
    h.kernel.sendToCell("desk", { text: "主人说导出用 UTF-8" }, { principalId: "agent:main" });
    await h.kernel.idle();
    const viaAgent = relayed(h, live).find((p) => p.text === "主人：「导出用 UTF-8」");
    expect(viaAgent?.ownerMessageId).toEqual(expect.any(String));
    const agentMessage = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellMessage }).find((m) => m.envelope.principalId === "agent:main");
    expect(viaAgent?.ownerMessageId).toBe(agentMessage?.envelope.id);

    // Woken by a project's question, the desk passes on its own decision: no owner message to name.
    h.script.add("project", tool("send_message", { to: "inbox:desk", summary: "请示", text: "导出要不要带表头？" }), {});
    h.script.add("desk", tool("steer_item", { itemId: live, message: "主台：带表头" }), {});
    h.kernel.sendToCell(live, { text: "导出的事有问题就问主台" }, owner(h));
    await h.kernel.idle();
    const own = relayed(h, live).find((p) => p.text === "主台：带表头");
    expect(own).toBeDefined();
    expect(own).not.toHaveProperty("ownerMessageId");

    // Live rerun round 2 (uc27): the owner is talking to the desk, and the desk sends a project a coordination note of
    // its own in the same wake-up. Without fromOwner it is not the owner's request, whatever else is in the batch.
    h.script.add("desk", tool("steer_item", { itemId: live, message: "主台提醒：另一个项目也在这个仓库里改文件，注意分工" }), {});
    await h.ui.capture({ text: "再给这个仓库立一个写文档的项目" }, "owner");
    await h.kernel.idle();
    const note = relayed(h, live).find((p) => p.text.startsWith("主台提醒"));
    expect(note).toBeDefined();
    expect(note).not.toHaveProperty("ownerMessageId");
    expect(note).toMatchObject({ summary: "主台转来的补充（不是主人说的）" });
  });

  // Rerun round 1, uc01 (N2): a source's further hit, passed on by the desk with steer_item, reached the project as
  // "主人的新要求" — the owner had asked for nothing.
  it("uc01: steer_item calls the relay the owner's request only when the batch holds the owner's message; a source hit's relay is the desk's addition", async () => {
    const h = await boot();
    const live = startProjectSync(h.kernel, { title: "排查 CI", outcome: "o", brief: "b" }, owner(h)).projectId;
    await h.kernel.idle();
    h.script.setDefault("project", () => ({}));
    const steered = (text: string) =>
      h.kernel.inbox.listMessagesSync({ cellId: live, type: PAYLOAD.cellMessage }).map((m) => m.envelope.payload as { text: string; summary?: string; ownerMessageId?: string }).find((p) => p.text === text);

    // The owner writes in the workbench: their request, naming their message.
    h.script.add("desk", tool("steer_item", { itemId: live, message: "主人：「顺便看看夜间构建」", fromOwner: true }), {});
    const said = await h.ui.capture({ text: "顺便看看夜间构建" }, "owner");
    await h.kernel.idle();
    expect(steered("主人：「顺便看看夜间构建」")).toMatchObject({ summary: "主人的新要求", ownerMessageId: said.id });

    // A source hits again and the desk passes it on: not the owner's words, and no owner message named.
    const hit = "信源「CI 巡检」又命中了：main 分支 CI 红了（不是主人说的）";
    h.script.add("desk", tool("steer_item", { itemId: live, message: hit }), {});
    h.kernel.inbox.enqueueSync("desk", createEnvelope({
      from: "inbox:src_ci", to: "inbox:desk", principalId: "cell:src_ci", kind: "event", type: PAYLOAD.sourceHit,
      payload: { sourceCellId: "src_ci", title: "CI 巡检", summary: "main 分支 CI 红了" },
    }, h.clock));
    await h.kernel.idle();
    const relay = steered(hit);
    expect(relay).toMatchObject({ summary: "主台转来的补充（不是主人说的）" });
    expect(relay).not.toHaveProperty("ownerMessageId");
  });

  // Audit 2026-11-23 rerun R08
  it("R08: update_project rewrites the recorded plan with the owner's change: steps replaced, [] phases ends staging, outcome and title mirrored", async () => {
    const h = await boot();
    const proposal = {
      title: "上线手册",
      outcome: "业主完成安全组确认后上线",
      background: "写一份上线手册",
      actions: [
        { title: "写手册", owner: "agent" as const },
        { title: "与安全组确认默认值", owner: "human" as const, nextStep: "约安全组" },
      ],
      phases: ["写手册", "安全组确认"],
    };
    const snapshots: Array<ProjectRecord | null> = [];
    const outputs: string[] = [];
    let projectId = "";
    const step = (next: ReturnType<typeof tool>) => (req: ModelRequest) => {
      outputs.push(lastToolResult(req));
      snapshots.push(h.project(projectId));
      return next;
    };
    h.script.add(
      "project",
      tool("update_project", { outcome: "写好上线手册", plan: [{ title: "写手册", owner: "agent" }, { title: "主人过目", owner: "human", nextStep: "看一下手册" }], phases: [] }),
      step(tool("update_project", { phases: ["初稿", "定稿"] })),
      step(tool("update_project", { title: "上线手册（精简）", summary: "主人去掉了安全组那一步" })),
      step({}),
    );
    projectId = startProjectSync(h.kernel, { title: proposal.title, outcome: proposal.outcome, brief: "b", proposal, phases: proposal.phases }, owner(h)).projectId;
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);

    const [replanned, restaged, renamed] = snapshots;
    expect(outputs[0]).toContain("the recorded plan now has the steps and stages you gave");
    expect(replanned).toMatchObject({ outcome: "写好上线手册" });
    expect(replanned!.proposal).toEqual({
      title: "上线手册",
      outcome: "写好上线手册",
      background: "写一份上线手册",
      actions: [{ title: "写手册", owner: "agent" }, { title: "主人过目", owner: "human", nextStep: "看一下手册" }],
    });
    // Stages again, the steps as they were.
    expect(restaged!.proposal).toMatchObject({ phases: ["初稿", "定稿"], actions: replanned!.proposal!.actions, outcome: "写好上线手册" });
    // A title change follows into the plan; the rest of it stays.
    expect(outputs[2]).not.toContain("the recorded plan now has");
    expect(renamed).toMatchObject({ title: "上线手册（精简）", summary: "主人去掉了安全组那一步" });
    expect(renamed!.proposal).toMatchObject({ title: "上线手册（精简）", outcome: "写好上线手册", phases: ["初稿", "定稿"], actions: replanned!.proposal!.actions });

    // A project without a recorded plan gets one only when steps or stages are given.
    const small: Array<ProjectRecord | null> = [];
    let smallId = "";
    h.script.add(
      "project",
      tool("update_project", { summary: "在改" }),
      () => {
        small.push(h.project(smallId));
        return tool("update_project", { plan: [{ title: "改一行", owner: "agent" }] });
      },
      () => {
        small.push(h.project(smallId));
        return {};
      },
    );
    smallId = startProjectSync(h.kernel, { title: "小改动", outcome: "改好", brief: "b" }, owner(h)).projectId;
    await h.kernel.idle();
    expect(small[0]).not.toHaveProperty("proposal");
    expect(small[1]!.proposal).toEqual({ title: "小改动", outcome: "改好", actions: [{ title: "改一行", owner: "agent" }] });
  });

  // Audit 2026-11-23 rerun M14 (follow-up): the closing notice is sent when the close is carried out, not when asked for.
  it("M14: a follow-up that beat the close keeps the project open and the owner hears nothing; the real close later sends one notice", async () => {
    const h = await boot();
    let projectId = "";
    const outputs: string[] = [];
    h.script.add(
      "project",
      () => {
        // The owner's follow-up lands while the project is finishing: the kernel will not close over it.
        expect(h.kernel.sendToCell(projectId, { text: "等等，再补一个导出功能" }, owner(h))).toMatchObject({ status: "delivered" });
        return tool("finish_project", { outcome: "completed", summary: "报表都做完了" });
      },
      (req) => {
        expect(latest(req)).toContain("再补一个导出功能");
        expect(h.project(projectId)).toMatchObject({ lifecycle: "active" });
        // Nothing was carried out, so nothing was said.
        outputs.push(h.notices().filter((n) => n.includes("「报表」")).join("|"));
        return tool("finish_project", { outcome: "completed", summary: "报表和导出都做完了，在分支 feat/report 上，main 没有改动。" });
      },
    );
    projectId = startProjectSync(h.kernel, { title: "报表", outcome: "报表上线", brief: "做报表" }, owner(h)).projectId;
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    const said = h.kernel.context.listEvidenceSync(projectId).map((e) => e.record).filter((r) => r.kind === "tool_result" && r.name === "finish_project").map((r) => (r as { output: string }).output);
    expect(said).toHaveLength(2);
    for (const out of said) expect(out).toContain("when it is carried out the owner is sent your summary as the closing notice; stop here.");
    expect(outputs).toEqual([""]);
    expect(h.kernel.getCell(projectId)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.notices().filter((n) => n.includes("「报表」"))).toEqual(["「报表」已完成：报表和导出都做完了，在分支 feat/report 上，main 没有改动。"]);
  });

  // Audit 2026-11-23 rerun R07 (follow-up): a triggering message from somebody other than the owner is not the owner's words.
  it("R07: a message from another sender is quoted as theirs, not as the owner's words; the owner's and their agent's messages still are", async () => {
    const h = await boot();
    const briefOf = (id: string) => String((h.kernel.inbox.listMessagesSync({ cellId: id, type: PAYLOAD.cellTask })[0]!.envelope.payload as { instruction?: string }).instruction);
    const startOne = async (title: string, send: () => Promise<unknown>) => {
      h.script.add("desk", tool("start_project", { title, outcome: "o", brief: "主台补充：先查原因" }), {});
      await send();
      await h.kernel.idle();
      return briefOf(projects(h).find((id) => h.kernel.getCell(id)!.title === title)!);
    };
    const fromBot = await startOne("修 CI", () => h.memory.inject({ from: "ci-bot", text: "main 分支构建失败 #813" }));
    // (The heading's "「」里是主人的原话" still holds: this message is not put in 「」.)
    expect(fromBot).not.toContain("主人的原话（");
    expect(fromBot).not.toContain("「main 分支构建失败 #813」");
    expect(fromBot).toMatch(/触发这次立项的消息（来自[^，]+，不是主人说的；可能只是几条消息中的最后一条）：main 分支构建失败 #813/);
    const fromOwner = await startOne("改表格", () => h.ui.capture({ text: "把表格对齐修好" }, "owner"));
    expect(fromOwner).toContain("主人的原话（触发这次立项的消息，可能只是几条消息中的最后一条）：「把表格对齐修好」");
    expect(fromOwner).not.toContain("不是主人说的");
    const fromAgent = await startOne("改导出", () => h.ui.capture({ text: "导出加上表头" }, "agent:main"));
    expect(fromAgent).toContain("主人的原话（触发这次立项的消息，可能只是几条消息中的最后一条）：「导出加上表头」");
    expect(fromAgent).not.toContain("不是主人说的");

    // Who sent it is read from the project's source; a source that names nobody is not an outside sender.
    const brief = (source: ItemSource) => renderBrief({ title: "t", outcome: "o", brief: "修 CI", rawInput: "CI 失败", source });
    expect(brief({ label: "信源 · CI", at: T0, principalId: "memory:ci-bot" })).toContain("来自信源 · CI，不是主人说的");
    expect(brief({ label: "编码助手", at: T0, principalId: "agent:main" })).toContain("主人的原话");
    expect(brief({ label: "系统", at: T0 })).toContain("主人的原话");
    // A confirmed plan stands by itself.
    const proposal = { title: "修 CI", outcome: "CI 绿", background: "按方案修", actions: [{ title: "修", owner: "agent" as const }] };
    const action = { type: "project.start", summary: "立项：修 CI", subjectKey: "s", sideEffect: "internal", proposal } satisfies ProjectStartAction;
    const remembered = { source: { label: "信源 · CI", at: T0, principalId: "memory:ci-bot" }, rawInput: { text: "CI 失败", kind: "monitor_summary" as const } };
    const init = approvedProjectInit("act_r07c", action, null, remembered, new ManualClock(T0));
    expect(init).toMatchObject({ briefBy: "plan", source: remembered.source });
    expect(renderBrief(init)).not.toContain("CI 失败");
  });

  // Audit 2026-11-23 rerun L06 (follow-up): handing an existing step to the owner is new to them; changing theirs is not.
  it("L06: track_action tells to inform the owner when an existing action is handed to them, not when the owner's action merely changes", async () => {
    const h = await boot();
    const outputs: string[] = [];
    let id = "";
    h.script.add(
      "project",
      tool("track_action", { title: "写测试", owner: "agent" }),
      (req) => {
        id = /Recorded action (\S+)「/.exec(lastToolResult(req))![1]!;
        return tool("track_action", { id, owner: "human", nextStep: "看一下测试" });
      },
      (req) => {
        outputs.push(lastToolResult(req));
        return tool("track_action", { id, owner: "human", nextStep: "看一下测试，没问题就勾掉" });
      },
      (req) => {
        outputs.push(lastToolResult(req));
        return {};
      },
    );
    startProjectSync(h.kernel, { title: "t", outcome: "o", brief: "b" }, owner(h));
    await h.kernel.idle();
    const [handed, changed] = outputs;
    expect(handed).toContain('Tell the owner once (send_message), then wait with waitingFor "human"');
    expect(handed).not.toContain("The owner's list shows the change.");
    expect(changed).toContain("The owner's list shows the change.");
    expect(changed).not.toContain("Tell the owner once");
  });

  it("track_action keeps a revising human action hidden until status 'open' is passed explicitly", async () => {
    const h = await boot();
    let actionId = "";
    let workerId = "";
    let updateOutput = "";
    let reopenOutput = "";
    h.script.add(
      "project",
      tool("save_artifact", { artifactId: "art_rev", title: "排查报告", body: "v1" }),
      tool("track_action", { title: "验收：排查报告", owner: "human", artifactId: "art_rev", nextStep: "看报告 v1" }),
      (req) => {
        actionId = /Recorded action (\S+)「/.exec(lastToolResult(req))![1]!;
        return tool("wait", { waitingFor: "human", reason: "等主人验收 v1" });
      },
    );
    const { projectId } = startProjectSync(h.kernel, { title: "rev", outcome: "o", brief: "b" }, owner(h));
    await h.kernel.idle();
    expect(h.kernel.listWaits([projectId])).toMatchObject([{ waitingFor: "human" }]);

    // Send back for revision: card moves to `revising`, stale human wait clears, and updating nextStep without `status: "open"` keeps it hidden.
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((r) => { releaseWorker = r; });
    h.script.add("worker", async () => {
      await workerGate;
      return { text: "修复完成" };
    });
    h.script.add(
      "project",
      tool("dispatch", { title: "实现修复", instruction: "补修复" }),
      (req) => {
        workerId = /Dispatched (\S+)/.exec(lastToolResult(req))?.[1] ?? h.kernel.listCells({ parentId: projectId })[0]!.id;
        return tool("track_action", { id: actionId, title: "验收：方案与修复", nextStep: "修复与验证进行中" });
      },
      (req) => {
        updateOutput = lastToolResult(req);
        return tool("wait", { waitingFor: `inbox:${workerId}`, reason: "等修复结果" });
      },
    );
    const before = h.kernel.humanItems.get(actionId)!;
    await h.kernel.humanItems.decide(
      actionId,
      { optionId: "system.revise", seenItemRevision: before.itemRevision, seenArtifactVersion: 1, note: "小 fix 直接做" },
      "owner",
    );
    // Wait until the project finishes dispatching and enters wait on the worker.
    await new Promise((r) => setTimeout(r, 40));
    expect(updateOutput).toContain("revising");
    expect(updateOutput).not.toContain("The owner's list shows the change.");
    expect(h.kernel.humanItems.get(actionId)).toMatchObject({ status: "revising", title: "验收：方案与修复", revisionNote: "小 fix 直接做" });
    expect(h.kernel.humanItems.list()).toEqual([]);
    expect(h.kernel.listWaits([projectId]).map((w) => w.waitingFor)).toEqual([`inbox:${workerId}`]);

    // Explicitly passing `status: "open"` reopens the card back to `pending` when ready.
    h.script.add(
      "project",
      tool("track_action", { id: actionId, status: "open", nextStep: "修复已完成，请验收" }),
      (req) => {
        reopenOutput = lastToolResult(req);
        return tool("wait", { waitingFor: "human", reason: "等主人验收修复" });
      },
    );
    releaseWorker();
    await h.kernel.idle();
    expect(reopenOutput).toContain('Tell the owner once (send_message), then wait with waitingFor "human"');
    expect(h.kernel.humanItems.get(actionId)).toMatchObject({ status: "pending", description: "修复已完成，请验收" });
    expect(h.kernel.humanItems.list().map((i) => i.id)).toEqual([actionId]);
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

describe("live rerun round 3: desk and project tools", () => {
  const owner = (h: Harness) => ({ principalId: h.kernel.ownerPrincipal });

  // Live rerun round 3 (uc04): the desk brought a parked project back with the owner's go-ahead, and the project's
  // note about the resume said "without a word" — so it asked the owner again.
  it("reactivate_item with the owner's words keeps them as the words of the resume: the project's next turn quotes them", async () => {
    const h = await boot();
    const { projectId } = startProjectSync(h.kernel, { title: "笔记导入", outcome: "o", brief: "b" }, owner(h));
    await h.kernel.idle();
    expect(h.kernel.control(projectId, { action: "pause", pauseReason: "parked" }, owner(h))).toMatchObject({ applied: true });
    h.clock.advance(MIN);
    let seen = "";
    h.script.add("project", (req) => {
      seen = requestText(req);
      return {};
    });
    const words = "主人：现在开始做，只做导入预览";
    h.script.add("desk", tool("reactivate_item", { itemId: projectId, message: words }), tool("wait", { reason: "ok" }));
    await h.ui.capture({ text: "笔记导入现在开始做吧，只做导入预览" }, "owner");
    await h.kernel.idle();
    expect(h.kernel.getCell(projectId)?.status).toBe("active");
    expect(h.state<CellPauseState>(projectId, CELL_PAUSE_KEY)).toMatchObject({ reason: "parked", resumedBy: "cell:desk", resumeNote: words });
    expect(seen).toContain("[back from a pause — the owner parked this cell for later at 2026-11-17T01:00:00Z, without a word.");
    expect(seen).toContain(`resumed it at 2026-11-17T01:01:00Z, with the words "${words}".`);
    expect(seen).not.toContain("resumed it at 2026-11-17T01:01:00Z, without a word");
  });

  // Live rerun round 3: "「导出」已完成：已完成：…" — the project's summary already opened with the label.
  it("finish_project: a summary that opens with the label and a break is not labelled twice; '已完成并验收，…' stays whole", async () => {
    const h = await boot();
    const finish = async (title: string, summary: string) => {
      h.script.add("project", tool("finish_project", { outcome: "completed", summary }));
      const { projectId } = startProjectSync(h.kernel, { title, outcome: "o", brief: "b" }, owner(h));
      await h.kernel.idle();
      expect(h.kernel.getCell(projectId)).toMatchObject({ status: "closed", closeReason: "completed" });
      return { notices: h.notices().filter((n) => n.startsWith(`「${title}」`)), line: h.state<CellStatusLine>(projectId, CELL_STATUS_KEY)?.text };
    };
    expect(await finish("导出", "已完成：导出在分支 feat/export 上")).toEqual({ notices: ["「导出」已完成：导出在分支 feat/export 上"], line: "已完成：导出在分支 feat/export 上" });
    expect(await finish("导入", "已完成。导入在分支 feat/import 上")).toEqual({ notices: ["「导入」已完成：导入在分支 feat/import 上"], line: "已完成：导入在分支 feat/import 上" });
    expect(await finish("报表", "已完成并验收，报表在 main 上")).toEqual({ notices: ["「报表」已完成：已完成并验收，报表在 main 上"], line: "已完成：已完成并验收，报表在 main 上" });
  });
});
