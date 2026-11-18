import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, subjectKeys, type EscalationCard, type ProjectProposalCard, type ProjectRecord } from "@ng/protocol";
import { DEFAULT_SETTINGS, inputOf, projectActivity, projectClarify, projectEngage, projectEngageDetail, projectRadar, projectReview, projectSources, projectStatus, SENSOR_SUGGESTION_PREFIX, SKILL_SUGGESTION_PREFIX } from "../src/server/projections";
import { cronText } from "../src/server/projections/sources";
import { parseDecisions, waitingDTO } from "../src/server/projections/format";
import { afternoonSlot, dueText, nextWeekly, weekStart } from "../src/server/projections/time";
import { relativeTimeZh } from "../src/shared/api";
import type { Kernel } from "@ng/cell";
import { agentRedraft, bootDesk, cleanupAll, DAY, HOUR, makeProject, makeReplyCard, MIN, writeAction, writeActivity, writeProject, writeSource } from "./helpers";

afterEach(cleanupAll);

const view = (k: Kernel) => inputOf(k, { ...DEFAULT_SETTINGS, backend: "scripted" });

function deferCard(kernel: Kernel, cellId: string, action: Record<string, unknown>, artifactVersion?: number): string {
  const cell = kernel.getCell(cellId)!;
  const r = kernel.gate.authorizeSync(action as never, { cellId, principalId: `cell:${cellId}`, epoch: cell.epoch, ...(artifactVersion ? { artifactVersion } : {}) });
  if (r.type !== "defer") throw new Error(`expected defer, got ${r.type}`);
  return r.actionId;
}

describe("Clarify projection", () => {
  it("a reply card carries the four fixed blocks and its buttons with their endpoints", async () => {
    const { kernel, clock } = await bootDesk();
    const { actionId, artifactId } = makeReplyCard(kernel);
    const q = projectClarify(view(kernel));
    expect(q).toMatchObject({ generatedAt: clock.now(), remaining: 1, inboxZero: false, snoozed: 0 });
    const c = q.cards[0]!;
    expect(c).toMatchObject({
      id: actionId,
      cardType: "response",
      state: "pending",
      title: "回复 Alice：接口什么时候上线",
      sourceBar: { source: { label: "测试通道", at: clock.now() - 12 * MIN }, statusText: "已备好初稿 v1 · 等待确认", version: 1, draftUpdated: false },
      rawInput: { text: "接口什么时候上线？", kind: "message" },
      prep: { summary: "查了发布计划", checked: [{ label: "发布计划", uri: "https://example.test/plan" }] },
      draft: { artifactId, version: 1, body: "您好，接口下周二上线。", updatedBy: "agent", save: { method: "PUT", path: `/api/artifacts/${artifactId}` } },
      reply: { targetLabel: "Alice", channelLabel: "测试通道", confirmVerb: "send" },
      proposal: null,
      escalation: null,
      outcome: null,
    });
    expect(c.buttons.map((b) => [b.id, b.label, b.group, b.primary])).toEqual([
      ["confirm", "✓ 确认发送", "main", true],
      ["revise_voice", "🎙 按住口述修改意见", "main", false],
      ["snooze", "⏱ 推迟到下午", "main", false],
      ["skip", "下一张 →", "main", false],
      ["to_human", "转给我来处理", "more", false],
      ["dismiss", "不需要处理（归档）", "more", false],
    ]);
    expect(c.buttons[1]).toMatchObject({ endpoint: { path: `/api/clarify/${actionId}/revise`, body: { voice: true } }, input: { field: "instruction" } });
    expect(c.buttons[3]).toMatchObject({ client: "skip" });
    expect(c.buttons[3]!.endpoint).toBeUndefined();

    agentRedraft(kernel, artifactId, "新版本", 1);
    expect(projectClarify(view(kernel)).cards[0]!.sourceBar).toMatchObject({ version: 2, draftUpdated: true, statusText: "草稿已更新为 v2 · 请重看" });
  });

  it("snoozed cards are hidden until due; a card taken over in Engage is hidden while it stays pending", async () => {
    const { kernel, clock } = await bootDesk();
    const a = makeReplyCard(kernel);
    const b = makeReplyCard(kernel);
    kernel.gate.snoozeSync(a.actionId, clock.now() + HOUR);
    writeAction(kernel, "desk", { title: "自己回", owner: "human", approvalActionId: b.actionId } as never);
    expect(projectClarify(view(kernel))).toMatchObject({ remaining: 0, snoozed: 1, inboxZero: true });
    clock.advance(HOUR);
    expect(projectClarify(view(kernel)).cards.map((c) => c.id)).toEqual([a.actionId]);
  });

  it("a project proposal shows the plan as currently saved, with the plan editor wired to its version", async () => {
    const { kernel } = await bootDesk();
    const proposal = { title: "官网改版", outcome: "新官网上线", actions: [{ title: "出设计稿", owner: "agent" as const }] };
    kernel.context.commitSync("desk", { artifact: { artifactId: "art_p", content: { format: "json", body: JSON.stringify(proposal), data: proposal }, updatedBy: "agent" } });
    const card: ProjectProposalCard = {
      cardType: "project_proposal",
      subjectKey: "msg:p",
      title: "官网改版",
      source: { label: "随手记", at: kernel.clock.now() },
      rawInput: { text: "想把官网改版", kind: "message" },
      prep: { summary: "看了现在的官网", checked: [] },
      proposal,
      draft: { artifactId: "art_p", version: 1 },
    };
    const id = deferCard(kernel, "desk", { type: "project.start", proposal, artifactId: "art_p", summary: "立项", subjectKey: "msg:p", sideEffect: "external", card: { format: "card", body: "x", data: card } }, 1);
    const edited = { ...proposal, actions: [...proposal.actions, { title: "约设计师", owner: "human" as const, effort: "15m" as const }] };
    kernel.context.commitSync("desk", { artifact: { artifactId: "art_p", content: { format: "json", body: JSON.stringify(edited), data: edited }, updatedBy: "human", expectedVersion: 1 } });
    const c = projectClarify(view(kernel)).cards[0]!;
    expect(c).toMatchObject({ id, cardType: "project_proposal", sourceBar: { statusText: "已拟好立项方案 v2 · 等待确认", version: 2 } });
    expect(c.proposal!.actions.map((a) => [a.title, a.ownerLabel, a.effortLabel])).toEqual([
      ["出设计稿", "🟢 Agent 处理中", undefined],
      ["约设计师", "🔵 我来处理", "15m 碎片时间"],
    ]);
    expect(c.buttons.slice(0, 4).map((b) => b.id)).toEqual(["confirm", "edit_plan", "someday", "skip"]);
    expect(c.buttons[1]).toMatchObject({ client: "open_plan_editor", endpoint: { method: "PUT", path: `/api/clarify/${id}/plan`, body: { expectedVersion: 2 } } });
  });

  it("escalations: waiting timeout offers the nudge, one more day and resolve offline; budget offers more budget", async () => {
    const { kernel } = await bootDesk();
    kernel.spawnCell("desk", { id: "wq", preset: "watcher", title: "等报价", bounds: { canSendTo: ["channel:memory:*"] } });
    kernel.context.commitSync("wq", { artifact: { artifactId: "art_n", content: { format: "text", body: "C 总，报价方便今天发一下吗？" }, updatedBy: "agent" } });
    const t = kernel.clock.now();
    const card: EscalationCard = {
      cardType: "escalation",
      subjectKey: "cell:wq",
      title: "供应商 C 还没回报价",
      source: { label: "后台分身", at: t },
      rawInput: { text: "等待 3 家报价", kind: "system" },
      prep: { summary: "A、B 已回", checked: [] },
      escalation: {
        reason: "waiting_timeout",
        explanation: "C 已超时 1 天未回",
        waiting: { description: "等待供应商报价回信", join: "all", parties: [{ id: "a", label: "A", replied: true }, { id: "b", label: "B", replied: true }, { id: "c", label: "C", replied: false, dueAt: t - DAY }] },
        nudgeDraft: { artifactId: "art_n", version: 1 },
        nudgeTarget: "channel:memory:supplier-c",
      },
    };
    const id = deferCard(
      kernel,
      "wq",
      { type: "channel.send", target: "channel:memory:supplier-c", content: { format: "text", body: "C 总，报价方便今天发一下吗？" }, artifactId: "art_n", summary: "催 C", subjectKey: "cell:wq", sideEffect: "external", card: { format: "card", body: "x", data: card } },
      1,
    );
    const c = projectClarify(view(kernel)).cards.find((x) => x.id === id)!;
    expect(c.escalation).toMatchObject({ reason: "waiting_timeout", reasonLabel: "等待超时", waiting: { replied: 2, total: 3, text: "已回 2/3 · 剩 C 已超时 1 天" } });
    expect(c.reply).toMatchObject({ targetLabel: "channel:memory:supplier-c", channelLabel: "测试通道" });
    expect(c.buttons.slice(0, 4).map((b) => [b.id, b.label])).toEqual([
      ["confirm", "✓ 发送催问并继续跟进"],
      ["extend", "⏱ 再等 1 天"],
      ["resolve_offline", "✓ 线下已解决，直接完结"],
      ["skip", "下一张 →"],
    ]);
    expect(c.buttons[1]!.endpoint!.body).toEqual({ until: kernel.clock.now() + DAY });
  });

  it("cards without GTD card data are shown generically with confirm / deny", async () => {
    const { kernel } = await bootDesk();
    const id = deferCard(kernel, "desk", { type: "custom", name: "deploy", summary: "发布到生产", subjectKey: "cell:desk", sideEffect: "external" });
    const c = projectClarify(view(kernel)).cards[0]!;
    expect(c).toMatchObject({ id, cardType: "generic", title: "发布到生产", sourceBar: { statusText: "等待确认", version: null } });
    expect(c.buttons.slice(0, 3).map((b) => b.id)).toEqual(["confirm", "deny", "skip"]);
  });
});

describe("Engage projection", () => {
  it("lists open 🔵 actions of active projects only, overdue first, with effort counts", async () => {
    const { kernel, clock } = await bootDesk();
    const later = writeAction(kernel, "desk", { title: "写周报", owner: "human", effort: "45m", dueAt: clock.now() + DAY });
    const overdue = writeAction(kernel, "desk", { title: "交报销", owner: "human", effort: "low_energy", dueAt: clock.now() - HOUR });
    writeAction(kernel, "desk", { title: "agent 的活", owner: "agent" });
    writeAction(kernel, "desk", { title: "已完成", owner: "human", status: "done" });
    const someday = makeProject(kernel, "以后再说的项目", { lifecycle: "someday" });
    writeAction(kernel, someday, { title: "不该出现", owner: "human" });
    const active = makeProject(kernel, "活跃项目");
    const inProject = writeAction(kernel, active, { title: "约客户", owner: "human", effort: "15m" });

    const e = projectEngage(view(kernel));
    expect(e.items.map((i) => i.title)).toEqual(["交报销", "写周报", "约客户"]);
    expect(e.counts).toEqual({ all: 3, "15m": 1, "45m": 1, low_energy: 1 });
    expect(e.items[0]).toMatchObject({ actionId: overdue.id, overdue: true, kind: "quick" });
    expect(e.items[2]).toMatchObject({ actionId: inProject.id, project: { id: active, title: "活跃项目" } });
    expect(projectEngage(view(kernel), "45m").items.map((i) => i.actionId)).toEqual([later.id]);
    expect(e.focus).toEqual({ on: false, buffered: 0, text: "免打扰未开启" });
  });

  it("the detail marks decision passages and fills the context pack from the item's source", async () => {
    const { kernel } = await bootDesk();
    kernel.context.commitSync("desk", {
      artifact: { artifactId: "art_d", content: { format: "markdown", body: "开头\n> [!DECISION] 迁移方案二选一\n> A：停机\n> B：双写\n结尾" }, updatedBy: "agent" },
    });
    kernel.context.upsertSkillOrNoteSync("desk", { kind: "skill", name: "reply-style", description: "回复客户的语气清单", body: "- 先结论后细节", scope: "global", mode: "upsert" });
    const a = writeAction(kernel, "desk", { title: "定方案", owner: "human", artifactId: "art_d" });
    const d = projectEngageDetail(view(kernel), "desk", a.id)!;
    expect(d.artifact!.decisions).toEqual([{ label: "迁移方案二选一", text: "A：停机\nB：双写", startLine: 1, endLine: 3 }]);
    expect(d.contextPack.skills).toEqual([{ name: "reply-style", description: "回复客户的语气清单" }]);
    expect(d.item.buttons.map((b) => b.id)).toEqual(["open", "done"]);
    expect(projectEngageDetail(view(kernel), "desk", "nope")).toBeNull();
  });
});

describe("Radar projection", () => {
  it("ball priority is 🔵 > 🟢 > 🟡, with aggregated progress and waiting text", async () => {
    const { kernel, clock } = await bootDesk();
    const p = makeProject(kernel, "供应商比价");
    writeAction(kernel, p, {
      title: "等报价",
      owner: "waiting",
      waiting: { description: "等待供应商报价回信", join: "all", parties: [{ id: "a", label: "A", replied: true }, { id: "b", label: "B", replied: true }, { id: "c", label: "C", replied: false, dueAt: clock.now() + DAY }] },
    });
    let row = projectRadar(view(kernel)).projects[0]!;
    expect(row.ball).toMatchObject({ owner: "waiting", label: "🟡 等待回复", text: "等待供应商报价回信 (已回 2/3 · 剩 C 明天到期)" });
    expect(row.waiting).toMatchObject({ replied: 2, total: 3 });

    writeAction(kernel, p, { title: "整理竞品", owner: "agent", progress: { done: 11, total: 15, label: "正在并发整理竞品资料" } });
    row = projectRadar(view(kernel)).projects[0]!;
    expect(row.ball).toMatchObject({ owner: "agent", text: "正在并发整理竞品资料 11/15" });
    expect(row.progress).toMatchObject({ done: 11, total: 15 });

    const h = writeAction(kernel, p, { title: "拍板选哪家", owner: "human", nextStep: "看三家报价表，选一家" });
    row = projectRadar(view(kernel)).projects[0]!;
    expect(row.ball).toMatchObject({ owner: "human", label: "🔵 我来处理", text: "看三家报价表，选一家", engage: { cellId: p, actionId: h.id } });
    expect(row.openActions.map((a) => a.owner)).toEqual(["human", "agent", "waiting"]);
  });

  it("stalled = the kernel's five-anchor check (no running work, no watch or timer, no next step, no card); paused projects are not stalled", async () => {
    const { kernel } = await bootDesk();
    const bare = makeProject(kernel, "无人推进");
    const carded = makeProject(kernel, "有卡待确认");
    // a card in the project's own subtree is the owner's anchor (docs/05 guard 2)
    makeReplyCard(kernel, { cellId: carded, subjectKey: subjectKeys.project(carded) });
    const timed = makeProject(kernel, "有闹钟");
    kernel.spawnCell(timed, { id: "t1", preset: "watcher", title: "超时提醒", schedules: [{ deliverAt: kernel.clock.now() + DAY }] });
    const paused = makeProject(kernel, "暂停中");
    kernel.control(paused, { action: "pause" });
    // The projection only reads the kernel's stamp; the kernel re-checks right after each change (here: now).
    kernel.checkStalls();
    const rows = projectRadar(view(kernel)).projects;
    const by = (id: string) => rows.find((r) => r.id === id)!;
    const stamp = kernel.context.readStateSync<ProjectRecord>(bare, gtdKeys.project)!.stalledSince;
    expect(stamp).toBe(kernel.clock.now());
    expect(by(bare)).toMatchObject({ stalled: true, stalledSince: stamp, ball: null, running: 0, waitingOn: 0 });
    expect(by(carded)).toMatchObject({ stalled: false, ball: { owner: "human" }, pendingCardId: expect.any(String) });
    expect(by(timed)).toMatchObject({ stalled: false, waitingOn: 1 });
    expect(by(paused)).toMatchObject({ stalled: false, paused: true });
    expect(by(paused).buttons.map((b) => b.id)).toContain("resume");
    expect(rows[0]!.id).toBe(bare);
  });
});

describe("Radar projection — docs/05", () => {
  it("the stalled flag is the kernel's stamp on the record: set when no anchor holds, cleared when one returns, ignored while paused", async () => {
    const { kernel, clock } = await bootDesk();
    const p = makeProject(kernel, "无人推进");
    const human = writeAction(kernel, p, { title: "约客户", owner: "human", nextStep: "打电话约周三" });
    kernel.checkStalls();
    expect(projectRadar(view(kernel)).projects[0]).toMatchObject({ stalled: false, stalledSince: null, stalledText: null });

    // the owner's last open action goes away: nothing moves the project any more
    clock.advance(MIN);
    kernel.context.commitSync(p, { statePatches: { [gtdKeys.action(human.id)]: { ...human, status: "done" } } });
    kernel.checkStalls();
    let row = projectRadar(view(kernel)).projects[0]!;
    expect(row).toMatchObject({ stalled: true, stalledSince: clock.now(), stalledText: expect.stringContaining("补上下一步") });
    expect(projectRadar(view(kernel)).counts.stalled).toBe(1);

    // a stamp the app did not see the kernel clear (e.g. a pause) does not make a paused project red
    kernel.control(p, { action: "pause" });
    row = projectRadar(view(kernel)).projects[0]!;
    expect(row).toMatchObject({ paused: true, stalled: false });
    kernel.control(p, { action: "resume" });
    kernel.checkStalls();

    // a timer in the subtree is an anchor: the kernel clears the stamp
    kernel.spawnCell(p, { id: "t1", preset: "watcher", title: "明天再看", schedules: [{ deliverAt: clock.now() + DAY }] });
    kernel.checkStalls();
    expect(kernel.context.readStateSync<ProjectRecord>(p, gtdKeys.project)!.stalledSince).toBeUndefined();
    expect(projectRadar(view(kernel)).projects[0]).toMatchObject({ stalled: false, waitingOn: 1, ball: { owner: "waiting" } });
  });

  it("a project's workers and watchers are detail of its row, never rows of their own; summary and directory come from the record", async () => {
    const { kernel } = await bootDesk();
    const p = makeProject(kernel, "竞品调研", { summary: "A、B 两家已整理完", cwd: "/srv/code/research" });
    kernel.spawnCell(p, { id: "w1", preset: "worker", title: "扒 A 公司" });
    kernel.spawnCell("w1", { id: "w1a", preset: "worker", title: "扒 A 的定价" });
    kernel.spawnCell(p, { id: "wt", preset: "watcher", title: "等 C 报价", watches: [{ threadOrFilter: { thread: "memory:quote-c" } }] });
    const radar = projectRadar(view(kernel));
    expect(radar.projects.map((r) => r.id)).toEqual([p]);
    expect(radar.projects[0]).toMatchObject({ summary: "A、B 两家已整理完", cwd: "/srv/code/research" });
    expect(radar.projects[0]!.workers.map((w) => [w.cellId, w.title, w.state])).toEqual([
      ["w1", "扒 A 公司", "idle"],
      ["w1a", "扒 A 的定价", "idle"],
      ["wt", "等 C 报价", "waiting"],
    ]);
  });
});

describe("weekly review projection", () => {
  it("collects this week's completions, overdue waits and suggestions", async () => {
    const { kernel, clock } = await bootDesk();
    const t = clock.now();
    writeAction(kernel, "desk", { title: "给牙医回电话", owner: "human", status: "done", completedAt: t - HOUR });
    writeAction(kernel, "desk", { title: "上上周的事", owner: "human", status: "done", completedAt: t - 14 * DAY });
    const p = makeProject(kernel, "比价");
    writeAction(kernel, p, { title: "等报价", owner: "waiting", waiting: { description: "等 C", join: "all", parties: [{ id: "c", label: "C", replied: false, dueAt: t - DAY }] } });
    writeProject(kernel, makeProject(kernel, "旧项目"), { title: "旧项目", lifecycle: "completed", completedAt: t - 2 * HOUR });
    kernel.spawnCell("desk", { id: "s1", preset: "sensor", title: "指标巡检" });
    writeSource(kernel, "s1", { title: "指标巡检", processor: "llm", runCount: 6, hitCount: 0 });
    kernel.context.commitSync("desk", {
      statePatches: {
        [`${SKILL_SUGGESTION_PREFIX}reply-style`]: { name: "reply-style", description: "回复客户的语气", body: "- 先结论", reason: "你本周 4 次把草稿改得更简短" },
        [`${SENSOR_SUGGESTION_PREFIX}s1`]: { entry: "script:checks/metrics.sh", reason: "检查逻辑固定" },
      },
    });

    const r = projectReview(view(kernel));
    expect(r.weekStart).toBe(weekStart(t));
    expect(r.completed.map((c) => [c.kind, c.title])).toEqual([
      ["action", "给牙医回电话"],
      ["project", "旧项目"],
    ]);
    expect(r.overdueWaits).toMatchObject([{ title: "等报价", project: "比价", text: "已回 0/1 · 已超时 1 天" }]);
    expect(r.skillSuggestions).toMatchObject([{ name: "reply-style", buttons: [{ id: "accept_skill", endpoint: { path: "/api/review/skills/reply-style/accept" } }, { id: "dismiss_skill" }] }]);
    expect(r.sensorSuggestions).toMatchObject([{ sensorId: "s1", entry: "script:checks/metrics.sh", buttons: [{ endpoint: { body: { entry: "script:checks/metrics.sh" } } }] }]);
    expect(r.nextReviewAt).toBe(nextWeekly(t, 5, 16));
  });
});

describe("status projection", () => {
  it("counts today's silent work and renders the status line of each view", async () => {
    const { kernel, clock } = await bootDesk();
    writeActivity(kernel, { kind: "notification_archived", title: "群通知" });
    writeActivity(kernel, { kind: "notification_archived", title: "群通知 2" });
    writeActivity(kernel, { kind: "note_saved", title: "存了一篇文章" });
    const p = makeProject(kernel, "停滞的");
    void p;
    makeReplyCard(kernel);
    kernel.checkStalls();
    // The kernel's single stall notice reaches the project after its grace period; the project looks and ends its
    // turn (the scripted model does nothing), and it stays flagged without a second notice.
    clock.advance(3_000);
    await kernel.idle();
    const s = projectStatus(view(kernel));
    expect(s).toMatchObject({
      demo: false,
      backend: "scripted",
      clarify: { pending: 1, snoozed: 0 },
      today: { archivedNotifications: 2, notesSaved: 1 },
      radar: { activeProjects: 1, stalledProjects: 1 },
      focus: { on: false, buffered: 0 },
    });
    expect(s.statusLine.clarify).toBe("后台已静默归档 2 条通知 · 自动存好 1 条随手笔记 · 后台没有在途任务");
    expect(s.statusLine.radar).toMatch(/^1 个进行中项目 · 1 个停滞待补下一步 · 下次周回顾 /);
    expect(projectActivity(view(kernel)).counts).toMatchObject({ notification_archived: 2, note_saved: 1 });
  });
});

describe("sources projection", () => {
  it("lists channels with their webhook paths and sensors with readable schedules", async () => {
    const { kernel } = await bootDesk();
    kernel.spawnCell("desk", { id: "s2", preset: "sensor", title: "支付报错探头" });
    writeSource(kernel, "s2", { title: "支付报错探头", schedule: { cron: "0 9 * * 1" }, mode: "observe", processor: "code", runCount: 3 });
    const s = projectSources(view(kernel));
    expect(s.channels.map((c) => [c.id, c.label, c.hookPath])).toEqual([
      ["ui", "随手记", null],
      ["memory", "测试通道", null],
    ]);
    expect(s.sensors).toMatchObject([{ id: "s2", scheduleText: "每周一 09:00", modeLabel: "只记观察笔记，不弹卡", processorLabel: "脚本检查（零 Token）", status: "ok" }]);
    expect(s.sensors[0]!.buttons.map((b) => b.id)).toEqual(["pause", "mode", "delete"]);
  });
});

describe("pure helpers", () => {
  it("time and text helpers", () => {
    const now = new Date(2026, 10, 17, 10, 0).getTime();
    expect(new Date(afternoonSlot(now, 14)).getDate()).toBe(17);
    expect(new Date(afternoonSlot(new Date(2026, 10, 17, 13, 30).getTime(), 14)).getDate()).toBe(18);
    expect(dueText(now + DAY, now)).toBe("明天到期");
    expect(dueText(now - 2 * DAY, now)).toBe("已超时 2 天");
    expect(relativeTimeZh(now - 12 * MIN, now)).toBe("12 分钟前");
    expect(cronText("*/30 * * * *")).toBe("每 30 分钟");
    expect(cronText("0 9 * * *")).toBe("每天 09:00");
    expect(parseDecisions("> [!决策]\n> 选 A 还是 B")).toEqual([{ label: "需要你拍板", text: "选 A 还是 B", startLine: 0, endLine: 1 }]);
    // The presets' prompts put the marker "right before" the passage: an unquoted paragraph after it is the passage.
    expect(parseDecisions("开头\n> [!DECISION] 迁移窗口\nA 停机 10 分钟\nB 双写一周\n\n结尾")).toEqual([
      { label: "迁移窗口", text: "A 停机 10 分钟\nB 双写一周", startLine: 1, endLine: 3 },
    ]);
    // A plan step "等行政确认…" with nobody counted (no watch) is plain text, not "已回 0/0".
    expect(waitingDTO({ description: "x", join: "any", parties: [] }, now)).toBeNull();
    expect(gtdKeys.project).toBe("gtd:project");
  });
});
