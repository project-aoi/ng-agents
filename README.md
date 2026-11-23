# ng-agents

ng-desk 是运行在本机的工程工作台。可以在网页里与主台交流，也可以从日常使用的 Claude Code、Codex 或 Antigravity 交办项目。项目保存任务、文稿和工作记录，分身在指定目录执行工作，结束一轮后可以沿原会话继续。

## 启动

使用 Node.js 24 或更高版本、仓库指定的 pnpm 和至少一个已登录的本地命令行引擎。

```sh
pnpm install
pnpm build
pnpm start
```

默认地址为 `http://127.0.0.1:8790`。用 `NG_AGENT_RUNNERS=claude,codex` 指定可用的本机 CLI runner，支持 `claude`、`codex` 和 `agy`。列表中的 runner 都须能运行，第一个是初始默认值。未配置列表时沿用 `NG_AGENT_BACKEND` 或自动选择首个可用 CLI。`NG_DESK_DATA_DIR` 指定本机数据目录。首次启动自动创建 v1 数据库。开发时可运行 `pnpm dev`。

网页右上角可保存全局默认 runner，以及该 runner 的主力和轻量模型与推理强度。`start_project`、`dispatch`、`spawn_cell` 等工具在说明中列出已启用的 runner 和各自的模型与推理强度。启动节点时可选填 `runner`、`model`、`effort`。三个参数都省略时，节点在每次运行时使用全局默认设置。指定 `model` 时会绑定所选 runner，省略 `runner` 时绑定当时的全局默认 runner。填写 `effort` 时也要填写 `model`。

| 视图 | 可以做什么 |
| --- | --- |
| 待我处理 | 处理待办和决定、提供补充材料、核对并保存文稿 |
| 项目全局 | 查看项目进度、工作目录、报告和停靠项目，恢复或结束工作 |
| 分身实况 | 查看运行记录，与分身直接对话，检查项目收到了哪些回报 |

定时检查在信源抽屉管理。个人提醒到期进入待办。项目方案可列出后台步骤和需要主人亲自完成的动作。文稿保存和卡片决定都带版本，后台更新后需要重新核对。

- [外部助手接入](apps/gtd-desk/main-agent/ng-desk/README.md)
- [开发约定](AGENTS.md)
- [产品、工作流与缺陷台账](docs/README.md)

在仓库根目录运行 `pnpm typecheck && pnpm test && pnpm build`。

工作台在默认回环地址启动时生成本次主人的登录链接。配置 `NG_AGENT_TOKEN` 或 `NG_AGENT_TOKENS` 时，同时为主人配置独立的 `NG_DESK_TOKEN`。助手凭据只用于助手接口。
