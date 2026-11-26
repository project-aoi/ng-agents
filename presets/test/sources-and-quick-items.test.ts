import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys } from "../src/shared/keys";
import { PAYLOAD, type ProjectProposal } from "@ng/protocol";
import { defineSensorCheck, OBSERVATION_NOTE, type SensorHit } from "../src";
import { boot, cleanupAll, DAY, projects, T0, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

/** Monday 2026-11-23 09:00 Asia/Shanghai. */
const MONDAY_9 = Date.UTC(2026, 10, 23, 1, 0, 0);

function sensorsOf(h: Harness): string[] {
  return h.kernel.listCells({ parentId: "desk", preset: "sensor" }).map((c) => c.id);
}

it.each(["", "先核对数据，再讨论立项"])("passes the owner's explanation on a declined proposal through desk bookkeeping", async note => {
  const h = await boot();
  const deferred = h.kernel.gate.authorizeSync({type:"project.start", subjectKey:"proposal:review", summary:"确认安排",
    sideEffect:"external", proposal:{title:"核对记录", outcome:"交付记录", actions:[]}}, {cellId:"desk", principalId:"cell:desk", epoch:h.kernel.getCell("desk")!.epoch});
  if (deferred.type !== "defer") throw Error("expected a proposal");
  const item = h.kernel.humanItems.get(deferred.actionId)!;
  const decline = item.options.find(o => o.effect === "terminate")!;
  const before = h.script.callsOf("desk").length;
  await h.kernel.humanItems.decide(item.id, {optionId:decline.id, seenItemRevision:item.itemRevision, note}, "owner");
  await h.kernel.idle();
  const calls = h.script.callsOf("desk").slice(before);
  if (note) expect(calls.some(call => JSON.stringify(call.messages).includes(note))).toBe(true);
  else expect(calls).toHaveLength(0);
  expect(projects(h)).toHaveLength(0);
});

describe("docs/03 §四 row 1 — a sensor is a source, not a task", () => {
  it("stays silent on a normal run, posts one hit to the desk, which turns it into a project proposal; approving starts the project", async () => {
    const hits: Array<SensorHit | null> = [null, { title: "注册转化率下跌", summary: "注册转化率环比下跌 18%（12.1% → 9.9%）", rawInput: "signup_cr: 0.099 (last week 0.121)" }];
    const h = await boot({
      setup: (r) => r.codeProcessors.register(defineSensorCheck("test.metrics", () => hits.shift() ?? null)),
    });

    // The owner asks for a weekly check: the desk adds a source, not a project.
    h.script.add(
      "desk",
      tool("add_source", { title: "核心指标巡检", description: "注册转化率环比下跌超过 10% 才算", cron: "0 9 * * 1", tz: "Asia/Shanghai", check: "test.metrics" }),
      {},
    );
    await h.ui.capture({ text: "每周一早 9 点帮我看下核心指标有没有掉" }, "owner");
    await h.kernel.idle();

    const [sensor] = sensorsOf(h);
    expect(sensor).toBeDefined();
    expect(h.source(sensor!)).toMatchObject({ title: "核心指标巡检", kind: "cron", mode: "active", processor: "code", status: "ok", runCount: 0, hitCount: 0, schedule: { cron: "0 9 * * 1", tz: "Asia/Shanghai" } });
    expect(h.notices()).toEqual(["已添加信源：核心指标巡检"]);
    expect(h.cards()).toEqual([]);
    expect(h.project(sensor!)).toBeNull(); // never a project row
    const deskRuns = h.deskRuns();

    // First Monday: metrics normal → silent. SourceRecord moves, nothing else does.
    h.clock.set(MONDAY_9);
    await h.kernel.idle();
    expect(h.source(sensor!)).toMatchObject({ runCount: 1, hitCount: 0, lastRunAt: MONDAY_9, status: "ok" });
    expect(h.deskRuns()).toBe(deskRuns);
    expect(h.cards()).toEqual([]);

    // Second Monday: a hit → one source.hit to the desk → a project proposal card.
    h.script.add("desk", (req) => {
      expect(JSON.stringify(req.messages)).toContain("注册转化率环比下跌 18%");
      return tool("propose_project", {
        title: "排查注册转化率下跌",
        outcome: "找到下跌原因并给出修复方案",
        actions: [
          { title: "拉取近两周注册漏斗数据，定位下跌环节", owner: "agent" },
          { title: "和增长组同步结论", owner: "human", effort: "15m", nextStep: "约增长组开 15 分钟短会" },
        ],
        prep: { summary: "对比了上周与本周的注册漏斗指标" },
      });
    });
    h.clock.set(MONDAY_9 + 7 * DAY);
    await h.kernel.idle();
    expect(h.source(sensor!)).toMatchObject({ runCount: 2, hitCount: 1, lastHitAt: MONDAY_9 + 7 * DAY });
    const cards = h.cards();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.cellId).toBe("desk");
    expect(card.decision).toMatchObject({
      cardType: "project_proposal",
      title: "排查注册转化率下跌",
      source: { label: "信源 · 注册转化率下跌" },
      rawInput: { text: "signup_cr: 0.099 (last week 0.121)", kind: "monitor_summary" },
      prep: { summary: "对比了上周与本周的注册漏斗指标" },
      proposal: { title: "排查注册转化率下跌", outcome: "找到下跌原因并给出修复方案" },
      draft: { version: 1 },
    });
    expect(card.boundVersion).toBe(1);

    // "✎ 手动改一下安排": the owner edits the plan (v2); approving the v1 they no longer see is refused.
    const proposal = (card.decision as { proposal: ProjectProposal }).proposal;
    const edited: ProjectProposal = { ...proposal, actions: [...proposal.actions, { title: "确认埋点没有漏报", owner: "agent" }] };
    expect(h.kernel.context.commitSync("desk", { artifact: { artifactId: card.artifactId!, content: { format: "json", body: JSON.stringify(edited), data: edited }, updatedBy: "human", expectedVersion: 1 } })).toMatchObject({ ok: true });
    await expect(h.kernel.humanItems.decide(card.actionId, { optionId: "system.execute", seenItemRevision: h.kernel.humanItems.get(card.actionId)!.itemRevision, seenArtifactVersion: 1 }, "owner")).rejects.toMatchObject({code: "conflict"});

    // Approve v2 → the project starts with the edited plan, before (and without) any model call of the desk.
    const deskCalls = h.script.callsOf("desk").length;
    expect(await h.kernel.humanItems.decide(card.actionId, { optionId: "system.execute", seenItemRevision: h.kernel.humanItems.get(card.actionId)!.itemRevision, seenArtifactVersion: 2 }, "owner")).toEqual({ status: "approved" });
    await h.kernel.idle();
    expect(h.script.callsOf("desk")).toHaveLength(deskCalls);

    const [project] = projects(h);
    expect(project).toBeDefined();
    expect(h.kernel.getCell(project!)).toMatchObject({ preset: "project", status: "active", parentId: "desk" });
    expect(h.project(project!)).toMatchObject({
      title: "排查注册转化率下跌",
      outcome: "找到下跌原因并给出修复方案",
      lifecycle: "active",
      source: { label: "信源 · 注册转化率下跌" },
      proposal: { actions: expect.arrayContaining([expect.objectContaining({ title: "确认埋点没有漏报" })]) },
    });
    // The approved plan is on the project's books; the project decides when each step is dispatched.
    const acts = h.actions(project);
    expect(acts.map((a) => [a.title, a.owner, a.status, a.nextStep ?? null])).toEqual([
      ["拉取近两周注册漏斗数据，定位下跌环节", "agent", "open", null],
      ["确认埋点没有漏报", "agent", "open", null],
      ["和增长组同步结论", "human", "open", "约增长组开 15 分钟短会"],
    ]);
    expect(acts.every((a) => a.projectCellId === project)).toBe(true);
    expect(h.kernel.humanItems.get(acts.find(a => a.owner === "human")!.id)).toMatchObject({
      relatedProjectIds: [project], category: "action", title: "和增长组同步结论", effort: "15m",
    });
    expect(h.cards()).toEqual([]);
    expect(h.notices()).toContain("已立项：排查注册转化率下跌，后台开始推进");
  });

  it("observe mode: a hit only goes to the observation notes, never to the desk", async () => {
    const h = await boot({
      setup: (r) => r.codeProcessors.register(defineSensorCheck("test.group", () => ({ title: "支付报错", summary: "有人说付款页面白屏" }))),
    });
    h.script.add("desk", tool("add_source", { title: "研发群反馈", watchThread: "memory:dev-group", check: "test.group", mode: "observe" }), {});
    await h.ui.capture({ text: "盯一下研发群有没有人反馈支付报错，先观察两天别弹卡" }, "owner");
    await h.kernel.idle();
    const [sensor] = sensorsOf(h);
    const deskRuns = h.deskRuns();

    await h.memory.inject({ from: "dev1", text: "付款页面白屏了", threads: ["memory:dev-group"] });
    await h.kernel.idle();

    expect(h.source(sensor!)).toMatchObject({ mode: "observe", runCount: 1, hitCount: 1 });
    expect(h.deskRuns()).toBe(deskRuns);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.sourceHit })).toEqual([]);
    expect(h.cards()).toEqual([]);
    const note = h.kernel.context.getKnowledgeSync({ kind: "reference", name: OBSERVATION_NOTE, scope: "cell", cellId: sensor! });
    expect(note?.body).toContain("有人说付款页面白屏");
    expect(h.notices()).toEqual(["已添加信源：研发群反馈（观察模式，只记笔记不出卡）"]);
  });

  it("a failing check marks the source as erroring without creating an item", async () => {
    const h = await boot({
      setup: (r) =>
        r.codeProcessors.register(
          defineSensorCheck("test.broken", () => {
            throw new Error("metrics API 502");
          }),
        ),
    });
    h.script.add("desk", tool("add_source", { title: "指标", cron: "0 9 * * 1", tz: "Asia/Shanghai", check: "test.broken" }), {});
    await h.ui.capture({ text: "每周一查指标" }, "owner");
    await h.kernel.idle();
    const [sensor] = sensorsOf(h);
    h.clock.set(MONDAY_9);
    await h.kernel.idle();
    expect(h.source(sensor!)).toMatchObject({ status: "error", lastError: "metrics API 502", runCount: 1, hitCount: 0 });
    expect(h.cards()).toEqual([]);
  });
});

describe("docs/03 §四 row 2 — personal zero-side-effect items: done at once, no card", () => {
  it("a link for the reading list: note + activity + light notice, no owner decision", async () => {
    const h = await boot();
    h.script.add(
      "desk",
      tool("capture_note", { title: "Agent 架构长文", url: "https://example.com/post", list: "阅读清单" }),
      {},
    );
    const env = await h.ui.capture({ text: "把这篇链接存进阅读清单 https://example.com/post" }, "owner");
    await h.kernel.idle();

    expect(h.cards()).toEqual([]);
    const [a] = h.activities();
    expect(a).toMatchObject({
      kind: "note_saved",
      title: "已存入阅读清单：Agent 架构长文",
      detail: "https://example.com/post",
      source: { label: "随手记", channelId: "ui" },
      rawInput: "把这篇链接存进阅读清单 https://example.com/post",
      restorable: true,
      envelope: { id: env.id },
    });
    expect(h.notices()).toEqual(["已存入阅读清单：Agent 架构长文"]);
    const note = h.kernel.context.getKnowledgeSync({ kind: "reference", name: "阅读清单", scope: "cell", cellId: "desk" });
    expect(note?.body).toContain("Agent 架构长文 https://example.com/post");
  });

  it("a reminder: set at once with a light notice; when it fires it becomes a quick to-do, still no card", async () => {
    const h = await boot();
    h.script.add("desk", tool("remind_me", { text: "给牙医打电话约时间", at: "2026-11-20T15:00:00+08:00" }), {});
    await h.ui.capture({ text: "周五下午 3 点提醒我给牙医打电话" }, "owner");
    await h.kernel.idle();

    const remindAt = Date.parse("2026-11-20T15:00:00+08:00");
    expect(h.cards()).toEqual([]);
    expect(h.activities()).toEqual([
      expect.objectContaining({ kind: "reminder_set", title: "已设好提醒：给牙医打电话约时间", detail: "11月20日周五 15:00", remindAt, restorable: false }),
    ]);
    expect(h.notices()).toEqual(["已设好 11月20日周五 15:00 的提醒：给牙医打电话约时间"]);
    expect(h.actions("desk")).toEqual([]);

    // It fires: the desk's books turn it into a quick human action + the reminder itself; the model is not woken.
    const deskCalls = h.script.callsOf("desk").length;
    h.clock.set(remindAt);
    await h.kernel.idle();
    expect(h.script.callsOf("desk")).toHaveLength(deskCalls);
    const acts = h.kernel.humanItems.list();
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ title: "给牙医打电话约时间", cellId: null, status: "pending", effort: "15m", dueAt: remindAt });
    expect(h.notices().at(-1)).toBe("⏰ 提醒：给牙医打电话约时间");
    expect(h.cards()).toEqual([]);

    // Applying the same wake-up twice changes nothing (any desk tool settles it first).
    expect(h.kernel.context.listStateSync("desk", gtdKeys.actionPrefix)).toHaveLength(0);
  });

  it("a reminder becomes a to-do when it fires even if the model ignores the wake-up it shares with a new item", async () => {
    const h = await boot();
    h.script.add("desk", tool("remind_me", { text: "交房租", inMinutes: 60 }), {});
    await h.ui.capture({ text: "一小时后提醒我交房租" }, "owner");
    await h.kernel.idle();
    // The desk is busy with one item while the reminder comes due and another message arrives: both land in one batch,
    // and the model answers it with no desk tool at all.
    let release!: () => void;
    const busy = new Promise<void>((r) => (release = r));
    h.script.add("desk", async () => {
      await busy;
      return {};
    });
    h.script.add("desk", (req) => {
      expect(JSON.stringify(req.messages)).toContain("下午开会记得带电脑");
      return {};
    });
    await h.ui.capture({ text: "帮我想想周报怎么写" }, "owner");
    while (h.script.callsOf("desk").length < 3) await new Promise((r) => setTimeout(r, 5));
    h.clock.advance(60 * 60_000);
    await h.ui.capture({ text: "下午开会记得带电脑" }, "owner");
    release();
    await h.kernel.idle();
    expect(h.script.callsOf("desk")).toHaveLength(4);
    expect(h.kernel.humanItems.list()).toEqual([expect.objectContaining({ title: "交房租", cellId: null, status: "pending", dueAt: T0 + 60 * 60_000 })]);
    expect(h.notices()).toContain("⏰ 提醒：交房租");
    expect(h.kernel.context.listStateSync("desk", "desk:reminder:")).toEqual([]);
  });
});
