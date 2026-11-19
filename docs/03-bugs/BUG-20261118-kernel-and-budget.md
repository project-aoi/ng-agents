# 内核调度、算力计量、预算护栏与宿主休眠缺陷单

> **状态**：`open`  
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

---

## `BUG-013`（P2）：macOS 下 `markedAlive` 因无 `/proc` 退化为盲信复用 PID，且 `docs05-slots` 信号屏蔽测试存在时序竞态 {#bug-013}

- **精确源码位置**：
  - [packages/workspace/src/util.ts](../../packages/workspace/src/util.ts#L83-L103)
  - [packages/workspace/test/jobs.test.ts](../../packages/workspace/test/jobs.test.ts#L188-L202)
  - [packages/cell/test/docs05-slots.test.ts](../../packages/cell/test/docs05-slots.test.ts#L155-L185)
- **实测触发证据（本机 macOS 跑 `pnpm test` 检出，94 个测试套件中 92 通过、仅此 2 处失败）**：
  1. **`markedAlive` 在 macOS 上完全失去防 PID 复用保护**：`util.ts` 仅检测 Linux 的 `/proc/${pid}/environ`；在 macOS 上 `HAVE_PROC === false`，`markedAlive` 直接回退为裸 `pidAlive(pid)`（`kill(pid, 0)`），导致重启执行 `recover()` 时若原 `Job` 的 PID 已被其他无关进程复用，会被误判为原任务仍在运行并直接收编（`jobs.test.ts:199` 实测复现）。
  2. **`docs05-slots.test.ts` 的 `trap '' TERM; sleep 30` 启动竞态**：`startJob` 刚落库返回 `running` 时 `/bin/sh` 尚未执行完 `trap '' TERM`（或测试 `killGraceMs` 与 `setTimeout(100)` 窗口竞态），此时立即调 `closeCell` 发进程组 `SIGTERM` 会直接杀掉尚未挂好信号屏蔽的 shell，使 100ms 后的中间态断言看到 `running` 数为 `0`。
- **目标修复方向**：
  - 在 macOS（`process.platform === "darwin"`）上通过 `ps eww -p <pid>`（或持久化进程启动时间比对）实现非 `/proc` 平台的环境变量标记校验，确保跨重启恢复绝不误收编或误杀复用 PID 的无关进程；
  - 在 `docs05-slots.test.ts` 中等待子进程写出“已装好 `trap`”就绪标记后再触发 `closeCell`，消除 shell 启动竞态。
