# 报告编辑与上下文

<a id="bug-006"></a>

## BUG-006　局部修订报告时保留标题

实机的一份长报告经历多次分页读取。共享文档支持按期望版本修改局部内容，同一文档升版时保留已有标题。并发编辑发生冲突时给调用方最新版本。

[共享文档测试](../../packages/context/test/artifacts.test.ts)

<a id="bug-007"></a>

## BUG-007　控制报告体积与偏好范围

报告应保留被分析项目的真实文件名和技术术语。长清单放在供检索的材料里。按目录、角色筛选适用偏好，已内联的技能无需再次主动读取。

[知识范围测试](../../packages/context/test/knowledge.test.ts) [上下文测试](../../packages/context/test/hydrate.test.ts) [角色边界测试](../../presets/test/conventions.test.ts)
