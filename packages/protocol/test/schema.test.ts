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
  isNgError,
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

  it("enforces foreign keys to cells", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      run(db, "INSERT INTO cell_state (cell_id, key, value, updated_at) VALUES ('nope', 'k', '1', 1)"),
    ).toThrow(/FOREIGN KEY/);
  });

  it("runs migrations for older databases and refuses newer ones", () => {
    const db = openDatabase(":memory:");
    const v1: SchemaModule = { owner: "@test/x", version: 1, ddl: "CREATE TABLE IF NOT EXISTS x_items (id TEXT PRIMARY KEY);" };
    applySchemas(db, [v1]);
    const v2: SchemaModule = {
      owner: "@test/x",
      version: 2,
      ddl: "CREATE TABLE IF NOT EXISTS x_items (id TEXT PRIMARY KEY, note TEXT); CREATE INDEX IF NOT EXISTS idx_x_note ON x_items(note);",
      migrations: [{ version: 2, up: "ALTER TABLE x_items ADD COLUMN note TEXT;" }],
    };
    applySchemas(db, [v2]);
    expect(all<{ name: string }>(db, "PRAGMA table_info(x_items)").map((c) => c.name)).toEqual(["id", "note"]);
    expect(schemaVersions(db)["@test/x"]).toBe(2);

    let caught: unknown;
    try {
      applySchemas(db, [v1]);
    } catch (e) {
      caught = e;
    }
    expect(isNgError(caught, "schema")).toBe(true);
  });
});
