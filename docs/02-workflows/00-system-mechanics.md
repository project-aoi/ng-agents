# 工作台运行机制

网页与外部助手共用本机服务。主台 inline 处理输入，project 协调持续项目，worker 执行工作，checker 检查明确条件，sensor 定时观察，hub 归集内部专题。SQLite 保存收件箱、状态、文稿、人工事项及运行证据。回合开始前认领一批信封，处理完成后按实际消费情况结算。

## 行为约定

**`INV-SYS-01`**　每个节点任一时刻仅有一个在途认领，活跃执行还受全局并发限制。

**`INV-SYS-02`**　项目缺少可推进的锚点时先触发一次自查；核实仍无进展才通知主人。自查本身不计作锚点。

**`INV-SYS-03`**　叶节点排空唤醒输入后才能结算。一次性探针将本轮结果与关闭原子提交。

**`INV-SYS-05`**　可重唤醒分身每个结算回合向父节点报告一次。相邻报告对应互不重叠的证据区间。

**`INV-SYS-06`**　人直连已启用抄送的分身时，输入和给父项目的抄送同事务提交。重试沿用相同客户端标识。

**`INV-SYS-07`**　待命分身保留会话，不占执行槽、不阻挡结项。项目结项时将其一并归档。

**`INV-SYS-08`**　模型节点在回合启动时按「节点显式覆盖 > 所属层级默认 > 全局默认」解析 runner、模型和推理强度。创建节点时可指定已启用的 runner、模型和推理强度（允许单独覆盖 runner 或推理强度），工具说明从实际模型目录和层级默认配置生成选项。节点的显式选择随节点保存。配置变化后，会话仅在 runner、模型和推理强度仍匹配时续接。脚本探针按原定脚本执行。

**`INV-SYS-09`**　回合附注在预设簿记之后读取：模型看到的开放动作、等待和卡片与记录一致。簿记代为关闭的动作单独列出并可重开；本轮输入将答复的等待不再显示为开放；归主人的动作只在开放动作里列一次。叶节点的附注不列父节点对它的等待，也不把自己的上级协调器算作同目录的其他人。

**`INV-SYS-10`**　暂停和恢复都留记录：谁、何时、随附的原话。被点名的节点在证据里有一条说明，父节点的花名册和 inspect_cell 显示暂停原因。恢复后，协调器有待处理输入时先于其下属运行一个回合；早于暂停的指令重投时注明它来自暂停之前。

**`INV-SYS-11`**　结束回合的工具返回后，模型在同一回合里说的话保留在记录里，之后回合的输出不计入。命令行会话在首次进展时登记，回合中途崩溃后下一回合续接同一会话。续接会话时不重发最初任务；无法续接父会话的分叉节点使用自己的角色提示词。

**`INV-SYS-12`**　后台节点启动的命令行进程带 `NG_WORKBENCH_CELL_ID`，外部助手接入套件在这类进程里不提供控制面工具；Codex 后台进程启动时关闭 `ng-desk` 插件，主人的其余配置照常加载。

**`INV-SYS-13`**　后台任务的静默告警只计进程实际运行的时间，宿主休眠或整组冻结的时段不算。

## 回归入口

[dispatch.test.ts](../../packages/cell/test/dispatch.test.ts)、[docs05-anchors.test.ts](../../packages/cell/test/docs05-anchors.test.ts)、[wakeable.test.ts](../../packages/cell/test/wakeable.test.ts)、[models.test.ts](../../apps/gtd-desk/test/models.test.ts)、[wake-notes.test.ts](../../presets/test/wake-notes.test.ts)（09）、[pause-record.test.ts](../../packages/cell/test/pause-record.test.ts)（10）、[cli.test.ts](../../packages/loop/test/cli.test.ts)（11、12）、[adapters.test.ts](../../packages/loop/test/adapters.test.ts)（12）、[jobs.test.ts](../../packages/workspace/test/jobs.test.ts)（13）。
