import type { PresetDef } from "@ng/protocol";
import { ROLES } from "../shared/config";
import { SENSOR_LLM_PROCESSOR } from "../shared/processors";

export function sensorPreset(): PresetDef {
  return {
    name: "sensor",
    description: "Mailbox source: scheduled/conditional check (code or fast-tier filter); silent when nothing is found, source.hit to the desk on a hit; observe mode only keeps notes.",
    // It may need commands for its check, in a directory of its own (never queued behind a project's work tree).
    defaults: { processor: SENSOR_LLM_PROCESSOR, cwdMode: "write", lifetime: "persistent", meta: { role: ROLES.sensor } },
    inheritCwd: false,
  };
}
