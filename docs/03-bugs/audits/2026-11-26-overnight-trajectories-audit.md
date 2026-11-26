# 2026-11-25/26 跨夜双机全轨迹审计（`traecli` + `GPT-6.1-Sol xhigh`）

> 审计时间：2026-11-26（只读快照，未修改远端数据或代码）
> 审计方法：通过 6 路分片并行通读 + 1 路独立跨机复核，覆盖两台开发机（记为**主机 201**、**主机 233**）在 2026-11-25 下午至 11-26 早间的全部 `ng.db` 记录、原始 `traecli` rollout JSONL、后台 job 日志、`logs_2.sqlite`、用量库及对应源码，并对照本仓库 `main@3f07a55` 核对每项根因是否同样存在于公开主线。
> 审计原则：**看轨迹不看最终结果**——强模型会替误导性提示词、坏游标和内核摩擦兜底，但过程里的额外 token、空转、重读、误判与隐性崩坏只能在原始轨迹里看见。

---

## 一、总览与结论

### 核心发现（最该优先聊的 5 件事）

1. **`wait()` 异化为“下班打卡按钮”叠加 `RUN_ENDED_NOTICE` / `"OK"` + 10 秒硬中断（B2）**：内核本就按自然结束 turn + 真实锚点结算，但 `wait` 被做成带 `endRun` 的通用收尾工具，导致两机 **605 次** `wait()`（`project` 97.5% 回合、`worker` 63.7% 回合，其中 ~90% 无需写 `cell_waits`）并触发 **615 次** `RUN_ENDED_NOTICE`；其中 **521 次（84.7%）** 打包在工具块内、**94 次（15.3%）** 为纯多余独立调用，合计 **549 次**收尾全上下文推理耗费 **1.123 亿输入 token（占总输入 9.38 亿的 11.97%）**、**61.0 分钟**，制造全部 68 次 `<turn_aborted>` 里的 **66–67 次（98.5%）**，还把项目协调者训出条件反射对用户可见记录直接回裸 `"OK"`（A7）。
2. **19:51–20:03 两机集体「失忆重启」并非进程崩溃，而是存 1 条全局偏好一锅端掉所有活会话（B1）**：两台 Node 服务全程零重启。保存 1 条 `applies=null` 的磁盘巡检偏好触发全员 `refreshPrefixSync`，改写 `prompt_prefixes.hash` 导致 `own.systemHash === snapshot.system.hash` 失败，直接作废并冷重建 **22/22 个在跑原生会话**（重放 **3.79 MB**、首轮 uncached 消耗 **169 万 token**；加上切 `cwd`/切模型/早期偏好，100% 解释全部 **28/28 次**冷恢复）。
3. **上下文污染与假状态误导（A1 / A2 / A3 / C1）**：
   - 主台与信源默认 `cwd` 落在宿主 git 仓内，**9/9 份** rollout 被注入 ~14.5 KB 无关的宿主 `AGENTS.md`（且软链触发二次注入），233 主台直接把无关项目的数据库 WAL/SHM 边界抄进了磁盘清理规范；
   - 非主台 cell 没隔离 `TRAE_HOME`，**49/49 份** rollout 被注入 ~22.5 KB 过时历史 `MEMORY_SUMMARY`（280 次 `<oai-mem-citation>` 泄露）；
   - `inspect_cell` 游标因 `afterSeq <= cursor` 在首次截断后**永久卡死（13/21 条游标）**，内核持续喂假未读数（单分身高达 1,804 条假未读）；
   - 冷恢复把 4 小时前过时的 `[original task]` **重复塞 2 遍（23/28 次）**，且 `[references]` 截断拼回导致 **20/20 份摘要**被残缺 URI 吃掉 33%–42% 预算。
4. **单份共享报告踩踏与截断悬崖（B4）**：8 个分身同时改 1 份报告推到 **v47**（v45 膨胀到 84 KB，v46 一刀砍掉 -88.5%），另有多份报告刷到 v30/v29/v19；`read_artifact` 超过 12 KB 就悬崖截断到 4 KB（**200/279 = 71.7%** 溢出），所有 7 次乐观锁冲突都在这份共享报告上。
5. **`233` 下游分支（`7f5626b` `cli-input.ts`）独有两处严重回归（R1 / R2）**：`prepareRun` 消化的消息永远不入 `acceptedEnvelopeIds`，把 `desk` 游标永久锁死在 `1977` 反复重投旧结果，攒满 `MAX_IDS=512` 会直接抛异常变砖；同时 230 条 `原生消息接纳记录` 刷屏泄露进 rollout **459 次**、`inspect_cell` **25 次**，且 85%（91/107）的 LLM 回合在 `endOutcome` 提前 return 绕过了 `completeCliInput()`。

### 全量覆盖与量化基线

| 指标 | 主机 201 | 主机 233 | 合计 |
| --- | ---: | ---: | ---: |
| 下游分支 / 提交 | `feat/ng-agents-super-agent@68784bd` | `fix/pinned-desk-model-switch@d46ac0d` | 相差 34 个提交 |
| 服务端连续运行（CST） | 11-25 15:17:58 起（0 重启） | 11-25 16:04:22 起（0 重启） | 19:51–20:03 无服务崩溃 |
| Cell 总数（覆盖率） | **21 / 21**（全 LLM） | **9 / 9**（7 LLM + 2 code checker） | **30 / 30（100%）** |
| 原始 Rollout JSONL（覆盖率） | **44 / 44**（0 遗漏） | **12 / 12**（0 遗漏） | **56 / 56（100%）** |
| 冷恢复 Rollout 数 | 23 | 5 | 28（100% 归因） |
| `evidence` 总条数（`system_note`） | 20,267（0） | 3,339（283） | 23,606（283） |
| 回合数（runs / error） | 705（1 次 60m 超时） | 160（0 error） | 865（1 error） |
| LLM API 调用数 | 4,166 | 607 | 4,773 |
| 输入 Token（缓存命中率 / 未命中） | 832.36M（95.34% / 38.77M） | 106.13M（95.04% / 5.26M） | **938.49M**（44.03M 未命中） |
| 输出 Token（其中 reasoning） | 4.58M（2.34M） | 0.69M（0.35M） | **5.28M**（2.69M） |
| 工具调用数（`isError: true` / 未配对） | 8,137（315 = 3.87% / 0） | 1,184（41 = 3.46% / 0） | 9,321（356 / 0） |
| 后台 Job（成功 / 失败 / 取消 / 运行中） | 193（81 / 103 / 8 / 1） | 48（32 / 15 / 1 / 0） | 241（113 / 118 / 9 / 1） |
| 文稿数 / 版本数 / `artifact_parked` | 16 / 172 / 0（最高 v47） | 3 / 22 / 0（最高 v19） | 19 / 194 / 0 |
| `wait()` 次数 / 超时次数 / 停滞事件 | 518（0 设超时）/ 0 / 0 | 87（0 设超时）/ 0 / 0 | 605 / 0 / 0 |
| `job.warning`（300s 静默唤醒） | 44 | 7 | 51 |
| Rollout `turn_aborted (interrupted)` | 54 | 14 | 68 |

### 跨分支影响范围矩阵（公开 `main@3f07a55` vs `201` vs `233`）

| 编号 | 问题摘要 | 公开 `main@3f07a55` | 主机 201 (`68784bd`) | 主机 233 (`d46ac0d`) |
| --- | --- | :---: | :---: | :---: |
| **A1** | 默认 cell `cwd` 落入宿主 git 仓，注入无关 `AGENTS.md` + 软链双注入 | **存在** | 命中（5/5） | 命中（4/4） |
| **A2** | `inspect_cell` `pull:*` 游标永久卡死，持续喂假未读 | **存在** | 命中（9/15 游标） | 命中（4/6 游标） |
| **A3** | 冷恢复 `[original task]` 重复 2× + `[references]` 截断腐烂 | **存在** | 命中（20/23 恢复） | 命中（3/5 恢复） |
| **A6** | `update_cell` 缺 `cwd` → 旧 skills、假工作树警告、真实 `index.lock` 撞车 | **存在** | 命中（384 警告 + 1 撞车） | 命中（4 警告） |
| **A7** | 叶分身/信源提示词灌入主台技能 + `ship-mr` 规则打架 + `"OK"` 泄漏 | **存在** | 命中 | 命中 |
| **A8** | `job_observe`/跨 cell URI/`read_state` 漏保留键/`read_artifact` 缺结构化版本/叶节点 `working_note` 不回注 | **存在** | 命中 | 命中 |
| **B1** | 存全局偏好触发全员 `refreshPrefixSync` → 批量冷重置所有活会话 | **存在** | 命中（18 cell） | 命中（4 cell） |
| **B2** | `RUN_ENDED_NOTICE` 多跑全上下文 `"OK"` 回合 + 10s `<turn_aborted>` | **存在** | 命中（524 次） | 命中（91 次） |
| **B3** | 60 分钟超时释 claim 三投 + `steer()===false` 队列饥饿 | **存在**（`codex.ts` 同样无实时 steer） | 命中（`94ra3n`） | 部分缓解（`endOutcome` 仍跳过） |
| **B4** | 共享报告踩踏（v47）+ `read_artifact` 12KB→4KB 截断悬崖 + 冲突全文倾倒 | **存在** | 命中（171/240 溢出） | 命中（29/39 溢出） |
| **B5** | `job.warning` 只看 `output.log` mtime → 90.2% 重定向假警报 + 超时抢跑 | **存在** | 命中（44 次） | 命中（7 次） |
| **B6** | `job_start` 默认 `stdio:["pipe",fd,fd]` 悬空 stdin 死锁 | **存在** | 潜伏 | 命中（185.5s） |
| **B7** | `send_message` 默认强唤醒（`quiet` 仅 8.7%）+ 协调者 `xhigh` 瓶颈 | **存在** | 命中 | 命中 |
| **B8** | `trae.ts` `"backgrounded"` 重复 `tool_call` + 丢 `exitCode` 记 `"failed"` | 仅下游 `trae.ts` | 命中（60 重复） | 命中（34 重复） |
| **B9** | `add_source` 建完即空跑 + 无协调多 checker + 200 字硬截状态 + 残留 `silent_inject` | **存在** | 命中 | 命中 |
| **R1** | `desk` 无限重投 `prepareRun` 已处理结果 + `MAX_IDS=512` 抛异常变砖 | **无**（主线无 `cli-input.ts`） | 无 | **回归（`7f5626b`）** |
| **R2** | 230 条 `cliInputReceipt` `system_note` 刷屏泄露 + 85% 跳过 `completeCliInput()` | **无** | 无 | **回归（`7f5626b`）** |
| **C1** | 非主台未隔离 `TRAE_HOME`，注入宿主过时 `MEMORY_SUMMARY` | 下游+主线均未给 worker 隔离 CLI home | 命中（40/40） | 命中（9/9） |

---

## 二、系统误导明细（A1–A9）

### A1（P0）默认 cell `cwd` 落在宿主仓库内，注入无关 `AGENTS.md` 与软链二次注入

- **根因**：[boot.ts:92](../../../apps/gtd-desk/src/server/boot.ts#L92) 与 [manager.ts:50](../../../packages/workspace/src/manager.ts#L50) 将未指定目录的 cell（`desk`、`src_*`）默认目录设为 `<dataDir>/cells/<cellId>`，即位于宿主 `trae-things` git 仓内部。CLI 运行时沿目录树向上扫描，自动注入约 14.5 KB 的宿主 `AGENTS.md`（另一项目《Things Agent 开发约束》）和宿主 `gitStatus`。此外在运行普通 `df` 后，Bash 解析 `/home → /data00/home` 软链再次触发 `AGENTS.md` 替换重注（+14.3 KB）。
- **轨迹实证**：两机 **9/9 份** `desk` 与 `src_*` rollout 全部被污染（201 5 份、233 4 份）。最直接的误导证据在主机 233：`desk` 在创建磁盘清理信源 `src_01m898sa01` 时（`seq=1609`），把无关的 Things 约束原话——「来源数据库及 WAL/SHM 继续遵守现有只读边界」——原封不动写进了磁盘巡检规范里。
- **已确认的解决方案**：未指定工作目录的 `desk` / `src_*` 默认 `cwd` 迁出任何宿主 git 仓库，改放独立空目录（如 `~/.ng-desk/cells/<id>` 或稳定隔离目录），并经 `realpathSync` 规整路径以彻底避免软链触发二次 `AGENTS.md` 注入。

### A2（P0）`inspect_cell` `pull:*` 游标永久卡死 → 内核反复喂假未读

- **根因**：[inspect.ts:232](../../../packages/cell/src/inspect.ts#L232) 在中间省略（head 20% + tail 80%）时，将 `resumeAfterSeq` 设为头部末尾序号（如 `#85`、`#103`），而返回正文同时展示了末尾 `toSeq`。之后协调者显式传更大的 `afterSeq` 继续往后看时，[inspect.ts:260-261](../../../packages/cell/src/inspect.ts#L260-L261) 的判断条件 `afterSeq <= cursor` 不再满足，游标从此**永久冻死**在首轮头部截断位。随后 [readmodel.ts:321](../../../packages/cell/src/readmodel.ts#L321) 每轮都在协调者 prompt 里注入 `new since your last inspect_cell: #86–#...`，与协调者自己白板上的已读记录直接打架。
- **轨迹实证**：两机 **13/21 条 `pull:*` 游标**永久冻死：
  - 主机 201：9/15 卡死。GPT 6.2 四个早期分身分别卡在 `#85/#268/#296/#1462`，Web UI 显示 **4,258 条假未读**（`+1240/+1081/+1103/+834`），协调者被迫在 65+ 个回合里反复面对矛盾提示，全年累计调 `inspect_cell` **267 次**（单回合最多 12 次），在 `board`/`implementation-map` 笔记里手动维护真实游标。
  - 主机 233：4/6 卡死。`proj_01m88w8v36 → cell_01m88wc0m8` 卡在 `#103`（显示 `1,804/1,820` 未读），`cell_01m88wc08e` 卡在 `#91`（`365/380` 未读），`cell_01m899fh34` 在 `desk` 与 `proj_01m899dnn8` 上双双卡在 `#1732`。
- **已确认的解决方案（方案 1）**：将 `pull:<targetId>` 明确定义为「检查者已检视到的最新高水位」——只要 `inspector` 读到 `toSeq > cursor`（无论本次是否因 head+tail 发生中间省略，也无论是否显式传了 `afterSeq > cursor`），都将游标推进到 `Math.max(cursor, toSeq)`；中间省略的 `more: true`、`resumeAfterSeq` 与提示行仍保留在本次返回正文中供当下按需补查，但不再永久冻结后续游标。

### A3（P0）冷恢复重复注入过时 `[original task]` 2 次 + `truncatingSummary` 截烂 `[references]`

- **根因**：
  1. [hydrate.ts:167-168,348](../../../packages/context/src/hydrate.ts#L167-L168) 在 `summary` 中嵌入 `[original task]`；同时冷恢复路径 [cli/loop.ts:240,268](../../../packages/loop/src/cli/loop.ts#L240) 把未经 `{ resumed: true }` 过滤的 `tailText(snapshot)` 拼进 `freshPrompt()`，把同一份可能已过时数小时的一期任务**注入两遍**。
  2. [summarize.ts:5-10](../../../packages/context/src/summarize.ts#L5-L10) 的 URI 提取正则没排除中文括号 `（）`（把 `res_01m88svzj50000sn0w9vah（约字符5840附近）` 粘成单个 token），且 [hydrate.ts:345-346](../../../packages/context/src/hydrate.ts#L345-L346) 把 `[references]` 截断在 `Math.floor(summaryMaxChars / 3)`（2,666 字符）时按字符硬切，下一轮压缩再把被截断的 `previousSummary` 喂回 `referencesIn()`，滚雪球产出大量碎片（`art_0`、`art_01m8`、`res://cell_`）。
- **轨迹实证**：**23/28 次**冷恢复 rollout 均重复出现 2 次 `[original task]`（201 20/23，233 3/5）；**20/20 份**压缩过的 `prompt_prefixes.summary`（201 17 份 + 233 3 份，共 133 次内核压缩）全部存在残缺 URI，占掉 8KB 摘要预算的 **33%–42%**。
- **已确认的解决方案**：
  1. **`[original task]` 去重 + 锚定最新目标（选项 B）**：冷恢复时若 `history` 已含 `summary` 或原始 `cell.task`，`tailText` 不再拼接第二份 `[original task]`；并且对 `project` 节点，压缩摘要/冷恢复优先锚定当前 `gtd:project` 里的最新目标与交付物（未更新过再回退到最初任务原话），避免改完方向后被几小时前的旧任务误导。
  2. **`[references]` 防切香肠与控预算**：正则收紧为严格 ASCII 合法 URI/ID 字符集（排除中文括号/标点并过滤不完整短碎片）；超预算时按**完整条目**丢弃最老的临时 `res://` 链接（绝不按字符腰斩），优先保留 `art_*`/`artifact://` 正式文稿引用，并将 `[references]` 预算上限从 1/3 下调（如 `min(1200, summaryMaxChars / 5)`）。

### A4 / A5（P0 / P1，仅 233 下游回归）
见第四节 **R1 / R2**。

### A6（P1）`update_cell` 未暴露 `cwd` → 复用分身钉死旧主仓，引发 388 次假警告与真实 `git index.lock` 撞车

- **根因**：`packages/cell/src/lifecycle.ts` 底层支持更新 `cwd`，但 [tools/cells.ts:187](../../../packages/loop/src/tools/cells.ts#L187) 的 `update_cell` schema 仅暴露 `title/watches/schedules/meta`，漏掉 `cwd`。项目进入实施阶段切到独立 worktree（`update_project({ cwd })`）后，已创建的复用分身仍永远绑定在旧主仓 `~/dev/trae-x`（落后远端 2,238 个提交）。
- **轨迹实证**：
  - 所有复用分身加载了旧版 `.agents/skills`（201 AGENTS.md 项目触发过时测试注册表 skill 冲突并撤回；请求标识清理项目跑了旧版 `poll_ci.sh` 在 Python 3.7 崩溃；验收分身跑相对路径 `rg` 4 次报错）。
  - [readmodel.ts:346,383,412](../../../packages/cell/src/readmodel.ts#L346) 对旧主仓刷出 **388 条**假的工作树并发警告（201 384 条 + 233 4 条，约 60.1 KB）。
  - **真实撞车**：201 GPT 6.2 中 `tr5aj` 与只读复核分身 `baye9fq` 的登记 `cwd` 不一致导致 `activeWorkspaces()` 失明——18:13:11.126 `tr5aj`（`ev#7914`）在 worktree 跑 `git cherry-pick`，125ms 后 `baye9fq`（`ev#7921`）在同一 worktree 跑 `git status --short --branch`（未带 `GIT_OPTIONAL_LOCKS=0`），当场打爆 `cherry-pick`（`index.lock: File exists`，`ev#7922` / `res_01m8933tys`），`tr5aj` 停滞 **7 分 24 秒**。
- **已确认的解决方案**：给 `update_cell` 暴露 `cwd`（且 `update_project({ cwd })` 返回时提示可同步更新仍在复用的子分身目录）；同时在只读查阅提示词中提醒并发目录做只读 git 检查尽量加 `GIT_OPTIONAL_LOCKS=0`（或优先用 `git worktree` 隔离）。

### A7（P1）角色错配提示词、规则互相打架与 `"OK"` 条件反射泄漏

- **根因与轨迹实证**：
  1. **非对称技能灌入**：[hydrate.ts:177](../../../packages/context/src/hydrate.ts#L177) 把全部 4 个全局技能（`domain-hub`、`project-relay`、`workspace-arbitration`、`habit-and-routine-discovery`）以及 `"Children: up to 16 concurrent, 0 more level(s) of spawning"` 灌给每个叶节点 worker 和定时 sensor；201 的 `df` 磁盘巡检 sensor（`src_01m898sywm`）为了跑一条 `df`，吃下 ~58 KB 系统上下文。
  2. **规则打架**：worker 提示词与 `project-relay` Pattern B 禁止 worker 起后台 job 轮询 CI，但仓库内 `ship-mr/SKILL.md` 明确指引执行 `poll_ci.sh`——201 `cell_01m88sz8hd` 在 11-26 早间撞上该矛盾，连起两轮 `poll_ci.sh`，并在第二次退出 3 秒后因信息竞态向协调者错报「当前没有失败项或未解决评论」（实际 exit 4 有 2 条未解决评论线程，`seq=1204`）。
  3. **`RUN_ENDED_NOTICE` 训练出空 `"OK"` 泄漏**：[cli/loop.ts:50,220](../../../packages/loop/src/cli/loop.ts#L50) 反复要求 `"otherwise answer with nothing but OK"`，导致 201 `proj_01m88sgd77` 在 Run #88（`ev#19136`）和 Run #92（`ev#19720`）零工具直接输出 `"OK"` 进入用户可见 `evidence` 并按 `completed` 退出。
- **已确认的解决方案**：
  1. **内置技能按角色 tag 过滤 + 叶节点配额文案修正**：`listSkills` 对带角色 tag（`desk`/`project`/`hub`）的内置技能按角色过滤（用户自定义全局技能保持开放）；`maxDepth === 0` 时 `describeBounds` 直接标明 `"Children: none (leaf cell)"`，不再出现 `up to 16 concurrent`；
  2. **明确仓库 skill 与 workbench 规则的优先级**：在 `workerPromptText` 写明运行外部命令/skill（如 `/ship-mr`）时仅执行创建/推送/开 MR 动作，跳过其中轮询 CI 或等人工合入的步骤，立刻交付 MR 链接交由项目派低成本 checker 跟进；
  3. **裸 `"OK"` 泄漏**：已由 **B2** 方案根治。

### A8（P1）工具契约与报错误导集合

以下 5 处均为公开 `main@3f07a55` 与下游共有的轻量但高频踩坑（**均已确认解决方案**）：

1. **`job_observe` 报错误导**：[port.ts:62](../../../packages/workspace/src/port.ts#L62) 在 `job.cellId !== cellId` 时抛出 `job "<id>" not found in this workspace`，而 [tools/workspace.ts:28](../../../packages/loop/src/tools/workspace.ts#L28) 文档没说明 job 是 cell 私有。201 AGENTS.md 复核分身 `v5kp4` 共享同一目录去查队友 job 时，触发了该项目全部 2 次 MCP 报错（`ev#15753–15756`）。→ **已确认方案（B）**：保持 `job_input`/`job_cancel` 仅限启动者私有，但放宽**同项目内跨 cell 只读 `job_observe`**；若跨项目或越权访问，报错明确提示归属权限而非 `"not found in this workspace"`。
2. **`search_history(scope="global")` 泄漏跨 cell 不可读 URI**：全局搜索返回其他 cell 的 `working_note://` / `reference://`，但 `read_resource` 按本 cell 解析直接 `not found`（201 `ev#12584`、`ev#19788`）。→ **已确认方案**：支持带 `cellId` 的跨 cell 只读 URI（如 `working_note://<cellId>/<name>`），或全局搜索返回可被 `read_resource` 直接打开的完整引用。
3. **`read_state` 泄漏内核保留键**：[tools/context.ts:26](../../../packages/loop/src/tools/context.ts#L26) 与 [store.ts:267](../../../packages/context/src/store.ts#L267) 未过滤 `cli:session`、`pull:*` 等内核私有键。201 `tbfxg` 冷恢复后读项目状态（`ev#13571`）被吐出 9,128 字符，内含 `proj` 的 `cli:session` 反而把业务键 `gtd:project` 截断。→ **已确认方案**：`read_state` 按前缀/全量列出时默认过滤内核保留键（`cli:*`、`pull:*` 等），仅在显式指定 `key` 时可读取。
4. **`read_artifact` 缺少结构化版本号**：[tools/context.ts:65](../../../packages/loop/src/tools/context.ts#L65) 只返回纯文本头，导致 201 `sxzfy`（`ev#16469–16470`）在 Code Mode 脚本里用正则抽版本号时错匹配到 ULID `art_01m88zwbsh00006v881681` 中的 `v881681`，提交了 `expectedVersion: 881681` 触发 77.1 KB 冲突倾倒。→ **已确认方案**：随 **B4** 在 `read_artifact` 返回结构化 `{ artifactId, version, totalChars, ... }`。
5. **叶分身 `working_note` 存了白存**：[readmodel.ts:550](../../../packages/cell/src/readmodel.ts#L550) 的 `if (!leaf)` 直接跳过了所有叶分身自存的 `working_note` 回注。仅 201 GPT 6.2 后 4 个分身就存了 26 次笔记（`94ra3n` 22 次、`9261n3` 4 次），回注次数为 `0`。→ **已确认方案（A）**：移除 `if (!leaf)` 限制，叶分身自存的 `working_note` 每次醒来同样回注（未存笔记的叶分身零开销）。

### A9（P1）早期 `Seed-Code` 误启动 + Code Mode 吞 MCP `isError: true` → 静默丢失 3 条主人偏好

- **轨迹实证**：201 `desk` 首轮（14:57，尚在 `68784bd` 修复之前）误以 `Seed-Code` 启动，在 Code Mode `exec` 中猜错 `{title, content}` 参数连调 3 次 `save_note` 全部返回 `isError: true`（`ev#6–12`）。因为 Code Mode 里 MCP 返回 `{ isError: true }` 不会 throw 异常，脚本照常打印「三条背景知识已保存」，主台当场向主人虚假确认「已保存」，3 条偏好静默丢失直到 15:18 人工重发。
- **当前状态**：`68784bd` / `d46ac0d` 已修掉 pinned desk 忽略 `models.json` 的启动 bug；但 Code Mode 调用 MCP 失败不抛异常的陷阱仍在。

---

## 三、明显跑得不顺畅明细（B1–B9）

### B1（P0）保存 1 条全局偏好 → 批量作废并冷重建全部 22 个在跑原生会话

- **根因**：
  1. [kernel.ts:305-324](../../../packages/cell/src/kernel.ts#L305-L324) 监听 `knowledge.changed`，对所有匹配的活跃/暂停 cell 同步调用 `context.refreshPrefixSync(c.id)`（原注释仅按 API 直连模型估算「that costs each of them one cache miss」）。
  2. 但对 CLI runner，[cli/loop.ts:252](../../../packages/loop/src/cli/loop.ts#L252) 校验 `own.systemHash === snapshot.system.hash`——哪怕只多了 96 字节全局偏好，哈希一变就直接**丢弃整个 warm CLI 会话**，走 `freshPrompt` 冷重放。
- **全部 28 次冷恢复 100% 归因**：
  - **22 次（78.6%）** 来自 19:51:44（201，+96B）和 19:52:17（233，+132B）保存的 `applies=null` 磁盘巡检偏好——命中**全部 18 个 201 在跑 cell** 与 **全部 4 个 233 在跑 LLM cell**，重放 **3.79 MB**（3.08 MB + 717 KB），首轮 uncached 输入烧掉 **1,689,094 token**（叠加 201 `desk` 顺手给 3 个编码项目广播 `steer_item`，引发 `tbfxg` Run 23 连续 7 次恢复查询、`sxzeg` Run 28 526s 重整、`tr5aj` 失忆误启 `--all-features` 编译再取消）。
  - 其余 **6 次**：3 次项目切 worktree `cwd`（201 17:22 / 17:41 / 18:27）、1 次 `desk` 切模型（201 15:18）、2 次初始 `desk` 保存偏好（201 15:19 / 233 16:10）。累计 28 次冷恢复仅首轮 uncached 就消耗 **2,001,746 token**。
- **讨论结论（暂不修改 / 降为低优先）**：保存全局偏好在日常使用中属极低频操作，昨晚两机合计首轮 uncached 仅占总输入 0.18%（1.69M / 938.49M）；体感放大主要来自叠加了 **A3**（冷恢复重复旧任务 + 截烂引用）及 `desk` 顺手给编码项目发了 `steer_item`。暂保留现有即时刷新语义，优先修好 **A3** 的冷恢复质量并引导 `save_preference` 合理填写 `applies` 范围；后续如有需要再考虑把活跃 CLI 会话的偏好更新改为增量 delta 注入。

### B2（P0）`wait()` 异化为“下班按钮”叠加 `RUN_ENDED_NOTICE` `"OK"` 税与 10 秒硬中断

- **引入背景（三阶段演进）**：
  1. **原生协议约束（`2de41dd`，2026-11-17）**：早年直调 API 时，工具返回 `endRun` 可直接 break while 循环且零成本；切到外置 CLI 后，返回 MCP `tool_result` 并不会让 CLI 结束 turn，CLI 必然再发一次 LLM 请求等待纯文本才能 `turn_end` 落盘退出。为避免直接强杀导致未配对 `tool_use` 损坏 `resume`，内核引入 `RUN_ENDED_NOTICE`（软劝退）+ `endRunGraceMs = 10_000`（超时 `interruptAndKill()`）+ `RUN_ALREADY_ENDED`（拒后续工具调用）。
  2. **修 `E09`（`1a2aea9`，2026-11-23）**：最初丢弃 `endOutcome` 后的收尾文字，导致模型在 `propose_project`/`request_approval` 之后补写给主人的答复丢失，于是改为保留收尾一句。
  3. **修 `M15`（`96845c9`，2026-11-24）**：保留收尾文字后，因 LLM 无法返回空字符串，模型在被迫多跑的那一轮里反复复述刚说过/发过的话；于是约定暗号 `"otherwise answer with nothing but \"OK\""`，并加 `worthKeeping()`（[cli/loop.ts:224](../../../packages/loop/src/cli/loop.ts#L224)）识别并吞掉 `"OK"`。
- **结构性根因与实测拆解**：
  - **内核本就不依赖 `wait()` 结束回合**：[dispatcher.ts:611-650](../../../packages/cell/src/dispatcher.ts#L611-L650) 与 [readmodel.ts:141-163,654-714](../../../packages/cell/src/readmodel.ts#L141-L163) 均按自然结束 turn + 真实状态（running job、活跃子 worker、待决卡、watch/timer）判定结算与防停滞。但 [tools/comms.ts:451-481](../../../packages/loop/src/tools/comms.ts#L451-L481) 把「登记跨节点/人等待」和「空操作版 `End this run and sleep`（不传 `waitingFor`）」混在同一个带 `endRun` 的 `wait` 工具里，且描述里点名 `a child's "inbox:<cellId>"` 与 `"external" (with a background job)`，把 `wait` 塑造成了每轮必按的下班打卡按钮。
  - **两机 `ng.db` 全量 605 次 `wait()` 拆解（~90% 完全多余）**：
    - `project`：**269 / 276 回合（97.5%）** 调了 `wait()`——其中裸 `wait` **122 次**（空操作）、`waitingFor="inbox:<子worker>"` **132 次**（与活跃子 worker 重复）、`human` **13 次**、`inbox:desk` **2 次**；
    - `worker`：**325 / 510 回合（63.7%）** 调了 `wait()`——其中 `waitingFor="external"` **178 次**（绝大多数在等自己的 `job_start`，与 running job 重复）、裸 `wait` **91 次**（49 次同轮刚调 `job_start`）、`inbox:<cell>` **56 次**；
    - `inline`（desk）：**11 / 23 回合（47.8%）** 调了 `wait()`（10 次裸 `wait`、1 次 `inbox:<cell>`）；`checker`（全脚本）：**0 / 53**。
  - **两机 56 份 rollout 共 615 次 `RUN_ENDED_NOTICE`（201 524 + 233 91；其中 `wait` 占 602 次 = 97.9%）**：
    - **521 / 615（84.7%）为打包调用（batched）**：与 `send_message`/`track_action`/`save_note`/`job_start` 写在同一个 Code Mode `exec` 块内（其中 57 次撞 10 秒强杀）。需注意：这部分即使去掉 `wait`，在标准 CLI tool-calling 循环里，`exec` 返回后仍会自然走一次收尾 LLM 调用；真正能把这部分 ~1 亿输入 token 彻底省掉的唯一方式是在 CLI 协议层支持静默收尾。
    - **94 / 615（15.3%）为独立调用（standalone）**：整块只调了 `endRun` 工具（其中 10 次撞 10 秒强杀），属于纯多余的整轮 LLM 调用。
    - **总账**：**549 次**收尾推理消耗 **`112,341,095` 输入 token（占总输入 938.49M 的 11.97%，含 1.90M uncached）**、仅换回 `4,622` 输出 token、白耗 **3,657.1 秒（61.0 分钟）**；**66–67 次**因 `endRunGraceMs = 10_000` 精准落入 `xhigh`“已发完请求却来不及吐完 `"OK"`”的最差区间而被强杀（占全部 68 次 `<turn_aborted>` 的 **98.5%**），且 80+ 轮 rollout 里的 `assistant: OK` 将 `proj_01m88sgd77` 驯化出 2 次无工具直接回裸 `"OK"`（`ev#19136`、`ev#19720`）。
- **已确认的解决方案**：
  1. **回归“自然结束 turn + 看真实锚点”的原设计，给 `wait` 彻底瘦身（P0，纯 `ng-agents` 侧）**：
     - 删除无 `waitingFor` 的裸 `wait`；从工具描述和提示词中移除“用 `wait` 结束回合 / 等自己的子 worker / 等自己的 `job_start`”，让细胞干完活或发起 `job_start`/`dispatch` 后直接自然结束 turn；
     - 仅保留极少数内核无法从一等公民状态推断的显式等待登记（① 跨节点发问/仲裁等回信，防漏答与防止 worker 提前结算；② 纯文本向主人提要求且未带问号时的 `pendingQuestion` 兜底；③ 显式 `timeoutMinutes`），改为**不带 `endRun` 的纯状态登记工具**（或在 `send_message` 上提供 `expectReply: true`）。
     - 同步把 [cli/loop.ts:221-224](../../../packages/loop/src/cli/loop.ts#L221-L224) 对本轮 `send_message` 重复正文的去重检查扩展到普通 `handle(text)`，防止无 `wait` 时在发完通知后把原文原样复述进分身实况。
     - **直接收益**：消掉 ~90% 的 `wait()`（500+ 次）、彻底清零 94 次多余独立回合、100% 消除 `"OK"` 驯化污染以及日常协调/job 里的 `<turn_aborted>` 强杀。
  2. **收敛并修复剩余极少数 `endRun` 安全闸门工具（`request_approval` / `propose_project` / `finish_project` / `pause_self` / `no_hit`，昨晚合计仅 13 次）**：
     - 保留 `endRun` 作为“提完审批卡/结项后绝不许同轮继续动手”的硬围栏，但将 `endRunGraceMs` 从 10 秒放宽到不会误杀 `xhigh` 收尾的值（如 30–60 秒），彻底逃离“钱花了、等 10 秒再强杀污染 `<turn_aborted>`”的最差区间。
  3. **（可选，CLI 协议层进一步省 ~12% Token）**：若后续可在 `traecli`（`app-server`）侧增加“工具结果落盘后、发起下一次 LLM 请求前静默收尾（不写 `<turn_aborted>`）”原语，可在 `personWaits === false` 的收尾回合直接省下打包调用后的最后一次全上下文 prefill。

### B3（P0）60 分钟超时释放 claim → 74 分钟后无标记三投 + `steer()===false` 饥饿 14.8 分钟

- **根因**：[dispatcher.ts:823](../../../packages/cell/src/dispatcher.ts#L823) 达到 3,600,000 ms 硬超时中止回合后释放 claim 并设 5s 退避重投；同时 [adapters/codex.ts:98](../../../packages/loop/src/cli/adapters/codex.ts#L98)（以及下游 `adapters/trae.ts`）的 `steer()` 固定返回 `false`，运行期间到达的消息只能干等本轮结束。
- **轨迹实证**：201 `cell_01m894ra3n` 的 `run_01m89g7mvn` 在 23:02:28 跑满 60 分钟（230 次工具调用）被杀（`ev#18971`），此前已处理的 4 条信封（`iseq=1065,1079,1084,1091`，原时间 22:02–22:43）被**投递了 3 次**：① 原始处理 → ② 23:02:29 `[Earlier events]` 重放（15.4 KB）→ ③ 23:16:43 在新回合运行中**无 `[delivered again]` 标记直接实时注入**（距原消息晚了 74 分钟，`ev#19163–19166`）。同时 12 条新消息因 `steer()===false` 排队饥饿最长 **890.9 秒（14.8 分钟）**。
- **已确认的解决方案**：
  1. **活回合不强制墙钟超时（改为无进展看门狗）**：将 [cli/loop.ts:379](../../../packages/loop/src/cli/loop.ts#L379) 的固定 60 分钟墙钟 `runTimeoutMs` 改为**空闲/无进展看门狗**（扣除宿主休眠时间）——只要 CLI 持续产生推进事件（`text` / `tool_start` / `tool_end` / `callTool` / `usage` 等），就不断续期、不强杀正在正常干活的回合；仅在真正卡死无进展超阈值（如 15–20 分钟）时中止（防死循环由已有 `maxSteps` 或更高安全兜底负责）；
  2. **真正超时后的续接不三投旧消息**：当回合已实际推进过却触发超时中止时，不再将整批已消费信封退回队列无标记重投，而是对齐 `step_limit` 语义——确认旧批次并入队 `kernel.run_continue (reason: "timeout")` 续接；
  3. **（按需增强）**：后续视 `traecli app-server` 协议支持情况，为 `trae.ts` 接入中途 `steer()` 能力以消除长回合内的紧急消息等待。

### B4（P0）单份共享报告严重踩踏（v47 / v30 / v29 / v19）+ `read_artifact` 12KB→4KB 截断悬崖

- **根因**：
  1. 提示词与 `project-relay` Pattern A 把多阶段、多 worker 导向持续修改同一份共享文稿。
  2. [evidence.ts:173-186](../../../packages/context/src/evidence.ts#L173-L186) 对超过 12 KB 的 `read_artifact` 返回直接悬崖截断为 4 KB（首尾拼接 + `res://` 溢出），逼得调用方每次都要多跳几轮 `read_resource` 翻页。
  3. [artifacts.ts:104](../../../packages/context/src/artifacts.ts#L104) 仅在 `agent` 撞 `human` 时 `park`，多 agent 并发写入只返回 `artifactConflict`（[tools/context.ts:85](../../../packages/loop/src/tools/context.ts#L85)）并把完整正文（62–77 KB）直接内联倾倒进工具结果。
- **轨迹实证**：
  - 201 `art_01m88zwbsh`（GPT 6.2 实现报告）被 **8 个分身**反复叠加写到 **v47**（v45 达 84,064 字符 / 742 行，v46 被汇总分身删掉 73,724 字符 [-88.5%] 缩回 9.7 KB）；201 请求标识清理的 2 份主报告被刷到 **v29 / v30**（含 6 组因「Worker+协调者双发回声」触发的单 run 双写）；233 MCP 报告刷到 **v19**。
  - 两机 **200/279 次（71.7%）** `read_artifact` 触发溢出（201 171/240，233 29/39）；201 全部 **7/7 次** `patch_artifact` 报错均为对 `art_01m88zwbsh` 的乐观锁版本冲突；两机 `artifact_parked` 均为 `0`。
- **已确认的解决方案（方案 1A + 读/冲突工具改造）**：
  1. **协作分工（1A）**：提示词区分「2–3 步串行接力」与「多路并行」——多路并行调研/实现时各分身写独立模块交付件或汇报，最终由协调者或 1 个汇总分身整理为唯一一份面向主人的精炼主报告，既不制造报告碎片又避免并行踩踏；
  2. **`read_artifact` 消悬崖 + 分页 + 结构化版本**：支持 `offset`/`limit`/`outline` 分页与目录查看，提高单次内联上限（如 24–32 KB）并在超上限时按整页返回（彻底消除 12KB→4KB 倒扣悬崖），同时在结构化字段中明确返回 `artifactId`/`version`/`totalChars`（同步根治 A8-4）；
  3. **冲突报错限长**：版本冲突仅在短文稿（如 ≤ 8 KB）时内联附正文；大文稿只返回 `currentVersion`/`updatedBy`/`totalChars` 与目录概要，避免 77 KB 全文倾倒。

### B5（P1）`job.warning` 300s 静默误报风暴 + 超时抢跑

- **根因**：[jobs.ts:323,331](../../../packages/workspace/src/jobs.ts#L323) 只检查 `statSync(live.logPath).mtimeMs`，既不看进程组 CPU 活跃度，也不感知 shell `> /tmp/*.log` 重定向（导致 `output.log` 永远 0 字节、300 秒必报）。
- **轨迹实证**：两机共 **51 次** `job.warning`（201 44 次 + 233 7 次），其中 **46/51（90.2%）** 属于带日志重定向的健康编译/测试；仅 2 次真正抓到挂死（其中一个 `233` `job_01m893yaaz` 自己已设 `timeoutMs=300s`，与 `jobQuietWarningMs=300s` 同时撞车，在 `job.result` 到来前 50 秒白烧 556K token）。233 光这 7 次唤醒就烧了 **602 万 token（占 233 全晚 5.6%）**，201 浪费 >23 分钟。
- **已确认的解决方案**：
  1. **叠加进程组 CPU 活跃检测**：到 300s 发现 `output.log` mtime 未更新时，扫描 job 进程组（pgid）累计 CPU 时间（Linux `/proc` `utime + stime`），只要 CPU 在增长（健康编译/测试）就不报警、顺延至下个周期，仅在「无输出且 CPU 近零」时才发 `job.warning`；
  2. **防超时抢跑**：若 `timeoutMs <= jobQuietWarningMs` 或距 `timeoutMs` 不足阈值（如 30–60s），不再发 `job.warning`；
  3. **工具说明补充**：在 `job_start` 描述中提醒输出已自动落盘供 `job_observe` 查看，勿盲目重定向到 `/tmp/*.log`。

### B6（P1）`job_start` 悬空 stdin pipe 导致非交互子进程死锁

- **根因**：[jobs.ts:223](../../../packages/workspace/src/jobs.ts#L223) 默认以 `stdio: ["pipe", fd, fd]` 启动所有后台 job，而两机 **241 个 job 中 `job_input` 使用次数为 0**。任何检测非 TTY stdin 并尝试读至 EOF 的子进程（如 `traecli exec` 的 `OptionalAppend`）都会永久挂死。
- **轨迹实证**：233 `cell_01m88wc0m8` 的 `job_01m89et80e` 挂死 **185.5 秒**（外加 94.4 秒排障回合）；给同一命令补上 `</dev/null` 后（`job_01m89f2kc2`）**12.5 秒**即完成。
- **已确认的解决方案**：`job_start` 默认改用 `stdio: ["ignore", fd, fd]`（接 `/dev/null`，非交互子进程立刻收到 EOF 绝不挂死），仅在调用方显式传 `interactive: true` 时才打开 stdin pipe（对非 interactive job 调 `job_input` 时返回明确提示）。

### B7（P1）`send_message` 默认强唤醒放大 + 协调者 `xhigh` 成为延迟瓶颈

- **根因与轨迹实证**：
  - [tools/comms.ts:153](../../../packages/loop/src/tools/comms.ts#L153) 的 `quiet: true` 未写入项目/分身提示词，两机仅用了 **78/899（8.7%）**（201 7.9%，233 21.6%），导致 **227 次 `<10s` 连续唤醒**（201 191 次 + 233 36 次）、25 次零工具纯回「收到」空跑、166 次运行中吸收、以及 **112+ 次**发完 `job_start` 后多余的 `wait()`。
  - 协调者 `project` 未降推理档位，全跑 `GPT-6.1-Sol@xhigh`（61.9% 输出为 reasoning），201 `proj_01m88sgd77` 单轮最慢达 **15 分 49 秒**（Run #96 949s、Run #37 880s、Run #38 853s），期间收件箱积压 8–12 条消息。
- **讨论结论（暂不修改）**：暂保持现有 `send_message` 默认行为与协调者模型/推理档位，后续观察去掉 B2 冗余回合后的实际吞吐再决定是否调整。

### B8（P1，下游 `trae.ts`）`"backgrounded"` 重复记账 + 丢 `exitCode` 记 `"failed"`

- **根因与轨迹实证**：下游 `packages/loop/src/cli/adapters/trae.ts`（201 L146–149 / 233 L224–227）在收到命令中间态 `status="backgrounded"` 时调用 `startedItems.delete(id)`，等命令真正结束时又发一遍 `tool_start`+`tool_end`，导致两机产生 **94 对重复 `toolUseId`**（201 60 + 233 34，含 53 条 `"backgrounded"` 中间结果，如 `forge-cli mr create` 被记两次）；同时对空 stdout 的非零退出命令（包括正常的 `rg` 无匹配 exit 1）丢失退出码，统一记成不透明的 `"failed"` + `isError: true`（26 次）。
- **已确认的解决方案**：将 `"backgrounded"` 视为进行中状态更新而非终态（不删 `startedItems`，命令真正 `completed`/`failed` 时再发 `tool_end`）；空 stdout 非零退出时保留 `exitCode`（如 `(no output, exit code 1)`）。

### B9（P1）Sensor / Checker 生命周期与状态卫生杂项

1. **`add_source` 建完即空跑**：创建 LLM sensor 时立刻触发一次 `cell.task` 仅为了调 `no_hit`（233 `src_01m898sa01` 白烧 **84,253 token** 且仍留 `runCount:0, lastRunAt:null`）；确定性的 `df -B1` 空间检查也被建成了 LLM sensor 而非脚本探针。→ **已确认方案**：带 `schedules`/`watches` 的 LLM sensor 创建时由内核直接初始化设定记录，不触发空跑 `cell.task`，等首次真实定时/命中再唤醒；提示词明确确定性命令检查优先用 `script` 零 token 探针。
2. **多监控互不知情 + Checker 字段写错（233 MR !5623）**：21:47–21:49 同时存在 **3 个监控者**（2 个 `gtd.check_probe` checker + 1 个 worker 轮询脚本，多烧 100 万 token）；Checker #1 查了不存在的 `SourceCommitId` 字段，**46/46 次轮询**输出的 `source=` 和 `merge=` 全是空的；两个 checker 的 `cell:result.summary` 都把截断的 Python 脚本代码塞进了摘要。→ **已确认方案**：`project` 派 checker 前核对 `[in-flight child cells]` 避免重复监控，脚本 checker 需确认检查字段真实非空，并清理脚本 checker 摘要格式避免把截断脚本代码塞进 summary。
3. **小细节卫生**：[tools/comms.ts:345](../../../packages/loop/src/tools/comms.ts#L345) 按 200 字符硬切状态行（切在词中间，如 `...源PNG IHD`）；201 休眠分身 `cell_01m88t1k8d` 上留有 1 条挂起超 13 小时的 `silent_inject`（`iseq=1102`）；`workspaces` 表未清理已关闭 cell 的 `"active"` 状态；`desk` 的 `cell:direct_chat.unsettled` 计数器从未归零（201 停在 5，233 停在 3）。→ **已确认方案**：状态行按词/句边界截断并补 `…`；关闭 cell 时同步更新 `workspaces` 状态为 `closed`；修复 `desk` `unsettled` 计数归零与休眠分身残留 `silent_inject` 清理。

---

## 四、主机 233 下游分支（`7f5626b` `cli-input.ts`）独有回归（R1–R2）

> 这两项不存在于公开 `main@3f07a55` 和主机 201（`68784bd`），均由主机 233 上新增的提交 `7f5626b`（`fix(ng-agents): 修复消息接纳确认与恢复去重`）引入，**在将 `233` 改动合并或同步至主线/`201` 前必须先修**。

### R1（P0）`desk` 无限重投已处理 `cell.result` + `MAX_IDS=512` 变砖炸弹

- **根因**：233 `desk` 的 `run_01m899xf8x`（20:12:02，`seq=1977..1979`）收到空 MR 项目的 `cell.result`（`seq=1978`）时，被 `preset.prepareRun` 直接返回 `"handled"` 消化，未进入 `core.loop.run`（`packages/cell/src/dispatcher.ts:716-746`，对应主线 [dispatcher.ts:735-761](../../../packages/cell/src/dispatcher.ts#L735-L761)）。
  - 但 `packages/cell/src/cli-input.ts:115-131` 的 `advanceAcceptedCursor` 要求 `seq=1978` 出现在 `cli:input:v1.acceptedEnvelopeIds` 才推进游标，结果 `cli:session.lastDeliveredEvidenceSeq` **永久卡死在 `1977`**（落后最新 `3339` 共 1,362 条）。
  - 后果一：`desk` 后续每次运行（20:56 / 21:38 / 22:20，Rollout #3 L97/L114/L158）全部被重复注入同一条过期的空 MR 完结通知。
  - 后果二：因为游标不推进，`acceptedEnvelopeIds` 永远无法裁剪（`cli-input.ts:154-169`），一旦累计到 `MAX_IDS = 512`（L8, L168）就会直接 throw 异常把 `desk` **永久卡死**。
- **已确认的解决方案**：`prepareRun` 返回 `"handled"`（不经 CLI 执行）的 inbound 信封在结算时直接标记为内核已消化/推进游标，绝不阻塞 `advanceAcceptedCursor`；同时对 `MAX_IDS` 提供对已 `done` 且非阻塞旧 ID 的安全清理/告警兜底，避免把 `desk` 永久卡死。

### R2（P1）230 条 `cliInputReceipt` `system_note` 刷屏泄露 + 85% 回合跳过 `completeCliInput()`

- **根因**：
  1. `cli-input.ts:93-94` 将内部接纳状态 `原生消息接纳记录：{unknown,accepted,resolved}。` 写入 `evidence` 表 `kind='system_note'`（共 230 条：107 `unknown` + 107 `accepted` + 16 `resolved`，占 233 全部 283 条 `system_note` 的 **81.3%**）。但 `hydrate.ts:270` 和 `inspect.ts:135-147` 未过滤 `cliInputReceipt`，导致这些内部记账文本 **459 次**泄露进 7 份 rollout、**25 次**泄露进 `inspect_cell`、**6 次**泄露进全部 3 份非空 `prompt_prefixes.summary`。
  2. 233 `packages/loop/src/cli/loop.ts:871-883` 在 `endOutcome && turn_end` 时提前 return，直接绕过了 `completeCliInput()`——**91/107 次（85.0%）** LLM 运行跳过了正常收尾确认。
- **已确认的解决方案（方案 A）**：将 `cliInputReceipt` 见证移出模型可见的 `evidence` 表，改存独立 append-only 见证表（如 `cli_input_witness`），彻底杜绝污染 rollout、`inspect_cell` 与压缩摘要；同时在 `endOutcome && turn_end` 提前返回路径前统一补齐 `completeCliInput()`。

---

## 五、剥离出的 CLI 运行时 / Code Mode / 宿主机环境问题（C1–C4）

以下问题根源在 `traecli` 或宿主机环境，但部分可在 `ng-agents` 侧通过隔离手段规避：

- **C1（P1）非主台 cell 继承宿主 `~/.trae/cli/memories`**：主台通过隔离 `TRAE_HOME`（`.../workspace/runtime/traecli`）做到 **0/7** 污染，但所有非主台 cell 共用宿主机 `~/.trae/cli`，导致 **49/49 份**非主台 rollout 被注入 ~22.5 KB 过时 `MEMORY_SUMMARY`（280 次 `<oai-mem-citation>` 泄露、反复读取不存在的历史 `/tmp` 文件）。**已确认方案**：为非主台 cell 禁用宿主 memory 注入（若 `traecli` 支持配置开关则直接关闭；否则像主台一样隔离 `TRAE_HOME`/`memories`，同时保留主人登录态与模型配置）。
- **C2（P1，`traecli` / Code Mode 侧跟进）Code Mode 使用摩擦**：延迟工具发现导致 **228 次** ~28 KB 的 `ALL_TOOLS` 拉取（201 185 + 233 43）；**35 次** JS `Script failed`（29 + 6）；`store()` 在 `wait()` 进程退出后丢失；`traecli` 内置 `<system-reminder>` 仍不断催促调用 `update_plan`（**134 次**提醒，白调 39 次）；MCP `isError: true` 在 JS 内不抛异常（促成 A9）；`read_state` 溢出把 JSON 截断在半中间直接让 `JSON.parse()` 崩溃（201 `ev#19504`，`ng-agents` 侧可顺手在溢出提示中标明截断内容非完整 JSON）。
- **C3（P2，宿主机 / `traecli` 侧跟进）Pinned Desk `logs_2.sqlite` 后台报错**：两机共 13 条 `ERROR`、580 条 `WARN`——每次拉起主台都报错启动不存在的 `ng-desk`/`things` MCP（`os error 2`）、记忆整理写死请求不可用模型 `GPT-5.4`、201 出现 **326 次** `os error 24`（FD/inotify 耗尽，233 有 53 次降级 `file_watcher`）、以及 TRAE `code=3004` / `400 rate_limit_exceeded` 限流重试（拖出 201 单轮 182s）。
- **C4（P2，宿主机环境侧跟进）宿主机工具链与目标仓库基线**：201 103/193（53.4%）job 失败主要来自目标仓基线已有 `unwrap_used` clippy 报错（88 次 exit 101）、默认 PATH 为 Python 3.7.3（打挂 `poll_ci.sh`）、老版本 `git` 缺 `-b`/`--show-current`、`bwrap` 缺 `/dev`/`/proc`、缺 `~/.cargo/bin` 与 `PIL`；233 15/48 失败主要来自 `forge-cli` 不在 PATH、JWT 过期、JSON 返回结构不一致、缺 `jq`/`Pillow`/`libopenjp2`/`tmux`。

---

## 六、已确认的修复执行清单（2026-11-26 讨论定稿）

### P0 · 立即修复
1. **下游阻断项（233 `7f5626b` · R1 + R2）**：`prepareRun("handled")` 推进游标并防 `MAX_IDS=512` 爆仓（R1）；`cliInputReceipt` 见证移出 `evidence` 改存独立 append-only 表，并在 `endOutcome && turn_end` 补齐 `completeCliInput()`（R2）。
2. **回归自然收尾、根治 `wait` / `"OK"` / 10s 强杀（B2）**：删掉裸 `wait` 与等子 worker/`job_start` 的多余 `wait`，将显式跨节点/人等待降级为不带 `endRun` 的纯状态登记；对普通 `handle(text)` 扩展本轮 `send_message` 原文去重；放宽剩余极少数闸门工具（`request_approval`/`propose_project`/`finish_project`/`pause_self`/`no_hit`）的 `endRunGraceMs`（可选后续再在 `trae-x` 侧加静默收尾省 ~12% 打包收尾 token）。
3. **消除假状态与上下文污染（A2 + A3 + A1 + C1）**：`inspect_cell` 的 `pull:<targetId>` 改高水位 `Math.max(cursor, toSeq)`（A2）；冷恢复 `[original task]` 去重并优先锚定 `project` 最新目标、`[references]` 严格 ASCII 正则 + 按整条裁剪控预算（A3）；默认 `desk`/`src_*` `cwd` 迁出宿主 git 仓并 `realpathSync` 规整（A1）；非主台 cell 关闭/隔离宿主 `MEMORY_SUMMARY`（C1）。
4. **活回合不强制墙钟超时 + 共享文稿防踩踏（B3 + B4）**：固定 60m 墙钟超时改为扣休眠的无进展空闲看门狗，真正超时走续接不三投旧消息（B3）；提示词区分串行接力与多路并行（1A），`read_artifact` 支持分页/目录、消 12KB→4KB 悬崖并返回结构化版本，冲突大文稿不内联吐全文（B4）。

### P1 · 协同与后台任务顺畅度
5. **后台任务可靠性（B5 + B6）**：`job_start` 默认 `stdio: ["ignore", fd, fd]`（可选 `interactive: true`）（B6）；300s 静默告警叠加进程组 CPU 活跃检测、临近 `timeoutMs` 不抢跑并提醒勿盲目重定向（B5）。
6. **工具契约、目录更新与角色边界（A6 + A7 + A8）**：`update_cell` 暴露 `cwd` 并提醒并发只读加 `GIT_OPTIONAL_LOCKS=0`（A6）；内置技能按角色 tag 过滤、`maxDepth===0` 标明叶节点、明确 `/ship-mr` 跳过轮询 CI（A7）；移除 `if (!leaf)` 恢复叶分身 `working_note` 回注、放宽同项目只读 `job_observe`、过滤 `read_state` 保留键、支持跨 cell 只读笔记 URI（A8）。
7. **下游适配器与生命周期卫生（B8 + B9）**：下游 `trae.ts` 将 `"backgrounded"` 视为进行中状态且保留 `exitCode`（B8）；定时 LLM sensor 建完不空跑 `cell.task`、确定性检查优先 `script`、派 checker 防重复并校验字段、清理状态行硬截与 `workspaces`/`unsettled`/`silent_inject` 残留（B9）。

### 暂不修改 / 外部跟进
8. **暂保留现状（B1 + B7）**：全局偏好刷新属低频操作，暂不拆解 `prompt_prefixes.hash`（优先靠 A3 保障冷恢复质量）（B1）；暂不改 `send_message` 默认强唤醒与协调者 `effort` 档位（B7）。
9. **`traecli` / 宿主机环境侧跟进（A9 + C2–C4）**：Code Mode MCP `isError` 抛错策略、`update_plan` 提醒降噪、宿主机 FD/inotify 与工具链基线。

---

## 七、附录：30 个 Cell 覆盖简表与复核修正记录

### 复核阶段驳回 / 修正记录

1. **驳回误判**：初审曾怀疑 201 请求标识清理项目 `auth_2` L36 出现「`traecli exec_command` 在 Python `AssertionError` 时返回 `exit_code: 0`」。核对原始 rollout 后证伪：模型在 bash 命令里写了 `python3.11 ...` 后直接换行接 `git diff --check` 且**没加 `set -e`**，Python 退出 1 后 bash 继续跑了 `git diff --check`（退出 0），属于模型在单块脚本中未做错误处理就投机群发 `send_message`，不是 `exec_command` 吞退出码。
2. **补全漏报**：233 初审漏报了 `inspect_cell` `pull:*` 游标卡死；复核核对 233 `inspect.ts` 与 `cell_state` 确认 233 同样有 **4/6** 游标卡死（合计两机 13/21）。
3. **口径校准**：233 `cliInputReceipt` 泄漏进摘要的精确口径为 **3/3 份非空摘要中共 6 处**（而非 6 份摘要）；233 `desk` Rollout #3 的三处重复注入 1-based 行号为 L97/L114/L158。

### 主机 201（21 Cells / 44 Rollouts）

| Cell | 角色 | 状态 | Evidence | Runs | Tool Calls (`isErr`) | Rollouts | 任务标题 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `desk` | inline | active | 217 | 14 | 79 (3) | 4 | 主台 |
| `proj_01m88sgd77` | project | active | 2,625 | 98 | 1,050 (7) | 3 | GPT 6.2 harness 移植实现 |
| `cell_01m88smdn3` | worker | active | 1,347 | 46 | 540 (27) | 2 | 追查图片预算显式关闭的 TUI 冷恢复 |
| `cell_01m88sxzeg` | worker | active | 1,151 | 29 | 459 (39) | 2 | 实现 Code Mode 有界输出收集与呈现 |
| `cell_01m88sxzfy` | worker | active | 1,189 | 37 | 491 (26) | 2 | 实现 6.2 同步/异步提问与 TUI 交互 |
| `cell_01m88tr5aj` | worker | active | 918 | 34 | 367 (22) | 2 | 实现历史恢复边界与有效答复保留时序 |
| `cell_01m890cx8z` | worker | active | 927 | 30 | 382 (23) | 2 | 适配 TRAE raw chat 的增量工具目录 |
| `cell_01m89261n3` | worker | active | 760 | 12 | 332 (21) | 2 | 独立复核合并后的增量目录请求锁 |
| `cell_01m894ra3n` | worker | active | 1,668 | 36 | 698 (26) | 2 | 准备最终集成与真实 TRAE TUI 验收 |
| `cell_01m89557vs` | worker | active | 505 | 18 | 192 (13) | 2 | 落实 6.2 compact 空摘要的安装边界 |
| `proj_01m88stvds` | project | active | 1,626 | 82 | 638 (0) | 3 | TRAE 与第三方请求标识清理 |
| `cell_01m88sz8hd` | worker | active | 1,636 | 71 | 632 (20) | 2 | 提交请求标识清理 MR 并合入 develop |
| `cell_01m88t1k8d` | worker | active | 618 | 28 | 237 (4) | 2 | 验证请求标识清理的真实 CLI 与 TUI |
| `cell_01m88v4ps4` | worker | active | 1,053 | 25 | 422 (15) | 2 | 独立复核请求标识清理实现与协议边界 |
| `proj_01m88t9rpz` | project | active | 1,216 | 65 | 464 (2) | 3 | AGENTS.md 加载对齐 Claude Code |
| `cell_01m88tbfwn` | worker | active | 648 | 22 | 262 (13) | 2 | 验收 AGENTS.md 加载的真实 CLI 与 TUI |
| `cell_01m88tbfxg` | worker | active | 1,404 | 40 | 572 (33) | 2 | 创建 AGENTS.md 修复 MR 并跟进合入 develop |
| `cell_01m88v5kp4` | worker | active | 577 | 13 | 241 (17) | 2 | 复核 AGENTS.md 加载实现与最终证据 |
| `src_01m898sywm` | sensor | active | 12 | 2 | 3 (0) | 1 | 硬盘空间定期检查 |
| `proj_01m899dy2a` | project | closed | 35 | 2 | 13 (1) | 1 | 验证 `forge-cli` 创建空 MR |
| `cell_01m899f35r` | worker | closed | 135 | 1 | 63 (3) | 1 | 用 `forge-cli` 创建并核验空 MR |

### 主机 233（9 Cells / 12 Rollouts）

| Cell | 角色 | 状态 | Evidence | Runs | Tool Calls (`isErr`) | Rollouts | 任务标题 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `desk` | inline | active | 153 | 9 | 48 (0) | 3 | 主台 |
| `proj_01m88w8v36` | project | closed | 593 | 27 | 208 (0) | 2 | MCP 断线恢复与 Codex backport 排查 |
| `cell_01m88wc08e` | worker | closed | 380 | 14 | 139 (6) | 2 | 对照 develop CI 的 exec-server 能力探测超时 |
| `cell_01m88wc0m8` | worker | closed | 1,820 | 52 | 717 (32) | 2 | 复测最终 MCP 提交并交付 MR 至 develop |
| `cell_01m89b9m6n` | checker (code) | closed | 184 | 46 | 0 (0) | 0 | 跟进 MCP 修复 MR !5623 的合入结果 |
| `cell_01m89fc825` | checker (code) | closed | 28 | 7 | 0 (0) | 0 | 等待 MCP MR !5623 当前提交的 CI 结果 |
| `src_01m898sa01` | sensor | active | 7 | 1 | 1 (0) | 1 | 所有磁盘空间定期检查 |
| `proj_01m899dnn8` | project | closed | 41 | 2 | 14 (0) | 1 | trae-x 空 MR 与 `forge-cli` 可用性检查 |
| `cell_01m899fh34` | worker | closed | 133 | 2 | 57 (3) | 1 | 用 `forge-cli` 创建并核实空测试 MR |
