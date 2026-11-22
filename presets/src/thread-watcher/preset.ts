import type { PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { CHECKER_PROCESSOR, WAIT_MATCH_PROCESSOR } from "../shared/processors";

/** The historical watcher name remains readable on pre-migration databases. */
export function watcherPreset(name: "watcher" | "checker" | "reply_watcher" = "checker"): PresetDef {
  return {
    name,
    description:
      name === "reply_watcher"
        ? "Waits for an external reply and delivers it to the coordinator."
        : "Light one-shot checker of one outside condition (MR merged, CI green, a path exists, a reply arrived): looks at the current state first, reports when it holds.",
    defaults: {
      ccParent: true,
      processor: name === "reply_watcher" ? WAIT_MATCH_PROCESSOR : CHECKER_PROCESSOR,
      lifetime: name === "reply_watcher" ? "persistent" : "one_shot",
      meta: { role: name === "reply_watcher" ? ROLES.watcher : ROLES.checker },
    },
    requestBounds: () => ({ maxDepth: 0 }),
  };
}
