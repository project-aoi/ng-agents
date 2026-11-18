// docs/05 Phase 3 — the built-in playbooks. A role prompt states the contract; these show it carried out, step by
// step, with the exact tool calls. They are ordinary global skills (SKILL.md under <dataDir>/skills): seeded once when
// missing, never overwritten — the owner's edits are the point of having them as files.

export interface BuiltinSkill {
  name: string;
  description: string;
  tags: string[];
  body: string;
}

export const SKILL_PROJECT_RELAY = "project-relay";
export const SKILL_DOMAIN_HUB = "domain-hub";
export const SKILL_WORKSPACE_ARBITRATION = "workspace-arbitration";
export const SKILL_HABIT_DISCOVERY = "habit-and-routine-discovery";

const projectRelay: BuiltinSkill = {
  name: SKILL_PROJECT_RELAY,
  description:
    "For a project cell: how to run a multi-step outcome as a relay of one-shot workers — what to put in each hand-off, how to wait for outside events and for the owner, staged work, and finishing with preferences saved.",
  tags: ["project", "builtin"],
  body: `# Project relay

A project is a relay race: you hold the baton (goal, plan, records, the shared report) and each worker runs one leg and hands it back. The runner leaves; the baton stays with you.

## The hand-off: what a dispatch instruction contains
A worker knows only what you write. Use this shape and leave nothing implicit:

\`\`\`
目标：<这一棒要交付什么，一句话>
目录：<绝对路径>（<只读分析 | 可以改动>）
现场：<上一棒留下的分支、提交、未合入的改动；或“干净的主干”>
材料：<要读的路径、链接、artifact id 与版本>
做法与约束：<主人的偏好、不能碰的东西>
验证：<怎么算做对了>
交付：<report 里要写清的：分支、MR 链接、artifact id、没验证到的部分>
\`\`\`

## Pattern A — some parts can start now, one part waits for the owner
Example: compare three code bases; two are on disk, the third must be requested from a colleague.
1. dispatch a read-only worker for the parts that can start. Ask it to create the report artifact and report its id.
2. track_action owner "human": title "要到 Doubao work 的代码", nextStep "向 <谁> 要代码，放到 <路径> 后在这里勾掉". Tell the owner once. If the code will land at a known path, also dispatch a watcher that checks \`test -d <路径>\` — then you continue even if the owner forgets to tick the box.
3. wait with waitingFor "human". (The first worker keeps running; its result wakes you too.)
4. When the owner ticks the action or the watcher reports: dispatch the next worker with the report's artifact id and current version, to add the missing part — not to start a new report.
5. The report is complete: tell the owner where it is, record "验收：对比报告" as a human action and wait. The owner asks for additions: one more dispatch on the same artifact. Report version numbers go up; nothing is lost. Finish when they accept it.

## Pattern B — code change, then MR, then "one more thing", then wait for the merge
1. dispatch a writer into the repository. Its report gives the branch and what was verified. Tell the owner (what changed, branch, what was and was not verified), record track_action owner "human" "验收：<改动>", and wait with waitingFor "human". Do not finish: unpushed code on a local branch is a delivery, not the end.
2. The owner says "用 /ship-mr 跟进": dispatch a second writer into the same directory — "现场：分支 <上一棒的分支>，改动已提交；用 /ship-mr 推分支并建 MR，报告 MR 链接". Note for later that this is a habit worth saving.
3. The owner says "补个录屏": a third dispatch, same directory, same branch.
4. As soon as the MR exists, dispatch a watcher for it: "检查 MR <链接> 是否已合入：先看当前状态（gh pr view / glab mr view），未合入则每 10 分钟再看；合入后报告合入时间". The action is now "waiting".
5. The watcher reports "merged" while the screencast worker is still running: do **not** finish yet. Finish when every accepted piece is done.
6. Before finish_project: save_note kind "preference", scope "global" — e.g. name "code-change-followup", body "改完代码后直接用 /ship-mr 提 MR，并附一段验证录屏，不用再等我说". Name it in finish_project's retro.

## Pattern C — an idea for later, then a staged build
1. Started with mode "research_then_park": dispatch one read-only worker to research how others do it (web allowed) and save a report artifact. When it reports: update_project with a one-line summary, then finish_project outcome "someday". You are parked with everything kept.
2. Woken later (the owner raised it again): read your report (read_artifact), tell the owner in two lines what it concluded, ask what changed. Then split the work into phases: track_action for each with its phase number, owner "agent".
3. Run phase 1 only. When it is done: request_approval kind "action", title "阶段 1 完成，是否开始阶段 2", with what was delivered and what phase 2 would do. Start phase 2 only after the answer. One phase in flight at a time, even though the machine could run them all.

## When a worker comes back with a problem
- "directory not in the expected state, asked the desk": nothing for you to do until it reports again — it is waiting for the desk, not for you.
- status "failed" with a reason: read the reason. Missing input → get the input (human action or another worker). Wrong plan → change the plan and say so in update_project. Never dispatch the same instruction again unchanged.
- You forwarded a follow-up with send_message and got "NOT DELIVERED … closed": dispatch a new worker with the context; that is the normal path, not an error.
`,
};

const domainHub: BuiltinSkill = {
  name: SKILL_DOMAIN_HUB,
  description:
    "For a hub cell: how to turn a batched stream of direct messages (review requests, incident pings) into topics, forward follow-ups to the worker already on a topic, and continue seamlessly when that worker has just closed.",
  tags: ["hub", "builtin"],
  body: `# Domain hub

## The ledger (state key "hub:topics")
\`\`\`json
{
  "mr-41": { "about": "Review MR !41 限流阈值", "repo": "gateway", "worker": "cell_…", "state": "reviewing", "thread": "feishu:chat-review", "updatedAt": "…" },
  "inc-order-5xx": { "about": "order-service 线上 5xx", "repo": "order", "worker": null, "state": "done" }
}
\`\`\`
Pick the key from what identifies the topic outside (MR number, incident id, a short slug). Write the ledger with set_state after every change; read it with read_state at the start of a wake-up if you do not have it.

## One batch, start to finish
Messages in the batch:
1. "@bot 看下 MR !41" (张三)   2. "@bot !41 补充：重点看并发" (张三)   3. "@bot 帮忙订会议室" (李四)   4. "@bot !38 改好了再看一眼" (王五)

- 1 + 2 are one topic, mr-41, new → spawn_cell preset "worker", cwd = the repository's directory, cwdMode "read", instruction: "评审 MR !41（<链接>），仓库 <目录>，默认分支 <分支>。张三特别提到：重点看并发。交付：评审意见（阻塞项/建议项），写成 artifact 并报告 id。"
- 3 is not yours → handback with its id, reason "不是代码评审的事".
- 4 is mr-38; the ledger says worker cell_abc is on it → send_message to "inbox:cell_abc": "王五说 !38 改好了，请再看一眼（<原话>）".
  - "Delivered" → done; the worker takes it before it finishes.
  - "NOT DELIVERED … closed" → the previous round just ended. spawn_cell a new worker: "继续评审 MR !38：上一轮结论见 artifact <id>（ledger 里记着）；作者王五称已修改，请复核上一轮的阻塞项是否解决。"
- Update the ledger for mr-41 and mr-38, end the turn.

## Rules of thumb
- Reviewing and investigating are read-only work (cwdMode "read"): they never queue and never disturb whoever is writing in that repository.
- A fix is a writer (cwdMode "write") in the repository's directory; if another writer is in there, the kernel starts yours when it is done. Do not wait, lock, or pick another directory to dodge the queue.
- A reply to the people in the thread is the owner's to approve: send_message to the thread creates the draft and the card. Say in the summary which topic it answers.
- You never close a topic by silence: either its worker reported, or you handed it back.
`,
};

const workspaceArbitration: BuiltinSkill = {
  name: SKILL_WORKSPACE_ARBITRATION,
  description:
    "For the desk: the full decision procedure when a cell reports a directory in an unexpected state or a shared blocker (public CI down) — one fixer per cause, everyone waiting is told, and the owner's own uncommitted work is never touched.",
  tags: ["desk", "arbitration", "builtin"],
  body: `# Workspace arbitration

A cell wrote to you and is now asleep, waiting for inbox:desk. It has let go of its directory. Until you answer, it stays asleep — so every request ends with a send_message to that cell.

## Step 0 — read the request
It should give: directory, branch, \`git status\` (or the failing job and error), its task, what it needs. If something essential is missing, ask it (send_message to inbox:<id>) — it wakes, answers and waits again.

## Step 1 — whose problem is it?
Look at the live note "active workspaces", the in-flight list, and read_state "desk:arbitration" (open blockers).

### A. Shared blocker — the cause is outside the reporter's task and hits others too
Signs: a CI job fails on the main branch as well; several cells report the same error; a shared service or dependency is broken.
Keep your own note of open blockers in state: set_state { patches: { "desk:arbitration": { "<key>": { title, fixer: <cell id>, waiters: [<cell ids>], openedAt } } } } — a short stable key per cause ("ci-develop-lint"). It is your memory across wake-ups; nothing else reads it.
- First report of a cause: start one fixer — spawn_cell { preset: "worker", title: "修复公共 CI", cwd: <repo>, instruction: "…" } — and note the blocker with the reporter as its first waiter.
  - The repository's checkout is on the reporter's feature branch? Then the fixer should not work in it: instruct "在独立目录修复：\`git -C <repo> worktree add <临时目录> origin/develop\`（或另行 clone），在那里修、提 MR、合入后删除你自己建的这个 worktree；不要动 <repo> 当前检出".
- Every further report of the same cause: add that reporter to the waiters in your note; no second fixer. Tell it, if useful, that a fix is under way — it keeps waiting.
- The fixer's cell.result arrives: for each waiter in the note, send_message { to: "inbox:<waiter>", summary: "公共问题已处理", text: "ci已修复（<MR 链接>），可以 rebase develop 然后继续推进" }. A send that comes back "closed" means that cell finished or was stopped meanwhile — its project will dispatch a successor; nothing more for you to do. Then remove the blocker from your note.
- The fixer failed: tell the waiters what you know and raise it to the owner (request_approval, reason "blocked") — do not leave them waiting on a fix that is not coming.

### B. Leftover from another cell
Signs: an unexpected branch or uncommitted changes that match what an earlier worker of the same project reported (read the project's records: read_state with cellId = the project, prefix "gtd:"; read its artifacts; search_history scope "global" for the branch name).
- Answer the asker: "这是上一棒 <谁> 留下的 <分支/改动>，属于本项目：留在该分支上继续，不要丢弃" — or "切回 <分支>：\`git switch <分支>\`（改动已提交在 <提交>）".
- If the earlier worker is still running in the "active workspaces" note, the asker should not be in that directory at all: tell it to wait, and tell its project.

### C. Nobody's — it is the owner's
Signs: uncommitted changes, no cell has worked in this directory recently, nothing in any project's records explains them.
- **Never** instruct reset / clean / stash / checkout over it. The owner is mid-edit.
- request_approval kind "escalation", reason "blocked", title "<目录> 里有你未提交的改动", explanation with the branch and the changed files, and the three choices: "等我提交完再继续 / 我自己 stash，之后继续 / 让它另开目录做".
- On approval.resolved: send_message to the asker with the owner's choice, in words it can execute ("主人已提交，重新检查 git status 后继续" / "在 <新目录> 用 git worktree 开工，不要碰原目录").

## Step 2 — make sure nobody is left hanging
Before you end the turn: every cell that asked has either an answer, or is on an open blocker's waiting list, or is covered by a card you raised (and you will answer it when the card is resolved).
`,
};

const habitDiscovery: BuiltinSkill = {
  name: SKILL_HABIT_DISCOVERY,
  description:
    "How to find the owner's recurring routines and unwritten habits from the record (past sessions, long tool outputs, documents, calendar) and turn them into a scheduled source, a saved preference or a skill — e.g. a weekly report prepared before the weekly meeting.",
  tags: ["desk", "routine", "builtin"],
  body: `# Habit and routine discovery

The record remembers what the owner keeps doing by hand. Your job is to notice, verify, and offer to take it over — never to start doing it unasked.

## Where to look
- search_history with scope "global": it covers every cell's messages and tool output — including closed workers and the full text of long outputs — plus artifacts and saved state. Search the thing itself ("周报", "weekly report") and its ingredients ("周会", the document's title, table or dashboard names).
- For each hit open the source (read_resource on the res:// or artifact:// link) and read around it: which data sources were queried, in which order, what the final document looked like.
- A recurring calendar entry or a document that is edited at a regular rhythm is the schedule; past sessions that produced the document are the recipe.

## What counts as a routine
The same deliverable, produced at least three times, at a regular rhythm, from the same kinds of sources. Fewer than three: note it (save_note) and look again at the next weekly review.

## Turning it into something that runs
1. Write the recipe down as a skill (suggest_skill): when it applies, the data sources with exactly how each is queried, the structure of the deliverable, what the owner always rewrites by hand.
2. Propose the schedule to the owner — never switch it on silently: present_to_owner or propose_project, e.g. "每周四 17:00（周会前）按以往做法整理周报草稿并推送给你，要开启吗？".
3. Once agreed: add_source with the cron in the owner's time zone and a description that names the skill; each run produces a draft artifact and a hit, which reaches the owner as a card they can edit before it goes anywhere.

## Smaller habits
A correction the owner makes twice ("报告先写结论", "提 MR 后贴录屏") is a preference: save_note kind "preference", scope "global", with when it applies. Check existing preferences first so you refine one instead of adding a near-duplicate.
`,
};

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [projectRelay, domainHub, workspaceArbitration, habitDiscovery];
