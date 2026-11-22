import type { Registry, Toolset } from "@ng/protocol";
import { cellsToolset, CELLS_TOOLSET } from "./cells";
import { commsToolset, COMMS_TOOLSET, type CommsToolsetOptions } from "./comms";
import { contextToolset, CONTEXT_TOOLSET } from "./context";
import { scheduleToolset, SCHEDULE_TOOLSET } from "./schedule";
import { workspaceToolset, WORKSPACE_TOOLSET } from "./workspace";

/** Names to list in `ProcessorSpec.llm.toolsets`. */
export const STANDARD_TOOLSETS = {
  workspace: WORKSPACE_TOOLSET,
  cells: CELLS_TOOLSET,
  context: CONTEXT_TOOLSET,
  comms: COMMS_TOOLSET,
  schedule: SCHEDULE_TOOLSET,
} as const;

export type StandardToolsetOptions = CommsToolsetOptions;

/** The five standard toolsets (not registered). `registry` is read lazily by spawn_cell for preset defaults. */
export function standardToolsets(registry: Registry, opts: StandardToolsetOptions = {}): Toolset[] {
  return [workspaceToolset(), cellsToolset(registry), contextToolset(registry), commsToolset(opts), scheduleToolset()];
}

/** Registers the five standard toolsets; call once at startup, before presets that reference them are used. */
export function registerStandardToolsets(registry: Registry, opts: StandardToolsetOptions = {}): Toolset[] {
  return standardToolsets(registry, opts).map((ts) => registry.toolsets.register(ts));
}
