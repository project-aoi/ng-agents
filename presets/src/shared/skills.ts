// Built-in playbooks (ordinary global SKILL.md files seeded when missing and auto-updated when unedited).

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
    "For a project cell: running multi-step work through autonomous workers — crisp hand-offs, inspecting turns, reusing workers and checkers in place, handling parallel/human/staged patterns, and closing cleanly.",
  tags: ["project", "builtin"],
  body: `# Project relay

Keep the goal, plan, action books, shared report and concise \`working_note\` ("board") on the project; reuse listed actionIds in dispatch/track_action. Empower each worker to finish "diagnose → fix → verify" inside its leg instead of bouncing micro-steps across extra roles.

## Hand-off shape (new worker)
\`\`\`
目标：<一句话交付物>
目录：<绝对路径>（只读查阅 | 可改动；如有并发写入注明 git worktree add）
现场：<上一棒分支、提交或干净主干>
材料：<路径、链接、artifact id 与版本>
约束与验证：<主人偏好、边界、怎么算做对了>
\`\`\`
Follow-ups to an existing worker need only what changed and what to deliver. At a major phase switch (e.g. implementation → CI/release) on a long-lived worker, pass \`update_cell({ cellId, resetSession: true })\` so it starts a clean session with its summary and notes.

## After a worker's turn (\`cell.result\`)
1. Call inspect_cell before relying on deliverables — especially when the owner spoke directly to the worker.
2. Update update_project, track_action and rewrite "board".
3. Next leg: follow-up on same piece → send_message; independent/parallel piece → dispatch; ready for owner → delivery + human acceptance action.

## Pattern A — partial start while waiting on the owner
1. dispatch a read-only worker for available inputs to start the report artifact.
2. track_action owner "human" with concrete nextStep, notify owner once, and wait with waitingFor "human". If the missing input lands at a known path, add a zero-cost checker (\`ls -d <路径> 2>&1; test -d <路径>\`, everySec 60, deadlineHours 72) so work resumes even if the owner forgets to tick the box.
3. When the input arrives, send_message the dormant worker to extend the report (or synthesize module drafts once across 3+ parallel workers), then deliver for human acceptance.

## Pattern B — code change, MR, parallel extras, merge
1. dispatch a worker to implement and verify locally before pushing. After inspect_cell, deliver clearly to the owner, record one acceptance action (track_action owner "human"), and wait with waitingFor "human" (do not close on an unpushed local branch; reuse this single acceptance action across later rounds).
2. Follow-ups like "/ship-mr" go via send_message to the same worker (+ track_action owner "agent", cellId). Independent parallel extras (e.g. screencast) get a separate read-only worker.
3. Once an MR exists, check \`[in-flight child cells]\` and start one zero-cost checker (\`check: { command: 's=$(gh pr view <n> --json state -q .state); echo "state=$s"; test "$s" = MERGED -o "$s" = CLOSED', everySec: 120, deadlineHours: 72 }\`; \`glab mr view <n>\` for GitLab; verify non-empty fields with \`test -n "$s"\`). On new pushes or target changes, update the existing checker in place via update_check instead of spawning duplicates. Keep business MRs free of unrelated shared CI scripts.
4. Wait until every accepted piece finishes before finish_project (close remaining actions via settle_item / track_action; cancel an unreviewed acceptance action and say so in finish_project's summary). Report confirmed reusable rules to the desk and name them in retro.

## Pattern C — research_then_park & staged builds
1. On \`research_then_park\`, dispatch one read-only research worker, update_project, and finish_project outcome "someday".
2. When woken later, follow \`[back from a pause …]\`, read_artifact to recap conclusions briefly, and stage work (numbered phases + request_approval \`action {name: "phase.advance"}\` between phases) only when the owner asks to review each stage.

## Worker blockers & failures
- Workspace conflict: clarify ownership, branch, or \`git worktree add\` (escalate cross-project issues to desk, unowned changes to owner — never discard).
- Failure: inspect_cell first, adjust the plan or fetch missing input, then send corrected guidance (never repeat an unchanged failing prompt). On "NOT DELIVERED … closed", dispatch a replacement with the prior state/artifact.
`,
};

const domainHub: BuiltinSkill = {
  name: SKILL_DOMAIN_HUB,
  description:
    "For a hub cell: turning batched topic messages into tracked topics, forwarding follow-ups to dormant/running workers, and replacing closed workers cleanly.",
  tags: ["hub", "builtin"],
  body: `# Domain hub

## Topic state (\`hub:topics\`)
\`\`\`json
{
  "mr-41": { "about": "Review MR !41 限流阈值", "repo": "gateway", "worker": "cell_…", "state": "reviewing", "thread": "ui:reviews" },
  "inc-order-5xx": { "about": "order-service 线上 5xx", "repo": "order", "worker": null, "state": "done" }
}
\`\`\`
Read with read_state key "hub:topics" when not in recent context; update with set_state after every change.

## Handling one batch
- Group messages for the same MR/incident into one topic → spawn_cell preset "worker" in the repo cwd ("只做查阅，不要改文件、不要切分支" for reviews; \`git worktree add\` for fixes when "active workspaces" shows another writer).
- Out-of-domain items → handback with id and reason.
- Existing topic → send_message to \`inbox:<worker>\`. If "NOT DELIVERED … closed", spawn_cell a replacement with the prior artifact id and new context.

## Worker completion
On \`cell.result\`, inspect_cell when needed, update "hub:topics" (keep worker dormant if waiting on author revisions), mark superseded reports in state and via patch_artifact line 1, and notify the owner via send_message to \`channel:ui:owner\`. Never close a topic silently.
`,
};

const workspaceArbitration: BuiltinSkill = {
  name: SKILL_WORKSPACE_ARBITRATION,
  description:
    "For the desk: settling shared blockers and workspace conflicts cleanly — check mainline first, freeze pending-approval fixers, never act as a compile lock, and protect the owner's uncommitted work.",
  tags: ["desk", "arbitration", "builtin"],
  body: `# Workspace arbitration

A cell wrote to you and is waiting on \`inbox:desk\`. Every request ends with an actionable send_message (passing matching waitId/refId as \`refId\`), a tracked active fixer, or a pending decision card covering it.

## Hard boundaries before acting
1. **Never act as a build/compile lock scheduler**: separate worktrees and target directories build independently. Never create \`arb:cargo-window-*\` or serialize local builds/tests via desk messages — if a host ever hits CPU/RAM pressure, handle it via OS parallelism flags or local file locks, never LLM arbitration.
2. **Check mainline reality first**: before spawning or waking a shared-blocker fixer, inspect recent upstream commits (\`git fetch origin\` and \`git log <base>..origin/<main>\`). If mainline already landed a fix, tell the waiting cells to rebase/pull instead of duplicating work.
3. **Freeze pending-approval fixers**: once a shared fixer has produced a pending decision card for the owner, do **not** wake it for side forensic chores or secondary experiments while awaiting approval.
4. **No ad-hoc temporary CI pipelines**: if verification requires a target OS or environment unavailable on this host, report the environment gap plainly to the owner instead of fabricating temporary CI workflows or piggybacking diagnostic scripts onto business MRs.

## Step 1 — classify and resolve
Check "active workspaces", \`[in-flight child cells]\`, \`[cells waiting on you]\`, and inspect_cell / search_history (scope "global").

### A. Shared blocker (broken main CI, shared dependency/service)
- First verify upstream mainline has not already fixed it.
- Reuse one active fixer per stable cause (\`meta.relatedProjectIds\`). If the shared checkout is on a feature branch, instruct \`git -C <repo> worktree add <临时目录> origin/<main>\` (remove that worktree after merge; never leave fixes in a throwaway clone). Keep intermediate progress at the desk.
- When the fixer's turn ends (\`cell.result\`), inspect_cell if needed and verify: (1) where the fix lives (branch / MR / merged), (2) who merges it per README/CODEOWNERS (if owner, raise one card: request_approval kind "action", subjectKey \`arb:<cause>\`, \`relatedProjectIds\`, \`blockingProjectIds\` limited to projects genuinely blocked on this merge, \`sourceCellId\` when batching multiple cell messages, and reply option e.g. \`{ id: "merged", label: "已合入", effect: "reply" }\`), (3) whether the shared checkout was left off main.
- Answer every waiter with send_message (\`refId\` matching waitId/refId). Waiters that can proceed off the fix branch are unblocked; others remain covered by the card until resolved. When the owner confirms merge (card or settle_item), answer remaining waiters and send quiet: true notes to projects previously told "尚未合入". Close the fixer (close_cell) only after merge or owner decline.
- If the fixer fails, keep waiters asleep and escalate via request_approval (kind "escalation", subjectKey \`arb:<cause>\`, \`blockingProjectIds\`, explicit reply options).

### B. Another cell's work in the same work tree
- Same project's prior leg → tell the asker to stay on/switch to that branch and keep the changes.
- Concurrent writers in one checkout → assign order or instruct \`git worktree add <新目录> <分支>\`, informing the other project if affected.

### C. Nobody's — the owner's uncommitted work
- **Never** instruct reset, clean, stash or checkout over it.
- Raise request_approval (kind "escalation", subjectKey \`arb:<cause>\`, \`blockingProjectIds\` for blocked projects, explicit reply options: wait until committed / owner stashes / work in a new worktree) listing directory, branch and changed files. On \`approval.resolved\`, relay actionable steps to every waiter with matching \`refId\`.
`,
};

const habitDiscovery: BuiltinSkill = {
  name: SKILL_HABIT_DISCOVERY,
  description:
    "How to find recurring owner routines from history and propose a scheduled source, preference or skill without starting silently.",
  tags: ["desk", "routine", "builtin"],
  body: `# Habit and routine discovery

Notice recurring manual work, verify it, and propose taking it over — never switch automation on unasked.

## Finding routines
- Use search_history (scope "global") for recurring deliverables (e.g. weekly reports) and open hits with read_resource to verify sources, order, and structure.
- Count as a routine only when the same deliverable recurs at a regular rhythm (at least 3 times); otherwise record a cell-scoped reference note and revisit at the next weekly review.

## Proposing automation
1. Capture the recipe with suggest_skill.
2. Propose the schedule via request_approval (kind "action", explicit reply options) or direct chat — never silently enable it, and do not use present_to_owner or propose_project for a recurring source.
3. Once approved, call add_source in the owner's time zone naming the skill.
4. Save smaller lasting preferences via save_note (kind "preference", scope "global") only after owner confirmation.
`,
};

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [projectRelay, domainHub, workspaceArbitration, habitDiscovery];
