import type { PresetDef } from "@ng/protocol";
import { sourceInit } from "../shared/sensor";
import { newSource } from "../shared/records";
import { gtdKeys } from "../shared/keys";
import { ROLES } from "../shared/config";
import { SENSOR_LLM_PROCESSOR } from "../shared/processors";

export function sensorPreset(): PresetDef {
  return {
    name: "sensor",
    description: "Mailbox source: scheduled/conditional check (code or fast-tier filter); silent when nothing is found, source.hit to the desk on a hit; observe mode only keeps notes.",
    // It may need commands for its check, in a directory of its own; it only looks (its prompt's red line).
    defaults: { processor: SENSOR_LLM_PROCESSOR, lifetime: "persistent", meta: { role: ROLES.sensor } },
    inheritCwd: false,
    requestBounds: () => ({ maxDepth: 0 }),
    onCellCreated(cell, store, clock) {
      const init = sourceInit(cell.spec);
      const now = clock.now();
      store.commitSync(cell.id, { statePatches: { [gtdKeys.source]: newSource(init, now) } });
      if (cell.spec.processor.kind === "llm" && init.description) {
        store.appendEvidenceSync(cell.id, {
          kind: "system_note",
          runId: null,
          at: now,
          text: `[source setup] ${init.title}: ${init.description}`,
        });
      }
    },
  };
}
