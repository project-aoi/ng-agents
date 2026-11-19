# Bug 记录与实测缺陷台账（Layer 3）

> [!WARNING]
> **Agent 开发与修 Bug 必读声明**：
> 1. 本目录**仅存放当前代码实现相对于理想设计的阶段性偏差与实测审计档案**，**绝不是**产品设计规范！
> 2. 动手修问题前，请同时对照 **[第一层：产品与架构设计原则](../01-principles/)**、**[第二层：产品理想工作方式与用例推导](../02-workflows/)** 以及 **[第五层：已拍板的下一代演进提案（`05-proposals/`）](../05-proposals/README.md)**——凡注明已被 `05-proposals` 取代（`superseded`）的旧机制子项（如 `cwdMode` 写锁与 `worker` 只读沙箱），**切勿再按旧设计白做修补**，直接随演进批次下线或合流实现！
> 3. 每修完一条 Bug：必须补齐对应的自动化回归测试（`vitest`），跑通 `pnpm typecheck && pnpm test && pnpm build`，随后在本台账中将其状态更新为 `fixed (commit)`（被新提案移除的旧机制标为 `superseded`）并注明验证结论。

---

## 一、2026-11-18 压测轮次 Bug 总看板（2026-11-19 已按四批修复落地）

本看板 13 条缺陷源自 2026-11-18 真实端到端压测与代码清点；原始全量压测轨迹与数据库交叉核验见：[audits/2026-11-18-traex-live-e2e.md](./audits/2026-11-18-traex-live-e2e.md)。

**本轮结果**：2026-11-19 四个批次全部落地，全量门禁 `pnpm typecheck && pnpm test && pnpm build` 通过（99 个测试文件、1018+ 条测试）。13 条除[第二节](#二2026-11-19-修复落地记录与遗留项)列出的余项外均已 `fixed`（尚无提交号，状态记为修复日期），被提案移除的旧机制子项标为 `superseded`；未经实机验证的说明同见第二节。各条的修复结论（改了什么、在哪、由哪些测试覆盖）写在对应详情单的「修复结论」块中。

| 编号 | 级别 | 状态 | 问题摘要（含与 [`05-proposals`](../05-proposals/README.md) 的合流说明） | 核心涉及源码 | 对齐的目标规范与提案 | 详情单 |
| :--- | :---: | :---: | :--- | :--- | :--- | :--- |
| **`BUG-001`** | **P0** | `fixed（2026-11-19）` | `budget_stopped` 认领后零 Token 短路，黑洞吞没状态化 CLI 会话的入站信封（丢失 `cell.result`）<br>**验证**：预算停在认领之前挂起，信封留在队列、续费后全部送达；`wakeable.test.ts`、`dispatch.test.ts` 覆盖 | `packages/cell/src/dispatcher.ts`<br>`packages/loop/src/cli/loop.ts` | `P-SAFE-7` · `INV-UC07-04` · [uc07](../02-workflows/uc07-external-agent-and-overnight-hosting.md) | [内核与预算单](./BUG-20261118-kernel-and-budget.md#bug-001) |
| **`BUG-002`** | **P0** | `fixed（2026-11-19）` | `codex exec resume` 会话历史累计 Token 被当成单轮增量重复记账（$O(K^2)$ 虚增；开放直连 `worker` 多轮续聊前必止血）<br>**验证**：会话累计值按 `CliSessionRecord.reported` 求单轮差值计量；`cli.test.ts`（`CLI usage metering (BUG-002)`）、`adapters.test.ts` 覆盖 | `packages/loop/src/cli/adapters/codex.ts`<br>`packages/gate/src/gate.ts` | `P-SAFE-7` · `INV-UC07-03` · [uc07](../02-workflows/uc07-external-agent-and-overnight-hosting.md) | [内核与预算单](./BUG-20261118-kernel-and-budget.md#bug-002) |
| **`BUG-003`** | **P0** | `fixed（2026-11-19）` | 预算门禁四连环：缺收尾免死缓冲、96.5% 缓存按 1:1 计费且美分记 `0`、祖先链同时超限背靠背连弹双卡、派生时静态焊死父瞬时余额<br>**验证**：四个子项均已修复（美分仍按 CLI 原报、未加价格估算）；另新增主人专属的预算限额总开关；`ledger.test.ts`、`attenuate.test.ts`、`migration.test.ts`、`wakeable.test.ts` 覆盖 | `packages/gate/src/gate.ts`<br>`packages/cell/src/approvals.ts` | `P-SAFE-7` · `INV-SYS-04` · [uc07](../02-workflows/uc07-external-agent-and-overnight-hosting.md) | [内核与预算单](./BUG-20261118-kernel-and-budget.md#bug-003) |
| **`BUG-004`** | **P1** | `fixed（2026-11-19）` | `auto` 模型选择下忽略 `modelTier: "fast"`，监听器与轻量任务全员退化跑旗舰 `@xhigh`<br>**验证**：`fast` 档从 CLI 自带模型清单取轻量模型，没有则用推荐模型降推理档；`cli-models.test.ts`、两处 `models.test.ts` 覆盖 | `packages/cell/src/models.ts`<br>`packages/loop/src/cli/models.ts` | `P-KERN-4` · `INV-UC02-05` · [uc02](../02-workflows/uc02-code-delivery-and-relay.md) | [循环与监听单](./BUG-20261118-loop-and-watcher.md#bug-004) |
| **`BUG-005`** | **P1** | `fixed（2026-11-19；子项 1 收窄）` | Watcher 五处缺陷：缺零 Token 脚本探针、`idleSec` 与 `set_reminder` 双定时器空转、CI 自动重跑中误报 `failed` 自毁、缺目录上下文、合入窗口无自适应收紧<br>**验证**：五项均已落地，但子项 1 只做了零 Token 探针，「结果变化或异常时升级给 `fast` 模型研判」未做（余项见第二节）；`probe.test.ts`、`watchers.test.ts` 覆盖 | `presets/src/project/toolset.ts`<br>`presets/src/thread-watcher/preset.ts`<br>`presets/src/shared/prompts.ts` | `P-KERN-3` · `P-KERN-4` · `INV-UC02-04` · [uc02](../02-workflows/uc02-code-delivery-and-relay.md) | [循环与监听单](./BUG-20261118-loop-and-watcher.md#bug-005) |
| **`BUG-006`** | **P1** | `fixed（2026-11-19）` | `save_artifact` 升版省略 `title` 时将原版标题抹成 `NULL`；缺 `patch_artifact` 局部修订引发 38 次分页读写风暴<br>**验证**：升版保留标题、新增 `patch_artifact`、`read_resource` 单页按需放宽至 64,000 字符；`artifacts.test.ts`、`tools.test.ts` 覆盖 | `packages/context/src/artifacts.ts`<br>`packages/loop/src/tools/context.ts`<br>`packages/context/src/evidence.ts` | `P-KERN-5` · `INV-UC03-03` · [uc03](../02-workflows/uc03-human-collaboration-and-engage.md) | [上下文与提示词单](./BUG-20261118-context-and-prompt.md#bug-006) |
| **`BUG-007`** | **P1** | `fixed（2026-11-19）` | 提示词与偏好四处缺陷：已内联技能重复列在 `# Skills` 白读一次、`save_preference` 缺目录/角色作用域、禁词规则误伤源码技术专有名词、报告巨无霸附录倾倒<br>**验证**：四项均已修复（偏好作用域为上下文 schema v4）；`hydrate.test.ts`、`knowledge.test.ts`、`conventions.test.ts` 覆盖 | `packages/context/src/hydrate.ts`<br>`apps/gtd-desk/src/agent/tools.ts`<br>`presets/src/shared/prompts.ts` | `P-UX-1` · `P-UX-7` · [uc04](../02-workflows/uc04-someday-research-and-reactivate.md) | [上下文与提示词单](./BUG-20261118-context-and-prompt.md#bug-007) |
| **`BUG-008`** | **P1** | `fixed（子项 1）· superseded（子项 3）` | **必做**：补齐 Codex Code Mode 隐藏 `custom_tool_call` 采集（与 `inspect_cell` 及 `Agents` 时间线合并做）与评估 `jobs` 引导；<br>**免做**：`worker` 的 `cwdMode: "read"` OS 只读沙箱已由[提案分册三](../05-proposals/03-ai-driven-workspace-and-project-notes.md)取消 `cwdMode` 取代（仅 `sensor` 保持只读）<br>**验证**：子项 1 于 2026-11-19 修复（`adapters.test.ts`、`cli.test.ts` 覆盖）；子项 2（`jobs` 闲置）代码未改，作为观察项保留 | `packages/loop/src/cli/adapters/codex.ts`<br>`packages/loop/src/cli/loop.ts` | [02-direct-worker](../05-proposals/02-direct-worker-chat-and-pull-handoff.md) · [03-ai-workspace](../05-proposals/03-ai-driven-workspace-and-project-notes.md) | [循环与监听单](./BUG-20261118-loop-and-watcher.md#bug-008) |
| **`BUG-009`** | **P2** | `fixed（2026-11-19）` | 宿主机活跃任务期未持 `caffeinate -i` 防空闲休眠，且合盖休眠唤醒时存在 `leaseMs=10m` 租约误判超时重投竞态<br>**验证**：`awake.test.ts`、`sleep.test.ts` 覆盖；**尚未在真实 Mac 上验证**（仅在 Linux 上开发与测试） | `packages/inbox/src/inbox.ts`<br>`packages/cell/src/kernel.ts` | `P-SAFE-7` · `INV-UC07-05` · [uc07](../02-workflows/uc07-external-agent-and-overnight-hosting.md) | [内核与预算单](./BUG-20261118-kernel-and-budget.md#bug-009) |
| **`BUG-010`** | **P1** | `fixed（2026-11-19）` | 停靠在 `以后再说（someday）` 的调研报告在 `Radar` 界面无阅读入口（与[提案分册四](../05-proposals/04-agents-topology-and-live-chat-tab.md)共用 `Artifact` 阅读抽屉一并闭环）<br>**验证**：`agents.test.ts` 覆盖投影；**界面未在真实浏览器中目视验证**（构建环境无浏览器） | `apps/gtd-desk/src/shared/api.ts`<br>`apps/gtd-desk/src/server/projections/radar.ts`<br>`apps/gtd-desk/src/web/views/Radar.tsx` | `P-UX-6` · `INV-UC04-03` · [04-agents-tab](../05-proposals/04-agents-topology-and-live-chat-tab.md) | [界面与控制面单](./BUG-20261118-ui-and-control.md#bug-010) |
| **`BUG-011`** | **P2** | `fixed（2026-11-19）` | GTD 视图投影三处错位：`waiting` 硬编码“等待回复”、15 分钟周回顾混入在途项目内部子步骤、`someday` 与 `paused` 双徽章及计数混淆<br>**验证**：三项均已修复；`agents.test.ts`、`projections.test.ts` 覆盖 | `packages/protocol/src/gtd.ts`<br>`apps/gtd-desk/src/server/projections/review.ts`<br>`apps/gtd-desk/src/server/projections/radar.ts` | `P-UX-5` · `P-UX-6` · [uc04](../02-workflows/uc04-someday-research-and-reactivate.md) | [界面与控制面单](./BUG-20261118-ui-and-control.md#bug-011) |
| **`BUG-012`** | **P2** | `fixed（2026-11-19）· 余 1 项 open（P3）` | 外部主 Agent 控制面视野：历史/待命子分身展示、预算进度、`read_artifact` / `read_resource` 分页并入提案阶段 1～3 统一实现；动态改 `cwdMode` 需求随分册三自然消解<br>**验证**：控制面视野与分页、关闭分身恢复不再越过并发上限均已修复（`agents.test.ts`、`agent.test.ts`、`wakeable.test.ts` 覆盖），`cwdMode` 项 `superseded`；仍开放：立项卡批准的项目其 `Cell` 创建主体记在主台名下 | `apps/gtd-desk/src/agent/tools.ts`<br>`apps/gtd-desk/src/agent/guide.ts`<br>`packages/cell/src/lifecycle.ts` | `P-UX-2` · [02-direct-worker](../05-proposals/02-direct-worker-chat-and-pull-handoff.md) · [04-agents-tab](../05-proposals/04-agents-topology-and-live-chat-tab.md) | [界面与控制面单](./BUG-20261118-ui-and-control.md#bug-012) |
| **`BUG-013`** | **P2** | `fixed（2026-11-19，子项 1）· superseded（子项 2）` | **必做**：macOS 下 `markedAlive` 因无 `/proc` 退化为盲信复用 PID（导致 `jobs.test.ts` 失败）；<br>**免做**：`docs05-slots.test.ts` 写锁槽位测试随[提案分册三](../05-proposals/03-ai-driven-workspace-and-project-notes.md)移除写锁队列一并清理<br>**验证**：子项 1 由 `jobs.test.ts` 覆盖，其中真实 macOS 用例在 Linux 上跳过、**尚未在真实 Mac 上验证**；`docs05-slots.test.ts` 已随写锁队列删除 | `packages/workspace/src/util.ts`<br>`packages/workspace/test/jobs.test.ts` | `P-SAFE-1` · [03-ai-workspace](../05-proposals/03-ai-driven-workspace-and-project-notes.md) | [内核与预算单](./BUG-20261118-kernel-and-budget.md#bug-013) |

---

## 二、2026-11-19 修复落地记录与遗留项

原定的四批去重合流排期（见 [`docs/05-proposals/README.md`](../05-proposals/README.md#五与-03-bugs-去重合并后的全局实施总排期)）已于 **2026-11-19** 全部落地，全量门禁 `pnpm typecheck && pnpm test && pnpm build` 通过（99 个测试文件、1018+ 条测试）：

1. **第 1 批（P0 账本与防吞信封止血）**：`BUG-002`、`BUG-001`、`BUG-003`、`BUG-004` 已修复；另新增主人专属的预算限额总开关（见[内核与预算单](./BUG-20261118-kernel-and-budget.md#bug-003)）。
2. **第 2 批（可唤醒叶节点内核 + 主动 Pull + AI 目录协同）**：**`BUG-008` 子项 1** 已修复；旧 `cwdMode` 写锁队列与 `docs05-slots.test.ts` 已下线，`BUG-008` 子项 3、`BUG-013` 子项 2 与 `BUG-012` 的 `cwdMode` 项标为 `superseded`。
3. **第 3 批（第 4 视图「分身实况 · Agents」+ 对话式 `desk` + UI/控制面闭环）**：`BUG-010`、`BUG-011` 已修复，`BUG-012` 除下述一项外已修复。
4. **第 4 批（Watcher 零算力探针、局部补丁与宿主机韧性收尾）**：`BUG-006`、`BUG-005`（子项 1 收窄）、`BUG-007`、`BUG-009`、**`BUG-013` 子项 1** 已修复。

**仍开放 / 待观察的余项**：

- **`BUG-005` 子项 1 的模型研判升级未做**：零 Token 探针已落地，但「探针结果变化或异常时唤醒 `fast` 模型研判」没有实现——命令判定不了的情况一律以失败结果交回项目，由项目协调器自行决断。
- **`BUG-008` 子项 2（后台 `jobs` 闲置）保留为观察项**：代码未改，`worker` 提示词仍要求慢任务用 `job_start`；目前不作为有修复计划的缺陷。
- **`BUG-012` 立项卡发起人一项仍 `open`（P3）**：经立项提案卡批准启动的项目，其 `Cell` 的创建主体仍记在主台名下，原发起人保留在项目记录的 `source` 中；改动 `Cell` 主体意味着允许一个 `Cell` 以另一主体身份行事，内核按设计拒绝。
- **未经实机验证**：`BUG-009`（`caffeinate` 防休眠与合盖唤醒续租）与 `BUG-013` 子项 1（macOS 进程标记校验）均在 Linux 上开发与测试，**尚未在真实 Mac 上验证**（`jobs.test.ts` 中的真实 macOS 用例在 Linux 上跳过）；`BUG-010` 的报告阅读抽屉**未在真实浏览器中目视验证**（构建环境无浏览器）。
