# 模型选择与现场检查

<a id="bug-004"></a>

## BUG-004　按角色选择模型

实机发现轻量检查和复杂交付使用了同一档模型。工作台分别保存快速与强力模型选择，将模型和推理强度传给相应的本地命令行驱动。

[模型选择测试](../../apps/gtd-desk/test/models.test.ts) [驱动参数测试](../../packages/loop/test/adapters.test.ts)

<a id="bug-005"></a>

## BUG-005　按事实完成一次性检查

能用命令验证的条件交给脚本探针。模型检查分身在目标目录查看现状，只保留一个唤醒时机。暂未满足条件时继续等，满足时报告并关闭。

[检查分身测试](../../presets/test/checkers.test.ts) [脚本探针测试](../../presets/test/probe.test.ts)

<a id="bug-008"></a>

## BUG-008　把执行证据交回项目

一次工具调用可能同时包含宿主命令和很长的输出。项目需要看到实际命令、结果、错误结尾和完整输出引用。较长工作可以通过带标识的后台命令持续执行。

[内核运行测试](../../packages/cell/test/phase0.test.ts) [后台命令测试](../../packages/workspace/test/jobs.test.ts)
