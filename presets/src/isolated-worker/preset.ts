import type { PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { WORKER_PROCESSOR } from "../shared/processors";

/** A worker runs in its assigned host directory and resumes the same session on follow-up. */
export function workerPreset(): PresetDef {
  return {
    name: "worker",
    description: "Executor: one piece of work in its directory (reads, changes code, runs commands, researches). Its parent is told when its turn is over; it then rests and can be woken again with a message.",
    defaults: { ccParent:true, processor: WORKER_PROCESSOR, lifetime: "wakeable", meta: { role: ROLES.worker } },
    requestBounds: () => ({ maxDepth: 0 }),
  };
}
