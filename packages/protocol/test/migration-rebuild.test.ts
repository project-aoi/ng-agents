import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { all, cellsRepo, makeBounds, openDatabase, run, schemaVersions } from "../src";

// docs/05: the v1 `cells` table pinned `preset` with a CHECK. Opening an old database must lift it without losing rows
// or breaking the foreign keys every other table holds on cells(id).
const V1_CELLS = `
CREATE TABLE cells (
  id TEXT PRIMARY KEY, parent_id TEXT REFERENCES cells(id), root_id TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0,
  preset TEXT CHECK (preset IS NULL OR preset IN ('inline','worker','watcher','sensor')),
  title TEXT, spec TEXT NOT NULL, bounds TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('completed','cancelled')),
  principal_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_run_at INTEGER, closed_at INTEGER
);
CREATE TABLE cell_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cell_id TEXT NOT NULL REFERENCES cells(id), thread TEXT, filter TEXT NOT NULL DEFAULT '{}',
  cancel_group TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE schema_versions (owner TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL);
INSERT INTO schema_versions VALUES ('@ng/cell', 1, 0);
INSERT INTO cells (id, parent_id, root_id, depth, preset, title, spec, bounds, principal_id, created_at, updated_at)
  VALUES ('desk', NULL, 'desk', 0, 'inline', '主台', '{"processor":{"kind":"llm"}}', '{"tools":[],"canSendTo":[],"isolation":"none","maxConcurrentChildren":1,"maxDepth":1}', 'owner', 1, 1),
         ('w1', 'desk', 'desk', 1, 'worker', 'w', '{"processor":{"kind":"llm"}}', '{"tools":[],"canSendTo":[],"isolation":"none","maxConcurrentChildren":1,"maxDepth":1}', 'owner', 2, 2);
INSERT INTO cell_watches (cell_id, thread, created_at) VALUES ('w1', 'github:o/r#1', 3);
`;

describe("cells v1 → v2 (preset CHECK lifted by a table rebuild)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps every row and foreign key, and accepts the new presets", () => {
    dir = mkdtempSync(join(tmpdir(), "ng-mig-"));
    const path = join(dir, "ng.db");
    const old = new DatabaseSync(path);
    old.exec(V1_CELLS);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersions(db)["@ng/cell"]).toBe(6);
    expect(all<{ id: string }>(db, "SELECT id FROM cells ORDER BY id").map((r) => r.id)).toEqual(["desk", "w1"]);
    expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
    expect(all<{ foreign_keys: number }>(db, "PRAGMA foreign_keys")[0]!.foreign_keys).toBe(1);

    const cells = cellsRepo(db);
    const bounds = makeBounds({ tools: [], canSendTo: [], isolation: "none", maxConcurrentChildren: 1, maxDepth: 0 });
    const p = cells.insert({ id: "p1", parentId: "desk", preset: "project", title: "p", spec: { preset: "project", processor: { kind: "llm" } }, bounds, principalId: "owner" });
    expect(p.preset).toBe("project");
    // Foreign keys are enforced again: other tables still point at the rebuilt cells(id), and so does parent_id.
    expect(() => run(db, "INSERT INTO cell_watches (cell_id, created_at) VALUES ('nope', 1)")).toThrow(/FOREIGN KEY/);
    expect(() => cells.insert({ id: "x", parentId: "ghost", preset: "hub", title: null, spec: { processor: { kind: "llm" } }, bounds, principalId: "owner" })).toThrow();
    db.close();

    // Reopening is a no-op.
    const again = openDatabase(path);
    expect(all<{ n: number }>(again, "SELECT count(*) AS n FROM cells")[0]!.n).toBe(3);
    again.close();
  });
});
