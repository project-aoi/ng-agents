import { afterEach, describe, expect, it } from "vitest";
import { all, createBus, isNgError, openDatabase, cellsRepo, makeBounds, ManualClock } from "@ng/protocol";
import { createGate, envSecretStore, redactSecrets, secretEnvName } from "../src";
import { SECRET_VALUE, exec, expectType, meta, secretUse, send, setup, withWorker } from "./helpers";

const GATE_TABLES = ["approvals", "action_tokens", "ledger", "usage_log", "budget_raises", "policy_rules", "approval_stats"];

function dumpGateTables(f: ReturnType<typeof setup>): string {
  return JSON.stringify(GATE_TABLES.map((t) => all(f.db, `SELECT * FROM ${t}`)));
}

describe("SecretStore", () => {
  it("maps refs to NG_SECRET_<REF> and reads the environment at call time", () => {
    expect(secretEnvName("github")).toBe("NG_SECRET_GITHUB");
    expect(secretEnvName("feishu.app-secret")).toBe("NG_SECRET_FEISHU_APP_SECRET");
    const env: Record<string, string | undefined> = { NG_SECRET_GITHUB: "x", NG_SECRET_EMPTY: "" };
    const store = envSecretStore({ env });
    expect([store.has("github"), store.get("github")]).toEqual([true, "x"]);
    expect(store.has("empty")).toBe(false);
    expect(store.has("")).toBe(false);
    env["NG_SECRET_LATE"] = "y";
    expect(store.get("late")).toBe("y");
    expect(store.refs!().sort()).toEqual(["GITHUB", "LATE"]);
  });

  it("redactSecrets scrubs nested strings and ignores implausibly short values", () => {
    const m = new Map([
      ["sekret-123", "a"],
      ["abc", "b"],
    ]);
    expect(redactSecrets({ e: ["auth sekret-123 failed"], n: 1, s: "abc" }, m)).toEqual({ e: ["auth [redacted:a] failed"], n: 1, s: "abc" });
  });
});

describe("the default store is environment-backed", () => {
  const KEY = "NG_SECRET_GATE_TEST_REF";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("createGate without `secrets` resolves NG_SECRET_<REF> from process.env", () => {
    process.env[KEY] = "env-secret-value-42";
    const db = openDatabase(":memory:");
    const clock = new ManualClock(1);
    cellsRepo(db, clock).insert({ id: "desk", bounds: makeBounds({ secretRefs: ["gate_test_ref"], maxTokens: 10, maxCents: 10 }) });
    const gate = createGate({ db, bus: createBus(), clock });
    const t = expectType(gate.authorizeSync(secretUse("gate_test_ref"), meta("desk")), "allow").actionToken;
    expect(gate.injectSecretSync(t)).toBe("env-secret-value-42");
  });
});

describe("secret values never leave the host side", () => {
  it("not in authorize results, approval rows, token rows, bus events, or error messages", () => {
    const f = setup();
    withWorker(f);
    const results: unknown[] = [];
    const errors: string[] = [];
    const attempt = (fn: () => unknown) => {
      try {
        results.push(fn());
      } catch (e) {
        errors.push(String(e), JSON.stringify(e), isNgError(e) ? JSON.stringify(e.details ?? null) : "");
      }
    };

    const token = expectType(f.gate.authorizeSync(secretUse("github", { purpose: "comment on PR" }), meta("w1")), "allow");
    results.push(token);
    results.push(f.gate.authorizeSync(secretUse("feishu"), meta("w1")));
    results.push(f.gate.authorizeSync(secretUse("feishu"), meta("desk")));

    // host side: the value exists only here
    expect(f.gate.injectSecretSync(token.actionToken, "github")).toBe(SECRET_VALUE);
    attempt(() => f.gate.injectSecretSync(token.actionToken));
    attempt(() => f.gate.injectSecretSync("ngt_bogus"));
    attempt(() => f.gate.injectSecretSync(expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "allow").actionToken));

    // an adapter echoing the credential in its error, a reason pasted by someone, a draft that somehow contains it
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1"), meta("desk")), "defer");
    f.gate.approveSync(d.actionId, "owner");
    f.gate.recordOutcomeSync(d.actionId, "failed", { error: `401 for Authorization: token ${SECRET_VALUE}`, result: { echo: [SECRET_VALUE] } });
    const e = expectType(f.gate.authorizeSync(send("channel:feishu:oc_2", { subjectKey: "x" }), meta("desk")), "defer");
    f.gate.denySync(e.actionId, "owner", `do not paste ${SECRET_VALUE}`);
    const leak = f.gate.authorizeSync(send("channel:feishu:oc_3", { subjectKey: "y", content: { format: "text", body: `key=${SECRET_VALUE}` } }), meta("desk"));
    results.push(leak);
    f.gate.withdrawSync(expectType(leak, "defer").actionId, `withdrawn ${SECRET_VALUE}`);
    attempt(() => f.gate.issueTokenSync(d.actionId, send("channel:feishu:oc_9")));

    const everything = [JSON.stringify(results), errors.join("\n"), JSON.stringify(f.events), dumpGateTables(f), JSON.stringify(f.gate.listApprovalsSync())];
    for (const blob of everything) expect(blob).not.toContain(SECRET_VALUE);
    expect(f.gate.getApprovalSync(d.actionId)!.outcome!.error).toBe("401 for Authorization: token [redacted:github]");
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it("values handed out by injectSecret are scrubbed even when the store cannot enumerate", () => {
    const value = "vault-only-credential-xyz";
    const f = setup({ secrets: { has: (r) => r === "github", get: (r) => (r === "github" ? value : undefined) } });
    const t = expectType(f.gate.authorizeSync(secretUse("github"), meta("desk")), "allow").actionToken;
    f.gate.injectSecretSync(t);
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1"), meta("desk")), "defer");
    f.gate.approveSync(d.actionId, "owner");
    f.gate.recordOutcomeSync(d.actionId, "unknown", { error: `timeout using ${value}` });
    expect(dumpGateTables(f)).not.toContain(value);
  });
});
