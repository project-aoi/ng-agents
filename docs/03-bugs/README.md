# 缺陷与回归台账

以下条目已在 v1 工作区修复。按入口运行回归即可重新触发原始条件。

| 编号 | 范围 | 已验证行为 | 回归入口 |
| --- | --- | --- | --- |
| C1、C5、S3 | 跨节点知识写入和人工事项隔离 | 分身写共享偏好或全局引用会被拒绝；同主题的不同节点各自处理自己的卡。 | [authorize.test.ts](../../packages/gate/test/authorize.test.ts)、[tools.test.ts](../../packages/loop/test/tools.test.ts)、[human-items.test.ts](../../packages/cell/test/human-items.test.ts) |
| C2 | 暂停与祖先检查 | 经收件箱直接暂停项目，中止后代运行及后台任务。暂停祖先下无法派生、认领或路由工作。 | [lifecycle.test.ts](../../packages/cell/test/lifecycle.test.ts)、[routing.test.ts](../../packages/cell/test/routing.test.ts) |
| C6、B12 | 立项与人工动作 | 立项含人工步骤时原子生成关联项目的待办；完成的个人提醒仍可在周回顾查到。 | [sources-and-quick-items.test.ts](../../presets/test/sources-and-quick-items.test.ts)、[projections.test.ts](../../apps/gtd-desk/test/projections.test.ts)、[conventions.test.ts](../../presets/test/conventions.test.ts) |
| C8、B3、C9 | 回合结算与答复归属 | 拒答处理已消费的等待，旧回合结果不清新等待。抄送、自查与指向别项的答复不会误清。 | [docs05-settle.test.ts](../../packages/cell/test/docs05-settle.test.ts)、[docs05-anchors.test.ts](../../packages/cell/test/docs05-anchors.test.ts) |
| B2、S5 | 停滞与计时 | 停靠节点退出巡检，相同原因按等待登记隔离，解决后可再次升级。时钟回拨重设实际唤醒。 | [docs05-anchors.test.ts](../../packages/cell/test/docs05-anchors.test.ts)、[schedule.test.ts](../../packages/inbox/test/schedule.test.ts) |
| B11、B13 | 撤销与重复直连 | 撤销时检查发起节点是否可恢复，必要时发更正。关闭后重试已送达的直连保持幂等。 | [human-items.test.ts](../../packages/cell/test/human-items.test.ts)、[wakeable.test.ts](../../packages/cell/test/wakeable.test.ts)、[agent.test.ts](../../apps/gtd-desk/test/agent.test.ts) |
| C7、B4、B5、B6 | 命令行输入与证据游标 | 终止工具执行后未确认的输入返回队列；下一回合实际收到追加消息才确认。拒答可推进已消费输入的游标。 | [cli-followup.test.ts](../../packages/loop/test/cli-followup.test.ts)、[cli.test.ts](../../packages/loop/test/cli.test.ts)、[phase0.test.ts](../../packages/cell/test/phase0.test.ts) |
| B7、B8、S4、S6 | 压缩、前缀与重新启动 | 结构化任务、引用和最新摘要保留；会话分叉核对父前缀与目录，重建保留笔记和子节点名单。 | [hydrate.test.ts](../../packages/context/test/hydrate.test.ts)、[cli-followup.test.ts](../../packages/loop/test/cli-followup.test.ts) |
| B9、B10 | 进程与后台任务 | 按实例和进程身份处理残留；核实整个进程组退出后结算，回收期间禁止重复启动。 | [cli-orphans.test.ts](../../packages/loop/test/cli-orphans.test.ts)、[jobs.test.ts](../../packages/workspace/test/jobs.test.ts) |
| B15 | 脚本信源 | 运行真实临时脚本读取触发信封；沿用同一信封重试时，观察与计数只写入一次。 | [api.test.ts](../../apps/gtd-desk/test/api.test.ts)、[script-sensor.test.ts](../../presets/test/script-sensor.test.ts)、[sources-and-quick-items.test.ts](../../presets/test/sources-and-quick-items.test.ts) |
| C10、B16 | 工作台焦点、版本与实时状态 | 收到新卡时保留正在填写的内容。冲突后用远端最新版核对；撤销和重开返回最新状态，并通知订阅视图。 | [human-inbox-browser.test.ts](../../apps/gtd-desk/test/human-inbox-browser.test.ts)、[api.test.ts](../../apps/gtd-desk/test/api.test.ts)、[server.test.ts](../../apps/gtd-desk/test/server.test.ts) |
| 列表切换跳顶 | 工作台滚动与导航 | 待办鼠标切换和 n 键仅就近显示选中行；视图切换回顶，深链接及前后退保留选择。项目动作展开和分身树窗格滚动不回归。 | [scroll-desk.ts](../../apps/gtd-desk/test/fixtures/scroll-desk.ts) |
| 探针排空 | 一次性结算 | 失败报告在第二个回合重新绑定，父项目只收到一次失败和原始检查结果。 | [probe.test.ts](../../presets/test/probe.test.ts) |
| 主人与助手 | 本机身份 | 不设凭据。`/api/*` 记录为主人，`/api/agent/*` 记录为 `agent:local`，两者权限相同。Host 与跨站检查拦截网页来源的请求。 | [agent.test.ts](../../apps/gtd-desk/test/agent.test.ts)、[agent-parity.test.ts](../../apps/gtd-desk/test/agent-parity.test.ts)、[server.test.ts](../../apps/gtd-desk/test/server.test.ts) |
| 信源与内部定时 | 批量与失败恢复 | 每个脚本触发独立结算。内部提醒失败后退避重试；无需唤醒模型。 | [api.test.ts](../../apps/gtd-desk/test/api.test.ts)、[human-items.test.ts](../../packages/cell/test/human-items.test.ts) |
| 分身与文稿归属 | 项目协作 | 同项目可接力编辑，无关项目写入和非发起节点修改待批方案会被拒绝。 | [human-items.test.ts](../../packages/cell/test/human-items.test.ts)、[scenario-human-step.test.ts](../../presets/test/scenario-human-step.test.ts) |
| 仲裁与暂停 | 自查结算 | 自身停靠后不产生新卡。已有仲裁持有相同等待时，项目自查等待该次仲裁结算。 | [docs05-anchors.test.ts](../../packages/cell/test/docs05-anchors.test.ts) |
| 纠偏与回收 | 进程和会话 | 旧工具调用返回时只确认原回合。进程身份未知时保留登记，恢复后台任务时等待同组进程退出。 | [cli.test.ts](../../packages/loop/test/cli.test.ts)、[cli-orphans.test.ts](../../packages/loop/test/cli-orphans.test.ts)、[jobs.test.ts](../../packages/workspace/test/jobs.test.ts) |

[2026-11-22 复核](audits/2026-11-22-repository-audit.md)

[2026-11-23 八组工作流实机核对](audits/2026-11-23-codex-e2e-workflows.md)：列出 E01–E40，其中 13 项高优先级。同日全部修复，逐项的改动和回归入口见报告末尾的“修复记录”。自动回归通过；提示词和工具文字的改动尚未用真实命令行复跑八组工作流。

[2026-11-23 八组工作流复跑](audits/2026-11-23-codex-e2e-rerun.md)：在修复后的 `1a2aea9` 上用 Codex 重跑八组，逐个读会话轨迹，列出 R01–R11、M01–M21、L01–L07。11 月 24 日全部修复，并用真实命令行又跑了十轮八组，直到第十轮八组都没有再发现产品缺陷；复跑中新发现的问题一并修复，遗留的模型失误和没有走到的路径列在报告的“遗留”一节。逐项改动、回归入口和实机结论见报告末尾的“修复记录”。

| 编号 | 范围 | 已验证行为 | 回归入口 |
| --- | --- | --- | --- |
| E01 | 后台与主人控制面 | 后台命令行进程带节点标记，接入套件在其中只给一个说明用的占位工具；Codex 后台进程关闭 `ng-desk` 插件。 | [adapters.test.ts](../../packages/loop/test/adapters.test.ts)、[cli.test.ts](../../packages/loop/test/cli.test.ts)、[agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts) |
| E02、E08、E26、E35、E40 | 外部助手转述 | 提问标明是给主人的；主人原话与助手补充分开传递并在下游标注；总览列出未答提问；批准备注送达项目；每个接入会话有自己的会话编号。 | [agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts)、[render.test.ts](../../packages/context/test/render.test.ts)、[human-items.test.ts](../../packages/cell/test/human-items.test.ts) |
| E03、E04 | 停滞误报 | 自己在等主人且有开放事项的项目能答复下级；主台收件箱里有关联修复分身的结果时，等待它的项目不算停滞。停滞说明写出实际悬空的等待。 | [docs05-anchors.test.ts](../../packages/cell/test/docs05-anchors.test.ts) |
| E05、E06 | 暂停与恢复 | 暂停留下谁、何时、原话，花名册和 inspect_cell 可见；恢复后协调器先运行，早于暂停的指令重投时注明。 | [pause-record.test.ts](../../packages/cell/test/pause-record.test.ts)、[tools.test.ts](../../presets/test/tools.test.ts) |
| E07、E13、E17 | 卡片与信源 | 卡片可绑定文稿版本并始终可请修改；节点可撤回自己的未决卡，立项可接手一张卡；内容不变的命中在恢复前只报一次并带出处；方案可改阶段。 | [human-items.test.ts](../../packages/cell/test/human-items.test.ts)、[tools.test.ts](../../presets/test/tools.test.ts)、[script-sensor.test.ts](../../presets/test/script-sensor.test.ts)、[tools.test.ts](../../packages/loop/test/tools.test.ts) |
| E09、E11、E15、E33 | 命令行回合 | 结束工具之后同一回合的话保留；无法续接父会话的分叉节点用自己的角色提示词；续接会话不重发最初任务；会话在首次进展时登记。 | [cli.test.ts](../../packages/loop/test/cli.test.ts)、[hydrate.test.ts](../../packages/context/test/hydrate.test.ts) |
| E10、E14、E36 | 回合附注 | 附注在簿记之后读取；同一分身承担的动作全部关闭并列出；已答复的等待不再显示为开放；父节点的等待和上级协调器不出现在分身的附注里。 | [wake-notes.test.ts](../../presets/test/wake-notes.test.ts)、[wakeable.test.ts](../../packages/cell/test/wakeable.test.ts) |
| E19、E24、E27 | 控制面读取 | 可读观察笔记和最近命中；服务器说明缩到一千字符以内；总览列出 hub 和主台直属分身。 | [agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts) |
| E22、E23、E30 | 上下文 | inspect_cell 的完整视图不再被截到 3,000 字符；检索排除当前回合和检索调用自身；作者再次保存成功后清掉自己的停放稿。 | [evidence.test.ts](../../packages/context/test/evidence.test.ts)、[search.test.ts](../../packages/context/test/search.test.ts)、[artifacts.test.ts](../../packages/context/test/artifacts.test.ts) |
| E18、E28、E29、E31、E34 | 预设工具 | 立项简报不重复附原话；审批选项去掉必然报错的 `complete`；完成通知按边界截断，正常结项不再空唤醒主台；对停靠项目说话只送达一次；停靠说明与实际一致。 | [tools.test.ts](../../presets/test/tools.test.ts)、[tools.test.ts](../../packages/loop/test/tools.test.ts) |
| E32 | 后台任务 | 静默告警不计宿主冻结的时段。 | [jobs.test.ts](../../packages/workspace/test/jobs.test.ts) |
| E12、E16、E20、E21、E25、E37–E39 | 提示词与技能 | 仲裁收尾、验收事项、查阅范围、任务大小、技能触发、面向主人的措辞。内置技能未被主人改过时随版本更新。 | [conventions.test.ts](../../presets/test/conventions.test.ts)、[tools.test.ts](../../presets/test/tools.test.ts) |

| 编号 | 范围 | 已验证行为 | 回归入口 |
| --- | --- | --- | --- |
| R01、R03 | 停靠、恢复与重开 | 停靠记录对外部助手可见；恢复写实际操作者，主人的话单独引用；恢复后的第一个回合有实时附注，主人本人恢复才算继续指令；重开带主人的话。 | [audit-rerun.test.ts](../../packages/cell/test/audit-rerun.test.ts)、[agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts)、[projects.test.ts](../../apps/gtd-desk/test/projects.test.ts) |
| R02、M17 | 停滞与花名册 | 等待的协调器有回合在途或有未读消息时不判停滞；答复已在收件箱里的等待不显示为还在等。 | [audit-rerun.test.ts](../../packages/cell/test/audit-rerun.test.ts)、[docs05-anchors.test.ts](../../packages/cell/test/docs05-anchors.test.ts) |
| R04 | 信源 | 观察转正式不吞掉仍在的故障；命中先出一张卡，同一信源一张开放卡；命中不标成主人的话。 | [agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts)、[tools.test.ts](../../presets/test/tools.test.ts)、[conventions.test.ts](../../presets/test/conventions.test.ts) |
| R05、M01、L04、L06 | 回合附注 | 主人改文稿的提示到达项目和主台；首回合不重复任务；同目录占用不列协调器；重投的消息有标注。 | [audit-rerun.test.ts](../../packages/cell/test/audit-rerun.test.ts)、[hydrate.test.ts](../../packages/context/test/hydrate.test.ts)、[render.test.ts](../../packages/context/test/render.test.ts) |
| R06、R10、L01、L03、L05 | 外部助手读到的内容 | 等主人的最后一句算提问；hub 下列出分身结论和专题；项目发给主人的通知、停靠记录、工作台地址可见；状态文字为中文。 | [agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts)、[agent.test.ts](../../apps/gtd-desk/test/agent.test.ts) |
| R07、R08、M18 | 简报与方案 | 助手补充单列；简报标明转述人；方案卡显示当前方案并列出待拍板段落，`save_plan` 报告去掉的段落；`update_project` 可改方案。 | [tools.test.ts](../../presets/test/tools.test.ts)、[agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts) |
| R09、M13、M16 | 主人的决定落在事项上 | `settle_item` 按主人的话结清；冲突写出当前版本；主台转达主人的话可结清等待；分身途中提过问时不代关动作；主台自行撤回的卡进活动记录。 | [audit-rerun.test.ts](../../packages/cell/test/audit-rerun.test.ts)、[tools.test.ts](../../packages/loop/test/tools.test.ts)、[tools.test.ts](../../presets/test/tools.test.ts)、[agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts) |
| M02 | 后台任务 | 时限只计运行时间，结果写明停转时长。 | [jobs.test.ts](../../packages/workspace/test/jobs.test.ts) |
| M07 | 检索 | 摘录落在命中处并带偏移。 | [text.test.ts](../../packages/context/test/text.test.ts)、[search.test.ts](../../packages/context/test/search.test.ts) |
| M09、M10 | 插话与等待答复 | 没有打断时如实说明；主台仍在处理时不把途中话当答复。 | [agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts)、[agents.test.ts](../../apps/gtd-desk/test/agents.test.ts) |
| M14、M15 | 通知与结束回合 | 完成通知一份，在真正结清时发出；没人对话的回合里结束工具之后的复述不记录。 | [tools.test.ts](../../presets/test/tools.test.ts)、[cli.test.ts](../../packages/loop/test/cli.test.ts)、[audit-rerun.test.ts](../../packages/cell/test/audit-rerun.test.ts) |
| R11、M03–M06、M08、M11、M12、M19–M21、L02、L07 | 提示词与技能 | 交付清单、带选项的卡、检查脚本、默认提醒时间、定稿、修复位置、对外动作确认、不自行加规矩、先报告做不了的事、先找查平台的命令、专题走 capture。 | [conventions.test.ts](../../presets/test/conventions.test.ts)、[agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts) |
| 复跑中新发现 | 对外显示与转达 | 网页待我处理列出并计入节点用话提的问题；对外只显示还没答复的等待；卡片来源只引用人说的话；停靠回执列出还在等主人的事项；项目全局显示停靠记录；插话行写明来自谁；直连消息默认不唤醒项目；周回顾统计主人改过的草稿；时间线区分新卡与更新。 | [agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts)（“live rerun round 3”）、[audit-rerun.test.ts](../../packages/cell/test/audit-rerun.test.ts)（“rerun round 3”）、[tools.test.ts](../../presets/test/tools.test.ts)、[tools.test.ts](../../packages/loop/test/tools.test.ts)、[contract-helpers.test.ts](../../packages/protocol/test/contract-helpers.test.ts)、[dispatch.test.ts](../../packages/cell/test/dispatch.test.ts) |
| 清理 | 结清、转达与计数 | `settle_item` 与卡片决定同一路径（版本核对、留言、撤销）；转达主人的话核对来源；总览不写状态，按每轮实际收到的消息判断主台的话是否由人引出；撤销的更正不算主人说话；已停靠节点的提问不计数；时间线写对没有收尾的原因。 | [audit-rerun.test.ts](../../packages/cell/test/audit-rerun.test.ts)、[agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts)、[projects.test.ts](../../apps/gtd-desk/test/projects.test.ts) |

## 专项记录

| 时间 | 复现与回归 |
| --- | --- |
| 11 月 18 日 | [宿主运行](BUG-20261118-runtime.md)、[执行与探针](BUG-20261118-execution.md)、[上下文与提示词](BUG-20261118-context-and-prompt.md)、[工作台与控制面](BUG-20261118-ui-and-control.md)、[实机记录](audits/2026-11-18-traex-live-e2e.md) |
| 11 月 19 日 | [人工事项与协调](BUG-20261119-cards-and-coordination.md) |
| 11 月 21 日 | [上下文可见性](BUG-20261121-context-and-visibility.md)、[生命周期与恢复](BUG-20261121-lifecycle-and-resilience.md)、[状态归属与控制](BUG-20261121-orthogonality-and-control.md) |
| 2026-11-23 | 随手记图片：新增本地图片/短URI链路，覆盖格式与180 KiB边界、clientId、移除晚回执、持久回看及原生JSON字段完整性；真实TRAE剪贴板和最终原生产物由后续验收。入口：[capture-assets.test.ts](../../apps/gtd-desk/test/capture-assets.test.ts)、[capture-panel-browser.test.tsx](../../apps/gtd-desk/test/capture-panel-browser.test.tsx)、[capture-image-api.test.ts](../../apps/gtd-desk/test/capture-image-api.test.ts)。 |
| 2026-11-23 | 随手记图片独立浏览器发现响应丢失后编辑假成功、Viewer继承缩略图高度及关闭丢焦点，隔离存储发现目录替换竞态。修复以提交快照/实际持久内容校验、独立Viewer尺寸和卸载后焦点恢复为准；目录I/O前后按fd的inode/dev校验，检测到替换即拒绝，不能承诺隔离同用户完整写权限进程。回归：[capture-assets.test.ts](../../apps/gtd-desk/test/capture-assets.test.ts)、[capture-panel-browser.test.tsx](../../apps/gtd-desk/test/capture-panel-browser.test.tsx)；真实浏览器同场景由独立复验确认。 |
| 2026-11-26 | 跨夜长跑轨迹审计公开主线十二项修复与九组工作流（`uc01`–`uc09`）隔离收敛复跑：移除 `wait` 的 `endRun` 回归自然收尾并放宽闸门宽限至 45s（B2）；`inspect_cell` 拉取游标对齐高水位 `toSeq`（A2）；冷恢复去重 `[original task]`、锚定更新后的 `[project goal]` 并过滤压缩引用残片（A3）；主台/信源默认目录隔离于宿主 Git/`AGENTS.md` 树外并经 `realpath` 规整（A1）；CLI 睡眠感知无进展看门狗续接（B3）；`read_artifact` 28KB 分页/目录/结构化版本与长文稿冲突大纲（B4）；`job_start` 默认 `/dev/null` stdin 与进程组 CPU 静默判活（B6、B5）；`update_cell({ cwd })` 同步工作树、内置技能按角色过滤、同项目只读 `job_observe`、跨节点笔记直读、叶节点 `working_note` 回注与信源零空转启动（A6–A8、B9）。实机记录：[收敛复跑报告](audits/2026-11-26-e2e-convergence-rerun.md)；回归：[audit-2026-11-26-regressions.test.ts](../../presets/test/audit-2026-11-26-regressions.test.ts)、[audit-2026-11-26-jobs.test.ts](../../packages/workspace/test/audit-2026-11-26-jobs.test.ts)、[cli.test.ts](../../packages/loop/test/cli.test.ts)、[agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts)。 |
| 2026-11-27 | 轨迹审计主线七项可靠性与存储修复（M1–M7）及提示词/内置技能瘦身重构：失败回合已执行写副作用时禁止整批盲目重投，改为确认原批并投递带已执行写摘要的紧凑 `error_recovery`；重试 `inbound` 按 `envelope_id` 去重、过滤已关闭发送方的非终态消息、死信/升级卡剥离 ANSI 转义符（M1）；Radar/Topology 区分阻塞卡片 `blockingProjectIds` 与知会 `relatedProjectIds`，批处理 `request_approval` 按绑定文稿或显式 `sourceCellId` 归因来源（M2、M3）；数据库迁移 v1→v2 退出大日志 `resource_fts` 与 `tool_result` 全量 trigram 索引并保留按需检索，自动裁剪未被引用的文稿中间草稿（M4）；纯 `code` 处理器跳过 `context.hydrate()`，`gtd.check_probe` 增加父项目等待决定自动挂起与结卡即醒、长时退避、同输出原地更新计数不刷证据，并新增 `update_check` 原地改探针目标（M5）；非待命叶节点纯文本答复父提问时自动孤儿答复抄送，`stalled_check` 识别指向开放卡片的 `refId`（M6）；结构化摘要保留目标/关键路径与近期进展、已结项 `arb:*` 状态自动归档、支持 `update_cell({ resetSession: true })` 及连续压缩自动滚换超长原生会话（M7）；按“现实优先、相称性、循环感知与升维、信任原生事实”四条元原则瘦身角色提示词与内置技能并修正仲裁规则。回归：[audit-2026-11-27-regressions.test.ts](../../presets/test/audit-2026-11-27-regressions.test.ts)、[schema.test.ts](../../packages/protocol/test/schema.test.ts)、[projections.test.ts](../../apps/gtd-desk/test/projections.test.ts)、[hydrate.test.ts](../../packages/context/test/hydrate.test.ts)、[cli.test.ts](../../packages/loop/test/cli.test.ts)、[conventions.test.ts](../../presets/test/conventions.test.ts)。 |
