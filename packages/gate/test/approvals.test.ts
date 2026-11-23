import { describe, expect, it } from "vitest";
import { isNgError, type ProposedAction } from "@ng/protocol";
import { expectType, meta, putArtifact, proposal, setup } from "./helpers";

function deferDraft(f: ReturnType<typeof setup>, subjectKey = "msg:1") {
  putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 1, body: "v1 by agent" });
  return expectType(f.gate.authorizeSync(proposal({ artifactId: "a1", subjectKey }), meta("desk")), "defer");
}

function custom(name: string, over: Record<string, unknown> = {}): ProposedAction {
  return { type: "custom", name, summary: name, subjectKey: `s:${name}`, sideEffect: "external", ...over } as ProposedAction;
}

/** An escalation card the way request_approval (kind escalation) or the kernel builds it. */
function escalationCard(reason: string) {
  const data = { cardType: "escalation", escalation: { reason, explanation: "x" } };
  return { format: "card" as const, title: reason, body: reason, data };
}

/** Runs `fn`, expects NgError("bounds_violation"), returns its message. */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(isNgError(e, "bounds_violation"), String(e)).toBe(true);
    return (e as Error).message;
  }
  throw new Error("expected a bounds_violation refusal");
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

  it("a paused cell can still be approved (the human decided explicitly)", () => {
    const f = setup();
    const d = expectType(f.gate.authorizeSync(proposal(), meta("desk")), "defer");
    f.cells.setStatus("desk", "paused");
    expect(f.gate.approveSync(d.actionId, "owner")).toBe("approved");
  });

  it("is idempotent for decided approvals and refuses cancelled ones", () => {
    const f = setup();
    const d = expectType(f.gate.authorizeSync(proposal(), meta("desk")), "defer");
    expect(f.gate.approveSync(d.actionId, "owner")).toBe("approved");
    expect(f.gate.approveSync(d.actionId, "owner")).toBe("approved");
    f.gate.recordOutcomeSync(d.actionId, "executed", { note: "done" });
    expect(f.gate.approveSync(d.actionId, "owner")).toBe("approved");
    expect(f.gate.approveSync("act_missing", "owner")).toBe("not_found");
    const e = expectType(f.gate.authorizeSync(proposal({ subjectKey: "z" }), meta("desk")), "defer");
    expect(f.gate.denySync(e.actionId, "owner", "不回了")).toBe("denied");
    expect(f.gate.approveSync(e.actionId, "owner")).toBe("already_cancelled");
  });

  it("a cell (or any principal but the owner and an agent) can never approve or deny", () => {
    const f = setup();
    const d = expectType(f.gate.authorizeSync(custom("merge"), meta("desk")), "defer");
    for (const who of ["cell:desk", "memory:ou_colleague", "agent:", "agent:a:b", "someone"]) {
      expect(refusal(() => f.gate.approveSync(d.actionId, who)), who).toMatch(new RegExp(`needs the owner or an agent on the control plane; ${who} may not`));
      expect(refusal(() => f.gate.denySync(d.actionId, who)), who).toMatch(/needs the owner or an agent/);
    }
    expect(() => f.gate.approveSync(d.actionId, "")).toThrow(/principal required/);
    expect(f.gate.getApprovalSync(d.actionId)!.status).toBe("pending");
  });

});

describe("approve — an external main agent (agent:*) decides with the owner's rights (proposal 07)", () => {
  const AGENT = "agent:ops";

  it("may approve project.start cards, custom actions and blocked / retry_limit / waiting_timeout escalations; a cell or an outsider still may not", () => {
    const f = setup();
    const project = expectType(
      f.gate.authorizeSync(
        { type: "project.start", summary: "立项", subjectKey: "msg:p", sideEffect: "external", proposal: { title: "竞品调研", outcome: "交付调研报告", actions: [] } },
        meta("desk"),
      ),
      "defer",
    );
    for (const who of ["cell:desk", "external:mail:someone"]) {
      expect(refusal(() => f.gate.approveSync(project.actionId, who)), who).toMatch(/needs the owner or an agent on the control plane/);
      expect(f.gate.getApprovalSync(project.actionId)).toMatchObject({ status: "pending", approverId: null });
    }

    const cards = [
      project.actionId,
      expectType(f.gate.authorizeSync(custom("merge"), meta("desk")), "defer").actionId,
      expectType(f.gate.authorizeSync(custom("escalation.blocked", { card: escalationCard("blocked") }), meta("desk")), "defer").actionId,
      expectType(f.gate.authorizeSync(custom("escalation.waiting_timeout"), meta("desk")), "defer").actionId,
      expectType(
        f.gate.authorizeSync(custom("kernel.escalation", { args: { kernel: true, reason: "retry_limit", cellId: "desk" }, card: escalationCard("retry_limit") }), meta("desk", 0, {principalId:"kernel:escalation"})),
        "defer",
      ).actionId,
    ];
    for (const id of cards) {
      expect(f.gate.approveSync(id, AGENT)).toBe("approved");
      expect(f.gate.getApprovalSync(id)).toMatchObject({ status: "approved", approverId: AGENT });
    }
  });

  it("may deny and snooze any card", () => {
    const f = setup();
    const a = expectType(f.gate.authorizeSync(proposal({ subjectKey: "a" }), meta("desk")), "defer");
    const b = expectType(f.gate.authorizeSync(proposal({ subjectKey: "b" }), meta("desk")), "defer");
    expect(f.gate.denySync(a.actionId, AGENT, "不回了")).toBe("denied");
    expect(f.gate.getApprovalSync(a.actionId)).toMatchObject({ status: "denied", approverId: AGENT, statusReason: "不回了" });
    expect(f.gate.snoozeSync(b.actionId, f.clock.now() + 60_000)).toBe("snoozed");
    expect(f.gate.withdrawSync(b.actionId, "resolved offline")).toBe("cancelled");
  });
});

describe("card lifecycle", () => {
  it("snooze hides a card until it is due", () => {
    const f = setup();
    const d = expectType(f.gate.authorizeSync(proposal(), meta("desk")), "defer");
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

  it("BUG-020: itemRevision optimistic locking rejects stale seenItemRevision and bumps on every accepted change (incl. revise)", () => {
    const f = setup();
    const d = expectType(f.gate.authorizeSync(proposal({ subjectKey: "rev:1" }), meta("desk")), "defer");
    expect(f.gate.getApprovalSync(d.actionId)!.itemRevision).toBe(1);

    // Stale revision rejected across revise / snooze / deny / withdraw / approve.
    expect(f.gate.reviseSync(d.actionId, "owner", { seenItemRevision: 99 })).toBe("revision_mismatch");
    expect(f.gate.snoozeSync(d.actionId, f.clock.now() + 60_000, { seenItemRevision: 99 })).toBe("revision_mismatch");
    expect(f.gate.denySync(d.actionId, "owner", "no", { seenItemRevision: 99 })).toBe("revision_mismatch");
    expect(f.gate.withdrawSync(d.actionId, "no", { seenItemRevision: 99 })).toBe("revision_mismatch");
    expect(f.gate.approveSync(d.actionId, "owner", undefined, { seenItemRevision: 99 })).toBe("revision_mismatch");

    // Accepted revise bumps itemRevision: 1 -> 2, and old revision 1 is now stale.
    expect(f.gate.reviseSync(d.actionId, "owner", { seenItemRevision: 1 })).toBe("revised");
    expect(f.gate.getApprovalSync(d.actionId)!.itemRevision).toBe(2);
    expect(f.gate.snoozeSync(d.actionId, f.clock.now() + 60_000, { seenItemRevision: 1 })).toBe("revision_mismatch");

    // Accepted snooze bumps itemRevision: 2 -> 3.
    expect(f.gate.snoozeSync(d.actionId, f.clock.now() + 60_000, { seenItemRevision: 2 })).toBe("snoozed");
    expect(f.gate.getApprovalSync(d.actionId)!.itemRevision).toBe(3);

    // Accepted approve bumps itemRevision: 3 -> 4; executed outcome bumps to 5.
    expect(f.gate.approveSync(d.actionId, "owner", undefined, { seenItemRevision: 3 })).toBe("approved");
    expect(f.gate.getApprovalSync(d.actionId)!.itemRevision).toBe(4);
    f.gate.recordOutcomeSync(d.actionId, "executed", { note: "done" });
    expect(f.gate.getApprovalSync(d.actionId)!.itemRevision).toBe(5);
    expect(f.gate.approveSync(d.actionId, "owner", undefined, { seenItemRevision: 4 })).toBe("revision_mismatch");
    expect(f.gate.approveSync(d.actionId, "owner", undefined, { seenItemRevision: 5 })).toBe("approved");
    expect(f.gate.getApprovalSync(d.actionId)!.itemRevision).toBe(5);
  });

});
