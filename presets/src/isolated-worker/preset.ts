import type { PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { WORKER_PROCESSOR } from "../shared/processors";

/**
 * One piece of work in one directory of the owner's real machine (isolation "none" is inherited: no worktree, no
 * sandbox). A leaf: `maxDepth: 0`, so it cannot start cells (what its own CLI does with sub-agents is the CLI's
 * business). `wakeable`: when its turn is over the kernel tells its parent and it rests — any later message, from its
 * project or straight from the owner, continues it on the same session.
 */
export function workerPreset(): PresetDef {
  return {
    name: "worker",
    description: "Executor: one piece of work in its directory (reads, changes code, runs commands, researches). Its parent is told when its turn is over; it then rests and can be woken again with a message.",
    defaults: { processor: WORKER_PROCESSOR, lifetime: "wakeable", meta: { role: ROLES.worker } },
    requestBounds: () => ({ maxDepth: 0 }),
  };
}
