# 外部助手交办与跨夜续接

主人在日常助手中先核对项目和长期偏好，再明确哪些工作可以立项。助手以自己的身份交办并返回。宿主跨夜休眠或服务重启后，工作台核对认领、进程和已有会话再继续处理。

## 行为约定

**`INV-UC07-01`**　交办前检查已有项目与活跃目录，提交后返回项目标识，供主人随时查询。

**`INV-UC07-02`**　外部助手用 `create_project` 直接交办，主台分身用 `start_project`。需要主人确认时生成 `project.start` 卡。外部助手可以按主人的指示直接批准、停靠、推迟、退回修改或拒绝，也可以编辑方案，权限与网页相同；提交时带所见版本，冲突返回最新内容。后台节点不能批准这张卡。工作台、宿主启动程序与外部助手均显式传入身份，缺少身份的内核写入会被拒绝。

**`INV-UC07-03`**　外部助手的 `create_project` 和 `spawn_cell` 与内置立项、派工工具共用宿主启用的 runner 列表和模型目录。拒绝无效的选择，保留原有交办和审批权限。

**`INV-UC07-05`**　唤醒时保护仍存活的运行。回收旧进程完成后才允许同一分身启动新命令行。身份暂时不可读时保留登记。后台脚本退出后，恢复流程核对仍存活的同组子进程，再发布任务结果。

## 回归入口

[agent.test.ts](../../apps/gtd-desk/test/agent.test.ts)、[models.test.ts](../../apps/gtd-desk/test/models.test.ts)、[restart.test.ts](../../packages/cell/test/restart.test.ts)、[cli-orphans.test.ts](../../packages/loop/test/cli-orphans.test.ts)。
