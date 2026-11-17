import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, PAYLOAD, type ActionRecord, type Envelope } from "@ng/protocol";
import { KEYS } from "../src";
import { RESTORE_REASON } from "../src/shared/config";
import { boot, cleanupAll, lastToolResult, roots, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

/** What the app sends for "移回待确认" (apps/gtd-desk restoreActivity). */
function restore(h: Harness, original: Envelope, activityId: string): void {
  h.kernel.inbox.enqueueSync("desk", {
    id: `${original.id}#restore#${activityId}`,
    from: "kernel:router",
    principalId: "owner",
    kind: "event",
    type: PAYLOAD.handback,
    payload: { original, fromCellId: "desk", reason: RESTORE_REASON },
    createdAt: h.clock.now(),
  });
}

describe("conventions the workbench app relies on", () => {
  it("an item moved back from the archive gets a card; archiving it again is refused", async () => {
    const h = await boot();
    h.script.add("desk", tool("archive_notification", { title: "CI 构建通过" }), tool("wait", { reason: "ok" }));
    const env = await h.memory.inject({ from: "ci-bot", text: "main 分支构建通过 #812" });
    await h.kernel.idle();
    const [archived] = h.activities();
    expect(archived).toMatchObject({ kind: "notification_archived", restorable: true, envelope: { id: env.id } });

    h.script.add(
      "desk",
      tool("archive_notification", { title: "CI 构建通过" }),
      (req) => {
        expect(lastToolResult(req)).toContain("moved this item back from the archive");
        return tool("present_to_owner", { title: "CI：main 分支构建通过 #812", summary: "构建通过，没有需要处理的；确认后归档。" });
      },
    );
    restore(h, archived!.envelope!, archived!.id);
    await h.kernel.idle();
    expect(h.activities()).toHaveLength(1);
    const [card] = h.cards();
    expect(card).toMatchObject({ cellId: "desk", subjectKey: `msg:${env.id}` });
    expect(card!.clarify).toMatchObject({ cardType: "response", confirmVerb: "accept", title: "CI：main 分支构建通过 #812", rawInput: { text: "main 分支构建通过 #812" }, source: { label: "测试通道" } });
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", seenArtifactVersion: 1 })).toMatchObject({ status: "approved" });
  });

  it("a reply card the owner took over (\"我来处理\", approvalActionId) closes its Engage item when it is finally sent; other fields stay", async () => {
    const h = await boot();
    h.script.add("desk", tool("draft_reply", { text: "下周二可以。", title: "回复王总：会面时间" }));
    await h.memory.inject({ from: "wang", text: "下周二有空见一面吗？" });
    await h.kernel.idle();
    const [card] = h.cards();
    // What the app writes for "转给我处理" on a reply: the approval stays pending behind a human action.
    const human: ActionRecord & { appNote: string } = {
      id: "act_h1",
      title: "回复王总：会面时间",
      owner: "human",
      status: "open",
      approvalActionId: card!.actionId,
      artifactId: card!.artifactId!,
      effort: "15m",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
      appNote: "kept",
    };
    h.kernel.context.commitSync("desk", { statePatches: { [gtdKeys.action(human.id)]: human } });

    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", seenArtifactVersion: 1 })).toMatchObject({ status: "sent" });
    await h.kernel.idle();
    expect(h.state<ActionRecord & { appNote: string }>("desk", gtdKeys.action(human.id))).toMatchObject({ status: "done", completedAt: h.clock.now(), appNote: "kept", approvalActionId: card!.actionId });
  });

  it("weekly review: the desk sees how the owner rewrote a reply and leaves a skill suggestion for the review column", async () => {
    const h = await boot({ presets: { weeklyReview: "0 16 * * 5" } });
    h.script.add("desk", tool("draft_reply", { text: "好的，收到。", title: "回复供应商：交期" }));
    await h.memory.inject({ from: "supplier", text: "交期能提前到周五吗？" });
    await h.kernel.idle();
    const [card] = h.cards();
    h.kernel.context.commitSync("desk", { artifact: { artifactId: card!.artifactId!, content: { format: "text", body: "您好，周五可以，但需要加急费 5%，请确认。" }, updatedBy: "human", expectedVersion: 1 } });
    await h.kernel.resolveApproval(card!.actionId, { decision: "approve", seenArtifactVersion: 2 });
    await h.kernel.idle();
    expect(h.kernel.inbox.listSchedulesSync({ cellId: "desk", activeOnly: true }).map((s) => [s.template.id, s.cron, s.tz])).toEqual([["gtd-weekly-review", "0 16 * * 5", "Asia/Shanghai"]]);

    h.script.add(
      "desk",
      (req) => {
        expect(JSON.stringify(req.messages)).toContain("每周回顾");
        return tool("review_week");
      },
      (req) => {
        const facts = lastToolResult(req);
        expect(facts).toContain("你的初稿：\n好的，收到。");
        expect(facts).toContain("主人发出的版本：\n您好，周五可以，但需要加急费 5%");
        return tool("suggest_skill", {
          name: "supplier-reply",
          description: "回复供应商时使用",
          body: "- 以“您好”开头\n- 涉及加急必须写明费用并请对方确认",
          reason: "本周你把给供应商的回复都改成了带称呼、写明费用的版本",
        });
      },
      tool("wait", { reason: "reviewed" }),
    );
    h.clock.set(Date.UTC(2026, 10, 20, 8, 0, 0)); // Friday 16:00 Asia/Shanghai
    await h.kernel.idle();
    expect(h.state("desk", KEYS.skillSuggestion("supplier-reply"))).toMatchObject({
      name: "supplier-reply",
      description: "回复供应商时使用",
      reason: "本周你把给供应商的回复都改成了带称呼、写明费用的版本",
    });
    expect(h.cards()).toEqual([]);
  });

  it("stopping an item the owner had paused still winds it down and marks it cancelled", async () => {
    const h = await boot();
    h.script.add("desk", tool("delegate", { title: "整理客户名单", instruction: "整理", research: true }), tool("wait", { reason: "ok" }));
    h.script.add("worker", tool("wait", { reason: "thinking" }));
    await h.ui.capture({ text: "整理一下客户名单" });
    await h.kernel.idle();
    const [root] = roots(h);
    expect(h.kernel.control(root!, { action: "pause" })).toMatchObject({ applied: true });

    h.script.add("desk", tool("stop_item", { itemId: root, reason: "不需要了" }), tool("wait", { reason: "ok" }));
    await h.ui.capture({ text: "客户名单不用整理了" });
    await h.kernel.idle();
    expect(h.project(root!)).toMatchObject({ lifecycle: "cancelled" });
    expect(h.actions(root)).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(h.kernel.getCell(root!)).toMatchObject({ status: "closed", closeReason: "cancelled" });
  });
});
