import type { SchemaModule } from "./types";

const waitTable = `CREATE TABLE IF NOT EXISTS cell_waits (
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
) WITHOUT ROWID;`;

// Owner: @ng/cell. Other packages read through cellsRepo(db); Inbox.control may bump epoch / set status through it.
export const cellSchema: SchemaModule = {
  owner: "@ng/cell",
  version: 6,
  migrations: [
    {
      // v1 pinned `preset` to the four original names with a CHECK; docs/05 adds presets, and a CHECK can only be
      // changed by recreating the table.
      version: 2,
      rebuild: true,
      up: /* sql */ `
CREATE TABLE cells_v2 (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES cells(id),
  root_id       TEXT NOT NULL,
  depth         INTEGER NOT NULL DEFAULT 0,
  preset        TEXT,                          -- PresetName, validated by the kernel (PRESET_NAMES)
  title         TEXT,
  spec          TEXT NOT NULL,                 -- JSON CellSpec, resolved (preset defaults applied)
  bounds        TEXT NOT NULL,                 -- JSON SerializedBounds, effective (after attenuate)
  epoch         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  close_reason  TEXT CHECK (close_reason IS NULL OR close_reason IN ('completed','cancelled')),
  principal_id  TEXT NOT NULL,                 -- who created it
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_run_at   INTEGER,
  closed_at     INTEGER
);
INSERT INTO cells_v2 (id, parent_id, root_id, depth, preset, title, spec, bounds, epoch, status, close_reason, principal_id, created_at, updated_at, last_run_at, closed_at)
  SELECT id, parent_id, root_id, depth, preset, title, spec, bounds, epoch, status, close_reason, principal_id, created_at, updated_at, last_run_at, closed_at FROM cells;
DROP TABLE cells;
ALTER TABLE cells_v2 RENAME TO cells;
ALTER TABLE cell_watches ADD COLUMN coalesce_ms INTEGER;
`,
    },
    {
      version: 3,
      up: `
CREATE TABLE IF NOT EXISTS cell_waits (
  cell_id       TEXT NOT NULL REFERENCES cells(id),
  waiting_for   TEXT NOT NULL,                 -- an address (inbox:<cellId>, channel:…) or "human" / "external"
  reason        TEXT NOT NULL,
  epoch         INTEGER NOT NULL,              -- cell epoch when registered
  timeout_at    INTEGER,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (cell_id, waiting_for)
) WITHOUT ROWID;
ALTER TABLE cell_waits RENAME TO old_cell_waits;
${waitTable}
INSERT INTO cell_waits (cell_id, wait_id, waiting_for, reason, epoch, timeout_at, created_at)
  SELECT cell_id, waiting_for, waiting_for, reason, epoch, timeout_at, created_at FROM old_cell_waits;
DROP TABLE old_cell_waits;
`,
    },
    {version:5,up:`ALTER TABLE cells ADD COLUMN pause_reason TEXT CHECK(pause_reason IN ('manual','parked') OR pause_reason IS NULL);
      UPDATE cells SET pause_reason='manual' WHERE status='paused';`},
    {version:6,up:`UPDATE cells SET spec=json_set(spec,'$.ccParent',json('true'))
      WHERE json_type(spec,'$.ccParent') IS NULL AND (json_extract(spec,'$.lifetime') IN ('wakeable','one_shot') OR preset='watcher');`},
  ],
  ddl: /* sql */ `
CREATE TABLE IF NOT EXISTS cells (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES cells(id),
  root_id       TEXT NOT NULL,
  depth         INTEGER NOT NULL DEFAULT 0,
  preset        TEXT,                          -- PresetName, validated by the kernel (PRESET_NAMES)
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
${waitTable}
CREATE INDEX IF NOT EXISTS idx_waits_party ON cell_waits(waiting_for);
CREATE TABLE IF NOT EXISTS cell_closures(
  cell_id TEXT NOT NULL REFERENCES cells(id), epoch INTEGER NOT NULL, target_id TEXT NOT NULL,
  closure_id TEXT NOT NULL, was_revoked INTEGER NOT NULL, PRIMARY KEY(cell_id,epoch)
);
CREATE INDEX IF NOT EXISTS idx_closure_members ON cell_closures(closure_id);
CREATE TABLE IF NOT EXISTS stall_incidents (
  cause_key TEXT PRIMARY KEY, wait_ids TEXT NOT NULL DEFAULT '[]',
  wake_envelope_id TEXT, escalation_id TEXT, updated_at INTEGER NOT NULL
);

`,
};
