# Bug 记录与实测缺陷台账（Layer 3）

> [!WARNING]
> **Agent 开发与修 Bug 必读声明**：
> 1. 本目录**仅存放当前代码实现相对于理想设计的阶段性偏差与实测审计档案**，**绝不是**产品设计规范！
> 2. 动手修问题前，请同时对照 **[第一层：产品与架构设计原则](../01-principles/)**、**[第二层：产品理想工作方式与用例推导](../02-workflows/)** 以及 **[第五层：已拍板的下一代演进提案（`05-proposals/`）](../05-proposals/README.md)**——凡注明已被 `05-proposals` 取代（`superseded`）的旧机制子项（如 `cwdMode` 写锁与 `worker` 只读沙箱），**切勿再按旧设计白做修补**，直接随演进批次下线或合流实现！
> 3. 每修完一条 Bug：必须补齐对应的自动化回归测试（`vitest`），跑通 `pnpm typecheck && pnpm test && pnpm build`，随后在本台账中将其状态更新为 `fixed (commit)`（被新提案移除的旧机制标为 `superseded`）并注明验证结论。

---

## 一、当前待修 Bug 总看板（源自 2026-11-18 真实端到端压测与代码清点）

原始全量压测轨迹与数据库交叉核验见：[audits/2026-11-18-traex-live-e2e.md](./audits/2026-11-18-traex-live-e2e.md)。

| 编号 | 级别 | 状态 | 问题摘要（含与 [`05-proposals`](../05-proposals/README.md) 的合流说明） | 核心涉及源码 | 对齐的目标规范与提案 | 详情单 |
| :--- | :---: | :---: | :--- | :--- | :--- | :--- |
| **`BUG-001`** | **P0** | `open` | `budget_stopped` 认领后零 Token 短路，黑洞吞没状态化 CLI 会话的入站信封（丢失 `cell.result`） | `packages/cell/src/dispatcher.ts`<br>`packages/loop/src/cli/loop.ts` | `P-SAFE-7` · `INV-UC07-04` · [uc07](../02-workflows/uc07-external-agent-and-overnight-hosting.md) | [内核与预算单](./BUG-20261118-kernel-and-budget.md#bug-001) |
| **`BUG-002`** | **P0** | `open` | `codex exec resume` 会话历史累计 Token 被当成单轮增量重复记账（$O(K^2)$ 虚增；开放直连 `worker` 多轮续聊前必止血） | `packages/loop/src/cli/adapters/codex.ts`<br>`packages/gate/src/gate.ts` | `P-SAFE-7` · `INV-UC07-03` · [uc07](../02-workflows/uc07-external-agent-and-overnight-hosting.md) | [内核与预算单](./BUG-20261118-kernel-and-budget.md#bug-002) |
| **`BUG-003`** | **P0** | `open` | 预算门禁四连环：缺收尾免死缓冲、96.5% 缓存按 1:1 计费且美分记 `0`、祖先链同时超限背靠背连弹双卡、派生时静态焊死父瞬时余额 | `packages/gate/src/gate.ts`<br>`packages/cell/src/approvals.ts` | `P-SAFE-7` · `INV-SYS-04` · [uc07](../02-workflows/uc07-external-agent-and-overnight-hosting.md) | [内核与预算单](./BUG-20261118-kernel-and-budget.md#bug-003) |
| **`BUG-004`** | **P1** | `open` | `auto` 模型选择下忽略 `modelTier: "fast"`，监听器与轻量任务全员退化跑旗舰 `@xhigh` | `packages/cell/src/models.ts`<br>`packages/loop/src/cli/models.ts` | `P-KERN-4` · `INV-UC02-05` · [uc02](../02-workflows/uc02-code-delivery-and-relay.md) | [循环与监听单](./BUG-20261118-loop-and-watcher.md#bug-004) |
| **`BUG-005`** | **P1** | `open` | Watcher 五处缺陷：缺零 Token 脚本探针、`idleSec` 与 `set_reminder` 双定时器空转、CI 自动重跑中误报 `failed` 自毁、缺目录上下文、合入窗口无自适应收紧 | `presets/src/project/toolset.ts`<br>`presets/src/thread-watcher/preset.ts`<br>`presets/src/shared/prompts.ts` | `P-KERN-3` · `P-KERN-4` · `INV-UC02-04` · [uc02](../02-workflows/uc02-code-delivery-and-relay.md) | [循环与监听单](./BUG-20261118-loop-and-watcher.md#bug-005) |
| **`BUG-006`** | **P1** | `open` | `save_artifact` 升版省略 `title` 时将原版标题抹成 `NULL`；缺 `patch_artifact` 局部修订引发 38 次分页读写风暴 | `packages/context/src/artifacts.ts`<br>`packages/loop/src/tools/context.ts`<br>`packages/context/src/evidence.ts` | `P-KERN-5` · `INV-UC03-03` · [uc03](../02-workflows/uc03-human-collaboration-and-engage.md) | [上下文与提示词单](./BUG-20261118-context-and-prompt.md#bug-006) |
| **`BUG-007`** | **P1** | `open` | 提示词与偏好四处缺陷：已内联技能重复列在 `# Skills` 白读一次、`save_preference` 缺目录/角色作用域、禁词规则误伤源码技术专有名词、报告巨无霸附录倾倒 | `packages/context/src/hydrate.ts`<br>`apps/gtd-desk/src/agent/tools.ts`<br>`presets/src/shared/prompts.ts` | `P-UX-1` · `P-UX-7` · [uc04](../02-workflows/uc04-someday-research-and-reactivate.md) | [上下文与提示词单](./BUG-20261118-context-and-prompt.md#bug-007) |
| **`BUG-008`** | **P1** | `open`（部分由提案消解） | **必做**：补齐 Codex Code Mode 隐藏 `custom_tool_call` 采集（与 `inspect_cell` 及 `Agents` 时间线合并做）与评估 `jobs` 引导；<br>**免做**：`worker` 的 `cwdMode: "read"` OS 只读沙箱已由[提案分册三](../05-proposals/03-ai-driven-workspace-and-project-notes.md)取消 `cwdMode` 取代（仅 `sensor` 保持只读） | `packages/loop/src/cli/adapters/codex.ts`<br>`packages/loop/src/cli/loop.ts` | [02-direct-worker](../05-proposals/02-direct-worker-chat-and-pull-handoff.md) · [03-ai-workspace](../05-proposals/03-ai-driven-workspace-and-project-notes.md) | [循环与监听单](./BUG-20261118-loop-and-watcher.md#bug-008) |
| **`BUG-009`** | **P2** | `open` | 宿主机活跃任务期未持 `caffeinate -i` 防空闲休眠，且合盖休眠唤醒时存在 `leaseMs=10m` 租约误判超时重投竞态 | `packages/inbox/src/inbox.ts`<br>`packages/cell/src/kernel.ts` | `P-SAFE-7` · `INV-UC07-05` · [uc07](../02-workflows/uc07-external-agent-and-overnight-hosting.md) | [内核与预算单](./BUG-20261118-kernel-and-budget.md#bug-009) |
| **`BUG-010`** | **P1** | `open`（与新 Tab 共用抽屉） | 停靠在 `以后再说（someday）` 的调研报告在 `Radar` 界面无阅读入口（与[提案分册四](../05-proposals/04-agents-topology-and-live-chat-tab.md)共用 `Artifact` 阅读抽屉一并闭环） | `apps/gtd-desk/src/shared/api.ts`<br>`apps/gtd-desk/src/server/projections/radar.ts`<br>`apps/gtd-desk/src/web/views/Radar.tsx` | `P-UX-6` · `INV-UC04-03` · [04-agents-tab](../05-proposals/04-agents-topology-and-live-chat-tab.md) | [界面与控制面单](./BUG-20261118-ui-and-control.md#bug-010) |
| **`BUG-011`** | **P2** | `open` | GTD 视图投影三处错位：`waiting` 硬编码“等待回复”、15 分钟周回顾混入在途项目内部子步骤、`someday` 与 `paused` 双徽章及计数混淆 | `packages/protocol/src/gtd.ts`<br>`apps/gtd-desk/src/server/projections/review.ts`<br>`apps/gtd-desk/src/server/projections/radar.ts` | `P-UX-5` · `P-UX-6` · [uc04](../02-workflows/uc04-someday-research-and-reactivate.md) | [界面与控制面单](./BUG-20261118-ui-and-control.md#bug-011) |
| **`BUG-012`** | **P2** | `open`（与提案合流） | 外部主 Agent 控制面视野：历史/待命子分身展示、预算进度、`read_artifact` / `read_resource` 分页并入提案阶段 1～3 统一实现；动态改 `cwdMode` 需求随分册三自然消解 | `apps/gtd-desk/src/agent/tools.ts`<br>`apps/gtd-desk/src/agent/guide.ts`<br>`packages/cell/src/lifecycle.ts` | `P-UX-2` · [02-direct-worker](../05-proposals/02-direct-worker-chat-and-pull-handoff.md) · [04-agents-tab](../05-proposals/04-agents-topology-and-live-chat-tab.md) | [界面与控制面单](./BUG-20261118-ui-and-control.md#bug-012) |
| **`BUG-013`** | **P2** | `open`（子项 2 由提案消解） | **必做**：macOS 下 `markedAlive` 因无 `/proc` 退化为盲信复用 PID（导致 `jobs.test.ts` 失败）；<br>**免做**：`docs05-slots.test.ts` 写锁槽位测试随[提案分册三](../05-proposals/03-ai-driven-workspace-and-project-notes.md)移除写锁队列一并清理 | `packages/workspace/src/util.ts`<br>`packages/workspace/test/jobs.test.ts` | `P-SAFE-1` · [03-ai-workspace](../05-proposals/03-ai-driven-workspace-and-project-notes.md) | [内核与预算单](./BUG-20261118-kernel-and-budget.md#bug-013) |

---

## 二、与 `05-proposals` 去重合流后的推荐实施顺序

完整架构演进拆解见 [`docs/05-proposals/README.md`](../05-proposals/README.md#五与-03-bugs-去重合并后的全局实施总排期)：

1. **第 1 批（P0 账本与防吞信封止血）**：`BUG-002`（CLI `--resume` 增量计费） $\rightarrow$ `BUG-001`（认领前预算预检防吞信封） $\rightarrow$ `BUG-003`（缓存权重、祖先链一键续费、收尾缓冲、取消静态余额焊死） $\rightarrow$ `BUG-004`（`fast` 档位正确映射）。
2. **第 2 批（可唤醒叶节点内核 + 主动 Pull + AI 目录协同）**：落地 `05-proposals` 分册二 & 分册三 + 补齐 **`BUG-008` 子项 1**（Codex `custom_tool_call` 采集）+ 新增 `evidence.appended` 总线事件（同步下线旧 `cwdMode` 写锁队列与 `docs05-slots` 测试）。
3. **第 3 批（第 4 视图「分身实况 · Agents」+ 对话式 `desk` + UI/控制面闭环）**：落地 `05-proposals` 分册一 & 分册四 + 一并收口 **`BUG-010`**（共享 `Artifact` 报告阅读抽屉）、**`BUG-011`**（GTD 三处投影纠偏）与 **`BUG-012`**（历史/待命分身视野与大资源分页）。
4. **第 4 批（Watcher 零算力探针、局部补丁与宿主机韧性收尾）**：`BUG-006`（`Artifact` 保留原标题 + `patch_artifact`） $\rightarrow$ `BUG-005`（零 Token 脚本探针 `watcher`、单一定时源与重跑防误毁） $\rightarrow$ `BUG-007`（过滤已内联技能、偏好作用域、保留源码术语） $\rightarrow$ `BUG-009` & **`BUG-013` 子项 1**（macOS `caffeinate -i`、合盖唤醒续租、macOS `markedAlive` 防 PID 复用）。
