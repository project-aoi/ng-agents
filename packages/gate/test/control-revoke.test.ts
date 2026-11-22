import { describe, expect, it } from "vitest";
import { makeBounds } from "@ng/protocol";
import { deliveryAllowed } from "../src";
import { exec, expectType, meta, setup, withWorker } from "./helpers";

function tree() {
  const f = setup();
  withWorker(f, "proj", { maxDepth: 2, canSendTo: ["channel:ui:*"] });
  f.cells.insert({ id: "leaf", parentId: "proj", bounds: f.gate.attenuate(f.cells.require("proj").bounds, "proj", { canSendTo: ["channel:ui:*"] }) });
  withWorker(f, "sib");
  return f;
}

describe("authorizeControlSync (the Inbox control bypass)", () => {
  it("owner may control any non-root cell (and steer/resume root, never pause/cancel root); a cell only its strict descendants", () => {
    const f = tree();
    for (const id of ["proj", "leaf", "sib"]) expect(f.gate.authorizeControlSync(id, "owner", "cancel")).toEqual({ ok: true });
    expect(f.gate.authorizeControlSync("desk", "owner", "cancel")).toMatchObject({ ok: false, reason: /root cell/ });
    expect(f.gate.authorizeControlSync("desk", "owner", "pause")).toMatchObject({ ok: false, reason: /root cell/ });
    expect(f.gate.authorizeControlSync("desk", "owner", "resume")).toEqual({ ok: true });
    expect(f.gate.authorizeControlSync("desk", "owner", "steer")).toEqual({ ok: true });
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

  it("an agent on the control plane may control any non-root cell, and only steer/resume root (BUG-020)", () => {
    const f = tree();
    for (const id of ["proj", "leaf", "sib"]) {
      for (const action of ["pause", "resume", "steer", "cancel"] as const) {
        expect(f.gate.authorizeControlSync(id, "agent:ops", action), `${action} ${id}`).toEqual({ ok: true });
      }
    }
    expect(f.gate.authorizeControlSync("desk", "agent:ops", "pause")).toMatchObject({ ok: false, reason: /root cell/ });
    expect(f.gate.authorizeControlSync("desk", "agent:ops", "cancel")).toMatchObject({ ok: false, reason: /root cell/ });
    expect(f.gate.authorizeControlSync("desk", "agent:ops", "resume")).toEqual({ ok: true });
    expect(f.gate.authorizeControlSync("desk", "agent:ops", "steer")).toEqual({ ok: true });
    f.gate.revokeSync("proj");
    expect(f.gate.authorizeControlSync("leaf", "agent:ops", "cancel")).toEqual({ ok: true });
    expect(f.gate.authorizeControlSync("ghost", "agent:ops", "pause")).toMatchObject({ ok: false, reason: /unknown cell "ghost"/ });
    expect(f.gate.authorizeControlSync("leaf", "agent:ops", "delete" as never)).toMatchObject({ ok: false, reason: /unknown control action/ });
    // not well-formed agent principals
    for (const p of ["agent:", "agent:a:b"]) {
      expect(f.gate.authorizeControlSync("leaf", p, "cancel"), p).toMatchObject({ ok: false, reason: /only the owner, an agent on the control plane, or an ancestor cell/ });
    }
  });

  it("refuses external principals, unknown cells/actions and inactive or revoked actors", () => {
    const f = tree();
    expect(f.gate.authorizeControlSync("leaf", "memory:ou_colleague", "cancel")).toMatchObject({ ok: false, reason: /only the owner, an agent/ });
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

  it("is idempotent, a no-op for unknown cells, and the async form delegates", async () => {
    const f = tree();
    f.gate.revokeSync("proj");
    f.gate.revokeSync("proj");
    f.gate.revokeSync("ghost");
    await f.gate.revoke("sib");
    expectType(f.gate.authorizeSync(exec("read"), meta("sib")), "deny");
    expectType(f.gate.authorizeSync(exec("review"), meta("desk")), "allow");
  });
});

describe("reinstate", () => {

  it("reinstating a descendant does not lift an ancestor's revoke; unknown or never-revoked cells are a no-op", () => {
    const f = tree();
    f.gate.revokeSync("proj");
    f.gate.reinstateSync("leaf");
    expect(expectType(f.gate.authorizeSync(exec("read"), meta("leaf")), "deny").feedback).toMatch(/ancestor cell "proj" was revoked/);
    f.gate.reinstateSync("sib");
    f.gate.reinstateSync("ghost");
    expectType(f.gate.authorizeSync(exec("read"), meta("sib")), "allow");
    // with proj reinstated as well, the leaf may act again
    f.gate.reinstateSync("proj");
    expectType(f.gate.authorizeSync(exec("read"), meta("leaf")), "allow");
    // and a later revoke takes hold again
    f.gate.revokeSync("proj");
    expectType(f.gate.authorizeSync(exec("read"), meta("proj")), "deny");
  });
});

describe("deliveryAllowed (kernel helper for inboxOut / emitToParent)", () => {
  it("covers canSendTo patterns and always the parent's own inbox", () => {
    const f = tree();
    const leaf = f.cells.require("leaf");
    expect(deliveryAllowed(leaf.bounds, "proj", "inbox:proj")).toBe(true);
    expect(deliveryAllowed(leaf.bounds, "proj", "channel:ui:oc_7")).toBe(true);
    // desk holds inbox:*, and inbox patterns pass down the tree: a grandchild may ask the desk to arbitrate
    expect(deliveryAllowed(leaf.bounds, "proj", "inbox:desk")).toBe(true);
    expect(deliveryAllowed(leaf.bounds, "proj", "inbox:sib")).toBe(true);
    expect(deliveryAllowed(leaf.bounds, "proj", "channel:memory:peer")).toBe(false);
    expect(deliveryAllowed(leaf.bounds, "proj", "inbox:*")).toBe(false);
    const bare = makeBounds({ canSendTo: ["channel:ui:*"] });
    expect(deliveryAllowed(bare, "proj", "inbox:proj")).toBe(true);
    expect(deliveryAllowed(bare, "proj", "inbox:desk")).toBe(false);
    expect(deliveryAllowed(bare, null, "inbox:proj")).toBe(false);
  });

  it("a root without inbox:* still lets every descendant reach every ancestor's inbox", () => {
    const f = setup();
    f.addCell("root", null, { tools: ["read"], canSendTo: ["channel:ui:*"], maxConcurrentChildren: 2, maxDepth: 3 });
    const mid = f.gate.attenuate(f.cells.require("root").bounds, "root", {});
    f.cells.insert({ id: "mid", parentId: "root", bounds: mid });
    const low = f.gate.attenuate(mid, "mid", {});
    expect(low.canSendTo).toEqual(["inbox:mid", "inbox:root"]);
    expect(deliveryAllowed(low, "mid", "inbox:root")).toBe(true);
    expect(deliveryAllowed(low, "mid", "inbox:desk")).toBe(false);
    expect(deliveryAllowed(low, "mid", "channel:ui:owner")).toBe(false);
  });
});
