import type { ChildProcess, StdioOptions } from "node:child_process";
import type {
  Bus,
  Clock,
  Db,
  InboxWriter,
  JobState,
  Workspace,
  WorkspaceAcquireOptions,
  WorkspacePort,
} from "@ng/protocol";

// ==================== process spawning ====================

export interface SpawnRequest {
  file: string;
  args: readonly string[];
  cwd: string;
  /** The complete environment of the child. Nothing is inherited from the kernel process. */
  env: Record<string, string>;
  detached?: boolean;
  stdio?: StdioOptions;
}

export interface CommandRunner {
  spawn(req: SpawnRequest): ChildProcess;
}

export interface WorkspaceLimits {
  bashTimeoutMs: number;                // default timeout of `bash` (args.timeoutMs overrides, clamped to maxBashTimeoutMs)
  maxBashTimeoutMs: number;
  maxOutputChars: number;               // command output cap (head + tail kept, middle elided)
  jobTailChars: number;                 // observeJob tail
  jobResultTailChars: number;           // tail carried in the job.result payload
  storedLogMaxChars: number;            // log text handed to `resources.writeResourceSync` (tail kept)
  killGraceMs: number;                  // SIGTERM → SIGKILL delay
  maxJobsPerCell: number;               // concurrently running jobs per cell
  jobTimeoutMs: number;                 // default max runtime of a background job (spec.timeoutMs overrides, clamped to maxJobTimeoutMs)
  maxJobTimeoutMs: number;              // hard ceiling for background job runtime
  jobQuietWarningMs: number;            // one warning per job after this long without output; 0 disables
  jobPollMs: number;                    // liveness poll for jobs re-attached after a restart
}

export interface WorkspaceManagerOptions {
  db: Db;
  bus: Bus;
  clock?: Clock;
  /** Root directory for cell working directories and job logs. */
  dataDir: string;
  /** Receives job.result envelopes inside the completion transaction (Inbox.enqueueSync). */
  inbox: InboxWriter;
  /** Optional: Context's writeResourceSync. When given, each finished job's log is stored and its `res://` URI set as `logUri`. */
  resources?: { writeResourceSync(cellId: string, content: string, meta?: { runId?: string; mime?: string; source?: string }): string };
  runner?: CommandRunner;
  defaultRepoPath?: string;
  /** Additional environment for scripts and jobs. */
  env?: Record<string, string>;
  /** Host shell for bash and jobs. Default /bin/bash when present, else /bin/sh. */
  shell?: string;
  limits?: Partial<WorkspaceLimits>;
}

// ==================== the manager ====================

export interface JobObservation {
  state: JobState;
  tail: string;
}

export interface WorkspaceManager extends Workspace {
  acquire(cellId: string, opts?: WorkspaceAcquireOptions): Promise<ManagedWorkspacePort>;
  /** State and log tail of any job (UI/kernel use; ports only see their own cell's jobs). */
  observeJobSync(jobId: string): JobObservation | undefined;
  /** Mark a closed cell's workspace row as `'closed'`. */
  markWorkspaceClosedSync(cellId: string): void;
  /**
   * Stop watching: timers and pipes are released and exit handlers detached, but running jobs are NOT killed — they
   * keep running and the next process's `recover()` re-attaches or finalizes them.
   */
  close(): void;
}

export interface ManagedWorkspacePort extends WorkspacePort {
  writeJobInput(jobId: string, input: string): Promise<void>;
}
