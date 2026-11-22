# 工作交接与现场可见性

<a id="bug-032"></a>

## BUG-032　保留主人的文稿修订

草稿内容有独立版本。提交决定同时校验审阅版本。发生冲突时保留本地输入，展示远端最新内容供比较；回执向后台说明主人编辑的内容。

[共享文档测试](../../packages/context/test/artifacts.test.ts) [人工事项测试](../../packages/cell/test/human-items.test.ts) [收件箱交互测试](../../apps/gtd-desk/test/human-inbox-browser.test.ts)

<a id="bug-033"></a>

## BUG-033　命令行恢复时补齐未读证据

恢复已有会话需要检查稳定前缀、当前目录与证据游标。压缩时保留最初任务及完整引用；无法沿用会话时重新装配动态上下文。

[上下文测试](../../packages/context/test/hydrate.test.ts) [命令行会话测试](../../packages/loop/test/cli.test.ts) [运行中补充消息测试](../../packages/loop/test/cli-followup.test.ts)

<a id="bug-034"></a>

## BUG-034　检查分身时保留能定位问题的证据

错误摘要要保留报错结尾、命令退出码和长输出引用。后台执行结果与决定事件使用各自可读的说明，项目可据此决定下一步。

[内核运行测试](../../packages/cell/test/phase0.test.ts)

<a id="bug-035"></a>

## BUG-035　让同轮派工和工作现场可查

项目可以登记本轮刚派出的分身。活跃工作目录、在途事项、等待方、当前消息来源进入动态上下文，项目用返回的标识查看原始工作记录。

[项目行动测试](../../presets/test/project-books.test.ts) [分身活动测试](../../packages/cell/test/readmodel.test.ts) [上下文测试](../../packages/context/test/hydrate.test.ts)
