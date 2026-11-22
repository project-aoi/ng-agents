---
description: 把一件事交给 ng-agents 工作台（能确定归属就直达，不确定就交给总助理分拣）
argument-hint: <要做的事，原话即可>
---

主人要记下或交办这件事：

$ARGUMENTS

用 `ng-desk` 这个 MCP 服务器的工具处理，按它的说明（server instructions）行事。工作台里分三层：总助理（desk）查重、决定事情归谁；项目（project）对一个交付目标负责；执行分身（worker）干具体的一块活。要点：

1. 先看现状：`workbench_overview`，必要时 `search` 关键词。
2. 判断归属：
   - 明确是某个进行中项目的追加要求 → `message_project`；明确是对某个分身说的话 → `message_cell`（它在待命会被唤醒，所属项目自动收到抄送）。
   - 新的事、说不清归谁、可能和已有工作重复 → `chat_with_desk`，原话转给总助理，由它查重、追问缺的信息（代码类必须有本机仓库的绝对路径）并放到对的地方。
   - 信息已经问齐、`search` 确认没有同题项目时，也可以自己 `create_project`（`brief` 带上原话、路径、约束和“怎样算做完”）；只想先记着的点子用 `mode: "research_then_park"`。
3. 主人要勾掉人工待办或处理决策卡时，先用 `list_human_items` 读取当前选项、修订号（`itemRevision`）和草稿版本（`artifactVersion`），再用 `decide_human_item` 提交对应选项与备注（已推迟事项在到期前不会列出）；需要主人亲自批准的立项执行项（`ownerOnly: true`），引导主人在「待我处理」确认。添加或管理定时信源、查看周回顾建议请通过 `chat_with_desk` 交给总助理处理。
4. 总助理在后台回复：我问起时用 `chat_with_desk` 带 `since` 读它的回复并转述；回答它的追问时带上那条追问的 `replyToId`。
5. 用一两句话告诉我交给了谁、接下来会发生什么。不要在这个对话里自己动手做这件事，也不要循环轮询进度。
