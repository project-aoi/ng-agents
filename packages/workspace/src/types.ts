import type { ChildProcess, StdioOptions } from "node:child_process";
import type {
  Bus,
  Clock,
  Db,
  InboxWriter,
  IsolationLevel,
  JobRecord,
  JobState,
  Workspace,
  WorkspaceAcquireOptions,
  WorkspacePort,
  WorkspaceRecord,
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

/**
 * Every child process the workspace starts (git, bash, jobs, the code_rpc child, the docker CLI) is created through
 * this. The default wraps `node:child_process.spawn`; tests inject a fake to observe/emulate docker invocations.
 */
export interface CommandRunner {
  spawn(req: SpawnRequest): ChildProcess;
}

// ==================== code_rpc host services ====================

export interface SecretRequestContext {
  cellId: string;
  epoch: number;                        // the cell's epoch when the request was made
  /** Human-readable reason, e.g. `http GET api.github.com` or `rpc github.listIssues`. */
  purpose: string;
  url?: string;                         // destination of an http request
  method?: string;
  rpc?: string;                         // name of the host RPC that asked
}

/**
 * Host-side secret lookup. The kernel wires this to Gate (`authorize` a `secret.use` action for the cell, then
 * resolve the value with the allow token). Throwing denies the request; the error message (never a secret) is what
 * the sandboxed code sees.
 */
export type SecretInjector = (secretRef: string, ctx: SecretRequestContext) => string | Promise<string>;

export interface RpcContext {
  cellId: string;
  epoch: number;
  /** Host path of the workspace root. */
  root: string;
  signal: AbortSignal;
  /** Resolve a secret through the injector. Every value obtained this way is scrubbed from the handler's result. */
  secret(secretRef: string, purpose?: string): Promise<string>;
  fetch: typeof fetch;
}

/** A host function callable from code_rpc as `await tools.rpc(name, args)`. Runs in the kernel process, outside the sandbox. */
export interface RpcHandlerDef {
  description?: string;
  handler(args: unknown, ctx: RpcContext): unknown;
}

// ==================== drivers ====================

export interface ContainerOptions {
  image: string;
  /** docker CLI binary. Default "docker". */
  docker?: string;
  /** `--network`. Default "none". */
  network?: string;
  /** `--user`. Default the kernel's uid:gid, so files written on the bind mount stay removable by the host. */
  user?: string;
  /** Where the workspace directory is mounted. Default "/workspace". */
  mountPath?: string;
  /** Where the cell's job directory (logs, exit files) is mounted. Default "/ng/jobs". */
  jobsMountPath?: string;
  /** Shell for bash/jobs inside the container. Default "/bin/sh". */
  shell?: string;
  /** node binary inside the image, for code_rpc. Default "node". */
  node?: string;
  memory?: string;
  cpus?: string;
  /** `--pids-limit`. Default 512. */
  pidsLimit?: number;
  /** `--read-only` root filesystem with a tmpfs /tmp. Default true. */
  readOnlyRootfs?: boolean;
  extraRunArgs?: readonly string[];
  /** Environment of processes inside the container (passed with `-e`). Default `{ HOME: "/tmp" }` plus git identity. */
  env?: Record<string, string>;
  /** Environment of the docker CLI process itself. Default: PATH, HOME and DOCKER_* of the kernel process. */
  cliEnv?: Record<string, string>;
}

export interface WorkspaceLimits {
  bashTimeoutMs: number;                // default timeout of `bash` (args.timeoutMs overrides, clamped to maxBashTimeoutMs)
  maxBashTimeoutMs: number;
  maxOutputChars: number;               // bash/code_rpc output cap (head + tail kept, middle elided)
  readMaxLines: number;                 // default `limit` of read_file
  readMaxChars: number;
  listMaxEntries: number;
  searchMaxResults: number;             // default when args.maxResults is absent
  codeRpcTimeoutMs: number;
  codeRpcMaxCalls: number;              // tool/http/rpc calls one code_rpc execution may make
  httpTimeoutMs: number;
  httpMaxResponseChars: number;
  jobTailChars: number;                 // observeJob tail
  jobResultTailChars: number;           // tail carried in the job.result payload
  storedLogMaxChars: number;            // log text handed to `resources.writeResourceSync` (tail kept)
  killGraceMs: number;                  // SIGTERM → SIGKILL delay
  maxJobsPerCell: number;               // concurrently running jobs per cell
  jobTimeoutMs: number;                 // default max runtime of a background job (spec.timeoutMs overrides, clamped to maxJobTimeoutMs)
  maxJobTimeoutMs: number;              // hard ceiling for background job runtime
  jobQuietWarningMs: number;            // one warning per job after this long without output; 0 disables
  jobPollMs: number;                    // liveness poll for jobs re-attached after a restart
  previewPollMs: number;                // log poll for streamPreview jobs
}

export interface WorkspaceManagerOptions {
  db: Db;
  bus: Bus;
  clock?: Clock;
  /** Root for everything the manager creates: worktrees/, scratch/, jobs/, home/. Must not be inside a base repository. */
  dataDir: string;
  /** Receives job.result envelopes inside the completion transaction (Inbox.enqueueSync). */
  inbox: InboxWriter;
  /** Optional: Context's writeResourceSync. When given, each finished job's log is stored and its `res://` URI set as `logUri`. */
  resources?: { writeResourceSync(cellId: string, content: string, meta?: { runId?: string; mime?: string; source?: string }): string };
  runner?: CommandRunner;
  /**
   * The configured directory: used by `none`/`shared_ro` as the working directory and by `git_worktree`/`container`
   * as the base repository when `acquire` gets no `repoPath`.
   */
  defaultRepoPath?: string;
  /** Host environment variables passed through to sandboxed processes. Default PATH, LANG, LC_ALL, LC_CTYPE, TZ. */
  envAllowlist?: readonly string[];
  /** Fixed extra environment for sandboxed processes (never put secrets here). */
  env?: Record<string, string>;
  /** Host shell for bash and jobs. Default /bin/bash when present, else /bin/sh. */
  shell?: string;
  /** ripgrep binary, or false to force the built-in search. Default: look up `rg` on PATH once. */
  ripgrep?: string | false;
  limits?: Partial<WorkspaceLimits>;
  rpc?: Record<string, RpcHandlerDef>;
  injectSecret?: SecretInjector;
  /**
   * Destination allow-list per secret for code_rpc http requests: `{ github: ["api.github.com", "*.github.com"] }`.
   * When this map is given, a secret absent from it, or a host not listed for it, is refused before the injector is
   * asked. When omitted, the injector alone decides (it receives the url).
   */
  secretHosts?: Record<string, readonly string[]>;
  fetch?: typeof fetch;
  container?: ContainerOptions;
  /** Identity of the commits the manager itself makes (snapshot of uncommitted work on destroy/hibernate). */
  gitIdentity?: { name: string; email: string };
}

// ==================== the manager ====================

export interface JobObservation {
  state: JobState;
  tail: string;
}

export interface WorkspaceManager extends Workspace {
  acquire(cellId: string, isolation: IsolationLevel, opts?: WorkspaceAcquireOptions): Promise<ManagedWorkspacePort>;
  /** git_worktree only: commit uncommitted work to the cell branch as a snapshot, remove the worktree, keep the branch. */
  hibernate(cellId: string): Promise<string>;
  /** Re-creates the worktree from the branch and un-does the snapshot commit (changes come back uncommitted). */
  restore(snapshotId: string): Promise<ManagedWorkspacePort>;
  destroy(cellId: string): Promise<void>;
  cancelJobsForCell(cellId: string): Promise<number>;
  recover(): Promise<void>;
  getJobSync(jobId: string): JobRecord | undefined;
  listJobsSync(filter?: { cellId?: string; state?: readonly JobState[] }): JobRecord[];
  getWorkspaceSync(cellId: string): WorkspaceRecord | undefined;

  /** State and log tail of any job (UI/kernel use; ports only see their own cell's jobs). */
  observeJobSync(jobId: string): JobObservation | undefined;
  /**
   * Stop watching: timers and pipes are released and exit handlers detached, but running jobs are NOT killed — they
   * keep running and the next process's `recover()` re-attaches or finalizes them.
   */
  close(): void;
  /** The search backend in use: an absolute ripgrep path, or "builtin". */
  readonly searchBackend: string;
}

export interface ManagedWorkspacePort extends WorkspacePort {
  writeJobInput(jobId: string, input: string): Promise<void>;
}
