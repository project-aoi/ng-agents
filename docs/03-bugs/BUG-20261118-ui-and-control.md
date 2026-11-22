# 项目报告与状态呈现

<a id="bug-010"></a>

## BUG-010　打开已停靠项目的报告

两个预研项目停靠后仍需回读结论。项目行列出关联报告及版本，停靠与活跃状态使用同一阅读入口。

[分身视图测试](../../apps/gtd-desk/test/agents.test.ts) [投影测试](../../apps/gtd-desk/test/projections.test.ts)

<a id="bug-011"></a>

## BUG-011　展示实际等待与停靠状态

等待可能来自 CI、日期或人工输入。项目行显示具体条件，周回顾归集已完成的成果。已停靠项目单独计数，状态行根据当前工作事实生成。

[投影测试](../../apps/gtd-desk/test/projections.test.ts) [分身视图测试](../../apps/gtd-desk/test/agents.test.ts)

<a id="bug-012"></a>

## BUG-012　查看下属分身与历史交付

项目详情能查看待命和归档分身，报告和长输出支持分页。关闭后再次开启的分身仍要遵守有效并发边界。通过方案卡创建的项目保留提案来源，执行创建的主体仍是总助理。

[外部主代理测试](../../apps/gtd-desk/test/agent.test.ts) [分身视图测试](../../apps/gtd-desk/test/agents.test.ts) [分身唤醒测试](../../packages/cell/test/wakeable.test.ts)
