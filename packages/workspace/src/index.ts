// @ng/workspace — primitive ⑤: isolated execution (none / shared_ro / git_worktree / container; cow_microvm refused)
// and cross-Run jobs whose completion is enqueued as a job.result envelope in the owning cell's inbox.

export { createWorkspaceManager, DEFAULT_LIMITS } from "./manager";
export type {
  CommandRunner,
  ContainerOptions,
  JobObservation,
  ManagedWorkspacePort,
  RpcContext,
  RpcHandlerDef,
  SecretInjector,
  SecretRequestContext,
  SpawnRequest,
  WorkspaceLimits,
  WorkspaceManager,
  WorkspaceManagerOptions,
} from "./types";
export { defaultCommandRunner, DEFAULT_ENV_ALLOWLIST } from "./exec/process";
export { detectRipgrep } from "./exec/search";
export { resolveWorkspacePath, makePathPolicy, type PathPolicy } from "./exec/paths";
export { KILL_BY_MARKER_SCRIPT, COW_MICROVM_UNAVAILABLE } from "./drivers/container";
export { JOB_MARKER, JOB_WRAPPER } from "./jobs";
export { EXEC_MARKER } from "./port";
