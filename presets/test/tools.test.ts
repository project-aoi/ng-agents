import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retireDeskState } from "../src/shared/retire-desk-state";
import { run, withTx, gtdKeys, PAYLOAD, type ActionRecord, type ModelRequest, type ProjectRecord } from "@ng/protocol";
import { BUILTIN_SKILLS, seedBuiltinSkills, setProjectLifecycleSync, startApprovedProjectSync, startProjectSync } from "../src";
import { boot, childrenOf, cleanupAll, gitRepo, lastToolResult, projects, systemOf, tool } from "./helpers";

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
    const { projectId } = startProjectSync(h.kernel, { title: "t", outcome: "o", brief: "b" });
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
    const { projectId } = startProjectSync(h.kernel, { title: "t", outcome: "o", brief: "b" });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(childrenOf(h, projectId)).toEqual([worker]);
    // still one action: the same one, closed again by the new child's result
    expect(h.actions(projectId)).toEqual([expect.objectContaining({ id, status: "done", cellId: worker })]);
  });

  it("dispatch: a worker and a watcher work in the project's directory by default, an explicit cwd is passed through, and nothing is queued", async () => {
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
      tool("dispatch", { preset: "watcher", title: "等 CI", instruction: "CI 绿了报告" }),
      (req) => {
        startedBy(req);
        return tool("dispatch", { preset: "watcher", title: "看另一个仓库里的发布标记", instruction: "仓库出现 v2 tag 就报告", cwd: other });
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
    const { projectId } = startProjectSync(h.kernel, { title: "t", outcome: "o", brief: "b", cwd: repo });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    const [byDefault, explicit, reader] = started.map((id) => h.kernel.getCell(id)!);
    // The watcher sees the project's repository, remotes and tools (no private directory any more).
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
        const a = h.state<ActionRecord>(projectId, gtdKeys.action(id))!;
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
    const { projectId } = startProjectSync(h.kernel, { title: "t", outcome: "o", brief: "b" });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(h.actions(projectId)).toEqual([expect.objectContaining({ id, owner: "human", nextStep: "回复邮件确认需求范围", status: "open" })]);
  });

  it("finish_project completed: open actions do not stop it — they are left on the books and named in the note; retro is optional", async () => {
    const h = await boot();
    h.script.add(
      "project",
      tool("track_action", { title: "确认需求", owner: "human", nextStep: "回复确认需求" }),
      tool("track_action", { title: "写文档", owner: "agent" }),
      tool("finish_project", { outcome: "completed", summary: "改版上线了\n细节见 MR" }),
    );
    const { projectId } = startProjectSync(h.kernel, { title: "官网改版", outcome: "o", brief: "b" });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(h.kernel.getCell(projectId)).toMatchObject({ status: "closed", closeReason: "completed" });
    const record = h.project(projectId)! as ProjectRecord & { retro?: string };
    expect(record).toMatchObject({ lifecycle: "completed", summary: "改版上线了\n细节见 MR" });
    expect(record.retro).toBeUndefined();
    const open = h.actions(projectId);
    expect(open.map(a=>[a.title,a.status])).toEqual([["确认需求","open"],["写文档","open"]]);
    const result = h.kernel.context
      .listEvidenceSync(projectId)
      .map((e) => e.record)
      .find((r) => r.kind === "tool_result" && r.name === "finish_project");
    const output = result && "output" in result ? String(result.output) : "";
    expect(output).toBe(
      "Requested project settlement after this run drains; stop here." +
        ` Note: these actions were still open on the books — ${open[0]!.id}「确认需求」(the owner); ${open[1]!.id}「写文档」(agent).`,
    );
    expect(h.notices().at(-1)).toBe("「官网改版」已完成：改版上线了");
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => m.envelope.payload)).toEqual([
      expect.objectContaining({ childCellId: projectId, status: "completed", summary: "改版上线了\n细节见 MR" }),
    ]);
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
    const { projectId } = startProjectSync(h.kernel, { title: "取消测试", outcome: "o", brief: "b", cwd: repo });
    await h.kernel.idle();
    expect(h.kernel.getCell(worker)).toMatchObject({ status: "active" });
    h.kernel.sendToCell(projectId, { text: "主人：这个不做了" });
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
    const { projectId } = startProjectSync(h.kernel, { title: "收尾测试", outcome: "o", brief: "b", cwd: repo });
    await h.kernel.idle();
    h.kernel.sendToCell(projectId, { text: "主人：够用了，收尾吧" });
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
    const { projectId } = startProjectSync(h.kernel, { title: "旧标题", outcome: "o", brief: "b" });
    await h.kernel.idle();
    expect(h.project(projectId)).toMatchObject({ title: "新标题", summary: "方案已定", cwd: repo });
    expect(h.kernel.getCell(projectId)?.title).toBe("新标题");
    expect(h.state(projectId, "cell:status")).toMatchObject({ text: "方案已定" });
    const a = h.state<ActionRecord>(projectId, gtdKeys.action(id))!;
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
    await h.ui.capture({ text: "改一下 TUI" });
    await h.kernel.idle();
    expect(projects(h)).toEqual([]);
    // The control plane gets the kernel's own refusal to word for its audience.
    expect(() => startProjectSync(h.kernel, { title: "改 TUI", outcome: "o", brief: "b", cwd: "/no/such/tui" }, { principalId: "agent:main" })).toThrow(/not an existing directory/);

    // A finished project, and a pre-docs/05 one that was closed while "someday".
    const done = startProjectSync(h.kernel, { title: "已完成的", outcome: "o", brief: "b" }).projectId;
    const legacy = startProjectSync(h.kernel, { title: "旧的以后再说", outcome: "o", brief: "b" }).projectId;
    await h.kernel.idle();
    h.kernel.context.commitSync(legacy, { artifact: { artifactId: "art_old_report", content: { format: "markdown", title: "旧调研报告", body: "结论" }, updatedBy: "agent" } });
    await h.kernel.closeCell(done, "completed");
    await h.kernel.closeCell(legacy, "cancelled");
    const live = startProjectSync(h.kernel, { title: "进行中的", outcome: "o", brief: "b" }).projectId;
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
        return tool("reactivate_item", { itemId: legacy, message: "现在做" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain("cannot be resumed");
        expect(lastToolResult(req)).toContain("art_old_report v1「旧调研报告」");
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
    await h.ui.capture({ text: "几件事" });
    await h.kernel.idle();
    expect(h.script.pending("desk")).toBe(0);
    expect(h.kernel.getCell(live)).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect(h.project(live)).toMatchObject({ lifecycle: "cancelled" });
  });

  it("an approved proposal starts a project cell with the approved plan; the sync start and the desk's books start the same one once", async () => {
    const h = await boot();
    const repo = gitRepo("site");
    h.script.add("desk", tool("propose_project", { title: "官网改版", outcome: "新版官网上线", actions: [{ title: "盘点页面", owner: "agent" }, { title: "对齐风格", owner: "human", nextStep: "约市场部" }], cwd: repo, phases: ["盘点", "上线"] }));
    await h.ui.capture({ text: "官网该改版了" });
    await h.kernel.idle();
    const [card] = h.cards();
    expect(card?.clarify.cardType).toBe("project_proposal");
    const deskCalls = h.script.callsOf("desk").length;
    // Root cell cannot be paused (BUG-020); approve and synchronously start before the desk's microtask runs, then verify idempotency + desk wakeup.
    expect(h.kernel.control("desk", { action: "pause" })).toMatchObject({ applied: false });
    const resolving = h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 });
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
    expect(h.actions(started!.projectId).map((a) => [a.title, a.owner])).toEqual([["盘点页面", "agent"]]);
  });
});

describe("setProjectLifecycleSync agrees with the kernel's close hook", () => {
  it("someday keeps the actions; an ended record is never flipped; repeating is a no-op", async () => {
    const h = await boot();
    h.script.add("project",tool("track_action",{title:"a",owner:"human",nextStep:"做 a"}));
    const { projectId } = startProjectSync(h.kernel, { title: "p", outcome: "o", brief: "b", plan: [{ title: "a", owner: "human", nextStep: "做 a" }] });
    await h.kernel.idle();
    const t = h.clock.now();
    expect(setProjectLifecycleSync(h.kernel.context, projectId, "someday", t)).toBe(true);
    expect(h.project(projectId)).toMatchObject({ lifecycle: "someday" });
    expect(h.actions(projectId).map((a) => a.status)).toEqual(["open"]);
    expect(setProjectLifecycleSync(h.kernel.context, projectId, "active", t)).toBe(true);
    // The app cancels from Radar: the kernel's close hook settles the books; the call before or after changes nothing more.
    await h.kernel.closeCell(projectId, "cancelled");
    expect(h.project(projectId)).toMatchObject({ lifecycle: "cancelled" });
    const after = h.state<ProjectRecord>(projectId, gtdKeys.project);
    expect(setProjectLifecycleSync(h.kernel.context, projectId, "completed", t + 1)).toBe(true);
    expect(setProjectLifecycleSync(h.kernel.context, projectId, "cancelled", t + 1)).toBe(true);
    expect(h.state<ProjectRecord>(projectId, gtdKeys.project)).toEqual(after);
    expect(h.actions(projectId).map((a) => a.status)).toEqual(["cancelled"]);
    expect(setProjectLifecycleSync(h.kernel.context, "desk", "cancelled", t)).toBe(false);
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
    const { projectId } = startProjectSync(h.kernel, { title: "p", outcome: "o", brief: "b" });
    await h.kernel.idle();
    expect(systemOf(h, projectId)).toContain("# Skill: project-relay");
    expect(systemOf(h, projectId)).toContain("A project is a relay race");
    h.script.add("desk", tool("wait", { reason: "ok" }));
    await h.ui.capture({ text: "hi" });
    await h.kernel.idle();
    expect(systemOf(h, "desk")).toContain("- workspace-arbitration:");
    expect(systemOf(h, "desk")).not.toContain("# Skill: workspace-arbitration");
  });


});

it.each(["agent", "human"] as const)("migrates approved legacy proposals while preserving %s edit provenance", async updatedBy => {
  const h = await boot();
  h.script.add("desk", tool("propose_project", {title:"整理", outcome:"整理完成", actions:[{title:"核查", owner:"agent"}]}));
  await h.ui.capture({text:"整理一下"});
  await h.kernel.idle();
  const card = h.cards()[0]!;
  const id = card.artifactId!;
  const before = h.kernel.context.getArtifactSync(id)!;
  if (updatedBy === "human") h.kernel.context.commitSync("desk", {artifact:{artifactId:id, expectedVersion:1, content:before.content, updatedBy}});
  const version = h.kernel.context.getArtifactSync(id)!.version;
  expect(h.kernel.gate.approveSync(card.actionId, "owner", version)).toBe("approved");
  run(h.kernel.db, "INSERT INTO cell_state(cell_id,key,value,updated_at) VALUES('desk',?,?,?)", ["desk:proposal:"+id, JSON.stringify({phases:["核查"]}), h.clock.now()]);
  withTx(h.kernel.db, () => retireDeskState(h.kernel.db, h.clock));
  expect(h.kernel.gate.getApprovalSync(card.actionId)).toMatchObject({
    status:"approved", boundVersion:version+1, proposedVersion:updatedBy === "agent" ? version+1 : 1, humanEdited:updatedBy === "human",
  });
  expect(h.kernel.context.getArtifactSync(id)?.content.data).toMatchObject({phases:["核查"]});
});

it("reopens the same reassigned human action in the project's current epoch and clears its snooze", async () => {
  const h = await boot();
  const {projectId} = startProjectSync(h.kernel, {id:"reassign", title:"跟进", outcome:"办妥", brief:"跟进"});
  await h.kernel.idle();
  const key = gtdKeys.action("call");
  const record = {id:"call", title:"打电话", owner:"human", status:"open", projectCellId:projectId, createdAt:h.clock.now(), updatedAt:h.clock.now()};
  const write = (owner:string) => h.kernel.context.commitSync(projectId, {statePatches:{[key]:{...record, owner}}});
  write("human");
  const item = h.kernel.humanItems.list().find(i => i.title === record.title)!;
  await h.kernel.humanItems.decide(item.id, {optionId:"system.defer", seenItemRevision:item.itemRevision, until:h.clock.now()+60_000}, "owner");
  write("agent");
  await h.kernel.closeCell(projectId, "cancelled");
  await h.kernel.reopenProject(projectId, "owner");
  write("human");
  const reopened = h.kernel.humanItems.get(item.id)!;
  expect(reopened).toMatchObject({status:"pending", epoch:h.kernel.getCell(projectId)!.epoch, snoozedUntil:null});
  expect(reopened.epoch).toBeGreaterThan(item.epoch!);
  await expect(h.kernel.humanItems.decide(item.id, {optionId:"done", seenItemRevision:reopened.itemRevision}, "owner")).resolves.toMatchObject({status:"resolved"});
});
