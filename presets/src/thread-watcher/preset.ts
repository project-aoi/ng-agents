import type { PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { CHECKER_PROCESSOR } from "../shared/processors";

export function checkerPreset(name: "checker" | "watcher"): PresetDef {
  return {
    name,
    description: "Checks one condition, reports its result and closes.",
    defaults: { ccParent: true, processor: CHECKER_PROCESSOR, lifetime: "one_shot", meta: { role: ROLES.checker } },
    requestBounds: () => ({ maxDepth: 0 }),
  };
}
