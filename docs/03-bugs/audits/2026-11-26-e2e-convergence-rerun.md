# 2026-11-26 公开主线十二项缺陷修复与九组工作流隔离收敛复跑

基于[跨夜轨迹审计](2026-11-26-overnight-trajectories-audit.md)第六节确认的公开主线范围（P0：`B2`、`A2`、`A3`、`A1`、`B3`、`B4`；P1：`B6`、`B5`、`A6`、`A7`、`A8`、`B9`；`B1`/`B7` 保持现状），完成极简修复、自动化回归测试与新增[长周期多路并行夹具](../../02-workflows/fixtures/uc09.sh)，随后在 `bubblewrap` 只读挂载隔离容器（独立临时 `HOME`、剥离刷新令牌的临时 `CODEX_HOME`、独立端口、无 `docs/` 与 `test/` 的工作树快照、`gpt-6.2-sol · xhigh` + Headless Chrome CDP）中执行两轮 `uc01`–`uc09` 全轨迹与 `ng.db` 逐表核验，第二轮在零代码改动（快照与工作树逐字节一致）下 **9/9 全部收敛通过**。

---

## 一、十二项修复清单与回归测试入口

| 编号 | 级别 | 核心改动摘要 | 关键改动文件 | 新增/更新回归测试 |
| --- | :---: | --- | --- | --- |
| **B2** | P0 | `wait` 必填 `waitingFor`，移除 `endRun: "yielded_waiting"` 改为纯状态登记（`awaitsWakeup: true`）；精简 `wait` 与 `send_message` 描述，去除催促对自家子分身/`job_start` 调 `wait` 的话术；自然收尾文本复述 `send_message` 时按归一文本去重；硬闸门收尾宽限 `endRunGraceMs` 从 `10s` 放宽至 `45s`。 | `packages/loop/src/tools/comms.ts`、`packages/loop/src/cli/loop.ts`、`presets/src/shared/prompts.ts` | `packages/loop/test/cli.test.ts`（`B2: wait registers state...`）、`packages/loop/test/tools.test.ts`、`packages/cell/test/docs05-settle.test.ts` |
| **A2** | P0 | `inspect_cell` 将 `pull:<targetId>` 游标推进至已检视的高水位 `toSeq`（含中间省略 `head 20% + tail 80%` 或显式 `afterSeq > cursor`），并在结构化结果中返回 `resumeAfterSeq` 供继续翻看省略段，消除持续假未读。 | `packages/cell/src/inspect.ts`、`packages/loop/src/tools/cells.ts` | `presets/test/audit-2026-11-26-regressions.test.ts`（`A2:`） |
| **A3** | P0 | 冷恢复（`fresh` 且存在历史）若历史或摘要已覆盖首条任务则不再重复注入 `[original task]`；`update_project` 变更目标/目录/阶段后，后续锚点切换为最新 `[project goal]`；压缩摘要 `[references]` 严格限制为合法 ASCII 引用、过滤 `…` 截断残片、去重同 ID 裸引用与 `artifact://`，并按整条预算裁剪（Formal ID 优先）。 | `packages/context/src/summarize.ts`、`packages/context/src/hydrate.ts`、`packages/loop/src/cli/render.ts`、`packages/loop/src/cli/input.ts`、`packages/loop/src/cli/loop.ts` | `presets/test/audit-2026-11-26-regressions.test.ts`（`A3:`、`Round 1 E2E catches`）、`packages/loop/test/cli.test.ts`（`A3:`） |
| **A1** | P0 | `defaultCellsRoot` 检测 `dataDir` 是否处于宿主 Git 仓库或 `AGENTS.md`/`CLAUDE.md` 祖先目录内，若是则将未显式指定 `cwd` 的主台/信源默认工作目录隔离至 `<tmpdir>/ng-desk-cells/<hash>`（不触碰用户真实 `$HOME`），并统一经 `realpathSync` 规整软链路径。 | `packages/protocol/src/workdir-clean.ts`、`packages/cell/src/workdir.ts`、`packages/workspace/src/manager.ts` | `presets/test/audit-2026-11-26-regressions.test.ts`（`A1:`） |
| **B3** | P0 | CLI 回合将墙钟硬超时改为睡眠感知的**无进展空闲看门狗**（活跃工具调用/结果与文本进展持续续期）；若已产生真实步骤或回合后才无进展卡死，返回 `"timeout"` 触发内核 `kernel.continue(reason: "timeout")` 续接而非无标记释放重投旧批次。 | `packages/protocol/src/contract/loop.ts`、`packages/protocol/src/contract/payloads.ts`、`packages/loop/src/cli/loop.ts`、`packages/cell/src/dispatcher.ts`、`packages/context/src/render.ts`、`apps/gtd-desk/src/server/projections/agents.ts` | `packages/loop/test/cli.test.ts`（`B3:`）、`presets/test/audit-2026-11-26-regressions.test.ts`（`B3:`） |
| **B4** | P0 | `read_artifact` 内联单页上限提升至 `28,000` 字符（消除 12KB→4KB 溢出悬崖），支持 `offset`/`limit` 分页、`outline: true` 标题目录及 MCP `2025-06-18` `structuredContent` 版本元数据；`artifactConflict` 对 >8KB 长文稿只返回版本与标题大纲而非倾倒全文；提示词区分 2–3 步串行接力与 3+ 并行独立模块稿汇总，且仅在报告/对比/方案类交付时要求维护文稿。 | `packages/context/src/evidence.ts`、`packages/loop/src/tools/context.ts`、`packages/loop/src/cli/bridge.ts`、`packages/loop/src/cli/loop.ts`、`presets/src/shared/prompts.ts`、`presets/src/shared/skills.ts` | `presets/test/audit-2026-11-26-regressions.test.ts`（`B4 & A8-4:`）、`packages/loop/test/tools.test.ts` |
| **B6** | P1 | `job_start` 默认 `stdio: ["ignore", fd, fd]`（`stdin` 接 `/dev/null`），仅显式 `interactive: true` 时保留 `stdin` 管道，对非交互任务调用 `job_input` 明确报错。 | `packages/protocol/src/contract/workspace.ts`、`packages/workspace/src/jobs.ts`、`packages/loop/src/tools/workspace.ts` | `packages/workspace/test/audit-2026-11-26-jobs.test.ts`、`packages/workspace/test/jobs.test.ts` |
| **B5** | P1 | 后台任务静默检查读取整个进程组 `/proc` CPU ticks（`readGroupCpuTicks`），CPU 仍在推进的重定向编译/压测任务不误发 `job.warning`，且距 `timeoutMs` 不足 15s 时抑制冗余静默告警。 | `packages/protocol/src/process.ts`、`packages/workspace/src/jobs.ts`、`packages/loop/src/tools/workspace.ts` | `packages/workspace/test/audit-2026-11-26-jobs.test.ts` |
| **A6** | P1 | `update_cell` 开放父协调器更新子分身 `cwd`（并同步 `workspaces.path`），`update_project` 切换 `cwd` 时提示同步迁移在途可复用分身；提示词补充并发只读检查使用 `GIT_OPTIONAL_LOCKS=0`。 | `packages/loop/src/tools/cells.ts`、`packages/cell/src/lifecycle.ts`、`presets/src/project/toolset.ts`、`presets/src/shared/prompts.ts` | `presets/test/audit-2026-11-26-regressions.test.ts`（`A6 & A7:`、`Round 1 E2E catches`） |
| **A7** | P1 | 叶节点（`worker`/`checker`/`sensor`）均固定 `maxDepth: 0`，`describeBounds` 输出 `"Children: none (leaf cell)."`；`listSkills(cellId)` 按角色标签过滤内置技能（保留用户自定义全局技能）；分身执行仓库内置 MR 技能时跳过 CI 轮询交由项目探针跟进。 | `packages/protocol/src/bounds.ts`、`packages/context/src/knowledge.ts`、`packages/context/src/hydrate.ts`、`presets/src/cron-sensor/preset.ts`、`presets/src/shared/prompts.ts` | `presets/test/audit-2026-11-26-regressions.test.ts`（`A6 & A7:`、`Round 1 E2E catches`） |
| **A8** | P1 | ① 同项目分身只读 `job_observe` 互通，`job_input`/`job_cancel` 越权给出清晰归属错误；② 全局搜索与内核/外部 `read_resource` 支持直读 `working_note://<cellId>/<name>` 与 `reference://<cellId>/<name>`；③ `read_state` 列表默认隐藏 `cli:`/`pull:`/`sys:`/`cell:` 内部键；④ MCP 桥透传 `structuredContent`；⑤ 叶分身唤醒时回注自存 `[your notes]`。 | `packages/cell/src/ports.ts`、`packages/workspace/src/port.ts`、`packages/context/src/search.ts`、`packages/context/src/store.ts`、`packages/loop/src/tools/context.ts`、`packages/cell/src/readmodel.ts`、`apps/gtd-desk/src/server/agents.ts` | `presets/test/audit-2026-11-26-regressions.test.ts`（`A8:`）、`apps/gtd-desk/test/agent-relay.test.ts` |
| **B9** | P1 | ① 新建定时 LLM 信源不派发空启动回合，配置写入 `evidence` `[source setup]` 待首次触发再运行；② `probe` 结项摘要使用探针标题而非倾倒脚本源码，同项目重复派发活跃 `checker` 时给出提示；③ 状态摘要按词边界截断、节点关闭同步标记 `workspaces.status = 'closed'`、非叶节点回合结算归零 `cell:direct_chat.unsettled`、叶节点休眠顺带结清自取消任务遗留的到期 `silent_inject` `job.result`。 | `presets/src/cron-sensor/preset.ts`、`presets/src/inline-desk/toolset.ts`、`apps/gtd-desk/src/server/desk.ts`、`presets/src/shared/probe.ts`、`presets/src/project/toolset.ts`、`packages/loop/src/tools/util.ts`、`packages/workspace/src/store.ts`、`packages/cell/src/lifecycle.ts`、`packages/cell/src/dispatcher.ts` | `presets/test/audit-2026-11-26-regressions.test.ts`（`B9:`）、`apps/gtd-desk/test/server.test.ts`、`packages/cell/test/lifecycle.test.ts`、`presets/test/probe.test.ts` |

---

## 二、极简原则校验：提示词与工具描述改动前后对比

通过内核机制与角色过滤替代规则堆砌，**全部 6 个角色的最终可见系统提示词（`system.text`）以及「系统提示词 + 工具 Schema/描述」总可见字符数均比改前严格缩短**（其中 `sensor` 系统提示词缩减 **38.9%**）：

### 1. 各角色最终组装 `system.text` 与工具总可见长度对比

| 角色 | 改前 `systemChars` (`Bytes`) | 改后 `systemChars` (`Bytes`) | `system` 变化 | 改前 `toolDescChars` | 改后 `toolDescChars` | 改前总可见字符 | 改后总可见字符 | 总可见变化 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `desk` | 22,675 (23,295 B) | **22,145** (22,753 B) | **-530 (-2.3%)** | 14,438 | **14,236** | 65,318 | **65,175** | **-143** |
| `project` | 33,806 (35,479 B) | **32,253** (33,899 B) | **-1,553 (-4.6%)** | 13,801 | **13,651** | 72,837 | **71,723** | **-1,114** |
| `worker` | 14,936 (15,288 B) | **13,670** (14,008 B) | **-1,266 (-8.5%)** | 8,449 | **8,299** | 36,135 | **35,308** | **-827** |
| `checker` | 8,766 (8,986 B) | **7,489** (7,691 B) | **-1,277 (-14.6%)** | 8,449 | **8,299** | 29,965 | **29,127** | **-838** |
| `sensor` | 3,374 (3,406 B) | **2,061** (2,075 B) | **-1,313 (-38.9%)** | 4,801 | 4,975 | 12,675 | **11,975** | **-700** |
| `hub` | 13,212 (14,026 B) | **12,222** (13,024 B) | **-990 (-7.5%)** | 11,627 | **11,477** | 42,602 | **42,051** | **-551** |

### 2. 原始角色模板与内置技能正文长度对比

| 模板 / 内置技能 | 改前字符数 (`Bytes`) | 改后字符数 (`Bytes`) | 变化 |
| --- | ---: | ---: | ---: |
| `gtd.desk` | 21,337 (21,941 B) | **21,320** (21,922 B) | **-17 (-19 B)** |
| `gtd.project` | 24,307 (25,220 B) | **23,856** (24,767 B) | **-451 (-453 B)** |
| `gtd.worker` | 13,609 (13,945 B) | **13,573** (13,911 B) | **-36 (-34 B)** |
| `gtd.checker` | 7,439 (7,643 B) | **7,392** (7,594 B) | **-47 (-49 B)** |
| `gtd.hub` | 9,016 (9,304 B) | **8,969** (9,255 B) | **-47 (-49 B)** |
| `gtd.sensor` | 2,047 (2,063 B) | **1,964** (1,978 B) | **-83 (-85 B)** |
| `project-relay` | 8,388 (9,137 B) | **8,226** (8,961 B) | **-162 (-176 B)** |
| `domain-hub` | 3,085 (3,601 B) | **3,085** (3,601 B) | 0 |
| `workspace-arbitration` | 6,889 (7,635 B) | **6,889** (7,635 B) | 0 |
| `habit-and-routine-discovery` | 2,314 (2,412 B) | **2,314** (2,412 B) | 0 |

---

## 三、自动化验证与两轮 `uc01`–`uc09` 隔离端到端收敛记录

### 1. 全仓自动化构建与测试结果

- `pnpm typecheck`：10/10 工作区包全部零错误通过。
- `pnpm test`：97 个活跃测试文件全部通过（`1,103 passed | 4 skipped`，0 失败）。
- `pnpm build`：`@ng/gtd-desk` 前端产物构建通过。

### 2. 第一轮隔离实测发现并闭环修复的新问题

第一轮在 9 个独立 `bubblewrap` 容器中跑完 `uc01`–`uc09` 并通读全部 85+ 份原始 rollout JSONL 与 `ng.db` 后，核心修复项（`B2` 自然收尾与零 `<turn_aborted>`、`A1` 宿主隔离、`A2` 高水位游标、`B3` 看门狗、`B4` 28KB 分页与冲突大纲、`B5`/`B6` 静默 CPU 任务与 `/dev/null` stdin、`A6` worktree 迁移）全部生效，同时从原始轨迹和表状态中抓出以下边界问题并补齐修复与单测：

1. **项目重开二次结项主台活动去重碰撞（`UC08` · `INV-UC08-05`）**：`presets/src/inline-desk/items.ts` 原按 `earlier.detail === p.summary` 判断是否为首次结项，导致重开后再次通过 `set_project_state("complete")` 合成结项（或摘要相同）时吞掉第二次 `done-*` 活动记录；且外部主代理在 `decide_human_item(optionId: "done")` 后立即追加调用 `set_project_state("complete")` 会中断项目自身的 `finish_project` 收尾回合。修复后按 `resultId` 去重、合成结项优先取 `project.summary`，并在 `decide_human_item("done")` 返回提示项目已唤醒自行收尾。
2. **外部/Web 控制面 `read_resource` 未解析跨节点笔记 URI（`UC04` · `A8-2` / `INV-SYS-19`）**：内核 `readResourceSync` 已支持 `working_note://<cellId>/<name>`，但 `apps/gtd-desk/src/server/agents.ts` 前置校验仍要求显式传 `cellId`。修复后省略 `cellId` 时直接从 URI 提取所属节点 ID。
3. **跨延续 `Run` 的在途追问漏保留前段 `report_to_parent` 至 `saidBefore`（`UC06` · `INV-SYS-18`）**：分身在 `Run 1` 调用 `report_to_parent(kind="result")` 时恰逢在途 `SPOKEN` 追问触发排空守卫进入 `Run 2`，`notifySettled` 在 `run_boundary(start)` 清空了前段汇报。修复后仅在非对话延续（如 `job.result`/`timer.fired`）丢弃前段文字，对话延续完整保留至 `saidBefore`。
4. **压缩引用正则误提取省略号截断片段（`UC09` · `A3` / `INV-UC09-04`）**：内联摘要被 `…` 截断在 ULID 中间（如 `art_01m8bjqn7200003j…`）时，JS `\b` 将 `…` 视为词边界导致提取出残片。在 `REF_PATTERN` 增加 `(?!…|\.\.\.)` 否定前瞻并去重同 ID 的 `artifact://` 与裸 `art_*`。
5. **体验与元数据细节打磨（`UC01`/`UC02`/`UC03`/`UC05`/`UC07`）**：`sensorPreset` 补齐 `requestBounds: () => ({ maxDepth: 0 })`；`projectPromptText` §1 将文稿维护明确限定于报告/对比/方案类交付（消除纯代码 MR 接力的冗余文稿调用）；`updateCell({ cwd })` 即时同步 `workspaces.path`；`[your timers that have not fired yet]` 回显 `envelopeId`；`list_human_items` 展示人工动作项的 `optionId`。

### 3. 第二轮隔离实测结果（冻结快照零代码改动 · 9/9 全绿收敛）

基于逐字节一致的只读快照重新创建 `uc01`–`uc09` 全部 9 组隔离容器并完整跑通：

| 用例 | 第二轮结论 | 关键核验数据（原始轨迹 + `ng.db`） |
| --- | :---: | --- |
| **UC01** 收集、回复与信源 | **PASS** | 11 份轨迹 **0** 工具报错；2 个新建定时 LLM 信源启动运行数均为 `0`（仅到点运行），3 个 `sensor` 均确认 `maxDepth: 0` 与 `"Children: none (leaf cell)."`（前缀 2,165 字符）；草稿乐观锁、关闭分身检索与图片幂等全部通过。 |
| **UC02** 代码交付与接力 | **PASS** | 全 5 幕（含独立终审检出跨 Node 版本 SGR 冒号序列边界 → 唤醒原待命分身修补 → 唤醒原终审复核的三腿接力 + 维护者提前合入自动撤卡结项）**0** 工具报错、**0** 冗余文稿（协调器输入 token 较首轮再降 32.2%）、4 条 `pull:*` 游标 100% 追平、2 个零 token 脚本探针摘要无源码泄露。 |
| **UC03** 人机分工与改稿 | **PASS** | 21/21 次 `read_artifact`（含 14.5KB 正文直读）**0** `res://` 溢出并带 `structuredContent`；9.4KB 并发冲突返回 652 字符章节大纲、停放稿生成并在重做保存 `v5` 后自动收回；Headless Chrome CDP 验证全部视图、脏方案拦截与视图切换回顶；`list_human_items` 一步取消人工步骤零源码探查。 |
| **UC04** 停靠调研与重唤醒 | **PASS** | 外部 MCP 与 Web `GET /api/resources` 不传 `cellId` 直读 `working_note://<projId>/board` 返回 HTTP 200；停靠期间后台 0 运行，Headless Chrome CDP 验证 `已停靠` 与 `已暂停` 徽标及报告抽屉；冷恢复 `origTask=0, projGoal=1`。 |
| **UC05** 工作区并发与仲裁 | **PASS** | 完整覆盖主台单 fixer 仲裁、合入后 `quiet: true`（`silent_inject`）静默回注、脏主工作树保护卡、同仓双项目 worktree 隔离；`update_cell({ cwd })` 即时同步 `workspaces.path`；14 份轨迹 470 次 `GIT_OPTIONAL_LOCKS=0` 零锁冲突、30 回合 0 冗余 `wait()`、0 `<turn_aborted>`。 |
| **UC06** 领域中枢与直接消息流 | **PASS** | 120s 合并窗口严格锚定首条到达时间；`handback` 保留原始发送者与消息头；在途追问吸收结算同时完整保留 584 字符前段主评审报告至 `saidBefore`；中枢与项目技能严格按角色隔离；26/26 收件箱消息结清，0 次 `wait()`。 |
| **UC07** 外部主代理与过夜托管 | **PASS** | 双终端会话隔离、后台节点 `NG_WORKBENCH_CELL_ID` 权限阻断、待触发定时器凭 `envelopeId` 一步取消；`soak.sh` 运行中 `kill -9` 服务停机 15s 重连不重跑、双节点并发回合 `kill -9` 收割孤儿 CLI 并单次重投；90s LLM 回合冻结与 100s 后台任务冻结（总墙钟 149s > 120s 时限，扣除 `standstillMs=99028`）+ `/dev/null` stdin EOF 全部通过。 |
| **UC08** 直连分身与拉取同步 | **PASS** | 分身跨重开全程复用同一原生会话（6 个回合），休眠插话诚实提示、运行中插话即时打断、运行中顺手补充回合末吸收；重开二次结项后主台落盘两条独立 `done-*` 完成记录，全流程 0 取消回合、`pull:*` `240/240`、`unsettled=0`。 |
| **UC09** 长周期多路并行与冷恢复 | **PASS** | `NG_DESK_DATA_DIR` 置于带 `ORACLE-LEDGER-991` `AGENTS.md` 的软链宿主仓内，全部 11 份轨迹与 6 份 `prompt_prefixes` **0** 宿主污染；3 路并行分身 + 315s 静默高 CPU 压测（**0** `job.warning`）+ `verify_manifest.py` 默认 `/dev/null` stdin（64ms 退出 0）+ 23.6KB 主报告分页合成 + worktree 迁移复用分身 + `/ship-mr` 跳过轮询脚本 + 真实内核压缩（`[references]` 7 条精确引用零 `…` 残片、零重复）全部一次通过。 |

### 4. 残留的非阻塞极小边角说明

以下观察项均不影响功能正确性、数据一致性或用户体验，按做减法原则不引入额外特例：

1. **内核 `read_artifact({ cellId: projectId })` 列表仅按直接创建者过滤**：当主台在节点内不带 `artifactId` 列举某项目文稿时，子分身名下创建的文稿需经 `search_history` 或项目状态发现（外部控制面 `get_project` 已聚合整棵子树文稿）。
2. **`present_to_owner` 普通回复卡转立项的内部 `gtd:project.source.label`**：`propose_project` 立项卡带有 `cardType` 判别字段故可继承原始信源标签，而 `present_to_owner` 卡片未设 `cardType`，内部记录字段记为 `"系统"`（对外 `ProjectRowDTO` 不展示该内部字段，且项目简报与 `cell.task` 正文已完整携带信源出处与主人原话分离标注）。
3. **非阻塞只读调研分身的 CLI 沙箱参数**：`research_then_park` 调研分身复用通用 `worker` 预设，由提示词契约约束只读（两轮实测均未触碰任何仓库文件）；若未来需在 OS 层强制只读，可在 `dispatch` 上按需扩展可选只读参数。
