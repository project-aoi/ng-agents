import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD, type ApprovalResolvedPayload } from "@ng/protocol";
import { boot, cleanupAll, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

const resolvedOf = (h: Harness, cellId = "desk") =>
  h.kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.approvalResolved }).map((m) => ({ row: m.status, ...(m.envelope.payload as ApprovalResolvedPayload) }));

describe("resolveApproval — approve", () => {

  it("a project proposal is approved and handed back to the owning cell", async () => {
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
