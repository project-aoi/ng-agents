# ng-agents

面向日常工作的个人与团队 Agent 探索项目：底层采用 **8 个解耦的基础模块**，上层结合 **GTD（Getting Things Done）工作流**，把杂乱输入整理成随时可推进、可确认的具体事项。

## 文档目录

1. **[2026 热门 AI Agent 产品调研与底层工程共性](./docs/01-agent-landscape-2026.md)**
   - 拆解 Anthropic《Building always-on agents》、Paperclip、Hermes Agent、OpenClaw、Pi、DeepSeek Harness、Poke、Devin 2.2、Manus 2.0、OpenAI Codex、Cursor Automations 以及企业级 SaaS Agent 产品。
   - 总结行业收敛出的十个工程做法（默认休眠按事件唤醒、单会话串行锁、会话与沙箱分离、保持上下文前缀不变以命中缓存、写代码调工具、文件记忆与后台整理、`SKILL.md` 按需加载、沙箱外代理注入密钥与挂起等待审批、静默过滤低价值通知、子沙箱隔离与预算硬上限），以及线上真实踩过的坑。

2. **[Agent 核心架构拆解：1 条消息总线 + 8 个基础模块](./docs/02-atomic-kernel-architecture.md)**
   - **统一消息结构（`Envelope`）+ 8 个职责单一的基础模块**：`① Channel`（渠道接入）、`② Clock`（定时与唤醒）、`③ Inbox`（收件队列与并发锁）、`④ Context`（上下文与记忆）、`⑤ Agent Loop`（无状态推理循环）、`⑥ Workspace`（隔离执行沙箱）、`⑦ Gate`（权限拦截与预算控制）、`⑧ Outbox`（消息投递与静默过滤）。
   - 包含约 100 行最小 TypeScript 接口定义、5 种常见组合方式，以及如何用同一套模块搭出 Pi、Claude Always-On、OpenClaw、Hermes、Poke、Devin/Manus 和 Paperclip 等不同形态的产品。

3. **[用 GTD 的思路设计工作辅助 Agent](./docs/03-gtd-agent-product-vision.md)**
   - 从 GTD 的基本逻辑出发，分析为什么纯聊天框、传统 AI 待办列表和全自动黑盒都不够顺手。
   - 提出四个设计原则：**后台预处理（收到事儿先查清背景、写好初稿，别让人面对空白页）**、**标清当前归谁推进（`Agent 处理中` / `我来处理` / `等待回复`）**、**随手记入口 + 三个日常视图**、**随信任逐步放开自动执行权限**，并说明这套产品如何直接跑在 8 个基础模块之上。

4. **[GTD 工作台界面交互与状态流转设计](./docs/04-gtd-interaction-spec.md)**
   - 定义顶部导航与状态提示、`待确认收件箱（Clarify）`（单卡片处理流与三类常见卡片）、`专注工作区（Engage）`（初稿编辑区 + 关联资料侧栏 + 免打扰拦截）、`项目全局与周回顾（Radar）`（项目状态总览 + 从修改习惯提炼 `SKILL.md`）的具体交互与状态机。

5. **[模块精确定义与用户需求检验](./docs/05-module-contracts-and-capability-review.md)**
   - 明确 8 个模块的状态归属、操作边界与组合规则，区分 Session、Task、Run、Job、Action 和 Artifact。
   - 标明原接口所需的契约扩展，用并行工作、执行中取消、协同改稿、多 Agent 汇合等用户需求检验能力边界；不把定义遗漏或外部系统限制当成架构反例。
