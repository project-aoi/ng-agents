# ng-agents (`ng-desk`)

面向日常工程与知识工作的常驻后台 GTD 工作台：遵循 **“表层极简 GTD、底层原子动态拼装”** 的设计哲学——日常你只需跟顺手的 CLI 主 Agent（Antigravity / Claude Code / Codex）自然对话或在清爽的网页三视图里拍板，底层由 **1 条异步消息流 + 6 个封闭原语 + `Cell` 动态容器** 调度本地 CLI 分身完成跨会话、跨时段的接力调研、编码、零算力盯梢门禁与独立代码终审。

---

## 仓库分层结构（规范先行 $\times$ 模块解耦）

为了让人类与开发 Agent 都能一眼分清**“不可妥协的设计原则”**、**“一步步推导且不能 Break 的理想工作方式”**与**“阶段性待修 Bug”**，仓库按以下结构分层组织：

```text
ng-agents/
├── AGENTS.md / CLAUDE.md          # Agent 开发宪章：强制遵循 01-principles 与 02-workflows，严禁破坏用例不变量
├── docs/                          # 分层文档体系（总索引见 docs/README.md）
│   ├── 01-principles/             # 第一层：产品、原子内核与宿主安全设计原则（Why & Red Lines）
│   ├── 02-workflows/              # 第二层：产品理想工作方式与 7 组核心用例逐步推导（How & MUST-NOT-BREAK Invariants）
│   ├── 03-bugs/                   # 第三层：Bug 台账（BUG-001 ~ BUG-013）与端到端实测审计档案（What's Open Now）
│   └── 04-references/             # 第四层：2026 行业 Agent 调研与早期演进历史归档
├── packages/                      # 内核层：protocol + 6 个封闭原语 (channel/inbox/context/loop/workspace/gate) + cell 容器
├── presets/                       # 编排层：6 套角色预设 (inline/project/worker/watcher/sensor/hub)、Prompt 契约与 SKILL.md
└── apps/gtd-desk/                 # 应用层：本地常驻服务端、Web 三视图界面、stdio MCP 桥接与外部主 Agent 插件 (main-agent/)
```

### 核心文档快速入口

1. **[第一层：产品与架构设计原则](./docs/01-principles/)**
   - [产品表层设计原则](./docs/01-principles/01-product-principles.md) · [原子内核与编排原则](./docs/01-principles/02-kernel-principles.md) · [安全边界与算力治理准则](./docs/01-principles/03-safety-and-boundaries.md)
2. **[第二层：产品理想工作方式与用例逐步推导（不能 Break）](./docs/02-workflows/)**
   - [运行机制总纲](./docs/02-workflows/00-system-mechanics.md) · [UC01 随手记/回复/信源](./docs/02-workflows/uc01-capture-reply-and-sources.md) · [UC02 代码交付与接力终审](./docs/02-workflows/uc02-code-delivery-and-relay.md) · [UC03 人机协同与专注区](./docs/02-workflows/uc03-human-collaboration-and-engage.md) · [UC04 远期想法预研停靠](./docs/02-workflows/uc04-someday-research-and-reactivate.md) · [UC05 工作树并发与阻塞仲裁](./docs/02-workflows/uc05-workspace-concurrency-and-arbitration.md) · [UC06 领域直通中枢](./docs/02-workflows/uc06-domain-hub-direct-stream.md) · [UC07 外部主 Agent 跨夜托管](./docs/02-workflows/uc07-external-agent-and-overnight-hosting.md)
3. **[第三层：Bug 记录与实测审计台账](./docs/03-bugs/README.md)**
   - 汇总当前待修的 `BUG-001` ～ `BUG-013`（分批修复路线图）及 [2026-11-18 端到端实测审计原档](./docs/03-bugs/audits/2026-11-18-traex-live-e2e.md)。
4. **[第四层：行业调研与历史归档](./docs/04-references/README.md)**
   - [2026 热门 AI Agent 产品调研与十个底层工程共性](./docs/04-references/2026-agent-landscape.md) 及早期设计演进留档。

---

## 快速开始 / 运行

**环境要求**：Node.js ≥ 24（使用内置 `node:sqlite`）、pnpm（版本见根目录 [package.json](./package.json)）。无需 Docker 或原生编译扩展。

```bash
pnpm install      # 安装依赖
pnpm build        # 构建 Web 界面（apps/gtd-desk/dist/web）
pnpm start        # 启动工作台：同一端口提供界面和接口，默认 http://127.0.0.1:8790
pnpm dev          # 开发模式：服务端热重载 + Vite 界面（http://127.0.0.1:5173，接口转发至 8790）
pnpm typecheck    # 全工作区类型检查
pnpm test         # 全套单元与用例回归测试（vitest，不调用真实外部模型）
```

### 执行后端选择（CLI Agent / API / 演示模式）

启动时通过 `NG_AGENT_BACKEND`（默认 `auto`）选择驱动引擎，顶栏与启动日志会标明当前生效后端（`claude` / `codex` / `agy` / `anthropic` / `openai` / `demo`）：

| 取值 | 行为 |
| :--- | :--- |
| `auto`（默认） | 依次检测本机已安装的 `claude`、`codex`、`agy`；均未安装但配了 API Key 则走 API；否则自动进入**演示模式** |
| `claude` / `codex` / `agy` | 强制使用指定 CLI Agent 执行后台 `Cell`；未安装则在启动时直接报错，不静默降级 |
| `api` | 使用 API 工具循环（Anthropic 或 OpenAI 兼容接口）；未配 Key 启动即报错 |

```bash
NG_DESK_DEMO=1 pnpm start                                   # 强制进入演示模式（独立使用 data-demo/）
NG_AGENT_BACKEND=claude pnpm start                          # 使用本机 Claude Code
NG_AGENT_BACKEND=codex pnpm start                           # 使用本机 Codex CLI
NG_AGENT_BACKEND=agy pnpm start                             # 使用本机 Antigravity CLI
ANTHROPIC_API_KEY=sk-... NG_AGENT_BACKEND=api pnpm start    # 使用 API 模式
```

- **模型动态切换**：模型清单在运行时向当前 CLI 实时查询，可在网页顶栏「模型」面板或 `GET / PUT /api/models` 为「主力」与「轻量」分别指定模型与推理强度（保存至数据目录 `models.json`，从下一轮生效）。
- **数据存储与断点恢复**：默认位于 `apps/gtd-desk/data/`（`NG_DESK_DATA_DIR` 可改），包含单一 WAL 模式 `ng.db`、`skills/`、`cells/` 与 `cli-procs/`。代码与文档保留在你自己的真实目录中，服务重启自动恢复未完消息、到期提醒与遗留进程清理。
- **访问控制**：默认仅监听 `127.0.0.1` 并拦截非本机 Host 与跨站写请求；绑定非回环地址时必须配置至少 16 位的 `NG_DESK_TOKEN`。外部 Webhook 回调路径为 `/hooks/<渠道 id>`，仅在配置对应 `NG_SECRET_<REF>` 验签密钥后挂载。

---

## 接入外部主 Agent（把工作台当作后台手脚）

日常交互的 CLI Agent 以独立身份 `agent:<id>` 接入控制面（拥有创建、带话、暂停/恢复/取消、代办常规卡片与存偏好权限；**对外向他人发信**与**超预算续费**锁定 `ownerOnly` 需本人在网页点击）：

1. **通用 stdio MCP 接入**（[apps/gtd-desk/bin/ng-mcp.mjs](./apps/gtd-desk/bin/ng-mcp.mjs)）：
   ```bash
   D=$(pwd)/apps/gtd-desk/bin/ng-mcp.mjs
   claude mcp add ng-desk -e NG_DESK_URL=http://127.0.0.1:8790 -e NG_AGENT_TOKEN=<token> -- node $D
   codex  mcp add ng-desk --env NG_DESK_URL=http://127.0.0.1:8790 --env NG_AGENT_TOKEN=<token> -- node $D
   agy    mcp add --env NG_DESK_URL=http://127.0.0.1:8790 --env NG_AGENT_TOKEN=<token> ng-desk node $D
   ```
   *(仅监听本机回环且未配令牌时，可省略 `NG_AGENT_TOKEN`，本机进程以 `agent:local` 免令牌访问。)*
2. **开箱即用插件与命令模板**：
   - **Antigravity 原生插件**：`agy plugin install apps/gtd-desk/main-agent/ng-desk`（详见 [插件说明](./apps/gtd-desk/main-agent/ng-desk/README.md)）
   - **Claude Code `/todo` 命令**：将 [apps/gtd-desk/main-agent/todo.md](./apps/gtd-desk/main-agent/todo.md) 复制到 `~/.claude/commands/todo.md`
