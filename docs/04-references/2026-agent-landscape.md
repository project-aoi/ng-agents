# 长期运行代理的工程资料

这些资料用于对照工作台的设计问题。仓库实现及用例见[工作流](../02-workflows/)与[设计记录](../05-proposals/README.md)。

| 关注点 | 阅读材料 | 工作台中的对应问题 |
| --- | --- | --- |
| 跨回合执行 | [Effective harnesses for long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)、[Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) | 下一轮怎样找回任务、工作目录、可验证的进度？ |
| 编排与持久工作 | [Paperclip](https://github.com/paperclipai/paperclip)、[Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) | 谁保存目标和下一步，谁接收结果？ |
| 上下文与记忆 | [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)、[Context engineering for AI agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | 哪些规则应固定在前缀，哪些动态工作事实要随时刷新？ |
| 工具与按需技能 | [Code execution with MCP](https://www.anthropic.com/research/code-execution-with-mcp)、[Agent Skills](https://agentskills.io/home)、[AGENTS.md](https://agents.md/) | 哪些职责是工具接口，哪些适合按需读取的项目约定？ |
| 轻量执行与扩展 | [Pi](https://github.com/earendil-works/pi)、[OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk)、[Goose](https://github.com/aaif-goose/goose) | 通用执行层与角色编排如何保持独立？ |
