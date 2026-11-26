import {
  all,
  get,
  run,
  type Clock,
  type Db,
  type JobRecord,
  type JobState,
  type SqlParam,
  type WorkspaceRecord,
  type WorkspaceStatus,
} from "@ng/protocol";

interface WorkspaceRow {
  cell_id: string;
  path: string | null;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface JobRow {
  job_id: string;
  cell_id: string;
  epoch: number;
  command: string;
  cwd: string | null;
  state: string;
  pid: number | null;
  process_identity:string | null;
  log_path: string | null;
  exit_code: number | null;
  result_envelope_id: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
  cancel_requested_at: number | null;
  timeout_ms: number | null;
}

function toWorkspace(r: WorkspaceRow): WorkspaceRecord {
  return {
    cellId: r.cell_id,
    path: r.path,
    status: r.status as WorkspaceStatus,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toJob(r: JobRow): JobRecord {
  return {
    jobId: r.job_id,
    cellId: r.cell_id,
    epoch: r.epoch,
    command: r.command,
    cwd: r.cwd,
    state: r.state as JobState,
    pid: r.pid,
    processIdentity:r.process_identity,
    logPath: r.log_path,
    exitCode: r.exit_code,
    resultEnvelopeId: r.result_envelope_id,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
    cancelRequestedAt: r.cancel_requested_at ?? null,
    timeoutMs: r.timeout_ms ?? null,
  };
}

type WorkspaceUpsert = Pick<WorkspaceRecord, "cellId" | "path" | "status"> & { error?: string };

/** SQL access to the two tables this package owns (`workspaces`, `jobs`). Synchronous; joins the caller's transaction. */
export class WorkspaceStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  getWorkspace(cellId: string): WorkspaceRecord | undefined {
    const r = get<WorkspaceRow>(this.db, "SELECT * FROM workspaces WHERE cell_id = ?", [cellId]);
    return r ? toWorkspace(r) : undefined;
  }

  upsertWorkspace(w: WorkspaceUpsert): WorkspaceRecord {
    const now = this.clock.now();
    run(
      this.db,
      `INSERT INTO workspaces (cell_id, path, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(cell_id) DO UPDATE SET path = excluded.path, status = excluded.status,
         error = excluded.error, updated_at = excluded.updated_at`,
      [w.cellId, w.path, w.status, w.error ?? null, now, now],
    );
    return this.getWorkspace(w.cellId)!;
  }

  closeWorkspace(cellId: string): void {
    run(this.db, "UPDATE workspaces SET status = 'closed', updated_at = ? WHERE cell_id = ? AND status != 'closed'", [
      this.clock.now(),
      cellId,
    ]);
  }

  getJob(jobId: string): JobRecord | undefined {
    const r = get<JobRow>(this.db, "SELECT * FROM jobs WHERE job_id = ?", [jobId]);
    return r ? toJob(r) : undefined;
  }

  listJobs(filter: { cellId?: string; state?: readonly JobState[] } = {}): JobRecord[] {
    const params: SqlParam[] = [];
    let sql = "SELECT * FROM jobs WHERE 1 = 1";
    if (filter.cellId !== undefined) {
      sql += " AND cell_id = ?";
      params.push(filter.cellId);
    }
    if (filter.state?.length) {
      sql += ` AND state IN (${filter.state.map(() => "?").join(",")})`;
      params.push(...filter.state);
    }
    return all<JobRow>(this.db, sql + " ORDER BY started_at, job_id", params).map(toJob);
  }

  countRunning(cellId: string): number {
    return get<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM jobs WHERE cell_id = ? AND state = 'running'", [cellId])?.n ?? 0;
  }

  insertJob(j: { jobId: string; cellId: string; epoch: number; command: string; cwd: string; logPath: string; timeoutMs?: number | null }): void {
    const now = this.clock.now();
    run(
      this.db,
      `INSERT INTO jobs (job_id, cell_id, epoch, command, cwd, state, pid, log_path, exit_code, result_envelope_id, error, started_at, finished_at, updated_at, timeout_ms)
       VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
      [j.jobId, j.cellId, j.epoch, j.command, j.cwd, j.logPath, now, now, j.timeoutMs ?? null],
    );
  }

  setJobPid(jobId: string, pid: number, identity:string | null): void {
    run(this.db, "UPDATE jobs SET pid = ?, process_identity=?, updated_at = ? WHERE job_id = ?", [pid, identity, this.clock.now(), jobId]);
  }

  /**
   * "Cancelling": the request and its reason are on the row before any signal is sent, so a kernel that dies between
   * the request and the confirmed exit leaves a row `recover()` knows it must still kill. First request wins.
   */
  requestJobCancel(jobId: string, reason: string): boolean {
    const now = this.clock.now();
    return (
      run(this.db, "UPDATE jobs SET cancel_requested_at = ?, error = ?, updated_at = ? WHERE job_id = ? AND state = 'running' AND cancel_requested_at IS NULL", [
        now,
        reason,
        now,
        jobId,
      ]).changes > 0
    );
  }

  /** Conditional on `running`: returns false when another path already finished the job. */
  finishJob(jobId: string, f: { state: Exclude<JobState, "running">; exitCode: number | null; error: string | null; resultEnvelopeId: string | null }): boolean {
    const now = this.clock.now();
    const r = run(
      this.db,
      `UPDATE jobs SET state = ?, exit_code = ?, error = ?, result_envelope_id = ?, finished_at = ?, updated_at = ?
       WHERE job_id = ? AND state = 'running'`,
      [f.state, f.exitCode, f.error, f.resultEnvelopeId, now, now, jobId],
    );
    return r.changes === 1;
  }
}
