# Bug 详情单（2026-11-21 架构审计）：概念正交性、影子双轨与控制面分叉（`BUG-020` ～ `BUG-024`）

> **来源**：2026-11-21 全仓架构与正交性深度只读审计（对照 [01-product-principles.md](../01-principles/01-product-principles.md)、[02-kernel-principles.md](../01-principles/02-kernel-principles.md)、[03-safety-and-boundaries.md](../01-principles/03-safety-and-boundaries.md) 与修订版[提案 05](../05-proposals/05-unified-human-inbox-and-custom-cards.md)）。

---

## `BUG-020`（P0）：外部主 Agent `control_cell` 绕过领域守卫可误杀根 `desk`；`decide_card` 现场读库击穿 `seenVersion` 防盲发乐观锁

- **核心源码**：
  - [agents.ts](../../apps/gtd-desk/src/server/agents.ts#L168-L203)（Web 端保护逻辑：禁停/禁删根 `desk`、项目走 `desk.projectOp` 级联清理、信源禁取消）
  - [tools.ts](../../apps/gtd-desk/src/agent/tools.ts#L898-L922)（MCP `control_cell` 直接调 `kernel.control`）
  - [tools.ts](../../apps/gtd-desk/src/agent/tools.ts#L694-L699)（MCP `decide_card("approve")` 现场读 DB 最新版填入 `seenVersion`）
  - [gate.ts](../../packages/gate/src/gate.ts#L1067)（`authorizeControlSync` 对 `agent:*` 无条件放行）
  - [lifecycle.ts](../../packages/cell/src/lifecycle.ts#L404)（底层 `closeCellSync` 未硬禁关闭 `parentId === null` 根节点）
- **根因与后果**：
  1. **直接可杀工作台主脑**：Web 端的领域守卫与级联清理（清理跨 Cell 动作、撤回关联卡、同步信源状态）全写在 `agents.ts` / `desk.ts`，而 MCP `control_cell` 绕过它们直接调底层 `kernel.control`。外部主 Agent 可对根 `desk` 执行 `cancel` 永久关闭主脑；对 `someday` 项目执行 `resume` 制造 `cells.status = active` 而 `gtd:project.lifecycle = someday` 的分裂态；对活跃项目 `cancel` 在 `desk` 留下悬挂孤儿卡。
  2. **防盲发乐观锁被击穿**：`decide_card(decision: "approve")` 不要求调用方回传 `list_cards` 时看到的草稿版本号，而是在批准瞬间现读 `context.getArtifactSync(rec.artifactId)?.version` 传给 `desk.approve`——后台或主人在间隙改稿后，外部主 Agent 会盲目批准从未见过的新版，永远不触发 `version_mismatch`。
- **修复方向（Batch 0 止血）**：
  - `@ng/cell` 内核层（`lifecycle.closeCellSync` / `inbox.controlSync`）硬禁止 `pause`/`cancel`/`close` 根节点（`parentId === null`）；
  - 确立**唯一命令服务原则**：MCP 与 Web 全部经由 `DeskService` 统一命令执行控制与清理，严禁直调底层写方法；
  - `list_human_items` 暴露 `artifactVersion` 与 `humanEdited`，`decide_card` 强制透传调用方持有的 `seenVersion`。
- **Phase 0 修复结论（2026-11-21 · `fixed`）**：
  - `DeskActor` / `approverId` 全链路显式必填，移除静默退回 `ownerPrincipal` 的默认降级；
  - `approvals.resolve()` 先校验操作者身份与 `ownerOnly` 再查 `inflight`（并发同决前同时核验 `seenArtifactVersion` / `seenItemRevision`，非在途交给 `gate.approveSync` 保持状态优先级与 `bound_version` 重绑）；`ownerOnlyApproval()` 补覆盖 `project.start`；
  - `packages/cell/src/lifecycle.ts`、`packages/inbox/src/inbox.ts` 与 `packages/gate/src/gate.ts` 物理禁止 `pause`/`cancel`/`close` 根节点（`parentId === null`）；
  - MCP `control_cell` 统一收口至 `DeskService.controlCell`，`decide_card` 透传调用方持有的 `seenVersion`/`seenItemRevision`（不再现读 DB 最新版），`list_cards` 暴露 `artifactVersion`、`humanEdited` 与 `itemRevision`；
  - Web 与 MCP 的卡片决策要求调用方提供 `seenItemRevision`。转交人工、放弃失败发送及恢复会更新修订号。恢复按放弃时生成的活动编号匹配卡片，旧标签页的重试继续被拒绝。
  - `set_state` 增加保留权威键前缀护栏（拒绝 `gtd:project` / `gtd:source` / `gtd:activity` 及 `:*`、`cli:*`、`sys:*`、`cell:*`、`pull:*`）；
  - Gate schema v4 落地卡片级乐观锁 `item_revision` / `seenItemRevision`（含 `revise` / `snooze` / `deny` / `withdraw` / `approve` / `abandon` 与外发 TX 1 同事务校验并递增）。
  - **测试覆盖**：`packages/inbox/test/control.test.ts`、`packages/gate/test/{approvals,control-revoke,migration}.test.ts`、`packages/cell/test/phase0.test.ts`、`packages/loop/test/tools.test.ts`、`apps/gtd-desk/test/{api,agent}.test.ts` 全绿（全仓 1054/1054 通过）。

---

## `BUG-021`（P0）：影子状态与假薄内核双轨——已取消提醒按时复活、工作目录与信源状态漂移

**结案**　提案 06 已覆盖影子清理与状态归属。

- **核心源码**：
  - 提醒双轨复活：[toolset.ts](../../presets/src/inline-desk/toolset.ts#L159-L171)（`remind_me` 同时写 Inbox 延迟信封与 `desk:reminder:<id>`）vs [items.ts](../../presets/src/inline-desk/items.ts#L322-L331)（`settleDeskBatch` 扫 `desk:reminder:*` 自动触发）
  - 回复/提案影子表：[items.ts](../../presets/src/inline-desk/items.ts#L36-L60)、[toolset.ts](../../presets/src/inline-desk/toolset.ts#L227-L302)、[toolset.ts](../../presets/src/inline-desk/toolset.ts#L529-L540)
  - 工作目录漂移：[toolset.ts](../../presets/src/project/toolset.ts#L345-L350)（`update_project` 只改 `gtd:project.cwd`）vs [lifecycle.ts](../../packages/cell/src/lifecycle.ts#L69)（禁改 `cells.spec.cwd`）、[readmodel.ts](../../packages/cell/src/readmodel.ts#L300)、[knowledge.ts](../../packages/context/src/knowledge.ts#L114)
  - 暂停与信源漂移：[status.ts](../../apps/gtd-desk/src/server/projections/status.ts#L35-L51)、[sources.ts](../../apps/gtd-desk/src/server/projections/sources.ts#L60)
- **根因与后果**：
  1. **已取消提醒复活**：`remind_me` 返回提示模型用 `cancel_scheduled` 取消提醒，但 `cancel_scheduled` 只删 Inbox 定时信封、不删 `cell_state["desk:reminder:<id>"]`。到点后任意一次 `desk` 唤醒触发 `settleDeskBatch` 扫表，把已取消的提醒当场复活并通知主人。
  2. **`desk:reply:*` 与 `desk:proposal:*` 僵尸污染**：`dismiss`/`abandon` 后 `desk:reply` 永停 `pending` 干扰同线索去重；`desk:proposal` 结案后永不清理，长期污染全文检索表 `state_fts`。
  3. **`cwd` / `status` / `source` 双写撕裂**：项目改目录后，`activeWorkspaces`、偏好 `cwdPrefix` 匹配与 Agents 视图持续使用陈旧的 `cells.spec.cwd`；`cells.status = "paused"` 混载手动暂停与 `someday` 停靠；`gtd:source` 与 `cells.status` 漂移靠投影强覆；内核 `@ng/cell` 多处反向硬编码读写 `gtd:*`。
- **修复方向（Batch 0 + Batch 1/2）**：
  - 彻底删除 `desk:reminder:*`、`desk:reply:*`、`desk:proposal:*` 三类影子 state；提醒唯一真相归 Inbox 延迟信封（到期原生直落 `HumanItem`）；
  - `cwd`/`status`/`processor`/`schedule` 全部以内核结构化表为唯一真相（放开受控 `updateCell(cwd)`），`cells` 拆正交 `pause_reason: "manual" | "parked" | null`；`settleGtdRecords` 下沉为 `PresetDef.onCellClosed` 钩子。
- **Phase 0 阶段修复结论（2026-11-21 · `partial`）**：
  - 已完成子项 1（提醒复活止血）：移除 `presets/src/inline-desk/{toolset,items}.ts` 与 `presets/src/shared/config.ts` 中的 `desk:reminder:*` 影子 state 与 `settleDeskBatch` 扫表复活，提醒唯一真相归 Inbox 定时信封，`cancel_scheduled` 后永不复活（`presets/test/phase0.test.ts` 覆盖）。
  - 提案 06 已清理其余影子键，项目目录、暂停原因与信源处理器读取当前 Cell。

---

## `BUG-022`（P0）：发消息 5 入口 4 语义（MCP `capture` 绕过 Watch、主对话丢来源）+ Script Sensor 两套相反执行引擎

**结案**　提案 06 已覆盖入站订阅与唯一脚本执行路径。

- **核心源码**：
  - 消息分叉：[desk.ts](../../apps/gtd-desk/src/server/desk.ts#L282)、[tools.ts](../../apps/gtd-desk/src/agent/tools.ts#L415-L430)（MCP `capture` 直写 `desk` 收件箱）、[tools.ts](../../apps/gtd-desk/src/agent/tools.ts#L617-L633)（`message_project`）、[tools.ts](../../apps/gtd-desk/src/agent/tools.ts#L898-L907)、[records.ts](../../presets/src/shared/records.ts#L48-L58)（漏判 `KERNEL_FROM.control`）
  - 脚本信源现由 [sensor.ts](../../presets/src/shared/sensor.ts) 注册并使用 [script-command.ts](../../presets/src/shared/script-command.ts) 构造命令。
- **根因与后果**：
  1. **消息路由与身份分叉**：Web 端 `capture` 走 `routing.ingest` + `matchWatches` 且幂等，而 MCP `capture` 直接入队 `desk`，绕过所有 `hub` 与回复监听 `watcher`；外部主 Agent 同时面对 5 个语义不一的发话工具；且 `records.ts:48` 漏掉 `KERNEL_FROM.control`，把 Web 主对话和 `chat_with_desk` 建的卡片/项目错标为「系统」。
  2. **脚本信源两套相反行为**：审计时 Web 新建脚本信源使用旧的 Loop 执行器（非零退出抛异常触发 5 次重试弹死信卡、`observe` 观察模式静默丢弃命中、无幂等键、首启即跑），而 `desk.add_source` 走 `gtd.sensor_script`（吞错写 `lastError`、`observe` 写笔记、带幂等键、首启不跑）。
- **修复方向（Batch 0 + Batch 2）**：
  - 全系统收口为唯二消息原语：`ingest`（无定向入站，必经 `matchWatches` 与去重）+ `directMessage`（定向直连）；抽出统一 `describeEnvelopeSource()` 到 `@ng/protocol`；
  - 移除 Loop 内的旧信源执行器，所有脚本信源统一使用 `gtd.sensor_script` 与唯一构造器。
- **Phase 0 阶段修复结论（2026-11-21 · `partial`）**：
  - 已完成 `presets/src/shared/records.ts` 的 `itemSource` 来源识别补齐：新增 `KERNEL_FROM.control` 识别（准确区分主对话与外部主 Agent，不再错标为「系统」；`presets/test/phase0.test.ts` 覆盖）。
  - 提案 06 已归一入站、定向发话和脚本信源执行路径。

---

## `BUG-023`（P1）：`knowledge(kind="note")` 书签污染 Prompt、`gtd:activity` 兼职墓碑、`save_skill` 绕过周回顾审批

**结案**　提案 06 已覆盖知识分类与技能提议。

- **核心源码**：
  - Prompt 混桶污染：[toolset.ts](../../presets/src/inline-desk/toolset.ts#L122)（`capture_note`）、[sensor.ts](../../presets/src/shared/sensor.ts#L64)（`观察笔记`）、[readmodel.ts](../../packages/cell/src/readmodel.ts#L359-L376)（`notesNote` 按字母序把全部 `kind="note", scope="cell"` 塞进每次唤醒 tail，上限 8,000 字）
  - 活动墓碑：[desk.ts](../../apps/gtd-desk/src/server/desk.ts#L661-L674)、[clarify.ts](../../apps/gtd-desk/src/server/projections/clarify.ts#L44-L53)
  - 技能绕审批：[context.ts](../../packages/loop/src/tools/context.ts#L388)（`save_skill` 在通用工具集）vs [toolset.ts](../../presets/src/inline-desk/toolset.ts#L664-L705)（`suggest_skill`）
- **根因与后果**：
  1. 主人随手存的书签/稍后看文章与 `desk` 自己的工作备忘录同桶，随手记越多 `desk` 每次唤醒白烧的 Token 越多，且字母序截断会把真正的工作记忆挤掉；`sensor` 观察日志每次 tick 全文回塞自己 prompt。
  2. 放弃失败外发卡不改 `approvals` 状态，靠往 `gtd:activity` 写一条 `card_withdrawn` 充当前端隐藏墓碑。
  3. 任意 Worker 或 Desk 可直接调 `save_skill` 写全局技能，完全绕过周回顾主人审批。
- **修复方向（Batch 2 + Batch 3）**：
  - 拆分 `knowledge.kind` 为 `working_note`（自动注入 tail）与 `reference`（仅按需读取）；
  - 失败外发放弃走统一 `HumanItem` 终态转换，让 `gtd:activity` 回归纯审计事件流；
  - 从通用 LLM 工具集移出 `save_skill`，LLM 侧一律走 `suggest_skill`。
- **Phase 0 已修复第 2 项**。放弃操作将失败审批转为已取消，队列直接读取审批状态。旧库按带有明确审批编号的放弃记录迁移，恢复后只能用新修订号重试。

---

## `BUG-024`（P1）：角色与工具边界冲突——`watcher` 三身合体、同 LLM 混持冲突工具、`maxConcurrentChildren` 双口径

**结案**　提案 06 已覆盖角色、工具与并发计数。

- **核心源码**：
  - `watcher` 叶节点打架：[watcher.ts](../../presets/src/shared/watcher.ts#L88-L103)（`preset: "watcher"` 覆写 `lifetime: "persistent"`）、[cell.ts](../../packages/protocol/src/contract/cell.ts#L110-L112) vs [agents.ts](../../apps/gtd-desk/src/server/projections/agents.ts#L204-L206)、[messages.ts](../../packages/cell/src/messages.ts#L55)
  - 冲突工具并置：[processors.ts](../../presets/src/shared/processors.ts#L5-L24)、[schedule.ts](../../packages/loop/src/tools/schedule.ts#L12)（`set_reminder` 描述声称给主人设提醒）、[comms.ts](../../packages/loop/src/tools/comms.ts#L546-L589)（`project` 调 `pause_self` 撕裂 `gtd:project` 影子态）
  - 并发配额双口径：[lifecycle.ts](../../packages/cell/src/lifecycle.ts#L287-L295) vs [policy.ts](../../packages/gate/src/policy.ts#L170) & [gate.ts](../../packages/protocol/src/contract/gate.ts#L157-L176)（4 类僵尸 `ProposedAction`）
  - *(记录留档 · `by design`)*：[loop.ts](../../packages/loop/src/cli/loop.ts#L648-L682) vs [processors.ts](../../presets/src/shared/processors.ts#L9-L56)（原审计建议给只读角色配 `allowedTools` 剥离宿主机 `write/edit/bash`——**2026-11-21 主人明确拍板不加此类宿主能力限制，唯一拓扑硬限制仅保留叶节点 `worker` 禁止派生子 Cell `maxDepth: 0`**）
- **根因与后果**：
  1. `reply_watcher` 在内核按 `persistent` 被视为非叶（不抄送父项目），在 UI 按 `preset === "watcher"` 被视为叶节点并谎称已抄送。
  2. 在影子状态尚未清除时，同一模型同时持有重叠的工作台内部工具（如 `remind_me` vs 描述冲突的 `set_reminder`、`finish_project` vs `pause_self`），容易误选导致状态分裂。
  3. `Gate` 保留着旧口径的并发计数与 4 类僵尸 `ProposedAction`。
- **修复方向（提案 06 · 阶段 B，遵循「做正交减法、不限制宿主能力」原则）**：
  - 拆分 `checker(one_shot)` 与 `reply_watcher(persistent)`，全系统只认内核 `isLeafLifetime`（抄送改显式 `ccParent`）；
  - 通过提案 06 清除影子状态从根源消除状态分裂，同时修正 `set_reminder` 误导描述、清理重叠包装工具与 `Gate` 僵尸 `ProposedAction`；不对任何角色施加宿主机 `read/write/edit/bash` 限制。
