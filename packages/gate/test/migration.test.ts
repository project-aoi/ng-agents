import { describe, expect, it } from "vitest";
import { ALL_SCHEMAS, ManualClock, all, applySchemas, cellsRepo, createBus, gateSchema, makeBounds, openDatabase, run, schemaVersions } from "@ng/protocol";
import { createGate, memorySecretStore } from "../src";
import { expectType, meta, putArtifact, secretUse, send } from "./helpers";

// The three gate tables as schema v1 shipped them (before proposed_version / secret_ref / revocation columns).
const V1_CHANGED_TABLES = /* sql */ `
CREATE TABLE approvals (
  action_id TEXT PRIMARY KEY, cell_id TEXT NOT NULL REFERENCES cells(id), epoch INTEGER NOT NULL, principal_id TEXT NOT NULL,
  subject_key TEXT NOT NULL, action_type TEXT NOT NULL, action TEXT NOT NULL, action_hash TEXT NOT NULL, card TEXT NOT NULL,
  artifact_id TEXT, bound_version INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled','superseded','executed','failed','unknown')),
  status_reason TEXT, snoozed_until INTEGER, approver_id TEXT, human_edited INTEGER NOT NULL DEFAULT 0, outcome TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER
);
CREATE TABLE ledger (
  cell_id TEXT PRIMARY KEY REFERENCES cells(id), own_tokens INTEGER NOT NULL DEFAULT 0, own_cents REAL NOT NULL DEFAULT 0,
  subtree_tokens INTEGER NOT NULL DEFAULT 0, subtree_cents REAL NOT NULL DEFAULT 0, raised_tokens INTEGER NOT NULL DEFAULT 0,
  raised_cents REAL NOT NULL DEFAULT 0, warned_at INTEGER, stopped_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE action_tokens (
  token_hash TEXT PRIMARY KEY, action_hash TEXT NOT NULL, action_id TEXT, cell_id TEXT NOT NULL REFERENCES cells(id),
  epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL
);
`;

describe("gate schema v1 → v2 migration", () => {
  it("adds the new columns to an existing database without losing rows, and the Gate works on it", () => {
    const db = openDatabase(":memory:", { schemas: ALL_SCHEMAS.filter((s) => s.owner !== "@ng/gate") });
    const clock = new ManualClock(10);
    cellsRepo(db, clock).insert({
      id: "desk",
      bounds: makeBounds({ canSendTo: ["channel:feishu:*"], secretRefs: ["github"], maxTokens: 1000, maxCents: 100, maxDepth: 1 }),
    });
    db.exec(V1_CHANGED_TABLES);
    run(db, "INSERT INTO schema_versions (owner, version, applied_at) VALUES ('@ng/gate', 1, 0)");
    run(
      db,
      `INSERT INTO approvals (action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card, created_at, updated_at)
       VALUES ('act_old', 'desk', 0, 'cell:desk', 'msg:old', 'custom', '{"type":"custom"}', 'h', '{"format":"card","body":""}', 1, 1)`,
    );
    run(db, "INSERT INTO ledger (cell_id, own_tokens, subtree_tokens, updated_at) VALUES ('desk', 5, 5, 1)");

    applySchemas(db, ALL_SCHEMAS);
    expect(schemaVersions(db)["@ng/gate"]).toBe(gateSchema.version);
    const cols = (t: string) => all<{ name: string }>(db, `PRAGMA table_info(${t})`).map((c) => c.name);
    expect(cols("approvals")).toContain("proposed_version");
    expect(cols("action_tokens")).toContain("secret_ref");
    expect(cols("ledger")).toEqual(expect.arrayContaining(["revoked_at", "revoke_reason"]));

    const gate = createGate({ db, bus: createBus(), clock, secrets: memorySecretStore({ github: "secret-value-123" }) });
    expect(gate.getApprovalSync("act_old")).toMatchObject({ status: "pending", subjectKey: "msg:old" });
    expect(gate.usageSync("desk").ownTokens).toBe(5);
    putArtifact(db, { artifactId: "a1", cellId: "desk", version: 1, body: "v1" });
    const d = expectType(gate.authorizeSync(send("channel:feishu:oc_1", { artifactId: "a1" }), meta("desk")), "defer");
    expect(gate.approveSync(d.actionId, "owner", 1)).toBe("approved");
    const t = expectType(gate.authorizeSync(secretUse("github"), meta("desk")), "allow").actionToken;
    expect(gate.injectSecretSync(t)).toBe("secret-value-123");
    gate.revokeSync("desk");
    expect(gate.getApprovalSync("act_old")!.status).toBe("cancelled");
  });
});
