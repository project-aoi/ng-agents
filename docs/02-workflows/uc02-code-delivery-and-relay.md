# 代码交付、接力与验收

主人通过 /todo 请后台修改表格复制逻辑。主台确认仓库后派给项目，分身在真实工作树修改并运行测试。项目拉取结果，视需要追加独立终审或合入检查，向主人交付可核对的结果。

本机替身：[fixtures/uc02.sh](fixtures/uc02.sh)（Node 仓库与裸远端）、[fixtures/forge.py](fixtures/forge.py)（MR 与 CI；首轮 CI 偶发失败后自动重跑）。

## 行为约定

**`INV-UC02-01`**　缺工作目录时先问清宿主路径。未答的提问在总览里可见，答复带 `replyToId`。

**`INV-UC02-02`**　本地提交完成后继续跟踪约定的合入、验收和交付条件。验收由主人作出；合入先发生时如实说明主人尚未验收。新一轮修改沿用原来的验收事项并更新下一步。

**`INV-UC02-03`**　在途工作、开放人工动作和探针结果均要结清；待命分身不占执行名额。

**`INV-UC02-04`**　checker 首轮检查实际状态，对仍在重跑的检查保持等待。

**`INV-UC02-05`**　可确定的检查用脚本，简单状态判定按轻量档执行。脚本检查附带它看到的状态，而不只是退出码。

## 端到端步骤

1. 主人：“/todo 表格复制……改好提个 MR。” 不给路径 → 主台追问。
2. 主人：“手头有啥事？” → 能看到这条提问。答：“在 /home/owner/dev/tui-table。”
3. 项目派分身：建分支、改 `src/copy.js`、补测试、跑 `npm test` 与 `npm run lint`、推分支、`forge mr create`。CI 首轮失败重跑期间保持等待。
4. 主人：“MR 先别急着合，找个没参与过的分身独立终审，有问题让原来那个改。” → 新分身只读评审，原分身修复，原评审者复核。
5. 维护者执行 `forge mr merge 1` → 脚本探针报告合入，项目结清各项后结项，说明主人是否已验收。

## 2026-11-23 实测

01、03、05 通过。02 部分：验收由项目自己勾掉（E16）。04 部分：CI 由分身的后台任务等待，没有走 checker。独立终审找到并复现了颜色码残留。另见 E08、E11、E18。明细见[核对报告](../03-bugs/audits/2026-11-23-codex-e2e-workflows.md)。

同日修复，自动回归通过，尚未实机复跑。E08、E11、E16、E18：总览列出未答提问，分叉项目用自己的角色提示词，验收只由主人完成，立项简报不再误引原话。

## 回归入口

[scenario-code-change.test.ts](../../presets/test/scenario-code-change.test.ts)、[probe.test.ts](../../presets/test/probe.test.ts)、[agent-relay.test.ts](../../apps/gtd-desk/test/agent-relay.test.ts)、[cli.test.ts](../../packages/loop/test/cli.test.ts)、[conventions.test.ts](../../presets/test/conventions.test.ts)、[tools.test.ts](../../presets/test/tools.test.ts)。
