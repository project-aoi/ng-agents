import type { SchemaModule } from "./types";

// Owner: @ng/cell. Other packages read through cellsRepo(db); Inbox.control may bump epoch / set status through it.
export const cellSchema: SchemaModule = {
  owner: "@ng/cell",
  version: 1,
  ddl: /* sql */ `
CREATE TABLE IF NOT EXISTS cells (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES cells(id),
  root_id       TEXT NOT NULL,
  depth         INTEGER NOT NULL DEFAULT 0,
  preset        TEXT CHECK (preset IS NULL OR preset IN ('inline','worker','watcher','sensor')),
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
CREATE INDEX IF NOT EXISTS idx_cells_parent ON cells(parent_id, status);
CREATE INDEX IF NOT EXISTS idx_cells_root ON cells(root_id);
CREATE INDEX IF NOT EXISTS idx_cells_status ON cells(status);

-- In-flight subscriptions used by the ingress router: exact thread match first (indexed), then JSON filters.
CREATE TABLE IF NOT EXISTS cell_watches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id       TEXT NOT NULL REFERENCES cells(id),
  thread        TEXT,                          -- fast path: matches when envelope.threads contains it
  filter        TEXT NOT NULL DEFAULT '{}',    -- JSON threadOrFilter (full CellSpec.watches entry)
  cancel_group  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watches_thread ON cell_watches(thread) WHERE active = 1 AND thread IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watches_cell ON cell_watches(cell_id, active);
`,
};
