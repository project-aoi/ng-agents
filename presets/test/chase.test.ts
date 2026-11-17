import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD, subjectKeys, type EscalationCard } from "@ng/protocol";
import { KEYS, type WatcherState } from "../src";
import { boot, cleanupAll, DAY, HOUR, roots, T0, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

const SUPPLIERS = ["A", "B", "C"] as const;

async function startChase(h: Harness, extra: Record<string, unknown> = {}): Promise<{ root: string; watcher: (s: string) => string }> {
  h.script.add(
    "desk",
    tool("chase_replies", {
      title: "办公椅采购比价",
      description: "等待供应商报价回信",
      parties: SUPPLIERS.map((s) => ({ label: `供应商 ${s}`, to: `channel:memory:sup${s}`, thread: `memory:quote-${s}`, principalId: `memory:sup${s}` })),
      waitHours: 24,
      ...extra,
    }),
    tool("wait", { reason: "chasing" }),
  );
  await h.ui.capture({ text: "帮我盯 A/B/C 三家供应商的办公椅报价，明天这个时候前要齐" });
  await h.kernel.idle();
  const [root] = roots(h);
  const watcher = (s: string) => `${root}-p${SUPPLIERS.indexOf(s as never) + 1}`;
  return { root: root!, watcher };
}

const reply = (h: Harness, s: string, text: string) => h.memory.inject({ from: `sup${s}`, text, threads: [`memory:quote-${s}`] });

describe("docs/03 §四 row 5 — chase three suppliers: one row, partial progress, one card at a time", () => {
  it("2/3 replies, an early reply cancels its timeout, the late one gets a nudge card; after the nudge and the last reply one summary card; accepting completes it", async () => {
    const h = await boot();
    const { root, watcher } = await startChase(h);

    expect(h.project(root)).toMatchObject({ title: "办公椅采购比价", lifecycle: "active" });
    let [act] = h.actions(root);
    expect(act).toMatchObject({
      title: "等待供应商报价回信",
      owner: "waiting",
      status: "open",
      dueAt: T0 + DAY,
      progress: { done: 0, total: 3, label: "已回" },
      waiting: {
        description: "等待供应商报价回信",
        join: "all",
        dueAt: T0 + DAY,
        parties: [
          { id: "p1", label: "供应商 A", replied: false, dueAt: T0 + DAY },
          { id: "p2", label: "供应商 B", replied: false, dueAt: T0 + DAY },
          { id: "p3", label: "供应商 C", replied: false, dueAt: T0 + DAY },
        ],
      },
    });
    for (const s of SUPPLIERS) {
      expect(h.kernel.getCell(watcher(s))).toMatchObject({ preset: "watcher", status: "active" });
      expect(h.kernel.inbox.listMessagesSync({ cellId: watcher(s), type: PAYLOAD.timerFired, status: ["pending"] })).toHaveLength(1);
    }
    expect(h.notices()).toEqual(["已开始跟进：等待供应商报价回信（3 方，11月18日周三 09:00 到期）"]);
    const deskRuns = h.deskRuns();

    // A and B reply early: straight to their watchers (the desk never sees them); their timeouts are cancelled.
    h.clock.set(T0 + HOUR);
    await reply(h, "A", "A 报价：每把 680 元，含税");
    h.clock.set(T0 + 2 * HOUR);
    await reply(h, "B", "B：620 元/把，两周交货");
    await h.kernel.idle();
    expect(h.deskRuns()).toBe(deskRuns);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage })).toHaveLength(1);
    for (const s of ["A", "B"]) {
      expect(h.kernel.inbox.listMessagesSync({ cellId: watcher(s), type: PAYLOAD.timerFired }).map((m) => m.status)).toEqual(["cancelled"]);
      expect(h.kernel.getCell(watcher(s))?.status).toBe("closed");
    }
    [act] = h.actions(root);
    expect(act).toMatchObject({ owner: "waiting", progress: { done: 2, total: 3 } });
    expect(act!.waiting!.parties.map((p) => [p.label, p.replied, p.repliedAt ?? null])).toEqual([
      ["供应商 A", true, T0 + HOUR],
      ["供应商 B", true, T0 + 2 * HOUR],
      ["供应商 C", false, null],
    ]);
    expect(h.state(root, "cell:status")).toMatchObject({ text: "等待供应商报价回信 已回 2/3" });
    expect(h.cards()).toEqual([]);

    // C's deadline passes: one escalation card with the prepared nudge; the ball is with the owner meanwhile.
    h.clock.set(T0 + DAY);
    await h.kernel.idle();
    let cards = h.cards();
    expect(cards).toHaveLength(1);
    const nudge = cards[0]!;
    expect(nudge).toMatchObject({ cellId: watcher("C"), subjectKey: subjectKeys.project(root) });
    const esc = nudge.clarify as EscalationCard;
    expect(esc).toMatchObject({
      cardType: "escalation",
      title: "供应商 C还没回复：等待供应商报价回信",
      source: { label: "随手记" },
      rawInput: { text: "帮我盯 A/B/C 三家供应商的办公椅报价，明天这个时候前要齐" },
      escalation: { reason: "waiting_timeout", nudgeTarget: "channel:memory:supC", nudgeDraft: { version: 1 }, waiting: { parties: [{ replied: true }, { replied: true }, { replied: false }] } },
    });
    expect(esc.escalation.explanation).toContain("已回 2/3");
    [act] = h.actions(root);
    expect(act).toMatchObject({ owner: "human", nextStep: "在待确认里决定是否催问供应商 C" });

    // "✓ 发送催问并继续跟进": the nudge goes out, a new check is set a day later, the ball goes back to C.
    const sent = await h.kernel.resolveApproval(nudge.actionId, { decision: "approve", seenArtifactVersion: 1 });
    expect(sent).toMatchObject({ status: "sent" });
    expect(h.memory.sent.map((d) => [d.target, d.content.body])).toEqual([["supC", "您好，想跟进一下：等待供应商报价回信。方便的话请回复一下，谢谢！"]]);
    await h.kernel.idle();
    expect(h.cards()).toEqual([]);
    [act] = h.actions(root);
    expect(act).toMatchObject({ owner: "waiting" });
    expect(act!.waiting!.parties[2]).toMatchObject({ replied: false, dueAt: T0 + 2 * DAY });
    expect(h.state<WatcherState>(watcher("C"), KEYS.watcher)).toMatchObject({ status: "waiting", nudges: 1, dueAt: T0 + 2 * DAY });
    expect(h.kernel.inbox.listMessagesSync({ cellId: watcher("C"), type: PAYLOAD.timerFired, status: ["pending"] }).map((m) => m.deliverAt)).toEqual([T0 + 2 * DAY]);

    // C replies before the next check: 3/3 → one summary card for the whole item.
    h.clock.set(T0 + DAY + 2 * HOUR);
    await reply(h, "C", "C：590 元/把，现货");
    await h.kernel.idle();
    expect(h.kernel.inbox.listMessagesSync({ cellId: watcher("C"), type: PAYLOAD.timerFired }).map((m) => m.status).sort()).toEqual(["cancelled", "done"]);
    cards = h.cards();
    expect(cards).toHaveLength(1);
    const summary = cards[0]!;
    expect(summary).toMatchObject({ cellId: root, subjectKey: subjectKeys.project(root) });
    expect(summary.clarify).toMatchObject({ cardType: "response", confirmVerb: "accept", title: "等待供应商报价回信：已回 3/3" });
    const body = h.kernel.context.getArtifactSync(summary.artifactId!)!.content.body;
    expect(body).toContain("**供应商 A**：A 报价：每把 680 元，含税");
    expect(body).toContain("**供应商 B**：B：620 元/把，两周交货");
    expect(body).toContain("**供应商 C**：C：590 元/把，现货");
    [act] = h.actions(root);
    expect(act).toMatchObject({ owner: "human", status: "open", progress: { done: 3, total: 3 }, nextStep: "在待确认里查看结果并确认" });
    expect(act!.waiting!.parties.every((p) => p.replied)).toBe(true);

    expect(await h.kernel.resolveApproval(summary.actionId, { decision: "approve", seenArtifactVersion: 1 })).toMatchObject({ status: "approved" });
    await h.kernel.idle();
    expect(h.actions(root)).toEqual([expect.objectContaining({ status: "done" })]);
    expect(h.project(root)).toMatchObject({ lifecycle: "completed" });
    expect(h.kernel.getCell(root)?.status).toBe("closed");
    // Exactly two cards in the item's whole life: the nudge, then the summary.
    expect(h.kernel.gate.listApprovalsSync({ subjectKey: subjectKeys.project(root) })).toHaveLength(2);
    // Zero tokens: no watcher or root ever called a model.
    expect(h.script.requests.filter((r) => r.role !== "desk")).toEqual([]);
  });

  it("“⏱ 再等 1 天” moves the deadline without sending; “✓ 线下已解决” settles that party and completes the wait", async () => {
    const h = await boot();
    const { root, watcher } = await startChase(h);
    await reply(h, "A", "A：700");
    await reply(h, "B", "B：650");
    h.clock.set(T0 + DAY);
    await h.kernel.idle();
    let [card] = h.cards();
    expect(card?.cellId).toBe(watcher("C"));

    const until = T0 + 2 * DAY + 3 * HOUR;
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "continue", until })).toMatchObject({ status: "continued" });
    await h.kernel.idle();
    expect(h.memory.sent).toEqual([]);
    expect(h.cards()).toEqual([]);
    expect(h.actions(root)[0]!.waiting!.parties[2]).toMatchObject({ dueAt: until, replied: false });
    expect(h.actions(root)[0]).toMatchObject({ owner: "waiting" });

    // Still nothing at the new deadline → a second nudge card; this time the owner settled it offline.
    h.clock.set(until);
    await h.kernel.idle();
    [card] = h.cards();
    expect(card?.cellId).toBe(watcher("C"));
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "resolve_offline" })).toMatchObject({ status: "resolved_offline", closedCellIds: [watcher("C")] });
    await h.kernel.idle();
    const [act] = h.actions(root);
    expect(act).toMatchObject({ owner: "human", progress: { done: 3, total: 3 } });
    const summary = h.cards();
    expect(summary).toHaveLength(1);
    expect(h.kernel.context.getArtifactSync(summary[0]!.artifactId!)!.content.body).toContain("**供应商 C**：已标记为线下解决");
  });

  it("join any: the first reply completes the wait and stops the other watchers", async () => {
    const h = await boot();
    const { root, watcher } = await startChase(h, { join: "any", description: "等任意一家报价" });
    await reply(h, "B", "B：600");
    await h.kernel.idle();
    expect(SUPPLIERS.map((s) => h.kernel.getCell(watcher(s))?.closeReason)).toEqual(["cancelled", "completed", "cancelled"]);
    const [card] = h.cards();
    expect(card?.clarify.title).toBe("等任意一家报价：已回 1/3");
    expect(h.actions(root)[0]).toMatchObject({ owner: "human" });
  });
});
