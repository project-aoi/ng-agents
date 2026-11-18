import type { SchemaModule } from "./types";

// Owner: @ng/workspace.
export const workspaceSchema: SchemaModule = {
  owner: "@ng/workspace",
  version: 2,
  migrations: [{ version: 2, up: /* sql */ `ALTER TABLE jobs ADD COLUMN cancel_requested_at INTEGER;` }],
  ddl: /* sql */ `
CREATE TABLE IF NOT EXISTS workspaces (
  cell_id       TEXT PRIMARY KEY REFERENCES cells(id),
  isolation     TEXT NOT NULL CHECK (isolation IN ('none','shared_ro','git_worktree','container','cow_microvm')),
  path          TEXT,                          -- host working directory
  base_repo     TEXT,
  base_ref      TEXT,
  branch        TEXT,
  container_id  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active','hibernated','destroyed','failed')),
  snapshot_id   TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id              TEXT PRIMARY KEY,
  cell_id             TEXT NOT NULL REFERENCES cells(id),
  epoch               INTEGER NOT NULL,        -- cell epoch at start → expectedEpoch of the job.result envelope
  command             TEXT NOT NULL,
  cwd                 TEXT,
  state               TEXT NOT NULL CHECK (state IN ('running','succeeded','failed','cancelled')),
  pid                 INTEGER,
  log_path            TEXT,
  exit_code           INTEGER,
  stream_preview      INTEGER NOT NULL DEFAULT 0,
  result_envelope_id  TEXT,                    -- set once job.result is enqueued (idempotent completion)
  error               TEXT,
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  updated_at          INTEGER NOT NULL,
  cancel_requested_at INTEGER                  -- "cancelling": requested, process group not yet confirmed gone
);
CREATE INDEX IF NOT EXISTS idx_jobs_cell ON jobs(cell_id, state);
CREATE INDEX IF NOT EXISTS idx_jobs_running ON jobs(state) WHERE state = 'running';
`,
};
