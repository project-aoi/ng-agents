# 外部助手交办与跨夜续接

主人在日常助手中先核对项目和长期偏好，再明确哪些工作可以立项。助手以自己的身份交办并返回。宿主跨夜休眠或服务重启后，工作台核对认领、进程和已有会话再继续处理。

## 行为约定

**`INV-UC07-01`**　交办前检查已有项目与活跃目录，提交后返回项目标识，供主人随时查询。

**`INV-UC07-02`**　外部助手用 `create_project` 直接交办，主台分身用 `start_project`。需要主人确认时生成 `project.start` 卡，由主人批准执行。工作台、宿主启动程序与外部助手均显式传入身份，缺少身份的内核写入会被拒绝。

**`INV-UC07-05`**　唤醒时保护仍存活的运行。回收旧进程完成后才允许同一分身启动新命令行。身份暂时不可读时保留登记。后台脚本退出后，恢复流程核对仍存活的同组子进程，再发布任务结果。

## 回归入口

[agent.test.ts](../../apps/gtd-desk/test/agent.test.ts)、[restart.test.ts](../../packages/cell/test/restart.test.ts)、[cli-orphans.test.ts](../../packages/loop/test/cli-orphans.test.ts)。
