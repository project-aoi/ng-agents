# 内核调度、算力计量、预算护栏与宿主休眠缺陷单

> **状态**：`fixed（2026-11-19）`（`BUG-013` 子项 2 为 `superseded`；`BUG-009` 与 `BUG-013` 子项 1 仅在 Linux 上开发与测试，尚未在真实 Mac 上验证）  
> **发现来源**：[2026-11-18 trae-x 真实端到端压测审计](./audits/2026-11-18-traex-live-e2e.md)  
> **关联设计原则与用例**：[03-safety-and-boundaries.md](../01-principles/03-safety-and-boundaries.md)（`P-SAFE-7`）、[uc07-external-agent-and-overnight-hosting.md](../02-workflows/uc07-external-agent-and-overnight-hosting.md)（`INV-UC07-03` ～ `INV-UC07-05`）

---

## `BUG-001`（P0）：`budget_stopped` 认领后零 Token 短路，黑洞吞没状态化 CLI 会话的入站信封 {#bug-001}

- **精确源码位置**：
  - [packages/cell/src/dispatcher.ts](../../packages/cell/src/dispatcher.ts#L448-L490)
  - [packages/loop/src/cli/loop.ts](../../packages/loop/src/cli/loop.ts#L186-L233)
- **实测触发证据**：
  - `22:52:24` 项目一 `watcher` `qfh5ay` 结账使树根 `desk` 突破 `20M` 上限；随后协调器 `Run #4` 唤醒仅跑 **2ms** 即因 `budget_stopped` 中止（根本未拉起 Codex 进程），但内核已将刚投进来的 `inbox seq=39`（3,401 字监听报告）标为 `done` 并清空动作上的 `cellId`！
  - 等人类在 Web UI 点完续费后，协调器 `Run #5` 以 `codex exec resume` 醒来，只收到了新一批 `approval.resolved`，前一次唤醒的 `seq=39` 报告在持久化 CLI 会话里永久蒸发，直接导致协调器失忆多派了一棒核验 `worker`（白烧 `1.07M` tokens）；`00:02:18` `seq=52` 终审回执再次复现同一吞信封故障。
- **根因机理**：
  - `dispatcher` 在调用 `loop.run` **之前**就已经将入站信封写入 `evidence` 并执行了 `prepareRun`，且当 `loop.ts:186` 零 Token 短路返回 `budget_stopped` 后，仍把这批 `inbox_messages` 提交为 `done`。状态化 CLI 会话在后续 `resume` 时只喂当轮新增 `batch`，不会回放上轮未真正送入 CLI 的信封。
- **目标修复方向（对齐 `INV-UC07-04`）**：
  - 在认领消费信封、进入 `appendEvidence / prepareRun` **之前**先行做零成本预算门禁预检：若已处于 `hard_stop`，直接挂起出卡而不消费 `pending` 队列中的信封（和/或在 `cli:session` 记录 `lastDeliveredSeq`，`resume` 时自动补齐尚未真正送达 CLI 进程的入站信封）。
  - **防回归红线**：修复时不得破坏 `INV-SYS-01`（单会话串行锁）与 `INV-SYS-03`（一次性 `worker` 排空交卷事务）。
- **修复结论（`fixed（2026-11-19）`）**：
  - 预算停在认领**之前**生效：调度泵认领前先查账本，已处于 `hard_stop` 的 `Cell` 由 `hold` 挂起并出预算卡，信封留在 `pending` 不被消费，主人续费后全部送达；若某次 `Run` 在第一次计量前就以 `budget_stopped` 结束（`stoppedBeforeDelivery`：零花费、无任何模型输出），这批信封原样退回队列、不计尝试次数，并继续挂起直到续费。
  - 源码：[packages/cell/src/dispatcher.ts](../../packages/cell/src/dispatcher.ts)（`hold`、`stoppedBeforeDelivery`、调度泵中的预算检查）。
  - 回归测试：[packages/cell/test/wakeable.test.ts](../../packages/cell/test/wakeable.test.ts)（「the budget stop holds a cell before anything is claimed」组：「a held cell's messages stay in its inbox and are all delivered after the raise; one card, one click for the whole chain」）、[packages/cell/test/dispatch.test.ts](../../packages/cell/test/dispatch.test.ts)（「budget hard stop → an escalation card even though the budget is gone; raising it lets the cell continue」）。

---

## `BUG-002`（P0）：`codex exec resume` 会话历史累计 Token 被当成单轮增量重复记账（$O(K^2)$ 虚增） {#bug-002}

- **精确源码位置**：
  - [packages/loop/src/cli/adapters/codex.ts](../../packages/loop/src/cli/adapters/codex.ts#L135-L140)
  - [packages/gate/src/gate.ts](../../packages/gate/src/gate.ts#L746-L776)
- **实测触发证据**：
  - 对比 `ng.db` 的 `usage_log` 与 `~/.codex/sessions/*.jsonl` 真实请求记录：全晚真实消耗 `40,390,220` tokens，而 `ng.db` 记账高达 `51,675,224` tokens（凭空虚增 **`+11.29M` 幽灵 Token**）。其中被 `resume` 唤醒 8 轮的项目一协调器真实仅消耗 `1.75M`，账本却记了 **`7.24M`（虚增 4.13 倍）**，直接加速引爆预算熔断。
- **根因机理**：
  - Codex CLI 在 `codex exec resume` 回合结束事件 `turn.completed.usage` 中返回的是**整条会话自创建以来的历史累计总 Token**，而非本轮增量；`CodexDriver` 未做差值计算便原样传给 `Gate.meter()` 累加（同步核查 `ClaudeDriver` 与 `AgyDriver` 在 `resume` 模式下的语义是否一致）。
- **目标修复方向（对齐 `INV-UC07-03`）**：
  - 在持久化会话记录 `CliSessionRecord` 中维护 `lastReportedUsage`（分列记录未缓存输入、缓存读取输入、输出），`resume` 结算时严格传递单轮非负差值 `Math.max(0, cumulative - lastReported)`（若会话重建重置则归零重计）。
- **修复结论（`fixed（2026-11-19）`）**：
  - 会话累计口径的 CLI 用量（Codex `turn.completed.usage`）改为对照 `CliSessionRecord.reported` 按单轮差值计量；累计值低于已计量值视为计数器重启，整笔按新增计；失败 `resume` 后重建的会话与 `fork_prefix` 分叉各有自己的基线。Claude Code 与 Antigravity 的用量本就是单轮口径，照报计量、不保存会话累计。
  - 源码：[packages/loop/src/cli/loop.ts](../../packages/loop/src/cli/loop.ts)、[packages/loop/src/cli/adapters/codex.ts](../../packages/loop/src/cli/adapters/codex.ts)、[packages/loop/src/cli/types.ts](../../packages/loop/src/cli/types.ts)。
  - 回归测试：[packages/loop/test/cli.test.ts](../../packages/loop/test/cli.test.ts)（「CLI usage metering (BUG-002)」组：逐轮差值 1000 / 500 / 2000、计数器重启、重建会话、分叉子会话基线，以及 claude / agy 按单轮计量）、[packages/loop/test/adapters.test.ts](../../packages/loop/test/adapters.test.ts)（「codex driver: items and usage」组：「reports turn.completed usage as the session's running total, with the cached input among the tokens」）。

---

## `BUG-003`（P0）：预算门禁四连环缺陷（缺收尾缓冲、缓存 1:1 原价扣减、58ms 双弹窗、派生焊死瞬时余额） {#bug-003}

- **精确源码位置**：
  - [packages/gate/src/gate.ts](../../packages/gate/src/gate.ts#L359-L364)、[gate.ts](../../packages/gate/src/gate.ts#L577-L583)
  - [packages/cell/src/approvals.ts](../../packages/cell/src/approvals.ts#L303-L311)
- **四个子缺陷拆解**：
  1. **单轮退出才结账 + 协调器缺收尾免死缓冲**：CLI 单轮跑 50～80 步仅在进程退出时结账，运行途中超支拦不住；反而在子 `worker` 刚交完卷后 28ms 把只差调一次 `finish_project("someday")` 就能停靠的项目三协调器拦死近 5 分钟。
  2. **高命中前缀缓存按 1:1 全额扣上限且美分记 `0`**：实测前缀缓存命中率高达 **96.49%**，但账本把廉价的 `cached_input_tokens` 与昂贵输出按 1:1 等权扣减 `20M` 上限，且 Codex 未报美元时 `billedCents` 硬编码为 `0`。
  3. **多级同时超限时背靠背连弹两张预算卡**：当子项目与父 `desk` 同时超限时，`effectiveLedger` 与 `approvals.ts` 每次只给最内层超限节点加额——导致 `00:03:37.579` 主人刚点完第一张「继续」卡，仅隔 **58ms** 立刻撞上 `desk` 上限再弹第二张卡（而并排点两张兄弟项目的预算卡又会把公共祖先 `desk` 重复加额两次）。
  4. **`gate.attenuate` 派生瞬间静态焊死父节点瞬时余额**：创建子 `Cell` 时把父节点当时的剩余额度静态写死进子 `bounds.maxTokens`，后续即使给父节点续了费或兄弟未用满，也容易造成反直觉的局部锁死。
- **目标修复方向（对齐 `INV-SYS-04`）**：
  - 点击 `continue` 批准预算卡时，沿 `chainOf(affected)` 祖先链一次性将所有当前处于 `hard_stop` 的节点幂等抬升额度（对未处于 `hard_stop` 的祖先不重复叠加）；
  - 移除 `attenuate` 将父瞬时剩余额度焊死为子静态上限的做法（未显式限额时直接由监督树动态共享账本约束）；
  - 按缓存真实成本权重（如缓存读取 `0.1x`）折算有效预算消耗或估算美分；为名下子任务已全清、仅剩最后一步收尾的 `project` 协调器提供小额收尾缓冲。
- **修复结论（`fixed（2026-11-19）`，四个子项全部完成）**：
  1. **收尾缓冲**：非根、非叶的协调器在其名下没有任何在途工作时，可在限额之上使用收尾额度——限额的 5%，封顶 200k tokens / 200 美分（`LedgerViewOptions.wrapUp`、`DEFAULT_WRAP_UP`）；叶节点不享有，`ledger.alert` 与 `stopped_at` 仍按真实限额。
  2. **缓存读取按权重计费**：`Usage.cachedTokens` 记录缓存读取量，按 `cacheReadWeight`（默认 `0.1`）折算扣额；`usage_log` 同时保留原始与缓存数字（gate schema v3 新增 `raw_tokens` / `cached_tokens` 列）。美分仍按 CLI 原报记录（Codex 不报美分），**未加入价格估算**。
  3. **一卡解开整条祖先链**：预算卡点「继续」时由 `raiseChainSync` 把链上**此刻处于停止状态**的每个账本各抬升一次，不再 58ms 后弹第二张卡，兄弟项目先后续费也不会重复抬升共同祖先。
  4. **不再焊死父节点瞬时余额**：子节点派生时只取父节点的静态上限，花费由整条链的实时账本约束，祖先续费后立即惠及子节点，无需重新派生。
  - 源码：[packages/gate/src/gate.ts](../../packages/gate/src/gate.ts)、[packages/gate/src/attenuate.ts](../../packages/gate/src/attenuate.ts)、[packages/cell/src/approvals.ts](../../packages/cell/src/approvals.ts)、[packages/protocol/src/schema/gate.ts](../../packages/protocol/src/schema/gate.ts)。
  - 回归测试：[packages/gate/test/ledger.test.ts](../../packages/gate/test/ledger.test.ts)（「prompt-cache reads are charged at a weight」「wrap-up allowance (LedgerViewOptions.wrapUp)」「raiseChainSync (one "continue" for the whole chain)」组）、[packages/gate/test/attenuate.test.ts](../../packages/gate/test/attenuate.test.ts)（「Gate.attenuate — persisted state」组，如「a child gets the parent's static cap, not what the chain has left at spawn time」）、[packages/gate/test/migration.test.ts](../../packages/gate/test/migration.test.ts)（「v2 → v3 adds raw_tokens / cached_tokens to usage_log; …」）、[packages/cell/test/wakeable.test.ts](../../packages/cell/test/wakeable.test.ts)（「a coordinator with nothing in flight beneath it may still wrap up within the allowance; a leaf may not」与一卡一键解开整条链的用例）。
  - **相关新增（非缺陷修复）**：主人专属的预算限额总开关——`Kernel.setBudgetLimits`、环境变量 `NG_BUDGET_LIMITS`、`PUT /api/settings/budget-limits`，实现见 [packages/cell/src/budget-switch.ts](../../packages/cell/src/budget-switch.ts)；关闭时照常计量但不挂起、不出卡、不拒绝，选择跨重启保留。测试：[packages/cell/test/budget-switch.test.ts](../../packages/cell/test/budget-switch.test.ts)（「budget limits switched off」组）。

---

## `BUG-009`（P2）：宿主机休眠无感知与唤醒瞬间租约误判超时重投风险 {#bug-009}

- **精确源码位置**：
  - [packages/inbox/src/inbox.ts](../../packages/inbox/src/inbox.ts#L841-L935)
  - [packages/cell/src/kernel.ts](../../packages/cell/src/kernel.ts#L372)
- **实测触发证据**：
  - `22:16:38` ～ `22:48:08` 宿主机 MacBook 合盖休眠 `31m 30s`：一方面有活跃任务时未持 `caffeinate -i` 防空闲休眠；另一方面 `Inbox` 认领 `leaseMs = 10m`，唤醒瞬间若 `inbox.backgroundTick` 先于 `heartbeat` 执行 `expireClaims(Date.now())`，会把休眠前仍正常存活的 CLI 子进程误判为租约过期并重复投递任务！
- **目标修复方向（对齐 `INV-UC07-05`）**：
  - 后台存在活跃 `Run / Job` 时在 macOS 上自动按需持有 `caffeinate -i`（全空闲时自动释放）；
  - 内核维护单调时钟基准（`performance.now()`）对比挂钟（`Date.now()`）：一旦检测到挂钟跳变显著大于单调时钟推进（即经历了宿主机系统休眠 $\Delta_{\text{sleep}}$），**必须先原子顺延所有活跃 `claimed` 租约的到期时间，再执行过期回收**，并可选在时间线记录休眠时长注记。
- **修复结论（`fixed（2026-11-19）`；尚未在真实 Mac 上验证）**：
  - 防空闲休眠：macOS 上只要有 `Run` 或 `Job` 在途，就持有一个 `caffeinate -i -w <pid>`（不按 `Run` 逐个起），空闲超过宽限期后释放；其他平台不做任何事。
  - 合盖唤醒续租：`Inbox` 对比挂钟与单调时钟识别宿主机休眠，在任何过期回收之前先把所有活跃租约按休眠时长顺延；两个时钟同步前进的真实流逝仍照常过期，几秒级偏差视为抖动。
  - 源码：[packages/cell/src/awake.ts](../../packages/cell/src/awake.ts)、[packages/inbox/src/inbox.ts](../../packages/inbox/src/inbox.ts)。
  - 回归测试：[packages/cell/test/awake.test.ts](../../packages/cell/test/awake.test.ts)（「keep awake (macOS caffeinate)」组）、[packages/inbox/test/sleep.test.ts](../../packages/inbox/test/sleep.test.ts)（「host suspend vs. lease expiry」组，如「a 31-minute suspend pushes active leases forward instead of expiring them (the batch is delivered once)」）。
  - **验证说明**：在 Linux 上开发与测试（`caffeinate` 以假进程替身测试），**尚未在真实 Mac 上验证**。

---

## `BUG-013`（P2）：macOS 下 `markedAlive` 因无 `/proc` 退化为盲信复用 PID，且 `docs05-slots` 信号屏蔽测试存在时序竞态 {#bug-013}

- **精确源码位置**：
  - [packages/workspace/src/util.ts](../../packages/workspace/src/util.ts#L83-L103)
  - [packages/workspace/test/jobs.test.ts](../../packages/workspace/test/jobs.test.ts#L188-L202)
  - `packages/cell/test/docs05-slots.test.ts`（L155-L185；该文件已随写锁队列删除）
- **实测触发证据（本机 macOS 跑 `pnpm test` 检出，94 个测试套件中 92 通过、仅此 2 处失败）**：
  1. **`markedAlive` 在 macOS 上完全失去防 PID 复用保护**：`util.ts` 仅检测 Linux 的 `/proc/${pid}/environ`；在 macOS 上 `HAVE_PROC === false`，`markedAlive` 直接回退为裸 `pidAlive(pid)`（`kill(pid, 0)`），导致重启执行 `recover()` 时若原 `Job` 的 PID 已被其他无关进程复用，会被误判为原任务仍在运行并直接收编（`jobs.test.ts:199` 实测复现）。
  2. **`docs05-slots.test.ts` 的 `trap '' TERM; sleep 30` 启动竞态**：`startJob` 刚落库返回 `running` 时 `/bin/sh` 尚未执行完 `trap '' TERM`（或测试 `killGraceMs` 与 `setTimeout(100)` 窗口竞态），此时立即调 `closeCell` 发进程组 `SIGTERM` 会直接杀掉尚未挂好信号屏蔽的 shell，使 100ms 后的中间态断言看到 `running` 数为 `0`。
- **目标修复方向（与 [`05-proposals`](../05-proposals/README.md) 合流更新）**：
  - **必做**：在 macOS（`process.platform === "darwin"`）上通过 `ps eww -p <pid>`（或持久化进程启动时间比对）实现非 `/proc` 平台的环境变量标记校验，确保跨重启恢复绝不误收编或误杀复用 PID 的无关进程；
  - **已由提案消解（随第 2 批下线）**：[提案分册三](../05-proposals/03-ai-driven-workspace-and-project-notes.md)移除 `Dispatcher` 工作树写锁槽位队列后，`docs05-slots.test.ts` 将整体替换为 AI 目录占用暴露与冲突上报测试，无需单独修补旧写锁测试。
- **修复结论（子项 1 `fixed（2026-11-19）`；子项 2 `superseded`）**：
  - **子项 1**：没有 `/proc` 时改用 `ps -E -ww`（darwin）读取进程环境查找任务标记；无法识别身份的进程一律视为「不是我们的」——既不收编、也不发信号，`recover()` 将其记为失败。源码：[packages/workspace/src/util.ts](../../packages/workspace/src/util.ts)、[packages/workspace/src/jobs.ts](../../packages/workspace/src/jobs.ts)。回归测试：[packages/workspace/test/jobs.test.ts](../../packages/workspace/test/jobs.test.ts)（「recover() never trusts a recycled pid: a live process without the job marker is neither adopted nor signalled」及「process identity without /proc (macOS)」组）。其中调用真实 `ps -E` 的 macOS 用例（「macOS: `ps -E` shows a real process's environment」）在 Linux 上跳过，**尚未在真实 Mac 上验证**。
  - **子项 2**：`packages/cell/test/docs05-slots.test.ts` 已随写锁槽位队列一并删除，标为 `superseded`。
