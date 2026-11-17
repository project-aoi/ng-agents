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

## 快速开始 / 运行

**环境要求**：Node.js ≥ 24（用到内置的 `node:sqlite`）、pnpm（版本见根目录 `package.json` 的 `packageManager`）。不需要 Docker，也不需要任何原生扩展。

```bash
pnpm install      # 安装依赖
pnpm build        # 构建 Web 界面（apps/gtd-desk/dist/web）
pnpm start        # 启动工作台：同一个端口提供界面和接口，默认 http://127.0.0.1:8790
pnpm dev          # 开发模式：服务端热重载 + Vite 界面（http://127.0.0.1:5173，接口自动转发到 8790）
pnpm typecheck    # 全部包的类型检查
pnpm test         # 全部测试（vitest，不调用任何真实模型）
```

没有执行 `pnpm build` 时，`pnpm start` 只提供接口（`/api/*`），首页会提示先构建界面。

### 谁来驱动 Agent：CLI Agent / API / 演示模式

启动时按 `NG_AGENT_BACKEND`（默认 `auto`）选一种，顶栏状态和启动日志会写明**实际在跑的是哪一个**（`claude` / `codex` / `agy` / `anthropic` / `openai` / `demo`）：

| 取值 | 行为 |
| :--- | :--- |
| `auto`（默认） | 本机装了哪个 CLI Agent 就用哪个（依次看 `claude`、`codex`、`agy`）；都没装但配了 API Key，就走 API；都没有则进入**演示模式** |
| `claude` / `codex` / `agy` | 指定用这个 CLI Agent 执行每个 Cell 的 Run；没装会在启动时直接报错，不会悄悄降级 |
| `api` | 只走 API 工具循环；没配 Key 同样启动即报错 |

- **CLI Agent**：用的是你本机 CLI 自己的登录（订阅或其 Key），工作台不会把 `ANTHROPIC_API_KEY` 和 `NG_*` 变量传给它。主台以只读方式运行（只给 Read/Grep/Glob），写代码的后台分身在独立 `git_worktree` 里跑。可选：`NG_CLAUDE_BIN` / `NG_CODEX_BIN` / `NG_AGY_BIN`（可执行文件路径）、`NG_<CLI>_MODEL_STRONG` / `NG_<CLI>_MODEL_FAST`（如 `NG_CLAUDE_MODEL_STRONG=sonnet`，留空即用 CLI 自己的默认模型）、`NG_CLI_DEBUG=1`（日志里打印每次启动的完整命令）。
- **CLI 的费用记账** `NG_CLI_BILL_REPORTED_COST`：默认 `1`，把 CLI 自报的费用（Claude Code 即使走订阅也按标价报）计入每个 Cell 的美分预算，让预算继续起到“刹车”作用；纯订阅用户若只想让美分预算统计 API 开销，可设为 `0`（Token 用量无论如何都计入）。
- **API**：`ANTHROPIC_API_KEY`（或 `ANTHROPIC_AUTH_TOKEN`），可用 `NG_MODEL_STRONG` / `NG_MODEL_FAST` 指定模型；兼容 OpenAI 接口的服务（如 DeepSeek）用 `NG_MODEL_PROVIDER=openai` + `NG_OPENAI_BASE_URL` + `NG_OPENAI_API_KEY` + `NG_MODEL_STRONG` / `NG_MODEL_FAST`。
- **演示模式**：没有 CLI 也没有 Key 时自动进入，`NG_DESK_DEMO=1` 可强制进入。首次启动会用真实内核和预设模板把 [产品设计](./docs/03-gtd-agent-product-vision.md) §四 的五个场景“演”一遍（从三天前开始，模拟同事、供应商在一个“演示 IM”通道里发消息），所以三个视图、信源抽屉、记录和周回顾一打开就有内容；之后在随手记里存链接、设提醒、对卡片口述修改都会有回应，其余输入会如实提示“演示模式下不会真正处理”。演示数据默认放在单独的 `data-demo/`，已有数据的目录永远不会被灌入演示内容。

```bash
NG_DESK_DEMO=1 pnpm start                                   # 演示模式
NG_AGENT_BACKEND=claude NG_CLAUDE_MODEL_STRONG=sonnet pnpm start   # 用本机 Claude Code
NG_AGENT_BACKEND=codex pnpm start                           # 用本机 Codex CLI
NG_AGENT_BACKEND=agy pnpm start                             # 用本机 Antigravity CLI
ANTHROPIC_API_KEY=sk-... NG_AGENT_BACKEND=api pnpm start    # 只走 API
```

### 数据放在哪

- 全部状态在 `NG_DESK_DATA_DIR`（默认 `./data`，演示模式默认 `./data-demo`；经 `pnpm start` / `pnpm dev` 启动时相对于 `apps/gtd-desk/`）：一个 SQLite 文件 `ng.db`（WAL 模式），加上 `skills/`（`SKILL.md`）、`workspace/`（各分身的工作目录与 worktree）、`base-repo/`（没有配置仓库时给 `git_worktree` 用的空白基础仓库）。
- 停掉再启动会接着上次的状态跑：未完成的消息、到期提醒、等待中的回信和后台任务都会恢复；删掉这个目录就是全新开始。
- 时区：提醒、“推迟到下午”和周回顾按 `NG_DESK_TZ`（默认本机时区）计算。

### 访问控制（回环地址 / 令牌）

- 默认只监听 `127.0.0.1`（`NG_DESK_HOST` / `NG_DESK_PORT` 可改），并拒绝非本机 Host 头与跨站写请求。
- 想在局域网或公网访问，必须同时设置 `NG_DESK_TOKEN`（至少 16 个随机字符，例如 `openssl rand -hex 24`）；没有令牌却绑定非回环地址，服务会拒绝启动。设置令牌后所有 `/api/*` 请求都要带 `Authorization: Bearer <令牌>`。经反向代理访问时用 `NG_DESK_ALLOWED_HOSTS` 声明域名。
- 外部渠道只有配置了对应密钥才会挂载（`NG_SECRET_<REF>`，例如 `NG_SECRET_GITHUB_WEBHOOK`、`NG_SECRET_SLACK_SIGNING`、`NG_SECRET_FEISHU_VERIFICATION`），回调地址为 `/hooks/<渠道 id>`，由各渠道自己的签名校验把关。

### 当前实现状态

已在本机实际跑通的：

- 全部测试（不调用真实模型）与类型检查；演示模式的完整启动、五个场景的播种与重启不重复播种。
- **Claude Code 作为执行后端**：只读主台、`haiku` 模型，经接口录入“把链接存进阅读清单”和“周五下午 3 点提醒我约牙医”两条随手记——主台分别调用了存笔记和设提醒，生成了记录和顶栏轻提示，没有弹待确认卡，提醒按本地时间挂好了延迟唤醒。

尚未实现或尚未在真实环境验证的：

- **Codex CLI、Antigravity CLI 作为后端**：适配器有测试，但这一版没有经工作台端到端跑过；Claude Code 下“可写代码的后台分身”（`git_worktree` + 沙箱）也没有经工作台实际跑过。
- **API 后端**（Anthropic / OpenAI 兼容）：本机没有 API Key，没有真实调用过，只用脚本化模型测过。
- **外部渠道**：飞书、Slack、GitHub、通用 Webhook 只用伪造的请求测过签名和解析，没有接过真实账号；邮件（IMAP/SMTP）没有实现。
- **隔离**：`container` 驱动没有在真实 Docker 上验证（本机无 Docker 权限）；`cow_microvm` 只有接口，选它会直接报错。
- **生成过程的实时预览**（流式输出到界面）没有做；界面只在每一步完成后刷新。
- 立项方案里“等待外部”类的动作不会自动挂上回信监听，所以只剩这类动作的项目会被标为停滞，需要你补上下一步或改用“催回信”。
- 演示模式里后台分身的“工作结果”是预先写好的文字，不代表真实执行；Web 界面由另一位同事并行开发，本次只确认了能构建和被服务端托管。
