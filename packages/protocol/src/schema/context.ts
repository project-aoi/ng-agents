import type { SchemaModule } from "./types";

// Owner: @ng/context. Gate/kernel read artifacts through artifactsRepo(db).
export const contextSchema: SchemaModule = {
  owner: "@ng/context",
  version: 2,
  migrations: [
    {
      version: 2,
      up: /* sql */ `
ALTER TABLE artifact_parked ADD COLUMN note TEXT;
ALTER TABLE prompt_prefixes ADD COLUMN inherited TEXT;
ALTER TABLE prompt_prefixes ADD COLUMN fork_note TEXT;
ALTER TABLE prompt_prefixes ADD COLUMN summary TEXT;
ALTER TABLE prompt_prefixes ADD COLUMN summary_upto_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE prompt_prefixes ADD COLUMN compactions INTEGER NOT NULL DEFAULT 0;
`,
    },
  ],
  ddl: /* sql */ `
-- Layer 1: business state (single writer per cell via the Inbox serial lock).
CREATE TABLE IF NOT EXISTS cell_state (
  cell_id     TEXT NOT NULL REFERENCES cells(id),
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,                   -- JSON
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (cell_id, key)
) WITHOUT ROWID;
-- cross-cell prefix queries (queryState): WHERE key >= :p AND key < :p || char(0x10FFFF)
CREATE INDEX IF NOT EXISTS idx_state_key ON cell_state(key, cell_id);

-- Layer 1: human-visible drafts with optimistic versioning.
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  cell_id     TEXT NOT NULL REFERENCES cells(id),
  version     INTEGER NOT NULL CHECK (version >= 1),
  title       TEXT,
  format      TEXT NOT NULL CHECK (format IN ('text','markdown','json','card')),
  content     TEXT NOT NULL,                   -- JSON Deliverable of the current version
  updated_by  TEXT NOT NULL CHECK (updated_by IN ('agent','human')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_cell ON artifacts(cell_id, updated_at);

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  version     INTEGER NOT NULL,
  content     TEXT NOT NULL,                   -- JSON Deliverable
  updated_by  TEXT NOT NULL CHECK (updated_by IN ('agent','human')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, version)
) WITHOUT ROWID;

-- Reference zone: agent additions that lost a version race against a human edit are parked, never merged silently.
CREATE TABLE IF NOT EXISTS artifact_parked (
  id               TEXT PRIMARY KEY,
  artifact_id      TEXT NOT NULL REFERENCES artifacts(artifact_id),
  based_on_version INTEGER NOT NULL,
  content          TEXT NOT NULL,              -- JSON Deliverable
  created_at       INTEGER NOT NULL,
  dismissed_at     INTEGER,
  note             TEXT                        -- v2
);
CREATE INDEX IF NOT EXISTS idx_parked_artifact ON artifact_parked(artifact_id, dismissed_at);

-- Layer 2: append-only raw records.
CREATE TABLE IF NOT EXISTS evidence (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id    TEXT NOT NULL REFERENCES cells(id),
  run_id     TEXT,
  kind       TEXT NOT NULL CHECK (kind IN
               ('inbound','assistant_text','tool_call','tool_result','external','system_note','run_boundary')),
  content    TEXT NOT NULL,                    -- JSON StepOrExternalEvidence (large text already cut to the inline head)
  text       TEXT NOT NULL DEFAULT '',         -- plain searchable text
  spill_uri  TEXT,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_cell ON evidence(cell_id, seq);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id) WHERE run_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS evidence_append_only BEFORE UPDATE ON evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only');
END;

-- trigram tokenizer: substring search that works for Chinese. MATCH needs >= 3 characters;
-- for 1-2 character queries use: WHERE text LIKE '%' || :q || '%' on evidence_fts (still served by the trigram index for >= 3).
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  text,
  content = 'evidence',
  content_rowid = 'seq',
  tokenize = 'trigram'
);
CREATE TRIGGER IF NOT EXISTS evidence_fts_ai AFTER INSERT ON evidence
BEGIN
  INSERT INTO evidence_fts(rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER IF NOT EXISTS evidence_fts_ad AFTER DELETE ON evidence
BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;

-- Inline & Spill: full large outputs addressed by URI (res://<cellId>/<id>), read in pages.
CREATE TABLE IF NOT EXISTS resources (
  uri         TEXT PRIMARY KEY,
  cell_id     TEXT NOT NULL REFERENCES cells(id),
  run_id      TEXT,
  mime        TEXT NOT NULL DEFAULT 'text/plain',
  source      TEXT,                            -- e.g. tool name, "job:<id>"
  content     TEXT NOT NULL,
  size_chars  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_cell ON resources(cell_id, created_at);

-- Layer 3: SKILL.md bodies, notes and preferences (separate from business state).
CREATE TABLE IF NOT EXISTS knowledge (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT, -- stable rowid for the external-content FTS table
  id          TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('skill','note','preference')),
  scope       TEXT NOT NULL CHECK (scope IN ('global','cell')),
  cell_id     TEXT REFERENCES cells(id),       -- set iff scope = 'cell'
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK ((scope = 'cell') = (cell_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_knowledge_name ON knowledge(kind, scope, COALESCE(cell_id, ''), name);
CREATE INDEX IF NOT EXISTS idx_knowledge_cell ON knowledge(cell_id) WHERE cell_id IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  name, description, body,
  content = 'knowledge',
  content_rowid = 'seq',
  tokenize = 'trigram'
);
CREATE TRIGGER IF NOT EXISTS knowledge_fts_ai AFTER INSERT ON knowledge
BEGIN
  INSERT INTO knowledge_fts(rowid, name, description, body) VALUES (new.seq, new.name, new.description, new.body);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_fts_ad AFTER DELETE ON knowledge
BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, name, description, body)
  VALUES ('delete', old.seq, old.name, old.description, old.body);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_fts_au AFTER UPDATE ON knowledge
BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, name, description, body)
  VALUES ('delete', old.seq, old.name, old.description, old.body);
  INSERT INTO knowledge_fts(rowid, name, description, body) VALUES (new.seq, new.name, new.description, new.body);
END;

-- Frozen system prefix per cell (prompt-cache stability). Rebuilt only on compaction or an explicit refresh.
CREATE TABLE IF NOT EXISTS prompt_prefixes (
  cell_id     TEXT PRIMARY KEY REFERENCES cells(id),
  text        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  skills      TEXT NOT NULL DEFAULT '[]',      -- JSON SkillIndexEntry[] embedded in text
  epoch       INTEGER NOT NULL,                -- cell epoch when frozen
  created_at  INTEGER NOT NULL,
  -- v2: fork_prefix children freeze the parent's history up to the fork point (JSON ModelMessage[]) and a fork note
  -- naming the child; both are dropped when the child is first compacted.
  inherited        TEXT,
  fork_note        TEXT,
  -- v2: compaction — one summary standing in for evidence up to summary_upto_seq.
  summary          TEXT,
  summary_upto_seq INTEGER NOT NULL DEFAULT 0,
  compactions      INTEGER NOT NULL DEFAULT 0
);
`,
};
