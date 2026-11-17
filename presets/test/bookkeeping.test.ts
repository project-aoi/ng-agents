import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, type ActionRecord } from "@ng/protocol";
import { awaitsCard, KEYS, startApprovedProjectSync, syncItemAfterOwnerChangeSync, type CoordinatorState, type ReplyItem } from "../src";
import { boot, cleanupAll, roots, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

const coordinator = (h: Harness, root: string) => h.state<CoordinatorState>(root, KEYS.coordinator);

async function proposeProject(h: Harness, actions: Array<{ title: string; owner: "agent" | "human" | "waiting"; effort?: "15m" }>) {
  h.script.add("desk", tool("propose_project", { title: "官网改版", outcome: "新版官网上线", actions, research: true }));
  await h.ui.capture({ text: "官网该改版了，帮我规划一下" });
  await h.kernel.idle();
  const [card] = h.cards();
  expect(card?.clarify.cardType).toBe("project_proposal");
  return card!;
}

describe("the desk's books never depend on the model calling a tool", () => {
  it("an approved proposal starts at once from the confirm click (sync), and the desk's own catch-up is a no-op", async () => {
    const h = await boot();
    const card = await proposeProject(h, [{ title: "拉一份现有页面清单", owner: "agent" }, { title: "和市场部对齐风格", owner: "human", effort: "15m" }]);
    const deskCalls = h.script.callsOf("desk").length;
    h.script.setDefault("worker", () => tool("wait", { reason: "working" }));

    expect(startApprovedProjectSync(h.kernel, card.actionId)).toBeNull(); // not approved yet
    // Hold the desk so its own wake-up cannot get there first: the click alone must create the project.
    expect(h.kernel.control("desk", { action: "pause" })).toMatchObject({ applied: true });
    expect(await h.kernel.resolveApproval(card.actionId, { decision: "approve", seenArtifactVersion: 1 })).toMatchObject({ status: "approved" });
    const started = startApprovedProjectSync(h.kernel, card.actionId);
    expect(started).toMatchObject({ started: true });
    // In the same synchronous step: the root exists with the approved plan queued as its first task.
    expect(h.kernel.getCell(started!.rootId)).toMatchObject({ parentId: "desk", status: "active", title: "官网改版" });
    expect(startApprovedProjectSync(h.kernel, card.actionId)).toEqual({ rootId: started!.rootId, started: false });

    h.kernel.control("desk", { action: "resume" });
    await h.kernel.idle();
    expect(roots(h)).toEqual([started!.rootId]);
    expect(h.project(started!.rootId)).toMatchObject({ title: "官网改版", lifecycle: "active" });
    expect(h.actions(started!.rootId).map((a) => [a.title, a.owner])).toEqual([
      ["拉一份现有页面清单", "agent"],
      ["和市场部对齐风格", "human"],
    ]);
    // The approval.resolved wake-up was pure bookkeeping: no model call, no second project.
    expect(h.script.callsOf("desk")).toHaveLength(deskCalls);
  });

  it("without the sync start, the approval wake-up starts the project before (and without) the model", async () => {
    const h = await boot();
    const card = await proposeProject(h, [{ title: "和市场部对齐风格", owner: "human" }]);
    const deskCalls = h.script.callsOf("desk").length;
    await h.kernel.resolveApproval(card.actionId, { decision: "approve", seenArtifactVersion: 1 });
    await h.kernel.idle();
    expect(roots(h)).toHaveLength(1);
    expect(h.script.callsOf("desk")).toHaveLength(deskCalls);
    expect(h.notices()).toContain("已立项：官网改版，后台开始推进");
  });

  it("the owner checking off a project's last action completes it (the root is told to re-check its books)", async () => {
    const h = await boot();
    const card = await proposeProject(h, [{ title: "和市场部对齐风格", owner: "human" }]);
    await h.kernel.resolveApproval(card.actionId, { decision: "approve", seenArtifactVersion: 1 });
    await h.kernel.idle();
    const [root] = roots(h);
    const [act] = h.actions(root);
    // What the app's "✓ 已办完" does: mark it done, and in the same transaction wake the root.
    const t = h.clock.now();
    const done: ActionRecord = { ...act!, status: "done", completedAt: t, updatedAt: t };
    h.kernel.context.commitSync(root!, { statePatches: { [gtdKeys.action(act!.id)]: done } });
    expect(syncItemAfterOwnerChangeSync(h.kernel.context, root!, { principalId: "owner", now: t, id: "sync-1" })).toBe(true);
    await h.kernel.idle();
    expect(h.project(root!)).toMatchObject({ lifecycle: "completed" });
    expect(h.kernel.getCell(root!)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(syncItemAfterOwnerChangeSync(h.kernel.context, root!, { principalId: "owner", now: t, id: "sync-2" })).toBe(false);
  });

  it("an action whose ball is a pending result card is marked as such (the owner's part is the card, not a to-do)", async () => {
    const h = await boot();
    h.script.add("desk", tool("delegate", { title: "整理上线检查清单", instruction: "整理", research: true }), tool("wait", { reason: "ok" }));
    h.script.add("worker", tool("report_to_parent", { kind: "result", text: "清单已整理" }));
    await h.ui.capture({ text: "帮我整理一份上线检查清单" });
    await h.kernel.idle();
    const [root] = roots(h);
    const [act] = h.actions(root);
    expect(act).toMatchObject({ owner: "human", status: "open" });
    expect(awaitsCard(coordinator(h, root!), act!.id)).toBe(true);
    const [card] = h.cards();
    await h.kernel.resolveApproval(card!.actionId, { decision: "approve", seenArtifactVersion: 1 });
    await h.kernel.idle();
    expect(awaitsCard(coordinator(h, root!), act!.id)).toBe(false);
  });
});

describe("cards the kernel resolves silently (dismiss) reach the item's books once the app wakes its cells", () => {
  it("a dismissed nudge: the watcher sets its next check and the ball goes back to the party", async () => {
    const h = await boot();
    h.script.add(
      "desk",
      tool("chase_replies", { title: "催报价", description: "等待报价", parties: [{ label: "供应商 A", to: "channel:memory:supA", thread: "memory:q-A" }], waitHours: 1 }),
      tool("wait", { reason: "ok" }),
    );
    await h.ui.capture({ text: "帮我催一下供应商 A 的报价" });
    await h.kernel.idle();
    const [root] = roots(h);
    const watcher = `${root}-p1`;
    h.clock.advance(60 * 60_000);
    await h.kernel.idle();
    const [card] = h.cards();
    expect(card).toMatchObject({ cellId: watcher, clarify: { cardType: "escalation" } });
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "dismiss", reason: "不催了" })).toMatchObject({ status: "dismissed" });
    await h.kernel.idle();
    expect(h.state<{ cardActionId?: string }>(watcher, KEYS.watcher)?.cardActionId).toBe(card!.actionId); // silent: not applied yet
    expect(syncItemAfterOwnerChangeSync(h.kernel.context, watcher, { principalId: "owner", now: h.clock.now(), id: "sync-w" })).toBe(true);
    await h.kernel.idle();
    expect(h.state<{ status: string; cardActionId?: string }>(watcher, KEYS.watcher)).toMatchObject({ status: "waiting" });
    expect(h.state<{ cardActionId?: string }>(watcher, KEYS.watcher)?.cardActionId).toBeUndefined();
    expect(h.actions(root)[0]).toMatchObject({ owner: "waiting", status: "open" });
    expect(awaitsCard(coordinator(h, root!), h.actions(root)[0]!.id)).toBe(false);
  });

  it("a dismissed result: the item completes", async () => {
    const h = await boot();
    h.script.add("desk", tool("delegate", { title: "整理上线检查清单", instruction: "整理", research: true }), tool("wait", { reason: "ok" }));
    h.script.add("worker", tool("report_to_parent", { kind: "result", text: "清单已整理" }));
    await h.ui.capture({ text: "帮我整理一份上线检查清单" });
    await h.kernel.idle();
    const [root] = roots(h);
    const [card] = h.cards();
    await h.kernel.resolveApproval(card!.actionId, { decision: "dismiss", reason: "不需要了" });
    expect(syncItemAfterOwnerChangeSync(h.kernel.context, root!, { principalId: "owner", now: h.clock.now(), id: "sync-r" })).toBe(true);
    await h.kernel.idle();
    expect(h.project(root!)).toMatchObject({ lifecycle: "completed" });
    expect(h.kernel.getCell(root!)?.status).toBe("closed");
  });
});

describe("reply drafts: a follow-up updates the same card, and never overwrites what the owner wrote", () => {
  const ask = (h: Harness, text: string) => h.memory.inject({ from: "lizong", replyTarget: "lizong", text, threads: ["memory:dm-lizong"] });

  it("a follow-up in the same thread redrafts the pending card in place; once the owner edited it, the new text is parked beside theirs", async () => {
    const h = await boot();
    h.script.add("desk", tool("draft_reply", { text: "李总，迁移方案周四前可以定。", title: "回复李总：迁移方案" }));
    await ask(h, "数据库迁移方案周四前能定吗？");
    await h.kernel.idle();
    const [card] = h.cards();
    expect(card).toMatchObject({ boundVersion: 1 });

    // A follow-up while the card waits: same item, same card, v2.
    h.script.add("desk", tool("draft_reply", { text: "李总，迁移方案周四前可以定，会避开下周六的大促。" }));
    await ask(h, "补充：下周六有大促，停机窗口要避开");
    await h.kernel.idle();
    let cards = h.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ actionId: card!.actionId, subjectKey: card!.subjectKey, boundVersion: 2 });

    // The owner rewrites the draft (v3, human). Another follow-up: their text stays current, ours is parked.
    const mine = "李总，方案周三给您：倾向双写灰度一周，避开大促。";
    expect(h.kernel.context.commitSync("desk", { artifact: { artifactId: card!.artifactId!, content: { format: "text", body: mine }, updatedBy: "human", expectedVersion: 2 } })).toMatchObject({ ok: true });
    h.script.add("desk", tool("draft_reply", { text: "李总，方案周四前定，补充：DBA 建议预留回滚窗口。" }), tool("wait", { reason: "ok" }));
    await ask(h, "DBA 说要预留回滚窗口");
    await h.kernel.idle();
    expect(h.kernel.context.getArtifactSync(card!.artifactId!)).toMatchObject({ version: 3, updatedBy: "human", content: { body: mine } });
    expect(h.kernel.context.listParkedSync(card!.artifactId!).map((p) => p.content.body)).toEqual(["李总，方案周四前定，补充：DBA 建议预留回滚窗口。"]);
    cards = h.cards();
    expect(cards).toHaveLength(1);
    expect(h.state<ReplyItem>("desk", KEYS.reply(card!.subjectKey))).toMatchObject({ status: "pending", actionId: card!.actionId });
  });

  it("the owner's own redraft request may replace a version they edited", async () => {
    const h = await boot();
    h.script.add("desk", tool("draft_reply", { text: "好的。" }));
    await ask(h, "周会改到周三可以吗？");
    await h.kernel.idle();
    const [card] = h.cards();
    h.kernel.context.commitSync("desk", { artifact: { artifactId: card!.artifactId!, content: { format: "text", body: "可以，周三下午。" }, updatedBy: "human", expectedVersion: 1 } });
    h.script.add("desk", tool("draft_reply", { text: "可以，周三下午三点，会议室我来订。" }));
    await h.kernel.resolveApproval(card!.actionId, { decision: "revise", instruction: "补上时间和会议室" });
    await h.kernel.idle();
    expect(h.kernel.context.getArtifactSync(card!.artifactId!)).toMatchObject({ version: 3, updatedBy: "agent", content: { body: "可以，周三下午三点，会议室我来订。" } });
    expect(h.kernel.context.listParkedSync(card!.artifactId!)).toEqual([]);
  });
});
