import type { SchemaModule } from "./types";

// Owner: @ng/workspace.
export const workspaceSchema: SchemaModule = {
  owner: "@ng/workspace",
  version: 4,
  migrations: [
    { version: 2, up: /* sql */ `ALTER TABLE jobs ADD COLUMN cancel_requested_at INTEGER;` },
    { version: 3, up: /* sql */ `ALTER TABLE jobs ADD COLUMN timeout_ms INTEGER;` },
    {version:4, up:"ALTER TABLE jobs ADD COLUMN process_identity TEXT;"},
  ],
  ddl: /* sql */ `
CREATE TABLE IF NOT EXISTS workspaces (
  cell_id       TEXT PRIMARY KEY REFERENCES cells(id),
  path          TEXT,                          -- host working directory
  status        TEXT NOT NULL CHECK (status IN ('active','failed')),
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
  process_identity    TEXT,
  log_path            TEXT,
  exit_code           INTEGER,
  result_envelope_id  TEXT,                    -- set once job.result is enqueued (idempotent completion)
  error               TEXT,
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  updated_at          INTEGER NOT NULL,
  cancel_requested_at INTEGER,                 -- "cancelling": requested, process group not yet confirmed gone
  timeout_ms          INTEGER                  -- time limit in milliseconds, enforced across restarts
);
CREATE INDEX IF NOT EXISTS idx_jobs_cell ON jobs(cell_id, state);
CREATE INDEX IF NOT EXISTS idx_jobs_running ON jobs(state) WHERE state = 'running';
`,
};
