import type { SchemaModule } from "./types";

// Owner: @ng/gate.
export const gateSchema: SchemaModule = {
  owner: "@ng/gate",
  version: 3,
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
  ],
  ddl: /* sql */ `
-- One row per deferred action; a 'pending' row is a Clarify card.
CREATE TABLE IF NOT EXISTS approvals (
  action_id      TEXT PRIMARY KEY,
  cell_id        TEXT NOT NULL REFERENCES cells(id),
  epoch          INTEGER NOT NULL,             -- cell epoch at defer time
  principal_id   TEXT NOT NULL,                -- requester
  subject_key    TEXT NOT NULL,
  action_type    TEXT NOT NULL,
  action         TEXT NOT NULL,                -- JSON ProposedAction
  action_hash    TEXT NOT NULL,                -- hashAction(action)
  card           TEXT NOT NULL,                -- JSON Deliverable (format "card", data: ClarifyCard)
  artifact_id    TEXT,                         -- draft bound to this approval (artifacts.artifact_id, owned by @ng/context)
  bound_version  INTEGER,
  proposed_version INTEGER,                    -- v2: version the agent proposed; human-written versions after it = human_edited
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                   ('pending','approved','denied','cancelled','superseded','executed','failed','unknown')),
  status_reason  TEXT,
  snoozed_until  INTEGER,
  approver_id    TEXT,
  human_edited   INTEGER NOT NULL DEFAULT 0,   -- a human edited the draft between defer and approve
  outcome        TEXT,                         -- JSON ApprovalOutcome
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  resolved_at    INTEGER
);
-- "同一事项至多一张卡": at most one pending approval per subject.
CREATE UNIQUE INDEX IF NOT EXISTS ux_approvals_one_pending ON approvals(subject_key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_cell ON approvals(cell_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_artifact ON approvals(artifact_id) WHERE artifact_id IS NOT NULL;

-- Dual ledger: own usage + subtree rollup (own + all descendants), per cell.
CREATE TABLE IF NOT EXISTS ledger (
  cell_id         TEXT PRIMARY KEY REFERENCES cells(id),
  own_tokens      INTEGER NOT NULL DEFAULT 0,
  own_cents       REAL NOT NULL DEFAULT 0,
  subtree_tokens  INTEGER NOT NULL DEFAULT 0,
  subtree_cents   REAL NOT NULL DEFAULT 0,
  raised_tokens   INTEGER NOT NULL DEFAULT 0,  -- human-granted extra allowance ("追加额度")
  raised_cents    REAL NOT NULL DEFAULT 0,
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
