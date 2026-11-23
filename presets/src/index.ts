export { gtdKeys } from "./shared/keys";
import { gtdLifecycle } from "./shared/lifecycle";
export {gtdLifecycle} from "./shared/lifecycle";
// @ng/presets — the workbench's cell templates (docs/05): the desk (triage + arbitration), persistent projects that keep
// the records and dispatch workers (they rest between turns and can be woken again), light checkers, sources and hubs,
// with their prompts, toolsets, playbooks and the few zero-token processors. This is where the GTD product behaviour lives; the records they keep (gtd.ts)
// are what the workbench UI renders.

import type { Registry } from "@ng/protocol";
import { sensorPreset } from "./cron-sensor/preset";
import { hubPreset } from "./hub/preset";
import { createDeskBooks } from "./inline-desk/items";
import { deskPreset } from "./inline-desk/preset";
import { deskToolset } from "./inline-desk/toolset";
import { workerPreset } from "./isolated-worker/preset";
import { projectPreset } from "./project/preset";
import { projectToolset } from "./project/toolset";
import { resolveConfig, type RegisterPresetsOptions } from "./shared/config";
import { actionBooks } from "./shared/human-actions";
import { createCheckProbe } from "./shared/probe";
import { promptDefs } from "./shared/prompts";
import { createScriptSensor, sensorToolset } from "./shared/sensor";
import { checkerPreset } from "./checker/preset";

export type { RegisterPresetsOptions, PresetsConfig } from "./shared/config";

export interface RegisteredPresets {
  presets: string[];
  prompts: string[];
  toolsets: string[];
  codeProcessors: string[];
}

/**
 * Registers the six presets (`inline` = the desk, `project`, `worker`, `checker`, `sensor`, `hub`), their prompts,
 * toolsets and code processors on `registry`. Call once per
 * registry, before the desk is created and before `kernel.start()`. The standard toolsets the presets list are
 * registered by the kernel. Afterwards, `seedBuiltinSkills` installs the playbooks the prompts refer to.
 */
export function registerPresets(registry: Registry, opts: RegisterPresetsOptions = {}): RegisteredPresets {
  registry.reserveState(
    ["gtd:project", "gtd:source", "gtd:activity", "desk:arbitration", "watch:state", "probe:state"],
    ["gtd:project:", "gtd:source:", "gtd:activity:", "gtd:action:", "desk:suggestion:"],
  );
  const cfg = resolveConfig(opts);
  const books = createDeskBooks(cfg);
  const presets = [deskPreset(books), projectPreset(), workerPreset(), checkerPreset(), sensorPreset(), hubPreset()];
  const prompts = promptDefs(cfg);
  const toolsets = [deskToolset(cfg, books), projectToolset(), sensorToolset()];
  const processors = [createScriptSensor(), createCheckProbe(cfg)];
  for (const p of presets) registry.presets.register({...gtdLifecycle, actionBooks, ...p});
  for (const p of prompts) registry.prompts.register(p);
  for (const t of toolsets) registry.toolsets.register(t);
  for (const c of processors) registry.codeProcessors.register(c);
  return {
    presets: presets.map((p) => p.name),
    prompts: prompts.map((p) => p.name),
    toolsets: toolsets.map((t) => t.name),
    codeProcessors: processors.map((c) => c.name),
  };
}

// ---------- for the app, the control plane, custom sensors ----------

export { sensorPreset };
export { PROMPTS, TOOLSETS, PROCESSORS, ROLES, KEYS, RESTORE_REASON } from "./shared/config";
export { BUILTIN_SKILLS, type BuiltinSkill } from "./shared/skills";
export { seedBuiltinSkills } from "./shared/seed";
export { createSensorSpec,sensorProcessor,createScriptSensor,defineSensorCheck, ensureSource, recordCheck, OBSERVATION_NOTE, type CheckOutcome, type HitOrigin, type SensorHit, type SensorCheckInput, type SourceInit } from "./shared/sensor";
export { notifyProjectOfOwnerChangeSync } from "./shared/sync";
export { startProjectSync, projectLaunch, type ProjectInit, type ProjectLaunch, type ProjectTaskInput, type ProjectSeed, type PlannedAction, type RepoRef, type ProjectMode } from "./project/launch";
export { startApprovedProjectSync, projectIdForApproval, type ProposalItem } from "./inline-desk/items";
export type { ProbeArgs, ProbeState, ProbeUntil } from "./shared/probe";

export { writeActionRecordSync, readHumanActionRecords } from "./shared/human-actions";

export type * from "./shared/product-records";
