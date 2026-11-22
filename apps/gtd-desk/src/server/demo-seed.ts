// The demo seed: a few days of the workbench (docs/03's inbox scenarios and docs/05's projects) played through the real
// kernel, the real presets and the app's own endpoints — owner captures through the 随手记 channel, colleagues and
// suppliers through a MemoryChannel, the desk answering from the DemoBrain's queue, projects and workers from their
// plans (registerPlans), buttons pressed through the Desk (the same functions the HTTP API calls). Nothing is written
// into the records directly. The story starts three days ago (DemoClock) and catches up with the real time at the
// end, so timers, deadlines and the morning check really fire on the way.

import type { Kernel } from "@ng/cell";
import type { MemoryChannel } from "@ng/channel";
import { defineSensorCheck } from "@ng/presets";
import type { ScriptTurn } from "@ng/loop";
import { asClarifyCard, subjectKeys, type Clock } from "@ng/protocol";
import type { Desk } from "./desk";
import { zonedParts, zonedTime, type DemoBrain } from "./demo-model";

/** Desk state key marking a data directory the demo seeded (never seeded twice, never mixed into real data). */
export const DEMO_SEED_KEY = "demo:seed";
export const DEMO_SEED_VERSION = 2;
export const DEMO_CHANNEL_ID = "demo";
export const DEMO_METRICS_CHECK = "demo.metrics_check";
export const DEMO_PAYMENT_CHECK = "demo.payment_callback_check";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

/**
 * Real time plus an offset that only ever shrinks towards zero: a fresh demo starts in the past and `jumpTo` moves it
 * forward (never beyond real time) while the seed plays the story; afterwards it is the system clock.
 */
export class DemoClock implements Clock {
  #offset: number;

  constructor(startAt?: number) {
    this.#offset = startAt === undefined ? 0 : Math.min(0, startAt - Date.now());
  }

  now(): number {
    return Date.now() + this.#offset;
  }

  /** Set the story's start, before anything has read this clock (boot does it before the database opens). */
  startFrom(t: number): void {
    this.#offset = Math.min(0, t - Date.now());
  }

  /** Still behind real time (a seed can replay the story). */
  get travelling(): boolean {
    return this.#offset < 0;
  }

  jumpTo(t: number): void {
    const off = Math.min(t, Date.now()) - Date.now();
    if (off > this.#offset) this.#offset = off;
  }

  catchUp(): void {
    this.#offset = 0;
  }
}

/** Local 08:00 three days ago: where a fresh demo's story begins. */
export function demoStart(timeZone: string, now = Date.now()): number {
  const p = zonedParts(now, timeZone);
  return zonedTime(timeZone, p.y, p.mo, p.d - 3, 8, 0);
}

/** The zero-token morning check of the demo's metrics source: everything is normal, so it stays silent. */
export const demoMetricsCheck = defineSensorCheck(DEMO_METRICS_CHECK, () => null, "演示：核心指标（注册、下单、支付成功率）都正常，静默结束");

/** What the weekly review offers instead of the model filter of the payment-error source: a fixed rule, zero tokens. */
export const demoPaymentCheck = defineSensorCheck(
  DEMO_PAYMENT_CHECK,
  ({ due }) => {
    for (const env of due) {
      const text = (env.payload as { text?: unknown } | null)?.text;
      if (typeof text === "string" && /回调/.test(text) && /500|报错|异常/.test(text)) return { title: "研发群：支付回调报错", summary: text, rawInput: text };
    }
    return null;
  },
  "演示：消息里同时出现“回调”和“500/报错”即命中",
);

export interface DemoSeedDeps {
  kernel: Kernel;
  desk: Desk;
  im: MemoryChannel;
  brain: DemoBrain;
  clock: DemoClock;
  timeZone: string;
  log: (line: string) => void;
}

const MINIMAL_REPORT = [
  "# 极简模式调研报告",
  "",
  "## 结论",
  "先做一个“极简档”：只保留最近 3 轮对话上下文、关闭自动预读整个仓库、默认用小模型，预计能省 60% 左右的 Token。",
  "",
  "## 其他产品的做法",
  "- Cursor：Ask 模式只读当前文件和显式 @ 的文件；",
  "- Aider：/tokens 实时显示消耗，--map-tokens 限制仓库地图大小；",
  "- Claude Code：/compact 手动压缩上下文，子任务交给子代理以免主会话膨胀。",
  "",
  "## 建议的阶段",
  "1. 极简档开关 + 上下文轮数上限；",
  "2. 消耗看板（每个事项花了多少）；",
  "3. 按事项自动选择模型档位。",
].join("\n");

const HARNESS_REPORT_V1 = [
  "# Harness 对比报告（v1：trae 部分）",
  "",
  "## trae cli / trae ide",
  "- 工具调用走统一的 ToolRegistry，权限在执行前按工作目录校验；",
  "- 长任务拆成子会话，主会话只保留摘要；",
  "- 失败重试由 harness 统一做，最多 3 次。",
  "",
  "## Doubao work",
  "（代码还没拿到，等主人要来后补上）",
].join("\n");

/** The plans of the demo's projects and the fixed outcomes of their workers (matched by a phrase of their brief / task). */
function registerPlans(brain: DemoBrain, o: { quoteDue: string }): void {
  const t = (name: string, input: unknown = {}): ScriptTurn => ({ toolCalls: [{ name, input }] });
  const quote = (who: string, id: string) =>
    t("await_reply", {
      who,
      description: `等${who}的压测服务器报价`,
      thread: `${DEMO_CHANNEL_ID}:quote-${id}`,
      principalId: `${DEMO_CHANNEL_ID}:${id}`,
      to: `channel:${DEMO_CHANNEL_ID}:${id}`,
      dueAt: o.quoteDue,
      nudgeText: "您好，想跟进一下压测服务器（8 核 32G × 6 台，租 3 个月）的报价，方便的话今天回复一下，谢谢！",
    });
  brain.projects.push(
    // An idea for later: research, a report, parked as someday (docs/05 scenario 5).
    {
      key: "极简模式",
      first: [t("dispatch", { title: "调研其他产品的极简模式", instruction: "调研对象：极简模式。看看其他 AI 编程产品怎么帮用户省 Token，写一份调研报告（存成 artifact），给出建议的阶段。" })],
      afterResult: [
        [
          t("update_project", { summary: "调研报告已完成：建议先做“极简档”（只留最近 3 轮上下文、关闭自动预读）" }),
          t("finish_project", { outcome: "someday", summary: "调研报告「极简模式调研报告」已存好，先放进以后再说；重新启动时按报告里的三个阶段推进", retro: "none — 这个项目里主人没有追加新的做事习惯" }),
        ],
      ],
    },
    // Partly runnable now, partly waiting on the owner (docs/05 scenario 1).
    {
      key: "Harness 对比",
      first: [
        t("track_action", { title: "要 Doubao work 的代码", owner: "human", nextStep: "找张三要 Doubao work 的代码，放到 ~/code/doubao，然后在这里勾掉", effort: "15m" }),
        t("dispatch", { title: "分析 trae 的 harness 实现", instruction: "分析对象：trae harness。读本地 trae cli / trae ide 的代码，写对比报告的 trae 部分（存成 artifact）。" }),
        t("update_project", { summary: "trae 部分正在分析；Doubao work 的代码要等你要来" }),
      ],
      afterResult: [
        [
          t("update_project", { summary: "trae 部分已分析完（报告 v1）；等你要来 Doubao work 的代码再继续" }),
          t("wait", { reason: "等主人要来 Doubao work 的代码", waitingFor: "human" }),
        ],
        [
          t("update_project", { summary: "两边都分析完了，对比报告已更新到 v2" }),
          t("track_action", { title: "看 Harness 对比报告 v2", owner: "human", nextStep: "读对比报告（art_demo_harness v2），有要补充的分析告诉我", effort: "45m" }),
        ],
      ],
      afterOwner: [
        [
          t("dispatch", {
            title: "分析 Doubao work 的 harness 实现",
            instruction: "分析对象：Doubao work harness。主人已把代码放到 ~/code/doubao。读 read_artifact art_demo_harness（v1）后，补上 Doubao work 部分，保存为 v2。",
          }),
        ],
      ],
    },
    // Waiting on three suppliers' replies (zero-token reply watchers).
    {
      key: "压测服务器采购比价",
      first: [quote("星河数据", "xinghe"), quote("云桥科技", "yunqiao"), quote("北辰网络", "beichen"), t("update_project", { summary: "已向三家供应商要报价，等回信" })],
      afterResult: [[t("update_project", { summary: "星河数据已报价（1280 元/台/月），等云桥、北辰" })], [t("update_project", { summary: "星河、云桥已报价（云桥最便宜：1150 元/台/月），等北辰网络" })], [t("update_project", { summary: "三家都报价了，可以比价了" })]],
    },
    // Running right now: one worker reported, the next one is still at it.
    {
      key: "排查支付回调偶发 500",
      first: [t("dispatch", { title: "复现并定位支付回调 500", instruction: "排查对象：支付回调偶发 500。复现、定位原因，不改代码，汇报原因和证据。" })],
      afterResult: [
        [
          t("update_project", { summary: "已定位：并发回调时幂等键 60 秒就过期；正在修复并补测试" }),
          t("dispatch", { title: "修复幂等键过期并补并发测试", instruction: "修复对象：支付回调幂等键。把幂等键 TTL 改为 24 小时，落库前加唯一索引兜底，补并发回调单测；改完汇报分支和验证结果。" }),
        ],
        [
          t("update_project", { summary: "已修复并补了 3 个并发测试，等你看一下改动" }),
          t("track_action", { title: "看一下支付回调的修复改动", owner: "human", nextStep: "看后台分支上的改动，没问题就合入", effort: "15m" }),
        ],
      ],
    },
  );
  brain.workers.push(
    { key: "调研对象：极简模式", artifact: { id: "art_demo_minimal", title: "极简模式调研报告", body: MINIMAL_REPORT }, result: "调研完成：报告「极简模式调研报告」（art_demo_minimal）。结论：先做极简档，预计省 60% Token；建议分三个阶段。" },
    { key: "分析对象：trae harness", artifact: { id: "art_demo_harness", title: "Harness 对比报告", body: HARNESS_REPORT_V1 }, result: "trae 部分分析完：报告 art_demo_harness v1。要点：统一 ToolRegistry、长任务拆子会话、harness 统一重试。" },
    {
      key: "分析对象：Doubao work harness",
      artifact: { id: "art_demo_harness", title: "Harness 对比报告", expectedVersion: 1, body: `${HARNESS_REPORT_V1.replace("（代码还没拿到，等主人要来后补上）", "- 工具调用直接走模型的 function calling，没有统一注册表；\n- 没有子会话，长任务靠上下文压缩；\n- 重试由各工具自己做。")}\n\n## 结论\ntrae 的 harness 更适合多阶段长任务；Doubao work 更轻。` },
      result: "Doubao work 部分已补上，报告 art_demo_harness 更新到 v2。",
    },
    { key: "排查对象：支付回调偶发 500", result: "已复现：并发回调时幂等键 60 秒就过期，同一笔回调被处理两次，第二次写库撞唯一约束返回 500。证据：order-service 日志 23:40 的两条同 trade_no 记录。" },
    {
      key: "修复对象：支付回调幂等键",
      progress: { text: "已改好 TTL 和唯一索引，正在跑并发测试", done: 1, total: 2, label: "修复中" },
      result: "已修复：幂等键 TTL 从 60 秒改为 24 小时，落库前加唯一索引兜底；新增 3 个并发回调单测，全部通过。改动在分支 fix/payment-callback-idempotency 上，等你看过再合入。",
      finishAfterMs: 12 * MIN,
    },
  );
  brain.sensorRules.push(
    { match: /导出.*(卡|超时|失败|慢)/, title: "客服反复反馈：报表导出卡住", summary: "本周第 3 次有客户反馈报表导出超过 1 万行就卡住，集中在月底对账场景。" },
    { match: /(支付|回调).*(500|报错|异常)|(500|报错).*(支付|回调)/, title: "研发群：支付回调报错", summary: "有人在研发群里提到支付回调返回 500。" },
  );
}

/** Runs the story. Assumes a fresh data directory and a travelling DemoClock. */
export async function seedDemo(d: DemoSeedDeps): Promise<void> {
  const { kernel, desk, im, brain, clock, timeZone, log } = d;
  const end = Date.now();
  const today = zonedParts(end, timeZone);
  /** Local time `h:m` on day `day` relative to today (never later than now). */
  const at = (day: number, h: number, m = 0) => Math.min(zonedTime(timeZone, today.y, today.mo, today.d + day, h, m), end - 5 * MIN);
  const iso = (t: number) => new Date(t).toISOString();
  const quoteDue = Math.max(zonedTime(timeZone, today.y, today.mo, today.d + 1, 12, 0), end + 6 * HOUR);
  registerPlans(brain, { quoteDue: iso(quoteDue) });

  const idle = () => kernel.idle({ timeoutMs: 30_000 });
  async function step(t: number): Promise<void> {
    clock.jumpTo(t);
    await idle();
  }
  function drained(what: string): void {
    const left = brain.drainDesk();
    if (left.length) log(`demo seed: ${what} left ${left.length} scripted desk turn(s) unused`);
  }
  async function owner(t: number, text: string, ...turns: ScriptTurn[]): Promise<string> {
    await step(t);
    brain.queueDesk(...turns);
    const r = await desk.ingest({ text },{principalId:desk.ownerPrincipal});
    await idle();
    drained(text.slice(0, 12));
    return r.id;
  }
  async function says(t: number, from: string, text: string, o: { thread: string; to?: string }, ...turns: ScriptTurn[]): Promise<string> {
    await step(t);
    brain.queueDesk(...turns);
    const env = await im.inject({ from, text, threads: [o.thread], ...(o.to ? { replyTarget: o.to } : {}) });
    await idle();
    drained(`${from}: ${text.slice(0, 12)}`);
    return env.id;
  }
  const t = (name: string, input: unknown = {}): ScriptTurn => ({ toolCalls: [{ name, input }] });
  const card = (subjectKey: string) => {
    const rec = kernel.gate.findPendingBySubjectSync(subjectKey) ?? (subjectKey.startsWith("msg:")
      ? kernel.gate.listPendingSync().find(r => asClarifyCard(r.card.data)?.source.envelopeId === subjectKey.slice(4))
      : undefined);
    if (!rec) throw new Error(`demo seed: no pending card for ${subjectKey}`);
    return rec;
  };
  const version = (artifactId: string | null) => (artifactId ? (kernel.context.getArtifactSync(artifactId)?.version ?? null) : null);
  const ownerActor = { principalId: desk.ownerPrincipal };
  const approve = async (subjectKey: string) => {
    const rec = card(subjectKey);
    const r = await desk.approve(rec.actionId, { seenVersion: version(rec.artifactId), seenItemRevision: rec.itemRevision }, ownerActor);
    if (!r.ok) log(`demo seed: approving "${rec.action.summary}" → ${r.outcome}`);
    await idle();
  };
  const project = (title: string, brief: string, extra: Record<string, unknown> = {}) => t("start_project", { title, outcome: title, brief, ...extra });
  const projectTitled = (title: string) => projectTitledIn(kernel, title);
  const sensorTitled = (title: string) => kernel.listCells({ parentId: kernel.deskCellId, preset: "sensor" }).find((c) => c.title === title)?.id;

  // ==================== day -3: sources (docs/03 原则 1) and a hub ====================
  await owner(
    at(-3, 9, 5),
    "每天早上 9 点帮我看一眼核心指标（注册、下单、支付成功率），正常就别打扰我",
    t("add_source", { title: "核心指标巡检", description: "注册、下单、支付成功率任一项环比下跌超过 10% 才算异常", cron: "0 9 * * *", tz: timeZone, check: DEMO_METRICS_CHECK }),
  );
  await owner(
    at(-3, 9, 20),
    "客服群里要是有客户反复反馈同一个问题，帮我捞出来",
    t("add_source", { title: "客服群反馈挖掘", description: "客户反复反馈的同一类问题（导出、对账、性能），偶发一次的不算", watchThread: "demo:support-group" }),
  );
  await owner(
    at(-3, 9, 25),
    "研发群里帮我盯一下有没有人说支付回调报错。这个探头还不太准，先只记观察笔记，别弹卡",
    t("add_source", { title: "研发群支付报错探头", description: "研发群里提到支付回调报错 / 500", watchThread: "demo:dev-group", mode: "observe" }),
  );
  await owner(
    at(-3, 9, 40),
    "代码评审群里 @我 的 review 请求，以后直接派人去看，不用经过信箱",
    t("add_hub", {
      title: "代码评审直通",
      repos: [{ name: "backend", cwd: "/srv/code/backend", defaultBranch: "develop" }],
      rules: "评审群里 @我 的 MR：派只读 worker 评审，把意见草稿发回 MR 讨论串（主人确认后发出）。",
      watch: { thread: "demo:review-group" },
      coalesceMinutes: 2,
    }),
  );

  // ==================== day -3: small things (原则 2) and a routine reply ====================
  const qa = await says(at(-3, 10, 10), "chenxiao", "灰度环境的发版窗口还是周四晚上 8 点吗？", { thread: "demo:dm-chenxiao" },
    t("draft_reply", { text: "是的，还是周四晚上 8 点。记得提前在群里同步一下这次的回归范围。", title: "回复陈晓：灰度发版窗口", targetLabel: "陈晓（测试）", prep: { summary: "核对了发布日历，本周没有调整。", checked: [{ label: "发布日历", uri: "https://wiki.example.com/release-calendar" }] } }),
  );
  await approve(subjectKeys.inbound(qa));
  await says(at(-3, 10, 40), "ci-bot", "【CI】main 分支构建通过 #1287（耗时 6 分 12 秒）", { thread: "demo:ci" }, t("archive_notification", { title: "CI：main 分支构建通过 #1287" }));
  await owner(
    at(-3, 11, 0),
    "https://martinfowler.com/articles/patterns-of-distributed-systems/ 这篇存进阅读清单，周末看",
    t("capture_note", { title: "分布式系统模式（Martin Fowler）", url: "https://martinfowler.com/articles/patterns-of-distributed-systems/", content: "周末看", list: "阅读清单" }),
  );

  // ==================== day -2: a reply that waits, a source hit → proposal, observe-mode notes ====================
  await says(at(-2, 9, 30), "wangmin", "订单导出接口下周能支持按门店筛选吗？客户那边在催", { thread: "demo:dm-wangmin" },
    t("draft_reply", {
      text: "可以，下周三前上线按门店筛选，参数是 store_ids（可多选）。超过 5 万行的导出会走异步任务，完成后发站内信通知。",
      title: "回复王敏：导出按门店筛选",
      targetLabel: "王敏（产品）",
      prep: { summary: "查了需求池和导出接口现状：筛选只需在查询层加条件，大数据量已有异步导出通道。", checked: [{ label: "需求池 PRD-342", uri: "https://wiki.example.com/prd/342" }, { label: "order/export.ts", uri: "https://git.example.com/backend/order/export.ts" }] },
    }),
  );
  await says(at(-2, 10, 5), "kf-zhou", "有客户问发票抬头在哪里改", { thread: "demo:support-group", to: "support-group" });
  await says(at(-2, 10, 15), "kf-liu", "又有客户说报表导出超过 1 万行就卡住，今天第 3 个了", { thread: "demo:support-group", to: "support-group" },
    t("propose_project", {
      title: "报表导出性能优化",
      outcome: "1 万行以上的报表导出 10 秒内完成，或自动转异步，不再卡死",
      background: "客服群本周第 3 次反馈：报表导出超过 1 万行就卡住，集中在月底对账",
      actions: [
        { title: "分析导出慢查询，给出优化方案", owner: "agent" },
        { title: "和王敏确认导出行数上限与异步通知文案", owner: "human", effort: "15m", nextStep: "约王敏聊 15 分钟" },
        { title: "压测验证 5 万行导出", owner: "agent" },
      ],
      prep: { summary: "看了客服群近一周的反馈和导出接口的慢查询日志：瓶颈在一次性加载全部明细。", checked: [{ label: "慢查询日志（近 7 天）", uri: "https://grafana.example.com/d/slow-sql" }] },
    }),
  );
  for (const [i, [who, text]] of ([
    ["zhaolei", "今天午饭有人一起吗"],
    ["sunhao", "支付回调昨晚 23:40 报了一批 500，重试后都成功了"],
    ["zhaolei", "发版检查清单放哪了？"],
    ["sunhao", "回调 500 今早又出现 2 次，先记一下"],
  ] as const).entries()) {
    await says(at(-2, 11, 10 * i), who, text, { thread: "demo:dev-group", to: "dev-group" });
  }

  // ==================== day -2: an idea for later, and work that waits on the owner ====================
  await owner(
    at(-2, 14, 0),
    "/todo 最近 Token 用得有点多，以后可能做个极简模式，先记一下",
    project("极简模式", "主人的原话：最近 Token 用得有点多，以后可能做个极简模式，先记一下。先调研其他产品怎么做，出一份报告就停，放进以后再说。", { mode: "research_then_park", outcome: "一份极简模式的调研报告，说明该做成什么样" }),
  );
  await owner(
    at(-2, 15, 30),
    "Harness 对比的事明天开始做：trae cli / trae ide 的代码本地有，Doubao work 的代码我还没有，要找张三要",
    project("Harness 对比", "主人的原话：Harness 对比的事明天开始做：trae cli / trae ide 的代码本地有，Doubao work 的代码我还没有，要找张三要。先把能做的 trae 部分分析了，Doubao 的部分等主人要来代码再做；最后给一份对比报告。", { outcome: "一份 trae 与 Doubao work 的 harness 对比报告" }),
  );

  // ==================== day -1: the CTO's question → 我来处理, edited, a follow-up parked beside it ====================
  await step(at(-1, 9, 30));
  const cto = await says(at(-1, 9, 40), "lizong", "数据库从 MySQL 5.7 升 8.0 的迁移方案，周四前能定吗？", { thread: "demo:dm-lizong" },
    t("draft_reply", {
      title: "回复李总：MySQL 8.0 迁移方案",
      targetLabel: "李总（CTO）",
      text: [
        "李总，方案周四前可以定。目前的安排：",
        "",
        "1. 先在预发环境全量回放一周流量，验证 SQL 兼容性（已发现 3 处依赖 GROUP BY 隐式排序的查询，需要改）；",
        "2. 正式迁移走主从切换，回滚预案是切回旧主库，数据用 binlog 追平。",
        "",
        "> [!DECISION] 迁移窗口二选一",
        "> A. 周六凌晨 2 点停机切换：快，但要停服约 10 分钟",
        "> B. 双写灰度一周：不停服，多 3 人日开发",
        "",
        "我倾向 B，周四前给您完整方案和回滚演练记录。",
      ].join("\n"),
      prep: { summary: "查了 SQL 兼容性扫描结果和上次大版本升级的复盘。", checked: [{ label: "SQL 兼容性扫描", uri: "https://wiki.example.com/db/mysql8-compat" }, { label: "2025 升级复盘", uri: "https://wiki.example.com/db/upgrade-retro" }] },
    }),
  );
  {
    const rec = card(subjectKeys.inbound(cto));
    const art = kernel.context.getArtifactSync(rec.artifactId!)!;
    desk.saveArtifact(art.artifactId, { expectedVersion: art.version, body: art.content.body.replace("我倾向 B，", "我倾向 B（DBA 也建议双写），") },{principalId:desk.ownerPrincipal});
  }
  await says(at(-1, 10, 30), "lizong", "补充一下：下周六有大促，停机窗口必须避开", { thread: "demo:dm-lizong" },
    t("draft_reply", {
      text: [
        "李总，收到，停机方案会避开下周六大促。目前的安排：",
        "",
        "1. 预发环境全量回放一周流量，验证 SQL 兼容性；",
        "2. 正式迁移走主从切换，回滚切回旧主库。",
        "",
        "> [!DECISION] 迁移窗口",
        "> 大促前只剩双写灰度（B）可选；若坚持停机（A），只能放到大促后的周二凌晨",
        "",
        "建议直接走 B，周四前给您完整方案。",
      ].join("\n"),
    }),
  );

  // ==================== day -1: a question someone else answered; quotes; reminders ====================
  await says(at(-1, 11, 0), "zhaolei", "@我 网关限流阈值现在是多少？压测要用", { thread: "demo:backend-group", to: "backend-group" },
    t("draft_reply", { text: "目前网关限流是每实例 100 QPS，压测环境可以临时调到 500。", title: "回复后端群：网关限流阈值", targetLabel: "后端群", prep: { summary: "查了网关配置。", checked: [{ label: "gateway.yaml", uri: "https://git.example.com/infra/gateway.yaml" }] } }),
  );
  await says(at(-1, 11, 6), "sunhao", "每实例 100 QPS，压测环境我已经帮你调到 500 了", { thread: "demo:backend-group", to: "backend-group" }, t("withdraw_card", { reason: "孙浩已经在后端群里回答了" }));
  await owner(
    at(-1, 14, 0),
    "帮我盯一下三家供应商的压测服务器报价（星河数据、云桥科技、北辰网络），后天中午前要齐",
    project("压测服务器采购比价", "主人的原话：帮我盯一下三家供应商的压测服务器报价（星河数据、云桥科技、北辰网络），后天中午前要齐。需求：8 核 32G × 6 台，租 3 个月。", { outcome: "三家报价齐了，可以比价" }),
  );
  await says(at(-1, 14, 30), "xinghe", "星河数据报价：8 核 32G 每台每月 1280 元，含 200G SSD，起租 1 个月", { thread: `${DEMO_CHANNEL_ID}:quote-xinghe` });
  const zl = await says(at(-1, 15, 40), "zhaolei", "登录接口的错误码文档在哪？前端要对一下提示文案", { thread: "demo:dm-zhaolei" },
    t("draft_reply", { text: "在 Wiki 上。", title: "回复赵磊：登录错误码文档", targetLabel: "赵磊（前端）", prep: { summary: "找到了 Wiki 上的错误码页面。", checked: [{ label: "登录错误码", uri: "https://wiki.example.com/auth/error-codes" }] } }),
  );
  await says(at(-1, 16, 0), "yunqiao", "云桥科技：每台每月 1150 元，起租 3 个月，带宽另算", { thread: `${DEMO_CHANNEL_ID}:quote-yunqiao` });
  const hrAt = Math.max(at(-1, 16, 31) + HOUR, Math.min(zonedTime(timeZone, today.y, today.mo, today.d, 10, 0), end - 20 * MIN));
  await owner(at(-1, 16, 30), "明早 10 点提醒我给 HR 回电话，确认后端候选人周五的面试时间", t("remind_me", { text: "给 HR 回电话，确认后端候选人周五的面试时间", at: iso(hrAt), effort: "15m" }));
  await says(at(-1, 18, 0), "monitor-bot", "【监控】order-service P99 延迟 820ms，持续 3 分钟后已自动恢复", { thread: "demo:alerts" },
    t("archive_notification", { title: "监控：order-service P99 短暂升高，已自动恢复", detail: "持续 3 分钟，820ms" }),
  );

  // ==================== today: the morning inbox ====================
  await says(at(0, 8, 20), "ci-bot", "【CI】nightly 全量回归通过（1532 个用例，耗时 41 分钟）", { thread: "demo:ci" }, t("archive_notification", { title: "CI：nightly 全量回归通过", detail: "1532 个用例" }));
  await owner(
    at(0, 8, 30),
    "https://opentelemetry.io/docs/languages/js/ 存一下，APM 选型要看",
    t("capture_note", { title: "OpenTelemetry JS 文档（APM 选型）", url: "https://opentelemetry.io/docs/languages/js/", list: "阅读清单" }),
  );
  {
    // The owner rewrites a too-short draft before sending it (what the weekly review learns from).
    const rec = card(subjectKeys.inbound(zl));
    await step(at(0, 8, 50));
    desk.saveArtifact(rec.artifactId!, {
      expectedVersion: version(rec.artifactId)!,
      body: "在 Wiki「认证服务 / 登录错误码」这一页：https://wiki.example.com/auth/error-codes 。提示文案以第 3 列为准，40103 和 40104 这两个上周刚改过，注意一下。",
    },{principalId:desk.ownerPrincipal});
    await approve(subjectKeys.inbound(zl));
  }
  await step(at(0, 9, 10));
  await says(at(0, 9, 30), "wangmin", "补充：客户还想按日期区间筛选，能一起做吗？", { thread: "demo:dm-wangmin" },
    t("draft_reply", { text: "可以，下周三前一起上线：按门店（store_ids，可多选）和日期区间（start_date / end_date，最长 92 天）筛选。超过 5 万行的导出走异步任务，完成后发站内信通知。" }),
  );
  const s3 = sensorTitled("研发群支付报错探头");
  await owner(
    at(0, 9, 45),
    "帮我看看这周有什么可以沉淀下来的",
    t("review_week"),
    t("suggest_skill", {
      name: "reply-with-doc-links",
      description: "同事问“某某文档在哪”时使用",
      body: "- 直接给出页面路径和链接，不要只说“在 Wiki 上”\n- 指出以哪一列 / 哪一节为准\n- 最近改过的条目单独点名提醒",
      reason: "本周你把「在 Wiki 上。」改成了带页面路径、链接和注意事项的回复。",
    }),
    ...(s3 ? [t("suggest_code_check", { sourceId: s3, entry: DEMO_PAYMENT_CHECK, reason: "这个探头每次都用模型判断，其实规则很固定：消息里同时出现“回调”和“500/报错”就算命中，换成脚本检查零成本。" })] : []),
  );
  await owner(at(0, 10, 0), "周五下午 3 点提醒我约牙医", t("remind_me", { text: "约牙医", at: iso(fridayAt(timeZone, end, 15)), effort: "15m" }));

  // ==================== now: a project whose second worker is still at it ====================
  clock.catchUp();
  await idle();
  brain.queueDesk(
    project("排查支付回调偶发 500", "主人的原话：支付回调偶发 500，看日志像是幂等键冲突。帮我查一下原因并修掉，修好给我看改动。", { outcome: "回调不再报 500，改动等主人看过后合入" }),
  );
  await desk.ingest({ text: "支付回调偶发 500，看日志像是幂等键冲突。帮我查一下原因并修掉，修好给我看改动" },{principalId:desk.ownerPrincipal});
  const bug = await until(() => projectTitled("排查支付回调偶发 500"), "the bug-fix project");
  await until(() => !kernel.activeRuns().some((r) => r.cellId === kernel.deskCellId) || null, "the desk");
  drained("start_project");
  // The first worker reports; the project dispatches the fix, which takes a while (it is the "running" row).
  await until(() => kernel.listCells({ parentId: bug, status: ["active"] }).some((c) => c.title === "修复幂等键过期并补并发测试") || null, "the fix worker");
}

/** The project cell started for `title` under the desk, if any. */
function projectTitledIn(kernel: Kernel, title: string): string | null {
  return kernel.listCells({ parentId: kernel.deskCellId }).find((x) => x.title === title && x.spec.meta?.["role"] === "project")?.id ?? null;
}

/** The coming Friday at `hour` local time (next week's if this one has passed). */
function fridayAt(timeZone: string, now: number, hour: number): number {
  const p = zonedParts(now, timeZone);
  let t = zonedTime(timeZone, p.y, p.mo, p.d + ((5 - p.wd + 7) % 7), hour, 0);
  if (t <= now) t += 7 * DAY;
  return t;
}

/** Real-time polling for work the seed cannot idle() on (runs that take minutes on purpose); resolves with the value. */
async function until<T>(read: () => T | null | false, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v !== null && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`demo seed: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
