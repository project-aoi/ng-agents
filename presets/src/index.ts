// @ng/presets — the four standard Cell templates (docs/02 §三): inline desk, isolated worker, thread watcher, cron
// sensor, with their prompts, toolsets and zero-token code processors. This is where the GTD product behaviour lives;
// the records they keep (gtd.ts) are what the workbench UI renders.

import type { Registry } from "@ng/protocol";
import { deskPreset, deskPrompt } from "./inline-desk/preset";
import { createDeskBooks } from "./inline-desk/items";
import { deskToolset } from "./inline-desk/toolset";
import { sensorPreset, sensorPrompt } from "./cron-sensor/preset";
import { workerPreset, workerPrompt } from "./isolated-worker/preset";
import { PROCESSORS, resolveConfig, type RegisterPresetsOptions } from "./shared/config";
import { createCoordinator } from "./shared/coordinator";
import { editorToolset } from "./shared/editor";
import { registerGtdPayloads } from "./shared/payloads";
import { editorPrompt } from "./shared/prompts";
import { createScriptSensor, sensorToolset } from "./shared/sensor";
import { createWaitMatch, watcherToolset } from "./shared/watcher";
import { watcherPreset, watcherPrompt } from "./thread-watcher/preset";

export type { RegisterPresetsOptions, PresetsConfig } from "./shared/config";

export interface RegisteredPresets {
  presets: string[];
  prompts: string[];
  toolsets: string[];
  codeProcessors: string[];
}

/**
 * Registers the four presets (`inline`, `worker`, `watcher`, `sensor`), their prompts, toolsets and code processors
 * on `registry`, plus the presets' private payload types (process-wide). Call once per registry, before the desk is
 * created and before `kernel.start()`. The standard toolsets the presets list are registered by the kernel.
 */
export function registerPresets(registry: Registry, opts: RegisterPresetsOptions = {}): RegisteredPresets {
  const cfg = resolveConfig(opts);
  registerGtdPayloads();
  const books = createDeskBooks(cfg);
  const presets = [deskPreset(books), workerPreset(), watcherPreset(), sensorPreset()];
  const prompts = [deskPrompt(cfg), workerPrompt(), watcherPrompt(), sensorPrompt(), editorPrompt()];
  const toolsets = [deskToolset(cfg, books), watcherToolset(cfg), sensorToolset(), editorToolset()];
  const processors = [createCoordinator(cfg, PROCESSORS.joinAll, "all"), createCoordinator(cfg, PROCESSORS.joinAny, "any"), createWaitMatch(cfg), createScriptSensor()];
  for (const p of presets) registry.presets.register(p);
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

// ---------- for the app, the demo seed and custom sensors ----------

export { PROMPTS, TOOLSETS, PROCESSORS, ROLES, KEYS, RESTORE_REASON } from "./shared/config";
export { defineSensorCheck, ensureSource, recordCheck, OBSERVATION_NOTE, type SensorHit, type SensorCheckInput, type SourceInit } from "./shared/sensor";
export { setProjectLifecycleSync } from "./shared/sync";
export { readCoordinator, awaitsCard, syncItemAfterOwnerChangeSync, type CoordinatorState } from "./shared/coordinator";
export type { WatcherState } from "./shared/watcher";
export {
  singlePlan,
  fanOutPlan,
  chasePlan,
  projectPlan,
  rootSpec,
  rootTask,
  workerChild,
  watcherChild,
  childCellId,
  type ItemPlan,
  type ItemInfo,
  type GroupPlan,
  type ChildPlan,
  type PartyPlan,
} from "./shared/plan";
export { GTD_PAYLOAD, type GtdCommand, type WatchEvent } from "./shared/payloads";
export type { ReplyItem, ProposalItem } from "./inline-desk/items";
export { startApprovedProjectSync, ACKNOWLEDGE_ACTION } from "./inline-desk/items";
