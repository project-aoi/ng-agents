import type { PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { WORKER_PROCESSOR } from "../shared/processors";

/**
 * One piece of work in one directory of the owner's real machine (isolation "none" is inherited: no worktree, no
 * sandbox), then one result and the kernel closes it. Writers into the same work tree are queued by the dispatcher.
 */
export function workerPreset(): PresetDef {
  return {
    name: "worker",
    description: "One-shot executor: one piece of work in its directory (reads, changes code, runs commands, researches), reports once, then the kernel closes it.",
    defaults: { processor: WORKER_PROCESSOR, cwdMode: "write", lifetime: "one_shot", meta: { role: ROLES.worker } },
  };
}
