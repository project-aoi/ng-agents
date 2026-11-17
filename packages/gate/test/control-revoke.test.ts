import { describe, expect, it } from "vitest";
import { all, makeBounds } from "@ng/protocol";
import { deliveryAllowed } from "../src";
import { OWNER_UI, exec, expectType, meta, send, setup, withWorker } from "./helpers";

function tree() {
  const f = setup();
  withWorker(f, "proj", { maxDepth: 2, canSendTo: ["channel:feishu:*"] });
  f.cells.insert({ id: "leaf", parentId: "proj", bounds: f.gate.attenuate(f.cells.require("proj").bounds, "proj", { canSendTo: ["channel:feishu:*"] }) });
  withWorker(f, "sib");
  return f;
}

describe("authorizeControlSync (the Inbox control bypass)", () => {
  it("owner may control any cell; a cell only its strict descendants", () => {
    const f = tree();
    for (const id of ["desk", "proj", "leaf", "sib"]) expect(f.gate.authorizeControlSync(id, "owner", "cancel")).toEqual({ ok: true });
    expect(f.gate.authorizeControlSync("leaf", "cell:desk", "steer")).toEqual({ ok: true });
    expect(f.gate.authorizeControlSync("leaf", "cell:proj", "pause")).toEqual({ ok: true });
    for (const [target, actor] of [
      ["proj", "cell:proj"], // self
      ["desk", "cell:proj"], // ancestor
      ["sib", "cell:proj"], // sibling
      ["leaf", "cell:sib"], // cousin
    ] as const) {
      expect(f.gate.authorizeControlSync(target, actor, "cancel").ok, `${actor} → ${target}`).toBe(false);
    }
  });

  it("refuses external principals, unknown cells/actions and inactive or revoked actors", () => {
    const f = tree();
    expect(f.gate.authorizeControlSync("leaf", "feishu:ou_colleague", "cancel")).toMatchObject({ ok: false, reason: /only the owner/ });
    expect(f.gate.authorizeControlSync("leaf", "", "cancel").ok).toBe(false);
    expect(f.gate.authorizeControlSync("ghost", "owner", "cancel")).toMatchObject({ ok: false, reason: /unknown cell/ });
    expect(f.gate.authorizeControlSync("leaf", "cell:ghost", "cancel")).toMatchObject({ ok: false, reason: /unknown cell/ });
    expect(f.gate.authorizeControlSync("leaf", "owner", "delete" as never)).toMatchObject({ ok: false, reason: /unknown control action/ });
    f.cells.setStatus("proj", "paused");
    expect(f.gate.authorizeControlSync("leaf", "cell:proj", "resume").ok).toBe(false);
    f.cells.setStatus("proj", "active");
    f.gate.revokeSync("proj");
    expect(f.gate.authorizeControlSync("leaf", "cell:proj", "cancel")).toMatchObject({ ok: false, reason: /revoked/ });
    // the owner can still stop a revoked subtree
    expect(f.gate.authorizeControlSync("leaf", "owner", "cancel")).toEqual({ ok: true });
  });
});

describe("revoke", () => {
  it("cancels pending cards and unused tokens for the cell and its whole subtree, then denies", () => {
    const f = tree();
    const cardLeaf = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "a" }), meta("leaf")), "defer");
    const cardDesk = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "b" }), meta("desk")), "defer");
    const tokenProj = expectType(f.gate.authorizeSync(exec("read"), meta("proj")), "allow").actionToken;
    const tokenSib = expectType(f.gate.authorizeSync(exec("read"), meta("sib")), "allow").actionToken;

    f.gate.revokeSync("proj");
    expect(f.gate.getApprovalSync(cardLeaf.actionId)).toMatchObject({ status: "cancelled", statusReason: "authority revoked" });
    expect(f.gate.getApprovalSync(cardDesk.actionId)!.status).toBe("pending");
    expect(f.gate.verifyTokenSync(tokenProj, exec("read"))).toEqual({ ok: false, reason: "revoked" });
    expect(f.gate.verifyTokenSync(tokenSib, exec("read")).ok).toBe(true);
    expect(expectType(f.gate.authorizeSync(exec("read"), meta("leaf")), "deny").feedback).toMatch(/revoked/);
    expect(expectType(f.gate.authorizeSync(exec("read"), meta("proj")), "deny").feedback).toMatch(/revoked/);
    expectType(f.gate.authorizeSync(exec("read"), meta("sib")), "allow");
    expect(f.events).toContainEqual({
      topic: "approval.changed",
      data: { actionId: cardLeaf.actionId, cellId: "leaf", subjectKey: "a", status: "cancelled" },
    });
    expect(all(f.db, "SELECT cell_id FROM ledger WHERE revoked_at IS NOT NULL ORDER BY cell_id")).toEqual([{ cell_id: "leaf" }, { cell_id: "proj" }]);
  });

  it("is idempotent, a no-op for unknown cells, and the async form delegates", async () => {
    const f = tree();
    f.gate.revokeSync("proj");
    f.gate.revokeSync("proj");
    f.gate.revokeSync("ghost");
    await f.gate.revoke("sib");
    expectType(f.gate.authorizeSync(exec("read"), meta("sib")), "deny");
    expectType(f.gate.authorizeSync(send(OWNER_UI, { sideEffect: "notify_owner" }), meta("desk")), "allow");
  });
});

describe("deliveryAllowed (kernel helper for inboxOut / emitToParent)", () => {
  it("covers canSendTo patterns and always the parent's own inbox", () => {
    const f = tree();
    const leaf = f.cells.require("leaf");
    expect(deliveryAllowed(leaf.bounds, "proj", "inbox:proj")).toBe(true);
    expect(deliveryAllowed(leaf.bounds, "proj", "channel:feishu:oc_7")).toBe(true);
    expect(deliveryAllowed(leaf.bounds, "proj", "inbox:desk")).toBe(false);
    expect(deliveryAllowed(leaf.bounds, "proj", "channel:ui:owner")).toBe(false);
    expect(deliveryAllowed(leaf.bounds, "proj", "inbox:*")).toBe(false);
    const bare = makeBounds({ canSendTo: ["channel:feishu:*"] });
    expect(deliveryAllowed(bare, "proj", "inbox:proj")).toBe(true);
    expect(deliveryAllowed(bare, null, "inbox:proj")).toBe(false);
  });
});
