import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD, subjectKeys, type ResponseCard } from "@ng/protocol";
import { KEYS, type ReplyItem } from "../src";
import { boot, cleanupAll, MIN, requestText, tool } from "./helpers";

afterEach(cleanupAll);

describe("docs/03 §四 row 3 — a colleague's question: one draft card, version-checked send", () => {
  it("question → draft → card → revise (same card, v2) → stale click refused → approve v2 → sent → recorded", async () => {
    const h = await boot();
    h.script.add(
      "desk",
      tool("search_history", { query: "限流" }),
      tool("draft_reply", {
        text: "目前网关限流是每实例 100 QPS。",
        title: "回复张三：网关限流阈值",
        targetLabel: "研发群",
        prep: { summary: "查了网关配置和上周的变更记录", checked: [{ label: "gateway.yaml", uri: "note://gateway" }] },
      }),
    );
    const q = await h.memory.inject({ from: "zhangsan", replyTarget: "grp-1", text: "@owner 网关的限流阈值现在是多少？", threads: ["memory:grp-1"] });
    await h.kernel.idle();

    let cards = h.cards();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    const subjectKey = subjectKeys.inbound(q.id);
    expect(card).toMatchObject({ cellId: "desk", subjectKey, boundVersion: 1, status: "pending" });
    expect(card.clarify).toMatchObject({
      cardType: "response",
      title: "回复张三：网关限流阈值",
      source: { label: "测试通道", channelId: "memory", envelopeId: q.id },
      rawInput: { text: "@owner 网关的限流阈值现在是多少？", kind: "message" },
      prep: { summary: "查了网关配置和上周的变更记录", checked: [{ label: "gateway.yaml", uri: "note://gateway" }] },
      draft: { version: 1 },
      reply: { target: "channel:memory:grp-1", targetLabel: "研发群" },
      confirmVerb: "send",
    });
    expect(h.memory.deliveries).toEqual([]);
    expect(h.of("run.finished").filter((e) => e.cellId === "desk").map((e) => e.outcome)).toEqual(["deferred_for_approval"]);

    // 🎙 口述修改 → the desk redrafts; the same card shows v2 with the original source and question.
    h.script.add("desk", (req) => {
      expect(requestText(req)).toContain("语气正式一点");
      return tool("draft_reply", { text: "您好，目前网关限流为每实例 100 QPS；如需临时上调可以提申请。" });
    });
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "revise", instruction: "语气正式一点，并说明可以申请临时上调" })).toMatchObject({ status: "revising" });
    await h.kernel.idle();
    cards = h.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ actionId: card.actionId, subjectKey, boundVersion: 2 });
    expect(cards[0]!.clarify).toMatchObject({
      draft: { artifactId: card.artifactId, version: 2 },
      source: { label: "测试通道", envelopeId: q.id },
      rawInput: { text: "@owner 网关的限流阈值现在是多少？" },
      reply: { target: "channel:memory:grp-1", targetLabel: "研发群" },
    });

    // A click on what the owner saw before the redraft is refused; nothing goes out.
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "approve", seenArtifactVersion: 1 })).toMatchObject({ status: "version_mismatch", currentVersion: 2 });
    expect(h.memory.deliveries).toEqual([]);

    expect(await h.kernel.resolveApproval(card.actionId, { decision: "approve", seenArtifactVersion: 2 })).toEqual({ status: "sent", actionId: card.actionId, artifactVersion: 2 });
    expect(h.memory.sent.map((d) => [d.target, d.content.body])).toEqual([["grp-1", "您好，目前网关限流为每实例 100 QPS；如需临时上调可以提申请。"]]);
    await h.kernel.idle();

    expect(h.cards()).toEqual([]);
    expect(h.activities()).toEqual([
      expect.objectContaining({ kind: "action_completed", title: "已回复研发群：回复张三：网关限流阈值", actionId: card.actionId, restorable: false, source: expect.objectContaining({ label: "测试通道" }) }),
    ]);
    expect(h.state<ReplyItem>("desk", KEYS.reply(subjectKey))).toMatchObject({ status: "sent" });
  });

  it("someone else answers in the group first: the card is withdrawn and archived (restorable)", async () => {
    const h = await boot();
    h.script.add("desk", tool("draft_reply", { text: "部署窗口是周四晚上 10 点。", title: "回复李四：部署窗口" }));
    const q = await h.memory.inject({ from: "lisi", replyTarget: "grp-2", text: "这周的部署窗口是什么时候？", threads: ["memory:grp-2"] });
    await h.kernel.idle();
    const [card] = h.cards();
    expect(card).toBeDefined();

    // Ten minutes later Wangwu answers in the same thread; it reaches the desk, which takes the card down.
    h.clock.advance(10 * MIN);
    h.script.add("desk", (req) => {
      expect(requestText(req)).toContain("周四晚上 10 点，我刚确认过");
      return tool("withdraw_card", { reason: "群里王五已经回答了" });
    }, tool("wait", { reason: "withdrawn" }));
    await h.memory.inject({ from: "wangwu", replyTarget: "grp-2", text: "@lisi 周四晚上 10 点，我刚确认过", threads: ["memory:grp-2"] });
    await h.kernel.idle();

    expect(h.cards()).toEqual([]);
    expect(h.kernel.gate.getApprovalSync(card!.actionId)).toMatchObject({ status: "cancelled", statusReason: "群里王五已经回答了" });
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", seenArtifactVersion: 1 })).toMatchObject({ status: "already_cancelled" });
    expect(h.memory.deliveries).toEqual([]);
    const [a] = h.activities();
    expect(a).toMatchObject({
      kind: "card_withdrawn",
      title: "已撤下：回复李四：部署窗口",
      detail: "群里王五已经回答了",
      actionId: card!.actionId,
      restorable: true,
      rawInput: "这周的部署窗口是什么时候？",
      envelope: { id: q.id, type: PAYLOAD.userMessage },
    });
    expect(h.notices()).toEqual([]); // archived silently
  });

  it("one card per item: drafting twice for the same message updates the card instead of adding one", async () => {
    const h = await boot();
    h.script.add("desk", tool("draft_reply", { text: "初稿", title: "回复：报销流程" }));
    await h.memory.inject({ from: "hr", text: "报销流程改了吗？" });
    await h.kernel.idle();
    const [first] = h.cards();
    // The same message comes back (handed back by a helper, or re-delivered): the desk drafts again.
    h.script.add("desk", tool("draft_reply", { text: "二稿：流程没变，单据照旧提交即可。" }));
    h.kernel.inbox.enqueueSync("desk", {
      id: `${first!.clarify.source.envelopeId}#handback#x`,
      from: "kernel:handback",
      principalId: "memory:hr",
      kind: "event",
      type: PAYLOAD.handback,
      payload: { original: h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage })[0]!.envelope, fromCellId: "x", reason: "re-triage" },
      createdAt: h.clock.now(),
    });
    await h.kernel.idle();
    const cards = h.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ actionId: first!.actionId, boundVersion: 2 });
    expect((cards[0]!.clarify as ResponseCard).reply.target).toBe("channel:memory:hr");
  });
});
