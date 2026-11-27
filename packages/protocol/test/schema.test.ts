import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_SCHEMAS,
  TABLE_OWNERS,
  all,
  applySchemas,
  get,
  openDatabase,
  run,
  schemaVersions,
  type SchemaModule,
} from "../src";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempPath(): string {
  const d = mkdtempSync(join(tmpdir(), "ng-protocol-"));
  dirs.push(d);
  return join(d, "nested", "ng.db");
}

describe("schema", () => {
  it("creates every owned table and records one version row per owner", () => {
    const db = openDatabase(":memory:");
    const names = new Set(all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type IN ('table')").map((r) => r.name));
    for (const table of Object.keys(TABLE_OWNERS)) expect(names, table).toContain(table);
    expect(schemaVersions(db)).toEqual(Object.fromEntries(ALL_SCHEMAS.map((m) => [m.owner, m.version])));
  });

  it("applies twice without error (in-memory and on disk, WAL)", () => {
    const db = openDatabase(":memory:");
    expect(() => applySchemas(db, ALL_SCHEMAS)).not.toThrow();
    expect(() => applySchemas(db, ALL_SCHEMAS)).not.toThrow();

    const path = tempPath();
    const a = openDatabase(path);
    run(a, "INSERT INTO cells (id, root_id, spec, bounds, principal_id, created_at, updated_at) VALUES ('desk','desk','{}','{}','owner',1,1)");
    a.close();
    const b = openDatabase(path);
    expect(get<{ journal_mode: string }>(b, "PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(get<{ foreign_keys: number }>(b, "PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    expect(get<{ n: number }>(b, "SELECT count(*) AS n FROM cells")?.n).toBe(1);
    b.close();
  });

  it("reserves a human item's subject while snoozed or revising and releases it when resolved", () => {
    const db = openDatabase(":memory:");
    const insertItem = (id: string) => run(db, `
      INSERT INTO human_items (action_id, principal_id, subject_key, category, action_type, action, action_hash, card, created_at, updated_at)
      VALUES (?, 'owner', 'dentist', 'action', 'custom', '{}', '', '{}', 1, 1)
    `, [id]);
    const status = () => get<{ status: string }>(db, "SELECT status FROM human_items WHERE action_id = 'first'")?.status;
    insertItem("first");
    expect(status()).toBe("pending");
    run(db, "UPDATE human_items SET snoozed_until = 100 WHERE action_id = 'first'");
    expect(status()).toBe("snoozed");
    expect(() => insertItem("next")).toThrow(/UNIQUE/);
    run(db, "UPDATE human_items SET disposition = 'revising', snoozed_until = NULL, revise_note = '再改改' WHERE action_id = 'first'");
    expect(status()).toBe("revising");
    expect(() => insertItem("next")).toThrow(/UNIQUE/);
    run(db, "UPDATE human_items SET disposition = 'executed', revise_note = NULL WHERE action_id = 'first'");
    expect(status()).toBe("resolved");
    insertItem("next");
    db.close();
  });

  it("migrates an existing @ng/gate v1 database to v2 preserving rows and foreign keys", () => {
    const path = tempPath();
    const v1Gate = {
      owner: "@ng/gate",
      version: 1,
      migrations: [],
      ddl: `
CREATE TABLE IF NOT EXISTS human_items (
  action_id      TEXT PRIMARY KEY,
  cell_id        TEXT REFERENCES cells(id),
  epoch          INTEGER,
  principal_id   TEXT NOT NULL,
  subject_key    TEXT NOT NULL,
  action_type    TEXT NOT NULL,
  action         TEXT NOT NULL,
  action_hash    TEXT NOT NULL,
  card           TEXT NOT NULL,
  artifact_id    TEXT,
  bound_version  INTEGER,
  proposed_version INTEGER,
  item_revision  INTEGER NOT NULL DEFAULT 1,
  disposition    TEXT NOT NULL DEFAULT 'pending' CHECK (disposition IN ('pending','approved','denied','cancelled','superseded','executed')),
  status_reason  TEXT,
  snoozed_until  INTEGER,
  approver_id    TEXT,
  human_edited   INTEGER NOT NULL DEFAULT 0,
  outcome        TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_human_items_active ON human_items(COALESCE(cell_id,''), subject_key)
  WHERE status IN ('pending','snoozed');
`,
    };
    const a = openDatabase(path, { schemas: ALL_SCHEMAS.map((m) => (m.owner === "@ng/gate" ? v1Gate : m)) });
    run(a, "INSERT INTO cells (id, root_id, spec, bounds, principal_id, created_at, updated_at) VALUES ('desk','desk','{}','{}','owner',1,1)");
    run(a, "INSERT INTO human_items (action_id, cell_id, epoch, principal_id, subject_key, category, action_type, action, action_hash, card, created_at, updated_at) VALUES ('act_1','desk',0,'cell:desk','sub:1','action','custom','{}','','{}',1,1)");
    run(a, "INSERT INTO human_item_activity (id, item_id, before_state, after_revision, after_disposition, at) VALUES ('ha_1','act_1','{}',2,'executed',2)");
    expect(schemaVersions(a)["@ng/gate"]).toBe(1);
    a.close();

    const b = openDatabase(path);
    expect(schemaVersions(b)["@ng/gate"]).toBe(2);
    run(b, "UPDATE human_items SET disposition = 'revising', revise_note = '补查上游' WHERE action_id = 'act_1'");
    expect(get(b, "SELECT status, revise_note FROM human_items WHERE action_id = 'act_1'")).toEqual({ status: "revising", revise_note: "补查上游" });
    expect(get<{ n: number }>(b, "SELECT count(*) AS n FROM human_item_activity WHERE item_id = 'act_1'")?.n).toBe(1);
    expect(all(b, "PRAGMA foreign_key_check")).toEqual([]);
    b.close();
  });

  it("migrates @ng/workspace v1 → v2 so existing workspaces tables accept status = 'closed' and sync closed cells", () => {
    const dir = mkdtempSync(join(tmpdir(), "ng-ws-mig-"));
    dirs.push(dir);
    const path = join(dir, "ng.db");
    const v1Workspace: SchemaModule = {
      owner: "@ng/workspace",
      version: 1,
      migrations: [],
      ddl: `
CREATE TABLE IF NOT EXISTS workspaces (
  cell_id       TEXT PRIMARY KEY REFERENCES cells(id),
  path          TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active','failed')),
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id              TEXT PRIMARY KEY,
  cell_id             TEXT NOT NULL REFERENCES cells(id),
  epoch               INTEGER NOT NULL,
  command             TEXT NOT NULL,
  cwd                 TEXT,
  state               TEXT NOT NULL CHECK (state IN ('running','succeeded','failed','cancelled')),
  pid                 INTEGER,
  process_identity    TEXT,
  log_path            TEXT,
  exit_code           INTEGER,
  result_envelope_id  TEXT,
  error               TEXT,
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  updated_at          INTEGER NOT NULL,
  cancel_requested_at INTEGER,
  timeout_ms          INTEGER
);
`,
    };
    const a = openDatabase(path, { schemas: ALL_SCHEMAS.map((m) => (m.owner === "@ng/workspace" ? v1Workspace : m)) });
    run(a, "INSERT INTO cells (id, root_id, status, spec, bounds, principal_id, created_at, updated_at) VALUES ('desk','desk','active','{}','{}','owner',1,1)");
    run(a, "INSERT INTO cells (id, parent_id, root_id, status, spec, bounds, principal_id, created_at, updated_at) VALUES ('w_old','desk','desk','closed','{}','{}','cell:desk',1,2)");
    run(a, "INSERT INTO workspaces (cell_id, path, status, created_at, updated_at) VALUES ('desk','/tmp/d','active',1,1)");
    run(a, "INSERT INTO workspaces (cell_id, path, status, created_at, updated_at) VALUES ('w_old','/tmp/w','active',1,1)");
    expect(schemaVersions(a)["@ng/workspace"]).toBe(1);
    a.close();

    const b = openDatabase(path);
    expect(schemaVersions(b)["@ng/workspace"]).toBe(2);
    expect(get(b, "SELECT status FROM workspaces WHERE cell_id = 'w_old'")).toEqual({ status: "closed" });
    run(b, "UPDATE workspaces SET status = 'closed', updated_at = 3 WHERE cell_id = 'desk'");
    expect(get(b, "SELECT status FROM workspaces WHERE cell_id = 'desk'")).toEqual({ status: "closed" });
    expect(all(b, "PRAGMA foreign_key_check")).toEqual([]);
    b.close();
  });

  it("migrates @ng/context v1 → v2 losslessly: drops resource_fts, rebuilds selective evidence_fts and recreates triggers (M4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ng-ctx-mig-"));
    dirs.push(dir);
    const path = join(dir, "ng.db");
    const v1Context: SchemaModule = {
      owner: "@ng/context",
      version: 1,
      migrations: [],
      ddl: `
CREATE TABLE IF NOT EXISTS cell_state (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id TEXT NOT NULL REFERENCES cells(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (cell_id, key)
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  cell_id TEXT NOT NULL REFERENCES cells(id),
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  content TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cell_id TEXT,
  PRIMARY KEY (artifact_id, version)
);
CREATE TABLE IF NOT EXISTS artifact_parked (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  cell_id TEXT NOT NULL REFERENCES cells(id),
  based_on_version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dismissed_at INTEGER
);
CREATE TABLE IF NOT EXISTS evidence (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id TEXT NOT NULL REFERENCES cells(id),
  run_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  text TEXT NOT NULL,
  spill_uri TEXT,
  at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(text, content = 'evidence', content_rowid = 'seq', tokenize = 'trigram');
CREATE TRIGGER IF NOT EXISTS evidence_fts_ai AFTER INSERT ON evidence BEGIN INSERT INTO evidence_fts(rowid, text) VALUES (new.seq, new.text); END;
CREATE TRIGGER IF NOT EXISTS evidence_fts_ad AFTER DELETE ON evidence BEGIN INSERT INTO evidence_fts(evidence_fts, rowid, text) VALUES ('delete', old.seq, old.text); END;
CREATE TABLE IF NOT EXISTS resources (
  uri TEXT PRIMARY KEY,
  cell_id TEXT NOT NULL REFERENCES cells(id),
  run_id TEXT,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(title, body, tokenize = 'trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS state_fts USING fts5(key, text, tokenize = 'trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS resource_fts USING fts5(content, content = 'resources', tokenize = 'trigram');
CREATE TRIGGER IF NOT EXISTS resource_fts_ai AFTER INSERT ON resources BEGIN INSERT INTO resource_fts(rowid, content) VALUES (new.rowid, new.content); END;
CREATE TRIGGER IF NOT EXISTS resource_fts_ad AFTER DELETE ON resources BEGIN INSERT INTO resource_fts(resource_fts, rowid, content) VALUES ('delete', old.rowid, old.content); END;
CREATE TRIGGER IF NOT EXISTS resource_fts_au AFTER UPDATE ON resources BEGIN INSERT INTO resource_fts(resource_fts, rowid, content) VALUES ('delete', old.rowid, old.content); INSERT INTO resource_fts(rowid, content) VALUES (new.rowid, new.content); END;
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  cell_id TEXT REFERENCES cells(id),
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  applies TEXT,
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(name, description, body, tags, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS prompt_prefixes (
  cell_id TEXT PRIMARY KEY REFERENCES cells(id),
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  skills TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  inherited TEXT,
  fork_note TEXT,
  summary TEXT,
  summary_upto_seq INTEGER NOT NULL DEFAULT 0,
  compactions INTEGER NOT NULL DEFAULT 0
);
`,
    };
    const a = openDatabase(path, { schemas: ALL_SCHEMAS.map((m) => (m.owner === "@ng/context" ? v1Context : m)) });
    run(a, "INSERT INTO cells (id, root_id, status, spec, bounds, principal_id, created_at, updated_at) VALUES ('desk','desk','active','{}','{}','owner',1,1)");
    run(a, "INSERT INTO evidence (cell_id, run_id, kind, content, text, at) VALUES ('desk','r1','inbound','{\"kind\":\"inbound\",\"envelope\":{\"id\":\"e1\"}}','hello inbound needle',1)");
    run(a, "INSERT INTO evidence (cell_id, run_id, kind, content, text, at) VALUES ('desk','r1','tool_result','{\"kind\":\"tool_result\"}','giant cargo compile blob log_needle',2)");
    run(a, "INSERT INTO evidence (cell_id, run_id, kind, content, text, at) VALUES ('desk','r1','tool_call','{\"kind\":\"tool_call\"}','" + "x".repeat(400) + "',3)");
    run(a, "INSERT INTO resources (uri, cell_id, run_id, source, content, byte_length, created_at) VALUES ('res://desk/1','desk','r1','spill','spilled resource payload',24,4)");
    expect(schemaVersions(a)["@ng/context"]).toBe(1);
    a.close();

    const b = openDatabase(path);
    expect(schemaVersions(b)["@ng/context"]).toBe(2);
    // resource_fts table and triggers are removed
    expect(get(b, "SELECT name FROM sqlite_master WHERE name = 'resource_fts'")).toBeUndefined();
    // evidence_fts retains inbound + capped tool_call only (excludes tool_result)
    const indexed = all<{ rowid: number; text: string }>(b, "SELECT rowid, text FROM evidence_fts ORDER BY rowid");
    expect(indexed.map((r) => r.rowid)).toEqual([1, 3]);
    expect(indexed[1]!.text.length).toBe(256);
    // Recreated evidence_fts_ai trigger indexes new conversational rows and ignores new tool_result rows
    run(b, "INSERT INTO evidence (cell_id, run_id, kind, content, text, at) VALUES ('desk','r2','assistant_text','{\"kind\":\"assistant_text\"}','post migration answer',5)");
    run(b, "INSERT INTO evidence (cell_id, run_id, kind, content, text, at) VALUES ('desk','r2','tool_result','{\"kind\":\"tool_result\"}','post migration blob',6)");
    expect(all<{ rowid: number }>(b, "SELECT rowid FROM evidence_fts ORDER BY rowid").map((r) => r.rowid)).toEqual([1, 3, 4]);
    // Raw evidence & resources data preserved 100% losslessly
    expect(get<{ n: number }>(b, "SELECT count(*) AS n FROM evidence")?.n).toBe(5);
    expect(get<{ n: number }>(b, "SELECT count(*) AS n FROM resources")?.n).toBe(1);
    expect(all(b, "PRAGMA foreign_key_check")).toEqual([]);
    b.close();
  });

  it("enforces foreign keys to cells", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      run(db, "INSERT INTO cell_state (cell_id, key, value, updated_at) VALUES ('nope', 'k', '1', 1)"),
    ).toThrow(/FOREIGN KEY/);
  });
});
