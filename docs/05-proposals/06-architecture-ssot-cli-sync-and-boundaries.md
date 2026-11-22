# 演进提案 06（2026-11-21 终审定稿 · 继 05 后实施）：真 SSOT、CLI 游标同步协议、唯一领域命令层与概念正交收敛

> [!IMPORTANT]
> **状态**：已分三步实施，现行行为见第一、二层规范。
> **实施顺序**：**`Phase 0（共同 P0 止血）` → `提案 05（人机协作、统一人类入口、零死状态卡片与撤销重开）` → `提案 06（本提案：内核与控制面深度架构收敛）`**。  
> **配套关系**：[提案 05](./05-unified-human-inbox-and-custom-cards.md) 解决表层与人机协同闭环（并前置落地了最小版 CLI 游标补漏、按代次清理与 `cell_waits` 多独立等待）；本提案拔除 2026-11-21 全仓审计暴露的 **4 根底层结构性病根**，覆盖 [BUG-20261121-orthogonality-and-control.md](../03-bugs/BUG-20261121-orthogonality-and-control.md)、[BUG-20261121-lifecycle-and-resilience.md](../03-bugs/BUG-20261121-lifecycle-and-resilience.md)、[BUG-20261121-context-and-visibility.md](../03-bugs/BUG-20261121-context-and-visibility.md) 中的底层架构项。

---

## 一、设计原则与明确边界（2026-11-21 主人拍板）

1. **做减法、立唯一真相源，而非堆补丁**：同一份事实全系统只允许有一个权威存储（SSOT），通过删除影子表与重复执行器消除状态漂移。
2. **不阉割 Agent 的宿主机能力**：**明确不对 `desk`、`project`、`hub`、`sensor` 的宿主机 `read / write / edit / bash` 施加 `allowedTools` 硬限制**——唯一的拓扑能力硬限制维持「**叶节点 `worker`（及 `checker`）禁止派生子 Cell（`maxDepth: 0`）**」（以及既定的 `ownerOnly` 外部副作用红线与 `RED_LINES`）。
3. **安全承诺的坦诚边界**：`ownerOnly` 与 `DeskService` 是在**工作台所有受控入口层**强制执行的权限与防呆护栏；在保留同一 macOS 用户下完整宿主机能力的前提下，不试图构建 OS 级多用户/提权隔离沙箱。
4. **用「消除双轨状态 + 保护保留键」代替「给 LLM 戴手铐」**：当 `cells` 与业务状态不再双写撕裂、`set_state` 拒绝改写保留权威前缀后，无需对宿主工具加繁琐黑名单即可防止状态破坏。
5. **与提案 05 零返工衔接**：`05` 在落地时即独立建 `HumanItem` 表、MCP 直接经由 `DeskService`、并提前启用最小 CLI 游标补漏与按代次清理，确保「先干完 05、再干 06」零返工。

---

## 二、契约 1：真 SSOT 字段归属与解除「假薄内核」反向耦合

### 2.1 全系统实体字段唯一真相源（SSOT 归属矩阵）

| 实体 / 事实维度 | 唯一真相源（权威表） | 彻底废弃/删除的影子存储 | 说明 |
| :--- | :--- | :--- | :--- |
| **Cell 存活、目录与暂停原因** | `cells`（新增 `pause_reason: "manual" \| "parked" \| "budget_declined" \| null`；放开受控 `updateCell(cwd)`） | `gtd:project.cwd`、`gtd:source.status`、`gtd:source.processor` | `activeWorkspaces`、偏好 `cwdPrefix`、Agents 视图、Radar 与 Sources 投影全部只读 `cells`，杜绝目录漂移与暂停态语义撕裂（`BUG-021`）。 |
| **定时周期与一次性提醒** | `inbox_schedules`（周期）+ `inbox_messages(deliver_at)`（一次性提醒） | `cell_state["desk:reminder:*"]`、`gtd:source.schedule` | `cancel_scheduled` 直接原子取消提醒，彻底根治「已取消提醒被 `settleDeskBatch` 扫表复活」（`BUG-021`）。 |
| **面向人类的待处理事项** | `HumanItem` 独立表（独占 `pending/snoozed/unknown/resolved/cancelled`）× `Gate`（纯授权记录）× `Outbox`（外发尝试） | `gtd:action(owner="human")` 双轨状态、`desk:reply:*`、`desk:proposal:*`、失败卡的 `gtd:activity` 墓碑 | 回复草稿查重、提案参数（含 `cwd/repos/phases`）、失败卡放弃均回归权威表与 `artifacts`（`BUG-021`、`BUG-023`）。 |
| **外部/内部等待与仲裁关系** | `cell_waits`（主键支持 `wait_id` / `ref_id` 多独立等待）+ `cell_watches` | `cell_state["desk:arbitration"]`、无锚点的裸 `gtd:action(owner="waiting")` | 内核 `tailNotes` 直接注入 `[cells waiting on you]`，取代手工维护的 `desk:arbitration` 软记忆（`BUG-017`、`BUG-021`）。 |
| **项目业务元数据** | `gtd:project`（瘦身为纯业务字段：`title / outcome / summary / plan / source / completedAt`） | 不再存 `cwd`、不再用 `lifecycle` 表达「暂停」 | `lifecycle` 仅保留 `active \| completed \| cancelled` 业务阶段，停靠、手动暂停与预算拒绝停工统一由 `cells.status + pause_reason` 表达。 |
| **信源业务元数据** | `gtd:source`（瘦身为纯业务字段：`title / mode / lastHitAt / lastError / description`） | 不再复制 `status / processor / schedule` | 状态与频率直接联合投影自 `cells` 与 `inbox_schedules`。 |
| **活动记录流** | `gtd:activity`（纯只读事件流 + `restorable` 撤销快照） | 严禁再充当隐藏 `approvals(failed)` 的状态机墓碑 | 回归纯审计与用户撤销恢复职责（`BUG-023`、`BUG-031`）。 |

### 2.2 解除内核 `@ng/cell` 与 `@ng/loop` 对 `gtd:*` 的反向耦合

1. **`PresetDef.onCellClosed` 钩子**：将当前硬编码在 [lifecycle.ts](../../packages/cell/src/lifecycle.ts#L472-L489) 的 `settleGtdRecords` 迁出 `@ng/cell`，改为内核在关闭事务内调用预设注册的 `onCellClosed(ctx)` 钩子；
2. **`StallMonitor` 与 `anchorsOf` 抽象解耦**：
   - 将 [stall.ts](../../packages/cell/src/stall.ts#L44-L49) 的监控目标从硬扫 `gtd:project` 升级为基于 `CellSpec.stallPolicy`（`project` 预设声明受监控，不再依赖首轮 `prepareRun` 延迟写入 `gtd:project`，根治首轮未跑完就隐形的漏洞，`BUG-030`）；
   - 同时增加**非项目活跃 Cell 孤儿等待巡检**（覆盖 `hub` 及其 Worker、`desk` 直属 Worker）：任何持有 `cell_waits` 指向已静默/关闭目标且超时无锚点的非项目 Cell 自动告警；
   - `anchorsOf` 的人类球权检查直接查询 `HumanItem` 索引（按 `relatedProjectIds`），不再硬编码扫描 `gtd:action:` KV。
3. **移除 `@ng/loop` 中的 GTD 脚本执行器**：删除 [packages/loop/src/script.ts](../../packages/loop/src/script.ts#L39-L80) 中硬编码读写 `gtd:source` 的逻辑，全端脚本信源收口到 `presets` 的唯一 `gtd.sensor_script` 执行器（`BUG-022`）。

---

## 三、契约 2：CLI Session = SQLite Evidence 的带游标物化缓存同步协议

> [!IMPORTANT]
> **根治双脑分裂（`BUG-026`、`BUG-027`、`BUG-033`）**：正式确立 **SQLite `evidence` 表是全系统唯一记忆真相**，外部 CLI（Claude / Codex / AGY）的 `--resume` 会话仅被视为「带输入交付游标的物化加速缓存」。

### 3.1 游标语义与推进铁律（修正 `settleRun` 后置 `system_note` 遗漏反例）

每条 `cli_sessions` 记录维护同步状态：`(sessionId, lastDeliveredEvidenceSeq, systemHash, cwd, engine, model)`。

1. **游标严格按「已确认交付的输入」推进，绝不取本轮最后一条 evidence**：
   - 每次启动 CLI 或追加输入时，记录该批次涵盖的 `envelopeId` 列表及其写入的输入 `evidence` 序号范围（如模型本次实际见到了 `#100`）；
   - **`settleRun` 仅推进游标到能够确认已作为输入交付给 CLI 的连续范围上限（`#100`）**；结算后由内核新写入的 `system_note`（例如 `#101`：「仍有活子分身，刚才的 `complete_self` 未执行」）**绝不计入本轮已交付游标**，必然留给下轮补喂；
   - **0-Token 回合（`prepareRun === "handled"`）绝不动 CLI 游标**；
   - **并发隔离**：同一 CLI 会话同一时刻不允许多个并发 Run 共同推进游标。
2. **`control.steer` 生命周期纳入 Claim（不轻信 `steer() === true`）**：
   - [inbox.ts](../../packages/inbox/src/inbox.ts#L547-L569) 的 `drainSteerSync(cellId, claimId)` 携带实际 `claimId` 与 `envelopeId`，改为标 `status = 'claimed', claim_id = ?` 并按条追踪追加输入；鉴于 Claude 适配器调用 `io.write()` 在 stdin 已关闭时仍可能静默返回 `true`，进程收尾若无法确认接收必须将该条退回 `'pending'`，Run 失败/暂停/崩溃自动回滚（彻底根治 `BUG-026`）。

### 3.2 `--resume` 增量补漏与按 `envelopeId` 去重重放

1. **休眠期遗漏事件补喂（最小版提前在 `05-A1` 落地）**：
   - 每次 CLI 准备 `--resume` 前，扫描 `evidence` 中 `lastDeliveredEvidenceSeq < seq < currentBatchStartSeq` 的未交付记录（涵盖 0-Token 消化的关键 `inbound` 与结算期产生的 `system_note`）；
   - 无遗漏则 0 额外 Token；有遗漏则压缩为紧凑 `[events handled while you were asleep]` 区块前置拼入本次 `tailText`（`BUG-033`）。
2. **按 `envelopeId` 合并重放（严禁按裸字符串数组拼接）**：
   - `drainInbound` 已把追加消息写入 `evidence`。触发 fresh rebuild（`resumeTrouble` 或 `systemHash` 变化）时，**按 `envelopeId` 合并 SQLite `evidence` 与尚未确认交付的本轮追加输入**（保留原序，既避免同一条消息被读两遍，也不会误吞主人确实连发两句相同文字）；同批部分交付失败时，仅让未确认部分回队。
3. **把会话交付与动作执行分开核实，正视外部 CLI 隐式压缩**：
   - 工作台受控动作（立项、加额、外发）按稳定业务 ID / `Outbox` 查账；宿主机仓库操作不另造重型幂等层，依赖重启先验现场（`git status` / `Job` 状态）；
   - 即使游标、`sessionId`、`systemHash` 全对，外部 CLI 内部仍可能发生隐式压缩——依靠每轮 `tailNotes` 自带简短当前目标、未结等待、未决卡、人工改稿版本与 `res://` 指针兜底，不假设 CLI 永远记得早期原话。

### 3.3 `systemHash` 全因子清单、`fork_prefix` 分叉点与压缩保底

1. **完整兼容判定**：`systemHash = sha256(promptTemplateVersion + basePrompt + activePreferences + activeSkills + forkNote + effectiveToolContract)`，同时核对 `(engine, model, cwd)`；
   - 修复 `fork_prefix` 子 Cell 借用父 hash 的漏洞；[kernel.ts](../../packages/cell/src/kernel.ts#L311-L321) 同时监听 `preference` 与 `skill` 变更刷新 Prefix；[boot.ts](../../apps/gtd-desk/src/server/boot.ts#L175-L178) 启动比对代码计算 hash 自动升级老持久 Cell；
   - **`fork_prefix` 分叉点校验**：若某 CLI 适配器只能复制父会话的**最新状态**而父会话已越过子 Cell 创建时的 `uptoSeq`，直接改从 SQLite 的 `uptoSeq` 重建子会话，防止子 Cell 读到创建之后的无关父对话；同时补全 `codex.ts` `exec fork` 的 `-C req.cwd` 与 `developer_instructions` 及 `claude` 同 `cwd` 校验。
2. **压缩保底与重建防截断**：
   - 截断摘要永久钉住首条 `cell.task` 结构化摘要（目标 + `parentCellId` + 关键 `artifactId`，≤800 字，不参与 oldest-drop）；
   - `hydrate.ts` 遇单轮超 60k 时兜底保留末轮末段记录，杜绝 `keepRecentChars` 归零；
   - `cli/render.ts` 重建截断超 4000 字工具输出改用「头 2000 + 尾 1500 + 显式保留 `res://` 指针」。

### 3.4 跨平台子进程三态探测与后台 Job 超时（macOS / Linux）

- [packages/loop/src/cli/process.ts](../../packages/loop/src/cli/process.ts#L154-L268) 删除 Linux 专属 `/proc` 硬编码，复用与 [packages/workspace/src/util.ts](../../packages/workspace/src/util.ts#L90-L135) 同源的跨平台 `ps -E` / `ps -eo pid=,ppid=` 探测，并**保留「已确认存活 / 已退出 / 身份未知（`null`）」三态**：身份未知时保留 PID 记录并暂缓同运行的替代进程，避免误判并发写盘（`BUG-027`）；
- `workspace.recover()` 遇 `null` 走 `#reattach` 多次确认；`job_start` 增加默认最大运行超时（如 30 分钟，可配置上限）与无输出静默告警。

---

## 四、契约 3：唯一领域命令层（`DeskService`）、保留键护栏与单事务边界

### 4.1 调用层级越界红线与 `set_state` 保护

```text
[Web HTTP 路由]   [外部主 Agent MCP]   [Channel Ingress]   [Presets（经内核命令端口）]
       \                  |                  /                      /
        \                 |                 /                      /
         ▼                ▼                ▼                      ▼
      ================================================================
      唯一有类型领域命令层：DeskService / 内核命令端口（强制显式 DeskActor）
      ================================================================
        │  所有鉴权、seenItemRevision / seenArtifactVersion、级联清理、单事务封装
        ▼
      @ng/cell 内核（底线护栏：硬禁关/停根节点 + 保留键保护 + 原子原语）
```

1. **禁止越界直调与缺省提权**：
   - Web HTTP（`app.ts`、`agents.ts`）与 MCP 工具（`agent/tools.ts`）为纯协议薄壳，严禁直调 `kernel.control`、`kernel.closeCell`、`kernel.inbox.enqueueSync`、`gate.*` 写方法；预设通过内核注入的命令接口调用（不反向依赖 Web 应用）；
   - **`DeskActor` 显式必填**：所有写命令由已认证入口显式提供操作者身份，**取消漏传参数时静默退回 `ownerPrincipal` 的默认行为**（缺失即拒）；
   - `@ng/cell` 底层物理禁止 `pause`/`cancel`/`close` 根节点（`parentId === null`）。
2. **`set_state` 保留键前缀护栏**：
   - 通用工具 `set_state` 继续允许 Agent 自由写业务工作笔记与自定义键，但**硬拒绝直接改写保留权威键前缀**（`gtd:project`、`gtd:source`、`gtd:activity`、`cli:`、`sys:`），权威状态必须经由有类型命令修改，防模型填错键名破坏系统状态。
3. **唯二消息原语 + 唯一构造器**：
   - 全系统收口为 **`ingest(text, source, clientId)`**（无定向入站，必经 `matchWatches` + 幂等去重）与 **`directMessage(cellId, text, { mode, replyToId, ... })`**（定向直连）；抽出唯一 `describeEnvelopeSource()` 到 `@ng/protocol`；
   - 脚本信源收口到唯一 `gtd.sensor_script` + `createSensorSpec`；项目创建收口到唯一 `projectLaunch`（`BUG-022`）。

### 4.2 强制事务边界清单（严守同步 `withTx` 不可跨 `await`）

1. **非 I/O 人类事项结算**：单 `withTx` 内验 `seenItemRevision` + 改 `HumanItem` + 验真入队 `approval.resolved`（或 `defer` 替换回弹定时器）+ 写 `restorable` 活动快照；
2. **外部发信（三步 Saga）**：`TX 1` 落批准与 `outbox(sending)` 意图 → 事务外发信 → `TX 2` 按尝试序号落结果 + 更新 `HumanItem` + 验真入队回执；
3. **立项停靠（`someday`）**：单 `withTx` 内建停靠态项目 Cell + 标记原 `HumanItem` 结案；
4. **取消 Cell（`control.cancel`）**：单 `withTx` 内 `bumpEpoch` 清队 + `closeCellSync` 级联清理；
5. **项目结案（`finish_project`）**：仅在 `settleRun` 排空与 `blockingChildren` 校验通过的关闭事务内同步写 `gtd:project.lifecycle` 并通知；
6. **项目原地重开（`reopenProject`）**：等旧代次 `cleanupClosed` 退出后，单 `withTx` 恢复 `cells.status` + 按当前祖先权限恢复资格 + 翻回 `gtd:project.lifecycle` + 验真入队唤醒；
7. **等待消解（`waits.answeredBy`）**：移至 `settleRun` 批次真正消费完成时同事务按 `ref_id` 精确销账；
8. **NTP 时钟回拨与 `resurface` 隔离**：修复 `inbox` `watermark` 单调过滤遇 `now < watermark` 导致延迟消息永睡，以及 `resurface` 定时器与 `silent_inject` 同批合并误醒 LLM（`BUG-031`）。

---

## 五、契约 4：三维度正交拆分与知识桶隔离（做减法，不限制宿主能力）

1. **显式拆分三个独立维度 + 拆分 `watcher`（`BUG-024`）**：
   - 全系统严格区分并分别判断三件事，绝不再拿一个字段猜另一件事：
     - **`lifetime`（`one_shot | wakeable | persistent`）**：只表达「何时结算与是否自动归档」；
     - **`maxDepth`（`0` vs `>0`）**：只表达「能否派生子 Cell」（叶节点 `worker`/`checker` 锁死 `0`）；
     - **`ccParent`（`boolean`）**：只表达「主人直连发话时是否抄送父级」。
   - 按职责把 `watcher` 拆分为 **`checker`（`one_shot`）** 与 **`reply_watcher`（`persistent`, `ccParent: true`）**，废除 [agents.ts](../../apps/gtd-desk/src/server/projections/agents.ts#L204-L206) 按预设名猜叶节点的硬编码；历史 `preset === "watcher"` 记录读取时按 `lifetime` 平滑映射展示。
2. **拆分 `knowledge.kind` 隔离 Prompt 注入（`BUG-023`）**：
   - **`working_note`**：Agent 自我工作备忘录（如项目白板 `board`），自动注入每次唤醒的 `tailNotes`；
   - **`reference`**：主人随手收藏（`capture_note`）与信源观察日志（`sensor` `观察笔记`），**绝不自动注入 Prompt 尾部**，仅按需检索/读取；历史用户随手记平滑归类为 `reference`。
3. **工具与策略正交瘦身（遵循「不限制宿主能力」原则）**：
   - **明确不做**：不为 `desk`/`project`/`hub`/`sensor` 加 `allowedTools` 剥离宿主机 `read/write/edit/bash`；
   - **正交瘦身**：修正 `set_reminder` 误导描述（明确仅用于 Cell 定时自唤醒，不与 `remind_me` 冲突）；随影子表删除精简重叠包装；清理 `Gate` 中 4 类僵尸 `ProposedAction` 并统一 `maxConcurrentChildren` 为 `busyLeafChildren`。

---

## 六、与 `05` 的衔接顺序与独立实施排期

总体严格按 **`Phase 0（共同 P0 止血）` → `提案 05（阶段 A）` → `提案 06（本提案，阶段 B）`** 串行推进：

| 阶段 | 归属 | 核心交付 | 清零的 Bug |
| :--- | :---: | :--- | :--- |
| **Phase 0：共同内核 P0 止血** | `05` / `06` 共同前置 | `DeskActor` 必填、`seenItemRevision`、外发三步 Saga、`deliverResolved` 验真、`set_state` 保留键护栏；`drainSteerSync` 改标 `'claimed'` + 按 `envelopeId` 防重；macOS 三态进程恢复 + `job_start` 超时；内核硬禁关根 `desk` + MCP 走 `DeskService` + `decide_card` 强制 `seenVersion`；修 `draft_reply` 覆盖、`items.ts` 吞失败、`propose_project` 常设规则、`desk:reminder` 复活、`inspect_cell` 与 `records.ts`。 | `BUG-020`、`BUG-021`(提醒)、`BUG-022`(来源)、`BUG-026`、`BUG-027`、`BUG-028`、`BUG-032`、`BUG-034` |
| **阶段 A：完整落地提案 05** | **[提案 05](./05-unified-human-inbox-and-custom-cards.md)** | 详见提案 05：三责分离 `HumanItem × Gate × Outbox`、5+1 可定制卡片、预算拒绝防重弹、`cell_waits` 多独立等待、按代次清理与 `reopenProject` / 诚实撤销、**最小版 CLI 游标补漏**、旧库无损迁移、3 Tab UI、6 项核心故障验收测试全绿。 | `BUG-014` ～ `BUG-019`、`BUG-025`、`BUG-029`、`BUG-030`、`BUG-031`(撤销/DND/清理/暂停)、`BUG-033`(最小游标)、`BUG-035` |
| **阶段 B1：真 SSOT 与去内核反向耦合** | **本提案（06）** | `cells` 拆 `pause_reason` + 受控 `updateCell(cwd)`；删光 `desk:reply`/`proposal`/`arbitration` 与失败卡墓碑；`PresetDef.onCellClosed` 迁出 `settleGtdRecords`；`StallMonitor` 改基于 `CellSpec.stallPolicy` + 非项目孤儿巡检。 | `BUG-021`(其余)、`BUG-030`(非项目巡检) |
| **阶段 B2：完整 CLI 游标协议与剩余竞态** | **本提案（06）** | 全因子 `systemHash`（含发版与 Skill 刷新）、`fork_prefix` 分叉点校验与 Codex/Claude fork 修复、压缩钉住 `cell.task` 与重建保留 `res://`、修复 NTP `watermark` 与 `resurface` 隔离。 | `BUG-031`(其余竞态)、`BUG-033`(完整) |
| **阶段 B3：命令层与概念彻底收口 + 规范同步** | **本提案（06）** | Web/MCP 全部薄壳化收口到 `DeskService` + 唯二 `ingest`/`directMessage` + 删 `loop/src/script.ts` 唯一化脚本信源；按三维度正交拆 `checker`/`reply_watcher`、拆 `working_note`/`reference`、清 `Gate` 僵尸动作与修正重叠工具说明；**同步修订第一、二层权威规范**并将全量 `BUG-014` ～ `BUG-035` 闭环归档。 | `BUG-022`(其余)、`BUG-023`、`BUG-024`(宿主限制项 `by design`) |
