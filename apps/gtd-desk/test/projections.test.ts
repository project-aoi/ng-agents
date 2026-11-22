import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys } from "@ng/presets";
import { subjectKeys } from "@ng/protocol";
import { DEFAULT_SETTINGS, inputOf, projectActivity, projectRadar, projectReview, projectSources, projectStatus, SENSOR_SUGGESTION_PREFIX, SKILL_SUGGESTION_PREFIX } from "../src/server/projections";
import { topBallOwner } from "../src/server/projections/radar";
import { cronText } from "../src/server/projections/sources";
import { parseDecisions, waitingDTO } from "../src/server/projections/format";
import { dueText, nextWeekly, weekStart } from "../src/server/projections/time";
import { relativeTimeZh } from "../src/shared/api";
import type { Kernel } from "@ng/cell";
import { bootDesk, cleanupAll, DAY, HOUR, makeProject, makeReviewCard, MIN, writeAction, writeActivity, writeProject, writeSource } from "./helpers";

afterEach(cleanupAll);

const view = (k: Kernel) => inputOf(k, { ...DEFAULT_SETTINGS, backend: "scripted" });

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
    expect(row.ball).toMatchObject({ owner: "waiting", label: "🟡 等待外部", text: "等待供应商报价回信 (已回 2/3 · 剩 C 明天到期)" });
    expect(row.waiting).toMatchObject({ replied: 2, total: 3 });

    writeAction(kernel, p, { title: "整理竞品", owner: "agent", progress: { done: 11, total: 15, label: "正在并发整理竞品资料" } });
    row = projectRadar(view(kernel)).projects[0]!;
    expect(row.ball).toMatchObject({ owner: "agent", text: "正在并发整理竞品资料 11/15" });
    expect(row.progress).toMatchObject({ done: 11, total: 15 });

    const h = writeAction(kernel, p, { title: "拍板选哪家", owner: "human", nextStep: "看三家报价表，选一家" });
    row = projectRadar(view(kernel)).projects[0]!;
    expect(row.ball).toMatchObject({ owner: "human", label: "🔵 我来处理", text: "看三家报价表，选一家", cardId: h.id });
    expect(row.openActions.map((a) => a.owner)).toEqual(["human", "agent", "waiting"]);
  });

  it("stalled = the kernel's five-anchor check (no running work, no watch or timer, no next step, no card); paused projects are not stalled", async () => {
    const { kernel } = await bootDesk();
    const bare = makeProject(kernel, "无人推进");
    const carded = makeProject(kernel, "有卡待确认");
    // a card in the project's own subtree is the owner's anchor (docs/05 guard 2)
    makeReviewCard(kernel, { cellId: carded, subjectKey: subjectKeys.project(carded) });
    const timed = makeProject(kernel, "有闹钟");
    kernel.spawnCell(timed, { id: "t1", preset: "checker", title: "超时提醒", schedules: [{ deliverAt: kernel.clock.now() + DAY }] }, undefined, { principalId: kernel.ownerPrincipal });
    const paused = makeProject(kernel, "暂停中");
    kernel.control(paused, { action: "pause" }, { principalId: kernel.ownerPrincipal });
    // The projection only reads the kernel's stamp; the kernel re-checks right after each change (here: now).
    kernel.checkStalls();
    const rows = projectRadar(view(kernel)).projects;
    const by = (id: string) => rows.find((r) => r.id === id)!;
    const stamp = kernel.db.prepare("SELECT since FROM cell_stalls WHERE cell_id=?").get(bare)?.since;
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
    await kernel.humanItems.decide(human.id, {optionId:"done",seenItemRevision:kernel.humanItems.get(human.id)!.itemRevision}, kernel.ownerPrincipal);
    await kernel.idle();
    kernel.checkStalls();
    let row = projectRadar(view(kernel)).projects[0]!;
    expect(row).toMatchObject({ stalled: true, stalledSince: clock.now(), stalledText: expect.stringContaining("补上下一步") });
    expect(projectRadar(view(kernel)).counts.stalled).toBe(1);

    // a stamp the app did not see the kernel clear (e.g. a pause) does not make a paused project red
    kernel.control(p, { action: "pause" }, { principalId: kernel.ownerPrincipal });
    row = projectRadar(view(kernel)).projects[0]!;
    expect(row).toMatchObject({ paused: true, stalled: false });
    kernel.control(p, { action: "resume" }, { principalId: kernel.ownerPrincipal });
    kernel.checkStalls();

    // a timer in the subtree is an anchor: the kernel clears the stamp
    kernel.spawnCell(p, { id: "t1", preset: "checker", title: "明天再看", schedules: [{ deliverAt: clock.now() + DAY }] }, undefined, { principalId: kernel.ownerPrincipal });
    kernel.checkStalls();
    expect(kernel.db.prepare("SELECT 1 FROM cell_stalls WHERE cell_id=?").get(p)).toBeUndefined();
    expect(projectRadar(view(kernel)).projects[0]).toMatchObject({ stalled: false, waitingOn: 1, ball: { owner: "waiting" } });
  });

  it("a project's workers and checkers are detail of its row, never rows of their own; summary and directory come from the record", async () => {
    const { kernel } = await bootDesk();
    const p = makeProject(kernel, "竞品调研", { summary: "A、B 两家已整理完", cwd: process.cwd() });
    kernel.updateCell(p,{cwd:process.cwd()}, { principalId: kernel.ownerPrincipal });
    kernel.spawnCell(p, { id: "w1", preset: "inline", title: "扒 A 公司" }, undefined, { principalId: kernel.ownerPrincipal });
    kernel.spawnCell("w1", { id: "w1a", preset: "worker", title: "扒 A 的定价" }, undefined, { principalId: kernel.ownerPrincipal });
    kernel.spawnCell(p, { id: "wt", preset: "checker", title: "等 C 报价", watches: [{ threadOrFilter: { thread: "memory:quote-c" } }] }, undefined, { principalId: kernel.ownerPrincipal });
    const radar = projectRadar(view(kernel));
    expect(radar.projects.map((r) => r.id)).toEqual([p]);
    expect(radar.projects[0]).toMatchObject({ summary: "A、B 两家已整理完", cwd: process.cwd() });
    expect(radar.projects[0]!.workers.map((w) => [w.cellId, w.title, w.state])).toEqual([
      ["w1", "扒 A 公司", "idle"],
      ["w1a", "扒 A 的定价", "idle"],
      ["wt", "等 C 报价", "waiting"],
    ]);
  });
});

describe("weekly review projection", () => {
  it("keeps a completed personal reminder in this week's review", async () => {
    const { kernel, clock } = await bootDesk();
    const reminder = kernel.humanItems.create({
      title: "给牙医回电话", category: "action", subjectKey: "reminder:dentist",
      options: [{ id: "done", label: "已办完", effect: "complete" }],
    }, null);
    await kernel.humanItems.decide(reminder.id, { optionId: "done", seenItemRevision: reminder.itemRevision }, "owner");
    expect(kernel.humanItems.list()).toHaveLength(0);
    expect(projectReview(view(kernel)).completed).toEqual([
      { kind: "action", title: "给牙医回电话", at: clock.now(), project: null },
    ]);
  });

  it("collects this week's completions, overdue waits and suggestions", async () => {
    const { kernel, clock } = await bootDesk();
    const t = clock.now();
    writeAction(kernel, "desk", { title: "给牙医回电话", owner: "human", status: "done", completedAt: t - HOUR });
    writeAction(kernel, "desk", { title: "上上周的事", owner: "human", status: "done", completedAt: t - 14 * DAY });
    const p = makeProject(kernel, "比价");
    writeAction(kernel, p, { title: "等报价", owner: "waiting", waiting: { description: "等 C", join: "all", parties: [{ id: "c", label: "C", replied: false, dueAt: t - DAY }] } });
    writeProject(kernel, makeProject(kernel, "旧项目"), { title: "旧项目", lifecycle: "completed", completedAt: t - 2 * HOUR });
    kernel.spawnCell("desk", { id: "s1", preset: "sensor", title: "指标巡检" }, undefined, { principalId: kernel.ownerPrincipal });
    writeSource(kernel, "s1", { title: "指标巡检", runCount: 6, hitCount: 0 });
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
    makeReviewCard(kernel);
    kernel.checkStalls();
    // The kernel's single stall notice reaches the project after its grace period; the project looks and ends its
    // turn (the scripted model does nothing), and it stays flagged without a second notice.
    clock.advance(3_000);
    await kernel.idle();
    const s = projectStatus(view(kernel));
    expect(s).toMatchObject({
      backend: "scripted",
      humanPending: 2, humanSnoozed: 0,
      today: { archivedNotifications: 2, notesSaved: 1 },
      radar: { activeProjects: 1, stalledProjects: 0 },
    });
    expect(s.statusLine.inbox).toBe("后台已静默归档 2 条通知 · 自动存好 1 条随手笔记 · 后台没有在途任务");
    expect(kernel.humanItems.list().some(item => item.relatedProjectIds.includes(p))).toBe(true);
    expect(projectActivity(view(kernel)).counts).toMatchObject({ notification_archived: 2, note_saved: 1 });
  });
});

describe("sources projection", () => {
  it("lists sensors with readable schedules", async () => {
    const { kernel } = await bootDesk();
    kernel.spawnCell("desk", { id: "s2", preset: "sensor", title: "支付报错探头",processor:{kind:"code",entry:"gtd.sensor_script",args:{script:"checks/probe.sh"}},schedules:[{cron:"0 9 * * 1"}] }, undefined, { principalId: kernel.ownerPrincipal });
    writeSource(kernel, "s2", { title: "支付报错探头", mode: "observe", runCount: 3 });
    const s = projectSources(view(kernel));
    expect(s.sensors).toMatchObject([{ id: "s2", scheduleText: "每周一 09:00", modeLabel: "只记观察笔记，不弹卡", processorLabel: "脚本检查（零 Token）", status: "ok" }]);
    expect(s.sensors[0]!.buttons.map((b) => b.id)).toEqual(["pause", "mode", "delete"]);
  });
});

describe("pure helpers", () => {
  it("time and text helpers", () => {
    const now = new Date(2026, 10, 17, 10, 0).getTime();
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

describe("project action display order", () => {
  it("aggregates the ball owner by priority human > agent > waiting over open actions", () => {
    expect(topBallOwner([{ owner: "waiting", status: "open" }, { owner: "agent", status: "open" }])).toBe("agent");
    expect(topBallOwner([{ owner: "agent", status: "open" }, { owner: "human", status: "open" }])).toBe("human");
    expect(topBallOwner([{ owner: "human", status: "done" }, { owner: "waiting", status: "open" }])).toBe("waiting");
    expect(topBallOwner([{ owner: "human", status: "cancelled" }])).toBeNull();
  });
});
