import { describe, expect, it } from "vitest";
import {
  ALL_SCHEMAS,
  ManualClock,
  all,
  applySchemas,
  cellsRepo,
  createBus,
  gateSchema,
  makeBounds,
  openDatabase,
  run,
  schemaVersions,
  type Db,
} from "@ng/protocol";
import { createGate, memorySecretStore } from "../src";
import { expectType, meta, putArtifact, secretUse, send } from "./helpers";

// The gate tables that later migrations alter, as schema v1 shipped them (before proposed_version / secret_ref /
// revocation columns in v2 and before raw_tokens / cached_tokens in v3).
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
CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cell_id TEXT NOT NULL REFERENCES cells(id), tokens INTEGER NOT NULL,
  cents REAL NOT NULL, at INTEGER NOT NULL
);
`;

/** A database whose gate tables are at `version` (v2 = v1 plus the v2 migration as shipped), with one desk cell. */
function oldDatabase(version: 1 | 2): { db: Db; clock: ManualClock } {
  const db = openDatabase(":memory:", { schemas: ALL_SCHEMAS.filter((s) => s.owner !== "@ng/gate") });
  const clock = new ManualClock(10);
  cellsRepo(db, clock).insert({
    id: "desk",
    bounds: makeBounds({ canSendTo: ["channel:feishu:*"], secretRefs: ["github"], maxTokens: 1000, maxCents: 100, maxDepth: 1 }),
  });
  db.exec(V1_CHANGED_TABLES);
  if (version === 2) db.exec(gateSchema.migrations!.find((m) => m.version === 2)!.up);
  run(db, "INSERT INTO schema_versions (owner, version, applied_at) VALUES ('@ng/gate', ?, 0)", [version]);
  return { db, clock };
}

const cols = (db: Db, t: string) => all<{ name: string }>(db, `PRAGMA table_info(${t})`).map((c) => c.name);

describe("gate schema migrations", () => {
  it("v1 → current adds the new columns to an existing database without losing rows, and the Gate works on it", () => {
    const { db, clock } = oldDatabase(1);
    run(
      db,
      `INSERT INTO approvals (action_id, cell_id, epoch, principal_id, subject_key, action_type, action, action_hash, card, created_at, updated_at)
       VALUES ('act_old', 'desk', 0, 'cell:desk', 'msg:old', 'custom', '{"type":"custom"}', 'h', '{"format":"card","body":""}', 1, 1)`,
    );
    run(db, "INSERT INTO ledger (cell_id, own_tokens, subtree_tokens, updated_at) VALUES ('desk', 5, 5, 1)");

    applySchemas(db, ALL_SCHEMAS);
    expect(schemaVersions(db)["@ng/gate"]).toBe(gateSchema.version);
    expect(cols(db, "approvals")).toContain("proposed_version");
    expect(cols(db, "action_tokens")).toContain("secret_ref");
    expect(cols(db, "ledger")).toEqual(expect.arrayContaining(["revoked_at", "revoke_reason"]));
    expect(cols(db, "usage_log")).toEqual(expect.arrayContaining(["raw_tokens", "cached_tokens"]));

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

  it("v2 → v3 adds raw_tokens / cached_tokens to usage_log; old rows keep their numbers and metering records the new ones", () => {
    const { db, clock } = oldDatabase(2);
    expect(cols(db, "ledger")).toContain("revoked_at");
    run(db, "INSERT INTO usage_log (cell_id, tokens, cents, at) VALUES ('desk', 300, 2.5, 1)");
    run(db, "INSERT INTO ledger (cell_id, own_tokens, own_cents, subtree_tokens, subtree_cents, updated_at) VALUES ('desk', 300, 2.5, 300, 2.5, 1)");

    applySchemas(db, ALL_SCHEMAS);
    expect(schemaVersions(db)["@ng/gate"]).toBe(3);
    expect(cols(db, "usage_log")).toEqual(["id", "cell_id", "tokens", "cents", "at", "raw_tokens", "cached_tokens"]);
    // a pre-v3 row: raw_tokens unknown (NULL = same as tokens), no cache reads
    expect(all(db, "SELECT cell_id, tokens, cents, raw_tokens, cached_tokens FROM usage_log")).toEqual([
      { cell_id: "desk", tokens: 300, cents: 2.5, raw_tokens: null, cached_tokens: 0 },
    ]);

    const gate = createGate({ db, bus: createBus(), clock, secrets: memorySecretStore({}) });
    expect(gate.usageSync("desk")).toMatchObject({ ownTokens: 300, subtreeCents: 2.5, state: "ok" });
    // 200 raw tokens, 100 of them cache reads at the default weight 0.1 → 110 charged
    expect(gate.meter("desk", { tokens: 200, cachedTokens: 100, billedCents: 1 })).toBe("ok");
    expect(gate.usageSync("desk")).toMatchObject({ ownTokens: 410, subtreeTokens: 410, ownCents: 3.5 });
    expect(all(db, "SELECT tokens, raw_tokens, cached_tokens FROM usage_log ORDER BY id")).toEqual([
      { tokens: 300, raw_tokens: null, cached_tokens: 0 },
      { tokens: 110, raw_tokens: 200, cached_tokens: 100 },
    ]);
    // limits act on old and new charges alike: 410 + 600 ≥ 1000
    expect(gate.meter("desk", { tokens: 600, billedCents: 0 })).toBe("hard_stop");
  });
});
