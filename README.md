# ng-agents

面向日常工作的个人与团队 Agent 探索项目：遵循 **“表层极简 GTD、底层原子可动态拼装”** 的设计思路——对外只呈现最直觉的收件箱、待确认卡片与事项状态，对内靠 **6 个基础原语 + `Cell` 动态拼装容器** 适配从秒级随手记到跨天多方协同、并发深挖等不同粒度的工作。

## 核心设计准则

1. **用户看到的类 GTD 表层保持极简**：不向用户暴露复杂的底层运行概念。定时巡检与条件监控归入 **信源（Mailbox Source）** 产生事件，GTD 视图只管理真正需要推进的动作与有终点的项目。
2. **内核不堆砌定制业务实体与过度包装**：系统底层只保留 **1 条异步消息流 + 6 个基础原语 + `Cell` 拼装容器**（主台轻装秒回并秒派分身，单 `Cell` 慢命令走跨轮次异步 `Job`；单套权限严格满足 `child ⊆ parent`；仅保留 `Cell epoch` 防取消诈尸与草稿 `Artifact version` 防覆盖/盲发；异步事件走队列、UI 简单交互直走同步事务）。常见场景靠预设模板开箱即用，长尾复杂场景由 Agent 在权限边界内动态拼装完成。

## 文档目录

1. **[2026 热门 AI Agent 产品调研与底层工程共性](./docs/01-agent-landscape-2026.md)**
   - 深度拆解 Anthropic《Building always-on agents》、Paperclip、Hermes Agent、**DeepSeek Super-agent (`dsh-superagent`) / DeepSeek Harness (`dsh`)**、OpenClaw、Pi、Poke、Devin 2.2、Manus 2.0、OpenAI Codex、Cursor Automations 以及企业级 SaaS Agent 产品。
   - 总结行业收敛出的十个工程做法（默认休眠按事件唤醒、单会话串行锁与线程直通、会话与沙箱分离、保持上下文前缀不变以命中缓存、写代码调工具、文件记忆与后台整理、`SKILL.md` 按需加载、沙箱外代理注入密钥与挂起等待审批、静默过滤低价值通知、子沙箱隔离与金额/Token 双硬上限），以及线上真实踩过的坑。

2. **[Agent 核心架构拆解：6 个基础原语 + `Cell` 动态拼装](./docs/02-atomic-kernel-architecture.md)**
   - **统一消息信封（`Envelope`）+ 6 个职责封闭的原子模块**：`① Channel`（外部通道接入、能力声明、幂等外发与免打扰缓冲）、`② Inbox`（SQLite 队列、`deliverAt` 延迟与 Cron 唤醒、串行锁与实时 `control` 急刹）、`③ Context`（业务状态、带 `version` 草稿 `Artifact`、前缀快照、`FTS5` 检索与 `SKILL.md`）、`④ Loop`（支持工具裁剪的大模型推理与零 Token 确定性 `code` 执行）、`⑤ Workspace`（隔离沙箱与跨轮次异步 `Job` 句柄）、`⑥ Gate`（单调权限收紧 `child ⊆ parent`、密钥代理、绑定草稿版本的 `defer` 审批与双账本预算）。
   - **`Cell` 动态拼装与极简落地路径**：说明如何靠 **4 种预设模板（`inline / worker / watcher / sensor`）+ 轻装主台秒派分身 + 异步 `Job` + Agent 动态拼装（`spawnCell`）** 适配不同粒度工作（含按需授权子 Agent 1 对 1 直连汇报），并验证如何用同一套底座支撑市面上 8 类代表性产品。

3. **[用 GTD 的思路设计工作辅助 Agent](./docs/03-gtd-agent-product-vision.md)**
   - 从 GTD 的基本逻辑出发，分析为什么纯聊天框、传统 AI 待办列表、全自动黑盒以及写死单一流水线的架构都不够顺手。
   - 确立 **极简表层概念（定时监控归入信源层，不污染待办）**、**后台预处理消除空白页**、**标清动作球权归属（`Agent 处理中` / `我来处理` / `等待回复`）**、**随手记 + 三个日常视图** 与 **随信任逐步放权**，并展示多粒度任务如何在底层动态拼装运行。

4. **[GTD 工作台界面交互与状态流转设计](./docs/04-gtd-interaction-spec.md)**
   - 定义信源层（含定时信源）与顶部独立运行状态栏、`待确认收件箱（Clarify）`（单事项至多一卡、绑定草稿 `version` 防误发与防覆盖、个人微事免二次审批）、`专注工作区（Engage）`（同步速办勾选 + 左 8 右 4 深度编辑 + 仅暂存外部 `Channel` 通知的免打扰缓冲）、`项目全局与周回顾（Radar）`（多动作并行进度聚合、防停滞检查与沉淀 `SKILL.md`/脚本）的交互与状态流转。
