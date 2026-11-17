import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { all, contextSchema, openDatabase, run, schemaVersions } from "@ng/protocol";
import { tempDir } from "./helpers";

const V2_COLUMNS: Record<string, string[]> = {
  artifact_parked: ["note"],
  prompt_prefixes: ["inherited", "fork_note", "summary", "summary_upto_seq", "compactions"],
};

const columns = (db: ReturnType<typeof openDatabase>, table: string) => all<{ name: string }>(db, `PRAGMA table_info(${table})`).map((c) => c.name);

describe("context schema v2", () => {
  it("migrates a v1 database in place", () => {
    const path = join(tempDir(), "ng.db");
    const old = openDatabase(path);
    // Recreate the v1 shape: the columns v2 added did not exist and the owner row said version 1.
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
    db.close();
  });
});
