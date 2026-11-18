import type { IsolationLevel, WorkspaceAcquireOptions, WorkspaceRecord } from "@ng/protocol";
import type { Git } from "../git";
import type { CommandRunner, SpawnRequest } from "../types";

export interface DriverDeps {
  dataDir: string;
  runner: CommandRunner;
  git: Git;
  defaultRepoPath?: string | undefined;
  hostShell: string;
  hostNode: string;
  slugOf(cellId: string): string;
  /** Host directory holding the cell's job logs and exit files (mounted into containers). */
  jobsDirOf(cellId: string): string;
  /** The kernel's own per-cell directory under the data dir: the cwd of a host cell that was given none. Never removed. */
  cellDirOf(cellId: string): string;
}

export interface Provisioned {
  path: string;
  baseRepo: string | null;
  baseRef: string | null;
  branch: string | null;
  containerId: string | null;
}

export interface ReleaseResult {
  /** The cell branch survives (it has commits, or the mode was hibernate). */
  branchKept: boolean;
  /** Commit made from uncommitted work before the directory was removed ("container" when made inside one). */
  snapshot: string | null;
  /** Problems worth recording on the workspace row (`error`), e.g. a backup branch had to be created. */
  warnings: string[];
}

export interface Marker {
  name: string;
  value: string;
}

export interface ProcessRequest {
  argv: readonly string[];
  /** Host path (inside the root) the process starts in. */
  cwd: string;
  /** Minimal host environment; container drivers substitute their own. */
  env: Record<string, string>;
  /** Identifies every process of this execution (pid verification after restart, kill inside containers). */
  marker: Marker;
}

export interface IsolationDriver {
  readonly level: IsolationLevel;
  /** write/edit/bash/startJob are refused. */
  readonly readOnly: boolean;
  /** Path arguments are confined to the root (everything except "none"). */
  readonly confine: boolean;
  /** Absolute sandbox paths that denote the root (e.g. "/workspace"), accepted in tool arguments. */
  aliases(ws: WorkspaceRecord): readonly string[];
  provision(cellId: string, opts: WorkspaceAcquireOptions, previous: WorkspaceRecord | undefined): Promise<Provisioned>;
  shell(): string;
  node(): string;
  plan(ws: WorkspaceRecord, req: ProcessRequest): SpawnRequest;
  toSandboxPath(ws: WorkspaceRecord, hostPath: string): string;
  /** Signal processes carrying `marker` that live outside the host process group (inside a container). */
  killInside?(ws: WorkspaceRecord, marker: Marker, sig: "TERM" | "KILL"): Promise<void>;
  release(ws: WorkspaceRecord, mode: "destroy" | "hibernate"): Promise<ReleaseResult>;
  /**
   * Stop what the kernel itself keeps running for this workspace (a container). Returns warnings. Must not remove or
   * rewrite anything on disk. Drivers with no runtime of their own leave it out.
   */
  stopRuntime?(ws: WorkspaceRecord): Promise<string[]>;
}
