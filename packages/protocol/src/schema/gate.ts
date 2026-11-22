import type { SchemaModule } from "./types";

export const gateSchema: SchemaModule = {
  owner: "@ng/gate", version: 1, migrations: [],
  ddl: `
CREATE TABLE IF NOT EXISTS human_items (
  action_id      TEXT PRIMARY KEY,
  cell_id        TEXT REFERENCES cells(id),
  epoch          INTEGER,             -- cell epoch at defer time
  principal_id   TEXT NOT NULL,                -- requester
  subject_key    TEXT NOT NULL,
  action_type    TEXT NOT NULL,
  action         TEXT NOT NULL,                -- JSON ProposedAction
  action_hash    TEXT NOT NULL,                -- hashAction(action)
  card           TEXT NOT NULL,                -- JSON Deliverable (format "card", data: ClarifyCard)
  artifact_id    TEXT,                         -- draft bound to this approval (artifacts.artifact_id, owned by @ng/context)
  bound_version  INTEGER,
  proposed_version INTEGER,                    -- version the agent proposed; human-written versions after it = human_edited
  item_revision  INTEGER NOT NULL DEFAULT 1,   -- card-level optimistic lock; bumped on every accepted decision/update
  disposition    TEXT NOT NULL DEFAULT 'pending' CHECK (disposition IN
                   ('pending','approved','denied','cancelled','superseded','executed')),
  status_reason  TEXT,
  snoozed_until  INTEGER,
  approver_id    TEXT,
  human_edited   INTEGER NOT NULL DEFAULT 0,   -- a human edited the draft between defer and approve
  outcome        TEXT,                         -- JSON ApprovalOutcome
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  options        TEXT,
  related_project_ids TEXT NOT NULL DEFAULT '[]',
  category       TEXT NOT NULL DEFAULT 'decision' CHECK (category IN ('action','decision')),
  effort         TEXT,
  due_at         INTEGER,
  status TEXT GENERATED ALWAYS AS (CASE
    WHEN disposition='pending' THEN CASE WHEN snoozed_until IS NULL THEN 'pending' ELSE 'snoozed' END
    WHEN disposition IN ('denied','cancelled','superseded') THEN 'cancelled' ELSE 'resolved' END) VIRTUAL,
  resolved_at    INTEGER
);
CREATE TABLE IF NOT EXISTS human_item_origins (
  cell_id TEXT NOT NULL REFERENCES cells(id), key TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES human_items(action_id),
  fields TEXT NOT NULL, PRIMARY KEY(cell_id,key)
);
CREATE INDEX IF NOT EXISTS idx_item_origins_item ON human_item_origins(item_id);
CREATE TABLE IF NOT EXISTS human_item_activity (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES human_items(action_id), before_state TEXT NOT NULL,
  after_revision INTEGER NOT NULL, receipt_cell TEXT, receipt_id TEXT, target_project TEXT, at INTEGER NOT NULL, undone_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_human_items_active ON human_items(subject_key)
  WHERE status IN ('pending','snoozed');
CREATE INDEX IF NOT EXISTS idx_items_cell ON human_items(cell_id, status);
CREATE INDEX IF NOT EXISTS idx_items_due ON human_items(due_at) WHERE due_at IS NOT NULL;
CREATE VIEW IF NOT EXISTS approvals AS SELECT action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card, artifact_id, bound_version, proposed_version, item_revision, disposition AS status, status_reason, snoozed_until, approver_id, human_edited, outcome, created_at, updated_at, resolved_at
  FROM human_items WHERE cell_id IS NOT NULL AND action_hash <> '';
`,
};
