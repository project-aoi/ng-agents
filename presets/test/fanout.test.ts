import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD, subjectKeys, type CellTaskPayload } from "@ng/protocol";
import { boot, cleanupAll, continuesRun, roots, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

const COMPETITORS = Array.from({ length: 15 }, (_, i) => `竞品${String.fromCharCode(65 + i)}`);

function taskTitle(h: Harness, cellId: string): string {
  const task = h.kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.cellTask })[0]!.envelope.payload as CellTaskPayload;
  return task.title ?? "";
}

describe("docs/03 §四 row 5 — fan out 15 workers: one project row with k/15, one card when all are in", () => {
  it("11/15 while four are still working; after the rest report, exactly one summary card; the root never calls a model", async () => {
    const h = await boot();
    const slow = new Set(COMPETITORS.slice(11));
    const released = new Set<string>();

    h.script.add(
      "desk",
      tool("fan_out", {
        title: "竞品调研",
        label: "正在并发整理竞品资料",
        instruction: "调研这家竞品的定价、目标客户和最近一次大版本，三句话汇报",
        items: COMPETITORS.map((c) => ({ title: c })),
        research: true,
        outcome: "一页竞品对比",
      }),
      tool("wait", { reason: "fanned out" }),
    );
    // Workers report at once, except four "slow" ones that only report once released (woken by a steer).
    h.script.setDefault("worker", (req) => {
      if (continuesRun(req)) return { text: "已汇报" };
      const title = taskTitle(h, req.metadata!.cellId!);
      if (slow.has(title) && !released.has(title)) return tool("wait", { reason: "still researching" });
      return tool("report_to_parent", { kind: "result", text: `${title}：定价 99 元/月，面向中小团队` });
    });
    await h.ui.capture({ text: "帮我扒一下这 15 家竞品的定价和定位" });
    await h.kernel.idle();

    const [root] = roots(h);
    const workers = h.kernel.listCells({ parentId: root! });
    expect(workers).toHaveLength(15);
    expect(workers.every((w) => w.bounds.isolation === "none" && !w.bounds.tools.has("write"))).toBe(true);
    let [act] = h.actions(root);
    expect(act).toMatchObject({ title: "竞品调研", owner: "agent", status: "open", progress: { done: 11, total: 15, label: "正在并发整理竞品资料" } });
    expect(h.state(root!, "cell:status")).toMatchObject({ text: "正在并发整理竞品资料", progress: { done: 11, total: 15 } });
    expect(h.cards()).toEqual([]);
    // The desk sees one in-flight item, not fifteen workers.
    expect(h.kernel.rosterFor("desk").map((r) => r.cellId)).toEqual([root]);
    expect(h.kernel.rosterFor("desk")[0]!.statusLine).toBe("正在并发整理竞品资料 (11/15 正在并发整理竞品资料)");

    for (const w of workers.filter((w) => w.status === "active")) {
      released.add(taskTitle(h, w.id));
      h.kernel.control(w.id, { action: "steer", steerMessage: "可以汇报了" });
    }
    await h.kernel.idle();

    const cards = h.cards();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({ cellId: root, subjectKey: subjectKeys.project(root!) });
    expect(card.clarify).toMatchObject({
      cardType: "response",
      confirmVerb: "accept",
      title: "竞品调研：结果已齐 15/15",
      rawInput: { text: "帮我扒一下这 15 家竞品的定价和定位" },
      prep: { summary: "已汇总 15 份结果" },
    });
    const body = h.kernel.context.getArtifactSync(card.artifactId!)!.content.body;
    for (const c of COMPETITORS) expect(body).toContain(`**${c}**：${c}：定价 99 元/月`);
    expect(body).toContain("目标：一页竞品对比");
    [act] = h.actions(root);
    expect(act).toMatchObject({ owner: "human", progress: { done: 15, total: 15 }, nextStep: "在待确认里查看结果并确认" });
    expect(h.kernel.listCells({ parentId: root! }).every((w) => w.status === "closed")).toBe(true);
    expect(h.script.requests.filter((r) => r.cellId === root)).toEqual([]);
    expect(h.kernel.gate.listApprovalsSync({ subjectKey: subjectKeys.project(root!) })).toHaveLength(1);

    await h.kernel.resolveApproval(card.actionId, { decision: "approve", seenArtifactVersion: 1 });
    await h.kernel.idle();
    expect(h.project(root!)).toMatchObject({ lifecycle: "completed" });
    expect(h.kernel.getCell(root!)?.status).toBe("closed");
  });

  it("a result sent back to whoever asked: the card is a real send, executed by the kernel on approval", async () => {
    const h = await boot();
    h.script.add(
      "desk",
      tool("fan_out", {
        title: "两家云厂商报价对比",
        instruction: "查官网价格",
        items: [{ title: "厂商甲" }, { title: "厂商乙" }],
        research: true,
        replyTo: "channel:memory:boss",
        replyLabel: "老板（飞书）",
      }),
      tool("wait", { reason: "ok" }),
    );
    h.script.setDefault("worker", (req) => (continuesRun(req) ? { text: "ok" } : tool("report_to_parent", { kind: "result", text: `${taskTitle(h, req.metadata!.cellId!)}：每核每月 50 元` })));
    await h.memory.inject({ from: "boss", text: "对比下甲乙两家云厂商的价格发我" });
    await h.kernel.idle();
    const [root] = roots(h);
    const [card] = h.cards();
    expect(card!.clarify).toMatchObject({ cardType: "response", confirmVerb: "send", reply: { target: "channel:memory:boss", targetLabel: "老板（飞书）" }, source: { label: "测试通道" } });
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", seenArtifactVersion: 1 })).toMatchObject({ status: "sent" });
    expect(h.memory.sent.map((d) => d.target)).toEqual(["boss"]);
    expect(h.memory.sent[0]!.content.body).toContain("厂商乙：每核每月 50 元");
    await h.kernel.idle();
    expect(h.project(root!)).toMatchObject({ lifecycle: "completed" });
  });
});
