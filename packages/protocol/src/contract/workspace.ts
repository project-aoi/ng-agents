import { z } from "zod";
import type { IsolationLevel, PolicyBounds, ToolKind } from "./envelope";

// docs/02 §二 — ⑤ Workspace, verbatim (comments translated). Extensions follow the `[ext]` marker.

// ==================== ⑤ Workspace: isolated execution sandbox and cross-Run async Jobs ====================
export interface Workspace {
  acquire(cellId: string, isolation: PolicyBounds["isolation"], opts?: WorkspaceAcquireOptions /* [ext] */): Promise<WorkspacePort>;
  hibernate?(cellId: string): Promise<string>;
  restore?(snapshotId: string): Promise<WorkspacePort>;
  /** @deprecated docs/05: nothing on disk is the kernel's to remove. Kept as an alias of `stopRuntime`. */
  destroy(cellId: string): Promise<void>;
  /**
   * [ext] docs/05 guard 4 — reclaim the cell's *runtime* only: cancel its Jobs and wait until their process groups are
   * gone, and remove an explicit (or legacy) container. Never touches a host directory, a branch or a worktree.
   * Idempotent; resolves once nothing of the cell is still running.
   */
  stopRuntime(cellId: string): Promise<void>;

  // ---------- [ext] ----------
  /**
   * Cancel every running job of the cell (cascade on cancel/close). Returns how many were cancelled. Each one still
   * gets its `cancelled` job.result (the inbox drops it when the cell's epoch has moved on).
   */
  cancelJobsForCell(cellId: string): Promise<number>;
  /**
   * Call once at startup. For every job left `running`: a process that is still alive (verified by its marker, not
   * only its pid) is re-attached and reports when it ends; a process that is gone is finished from the exit status
   * it recorded, or as `failed` when it recorded none (killed together with the previous kernel). Each such job
   * gets its job.result enqueued exactly once.
   * [ext] docs/05: a job whose cancellation was requested but not confirmed (`cancelRequestedAt` set, still `running`)
   * is killed again here and only then recorded `cancelled` — recover() resolves after those processes are gone, so
   * the dispatcher never starts a second writer in a directory an old process still works in.
   */
  recover(): Promise<void>;
  getJobSync(jobId: string): JobRecord | undefined;
  listJobsSync(filter?: { cellId?: string; state?: readonly JobState[] }): JobRecord[];
  getWorkspaceSync(cellId: string): WorkspaceRecord | undefined;
}

export interface WorkspacePort {
  exec(tool: ToolKind, args: unknown, signal?: AbortSignal): Promise<ExecResult /* [ext] doc: { output: string } */>;
  // slow builds / full test suites return a Job handle that outlives the Run; when it finishes it enqueues a
  // `result` envelope carrying expectedEpoch into the owning Cell's Inbox
  // [ext] every job that started ends with exactly one job.result (succeeded | failed | cancelled), id `${jobId}:result`;
  //       delivery "wakeup", except "silent_inject" for a job the cell cancelled itself through `cancelJob`.
  startJob(spec: { command: string; streamPreview?: boolean }): Promise<{ jobId: string }>;
  observeJob(jobId: string): Promise<{ state: "running" | "succeeded" | "failed" | "cancelled"; tail: string }>;
  writeJobInput?(jobId: string, input: string): Promise<void>;
  cancelJob(jobId: string): Promise<void>;

  // ---------- [ext] ----------
  readonly cellId: string;
  readonly isolation: IsolationLevel;
  /** Absolute host path of the working directory (the worktree, the shared dir, or the container mount source). */
  readonly root: string;
}

// ==================== [ext] types ====================

export interface WorkspaceAcquireOptions {
  repoPath?: string;                    // repository to base an explicit git_worktree/container on (spec.meta.workspace?.repoPath)
  baseRef?: string;                     // commit-ish the worktree starts from (default HEAD)
  branch?: string;                      // branch name to create (default derived from cellId)
  /** [ext] docs/05 — the cell's working directory for isolation "none"/"shared_ro" (absolute; must exist). */
  cwd?: string;
  /** @deprecated Ignored (see CellSpec.cwdMode). */
  cwdMode?: "read" | "write";
}

/**
 * `output` is what the model sees (stdout+stderr for bash, file text for read, ...).
 * `exitCode` is set for bash/code_rpc. A non-zero exit is not an exception; exec only rejects for
 * invalid args, path escapes, abort, or infrastructure failure.
 */
export interface ExecResult {
  output: string;
  exitCode?: number;
  truncated?: boolean;
}

export type JobState = "running" | "succeeded" | "failed" | "cancelled";

export interface JobRecord {
  jobId: string;
  cellId: string;
  epoch: number;                        // cell epoch when the job started (becomes the result's expectedEpoch)
  command: string;
  cwd: string | null;
  state: JobState;
  pid: number | null;
  logPath: string | null;
  exitCode: number | null;
  streamPreview: boolean;
  resultEnvelopeId: string | null;      // id of the job.result envelope once enqueued (idempotency)
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
  /**
   * [ext] docs/05 — set when cancellation was requested; the job stays `running` ("cancelling") until its process
   * group is confirmed gone, then becomes `cancelled`. A crash in between leaves it for recover() to finish.
   */
  cancelRequestedAt: number | null;
}

export type WorkspaceStatus = "active" | "hibernated" | "destroyed" | "failed";

export interface WorkspaceRecord {
  cellId: string;
  isolation: IsolationLevel;
  path: string | null;
  baseRepo: string | null;
  baseRef: string | null;
  branch: string | null;
  containerId: string | null;
  status: WorkspaceStatus;
  snapshotId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------- exec args per tool kind (paths are relative to the port root; escaping it is an error unless isolation is "none") ----------

export const readArgsSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("read_file"),
    path: z.string().min(1),
    offset: z.number().int().min(0).optional().describe("0-based first line"),
    limit: z.number().int().min(1).optional().describe("max lines"),
  }),
  z.object({
    op: z.literal("list_dir"),
    path: z.string().default("."),
    depth: z.number().int().min(1).max(5).optional(),
  }),
  z.object({
    op: z.literal("search"),
    pattern: z.string().min(1).describe("regex (ripgrep syntax) unless literal"),
    path: z.string().optional(),
    glob: z.string().optional(),
    literal: z.boolean().optional(),
    maxResults: z.number().int().min(1).optional(),
  }),
]);
export const writeArgsSchema = z.object({ path: z.string().min(1), content: z.string() });
export const editArgsSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().optional(),
});
export const bashArgsSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1).optional(),
  cwd: z.string().optional().describe("relative to the workspace root"),
});
/**
 * `code` is a JS (ESM) module body run in a child process with a `tools` object exposing read/write/edit/bash.
 * [ext] The child has no filesystem, process or secret access of its own (`node --permission`, minimal env);
 * every `tools.*` call is executed by the host, which applies the workspace rules. Only what the script prints
 * (stdout/stderr) is returned; exitCode 0 = completed, 1 = threw (message appended), 124 = timed out. Runtime API:
 *   tools.read(ReadArgs) / tools.write(WriteArgs) / tools.edit(EditArgs) / tools.bash(BashArgs | string) → ExecResult
 *   tools.readFile(path) → string · tools.search(pattern, { path?, glob?, literal?, maxResults? }) → ExecResult
 *   tools.http({ url, method?, headers?, body?, timeoutMs?, auth?: { secretRef, header? = "authorization",
 *                scheme? = "Bearer", query? } }) → { status, ok, headers, body, truncated? }
 *     the host resolves `secretRef` and attaches it; the value never enters the child, and any occurrence of it in
 *     a response is replaced by `[secret:<ref>]`.
 *   tools.rpc(name, args) → host-registered function result · tools.rpcList → [{ name, description }]
 */
export const codeRpcArgsSchema = z.object({ code: z.string().min(1), timeoutMs: z.number().int().min(1).optional() });

export type ReadArgs = z.input<typeof readArgsSchema>;
export type WriteArgs = z.input<typeof writeArgsSchema>;
export type EditArgs = z.input<typeof editArgsSchema>;
export type BashArgs = z.input<typeof bashArgsSchema>;
export type CodeRpcArgs = z.input<typeof codeRpcArgsSchema>;

export interface ExecArgsByTool {
  read: ReadArgs;
  write: WriteArgs;
  edit: EditArgs;
  bash: BashArgs;
  code_rpc: CodeRpcArgs;
}

export const execArgsSchemas = {
  read: readArgsSchema,
  write: writeArgsSchema,
  edit: editArgsSchema,
  bash: bashArgsSchema,
  code_rpc: codeRpcArgsSchema,
} as const satisfies Record<ToolKind, z.ZodType>;
