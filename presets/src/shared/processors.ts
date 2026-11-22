import type { ProcessorSpec, ToolKind } from "@ng/protocol";
import { PROMPTS, STD, TOOLSETS } from "./config";
import { SKILL_DOMAIN_HUB, SKILL_PROJECT_RELAY } from "./skills";

// The processors of the presets' cells. Every role gets the general primitives (context, comms, schedule, cells,
// workspace): what a role does with them is its prompt's business, not a tool filter's (docs/05 principle 6).

/** The desk: triage and arbitration. The arbitration and habit playbooks are in its skills index, read on demand. */
export const DESK_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.desk,
  modelTier: "strong",
  skills: [],
  toolsets: [TOOLSETS.desk, STD.context, STD.comms, STD.schedule, STD.cells, STD.workspace],
};

/** A project: keeps the records and the shared report, hands every piece of real work to a worker. */
export const PROJECT_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.project,
  modelTier: "strong",
  skills: [SKILL_PROJECT_RELAY],
  toolsets: [TOOLSETS.project, STD.context, STD.comms, STD.schedule, STD.cells, STD.workspace],
};

/** A worker (a leaf: with maxDepth 0 the spawn/steer/close tools of STD.cells are not offered to it). */
export const WORKER_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.worker,
  modelTier: "strong",
  toolsets: [STD.workspace, STD.context, STD.comms, STD.schedule, STD.cells],
};

/** The `watcher` preset's default: a light one-shot checker (update_cell on itself for watches, bash for `gh`/`git`). */
export const CHECKER_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.checker,
  modelTier: "fast",
  toolsets: [STD.workspace, STD.context, STD.comms, STD.schedule, STD.cells],
};

/** A hub: routes one stream of direct messages to workers. */
export const HUB_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.hub,
  modelTier: "strong",
  skills: [SKILL_DOMAIN_HUB],
  toolsets: [STD.context, STD.comms, STD.schedule, STD.cells, STD.workspace],
};

export const SENSOR_LLM_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.sensor,
  modelTier: "fast",
  toolsets: [TOOLSETS.sensor, STD.context, STD.workspace],
};

/**
 * Tool kinds for a bounds *request* that travels as JSON (inside a task payload or a stored spec): a Set would
 * serialize to `{}`, so the request carries an array, which attenuation accepts.
 */
export function toolKinds(...kinds: ToolKind[]): ReadonlySet<ToolKind> {
  return kinds as unknown as ReadonlySet<ToolKind>;
}
