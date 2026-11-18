import type { ProcessorSpec, ToolKind } from "@ng/protocol";
import { PROCESSORS, PROMPTS, STD, TOOLSETS } from "./config";
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

/** A project: keeps the records and the shared report, hands every piece of real work to a one-shot worker. */
export const PROJECT_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.project,
  modelTier: "strong",
  skills: [SKILL_PROJECT_RELAY],
  toolsets: [TOOLSETS.project, STD.context, STD.comms, STD.schedule, STD.cells, STD.workspace],
};

/** A one-shot worker. */
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

/** The reply watcher (await_reply): zero tokens, any message from the party is the reply. */
export const WAIT_MATCH_PROCESSOR: ProcessorSpec = { kind: "code", entry: PROCESSORS.waitMatch };

/** The reply watcher's model variant (await_reply interpret: true): the model judges messages, code keeps the books. */
export const REPLY_WATCHER_LLM_PROCESSOR: ProcessorSpec = {
  kind: "llm",
  prompt: PROMPTS.watcher,
  modelTier: "fast",
  toolsets: [TOOLSETS.watcher, STD.comms, STD.context],
};

/**
 * Tool kinds for a bounds *request* that travels as JSON (inside a task payload or a stored spec): a Set would
 * serialize to `{}`, so the request carries an array, which attenuation accepts.
 */
export function toolKinds(...kinds: ToolKind[]): ReadonlySet<ToolKind> {
  return kinds as unknown as ReadonlySet<ToolKind>;
}
