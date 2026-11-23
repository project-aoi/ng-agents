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
| 探针排空 | 一次性结算 | 失败报告在第二个回合重新绑定，父项目只收到一次失败和原始检查结果。 | [probe.test.ts](../../presets/test/probe.test.ts) |
| 主人与助手 | 本机身份 | 不设凭据。`/api/*` 记录为主人，`/api/agent/*` 记录为 `agent:local`，两者权限相同。Host 与跨站检查拦截网页来源的请求。 | [agent.test.ts](../../apps/gtd-desk/test/agent.test.ts)、[agent-parity.test.ts](../../apps/gtd-desk/test/agent-parity.test.ts)、[server.test.ts](../../apps/gtd-desk/test/server.test.ts) |
| 信源与内部定时 | 批量与失败恢复 | 每个脚本触发独立结算。内部提醒失败后退避重试；无需唤醒模型。 | [api.test.ts](../../apps/gtd-desk/test/api.test.ts)、[human-items.test.ts](../../packages/cell/test/human-items.test.ts) |
| 分身与文稿归属 | 项目协作 | 同项目可接力编辑，无关项目写入和非发起节点修改待批方案会被拒绝。 | [human-items.test.ts](../../packages/cell/test/human-items.test.ts)、[scenario-human-step.test.ts](../../presets/test/scenario-human-step.test.ts) |
| 仲裁与暂停 | 自查结算 | 自身停靠后不产生新卡。已有仲裁持有相同等待时，项目自查等待该次仲裁结算。 | [docs05-anchors.test.ts](../../packages/cell/test/docs05-anchors.test.ts) |
| 纠偏与回收 | 进程和会话 | 旧工具调用返回时只确认原回合。进程身份未知时保留登记，恢复后台任务时等待同组进程退出。 | [cli.test.ts](../../packages/loop/test/cli.test.ts)、[cli-orphans.test.ts](../../packages/loop/test/cli-orphans.test.ts)、[jobs.test.ts](../../packages/workspace/test/jobs.test.ts) |

[2026-11-22 复核](audits/2026-11-22-repository-audit.md)

[2026-11-23 八组工作流实机核对](audits/2026-11-23-codex-e2e-workflows.md)：列出 E01–E40，其中 13 项高优先级。同日全部修复，逐项的改动和回归入口见报告末尾的“修复记录”。自动回归通过；提示词和工具文字的改动尚未用真实命令行复跑八组工作流。

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

## 专项记录

| 时间 | 复现与回归 |
| --- | --- |
| 11 月 18 日 | [宿主运行](BUG-20261118-runtime.md)、[执行与探针](BUG-20261118-execution.md)、[上下文与提示词](BUG-20261118-context-and-prompt.md)、[工作台与控制面](BUG-20261118-ui-and-control.md)、[实机记录](audits/2026-11-18-traex-live-e2e.md) |
| 11 月 19 日 | [人工事项与协调](BUG-20261119-cards-and-coordination.md) |
| 11 月 21 日 | [上下文可见性](BUG-20261121-context-and-visibility.md)、[生命周期与恢复](BUG-20261121-lifecycle-and-resilience.md)、[状态归属与控制](BUG-20261121-orthogonality-and-control.md) |
