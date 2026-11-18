---
description: 把一件事交给 ng-agents 工作台（先查重、缺信息先问、再立项或随手记）
argument-hint: <要做的事，原话即可>
---

主人要记下或交办这件事：

$ARGUMENTS

用 `ng-desk` 这个 MCP 服务器的工具处理，按它的说明（server instructions）行事，要点：

1. 先看有没有同一件事：`search` 关键词，必要时 `workbench_overview`。已有进行中的项目、停靠的想法或报告，就告诉我它的状态并问是否继续（`message_project` / `set_project_state` activate），不要重复立项。
2. 判断它是什么：
   - 只是想先记一下、不确定做不做 → `create_project`，`mode: "research_then_park"`（先调研出报告再停靠），或者只是备忘/提醒 → `capture`。
   - 现在就要做 → 先把缺的信息问我要齐。涉及代码必须有本机仓库的绝对路径：没有就问，不要猜。
3. 信息齐了再 `create_project`：`brief` 里带上我的原话、路径、约束和“怎样算做完”。
4. 立项后用一两句话告诉我：建了什么、接下来会发生什么。不要在这个对话里自己动手做这件事，也不要循环轮询进度。
