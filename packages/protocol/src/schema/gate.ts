import type { SchemaModule } from "./types";

const statusColumn = `status         TEXT GENERATED ALWAYS AS (CASE
    WHEN disposition = 'unknown' THEN 'unknown'
    WHEN disposition = 'pending' OR (disposition = 'failed' AND action_type = 'channel.send') OR (disposition = 'approved' AND action_type = 'channel.send')
      THEN CASE WHEN snoozed_until IS NULL THEN 'pending' ELSE 'snoozed' END
    WHEN disposition IN ('cancelled','denied','superseded') THEN 'cancelled'
    ELSE 'resolved' END) VIRTUAL`;

const humanItemsTable = /* sql */ `CREATE TABLE IF NOT EXISTS human_items (
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
  proposed_version INTEGER,                    -- v2: version the agent proposed; human-written versions after it = human_edited
  item_revision  INTEGER NOT NULL DEFAULT 1,   -- v4: card-level optimistic lock; bumped on every accepted decision/update
  disposition    TEXT NOT NULL DEFAULT 'pending' CHECK (disposition IN
                   ('pending','approved','denied','cancelled','superseded','executed','failed','unknown')),
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
  blocked_by     TEXT REFERENCES human_items(action_id),
  ${statusColumn},
  resolved_at    INTEGER
);`;

// Owner: @ng/gate.
export const gateSchema: SchemaModule = {
  owner: "@ng/gate",
  version: 8,
  migrations: [
    {
      version: 2,
      up: /* sql */ `
ALTER TABLE approvals ADD COLUMN proposed_version INTEGER;
ALTER TABLE action_tokens ADD COLUMN secret_ref TEXT;
ALTER TABLE ledger ADD COLUMN revoked_at INTEGER;
ALTER TABLE ledger ADD COLUMN revoke_reason TEXT;
`,
    },
    {
      version: 3,
      up: /* sql */ `
ALTER TABLE usage_log ADD COLUMN raw_tokens INTEGER;
ALTER TABLE usage_log ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
`,
    },
    {
      version: 4,
      up: /* sql */ `
ALTER TABLE approvals ADD COLUMN item_revision INTEGER NOT NULL DEFAULT 1;
`,
    },
    {
      version: 5,
      up: `
ALTER TABLE ledger ADD COLUMN declined_at INTEGER;
${humanItemsTable}
INSERT INTO human_items (action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card, artifact_id, bound_version, proposed_version, item_revision, disposition, status_reason, snoozed_until, approver_id, human_edited, outcome, created_at, updated_at, resolved_at)
  SELECT action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card, artifact_id, bound_version, proposed_version, item_revision, status, status_reason, snoozed_until, approver_id, human_edited, outcome, created_at, updated_at, resolved_at FROM approvals;
-- The old partial index allowed unfinished sends next to a newer draft. Preserve each id and its ordering.
WITH ordered AS (
  SELECT action_id, lag(action_id) OVER (PARTITION BY subject_key ORDER BY
    CASE disposition WHEN 'unknown' THEN 0 WHEN 'approved' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, created_at, action_id) AS predecessor
  FROM human_items WHERE status IN ('pending','snoozed','unknown')
)
UPDATE human_items SET blocked_by = ordered.predecessor FROM ordered WHERE human_items.action_id = ordered.action_id;
DROP TABLE approvals;
`,
    },
    {version: 6, up: "DROP VIEW IF EXISTS approvals;"},
    {version: 7, up: `
      UPDATE action_tokens SET revoked_at=created_at WHERE used_at IS NULL AND revoked_at IS NULL AND action_id IN
        (SELECT action_id FROM human_items WHERE action_type IN ('workspace.exec','job.start','cell.spawn','cell.control'));
      UPDATE human_items SET
        action=json_object('type','custom','name','legacy.request','summary',coalesce(json_extract(action,'$.summary'),subject_key),
          'sideEffect','none','subjectKey',subject_key,'args',json_object('originalAction',json(action))),
        action_type='custom',action_hash='',options=NULL,item_revision=item_revision+1
      WHERE action_type IN ('workspace.exec','job.start','cell.spawn','cell.control') AND disposition='pending';
    `},
    { version: 8, up: `
      DROP TABLE IF EXISTS gate_authorizations;
      DROP VIEW IF EXISTS approvals;
      DROP TRIGGER IF EXISTS activate_next_human_item;
      DROP INDEX IF EXISTS idx_items_cell;
      DROP INDEX IF EXISTS ux_human_items_active;
      ALTER TABLE human_items DROP COLUMN status;
      ALTER TABLE human_items ADD COLUMN ${statusColumn};
      -- Keep the existing per-subject order. Skip only predecessors retired by the corrected status column.
      WITH RECURSIVE nearest(id, predecessor) AS (
        SELECT action_id, blocked_by FROM human_items
        UNION ALL
        SELECT n.id, h.blocked_by FROM nearest n JOIN human_items h ON h.action_id=n.predecessor
        WHERE h.status IN ('resolved','cancelled')
      ), active AS MATERIALIZED (
        SELECT n.id,n.predecessor FROM nearest n LEFT JOIN human_items h ON h.action_id=n.predecessor
        WHERE n.predecessor IS NULL OR h.status IN ('pending','snoozed','unknown')
      )
      UPDATE human_items SET blocked_by=active.predecessor FROM active
      WHERE human_items.action_id=active.id AND human_items.status IN ('pending','snoozed','unknown');
    `},
  ],
  ddl: /* sql */ `
${humanItemsTable}
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
  WHERE status IN ('pending','snoozed','unknown') AND blocked_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_cell ON human_items(cell_id, status);
CREATE INDEX IF NOT EXISTS idx_items_due ON human_items(due_at) WHERE due_at IS NOT NULL;
-- Read compatibility for Phase 0 callers. All writes go directly to human_items.
CREATE VIEW IF NOT EXISTS approvals AS SELECT action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card, artifact_id, bound_version, proposed_version, item_revision, disposition AS status, status_reason, snoozed_until, approver_id, human_edited, outcome, created_at, updated_at, resolved_at
  FROM human_items WHERE cell_id IS NOT NULL AND action_hash <> '' AND blocked_by IS NULL;
CREATE TRIGGER IF NOT EXISTS activate_next_human_item AFTER UPDATE OF disposition ON human_items
WHEN NEW.status IN ('resolved','cancelled') AND OLD.status IN ('pending','snoozed','unknown')
BEGIN
  UPDATE human_items SET blocked_by = NEW.blocked_by, item_revision = item_revision + 1 WHERE blocked_by = NEW.action_id AND status IN ('pending','snoozed','unknown');
END;
-- Dual ledger: own usage + subtree rollup (own + all descendants), per cell.
CREATE TABLE IF NOT EXISTS ledger (
  cell_id         TEXT PRIMARY KEY REFERENCES cells(id),
  own_tokens      INTEGER NOT NULL DEFAULT 0,
  own_cents       REAL NOT NULL DEFAULT 0,
  subtree_tokens  INTEGER NOT NULL DEFAULT 0,
  subtree_cents   REAL NOT NULL DEFAULT 0,
  raised_tokens   INTEGER NOT NULL DEFAULT 0,  -- human-granted extra allowance ("追加额度")
  raised_cents    REAL NOT NULL DEFAULT 0,
  declined_at     INTEGER,
  warned_at       INTEGER,
  stopped_at      INTEGER,
  updated_at      INTEGER NOT NULL,
  revoked_at      INTEGER,                     -- v2: Gate.revoke — authorize denies this cell and its descendants for good
  revoke_reason   TEXT
);

-- Append-only usage log (weekly review, per-run cost).
CREATE TABLE IF NOT EXISTS usage_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id    TEXT NOT NULL REFERENCES cells(id),
  tokens     INTEGER NOT NULL,             -- charged against the limits (cache reads weighted)
  cents      REAL NOT NULL,
  at         INTEGER NOT NULL,
  raw_tokens    INTEGER,                   -- v3: tokens as the model reported them (NULL on rows from before v3: same as tokens)
  cached_tokens INTEGER NOT NULL DEFAULT 0 -- v3: how many of raw_tokens were prompt-cache reads
);
CREATE INDEX IF NOT EXISTS idx_usage_cell ON usage_log(cell_id, at);

-- Budget raises are audited.
CREATE TABLE IF NOT EXISTS budget_raises (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id     TEXT NOT NULL REFERENCES cells(id),
  tokens      INTEGER NOT NULL DEFAULT 0,
  cents       REAL NOT NULL DEFAULT 0,
  approver_id TEXT NOT NULL,
  at          INTEGER NOT NULL
);

-- Single-use, expiring tokens bound to hashAction(action). Only the sha256 of the bearer token is stored.
CREATE TABLE IF NOT EXISTS action_tokens (
  token_hash   TEXT PRIMARY KEY,
  action_hash  TEXT NOT NULL,
  action_id    TEXT,                           -- approval it was minted for, if any
  cell_id      TEXT NOT NULL REFERENCES cells(id),
  epoch        INTEGER NOT NULL,               -- invalid once the cell epoch moves
  secret_ref   TEXT,                           -- v2: set for secret.use tokens (redeemed host-side by injectSecret)
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_cell ON action_tokens(cell_id) WHERE used_at IS NULL AND revoked_at IS NULL;

-- Trust grows gradually (docs/03 principle 4).
CREATE TABLE IF NOT EXISTS policy_rules (
  id             TEXT PRIMARY KEY,
  action_type    TEXT NOT NULL,                -- ProposedAction type or '*'
  target_pattern TEXT,                         -- exact or trailing-* prefix (see addressCovers)
  effect         TEXT NOT NULL CHECK (effect IN ('allow','defer','deny')),
  scope_cell_id  TEXT REFERENCES cells(id),    -- NULL = everywhere, else that cell's subtree
  max_uses       INTEGER,                      -- NULL = unlimited
  uses           INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_type ON policy_rules(action_type) WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS approval_stats (
  action_class       TEXT PRIMARY KEY,         -- actionClassOf(action)
  approved           INTEGER NOT NULL DEFAULT 0,
  approved_unedited  INTEGER NOT NULL DEFAULT 0,
  unedited_streak    INTEGER NOT NULL DEFAULT 0,
  denied             INTEGER NOT NULL DEFAULT 0,
  last_decided_at    INTEGER,
  suggested_at       INTEGER
);
`,
};
