# ng-agents

下一代个人与组织级工作辅助 Agent 探索项目：基于 **8 原子微内核（Atomic Microkernel）** 与 **GTD 认知协处理器（GTD Co-Processor）** 产品范式。

## 核心设计文档索引

1. **[2026 热门 AI Agent 产品全景调研与十大底层架构共性](./docs/01-agent-landscape-2026.md)**
   - 深度拆解 Anthropic《Building always-on agents》、Paperclip、Hermes Agent、OpenClaw、Pi、DeepSeek Harness、Poke、Devin 2.2、Manus 2.0、OpenAI Codex、Cursor Automations 与企业级 SaaS Agent 阵营。
   - 提炼行业收敛出的十大工程范式（默认休眠按事件唤醒、单写者合并锁、脑手状态分离、KV-Cache 前缀不变性、Codemode 写代码调工具、文件记忆 + 离线 Dreaming、`SKILL.md` 渐进披露、沙箱外凭据代理 + `defer` 零算力审批、主动降噪与可验证交付物、子沙箱隔离与双指标预算熔断）及生产踩坑教训。

2. **[Agent 微内核假说验证：八大原子拆解与全品类产品拼装蓝图](./docs/02-atomic-kernel-architecture.md)**
   - **1 条通用信封总线（`Envelope`）+ 8 个正交原子**：`① Channel`、`② Clock`、`③ Inbox`、`④ Context`、`⑤ Agent Loop`、`⑥ Workspace`、`⑦ Gate`、`⑧ Outbox`。
   - 包含 ~100 行最小 TypeScript 内核接口契约、5 大涌现分子电路，以及现场还原 Pi、Claude Always-On、OpenClaw、Hermes、Poke、Devin/Manus 与 Paperclip 的拓扑配方。

3. **[GTD × Agent 微内核：最佳“Agent 辅助工作”产品形态推演](./docs/03-gtd-agent-product-vision.md)**
   - 从 David Allen 的 GTD 第一性原理出发，剖析为何纯聊天框、传统 AI 待办表与失控全自动黑盒均非最优解。
   - 提出 **“幕僚预跑原则（把待办变成 80% 半成品批件）”**、**`@Agent / @Human / @Waiting` 三轨球权模型**、**随身闪念口 + 三模态工作台**，并证明其与 8 原子微内核严格 1:1 同构。

4. **[GTD 幕僚工作台交互与状态流转规范](./docs/04-gtd-interaction-spec.md)**
   - 详细定义顶栏心智护盾状态栏、`Clarify 拍板台`（三类标准决策卡片与 `Inbox Zero` 流转）、`Engage 心流工位`（8:4 底稿共创画布 + Context Pack 作战包 + 免打扰拦截）、`Radar 全景与周回顾`（三色球权雷达 + `Dreaming` 个人习惯固化为 `SKILL.md`）的交互细节与端到端状态机。
