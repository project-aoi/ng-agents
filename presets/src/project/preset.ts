import type { PolicyBounds, PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { PROJECT_PROCESSOR } from "../shared/processors";
import { prepareProjectRun } from "./books";

export function projectPreset(): PresetDef {
  return {
    name: "project", projectRoot: true,
    description: "Persistent coordinator of one outcome: keeps the record, the actions, its notes and the shared report; hands every piece of real work to a worker and reads what it did.",
    defaults: { stallPolicy:"monitor", processor: PROJECT_PROCESSOR, lifetime: "persistent", meta: { role: ROLES.project } },
    requestBounds: () => ({ canSendTo: ["channel:ui:owner"] as unknown as PolicyBounds["canSendTo"] }),
    prepareRun: (input) => prepareProjectRun(input),
  };
}
