# 执行循环、模型档位、Watcher 监听与 CLI 适配层缺陷单

> **状态**：`open`  
> **发现来源**：[2026-11-18 trae-x 真实端到端压测审计](./audits/2026-11-18-traex-live-e2e.md)  
> **关联设计原则与用例**：[02-kernel-principles.md](../01-principles/02-kernel-principles.md)（`P-KERN-3`、`P-KERN-4`）、[03-safety-and-boundaries.md](../01-principles/03-safety-and-boundaries.md)（`P-SAFE-2`）、[uc02](../02-workflows/uc02-code-delivery-and-relay.md)、[uc05](../02-workflows/uc05-workspace-concurrency-and-arbitration.md)

---

## `BUG-004`（P1）：`auto` 模式下 `modelTier: "fast"` 完全失效，全员退化跑旗舰 `@xhigh` {#bug-004}

- **精确源码位置**：
  - [packages/cell/src/models.ts](../../packages/cell/src/models.ts#L94-L132)
  - [packages/loop/src/cli/models.ts](../../packages/loop/src/cli/models.ts#L50-L65)
- **实测触发证据**：
  - 压测中 3 个简单 CI 轮询 `watcher` 与最后一步纯文本写盘 `worker` 均显式声明了 `modelTier: "fast"`，但底层 14 个 `Cell` **100% 运行在 `gpt-6.2-sol@xhigh`**！导致 3 个监听器白烧 `4.94M` 真实 Token（记账 `9.68M`），写报告分身也因 `@xhigh` 陷入近 3 分钟过度长思考与完美主义二次返工。
- **根因机理**：
  - 默认配置下 `strong` 和 `fast` 均为 `{ mode: "auto" }`，而 `choiceOf` 函数完全忽略了传入的 `tier` 参数，一律返回 `catalog.recommended` 并挑最高推理强度（`xhigh`）。
- **目标修复方向（对齐 `INV-UC02-05`）**：
  - 将 `tier` 传入 `choiceOf(tier, sel)`：在 `auto` 模式下，`strong` 继续选 CLI 首选模型 + 高推理档；`fast` 自动匹配模型清单中的轻量快速模型（如 mini / flash / haiku 系列），若清单仅有同系列旗舰模型则自动将推理强度降为 `low` 或 `medium`。

---

## `BUG-005`（P1）：Watcher 机制五处缺陷（过重 LLM 轮询、双定时器空转、瞬态重跑误自毁、缺目录上下文、合入窗口滞后） {#bug-005}

- **精确源码位置**：
  - [presets/src/project/toolset.ts](../../presets/src/project/toolset.ts#L78-L109)
  - [presets/src/thread-watcher/preset.ts](../../presets/src/thread-watcher/preset.ts#L16)
  - [presets/src/shared/prompts.ts](../../presets/src/shared/prompts.ts#L150-L160)
- **五个子缺陷拆解**：
  1. **`dispatch` 不支持零 Token 确定性脚本探针**：所有 `watcher` 每次轮询都拉起完整 LLM 会话重读递增历史，等待 90 分钟 CI 期间无法实现常态 `0 Token` 探测。
  2. **`idleSec` 与 `set_reminder` 双定时器竞态空转**：`project` 的 `dispatch` 工具给 `watcher` 挂了 `schedules: [{ idleSec }]`，而 `checkerPromptText` 又指示模型每轮调 `set_reminder`——后者总比 `idleSec` 早 8～11 秒触发，导致 `inbox_schedules` 表 100% 空转浪费。
  3. **未区分「CI 自动重跑/自愈中」与「MR 终态失败」导致误自毁**：`watcher` #2 看到首轮 PTY 测试挂了 2 条历史用例，尽管已经查明 MR 仍为 `open` 且发布方在 2 分钟前已启动重跑，仍机械调用 `report_to_parent(status: "failed")` 自毁退出，打断接力链。
  4. **`inheritCwd: false` 把 `watcher` 丢进空私有目录**：导致监听器看不到项目工作目录上下文，6 个子分身累计浪费 40+ 次 `shell` 满世界查找远端 CLI 绝对路径。
  5. **临近合入无自适应收紧 + 过度脱敏拖延**：`watcher` #3 在 `23:29` 已探测到 23/23 检查全绿 `mergeable=true`，仍死板设 `600s` 闹钟白睡 7 分多钟；确认合入后又连写 9 个脚本过度清洗 URL 参数（把正常 query 全删空了，害下游写报告分身花近 4 分钟重查拼链接）。
- **目标修复方向（对齐 `INV-UC02-04`）**：
  - 支持在 `dispatch(preset: "watcher")` 时可选提供确定性检查命令/探针（常态未就绪消耗 `0 Token`，仅状态变化或异常时唤醒 `fast` 模型研判）；
  - 收敛为单一唤醒定时源（有 `idleSec` 时不重复设单次闹钟，或统一由 `set_reminder` 自适应控制间隔：临近全绿合入自动收紧至 `60s`）；
  - 更新 `checkerPromptText` 明确：MR 仍 `open` 且重跑已在途或新提交已推送属于“等待中”，继续监听而不报 `failed`；保留 `watcher` 对项目只读目录上下文的可见性。

---

## `BUG-008`（P1）：CLI 适配层漏采隐藏 JS `exec`、后台 `jobs` 闲置、`cwdMode: "read"` 未挂 OS 只读沙箱 {#bug-008}

- **精确源码位置**：
  - [packages/loop/src/cli/adapters/codex.ts](../../packages/loop/src/cli/adapters/codex.ts#L41-L45)、[codex.ts](../../packages/loop/src/cli/adapters/codex.ts#L186-L199)
  - [packages/loop/src/cli/loop.ts](../../packages/loop/src/cli/loop.ts#L627-L678)
- **三个子缺陷拆解**：
  1. **漏采 193 次 Code Mode `custom_tool_call`**：Codex CLI 启用内置 JS REPL（`exec`）做内存计算与拼稿时发出的是 `custom_tool_call` / `custom_tool_call_output` 事件，`codex.ts` 未解析，导致 193 次调用在 `evidence` 表中完全隐身且绕过 `maxSteps` 统计。
  2. **跨轮次异步 `jobs` 原语 100% 闲置**：`kernelSystem` 提示词引导 CLI 优先用原生工具执行一切命令，导致慢任务也在单轮 CLI 进程内硬等，数据库的 `jobs` 表 0 条记录。
  3. **`cwdMode: "read"` 未挂载 CLI 操作系统级只读保护**：`capabilitiesOf` 仅看 `bounds.tools` 而不看 `cwdMode`，导致声明只读的分身仍以 `-s danger-full-access` / `bypassPermissions` 启动，全凭提示词自觉防误写。
- **目标修复方向（与 [`05-proposals`](../05-proposals/README.md) 合流更新）**：
  - **必做（并入提案第 2 批）**：在 `codex.ts` 完整采集 `custom_tool_call` / `custom_tool_call_output` 入库 `evidence` 并计入步数，确保 `inspect_cell` 与第 4 视图「分身实况（`Agents`）」操作流零遗漏；
  - **已由提案消解（免做）**：[提案分册三](../05-proposals/03-ai-driven-workspace-and-project-notes.md)已决定取消 `worker` 的 `cwdMode: "read" | "write"` 区分与内核排队（仅保留 `sensor` 只读），无需再为 `worker` 额外开发 OS 只读沙箱。
