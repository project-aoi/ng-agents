# 演进提案 05（2026-11-21 终审定稿 · 方案 A）：唯一人类处理入口、可定制零死状态卡片、正交底层与防误操作体系

> [!IMPORTANT]
> **状态**：已分三步实施，现行行为见第一、二层规范。
> **实施顺序**：**`Phase 0（共同 P0 止血）` → `提案 05（本提案：人机协作与卡片闭环）` → `提案 06（底层架构深度拔根）`**，配套底层契约见 [06-architecture-ssot-cli-sync-and-boundaries.md](./06-architecture-ssot-cli-sync-and-boundaries.md)。  
> **触发来源**：
> - 2026-11-19 实测暴露的卡片交互与跨项目仲裁缺陷：[BUG-20261119-cards-and-coordination.md](../03-bugs/BUG-20261119-cards-and-coordination.md)（`BUG-014` ～ `BUG-019`）；
> - 2026-11-21 全仓三路深度审计：[BUG-20261121-orthogonality-and-control.md](../03-bugs/BUG-20261121-orthogonality-and-control.md)、[BUG-20261121-lifecycle-and-resilience.md](../03-bugs/BUG-20261121-lifecycle-and-resilience.md)、[BUG-20261121-context-and-visibility.md](../03-bugs/BUG-20261121-context-and-visibility.md)（`BUG-020` ～ `BUG-035`）。  
> **核心理念**：严格贯彻 [02-kernel-principles.md](../01-principles/02-kernel-principles.md)「**薄内核守确定性硬底线，厚编排靠柔性策略**」——把**选项文案与业务分支**最大限度交还给 Agent 定制，把**「每个按钮必有确定性后继、绝不掉进死状态」「唯一人类入口与三责分离」「误操作诚实可补救」**焊死在协议与内核层。

---

## 一、为什么必须做这次改造（现状的四大病根）

1. **卡片选项被协议层写死，Agent 无法表达真实业务决策**：
   - 现行 [gtd.ts](../../packages/protocol/src/gtd.ts#L341-L372) 的 `cardButtons()` 把按钮硬编码在 3 种固定卡片模板里，连 `escalation.blocked` 都硬塞了「追加额度继续」且无备注框（`BUG-014`）。无论是 `uc05` 脏改动三选一、断网代理恢复方案选择，还是阶段门控调范围，Agent 都无法给出可点的真实选项。
2. **多处按钮与状态转移通向「无跟进死状态」或不可逆误杀**：
   - `dismiss` / `resolveUnknownSend` 发 `silent: true` 晾死发卡方；`to_human` 跨仲裁卡建出无人监听孤儿；`resolve_offline` 误杀整条项目细胞（`BUG-015`、`BUG-028`）；误点取消/完结项目、`deny`、`done` 彻底不可撤销（`BUG-031`）；再叠加 `subjectKey` 碰撞吞内核故障升级（`BUG-025`）与 `wait(inbox:desk)` 假锚点盲区（`BUG-017`、`BUG-030`），系统可能永久静默挂死。
3. **两个平级人类入口（`Clarify` vs `Engage`）及全仓影子双轨破坏 SSOT**：
   - `approvals` 与 `gtd:action(owner: "human")` 互不认识，拆成两个一级 Tab 导致同一阻塞两头重复建单（`BUG-016`）；同构问题还蔓延到 `desk:reminder`（已取消提醒复活）、`desk:reply`/`proposal` 影子表、MCP 绕过守卫直调底层写方法（`BUG-020`～`BUG-024`）。
4. **CLI `--resume` 失忆、人类手改被覆盖与可观测性盲区**：
   - 0-Token `prepareRun` 消化与 `system_note` 不进 CLI 视野、`draft_reply` 修订直接覆盖人类手改 v2、`inspect_cell` 把 `bash` 报错剪成 `[exit code 1]`、`tailNotes` 缺 `[cells waiting on you]` / `[your open cards]` / `[budget warning]`（`BUG-032`～`BUG-035`）。

---

## 二、已拍板的核心设计决策（方案 A · 彻底合一与正交分层）

### 2.1 唯一人类处理入口：4 视图精简为 3 视图

顶栏一级导航从 4 个 Tab 收敛为 **3 个核心视图 + 1 个随手记/信源抽屉**（快捷键 `1`～`3` 切换视图，`4` 或 `5` 打开信源抽屉）：

| 视图 | 定位 | 形态与交互 |
| :--- | :--- | :--- |
| **1. `待我处理`（统一入口，取代原 `Clarify` + `Engage`）** | **所有球在主人脚下的事**都在这一个池子里——外发审批、立项确认、阻塞多选一、预算续费、阶段门控、项目要材料/验收、个人定时提醒 | **左列表 + 右详情操作卡**：<br>- 列表按紧急/阻塞度自然分层（「后台正等着 / 需拍板」置顶，「待你动手 / 定时提醒」在下方），支持轻量筛选与键盘 `N` 顺手连刷；<br>- 涉及长草稿/长方案/报告的条目，右侧卡片提供**「展开专注编辑」**按钮，点开进入原有的 **8/4 双栏大工作区**（保留 `Artifact` 乐观锁防覆盖与右侧参考资料包），处理完退回列表；<br>- **彻底取消「转给我来处理（`to_human`）」**：所有事本来就在同一个池子里，暂时不办直接留着或点「推迟」；<br>- **免打扰（DND）正交重定义**：拆分为独立布尔 `manualDnd`（顶栏手动开关）与带心跳 TTL 的编辑会话租约 `activeEditorLeases`（进 8/4 专注编辑加租约、退出/崩溃超时自动释放），`effectiveDnd = manualDnd || activeEditorLeases > 0`，杜绝多标签页互相覆盖与崩溃永久锁死（`BUG-031`）；<br>- **暂停/停靠项目条目隔离**：归属 `paused`/`someday` 项目的条目在列表中标明「所属项目已暂停」，仅允许提示并恢复该条目直接所属的目标项目（绝不按 `relatedProjectIds` 批量恢复无关暂停项目）。 |
| **2. `项目全局`（`Radar`）** | 有终点的活跃项目、`Someday` 停靠区（含报告抽屉）与 15 分钟周回顾 | 所有处于人类球权的项目行（包括受跨项目仲裁卡覆盖的项目）统一经 `relatedProjectIds` 指向「待我处理」里的**同一条** `HumanItem`；新增「最近结束」原地重开入口。 |
| **3. `分身实况`（`Agents`）** | 三层拓扑画布 + 工作实况流 + 直连发话（默认选中 `desk` 主对话） | 保持现有架构不变；节点挂着人类待办项时一键跳转到「待我处理」对应条目。 |

---

### 2.2 正交底层模型：`HumanItem` × `Gate` × `Outbox` 三责分离

> [!IMPORTANT]
> **三责分离铁律**：`HumanItem` 回答「这件事现在需要人做什么」并**独占待办生命周期**；`Gate` 回答「谁批准了哪个受控动作与信任统计」；`Outbox` 回答「这一笔外发尝试到了哪一步」。三份事实各自落库，彻底消除两张表同步维护两份 `pending / resolved` 的漂移问题。

1. **第一层：`HumanItem`（唯一人类收件箱表，独占待办生命周期）**
   - 承载**所有**面向人类的事项：决策卡、阻塞多选一、项目要材料/验收、内核故障升级、外发/立项审批壳、以及无回调个人提醒（`callback: "none"`）。
   - **核心字段**：
     - `id`（`act_...`）、`cellId: string | null`（发起方 Cell；个人提醒等 `callback: "none"` 项为 `null`，由内核定时器直接落表，**完全穿透 `desk` LLM 预算限制**）、`epoch: number | null`；
     - **`itemRevision: number`（卡片级乐观锁版本号，每次变动或决定递增）**：凡 `options`、收件人、追加额度、关闭目标、提案参数变动，以及**每一次被接受的决定**（包括仍保持 `pending` 的 `revise` 与外发 `TX 1`）都在同一事务内校验并递增 `itemRevision`；每次决策提交 `(itemId, seenItemRevision, optionId)`，涉及草稿同时校验 `seenArtifactVersion`；发送在途期间由活跃 Outbox 尝试挡住相反决定，配合进程内 `inflight` 互斥（**必须先验身份与双版本再查 `inflight`**）彻底防双标签页过期操作与重启竞态，无需额外引入重型持久化 `commandId` 账本表；同时将立项方案的 `cwd / repos / phases` 纳入受版本保护的 `ProjectProposal` 正文，消灭 `desk:proposal` 脱离版本锁的问题；
     - **`subjectKey`（纯同议题去重键，唯一索引覆盖所有未结清状态 `status IN ('pending', 'snoozed', 'unknown')`）**：严格分命名空间，绝不用单一 `project:<id>` 挤压多事项（根治 `BUG-025` 且防止推迟/待核实期间被重复建卡）：
       - 项目人工动作：`action:<projectId>:<actionKey>`；
       - 对外草稿回复：`reply:<channel>:<thread>`；
       - 跨项目仲裁：`arb:<causeKey>`（禁止回退到全局单一 `cell:desk`）；
       - 内核故障升级：`kernel:<cellId>:<reason>`（多 Worker 撞同一祖先账本时按 `kernel:budget:<ledgerCellId>` 聚合，永不被业务卡覆写或吞掉）；
       - 个人提醒：`reminder:<id>`。
     - **`relatedProjectIds: string[]`（纯关联索引，语义严格限定）**：仅用于 `Radar` 跳转、列表归属展示与 5 锚点精准关联；**严禁**据此自动批量恢复所有暂停项目、批量关闭所有关联项目或推定同项目内每个等待均已答复；
     - `artifactId` + `boundVersion`（可选：绑定可编辑草稿/方案/报告）、`gateActionId?: string`（仅当含 `effect: "execute"` 时关联 `Gate` 授权记录）；
     - `options: CardOption[]`、`status: "pending" | "snoozed" | "unknown" | "resolved" | "cancelled"`、`snoozedUntil`、`effort?: "15m" | "45m" | "low_energy"`、`dueAt`、`category: "decision" | "action"`。
2. **第二层：`Gate`（纯受控权限、Token 与渐进信任引擎）× 第三层：`Outbox`（外发尝试与回执）**
   - `Gate` 仅在受控动作（`channel.send`、`project.start`、`raise_budget` 等）介入：负责 `policy_rules` 渐进信任评估、`approval_stats` 信任连击、`ownerOnly` 鉴权与一次性 `actionToken` 签发，不再维护独立的待办展示生命周期；
   - **`ownerOnly` 与渐进信任（`P-UX-7`）的精确边界**：保留主人直接要求开工（`start_project`）与**主人本人显式开启的常设信任规则**（`P-UX-7`，保留 `BUG-034` 的 `propose_project` 规则放行修复）；`ownerOnly` 硬约束的是「凡弹出的对外发送、追加预算、立项确认卡片（`ownerOnlyApproval()` 需补覆盖已弹出的 `project.start`），外部 `agent:*` 绝不可代主人批准，且不可替主人开启/修改常设规则」；同时取消调用链漏传 `DeskActor` 时静默退回 `ownerPrincipal` 的默认降级（缺身份一律拒绝）。**常设信任自动放行的对外发信**同样按稳定发送标识记入 `Outbox`：成功即结束，遇 `unknown` 自动创建/找回唯一核实卡，遇 `failed` 明确可重试（不再谎报 `sent (unknown)` 让人找不到核实入口）。
   - `Outbox` 以稳定 `actionId` 关联每次发送尝试与序号（迟到旧尝试严禁覆盖新尝试结果，根治 `BUG-028`）；外发结果落入 `unknown` 时，`HumanItem` 置为 `unknown` 并按 `Outbox` 记录接管展示核实选项。
3. **收口项目 `plan` 与 MCP 入口**：
   - **区分未激活 `plan` 与活跃 `HumanItem`**：立项方案里的未来人工步骤留在 `gtd:project.plan`，不一次性弹进「待我处理」轰炸主人；仅当真正轮到主人时才实例化为活跃 `HumanItem`；
   - **MCP 彻底合一**：废弃 `complete_action`，所有查看与操作统一经由 `DeskService` 的 `list_human_items`（暴露 `itemRevision / options / artifactVersion / humanEdited / relatedProjectIds`）与 `decide_human_item(id, seenItemRevision, optionId, note?, seenVersion?)`（`BUG-020`）。

---

### 2.3 内核封闭效果原语：5+1 零死状态硬约束与状态收紧（Mechanism）

**最高铁律：卡片上的每一个按钮，都必须绑定以下封闭集合中的一个内核效果原语（`CardEffect`），绝不允许出现「点完卡消失但无后继状态」的按钮！**

| 效果原语 (`effect`) | 内核确定性行为与事务边界 | 为什么不可能掉进死状态？ | 适用场景、状态收紧与硬约束 |
| :--- | :--- | :--- | :--- |
| **`reply`** | 单事务校验 `seenItemRevision` → 标 `resolved` → 投递 `delivery: "wakeup"` 的 `approval.resolved`（携带 `{ optionId, label, note, payload, relatedProjectIds }` 及人类手改 diff），**并校验信封真实进入 `pending`** | 发卡 Cell 100% 苏醒拿到精确选择、备注与改稿差异；投递目标若已关/旧 epoch 则回滚或转交存活父协调者 | 阻塞多选一、脏改动处理、阶段门控、项目要材料/验收反馈、跨项目仲裁局部放弃 |
| **`revise`** | **卡片保持 `pending` 不关闭**，单事务投递 `delivery: "wakeup"` 的 `approval.revise`（携带 `instruction`、`artifactId`、`artifactVersion`、`humanEdited` 及紧凑行级 diff） | 迭代改稿期间条目始终留在「待我处理」可见；强制模型基于人类最新 v2 修改，绝不覆盖（`BUG-032`） | 语音/文字让 AI 调整草稿语气、重写立项方案部分内容 |
| **`execute`** | **非 I/O 动作**（`project.start` / `project.someday` / `raise_budget`）在单事务内原子完成并验真投递回执；<br>**外部发信（`channel.send`）严格走三步 Saga**（适配同步 `withTx` 不可跨 `await`）：<br>① `TX 1`：验身份 + `seenItemRevision` + `seenArtifactVersion` → 递增 `itemRevision`、写 `Gate` 批准记录与 `outbox(sending)` 意图；<br>② 事务外执行通道发送 I/O（**必须拆分通道接口直接发送已登记尝试，禁止复用现有 `hub.send()` 同键短路返 `unknown`**）；<br>③ `TX 2`：按当前尝试序号写 `outbox` 结果（迟到旧尝试禁覆盖新尝试）→ 更新 `HumanItem` 状态 → 验真投递 `delivery: "wakeup"` 回执（发卡节点若刚好关闭则转交存活父节点保住已知送达结果） | 按 `action.type` 物理锁死映射：`channel.send`（非主人地址）、`project.start`、`budget_exhausted` 必须绑定 `execute` 且锁死 `ownerOnly: true`（非受控 `custom` 动作禁声明 `execute`）；<br>**`unknown` 状态收紧**：仅允许「核实收到了 / 核实没收到 / 稍后核实」，禁止普通 `deny` 结清；**「稍后核实」保持 `status = 'unknown'` 不变、只更新 `snoozedUntil`**（绝不改为 `snoozed`，防回弹退回普通 `pending` 露出发送/拒绝按钮）；核实「没收到」后再进入可重试或放弃态，核实完成必发 `wakeup`（`BUG-028`） | 确认发送对外回复、确认立项开工/先放以后再说、预算耗尽追加额度 |
| **`defer`** | 单事务校验并递增 `itemRevision`，设置 `snoozedUntil`（普通 `pending` 卡置 `snoozed`；**`unknown` 卡保持 `status = 'unknown'` 仅更新 `snoozedUntil`**），先取消旧 `resurface:<id>` 定时器再埋入带唯一后缀的新回弹信封 | 条目未消失且不丢失 `unknown` 状态约束，到点 0-Token 自动回弹（穿透预算停摆与 `silent_inject` 合并干扰），且 5 锚点持续计入 | 推迟到下午 / 明天 / 自定义时间 / 稍后核实 |
| **`terminate`** | 显式区分三类终结，**彻底废除对有下游/活跃 Cell 的静默 `dismiss`**：<br>- `mode: "deny"`（拒绝方案/放弃处理）：标 `cancelled` 并**验真投递 `delivery: "wakeup"`**（仅严格白名单——纯知会卡、无 `relatedProjectIds` 且无 `cell_waits` 的单次回复/立项拒绝——允许 `desk` 0-Token 吸收并记 `restorable: true`）；<br>- **预算卡拒绝特例（含根账本防无限重弹）**：对 `budget_exhausted` 卡点拒绝追加时，**按耗尽的 `ledgerCellId` 持久化「预算拒绝停工标记」**（随 `05-A1` 落地，不再依赖暂停根 `desk`）——所有受该账本限制的节点在 `hold()` 提卡前先查此标记，绝不因已有到期消息或新回执重弹同卡；根 `desk` 仍可照常处理 0-Token 机械事件，主人可显式恢复；<br>- `mode: "cancel_task"`（高危叫停）：**强制携带显式非根单项目 `targetCellIds`**，弹窗列出服务端渲染的精确待关任务清单，确认后 `closeCell("cancelled")` | 要么必然唤醒发卡 Cell 善后（预算卡含根账本均确定性停工不死循环），要么精准关闭明示目标；且内核 `closeCellSync` 硬禁关闭 `parentId === null` 根 `desk`（`BUG-020`、`BUG-031`） | 不发这封回复、拒绝提议、停工拒绝续费、取消个人提醒、显式叫停单个受阻任务 |
| **`complete`** | 仅允许 `callback: "none"` 的无回调个人条目使用：单事务标 `resolved` 并写 `restorable: true` 活动快照（含用户可选备注），0 Token 销账 | 无后台 Cell 等待，同步事务即终态闭环，且 100% 支持撤销恢复 | `remind_me` 到期提醒等纯个人待办（默认退路仅推迟或取消提醒） |

*(注：随着双入口彻底合一，`to_human` 跨页搬家原语正式退役。)*

---

### 2.4 Agent 定制选项契约与前端交互规范（Policy + UX）

#### 1. `CardOption` 协议定义

```ts
export type CardEffect = "reply" | "revise" | "execute" | "defer" | "terminate" | "complete";

export interface CardOptionInput {
  /**
   * "none": 点击直接提交
   * "optional": 点击后先在按钮行下方就地展开一行自动聚焦的小输入框，空着直接按 Enter 也能立即提交（主人拍板）
   * "required": 点击后展开输入框，必须填写内容才可提交
   */
  mode: "none" | "optional" | "required";
  placeholder?: string;
}

export interface CardOption {
  id: string;                              // 卡片内唯一标识，如 "proxy_fixed" / "alt_entry"
  label: string;                           // Agent 定制的直白中文文案（符合 P-UX-1）
  hint?: string;                           // 悬停/焦点提示：说明点下去后台会做什么
  primary?: boolean;                       // 推荐主选项（至多 1 个）
  group?: "main" | "more";                 // 默认 "main"；系统兜底退路可放 "more"
  effect: CardEffect;
  terminateMode?: "deny" | "cancel_task";  // effect === "terminate" 时指定，默认 "deny"
  targetCellIds?: string[];                // terminateMode === "cancel_task" 时必填：显式非根单项目目标
  input?: CardOptionInput;                 // 默认：{ mode: "optional" }（reply/complete）或按需声明
  confirm?: string;                        // 高破坏性操作二次确认文案
  payload?: Record<string, unknown>;       // 结构化参数，随 approval.resolved 原样回传
}
```

#### 2. 内核 5 条硬校验约束（在创建 `HumanItem` / 投影层强制执行）

1. **结构与极简约束**：`main` 组自定义按钮限定 **1 ～ 4 个**；`id` 唯一、`label` 非空、最多 1 个 `primary`；`complete` 仅允许 `callback: "none"` 条目，有回调 Cell 传 `complete` 直接报错拒收。
2. **按状态收紧默认退路**：
   - 有回调卡片若缺退路，投影层自动在「更多」补齐 `推迟稍后再看`（`defer`）与 `暂不处理 / 拒绝并告知后台`（`terminate(deny)`）；
   - 无回调个人提醒默认退路为 `推迟`（`defer`）与 `取消提醒`（`terminate`），不配唤醒后台；
   - 发送进入 `unknown` 时，内核接管选项并严格限定为 `已核实：对方收到了` / `已核实：对方没收到` / `稍后核实`（禁止普通 `deny`）。
3. **高风险执行事实由服务端渲染 + 版本硬锁**：
   - `channel.send`（非主人地址）、`project.start`、`budget_exhausted` 强制绑定 `execute` 与 `ownerOnly: true`；服务端直接渲染真实收件人、追加金额、待关目标清单，Agent 只提供背景解释，防文案与执行参数不符；
   - 所有决定校验 `seenItemRevision`（含草稿同时校验 `seenArtifactVersion`），按该 revision 保存的选项执行。
4. **前端单行可选输入框交互（含冲突防丢稿）**：
   - `input.mode === "optional"`（含决策回复与原 Engage 迁入的「已办完」按钮）：首次点击在按钮行下展开单行自动聚焦输入框，空着直接按 Enter 立即可提交，写字则作 `note` 随同 `optionId`/`payload` 一并送出；
   - **冲突保备注**：提交遇 `itemRevision` 或 `artifact` 版本冲突时，前端保留已输入备注草稿不清空，刷新新版后可一键重提。
5. **同构控制面**：MCP `list_human_items` / `decide_human_item` 与 Web UI 走完全同一套 `DeskService` 命令、`DeskActor` 显式鉴权与双版本校验。

---

### 2.5 卡片处理后的唤醒链路与三重防漏机制

主人（或外部主 Agent）在「待我处理」点击任意选项后，系统按**「内核保第 1 跳必达与验真，协调层做第 2 跳智能分流」**唤醒后台分身：

1. **5 步通用底层唤醒链**：
   - **同事务落账、投递并验真（含重启 `reconcile` 去重回查）**：内核原子更新 `HumanItem` 后调用 `deliverResolved()` 向发卡方 Cell（内核代发升级卡定向受影响 Cell）入队 `type: "approval.resolved"`、`delivery: "wakeup"`（失败/重试类信封 ID 带尝试序号，`humanEdited: true` 时附紧凑改稿 diff）。**强制校验 Inbox 入队结果**：首次投递必须真实落为 `pending`（绝不吞异常或放过 `dropped_epoch` / `cancelled`）；**重启 `reconcile()` 补投遇到 `deduped` 时，按确定性信封 ID 回查旧行状态**——旧行已为 `pending / claimed / done` 则有据可认，若为 `dropped_epoch / cancelled / dead` 则转交存活父协调者或显式报错（目标预算挂起时仅承诺回执已排队）；
   - **调度器即时拉起**：`inbox.enqueued` 触发 `dispatcher.notify(cellId)` → `pump()` 校验预算并认领回放（个人提醒等纯机械 0-Token 事件独立执行，穿透预算停摆；混批中的模型消息继续留队）；
   - **消费完成精确清理等待**：`cell_waits` 主键扩展支持 `wait_id` / `ref_id`（允许同一 Cell 对同一目标挂多个独立等待互不覆盖）；`waits.answeredBy()` 移至 `settleRun` 同事务按 `ref_id` 精确销账；
   - **0-Token 记账拦截 + 最小 CLI 游标补漏**：严格白名单内的纯机械善后由 `prepareRun` 0-Token 吸收（不动 CLI 游标）；**`05` 后端同步落地最小版 `lastDeliveredEvidenceSeq`（严格按实际喂进 CLI 的输入推进，详见提案 06 契约 2）**，确保休眠期间被 0-Token 吸收或结算后新写的 `system_note` 在下次 CLI `--resume` 时自动补喂，不失忆（`BUG-033`）；
   - **上下文续跑**：`context.hydrate()` 拼装完整会话、状态、本批回执与尾部硬事实交给模型执行后续动作。
2. **三类场景的唤醒拓扑**：
   - **单层直达（1 跳）**：`Project` / `Worker` 自己发的卡 → 内核直接唤醒发卡方继续推进、唤醒休眠 Worker 或结项；
   - **内核托管硬操作（0 跳/直通放行）**：确认立项直接建 `Project` 并启动；预算续费发 `ledger.raised` 一次性放行所有 `held` 及最近 `budget_stopped` 活跃 Cell（`BUG-030`）；`terminate(cancel_task)` 精准关闭 `targetCellIds`；
   - **跨层仲裁卡（2 跳级联）**：`desk` 发起的共享阻塞/跨项目冲突卡，内核**只唤醒发卡方 `desk`**（不绕过 `desk` 群炸底层 Worker）→ `desk` 醒来可先唤 `fixer` 验通，再按主人决策分流 `send_message` 唤醒各 `waiters` / 相关 `Project`。
3. **三重防漏机制（防止第 2 跳遗漏唤醒且防重复骚扰）**：
   - **事前内核硬事实注入**：[readmodel.ts](../../packages/cell/src/readmodel.ts#L380-L395) 的 `tailNotes(cellId)` 条件注入（无则 0 Token）：**`[cells waiting on you]`**（实时查 `cell_waits` 等 `inbox:<cellId>` 的活跃分身与 `waitId`）、**`[your open cards]`**、**`[budget warning]`**（接入 80% `"warn"`）、`[your running jobs]`、`[human-edited artifacts]`、`[your active watches & schedules]`；同时 `cell.message` 自动携带 `fromProjectCellId` 与 `fromTitle`（`BUG-035`）；
   - **当轮收尾自检与巡检共用去重记录**：一次阻塞共用稳定 `causeKey` 与具体 `waitId` 列表；**只要 `desk` 已把答复排入某个 waiter 队列即算已分发**（不必等对方跑完）；若 `desk` 处理完 `approval.resolved` 后仍有未分发 waiter 且无新卡/无活跃关联 `fixer`，由内核补发一次 `kernel.arbitration_unanswered`；**仲裁自检与 `StallMonitor` 共用持久化重试次数与升级记录，同一 `causeKey` 最多补醒 1 次、对主人最多升 1 张卡**，绝不轮流轰炸；
   - **事后精准 5 锚点兜底**：叠加精准版 `BUG-017` 与 `BUG-030` 修复——巡检消息自身、无关项目的卡、同项目的另一路工作均不算该等待的进展；两段式自救失败后自动向「待我处理」升起唯一 `stalled` 卡片。

---

### 2.6 防人类误操作补救：诚实撤销语义与按代次隔离的 `reopenProject`（2026-11-21 拍板纳入）

针对 `BUG-031` 暴露的「误点即永久报废」痛点，本轮建立两项确定性、语义诚实的补救能力：

1. **受控项目原地重开（`reopenProject`）与按代次清理隔离**：
   - 在 `Radar`「最近结束（已完成/已取消）」与外部控制面提供「重新打开项目」能力；
   - **按代次隔离异步清理（防新任务被旧清理误杀）**：[dispatcher.ts](../../packages/cell/src/dispatcher.ts#L507) 的异步 `cleanupClosed` 严格绑定被关闭时的 `epoch`（跳过已进入新代次的运行现场，且 `reopenProject` 在启动前等待该 `cellId` 上一代在途清理确认退出）；关闭通知信封 ID 改为 `${target.id}:${target.epoch}:closed`（防重开后二次关闭被去重吞掉，`BUG-031`）；
   - **恢复边界明确**：单事务内将 `cells.status` 恢复为 `active`、`gtd:project.lifecycle` 翻回 `active`、保留历史会话/草稿/已用预算并按**当前祖先权限**恢复工作资格，再投递唤醒信封——**绝不复活旧授权令牌、旧定时器或独立撤销的权限**，仅按需带回当时随项目归档的 Worker。
2. **非外发操作的诚实撤销 Toast 与恢复**：
   - 所有非外发决策（`terminate(deny)`、`complete`、`reply`）均写入 `ActivityRecord(restorable: true)`，Web 端点击后弹出 **5～10 秒「撤销」Toast**；
   - **诚实两态处理（以首次认领时间 `firstClaimedAt` 判定，不以 `status === 'pending'` 误判）**：
     - 给回执信封持久化 **`firstClaimedAt`**（首次被认领时间戳——因为报错/暂停/关机退队会让已认领并动过文件的信封重新变回 `pending`）；
     - **真撤销**：对无回调个人提醒（`complete`）、0-Token 吞掉的纯拒发卡（`deny`）、以及回执信封**从未被认领（`firstClaimedAt === null && status === 'pending'`）**的 `reply`，在单个事务内撤回回执信封并将原 `HumanItem` 恢复为 `pending`；
     - **已生效更正**：只要回执曾被认领（`firstClaimedAt !== null`）或已产生后续写入，绝不假装时光倒流，而是追加一条带版本的更正通知唤醒对应 Cell，UI 诚实显示「**已通知后台更正**」；对已真实外发消息的 `execute` 则明示不可撤回。

---

## 三、配套内核、防犯蠢与协同修复清单（与提案 05 合流）

1. **精准修复 `wait(inbox:desk)` 假锚点（`BUG-017`）**：
   - `anchorsOf(projId)` 评估指向子树外常驻节点（如 `inbox:desk`）的 `wait` 时，**严禁看 `desk` 的全局未决卡、全局 Run 或泛查 `desk` 全子树**，仅认三者之一成立才计有效 `internal` 锚点：
     1. 存在 `relatedProjectIds` 包含 `projId` 的未决 `HumanItem`；
     2. `desk` 收件箱或当前 Run 存在来自 `projId` 子树的未消费 `wakeup` 消息；
     3. 存在显式标记 `meta.relatedProjectIds` 包含 `projId` 的活跃仲裁 `fixer` 子分身。
   - 同时 `anchorsOf` 排除 `paused` 目标、做同子树环等检测，并将 `dispatcher.heldForBudget()` 排除出 `@Agent` 锚点（`BUG-030`、`BUG-035`）。
2. **仲裁去重与禁中间态广播炸醒风暴（`BUG-018`）**：
   - 修订 `workspace-arbitration` 技能（[skills.ts](../../presets/src/shared/skills.ts#L116-L154)）与提示词：排查失败准备弹卡时，禁止向已 `wait(inbox:desk)` 的休眠 `waiters` 群发 `wakeup`；靠 `HumanItem.relatedProjectIds` 覆盖项目球权，等主人拍板并验证恢复后再一次性放行。
3. **LLM 犯蠢核心护栏（`BUG-029`）**：
   - `set_reminder` 与非空 `watches/schedules` 的 `update_cell` 返回 `awaitsWakeup: true`，`one_shot` 只要仍有未决 timer/watch/job/card 且未显式 `report_to_parent` 禁自动关停；
   - `waits.register` 强校验合法地址与存活目标，暴露 `clear_wait`，`wakeable` 调 `report_to_parent(result)` 自动清自身 open waits；
   - `finish_project` 延后至 `settleRun` 同事务写终态。

---

## 四、与提案 06 配套的实施排期

本提案专注**人机协作层**；底层内核与控制面的 4 项架构级拔根契约（真 SSOT 字段归属与去反向耦合、完整 CLI 游标同步与压缩协议、唯一领域命令层 `DeskService`、角色与知识桶正交化）沉淀在配套的 **[06-architecture-ssot-cli-sync-and-boundaries.md](./06-architecture-ssot-cli-sync-and-boundaries.md)** 中。

整体按 **「`Phase 0（共同 P0 止血）` → `先完整干完提案 05` → `再干提案 06`」** 串行推进，每步均要求全量门禁（`pnpm typecheck && pnpm test && pnpm build`）全绿：

| 阶段 | 核心改造内容 | 合流清零的 Bug | 涉及核心模块 |
| :--- | :--- | :--- | :--- |
| **Phase 0：共同内核 P0 止血（前置）** | 1. 定下 `DeskActor` 显式必填（禁默认退回主人）、`seenItemRevision` + `seenArtifactVersion`（**`approvals.resolve` 先验身份与双版本再查 `inflight`**、`ownerOnlyApproval` 补覆盖已弹出 `project.start`）、`set_state` 保留键护栏；<br>2. 外发三步 Saga（**拆出直接发送已登记尝试的通道方法，禁调用现有 `hub.send` 同键短路**、发卡节点关闭则已知结果转父节点）+ 常设规则自动发信遇 `unknown` 建/找唯一核实卡 + `deliverResolved` 入队验真（`reconcile` 遇 `deduped` 回查旧行）；<br>3. `drainSteerSync` 带 `claimId + envelopeId` 改标 `'claimed'`、**按条追踪追加输入不轻信 Claude `steer() === true`（未确认接收即退队）** + CLI `relaunchWith` 按 `envelopeId` 防丢防重；<br>4. macOS `cli/process.ts` 复用三态进程探测（存活 / 已退出 / 身份未知 `null` 保留记录暂缓替身）+ `workspace.recover` + `job_start` 超时；<br>5. 内核硬禁关/停根 `desk` + MCP `control_cell` 收口到 `DeskService` + `decide_card` 强制 `seenVersion` + `reconcile` 覆盖非发信卡 + `:retry:` 尝试序号与 `resolveUnknownSend` 唤醒；<br>6. 修 `draft_reply` 覆盖人类手改、`items.ts` 吞外发失败、`propose_project` 常设规则直接起项目、`desk:reminder` 复活、`inspect_cell` `[exit code 1]` 与空行、`records.ts` 来源识别。 | `BUG-020`、`BUG-021`(提醒)、`BUG-022`(来源)、`BUG-026`、`BUG-027`、`BUG-028`、`BUG-032`、`BUG-034` | `packages/inbox`<br>`packages/loop`<br>`packages/workspace`<br>`packages/cell`<br>`presets`<br>`apps/gtd-desk` |
| **05-A1：正交底座、零死状态原语与最小 CLI 游标** | 1. 落地三责分离 **`HumanItem` × `Gate` × `Outbox`**、覆盖 `pending/snoozed/unknown` 的分层 `subjectKey` 索引 + `relatedProjectIds`、5+1 `CardEffect`（含 `revise` 递增 `itemRevision`、`unknown` 推迟保持 `status='unknown'`、按 `ledgerCellId` 持久化预算拒绝停工标记防含根账本重弹、`cancel_task` 显式 `targetCellIds`）、`cwd/repos/phases` 进受控提案、个人提醒直落穿透预算；<br>2. `cell_waits` 支持 `wait_id`/`ref_id` 多独立等待 + `clear_wait` + `one_shot` 护栏 + `finish_project` 原子结案 + 回执 `firstClaimedAt` 首次认领时间戳；<br>3. 精准版 `BUG-017` + 仲裁自检与 `StallMonitor` 共用去重升级记录 + 多 Worker 撞同一祖先账本聚合唤醒；<br>4. `cleanupClosed` 按 `epoch` 隔离 + 关闭信封 ID 带 `epoch` + **最小版 CLI 游标增量补漏**（按实际输入推进，0-Token 与结算后 `system_note` 不推游标）；<br>5. `tailNotes` 按需注入 6 项硬事实、`readmodel` 区分 `budget_paused`、`cell.message` 带 `fromProjectCellId`、工具 `output` 暴露关键 ID、`track_action` 改查实时存储。 | `BUG-014`、`BUG-015`、`BUG-017`、`BUG-025`、`BUG-029`、`BUG-030`、`BUG-031`(清理竞态)、`BUG-033`(最小游标)、`BUG-035` | `packages/protocol`<br>`packages/gate`<br>`packages/cell`<br>`packages/loop`<br>`presets` |
| **05-A2：统一服务层、旧库迁移、MCP 合一与撤销重开** | 1. 落地旧库迁移脚本（严守第五节迁移铁律）；合并 `Clarify` + `Engage` 为唯一「待我处理」投影；废弃 `to_human`、MCP `complete_action`（MCP 走 `DeskService`）；区分未激活 `plan` 与活跃 `HumanItem`；<br>2. 新增受控 **`reopenProject`** 与诚实两态撤销/更正端点；<br>3. 补齐 `paused`/`someday` 路由与卡片隔离、`someday` 建项目与结案同事务。 | `BUG-016`、`BUG-031`(撤销与暂停) | `apps/gtd-desk/src/shared`<br>`apps/gtd-desk/src/server`<br>`apps/gtd-desk/src/agent` |
| **05-A3：Web UI 三视图合一与提示词更新** | 1. 顶栏精简 3 Tab（`待我处理 / 项目全局 / 分身实况`），左列表 + 右详情卡（高风险参数服务端直显）+ 8/4 专注编辑（租约式 DND）+ 单行可选输入框（空回车直发、冲突保留备注）+ 撤销 Toast + 最近结束重开项目 + 含活 Job 暂停确认；<br>2. 更新 `workspace-arbitration`、`project-relay` 与角色提示词（清 `BUG-018`、`BUG-019`）；<br>3. 通过第五节 6 项核心故障验收测试，同步更新第一、二层中与人类入口、卡片原语相关的章节。 | `BUG-018`、`BUG-019`、`BUG-031`(UI/DND) | `apps/gtd-desk/src/web/*`<br>`presets/src/shared/*`<br>`docs/01-principles/*`<br>`docs/02-workflows/*` |
| **后续阶段 B：执行提案 06（底层架构拔根）** | 详见 [06-architecture-ssot-cli-sync-and-boundaries.md](./06-architecture-ssot-cli-sync-and-boundaries.md)：真 SSOT 删光影子表与去内核反向耦合、完整 CLI 压缩与 `fork_prefix` 同步、剩余入口与脚本信源合一、`watcher` 与 `knowledge` 正交拆分。 | `BUG-021`(其余)、`BUG-022`(其余)、`BUG-023`、`BUG-024`、`BUG-031`(其余竞态)、`BUG-033`(完整) | 见提案 06 |

---

## 五、提案 05 上线门槛：旧库迁移铁律与 6 项核心故障验收场景

### 5.1 旧库迁移铁律（`05-A2` 上线硬门禁）
1. **无损保留既有事实**：保留全部旧审批卡 `id`、已绑定的草稿版本号、推迟到期时间 `snoozedUntil`、历史发送尝试与 `outbox` 回执；
2. **禁止模糊合并**：仅当旧 `approvals` 与 `gtd:action(owner="human")` 存在**显式关联键（如 `approvalActionId`）**时才合并为同一条 `HumanItem`；**绝不**按「同项目 + 同标题」猜测合并；
3. **一次性切换权威写入点**：切换后所有旧入口只转发到新命令，严禁新旧双写；
4. **迁移后必验 4 条回归（含 `unknown + pending` 同键合法旧数据）**：升级后 `unknown` 外发仍保持待核实状态；**当旧库同一 `subjectKey` 同时存在一张 `unknown` 与一张 `pending` 时（旧唯一索引允许），优先呈现旧发送的 `unknown` 核实卡并保留后续草稿与原 ID，核实后再激活后续决定（不撞新唯一索引）**；已取消的提醒不会复活；已撤销卡片的旧定时器不会触发复活。

### 5.2 6 项上线必过故障验收场景（`vitest` 自动化覆盖）
1. **双标签页对同卡做相反决定**：两个请求持相同旧 `seenItemRevision` 同时提交（或后台修改选项/额度后旧标签页提交），前者成功、后者确定性返回版本冲突且不丢输入框备注；
2. **外发对方已收到、本地记账前崩溃**：重启后恢复为 `unknown`（绝不误判 `failed` 诱导重发），且普通 `deny` 被拒，仅允许核实后以 `wakeup` 续跑；
3. **预算耗尽且个人提醒与普通模型消息同批到期**：个人提醒独立落入「待我处理」不被卡死，普通模型消息继续留队等待续费；对预算卡点「拒绝追加」后确定性停工，绝不无限重弹同一张预算卡；
4. **同一分身对 `desk` 挂起两个独立等待**：借助 `wait_id`/`ref_id` 互不覆盖，只答复其一时另一条仍保持挂起，且 `desk` 自检与 `StallMonitor` 共享记录不重复骚扰；
5. **关闭清理未结束即 `reopenProject` 并启动新 Job**：旧异步 `cleanupClosed` 因 `epoch` 不匹配不误杀新任务，重开后再次关闭仍能正常向父级送达带新 `epoch` 的关闭通知；
6. **两次 CLI 重启之间产生未交付的 `settleRun` 纠正记录（`#101`）**：模型见到 `#100` 退出、结算写入 `#101` `system_note`，CLI 游标停在 `100` 而非 `101`，下轮 `--resume` 准确补喂 `#101` 不遗漏。
