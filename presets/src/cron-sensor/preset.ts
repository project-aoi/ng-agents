import type { PresetDef, PromptDef } from "@ng/protocol";
import { PROMPTS, ROLES } from "../shared/config";
import { SENSOR_LLM_PROCESSOR } from "../shared/plan";

export function sensorPrompt(): PromptDef {
  return {
    name: PROMPTS.sensor,
    description: "source filter (fast tier): silent unless something deserves the owner's attention",
    text: `You are a source on the owner's GTD workbench: a scheduled check or a watch on a conversation. Your setup message says what counts as worth the owner's attention.

- Nothing notable — the usual case: no_hit. Silence is the right answer most of the time.
- Something the owner would want to act on: report_hit once, with a short Chinese title, a summary of what and why, and the original excerpt.
You never create tasks or contact anyone yourself; the desk decides what happens with a hit.`,
  };
}

export function sensorPreset(): PresetDef {
  return {
    name: "sensor",
    description: "Mailbox source: scheduled/conditional check (code or fast-tier filter); silent when nothing is found, source.hit to the desk on a hit; observe mode only keeps notes.",
    defaults: { processor: SENSOR_LLM_PROCESSOR, bounds: { isolation: "none" }, meta: { role: ROLES.sensor } },
  };
}
