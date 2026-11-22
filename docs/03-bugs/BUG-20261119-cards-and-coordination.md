# 人工事项与跨项目协调

<a id="bug-014"></a>

## BUG-014　阻塞事项能表达现实选项

卡片可以声明选项及需要输入的备注。一个选择的实际含义、要交给分身的上下文和关联目标都来自这张卡。

[人工事项测试](../../packages/cell/test/human-items.test.ts) [HTTP 接口测试](../../apps/gtd-desk/test/api.test.ts)

<a id="bug-015"></a>

## BUG-015　处理选择后有确定的下一步

写入决定、更新事项修订与生成后续回执在同一事务内完成。涉及项目中止时，校验主人确认的目标集合。

[人工事项测试](../../packages/cell/test/human-items.test.ts) [HTTP 接口测试](../../apps/gtd-desk/test/api.test.ts)

<a id="bug-016"></a>

## BUG-016　人工行动只出现一次

项目人工行动以其自身编号进入待我处理，操作备注交回负责分身。重复刷新同一事项保留稳定标识。

[项目行动测试](../../presets/test/project-books.test.ts) [人工事项测试](../../packages/cell/test/human-items.test.ts)

<a id="bug-017"></a>

## BUG-017　识别没有推进来源的等待

等待总助理、形成环路，或等待一个已暂停的对象，均需检查实际推进来源。单有一个常驻节点不能让工作一直被认作在途。

[停滞与等待测试](../../packages/cell/test/docs05-anchors.test.ts)

<a id="bug-018"></a>

## BUG-018　对共同阻塞只处理一次

多个项目报告相同故障时，由总助理协调一次修复。保留每个等待方的引用，确认修复后分别发回结果。

[跨项目协调测试](../../presets/test/scenario-blockers.test.ts) [停滞与等待测试](../../packages/cell/test/docs05-anchors.test.ts)

<a id="bug-019"></a>

## BUG-019　按照真实工作目录执行

派工要说明是代码仓库还是资料目录，工作前核查实际路径。后台命令沿用宿主可执行路径，项目通过返回结果及完整证据引用核对现场。

[宿主目录测试](../../packages/cell/test/workspace.test.ts) [命令行环境测试](../../packages/loop/test/cli-env.test.ts)
