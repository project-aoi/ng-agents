// @ng/cell — ⑦ the kernel: wires the six primitives into one runtime (supervision tree, epochs, dispatcher, ingress
// routing, approval execution, escalations, close cascade). Presets and the app build on `createKernel`.

export { createKernel } from "./kernel";
export type {
  ActorOptions,
  AnchorReport,
  ApprovalDecision,
  CellNode,
  CellSpecInput,
  CloseResult,
  IdleOptions,
  IngestResult,
  Kernel,
  KernelOptions,
  KernelStats,
  ResolveApprovalResult,
  RootCellOptions,
  RosterEntry,
  RunInfo,
  RunResult,
  SpawnOptions,
} from "./types";
export {
  DEFAULT_ROOT_BOUNDS,
  KERNEL_ESCALATION,
  KERNEL_ESCALATION_PRINCIPAL,
  RESURFACE_MARKER,
} from "./constants";
export { WAIT_EXTERNAL, WAIT_HUMAN, type WaitRecord } from "./waits";
export { effectiveCwd, normalizeCwd, forgetWorkTreeKeys, workTreeKey } from "./workdir";
export { isKernelEscalation, type KernelEscalationArgs } from "./escalations";
export { scheduleEnvelopeId, watchFilterMatches } from "./spec";
export { createModelSettings, type ModelSettings, type ModelSettingsOptions, type ModelSettingsView, type ModelSelection } from "./models";
