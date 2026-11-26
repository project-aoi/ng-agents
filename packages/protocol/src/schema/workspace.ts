import type { SchemaModule } from "./types";

const WORKSPACES_COLUMNS = /* sql */ `
  cell_id       TEXT PRIMARY KEY REFERENCES cells(id),
  path          TEXT,                          -- host working directory
  status        TEXT NOT NULL CHECK (status IN ('active','failed','closed')),
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
`;

// Owner: @ng/workspace.
export const workspaceSchema: SchemaModule = {
  owner: "@ng/workspace",
  version: 2,
  migrations: [
    {
      from: 1,
      to: 2,
      run(db) {
        db.exec(/* sql */ `
CREATE TABLE workspaces_v2 (${WORKSPACES_COLUMNS});
INSERT INTO workspaces_v2 (cell_id, path, status, error, created_at, updated_at)
SELECT
  w.cell_id,
  w.path,
  CASE WHEN c.status = 'closed' THEN 'closed' ELSE w.status END,
  w.error,
  w.created_at,
  w.updated_at
FROM workspaces w
LEFT JOIN cells c ON c.id = w.cell_id;
DROP TABLE workspaces;
ALTER TABLE workspaces_v2 RENAME TO workspaces;
`);
      },
    },
  ],
  ddl: /* sql */ `
CREATE TABLE IF NOT EXISTS workspaces (${WORKSPACES_COLUMNS});

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
