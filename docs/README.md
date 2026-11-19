# `ng-agents` 分层规范与问题追踪体系

为了避免把“不可动摇的设计原则”、“一步步推导的理想工作流”与“某一时刻测出来的阶段性 Bug”混在一起导致演进失焦或修 A 坏 B，本项目文档严格划分为 **三层核心体系 + 一层历史参考**：

```text
docs/
├── 01-principles/     # 第一层：产品与架构设计原则（Why & Red Lines —— 最高准则，不可违背）
├── 02-workflows/      # 第二层：产品理想工作方式与用例推导（How & Invariants —— 逐步推导，严禁 Break）
├── 03-bugs/           # 第三层：Bug 记录与实测审计台账（Point-in-Time Defects —— 独立追踪，修完闭环）
├── 04-references/     # 第四层：行业背景调研与历史阶段性演进底稿归档（仅供背景溯源）
└── 05-proposals/      # 第五层：已于 2026-11-19 落地的架构演进设计记录（现行规范以一、二层为准）
```

> **Agent 开发强制铁律**（详见仓库根目录 [AGENTS.md](../AGENTS.md)）：  
> 任何智能体在规划特性、调整提示词或修复 `03-bugs/` 中的问题时，**必须以 `01-principles/` 和 `02-workflows/` 为准绳**，严禁把当前 Bug 行为当成设计预期，更严禁破坏 `02-workflows/` 中声明的任何一条 `INV-*` 用例不变量。

---

## 一、第一层：产品与架构设计原则（[`01-principles/`](./01-principles/)）

定义系统“为什么这样设计”以及绝不妥协的体验、架构与安全红线：

1. **[01-product-principles.md](./01-principles/01-product-principles.md)** — GTD 表层极简铁律（`P-UX-1` ～ `P-UX-7`）：内部黑话零泄漏（同时保留业务技术专有名词）、常驻 `desk` 主对话 $\times$ 外部主 Agent 伴随入口、定时监控归入信源不污染待办、微事秒办免卡与正事备初稿、球权三分明晰与单事项单卡、四视图分工（含「分身实况 · Agents」）与渐进信任。
2. **[02-kernel-principles.md](./01-principles/02-kernel-principles.md)** — 原子内核与编排原则（`P-KERN-1` ～ `P-KERN-6`）：薄内核守确定性机制 vs 厚编排走角色提示词/`SKILL.md`、1 流 + 6 原语 + `Cell`、持久 `Project` 沉淀资产 $\times$ 纯叶节点 `Worker` 回合结束即待命（退场通知 + 父节点主动 Pull）、UI 同步事务 vs 异步队列、Level-Triggered 状态监听、`0-Token / fast / strong` 三级算力与前缀缓存、独立无偏见终审。
3. **[03-safety-and-boundaries.md](./01-principles/03-safety-and-boundaries.md)** — 安全边界与算力治理（`P-SAFE-1` ～ `P-SAFE-7`）：真实宿主目录零误删、内核只亮活跃目录事实 $\times$ AI 决定同仓分工与冲突上报、主人未提交现场零触碰、`owner` vs `agent:*` 身份隔离（`ownerOnly` 红线）、双版本号防呆、5 锚点防悬空、认领前预算挂起与增量计量、主人专属的预算限制开关与宿主休眠续租。

---

## 二、第二层：产品理想工作方式与用例逐步推导（[`02-workflows/`](./02-workflows/)）

结合真实办公与重度研发用例，一步一步从表层交互推导到底层角色提示词、工具调用与数据库事务，并列出每条场景**严禁破坏的不变量（`INV-*`）**与对应回归测试：

- **[00-system-mechanics.md](./02-workflows/00-system-mechanics.md)** — 全链路角色拓扑、双层生命周期状态机、可唤醒 `Worker` 回合结算（待命 + 退场通知 + 主动 Pull）、`watcher` 单事务排空自关（`Drain-then-Close`）与四视图映射总纲
- **[uc01-capture-reply-and-sources.md](./02-workflows/uc01-capture-reply-and-sources.md)** — 随手记微事直办、外部提问单卡版本保护回复、定时巡检信源与历史周报习惯挖掘
- **[uc02-code-delivery-and-relay.md](./02-workflows/uc02-code-delivery-and-relay.md)** — `/todo` 缺路径追问、多棒接力追单（`/ship-mr` + 补录屏）、智能 `Watcher` 盯梢 CI 合入、独立源码终审与即时偏好沉淀
- **[uc03-human-collaboration-and-engage.md](./02-workflows/uc03-human-collaboration-and-engage.md)** — 局部先行与 `@Human` 外部材料等待、专注区左 8 右 4 人工改稿防覆盖与免打扰缓冲、多阶段人类注意力门控
- **[uc04-someday-research-and-reactivate.md](./02-workflows/uc04-someday-research-and-reactivate.md)** — 远期想法 `research_then_park` 预研停靠、两棒局部补证、网页报告阅读抽屉与跨周查重确认唤醒
- **[uc05-workspace-concurrency-and-arbitration.md](./02-workflows/uc05-workspace-concurrency-and-arbitration.md)** — 同工作树 AI 目录协同（内核只亮事实、协调器分工）、冲突上报停手、主人未提交脏现场保护、多项目公共 CI 共因阻塞单修广播唤醒
- **[uc06-domain-hub-direct-stream.md](./02-workflows/uc06-domain-hub-direct-stream.md)** — 领域直通中枢（`hub`）、固定时间桶攒批、噪音 `handback` 与在途/待命/已关 `Worker` 无损追单续接
- **[uc07-external-agent-and-overnight-hosting.md](./02-workflows/uc07-external-agent-and-overnight-hosting.md)** — 外部主 Agent 控制流（先存作用域偏好再立项）与跨夜多战线无人值守算力/休眠治理
- **[uc08-direct-worker-chat-and-pull-sync.md](./02-workflows/uc08-direct-worker-chat-and-pull-sync.md)** — 主人经 `Agents` 视图或外部主 Agent 直连 `Worker`、同事务静默抄送父项目、退场通知 + `inspect_cell` 主动 Pull 与查询零滞后

---

## 三、第三层：Bug 记录与实测审计台账（[`03-bugs/`](./03-bugs/)）

独立记录当前实现与第一、二层理想态之间的差距、精确源码定位与修复状态：

- **[03-bugs/README.md](./03-bugs/README.md)** — 待修 Bug 总看板（`BUG-001` ～ `BUG-013`）与推荐修复批次
  - [BUG-20261118-kernel-and-budget.md](./03-bugs/BUG-20261118-kernel-and-budget.md) — 内核吞信封、累计 Token 重复记账、预算四连环与休眠续租
  - [BUG-20261118-loop-and-watcher.md](./03-bugs/BUG-20261118-loop-and-watcher.md) — `fast` 档位失效、Watcher 五缺陷、CLI 隐藏 `exec` 采集与只读沙箱
  - [BUG-20261118-context-and-prompt.md](./03-bugs/BUG-20261118-context-and-prompt.md) — `Artifact` 丢标题与缺局部补丁、重复技能提示、偏好作用域与禁词误伤
  - [BUG-20261118-ui-and-control.md](./03-bugs/BUG-20261118-ui-and-control.md) — `someday` 网页报告抽屉缺失、GTD 文案/周回顾错位与主 Agent 排障视野
- **[audits/2026-11-18-traex-live-e2e.md](./03-bugs/audits/2026-11-18-traex-live-e2e.md)** — 2026-11-18 端到端真实研发托管压测轨迹与数据库交叉核验原始档案

---

## 四、第四层：背景参考与历史归档（[`04-references/`](./04-references/)）

- **[2026-agent-landscape.md](./04-references/2026-agent-landscape.md)** — 2026 热门 AI Agent 产品调研与十个底层工程共性
- **[archive/](./04-references/archive/)** — 早期阶段性设计稿留档

---

## 五、第五层：已落地的架构演进设计记录（[`05-proposals/`](./05-proposals/)）

存放 2026-11-19 拍板并已全部落地的架构与交互升级方案，作为当前架构的设计记录保留（解释规则的来龙去脉，不随代码修订）；现行权威规范是第一、二层，提案原文与之不一致处以第一、二层为准：

- **[05-proposals/README.md](./05-proposals/README.md)** — 演进总纲、规范拟修订表与 `03-bugs` $\times$ `05-proposals` 四批合流总排期
  - [01-conversational-desk-and-dual-entry.md](./05-proposals/01-conversational-desk-and-dual-entry.md) — 常驻 `desk` 升级为双向持久对话主 Agent 与双入口消息归属
  - [02-direct-worker-chat-and-pull-handoff.md](./05-proposals/02-direct-worker-chat-and-pull-handoff.md) — 纯叶节点可重唤醒 `Worker`（`Dormant`）、直连抄送防滞后与退场通知 + `inspect_cell` 主动 Pull
  - [03-ai-driven-workspace-and-project-notes.md](./05-proposals/03-ai-driven-workspace-and-project-notes.md) — 取消内核 `cwdMode` 写锁排队改 AI 目录协同 + `Project` 常驻非结构化白板笔记
  - [04-agents-topology-and-live-chat-tab.md](./05-proposals/04-agents-topology-and-live-chat-tab.md) — 工作台新增第 4 视图「分身实况 · Agents」（三层确定性拓扑画布、工作实况流与智能直连发话框）
