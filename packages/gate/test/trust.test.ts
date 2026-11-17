import { describe, expect, it } from "vitest";
import { ruleInputForClass } from "../src";
import { expectType, meta, putArtifact, send, setup } from "./helpers";

const CLASS = "channel.send|channel:feishu:*";

function approveOnce(f: ReturnType<typeof setup>, n: number, opts: { humanEdit?: boolean } = {}) {
  const artifactId = `a${n}`;
  putArtifact(f.db, { artifactId, cellId: "desk", version: 1, body: "draft" });
  const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { artifactId, subjectKey: `msg:${n}` }), meta("desk")), "defer");
  let seen = 1;
  if (opts.humanEdit) {
    putArtifact(f.db, { artifactId, cellId: "desk", version: 2, body: "edited", by: "human" });
    seen = 2;
  }
  expect(f.gate.approveSync(d.actionId, "owner", seen)).toBe("approved");
}

describe("trust grows gradually (docs/03 原则 4)", () => {
  it("counts consecutive unedited approvals per action class and suggests — never applies — an auto rule", () => {
    const f = setup({ trustStreak: 3 });
    approveOnce(f, 1);
    approveOnce(f, 2);
    expect(f.gate.trustCandidatesSync()).toEqual([]);
    approveOnce(f, 3);
    const [cand] = f.gate.trustCandidatesSync();
    expect(cand).toMatchObject({ actionClass: CLASS, approved: 3, approvedUnedited: 3, uneditedStreak: 3, denied: 0, suggestedAt: null });
    expect(f.gate.trustCandidatesSync(4)).toEqual([]);
    // nothing changed by itself: the next external send is still a card
    expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "next" }), meta("desk")), "defer");
    f.gate.markTrustSuggestedSync([CLASS], 123);
    expect(f.gate.approvalStatsSync()[0]!.suggestedAt).toBe(123);
  });

  it("a human edit or a denial resets the streak", () => {
    const f = setup({ trustStreak: 2 });
    approveOnce(f, 1);
    approveOnce(f, 2, { humanEdit: true });
    expect(f.gate.approvalStatsSync()[0]).toMatchObject({ approved: 2, approvedUnedited: 1, uneditedStreak: 0 });
    approveOnce(f, 3);
    approveOnce(f, 4);
    expect(f.gate.trustCandidatesSync()).toHaveLength(1);
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "msg:5" }), meta("desk")), "defer");
    f.gate.denySync(d.actionId, "owner");
    expect(f.gate.approvalStatsSync()[0]).toMatchObject({ denied: 1, uneditedStreak: 0 });
    expect(f.gate.trustCandidatesSync()).toEqual([]);
  });

  it("accepting the suggestion installs a capped auto rule; covered classes stop being suggested", () => {
    const f = setup({ trustStreak: 1 });
    approveOnce(f, 1);
    // a scoped rule does not count as covering the class globally
    f.gate.upsertPolicyRuleSync({ match: { type: "channel.send", target: "channel:feishu:*" }, effect: "allow", scopeCellId: "desk", createdBy: "owner" });
    expect(f.gate.trustCandidatesSync()).toHaveLength(1);
    const input = ruleInputForClass(CLASS, { createdBy: "owner", maxUses: 1 })!;
    expect(input).toEqual({ match: { type: "channel.send", target: "channel:feishu:*" }, effect: "allow", createdBy: "owner", maxUses: 1, note: null });
    const rule = f.gate.upsertPolicyRuleSync(input);
    expect(f.gate.trustCandidatesSync()).toEqual([]);
    // an exhausted rule no longer covers it
    f.gate.upsertPolicyRuleSync({ ...input, id: rule.id, maxUses: 0 });
    expect(f.gate.trustCandidatesSync()).toHaveLength(1);
    expect(ruleInputForClass("cell.control|cancel", { createdBy: "owner" })).toBeNull();
    expect(ruleInputForClass("job.start", { createdBy: "owner" })).toMatchObject({ match: { type: "job.start" }, maxUses: 20 });
  });
});
