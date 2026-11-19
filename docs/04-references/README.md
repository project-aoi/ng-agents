# 背景参考与历史演进归档（Layer 4）

> [!CAUTION]
> **Agent 开发提示**：本目录存放行业技术调研与早期演进阶段的历史文档底稿，**不作为当前代码开发的规范依据**。
> 开发与修复问题时，请严格遵循 **[`01-principles/`](../01-principles/)** 与 **[`02-workflows/`](../02-workflows/)**；若本目录下的历史文档与前两层存在出入（例如早期设计中的默认 `git_worktree` 克隆或四预设划分），一律以前两层为准。

---

## 目录内容

1. **[2026-agent-landscape.md](./2026-agent-landscape.md)**
   - 2026 年主流开源与商业 AI Agent 产品深度调研（Anthropic《Building always-on agents》、DeepSeek Super-agent / Harness、Paperclip、Hermes、OpenClaw、Pi、Devin 2.2、Manus 2.0、OpenAI Codex、Cursor Automations、Google Antigravity 等），总结行业收敛出的十个底层工程共性与线上真实踩坑。
2. **[`archive/`](./archive/)**（历史阶段性设计原稿留档，仅供演进溯源与查阅源码历史注释如 `docs/03`、`docs/05`）：
   - [02-atomic-kernel-architecture.md](./archive/02-atomic-kernel-architecture.md) — 初始 6 原语 + `Cell` 内核架构拆解稿
   - [03-gtd-agent-product-vision.md](./archive/03-gtd-agent-product-vision.md) — 初始 GTD 工作辅助 Agent 产品构想稿
   - [04-gtd-interaction-spec.md](./archive/04-gtd-interaction-spec.md) — 初始 GTD 工作台界面交互与状态流转稿
   - [05-scenario-evolution-plan.md](./archive/05-scenario-evolution-plan.md) — 面向 6 大真实场景去硬编码镣铐演进方案稿
   - [06-ideal-system-walkthrough.md](./archive/06-ideal-system-walkthrough.md) — `trae-x` 多战线并发研发托管实战理想态全景长文
