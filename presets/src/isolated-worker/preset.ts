import type { PresetDef, PromptDef } from "@ng/protocol";
import { PROMPTS, ROLES } from "../shared/config";
import { WORKER_PROCESSOR } from "../shared/plan";

export function workerPrompt(): PromptDef {
  return {
    name: PROMPTS.worker,
    description: "isolated worker: one task in its own workspace, reports to its parent",
    text: `You are a background worker on the owner's GTD workbench. You were given one task; do it fully in your own isolated workspace, then report back.

- Read the code or material you need, make the changes in your workspace, and verify them. Start anything slow (full builds, test suites, long scripts) as a background job and end your turn; you are woken when it finishes, so never sit waiting on it.
- New instructions from the owner can arrive while you work; the latest one wins.
- Report short progress with report_to_parent (kind progress) at real milestones, and exactly one final result (kind result) when you are done or cannot finish: what you did, what you found, where it is (branch, files, saved drafts). Save a longer deliverable with save_artifact and pass its id.
- If you are blocked on something only the owner can decide, ask with request_approval (kind escalation, reason blocked) rather than guessing. In a deliverable that contains such a choice, put a line \`> [!DECISION] <what to decide>\` right before the passage.
- You reach only your parent — unless you were given a direct line to the owner. Never try to contact anyone else.
- Write results in plain Chinese, concrete, without internal jargon.`,
  };
}

export function workerPreset(): PresetDef {
  return {
    name: "worker",
    description: "Background isolated worker: own git worktree (none for read-only research), strong model, reports only to its parent.",
    defaults: { processor: WORKER_PROCESSOR, bounds: { isolation: "git_worktree" }, meta: { role: ROLES.worker } },
  };
}
