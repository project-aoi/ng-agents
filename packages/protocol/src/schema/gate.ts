import type { SchemaModule } from "./types";

export const gateSchema: SchemaModule = {
  owner: "@ng/gate",
  version: 1,
  migrations: [],
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
  card           TEXT NOT NULL,                -- JSON Deliverable (format "card", data: DecisionCard)
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
    WHEN disposition='cancelled' AND status_reason='replied' THEN 'resolved'
    WHEN disposition IN ('denied','cancelled','superseded') THEN 'cancelled' ELSE 'resolved' END) VIRTUAL,
  resolved_at    INTEGER
);
CREATE TABLE IF NOT EXISTS human_item_activity (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES human_items(action_id), before_state TEXT NOT NULL,
  after_revision INTEGER NOT NULL, after_disposition TEXT NOT NULL, closed_epoch INTEGER, receipt_cell TEXT, receipt_id TEXT, target_project TEXT, at INTEGER NOT NULL, undone_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_item_activity_item ON human_item_activity(item_id, at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_human_items_active ON human_items(COALESCE(cell_id,''), subject_key)
  WHERE status IN ('pending','snoozed');
CREATE TRIGGER IF NOT EXISTS clear_finished_resurface AFTER UPDATE OF disposition,snoozed_until ON human_items
WHEN OLD.snoozed_until IS NOT NULL AND (NEW.disposition <> 'pending' OR NEW.snoozed_until IS NULL)
BEGIN
  UPDATE inbox_messages SET status='cancelled', status_reason='item settled', updated_at=NEW.updated_at
  WHERE status='pending' AND cancel_group='resurface:' || NEW.action_id AND type='timer.fired'
    AND cell_id IN (SELECT id FROM cells WHERE parent_id IS NULL);
END;
CREATE INDEX IF NOT EXISTS idx_items_cell ON human_items(cell_id, status);
CREATE INDEX IF NOT EXISTS idx_items_due ON human_items(due_at) WHERE due_at IS NOT NULL;
`,
};
