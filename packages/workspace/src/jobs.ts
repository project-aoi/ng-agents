import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
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
import type { IsolationDriver } from "./drivers/types";
import type { WorkspaceStore } from "./store";
import type { CommandRunner, JobObservation, WorkspaceLimits, WorkspaceManagerOptions } from "./types";
import { errorMessage, groupAlive, killGroup, markedAlive, sleep } from "./util";

export const JOB_MARKER = "NG_JOB_ID";

/**
 * POSIX sh wrapper every job runs under: `sh -c WRAPPER ng-job <exitFile> <shell> -c <command>`. It records the
 * command's exit status atomically next to the log, so a job that finishes while no kernel is watching (crash,
 * restart) still reports its real outcome to `recover()`.
 */
export const JOB_WRAPPER = 'exitf="$1"; shift; "$@"; s=$?; printf "%s\\n" "$s" > "$exitf.tmp" && mv -f "$exitf.tmp" "$exitf"; exit "$s"';

/** `silent`: the cell cancelled the job itself, so its result rides along with the next batch instead of waking it. */
type Outcome = { state: Exclude<JobState, "running">; exitCode: number | null; error: string | null; silent?: boolean };

interface LiveJob {
  jobId: string;
  cellId: string;
  pid: number;
  logPath: string;
  child: ChildProcess | null;           // null when re-attached after a restart (not our child)
  poller: NodeJS.Timeout | null;
  preview: { timer: NodeJS.Timeout; offset: number; decoder: StringDecoder } | null;
  done: Promise<void>;
  markDone: () => void;
  isDone: boolean;
  cancelReason: string | null;
  cancelSilent: boolean;
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
  sandboxEnv(cellId: string): Record<string, string>;
  /** The workspace record and driver of a cell, if it has one (used to signal processes inside a container). */
  workspaceOf(cellId: string): { ws: WorkspaceRecord; driver: IsolationDriver } | undefined;
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

  async start(ws: WorkspaceRecord, driver: IsolationDriver, spec: { command: string; streamPreview?: boolean | undefined }): Promise<{ jobId: string }> {
    if (this.#closed) throw new NgError("conflict", "the workspace manager is closed");
    if (driver.readOnly) throw new NgError("bounds_violation", `jobs are not allowed in a ${driver.level} workspace`);
    if (typeof spec?.command !== "string" || !spec.command.trim()) throw new NgError("invalid_argument", "startJob: command must be a non-empty string");
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
        if (cell.status === "closed") throw new NgError("conflict", `cell "${cellId}" is closed`);
        if (store.countRunning(cellId) >= this.d.limits.maxJobsPerCell) {
          throw new NgError("conflict", `cell "${cellId}" already has ${this.d.limits.maxJobsPerCell} running jobs; wait for one or cancel one`);
        }
        // The epoch is read in the same transaction that records the job: it becomes the result's expectedEpoch.
        store.insertJob({ jobId, cellId, epoch: cell.epoch, command: spec.command, cwd: root, logPath, streamPreview: spec.streamPreview === true });
        afterCommit(db, () => bus.emit("job.changed", { jobId, cellId, state: "running" }));
      });
    } catch (err) {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }

    let child: ChildProcess;
    try {
      const plan = driver.plan(ws, {
        argv: ["/bin/sh", "-c", JOB_WRAPPER, "ng-job", driver.toSandboxPath(ws, exitPath), driver.shell(), "-c", spec.command],
        cwd: root,
        env: this.d.sandboxEnv(cellId),
        marker: { name: JOB_MARKER, value: jobId },
      });
      child = this.d.runner.spawn({ ...plan, detached: true, stdio: ["pipe", fd, fd] });
      child.on("error", (err) => console.error(`[workspace] job ${jobId} process error:`, err));
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (err) {
      closeSync(fd);
      this.#failStart(jobId, cellId, errorMessage(err));
      throw new NgError("unsupported", `job could not be started: ${errorMessage(err)}`);
    }
    closeSync(fd);
    const pid = child.pid!;
    store.setJobPid(jobId, pid);

    const live = this.#register(jobId, cellId, pid, logPath, child);
    child.stdin?.on("error", () => {
      // EPIPE when the job exits without reading its input; nothing to report.
    });
    child.once("exit", (code, signal) => {
      if (this.#closed) return;
      // Members of the job's process group left behind (`cmd &`) belong to the finished job.
      if (groupAlive(pid)) {
        killGroup(pid, "SIGTERM");
        setTimeout(() => groupAlive(pid) && killGroup(pid, "SIGKILL"), this.d.limits.killGraceMs).unref();
      }
      const outcome: Outcome =
        live.cancelReason !== null
          ? { state: "cancelled", exitCode: null, error: live.cancelReason, silent: live.cancelSilent }
          : code === 0
            ? { state: "succeeded", exitCode: 0, error: null }
            : { state: "failed", exitCode: code, error: signal ? `terminated by ${signal}` : null };
      this.#settle(live, outcome);
    });
    // The log was created empty just above; output written before the poller starts must not be skipped.
    if (spec.streamPreview) this.#startPreview(live, { fromStart: true });
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
      poller: null,
      preview: null,
      done,
      markDone,
      isDone: false,
      cancelReason: null,
      cancelSilent: false,
      pendingOutcome: null,
      retry: null,
      attempts: 0,
    };
    this.#live.set(jobId, live);
    return live;
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

  #settle(live: LiveJob, outcome: Outcome): void {
    if (!live.isDone) {
      live.isDone = true;
      live.markDone();
    }
    if (live.poller) clearInterval(live.poller);
    live.poller = null;
    if (live.preview) {
      this.#pumpPreview(live);
      clearInterval(live.preview.timer);
      live.preview = null;
    }
    this.#complete(live, outcome);
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

  // ---------- preview ----------

  /** `fromStart`: a fresh job (preview everything); otherwise a job re-attached after a restart (only new output). */
  #startPreview(live: LiveJob, opts: { fromStart?: boolean } = {}): void {
    let offset = 0;
    if (!opts.fromStart) {
      try {
        const fd = openSync(live.logPath, "r");
        offset = fstatSync(fd).size;
        closeSync(fd);
      } catch {
        offset = 0;
      }
    }
    const timer = setInterval(() => this.#pumpPreview(live), this.d.limits.previewPollMs);
    timer.unref();
    live.preview = { timer, offset, decoder: new StringDecoder("utf8") };
  }

  #pumpPreview(live: LiveJob): void {
    const p = live.preview;
    if (!p) return;
    let fd: number;
    try {
      fd = openSync(live.logPath, "r");
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      while (p.offset < size) {
        const n = Math.min(size - p.offset, 64 * 1024);
        const buf = Buffer.alloc(n);
        const read = readSync(fd, buf, 0, n, p.offset);
        if (read <= 0) break;
        p.offset += read;
        const chunk = p.decoder.write(buf.subarray(0, read));
        if (chunk) this.d.bus.emit("job.output", { jobId: live.jobId, cellId: live.cellId, chunk });
      }
    } finally {
      closeSync(fd);
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

  /** Records `cancelled` (with its job.result) first, then TERM → grace → KILL on the process group. */
  async cancel(jobId: string, reason = "cancelled", opts: { silent?: boolean } = {}): Promise<boolean> {
    const job = this.d.store.getJob(jobId);
    if (!job || job.state !== "running") return false;
    const live = this.#live.get(jobId);
    if (live) {
      live.cancelReason = reason;
      live.cancelSilent = opts.silent === true;
    }
    try {
      this.finalizeSync(jobId, { state: "cancelled", exitCode: null, error: reason, silent: opts.silent === true });
    } catch (err) {
      // A live job is finished as cancelled by its exit handler (with retries); otherwise the caller must know.
      if (!live) throw err;
      console.error(`[workspace] recording cancel of ${jobId} failed; will retry after exit:`, err);
    }
    await this.#terminate(job, live);
    return true;
  }

  async cancelForCell(cellId: string, reason: string): Promise<number> {
    const running = this.d.store.listJobs({ cellId, state: ["running"] });
    const results = await Promise.all(running.map((j) => this.cancel(j.jobId, reason)));
    return results.filter(Boolean).length;
  }

  async #terminate(job: JobRecord, live: LiveJob | undefined): Promise<void> {
    const pid = job.pid;
    if (!pid) return;
    const ours = !!live?.child;
    if (!ours && !markedAlive(pid, JOB_MARKER, job.jobId)) return; // gone, or the pid now belongs to someone else
    const target = this.d.workspaceOf(job.cellId);
    const marker = { name: JOB_MARKER, value: job.jobId };
    const signalAll = (sig: "TERM" | "KILL") => {
      killGroup(pid, `SIG${sig}`);
      if (target?.driver.killInside) void target.driver.killInside(target.ws, marker, sig).catch(() => {});
    };
    signalAll("TERM");
    if (await this.#waitGone(job, live, this.d.limits.killGraceMs)) return;
    signalAll("KILL");
    await this.#waitGone(job, live, 2000);
  }

  /**
   * Our own child: done when the leader was reaped and no group member is left (a TERM-ignoring grandchild must
   * still get the KILL). A re-attached job: only the marker-verified leader is trusted, since its group id could
   * in principle be reused once the original group is gone.
   */
  #anyAlive(job: JobRecord, live: LiveJob | undefined): boolean {
    if (live?.child) return !live.isDone || groupAlive(job.pid!);
    return markedAlive(job.pid!, JOB_MARKER, job.jobId);
  }

  async #waitGone(job: JobRecord, live: LiveJob | undefined, ms: number): Promise<boolean> {
    const step = 25;
    for (let waited = 0; waited < ms; waited += step) {
      if (!this.#anyAlive(job, live)) return true;
      await sleep(step);
    }
    return !this.#anyAlive(job, live);
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
        if (markedAlive(job.pid, JOB_MARKER, job.jobId)) {
          this.#reattach(job);
          continue;
        }
        this.finalizeSync(
          job.jobId,
          this.#outcomeFromExitFile(job) ?? {
            state: "failed",
            exitCode: null,
            error: "the job process ended while no kernel was watching and recorded no exit status",
          },
        );
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length) throw new NgError("conflict", `recover: ${errors.length} job(s) could not be completed: ${errors.map(errorMessage).join("; ")}`);
  }

  #reattach(job: JobRecord): void {
    const pid = job.pid!;
    const live = this.#register(job.jobId, job.cellId, pid, job.logPath ?? "", null);
    live.poller = setInterval(() => {
      if (markedAlive(pid, JOB_MARKER, job.jobId)) return;
      const outcome: Outcome =
        live.cancelReason !== null
          ? { state: "cancelled", exitCode: null, error: live.cancelReason, silent: live.cancelSilent }
          : (this.#outcomeFromExitFile(job) ?? { state: "failed", exitCode: null, error: "the job process ended without recording an exit status" });
      this.#settle(live, outcome);
    }, this.d.limits.jobPollMs);
    live.poller.unref();
    if (job.streamPreview && job.logPath) this.#startPreview(live);
  }

  /** Stop watching without killing anything (the processes outlive this manager). */
  close(): void {
    this.#closed = true;
    for (const live of this.#live.values()) {
      if (live.poller) clearInterval(live.poller);
      if (live.preview) clearInterval(live.preview.timer);
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
