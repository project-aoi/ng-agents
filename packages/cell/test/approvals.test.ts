import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD, type ApprovalResolvedPayload } from "@ng/protocol";
import { boot, cleanupAll, HOUR, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

/** The desk drafts a reply to alice; returns the pending card. */
async function draftReply(h: Harness, text = "草稿 v1") {
  h.script.add("desk", tool("send_message", { to: "channel:memory:alice", text, summary: "reply to Alice" }));
  await h.memory.inject({ from: "alice", text: "问个问题" });
  await h.kernel.idle();
  const [card] = h.kernel.gate.listPendingSync();
  if (!card) throw new Error("no card");
  return card;
}

const resolvedOf = (h: Harness, cellId = "desk") =>
  h.kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.approvalResolved }).map((m) => ({ row: m.status, ...(m.envelope.payload as ApprovalResolvedPayload) }));

describe("resolveApproval — approve", () => {
  it("unknown is reported as is, kept visible on the record, and never re-sent; the owner can record what they verified", async () => {
    const h = await boot();
    const card = await draftReply(h);
    h.memory.respondWith("unknown");
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({ status: "unknown", artifactVersion: 1 });
    expect(h.kernel.gate.getApprovalSync(card.actionId)).toMatchObject({ status: "unknown", outcome: { receipt: "unknown" } });
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({ status: "unknown" });
    expect(h.memory.deliveries).toHaveLength(1);

    expect(h.kernel.resolveUnknownSend(card.actionId, "sent", { approverId: "owner", seenAttempt: 1, seenItemRevision: h.kernel.gate.getApprovalSync(card.actionId)!.itemRevision, note: "对方说收到了" })).toBe("resolved");
    expect(h.kernel.gate.getApprovalSync(card.actionId)!.status).toBe("executed");
    expect(h.kernel.hub.getOutboxSync(card.actionId)!.status).toBe("sent");
  });

  it("puts an unknown standing send_message in the outbox and keeps its verification card visible", async () => {
    const h = await boot();
    h.kernel.gate.upsertPolicyRuleSync({match:{type:"channel.send",target:"channel:memory:*"},effect:"allow",createdBy:"owner"});
    h.memory.respondWith("unknown");
    h.script.add("desk",tool("send_message",{to:"channel:memory:alice",text:"文件已发送",summary:"回复 Alice",subjectKey:"thread:files"}));
    await h.memory.inject({from:"alice",text:"请发文件"});
    await h.kernel.idle();
    const [item] = h.kernel.humanItems.list();
    expect(item).toMatchObject({status:"unknown",subjectKey:"thread:files",attempt:1});
    expect(h.kernel.hub.listOutboxSync({channelId:"memory"})).toMatchObject([{actionId:item!.id,status:"unknown"}]);
  });

  it("failed can be retried by approving again", async () => {
    const h = await boot();
    const card = await draftReply(h);
    h.memory.respondWith("failed");
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({ status: "failed" });
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({ status: "sent" });
    expect(h.memory.deliveries.map((d) => d.outcome)).toEqual(["failed", "sent"]);
    await h.kernel.idle();
    expect(resolvedOf(h).map((r) => r.status)).toEqual(["failed", "executed"]);
  });

  it("an approval made during focus still gets a real receipt (DND only holds notifications)", async () => {
    const h = await boot();
    const card = await draftReply(h);
    h.kernel.hub.setFocusSync(true);
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({ status: "sent" });
    expect(h.memory.sent).toHaveLength(1);
  });

  it("two concurrent clicks send once and both get the receipt", async () => {
    const h = await boot();
    const card = await draftReply(h);
    const [a, b] = await Promise.all([
      h.kernel.resolveApproval(card.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 }),
      h.kernel.resolveApproval(card.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 }),
    ]);
    expect(a).toMatchObject({ status: "sent" });
    expect(b).toMatchObject({ status: "sent" });
    expect(h.memory.deliveries).toHaveLength(1);
  });

  it("a card of a cancelled task cannot be approved; unknown ids are reported", async () => {
    const h = await boot();
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", bounds: { canSendTo: ["channel:memory:*"] } });
    h.script.add("worker", tool("send_message", { to: "channel:memory:bob", text: "hi bob", summary: "ping bob" }));
    h.kernel.inbox.enqueueSync("w", { id: "go", from: "inbox:desk", principalId: "cell:desk", kind: "event", type: PAYLOAD.userMessage, payload: { text: "go" }, createdAt: h.clock.now() });
    await h.kernel.idle();
    const [card] = h.kernel.gate.listPendingSync();
    expect(card!.cellId).toBe("w");
    h.kernel.control("w", { action: "cancel" });
    await h.kernel.idle();
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({ status: "already_cancelled" });
    expect(h.memory.deliveries).toEqual([]);
    expect(await h.kernel.resolveApproval("act_nope", { decision: "approve", approverId: "owner" })).toEqual({ status: "not_found", actionId: "act_nope" });
  });

  it("a non-send action (project.start) is approved and handed back to the owning cell", async () => {
    const h = await boot();
    h.script.add("desk", tool("request_approval", { kind: "project", title: "官网改版", summary: "propose a project", proposal: { outcome: "新官网上线", actions: [{ title: "出设计稿", owner: "agent" }] } }));
    await h.ui.capture({ text: "我想把官网改版" });
    await h.kernel.idle();
    const [card] = h.kernel.gate.listPendingSync();
    expect(card!.action.type).toBe("project.start");
    h.script.add("desk", { text: "creating the project" });
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: card!.boundVersion! })).toEqual({ status: "approved", actionId: card!.actionId });
    await h.kernel.idle();
    expect(resolvedOf(h)).toEqual([expect.objectContaining({ row: "done", status: "approved" })]);
  });
});

describe("owner addresses", () => {
  it("one list decides for both the Gate and the comms tool: the owner's own phone is a notice, not a card", async () => {
    const h = await boot({ kernel: { ownerAddresses: ["channel:ui:*", "channel:memory:owner-phone"] } });
    h.script.add(
      "desk",
      tool("send_message", { to: "channel:memory:owner-phone", text: "你的快递到了", summary: "notify owner" }),
      tool("send_message", { to: "channel:memory:alice", text: "hi", summary: "to Alice" }),
    );
    await h.ui.capture({ text: "快递到了告诉我，顺便和 Alice 打个招呼" });
    await h.kernel.idle();
    expect(h.memory.sent.map((d) => d.target)).toEqual(["owner-phone"]);
    const cards = h.kernel.gate.listPendingSync();
    expect(cards.map((c) => (c.action as { target: string }).target)).toEqual(["channel:memory:alice"]);
    // an owner notice is never saved as a draft; the outward message is
    expect(h.kernel.context.listArtifactsSync("desk")).toHaveLength(1);
  });
});

describe("resolveApproval — the other buttons", () => {
  it("snooze hides the card and brings it back at `until` without running the model", async () => {
    const h = await boot();
    const card = await draftReply(h);
    const calls = h.script.requests.length;
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "snooze", approverId: "owner", until: h.clock.now() + 4 * HOUR })).toMatchObject({ status: "snoozed" });
    expect(h.kernel.gate.listPendingSync()).toEqual([]);
    expect(h.kernel.stats()).toMatchObject({ pendingApprovals: 0, snoozedApprovals: 1 });

    h.clock.advance(4 * HOUR);
    await h.kernel.idle();
    expect(h.kernel.gate.listPendingSync().map((a) => a.actionId)).toEqual([card.actionId]);
    expect(h.of("approval.changed").filter((e) => e.actionId === card.actionId && e.status === "pending").length).toBeGreaterThanOrEqual(2);
    expect(h.script.requests.length).toBe(calls);
  });

  it("revise wakes the owning cell, which redrafts; the same card now shows the new version", async () => {
    const h = await boot();
    const card = await draftReply(h);
    h.script.add(
      "desk",
      (req) => {
        expect(JSON.stringify(req.messages)).toContain("语气再正式一点");
        return tool("save_artifact", { artifactId: card.artifactId!, expectedVersion: 1, body: "草稿 v2（更正式）", format: "text" });
      },
      tool("send_message", { to: "channel:memory:alice", artifactId: card.artifactId!, summary: "reply to Alice", subjectKey: card.subjectKey }),
    );
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "revise", approverId: "owner", instruction: "语气再正式一点", voice: true })).toMatchObject({ status: "revising" });
    await h.kernel.idle();
    const pending = h.kernel.gate.listPendingSync();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ actionId: card.actionId, boundVersion: 2 });
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 2 })).toMatchObject({ status: "sent", artifactVersion: 2 });
    expect(h.memory.sent[0]!.content.body).toBe("草稿 v2（更正式）");
  });

  it("deny tells the cell (a wake-up); dismiss wakes it too; deciding twice is not_pending", async () => {
    const h = await boot();
    const card = await draftReply(h);
    h.script.add("desk", { text: "ok, dropped" });
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "deny", approverId: "owner", reason: "不用回了" })).toMatchObject({ status: "denied" });
    await h.kernel.idle();
    expect(resolvedOf(h)).toEqual([expect.objectContaining({ row: "done", status: "denied", note: "不用回了" })]);
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "dismiss", approverId: "owner" })).toMatchObject({ status: "not_pending" });

    const runs = h.of("run.started").length;
    const card2 = await draftReply(h, "另一份草稿");
    expect(await h.kernel.resolveApproval(card2.actionId, { decision: "dismiss", approverId: "owner" })).toMatchObject({ status: "dismissed" });
    await h.kernel.idle();
    expect(h.of("run.started").length).toBe(runs + 2); // drafting and notifying the issuering Run, nothing for the dismissal
    expect(h.kernel.gate.getApprovalSync(card2.actionId)!.status).toBe("cancelled");
  });

  it("continue on a watcher's nudge card withdraws the send and wakes the watcher to keep waiting", async () => {
    const h = await boot();
    h.kernel.spawnCell("desk", { id: "w", preset: "watcher", bounds: { canSendTo: ["channel:memory:*"] } });
    h.script.add("watcher", tool("send_message", { to: "channel:memory:bob", text: "Bob，报价方便今天给吗？", summary: "nudge Bob", nudge: { explanation: "Bob 已经 2 天没回" } }));
    h.kernel.inbox.enqueueSync("w", { id: "timeout", from: "timer:w", principalId: "cell:w", kind: "event", type: PAYLOAD.timerFired, payload: { label: "timeout" }, createdAt: h.clock.now() });
    await h.kernel.idle();
    const [card] = h.kernel.gate.listPendingSync();
    expect((card!.card.data as { cardType: string }).cardType).toBe("escalation");
    h.script.add("watcher", { text: "waiting one more day" });
    const until = h.clock.now() + 24 * HOUR;
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "continue", approverId: "owner", until })).toMatchObject({ status: "continued" });
    await h.kernel.idle();
    expect(h.memory.deliveries).toEqual([]);
    expect(resolvedOf(h, "w")).toEqual([expect.objectContaining({ row: "done", status: "cancelled", decision: "continue", until })]);
  });
});

it.each([true, false])("verification preserves a retry unless its successor is still waiting (withdrawn=%s)", async (withdrawn) => {
  const h = await boot();
  const card = await draftReply(h);
  h.memory.respondWith("unknown");
  await h.kernel.resolveApproval(card.actionId, {decision:"approve", approverId:"owner", seenArtifactVersion:1});
  const next = h.kernel.gate.authorizeSync(card.action, {principalId:"cell:desk", cellId:"desk", epoch:card.epoch});
  if (next.type !== "defer") throw Error(next.type);
  if (withdrawn) expect(h.kernel.gate.withdrawSync(next.actionId, "withdrawn")).toBe("cancelled");
  const revision = h.kernel.humanItems.get(card.actionId)!.itemRevision;
  expect(h.kernel.resolveUnknownSend(card.actionId, "failed", {approverId:"owner", seenAttempt:1, seenItemRevision:revision})).toBe("resolved");
  expect(h.kernel.gate.getApprovalSync(card.actionId)?.status).toBe(withdrawn ? "failed" : "superseded");
  if (withdrawn) {
    expect(await h.kernel.resolveApproval(card.actionId, {decision:"approve", approverId:"owner", seenArtifactVersion:1})).toMatchObject({status:"sent"});
  } else {
    expect(h.of("approval.changed")).toContainEqual(expect.objectContaining({actionId:card.actionId, status:"superseded"}));
    expect(h.kernel.humanItems.list().map(item => item.id)).toContain(next.actionId);
  }
});

it("releases the outbox attempt for recovery if recording the delivered approval rolls back", async () => {
  const h = await boot();
  const card = await draftReply(h);
  h.kernel.db.exec("CREATE TEMP TRIGGER reject_test_outcome BEFORE UPDATE OF disposition ON human_items WHEN NEW.disposition='executed' BEGIN SELECT RAISE(ABORT, 'injected finalization failure'); END");
  await expect(h.kernel.resolveApproval(card.actionId, {decision:"approve", approverId:"owner", seenArtifactVersion:1})).rejects.toThrow("injected finalization failure");
  expect(h.kernel.hub.recoverInterruptedSync()).toBe(1);
  expect(h.kernel.hub.getOutboxSync(card.actionId)?.status).toBe("unknown");
  expect(h.memory.deliveries).toHaveLength(1);
});

it("wakes the issuer of a superseded card in the transaction that creates its replacement", async () => {
  const {kernel} = await boot({start:false});
  const meta = {cellId:"desk", epoch:0, principalId:"cell:desk"};
  const request = (name:string) => kernel.gate.authorizeSync({
    type:"custom", name, sideEffect:"external", summary:name, subjectKey:"arb:proposal",
  }, meta);
  const old = request("publish");
  if (old.type !== "defer") throw Error(old.type);
  const next = request("review");
  if (next.type !== "defer") throw Error(next.type);
  expect(kernel.humanItems.list().map(item => item.id)).toEqual([next.actionId]);
  const receipts = kernel.inbox.listMessagesSync({cellId:"desk", type:PAYLOAD.approvalResolved});
  expect(receipts.map(r => r.envelope)).toMatchObject([{delivery:"wakeup", payload:{actionId:old.actionId, status:"superseded"}}]);
});
