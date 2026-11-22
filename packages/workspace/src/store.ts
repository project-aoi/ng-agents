import {
  all,
  fromBool,
  get,
  run,
  toBool,
  type Clock,
  type Db,
  type IsolationLevel,
  type JobRecord,
  type JobState,
  type SqlParam,
  type WorkspaceRecord,
  type WorkspaceStatus,
} from "@ng/protocol";

interface WorkspaceRow {
  cell_id: string;
  isolation: string;
  path: string | null;
  base_repo: string | null;
  base_ref: string | null;
  branch: string | null;
  container_id: string | null;
  status: string;
  snapshot_id: string | null;
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
  stream_preview: number;
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
    isolation: r.isolation as IsolationLevel,
    path: r.path,
    baseRepo: r.base_repo,
    baseRef: r.base_ref,
    branch: r.branch,
    containerId: r.container_id,
    status: r.status as WorkspaceStatus,
    snapshotId: r.snapshot_id,
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
    streamPreview: toBool(r.stream_preview),
    resultEnvelopeId: r.result_envelope_id,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
    cancelRequestedAt: r.cancel_requested_at ?? null,
    timeoutMs: r.timeout_ms ?? null,
  };
}

export type WorkspaceUpsert = Pick<WorkspaceRecord, "cellId" | "isolation" | "path" | "baseRepo" | "baseRef" | "branch" | "containerId" | "status"> &
  Partial<Pick<WorkspaceRecord, "snapshotId" | "error">>;

export type WorkspacePatch = Partial<Omit<WorkspaceRecord, "cellId" | "createdAt" | "updatedAt">>;

const WS_COLUMNS: Record<keyof WorkspacePatch, string> = {
  isolation: "isolation",
  path: "path",
  baseRepo: "base_repo",
  baseRef: "base_ref",
  branch: "branch",
  containerId: "container_id",
  status: "status",
  snapshotId: "snapshot_id",
  error: "error",
};

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

  getWorkspaceBySnapshot(snapshotId: string): WorkspaceRecord | undefined {
    const r = get<WorkspaceRow>(this.db, "SELECT * FROM workspaces WHERE snapshot_id = ?", [snapshotId]);
    return r ? toWorkspace(r) : undefined;
  }

  listWorkspaces(status?: readonly WorkspaceStatus[]): WorkspaceRecord[] {
    const params: SqlParam[] = [];
    let sql = "SELECT * FROM workspaces";
    if (status?.length) {
      sql += ` WHERE status IN (${status.map(() => "?").join(",")})`;
      params.push(...status);
    }
    return all<WorkspaceRow>(this.db, sql + " ORDER BY created_at, cell_id", params).map(toWorkspace);
  }

  upsertWorkspace(w: WorkspaceUpsert): WorkspaceRecord {
    const now = this.clock.now();
    run(
      this.db,
      `INSERT INTO workspaces (cell_id, isolation, path, base_repo, base_ref, branch, container_id, status, snapshot_id, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cell_id) DO UPDATE SET
         isolation = excluded.isolation, path = excluded.path, base_repo = excluded.base_repo, base_ref = excluded.base_ref,
         branch = excluded.branch, container_id = excluded.container_id, status = excluded.status,
         snapshot_id = excluded.snapshot_id, error = excluded.error, updated_at = excluded.updated_at`,
      [w.cellId, w.isolation, w.path, w.baseRepo, w.baseRef, w.branch, w.containerId, w.status, w.snapshotId ?? null, w.error ?? null, now, now],
    );
    return this.getWorkspace(w.cellId)!;
  }

  patchWorkspace(cellId: string, patch: WorkspacePatch): void {
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const [k, v] of Object.entries(patch) as Array<[keyof WorkspacePatch, WorkspacePatch[keyof WorkspacePatch]]>) {
      if (v === undefined) continue;
      sets.push(`${WS_COLUMNS[k]} = ?`);
      params.push(v);
    }
    sets.push("updated_at = ?");
    params.push(this.clock.now(), cellId);
    run(this.db, `UPDATE workspaces SET ${sets.join(", ")} WHERE cell_id = ?`, params);
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

  insertJob(j: { jobId: string; cellId: string; epoch: number; command: string; cwd: string; logPath: string; streamPreview: boolean; timeoutMs?: number | null }): void {
    const now = this.clock.now();
    run(
      this.db,
      `INSERT INTO jobs (job_id, cell_id, epoch, command, cwd, state, pid, log_path, exit_code, stream_preview, result_envelope_id, error, started_at, finished_at, updated_at, timeout_ms)
       VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, NULL, ?, NULL, NULL, ?, NULL, ?, ?)`,
      [j.jobId, j.cellId, j.epoch, j.command, j.cwd, j.logPath, fromBool(j.streamPreview), now, now, j.timeoutMs ?? null],
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
