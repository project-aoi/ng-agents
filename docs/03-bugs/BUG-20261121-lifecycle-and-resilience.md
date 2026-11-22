# 并发与恢复

<a id="bug-025"></a>

## BUG-025　同名事项按签发分身隔离

两项目可以各自使用相同的主题名称。创建、刷新、查询及撤销均保持签发范围。故障升级的受保护名称由角色注册，普通业务写入无法冒用。

[人工事项测试](../../packages/cell/test/human-items.test.ts) [角色边界测试](../../presets/test/conventions.test.ts)

<a id="bug-026"></a>

## BUG-026　纠偏只在送达后确认

运行中的补充和立即纠偏可以在进程退出与下一轮启动之间到达。持久证据带信封编号，启动和恢复按实际接收情况确认，并用同一编号去重。

[运行中补充消息测试](../../packages/loop/test/cli-followup.test.ts) [命令行会话测试](../../packages/loop/test/cli.test.ts) [控制消息测试](../../packages/inbox/test/control.test.ts)

<a id="bug-027"></a>

## BUG-027　看到活进程时暂缓派工

宿主启动后核对执行实例、进程身份和进程组，回收完成前不为同一分身再启命令行。后台命令恢复与终止也按进程组核对。

[内核运行测试](../../packages/cell/test/phase0.test.ts) [后台命令测试](../../packages/workspace/test/jobs.test.ts) [命令行子进程测试](../../packages/loop/test/cli-orphans.test.ts)

<a id="bug-028"></a>

## BUG-028　决定与后台回执一同提交

事项决定只在当前修订上生效。两个并发选择只能提交一个；失败方看到冲突。后台回执和持久决定可在同一次事务提交后读到。

[人工事项测试](../../packages/cell/test/human-items.test.ts) [审批测试](../../packages/gate/test/approvals.test.ts)

<a id="bug-029"></a>

## BUG-029　真有结果才结束等待

一次性检查需要满足条件后报告。结束项目时检查仍在途的子分身与命令，待命分身可以随项目收尾。解除等待后重新判断谁需要被唤醒。

[检查分身测试](../../presets/test/checkers.test.ts) [停滞与等待测试](../../packages/cell/test/docs05-anchors.test.ts) [生命周期测试](../../packages/cell/test/lifecycle.test.ts)

<a id="bug-030"></a>

## BUG-030　沿等待关系查找实际推进来源

停滞检查结合在途工作、可达信号与能由主人处理的事项，排除循环和失效等待。独立项目可各自升级，新的等待登记可以再次触发检查。

[停滞与等待测试](../../packages/cell/test/docs05-anchors.test.ts)

<a id="bug-031"></a>

## BUG-031　撤销与重新打开遵守清理次序

关闭会触发相关后台清理，重开必须与对应轮次的清理互斥。后台认领前可撤销有效操作；认领后根据操作种类提交更正或要求重新打开项目。

[人工事项测试](../../packages/cell/test/human-items.test.ts) [生命周期测试](../../packages/cell/test/lifecycle.test.ts) [HTTP 接口测试](../../apps/gtd-desk/test/api.test.ts)
