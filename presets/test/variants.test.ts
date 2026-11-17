import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD, type ModelRequest } from "@ng/protocol";
import { boot, cleanupAll, continuesRun, roots, T0, DAY, tool, requestText, type Harness } from "./helpers";

afterEach(cleanupAll);

function lastUserText(req: ModelRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  return (last?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

describe("model-assisted variants keep the books in code", () => {
  it("a watcher that interprets replies: off-topic is handed back to the desk, the real answer is recorded; a timeout's nudge is worded by the model", async () => {
    const h = await boot();
    h.script.add(
      "desk",
      tool("chase_replies", {
        title: "合同回签",
        description: "等法务回复合同修改意见",
        parties: [{ label: "法务老周", to: "channel:memory:zhou", thread: "memory:contract" }],
        dueAt: new Date(T0 + DAY).toISOString(),
        interpret: true,
      }),
      tool("wait", { reason: "ok" }),
    );
    h.script.setDefault("watcher", (req) => {
      if (continuesRun(req)) return { text: "ok" };
      const text = lastUserText(req);
      if (text.includes("顺便问下")) return tool("handback", { reason: "和合同无关的新问题" });
      if (text.includes("合同我看完了")) return tool("record_reply", { summary: "法务同意，只改了违约金条款" });
      if (text.includes("[timer.fired")) return tool("draft_nudge", { text: "周老师好，合同修改意见方便今天给一下吗？谢谢！" });
      return tool("update_watch");
    });
    await h.ui.capture({ text: "盯一下法务对合同的意见" });
    await h.kernel.idle();
    const [root] = roots(h);
    const w = `${root}-p1`;
    expect(h.kernel.getCell(w)?.spec.processor).toMatchObject({ kind: "llm", modelTier: "fast", prompt: "gtd.watcher" });

    // Off-topic: back to the desk, the wait goes on.
    h.script.add("desk", (req) => {
      expect(requestText(req)).toContain("顺便问下");
      return tool("wait", { reason: "noted" });
    });
    await h.memory.inject({ from: "zhou", text: "顺便问下，下周团建去哪？", threads: ["memory:contract"] });
    await h.kernel.idle();
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.handback })).toHaveLength(1);
    expect(h.actions(root)[0]!.waiting!.parties[0]).toMatchObject({ replied: false });

    // Timeout: the model words the nudge; the card carries exactly that text.
    h.clock.set(T0 + DAY);
    await h.kernel.idle();
    const [card] = h.cards();
    expect(card?.clarify.cardType).toBe("escalation");
    expect(h.kernel.context.getArtifactSync(`${w}-nudge`)?.content.body).toBe("周老师好，合同修改意见方便今天给一下吗？谢谢！");

    // The real answer: recorded, the nudge card is taken down, one summary card.
    await h.memory.inject({ from: "zhou", text: "合同我看完了，只改违约金那条", threads: ["memory:contract"] });
    await h.kernel.idle();
    const cards = h.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.clarify).toMatchObject({ cardType: "response", confirmVerb: "accept" });
    expect(h.kernel.context.getArtifactSync(cards[0]!.artifactId!)?.content.body).toContain("法务同意，只改了违约金条款");
    expect(h.memory.deliveries).toEqual([]);
  });

  it("a source filtered by a small model: silent on noise, one hit on a real problem", async () => {
    const h = await boot();
    h.script.add("desk", tool("add_source", { title: "支付反馈", description: "有人反馈付款失败、白屏或扣款异常才算", watchThread: "memory:pay-group" }), tool("wait", { reason: "ok" }));
    h.script.setDefault("sensor", (req) => {
      if (continuesRun(req)) return { text: "ok" };
      const text = lastUserText(req);
      return text.includes("被扣了两次") ? tool("report_hit", { title: "用户反馈重复扣款", summary: "群里有人说同一笔订单被扣了两次", rawInput: "我昨天的订单被扣了两次款" }) : tool("no_hit");
    });
    await h.ui.capture({ text: "帮我盯着支付群，有人反馈付款问题就告诉我" });
    await h.kernel.idle();
    const sensor = h.kernel.listCells({ parentId: "desk", preset: "sensor" })[0]!;
    expect(h.source(sensor.id)).toMatchObject({ kind: "watch", processor: "llm", runCount: 0, hitCount: 0 });
    const deskRuns = h.deskRuns();

    await h.memory.inject({ from: "u1", text: "今天的活动海报真好看", threads: ["memory:pay-group"] });
    await h.kernel.idle();
    expect(h.source(sensor.id)).toMatchObject({ runCount: 1, hitCount: 0 });
    expect(h.deskRuns()).toBe(deskRuns);

    h.script.add("desk", (req) => {
      expect(requestText(req)).toContain("用户反馈重复扣款");
      return tool("archive_notification", { title: "重复扣款反馈（已转给支付组）" });
    }, tool("wait", { reason: "ok" }));
    await h.memory.inject({ from: "u2", text: "我昨天的订单被扣了两次款", threads: ["memory:pay-group"] });
    await h.kernel.idle();
    expect(h.source(sensor.id)).toMatchObject({ runCount: 2, hitCount: 1 });
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.sourceHit })).toHaveLength(1);
    expect(h.activities()).toEqual([expect.objectContaining({ kind: "notification_archived", source: expect.objectContaining({ label: "信源 · 用户反馈重复扣款" }) })]);
  });

  it("a direct line: the worker may message the owner and the owner's replies on its thread reach it, bypassing the desk", async () => {
    const h = await boot();
    h.script.add("desk", tool("delegate", { title: "写周报初稿", instruction: "写本周周报，有疑问直接问我", research: true, directLine: true }), tool("wait", { reason: "ok" }));
    h.script.add("worker", tool("send_message", { to: "channel:ui:owner", text: "周报要包含招聘进展吗？", summary: "question" }), tool("wait", { reason: "asked" }));
    await h.ui.capture({ text: "帮我写本周周报" });
    await h.kernel.idle();
    const [root] = roots(h);
    const worker = h.kernel.listCells({ parentId: root! })[0]!;
    expect(worker.bounds.canSendTo).toEqual(expect.arrayContaining(["channel:ui:owner", `inbox:${root}`]));
    expect(h.notices()).toContain("周报要包含招聘进展吗？");
    expect(h.cards()).toEqual([]);

    const deskRuns = h.deskRuns();
    h.script.add("worker", (req) => {
      expect(requestText(req)).toContain("要，简单写两句");
      return tool("report_to_parent", { kind: "result", text: "周报初稿已写好，含招聘进展" });
    });
    const r = await h.ui.capture({ text: "要，简单写两句", threads: [`ui:${root}`] });
    expect(r).toBeDefined();
    await h.kernel.idle();
    expect(h.deskRuns()).toBe(deskRuns);
    expect(h.cards()).toHaveLength(1);
  });
});
