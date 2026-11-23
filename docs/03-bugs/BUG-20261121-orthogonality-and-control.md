# 数据归属与控制边界

<a id="bug-020"></a>

## BUG-020　控制入口尊重身份和版本

总助理不可被项目操作关闭。提交决定必须提供读到的事项及相关文稿修订。

当时的修复还规定项目确认卡的执行选项仅限主人，这条限制已由[提案 07](../05-proposals/07-mcp-parity-and-no-auth.md) 废止：外部主代理与网页同权处理立项卡，后台节点仍不能批准。

[内核运行测试](../../packages/cell/test/phase0.test.ts) [人工事项测试](../../packages/cell/test/human-items.test.ts) [外部主代理测试](../../apps/gtd-desk/test/agent.test.ts)

<a id="bug-021"></a>

## BUG-021　提醒、工作目录和状态各有唯一来源

提醒只从定时信封触发；目录和暂停原因取自分身记录；主人行动的完成状态进入人工事项记录，周回顾据此汇总。

[提醒与信源测试](../../presets/test/sources-and-quick-items.test.ts) [投影测试](../../apps/gtd-desk/test/projections.test.ts) [项目行动测试](../../presets/test/project-books.test.ts)

<a id="bug-022"></a>

## BUG-022　一致地解释消息来源与脚本触发

主对话和外部代理的转述均携带身份。脚本信源从工作台创建后走正常调度，用触发信封驱动实际脚本，同一触发只记录一次观察。

[信源脚本测试](../../presets/test/script-sensor.test.ts) [外部主代理测试](../../apps/gtd-desk/test/agent.test.ts)

<a id="bug-023"></a>

## BUG-023　工作笔记与检索材料用途不同

项目白板使用本地 working_note，书签和长材料保存为 reference。确认的偏好由总助理记录，技能建议在周回顾中由主人决定。

[知识范围测试](../../packages/context/test/knowledge.test.ts) [角色边界测试](../../presets/test/conventions.test.ts)

<a id="bug-024"></a>

## BUG-024　一次性检查与持续信源分工

checker 查看目标条件并在报告后关闭，sensor 持续按计划观察；普通执行分身结束一轮后待命。各角色的完成语义决定下一次怎样被唤醒。

[检查分身测试](../../presets/test/checkers.test.ts) [信源脚本测试](../../presets/test/script-sensor.test.ts) [分身唤醒测试](../../packages/cell/test/wakeable.test.ts)
