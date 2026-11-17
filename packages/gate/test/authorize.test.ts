import { describe, expect, it } from "vitest";
import { all, get, hashAction, sha256Hex, type ProposedAction } from "@ng/protocol";
import { OWNER_UI, exec, expectType, meta, putArtifact, secretUse, send, setup, withWorker } from "./helpers";

const tokenRows = (f: ReturnType<typeof setup>) => all<{ action_hash: string; cell_id: string }>(f.db, "SELECT * FROM action_tokens");
const approvalRows = (f: ReturnType<typeof setup>) => all<{ status: string }>(f.db, "SELECT * FROM approvals");

describe("authorize — deny (and nothing persisted)", () => {
  function denied(f: ReturnType<typeof setup>, action: unknown, m: unknown, pattern: RegExp) {
    const r = f.gate.authorizeSync(action as ProposedAction, m as never);
    expect(expectType(r, "deny").feedback).toMatch(pattern);
    expect(tokenRows(f)).toEqual([]);
    expect(approvalRows(f)).toEqual([]);
  }

  it("malformed actions and meta", () => {
    const f = setup();
    denied(f, null, meta("desk"), /expected an object/);
    denied(f, { ...send(OWNER_UI), type: "shell" }, meta("desk"), /unknown type/);
    denied(f, { ...send(OWNER_UI), subjectKey: "" }, meta("desk"), /subjectKey/);
    denied(f, { ...send(OWNER_UI), sideEffect: "harmless" }, meta("desk"), /sideEffect/);
    denied(f, { ...send(OWNER_UI), summary: 3 }, meta("desk"), /summary/);
    denied(f, send(OWNER_UI), { cellId: "desk", principalId: "cell:desk" }, /epoch/);
    denied(f, send(OWNER_UI), { cellId: "desk", epoch: 0 }, /principalId/);
  });

  it("unknown, closed, paused, stale-epoch, impersonated and revoked cells", () => {
    const f = setup();
    withWorker(f);
    denied(f, send(OWNER_UI), meta("nope"), /unknown cell/);
    denied(f, send(OWNER_UI), { ...meta("desk"), principalId: "cell:w1" }, /may not act for cell "desk"/);

    f.cells.bumpEpoch("desk");
    denied(f, send(OWNER_UI), meta("desk", 0), /stale epoch 0 \(current 1\)/);

    f.cells.setStatus("w1", "paused");
    denied(f, exec("read"), meta("w1"), /this cell is paused/);
    f.cells.setStatus("w1", "active");
    f.cells.setStatus("desk", "paused");
    denied(f, exec("read"), meta("w1"), /ancestor cell "desk" is paused/);
    f.cells.setStatus("desk", "closed");
    denied(f, exec("read"), meta("w1"), /ancestor cell "desk" is closed/);
    denied(f, send(OWNER_UI), meta("desk", 1), /this cell is closed/);
  });

  it("revoked cells, their subtree, and children created after the revoke", () => {
    const f = setup();
    withWorker(f);
    f.gate.revokeSync("desk");
    denied(f, send(OWNER_UI), meta("desk"), /authority was revoked/);
    denied(f, exec("read"), meta("w1"), /authority was revoked/);
    f.addCell("late", "w1", { tools: ["read"] });
    denied(f, exec("read"), meta("late"), /authority of ancestor cell "(w1|desk)" was revoked/);
  });

  it("channel.send outside canSendTo, or not a channel address", () => {
    const f = setup();
    withWorker(f);
    denied(f, send("channel:feishu:oc_1"), meta("w1"), /may not send to channel:feishu:oc_1/);
    denied(f, send(OWNER_UI), meta("w1"), /may not send to channel:ui:owner/);
    denied(f, send("inbox:desk"), meta("w1"), /must be a channel address/);
    denied(f, send("channel:feishu:*"), meta("desk"), /must be a channel address/);
    denied(f, send("channel:slack:C1"), meta("desk"), /may not send to channel:slack:C1/);
    denied(f, send(OWNER_UI, { content: { body: 1 } }), meta("desk"), /Deliverable/);
  });

  it("workspace tools, jobs and secrets outside bounds", () => {
    const f = setup();
    withWorker(f);
    denied(f, exec("code_rpc"), meta("w1"), /tool "code_rpc" is outside/);
    denied(f, exec("format_disk"), meta("w1"), /unknown tool/);
    f.addCell("ro", "desk", { tools: ["read", "write", "bash"], isolation: "shared_ro" });
    denied(f, exec("write"), meta("ro"), /read-only workspace/);
    denied(f, { type: "job.start", summary: "", subjectKey: "s", sideEffect: "internal", command: "make" }, meta("ro"), /read-only/);
    f.addCell("nobash", "desk", { tools: ["read"], isolation: "git_worktree" });
    denied(f, { type: "job.start", summary: "", subjectKey: "s", sideEffect: "internal", command: "make" }, meta("nobash"), /needs the "bash" tool/);
    denied(f, secretUse("feishu"), meta("w1"), /secret "feishu" is outside/);
    denied(f, secretUse("github", { tool: "code_rpc" }), meta("w1"), /tool "code_rpc" is outside/);
    // in bounds but no value on the host
    denied(f, secretUse("feishu"), meta("desk"), /not configured on the host/);
  });

  it("spawn beyond depth or concurrency, and control of non-descendants", () => {
    const f = setup();
    withWorker(f, "w1", { maxDepth: 0, maxConcurrentChildren: 0 });
    const spawn = (over: Record<string, unknown> = {}) =>
      ({ type: "cell.spawn", summary: "", subjectKey: "s", sideEffect: "internal", spec: { processor: { kind: "llm" } }, ...over }) as ProposedAction;
    denied(f, spawn(), meta("w1"), /maxDepth 0/);
    denied(f, spawn({ spec: { parentId: "w1", processor: { kind: "llm" } } }), meta("desk"), /only create children of the requesting cell/);
    f.addCell("w2", "desk", { tools: ["read"] });
    f.addCell("w3", "desk", { tools: ["read"] });
    denied(f, spawn(), meta("desk"), /already has 3 open children \(max 3\)/);

    const control = (targetCellId: string) =>
      ({ type: "cell.control", summary: "", subjectKey: "s", sideEffect: "internal", targetCellId, action: "cancel" }) as ProposedAction;
    denied(f, control("w2"), meta("w1"), /not a descendant/);
    denied(f, control("w1"), meta("w1"), /not a descendant/);
    denied(f, control("desk"), meta("w1"), /not a descendant/);
    denied(f, control("ghost"), meta("desk"), /not a descendant/);
  });

  it("budget exhausted for the cell or any ancestor", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 1000 });
    f.gate.meter("w1", { tokens: 1000, billedCents: 0 });
    denied(f, exec("read"), meta("w1"), /budget exhausted: this cell used 1000\/1000 tokens/);

    const g = setup();
    withWorker(g, "w1", { maxTokens: 1000 });
    g.addCell("w2", "desk", { tools: ["read"], maxTokens: 5_000_000, maxCents: 1e6 });
    g.gate.meter("w2", { tokens: 1_000_000, billedCents: 0 });
    denied(g, exec("read"), meta("w1"), /ancestor cell "desk" used 1000000\/1000000 tokens/);
  });

  it("an exhausted budget still lets an action become a card (asking the owner spends nothing)", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 1000 });
    f.gate.meter("w1", { tokens: 1000, billedCents: 0 });
    const escalation = {
      type: "custom",
      name: "escalation.budget_exhausted",
      summary: "budget used up",
      subjectKey: "cell:w1",
      sideEffect: "external",
    } as ProposedAction;
    const r = f.gate.authorizeSync(escalation, meta("w1"));
    expect(r.type).toBe("defer");
    expect(f.gate.findPendingBySubjectSync("cell:w1")).toMatchObject({ cellId: "w1", status: "pending" });
    // anything that would act right away is still refused, and mints no token
    const read = f.gate.authorizeSync(exec("read"), meta("w1"));
    expect(expectType(read, "deny").feedback).toMatch(/budget exhausted: this cell used 1000\/1000 tokens/);
    expect(tokenRows(f)).toEqual([]);
  });

  it("draft artifacts: unknown, unrelated, or a version that does not exist", () => {
    const f = setup();
    f.addCell("other", null, { tools: ["read"] });
    putArtifact(f.db, { artifactId: "a_other", cellId: "other", version: 1, body: "x" });
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 2, body: "x" });
    denied(f, send("channel:feishu:oc_1", { artifactId: "missing" }), meta("desk"), /not found/);
    denied(f, send("channel:feishu:oc_1", { artifactId: "a_other" }), meta("desk"), /unrelated task/);
    denied(f, send("channel:feishu:oc_1", { artifactId: "a1" }), meta("desk", 0, { artifactVersion: 3 }), /no version 3/);
    denied(f, send("channel:feishu:oc_1", { artifactId: "a1" }), meta("desk", 0, { artifactVersion: 0 }), /no version 0/);
  });

  it("an allowed channel.send without content cannot get a token", () => {
    const f = setup();
    denied(f, send(OWNER_UI, { content: undefined, sideEffect: "notify_owner" }), meta("desk"), /needs `content`/);
  });
});

describe("authorize — allow (single-use token, no card)", () => {
  it("owner notifications, reads and in-sandbox work never produce a card (docs/03 原则 2)", () => {
    const f = setup();
    withWorker(f);
    const notify = send(OWNER_UI, { sideEffect: "notify_owner", subjectKey: "note:1" });
    const a = expectType(f.gate.authorizeSync(notify, meta("desk")), "allow");
    expect(a.actionToken).toMatch(/^ngt_/);
    expect(a.proxyInjectedSecretRef).toBeUndefined();
    const row = get<{ action_hash: string; token_hash: string; epoch: number; action_id: string | null }>(f.db, "SELECT * FROM action_tokens");
    expect(row).toMatchObject({ action_hash: hashAction(notify), token_hash: sha256Hex(a.actionToken), epoch: 0, action_id: null });

    expectType(f.gate.authorizeSync(exec("read", { sideEffect: "none" }), meta("desk")), "allow");
    expectType(f.gate.authorizeSync(exec("bash"), meta("w1")), "allow");
    expectType(f.gate.authorizeSync({ type: "job.start", summary: "", subjectKey: "s", sideEffect: "internal", command: "pnpm test" }, meta("w1")), "allow");
    expectType(
      f.gate.authorizeSync({ type: "cell.spawn", summary: "", subjectKey: "s", sideEffect: "internal", spec: { processor: { kind: "llm" } } }, meta("desk")),
      "allow",
    );
    expectType(
      f.gate.authorizeSync({ type: "cell.control", summary: "", subjectKey: "s", sideEffect: "internal", targetCellId: "w1", action: "steer" }, meta("desk")),
      "allow",
    );
    expect(approvalRows(f)).toEqual([]);
    expect(f.events.filter((e) => e.topic === "approval.changed")).toEqual([]);
  });

  it("secret.use returns only the ref — never the value", () => {
    const f = setup();
    withWorker(f);
    const r = expectType(f.gate.authorizeSync(secretUse("github", { tool: "bash" }), meta("w1")), "allow");
    expect(r.proxyInjectedSecretRef).toBe("github");
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("the async contract delegates to the sync core", async () => {
    const f = setup();
    const r = await f.gate.authorize(send(OWNER_UI, { sideEffect: "notify_owner" }), meta("desk"));
    expect(r.type).toBe("allow");
  });
});

describe("authorize — defer (external side effects become one Clarify card)", () => {
  it("an external send is deferred with a persisted approval bound to the cell epoch", () => {
    const f = setup();
    f.cells.bumpEpoch("desk");
    const action = send("channel:feishu:oc_1");
    const d = expectType(f.gate.authorizeSync(action, meta("desk", 1)), "defer");
    expect(d.boundArtifactVersion).toBeUndefined();
    expect(d.approvalCard.format).toBe("card");
    const rec = f.gate.getApprovalSync(d.actionId)!;
    expect(rec).toMatchObject({ cellId: "desk", epoch: 1, principalId: "cell:desk", subjectKey: "msg:env_1", status: "pending", artifactId: null });
    expect(rec.action).toMatchObject({ type: "channel.send", target: "channel:feishu:oc_1" });
    expect(tokenRows(f)).toEqual([]);
    expect(f.events).toContainEqual({
      topic: "approval.changed",
      data: { actionId: d.actionId, cellId: "desk", subjectKey: "msg:env_1", status: "pending" },
    });
  });

  it("a mislabelled side effect can only get stricter", () => {
    const f = setup();
    // claims to notify the owner, but the target is a colleague's chat
    expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { sideEffect: "notify_owner", subjectKey: "a" }), meta("desk")), "defer");
    expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { sideEffect: "none", subjectKey: "b" }), meta("desk")), "defer");
    // declaring external on an owner notification is respected
    expectType(f.gate.authorizeSync(send(OWNER_UI, { sideEffect: "external", subjectKey: "c" }), meta("desk")), "defer");
    // project.start always needs the owner's confirmation (card B)
    const project: ProposedAction = {
      type: "project.start",
      summary: "立项：竞品调研",
      subjectKey: "d",
      sideEffect: "internal",
      proposal: { title: "竞品调研", outcome: "一份对比表", actions: [] },
    };
    expectType(f.gate.authorizeSync(project, meta("desk")), "defer");
    // mutating tools on the owner's real directory (isolation "none")
    expectType(f.gate.authorizeSync(exec("bash", { subjectKey: "e" }), meta("desk")), "defer");
    expectType(f.gate.authorizeSync({ type: "job.start", summary: "", subjectKey: "f", sideEffect: "internal", command: "rm -rf build" }, meta("desk")), "defer");
    expectType(f.gate.authorizeSync(exec("read", { subjectKey: "g" }), meta("desk")), "allow");
    expectType(f.gate.authorizeSync({ type: "custom", name: "x", summary: "", subjectKey: "h", sideEffect: "external" }, meta("desk")), "defer");
  });

  it("binds drafts to the current version, or to the version the agent names", () => {
    const f = setup();
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 1, body: "v1" });
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 2, body: "v2" });
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { artifactId: "a1", subjectKey: "s1" }), meta("desk")), "defer");
    expect(d.boundArtifactVersion).toBe(2);
    expect(f.gate.getApprovalSync(d.actionId)).toMatchObject({ artifactId: "a1", boundVersion: 2 });
    const e = expectType(
      f.gate.authorizeSync(send("channel:feishu:oc_1", { artifactId: "a1", subjectKey: "s2" }), meta("desk", 0, { artifactVersion: 1 })),
      "defer",
    );
    expect(e.boundArtifactVersion).toBe(1);
  });

  it("drafts written by a descendant (e.g. a worker's result) may be bound", () => {
    const f = setup();
    withWorker(f);
    putArtifact(f.db, { artifactId: "a_w", cellId: "w1", version: 1, body: "PR summary" });
    expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { artifactId: "a_w" }), meta("desk")), "defer");
  });

  it("uses the caller's card when it is a valid Deliverable, otherwise builds a Chinese fallback", () => {
    const f = setup();
    const card = { format: "card" as const, title: "回复张三", body: "fallback", data: { cardType: "response" } };
    const d = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { card, subjectKey: "s1" }), meta("desk")), "defer");
    expect(d.approvalCard).toEqual(card);
    expect(f.gate.getApprovalSync(d.actionId)!.card).toEqual(card);
    expect((f.gate.getApprovalSync(d.actionId)!.action as { card?: unknown }).card).toBeUndefined();
    const e = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { card: { nope: 1 }, subjectKey: "s2" }), meta("desk")), "defer");
    expect(e.approvalCard.body).toContain("对外发送到 channel:feishu:oc_1");
  });
});

describe("authorize — one pending card per subjectKey", () => {
  it("a repeat defer from the same cell and action type updates the card in place", () => {
    const f = setup();
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 1, body: "v1" });
    const first = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { artifactId: "a1" }), meta("desk")), "defer");
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 2, body: "v2 (new info)" });
    const second = expectType(
      f.gate.authorizeSync(send("channel:feishu:oc_1", { artifactId: "a1", content: { format: "text", body: "v2" } }), meta("desk")),
      "defer",
    );
    expect(second.actionId).toBe(first.actionId);
    expect(second.boundArtifactVersion).toBe(2);
    expect(f.gate.listPendingSync()).toHaveLength(1);
    expect(f.gate.getApprovalSync(first.actionId)!.action).toMatchObject({ content: { body: "v2" } });
  });

  it("a repeat defer that changes what the card does (target, proposal) supersedes, so an old click cannot approve it", () => {
    const f = setup();
    putArtifact(f.db, { artifactId: "a1", cellId: "desk", version: 1, body: "v1" });
    const first = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { artifactId: "a1" }), meta("desk")), "defer");
    const retarget = expectType(f.gate.authorizeSync(send("channel:feishu:oc_boss", { artifactId: "a1" }), meta("desk")), "defer");
    expect(retarget.actionId).not.toBe(first.actionId);
    expect(f.gate.approveSync(first.actionId, "owner", 1)).toBe("already_cancelled");

    const project = (title: string): ProposedAction => ({
      type: "project.start",
      summary: "立项",
      subjectKey: "msg:p",
      sideEffect: "external",
      proposal: { title, outcome: "", actions: [] },
    });
    const p1 = expectType(f.gate.authorizeSync(project("调研 3 家"), meta("desk")), "defer");
    const p2 = expectType(f.gate.authorizeSync(project("调研 15 家"), meta("desk")), "defer");
    expect(p2.actionId).not.toBe(p1.actionId);
    expect(f.gate.getApprovalSync(p1.actionId)!.status).toBe("superseded");
    // same effect, new wording only → stays the same card
    const p3 = expectType(f.gate.authorizeSync({ ...project("调研 15 家"), summary: "立项（补充背景）" }, meta("desk")), "defer");
    expect(p3.actionId).toBe(p2.actionId);
  });

  it("a defer from another cell (or of another type) supersedes the old card", () => {
    const f = setup();
    withWorker(f);
    f.addCell("w2", "desk", { tools: ["read"], canSendTo: ["channel:feishu:*"], maxTokens: 1000, maxCents: 10, isolation: "git_worktree" });
    const a = expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "project:p1" }), meta("desk")), "defer");
    const b = expectType(f.gate.authorizeSync(send("channel:feishu:oc_2", { subjectKey: "project:p1" }), meta("w2")), "defer");
    expect(b.actionId).not.toBe(a.actionId);
    expect(f.gate.getApprovalSync(a.actionId)).toMatchObject({ status: "superseded", statusReason: `superseded by ${b.actionId}` });
    const c = expectType(
      f.gate.authorizeSync({ type: "custom", name: "merge", summary: "合入", subjectKey: "project:p1", sideEffect: "external" }, meta("w2")),
      "defer",
    );
    expect(f.gate.getApprovalSync(b.actionId)!.status).toBe("superseded");
    expect(f.gate.listPendingSync().map((p) => p.actionId)).toEqual([c.actionId]);
    expect(f.gate.findPendingBySubjectSync("project:p1")!.actionId).toBe(c.actionId);
  });
});

describe("authorize — policy rules", () => {
  it("an auto-allow rule lets an action class through within its use budget, then defers again", () => {
    const f = setup();
    const rule = f.gate.upsertPolicyRuleSync({ match: { type: "channel.send", target: "channel:feishu:*" }, effect: "allow", maxUses: 2, createdBy: "owner" });
    expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "a" }), meta("desk")), "allow");
    expectType(f.gate.authorizeSync(send("channel:feishu:oc_2", { subjectKey: "b" }), meta("desk")), "allow");
    expectType(f.gate.authorizeSync(send("channel:feishu:oc_3", { subjectKey: "c" }), meta("desk")), "defer");
    expect(f.gate.listPolicyRulesSync().find((r) => r.id === rule.id)!.uses).toBe(2);
  });

  it("an allow rule is not charged for actions that would be allowed anyway", () => {
    const f = setup();
    f.gate.upsertPolicyRuleSync({ match: { type: "*" }, effect: "allow", maxUses: 1, createdBy: "owner" });
    expectType(f.gate.authorizeSync(exec("read"), meta("desk")), "allow");
    expectType(f.gate.authorizeSync(exec("read"), meta("desk")), "allow");
    expect(f.gate.listPolicyRulesSync()[0]!.uses).toBe(0);
  });

  it("rules never widen bounds", () => {
    const f = setup();
    withWorker(f);
    f.gate.upsertPolicyRuleSync({ match: { type: "*" }, effect: "allow", createdBy: "owner" });
    expectType(f.gate.authorizeSync(send("channel:feishu:oc_1"), meta("w1")), "deny");
    expectType(f.gate.authorizeSync(exec("code_rpc"), meta("w1")), "deny");
  });

  it("most specific rule wins: nearer scope, exact type, exact target; deny breaks ties", () => {
    const f = setup();
    withWorker(f, "w1", { canSendTo: ["channel:feishu:*"] });
    f.gate.upsertPolicyRuleSync({ match: { type: "channel.send", target: "channel:feishu:*" }, effect: "allow", createdBy: "owner" });
    f.gate.upsertPolicyRuleSync({ match: { type: "channel.send", target: "channel:feishu:oc_boss" }, effect: "deny", note: "老板的群只能人工回", createdBy: "owner" });
    f.gate.upsertPolicyRuleSync({ match: { type: "channel.send" }, effect: "defer", scopeCellId: "w1", createdBy: "owner" });
    expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "a" }), meta("desk")), "allow");
    expect(expectType(f.gate.authorizeSync(send("channel:feishu:oc_boss", { subjectKey: "b" }), meta("desk")), "deny").feedback).toMatch(/老板的群/);
    // the w1-scoped defer rule is nearer than the global allow
    expectType(f.gate.authorizeSync(send("channel:feishu:oc_1", { subjectKey: "c" }), meta("w1")), "defer");

    f.gate.upsertPolicyRuleSync({ match: { type: "workspace.exec", target: "read" }, effect: "allow", createdBy: "owner" });
    f.gate.upsertPolicyRuleSync({ match: { type: "workspace.exec", target: "read" }, effect: "deny", createdBy: "owner" });
    expectType(f.gate.authorizeSync(exec("read"), meta("desk")), "deny");
  });

  it("a defer rule turns an internal action into a card; disabled rules are ignored", () => {
    const f = setup();
    withWorker(f);
    const r = f.gate.upsertPolicyRuleSync({ match: { type: "workspace.exec", target: "bash" }, effect: "defer", createdBy: "owner" });
    expectType(f.gate.authorizeSync(exec("bash"), meta("w1")), "defer");
    f.gate.upsertPolicyRuleSync({ id: r.id, match: r.match, effect: "defer", enabled: false, createdBy: "owner" });
    expectType(f.gate.authorizeSync(exec("bash", { subjectKey: "z" }), meta("w1")), "allow");
  });

  it("rejects malformed rules and rules authored by a cell", () => {
    const f = setup();
    expect(() => f.gate.upsertPolicyRuleSync({ match: { type: "rm" as never }, effect: "allow", createdBy: "owner" })).toThrow(/unknown action type/);
    expect(() => f.gate.upsertPolicyRuleSync({ match: { type: "*" }, effect: "maybe" as never, createdBy: "owner" })).toThrow(/invalid effect/);
    expect(() => f.gate.upsertPolicyRuleSync({ match: { type: "*" }, effect: "allow", createdBy: "cell:desk" })).toThrow(/cell principal/);
    expect(() => f.gate.upsertPolicyRuleSync({ match: { type: "*" }, effect: "allow", maxUses: -1, createdBy: "owner" })).toThrow(/maxUses/);
    expect(() => f.gate.upsertPolicyRuleSync({ match: { type: "*" }, effect: "allow", scopeCellId: "ghost", createdBy: "owner" })).toThrow(/not found/);
    const r = f.gate.upsertPolicyRuleSync({ match: { type: "*" }, effect: "deny", createdBy: "owner" });
    f.gate.deletePolicyRuleSync(r.id);
    expect(f.gate.listPolicyRulesSync()).toEqual([]);
  });
});
