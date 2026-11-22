# 工作台的设计记录

每份记录说明一项设计选择、它解决的问题，以及可以验证行为的入口。产品约束见[设计原则](../01-principles/)，完整使用过程见[工作流](../02-workflows/)。

| 设计问题 | 记录 |
| --- | --- |
| 主人通过两种入口说话时，谁负责接续上下文？ | [总助理与外部主代理](01-conversational-desk-and-dual-entry.md) |
| 主人直接给分身补充要求，项目如何知道？ | [直连分身与项目交接](02-direct-worker-chat-and-pull-handoff.md) |
| 同一仓库有多人工作时，谁决定在哪儿改？ | [目录协作与项目白板](03-ai-driven-workspace-and-project-notes.md) |
| 怎样看到分身正在做什么，并找到它交付的报告？ | [分身实况](04-agents-topology-and-live-chat-tab.md) |
| 哪个事项需要主人做什么，如何避免提交看过之后已被改动的内容？ | [待我处理](05-unified-human-inbox-and-custom-cards.md) |
| 持久记录与命令行会话分别负责哪部分状态？ | [数据归属与会话恢复](06-architecture-ssot-cli-sync-and-boundaries.md) |
