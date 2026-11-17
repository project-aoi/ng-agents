import { describe, expect, it } from "vitest";
import { run, type Db } from "../src";
import { memDb, seedCells } from "./helpers";

function insertApproval(db: Db, actionId: string, subjectKey: string, status = "pending") {
  run(
    db,
    `INSERT INTO approvals (action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card, status, created_at, updated_at)
     VALUES (?, 'desk', 0, 'cell:desk', ?, 'channel.send', '{}', 'h', '{}', ?, 1, 1)`,
    [actionId, subjectKey, status],
  );
}

describe("approvals: at most one pending card per subjectKey", () => {
  it("rejects a second pending row for the same subject", () => {
    const db = memDb();
    seedCells(db);
    insertApproval(db, "a1", "project:p1");
    expect(() => insertApproval(db, "a2", "project:p1")).toThrow(/UNIQUE/);
  });

  it("allows any number of resolved rows and a new pending one after resolution", () => {
    const db = memDb();
    seedCells(db);
    insertApproval(db, "a1", "project:p1");
    insertApproval(db, "a0", "project:p1", "executed");
    insertApproval(db, "a00", "project:p1", "cancelled");
    run(db, "UPDATE approvals SET status = 'superseded' WHERE action_id = 'a1'");
    expect(() => insertApproval(db, "a2", "project:p1")).not.toThrow();
    expect(() => insertApproval(db, "b1", "project:p2")).not.toThrow();
  });
});
