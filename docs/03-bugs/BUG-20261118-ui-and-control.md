# Web UI 视图投影与外部主 Agent 控制面缺陷单

> **状态**：`open`  
> **发现来源**：[2026-11-18 trae-x 真实端到端压测审计](./audits/2026-11-18-traex-live-e2e.md) 与 [README 遗留缺口记录](../../README.md)  
> **关联设计原则与用例**：[01-product-principles.md](../01-principles/01-product-principles.md)（`P-UX-2`、`P-UX-5`、`P-UX-6`）、[uc04](../02-workflows/uc04-someday-research-and-reactivate.md)（`INV-UC04-03`）、[uc07](../02-workflows/uc07-external-agent-and-overnight-hosting.md)

---

## `BUG-010`（P1）：停靠在「以后再说（`someday`）」的调研报告在 Web UI 上完全打不开 {#bug-010}

- **精确源码位置**：
  - [apps/gtd-desk/src/shared/api.ts](../../apps/gtd-desk/src/shared/api.ts#L556-L589)（`ProjectRowDTO`）
  - [apps/gtd-desk/src/server/projections/radar.ts](../../apps/gtd-desk/src/server/projections/radar.ts)
  - [apps/gtd-desk/src/web/views/Radar.tsx](../../apps/gtd-desk/src/web/views/Radar.tsx#L97-L192)
- **实测触发证据**：
  - `research_then_park` 跑完后只把完整调研结论存为项目的 `Artifact` 并调 `finish_project({ outcome: "someday" })` 停靠（不弹审批卡、也不建 `@Human` 动作）。
  - 但后端 `ProjectRowDTO` 未投影项目关联的 `artifacts` 列表，前端 `Radar.tsx` 项目行（尤其是 `以后再说` 专区）也没有任何报告阅读抽屉入口——导致后台跑了半小时产出的高质量报告，用户在网页上只能看到两行截断摘要，完全点不开正文，只能回终端让外部主 Agent 调 MCP `read_artifact` 代读！
- **目标修复方向（对齐 `INV-UC04-03`，与[提案分册四](../05-proposals/04-agents-topology-and-live-chat-tab.md)合并实现）**：
  - 在 `ProjectRowDTO` 与节点详情接口中投影关联的 `artifacts` 摘要列表（`artifactId`、`title`、`version`、`updatedAt`），在 Web UI 抽出一套通用的 Markdown 报告阅读抽屉组件，同时挂载到 `Radar`（含活跃项目、已完结归档与 `以后再说` 停靠行）以及新增第 4 视图 `Agents`（分身实况）的节点头部与时间线胶囊上。

---

## `BUG-011`（P2）：GTD 视图状态投影三处错位（`waiting` 文案、周回顾噪音、`someday` 双徽章） {#bug-011}

- **精确源码位置**：
  - [packages/protocol/src/gtd.ts](../../packages/protocol/src/gtd.ts#L73)、[apps/gtd-desk/src/web/components/chrome.tsx](../../apps/gtd-desk/src/web/components/chrome.tsx#L118)
  - [apps/gtd-desk/src/server/projections/review.ts](../../apps/gtd-desk/src/server/projections/review.ts#L64-L70)
  - [apps/gtd-desk/src/server/projections/radar.ts](../../apps/gtd-desk/src/server/projections/radar.ts#L156)、[apps/gtd-desk/src/agent/tools.ts](../../apps/gtd-desk/src/agent/tools.ts)
- **三个子缺陷拆解**：
  1. **`waiting` 球权文案过于狭隘**：硬编码为「等待回复 / 在等外部回复」，当后台实际在等本地测试锁释放或云端 CI 合入时，让用户误以为在等某人回消息。应统一优化为「等待外部」（结合具体动作标题说明在等什么）。
  2. **内部流水线子步骤污染「15 分钟周回顾」**：`review.ts` 无条件捞取所有 `status === "done"` 的 Action，导致在途项目内部派出的七八棒 `worker / watcher` 脚手架动作全塞进了周回顾右侧「本周完结」栏。周回顾应聚焦项目级交付完结项与人类（`owner === "human"`）亲自办结的事项。
  3. **`someday` 与 `paused` 状态及徽章混淆**：因为 `someday` 底层将 `Cell` 置为 `paused`，`radar.ts` 未排除 `lifecycle === "someday"`，导致停靠项目在网页上同时挂出「已暂停」+「以后再说」两个徽章，顶栏还虚报“2 项已暂停”；同时 MCP `get_project` 输出 `状态：someday；paused` 容易误导外部主 Agent 调 `set_project_state("resume")`（实际停靠项必须传 `"activate"`）。

---

## `BUG-012`（P2）：外部主 Agent 控制面排障视野受限与三处遗留边界小缺口 {#bug-012}

- **精确源码位置**：
  - [apps/gtd-desk/src/agent/tools.ts](../../apps/gtd-desk/src/agent/tools.ts)、[apps/gtd-desk/src/agent/guide.ts](../../apps/gtd-desk/src/agent/guide.ts)
  - [presets/src/inline-desk/items.ts](../../presets/src/inline-desk/items.ts)、[packages/cell/src/lifecycle.ts](../../packages/cell/src/lifecycle.ts)
- **问题清单**：
  1. **外部主 Agent 工具视野与大文档分页缺口**：
     - `get_project` 过滤掉了已关闭的历史子 `Cell`（排障看不到刚跑完哪几棒），且不展示当前项目的 Token 预算使用进度（`subtreeTokens / limitTokens`）；
     - MCP `read_artifact` 无 `{ version, offset, limit }` 分页参数（遇到百 KB 报告一调就拍满主会话上下文）；
     - `get_cell` 每条记录截断在 200 字符偏短，且 MCP 未暴露按 URI 分页读取溢出日志的 `read_resource`。
  2. **三处已知低频边界小缺口**：
     - 经立项提案卡片批准启动的项目，`principalId` 总是记在主台名下而非原发起人；
     - `Cell` 创建后不支持动态修改 `cwdMode`（只读分身发现需改文件时按规范应回报上级另派写分身，属预期但可评估报错提示清晰度）；
     - 对已关闭的一次性分身异常调用底层恢复时，可能使同级计数超过 `maxConcurrentChildren`。
