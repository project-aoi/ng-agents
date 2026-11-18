import { afterEach, describe, expect, it } from "vitest";
import type {
  ActivityListDTO,
  CaptureResponse,
  ClarifyMutationResponse,
  ClarifyQueueDTO,
  EngageDetailDTO,
  EngageListDTO,
  RadarDTO,
  SourcesDTO,
  StatusDTO,
  WeeklyReviewDTO,
} from "../src/shared/api";
import { createDeskServer, type DeskServer } from "../src/server/boot";
import { parseWhen, reminderText, zonedParts } from "../src/server/demo-model";
import { cleanupAll, tempDir } from "./helpers";

const servers: DeskServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  await cleanupAll();
});

const TZ = "Asia/Shanghai";
// As main.ts does for NG_DESK_TZ: the app's local-time projections (today, this week) follow the desk's zone.
process.env["TZ"] = TZ;

async function bootDemo(dataDir: string, logs: string[] = []): Promise<DeskServer> {
  const errors: string[] = [];
  const server = await createDeskServer({
    env: { NG_DESK_TZ: TZ },
    detectCli: () => false,
    dataDir,
    webDir: null,
    log: (l) => logs.push(l),
    onError: (err, where) => errors.push(`${where}: ${err instanceof Error ? err.message : String(err)}`),
  });
  // Errors after boot (e.g. a Run that fails later) are not the seed's; the seed itself must have been clean.
  expect(errors).toEqual([]);
  return server;
}

function api(server: DeskServer) {
  return {
    async get<T>(path: string): Promise<T> {
      const res = await server.app.request(path);
      expect(res.status, path).toBe(200);
      return (await res.json()) as T;
    },
    async post<T>(path: string, body: unknown = {}): Promise<T> {
      const res = await server.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(res.status, path).toBe(200);
      return (await res.json()) as T;
    },
  };
}

/** Polls until the condition holds (the demo's background runs in real time). */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("demo mode: the workbench's scenarios played through the real kernel and presets", () => {
  it("every view has content after the seed, and a restart on the same data directory does not seed again", async () => {
    const dataDir = tempDir("demo");
    const logs: string[] = [];
    const server = await bootDemo(dataDir, logs);
    cleanupAfter(server);
    expect(logs.some((l) => l.startsWith("demo: seeded"))).toBe(true);
    expect(logs.some((l) => l.includes("left") && l.includes("unused"))).toBe(false);
    const d = api(server);

    const status = await d.get<StatusDTO>("/api/status");
    expect(status).toMatchObject({ demo: true, backend: "demo" });
    expect(status.notifications.length).toBeGreaterThan(5);
    expect(status.today.archivedNotifications).toBeGreaterThan(0);
    expect(status.background.running).toBeGreaterThan(0);

    // 📥 Clarify: a reply waiting for the owner (redrafted after a follow-up) and a proposal raised by a source hit.
    const clarify = await d.get<ClarifyQueueDTO>("/api/clarify");
    const byType = (t: string) => clarify.cards.filter((c) => c.cardType === t);
    const reply = byType("response").find((c) => c.reply?.confirmVerb === "send");
    expect(reply).toMatchObject({ title: "回复王敏：导出按门店筛选", state: "pending", sourceBar: { source: { label: "演示 IM" }, version: 2 } });
    expect(reply!.draft!.body).toContain("日期区间");
    expect(byType("project_proposal")).toEqual([expect.objectContaining({ title: "报表导出性能优化", sourceBar: expect.objectContaining({ source: expect.objectContaining({ label: "信源 · 客服反复反馈：报表导出卡住" }) }) })]);
    expect(byType("project_proposal")[0]!.proposal!.actions.map((a) => a.owner)).toEqual(["agent", "human", "agent"]);

    // 🎯 Engage: a reminder that came due, a project's human action, and one deep item with a decision passage and a
    // parked background addition.
    const engage = await d.get<EngageListDTO>("/api/engage");
    const quick = engage.items.filter((i) => i.kind === "quick");
    expect(quick.find((i) => i.title.startsWith("给 HR"))).toMatchObject({ overdue: true, source: { label: "定时提醒" }, project: null });
    expect(quick.find((i) => i.title === "要 Doubao work 的代码")).toMatchObject({ project: { title: "Harness 对比" } });
    const deep = engage.items.find((i) => i.kind === "deep")!;
    expect(deep).toMatchObject({ title: "回复李总：MySQL 8.0 迁移方案", send: { state: "ready" } });
    const detail = await d.get<EngageDetailDTO>(`/api/engage/${deep.cellId}/${deep.actionId}`);
    expect(detail.artifact).toMatchObject({ updatedBy: "human" });
    expect(detail.artifact!.decisions[0]).toMatchObject({ label: "迁移窗口二选一" });
    expect(detail.artifact!.decisions[0]!.text).toContain("双写灰度一周");
    expect(detail.artifact!.parked).toHaveLength(1);
    expect(detail.contextPack.references.length).toBeGreaterThan(0);
    expect(detail.contextPack.rawInput?.text).toContain("MySQL 5.7 升 8.0");

    // 🧭 Radar: a project running with one worker result in, one waiting on the owner, one waiting on a reply, and a
    // parked idea with its report.
    const radar = await d.get<RadarDTO>("/api/radar");
    const row = (title: string) => radar.projects.find((p) => p.title === title)!;
    expect(radar.projects.map((p) => p.title).sort()).toEqual(["Harness 对比", "压测服务器采购比价", "排查支付回调偶发 500"].sort());
    expect(row("排查支付回调偶发 500")).toMatchObject({ ball: { owner: "agent" }, summary: expect.stringContaining("已定位"), stalled: false });
    expect(row("排查支付回调偶发 500").workers).toEqual([expect.objectContaining({ title: "修复幂等键过期并补并发测试", state: "running" })]);
    expect(row("Harness 对比")).toMatchObject({ ball: { owner: "human", engage: expect.any(Object) }, summary: expect.stringContaining("trae 部分已分析完"), stalled: false });
    expect(row("压测服务器采购比价")).toMatchObject({ ball: { owner: "waiting" }, waiting: { replied: 0, total: 1 }, stalled: false });
    expect(row("压测服务器采购比价").ball!.text).toContain("北辰网络");
    expect(row("压测服务器采购比价").workers.map((w) => [w.preset, w.state])).toEqual([["watcher", "waiting"]]);
    expect(radar.someday).toEqual([expect.objectContaining({ title: "极简模式", lifecycle: "someday", paused: true, summary: expect.stringContaining("调研报告") })]);
    expect(radar.counts).toMatchObject({ active: 3, someday: 1, stalled: 0 });
    const report = await d.get<{ title: string; body: string }>("/api/artifacts/art_demo_minimal");
    expect(report).toMatchObject({ title: "极简模式调研报告" });
    expect(report.body).toContain("Cursor");

    // ⚡ Sources: a silent zero-token check, a model filter that hit once, an observe-mode probe, a hub.
    const sources = await d.get<SourcesDTO>("/api/sources");
    const sensor = (title: string) => sources.sensors.find((s) => s.title === title)!;
    expect(sensor("核心指标巡检")).toMatchObject({ processor: "code", hitCount: 0, status: "ok" });
    expect(sensor("核心指标巡检").runCount).toBeGreaterThanOrEqual(2);
    expect(sensor("客服群反馈挖掘")).toMatchObject({ mode: "active", hitCount: 1 });
    expect(sensor("研发群支付报错探头")).toMatchObject({ mode: "observe", runCount: 4, hitCount: 2 });
    expect(sensor("代码评审直通")).toMatchObject({ kind: "channel" });
    expect(sources.channels.map((c) => c.id)).toEqual(expect.arrayContaining(["ui", "demo"]));

    // Activity: archived notifications, saved notes, reminders, a withdrawn card, sent replies.
    const activity = await d.get<ActivityListDTO>("/api/activity");
    expect(activity.counts.notification_archived).toBeGreaterThanOrEqual(2);
    expect(activity.counts.note_saved).toBeGreaterThanOrEqual(1);
    expect(activity.counts.reminder_set).toBe(2);
    expect(activity.counts.card_withdrawn).toBe(1);
    expect(activity.counts.action_completed).toBeGreaterThanOrEqual(2);
    expect(activity.items.find((i) => i.kind === "card_withdrawn")).toMatchObject({ restorable: true, detail: "孙浩已经在后端群里回答了" });

    // Weekly review: a skill distilled from a rewritten reply, a zero-token check for the model-run probe.
    const review = await d.get<WeeklyReviewDTO>("/api/review");
    expect(review.skillSuggestions.map((s) => s.name)).toEqual(["reply-with-doc-links"]);
    expect(review.sensorSuggestions[0]).toMatchObject({ title: "研发群支付报错探头", entry: "demo.payment_callback_check" });
    expect(review.completed.length).toBeGreaterThanOrEqual(2);
    expect(review.editedDrafts).toBe(1);

    // Restart on the same directory: nothing is seeded twice.
    const before = { cards: clarify.remaining, projects: radar.projects.length, activity: activity.items.length };
    await server.close();
    const logs2: string[] = [];
    const again = await bootDemo(dataDir, logs2);
    cleanupAfter(again);
    expect(logs2.some((l) => l.startsWith("demo: seeded"))).toBe(false);
    const d2 = api(again);
    expect((await d2.get<ClarifyQueueDTO>("/api/clarify")).remaining).toBe(before.cards);
    expect((await d2.get<RadarDTO>("/api/radar")).projects).toHaveLength(before.projects);
    expect((await d2.get<ActivityListDTO>("/api/activity")).items).toHaveLength(before.activity);
  });

  it("answers live input: a link is saved, a reminder is set, anything else gets an honest demo note, a card can be revised, a ticked-off action moves its project on", async () => {
    const server = await bootDemo(tempDir("demo-live"));
    cleanupAfter(server);
    const d = api(server);
    const notices = async () => (await d.get<StatusDTO>("/api/status")).notifications.map((n) => n.text);

    await d.post<CaptureResponse>("/api/capture", { text: "https://example.com/rust-async 这篇存一下" });
    await eventually(notices, (n) => n.includes("已存入阅读清单：example.com/rust-async"), "the saved link");

    await d.post<CaptureResponse>("/api/capture", { text: "明天下午 4 点提醒我交报销" });
    const tomorrow = zonedParts(Date.now() + 24 * 3_600_000, TZ);
    await eventually(notices, (n) => n.some((t) => t.includes(`${tomorrow.mo}月${tomorrow.d}日`) && t.includes("16:00 的提醒：交报销")), "the reminder");

    await d.post<CaptureResponse>("/api/capture", { text: "下周的发布计划怎么排？" });
    await eventually(notices, (n) => n.some((t) => t.startsWith("（演示模式）")), "the demo note");
    expect((await d.get<ClarifyQueueDTO>("/api/clarify")).cards.some((c) => c.title.includes("发布计划"))).toBe(false);

    const card = (await d.get<ClarifyQueueDTO>("/api/clarify")).cards.find((c) => c.title === "回复王敏：导出按门店筛选")!;
    const r = await d.post<ClarifyMutationResponse>(`/api/clarify/${card.id}/revise`, { instruction: "语气再正式一点" });
    expect(r).toMatchObject({ ok: true, outcome: "revising" });
    const redrafted = await eventually(
      () => d.get<ClarifyQueueDTO>("/api/clarify"),
      (q) => q.cards.some((c) => c.id === card.id && c.state === "pending" && c.sourceBar.version === 3),
      "the redraft",
    );
    expect(redrafted.cards.find((c) => c.id === card.id)!.draft!.body).toMatch(/^您好，/);

    // The owner got the code: ticking the project's action off wakes it, it sends a worker on, the report grows.
    const action = (await d.get<EngageListDTO>("/api/engage")).items.find((i) => i.title === "要 Doubao work 的代码")!;
    await d.post(`/api/engage/${action.cellId}/${action.actionId}/done`, { note: "代码在 ~/code/doubao" });
    const radar = await eventually(
      () => d.get<RadarDTO>("/api/radar"),
      (v) => v.projects.some((p) => p.title === "Harness 对比" && p.summary?.includes("两边都分析完了") === true),
      "the Harness project moving on",
    );
    expect(radar.projects.find((p) => p.title === "Harness 对比")).toMatchObject({ ball: { owner: "human", text: expect.stringContaining("对比报告") }, stalled: false });
    expect(await d.get<{ version: number; body: string }>("/api/artifacts/art_demo_harness")).toMatchObject({ version: 2, body: expect.stringContaining("Doubao work") });
  });
});

describe("demo time words", () => {
  const now = Date.UTC(2026, 10, 17, 2, 0); // Tue 10:00 in Shanghai
  const local = (ms: number) => {
    const p = zonedParts(ms, TZ);
    return `${p.mo}/${p.d} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
  };
  it.each([
    ["周五下午 3 点提醒我约牙医", "11/20 15:00"],
    ["明早 10 点提醒我给 HR 回电话", "11/18 10:00"],
    ["下午三点半提醒我开会", "11/17 15:30"],
    ["早上 9 点提醒我", "11/18 09:00"],
    ["下周一提醒我交周报", "11/23 09:00"],
    ["20 分钟后提醒我喝水", "11/17 10:20"],
  ])("%s → %s", (text, expected) => {
    expect(local(parseWhen(text, now, TZ))).toBe(expected);
  });
  it("keeps what to do", () => {
    expect(reminderText("周五下午 3 点提醒我约牙医")).toBe("约牙医");
  });
});

function cleanupAfter(server: DeskServer): void {
  servers.push(server);
}
