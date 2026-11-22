import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { all, cellsRepo, contextSchema, createBus, createRegistry, ManualClock, openDatabase, run, schemaVersions, type Db } from "@ng/protocol";
import { createContextStore } from "../src";
import { FakeInbox, tempDir } from "./helpers";

const V2_COLUMNS: Record<string, string[]> = {
  artifact_parked: ["note"],
  prompt_prefixes: ["inherited", "fork_note", "summary", "summary_upto_seq", "compactions"],
};
const V3_FTS = ["artifact_fts", "state_fts", "resource_fts"];

const columns = (db: Db, table: string) => all<{ name: string }>(db, `PRAGMA table_info(${table})`).map((c) => c.name);
const tables = (db: Db) => all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);

/** Turn a freshly created database back into the v3 shape: knowledge rows have no `applies`. */
function downgradeToV3(db: Db): void {
  db.exec("ALTER TABLE knowledge DROP COLUMN applies");
  run(db, "UPDATE schema_versions SET version = 3 WHERE owner = '@ng/context'");
}

/** Turn a freshly created database back into the v2 shape: no search indexes, no artifact_versions.cell_id, cell_state WITHOUT ROWID. */
function downgradeToV2(db: Db): void {
  downgradeToV3(db);
  for (const t of V3_FTS) for (const op of ["ai", "au", "ad"]) db.exec(`DROP TRIGGER ${t}_${op}`);
  for (const t of V3_FTS) db.exec(`DROP TABLE ${t}`);
  db.exec(`
DROP TABLE artifact_versions;
CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), version INTEGER NOT NULL, content TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (updated_by IN ('agent','human')), created_at INTEGER NOT NULL, PRIMARY KEY (artifact_id, version)
) WITHOUT ROWID;
DROP TABLE cell_state;
CREATE TABLE cell_state (
  cell_id TEXT NOT NULL REFERENCES cells(id), key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (cell_id, key)
) WITHOUT ROWID;
CREATE INDEX idx_state_key ON cell_state(key, cell_id);`);
  run(db, "UPDATE schema_versions SET version = 2 WHERE owner = '@ng/context'");
}

function storeOn(db: Db) {
  return createContextStore({ db, bus: createBus(), clock: new ManualClock(1_763_366_400_000), inbox: new FakeInbox(db), dataDir: tempDir(), registry: createRegistry() });
}

describe("context schema migrations", () => {
  it("migrates a v1 database in place", () => {
    const path = join(tempDir(), "ng.db");
    const old = openDatabase(path);
    // Recreate the v1 shape: the columns v2 added did not exist and the owner row said version 1.
    downgradeToV2(old);
    for (const [table, cols] of Object.entries(V2_COLUMNS)) for (const c of cols) old.exec(`ALTER TABLE ${table} DROP COLUMN ${c}`);
    run(old, "UPDATE schema_versions SET version = 1 WHERE owner = '@ng/context'");
    run(old, "INSERT INTO cells (id, root_id, spec, bounds, principal_id, created_at, updated_at) VALUES ('desk','desk','{}','{}','owner',1,1)");
    run(old, "INSERT INTO prompt_prefixes (cell_id, text, hash, epoch, created_at) VALUES ('desk', 'frozen', 'h', 0, 1)");
    for (const [table, cols] of Object.entries(V2_COLUMNS)) for (const c of cols) expect(columns(old, table)).not.toContain(c);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersions(db)["@ng/context"]).toBe(contextSchema.version);
    for (const [table, cols] of Object.entries(V2_COLUMNS)) expect(columns(db, table)).toEqual(expect.arrayContaining(cols));
    expect(all(db, "SELECT text, summary, summary_upto_seq, compactions FROM prompt_prefixes")).toEqual([
      { text: "frozen", summary: null, summary_upto_seq: 0, compactions: 0 },
    ]);
    expect(tables(db)).toEqual(expect.arrayContaining(V3_FTS));
    db.close();
  });

  it("v2 → v3 adds artifact_versions.cell_id, gives cell_state a rowid and backfills the search indexes", () => {
    const path = join(tempDir(), "ng.db");
    const old = openDatabase(path);
    downgradeToV2(old);
    expect(tables(old)).not.toEqual(expect.arrayContaining(["artifact_fts"]));
    // Rows written by v2 code, before any of the new indexes existed.
    cellsRepo(old).insert({ id: "desk" });
    cellsRepo(old).insert({ id: "w1", parentId: "desk" });
    const report = JSON.stringify({ format: "markdown", title: "周报", body: "GMV 口径见 metrics_v3 看板" });
    run(old, "INSERT INTO artifacts (artifact_id, cell_id, version, title, format, content, updated_by, created_at, updated_at) VALUES ('rep','w1',1,'周报','markdown',?,'agent',3,3)", [report]);
    run(old, "INSERT INTO artifact_versions (artifact_id, version, content, updated_by, created_at) VALUES ('rep',1,?,'agent',3)", [report]);
    run(old, "INSERT INTO cell_state (cell_id, key, value, updated_at) VALUES ('w1','notes:source',?,4), ('w1','cli:session',?,4), ('desk','gtd:project',?,4)", [
      JSON.stringify({ text: "埋点数据源 kafka-topic-clicks" }),
      JSON.stringify({ sessionId: "kafka-topic-clicks" }),
      JSON.stringify({ title: "季度复盘" }),
    ]);
    const big = `${"x".repeat(5000)} zq_middle_token ${"y".repeat(5000)}`;
    run(old, "INSERT INTO resources (uri, cell_id, content, size_chars, created_at) VALUES ('res://w1/r1','w1',?,?,5)", [big, big.length]);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersions(db)["@ng/context"]).toBe(contextSchema.version);
    expect(columns(db, "artifact_versions")).toContain("cell_id");
    expect(columns(db, "cell_state")[0]).toBe("seq");
    expect(all(db, "SELECT cell_id, key FROM cell_state ORDER BY seq")).toEqual([
      { cell_id: "desk", key: "gtd:project" },
      { cell_id: "w1", key: "cli:session" },
      { cell_id: "w1", key: "notes:source" },
    ]);
    for (const t of V3_FTS) expect(() => db.exec(`INSERT INTO ${t}(${t}) VALUES ('integrity-check')`)).not.toThrow();

    const store = storeOn(db);
    expect(store.listArtifactVersionsSync("rep").map((v) => [v.version, v.cellId])).toEqual([[1, null]]);
    const sub = (q: string) => store.searchHistorySync("desk", q, { scope: "subtree" }).map((s) => `${s.source}:${s.cellId}:${s.title ?? s.uri}`);
    expect(sub("metrics_v3")).toEqual(["artifact:w1:周报"]);
    expect(sub("kafka-topic-clicks")).toEqual(["state:w1:notes:source"]);
    expect(sub("zq_middle_token")).toEqual(["resource:w1:res://w1/r1"]);
    expect(sub("季度复盘")).toEqual(["state:desk:gtd:project"]);

    // Old rows keep working through the store, and new writes are indexed by the triggers.
    expect(store.readStateSync("w1", "notes:source")).toEqual({ text: "埋点数据源 kafka-topic-clicks" });
    store.commitSync("w1", { statePatches: { "notes:source": "moved to clickhouse_events" } });
    expect(sub("kafka-topic-clicks")).toEqual([]);
    expect(sub("clickhouse_events")).toEqual(["state:w1:notes:source"]);
    expect(store.commitSync("desk", { artifact: { artifactId: "rep", content: { format: "markdown", body: "v2 by desk" }, updatedBy: "agent", expectedVersion: 1 } })).toEqual({
      ok: true,
      artifactVersion: 2,
    });
    db.close();

    // Reopening is a no-op: nothing is indexed twice.
    const again = openDatabase(path);
    expect(storeOn(again).searchHistorySync("desk", "zq_middle_token", { scope: "global" })).toHaveLength(1);
    expect(all(again, "SELECT count(*) AS n FROM state_fts")).toEqual([{ n: 3 }]);
    again.close();
  });

  it("v3 → v4 adds knowledge.applies; preferences saved before it stay unlimited", () => {
    const path = join(tempDir(), "ng.db");
    const old = openDatabase(path);
    downgradeToV3(old);
    expect(columns(old, "knowledge")).not.toContain("applies");
    cellsRepo(old).insert({ id: "desk" });
    run(old, "INSERT INTO knowledge (id, kind, scope, cell_id, name, description, body, tags, created_at, updated_at) VALUES ('kn1','preference','global',NULL,'tone','语气','简洁','[]',1,1)");
    old.close();

    const db = openDatabase(path);
    expect(schemaVersions(db)["@ng/context"]).toBe(5);
    expect(columns(db, "knowledge")).toContain("applies");
    const store = storeOn(db);
    const tone = store.getKnowledgeSync({ kind: "preference", scope: "global", name: "tone" });
    expect(tone).toMatchObject({ body: "简洁" });
    expect(tone).not.toHaveProperty("applies");
    store.upsertSkillOrNoteSync("desk", { kind: "preference", scope: "global", name: "tone", description: "语气", body: "简洁", mode: "upsert", applies: { roles: ["worker"] } });
    expect(store.getKnowledgeSync({ kind: "preference", scope: "global", name: "tone" })?.applies).toEqual({ roles: ["worker"] });
    db.close();
  });
});
