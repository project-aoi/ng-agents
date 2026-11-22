# 2026-11-22 工作台 v1 复核

检查覆盖权限、队列、命令行输入、上下文、宿主进程与三个工作台视图。人工事项通过同一张表、同一组领域命令处理，版本冲突通过真实请求及页面操作验证。

| 编号 | 范围 | 已验证行为 | 回归入口 |
| --- | --- | --- | --- |
| C1、C5、S3 | 跨节点知识写入和人工事项隔离 | 分身写共享偏好或全局引用会被拒绝；同主题的不同节点各自处理自己的卡。 | [authorize.test.ts](../../../packages/gate/test/authorize.test.ts)、[tools.test.ts](../../../packages/loop/test/tools.test.ts)、[human-items.test.ts](../../../packages/cell/test/human-items.test.ts) |
| C2 | 暂停与祖先检查 | 经收件箱直接暂停项目，中止后代运行及后台任务。暂停祖先下无法派生、认领或路由工作。 | [lifecycle.test.ts](../../../packages/cell/test/lifecycle.test.ts)、[routing.test.ts](../../../packages/cell/test/routing.test.ts) |
| C6、B12 | 立项与人工动作 | 立项含人工步骤时原子生成关联项目的待办；完成的个人提醒仍可在周回顾查到。 | [sources-and-quick-items.test.ts](../../../presets/test/sources-and-quick-items.test.ts)、[projections.test.ts](../../../apps/gtd-desk/test/projections.test.ts)、[conventions.test.ts](../../../presets/test/conventions.test.ts) |
| C8、B3、C9 | 回合结算与答复归属 | 拒答处理已消费的等待，旧回合结果不清新等待。抄送、自查与指向别项的答复不会误清。 | [docs05-settle.test.ts](../../../packages/cell/test/docs05-settle.test.ts)、[docs05-anchors.test.ts](../../../packages/cell/test/docs05-anchors.test.ts) |
| B2、S5 | 停滞与计时 | 停靠节点退出巡检，相同原因按等待登记隔离，解决后可再次升级。时钟回拨重设实际唤醒。 | [docs05-anchors.test.ts](../../../packages/cell/test/docs05-anchors.test.ts)、[schedule.test.ts](../../../packages/inbox/test/schedule.test.ts) |
| B11、B13 | 撤销与重复直连 | 撤销时检查发起节点是否可恢复，必要时发更正。关闭后重试已送达的直连保持幂等。 | [human-items.test.ts](../../../packages/cell/test/human-items.test.ts)、[wakeable.test.ts](../../../packages/cell/test/wakeable.test.ts)、[agent.test.ts](../../../apps/gtd-desk/test/agent.test.ts) |
| C7、B4、B5、B6 | 命令行输入与证据游标 | 终止工具执行后未确认的输入返回队列；下一回合实际收到追加消息才确认。拒答可推进已消费输入的游标。 | [cli-followup.test.ts](../../../packages/loop/test/cli-followup.test.ts)、[cli.test.ts](../../../packages/loop/test/cli.test.ts)、[phase0.test.ts](../../../packages/cell/test/phase0.test.ts) |
| B7、B8、S4、S6 | 压缩、前缀与重新启动 | 结构化任务、引用和最新摘要保留；会话分叉核对父前缀与目录，重建保留笔记和子节点名单。 | [hydrate.test.ts](../../../packages/context/test/hydrate.test.ts)、[cli-followup.test.ts](../../../packages/loop/test/cli-followup.test.ts) |
| B9、B10 | 进程与后台任务 | 按实例和进程身份处理残留；核实整个进程组退出后结算，回收期间禁止重复启动。 | [cli-orphans.test.ts](../../../packages/loop/test/cli-orphans.test.ts)、[jobs.test.ts](../../../packages/workspace/test/jobs.test.ts) |
| B15 | 脚本信源 | 运行真实临时脚本读取触发信封；沿用同一信封重试时，观察与计数只写入一次。 | [script-sensor.test.ts](../../../presets/test/script-sensor.test.ts)、[sources-and-quick-items.test.ts](../../../presets/test/sources-and-quick-items.test.ts) |
| C10、B16 | 工作台焦点、版本与实时状态 | 收到新卡时保留正在填写的内容。冲突后用远端最新版核对；撤销和重开返回最新状态，并通知订阅视图。 | [human-inbox-browser.test.ts](../../../apps/gtd-desk/test/human-inbox-browser.test.ts)、[api.test.ts](../../../apps/gtd-desk/test/api.test.ts)、[server.test.ts](../../../apps/gtd-desk/test/server.test.ts) |
| 探针排空 | 一次性结算 | 失败报告在第二个回合重新绑定，父项目只收到一次失败和原始检查结果。 | [probe.test.ts](../../../presets/test/probe.test.ts) |
| 主人与助手 | 本机身份 | 回环访问也核对主人凭据。独立助手令牌需要配对的主人令牌。 | [agent.test.ts](../../../apps/gtd-desk/test/agent.test.ts)、[server.test.ts](../../../apps/gtd-desk/test/server.test.ts) |
| 信源与内部定时 | 批量与失败恢复 | 每个脚本触发独立结算。内部提醒失败后退避重试；无需唤醒模型。 | [api.test.ts](../../../apps/gtd-desk/test/api.test.ts)、[human-items.test.ts](../../../packages/cell/test/human-items.test.ts) |

## 重跑验收

```sh
pnpm typecheck && pnpm test && pnpm build
```

命令行流式测试用可控的真实子进程，在接收输入、执行工具、退出及恢复时同步。实际已登录的命令行可用 `NG_LIVE_CLI=codex pnpm exec vitest run packages/loop/test/cli-live.test.ts` 单独验证；该用例读取临时工作区，调用内核工具并检查写回值。

## 本机复核

- 空库启动后，六个模块的 schema 版本均为 1，SQLite 完整性检查返回 `ok`。主页、状态、收件箱、项目全局和分身拓扑接口均返回 200。
- 本机 Codex 读取了临时目录中的文件，经工具桥调用 `set_state`，内核收到与文件一致的值。
- 使用独立浏览器配置依次进入三个视图，核对事项、项目、分身与时间线。服务端推送新事项后，浏览器自动刷新列表并保留当前焦点。
- 使用真实 HTTP 请求验证了方案保存冲突、撤销、已结束项目查询和重新打开；使用真实宿主脚本核对了信源触发信封和观察记录。
