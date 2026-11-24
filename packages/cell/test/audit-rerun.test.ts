import { afterEach, describe, expect, it } from "vitest";
import { createEnvelope, PAYLOAD, run } from "@ng/protocol";
import { renderEnvelope } from "@ng/context";
import { gtdLifecycle } from "../../../presets/src";
import { CELL_PAUSE_KEY, type CellPauseState } from "../src";
import { boot, cleanupAll, registerTestPresets, requestText, TOOLSETS, tool, type Harness } from "./helpers";

// Regressions for docs/03-bugs/audits/2026-11-23-codex-e2e-rerun.md — the kernel's part.

afterEach(cleanupAll);

const owner = (h: Harness) => ({ principalId: h.kernel.ownerPrincipal });
const agent = { principalId: "agent:local" };

function project(h: Harness, id = "proj", preset = "project"): void {
  h.kernel.spawnCell("desk", { id, preset: preset as "project", title: `项目 ${id}`, meta: { role: id, projectCellId: id } }, undefined, owner(h));
}

function addWait(h: Harness, from: string, to: string, id = to): void {
  run(h.kernel.db, `INSERT INTO cell_waits(cell_id, wait_id, registration_id, waiting_for, reason, epoch, created_at)
    VALUES (?,?,?,?,?,?,?)`, [from, id, id, `inbox:${to}`, "等主台答复公共 CI", h.kernel.getCell(from)!.epoch, h.clock.now()]);
}

/** Who settled an item, and what they said. */
const settled = (h: Harness, id: string) =>
  h.kernel.db.prepare("SELECT approver_id, json_extract(outcome,'$.note') AS note FROM human_items WHERE action_id = ?").get(id);

const stallChecks = (h: Harness, cellId: string) => h.kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.stalledCheck });

describe("R02: a coordinator that is in the middle of answering is not judged silent", () => {
  // Original condition (uc15, 21:56:51): the owner answers the arbitration card, the card is gone, and the desk — the
  // only one who can now answer the two waiting projects — is at that instant handling the answer. Both projects got
  // "waits for inbox:desk, which has nothing in flight" and ran two extra turns each.
  it("the owner decides the arbitration card: the waiters get no stall check while the desk's turn is under way", async () => {
    const h = await boot();
    project(h, "pay");
    project(h, "report");
    addWait(h, "pay", "desk", "ci");
    addWait(h, "report", "desk", "ci");
    const card = h.kernel.humanItems.create({
      title: "合入公共修复", subjectKey: "arb:ci", relatedProjectIds: ["pay", "report"],
      options: [{ id: "merged", label: "已合入", effect: "reply" }],
    }, "desk");
    await h.kernel.idle();
    expect(stallChecks(h, "pay")).toEqual([]);
    expect(stallChecks(h, "report")).toEqual([]);

    const during: Array<{ pay: boolean; report: boolean }> = [];
    const look = () => during.push({ pay: h.kernel.anchorsOf("pay").stalled, report: h.kernel.anchorsOf("report").stalled });
    h.script.add(
      "desk",
      () => {
        look();
        h.kernel.checkStalls();
        return tool("send_message", { to: "inbox:pay", text: "ci 已合入 main，rebase 后继续", summary: "公共问题已处理", refId: "ci" });
      },
      () => {
        look();
        h.kernel.checkStalls();
        return tool("send_message", { to: "inbox:report", text: "ci 已合入 main，rebase 后继续", summary: "公共问题已处理", refId: "ci" });
      },
      { text: "都通知了。" },
    );
    await h.kernel.humanItems.decide(card.id, { optionId: "merged", seenItemRevision: card.itemRevision }, "owner");
    await h.kernel.idle();

    expect(during).toEqual([{ pay: false, report: false }, { pay: false, report: false }]);
    // No stall check about the desk was ever queued for either of them — not even one that was cancelled in time.
    const about = [...stallChecks(h, "pay"), ...stallChecks(h, "report")].filter((m) => JSON.stringify(m.envelope.payload).includes("inbox:desk"));
    expect(about).toEqual([]);
    expect(h.kernel.listWaits(["pay", "report"])).toEqual([]);
  });

  it("the deferral ends with the desk's turn: a waiter the desk did not answer is then taken up", async () => {
    const h = await boot();
    project(h, "pay");
    addWait(h, "pay", "desk", "ci");
    const card = h.kernel.humanItems.create({
      title: "合入公共修复", subjectKey: "arb:ci", relatedProjectIds: ["pay"],
      options: [{ id: "merged", label: "已合入", effect: "reply" }],
    }, "desk");
    await h.kernel.idle();
    // The desk takes the answer in and says nothing to the waiter (twice: also on the kernel's reminder).
    h.script.add("desk", { text: "知道了。" }, { text: "嗯。" });
    await h.kernel.humanItems.decide(card.id, { optionId: "merged", seenItemRevision: card.itemRevision }, "owner");
    await h.kernel.idle();
    // The desk was reminded once, and when that changed nothing the owner got the escalation (the existing mechanism).
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.arbitrationUnanswered })).toHaveLength(1);
    expect(h.kernel.humanItems.list().filter((i) => i.subjectKey.startsWith("kernel:stalled:"))).toHaveLength(1);
    expect(h.kernel.listWaits(["pay"])).toHaveLength(1);
  });

  it("a desk with unread mail is given its turn before a waiter is called stranded; once it has read it, the waiter is", async () => {
    const h = await boot({ start: false });
    project(h, "pay");
    addWait(h, "pay", "desk", "ci");
    expect(h.kernel.anchorsOf("pay")).toMatchObject({ internal: false, stalled: true });
    const mail = createEnvelope({ from: "channel:ui:owner", to: "inbox:desk", principalId: "owner", kind: "event", type: PAYLOAD.userMessage, payload: { text: "别的事" } }, h.clock);
    h.kernel.inbox.enqueueSync("desk", mail);
    expect(h.kernel.anchorsOf("pay")).toMatchObject({ internal: true, stalled: false });
    h.kernel.inbox.consumePendingSync("desk", mail.id, h.kernel.getCell("desk")!.epoch);
    expect(h.kernel.anchorsOf("pay")).toMatchObject({ internal: false, stalled: true });
  });
});

describe("R05: the owner's edit of a document reaches the coordinators above it", () => {
  /** The real project and desk presets keep books before the model runs; the kernel then reads the notes again. */
  function withBooks(registry: Parameters<typeof registerTestPresets>[0]): void {
    registerTestPresets(registry);
    registry.presets.register({
      ...gtdLifecycle,
      name: "bookkept",
      projectRoot: true,
      description: "a project preset with prepareRun, like the real one",
      prepareRun: async () => {},
      defaults: { stallPolicy: "monitor", processor: { kind: "llm", toolsets: [TOOLSETS.context, TOOLSETS.comms, TOOLSETS.cells] }, lifetime: "persistent", meta: { role: "project" } },
    });
  }

  // Original condition (uc03): the notes are re-read after the Run's own start is on record (E10), and "no turn has
  // started since the edit" then never held — the note was gone for every cell with books.
  it("a project with books sees the note at its first turn after the edit, and not again once it has seen it", async () => {
    const h = await boot({ setup: withBooks });
    project(h, "proj", "bookkept");
    h.kernel.spawnCell("proj", { id: "worker", preset: "worker" }, undefined, owner(h));
    h.kernel.sendToCell("worker", { text: "写报告" }, owner(h));
    await h.kernel.idle();
    const draft = (body: string) => ({ format: "text" as const, body });
    h.kernel.context.commitSync("worker", { artifact: { artifactId: "art_report", content: draft("初稿"), updatedBy: "agent" } });
    h.clock.advance(60_000);
    h.kernel.context.commitSync("worker", { artifact: { artifactId: "art_report", expectedVersion: 1, content: draft("主人改过"), updatedBy: "human" } });
    h.clock.advance(35_000);

    h.kernel.sendToCell("proj", { text: "我改了报告，看一下" }, owner(h));
    await h.kernel.idle();
    const first = requestText(h.script.callsOf("proj").at(-1)!);
    expect(first).toContain("[human-edited artifacts");
    expect(first).toContain("art_report v2");

    h.clock.advance(60_000);
    h.kernel.sendToCell("proj", { text: "还有一件事" }, owner(h));
    await h.kernel.idle();
    const second = requestText(h.script.callsOf("proj").at(-1)!);
    expect(second.slice(second.lastIndexOf("还有一件事") - 2_000)).not.toContain("[human-edited artifacts");
  });

  // Rerun round 1: the owner saved v2 and a worker saved v3 on top before the project's next turn; the note looked at
  // the current version only (an agent's), and the owner's edit was never mentioned.
  it("an owner's edit with a cell's version saved on top since is still listed, with the version on top named", async () => {
    const h = await boot({ setup: withBooks });
    project(h, "proj", "bookkept");
    h.kernel.spawnCell("proj", { id: "worker", preset: "worker" }, undefined, owner(h));
    h.kernel.sendToCell("worker", { text: "写报告" }, owner(h));
    await h.kernel.idle();
    const draft = (body: string) => ({ format: "text" as const, body });
    h.kernel.context.commitSync("worker", { artifact: { artifactId: "art_report", content: draft("初稿"), updatedBy: "agent" } });
    h.clock.advance(60_000);
    h.kernel.context.commitSync("worker", { artifact: { artifactId: "art_report", expectedVersion: 1, content: draft("主人改过"), updatedBy: "human" } });
    h.clock.advance(20_000);
    expect(h.kernel.context.commitSync("worker", { artifact: { artifactId: "art_report", expectedVersion: 2, content: draft("主人改过，又补了一段"), updatedBy: "agent" } })).toMatchObject({ ok: true });
    expect(h.kernel.context.getArtifactSync("art_report")).toMatchObject({ version: 3, updatedBy: "agent" });
    h.clock.advance(15_000);

    h.kernel.sendToCell("proj", { text: "我改了报告，看一下" }, owner(h));
    await h.kernel.idle();
    const seen = requestText(h.script.callsOf("proj").at(-1)!);
    expect(seen).toContain("[human-edited artifacts");
    expect(seen).toContain("art_report v2 (a cell has saved v3 on top since)");
  });
});

describe("R01: being resumed is not the owner's go-ahead", () => {
  it("the first turn after a resume is told who parked it with what words and who resumed it with what — as a live note", async () => {
    const h = await boot();
    project(h);
    await h.kernel.idle();
    h.clock.advance(60_000);
    h.kernel.control("proj", { action: "pause", pauseReason: "parked", note: "先停一下，我还没想好" }, agent);
    h.clock.advance(37_000);
    // The agent activates it on its own: no words of the owner come with it.
    h.kernel.control("proj", { action: "resume" }, agent);
    expect(h.kernel.context.readStateSync<CellPauseState>("proj", CELL_PAUSE_KEY)).toMatchObject({ resumedBy: "agent:local" });
    h.kernel.sendToCell("proj", { text: "从以后再说里拿出来了" }, agent);
    await h.kernel.idle();
    const seen = requestText(h.script.callsOf("proj").at(-1)!);
    expect(seen).toContain("[back from a pause — the owner's coding agent parked this cell for later at 2026-11-17T01:01:00Z, with the words \"先停一下，我还没想好\".");
    expect(seen).toContain("The owner's coding agent resumed it at 2026-11-17T01:01:37Z, without a word.");
    // The act is the agent's: nothing says the owner did it.
    expect(seen).not.toContain("resumed by the owner at");
    expect(h.kernel.inspectCell("proj").text).toContain("[resumed by the owner's coding agent at 2026-11-17T01:01:37Z]");

    // The note is for that first turn only.
    h.kernel.sendToCell("proj", { text: "第二条" }, owner(h));
    await h.kernel.idle();
    const later = requestText(h.script.callsOf("proj").at(-1)!);
    expect(later.slice(later.lastIndexOf("第二条") - 1_500)).not.toContain("[back from a pause");
  });

  // Live run uc04, step 11: the owner pressed "start" in the web view and the note still told the project to ask.
  it("says when it was the owner who resumed it themselves; what that means is the role prompt's to say", async () => {
    const h = await boot();
    project(h);
    await h.kernel.idle();
    h.kernel.control("proj", { action: "pause", pauseReason: "parked", note: "先放一放" }, agent);
    h.clock.advance(60_000);
    h.kernel.control("proj", { action: "resume" }, owner(h));
    h.kernel.sendToCell("proj", { text: "从以后再说里拿出来了" }, owner(h));
    await h.kernel.idle();
    const seen = requestText(h.script.callsOf("proj").at(-1)!);
    expect(seen).toContain("The owner resumed it at 2026-11-17T01:01:00Z, without a word.]");
  });

  it("the words that come with a resume are kept and quoted", async () => {
    const h = await boot();
    project(h);
    await h.kernel.idle();
    h.kernel.control("proj", { action: "pause", pauseReason: "parked" }, owner(h));
    h.clock.advance(60_000);
    h.kernel.control("proj", { action: "resume", note: "之前那个现在开始做" }, agent);
    expect(h.kernel.context.readStateSync<CellPauseState>("proj", CELL_PAUSE_KEY)).toMatchObject({ resumeNote: "之前那个现在开始做" });
    h.kernel.sendToCell("proj", { text: "开始" }, agent);
    await h.kernel.idle();
    const seen = requestText(h.script.callsOf("proj").at(-1)!);
    expect(seen).toContain("the owner parked this cell for later at 2026-11-17T01:00:00Z, without a word.");
    expect(seen).toContain('resumed it at 2026-11-17T01:01:00Z, with the words "之前那个现在开始做".');
  });
});

describe("R03: a reopened project wakes with the owner's words", () => {
  const reopened = (h: Harness) => h.kernel.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.cellMessage, status: ["pending"] }).map((m) => m.envelope.payload as { text: string; agentContext?: string });

  it("with words: they are the message, the agent's note apart; without: it says nothing came and where to look first", async () => {
    const h = await boot({ start: false });
    project(h);
    await h.kernel.closeCell("proj", "completed", owner(h));
    await h.kernel.reopenProject("proj", "agent:local", { text: "让原来那个分身把重试改回 5 次", agentContext: "主人是在终端里说的" });
    expect(reopened(h)).toMatchObject([{ text: expect.stringContaining("并说：\n让原来那个分身把重试改回 5 次"), agentContext: "主人是在终端里说的" }]);
    expect(reopened(h)[0]!.text).toContain("主人（经其编码助手）重新打开了这个项目");

    await h.kernel.closeCell("proj", "completed", owner(h));
    await h.kernel.reopenProject("proj", "owner");
    const bare = reopened(h).at(-1)!.text;
    expect(bare).toBe("主人重新打开了这个项目，没有附带新的要求。");
  });
});

describe("R09: an item the owner settled in conversation is closed on their word", () => {
  it("a cell closes its own action; the desk closes a personal reminder; an approval the Gate holds is not settled this way", async () => {
    const h = await boot({ start: false });
    project(h);
    const review = h.kernel.humanItems.create({ category: "action", title: "验收：对比报告", subjectKey: "action:proj:review",
      options: [{ id: "done", label: "已办完", effect: "reply" }] }, "proj");
    const water = h.kernel.humanItems.create({ category: "action", title: "给绿植浇水", subjectKey: "reminder:water",
      options: [{ id: "done", label: "已办完", effect: "complete" }] }, null);

    // Not somebody else's: a project cannot settle the desk's personal item.
    const settle = (item: typeof water, cellId: string, ownerWords: string, approverId?: string) =>
      h.kernel.humanItems.settleOwn(item.id, cellId, { ownerWords, seenItemRevision: item.itemRevision, ...(approverId ? { approverId } : {}) });
    expect(settle(water, "proj", "浇过了")).toEqual({ status: "not_found" });
    expect(settle(water, "desk", "浇水浇过了", "owner")).toEqual({ status: "settled" });
    expect(h.kernel.humanItems.get(water.id)).toMatchObject({ status: "resolved" });
    expect(h.kernel.humanItems.list().map((i) => i.id)).toEqual([review.id]);
    expect(settle(water, "desk", "浇过了")).toEqual({ status: "not_pending" });

    // The desk settles a project's item on the owner's word: the project hears it like a decision on the card.
    expect(settle(review, "desk", "报告行了", "owner")).toEqual({ status: "settled" });
    const heard = h.kernel.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.approvalResolved, status: ["pending"] });
    expect(heard.map((m) => m.envelope.payload)).toMatchObject([{ actionId: review.id, status: "executed", approverId: "owner", note: "报告行了" }]);
    expect(settled(h, review.id)).toEqual({ approver_id: "owner", note: "报告行了" });
    expect(settled(h, water.id)).toEqual({ approver_id: "owner", note: "浇水浇过了" });

    // Nobody's message is at hand: the record names the cell that closed it, not an owner who may not have spoken.
    const again = h.kernel.humanItems.create({ category: "action", title: "补一张截图", subjectKey: "action:proj:shot",
      options: [{ id: "done", label: "已办完", effect: "reply" }] }, "proj");
    expect(settle(again, "proj", "截好了")).toEqual({ status: "settled" });
    expect(settled(h, again.id)).toEqual({ approver_id: "cell:proj", note: "截好了" });
  });

  it("P-SAFE-5: settling is checked against the item revision and document version, and bound to that version", async () => {
    const h = await boot({ start: false });
    project(h);
    const draft = (body: string) => ({ format: "text" as const, body });
    h.kernel.context.commitSync("proj", { artifact: { artifactId: "art_manual", content: draft("初稿"), updatedBy: "agent" } });
    const review = h.kernel.humanItems.create({ category: "action", title: "验收：手册", subjectKey: "action:proj:manual", artifactId: "art_manual",
      options: [{ id: "done", label: "已办完", effect: "reply" }] }, "proj");
    h.kernel.context.commitSync("proj", { artifact: { artifactId: "art_manual", expectedVersion: 1, content: draft("主人改过"), updatedBy: "human" } });

    const settle = (seen: { seenItemRevision: number; seenArtifactVersion?: number }) =>
      h.kernel.humanItems.settleOwn(review.id, "proj", { ownerWords: "手册行了", approverId: "owner", ...seen });
    const current = { status: "stale", itemRevision: 1, artifactVersion: 2 };
    expect(settle({ seenItemRevision: 1 })).toEqual(current);
    expect(settle({ seenItemRevision: 1, seenArtifactVersion: 1 })).toEqual(current);
    expect(settle({ seenItemRevision: 7, seenArtifactVersion: 2 })).toEqual(current);
    expect(h.kernel.humanItems.get(review.id)).toMatchObject({ status: "pending" });
    expect(settle({ seenItemRevision: 1, seenArtifactVersion: 2 })).toEqual({ status: "settled" });
    // Bound to what they accepted, and counted as a draft the owner edited (the weekly review reads this).
    expect(h.kernel.db.prepare("SELECT bound_version, human_edited FROM human_items WHERE action_id=?").get(review.id)).toEqual({ bound_version: 2, human_edited: 1 });
  });

  it("undoing a settlement takes back the holder's receipt, corrects a cell that already knows, and puts a reminder back", async () => {
    const h = await boot({ start: false });
    project(h);
    const item = (title: string, cellId: string | null) => h.kernel.humanItems.create({ category: "action", title, subjectKey: `t:${title}`,
      options: [{ id: "done", label: "已办完", effect: cellId ? "reply" : "complete" }] }, cellId);
    const settleAndUndo = async (it: ReturnType<typeof item>, by: string) => {
      expect(h.kernel.humanItems.settleOwn(it.id, by, { ownerWords: "好了", approverId: "owner", seenItemRevision: it.itemRevision })).toEqual({ status: "settled" });
      const { id } = h.kernel.db.prepare("SELECT id FROM human_item_activity WHERE item_id=?").get(it.id) as { id: string };
      return (await h.kernel.humanItems.undo(id, "owner")).status;
    };
    const pending = (type: string) => h.kernel.inbox.listMessagesSync({ cellId: "proj", type, status: ["pending"] }).map((m) => m.envelope.payload);

    // From above: the holder has not read the receipt yet — it is taken back and the item is open again.
    const fromAbove = item("验收：报告", "proj");
    expect(await settleAndUndo(fromAbove, "desk")).toBe("undone");
    expect(pending(PAYLOAD.approvalResolved)).toEqual([]);
    expect(h.kernel.humanItems.get(fromAbove.id)).toMatchObject({ status: "pending" });
    expect(settled(h, fromAbove.id)).toEqual({ approver_id: null, note: null });

    // By the holder itself: it has acted on it, so it is told.
    const own = item("确认范围", "proj");
    expect(await settleAndUndo(own, "proj")).toBe("corrected");
    expect(pending(PAYLOAD.cellMessage)).toMatchObject([{ text: expect.stringContaining("主人已撤回") }]);

    // A reminder no cell holds is back on the owner's list; the desk, which had settled it, is told without being woken.
    const reminder = item("给绿植浇水", null);
    expect(await settleAndUndo(reminder, "desk")).toBe("undone");
    expect(h.kernel.humanItems.get(reminder.id)).toMatchObject({ status: "pending" });
    const told = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellMessage, status: ["pending"] }).map((m) => m.envelope);
    expect(told).toMatchObject([{ delivery: "silent_inject", payload: { text: expect.stringContaining("「给绿植浇水」的结清") } }]);
  });

  it("a card with reply choices can be settled by the owner's word; a card that approves an action cannot", async () => {
    const h = await boot();
    // The desk raises an arbitration card with a reply choice, and an approval of an outward action.
    h.script.add("desk", tool("request_approval", { kind: "escalation", title: "合入公共修复", summary: "修复在 fix/ci，合入后告诉我",
      subjectKey: "arb:ci", escalation: { reason: "blocked", explanation: "需要你合入" }, options: [{ id: "merged", label: "已合入", effect: "reply" }] }));
    await h.ui.capture({ text: "公共 CI 怎么了" }, "owner");
    await h.kernel.idle();
    h.script.add("desk", tool("request_approval", { kind: "action", title: "推送到远端", summary: "git push origin fix/ci", action: { name: "git.push", args: { branch: "fix/ci" } } }));
    await h.ui.capture({ text: "推一下" }, "owner");
    await h.kernel.idle();
    const items = h.kernel.humanItems.list();
    const reply = items.find((i) => i.title === "合入公共修复")!;
    const approval = items.find((i) => i.title === "推送到远端")!;
    expect(approval.options.some((o) => o.effect === "execute")).toBe(true);

    const settle = (item: typeof reply, ownerWords: string) => h.kernel.humanItems.settleOwn(item.id, "desk", { ownerWords, approverId: "owner", seenItemRevision: item.itemRevision });
    expect(settle(approval, "推吧")).toEqual({ status: "needs_owner" });
    expect(h.kernel.humanItems.get(approval.id)).toMatchObject({ status: "pending" });
    expect(settle(reply, "已经合了")).toEqual({ status: "settled" });
    // Resolved — answered — not withdrawn, and the owner's words are kept on it.
    expect(h.kernel.humanItems.get(reply.id)).toMatchObject({ status: "resolved" });
    expect(settled(h, reply.id)).toEqual({ approver_id: "owner", note: "已经合了" });
  });
});

describe("M16: the owner's words passed on by the desk answer a wait on the owner", () => {
  it("a relayed message that names the owner's message closes the project's wait on \"human\"; a plain desk message does not", async () => {
    const h = await boot();
    project(h);
    h.script.add("proj", tool("wait", { waitingFor: "human", reason: "等主人确认范围" }));
    h.kernel.sendToCell("proj", { text: "先问主人" }, owner(h));
    await h.kernel.idle();
    expect(h.kernel.listWaits(["proj"])).toMatchObject([{ waitingFor: "human" }]);

    const fromDesk = (payload: Record<string, unknown>) =>
      h.kernel.inbox.enqueueSync("proj", createEnvelope({ from: "inbox:desk", to: "inbox:proj", principalId: "cell:desk", kind: "event", type: PAYLOAD.cellMessage, payload: { fromCellId: "desk", ...payload } }, h.clock));
    fromDesk({ text: "例行通知" });
    await h.kernel.idle();
    expect(h.kernel.listWaits(["proj"])).toHaveLength(1);
    fromDesk({ text: "主人说：范围就按报告里的来", ownerMessageId: "msg_owner_1" });
    await h.kernel.idle();
    expect(h.kernel.listWaits(["proj"])).toEqual([]);
  });

  it("only a message the owner really sent the passing cell can be named as theirs", async () => {
    const results: unknown[] = [];
    const h = await boot({
      setup(registry) {
        registerTestPresets(registry);
        registry.codeProcessors.register({
          name: "test.relay",
          async run({ ports, snapshot }) {
            const own = snapshot.batch.envelopes[0]!.id;
            for (const ownerMessageId of ["made_up", own]) results.push(await ports.sendToCell!("inbox:proj", { text: "主人说继续", ownerMessageId }));
            return "completed";
          },
        });
      },
    });
    project(h);
    h.kernel.spawnCell("desk", { id: "relay", preset: "worker", processor: { kind: "code", entry: "test.relay" }, bounds: { canSendTo: ["inbox:proj"] } }, undefined, owner(h));
    h.kernel.sendToCell("relay", { text: "继续" }, owner(h));
    await h.kernel.idle();
    expect(results).toMatchObject([{ status: "refused", reason: expect.stringContaining("made_up") }, { status: "delivered" }]);
  });
});

describe("M17: the roster does not show a wait whose answer is already in the child's inbox", () => {
  // Original condition (uc07): the owner ticked the review off; the desk, woken in the same seconds, read "waiting for
  // human (等待主人验收…)" in its roster and told the owner the acceptance was "尚未由本人确认".
  it("a project whose review the owner has just accepted is not shown to the desk as waiting for the owner", async () => {
    const h = await boot();
    project(h);
    h.script.add("proj", tool("wait", { waitingFor: "human", reason: "等待主人验收" }));
    h.kernel.sendToCell("proj", { text: "交付后等验收" }, owner(h));
    await h.kernel.idle();
    const roster = async (ask: string) => {
      let seen = "";
      h.script.add("desk", (req) => {
        seen = requestText(req);
        return { text: "好" };
      });
      await h.ui.capture({ text: ask }, "owner");
      while (!seen) await new Promise<void>((r) => setImmediate(r));
      return seen.slice(seen.lastIndexOf("[in-flight child cells"));
    };
    expect(await roster("项目怎么样了")).toContain("waiting for human (等待主人验收)");
    await h.kernel.idle();

    // The owner's acceptance is with the project, whose turn on it is still under way when the desk looks.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const claimed = new Promise<void>((r) => (taken = r));
    h.script.add("proj", async () => {
      taken();
      await held;
      return { text: "收到验收" };
    });
    h.kernel.sendToCell("proj", { text: "验收通过" }, owner(h));
    await claimed;
    const during = await roster("验收了吗");
    release();
    await h.kernel.idle();
    // The project's turn on the answer is under way: the roster says so, not "at its next turn".
    expect(during).toContain("was waiting for human (等待主人验收) — it has the answer and is acting on it now");
    expect(during).not.toMatch(/· waiting for human/);
  });
});

describe("L04: a coordinator's turn is nobody working in the tree", () => {
  it("the active-workspaces note lists a worker at work, not another project that merely has a turn in flight", async () => {
    const h = await boot();
    const dir = h.dataDir;
    h.kernel.spawnCell("desk", { id: "a", preset: "project", title: "项目 a", cwd: dir, meta: { role: "a", projectCellId: "a" } }, undefined, owner(h));
    h.kernel.spawnCell("desk", { id: "b", preset: "project", title: "项目 b", cwd: dir, meta: { role: "b", projectCellId: "b" } }, undefined, owner(h));
    await h.kernel.idle();
    let seen = "";
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    h.script.add("b", async () => {
      started();
      await held;
      return { text: "b 结束" };
    });
    h.kernel.sendToCell("b", { text: "开始" }, owner(h));
    await running;
    h.script.add("a", (req) => {
      seen = requestText(req);
      return { text: "a 结束" };
    });
    h.kernel.sendToCell("a", { text: "看看谁在这个目录" }, owner(h));
    while (!seen) await new Promise<void>((r) => setImmediate(r));
    release();
    await h.kernel.idle();
    expect(seen).not.toContain('"项目 b"');
    expect(seen).not.toContain("[active workspaces");
  });
});

describe("L06: a batch that is delivered a second time says so", () => {
  it("after a turn that failed, the redelivered message carries a note; a first delivery does not", async () => {
    const h = await boot();
    project(h);
    await h.kernel.idle();
    const seen: string[] = [];
    h.script.add(
      "proj",
      (req) => {
        seen.push(requestText(req));
        throw new Error("model backend down");
      },
      (req) => {
        seen.push(requestText(req));
        return { text: "接着做完了" };
      },
    );
    h.kernel.sendToCell("proj", { text: "把版本号升到 1.5.0" }, owner(h));
    await h.kernel.idle();
    h.clock.advance(120_000);
    await h.kernel.idle();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toContain("[delivered again");
    expect(seen[1]).toContain("[delivered again — these message(s) were already given to an earlier turn of yours that was cut off");
  });
});

describe("live run uc08: an interruption while a worker is at work keeps who sent it", () => {
  it("inspect_cell shows the owner's steer as the owner speaking directly and counts it", async () => {
    const h = await boot();
    project(h);
    h.kernel.spawnCell("proj", { id: "w", preset: "worker", title: "写说明", meta: { role: "w" } }, "写一份说明", owner(h));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    h.script.add("w", async () => {
      started();
      await held;
      return tool("read_state", { key: "x" });
    }, { text: "按 15 行写完了" });
    await running;
    expect(h.kernel.control("w", { action: "steer", steerMessage: "说明控制在 15 行以内" }, agent)).toMatchObject({ applied: true });
    release();
    await h.kernel.idle();
    const seen = h.kernel.inspectCell("w");
    expect(seen.text).toContain("← the owner, directly, interrupting its work (agent:local): 说明控制在 15 行以内");
    expect(seen.text).not.toContain("← note: [steer from the user");
    expect(seen.directChats).toBe(1);
  });
});

describe("rerun round 1: [cells waiting on you] lists the cells still waiting", () => {
  /** The newest user message of a request: what this wake-up brought, with its notes (the history left out). */
  const latest = (req: Parameters<typeof requestText>[0]) => requestText({ ...req, messages: req.messages.filter((m) => m.role === "user").slice(-1) });

  // Rerun round 1: the desk had answered a project that waited on it; at its next turn — the project still busy with
  // something else, the answer in its inbox — "[cells waiting on you]" listed the project again.
  it("a waiter whose answer is already queued in its inbox is not listed; it is while the answer has not been sent", async () => {
    const h = await boot();
    project(h, "pay");
    await h.kernel.idle();
    addWait(h, "pay", "desk", "ci");
    const notes: string[] = [];
    const look = (reply: string) => (req: Parameters<typeof requestText>[0]) => {
      notes.push(latest(req));
      return { text: reply };
    };

    // Before any answer: listed.
    h.script.add("desk", look("还在等公共 CI"));
    await h.ui.capture({ text: "公共 CI 怎么样了" }, "owner");
    await h.kernel.idle();
    expect(notes[0]).toContain("[cells waiting on you]\npay [waitId=ci]");

    // The project is busy with something that does not answer its wait (a note from another cell) …
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const busy = new Promise<void>((r) => (taken = r));
    h.script.add("pay", async () => {
      taken();
      await held;
      return { text: "先处理报表那边" };
    });
    h.kernel.inbox.enqueueSync("pay", createEnvelope({ from: "inbox:report", to: "inbox:pay", principalId: "cell:report", kind: "event", type: PAYLOAD.cellMessage, payload: { fromCellId: "report", text: "报表那边也在等这个修复" } }, h.clock));
    await busy;

    // … when the desk answers it: the answer waits in the project's inbox, the wait is still open.
    const answered = new Promise<void>((r) => {
      const off = h.kernel.bus.on("run.finished", (e) => {
        if (e.cellId !== "desk") return;
        off();
        r();
      });
    });
    h.script.add("desk", tool("send_message", { to: "inbox:pay", text: "ci 已合入 main，rebase 后继续", summary: "公共问题已处理", refId: "ci" }), { text: "已通知 pay" });
    await h.ui.capture({ text: "ci 合好了，告诉 pay" }, "owner");
    await answered;
    expect(h.kernel.inbox.listMessagesSync({ cellId: "pay", type: PAYLOAD.cellMessage, status: ["pending"] }).map((m) => m.envelope.from)).toEqual(["inbox:desk"]);
    expect(h.kernel.listWaits(["pay"])).toHaveLength(1);

    // The desk's next turn, before the project has read it: not listed as waiting on the desk.
    h.script.add("desk", look("好"));
    await h.ui.capture({ text: "现在呢" }, "owner");
    while (notes.length < 2) await new Promise<void>((r) => setImmediate(r));
    expect(h.kernel.listWaits(["pay"])).toHaveLength(1);
    release();
    await h.kernel.idle();
    expect(notes[1]).toContain("现在呢");
    expect(notes[1]).not.toContain("[cells waiting on you]");
    // The project read the answer: the wait is closed.
    expect(h.kernel.listWaits(["pay"])).toEqual([]);
  });
});

describe("rerun round 1 (uc01 N4): what the owner said when they ticked off a personal item stays on it", () => {
  const reason = (h: Harness, id: string) =>
    (h.kernel.db.prepare("SELECT status_reason FROM human_items WHERE action_id = ?").get(id) as { status_reason: string | null }).status_reason;
  const note = (h: Harness, id: string) => (settled(h, id) as { note: string | null }).note;

  // Rerun round 1, uc01 (N4): the owner ticked off a reminder with "浇过了，用的是雨水"; a personal item has no cell to
  // hand the note to, and the words were lost.
  it("a personal item decided with a note keeps it; without a note there is none; so does a reply on a Gate-held card", async () => {
    const h = await boot({ start: false });
    const done = [{ id: "done", label: "已办完", effect: "complete" as const }];
    const water = h.kernel.humanItems.create({ category: "action", title: "给绿植浇水", subjectKey: "reminder:water", options: done }, null);
    await h.kernel.humanItems.decide(water.id, { optionId: water.options[0]!.id, seenItemRevision: water.itemRevision, note: "浇过了，\n  用的是雨水" }, "owner");
    expect(h.kernel.humanItems.get(water.id)).toMatchObject({ status: "resolved" });
    expect(note(h, water.id)).toBe("浇过了，\n  用的是雨水");

    const power = h.kernel.humanItems.create({ category: "action", title: "交电费", subjectKey: "reminder:power", options: done }, null);
    await h.kernel.humanItems.decide(power.id, { optionId: power.options[0]!.id, seenItemRevision: power.itemRevision }, "owner");
    expect(h.kernel.humanItems.get(power.id)).toMatchObject({ status: "resolved" });
    expect(note(h, power.id)).toBeNull();

    // An outward action the Gate holds, answered with "只回复": closed as a reply; the note goes to the cell that asked.
    const held = h.kernel.gate.authorizeSync(
      { type: "custom", name: "send_mail", summary: "给客户发上线通知", subjectKey: "mail:client", sideEffect: "external", card: { format: "card", title: "给客户发上线通知", body: "您好，接口下周二上线。" } },
      { cellId: "desk", principalId: "cell:desk", epoch: h.kernel.getCell("desk")!.epoch },
    );
    if (held.type !== "defer") throw new Error(`expected a card, got ${held.type}`);
    const card = h.kernel.humanItems.get(held.actionId)!;
    expect(card.options.map((o) => o.id)).toContain("system.reply");
    await h.kernel.humanItems.decide(card.id, { optionId: "system.reply", seenItemRevision: card.itemRevision, note: "先别发，等我改完" }, "owner");
    expect(reason(h, card.id)).toBe("replied");
    expect(note(h, card.id)).toBe("先别发，等我改完");
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved }).at(-1)!.envelope.payload).toMatchObject({ actionId: card.id, note: "先别发，等我改完" });
  });
});

describe("rerun round 1 (uc07): a close that was not carried out, and a decision on a settled item", () => {
  // The owner was told "已完成" while a message that had arrived kept the project open for 18 more minutes.
  it("a message that beats the close keeps the cell open, tells it so, and sends the owner no closing notice", async () => {
    const h = await boot();
    project(h);
    await h.kernel.idle();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    h.script.add("proj", async () => {
      started();
      await held;
      return tool("complete_self", { summary: "都做完了" });
    }, { text: "OK" }, { text: "收到新的要求" });
    h.kernel.sendToCell("proj", { text: "验收" }, owner(h));
    await running;
    h.kernel.sendToCell("proj", { text: "另外再加一个功能" }, owner(h));
    release();
    await h.kernel.idle();
    expect(h.kernel.getCell("proj")!.status).toBe("active");
    const notes = h.kernel.context.listEvidenceSync("proj").map((e) => e.record).filter((r) => r.kind === "system_note").map((r) => r.text).join("\n");
    expect(notes).toContain("closing this cell was not carried out: a message arrived before the turn settled");
    expect(h.count("owner_notifications")).toBe(0);
  });

  it("deciding an item that is already settled says so instead of asking to look again", async () => {
    const h = await boot({ start: false });
    const item = h.kernel.humanItems.create({ category: "action", title: "给绿植浇水", subjectKey: "reminder:water",
      options: [{ id: "done", label: "已办完", effect: "complete" }] }, null);
    await h.kernel.humanItems.decide(item.id, { optionId: "done", seenItemRevision: item.itemRevision }, "owner");
    await expect(h.kernel.humanItems.decide(item.id, { optionId: "done", seenItemRevision: item.itemRevision }, "owner")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("已经处理过了") });
  });
});

describe("rerun round 2 (uc25): a fact for another cell's record wakes nobody", () => {
  it("send_message with quiet leaves the note as background: no turn starts for it, no wait is answered, the next turn reads it", async () => {
    const h = await boot();
    project(h);
    h.script.add("proj", tool("wait", { waitingFor: "human", reason: "等待主人验收" }));
    h.kernel.sendToCell("proj", { text: "交付后等验收" }, owner(h));
    await h.kernel.idle();
    const turns = h.script.callsOf("proj").length;
    h.script.add("desk", tool("send_message", { to: "inbox:proj", text: "公共修复已由主人合入 main", summary: "公共修复已合入", quiet: true }), { text: "OK" });
    await h.ui.capture({ text: "ci-shared 那个我合了" }, "owner");
    await h.kernel.idle();
    expect(h.script.callsOf("proj")).toHaveLength(turns);
    expect(h.kernel.listWaits(["proj"])).toMatchObject([{ waitingFor: "human" }]);
    h.kernel.sendToCell("proj", { text: "验收通过" }, owner(h));
    await h.kernel.idle();
    expect(requestText(h.script.callsOf("proj").at(-1)!)).toContain("公共修复已由主人合入 main");
  });
});

describe("rerun round 3 (uc35): what an onlooker and the owner are shown", () => {
  it("a card raised on a cell's first turn does not quote its task text as the message it came from; a card raised in answer to the owner quotes the owner", async () => {
    const h = await boot();
    const ask = (title: string) => tool("request_approval", { kind: "escalation", title, summary: "需要你选", escalation: { reason: "blocked", explanation: "目录里有未提交的改动" },
      options: [{ id: "worktree", label: "在独立工作树里做", effect: "reply" }] });
    h.script.add("proj", ask("ledger 的改动怎么处理"));
    h.kernel.spawnCell("desk", { id: "proj", preset: "project", title: "升版本", meta: { role: "proj", projectCellId: "proj" } }, "## 交办内容\n把 VERSION 升到 1.5.0（worker（dispatch）、send_message 等工作台说明）", owner(h));
    await h.kernel.idle();
    const first = h.kernel.humanItems.list().find((i) => i.title === "ledger 的改动怎么处理")!;
    expect(first.rawInput?.text ?? "").toBe("");

    h.script.add("proj", ask("第二个问题"));
    h.kernel.sendToCell("proj", { text: "另外 README 也改一下" }, owner(h));
    await h.kernel.idle();
    const second = h.kernel.humanItems.list().find((i) => i.title === "第二个问题")!;
    expect(second.rawInput?.text).toBe("另外 README 也改一下");
  });

  it("listOpenWaits leaves out a wait whose answer the cell is already handling; listWaits still has it until the turn settles", async () => {
    const h = await boot();
    project(h);
    h.script.add("proj", tool("wait", { waitingFor: "human", reason: "等待验收" }));
    h.kernel.sendToCell("proj", { text: "交付后等验收" }, owner(h));
    await h.kernel.idle();
    expect(h.kernel.listOpenWaits(["proj"])).toHaveLength(1);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const claimed = new Promise<void>((r) => (taken = r));
    h.script.add("proj", async () => {
      taken();
      await held;
      return { text: "收到" };
    });
    h.kernel.sendToCell("proj", { text: "验收通过" }, owner(h));
    await claimed;
    expect(h.kernel.listWaits(["proj"])).toHaveLength(1);
    expect(h.kernel.listOpenWaits(["proj"])).toEqual([]);
    release();
    await h.kernel.idle();
    expect(h.kernel.listWaits(["proj"])).toEqual([]);
  });
});


describe("rerun round 3: the root's own schedule is not background waiting", () => {
  // The desk's weekly review (a cron on the root) or a reminder it set itself made the workbench report "1 个后台在等"
  // with no background cell at all.
  it("stats().waitingCells leaves out the root with a schedule or a timer; a non-root cell with a timer still counts", async () => {
    const h = await boot();
    await h.kernel.idle();
    expect(h.kernel.stats()).toMatchObject({ backgroundCells: 0, waitingCells: 0 });

    // A weekly schedule on the root …
    h.kernel.updateCell("desk", { schedules: [{ cron: "0 16 * * 5" }] }, owner(h));
    expect(h.kernel.inbox.listSchedulesSync({ cellId: "desk", activeOnly: true })).toHaveLength(1);
    expect(h.kernel.stats().waitingCells).toBe(0);
    // … and a timer of its own (a reminder due tomorrow).
    h.kernel.inbox.enqueueSync(
      "desk",
      createEnvelope({ from: "inbox:desk", to: "inbox:desk", principalId: "cell:desk", kind: "event", type: PAYLOAD.timerFired, payload: { label: "明早提醒主人" } }, h.clock),
      { deliverAt: h.clock.now() + 86_400_000 },
    );
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", status: ["pending"] }).filter((m) => m.deliverAt > h.clock.now())).toHaveLength(1);
    expect(h.kernel.stats().waitingCells).toBe(0);

    // A background cell with a timer is waiting.
    h.kernel.spawnCell("desk", { id: "later", preset: "checker", title: "明天再看", schedules: [{ deliverAt: h.clock.now() + 86_400_000 }] }, undefined, owner(h));
    expect(h.kernel.stats()).toMatchObject({ backgroundCells: 1, waitingCells: 1 });
  });
});

describe("rerun round 4 (uc45): a message that arrives after a worker's account does not replace the account", () => {
  // Original condition: the fixer had written its full report (where the fix is, who merges it, which branch the
  // checkout is on); a forwarded message reached it before the turn settled; it added two lines — and only those two
  // lines were delivered to the desk as the turn's result (and quoted on the owner's merge card).
  const REPORT = "修复在 fix/schema-2 分支，由平台组合入，共享检出停在该分支。" + "已核对 README 与 CODEOWNERS：README 写明修复走 fix/ 分支并由平台组负责人合入，仓库没有 CODEOWNERS 文件。验证：在 ci-shared 里跑了 run_tests.sh，另在 pay-core 和 report-gen 的临时副本里各跑了一遍各自的测试，三处都通过，临时副本已删除，没有留下缓存文件。还没有推送，也没有建 MR；共享检出目前停在修复分支上，合入之前不要在这个检出里切回 main，否则两个等着的项目拿不到修复。".repeat(1);
  it("the turn result carries the account from before the late message and what was added after it", async () => {
    const h = await boot();
    project(h);
    h.kernel.spawnCell("proj", { id: "w", preset: "worker", title: "修公共 CI", meta: { role: "w" } }, "修 ci-shared", owner(h));
    h.script.add(
      "w",
      tool("read_state", { key: "x" }),
      () => {
        // The message is there when the report is done, and is taken in before the turn settles.
        h.kernel.sendToCell("w", { text: "另一个项目也在等这个修复" }, { principalId: "cell:proj" });
        return { text: REPORT };
      },
      { text: "已知悉，不需要再改。" },
    );
    await h.kernel.idle();
    const result = h.kernel.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.cellResult }).at(-1)!.envelope;
    expect(result.payload).toMatchObject({ summary: "已知悉，不需要再改。", saidBefore: REPORT });
    // The parent reads the account as text of its own, not as a field in a JSON dump.
    expect(renderEnvelope(result)).toContain(`may be here]\n${REPORT}\n`);
  });

  // Live round 11: what it said on the way to its next step (uc08: a plan the steer overruled) or before its own job
  // reported back (uc05) came along as if it had been its report.
  it("words on the way to the next step, or before its own job's result, are no account", async () => {
    const h = await boot();
    project(h);
    h.kernel.spawnCell("proj", { id: "w", preset: "worker", title: "改退避", meta: { role: "w" } }, undefined, owner(h));
    const resultOf = async (...turns: Parameters<typeof h.script.add>[1][]) => {
      h.script.add("w", ...turns);
      h.kernel.sendToCell("w", { text: "开始" }, { principalId: "cell:proj" });
      await h.kernel.idle();
      return h.kernel.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.cellResult }).at(-1)!.envelope.payload;
    };
    const steered = await resultOf(
      { text: "我会分 8 次提交。", toolCalls: [{ name: "read_state", input: { key: "x" } }] },
      () => {
        h.kernel.control("w", { action: "steer", steerMessage: "一次提交就行" }, agent);
        return tool("read_state", { key: "y" });
      },
      { text: "已一次提交。" },
    );
    expect(steered).toMatchObject({ summary: "已一次提交。" });
    expect(steered).not.toHaveProperty("saidBefore");

    const job = createEnvelope({ from: "kernel:workspace", to: "inbox:w", principalId: "cell:w", kind: "result", type: PAYLOAD.jobResult,
      payload: { jobId: "job_1", command: "pnpm test", state: "succeeded", exitCode: 0, tail: "ok" }, expectedEpoch: h.kernel.getCell("w")!.epoch }, h.clock);
    const ownJob = await resultOf(
      () => {
        h.kernel.inbox.enqueueSync("w", job);
        return { text: "测试已在后台启动，等结果。" };
      },
      { text: "测试通过，已提交。" },
    );
    expect(ownJob).toMatchObject({ summary: "测试通过，已提交。" });
    expect(ownJob).not.toHaveProperty("saidBefore");
  });

  // Round 5 (uc55): a worker that said "blocked, I'll wait", waited, and was answered got a result opening with that
  // old line, labelled as if a late message had come in — a Run that ends in a wait settles nothing, so the next
  // result covers both Runs.
  it("what a worker said before it waited is not part of the result of the turn its answer started", async () => {
    const h = await boot();
    project(h);
    h.script.add("w3", { text: "run_tests.sh 被公共 CI 挡住了，我会报告这个公共阻碍并等待处理。", toolCalls: [{ name: "wait", input: { waitingFor: "inbox:proj", reason: "等公共 CI 修复" } }] });
    h.kernel.spawnCell("proj", { id: "w3", preset: "worker", title: "改重试上限", meta: { role: "w3" } }, "把 MAX_RETRY 改成 3", owner(h));
    await h.kernel.idle();
    expect(h.kernel.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.cellResult })).toEqual([]);
    h.script.add("w3", { text: "公共修复已到位，改动已提交在 fix/max-retry-3。" });
    // The answer it waited for arrives (the wait is closed with it).
    run(h.kernel.db, "DELETE FROM cell_waits WHERE cell_id = ?", ["w3"]);
    h.kernel.sendToCell("w3", { text: "公共 CI 修好了，继续" }, { principalId: "cell:proj" });
    await h.kernel.idle();
    h.clock.advance(5_000);
    await h.kernel.idle();
    expect(h.kernel.context.listEvidenceSync("w3", {}).filter((e) => e.record.kind === "run_boundary" && e.record.phase === "start")).toHaveLength(2);
    const result = h.kernel.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.cellResult, status: ["pending", "claimed", "done"] }).at(-1)!;
    expect((result.envelope.payload as { summary: string }).summary).toBe("公共修复已到位，改动已提交在 fix/max-retry-3。");
  });

  it("a turn nobody interrupted still reports its last words only", async () => {
    const h = await boot();
    project(h);
    h.script.add("w2", { text: "先看一下目录。", toolCalls: [{ name: "read_state", input: { key: "x" } }] }, { text: "改好了，已提交。" });
    h.kernel.spawnCell("proj", { id: "w2", preset: "worker", title: "改配置", meta: { role: "w2" } }, "改配置", owner(h));
    await h.kernel.idle();
    const result = h.kernel.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.cellResult }).at(-1)!;
    expect(result.envelope.payload).toMatchObject({ summary: "改好了，已提交。" });
    expect(result.envelope.payload).not.toHaveProperty("saidBefore");
  });
});

describe("rerun rounds 4–5 (uc41, uc51): the desk sees the owner's reminders that are not due yet", () => {
  // A reminder that is not due is a timer of the desk's, not an item: it becomes an item in 待我处理 when it fires.
  // (Round 4's first fix looked for items with a future due time, which production never creates.)
  it("a timer the desk set for later is listed in its notes with its time and cancel group; a due personal item is an open card; a project does not see the desk's timers", async () => {
    const h = await boot();
    project(h);
    h.script.add("desk", tool("set_reminder", { label: "提醒：联系牙医", inSeconds: 3 * 24 * 3_600, cancelGroup: "reminder:dentist" }), { text: "设好了" });
    await h.ui.capture({ text: "周五提醒我联系牙医" }, "owner");
    await h.kernel.idle();
    const due = h.kernel.humanItems.create({ category: "action", title: "给绿植浇水", subjectKey: "reminder:water", options: [{ id: "done", label: "已办完", effect: "complete" as const }] }, null);
    const seen: Record<string, string> = {};
    h.script.add("desk", (req) => {
      seen["desk"] = requestText(req);
      return { text: "好" };
    });
    h.script.add("proj", (req) => {
      seen["proj"] = requestText(req);
      return { text: "好" };
    });
    await h.ui.capture({ text: "提醒都设好了吗？" }, "owner");
    h.kernel.sendToCell("proj", { text: "进展如何" }, owner(h));
    await h.kernel.idle();
    expect(seen["desk"]).toContain("[your timers that have not fired yet]");
    expect(seen["desk"]).toMatch(/\d{4}-\d\d-\d\dT[\d:.]+Z "提醒：联系牙医"/);
    expect(seen["desk"]).toContain(`${due.id} rev 1 [action] "给绿植浇水"`);
    expect(seen["proj"]).not.toContain("联系牙医");
  });
});

describe("rerun round 6 (uc66): a worker's result closes the wait on that worker, also beside a standing wait for whatever comes next", () => {
  // Original condition: the hub ended its first turn with wait "external" (the next review request) and each dispatch
  // with wait inbox:<worker>. A worker's result could answer both, the kernel closed neither, and the hub — to itself,
  // the desk and the owner's agent — kept "waiting for" results it already had.
  it("the result closes the wait on its sender and leaves the vague external wait open", async () => {
    const h = await boot();
    project(h);
    h.kernel.spawnCell("proj", { id: "rv", preset: "worker", title: "评审", meta: { role: "rv" } }, undefined, owner(h));
    run(h.kernel.db, `INSERT INTO cell_waits(cell_id, wait_id, registration_id, waiting_for, reason, epoch, created_at) VALUES (?,?,?,?,?,?,?)`,
      ["proj", "external", "w-ext", "external", "等下一条评审请求", h.kernel.getCell("proj")!.epoch, h.clock.now()]);
    addWait(h, "proj", "rv", "inbox:rv"); // as wait{waitingFor} registers it: the wait is named by its party
    expect(h.kernel.listWaits(["proj"]).map((w) => w.waitingFor).sort()).toEqual(["external", "inbox:rv"]);
    h.script.add("rv", { text: "评审完成：有 2 个阻塞问题。" });
    h.kernel.sendToCell("rv", { text: "评审 MR !1" }, { principalId: "cell:proj" });
    await h.kernel.idle();
    h.clock.advance(5_000);
    await h.kernel.idle();
    expect(h.kernel.listWaits(["proj"]).map((w) => w.waitingFor)).toEqual(["external"]);
  });

  it("a wait on a cell that has closed stays on record (it is no anchor) but is not shown to an onlooker as waiting", async () => {
    const h = await boot();
    project(h);
    h.kernel.spawnCell("proj", { id: "rv2", preset: "worker", title: "评审", meta: { role: "rv2" } }, undefined, owner(h));
    addWait(h, "proj", "rv2");
    await h.kernel.closeCell("rv2", "cancelled", owner(h));
    await h.kernel.idle();
    expect(h.kernel.listWaits(["proj"]).map((w) => w.waitingFor)).toEqual(["inbox:rv2"]);
    expect(h.kernel.listOpenWaits(["proj"])).toEqual([]);
  });
});

