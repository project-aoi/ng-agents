# 提案 07：MCP 外部 AI 与人端功能对等、移除 ownerOnly 限制及取消鉴权

> **状态**：已实施（2026-11-23）

## 术语约定

本提案严格区分两类 AI，避免概念混淆：

- **MCP 外部 AI（外部主代理）**：主人日常使用的助手（Claude Code、Codex、Antigravity 等），通过 `apps/gtd-desk/bin/ng-mcp.mjs`（stdio MCP）或直接调用 `/api/agent/tools/*` 来操控工作台。**本提案面向的就是这一层。**
- **内部后台节点（`cell:*`）**：工作台内部监督树中运行的总助理、项目协调、执行分身、外部盯梢、信源、领域中枢。它们属于被调度的后台执行单元，不走控制面，仍保持内部监督树约束（不能自批卡片、`child ⊆ parent` 权限收紧、无关后台节点不可篡改其他任务发起的待批立项方案）。

---

## 一、背景与目标

当前工作台虽然同时提供 Web 人端（`/api/*`）和 MCP 外部 AI 控制面（`/api/agent/tools/*`），但存在三类人为割裂：

1. **存在多处「仅限主人（`ownerOnly`）」硬拦截**：MCP 外部 AI 虽然能通过 `create_project` 直接立项，却被禁止批准或停靠立项确认卡（`project.start`）、禁止撤销立项决定、禁止编辑文稿（`saveArtifact`）、禁止修改待批立项方案（`savePlan`），也无法初始化根工作台。
2. **令牌分类与鉴权过重**：本地单机工作台维护了 `NG_DESK_TOKEN`、`NG_AGENT_TOKEN`、`NG_AGENT_TOKENS`、回环自动生成随机令牌与 `#token=` 登录链接、前端令牌输入页以及 MCP 401 鉴权链路，增加了本机使用与接入摩擦。
3. **MCP 工具覆盖不全**：底层 `Desk` 服务已具备信源管理、周回顾、Runner/模型配置、后台活动与误归档恢复、手动触发脚本探针、清理文稿冲突参考区等能力，但 MCP 控制面未暴露，导致部分功能必须回到网页端操作。

### 目标

1. **全面移除 `ownerOnly` 限制**：所有位置均不再区分主人与 MCP 外部 AI 的操作权限，控制面上两者完全对等。
2. **彻底删除整套鉴权**：不保留令牌分类，删除全部 Bearer Token 校验、随机登录链接与鉴权配置；服务默认监听 `127.0.0.1:8790`，打开网页或接入 MCP 即可直接使用。
3. **MCP 外部 AI 与 Web 人端 100% 功能对等**：补齐所有缺失的只读与写操作工具，使人在网页端能做的每一件事，MCP 外部 AI 都能直接完成。

### 保留的内核不变量

- **内部后台节点（`cell:*`）隔离不变**：后台节点仍不能自行批准/撤销待处理卡片，仍遵守 `child ⊆ parent` 与工作目录安全红线（`P-SAFE-1 ~ P-SAFE-3`）。
- **乐观并发与冲突保护不变**：卡片修订号（`seenItemRevision`）、文稿版本（`seenArtifactVersion` / `expectedVersion`）以及后台并发写文稿冲突时停靠至参考区（`parked`）的机制保持不变。
- **操作来源区分保留为纯记录信息**：Web 端调用仍记录为 `owner`，MCP 控制面调用默认记录为 `agent:local`，仅用于审计与消息归因（如「主人」vs「主人（经主 Agent）」），不再作为任何权限判断条件。

---

## 二、改动一：全面移除所有「仅限主人（`ownerOnly`）」限制

> **关键解耦点**：现有代码把 `ownerOnlyApproval(action)` 同时当成了「权限拦截条件」和「判断动作是否为 `project.start` 的业务谓词」。删除 `ownerOnlyApproval` 时，必须在 `human-items.ts`（触发 `approvedSpawn` 建项目）和 `ports.ts`（阻止无关内部细胞修改待批方案）中显式改为 `action.type === "project.start"`，避免破坏正常立项与内部隔离。

| 模块 / 文件 | 现状 | 调整方案 |
| --- | --- | --- |
| `packages/protocol/src/contract/gate.ts`<br>`packages/protocol/src/index.ts`<br>`packages/gate/src/policy.ts`<br>`packages/gate/src/index.ts` | 定义并重导出 `ownerOnlyApproval(action)` | 彻底删除 `ownerOnlyApproval` 及其所有导出 |
| `packages/gate/src/gate.ts` | `approveSync` 在 `decider !== "owner"` 且命中 `ownerOnlyApproval` 时抛 `bounds_violation` | 删除该拦截；保留 `assertOwnerOrAgent`（放行 `owner` 与 `agent`，拒绝 `cell:*` / `external:*`） |
| `packages/cell/src/human-items.ts` | ① `applyDecision` 拦截非 `owner` 执行 `ownerOnlyApproval` 选项<br>② `applyDecision` 用 `if (ownerOnlyApproval(rec.action))` 判断是否走 `approvedSpawn`<br>③ `undo` 拦截非 `owner` 撤销 `ownerOnlyApproval` 卡片 | ① 删除拦截<br>② 解耦为 `if (rec.action.type === "project.start")`，确保 MCP 外部 AI 批准立项卡后同样自动派生项目<br>③ 删除拦截 |
| `packages/cell/src/ports.ts` | 内部细胞 `commit` 中用 `binding.cell_id !== cellId && ownerOnlyApproval(action)` 防止无关后台细胞修改待批文稿 | 解耦为 `binding.cell_id !== cellId && action.type === "project.start"`，报错文案调整为 `"只有发起任务或控制面可以修改这份待批立项方案"` |
| `packages/cell/src/lifecycle.ts` | `createRootCell` / `ensureRootCell` 仅允许 `kind === "owner"` | 放宽为 `kind === "owner" \|\| kind === "agent"`（仍拒绝 `cell:*` / `external:*`） |
| `apps/gtd-desk/src/server/desk.ts` | ① `parkProposal` 校验 `approverId !== owner`<br>② `savePlan` 校验 `if (byAgent(as))`<br>③ `saveArtifact` 校验 `if (byAgent(as))`<br>④ `listHumanItems` 计算 `ownerOnly` 字段 | 全部删除上述限制与 `ownerOnly` 字段；`principalOf(as)` 已保证调用方为控制面身份 |
| `apps/gtd-desk/src/shared/api.ts`<br>`apps/gtd-desk/src/agent/tools.ts`<br>`apps/gtd-desk/src/web/views/HumanInbox.tsx` | `HumanItemDTO.ownerOnly`、`[ownerOnly]` 标注及「此操作需要主人确认」文案 | 删除 `ownerOnly` 字段与标注；前端 `bounds_violation` 提示改为通用权限错误文案 |

### `saveArtifact` / `savePlan` 的 `updatedBy` 约定

MCP 外部 AI 通过 `Desk.saveArtifact` / `Desk.savePlan` 修订文稿与立项方案时，属于控制面（用户侧）修改，与后台分身（`cell:*`）自动写入区分，因此仍写入 `updatedBy: "human"`：
- 后台分身随后基于旧版本写入并冲突时，仍会停靠至 `parked` 参考区而非覆盖控制面改动；
- 批准卡片时 `humanEdited` 与 `humanDiff` 能准确反馈修订差异。

---

## 三、改动二：彻底删除整套鉴权机制

删除全部 Token 分类、Bearer 鉴权、启动随机令牌、登录链接与前端令牌输入逻辑：

| 模块 / 文件 | 移除与简化内容 |
| --- | --- |
| `apps/gtd-desk/src/server/security.ts` | 删除 `token`、`generatedOwnerToken`、`agentTokens`、`agentTokensFromEnv`、`agentAuthFor`、`tokenMatches`、`bearerOf` 及令牌长度/互斥校验；取消非回环地址必须配令牌的 `SecurityConfigError`（默认监听仍为 `127.0.0.1`）。可按需仅保留可选的轻量防跨站检查（`crossSiteReason` / `allowedHosts`），或精简整个文件只保留纯 HTTP 请求守卫。 |
| `apps/gtd-desk/src/server/app.ts` | 删除 `/api/*` 与 `/api/agent/*` 的 Bearer Token / `?token=` 校验及 401 `WWW-Authenticate` 分支；`/api/*` 直接以 `owner` 身份执行，`/api/agent/*` 直接以 `agent:local` 身份执行。 |
| `apps/gtd-desk/src/server/boot.ts` | 删除 `DeskServerOptions.token`、`agentTokens`、`NG_DESK_TOKEN`、`NG_AGENT_TOKEN`、`NG_AGENT_TOKENS`、`settings.tokenRequired` 与启动日志里的 token 鉴权状态。 |
| `apps/gtd-desk/src/server/main.ts` | 删除 `bearer token required` 和 `本次工作台登录链接 ${url}/#token=...` 输出，启动后直接打印访问地址 `http://127.0.0.1:8790`。 |
| `apps/gtd-desk/src/shared/api.ts`<br>`apps/gtd-desk/src/server/projections/common.ts`<br>`apps/gtd-desk/src/server/projections/status.ts` | 移除 `StatusDTO.auth.tokenRequired` 与 `DeskSettings.tokenRequired`。 |
| `apps/gtd-desk/src/web/api.ts`<br>`apps/gtd-desk/src/web/main.tsx`<br>`apps/gtd-desk/src/web/components/states.tsx` | 删除 `TOKEN_KEY`、`initToken`、`setToken`、`hasToken`、`Authorization` 请求头、`eventsUrl()` 中的 `?token=` 以及 `ErrorState` 中的 401 令牌输入表单；`/api/events` 直接连接。 |
| `apps/gtd-desk/bin/ng-mcp.mjs` | 删除 `NG_AGENT_TOKEN` 读取、`Authorization` 头及 401 鉴权错误分支，仅保留 `NG_DESK_URL` 和 `NG_MCP_TIMEOUT_MS`。 |
| `packages/loop/src/cli/env.ts`、`packages/workspace/` | 检查并清理不再需要的 `NG_DESK_TOKEN` / `NG_AGENT_TOKEN` 说明（若 `NG_*` 通用过滤规则仍保留，则仅更新相关测试断言）。 |

---

## 四、改动三：补齐 MCP 外部 AI 控制面，实现与 Web 人端 100% 功能对等

对标 `apps/gtd-desk/src/server/app.ts` 的全部人端 HTTP 接口，在现有 **23 个**外部 Agent 工具基础上，**新增 13 个工具**、**增强 8 个已有工具**（共 36 个工具），消除所有功能缺口。

### 1. Web `/api/*` 与 MCP 工具全量对照表

| Web 人端接口（`apps/gtd-desk/src/server/app.ts`） | MCP 外部 AI 工具（改造后） | 变更 |
| --- | --- | --- |
| `GET /api/status`、`GET /api/radar`、`GET /api/projects/closed` | `workbench_overview`、`get_project` | 增强（补齐今日统计、项目白板 `notes`、活跃 `jobs`） |
| `GET /api/models`（含 `?refresh=1`） | **`get_models`** | **新增** |
| `PUT /api/models` | **`configure_models`** | **新增** |
| `POST /api/capture` | `capture` | 增强（补齐 `attachments`、`voice`） |
| `GET /api/human-items` | `list_human_items` | 增强（补齐 `includeSnoozed`，移除 `ownerOnly`） |
| `POST /api/human-items/:id/decide` | `decide_human_item` | 放开全部选项（含立项 `system.execute` / `system.someday`） |
| `PUT /api/human-items/:id/plan` | **`save_plan`** | **新增** |
| `POST /api/human-activity/:id/undo` | `undo_human_decision` | 放开立项相关决策撤销 |
| `POST /api/projects/:id/reopen` | `reopen_project` | 保持 |
| `GET /api/artifacts/:id` | `read_artifact` | 增强（补齐 `versions`、`parked` 列表、`decisions` 段） |
| `PUT /api/artifacts/:id` | **`save_artifact`** | **新增** |
| `POST /api/artifacts/:id/parked/:parkedId/dismiss` | **`dismiss_parked`** | **新增** |
| `POST /api/projects/:id/{pause,resume,cancel,complete,someday,activate}` | `set_project_state` | 保持 |
| `POST /api/projects/:id/actions` | `add_action` | 增强（补齐 `effort`） |
| `GET /api/agents/topology` | **`get_topology`** | **新增** |
| `GET /api/cells/:id/timeline` | `get_cell`、`inspect_cell` | 增强 `get_cell`（补齐 `branch`、`notes`、`jobs`、`pendingQuestion`） |
| `GET /api/resources` | `read_resource` | 保持 |
| `POST /api/cells/:id/messages` | `message_cell`、`chat_with_desk` | 保持 |
| `POST /api/cells/:id/control`、`POST /api/cells/:id/trigger` | `control_cell` | 增强（`action` 新增 `"trigger"`） |
| `GET /api/review` | **`get_review`** | **新增** |
| `POST /api/review/skills/:name/accept\|dismiss`、`POST /api/review/sensors/:id/code` | **`resolve_review_suggestion`** | **新增** |
| `GET /api/activity` | **`list_activity`** | **新增** |
| `POST /api/activity/:cellId/:activityId/restore` | **`restore_activity`** | **新增** |
| `GET /api/sources` | **`list_sources`** | **新增** |
| `POST /api/sources` | **`create_source`** | **新增** |
| `POST /api/sources/:id/pause\|resume`、`PUT .../mode`、`DELETE .../sources/:id` | **`manage_source`** | **新增** |

> 注：`GET /api/events`（SSE）属于浏览器端实时渲染推流，不对应同步工具；MCP 外部 AI 继续通过异步拉取工具按需获取最新状态。

### 2. 新增 13 个工具契约

#### 文稿与方案编辑（3 个）
1. **`save_artifact`**：`{ id, expectedVersion, body, title?, format?: "text"|"markdown"|"json", data? }` → 调用 `desk.saveArtifact`；版本冲突时返回最新版本、`parked` 列表与正文，不覆盖。
2. **`dismiss_parked`**：`{ artifactId, parkedId }` → 调用 `desk.dismissParked`，清除已查阅/合并的冲突参考条目。
3. **`save_plan`**：`{ id, expectedVersion, title?, outcome, background?, runnerOverride?: { engine, model?, effort? } | null, actions: Array<{ title, owner: "human"|"agent"|"waiting", effort?: "15m"|"45m"|"low_energy", nextStep? }> }` → 调用 `desk.savePlan`，版本冲突时返回最新方案。

#### 信源管理（3 个）
4. **`list_sources`**：`{}` → 调用 `desk.sources()`，列出所有定时/条件信源的配置、模式、状态、运行/命中次数及最近错误。
5. **`create_source`**：`{ title, description?, cron?, tz?, everyMinutes?, checkKind: "script"|"code"|"llm", scriptPath?, codeEntry?, instruction?, mode?: "active"|"observe" }` → 组装为 `CreateSourceRequest` 调用 `desk.createSource`（扁平入参便于 LLM 准确传参）。
6. **`manage_source`**：`{ sensorId, action: "pause"|"resume"|"set_mode"|"delete", mode?: "active"|"observe" }` → 映射到 `desk.pauseSource` / `desk.setSourceMode` / `desk.deleteSource`。

#### 周回顾与建议（2 个）
7. **`get_review`**：`{}` → 调用 `desk.review()`，返回本周完结、超期等待、本周修改草稿数、Skill 建议与信源脚本化建议。
8. **`resolve_review_suggestion`**：`{ action: "accept_skill"|"dismiss_skill"|"sensor_to_code", name?, sensorId?, entry? }` → 映射到 `desk.acceptSkill` / `desk.dismissSkill` / `desk.sensorToCode`。

#### 后台活动记录与恢复（2 个）
9. **`list_activity`**：`{ kind?: "notification_archived"|"note_saved"|"reminder_set"|"card_withdrawn"|"action_completed" }` → 调用 `desk.activity(kind)`，返回分类统计与活动明细。
10. **`restore_activity`**：`{ cellId, activityId }` → 调用 `desk.restoreActivity`，将误归档项交回主台重新分拣。

#### Runner 与模型配置（2 个）
11. **`get_models`**：`{ refresh?: boolean }` → 调用 `desk.models(refresh === true)`，返回所有已启用 CLI 的模型目录及全局/层级生效配置。
12. **`configure_models`**：`{ target: "runner"|"tier"|"role", runner?, tier?: "strong"|"fast", engine?, role?: "desk"|"project"|"worker"|"hub"|"checker"|"sensor", mode?: "auto"|"fixed"|"inherit"|"custom", model?, effort? }` → 映射为 `UpdateModelsRequest` 调用 `desk.setModel`。

#### 分身关系拓扑（1 个）
13. **`get_topology`**：`{ includeArchived?: boolean, projectId?: string }` → 调用 `desk.topology`，返回三层节点拓扑、等待关系、同目录协作高亮与未汇总计数。

### 3. 已有工具与校验器增强

- `validateArgs`（`apps/gtd-desk/src/agent/tools.ts`）：补充 `object` 类型校验，使 `actions`、`attachments`、`runnerOverride` 等结构化参数在进入 handler 前即可返回清晰修正提示。
- `capture`：补齐 `attachments`、`voice`。
- `add_action`：补齐 `effort`。
- `list_human_items`：补齐 `includeSnoozed`（默认 `false`），移除 `ownerOnly`。
- `read_artifact`：补齐 `versions`、`decisions`、`parked` 列表。
- `get_project`：补齐项目白板 `notes` 与在途 `jobs`。
- `get_cell`：补齐 `branch`、`notes`、`jobs`、`pendingQuestion`。
- `control_cell`：`action` 枚举增加 `"trigger"`（调用 `desk.cellTrigger`）。
- `workbench_overview`：补齐 `today` 今日统计与当前 `backend`/`model`。

---

## 五、文档、Skill 与测试同步清单

### 1. 原则、工作流与文档
- `README.md`：移除登录链接、`NG_DESK_TOKEN`、`NG_AGENT_TOKEN`、`NG_AGENT_TOKENS` 说明。
- `AGENTS.md`：移除“立项确认卡只允许主人批准”约束，改为“Web 主人端与 MCP 外部主代理操作权限完全对等”。
- `docs/01-principles/03-safety-and-boundaries.md`（`P-SAFE-4`）：移除立项确认卡仅限 owner 批准的表述，明确 `owner` 与 MCP 外部 `agent` 控制面权限完全对等，内部 `cell:*` 仍受 `child ⊆ parent` 约束。
- `docs/02-workflows/uc07-external-agent-and-overnight-hosting.md`（`INV-UC07-02`）：更新为外部助手可直接审批、停靠与编辑 `project.start` 立项卡。
- `docs/05-proposals/01-conversational-desk-and-dual-entry.md`：移除 `ownerOnly` 描述。
- `docs/03-bugs/BUG-20261121-orthogonality-and-control.md`：标注原「项目确认卡执行选项仅限主人」限制已由本提案废止。
- `apps/gtd-desk/src/agent/guide.ts`、`apps/gtd-desk/main-agent/ng-desk/skills/ng-desk/SKILL.md`、`apps/gtd-desk/main-agent/todo.md`：删除 `ownerOnly` 与 `NG_AGENT_TOKEN` 说明，补充全部新增工具使用指引。

### 2. 测试更新与回归入口
- `packages/gate/test/approvals.test.ts`：`agent:ops` 批准 `project.start` 由“拒绝”改为“允许”；保留对 `cell:*` / `external:*` 拒绝的断言。
- `packages/cell/test/docs05-anchors.test.ts`：`createRootCell` 对 `agent` 放行，保留对 `cell:*` / `external:*` 的拒绝断言。
- `packages/cell/test/human-items.test.ts`：覆盖 `agent:<id>` 批准 `project.start` 触发 `approvedSpawn`、`agent:<id>` 撤销决定，以及无关 `cell:*` 不可改待批立项方案。
- `apps/gtd-desk/test/server.test.ts`、`apps/gtd-desk/test/helpers.ts`、`apps/gtd-desk/test/models-browser.test.ts`、`apps/gtd-desk/test/human-inbox-browser.test.ts`：移除全部 Bearer Token / 401 / `generatedOwnerToken` / `tokenRequired` / `ownerOnly` 断言与夹具。
- `apps/gtd-desk/test/agent.test.ts`：移除 `NG_AGENT_TOKEN` / `NG_DESK_TOKEN` / `ownerOnly` 断言；补齐全部 13 个新增工具、8 个增强工具以及 MCP 审批/停靠/改方案/改文稿/冲突清理的端到端测试。

---

## 六、分阶段实施与验证（待确认后执行）

1. **阶段 1（去限制）**：删除 `ownerOnlyApproval` 并解耦 `project.start` 业务逻辑，放开 `Gate`、`HumanItems`、`Lifecycle`、`Desk` 与 DTO/UI。
2. **阶段 2（去鉴权）**：移除服务端、前端、MCP 代理及测试夹具中的所有令牌分类与鉴权逻辑。
3. **阶段 3（补工具）**：在 `guide.ts` 与 `tools.ts` 中实现 13 个新增工具、8 个工具增强与 `validateArgs` 增强。
4. **阶段 4（同步文档与验证）**：同步全部文档、Skill 与测试，运行：
   ```sh
   pnpm typecheck && pnpm test && pnpm build
   ```

---

## 七、非目标范围

- **Web 端反向补齐**：MCP 已有直接工具但 Web 端暂无独立页面的能力（长期偏好管理页、全局搜索框、直接新建项目表单）不在本次范围内，可后续单独规划。
- **MCP 主动推流**：不新增 SSE/Webhook 推送给外部 MCP 客户端，继续使用按需拉取模式。
