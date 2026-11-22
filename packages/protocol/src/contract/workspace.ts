import { z } from "zod";

// docs/02 §二 — ⑤ Workspace, verbatim (comments translated). Extensions follow the `[ext]` marker.

// ==================== ⑤ Workspace: host script execution and cross-Run async Jobs ====================
export interface Workspace {
  acquire(cellId: string, opts?: WorkspaceAcquireOptions): Promise<WorkspacePort>;
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
  exec(tool: "bash", args: unknown, signal?: AbortSignal): Promise<ExecResult /* [ext] doc: { output: string } */>;
  // slow builds / full test suites return a Job handle that outlives the Run; when it finishes it enqueues a
  // `result` envelope carrying expectedEpoch into the owning Cell's Inbox
  // [ext] every job that started ends with exactly one job.result (succeeded | failed | cancelled), id `${jobId}:result`;
  //       delivery "wakeup", except "silent_inject" for a job the cell cancelled itself through `cancelJob`.
  startJob(spec: { command: string; timeoutMs?: number }): Promise<{ jobId: string }>;
  observeJob(jobId: string): Promise<{ state: "running" | "succeeded" | "failed" | "cancelled"; tail: string }>;
  writeJobInput?(jobId: string, input: string): Promise<void>;
  cancelJob(jobId: string): Promise<void>;

  // ---------- [ext] ----------
  readonly cellId: string;
  /** Absolute working directory on the host. */
  readonly root: string;
}

// ==================== [ext] types ====================

export interface WorkspaceAcquireOptions {
  cwd?: string;
}

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
  processIdentity?: string | null;
  logPath: string | null;
  exitCode: number | null;
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
  /** [ext] Maximum allowed runtime in ms before the workspace terminates the job as timed out. */
  timeoutMs?: number | null;
}

export type WorkspaceStatus = "active" | "failed";

export interface WorkspaceRecord {
  cellId: string;
  path: string | null;
  status: WorkspaceStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export const bashArgsSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1).optional(),
  cwd: z.string().optional().describe("relative to the workspace root"),
});
