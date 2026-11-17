// @ng/cell — ⑦ the kernel: wires the six primitives into one runtime (supervision tree, epochs, dispatcher, ingress
// routing, approval execution, escalations, close cascade). Presets and the app build on `createKernel`.

export { createKernel } from "./kernel";
export type {
  ActorOptions,
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
  HOST_MUTATING_TOOLS,
  KERNEL_ESCALATION,
  KERNEL_ESCALATION_PRINCIPAL,
  RESURFACE_MARKER,
  hostWriteRefusal,
} from "./constants";
export { isKernelEscalation, type KernelEscalationArgs } from "./escalations";
export { scheduleEnvelopeId, watchFilterMatches } from "./spec";
