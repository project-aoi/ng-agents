// docs/05 Phase 3 — the built-in playbooks. A role prompt states the contract; these show it carried out, step by
// step, with the exact tool calls. They are ordinary global skills (SKILL.md under <dataDir>/skills): seeded when
// missing, and replaced by a newer text only while the installed one is exactly a text shipped before (seed.ts) — the
// owner's edits are the point of having them as files.

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
    "For a project cell: how to run a multi-step outcome as a relay of workers — what to put in each hand-off, reading what a worker did when its turn is over, sending the next step to the worker that already knows the work or to a new one, waiting for outside events and for the owner, staged work, and finishing with preferences saved.",
  tags: ["project", "builtin"],
  body: `# Project relay

A project is a relay race: you hold the baton — the goal, the plan, the records, the shared report and your "board" note — and each worker runs a leg. A worker that has run its leg does not leave the track: you are told that its turn is over, and it rests (dormant), remembering everything about its leg, until a message sends it out again. So the next leg goes either to the worker that already knows the ground (send_message) or to a new runner (dispatch). That choice, and the baton, are yours.

## The hand-off: what a dispatch instruction contains
A new worker knows only what you write. Use this shape and leave nothing implicit:

\`\`\`
目标：<这一棒要交付什么，一句话>
目录：<绝对路径>（<只读分析：不改文件、不切分支 | 可以改动>）
同仓：<"active workspaces" 里此刻还有谁在这个仓库改代码；有人在改时写明：只做查阅，或用 git worktree add 另建工作树、在那里改；没有就写"无">
现场：<上一棒留下的分支、提交、未合入的改动；或"干净的主干">
材料：<要读的路径、链接、artifact id 与版本>
做法与约束：<主人的偏好、不能碰的东西>
验证：<怎么算做对了>
交付：<结束时要说清的：分支、MR 链接、artifact id、没验证到的部分>
\`\`\`
A follow-up to a worker that already ran a leg is shorter: it knows the goal, the directory and what it did, so say what is new and what to deliver.

## When a worker's turn is over
The notice (\`cell.result\`) carries the worker's own summary, the stretch of its record the turn covers, and whether the owner talked to it directly. Then:
1. Look before you rely on it: inspect_cell shows what it was told, what it said, the files it changed and the commands it ran with how they ended. Always look when the owner spoke to it directly — that is where a changed requirement shows up.
2. Take what matters into your books (update_project, track_action) and rewrite your board note (save_note kind "note", scope "cell", name "board"): per worker what it is for, where it works, how far you have read its record, what the owner changed along the way.
3. Decide the next leg: more work on what it just did → send_message to that worker; a different piece, or one that should run alongside → dispatch; a delivery → the owner's review (Pattern B).

## Pattern A — some parts can start now, one part waits for the owner
Example: compare three code bases; two are on disk, the third must be requested from a colleague.
1. dispatch a worker for the parts that can start, told to only read. Ask it to create the report artifact and give its id.
2. track_action owner "human": title "要到 Doubao work 的代码", nextStep "向 <谁> 要代码，放到 <路径> 后在这里勾掉". Tell the owner once. If the code will land at a known path, also dispatch a watcher with check { command: "test -d <路径>" } — it costs nothing while the directory is missing, and you continue even if the owner forgets to tick the box.
3. wait with waitingFor "human". (The first worker keeps working; the notice that its turn is over wakes you too.)
4. When the owner ticks the action or the watcher reports: the missing part goes into the same report. The first worker is dormant and knows the report — send it the new path ("Doubao work 的代码已在 <路径>，按同样的维度补上这一部分，更新 artifact <id>"), or dispatch a new worker with the artifact id and its current version. Either way it extends the report; it does not start a new one.
5. The report is complete: tell the owner where it is, record "验收：对比报告" as a human action and wait. The owner asks for additions: one more message to the worker that wrote it, or one more dispatch on the same artifact. Report version numbers go up; nothing is lost. Finish when they accept it.

## Pattern B — code change, then MR, then "one more thing", then wait for the merge
1. dispatch a worker into the repository to make the change. When its turn is over, inspect_cell: which branch, which commits, what was verified. Tell the owner (what changed, branch, what was and was not verified), record track_action owner "human" "验收：<改动>", and wait with waitingFor "human". Do not finish: unpushed code on a local branch is a delivery, not the end.
2. The owner says "用 /ship-mr 跟进": that is more work on what the worker just did, so it goes to the same worker — send_message to inbox:<its id>: "用 /ship-mr 推分支并建 MR，报告 MR 链接". It wakes with the branch and its changes in mind. Its first action is already closed, so record this step: track_action owner "agent", title "用 /ship-mr 提 MR", cellId <its id>. Note for later that this is a habit worth saving.
3. The owner says "补个录屏": a recording takes a while and can run beside the MR work — dispatch a second worker into the same directory: "现场：分支 <分支>；只录屏，不改文件、不切分支".
4. As soon as the MR exists, dispatch a watcher for it, with a check command so that the waiting costs nothing: instruction "检查 MR <链接> 是否已合入", check { command: "gh pr view <n> --json state -q .state | grep -qx MERGED", everySec: 600 } (for GitLab, \`glab mr view <n>\` and its state). The action is now "waiting".
5. The watcher reports "merged" while the screencast worker is still working: do **not** finish yet. Finish when every accepted piece is done. A dormant worker is not in the way: it is archived with the project.
6. Before finish_project: save_note kind "preference", scope "global" — e.g. name "code-change-followup", body "改完代码后直接用 /ship-mr 提 MR，并附一段验证录屏，不用再等我说". Name it in finish_project's retro.

## Pattern C — an idea for later, then a staged build
1. Started with mode "research_then_park": dispatch one worker, told to only read, to research how others do it (web allowed) and save a report artifact. When its turn is over: update_project with a one-line summary, then finish_project outcome "someday". You are parked with everything kept.
2. Woken later (the owner raised it again): read your report (read_artifact), tell the owner in two lines what it concluded, ask what changed. Then split the work into phases: track_action for each with its phase number, owner "agent".
3. Run phase 1 only. When it is done: request_approval kind "action", title "阶段 1 完成，是否开始阶段 2", with what was delivered and what phase 2 would do. Start phase 2 only after the answer. One phase in flight at a time, even though the machine could run them all.

## When a worker comes back with a problem
- It asks you about its directory ("工作区冲突/公共受阻，请指示": changes it was not told about, an unexpected branch, another cell changing the same files) and waits for your answer. Answer it with send_message: whose changes they are (your board note, inspect_cell on your other workers, the note "active workspaces"), which branch to be on, whether to wait or to work in a work tree of its own (\`git worktree add\`). If another project's cell is in the way, ask the desk; if the changes belong to no cell, they are the owner's — ask the owner, and never tell the worker to discard them.
- It asked the desk instead (a CI failure that is everybody's, changes that belong to nobody it knows of): nothing for you to do until the desk answers it; its next turn tells you how it went.
- Its turn ended with status "failed": read what happened (inspect_cell), not only the reason it gave. Missing input → get the input (human action or another worker). Wrong plan → change the plan and say so in update_project. The worker is dormant with everything it learned, so a corrected instruction sent to it is often the quickest way on. Never send the same instruction again unchanged.
- send_message answers "NOT DELIVERED … closed": that cell is really gone (it was stopped, or it was a watcher that has reported). Dispatch a new worker with the context it needs — what the previous one did, the branch or artifact it left.
`,
};

const domainHub: BuiltinSkill = {
  name: SKILL_DOMAIN_HUB,
  description:
    "For a hub cell: how to turn a batched stream of direct messages (review requests, incident pings) into topics, forward follow-ups to the worker already on a topic — working or resting, it continues with everything it knows — and start a new one only when that worker is gone.",
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

- 1 + 2 are one topic, mr-41, new → spawn_cell preset "worker", cwd = the repository's directory, instruction: "评审 MR !41（<链接>），仓库 <目录>，默认分支 <分支>。张三特别提到：重点看并发。只做查阅，不要改文件、不要切分支。交付：评审意见（阻塞项/建议项），写成 artifact 并报告 id。"
- 3 is not yours → handback with its id, reason "不是代码评审的事".
- 4 is mr-38; the ledger says worker cell_abc is on it → send_message to "inbox:cell_abc": "王五说 !38 改好了，请再看一眼（<原话>）".
  - "Delivered" → done. A worker still reviewing takes it before its turn ends; one whose review turn is over is resting, and the message wakes it — it re-checks with its first review and everything it learned in mind.
  - "NOT DELIVERED … closed" → that worker is gone (someone stopped it). spawn_cell a new worker: "继续评审 MR !38：上一轮结论见 artifact <id>（ledger 里记着）；作者王五称已修改，请复核上一轮的阻塞项是否解决。只做查阅，不要改文件、不要切分支。"
- Update the ledger for mr-41 and mr-38, end the turn.

## When a worker's turn is over
You are told (\`cell.result\`, with its summary). The summary is its own account; before you pass an outcome on, or when the summary leaves doubt, inspect_cell shows what it actually did. Update the topic in the ledger: done — or, for a review with blocking issues, "waiting for the author", with the worker left as it is, resting and ready for the next round.

## Rules of thumb
- Nothing queues for a repository and nothing locks it: every worker starts the moment you spawn it. Reviewing and investigating only read — say "只做查阅，不要改文件、不要切分支" in the instruction — so they can run beside anyone.
- A fix changes files. Look at the note "active workspaces" first: nobody is changing code in that repository → start the worker there; someone is → tell it "用 \`git worktree add <新目录> <默认分支>\` 建独立工作树，在那里改，不要动 <目录> 的检出". A fix that belongs to a topic whose worker already knows the code goes to that worker instead.
- A worker that asks you what to do about a directory that is not as expected is waiting for your answer: answer it, or pass the question to the desk and tell the worker so.
- A reply to the people in the thread is the owner's to approve: send_message to the thread creates the draft and the card. Say in the summary which topic it answers.
- You never close a topic by silence: either its worker's turn brought the outcome, or you handed it back.
`,
};

const workspaceArbitration: BuiltinSkill = {
  name: SKILL_WORKSPACE_ARBITRATION,
  description:
    "For the desk: the full decision procedure when a cell reports a directory in an unexpected state or a shared blocker (public CI down) — one fixer per cause, everyone waiting is told, and the owner's own uncommitted work is never touched.",
  tags: ["desk", "arbitration", "builtin"],
  body: `# Workspace arbitration

A cell wrote to you and is now asleep, waiting for inbox:desk. It stopped before changing anything — that is what a cell does when its directory is not as described or something outside its task blocks it. Until you answer, it stays asleep, and nothing else wakes it for this — so every request ends with a send_message to that cell. Trouble inside one project goes to that project first; what reaches you is shared by several cells, crosses projects, or belongs to nobody the cell knows — or it is a question a project passed on.

## Step 0 — read the request
It should give: directory, branch, \`git status\` (or the failing job and error), its task, what it needs. If something essential is missing, ask it (send_message to inbox:<id>) — it wakes, answers and waits again.

## Step 1 — whose problem is it?
Look at the live note "active workspaces" (who is working in which directory right now, in which project), the in-flight list, and [cells waiting on you] (each independent wait and its reference). inspect_cell on a cell shows what it was told and what it did.

### A. Shared blocker — the cause is outside the reporter's task and hits others too
Signs: a CI job fails on the main branch as well; several cells report the same error; a shared service or dependency is broken.
Use one stable cause ("ci-develop-lint"). Read the waiting cells and each waitId. Reuse an active fixer whose meta.relatedProjectIds match the affected projects.
- First report: spawn one worker with the affected project ids and a concrete instruction.
  - The repository's checkout is on the reporter's feature branch? Then the fixer should not work in it: instruct "在独立目录修复：\`git -C <repo> worktree add <临时目录> origin/develop\`（或另行 clone），在那里修、提 MR、合入后删除你自己建的这个 worktree；不要动 <repo> 当前检出".
- Every further report of the same cause: use the registered wait and the existing fixer. Keep intermediate progress at the desk. Only notify a waiter when it has an actionable answer.
- You are told the fixer's turn is over (\`cell.result\`): check that it really is fixed — its summary, and inspect_cell when the summary leaves doubt. Something left to do: send it to the fixer (send_message; it rests between turns and continues where it stopped). Fixed: for each registered waiter, call send_message { refId: "<matching waitId or refId>", to: "inbox:<waiter>", summary: "公共问题已处理", text: "ci已修复（<MR 链接>），可以 rebase develop 然后继续推进" }. A send that comes back "NOT DELIVERED … closed" means that cell was stopped, or its project ended, meanwhile — nothing more for you to do; its project decides whether someone carries on. The kernel settles each answered wait.
- The fixer failed: keep the waiters asleep and raise it to the owner (request_approval, reason "blocked") — do not leave them waiting on a fix that is not coming.

### B. Somebody else's work in the same place
Signs: an unexpected branch or uncommitted changes that match what another cell did (inspect_cell on the cells of the project in question; its records: read_state with cellId = the project, prefix "gtd:"; its artifacts; search_history scope "global" for the branch name), or a cell of another project changing the same files right now (the note "active workspaces").
- Left by an earlier step of the same work: "这是上一棒 <谁> 留下的 <分支/改动>，属于本项目：留在该分支上继续，不要丢弃" — or "切回 <分支>：\`git switch <分支>\`（改动已提交在 <提交>）".
- Two cells really are in each other's way (both changing code in one work tree): decide who goes first — the other waits for your word — or tell the asker to do its part in a work tree of its own: "用 \`git worktree add <新目录> <分支>\` 建独立工作树，在那里改，不要动 <目录> 的检出". Tell the other cell's project what you decided when it changes anything for them.

### C. Nobody's — it is the owner's
Signs: uncommitted changes, no cell has worked in this directory recently, nothing in any project's records explains them.
- **Never** instruct reset / clean / stash / checkout over it. The owner is mid-edit.
- request_approval kind "escalation", reason "blocked", title "<目录> 里有你未提交的改动", explanation with the branch and the changed files, and the three choices: "等我提交完再继续 / 我自己 stash，之后继续 / 让它另开目录做".
- Include relatedProjectIds and a stable arb:<cause> subject. Give each meaningful choice a reply option. Verify that the chosen route works before waking waiters. If only some can proceed, reply to those individually using refId; leave the others waiting.
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

/**
 * Per playbook, the digests (seed.ts skillDigest) of every text an earlier version shipped. An installed playbook that
 * is still exactly one of them was never touched by the owner, so seeding replaces it with the current text; anything
 * else is theirs and stays. When you change a playbook, add the digest of the text it had before to its list.
 */
export const SUPERSEDED_SKILL_DIGESTS: Readonly<Record<string, readonly string[]>> = {
  // 2026-11-18: one-shot workers, cwdMode read/write, writers queued by the kernel.
  [SKILL_PROJECT_RELAY]: ["862adcc1128d43b0fe9e80a897e16be0eccafa56e3f0c0f828eb248e5c669528"],
  [SKILL_DOMAIN_HUB]: ["ab567185e4c44b045ec9388f8352e6daf44bfecc44d61f91d6758bb0f7d04762"],
  [SKILL_WORKSPACE_ARBITRATION]: ["23a46645c0c73286a8a0c9039668c0dcfbb8466233ece18943ea96af5280f437","39e657a5fecc8fdf1da5b3ad17238fc64e91f2a11262c2a41328126633022870","ec1b4870c4c4cbcba535712f7331837a06000b4b120028ff3919b3a3e98de5d0","2fd6bd61786138935a735117b3f8f23391574330e476cfcad2717c005dc74c3e"],
};
