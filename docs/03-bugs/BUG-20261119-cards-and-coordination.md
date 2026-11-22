# 2026-11-19 实测缺陷单：卡片死状态、双人类入口割裂、假锚点与仲裁广播风暴

> 当前状态见各条的「验证范围」。源码位置、日志和目标修复方向均记录发现当时的情况。
> **发现来源**：2026-11-19 20:32 ～ 20:43（东八区）真实运行 [ng.db](../../apps/gtd-desk/data/ng.db) 全库日志核验（激活项目 `proj_01m7qf3dem000006dp6zm1`「重构收官后重算 12 模块上游回迁雷达」并行派发 4 个上游回迁包，遇 Surge 代理出站 `Connection refused` 触发 `desk` 跨包仲裁与阻塞弹卡，共产生 35 轮 Run、消耗 1,983,338 计费 Token / 12,935,618 原始 Token，缓存命中率 94.1%）  
> **关联原则与用例**：[01-product-principles.md](../01-principles/01-product-principles.md)（`P-UX-1`、`P-UX-5`、`P-UX-6`）、[02-kernel-principles.md](../01-principles/02-kernel-principles.md)（`P-KERN-2`）、[03-safety-and-boundaries.md](../01-principles/03-safety-and-boundaries.md)（`P-SAFE-4`、`P-SAFE-6`）、[uc03](../02-workflows/uc03-human-collaboration-and-engage.md)、[uc05](../02-workflows/uc05-workspace-concurrency-and-arbitration.md)

---

## `BUG-014`（P0）：`blocked` / `retry_limit` 与 `action` 卡片按钮写死且缺失备注输入框，Agent 无法定制真实选项 {#bug-014}

**验证范围**　已修复。自定义选项的备注和回调覆盖在 `packages/cell/test/human-items.test.ts`，收件箱通过浏览器实际提交备注的路径见 `apps/gtd-desk/test/human-inbox-browser.test.ts`。

- **精确源码位置**：
  - [packages/protocol/src/gtd.ts](../../packages/protocol/src/gtd.ts#L341-L372)（`cardButtons`）
  - [apps/gtd-desk/src/server/projections/clarify.ts](../../apps/gtd-desk/src/server/projections/clarify.ts#L190-L260)（`buttonsFor`）
  - [packages/loop/src/tools/comms.ts](../../packages/loop/src/tools/comms.ts#L280-L387)（`request_approval`）
- **实测触发证据**：
  - 2026-11-19 20:42:46，`desk` 在排查两台开发机共用 Surge 代理出站失败后，调用 `request_approval(kind: "escalation", reason: "blocked")` 弹出卡片 `act_01m7sx9e3d0000y58xv755`（「请选择如何恢复两台开发机的接入」），正文明确写着：*「请在备注里告诉我如何继续。你可以恢复现有代理后通知我复测，提供一个已授权的接入入口，或让四个回迁包继续暂停。」*
  - 但 [gtd.ts](../../packages/protocol/src/gtd.ts#L357-L371) 的 `cardButtons()` 对 `cardType === "escalation"` **仅判断了 `reason === "waiting_timeout"`**，其余全部原因（`budget_exhausted`、`retry_limit`、**`blocked`**）一律硬编码主按钮文案为 **`「追加额度继续」`**（`id: "extend"`）！
  - 虽然 [desk.ts](../../apps/gtd-desk/src/server/desk.ts#L542-L565) 的 `extend()` 与 [approvals.ts](../../packages/cell/src/approvals.ts#L323) 的 `deliverResolved()` 在后端已支持 `note`，但 [clarify.ts](../../apps/gtd-desk/src/server/projections/clarify.ts#L232-L244) 为 `extend` 生成 `ButtonDTO` 时**没有配置 `input`**，前端页面完全没有备注输入框，点击只能发空 `{}`。
  - 同理，`request_approval(kind: "action")` 在 [comms.ts](../../packages/loop/src/tools/comms.ts#L371-L381) 中未构造 `ClarifyCard`，只能落到 `确认执行 / 不同意` 兜底按钮，既不能定制选项也不能写修改范围说明。
- **目标修复方向**：
  - 合流至[提案 05](../05-proposals/05-unified-human-inbox-and-custom-cards.md)：废除写死的 `cardButtons()` 映射，开放 Agent 通过 `options: CardOption[]` 定制按钮文案、说明与输入模式；支持 `input.mode === "optional"` 点击先展开单行输入框（空着直接回车即提交）。

---

## `BUG-015`（P0）：卡片处理按钮存在三处「掉进无跟进死状态 / 误杀任务」的机制漏洞 {#bug-015}

**验证范围**　已修复。`packages/cell/test/human-items.test.ts` 覆盖选项回调、定向拒绝和撤销。死信、超步继续的真实重试路径见 `packages/cell/test/dispatch.test.ts` 和 `packages/cell/test/docs05-settle.test.ts`。

- **精确源码位置**：
  - [packages/cell/src/approvals.ts](../../packages/cell/src/approvals.ts#L328-L344)（`resolve_offline`、`dismiss`）
  - [apps/gtd-desk/src/server/desk.ts](../../apps/gtd-desk/src/server/desk.ts#L576-L625)（`toHuman`）、[apps/gtd-desk/src/server/desk.ts](../../apps/gtd-desk/src/server/desk.ts#L696-L709)（`completeAction`）
  - [apps/gtd-desk/src/server/projections/common.ts](../../apps/gtd-desk/src/server/projections/common.ts#L211-L216)（`approvalProjectId`）
- **三个子漏洞拆解**：
  1. **`dismiss`（「不需要处理（归档）」）静默吞掉唤醒**：`approvals.ts:342` 投递 `approval.resolved` 时硬编码 `silent: true`（`delivery: "silent_inject"`）。对于正在为多个 `waiters` 仲裁的 `desk` 或阻塞等待答案的 `project / worker`，撤卡后发卡 Cell 根本不会被唤醒，下游等待中的分身永久挂死。
  2. **`to_human`（「转给我来处理」）对 `desk` 仲裁卡直接断链**：`act_01m7sx9e3d0000y58xv755` 的 `cell_id = "desk"`、`subject_key = "desk:arbitration:traex-dev-ssh-pre-kex"`。点「转给我来处理」会先以 `silent: true` 撤卡（不唤醒 `desk`），再因 `approvalProjectId()` 返回 `null` 在 Engage 建一条无项目归属的个人待办；事后用户在 Engage 勾「已办完」时，`liveProjectOf()` 同样返回 `null`（代码注释明写 *“The desk's own quick to-dos tell nobody.”*），既不唤醒 `desk` 也不唤醒项目，彻底掉进黑洞。
  3. **`resolve_offline`（「线下已解决，直接完结」）语义双重人格且易误杀**：`approvals.ts:332-334` 对非根节点（`parentId !== null`，即任意项目或分身）直接调 `lifecycle.closeCell(affectedId, "completed")` 强关整个项目/分身；而对根 `desk` 又不关 Cell、改发 `approval.resolved(cancelled, resolve_offline)`。用户在阻塞卡上看到「线下已解决」极易理解为「我在线下把问题修好了，继续吧」，挂在项目上一点直接把整个项目强行完结。
- **目标修复方向**：
  - 合流至[提案 05](../05-proposals/05-unified-human-inbox-and-custom-cards.md)：内核对所有卡片按钮施加「零死状态硬约束」——所有按钮必须绑定封闭的 4+1 内核效果原语（`reply / execute / defer / terminate` + 无回调 `complete`）；取消静默 `dismiss`（改由 `wakeup` + 0-Token `prepareRun` 吸收纯单次无下游卡片）；取消 `to_human` 跨页搬家；将「拒绝并唤醒善后」与「级联取消整个任务」明确拆开。

---

## `BUG-016`（P1）：`Clarify` 与 `Engage` 双人类入口割裂，导致同一阻塞两头重复建待办且「已办完」无备注入口 {#bug-016}

**验证范围**　已修复。`apps/gtd-desk/test/api.test.ts` 覆盖关联动作共用一项及移交；`apps/gtd-desk/test/human-inbox-browser.test.ts` 覆盖按所属项目和动作深链选中、改稿核对和冲突重提。

- **精确源码位置**：
  - [apps/gtd-desk/src/server/projections/clarify.ts](../../apps/gtd-desk/src/server/projections/clarify.ts) 与 [apps/gtd-desk/src/server/projections/engage.ts](../../apps/gtd-desk/src/server/projections/engage.ts#L72)
  - [apps/gtd-desk/src/server/projections/common.ts](../../apps/gtd-desk/src/server/projections/common.ts#L224-L232)（`cardBackedActions`）
  - [apps/gtd-desk/src/web/App.tsx](../../apps/gtd-desk/src/web/App.tsx#L155)（进 Engage Tab 自动开免打扰）
- **实测触发证据**：
  - 2026-11-19 `20:42:46`，`desk` 针对 Surge 代理阻塞在 `approvals` 表建出卡片 `act_01m7sx9e3d0000y58xv755`（显示在 `Clarify`）。
  - 19 秒后（`20:43:05`），`proj_01m7qf3dem000006dp6zm1` 收到 `desk` 广播后，又在自身 `cell_state` 调 `track_action(owner: "human")` 建出待办 `act_01m7sxa0qb0000gzcjxmkg`「恢复开发机接入」（显示在 `Engage`）并执行 `wait(waitingFor: "human")`。
  - `cardBackedActions()` 只按 `ActionRecord.cellId === card.cellId` 去重，无法识别 `desk` 的仲裁卡与项目的 `human` 动作其实是同一件事——同一问题在两个 Tab 各挂一条，只处理其中一条都无法同时解除两边等待。
  - 此外，后端 [desk.ts](../../apps/gtd-desk/src/server/desk.ts#L718) 的 `done()` 早已支持 `note`（完成说明），但 [engage.ts](../../apps/gtd-desk/src/server/projections/engage.ts#L72) 的「已办完」按钮没挂输入框，用户无法顺手写完成备注。
- **目标修复方向**：
  - 合流至[提案 05](../05-proposals/05-unified-human-inbox-and-custom-cards.md) 方案 A：彻底合并 `Clarify` 与 `Engage` 为唯一人类入口（顶栏从 4 Tab 精简为 3 Tab），底层人类事项统一收口、支持同 `subjectKey` 去重与 `relatedProjectIds` 关联，并统一所有完成/回复按钮的单行可选备注交互。

---

## `BUG-017`（P1）：5 锚点停滞检测存在 `wait(inbox:desk)` 常驻根假锚点盲区 {#bug-017}

**验证范围**　已修复。`packages/cell/test/docs05-anchors.test.ts` 覆盖等待目标、同树空等及三节点环。

- **精确源码位置**：
  - [packages/cell/src/readmodel.ts](../../packages/cell/src/readmodel.ts#L458-L469)（`anchorsOf` 的第 3 锚点 `internal`）
- **实测与代码证据**：
  - 2026-11-19 20:43 结束时，`proj_01m7qf3dem000006dp6zm1` 下有 3 个 worker（`cell_01m7swtf5k0000kym4stkb`、`cell_01m7swtf5v0001xxzk3983`、`cell_01m7swtf6a00000qznzn7f`）在 `cell_waits` 中等待 `waiting_for = "inbox:desk"`。
  - `readmodel.ts:460-469` 判定 `@Waiting(internal)` 锚点时，只判断 `t = cells.get(target)` 存在且 `t.status !== "closed"`。因为树根 `desk` 永远是 `active`（永不关闭），只要子树里有任意节点等待 `inbox:desk`，`internal` 锚点就**恒为 `true`**！
  - 后果：即便 `desk` 已经彻底空闲、没有任何待确认卡、也没有在跑的排查分身或待领消息（例如卡片被误撤或仲裁漏回），`anchorsOf(projectId)` 仍然报告 `stalled: false`，5 锚点防悬空护栏（`P-SAFE-6` / `INV-SYS-02`）对此类跨项目仲裁死锁完全失明。
- **目标修复方向**：
  - 在 `anchorsOf()` 评估 `waitingFor = inbox:<target>` 且 `target` 位于当前项目子树之外（特别是常驻根 `desk` 或兄弟协调器）时，仅当 `target` 自身此刻持有**真实推进锚点**（在跑 Run/Job、待领 wakeup 消息、未决待确认卡，或与该等待关联的排查子分身仍在工作）才认定为有效 `internal` 锚点；否则判定为失锚，允许 `StallMonitor` 正常告警并触发唯一一次停滞巡检。

---

## `BUG-018`（P1）：共因阻塞仲裁引发消息乒乓与中间态广播炸醒风暴，且等待路由分叉 {#bug-018}

**验证范围**　确定性回归覆盖，待真实模型复验。`presets/test/scenario-blockers.test.ts` 验证两个项目共用一个修复者，`packages/cell/test/docs05-anchors.test.ts` 验证按项目仲裁与同一原因再次出现时重开事件。

- **精确源码位置**：
  - [presets/src/shared/skills.ts](../../presets/src/shared/skills.ts#L131-L138)（`workspace-arbitration`）
  - [presets/src/shared/prompts.ts](../../presets/src/shared/prompts.ts#L74-L79)（`desk` §3）、[presets/src/shared/prompts.ts](../../presets/src/shared/prompts.ts#L158-L165)（`worker` §1）
- **实测触发证据**（来自 [ng.db](../../apps/gtd-desk/data/ng.db) 2026-11-19 `20:35–20:43` 轨迹）：
  1. **登记阶段乒乓**：`20:35:16–20:37:48` 间，3 个 worker 直报 `desk`、1 个 worker（`W-trace`）先报 `PROJ` 再报 `desk`；`desk` 与 `PROJ` 围绕「谁在等待名单、谁转达 `W-trace`」互发多轮确认消息，`desk` 连跑 4 轮、`PROJ` 连跑 5 轮。
  2. **静态准备逐条唤醒**：4 个 worker 分别完成本地静态核对后各自 `send_message` 给 `PROJ`，导致 `PROJ` 在 `20:38:10–20:41:11` 连续被唤醒 5 轮仅做 `set_state` + `wait`（`PROJ` 总计 11 轮消耗 51.8 万计费 Token / 379 万原始 Token）。
  3. **中间态群发炸醒风暴**：`20:42:39` `desk` 在确认排查失败、准备向主人弹卡前，顺手给 `PROJ` + 全部 4 个已经睡着的 worker 群发 5 条 `wakeup` 消息（「连接仍受阻，准备请机主恢复」），瞬间把 4 个休眠分身全部拉起，每人烧 1.8～3.5 万计费 Token 后又各自重新 `wait`；其中 `W-trace` 在 `20:42:58` 刚睡下 7 秒，又被 `PROJ` 在 `20:43:05` 转发同一内容二次炸醒（白烧 3.6 万计费 Token），且最终 `W-trace` 挂的是 `wait(inbox:proj_...)`、另 3 个挂的是 `wait(inbox:desk)`，等待路由发生分叉。
- **目标修复方向**：
  - 修订 `workspace-arbitration` 技能与 `desk / project` 提示词（并配合提案 05 的 `relatedProjectIds`）：
    1. 共因阻塞未解决前（排查失败转请主人拍板属于中间态），`desk` **绝不向处于 `wait` 的休眠 `waiters` 群发 `wakeup` 通知**；只需在仲裁卡上声明 `relatedProjectIds`，等主人拍板且复测通过（或明确取消/改道）后，再一次性唤醒所有 `waiters`；
    2. 明确同类上报的收敛口径：一旦 `desk` 已给项目回复「统一纳入通知名单」，项目无需再向已由 `desk` 接管的 worker 重复转发同一条阻塞更新。

---

## `BUG-019`（P2）：实机执行侧三处小摩擦（非 Git 看板目录误跑 `git status`、排查脚本碎步、子命令 `PATH` 丢失） {#bug-019}

**验证范围**　提示词已修订，待实机任务复验。`presets/src/shared/prompts.ts` 要求先识别 Git 工作树、合并相关只读检查，在子进程缺命令时核查 PATH 和程序路径。

- **精确源码与日志位置**：
  - [presets/src/shared/prompts.ts](../../presets/src/shared/prompts.ts#L160)（`worker` §1 动刀前 `git status` 检查）
  - [ng.db](../../apps/gtd-desk/data/ng.db) 证据 `#1582`、`#1588`、`#1840`、`#1904–#2154`
- **实测现象**：
  1. `W-path`（`#1582`）与 `W-trace`（`#1588`）虽已知本机 `/Users/ar8327/dev/trae-x` 是非 Git 看板目录、真正代码在远端开发机，仍受通用 `worker` 提示词惯性影响在本机跑 `git status` 报错 `exit 128`。
  2. `W-schema` 在 `#1840` 执行一段 `shell` 脚本时出现 `zsh:1: command not found: git / wc`（脚本内部变量名覆盖了 `PATH`）。
  3. `W-fixer`（`cell_01m7swwm6z0000ja9x3phg`）排查 Surge 出站策略连跑 2 轮、写了 14 个内联 Python 脚本反复 `surge-cli dump` 耗时 6 分钟（23 万计费 Token），且第 1 轮 `report_to_parent(failed)` 因 `desk` 补发了一条线索被排空机制顺延到第 2 轮结束才一并上送。
- **处理建议**：
  - 提示词里明确「仅当目标改动目录确实为本地 Git 仓库时才在本地运行 `git status`；远端仓库的现场检查在远端工作树中执行」；其余两项记为观察项，不做过度硬编码。
