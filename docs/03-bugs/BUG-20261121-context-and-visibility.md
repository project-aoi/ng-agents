# Bug 详情单（2026-11-21 架构审计）：Agent 上下文完备性、CLI 失忆与信息可见性（`BUG-032` ～ `BUG-035`）

> **来源**：2026-11-21 全仓上下文与可观测性深度审计（覆盖 API Loop vs CLI Session Resume、人类改稿反馈、实时快照 `tailNotes`/`roster`/`inspect_cell` 与跨角色工具返回值；合流至修订版[提案 05](../05-proposals/05-unified-human-inbox-and-custom-cards.md)）。

---

## `BUG-032`（P0）：人类手改草稿盲视与静默覆盖 + 固定 ID 吞二次失败 + `items.ts` 静默吞外发失败

- **核心源码**：
  - 覆盖人类手改：[toolset.ts](../../presets/src/inline-desk/toolset.ts#L244-L255)（`revise === true` 时私自取 `cur.version` 填 `expectedVersion` 绕过防覆盖锁）
  - 缺少手改 diff：[approvals.ts](../../packages/cell/src/approvals.ts#L78-L95)、[approvals.ts](../../packages/cell/src/approvals.ts#L268-L297)
  - 重试失败撞 ID：[approvals.ts](../../packages/cell/src/approvals.ts#L95)（`${rec.actionId}:resolved:${status}`）
  - 吞外发失败：[items.ts](../../presets/src/inline-desk/items.ts#L284-L301)（`channel.send` 的 `failed`/`unknown` 无条件 `return true` 当 0-Token 消化）
- **根因与后果**：
  1. 主人在专注区亲手修改草稿存为 v2 后，点「让 AI 调一下语气」发 `approval.revise`——信封既无 `humanEdited` 标记也无 v2 内容/diff；模型凭 v1 记忆重拟后调 `draft_reply`，因 `toolset.ts:248` 自动塞入 `cur.version`（v2），**把主人手改内容悄无声息覆盖回旧版**！
  2. `approval.resolved` 回传的始终是建卡时的 v1 `rec.action`，主人改稿后批准，模型仍不知改了哪几行。
  3. 外发首次失败后用户点重试再次失败，相同信封 ID 被 Inbox 去重吞掉；且 `items.ts:300` 对 `failed`/`unknown` 直接返回 `true` 0-Token 吞掉，系统不会唤醒处理。
- **修复方向（Batch 0 止血 + Batch 1）**：
  - `draft_reply` 禁止在 `updatedBy === "human"` 时私自代填 `expectedVersion`，强制模型先读最新版本；
  - `approval.revise` 与 `approval.resolved` 在 `humanEdited: true` 时附加紧凑行级 diff（≤1,500 字）与最新版本号；
  - 失败/未知回执信封 ID 附带尝试序号；修复 `items.ts:284-301` 仅对 `executed`/`denied`/`cancelled` 0-Token 吸收，`failed`/`unknown` 必须唤醒。
- **Phase 0 修复结论（2026-11-21 · `fixed`）**：
  - `presets/src/inline-desk/toolset.ts`：`draft_reply` 在 `cur.updatedBy === "human"` 时即使 `revise: true` 也不再代填 `cur.version`，必须由模型显式读取最新人工版本后再传入 `expectedVersion`；
  - `packages/cell/src/approvals.ts`：`approval.revise` 与 `approval.resolved`（按 `boundVersion` 对比）在 `humanEdited: true` 时附紧凑行级 `humanDiff`（≤ 1,500 字）与 `artifactVersion`；
  - `packages/cell/src/approvals.ts`：`failed` / `unknown` 回执信封 ID 附尝试序号 `:a${attemptSeq}`（发前 `issueTokenSync` 失败用独立 `:pf_*` 标记防撞 `:a1`），避免连续失败被去重吞掉；
  - `presets/src/inline-desk/items.ts`：`channel.send` 的 `failed` / `unknown` 回执返回 `false`，不再被 0-Token 消化吞掉。
  - **测试覆盖**：`packages/cell/test/phase0.test.ts`、`presets/test/phase0.test.ts` 全绿。

---

## `BUG-033`（P0）：CLI `--resume` 失忆与 Prefix 冻结四盲区 + 压缩雪崩失忆

**结案**　提案 06 已覆盖证据游标与重建。`packages/loop/test/cli.test.ts` 覆盖压缩越过旧游标后，续接仍发送中间的结算证据，并只确认已送达的输入。

- **核心源码**：
  - CLI 0-Token 与 `system_note` 失忆：[dispatcher.ts](../../packages/cell/src/dispatcher.ts#L495-L606)、[items.ts](../../presets/src/inline-desk/items.ts#L190-L201)、[loop.ts](../../packages/loop/src/cli/loop.ts#L229-L235)
  - Prefix 刷新四盲区：[hydrate.ts](../../packages/context/src/hydrate.ts#L304-L333)（`fork_prefix` 借父 hash 未计入 `fork_note`）、[kernel.ts](../../packages/cell/src/kernel.ts#L311-L321)（忽略 `kind === "skill"`）、[boot.ts](../../apps/gtd-desk/src/server/boot.ts#L175-L178)（发版升级不刷新旧 Prefix）、[codex.ts](../../packages/loop/src/cli/adapters/codex.ts#L67-L74)（`exec fork` 缺 `-C` 与 `developer_instructions`）
  - 压缩雪崩：[hydrate.ts](../../packages/context/src/hydrate.ts#L231-L275)（单轮超 60k 致 `keepRecentChars` 归零）、[summarize.ts](../../packages/context/src/summarize.ts#L9-L32)（最旧先丢删光首条 `cell.task`）、[render.ts](../../packages/loop/src/cli/render.ts#L3-L29)（CLI 重建硬切 4000 字切掉 `res://`）
- **根因与后果**：
  1. `prepareRun === "handled"` 0-Token 消化的审批/立项/提醒事件，以及 `complete_self` 因有活子 Cell 被拒写入的 `system_note`，只落盘 `evidence`——API 模式重读历史看得到，而 **CLI `--resume` 只收新 batch，对休眠期间发生的事完全失忆**。
  2. 升级代码（如上线提案 05 新提示词）、新增全局 Skill、或更新 `fork_prefix` 子角色偏好后，已有持久 Cell 继续沿用 SQLite 中冻结的旧 Prefix，完全不认新规则。
  3. 生产未接 LLM 摘要器，长任务一次压缩把首条 `cell.task` 删光；若末轮超 60k 则连刚结束的一整轮都被压没。
- **修复方向（Batch 1）**：
  - CLI session 维护 `lastDeliveredEvidenceSeq`，`--resume` 时将休眠期间未送入 CLI 的 0-Token 事件与 `system_note` 压缩成紧凑几行前置进 `tailText`；
  - `fork_prefix` 独立算 hash；`kernel.ts` 同步监听 `skill` 变更；`boot.ts` 启动比对代码 hash 自动刷新升级后的持久 Cell Prefix；补全 Codex/Claude fork 参数；
  - 压缩永久钉住首条 `cell.task` 结构化摘要、兜底保留末轮末段、CLI 重建保留「头 2000 + 尾 1500 + `res://`」。

---

## `BUG-034`（P0）：`inspect_cell` 摘要失真（`bash` 报错剪成 `[exit code 1]`、关键事件空行、丢 `res://` 与结尾）+ `propose_project` 常设规则分支撒谎

- **核心源码**：
  - `inspect_cell` 失真：[workspace.ts](../../packages/loop/src/tools/workspace.ts#L15-L20)（非零 `exitCode` 不置 `isError: true` 且末行放 `[exit code N]`）、[inspect.ts](../../packages/cell/src/inspect.ts#L29-L165)（`payloadText` 不认 `job.result`/`approval.resolved`、`isError` 反取头 200 字、摘要切掉 `res://`、超 12k 前向截断留头丢尾）
  - `propose_project` 撒谎：[toolset.ts](../../presets/src/inline-desk/toolset.ts#L551)（`allow` 分支让模型调 `apply_updates` 启动项目，但 `apply_updates` 只认 `approval.resolved` 信封）
- **根因与后果**：
  1. 父项目 Pull 失败 Worker 的足迹时，所有 `bash` 报错摘要只剩 `→ [exit code 1]`，真实错误堆栈全灭；`job.result` 与 `approval.resolved` 即使 `detail: "full"` 也渲染为空白行；`res://` 链接被切掉；超长记录留着开头 `list_dir` 却把结尾改文件与结论截没。
  2. `propose_project` 命中常设自动放行规则后，模型乖乖调 `apply_updates` 收到 `"Nothing to apply."`，项目永远不会启动。
- **修复方向（Batch 0 止血）**：
  - `workspace.ts:15` 非零 `exitCode` 返回 `isError: true`；`inspect.ts` 对 `isError` 取末尾 200 字并必附加 `[res://...]`、为 `job.result`/`approval.resolved` 加专用单行 formatter、超长改「头 20% + 尾 80%」；
  - `propose_project` 的 `allow` 分支直接调 `launchProject` 并返回 `projectId`。
- **Phase 0 修复结论（2026-11-21 · `fixed`）**：
  - `packages/loop/src/tools/workspace.ts`：`execOutput` 在 `exitCode !== undefined && exitCode !== 0` 时返回 `isError: true`；
  - `packages/cell/src/inspect.ts` + `packages/protocol/src/contract/cell.ts` + `apps/gtd-desk/src/agent/tools.ts`：错误摘要取末尾 200 字并必保留 `[res://...]`；新增 `job.result`（末尾错误尾段）与 `approval.resolved` 专用单行 formatter；超 `maxChars` 改为「头 20% + 尾 80%」截断（严格守住预算上限）并在 `CellInspection` / MCP `inspect_cell` 返回精确续读游标 `resumeAfterSeq`；
  - `presets/src/inline-desk/toolset.ts`：`propose_project` 命中常设 `allow` 规则时直接调用 `launchProject` 启动项目并返回 `projectId`。
  - **测试覆盖**：`packages/loop/test/tools.test.ts`、`packages/cell/test/phase0.test.ts`、`presets/test/phase0.test.ts` 全绿。

---

## `BUG-035`（P1）：实时快照与事件载荷盲区（预算冻结伪装成 `working`、`track_action` 拒新派 Worker、`tailNotes` 缺核心事实、工具隐藏 ID）

**本轮回归**　`track_action` 在调用时查直接子节点。协调器和外部查询均显示额度暂停，项目能看见后代创建的共享文档被主人修改。预算与文档投影见 `packages/cell/test/docs05-anchors.test.ts`。

- **核心源码**：
  - `roster` 与 `tailNotes`：[readmodel.ts](../../packages/cell/src/readmodel.ts#L79-L425)、[loop.ts](../../packages/loop/src/loop.ts#L179)（忽略 80% 预算 `"warn"`）、[toolset.ts](../../presets/src/project/toolset.ts#L220)（`track_action` 拿 Run 初过期 `roster` 校验 `cellId`）
  - 事件载荷缺口：[messages.ts](../../packages/cell/src/messages.ts#L41-L69)（`cell.direct_chat` 丢 `replyToText`）、[messages.ts](../../packages/cell/src/messages.ts#L105-L113)（`cell.message` 缺 `fromProjectCellId`）、[messages.ts](../../packages/cell/src/messages.ts#L178-L198)（`steer` 剥发件人伪标用户）、[render.ts](../../packages/context/src/render.ts#L47-L49)（剥 `raw` 丢 GitHub `reviewState`/飞书 `chatType`）、[jobs.ts](../../packages/workspace/src/jobs.ts#L245-L258)（丢 `error`）、[sensor.ts](../../presets/src/shared/sensor.ts#L132)（20KB 原文不 spill）
  - 工具藏 ID 与能力缺口：[loop.ts](../../packages/protocol/src/contract/loop.ts#L69)、[toolset.ts](../../presets/src/inline-desk/toolset.ts#L291-L740)、[comms.ts](../../packages/loop/src/tools/comms.ts#L99-L275)、[search.ts](../../packages/context/src/search.ts#L141)
- **根因与后果**：
  1. `readmodel` 不查 `dispatcher.heldForBudget()`，预算停摆的 Cell 在 `roster` 显示成 `working` 且误满足 `@Agent` 锚点；60 条 `roster` 静默截断；`track_action` 拒收同轮刚 `dispatch` 的 Worker。
  2. `tailNotes` 缺少条件注入（无则 0 Token）的 `[cells waiting on you]`、`[your open cards]`、`[budget warning]`、`[your running jobs]`、`[human-edited artifacts]`、`[your active watches & schedules]`。
  3. `cell.message` 不带 `fromProjectCellId` 导致 `desk` 在仲裁时无法可靠填写 `relatedProjectIds`；GitHub review 丢失 Approve/Request Changes；`draft_reply`/`propose_project`/`send_message`/`set_reminder`/`add_source` 把关键 ID 藏在模型不可见的 `ToolResult.data` 里。
- **修复方向（Batch 1 + Batch 2）**：
  - `readmodel` 区分 `budget_paused` 且不计入 `@Agent`、活跃优先排序并加省略提示；`track_action`/`stop_item`/`review_week` 改查实时 store；
  - `tailNotes` 按需补齐 6 项内核硬事实，80% 预算 `"warn"` 当轮注入收尾提醒；
  - 补全事件元数据（`fromProjectCellId`、`replyToText`、`steer` 真实发件人、`reviewState`/`chatType`、`job.error`、`source.hit` spill）并在工具 `output` 括号附回关键 ID；`search_history(lineage)` 纳入本 Cell 自身 `artifacts`/`state`，API Worker 注入 `cwd`。
