import { describe, expect, it } from "vitest";
import { all, run } from "../src";
import { memDb, seedCells } from "./helpers";

function addEvidence(db: ReturnType<typeof memDb>, text: string, cellId = "desk"): number {
  return run(db, "INSERT INTO evidence (cell_id, run_id, kind, content, text, at) VALUES (?, NULL, 'external', '{}', ?, 1)", [
    cellId,
    text,
  ]).lastInsertRowid;
}

describe("evidence FTS5 (trigram)", () => {
  it("finds a Chinese substring with MATCH (>= 3 chars)", () => {
    const db = memDb();
    seedCells(db);
    const hit = addEvidence(db, "供应商 C 的报价单明天到期，A 和 B 已经回复");
    addEvidence(db, "PR #108 CI 测试第 1 轮失败");
    const rows = all<{ rowid: number }>(db, "SELECT rowid FROM evidence_fts WHERE evidence_fts MATCH ? ORDER BY rank", ['"报价单"']);
    expect(rows.map((r) => r.rowid)).toEqual([hit]);
  });

  it("finds a 2-character Chinese word with LIKE on the FTS table", () => {
    const db = memDb();
    seedCells(db);
    const hit = addEvidence(db, "催一下报价");
    addEvidence(db, "周五下午三点约牙医");
    const rows = all<{ rowid: number }>(db, "SELECT rowid FROM evidence_fts WHERE text LIKE ?", ["%报价%"]);
    expect(rows.map((r) => r.rowid)).toEqual([hit]);
  });

  it("keeps the index in sync on delete and forbids updates", () => {
    const db = memDb();
    seedCells(db);
    const seq = addEvidence(db, "支付报错反馈汇总");
    expect(() => run(db, "UPDATE evidence SET text = 'x' WHERE seq = ?", [seq])).toThrow(/append-only/);
    run(db, "DELETE FROM evidence WHERE seq = ?", [seq]);
    expect(all(db, "SELECT rowid FROM evidence_fts WHERE evidence_fts MATCH ?", ['"支付报错"'])).toEqual([]);
  });

  it("indexes knowledge bodies for Chinese search", () => {
    const db = memDb();
    seedCells(db);
    run(
      db,
      "INSERT INTO knowledge (id, kind, scope, name, description, body, created_at, updated_at) VALUES ('k1','skill','global','weekly-review','周回顾','对比本周改稿习惯并提炼规则',1,1)",
    );
    const rows = all<{ name: string }>(db, "SELECT name FROM knowledge_fts WHERE knowledge_fts MATCH ?", ['"改稿习惯"']);
    expect(rows.map((r) => r.name)).toEqual(["weekly-review"]);
  });
});
