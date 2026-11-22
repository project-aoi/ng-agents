# Bug 详情单（2026-11-21 架构审计）：状态流转、死锁、崩溃恢复与防误操作（`BUG-025` ～ `BUG-031`）

> **来源**：2026-11-21 全仓状态机与容错对抗审计（覆盖 LLM 犯蠢、人类按错/反悔、并发竞态与崩溃恢复；已与 [BUG-20261119-cards-and-coordination.md](./BUG-20261119-cards-and-coordination.md) 去重并合流至修订版[提案 05](../05-proposals/05-unified-human-inbox-and-custom-cards.md)）。

---

## `BUG-025`（P0）：`subjectKey` 碰撞引发「跨 Cell 静默覆盖」与「内核故障升级被业务卡静默吞噬」双重死锁

**本轮回归**　同一主题不能被另一个 Cell 静默覆盖，内核保留的主题命名空间、死信和超步继续分别有回归。见 `packages/gate/test/authorize.test.ts`、`packages/cell/test/dispatch.test.ts` 和 `packages/cell/test/docs05-settle.test.ts`。

- **核心源码**：
  - [gate.ts](../../packages/gate/src/gate.ts#L524-L569)（`deferAction` 静默将旧卡置 `superseded`，不投任何信封）
  - [escalations.ts](../../packages/cell/src/escalations.ts#L95-L109)（`subjectOf` 返回 `project:<id>`；`raise` 遇已有同 `subjectKey` 卡直接 `return existing`）
  - [util.ts](../../packages/loop/src/tools/util.ts#L18-L38)（`cell.message` 不在 `ITEM_TYPES`，缺省全撞在 `cell:desk`）
  - [watcher.ts](../../presets/src/shared/watcher.ts#L202-L239)
- **根因与后果**：
  1. **跨 Cell 静默覆盖失联**：同项目两个 Worker 或 `desk` 两条来自 `cell.message` 的仲裁卡撞在同一 `subjectKey` 时，Gate 将旧卡标 `superseded` 却不唤醒旧发卡 Cell。旧 Cell 因 `deferred_for_approval` 跳过 `notifySettled` 且永收不到 `approval.resolved`，永久挂死；`desk` 第一条仲裁卡被覆盖则第一批 waiters 永不苏醒。
  2. **内核故障升级被静默吞掉**：只要项目名下挂着任意一张待处理普通卡（含已推迟），同一项目内其他分支触发 `budget_exhausted`、`dead_letter`、`step_limit` 或 `refused` 时，`escalations.ts:108` 查到旧卡直接返回——**不弹升级卡、不改旧卡、不报警**，后台永久冻结。
- **修复方向（Batch 1 核心底座）**：
  - 解耦「议题去重键 `subjectKey`」与「项目归属 `relatedProjectIds`」；强制命名空间隔离（`kernel:<cellId>:<reason>` 永不与业务卡共享，`desk` 仲裁卡禁回退到全局 `cell:desk`）；
  - 禁止跨 Cell 静默 `superseded`，同 Cell 覆盖必同事务投递 `wakeup` 通知；`escalations` 仅允许同 `cellId + reason` 去重。

---

## `BUG-026`（P0）：`drainSteerSync` 未送达即标 `'done'` + CLI `deliver()` / `relaunchWith` 竞态丢弃，紧急纠偏永久丢失

**本轮回归**　`packages/loop/test/cli-followup.test.ts` 在续接失败后重建原始输入和运行中吸收的跟进，覆盖有无历史文本的场景。暂停时未确认的纠偏由下一轮接收。

- **核心源码**：
  - [inbox.ts](../../packages/inbox/src/inbox.ts#L547-L569)（`drainSteerSync` 直接写 `status = 'done'` 而非 `'claimed'`）
  - [inbox.ts](../../packages/inbox/src/inbox.ts#L352)（`finishClaim` 仅重放 `status = 'claimed'`）
  - [loop.ts](../../packages/loop/src/cli/loop.ts#L400-L428)（`relaunchWith` Leg-2 遇 `resumeTrouble` 重建 fresh session 时丢失 Leg-1 吸收的 follow-up/steer）
  - [loop.ts](../../packages/loop/src/cli/loop.ts#L476-L490)、[loop.ts](../../packages/loop/src/cli/loop.ts#L609-L627)（`deliver()` 遇 `finished`/`endOutcome` 直接 `return` 丢弃已标 `'done'` 的 steer）
- **根因与后果**：
  1. 主人或父项目发出的紧急 `control.steer` 刚被 `poll` 抽出就在 SQLite 标成终态 `'done'`。若 CLI 恰好进入收尾窗口被 `deliver()` 跳过，或本轮随后报错/暂停/崩溃触发 `releaseSync`，该纠偏消息永不重放、CLI 重试也不会看到，**100% 永久丢失**。
  2. 不支持运行中 stdin 注入的 CLI（如 Codex）把跟进消息攒进 `relaunchWith` 跑 Leg-2 时，若 Leg-2 触发 `resumeTrouble` 回退 fresh session，只传了空的 Leg-2 `out.relaunchWith`，Leg-1 认领的跟进消息蒸发且 Leg-1 工作被重做。
- **修复方向（Batch 0 止血）**：
  - `drainSteerSync(cellId, claimId)` 与 `drainInboundSync` 对齐，改为标 `status = 'claimed'` 绑定当前 claim，随 `settleRun` 一同完成，异常/未送达自动回滚 `pending`；
  - `cli/loop.ts` 维护贯穿整个 Run 的 `absorbedInputs`，fresh fallback 时基于最新 evidence 重建 transcript 并带齐全部吸收输入。
- **Phase 0 修复结论（2026-11-21 · `fixed`）**：
  - `packages/inbox/src/inbox.ts`：`drainSteerSync(cellId, claimId)` 返回 `{ envelopeId, message }` 并改为写 `status = 'claimed', claim_id = ?`，新增 `requeueClaimedSync(claimId, envelopeIds, reason)` 精准退回未确认信封；
  - `packages/loop/src/cli/loop.ts` & `adapters/{claude,codex,agy}.ts` & `packages/loop/src/loop.ts`：
    - `DriverIO.write()` 显式返回 `boolean`，但不轻信 `steer() === true`——每条追加输入以 `AppendedInput` 按 `envelopeId` 追踪并绑定目标确认轮次 `confirmAtTurn`（单批合并一次 `d.steer` 防止 Agy 自取消；`turn_end` 须 `ok && !stopped` 且轮次恰好等于目标轮次才确认；`endRun` / `budget_stopped` / `step_limit` / `refused` / 进程异常退场一律退回未确认项）；
    - `rebuildFreshPrompt` 按当前 `runId` 过滤 SQLite `evidence` 并严格按 `envelopeId` 合并未确认输入（零重复且保留同文本不同信封），限制最大重建/无进展重跑次数杜绝死循环，Codex `interruptedForSteer` 续聊排除已入会话的首轮 prompt 避免重复；API loop 在 `steps === maxSteps` 末步不再提前抽走 steer/inbound。
  - **测试覆盖**：`packages/inbox/test/control.test.ts`、`packages/loop/test/cli-followup.test.ts`（含 Claude 退出竞态、Codex 失败 resume 重建、Agy 多 follow-up 合并）。

---

## `BUG-027`（P0）：macOS 孤儿 CLI 清理硬编码 `/proc` 彻底失效（双 CLI 并发写仓库）+ `workspace.recover` 误杀活 Job + 后台 Job 无超时

**本轮回归**　`packages/loop/test/cli-orphans.test.ts` 与 `packages/workspace/test/jobs.test.ts` 覆盖支持和忽略 SIGTERM 的子进程、重附着取消及进程组退出。macOS 包装进程捕获 TERM，实际程序仍可安装自己的 TERM 处理函数。

- **核心源码**：
  - [process.ts](../../packages/loop/src/cli/process.ts#L154-L268)（`cliProcessAlive` 读 `/proc/${pid}/environ`、`descendants()` 读 `/proc`，在 macOS 恒抛错返 `false`/`[]`）
  - [jobs.ts](../../packages/workspace/src/jobs.ts#L115-L193)（`job_start` 无任何 `timeoutMs` 上限）
  - [jobs.ts](../../packages/workspace/src/jobs.ts#L515)、[util.ts](../../packages/workspace/src/util.ts#L133)（`recover()` 将 macOS `ps` 偶发 `null` 折算为 `false` 误判已死）
- **根因与后果**：
  1. **macOS 上重启必现双 Agent 踩踏仓库**：服务崩溃重启时 `kernel.start()` 先释放批次再调 `reapOrphanedCliProcesses`——因 `/proc` 不存在，一个孤儿 CLI 不杀还删了 PID 文件，随后调度器立即在同一真实仓库拉起第二个 CLI 进程并发改代码；正常 `kill()` 也漏杀跨组子进程。
  2. `workspace.recover()` 将探测不确定（`null`）直接判死，同样可能放行新 Run 与仍在写盘的活 Job 撞车。
  3. 若 LLM 用 `job_start` 启动了监听式/卡死命令（如忘加 `--run` 的测试或等密码的 `ssh`），无超时上限将永久锁死 `@Agent` 锚点并阻断 `notifySettled`。
- **修复方向（Batch 0 止血）**：
  - `cli/process.ts` 复用/对齐 `packages/workspace/src/util.ts` 的 macOS `ps -E -ww` 与 `ps -eo pid=,ppid=` 探测及进程树扫描；
  - `workspace.recover()` 遇 `null` 走 `#reattach` 多次确认；
  - 为 `job_start` 增加默认最大时长上限与静默无输出告警。
- **Phase 0 修复结论（2026-11-21 · `fixed`，已在 macOS 实机验证）**：
  - `@ng/protocol/src/process.ts` 抽出跨平台三态进程探测（Linux `/proc`、macOS `ps -E -ww` + `ps -ww` 对比识别 SIP 剥离环境返回 `null`、`ps -eo pid=,ppid=` 后代树），`@ng/workspace` 与 `@ng/loop` 共用同源实现；
  - `packages/loop/src/cli/process.ts` & `packages/cell/src/dispatcher.ts`：移除 Linux `/proc` 硬编码，`reapOrphanedCliProcesses` 遇 `null` 绝不误杀也不删 PID 文件，调度器以 `unknownOrphans` 暂缓同 Cell 替代进程并按 `cellId` + `skipOwnerPid` 隔离收割（绝不误杀同内核其他活 CLI，且 `still !== true` 不再扫潜在复用 PID 的后代树）；
  - `packages/workspace/src/jobs.ts`（schema v3 加 `timeout_ms`）：`/bin/sh` `$0` 携带 `NG_JOB_ID=<jobId>` 绕过 macOS SIP 对 `/bin/sh` 环境的剥离；`recover()` 遇 `null` 走 `#reattach` 多次确认且在确认身份前不提前触发超时、`#terminate`/`#waitGone` 保持三态不把 `null` 折成 `false`；`job_start` 增加默认 30m / 上限 4h 超时（`exitCode: 124`，崩溃重启后仍保 124）。
  - 启动恢复队列和孤儿进程时核对启动标记、进程启动时间与命令。身份持续不可读时有界重查，放弃追踪时不向未知进程发送信号。默认连续 5 分钟无输出时向所属 Cell 投递一次 `job.warning`。
  - **测试覆盖**：`packages/workspace/test/jobs.test.ts`、`packages/loop/test/cli-orphans.test.ts`、`packages/cell/test/phase0.test.ts`（含 macOS 真实 `ps -E` 与孤儿隔离用例）全绿。

---

## `BUG-028`（P0）：审批落账与唤醒两事务撕裂、`reconcile` 漏非发信卡、`channel.send` `:retry:` 换 key 引发 `unknown` 409 死锁与静默吞唤醒

**本轮回归**　`presets/test/phase0.test.ts` 从发送后的 SQLite 快照模拟再次认领，分别验证 `draft_reply` 和 `send_message` 命中常设规则时只向通道提交一次。

- **核心源码**：
  - 两事务撕裂与 `reconcile` 漏网：[approvals.ts](../../packages/cell/src/approvals.ts#L90-L109)、[approvals.ts](../../packages/cell/src/approvals.ts#L186-L195)、[approvals.ts](../../packages/cell/src/approvals.ts#L308-L325)、[approvals.ts](../../packages/cell/src/approvals.ts#L414-L430)
  - `:retry:` key 脱节与静默核实：[approvals.ts](../../packages/cell/src/approvals.ts#L142-L169)、[approvals.ts](../../packages/cell/src/approvals.ts#L394-L404)、[hub.ts](../../packages/channel/src/hub.ts#L411-L423)、[desk.ts](../../apps/gtd-desk/src/server/desk.ts#L652-L659)
- **根因与后果**：
  1. **崩溃丢唤醒**：所有审批状态更新（TX 1）与 `deliverResolved` 入队（TX 2）分离提交，且 TX 2 异常被吞；中间崩溃后卡已消失但 Cell 永不苏醒。`reconcile()` 又写死只查 `channel.send`，跳过 `project.start` 与 `custom` 卡；`continue` 忽视 `approveSync` 返回值，遇并发取消仍谎报成功。
  2. **外发重试 `unknown` 永久 409 死锁 + 重复外发风险**：token 被拒后重试换用了 `${actionId}:retry:...` 写 outbox，但 `resolveUnknownSend` 和 `reconcile` 仍按旧 `rec.actionId` 查 outbox！重试落入 `unknown` 后主人核实永远报 409，卡片霸占最高优先级和 `subjectKey` 删不掉；崩溃恢复则误读旧 `failed` 行诱导重复外发。
  3. **`resolveUnknownSend` 硬编码 `silent: true`**（line 401）：主人核实完「对方收到/没收到」后不唤醒发卡 Cell，且漏传用户 `note`，导致等待发信结果的子任务永久卡死。
- **修复方向（Batch 0 止血）**：
  - 所有非 I/O 审批落账与 `deliverResolved` 进同一 `withTx`；`reconcile()` 对非发信 `approved` 卡幂等补发回执；`continue` 校验 `approveSync` 返回值并全分支接入 `inflight` 互斥；
  - 持久化最新 `outbox_key`（或按 `action_id` 取最新行）；`resolveUnknownSend` 改为 `delivery: "wakeup"` 并透传 `note`。
- **Phase 0 修复结论（2026-11-21 · `fixed`）**：
  - **外发三步 Saga**（`packages/channel/src/{outbox,hub}.ts` & `packages/cell/src/approvals.ts`，channel schema v3 为已有 `action_id` 加索引）：
    - TX 1：`approveSync` + 按需 `issueTokenSync`（含内容变化检测）+ `hub.prepareSendAttemptSync` 预写 `pending` 尝试序号（登记 `preparedInflight` 防启动恢复误扫）；
    - 事务外：`hub.deliverPreparedAttempt(rowId, attemptSeq)` 直接发送已登记尝试（不经 `hub.send()` 防短路）；
    - TX 2：`hub.finalizePreparedAttemptSync` 以 `attempts = ?` 条件写回结果（防迟到旧尝试覆盖新尝试）+ `recordOutcomeSync` + 验真 `deliverResolved`（若发卡子节点中途关闭则转交最近存活祖先保住已知送达结果）；
  - **`:retry:` 闭环与核实唤醒**：按 `action_id` 关联最新 Outbox 尝试行，重发改稿自动签发新 token + `:retry:` 行；`resolveUnknownSend` 仅限 `owner`、改为 `delivery: "wakeup"` 并透传 `note`；
  - **常设信任规则自动发信闭环**（`presets/src/inline-desk/toolset.ts` & `packages/gate/src/gate.ts`）：按稳定 `idempotencyKey` 记入 Outbox，遇 `unknown` 建/找唯一核实卡（不再谎报已发且同主题阻止再次自动放行），遇 `failed` 明确可重试；
  - 常设授权以发起 Cell、来源信封和收件人生成稳定键，规则计数、批准记录和 Outbox 尝试同事务提交。通道回执写回前崩溃时，重启只生成核实事项。主人核实时回传卡片修订号和尝试序号，界面展示 Outbox 保存的正文。
  - **非 I/O 审批原子化与 `reconcile`**：所有非 I/O 审批状态变更与 `deliverResolved` 纳入同一 `withTx` 且验真落为 `pending`（绝不吞错或放过 `dropped_epoch`/`cancelled`）；`reconcile()` 覆盖非发信 `approved` 卡并跳过已关/过期子节点；`continue` 先校验 `approveSync`/`withdrawSync` 再加预算。
  - **测试覆盖**：`packages/channel/test/hub.test.ts`、`packages/gate/test/approvals.test.ts`、`packages/cell/test/phase0.test.ts`、`presets/test/phase0.test.ts` 全绿。

---

## `BUG-029`（P0）：LLM 犯蠢流转死角——`one_shot` Watcher 忘调 `wait()` 自杀谎报 `done`、`finish_project` 先写终态产生僵尸、`waits` 无校验与 `clear_wait` 阻断 `notifySettled`

- **核心源码**：
  - `one_shot` 假完成：[schedule.ts](../../packages/loop/src/tools/schedule.ts#L45-L48)、[cells.ts](../../packages/loop/src/tools/cells.ts#L202-L212)、[dispatcher.ts](../../packages/cell/src/dispatcher.ts#L480-L505)、[books.ts](../../presets/src/project/books.ts#L138-L139)
  - `finish_project` 假完结僵尸：[toolset.ts](../../presets/src/project/toolset.ts#L366-L399)、[dispatcher.ts](../../packages/cell/src/dispatcher.ts#L469-L505)
  - `waits` 残留锁死：[waits.ts](../../packages/cell/src/waits.ts#L68-L106)、[ports.ts](../../packages/cell/src/ports.ts#L462-L464)、[dispatcher.ts](../../packages/cell/src/dispatcher.ts#L485)
- **根因与后果**：
  1. `set_reminder` 和 `update_cell(watches)` 均未返 `awaitsWakeup: true`。`one_shot` Watcher 设完下次巡检若忘调 `wait()`，`settleRun` 立即将其当 `completed` 关停（顺手取消刚设的定时器）并向父项目发 `cell.result(completed)`，父项目自动把等待动作标 `done` 误以为条件已满足。
  2. `finish_project` 在工具执行期就提前提交 `lifecycle = "completed"` 并向主人报喜；若同轮遇 `blockingChildren` 拦截、并发弹卡或报错，`settleRun` 不关 Cell，留下「界面已完成、内核仍活着、StallMonitor 失明」的僵尸；另 `someday`/`pause_self` 声明 `closeChildren: true` 却不关子 Cell 且跳过排空。
  3. `waits.register` 无格式校验且全仓未暴露 `clear_wait` 工具。Worker 拼错 `waitingFor` 或中途被父项目改道后旧 wait 永不清零，连显式 `report_to_parent(result)` 也会因 `activity === "waiting"` 被 `dispatcher.ts:485` 跳过 `notifySettled`，永久锁死父项目。
- **修复方向（Batch 1）**：
  - `set_reminder` 与非空 `watches/schedules` 的 `update_cell` 返回 `awaitsWakeup: true`；`one_shot` 若有未决 timer/watch/job/card 且未显式 `report_to_parent` 禁自动关停；
  - `finish_project` 终态与完结通知延后到 `settleRun` 同事务原子提交；`pause` 先做排空；
  - `waits.register` 强校验合法地址与存活目标，暴露 `clear_wait`，`wakeable` 调 `report_to_parent(result)` 时自动清自身 open waits。

---

## `BUG-030`（P0）：`StallMonitor` 三大盲区（一次性通知即永死、四类节点脱管、环等/暂停假锚点）+ 多 Worker 撞预算漏唤醒 + 预算锁死 0-Token 记账

**结案**　提案 06 已覆盖共享升卡计数与非项目孤儿等待。本轮补测同子树空等、三节点环、预算挂起目标、按项目判断仲裁和相同原因再次触发。见 `packages/cell/test/docs05-anchors.test.ts`。根节点耗尽预算时个人提醒仍可送达，见 `presets/test/phase0.test.ts`。

- **核心源码**：
  - Stall 盲区：[stall.ts](../../packages/cell/src/stall.ts#L44-L109)、[readmodel.ts](../../packages/cell/src/readmodel.ts#L439-L469)、[books.ts](../../presets/src/project/books.ts#L72-L128)
  - 预算遗漏与掐死 0-Token：[dispatcher.ts](../../packages/cell/src/dispatcher.ts#L196-L208)、[dispatcher.ts](../../packages/cell/src/dispatcher.ts#L522-L537)
- **根因与后果**：
  1. **一次性通知永死**：`stalledNotifiedAt` 只触发一次 `stalled_check`，若那一次模型又犯蠢或撞预算，系统永不再次救场也不升卡。
  2. **四类节点全脱管**：仅扫 `gtd:project`，导致 `hub` 及其 Worker、`desk` 直属 Worker、首轮未跑完的项目、裸 `spawn_cell(project)` 全部脱离监控。
  3. **三类新假锚点**：子树内环等（`W1` 等 `proj` 而 `proj` 静默/反等）、等已 `paused` 外部节点、卡死的 LLM reply watcher 留着活 `cell_watches`。
  4. **预算续费漏唤醒与锁死 0-Token**：多 Worker `spent > 0` 中途撞父预算不进 `held`，续费后仅唤醒第 1 个；`desk` 预算耗尽时 `pump()` 连 `snooze` 回弹和 `remind_me` 等 0-Token `prepareRun` 一起掐死。
- **修复方向（Batch 1）**：
  - `StallMonitor` 改为两段式（自救超时自动升 `stalled` 卡片给主人）；项目创建同事务写初始 `gtd:project`；非项目活 Cell 纳入孤儿 wait 巡检；`anchorsOf` 排除 `paused`、做同子树环检测、并按精准关联修复 `BUG-017`；
  - `ledger.raised` 补发续跑给最近 `budget_stopped` 活跃 Cell；`pump()` 放行纯 0-Token 记账批次穿透预算检查。

---

## `BUG-031`（P0/P1）：人类误操作不可逆（取消/完结项目、`deny`、`done`）、`paused/someday` 隔离缺失、DND 崩溃永锁与 4 处 Epoch/时钟竞态

**结案**　提案 05、06 已覆盖按代次重开、撤销、专注租约、暂停节点路由隔离和时钟回拨。立即信封与重试信封也参加重新调度。暂停项目或分身的确认恢复、过期卡返回冲突见 `apps/gtd-desk/test/api.test.ts`。订阅路由与时钟回拨见 `packages/cell/test/routing.test.ts` 和 `packages/inbox/test/schedule.test.ts`。

- **核心源码**：
  - 不可撤销：[desk.ts](../../apps/gtd-desk/src/server/desk.ts#L645-L721)、[desk.ts](../../apps/gtd-desk/src/server/desk.ts#L843-L860)、[lifecycle.ts](../../packages/cell/src/lifecycle.ts#L508-L519)
  - 暂停隔离与蒸发：[routing.ts](../../packages/cell/src/routing.ts#L34-L46)、[desk.ts](../../apps/gtd-desk/src/server/desk.ts#L449-L492)、[hub.ts](../../packages/channel/src/hub.ts#L218-L244)
  - 4 处竞态：[lifecycle.ts](../../packages/cell/src/lifecycle.ts#L429)（固定 `${id}:closed` 吞重开后二次关闭）、[inbox.ts](../../packages/inbox/src/inbox.ts#L744-L757)（`cancel` 与 `close` 两事务）、[dispatcher.ts](../../packages/cell/src/dispatcher.ts#L552-L578)（`answeredBy` 过早删 wait & `resurface`+`silent_inject` 合并误醒）、[inbox.ts](../../packages/inbox/src/inbox.ts#L909-L938)（NTP 时钟回拨使 `(now, watermark]` 延迟信封永睡）
- **根因与后果**：
  1. 误关项目无 `reopenProject`，误点 `deny`（无确认、不写活动、0-Token 吞掉）与 `done`（`restorable: false`）均不可撤销；
  2. 已暂停的 `hub`/`someday` watcher 仍拦截外站消息积压；对暂停项目卡片点 `revise` 永久转圈；`someday` 先撤卡再建项目，遇目录失效卡片蒸发；暂停无确认强杀活 Job；浏览器崩溃致持久化 DND 永锁；
  3. 重开 Worker 二次关闭被 `deduped` 父项目不知情；NTP 回拨几百毫秒可让 `stalled_check`/`waitTimeout` 永远沉睡。
- **修复方向（Batch 1 + Batch 2 + Batch 3）**：
  - 新增受控 `reopenProject` 与非外发决策的撤销 Toast / 恢复流（主人已拍板纳入）；
  - 隔离暂停态路由、操作暂停项目卡片自动提示恢复、`someday` 撤卡与建项目同事务、DND 拆手动开关与带 TTL 租约的编辑态自动专注；
  - 关闭信封 ID 带 `epoch`、`cancel` 与 `close` 原子化、`answeredBy` 后移至 `settleRun` 并剥离 `resurface`、修复 `inbox` 时钟回拨 `watermark`。
