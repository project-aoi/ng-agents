import type { SchemaModule } from "./types";

// Owner: @ng/cell. Other packages read through cellsRepo(db); Inbox.control may bump epoch / set status through it.
export const cellSchema: SchemaModule = {
  owner: "@ng/cell",
  version: 1,
  migrations: [],
  ddl: /* sql */ `
CREATE TABLE IF NOT EXISTS cells (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES cells(id),
  root_id       TEXT NOT NULL,
  depth         INTEGER NOT NULL DEFAULT 0,
  preset        TEXT,                          -- registered preset
  title         TEXT,
  spec          TEXT NOT NULL,                 -- JSON CellSpec, resolved (preset defaults applied)
  bounds        TEXT NOT NULL,                 -- JSON SerializedBounds, effective (after attenuate)
  epoch         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  revoked_at INTEGER,
  pause_reason TEXT CHECK(pause_reason IN ('manual','parked') OR pause_reason IS NULL),
  close_reason  TEXT CHECK (close_reason IS NULL OR close_reason IN ('completed','cancelled')),
  principal_id  TEXT NOT NULL,                 -- who created it
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_run_at   INTEGER,
  closed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cells_parent ON cells(parent_id, status);
CREATE INDEX IF NOT EXISTS idx_cells_root ON cells(root_id);
CREATE INDEX IF NOT EXISTS idx_cells_status ON cells(status);

-- In-flight subscriptions used by the ingress router: exact thread match first (indexed), then JSON filters.
CREATE TABLE IF NOT EXISTS cell_stalls(cell_id TEXT PRIMARY KEY REFERENCES cells(id), since INTEGER NOT NULL, notified_at INTEGER);
CREATE TABLE IF NOT EXISTS cell_watches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id       TEXT NOT NULL REFERENCES cells(id),
  thread        TEXT,                          -- fast path: matches when envelope.threads contains it
  filter        TEXT NOT NULL DEFAULT '{}',    -- JSON threadOrFilter (full CellSpec.watches entry)
  cancel_group  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  coalesce_ms   INTEGER                        -- docs/05 §3.3: batching window of what this watch routes (NULL = deliver at once)
);
CREATE INDEX IF NOT EXISTS idx_watches_thread ON cell_watches(thread) WHERE active = 1 AND thread IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watches_cell ON cell_watches(cell_id, active);

-- docs/05 guard 2: what a sleeping cell is waiting on (the "@Waiting(internal)" anchor). One row per (cell, party);
-- deleted when that party answers, the wait times out, or the cell closes.
CREATE TABLE IF NOT EXISTS cell_waits (
  cell_id       TEXT NOT NULL REFERENCES cells(id),
  wait_id       TEXT NOT NULL,
  ref_id        TEXT,
  registered_run TEXT,
  registration_id TEXT,
  waiting_for   TEXT NOT NULL,                 -- an address (inbox:<cellId>, channel:…) or "human" / "external"
  reason        TEXT NOT NULL,
  epoch         INTEGER NOT NULL,              -- cell epoch when registered
  timeout_at    INTEGER,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (cell_id, wait_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_waits_party ON cell_waits(waiting_for);
CREATE TABLE IF NOT EXISTS cell_closures(
  cell_id TEXT NOT NULL REFERENCES cells(id), epoch INTEGER NOT NULL, target_id TEXT NOT NULL,
  closure_id TEXT NOT NULL, was_revoked INTEGER NOT NULL, PRIMARY KEY(cell_id,epoch)
);
CREATE INDEX IF NOT EXISTS idx_closure_members ON cell_closures(closure_id);
CREATE TABLE IF NOT EXISTS stall_incidents (
  incident_id TEXT PRIMARY KEY, cause_key TEXT NOT NULL, wait_ids TEXT NOT NULL DEFAULT '[]',
  wake_envelope_id TEXT, escalation_id TEXT, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stall_cause ON stall_incidents(cause_key);

`,
};
