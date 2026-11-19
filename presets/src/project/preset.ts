import type { PolicyBounds, PresetDef } from "@ng/protocol";
import { ROLES, type PresetsConfig } from "../shared/config";
import { PROJECT_PROCESSOR } from "../shared/processors";
import { prepareProjectRun } from "./books";

export function projectPreset(cfg: PresetsConfig): PresetDef {
  return {
    name: "project",
    description: "Persistent coordinator of one outcome: keeps the record, the actions, its notes and the shared report; hands every piece of real work to a worker and reads what it did.",
    defaults: { processor: PROJECT_PROCESSOR, lifetime: "persistent", meta: { role: ROLES.project } },
    // Short result messages to the owner go out directly; anything to someone else (a result for whoever asked, a
    // reply watcher's nudge) still waits on the owner's card. Inboxes are inherited.
    requestBounds: () => ({ canSendTo: [cfg.ownerAddress, "channel:*"] as unknown as PolicyBounds["canSendTo"] }),
    prepareRun: (input) => prepareProjectRun(input),
  };
}
