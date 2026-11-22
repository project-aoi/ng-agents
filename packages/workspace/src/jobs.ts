import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  afterCommit,
  cellPrincipal,
  createEnvelope,
  inboxAddr,
  KERNEL_FROM,
  newId,
  NgError,
  PAYLOAD,
  withTx,
  type Bus,
  type CellsRepo,
  type Clock,
  type Db,
  type InboxWriter,
  type JobRecord,
  type JobResultPayload,
  type JobState,
  type WorkspaceRecord,
} from "@ng/protocol";
import type { WorkspaceStore } from "./store";
import type { CommandRunner, JobObservation, WorkspaceLimits, WorkspaceManagerOptions } from "./types";
import { markedGroupState, processIdentity } from "@ng/protocol";
import { errorMessage, groupAlive, killGroup, pidAlive, processHasMarker, sleep } from "./util";

export const JOB_MARKER = "NG_JOB_ID";

/** Prefix on `jobs.error` when cancel_requested_at was set by #onTimeout so restart recovery preserves exitCode 124. */
const TIMEOUT_REASON_PREFIX = "job timed out after ";

/**
 * POSIX sh wrapper every job runs under: `sh -c WRAPPER ng-job <exitFile> <shell> -c <command>`. It records the
 * command's exit status atomically next to the log, so a job that finishes while no kernel is watching (crash,
 * restart) still reports its real outcome to `recover()`.
 */
// A caught TERM keeps the supervising shell alive and gives the command its normal TERM disposition.
export const JOB_WRAPPER = 'trap ":" TERM; exitf="$1"; shift; "$@"; s=$?; printf "%s\\n" "$s" > "$exitf.tmp" && mv -f "$exitf.tmp" "$exitf"; exit "$s"';

/** `silent`: the cell cancelled the job itself, so its result rides along with the next batch instead of waking it. */
type Outcome = { state: Exclude<JobState, "running">; exitCode: number | null; error: string | null; silent?: boolean };

interface LiveJob {
  unknownSince?:number;
  groupConfirmed: boolean;
  jobId: string;
  cellId: string;
  pid: number;
  logPath: string;
  child: ChildProcess | null;           // null when re-attached after a restart (not our child)
  poller: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  quietTimer: NodeJS.Timeout | null;
  terminationRetry: NodeJS.Timeout | null;
  warned: Set<string>;
  done: Promise<void>;
  markDone: () => void;
  isDone: boolean;
  timedOut: boolean;
  cancelReason: string | null;
  cancelSilent: boolean;
  /** The cancel in flight (request written, signals sent, waiting for the group to go). */
  cancelling: Promise<void> | null;
  pendingOutcome: Outcome | null;       // completion transaction failed; being retried
  retry: NodeJS.Timeout | null;
  attempts: number;
}

export interface JobDeps {
  db: Db;
  bus: Bus;
  clock: Clock;
  store: WorkspaceStore;
  cells: CellsRepo;
  inbox: InboxWriter;
  resources: WorkspaceManagerOptions["resources"];
  runner: CommandRunner;
  limits: WorkspaceLimits;
  jobsDirOf(cellId: string): string;
  shell: string;
  hostEnv(): Record<string, string>;
}

export function readTail(path: string | null, maxChars: number): string {
  if (!path) return "";
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const bytes = Math.min(size, maxChars * 4);
    if (bytes === 0) return "";
    const buf = Buffer.alloc(bytes);
    readSync(fd, buf, 0, bytes, size - bytes);
    let s = buf.toString("utf8");
    if (bytes < size) s = s.replace(/^�+/, "");
    return s.length > maxChars ? s.slice(s.length - maxChars) : s;
  } finally {
    closeSync(fd);
  }
}

function exitFileOf(logPath: string | null): string | null {
  return logPath ? join(dirname(logPath), "exit") : null;
}

export class JobManager {
  readonly #live = new Map<string, LiveJob>();
  #closed = false;

  constructor(private readonly d: JobDeps) {}

  // ---------- start ----------

  async start(
    ws: WorkspaceRecord,
    spec: { command: string; timeoutMs?: number | undefined },
  ): Promise<{ jobId: string }> {
    if (this.#closed) throw new NgError("conflict", "the workspace manager is closed");
    if (typeof spec?.command !== "string" || !spec.command.trim()) throw new NgError("invalid_argument", "startJob: command must be a non-empty string");
    if (spec.timeoutMs !== undefined && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)) {
      throw new NgError("invalid_argument", "startJob: timeoutMs must be a positive number");
    }
    const timeoutMs = Math.min(Math.max(1, Math.floor(spec.timeoutMs ?? this.d.limits.jobTimeoutMs)), this.d.limits.maxJobTimeoutMs);
    const { db, store, clock, bus } = this.d;
    const cellId = ws.cellId;
    const root = ws.path!;
    const jobId = newId("job", clock);
    const dir = join(this.d.jobsDirOf(cellId), jobId);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "output.log");
    const exitPath = join(dir, "exit");
    const fd = openSync(logPath, "a");

    try {
      withTx(db, () => {
        const cell = this.d.cells.get(cellId);
        if (!cell) throw new NgError("not_found", `cell "${cellId}" not found`);
        if (!this.d.cells.isActiveInTree(cellId)) throw new NgError("conflict", `cell "${cellId}" or an ancestor is paused or closed`);
        if (store.countRunning(cellId) >= this.d.limits.maxJobsPerCell) {
          throw new NgError("conflict", `cell "${cellId}" already has ${this.d.limits.maxJobsPerCell} running jobs; wait for one or cancel one`);
        }
        // The epoch is read in the same transaction that records the job: it becomes the result's expectedEpoch.
        store.insertJob({ jobId, cellId, epoch: cell.epoch, command: spec.command, cwd: root, logPath, timeoutMs });
      });
    } catch (err) {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }

    let child: ChildProcess;
    try {
      child = this.d.runner.spawn({
        file: "/bin/sh", args: ["-c", JOB_WRAPPER, `${JOB_MARKER}=${jobId}`, exitPath, this.d.shell, "-c", spec.command],
        cwd: root, env: { ...this.d.hostEnv(), [JOB_MARKER]: jobId }, detached: true, stdio: ["pipe", fd, fd],
      });
      child.on("error", (err) => console.error(`[workspace] job ${jobId} process error:`, err));
      if (child.pid === undefined) {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
      }
    } catch (err) {
      closeSync(fd);
      this.#failStart(jobId, cellId, errorMessage(err));
      throw new NgError("unsupported", `job could not be started: ${errorMessage(err)}`);
    }
    closeSync(fd);
    const pid = child.pid!;
    store.setJobPid(jobId, pid, process.platform === "darwin" ? processIdentity(pid) : null);

    const live = this.#register(jobId, cellId, pid, logPath, child);
    this.#armTimeout(live, timeoutMs, timeoutMs);
    child.stdin?.on("error", () => {
      // EPIPE when the job exits without reading its input; nothing to report.
    });
    child.once("exit", (code, signal) => {
      if (this.#closed) return;
      if (live.cancelReason !== null) {
        // cancel() records the outcome itself, once the whole process group is confirmed gone (not just the leader).
        this.#markExited(live);
        return;
      }
      const outcome: Outcome =
        code === 0 ? { state: "succeeded", exitCode: 0, error: null } : { state: "failed", exitCode: code, error: signal ? `terminated by ${signal}` : null };
      void this.#finishExit(store.getJob(jobId)!, live, outcome);
    });
    afterCommit(db, () => bus.emit("job.changed", { jobId, cellId, state: "running" }));
    return { jobId };
  }

  #failStart(jobId: string, cellId: string, message: string): void {
    // No job.result: the caller of startJob gets the error directly.
    withTx(this.d.db, () => {
      this.d.store.finishJob(jobId, { state: "failed", exitCode: null, error: `could not start: ${message}`, resultEnvelopeId: null });
      afterCommit(this.d.db, () => this.d.bus.emit("job.changed", { jobId, cellId, state: "failed" }));
    });
  }

  #register(jobId: string, cellId: string, pid: number, logPath: string, child: ChildProcess | null): LiveJob {
    let markDone!: () => void;
    const done = new Promise<void>((r) => (markDone = r));
    const live: LiveJob = {
      jobId,
      cellId,
      pid,
      logPath,
      child,
      groupConfirmed: child !== null,
      poller: null,
      timeoutTimer: null,
      quietTimer: null,
      terminationRetry: null,
      warned: new Set(),
      done,
      markDone,
      isDone: false,
      timedOut: false,
      cancelReason: null,
      cancelSilent: false,
      cancelling: null,
      pendingOutcome: null,
      retry: null,
      attempts: 0,
    };
    this.#live.set(jobId, live);
    this.#watchOutput(live);
    return live;
  }

  #warn(job: JobRecord, reason: "quiet" | "identity_unknown" | "termination_pending", message: string): boolean {
    const live = this.#live.get(job.jobId);
    if (!live || live.warned.has(reason)) return true;
    try {
      this.d.inbox.enqueueSync(job.cellId, createEnvelope({
        id: `${job.jobId}:warning:${reason}`, from: KERNEL_FROM.workspace, principalId: cellPrincipal(job.cellId),
        kind: "event", type: PAYLOAD.jobWarning, to: inboxAddr(job.cellId), expectedEpoch: job.epoch,
        payload: { jobId: job.jobId, reason, message }, delivery: "wakeup",
      }, this.d.clock));
      live.warned.add(reason);
      return true;
    } catch (err) {
      console.error(`[workspace] warning for job ${job.jobId}:`, err);
      return false;
    }
  }

  #watchOutput(live: LiveJob): void {
    const threshold = this.d.limits.jobQuietWarningMs;
    if (!live.logPath || threshold <= 0) return;
    const check = () => {
      const job = this.d.store.getJob(live.jobId);
      if (!job || job.state !== "running" || live.cancelReason !== null) return;
      // Log timestamps are filesystem wall time, independent of the scheduler clock.
      const modified = statSync(live.logPath, { throwIfNoEntry: false })?.mtimeMs;
      const remaining = modified === undefined ? 0 : threshold - (Date.now() - modified);
      if (remaining > 0) arm(remaining);
      else if (!this.#warn(job, "quiet", `Job has produced no output for ${threshold} ms: ${job.command}`)) arm(threshold);
    };
    const arm = (ms: number) => {
      live.quietTimer = setTimeout(() => {
        live.quietTimer = null;
        try { check(); } catch (err) { console.error("[workspace] job warning:", err); arm(threshold); }
      }, Math.min(threshold, Math.max(1, ms)));
      live.quietTimer.unref();
    };
    arm(Math.min(threshold, this.d.limits.jobPollMs));
  }

  #armTimeout(live: LiveJob, remainingMs: number, totalTimeoutMs: number): void {
    if (live.timeoutTimer) clearTimeout(live.timeoutTimer);
    live.timeoutTimer = setTimeout(() => {
      live.timeoutTimer = null;
      void this.#onTimeout(live, totalTimeoutMs);
    }, Math.max(0, remainingMs));
    live.timeoutTimer.unref();
  }

  async #onTimeout(live: LiveJob, totalTimeoutMs: number): Promise<void> {
    if (this.#closed || live.isDone || live.cancelReason !== null || live.timedOut) return;
    const job = this.d.store.getJob(live.jobId);
    if (!job || job.state !== "running") return;
    live.timedOut = true;
    const reason = `job timed out after ${totalTimeoutMs}ms`;
    this.d.store.requestJobCancel(live.jobId, reason);
    live.cancelReason = reason;
    await this.#finishCancellation(job, live);
  }

  // ---------- completion ----------

  /**
   * The single place a job ends: one transaction makes the `running → final` row update (conditional, so exactly
   * one path wins) and enqueues the job.result envelope (deterministic id `${jobId}:result`, expectedEpoch = the
   * start epoch), plus the stored log when a resource writer is configured. A crash before COMMIT leaves the row
   * `running` and nothing enqueued; `recover()` then finishes it from the recorded exit status. Returns false when
   * the job was already final.
   */
  finalizeSync(jobId: string, outcome: Outcome): boolean {
    const { db, store, clock, bus, limits } = this.d;
    return withTx(db, () => {
      const job = store.getJob(jobId);
      if (!job || job.state !== "running") return false;
      const envelopeId = `${jobId}:result`;
      if (!store.finishJob(jobId, { state: outcome.state, exitCode: outcome.exitCode, error: outcome.error, resultEnvelopeId: envelopeId })) return false;
      const now = clock.now();
      const payload: JobResultPayload = {
        jobId,
        command: job.command,
        state: outcome.state,
        exitCode: outcome.exitCode,
        tail: readTail(job.logPath, limits.jobResultTailChars),
        durationMs: Math.max(0, now - job.startedAt),
        ...(outcome.error ? { error: outcome.error } : {}),
      };
      if (this.d.resources && job.logPath && existsSync(job.logPath)) {
        payload.logUri = this.d.resources.writeResourceSync(job.cellId, readTail(job.logPath, limits.storedLogMaxChars), {
          mime: "text/plain",
          source: `job:${jobId}`,
        });
      }
      this.d.inbox.enqueueSync(
        job.cellId,
        createEnvelope(
          {
            id: envelopeId,
            from: KERNEL_FROM.workspace,
            to: inboxAddr(job.cellId),
            principalId: cellPrincipal(job.cellId),
            kind: "result",
            type: PAYLOAD.jobResult,
            expectedEpoch: job.epoch,
            delivery: outcome.silent ? "silent_inject" : "wakeup",
            payload,
            createdAt: now,
          },
          clock,
        ),
      );
      afterCommit(db, () => bus.emit("job.changed", { jobId, cellId: job.cellId, state: outcome.state }));
      return true;
    });
  }

  #markExited(live: LiveJob): void {
    if (live.isDone) return;
    live.isDone = true;
    live.markDone();
  }

  #settle(live: LiveJob, outcome: Outcome): void {
    this.#markExited(live);
    if (live.poller) clearInterval(live.poller);
    live.poller = null;
    if (live.quietTimer) clearTimeout(live.quietTimer);
    if (live.terminationRetry) clearTimeout(live.terminationRetry);
    if (live.timeoutTimer) clearTimeout(live.timeoutTimer);
    live.timeoutTimer = null;
    this.#complete(live, outcome);
  }

  /** A command can exit while its background children still have the workspace open. */
  async #finishExit(job: JobRecord, live: LiveJob, outcome: Outcome): Promise<void> {
    if (live.poller) clearInterval(live.poller);
    live.poller = null;
    if (live.timeoutTimer) clearTimeout(live.timeoutTimer);
    live.timeoutTimer = null;
    const gone = await this.#terminate(job, live);
    if (this.#closed || live.cancelReason !== null) return;
    if (gone) {
      this.#settle(live, outcome);
      return;
    }
    live.terminationRetry = setTimeout(() => {
      live.terminationRetry = null;
      void this.#finishExit(job, live, outcome);
    }, this.d.limits.jobPollMs);
    live.terminationRetry.unref();
  }

  #complete(live: LiveJob, outcome: Outcome): void {
    if (this.#closed) return;
    try {
      this.finalizeSync(live.jobId, outcome);
      live.pendingOutcome = null;
      this.#live.delete(live.jobId);
    } catch (err) {
      live.pendingOutcome = outcome;
      const delay = Math.min(30_000, 250 * 2 ** live.attempts++);
      console.error(`[workspace] completing job ${live.jobId} failed (retry in ${delay}ms):`, err);
      live.retry = setTimeout(() => {
        live.retry = null;
        if (live.pendingOutcome) this.#complete(live, live.pendingOutcome);
      }, delay);
      live.retry.unref();
    }
  }

  #outcomeFromExitFile(job: JobRecord): Outcome | null {
    const f = exitFileOf(job.logPath);
    if (!f) return null;
    try {
      const code = Number.parseInt(readFileSync(f, "utf8").trim(), 10);
      if (!Number.isFinite(code)) return null;
      return code === 0 ? { state: "succeeded", exitCode: 0, error: null } : { state: "failed", exitCode: code, error: null };
    } catch {
      return null;
    }
  }

  // ---------- observe / input ----------

  observeSync(jobId: string): JobObservation | undefined {
    const job = this.d.store.getJob(jobId);
    if (!job) return undefined;
    return { state: job.state, tail: readTail(job.logPath, this.d.limits.jobTailChars) };
  }

  async writeInput(jobId: string, input: string): Promise<void> {
    const job = this.d.store.getJob(jobId);
    if (!job) throw new NgError("not_found", `job "${jobId}" not found`);
    if (job.state !== "running") throw new NgError("conflict", `job "${jobId}" is ${job.state}`);
    const stdin = this.#live.get(jobId)?.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new NgError("conflict", `job "${jobId}" does not accept input (its stdin was lost when the previous kernel stopped)`);
    }
    await new Promise<void>((resolve, reject) => stdin.write(input, (err) => (err ? reject(err) : resolve())));
  }

  // ---------- cancel ----------

  /**
   * Request → kill → confirm → record, in that order (docs/05 guard 4):
   * 1. the request is written to the row (`cancel_requested_at`, the job stays `running` = "cancelling");
   * 2. TERM → grace → KILL on the process group;
   * 3. only when nothing of the job is alive any more does it become `cancelled`, with its job.result.
   * Whoever counts running jobs (the kernel's view of who is active in which directory) therefore never sees the directory as free
   * while an old process can still write to it, and a kernel that dies between 1 and 3 leaves a row `recover()`
   * finishes the same way. Resolves when the job is recorded; false when it was not running.
   */
  async cancel(jobId: string, reason = "cancelled", opts: { silent?: boolean } = {}): Promise<boolean> {
    const job = this.d.store.getJob(jobId);
    if (!job || job.state !== "running") return false;
    const live = this.#live.get(jobId) ?? this.#register(jobId, job.cellId, job.pid ?? 0, job.logPath ?? "", null);
    const first = this.d.store.requestJobCancel(jobId, reason);
    live.cancelReason ??= job.error ?? reason;
    if (first) live.cancelSilent = opts.silent === true;
    await this.#finishCancellation(job, live);
    if (this.d.store.getJob(jobId)?.state === "running") {
      throw new NgError("conflict", `job ${jobId} is still stopping; its workspace is still active`);
    }
    return first;
  }

  async #finishCancellation(job: JobRecord, live: LiveJob): Promise<void> {
    if (live.cancelling) return live.cancelling;
    const attempt = async () => {
      if (!await this.#terminate(job, live)) {
        if (this.#closed || live.terminationRetry) return;
        if (this.#aliveState(job,live) === null && this.#lostIdentity(job,live)) return;
        live.terminationRetry = setTimeout(() => {
          live.terminationRetry = null;
          void this.#finishCancellation(job, live);
        }, this.d.limits.jobPollMs);
        live.terminationRetry.unref();
        this.#warn(job, "termination_pending", "Waiting for confirmation that the job process has exited.");
        return;
      }
      const reason = live.cancelReason ?? "cancelled";
      const timeout = live.timedOut || reason.startsWith(TIMEOUT_REASON_PREFIX);
      this.#settle(live, { state: timeout ? "failed" : "cancelled", exitCode: timeout ? 124 : null, error: reason, silent: live.cancelSilent });
    };
    live.cancelling = attempt().finally(() => { live.cancelling = null; });
    return live.cancelling;
  }

  async cancelForCell(cellId: string, reason: string): Promise<number> {
    const running = this.d.store.listJobs({ cellId, state: ["running"] });
    const results = await Promise.all(running.map((j) => this.cancel(j.jobId, reason)));
    return results.filter(Boolean).length;
  }

  /** True when nothing of the job is confirmed alive afterwards (`false` if still alive or identity unreadable). */
  async #terminate(job: JobRecord, live: LiveJob | undefined): Promise<boolean> {
    const pid = job.pid;
    if (!pid) return true;
    const state = this.#aliveState(job, live);
    if (state === false) return true;
    if (state === null) {
      // A dying group can outlast its leader for a few ticks. Observe it without signalling unverified PIDs.
      return !pidAlive(pid) && this.#waitGone(job, live, this.d.limits.killGraceMs);
    }
    if (live) live.groupConfirmed = true;
    killGroup(pid, "SIGTERM");
    if (await this.#waitGone(job, live, this.d.limits.killGraceMs)) return true;
    const remaining = this.#aliveState(job, live);
    if (remaining !== true) return remaining === false;
    killGroup(pid, "SIGKILL");
    return this.#waitGone(job, live, 2000);
  }

  /**
   * Three-state liveness check:
   * - `true`:  confirmed alive
   * - `false`: confirmed gone (or PID recycled)
   * - `null`:  re-attached process appears alive, but its identity could not be read
   */
  #processState(job:JobRecord) {
    return processHasMarker(job.pid!, JOB_MARKER, job.jobId, job.processIdentity);
  }

  #aliveState(job: JobRecord, live: LiveJob | undefined): boolean | null {
    const pid = job.pid;
    if (!pid) return false;
    if (live?.child) {
      if (live.child.exitCode === null && live.child.signalCode === null) return true;
    }
    if (live?.groupConfirmed && !pidAlive(pid)) return groupAlive(pid);
    return markedGroupState(pid, JOB_MARKER, job.jobId, job.processIdentity);
  }

  async #waitGone(job: JobRecord, live: LiveJob | undefined, ms: number): Promise<boolean> {
    const deadline = performance.now() + ms;
    while (this.#aliveState(job, live) !== false) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await sleep(Math.min(25, remaining));
    }
    return true;
  }

  // ---------- restart ----------

  /**
   * For every `running` row: a job this manager is watching is left alone (a pending completion is retried); a
   * process that is still alive (verified by its marker, not just its pid) is re-attached and polled; a dead one is
   * finished from its recorded exit status, or as `failed` when none was recorded (killed with the old kernel).
   */
  async recover(): Promise<void> {
    if (this.#closed) throw new NgError("conflict", "the workspace manager is closed");
    const errors: unknown[] = [];
    for (const job of this.d.store.listJobs({ state: ["running"] })) {
      const live = this.#live.get(job.jobId);
      try {
        if (live) {
          if (live.pendingOutcome) {
            if (live.retry) clearTimeout(live.retry);
            this.finalizeSync(job.jobId, live.pendingOutcome);
            live.pendingOutcome = null;
            this.#live.delete(job.jobId);
          }
          continue;
        }
        if (job.pid === null) {
          this.finalizeSync(job.jobId, { state: "failed", exitCode: null, error: "the kernel stopped before the job process was started" });
          continue;
        }
        if (job.cancelRequestedAt !== null) {
          // The previous kernel asked for this cancel (or timeout termination) and died before it could confirm the
          // exit. An unreadable process stays registered and the pending request is retried.
          const cancel = this.#register(job.jobId, job.cellId, job.pid, job.logPath ?? "", null);
          cancel.cancelReason = job.error ?? "cancelled";
          await this.#finishCancellation(job, cancel);
          continue;
        }
        const marked = this.#processState(job);
        // Three-state handling (BUG-027): confirmed alive (`true`) OR identity unreadable (`null`, e.g. transient `ps`
        // error on macOS) goes to `#reattach` for multi-poll verification instead of falsely declaring the job dead.
        if (marked === true || marked === null) {
          this.#reattach(job, marked === true);
          continue;
        }
        const outcome = this.#outcomeFromExitFile(job) ?? {
          state: "failed" as const, exitCode: null, error: "the job process ended while no kernel was watching and recorded no exit status",
        };
        if (groupAlive(job.pid) && !pidAlive(job.pid)) {
          const ended = this.#register(job.jobId, job.cellId, job.pid, job.logPath ?? "", null);
          await this.#finishExit(job, ended, outcome);
        } else this.finalizeSync(job.jobId, outcome);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length) throw new NgError("conflict", `recover: ${errors.length} job(s) could not be completed: ${errors.map(errorMessage).join("; ")}`);
  }

  #lostIdentity(job: JobRecord, live: LiveJob): boolean {
    live.unknownSince ??= Date.now();
    if (Date.now() - live.unknownSince < 30_000) return false;
    this.#settle(live, this.#outcomeFromExitFile(job) ?? {state:"failed", exitCode:null, error:"Job process identity could not be verified; tracking stopped without signalling it."});
    return true;
  }

  #reattach(job: JobRecord, confirmedAlive: boolean): void {
    const pid = job.pid!;
    const live = this.#register(job.jobId, job.cellId, pid, job.logPath ?? "", null);
    const timeoutMs = job.timeoutMs ?? this.d.limits.jobTimeoutMs;
    const armIfTimeout = () => {
      if (timeoutMs > 0 && !live.timeoutTimer) {
        const elapsed = Math.max(0, this.d.clock.now() - job.startedAt);
        this.#armTimeout(live, Math.max(0, timeoutMs - elapsed), timeoutMs);
      }
    };
    // Only arm timeout termination once the process identity has been confirmed (`true`); an unverified `null` pid
    // waits for multi-poll confirmation first so we never misreport an unreadable process as a timeout (exit 124).
    live.groupConfirmed = confirmedAlive;
    if (live.groupConfirmed) armIfTimeout();
    live.poller = setInterval(() => {
      const marked = this.#processState(job);
      if (marked === true) {
        delete live.unknownSince;
        if (!live.groupConfirmed) {
          live.groupConfirmed = true;
          armIfTimeout();
        }
        return;
      }
      if (live.cancelReason !== null) return; // the termination request owns its final result
      const exit = this.#outcomeFromExitFile(job);
      if (marked === null && !exit) {
        if (this.#lostIdentity(job,live)) return;
        this.#warn(job, "identity_unknown", "The job process is still present but its identity cannot be confirmed.");
        return;
      }
      void this.#finishExit(job, live, exit ?? { state: "failed", exitCode: null, error: "the job process ended without recording an exit status" });
    }, this.d.limits.jobPollMs);
    live.poller.unref();
  }

  /** Stop watching without killing anything (the processes outlive this manager). */
  close(): void {
    this.#closed = true;
    for (const live of this.#live.values()) {
      if (live.quietTimer) clearTimeout(live.quietTimer);
      if (live.terminationRetry) clearTimeout(live.terminationRetry);
      if (live.poller) clearInterval(live.poller);
      if (live.timeoutTimer) clearTimeout(live.timeoutTimer);
      if (live.retry) clearTimeout(live.retry);
      live.child?.stdin?.destroy();
      live.child?.unref();
    }
    this.#live.clear();
  }

  isWatching(jobId: string): boolean {
    return this.#live.has(jobId);
  }
}
