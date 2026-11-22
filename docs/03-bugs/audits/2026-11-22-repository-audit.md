# 2026-11-22 全仓复核与回归记录

范围为 `main` 上已落地的 Phase 0、提案 05 和提案 06。本表采用最后一份审计意见的编号。文件清单按接手时的工作区快照比较，包含本轮修改的已跟踪文件和未跟踪文件。

## P0 验收

| 编号 | 修复与验证结果 | 回归入口 |
| --- | --- | --- |
| P0-1 | 从 HumanItem 点击「继续处理」会重新入队死信或续跑超步任务。连续两批死信可一起恢复，祖先代持的卡向实际受影响的分身投递回执。 | `packages/cell/test/dispatch.test.ts`、`docs05-settle.test.ts` |
| P0-2 | 后台改稿会在普通视图和专注视图显示版本变化，用户核对新版前无法发送。浏览器用例在收到新版本后实际点击发送并检查请求。 | `apps/gtd-desk/test/human-inbox-browser.test.ts` |
| P0-3 | 常设发送按触发信封、主题和草稿标识复用回执。同轮同收件人的两份现有草稿或两段不同正文均可送达。测试在远端已收件、本地尚未写回执时复制数据库，重启后检查投递次数和规则使用次数。 | `presets/test/phase0.test.ts` |
| P0-4 | 其他分身占用主题时返回冲突。同一分身替换旧卡会收到回执。内核主题有独立身份，死信和超步分开，旧库的开放超步卡可沿用。两个回复监听器在同一项目同时到期会出现两张独立卡。 | `packages/gate/test/authorize.test.ts`、`packages/cell/test/dispatch.test.ts`、`presets/test/watchers.test.ts` |
| P0-5 | 精确线程与过滤条件两条路由都只分发给活跃订阅者。暂停后消息回落到主台，恢复后重新接收。 | `packages/cell/test/routing.test.ts`、`lifecycle.test.ts` |
| P0-6 | 时钟回拨后立即信封和重试信封仍有唤醒时间，释放租约时会重新设置调度。测试驱动已启动的调度器完成实际唤醒。 | `packages/inbox/test/schedule.test.ts` |
| P0-7 | 根预算耗尽时个人提醒仍可送达。消费定时器后重新计算到期队列，真正需要模型的信封继续等待预算。 | `presets/test/phase0.test.ts`、`packages/cell/test/docs05-anchors.test.ts` |
| P0-8 | 内部等待必须沿有向路径到达可以实际推进的源。覆盖三节点环、空闲父节点、休眠兄弟、预算挂起和外部协调器的请求归属。 | `packages/cell/test/docs05-anchors.test.ts` |
| P0-9 | 仲裁按具体项目和本轮等待登记分别判断。已结案的同一原因可再次触发，普通人工待办不会压制仲裁，暂停祖先下的节点退出巡检。 | `packages/cell/test/docs05-anchors.test.ts`、`human-items.test.ts` |
| P0-10 | macOS 包装 shell 捕获 TERM 并等候实际命令退出，重附着取消和超时会等进程组退出。孤儿 CLI 收敛后才清除记录。覆盖正常处理 TERM 与忽略 TERM 的真实子进程。 | `packages/workspace/test/jobs.test.ts`、`packages/loop/test/cli-orphans.test.ts` |
| P0-11 | CLI 重建使用启动批次的信封 ID。运行中追加到可变批次的 follow-up 会进入重建提示，得到确认后才记为送达。 | `packages/loop/test/cli-followup.test.ts` |
| P0-12 | fresh、fork、resume 分别使用自己的基线。有进展才保存新会话，恢复从原游标补证据，MCP 结束工具与输出事件按序确认。覆盖压缩期间的零模型调用事件、迟到会话 ID 和异常退场。 | `packages/loop/test/cli.test.ts`、`cli-followup.test.ts` |

## P1 验收

| 编号 | 修复与验证结果 | 回归入口 |
| --- | --- | --- |
| P1-1 | 核实外发失败后，只有仍开放的后继草稿能取代旧卡。可重试卡保留，取代操作更新修订号和事件。 | `packages/cell/test/approvals.test.ts` |
| P1-2 | 发送中的标记保留到外层事务提交。注入结算失败后，同进程可恢复未定结果，通道只投递一次。 | `packages/channel/test/hub.test.ts`、`packages/cell/test/approvals.test.ts` |
| P1-3 | 向主人地址提交的自动发送独立记录回执，同主题的其他事项可继续等待。未知送达仍能由主人核实。 | `presets/test/replies.test.ts`、`watchers.test.ts` |
| P1-4 | 中止项目时回执发给存活祖先。未读撤销恢复当前代次，已认领则提示用 `reopen_project`。 | `packages/cell/test/human-items.test.ts` |
| P1-5 | 复用人工动作时写入当前代次并清除推迟时间，重新指派的旧事项可以实际办理。 | `presets/test/tools.test.ts` |
| P1-6 | 决定前固定所选选项，暂停分身与父项目分别检查。过期与缺失事项返回对应状态。以后再说使用存活父节点及其代次。 | `apps/gtd-desk/test/api.test.ts` |
| P1-7 | 回复监听器保留失败或未知发送的卡号，仅真实外发成功才记「已催问」。 | `presets/test/watchers.test.ts` |
| P1-8 | 深链支持动作关联。收件箱区分修订冲突、权限冲突与业务冲突，决定成功清除未保存标记。标签计数、专注提示和停靠时间采用现行投影与服务端时间。 | `apps/gtd-desk/test/human-inbox-browser.test.ts`、`api.test.ts` |
| P1-9 | 因请求审批结束的回合也结算已答复的旧等待。 | `packages/cell/test/docs05-settle.test.ts` |
| P1-10 | 主人或外部助手直聊能解除匹配的等待。普通消息保留明确引用优先和单候选回退。 | `packages/cell/test/docs05-anchors.test.ts`、`human-items.test.ts` |
| P1-11 | 老库已批准方案补回结构字段时同步绑定新版。人工稿保留原提案版本和人工编辑标记。 | `presets/test/tools.test.ts` |
| P1-12 | `track_action` 实时读取直接子节点。可关联同轮刚派发的分身，关闭后不能再指派。 | `presets/test/project-books.test.ts` |
| P1-13 | 协调器和 MCP 的文字输出均说明「额度用尽暂停」。 | `packages/cell/test/docs05-anchors.test.ts`、`apps/gtd-desk/test/agent.test.ts` |
| P1-14 | 自定义选项请求进入等待，具体操作经过 Gate 授权。一次性 checker 已提交结果时可以正常交付关停。 | `packages/loop/test/tools.test.ts`、`packages/cell/test/docs05-settle.test.ts` |
| P1-15 | AGY 首条提示发送前缓存追加输入。Claude 的后续回合已有活动时清除上轮结束计时器。 | `packages/loop/test/cli-followup.test.ts` |
| P1-16 | macOS 进程身份核对区分环境不可见与标记不符。摘要预算包含任务前后缀并保持多工具配对。启动时安装状态域并刷新前缀，发布指纹覆盖 presets 和仅有 dist 的目录。 | `packages/workspace/test/jobs.test.ts`、`packages/context/test/hydrate.test.ts`、`packages/cell/test/restart.test.ts` |

## P2、前次复核和文档

- 工作目录支持 `~/` 并规范化。预算被拒后通过追加额度或关闭限额恢复。交回主台的决定能找回原信封的线程。工具正文包含动作和草稿标识。
- 协调器能看见后代共享文档的人工修改。关联升级卡会发出变更事件。分身可撤回自己的排队草稿。个人事项重新出现时免写定时器对话证据。
- 内核直接办理 `system.someday` 会提示走工作台。CLI 等待父会话时可中止，超步工具调用配有结果。重附着 Job 使用同一次身份核验和宿主记录时间。
- 上轮六项已复查。覆盖单次快捷键保存及在途保护、列表分组与选中顺序、MCP 失败与版本别名、presets 发布指纹、暂停时追加输入的确认边界，以及排队草稿查询与撤回。
- 规范、提案索引、外部工具指南和缺陷台账已同步三视图、角色名称、`working_note`、三类主人批准边界和提案 01–06 的落地状态。真实模型、合盖唤醒及人工视觉验收的历史待验项继续按台账跟踪。

## 门禁与复核

- 宿主为 macOS arm64。独立复核覆盖 Gate 与 HumanItem 的事务边界、CLI 会话、操作系统进程、等待图和工作台入口。复核发现的同轮多稿、主人第二通道回执、旧库超步卡和已关闭子节点均已追加回归。
- 进程包装器使用 `trap ':' TERM`。这种写法能保留子命令自己的终止信号处理，测试同时检查优雅退出和强制回收。
- 按顺序运行 `pnpm typecheck && pnpm test && pnpm build`。10 个包类型检查通过，Vitest 在 104 个文件中通过 1,149 条，失败 0 条。另有 1 个文件的 3 条真实模型用例按默认配置跳过。前端生产构建成功，`git diff --check` 通过。
- 三项真实模型命令行用例由 `NG_LIVE_CLI` 显式启用。本次 CLI 测试通过确定性假模型和真实子进程验证。
- `pnpm-lock.yaml` 进入和结束本轮时的 SHA-256 均为 `da1e41d2a17356834f06a92b6ab55b474bca7be487749f8a7990557fa8923add`。本轮没有启停本机 ng-desk 服务，也没有操作外部工作区的 dashboard。

## 本轮涉及文件

共 89 个文件，包括本报告。

| 目录 | 文件 |
| --- | --- |
| `.` | [AGENTS.md](../../../AGENTS.md) |
| `apps/gtd-desk/main-agent/ng-desk/skills/ng-desk` | [SKILL.md](../../../apps/gtd-desk/main-agent/ng-desk/skills/ng-desk/SKILL.md) |
| `apps/gtd-desk/src/agent` | [guide.ts](../../../apps/gtd-desk/src/agent/guide.ts)、[tools.ts](../../../apps/gtd-desk/src/agent/tools.ts) |
| `apps/gtd-desk/src/server` | [desk.ts](../../../apps/gtd-desk/src/server/desk.ts) |
| `apps/gtd-desk/src/shared` | [api.ts](../../../apps/gtd-desk/src/shared/api.ts) |
| `apps/gtd-desk/src/web` | [App.tsx](../../../apps/gtd-desk/src/web/App.tsx) |
| `apps/gtd-desk/src/web/components` | [Parked.tsx](../../../apps/gtd-desk/src/web/components/Parked.tsx)、[chrome.tsx](../../../apps/gtd-desk/src/web/components/chrome.tsx)、[draft.tsx](../../../apps/gtd-desk/src/web/components/draft.tsx) |
| `apps/gtd-desk/src/web/views` | [HumanInbox.tsx](../../../apps/gtd-desk/src/web/views/HumanInbox.tsx)、[Radar.tsx](../../../apps/gtd-desk/src/web/views/Radar.tsx) |
| `apps/gtd-desk/test` | [agent.test.ts](../../../apps/gtd-desk/test/agent.test.ts)、[api.test.ts](../../../apps/gtd-desk/test/api.test.ts)、[human-inbox-browser.test.ts](../../../apps/gtd-desk/test/human-inbox-browser.test.ts) |
| `apps/gtd-desk/test/fixtures` | [human-inbox-browser.tsx](../../../apps/gtd-desk/test/fixtures/human-inbox-browser.tsx) |
| `docs` | [README.md](../../README.md) |
| `docs/01-principles` | [02-kernel-principles.md](../../01-principles/02-kernel-principles.md)、[03-safety-and-boundaries.md](../../01-principles/03-safety-and-boundaries.md) |
| `docs/02-workflows` | [uc07-external-agent-and-overnight-hosting.md](../../02-workflows/uc07-external-agent-and-overnight-hosting.md)、[uc08-direct-worker-chat-and-pull-sync.md](../../02-workflows/uc08-direct-worker-chat-and-pull-sync.md) |
| `docs/03-bugs` | [BUG-20261118-kernel-and-budget.md](../BUG-20261118-kernel-and-budget.md)、[BUG-20261119-cards-and-coordination.md](../BUG-20261119-cards-and-coordination.md)、[BUG-20261121-context-and-visibility.md](../BUG-20261121-context-and-visibility.md)、[BUG-20261121-lifecycle-and-resilience.md](../BUG-20261121-lifecycle-and-resilience.md)、[BUG-20261121-orthogonality-and-control.md](../BUG-20261121-orthogonality-and-control.md)、[README.md](../README.md) |
| `docs/03-bugs/audits` | [2026-11-22-repository-audit.md](2026-11-22-repository-audit.md) |
| `docs/05-proposals` | [README.md](../../05-proposals/README.md) |
| `packages/cell/src` | [approvals.ts](../../../packages/cell/src/approvals.ts)、[dispatcher.ts](../../../packages/cell/src/dispatcher.ts)、[escalations.ts](../../../packages/cell/src/escalations.ts)、[human-items.ts](../../../packages/cell/src/human-items.ts)、[index.ts](../../../packages/cell/src/index.ts)、[kernel.ts](../../../packages/cell/src/kernel.ts)、[lifecycle.ts](../../../packages/cell/src/lifecycle.ts)、[ports.ts](../../../packages/cell/src/ports.ts)、[readmodel.ts](../../../packages/cell/src/readmodel.ts)、[release.ts](../../../packages/cell/src/release.ts)、[routing.ts](../../../packages/cell/src/routing.ts)、[stall.ts](../../../packages/cell/src/stall.ts)、[types.ts](../../../packages/cell/src/types.ts)、[waits.ts](../../../packages/cell/src/waits.ts) |
| `packages/cell/test` | [approvals.test.ts](../../../packages/cell/test/approvals.test.ts)、[dispatch.test.ts](../../../packages/cell/test/dispatch.test.ts)、[docs05-anchors.test.ts](../../../packages/cell/test/docs05-anchors.test.ts)、[docs05-settle.test.ts](../../../packages/cell/test/docs05-settle.test.ts)、[human-items.test.ts](../../../packages/cell/test/human-items.test.ts)、[lifecycle.test.ts](../../../packages/cell/test/lifecycle.test.ts)、[phase0.test.ts](../../../packages/cell/test/phase0.test.ts)、[restart.test.ts](../../../packages/cell/test/restart.test.ts)、[routing.test.ts](../../../packages/cell/test/routing.test.ts) |
| `packages/channel/src` | [hub.ts](../../../packages/channel/src/hub.ts) |
| `packages/channel/test` | [hub.test.ts](../../../packages/channel/test/hub.test.ts) |
| `packages/context/src` | [hydrate.ts](../../../packages/context/src/hydrate.ts) |
| `packages/context/test` | [hydrate.test.ts](../../../packages/context/test/hydrate.test.ts) |
| `packages/gate/src` | [gate.ts](../../../packages/gate/src/gate.ts) |
| `packages/gate/test` | [approvals.test.ts](../../../packages/gate/test/approvals.test.ts)、[authorize.test.ts](../../../packages/gate/test/authorize.test.ts) |
| `packages/inbox/src` | [inbox.ts](../../../packages/inbox/src/inbox.ts) |
| `packages/inbox/test` | [schedule.test.ts](../../../packages/inbox/test/schedule.test.ts) |
| `packages/loop/src/cli` | [input.ts](../../../packages/loop/src/cli/input.ts)、[loop.ts](../../../packages/loop/src/cli/loop.ts)、[process.ts](../../../packages/loop/src/cli/process.ts) |
| `packages/loop/src/cli/adapters` | [agy.ts](../../../packages/loop/src/cli/adapters/agy.ts) |
| `packages/loop/src/testing` | [fake-cli-agent.mjs](../../../packages/loop/src/testing/fake-cli-agent.mjs)、[fake-cli.ts](../../../packages/loop/src/testing/fake-cli.ts)、[fake-ports.ts](../../../packages/loop/src/testing/fake-ports.ts) |
| `packages/loop/src/tools` | [comms.ts](../../../packages/loop/src/tools/comms.ts) |
| `packages/loop/test` | [cli-followup.test.ts](../../../packages/loop/test/cli-followup.test.ts)、[cli-orphans.test.ts](../../../packages/loop/test/cli-orphans.test.ts)、[cli.test.ts](../../../packages/loop/test/cli.test.ts)、[loop.test.ts](../../../packages/loop/test/loop.test.ts)、[tools.test.ts](../../../packages/loop/test/tools.test.ts) |
| `packages/protocol/src` | [process.ts](../../../packages/protocol/src/process.ts) |
| `packages/protocol/src/contract` | [cell.ts](../../../packages/protocol/src/contract/cell.ts)、[gate.ts](../../../packages/protocol/src/contract/gate.ts) |
| `packages/workspace/src` | [jobs.ts](../../../packages/workspace/src/jobs.ts) |
| `packages/workspace/test` | [jobs.test.ts](../../../packages/workspace/test/jobs.test.ts) |
| `presets/src/inline-desk` | [toolset.ts](../../../presets/src/inline-desk/toolset.ts) |
| `presets/src/project` | [toolset.ts](../../../presets/src/project/toolset.ts) |
| `presets/src/shared` | [human-actions.ts](../../../presets/src/shared/human-actions.ts)、[retire-desk-state.ts](../../../presets/src/shared/retire-desk-state.ts)、[watcher.ts](../../../presets/src/shared/watcher.ts) |
| `presets/test` | [phase0.test.ts](../../../presets/test/phase0.test.ts)、[project-books.test.ts](../../../presets/test/project-books.test.ts)、[replies.test.ts](../../../presets/test/replies.test.ts)、[tools.test.ts](../../../presets/test/tools.test.ts)、[watchers.test.ts](../../../presets/test/watchers.test.ts) |
