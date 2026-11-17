import { describe, expect, it } from "vitest";
import { isNgError, makeBounds, serializeBounds, type ProposedAction } from "@ng/protocol";
import { DEFAULT_TOKEN_TTL_MS } from "../src";
import { OWNER_UI, SECRET_VALUE, exec, expectType, meta, putArtifact, secretUse, send, setup, withWorker } from "./helpers";

const notify = (over: Record<string, unknown> = {}) => send(OWNER_UI, { sideEffect: "notify_owner", subjectKey: "note:1", ...over });

/** What the channel hub rebuilds from a send request (no presentational fields). */
function hubAction(target: string, content: unknown): ProposedAction {
  return { type: "channel.send", summary: "", subjectKey: "", sideEffect: "external", target, content } as ProposedAction;
}

describe("action tokens", () => {
  it("are single-use and bound to the operative action, not its presentation", () => {
    const f = setup();
    const action = notify();
    const { actionToken } = expectType(f.gate.authorizeSync(action, meta("desk")), "allow");
    const asHubSeesIt = hubAction(OWNER_UI, { format: "text", body: "报价单已附上" });
    expect(f.gate.verifyTokenSync(actionToken, asHubSeesIt)).toEqual({ ok: true, cellId: "desk", actionId: null });
    expect(f.gate.verifyTokenSync(actionToken, asHubSeesIt)).toEqual({ ok: false, reason: "used" });
  });

  it("a mismatching action is refused without consuming the token", () => {
    const f = setup();
    const { actionToken } = expectType(f.gate.authorizeSync(notify(), meta("desk")), "allow");
    expect(f.gate.verifyTokenSync(actionToken, hubAction(OWNER_UI, { format: "text", body: "换了内容" }))).toEqual({ ok: false, reason: "mismatch" });
    expect(f.gate.verifyTokenSync(actionToken, hubAction("channel:ui:someone", { format: "text", body: "报价单已附上" }))).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(f.gate.verifyTokenSync(actionToken, null as never)).toEqual({ ok: false, reason: "mismatch" });
    expect(f.gate.verifyTokenSync(actionToken, notify({ summary: "different title" })).ok).toBe(true);
  });

  it("expire, die with the epoch, die with revocation and with a paused Loop", () => {
    const f = setup();
    withWorker(f);
    const t1 = expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "allow").actionToken;
    f.clock.advance(DEFAULT_TOKEN_TTL_MS);
    expect(f.gate.verifyTokenSync(t1, exec("read"))).toEqual({ ok: false, reason: "expired" });

    const t2 = expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "allow").actionToken;
    f.cells.bumpEpoch("w1");
    expect(f.gate.verifyTokenSync(t2, exec("read"))).toEqual({ ok: false, reason: "stale_epoch" });

    const t3 = expectType(f.gate.authorizeSync(exec("read"), meta("w1", 1)), "allow").actionToken;
    f.cells.setStatus("w1", "paused");
    expect(f.gate.verifyTokenSync(t3, exec("read"))).toEqual({ ok: false, reason: "revoked" });
    f.cells.setStatus("w1", "active");
    expect(f.gate.verifyTokenSync(t3, exec("read")).ok).toBe(true);

    const t4 = expectType(f.gate.authorizeSync(exec("read"), meta("w1", 1)), "allow").actionToken;
    f.gate.revokeSync("desk");
    expect(f.gate.verifyTokenSync(t4, exec("read"))).toEqual({ ok: false, reason: "revoked" });

    expect(f.gate.verifyTokenSync("ngt_forged", exec("read"))).toEqual({ ok: false, reason: "unknown" });
    expect(f.gate.verifyTokenSync(42 as never, exec("read"))).toEqual({ ok: false, reason: "unknown" });
  });

  it("pruneTokensSync drops only long-dead tokens", () => {
    const f = setup();
    const used = expectType(f.gate.authorizeSync(exec("read"), meta("desk")), "allow").actionToken;
    f.gate.verifyTokenSync(used, exec("read"));
    expectType(f.gate.authorizeSync(exec("read"), meta("desk")), "allow"); // will expire
    f.clock.advance(DEFAULT_TOKEN_TTL_MS + 120_000);
    const fresh = expectType(f.gate.authorizeSync(exec("read"), meta("desk")), "allow").actionToken;
    expect(f.gate.pruneTokensSync(60_000)).toBe(2);
    expect(f.gate.verifyTokenSync(fresh, exec("read")).ok).toBe(true);
  });
});

describe("issueTokenSync — executing an approved action", () => {
  function approvedDraftSend(f: ReturnType<typeof setup>) {
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 1, body: "v1" });
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 2, body: "v2 the human approved" });
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { artifactId: "a1", content: undefined }), meta("desk")), "defer");
    expect(f.gate.approveSync(d.actionId, "owner", 2)).toBe("approved");
    return d.actionId;
  }
  const v2 = { format: "markdown", body: "v2 the human approved" };

  it("mints a token for the bound draft version's content and target only", () => {
    const f = setup();
    const actionId = approvedDraftSend(f);
    expect(() => f.gate.issueTokenSync(actionId, hubAction("channel:feishu:oc_1", { format: "markdown", body: "v1" }))).toThrow(/v2 as approved/);
    expect(() => f.gate.issueTokenSync(actionId, hubAction("channel:feishu:oc_2", v2))).toThrow(/approved address/);
    expect(() => f.gate.issueTokenSync(actionId, exec("read"))).toThrow(/approved channel.send/);
    const token = f.gate.issueTokenSync(actionId, hubAction("channel:feishu:oc_1", v2));
    expect(f.gate.verifyTokenSync(token, hubAction("channel:feishu:oc_1", v2))).toEqual({ ok: true, cellId: "desk", actionId });
  });

  it("non-draft actions must hash to exactly what was approved", () => {
    const f = setup();
    const project: ProposedAction = {
      type: "project.start",
      summary: "立项",
      subjectKey: "msg:9",
      sideEffect: "internal",
      proposal: { title: "竞品调研", outcome: "对比表", actions: [] },
    };
    const d = expectType(f.gate.authorizeSync(project, meta("desk")), "defer");
    f.gate.approveSync(d.actionId, "owner");
    expect(() => f.gate.issueTokenSync(d.actionId, { ...project, proposal: { ...project.proposal, title: "别的项目" } })).toThrow(/differs/);
    expect(f.gate.issueTokenSync(d.actionId, { ...project, summary: "presentational change is fine" })).toMatch(/^ngt_/);
  });

  it("refuses pending, executed, unknown and stale approvals; allows a retry after failed", () => {
    const f = setup();
    const pending = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "p" }), meta("desk")), "defer");
    expect(() => f.gate.issueTokenSync(pending.actionId, send("channel:feishu:oc_1"))).toThrow(/is pending/);
    expect(() => f.gate.issueTokenSync("act_missing", send("channel:feishu:oc_1"))).toThrow(/not found/);

    const actionId = approvedDraftSend(f);
    const final = hubAction("channel:feishu:oc_1", v2);
    f.gate.recordOutcomeSync(actionId, "failed", { error: "502" });
    expect(f.gate.issueTokenSync(actionId, final)).toMatch(/^ngt_/);
    f.gate.recordOutcomeSync(actionId, "unknown", { receipt: "unknown" });
    expect(() => f.gate.issueTokenSync(actionId, final)).toThrow(/is unknown/);
    f.gate.recordOutcomeSync(actionId, "executed", { receipt: "sent" });
    expect(() => f.gate.issueTokenSync(actionId, final)).toThrow(/is executed/);

    const g = setup();
    const id2 = approvedDraftSend(g);
    g.cells.bumpEpoch("desk");
    try {
      g.gate.issueTokenSync(id2, final);
      expect.unreachable();
    } catch (e) {
      expect(isNgError(e, "stale_epoch")).toBe(true);
    }
  });

  it("re-checks bounds at execution time", () => {
    const f = setup();
    const actionId = approvedDraftSend(f);
    f.cells.update("desk", { bounds: makeBounds({ ...serializeBounds(f.cells.require("desk").bounds), canSendTo: ["channel:ui:*"] }) });
    expect(() => f.gate.issueTokenSync(actionId, hubAction("channel:feishu:oc_1", v2))).toThrow(/no longer within bounds/);
  });

  it("approval-issued tokens survive a pause (the human decided), Loop tokens do not", () => {
    const f = setup();
    const actionId = approvedDraftSend(f);
    const token = f.gate.issueTokenSync(actionId, hubAction("channel:feishu:oc_1", v2));
    f.cells.setStatus("desk", "paused");
    expect(f.gate.verifyTokenSync(token, hubAction("channel:feishu:oc_1", v2)).ok).toBe(true);
  });
});

describe("secret proxy", () => {
  it("injectSecret redeems a secret.use token host-side, once", () => {
    const f = setup();
    withWorker(f);
    const { actionToken, proxyInjectedSecretRef } = expectType(f.gate.authorizeSync(secretUse("github"), meta("w1")), "allow");
    expect(proxyInjectedSecretRef).toBe("github");
    expect(() => f.gate.injectSecretSync(actionToken, "feishu")).toThrow(/issued for secret "github"/);
    expect(f.gate.injectSecretSync(actionToken, "github")).toBe(SECRET_VALUE);
    expect(() => f.gate.injectSecretSync(actionToken)).toThrow(/token used/);
  });

  it("refuses non-secret tokens, refs that left the bounds and refs with no value", () => {
    const f = setup();
    withWorker(f);
    const readToken = expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "allow").actionToken;
    expect(() => f.gate.injectSecretSync(readToken)).toThrow(/not issued for secret.use/);
    expect(() => f.gate.injectSecretSync("ngt_nope")).toThrow(/token unknown/);

    const t = expectType(f.gate.authorizeSync(secretUse("github"), meta("w1")), "allow").actionToken;
    f.cells.update("w1", { bounds: makeBounds({ ...serializeBounds(f.cells.require("w1").bounds), secretRefs: [] }) });
    expect(() => f.gate.injectSecretSync(t)).toThrow(/no longer within bounds/);

    // a store that claims the ref exists at authorize time but has lost the value by injection time
    const h = setup({ secrets: { has: () => true, get: () => undefined } });
    const t2 = expectType(h.gate.authorizeSync(secretUse("github"), meta("desk")), "allow").actionToken;
    expect(() => h.gate.injectSecretSync(t2)).toThrow(/not configured/);
  });

  it("a cancelled task can no longer redeem its secret token", () => {
    const f = setup();
    withWorker(f);
    const t = expectType(f.gate.authorizeSync(secretUse("github"), meta("w1")), "allow").actionToken;
    f.cells.bumpEpoch("w1");
    try {
      f.gate.injectSecretSync(t);
      expect.unreachable();
    } catch (e) {
      expect(isNgError(e, "stale_epoch")).toBe(true);
      expect(String(e)).not.toContain(SECRET_VALUE);
    }
  });
});
