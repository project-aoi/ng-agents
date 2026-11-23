# 工作台运行机制

网页与外部助手共用本机服务。主台 inline 处理输入，project 协调持续项目，worker 执行工作，checker 检查明确条件，sensor 定时观察，hub 归集内部专题。SQLite 保存收件箱、状态、文稿、人工事项及运行证据。回合开始前认领一批信封，处理完成后按实际消费情况结算。

## 行为约定

**`INV-SYS-01`**　每个节点任一时刻仅有一个在途认领，活跃执行还受全局并发限制。

**`INV-SYS-02`**　项目缺少可推进的锚点时先触发一次自查；核实仍无进展才通知主人。自查本身不计作锚点。

**`INV-SYS-03`**　叶节点排空唤醒输入后才能结算。一次性探针将本轮结果与关闭原子提交。

**`INV-SYS-05`**　可重唤醒分身每个结算回合向父节点报告一次。相邻报告对应互不重叠的证据区间。

**`INV-SYS-06`**　人直连已启用抄送的分身时，输入和给父项目的抄送同事务提交。重试沿用相同客户端标识。

**`INV-SYS-07`**　待命分身保留会话，不占执行槽、不阻挡结项。项目结项时将其一并归档。

**`INV-SYS-08`**　模型节点在回合启动时读取全局 runner 和模型档位。创建节点时可指定已启用的 runner、该 runner 提供的模型和推理强度，工具说明从实际模型目录生成选项。节点的显式选择随节点保存。配置变化后，会话仅在 runner、模型和推理强度仍匹配时续接。脚本探针按原定脚本执行。

## 回归入口

[dispatch.test.ts](../../packages/cell/test/dispatch.test.ts)、[docs05-anchors.test.ts](../../packages/cell/test/docs05-anchors.test.ts)、[wakeable.test.ts](../../packages/cell/test/wakeable.test.ts)、[models.test.ts](../../apps/gtd-desk/test/models.test.ts)。
