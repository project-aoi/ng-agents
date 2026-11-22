import type { SchemaModule } from "./types";

/** Searchable body of an artifacts row (`content` is a JSON Deliverable). */
const artifactBody = (row: string) => `CASE WHEN json_valid(${row}.content) THEN json_extract(${row}.content, '$.body') END`;

/** Searchable text of a cell_state value: its string leaves, one per line (a non-JSON value counts as one string). */
const stateText = (row: string) =>
  `(SELECT group_concat(j.value, char(10)) FROM json_tree(CASE WHEN json_valid(${row}.value) THEN ${row}.value ELSE json_quote(${row}.value) END) AS j WHERE j.type = 'text')`;

// Owner: @ng/context. Gate/kernel read artifacts through artifactsRepo(db).
export const contextSchema: SchemaModule = {
  owner: "@ng/context",
  version: 1,
  migrations: [],
  ddl: /* sql */ `
-- Layer 1: business state (single writer per cell via the Inbox serial lock).
CREATE TABLE IF NOT EXISTS cell_state (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT, -- stable rowid for state_fts
  cell_id     TEXT NOT NULL REFERENCES cells(id),
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,                   -- JSON
  updated_at  INTEGER NOT NULL,
  UNIQUE (cell_id, key)
);
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
  cell_id     TEXT REFERENCES cells(id),       -- writing cell, NULL for human edits
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
  note             TEXT
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
CREATE INDEX IF NOT EXISTS idx_evidence_steer ON evidence(cell_id,json_extract(content,\'$.envelopeId\')) WHERE kind=\'system_note\';
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

-- Full-text indexes for searchHistory. Artifacts and state store derived text; resources use their source table.
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(title, body, tokenize = 'trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS state_fts USING fts5(key, text, tokenize = 'trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS resource_fts USING fts5(content, content = 'resources', tokenize = 'trigram');
CREATE TRIGGER IF NOT EXISTS artifact_fts_ai AFTER INSERT ON artifacts
BEGIN
  INSERT INTO artifact_fts(rowid, title, body) VALUES (new.rowid, new.title, ${artifactBody("new")});
END;
CREATE TRIGGER IF NOT EXISTS artifact_fts_au AFTER UPDATE ON artifacts
BEGIN
  DELETE FROM artifact_fts WHERE rowid = old.rowid;
  INSERT INTO artifact_fts(rowid, title, body) VALUES (new.rowid, new.title, ${artifactBody("new")});
END;
CREATE TRIGGER IF NOT EXISTS artifact_fts_ad AFTER DELETE ON artifacts
BEGIN
  DELETE FROM artifact_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS state_fts_ai AFTER INSERT ON cell_state
BEGIN
  INSERT INTO state_fts(rowid, key, text) VALUES (new.seq, new.key, ${stateText("new")});
END;
CREATE TRIGGER IF NOT EXISTS state_fts_au AFTER UPDATE ON cell_state
BEGIN
  DELETE FROM state_fts WHERE rowid = old.seq;
  INSERT INTO state_fts(rowid, key, text) VALUES (new.seq, new.key, ${stateText("new")});
END;
CREATE TRIGGER IF NOT EXISTS state_fts_ad AFTER DELETE ON cell_state
BEGIN
  DELETE FROM state_fts WHERE rowid = old.seq;
END;
CREATE TRIGGER IF NOT EXISTS resource_fts_ai AFTER INSERT ON resources
BEGIN
  INSERT INTO resource_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS resource_fts_ad AFTER DELETE ON resources
BEGIN
  INSERT INTO resource_fts(resource_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS resource_fts_au AFTER UPDATE ON resources
BEGIN
  INSERT INTO resource_fts(resource_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO resource_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Layer 3: SKILL.md bodies, notes and preferences (separate from business state).
CREATE TABLE IF NOT EXISTS knowledge (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT, -- stable rowid for the external-content FTS table
  id          TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('skill','working_note','reference','preference')),
  scope       TEXT NOT NULL CHECK (scope IN ('global','cell')),
  cell_id     TEXT REFERENCES cells(id),       -- set iff scope = 'cell'
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  applies     TEXT,                            -- JSON KnowledgeApplies (preferences); NULL = every cell
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
  -- fork_prefix children freeze the parent's history up to the fork point (JSON ModelMessage[]) and a fork note
  -- naming the child; both are dropped when the child is first compacted.
  inherited        TEXT,
  fork_note        TEXT,
  -- Compaction — one summary standing in for evidence up to summary_upto_seq.
  summary          TEXT,
  summary_upto_seq INTEGER NOT NULL DEFAULT 0,
  compactions      INTEGER NOT NULL DEFAULT 0
);
`,
};
