import type { SchemaModule } from "./types";

// Owner: @ng/channel.
export const channelSchema: SchemaModule = {
  owner: "@ng/channel",
  version: 4,
  migrations: [
    { version: 2, up: "ALTER TABLE outbox ADD COLUMN refused INTEGER NOT NULL DEFAULT 0" },
    { version: 3, up: "CREATE INDEX IF NOT EXISTS idx_outbox_action ON outbox(action_id, created_at) WHERE action_id IS NOT NULL;" },
  ],
  ddl: /* sql */ `
CREATE TABLE IF NOT EXISTS outbox (
  id               TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  channel_id       TEXT NOT NULL,
  target           TEXT NOT NULL,              -- adapter-level target (after "channel:<id>:")
  content          TEXT NOT NULL,              -- JSON Deliverable
  status           TEXT NOT NULL CHECK (status IN ('pending','sent','buffered_dnd','failed','unknown')),
  urgent           INTEGER NOT NULL DEFAULT 0,
  refused          INTEGER NOT NULL DEFAULT 0, -- failed at the action-token check; never retried
  cell_id          TEXT REFERENCES cells(id),  -- originating cell, if any
  action_id        TEXT,                       -- approval executed by this send, if any
  attempts         INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  external_id      TEXT,                       -- message id on the external system
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  sent_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_channel ON outbox(channel_id, status);
CREATE INDEX IF NOT EXISTS idx_outbox_cell ON outbox(cell_id) WHERE cell_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_action ON outbox(action_id, created_at) WHERE action_id IS NOT NULL;

-- Small per-channel state; channel_id '*' holds global flags such as the Engage focus/DND switch (key 'focus').
CREATE TABLE IF NOT EXISTS editor_leases (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channel_state (
  channel_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,                   -- JSON
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, key)
) WITHOUT ROWID;
`,
};
