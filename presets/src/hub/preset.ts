import type { PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { HUB_PROCESSOR } from "../shared/processors";

export function hubPreset(): PresetDef {
  return {
    name: "hub",
    description: "Persistent router for one stream of direct messages: batches what its watch routes, hands each topic to a worker, forwards follow-ups.",
    defaults: { processor: HUB_PROCESSOR, lifetime: "persistent", absorbInbound: true, meta: { role: ROLES.hub } },
  };
}
