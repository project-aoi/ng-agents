# ng-agents

面向日常工作的个人与团队 Agent 探索项目：遵循 **“表层极简 GTD、底层原子可动态拼装”** 的设计思路——对外只呈现最直觉的收件箱、待确认卡片与事项状态，对内靠 **6 个基础原语 + `Cell` 动态拼装容器** 适配从秒级随手记到跨天多方协同、并发深挖等不同粒度的工作。

## 核心设计准则

1. **用户看到的类 GTD 表层保持极简**：不向用户暴露复杂的底层运行概念。定时巡检与条件监控归入 **信源（Mailbox Source）** 产生事件，GTD 视图只管理真正需要推进的动作与有终点的项目。
2. **内核不堆砌定制业务实体与过度包装**：系统底层只保留 **1 条异步消息流 + 6 个基础原语 + `Cell` 拼装容器**（主台轻装秒回并秒派分身，单 `Cell` 慢命令走跨轮次异步 `Job`；单套权限严格满足 `child ⊆ parent`；仅保留 `Cell epoch` 防取消诈尸与草稿 `Artifact version` 防覆盖/盲发；异步事件走队列、UI 简单交互直走同步事务）。常见场景靠预设模板开箱即用，长尾复杂场景由 Agent 在权限边界内动态拼装完成。

## 文档目录

1. **[2026 热门 AI Agent 产品调研与底层工程共性](./docs/01-agent-landscape-2026.md)**
   - 深度拆解 Anthropic《Building always-on agents》、Paperclip、Hermes Agent、**DeepSeek Super-agent (`dsh-superagent`) / DeepSeek Harness (`dsh`)**、OpenClaw、Pi、Poke、Devin 2.2、Manus 2.0、OpenAI Codex、Cursor Automations 以及企业级 SaaS Agent 产品。
   - 总结行业收敛出的十个工程做法（默认休眠按事件唤醒、单会话串行锁与线程直通、会话与沙箱分离、保持上下文前缀不变以命中缓存、写代码调工具、文件记忆与后台整理、`SKILL.md` 按需加载、沙箱外代理注入密钥与挂起等待审批、静默过滤低价值通知、子沙箱隔离与金额/Token 双硬上限），以及线上真实踩过的坑。

2. **[Agent 核心架构拆解：6 个基础原语 + `Cell` 动态拼装](./docs/02-atomic-kernel-architecture.md)**
   - **统一消息信封（`Envelope`）+ 6 个职责封闭的原子模块**：`① Channel`（外部通道接入、能力声明、幂等外发与免打扰缓冲）、`② Inbox`（SQLite 队列、`deliverAt` 延迟与 Cron 唤醒、串行锁与实时 `control` 急刹）、`③ Context`（业务状态、带 `version` 草稿 `Artifact`、前缀快照、`FTS5` 检索与 `SKILL.md`）、`④ Loop`（支持工具裁剪的大模型推理与零 Token 确定性 `code` 执行）、`⑤ Workspace`（隔离沙箱与跨轮次异步 `Job` 句柄）、`⑥ Gate`（单调权限收紧 `child ⊆ parent`、密钥代理、绑定草稿版本的 `defer` 审批与双账本预算）。
   - **`Cell` 动态拼装与极简落地路径**：说明如何靠 **4 种预设模板（`inline / worker / watcher / sensor`）+ 轻装主台秒派分身 + 异步 `Job` + Agent 动态拼装（`spawnCell`）** 适配不同粒度工作（含按需授权子 Agent 1 对 1 直连汇报），并验证如何用同一套底座支撑市面上 8 类代表性产品。

3. **[用 GTD 的思路设计工作辅助 Agent](./docs/03-gtd-agent-product-vision.md)**
   - 从 GTD 的基本逻辑出发，分析为什么纯聊天框、传统 AI 待办列表、全自动黑盒以及写死单一流水线的架构都不够顺手。
   - 确立 **极简表层概念（定时监控归入信源层，不污染待办）**、**后台预处理消除空白页**、**标清动作球权归属（`Agent 处理中` / `我来处理` / `等待回复`）**、**随手记 + 三个日常视图** 与 **随信任逐步放权**，并展示多粒度任务如何在底层动态拼装运行。

4. **[GTD 工作台界面交互与状态流转设计](./docs/04-gtd-interaction-spec.md)**
   - 定义信源层（含定时信源）与顶部独立运行状态栏、`待确认收件箱（Clarify）`（单事项至多一卡、绑定草稿 `version` 防误发与防覆盖、个人微事免二次审批）、`专注工作区（Engage）`（同步速办勾选 + 左 8 右 4 深度编辑 + 仅暂存外部 `Channel` 通知的免打扰缓冲）、`项目全局与周回顾（Radar）`（多动作并行进度聚合、防停滞检查与沉淀 `SKILL.md`/脚本）的交互与状态流转。

5. **[从真实场景出发的演进方案](./docs/05-scenario-evolution-plan.md)**
   - 用 7 个真实场景（`/todo` 记想法与立项、跨天接力、长文本里找习惯、多方并发改同一目录、领域中枢、外部主 Agent 调度）反推：拆掉写死的协调器与沙箱枷锁，补上全局检索、带合并窗口的监听、外部主 Agent 控制面三个原语。当前代码按这份方案实现，见下文「工作方式」。

## 工作方式（docs/05 之后）

- **行为由提示词建议，不由代码规定**：内核不写任何协作流程，也尽量不给 Agent 设权限。每个角色都拿到同一套通用原语（派生/带话/等待/状态/草稿/检索/后台任务/文件与命令），怎么用由角色提示词和 `SKILL.md` 建议——主台（`inline`）分流与仲裁；有终点的事交给长驻的 **项目 Cell（`project`）**，它把每一棒交给一次性的 **`worker`**，需要等外部事件时挂 **`watcher`**；高频同类消息由 **领域中枢（`hub`）** 按合并窗口成批处理。约定在 `presets/src/shared/prompts.ts`，内置手册（`project-relay`、`domain-hub`、`workspace-arbitration`、`habit-and-routine-discovery`）首次启动时装进 `skills/`。
- **内核只守少数几条硬底线**（docs/05 原则 7）：同一工作树单写者排队、一次性分身“排空才关”、五锚点停滞只提醒一次、对外发送与预算加额必须主人本人批准、共享草稿的版本号乐观锁、子 Cell 权限不超过父 Cell、`epoch` 急刹与预算熔断。除此之外没有“不允许”——例如结项前是否等完在途工作、公共阻塞由谁修、谁来通知等待者，全是提示词里的建议。
- **直接在你的真实目录里干活**：Cell 的 `cwd` 就是你给的路径，没有自动 worktree、没有假的 `$HOME`、不会替你删目录。`cwdMode` 只是一个**调度声明**：`write` 的分身为该工作树排队（**同一时刻只有一个写者**），`read` 的分身不排队、可与任何人并行；它不限制工具——只读分身同样有 shell（看 `git diff`、跑只看不改的命令），“只看不改”靠提示词。发现目录里有你未提交的改动时，分身不会碰它，而是经主台弹一张卡问你。
- **做完才关，关前不丢消息**：一次性分身交完结果后，内核先确认它没有未读消息、没有还开着的下级，才投递唯一的最终结果并关闭；给已关闭的分身发消息会明确得到 `closed`，由上级接着处理。
- **停滞只提醒一次**：项目同时失去五个“锚点”（在跑的 Run / Job、未读消息、定时器、监听、等人或等外部的登记）才算停滞，内核只发一条 `kernel.stalled_check`，锚点回来即撤回。
- **检索覆盖全部记录**：`search_history` 可按 `lineage / subtree / global` 搜证据、状态、草稿各版本和超长工具输出的落盘内容（FTS5，中英文与短词都能命中）。
- **偏好即时生效**：存下的长期偏好会进入所有在岗 Cell 下一轮的系统提示，不只影响之后新建的。

## 快速开始 / 运行

**环境要求**：Node.js ≥ 24（用到内置的 `node:sqlite`）、pnpm（版本见根目录 `package.json` 的 `packageManager`）。不需要 Docker，也不需要任何原生扩展。

```bash
pnpm install      # 安装依赖
pnpm build        # 构建 Web 界面（apps/gtd-desk/dist/web）
pnpm start        # 启动工作台：同一个端口提供界面和接口，默认 http://127.0.0.1:8790
pnpm dev          # 开发模式：服务端热重载 + Vite 界面（http://127.0.0.1:5173，接口自动转发到 8790）
pnpm typecheck    # 全部包的类型检查
pnpm test         # 全部测试（vitest，不调用任何真实模型；CLI Agent 用脚本化的假进程）
```

没有执行 `pnpm build` 时，`pnpm start` 只提供接口（`/api/*`），首页会提示先构建界面。

### 谁来驱动 Agent：CLI Agent / API / 演示模式

启动时按 `NG_AGENT_BACKEND`（默认 `auto`）选一种，顶栏状态和启动日志会写明**实际在跑的是哪一个**（`claude` / `codex` / `agy` / `anthropic` / `openai` / `demo`）：

| 取值 | 行为 |
| :--- | :--- |
| `auto`（默认） | 本机装了哪个 CLI Agent 就用哪个（依次看 `claude`、`codex`、`agy`）；都没装但配了 API Key，就走 API；都没有则进入**演示模式** |
| `claude` / `codex` / `agy` | 指定用这个 CLI Agent 执行每个 Cell 的 Run；没装会在启动时直接报错，不会悄悄降级 |
| `api` | 只走 API 工具循环；没配 Key 同样启动即报错 |

- **CLI Agent**：用的是你本机 CLI 自己的登录（订阅或其 Key），工作台不会把 `ANTHROPIC_API_KEY` 和 `NG_*` 变量传给它。可选：`NG_CLAUDE_BIN` / `NG_CODEX_BIN` / `NG_AGY_BIN`（可执行文件路径）、`NG_CLI_DEBUG=1`（日志里打印每次启动的完整命令）。
- **模型切换（界面顶栏「模型」）**：模型清单**不写在代码里**，每次都向 CLI 自己要（Claude Code 的 `initialize` 控制请求、`codex debug models`、`agy models`），所以 CLI 升级后新模型自动出现。默认是「自动」：跟随 CLI 自己排在第一位的模型，推理强度取 `xhigh`（该模型没有 `xhigh` 就取它提供的最高一档）——CLI 的首选换了，这里跟着换。可以分别给「主力」（主台、项目、分身）和「轻量」（监听、信源）固定某个模型和强度；选择存在数据目录的 `models.json`，从各 Agent 的下一轮开始生效，不打断在跑的工作。接口：`GET /api/models`（`?refresh=1` 重新向 CLI 要清单）、`PUT /api/models`。`NG_<CLI>_MODEL_STRONG` / `NG_<CLI>_MODEL_FAST` 仍可用来指定初始固定选择（界面里的选择优先）。
- **⚠️ CLI Agent 的权限**：按 docs/05，所有分身都在宿主机上、以你的身份运行，**没有沙箱，也不按角色裁剪工具**：Claude Code 以 `--permission-mode bypassPermissions` 运行，Codex 以 `-s danger-full-access` 运行，Antigravity 的权限请求全部自动批准——**它能做你在终端里能做的任何事**，无论它是主台、项目、只读分析还是可写 worker。约束来自三处：提示词里的红线（未经你当场确认不做不可逆操作；不动你未提交的改动；默认在新分支提交、不推送；声明只读的分身不改工作树）、内核的单写者队列、以及工作台自己的对外工具（经渠道发消息等）必须过 Gate 审批卡。注意 Gate 管不到 CLI 自己的 shell：分身技术上可以自己 `git push` 或联网，拦它的只有提示词。不放心的仓库或机器请不要交给它，或给 Cell 显式指定 `container` 隔离、收紧它的 `bounds`（这是你作为主人的选择，不是默认）。
- **CLI 的费用记账** `NG_CLI_BILL_REPORTED_COST`：默认 `1`，把 CLI 自报的费用（Claude Code 即使走订阅也按标价报）计入每个 Cell 的美分预算，让预算继续起到“刹车”作用；纯订阅用户若只想让美分预算统计 API 开销，可设为 `0`（Token 用量无论如何都计入）。
- **API**：`ANTHROPIC_API_KEY`（或 `ANTHROPIC_AUTH_TOKEN`），可用 `NG_MODEL_STRONG` / `NG_MODEL_FAST` 指定模型；兼容 OpenAI 接口的服务（如 DeepSeek）用 `NG_MODEL_PROVIDER=openai` + `NG_OPENAI_BASE_URL` + `NG_OPENAI_API_KEY` + `NG_MODEL_STRONG` / `NG_MODEL_FAST`。
- **演示模式**：没有 CLI 也没有 Key 时自动进入，`NG_DESK_DEMO=1` 可强制进入。首次启动会用真实内核和预设模板把 [产品设计](./docs/03-gtd-agent-product-vision.md) §四 的五个场景“演”一遍（从三天前开始，模拟同事、供应商在一个“演示 IM”通道里发消息），所以三个视图、信源抽屉、记录和周回顾一打开就有内容；之后在随手记里存链接、设提醒、对卡片口述修改都会有回应，其余输入会如实提示“演示模式下不会真正处理”。演示数据默认放在单独的 `data-demo/`，已有数据的目录永远不会被灌入演示内容。

```bash
NG_DESK_DEMO=1 pnpm start                                   # 演示模式
NG_AGENT_BACKEND=claude pnpm start                          # 用本机 Claude Code（模型默认跟随 CLI 的首选，可在界面里切换）
NG_AGENT_BACKEND=codex pnpm start                           # 用本机 Codex CLI
NG_AGENT_BACKEND=agy pnpm start                             # 用本机 Antigravity CLI
ANTHROPIC_API_KEY=sk-... NG_AGENT_BACKEND=api pnpm start    # 只走 API
```

### 数据放在哪

- 全部状态在 `NG_DESK_DATA_DIR`（默认 `./data`，演示模式默认 `./data-demo`；经 `pnpm start` / `pnpm dev` 启动时相对于 `apps/gtd-desk/`）：一个 SQLite 文件 `ng.db`（WAL 模式），加上 `skills/`（`SKILL.md`）、`cells/`（没有指定目录的 Cell 各自的私有目录，例如监听器）、`cli-procs/`（在跑的 CLI 进程登记，用于重启后清理遗留进程）。代码和文档留在你自己的目录里，工作台不复制、不清理。
- 停掉再启动会接着上次的状态跑：未完成的消息、到期提醒、等待中的回信和后台任务都会恢复，上次没来得及退出的 CLI 进程和取消到一半的 Job 会先被收尾；删掉这个目录就是全新开始。
- 时区：提醒、“推迟到下午”和周回顾按 `NG_DESK_TZ`（默认本机时区）计算。

### 访问控制（回环地址 / 令牌）

- 默认只监听 `127.0.0.1`（`NG_DESK_HOST` / `NG_DESK_PORT` 可改），并拒绝非本机 Host 头与跨站写请求。
- 想在局域网或公网访问，必须同时设置 `NG_DESK_TOKEN`（至少 16 个随机字符，例如 `openssl rand -hex 24`）；没有令牌却绑定非回环地址，服务会拒绝启动。设置令牌后所有 `/api/*` 请求都要带 `Authorization: Bearer <令牌>`。经反向代理访问时用 `NG_DESK_ALLOWED_HOSTS` 声明域名。
- 外部渠道只有配置了对应密钥才会挂载（`NG_SECRET_<REF>`，例如 `NG_SECRET_GITHUB_WEBHOOK`、`NG_SECRET_SLACK_SIGNING`、`NG_SECRET_FEISHU_VERIFICATION`），回调地址为 `/hooks/<渠道 id>`，由各渠道自己的签名校验把关。

### 外部主 Agent（把工作台当工具用）

你平时用的 CLI Agent（Claude Code / Codex / Antigravity）可以作为**主 Agent**接管“和你对话”这一层：它通过一组 `agent tools` 看概览、立项、给项目带话、勾掉动作、处理卡片、检索历史、存偏好，后台的项目与分身照常由工作台调度。

- **身份与边界**：主 Agent 以 `agent:<id>` 身份行事，可以创建、带话、暂停/恢复/关闭任何 Cell，但**不能放宽权限上限、不能批准对外发送类卡片、不能在预算耗尽后续费**——这些仍要你本人在界面上点。
- **凭据**：`NG_AGENT_TOKEN=<随机串>`（身份 `agent:main`），或 `NG_AGENT_TOKENS="id1:token1,id2:token2"` 配多个；它与 `NG_DESK_TOKEN`（主人令牌）是两套，主人令牌不能用于 `/api/agent/*`。两者都没配且只监听回环地址时，本机进程以 `agent:local` 免令牌访问。
- **HTTP**：`GET /api/agent/tools`（工具清单与使用说明），`POST /api/agent/tools/<name>`（JSON 参数）。
- **MCP（推荐）**：`apps/gtd-desk/bin/ng-mcp.mjs` 是一个零依赖的 stdio MCP 服务器，把上面的接口原样暴露出去：

```bash
D=$(pwd)/apps/gtd-desk/bin/ng-mcp.mjs
claude mcp add ng-desk -e NG_DESK_URL=http://127.0.0.1:8790 -e NG_AGENT_TOKEN=<token> -- node $D
codex  mcp add ng-desk --env NG_DESK_URL=http://127.0.0.1:8790 --env NG_AGENT_TOKEN=<token> -- node $D
agy    mcp add --env NG_DESK_URL=http://127.0.0.1:8790 --env NG_AGENT_TOKEN=<token> ng-desk node $D
```

- **`/todo` 命令**：`apps/gtd-desk/main-agent/todo.md` 是现成的 Claude Code 自定义命令模板，复制到 `~/.claude/commands/todo.md` 即可用 `/todo <一句话>`（先查重、缺路径先问、再立项或随手记）。不装也行——直接说“/todo …”或“帮我记一下 …”主 Agent 同样会照服务器说明处理。

### 当前实现状态

已在本机实际跑通的（2026-11-18，真实 CLI；外部消息源为模拟）。实测一律用各 CLI **自己列出的首选模型**（由模型切换的「自动」解析，当天是 Claude Code → Opus 5.5 · xhigh，Codex → GPT-6.2-Sol · xhigh，Antigravity → Gemini 4 Carbon · High），不针对较弱的模型调提示词：

- 全部测试（不调用真实模型）、类型检查与构建；演示模式的完整启动、五个场景的播种与重启不重复播种。
- **作为执行后端**，在真实预设（主台 → 项目 → worker → watcher / hub）下的五个场景：

| 场景 | Claude Code | Codex | Antigravity |
| :--- | :---: | :---: | :---: |
| `/todo` 改代码：缺路径先问 → 同一项目里追加要求 → 存偏好 → watcher 等到合并信号 → 带回顾结项 | ✓ | ✓ | ✓ |
| 目标文件里有主人未提交的改动：不碰它（出阻塞卡等答复，或在独立 worktree 的新分支上完成） | ✓ | ✓ | ✓ |
| 暂时不做的想法：调研出报告并停靠 → 再提起时先告知已有报告并询问 → 原项目恢复、分阶段、阶段间等确认 | ✓ | ✓ | 写本节时仍在运行（前两步符合预期） |
| 群聊直通中枢：半分钟一批、无关消息退回主台、只读分身用自己的 shell 看 `git diff` 做评审、追问转给在跑的分身或续派、回复经主人确认卡 | ✓ | ✓ | 写本节时尚未跑到 |
| 公共阻塞：两个项目被同一个共享检查卡住 → 主台只派一个修复者、用自己的状态笔记记下等待者、修好后逐个通知 → 都通过 | ✓ | ✓ | 写本节时尚未跑到 |

- **作为外部主 Agent**（经 `ng-mcp.mjs`）：Claude Code 走完一整轮（看概览 → `/todo` 没给路径先问 → 给了路径查重后立项 → 如实转述进展 → 验收 + 追加要求 + 长期约定 → 汇总）；Codex、Antigravity 各做了看概览、列出长期偏好、随手记一条提醒。
- **模型切换**：三个 CLI 的模型清单都能在运行时取到；`GET/PUT /api/models` 在真实服务上验证过（列出、切换、切回自动）；界面面板用无头浏览器加模拟接口测过交互，没有在真实浏览器会话里点过。

尚未实现或尚未在真实环境验证的：

- **API 后端**（Anthropic / OpenAI 兼容）：本机没有 API Key，没有真实调用过，只用脚本化模型测过。
- **外部渠道**：飞书、Slack、GitHub、通用 Webhook 只用伪造的请求测过签名和解析，没有接过真实账号；邮件（IMAP/SMTP）没有实现。领域中枢（`hub`）与合并窗口用内存通道模拟的群消息实测过，没有接真实的飞书消息流。
- **隔离**：`container` 驱动没有在真实 Docker 上验证（本机无 Docker 权限）；`cow_microvm` 只有接口，选它会直接报错。
- **生成过程的实时预览**（流式输出到界面）没有做；界面只在每一步完成后刷新。
- 已知的小缺口：经卡片批准立项的项目总是记在主台名下；Cell 创建后不能改 `cwdMode`（需要排队写就另派一个）；恢复（resume）已关闭的一次性分身可能使同级数量超过上限。
- 演示模式里后台分身的“工作结果”是预先写好的文字，不代表真实执行；Web 界面由另一位同事并行开发，本次只新增了顶栏的模型切换面板，其余只确认了能构建和被服务端托管。
- **与 docs/05 的一处出入**：docs/05 第三章要求 `cwdMode` 与执行权限“硬绑定”（只读 Cell 禁用写/命令工具）。按“尽量不给 Agent 设权限、行为只由提示词建议”的原则，现在 `cwdMode` 只决定是否排队占用工作树，不裁剪任何工具；实测中只读评审正是靠自己的 shell 看 `git diff` 才做得成。如需恢复硬绑定，改动集中在 `selectRunTools`、Cell 的工作区端口和 CLI 的 `capabilitiesOf` 三处。
