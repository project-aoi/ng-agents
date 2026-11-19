# 上下文交付物（`Artifact`）、提示词组装与偏好治理缺陷单

> **状态**：`fixed（2026-11-19）`  
> **发现来源**：[2026-11-18 trae-x 真实端到端压测审计](./audits/2026-11-18-traex-live-e2e.md)  
> **关联设计原则与用例**：[01-product-principles.md](../01-principles/01-product-principles.md)（`P-UX-1`、`P-UX-7`）、[02-kernel-principles.md](../01-principles/02-kernel-principles.md)（`P-KERN-5`）、[uc03](../02-workflows/uc03-human-collaboration-and-engage.md)、[uc04](../02-workflows/uc04-someday-research-and-reactivate.md)

---

## `BUG-006`（P1）：`save_artifact` 升版丢标题 Bug，且缺少局部 `patch_artifact` 引发 38 次分页读写风暴 {#bug-006}

- **精确源码位置**：
  - [packages/context/src/artifacts.ts](../../packages/context/src/artifacts.ts#L112-L114)
  - [packages/loop/src/tools/context.ts](../../packages/loop/src/tools/context.ts#L44-L101)
  - [packages/context/src/evidence.ts](../../packages/context/src/evidence.ts#L141-L159)
- **实测触发证据**：
  1. **升版抹空标题**：项目一终审 `worker` 更新 `art_01m7qp83jt00001ke2qpjd` 至 `v2` 时未重复传 `title` 参数，`artifacts.ts` 执行 `UPDATE artifacts SET title = ?` 直接把 `v1` 的标题覆盖成了 `NULL`。
  2. **全量读写分页风暴**：项目二第 2 棒补证 `worker` 只需修正 140 KB 报告中的几处侧车/遥测结论，但因只有全量覆盖的 `save_artifact` 且 `read_resource` 单页上限仅 `8,000` 字符，被迫先连发 **19 次 `read_resource`** 搬入全文、重吐 148 KB `v2`、又连发 **19 次 `read_resource`** 回读校验（累计 **38 次分页调用**，消耗 `5.42M` tokens）。
- **目标修复方向（对齐 `INV-UC03-03` 与 `P-KERN-5`）**：
  - 修复 `artifacts.ts` 更新语句为 `title = COALESCE(?, title)`（仅在显式传入非空新标题时更新，否则保留原标题），并补单元测试；
  - 新增带 `expectedVersion` 乐观锁保护的局部修订工具 `patch_artifact`（支持按目标片段/章节替换或追加），并适当放宽显式读取资源时的单页字符上限。
- **修复结论（`fixed（2026-11-19）`）**：
  - 升版未传标题时保留原标题，只有显式传入非空新标题才替换（[packages/context/src/artifacts.ts](../../packages/context/src/artifacts.ts)）。
  - 新增工具 `patch_artifact`：在 `expectedVersion` 保护下做 `replace` / `append` / `prepend` / `replace_section`（Markdown 章节替换到同级或更高级标题为止）局部修订，版本过期时不覆盖、按 `save_artifact` 的冲突方式报告（[packages/loop/src/tools/context.ts](../../packages/loop/src/tools/context.ts)）。
  - `read_resource` 默认单页仍为 8,000 字符，显式传 `limit` 时单页最多 64,000 字符（[packages/loop/src/tools/context.ts](../../packages/loop/src/tools/context.ts)、[packages/context/src/evidence.ts](../../packages/context/src/evidence.ts)）。
  - 回归测试：[packages/context/test/artifacts.test.ts](../../packages/context/test/artifacts.test.ts)（「a version saved without a title keeps the artifact's title; only a non-empty new title replaces it (BUG-006)」）、[packages/loop/test/tools.test.ts](../../packages/loop/test/tools.test.ts)（「kernel.context」下的「patch_artifact」组，以及「reads/writes state, notes, skills, search and resources」中的 `read_resource` 分页断言）。

---

## `BUG-007`（P1）：提示词组装重复注入、全局偏好缺作用域、禁词规则误伤技术术语、只读指令自虐化 {#bug-007}

- **精确源码位置**：
  - [packages/context/src/hydrate.ts](../../packages/context/src/hydrate.ts#L84-L133)
  - [apps/gtd-desk/src/agent/tools.ts](../../apps/gtd-desk/src/agent/tools.ts#L635-L642)、[apps/gtd-desk/src/agent/guide.ts](../../apps/gtd-desk/src/agent/guide.ts#L140-L145)
  - [presets/src/shared/prompts.ts](../../presets/src/shared/prompts.ts#L19-L28)、[prompts.ts](../../presets/src/shared/prompts.ts#L120-L139)
- **四个子缺陷拆解**：
  1. **已内联技能重复列在 `# Skills` 诱发冗余读取**：`hydrate.ts` 启动 `project` 时已将 `project-relay` 全文内联进系统提示词，却仍在 `# Skills` 索引区列出 `skill://project-relay`，导致 3 个项目协调器第 1 轮开局全部白调一次 `read_resource("skill://project-relay")` 重复往上下文塞入 4.4 KB。
  2. **长期偏好（`save_preference`）无目录与角色作用域**：偏好一律全局无差别注入所有 `Cell`——把针对 `trae-x` Rust 改码的严苛门禁塞进了所有只看 CI 的轻量 `watcher`、静态调研报告结尾（机械背诵“未挂 `Upstream-Commit` 尾注”）以及未来其他无关项目。
  3. **禁内部术语规则过宽，误伤被分析源码的技术专有名词**：`prompts.ts:19` 写死 `no "cell", "run", "queue", "epoch", "token"`，导致模型在撰写 `trae-x` 技术报告时把源码标识符 `code_cell.rs` 强行翻译成「代码单元追踪」、把 `token` 翻成「令牌代际」、把 `queue` 翻成「待冲刷引用」，严重损害技术文档可读性。
  4. **只读指令层层加码自虐 & 巨无霸附录原始路径倾倒**：协调器派只读调研单时自行加码禁 `git fetch` 与 `GIT_NO_LAZY_FETCH=1`，逼得 `worker` 在 partial clone 仓库上撞慢失败并耗费 19 分钟在 `/dev/shm` 手搓内存对象库；同时未约束报告篇幅结构，导致项目二把 808 个测试/快照命中路径逐行贴出 123 KB 附录（占全文 84%）。
- **目标修复方向（对齐 `P-UX-1`、`P-UX-7`、`P-SAFE-2`）**：
  - `hydrate.ts` 从 `# Skills` 待读索引中过滤掉已内联进当前角色系统提示词的技能名称；
  - 为偏好存储与 `save_preference` 增加可选 `cwdPrefix?: string` 与 `roles?: string[]` 过滤条件（不传则保持全局通用，向后完全兼容）；
  - 精确改写 `prompts.ts:19`：禁止向用户暴露 `ng-desk` 工作台自身的内部调度黑话，但**必须原样保留被分析代码库、协议与工程领域的真实文件名、标识符及标准技术术语**；
  - 在 `project / worker` 提示词中明确：只读分析允许正常只读 `git fetch`、按需拉取 Git 对象与 `/tmp` 临时文件；调研报告聚焦架构结论与核心生产路径，大批量测试/机械匹配仅给聚合统计与规则，禁止倾倒上百行原始路径清单。
- **修复结论（`fixed（2026-11-19）`，四个子项全部完成）**：
  1. **已内联技能不再列入 `# Skills`**：`hydrate` 从待读索引中滤掉已内联进当前角色系统提示词的技能，滤完为空时不再输出索引（[packages/context/src/hydrate.ts](../../packages/context/src/hydrate.ts)）。
  2. **偏好作用域**：偏好可用 `cwdPrefix`（绝对目录）与 `roles` 限定适用范围（`KnowledgeApplies`，上下文 schema v4 新增 `applies` 列，旧行为空即全局适用）；`save_note` 与控制面的 `save_preference` 均可传入，普通笔记不接受这两个限定（[packages/context/src/knowledge.ts](../../packages/context/src/knowledge.ts)、[packages/protocol/src/schema/context.ts](../../packages/protocol/src/schema/context.ts)、[packages/loop/src/tools/context.ts](../../packages/loop/src/tools/context.ts)、[apps/gtd-desk/src/agent/tools.ts](../../apps/gtd-desk/src/agent/tools.ts)）。
  3. **禁词规则收窄**：`COMMON` 只禁止把工作台自身的调度机制写进给人看的文字，并写明被描述代码或系统的真实文件名、标识符、命令、分支名与协议 / API 术语（如 `code_cell.rs`、`token`、`queue`、`epoch`）一律原样保留、不翻译不转述（[presets/src/shared/prompts.ts](../../presets/src/shared/prompts.ts)）。
  4. **只读工作与报告篇幅**：`project` 与 `worker` 提示词写明只读工作可以 `git fetch`、构建、跑测试并在临时目录写草稿文件，协调器不要再自行加码禁令；报告给结论与支撑推理，大批量证据只给数量与规则，不倾倒原始路径清单（[presets/src/shared/prompts.ts](../../presets/src/shared/prompts.ts)）。
  - 回归测试：[packages/context/test/hydrate.test.ts](../../packages/context/test/hydrate.test.ts)（「does not list an inlined skill again as one to read on demand; with nothing else left there is no index」及「hydrate: preferences limited to a directory or a role」组）、[packages/context/test/knowledge.test.ts](../../packages/context/test/knowledge.test.ts)（「limits only preferences, to an absolute directory and/or role names」）、[presets/test/conventions.test.ts](../../presets/test/conventions.test.ts)（「conventions: every prompt names only tools its role has」：校验各角色提示词只点名本角色拥有的工具，`COMMON` 中的术语示例列为非工具词）。子项 3、4 为提示词措辞，测试中没有针对其文字本身的断言。
