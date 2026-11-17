// The demo seed: docs/03 §四's five scenarios played through the real kernel, the real presets and the app's own
// endpoints — owner captures through the 随手记 channel, colleagues and suppliers through a MemoryChannel, the desk
// answering from the DemoBrain's queue, buttons pressed through the Desk (the same functions the HTTP API calls).
// Nothing is written into the records directly. The story starts three days ago (DemoClock) and catches up with the
// real time at the end, so timers, deadlines and the morning check really fire on the way.

import type { Kernel } from "@ng/cell";
import type { MemoryChannel } from "@ng/channel";
import { defineSensorCheck, KEYS, type CoordinatorState } from "@ng/presets";
import type { ScriptTurn } from "@ng/loop";
import { subjectKeys, type Clock } from "@ng/protocol";
import type { Desk } from "./desk";
import { zonedParts, zonedTime, type DemoBrain } from "./demo-model";

/** Desk state key marking a data directory the demo seeded (never seeded twice, never mixed into real data). */
export const DEMO_SEED_KEY = "demo:seed";
export const DEMO_SEED_VERSION = 1;
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

/** The fixed outcomes of the demo's background workers (matched by a phrase of their task). */
function registerWorkers(brain: DemoBrain): void {
  brain.workers.push(
    // 调研 5 家 APM：all back at once → one summary card.
    { key: "对象：SkyWalking", result: "SkyWalking：开源，Java/Go 探针成熟，挂 Agent 即可接入，成本最低；告警基于 OAL 规则，够用但配置界面弱。自建需要 ES 集群，约 2 台 8C16G。" },
    { key: "对象：Pinpoint", result: "Pinpoint：调用链可视化最好，但依赖 HBase，运维成本高；告警能力弱，要二次开发。Node 服务没有官方探针。" },
    { key: "对象：Elastic APM", result: "Elastic APM：能复用现有 ELK 集群；Node/Go/Java 都有官方 Agent；告警走 Kibana Alerting。注意部分功能需要付费许可证。" },
    { key: "对象：Datadog", result: "Datadog：开箱即用、告警最强，但按主机计费，30 台主机每月约 1 万元以上；数据出境需要法务评估。" },
    { key: "对象：OpenTelemetry", result: "OpenTelemetry + Grafana Tempo：标准化最好、后端可替换；需要改代码埋点（约 3 人日），告警复用现有 Prometheus/Grafana。推荐作为长期方案。" },
    // Projects' agent actions.
    { key: "整理新人第一周任务清单", result: "新人第一周任务清单：Day1 开通账号、跑通本地环境；Day2 读订单与支付模块代码；Day3 跟一次发版；Day4 修一个 good-first-issue；Day5 和导师复盘。" },
    { key: "整理候选议题清单", result: "候选议题 6 个：1. MySQL 8.0 迁移踩坑；2. 支付回调幂等设计；3. 报表导出异步化；4. OpenTelemetry 落地；5. 前端微前端拆分；6. 灰度发布流程。建议选 1、2、4。" },
    // In progress right now: these take real time.
    {
      key: "支付回调偶发 500",
      progress: { text: "已复现：并发回调时幂等键 60 秒就过期，同一笔回调被处理两次", done: 1, total: 2, label: "已定位原因，正在补测试" },
      result: "已修复：幂等键 TTL 从 60 秒改为 24 小时，并在落库前加唯一索引兜底；新增 3 个并发回调单测，全部通过。改动在后台分支上，等你看过再合入。",
      finishAfterMs: 12 * MIN,
    },
    { key: "对象：账无忧", result: "账无忧：角色 + 数据范围（按门店/部门）两层，审批流里可以临时授权；没有字段级权限。" },
    { key: "对象：云算盘", result: "云算盘：经典 RBAC，12 个角色模板可自定义；数据权限只到组织级，不支持按门店。" },
    { key: "对象：票据通", result: "票据通：权限粒度到字段（金额字段可隐藏），并有权限变更审计日志——这一点我们缺。" },
    { key: "对象：财小蜜", result: "财小蜜：按岗位预置权限包，新人入职一键分配；不支持自定义角色。", finishAfterMs: 8 * MIN },
    { key: "对象：账房先生", result: "账房先生：RBAC + ABAC 混合，按金额阈值控制审批权限，配置复杂但灵活。", finishAfterMs: 15 * MIN },
    { key: "对象：易对账", result: "易对账：只有管理员/普通成员两级，权限模型最简单，客户反馈不够用。", finishAfterMs: 25 * MIN },
  );
  brain.sensorRules.push(
    { match: /导出.*(卡|超时|失败|慢)/, title: "客服反复反馈：报表导出卡住", summary: "本周第 3 次有客户反馈报表导出超过 1 万行就卡住，集中在月底对账场景。" },
    { match: /(支付|回调).*(500|报错|异常)|(500|报错).*(支付|回调)/, title: "研发群：支付回调报错", summary: "有人在研发群里提到支付回调返回 500。" },
  );
}

/** Runs the story. Assumes a fresh data directory and a travelling DemoClock. */
export async function seedDemo(d: DemoSeedDeps): Promise<void> {
  const { kernel, desk, im, brain, clock, timeZone, log } = d;
  registerWorkers(brain);
  const end = Date.now();
  const today = zonedParts(end, timeZone);
  /** Local time `h:m` on day `day` relative to today (never later than now). */
  const at = (day: number, h: number, m = 0) => Math.min(zonedTime(timeZone, today.y, today.mo, today.d + day, h, m), end - 5 * MIN);
  const iso = (t: number) => new Date(t).toISOString();

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
    const r = await desk.capture({ text });
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
    const rec = kernel.gate.findPendingBySubjectSync(subjectKey);
    if (!rec) throw new Error(`demo seed: no pending card for ${subjectKey}`);
    return rec;
  };
  const version = (artifactId: string | null) => (artifactId ? (kernel.context.getArtifactSync(artifactId)?.version ?? null) : null);
  const approve = async (subjectKey: string) => {
    const rec = card(subjectKey);
    const r = await desk.approve(rec.actionId, { seenVersion: version(rec.artifactId) });
    if (!r.ok) log(`demo seed: approving "${rec.action.summary}" → ${r.outcome}`);
    await idle();
  };
  const rootTitled = (title: string) => {
    const c = kernel.listCells({ parentId: kernel.deskCellId }).find((x) => x.title === title && x.spec.meta?.["role"] === "coordinator");
    if (!c) throw new Error(`demo seed: no item "${title}"`);
    return c.id;
  };
  const sensorTitled = (title: string) => kernel.listCells({ parentId: kernel.deskCellId, preset: "sensor" }).find((c) => c.title === title)?.id;

  // ==================== day -3: sources (docs/03 原则 1) ====================
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

  // ==================== day -3: small things (原则 2) and a routine reply ====================
  const qa = await says(at(-3, 10, 10), "chenxiao", "灰度环境的发版窗口还是周四晚上 8 点吗？", { thread: "demo:dm-chenxiao" },
    t("draft_reply", { text: "是的，还是周四晚上 8 点。记得提前在群里同步一下这次的回归范围。", title: "回复陈晓：灰度发版窗口", targetLabel: "陈晓（测试）", prep: { summary: "核对了发布日历，本周没有调整。", checked: [{ label: "发布日历", uri: "https://wiki.example.com/release-calendar" }] } }),
  );
  await approve(subjectKeys.inbound(qa));
  await says(at(-3, 10, 40), "ci-bot", "【CI】main 分支构建通过 #1287（耗时 6 分 12 秒）", { thread: "demo:ci" },
    t("archive_notification", { title: "CI：main 分支构建通过 #1287" }),
  );
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
      research: true,
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

  // ==================== day -2: research fan-out (all back) and two projects ====================
  await owner(
    at(-2, 14, 0),
    "调研一下 5 家 APM 监控方案（SkyWalking、Pinpoint、Elastic APM、Datadog、OpenTelemetry + Tempo），对比接入成本和告警能力",
    t("fan_out", {
      title: "调研 5 家 APM 监控方案",
      instruction: "调研下面这个 APM 监控方案，重点写清接入成本（人日、机器）和告警能力，结论一两句话。",
      items: ["SkyWalking", "Pinpoint", "Elastic APM", "Datadog", "OpenTelemetry + Tempo"].map((name) => ({ title: name, instruction: `对象：${name}` })),
      label: "正在并发调研 APM 方案",
      research: true,
    }),
  );
  const onboarding = await owner(
    at(-2, 15, 30),
    "后端新同学 12 月 1 号入职，帮我把入职准备排一下",
    t("propose_project", {
      title: "后端新人入职准备",
      outcome: "新同学入职当天账号、环境、第一周任务都就绪",
      actions: [
        { title: "申请 GitLab、VPN 和堡垒机账号", owner: "human", effort: "15m", nextStep: "在 IT 服务台提三个账号申请" },
        { title: "挑 3 篇必读文档发给新同学", owner: "human", effort: "45m", nextStep: "从 Wiki 里挑架构总览、发版流程、值班手册" },
        { title: "整理新人第一周任务清单", owner: "agent" },
      ],
      prep: { summary: "参考了上次前端新人入职的清单。" },
      research: true,
    }),
  );
  await approve(subjectKeys.inbound(onboarding));
  const talks = await owner(
    at(-2, 16, 10),
    "下周五团队技术分享会，帮我规划一下",
    t("propose_project", {
      title: "Q4 技术分享会",
      outcome: "下周五下午的分享会议题、讲者、场地都定下来",
      actions: [
        { title: "整理候选议题清单", owner: "agent" },
        { title: "等行政确认 3 楼大会议室", owner: "waiting" },
      ],
      research: true,
    }),
  );
  await approve(subjectKeys.inbound(talks));

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
    const r = await desk.toHuman(rec.actionId, {});
    if (!r.ok) log(`demo seed: 转给我来处理 → ${r.outcome}`);
    const art = kernel.context.getArtifactSync(rec.artifactId!)!;
    desk.saveArtifact(art.artifactId, {
      expectedVersion: art.version,
      body: art.content.body.replace("我倾向 B，", "我倾向 B（DBA 也建议双写），"),
    });
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

  // ==================== day -1: a question someone else answered; chases ====================
  await says(at(-1, 11, 0), "zhaolei", "@我 网关限流阈值现在是多少？压测要用", { thread: "demo:backend-group", to: "backend-group" },
    t("draft_reply", { text: "目前网关限流是每实例 100 QPS，压测环境可以临时调到 500。", title: "回复后端群：网关限流阈值", targetLabel: "后端群", prep: { summary: "查了网关配置。", checked: [{ label: "gateway.yaml", uri: "https://git.example.com/infra/gateway.yaml" }] } }),
  );
  await says(at(-1, 11, 6), "sunhao", "每实例 100 QPS，压测环境我已经帮你调到 500 了", { thread: "demo:backend-group", to: "backend-group" },
    t("withdraw_card", { reason: "孙浩已经在后端群里回答了" }),
  );
  const quoteDue = Math.max(zonedTime(timeZone, today.y, today.mo, today.d + 1, 12, 0), end + 6 * HOUR);
  await owner(
    at(-1, 14, 0),
    "帮我盯一下三家供应商的压测服务器报价，后天中午前要齐",
    t("chase_replies", {
      title: "压测服务器采购比价",
      description: "等待供应商报价回信",
      parties: [
        ["星河数据", "xinghe"],
        ["云桥科技", "yunqiao"],
        ["北辰网络", "beichen"],
      ].map(([label, id]) => ({ label, to: `channel:${DEMO_CHANNEL_ID}:${id}`, thread: `${DEMO_CHANNEL_ID}:quote-${id}`, principalId: `${DEMO_CHANNEL_ID}:${id}` })),
      dueAt: iso(quoteDue),
      nudgeText: "您好，想跟进一下压测服务器（8 核 32G × 6 台，租 3 个月）的报价，方便的话今天回复一下，谢谢！",
    }),
  );
  await says(at(-1, 14, 30), "xinghe", "星河数据报价：8 核 32G 每台每月 1280 元，含 200G SSD，起租 1 个月", { thread: `${DEMO_CHANNEL_ID}:quote-xinghe` });
  await owner(
    at(-1, 15, 0),
    "三位组长的 Q4 OKR 自评今晚 8 点前要交，帮我盯一下，没交的到点提醒",
    t("chase_replies", {
      title: "收齐 Q4 OKR 自评",
      description: "等三位组长提交 Q4 OKR 自评",
      parties: [
        ["赵磊（前端）", "zhaolei"],
        ["陈晓（测试）", "chenxiao"],
        ["孙浩（运维）", "sunhao"],
      ].map(([label, id]) => ({ label, to: `channel:${DEMO_CHANNEL_ID}:${id}`, thread: `${DEMO_CHANNEL_ID}:okr-${id}`, principalId: `${DEMO_CHANNEL_ID}:${id}` })),
      dueAt: iso(at(-1, 20, 0)),
      nudgeText: "孙浩，Q4 OKR 自评今晚截止，方便的话今天提交一下，周一要汇总给李总，谢谢！",
    }),
  );
  const zl = await says(at(-1, 15, 40), "zhaolei", "登录接口的错误码文档在哪？前端要对一下提示文案", { thread: "demo:dm-zhaolei" },
    t("draft_reply", { text: "在 Wiki 上。", title: "回复赵磊：登录错误码文档", targetLabel: "赵磊（前端）", prep: { summary: "找到了 Wiki 上的错误码页面。", checked: [{ label: "登录错误码", uri: "https://wiki.example.com/auth/error-codes" }] } }),
  );
  await says(at(-1, 16, 0), "yunqiao", "云桥科技：每台每月 1150 元，起租 3 个月，带宽另算", { thread: `${DEMO_CHANNEL_ID}:quote-yunqiao` });
  await says(at(-1, 16, 20), "zhaolei", "OKR 自评已经提交到系统了", { thread: `${DEMO_CHANNEL_ID}:okr-zhaolei` });
  const hrAt = Math.max(at(-1, 16, 31) + HOUR, Math.min(zonedTime(timeZone, today.y, today.mo, today.d, 10, 0), end - 20 * MIN));
  await owner(at(-1, 16, 30), "明早 10 点提醒我给 HR 回电话，确认后端候选人周五的面试时间", t("remind_me", { text: "给 HR 回电话，确认后端候选人周五的面试时间", at: iso(hrAt), effort: "15m" }));
  await says(at(-1, 17, 5), "chenxiao", "交了～", { thread: `${DEMO_CHANNEL_ID}:okr-chenxiao` });
  await says(at(-1, 18, 0), "monitor-bot", "【监控】order-service P99 延迟 820ms，持续 3 分钟后已自动恢复", { thread: "demo:alerts" },
    t("archive_notification", { title: "监控：order-service P99 短暂升高，已自动恢复", detail: "持续 3 分钟，820ms" }),
  );
  // The OKR deadline passes on the way (20:00): the watcher drafts a nudge and the item raises its one card.
  await step(at(-1, 21, 0));

  // ==================== today: the morning inbox ====================
  await says(at(0, 8, 20), "ci-bot", "【CI】nightly 全量回归通过（1532 个用例，耗时 41 分钟）", { thread: "demo:ci" },
    t("archive_notification", { title: "CI：nightly 全量回归通过", detail: "1532 个用例" }),
  );
  await says(at(0, 8, 25), "admin-bot", "【行政】本周五下午 3 楼大会议室已被市场部预订", { thread: "demo:admin" },
    t("archive_notification", { title: "行政：周五下午 3 楼大会议室已被预订", detail: "市场部预订" }),
  );
  await owner(
    at(0, 8, 30),
    "https://opentelemetry.io/docs/languages/js/ 存一下，APM 选型要看",
    t("capture_note", { title: "OpenTelemetry JS 文档（APM 选型）", url: "https://opentelemetry.io/docs/languages/js/", list: "阅读清单" }),
  );
  await approve(subjectKeys.project(rootTitled("后端新人入职准备")));
  await approve(subjectKeys.project(rootTitled("Q4 技术分享会")));
  {
    // The owner rewrites a too-short draft before sending it (what the weekly review learns from).
    const rec = card(subjectKeys.inbound(zl));
    await step(at(0, 8, 50));
    desk.saveArtifact(rec.artifactId!, {
      expectedVersion: version(rec.artifactId)!,
      body: "在 Wiki「认证服务 / 登录错误码」这一页：https://wiki.example.com/auth/error-codes 。提示文案以第 3 列为准，40103 和 40104 这两个上周刚改过，注意一下。",
    });
    await approve(subjectKeys.inbound(zl));
  }
  await step(at(0, 9, 10));
  await says(at(0, 9, 30), "wangmin", "补充：客户还想按日期区间筛选，能一起做吗？", { thread: "demo:dm-wangmin" },
    t("draft_reply", {
      text: "可以，下周三前一起上线：按门店（store_ids，可多选）和日期区间（start_date / end_date，最长 92 天）筛选。超过 5 万行的导出走异步任务，完成后发站内信通知。",
    }),
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
    ...(s3
      ? [t("suggest_code_check", { sourceId: s3, entry: DEMO_PAYMENT_CHECK, reason: "这个探头每次都用模型判断，其实规则很固定：消息里同时出现“回调”和“500/报错”就算命中，换成脚本检查零成本。" })]
      : []),
  );
  await owner(at(0, 10, 0), "周五下午 3 点提醒我约牙医", t("remind_me", { text: "约牙医", at: iso(fridayAt(timeZone, end, 15)), effort: "15m" }));

  // ==================== now: work that is still running ====================
  clock.catchUp();
  await idle();
  brain.queueDesk(
    t("delegate", {
      title: "排查支付回调偶发 500",
      instruction: "支付回调偶发 500，看日志像是幂等键冲突。复现、定位原因并修掉，补上并发回调的测试，修好后汇报改动和验证结果。",
      outcome: "回调不再报 500，改动可以合入",
    }),
  );
  await desk.capture({ text: "支付回调偶发 500，看日志像是幂等键冲突。帮我查一下原因并修掉，修好给我看改动" });
  await until(() => kernel.listCells({ parentId: kernel.deskCellId }).some((c) => c.title === "排查支付回调偶发 500"), "the bug-fix item");
  await until(() => !kernel.activeRuns().some((r) => r.cellId === kernel.deskCellId), "the desk");
  drained("delegate");
  const rivals = ["账无忧", "云算盘", "票据通", "财小蜜", "账房先生", "易对账"];
  brain.queueDesk(
    t("fan_out", {
      title: "整理 6 家竞品的权限模型",
      instruction: "整理下面这家竞品的权限模型（角色、数据范围、字段级权限、审计），对照我们的 RBAC 指出差距。",
      items: rivals.map((name) => ({ title: name, instruction: `对象：${name}` })),
      label: "正在并发整理竞品权限模型",
      research: true,
    }),
  );
  await desk.capture({ text: "并行整理 6 家竞品的权限模型，看看我们的 RBAC 还要补什么" });
  await until(
    () => {
      const c = kernel.listCells({ parentId: kernel.deskCellId }).find((x) => x.title === "整理 6 家竞品的权限模型");
      const st = c ? kernel.context.readStateSync<CoordinatorState>(c.id, KEYS.coordinator) : null;
      return st !== null && Object.values(st.slots).filter((s) => s.status === "done").length >= 3;
    },
    "the first competitor results",
  );
  await until(() => !kernel.activeRuns().some((r) => r.cellId === kernel.deskCellId), "the desk");
  drained("fan_out");
}

/** The coming Friday at `hour` local time (next week's if this one has passed). */
function fridayAt(timeZone: string, now: number, hour: number): number {
  const p = zonedParts(now, timeZone);
  let t = zonedTime(timeZone, p.y, p.mo, p.d + ((5 - p.wd + 7) % 7), hour, 0);
  if (t <= now) t += 7 * DAY;
  return t;
}

/** Real-time polling for work the seed cannot idle() on (runs that take minutes on purpose). */
async function until(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`demo seed: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
