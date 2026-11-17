import type { SchemaModule } from "./types";

// Owner: @ng/inbox.
export const inboxSchema: SchemaModule = {
  owner: "@ng/inbox",
  version: 1,
  ddl: /* sql */ `
CREATE TABLE IF NOT EXISTS inbox_schedules (
  id             TEXT PRIMARY KEY,
  cell_id        TEXT NOT NULL REFERENCES cells(id),
  template_id    TEXT NOT NULL,                -- envelope id of the template (dedupe key)
  envelope       TEXT NOT NULL,                -- JSON Envelope template
  cron           TEXT,
  idle_sec       INTEGER,
  tz             TEXT,
  cancel_group   TEXT,
  expected_epoch INTEGER,
  next_fire_at   INTEGER,
  last_fired_at  INTEGER,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK ((cron IS NOT NULL) + (idle_sec IS NOT NULL) = 1),
  UNIQUE (cell_id, template_id)
);
CREATE INDEX IF NOT EXISTS idx_sched_next ON inbox_schedules(next_fire_at) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_sched_cell ON inbox_schedules(cell_id, active);
CREATE INDEX IF NOT EXISTS idx_sched_group ON inbox_schedules(cell_id, cancel_group) WHERE cancel_group IS NOT NULL;

CREATE TABLE IF NOT EXISTS inbox_messages (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id        TEXT NOT NULL REFERENCES cells(id),
  envelope_id    TEXT NOT NULL,
  envelope       TEXT NOT NULL,                -- full JSON Envelope (with "to" filled)
  kind           TEXT NOT NULL CHECK (kind IN ('event','result')),
  type           TEXT NOT NULL,
  delivery       TEXT NOT NULL DEFAULT 'wakeup' CHECK (delivery IN ('wakeup','silent_inject')),
  principal_id   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                   ('pending','claimed','done','cancelled','dropped_epoch','quarantined','handed_back','dead')),
  status_reason  TEXT,
  deliver_at     INTEGER NOT NULL,             -- enqueue time for immediate delivery
  cancel_group   TEXT,
  schedule_id    TEXT REFERENCES inbox_schedules(id),
  expected_epoch INTEGER,
  claim_id       TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (cell_id, envelope_id)                -- transport idempotency: same id twice → "deduped"
);
-- "due pending by cell": WHERE cell_id = ? AND status = 'pending' AND deliver_at <= ? ORDER BY seq
CREATE INDEX IF NOT EXISTS idx_inbox_due ON inbox_messages(cell_id, status, deliver_at, seq);
-- next wakeup across all cells
CREATE INDEX IF NOT EXISTS idx_inbox_pending_at ON inbox_messages(deliver_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbox_claim ON inbox_messages(claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_group ON inbox_messages(cell_id, cancel_group) WHERE cancel_group IS NOT NULL;

CREATE TABLE IF NOT EXISTS inbox_claims (
  claim_id         TEXT PRIMARY KEY,
  cell_id          TEXT NOT NULL REFERENCES cells(id),
  worker_id        TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('serial_coalesce','competing_workers')),
  epoch            INTEGER NOT NULL,           -- cell epoch at claim time
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','released','expired')),
  claimed_at       INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  finished_at      INTEGER,
  release_reason   TEXT
);
-- serial lock: at most one active serial claim per cell
CREATE UNIQUE INDEX IF NOT EXISTS ux_claims_serial ON inbox_claims(cell_id) WHERE status = 'active' AND mode = 'serial_coalesce';
CREATE INDEX IF NOT EXISTS idx_claims_lease ON inbox_claims(lease_expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_claims_cell ON inbox_claims(cell_id, status);
`,
};
