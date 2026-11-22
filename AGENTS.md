# `ng-agents` Agent 开发宪章（AGENTS.md）

欢迎进入 `ng-agents` 仓库！无论你是 Antigravity、Claude Code 还是 Codex CLI，在本仓库阅读、设计、修改代码、调整提示词或修复 Bug 时，**必须无条件遵守本文件规定的三层规范优先级与防破坏流程**。

---

## 一、三层文档体系与强制遵循顺序

本仓库严格分离**「设计原则」**、**「理想工作方式与用例推导」**和**「阶段性 Bug 记录」**：

### 1. 第一优先级：产品与架构设计原则（[`docs/01-principles/`](./docs/01-principles/)）—— **最高宪法，严禁违背**
- [01-product-principles.md](./docs/01-principles/01-product-principles.md)：GTD 表层极简铁律（`P-UX-1` ～ `P-UX-7`）。对人文案零内部黑话（但**必须保留被分析工程本身的真实技术专有名词与文件名**）、常驻 `desk` 是可双向对话的内生主 Agent 而外部主 Agent 是带归属的伴随入口、定时巡检归入信源不建假待办、微事秒办免卡、球权清晰且单事项至多一卡、三视图分工（待我处理、项目全局、分身实况）。
- [02-kernel-principles.md](./docs/01-principles/02-kernel-principles.md)：原子内核与编排准则（`P-KERN-1` ～ `P-KERN-6`）。内核只用确定性代码守住并发与安全底线，**绝不在内核硬编码业务流程状态机**；持久 `Project` 沉淀结构化上下文、共享 `Artifact` 与白板笔记，重体力活交给纯叶节点 `Worker`（`maxDepth: 0`；回合结束即待命、消息沿原会话唤醒，内核确定性通知父节点，父节点用 `inspect_cell` 主动 Pull），`checker` 是回报即关的一次性探针；监听优先看当前事实状态（Level-Triggered）并按 `0-Token / fast / strong` 分级调用。
- [03-safety-and-boundaries.md](./docs/01-principles/03-safety-and-boundaries.md)：宿主安全与治理红线（`P-SAFE-1` ～ `P-SAFE-7`）。直接在真实宿主目录工作，**严禁任何代码路径 `rmSync` 误删用户工作目录或乱改 `$HOME`**；内核不为目录排队加锁、只亮出活跃目录事实，谁在哪干由协调器决定，分身动刀前验现场、遇冲突上报并等待；主人未提交改动神圣不可侵犯；非主人地址外发、超预算续费和立项确认卡仅主人可批准执行，关闭预算限制也只允许主人操作。

### 2. 第二优先级：产品理想工作方式与用例推导（[`docs/02-workflows/`](./docs/02-workflows/)）—— **行为契约，严禁 Break！**
在动手改任何模块之前，必须先核对受影响的用例逐步推导与 **`INV-*` 不可破坏不变量**：
- [00-system-mechanics.md](./docs/02-workflows/00-system-mechanics.md)：全局七角色拓扑、双层状态机、可唤醒 `Worker` 的回合结算（待命 + 每轮一次退场通知 + 主动 Pull）、`checker` 单事务排空自关（`Drain-then-Close`）与三视图映射（`INV-SYS-01` ～ `07`）。
- [uc01-capture-reply-and-sources.md](./docs/02-workflows/uc01-capture-reply-and-sources.md)：微事免卡、单卡版本防盲发回复、信源静默巡检与周报习惯挖掘（`INV-UC01-01` ～ `04`）。
- [uc02-code-delivery-and-relay.md](./docs/02-workflows/uc02-code-delivery-and-relay.md)：`/todo` 缺路径追问、多棒接力追单、智能 `Watcher` 盯梢 CI、独立终审、全在途完结才结项与即时存偏好（`INV-UC02-01` ～ `05`）。
- [uc03-human-collaboration-and-engage.md](./docs/02-workflows/uc03-human-collaboration-and-engage.md)：局部先行与 `@Human` 等待、专注区人工改稿防覆盖与免打扰缓冲、多阶段注意力门控（`INV-UC03-01` ～ `05`）。
- [uc04-someday-research-and-reactivate.md](./docs/02-workflows/uc04-someday-research-and-reactivate.md)：`research_then_park` 预研停靠、网页报告抽屉、跨周查重先询问再激活（`INV-UC04-01` ～ `04`）。
- [uc05-workspace-concurrency-and-arbitration.md](./docs/02-workflows/uc05-workspace-concurrency-and-arbitration.md)：内核只亮活跃目录事实、协调器决定同仓分工（只做查阅 / 交给原 `worker` / `git worktree`）、冲突上报停手、主人脏改动弹卡保护、多项目共因 CI 单修广播唤醒（`INV-UC05-03` ～ `06`；`01`、`02` 已取代）。
- [uc06-domain-hub-direct-stream.md](./docs/02-workflows/uc06-domain-hub-direct-stream.md)：`domain-hub` 直通固定时间桶攒批、噪音 `handback`、在途无损 `--resume`、待命原会话唤醒与已关续派（`INV-UC06-01` ～ `04`）。
- [uc07-external-agent-and-overnight-hosting.md](./docs/02-workflows/uc07-external-agent-and-overnight-hosting.md)：外部主 Agent 控制流（先存作用域偏好再立项）与跨夜增量记账、认领前预算挂起零吞信封、预算限制总开关仅主人可拨、合盖休眠续租（`INV-UC07-01` ～ `06`）。
- [uc08-direct-worker-chat-and-pull-sync.md](./docs/02-workflows/uc08-direct-worker-chat-and-pull-sync.md)：主人经 `Agents` 视图或外部主 Agent 直连 `worker`（待命唤醒 / 顺手补充 / 立即打断）、同事务静默抄送父项目、退场通知标出直连、项目 `inspect_cell` 主动 Pull 并写进白板、查询零滞后、被关分身带回与脚本/归档节点拒收（`INV-UC08-01` ～ `06`）。

### 3. 第三层：Bug 记录与实测审计台账（[`docs/03-bugs/`](./docs/03-bugs/README.md)）—— **待修差距清单**
- `docs/03-bugs/` 记录的是**当前代码尚未对齐第一、二层理想态的缺陷**，绝不能将当前 Bug 行为误认为预期行为。
- 修复任何 `BUG-xxx` 时，必须确认修复结果向 `02-workflows/` 推导的理想状态机收敛，而非堆叠违背 `01-principles/` 的临时补丁；修完后补齐单测并更新 [docs/03-bugs/README.md](./docs/03-bugs/README.md) 中的状态。
- *(注：`docs/04-references/archive/` 为历史阶段演进归档，除非追溯旧注释，日常开发请勿将其当作现行规范。)*

### 4. 已落地的架构演进设计记录（[`docs/05-proposals/`](./docs/05-proposals/README.md)）—— **当前架构的来龙去脉**
- `docs/05-proposals/` 分册 01–06 已全部落地。分册 01–04 引入对话式主台 `desk`、纯叶节点可重唤醒 `Worker` + `inspect_cell` 主动 Pull、移除内核 `cwdMode` 排队改 AI 目录协同 + `Project` 常驻白板笔记、以及工作台的 **「分身实况 · Agents」**（拓扑画布 + 工作实况流 + 直连发话）。
- 分册 05、06 落地了统一人类收件箱、三视图、按证据游标续接 CLI 与统一领域命令层。
- 它们现在是**当前架构的设计记录**，用来理解某条规则为什么是这样，不再是待办蓝图，也不随代码修订；**权威规范重新是 `01-principles/` 与 `02-workflows/`**——提案原文与这两层（或与代码）不一致时，以这两层为准。凡被提案取代的旧机制（`cwdMode` 写锁队列、`worker` 只读沙箱、`worker` 回报即关）切勿再修补或复活。

---

## 二、代码仓库分层结构地图

```text
ng-agents/
├── AGENTS.md                   # Agent 开发宪章（本文件）
├── docs/                       # 分层规范、问题台账与演进设计记录 (01-principles / 02-workflows / 03-bugs / 04-references / 05-proposals)
├── packages/                   # 第一层代码：6 个封闭数据面原语 + Cell 控制面容器 (零业务耦合)
│   ├── protocol/               # Envelope 信封、地址与身份 (owner / agent:*)、SQLite Schema、GTD 基础契约
│   ├── channel/                # ① 外部通道接入验签、幂等外发与专注期免打扰缓冲
│   ├── inbox/                  # ② SQLite 队列、deliverAt/cron/coalesceMs 调度、串行租约锁与 control 急刹旁路
│   ├── context/                # ③ 业务状态、带乐观锁 Artifact、冻结前缀 hydrate、全域含溢出表 FTS5 与 SKILL.md
│   ├── loop/                   # ④ 单次有界执行 (API 循环 + Claude/Codex/AGY CLI 持久化会话驱动 + 0-Token code)
│   ├── workspace/              # ⑤ 宿主目录句柄、git.toplevel 解析与跨轮次异步长进程 Job
│   ├── gate/                   # ⑥ 单调权限收紧 (child ⊆ parent)、ownerOnly 审批卡与双账本预算护栏
│   └── cell/                   # ⑦ 监督树生命周期、Dispatcher（认领前预算挂起、叶节点回合结算与退场通知）、直连发话抄送、inspect_cell、活跃目录事实与 5 锚点停滞检测
├── presets/                    # 第二层代码：可编程角色编排层
│   └── src/                    # 7 套预设 (inline/project/worker/checker/reply_watcher/sensor/hub)、Prompt 契约与内置 SKILL.md
└── apps/
    └── gtd-desk/               # 第三层代码：产品应用与双入口接入层
        ├── src/server/         # 本地常驻 HTTP 服务、UI 同步事务 (desk.ts)、三视图投影、直连发话与模型动态切换
        ├── src/agent/          # 面向外部主 Agent 的结构化控制面 (/api/agent/* 工具定义与鉴权执行)
        ├── src/web/            # React + Vite 三视图界面（待我处理、项目全局、分身实况）
        ├── bin/ng-mcp.mjs      # 零依赖 stdio MCP 桥接服务器
        └── main-agent/         # 外部主 Agent 接入套件 (Antigravity 插件 ng-desk/ 与 Claude /todo 模板)
```

---

## 三、开发改动与防回归验证清单（Checklist）

每次提交代码或提示词改动前，请逐项核验：

1. **原则核验**：是否往内核（`packages/*`）塞进了本该属于 `presets` 提示词/`SKILL.md` 的硬编码业务流程（包括按目录排队、加锁或按 `cwdMode` 分支）？是否破坏了 `ownerOnly` 或主人现场安全边界？
2. **用例不变量核验**：对照 `docs/02-workflows/00-system-mechanics.md` 与 `uc01` ～ `uc08`，确认本次改动未破坏任何一条关联的 `INV-*`（例如改调度器必核排空才结算、每轮一次退场通知、待命不占槽不挡结项与认领前预算挂起；改直连发话必核发话与抄送同事务；改上下文/提示词必核前缀缓存稳定性、动态尾部的笔记与活跃目录、技术术语保留；改投影必核 待我处理单卡、`Radar` 停靠报告与周回顾过滤、`Agents` 视图零运行时黑话）。
3. **全量本地门禁必绿**（不依赖外部真实模型 API，CLI 测试采用确定性脚本假进程）：
   ```bash
   pnpm typecheck    # 全工作区 10 个包 TypeScript 严格类型检查
   pnpm test         # 全套单元与场景集成测试 (packages + presets + apps/gtd-desk)
   pnpm build        # 构建 Web 前端产物，确保前后端 DTO 契约一致
   ```
4. **文档同步**：若新增了产品用例或改变了理想工作流推导，同步更新 `docs/02-workflows/` 并补齐对应 `scenario-*.test.ts`；若修复了已知缺陷，同步更新 `docs/03-bugs/` 状态。
