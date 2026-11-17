import { describe, expect, it } from "vitest";
import { makeBounds, serializeBounds } from "@ng/protocol";
import { expectType, meta, putArtifact, send, setup } from "./helpers";

function deferDraft(f: ReturnType<typeof setup>, subjectKey = "msg:1") {
  putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 1, body: "v1 by agent" });
  return expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { artifactId: "a1", subjectKey }), meta("desk")), "defer");
}

describe("approve — version-bound confirmation", () => {
  it("approves when the human saw the current version; records approver and emits", () => {
    const f = setup();
    const d = deferDraft(f);
    expect(f.gate.approveSync(d.actionId, "owner", 1)).toBe("approved");
    const rec = f.gate.getApprovalSync(d.actionId)!;
    expect(rec).toMatchObject({ status: "approved", approverId: "owner", boundVersion: 1, humanEdited: false });
    expect(rec.resolvedAt).toBe(f.clock.now());
    expect(f.events.at(-1)).toEqual({
      topic: "approval.changed",
      data: { actionId: d.actionId, cellId: "desk", subjectKey: "msg:1", status: "approved" },
    });
  });

  it("stale seen-version → version_mismatch, the card is re-bound, and the next click on the refreshed card passes", () => {
    const f = setup();
    const d = deferDraft(f);
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 2, body: "v2 background refresh" });
    expect(f.gate.approveSync(d.actionId, "owner", 1)).toBe("version_mismatch");
    expect(f.gate.getApprovalSync(d.actionId)).toMatchObject({ status: "pending", boundVersion: 2 });
    expect(f.gate.approveSync(d.actionId, "owner")).toBe("version_mismatch"); // not saying what was seen counts as a mismatch
    expect(f.gate.approveSync(d.actionId, "owner", 3)).toBe("version_mismatch"); // a version that does not exist yet
    expect(f.gate.approveSync(d.actionId, "owner", 2)).toBe("approved");
    expect(f.gate.getApprovalSync(d.actionId)).toMatchObject({ status: "approved", boundVersion: 2, humanEdited: false });
  });

  it("approving what the human saw after editing it records human_edited", () => {
    const f = setup();
    const d = deferDraft(f);
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 2, body: "v2 edited by the owner", by: "human" });
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 3, body: "v3 agent re-draft" });
    // the card was bound to v1 but the human looked at v3: approving v3 is what they saw
    expect(f.gate.approveSync(d.actionId, "owner", 3)).toBe("approved");
    expect(f.gate.getApprovalSync(d.actionId)).toMatchObject({ boundVersion: 3, humanEdited: true });
  });

  it("an epoch bump (cancel / reopen) → already_cancelled, and the card is cancelled", () => {
    const f = setup();
    const d = deferDraft(f);
    f.cells.bumpEpoch("desk");
    expect(f.gate.approveSync(d.actionId, "owner", 1)).toBe("already_cancelled");
    expect(f.gate.getApprovalSync(d.actionId)).toMatchObject({ status: "cancelled", statusReason: "task was cancelled or restarted" });
    expect(f.gate.approveSync(d.actionId, "owner", 1)).toBe("already_cancelled");
    expect(f.gate.listPendingSync()).toEqual([]);
  });

  it("closed cells, revoked cells and bounds narrowed since the defer → already_cancelled", () => {
    const f = setup();
    f.addCell("p", "desk", { tools: ["read"], canSendTo: ["channel:feishu:*"], maxTokens: 10, maxCents: 10 });
    const mk = (subjectKey: string) => expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey }), meta("p")), "defer").actionId;
    const a = mk("a");
    const b = mk("b");
    f.cells.update("p", { bounds: makeBounds({ ...serializeBounds(f.cells.require("p").bounds), canSendTo: ["channel:feishu:oc_9"] }) });
    expect(f.gate.approveSync(a, "owner")).toBe("already_cancelled");
    expect(f.gate.getApprovalSync(a)!.statusReason).toMatch(/no longer within the task's permissions/);
    f.cells.setStatus("p", "closed");
    expect(f.gate.approveSync(b, "owner")).toBe("already_cancelled");

    const g = setup();
    const c = expectType(g.gate.authorizeSync(send("channel:feishu:oc_1"), meta("desk")), "defer").actionId;
    g.gate.revokeSync("desk");
    expect(g.gate.approveSync(c, "owner")).toBe("already_cancelled");
  });

  it("a paused cell can still be approved (the human decided explicitly)", () => {
    const f = setup();
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1"), meta("desk")), "defer");
    f.cells.setStatus("desk", "paused");
    expect(f.gate.approveSync(d.actionId, "owner")).toBe("approved");
  });

  it("is idempotent for decided approvals and refuses cancelled ones", () => {
    const f = setup();
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1"), meta("desk")), "defer");
    expect(f.gate.approveSync(d.actionId, "owner")).toBe("approved");
    expect(f.gate.approveSync(d.actionId, "owner")).toBe("approved");
    f.gate.recordOutcomeSync(d.actionId, "executed", { receipt: "sent" });
    expect(f.gate.approveSync(d.actionId, "owner")).toBe("approved");
    expect(f.gate.approveSync("act_missing", "owner")).toBe("not_found");
    const e = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "z" }), meta("desk")), "defer");
    expect(f.gate.denySync(e.actionId, "owner", "不回了")).toBe("denied");
    expect(f.gate.approveSync(e.actionId, "owner")).toBe("already_cancelled");
    expect(f.gate.approvalStatsSync().find((s) => s.actionClass === "channel.send|channel:feishu:*")).toMatchObject({ approved: 1, denied: 1 });
  });

  it("a cell can never approve, deny or raise budgets", () => {
    const f = setup();
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1"), meta("desk")), "defer");
    expect(() => f.gate.approveSync(d.actionId, "cell:desk")).toThrow(/cell principal/);
    expect(() => f.gate.denySync(d.actionId, "cell:desk")).toThrow(/cell principal/);
    expect(() => f.gate.raiseBudgetSync("desk", { tokens: 1 }, "cell:desk")).toThrow(/cell principal/);
    expect(f.gate.getApprovalSync(d.actionId)!.status).toBe("pending");
  });

  it("the async approve delegates", async () => {
    const f = setup();
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1"), meta("desk")), "defer");
    await expect(f.gate.approve(d.actionId, "owner")).resolves.toBe("approved");
  });
});

describe("card lifecycle", () => {
  it("snooze hides a card until it is due", () => {
    const f = setup();
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1"), meta("desk")), "defer");
    const until = f.clock.now() + 3_600_000;
    expect(f.gate.snoozeSync(d.actionId, until)).toBe("snoozed");
    expect(f.gate.listPendingSync()).toEqual([]);
    expect(f.gate.listPendingSync({ includeSnoozed: true })).toHaveLength(1);
    expect(f.gate.listPendingSync({ now: until })).toHaveLength(1);
    f.clock.set(until);
    expect(f.gate.listPendingSync()[0]).toMatchObject({ actionId: d.actionId, snoozedUntil: until });
    expect(f.gate.snoozeSync("act_missing", until)).toBe("not_pending");
    expect(() => f.gate.snoozeSync(d.actionId, Number.NaN)).toThrow();
  });

  it("withdraw (someone already answered) and cancelForCell", () => {
    const f = setup();
    const a = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "a" }), meta("desk")), "defer");
    const b = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "b" }), meta("desk")), "defer");
    const c = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "c" }), meta("desk")), "defer");
    expect(f.gate.withdrawSync(a.actionId, "群里已有人回答")).toBe("cancelled");
    expect(f.gate.withdrawSync(a.actionId, "again")).toBe("not_pending");
    expect(f.gate.getApprovalSync(a.actionId)).toMatchObject({ status: "cancelled", statusReason: "群里已有人回答" });
    expect(f.gate.cancelForCellSync("desk", "project closed")).toBe(2);
    expect([b, c].map((x) => f.gate.getApprovalSync(x.actionId)!.status)).toEqual(["cancelled", "cancelled"]);
    expect(f.events.filter((e) => e.topic === "approval.changed" && (e.data as { status: string }).status === "cancelled")).toHaveLength(3);
  });

  it("rebind moves a pending card to another existing draft version", () => {
    const f = setup();
    const d = deferDraft(f);
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 2, body: "v2" });
    expect(f.gate.rebindSync(d.actionId, 2)).toBe("rebound");
    expect(f.gate.getApprovalSync(d.actionId)!.boundVersion).toBe(2);
    expect(() => f.gate.rebindSync(d.actionId, 3)).toThrow(/no version 3/);
    expect(() => f.gate.rebindSync(d.actionId, 0)).toThrow(/no version 0/);
    const plain = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "x" }), meta("desk")), "defer");
    expect(() => f.gate.rebindSync(plain.actionId, 1)).toThrow(/not bound to a draft/);
    f.gate.approveSync(d.actionId, "owner", 2);
    expect(f.gate.rebindSync(d.actionId, 1)).toBe("not_pending");
  });

  it("recordOutcome follows approved → executed | failed | unknown; unknown stays listable", () => {
    const f = setup();
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1"), meta("desk")), "defer");
    expect(() => f.gate.recordOutcomeSync(d.actionId, "executed", {})).toThrow(/pending, not approved/);
    f.gate.approveSync(d.actionId, "owner");
    f.gate.recordOutcomeSync(d.actionId, "unknown", { receipt: "unknown", note: "飞书超时" });
    expect(f.gate.listApprovalsSync({ status: ["unknown"] }).map((a) => a.actionId)).toEqual([d.actionId]);
    expect(f.gate.getApprovalSync(d.actionId)!.outcome).toEqual({ receipt: "unknown", note: "飞书超时" });
    f.gate.recordOutcomeSync(d.actionId, "executed", { receipt: "sent" });
    f.gate.recordOutcomeSync(d.actionId, "executed", { receipt: "sent" }); // idempotent
    expect(() => f.gate.recordOutcomeSync(d.actionId, "failed", {})).toThrow(/already executed/);
    expect(() => f.gate.recordOutcomeSync(d.actionId, "pending" as never, {})).toThrow(/invalid status/);
    expect(() => f.gate.recordOutcomeSync("act_missing", "failed", {})).toThrow(/not found/);
  });

  it("lists by cell, status, subject and limit", () => {
    const f = setup();
    f.addCell("p", "desk", { canSendTo: ["channel:feishu:*"], maxTokens: 10, maxCents: 10 });
    const a = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "a" }), meta("desk")), "defer");
    f.clock.advance(1);
    const b = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "b" }), meta("p")), "defer");
    expect(f.gate.listPendingSync().map((x) => x.actionId)).toEqual([a.actionId, b.actionId]);
    expect(f.gate.listPendingSync({ cellIds: ["p"] }).map((x) => x.actionId)).toEqual([b.actionId]);
    expect(f.gate.listPendingSync({ cellIds: [] })).toEqual([]);
    expect(f.gate.listPendingSync({ limit: 1 })).toHaveLength(1);
    expect(f.gate.listApprovalsSync({ subjectKey: "a" }).map((x) => x.actionId)).toEqual([a.actionId]);
    expect(f.gate.listApprovalsSync().map((x) => x.actionId)).toEqual([b.actionId, a.actionId]);
  });
});
