import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, PAYLOAD, subjectKeys, type CellResultPayload, type CodeProcessor, type Envelope, type ItemSource } from "@ng/protocol";
import { chasePlan, fanOutPlan, GTD_PAYLOAD, KEYS, rootSpec, rootTask, setProjectLifecycleSync, type CoordinatorState, type ItemInfo, type WatcherState } from "../src";
import { boot, cleanupAll, DAY, HOUR, T0, type Harness } from "./helpers";

afterEach(cleanupAll);

const source: ItemSource = { label: "随手记", at: T0 };
const item = (title: string): ItemInfo => ({ title, source, rawInput: { text: title, kind: "message" } });

/** Zero-token stand-in worker: reports `input.i`, twice when input.dup (a duplicate report), or fails when input.fail. */
const echo: CodeProcessor = {
  name: "test.echo",
  async run({ snapshot, ports }) {
    const task = snapshot.batch.envelopes.find((e) => e.type === PAYLOAD.cellTask);
    if (!task) return "completed";
    const input = (task.payload as { input: { i: number; dup?: boolean; fail?: boolean } }).input;
    const result: CellResultPayload = { childCellId: ports.self.cellId, status: input.fail ? "failed" : "completed", summary: `item ${input.i}` };
    await ports.emitToParent(PAYLOAD.cellResult, result, { id: `${ports.self.cellId}:r1` });
    if (input.dup) await ports.emitToParent(PAYLOAD.cellResult, { ...result, summary: "duplicate" }, { id: `${ports.self.cellId}:r2` });
    return "completed";
  },
};

function startFanOut(h: Harness, rootId: string, inputs: Array<{ dup?: boolean; fail?: boolean }>): void {
  const plan = fanOutPlan(rootId, item("调研"), { instruction: "go", items: inputs.map((x, i) => ({ title: `第${i}项`, input: { i, ...x } })), research: true });
  for (const g of plan.groups) for (const c of g.children) c.spec = { ...c.spec, processor: { kind: "code", entry: echo.name } };
  h.kernel.spawnCell("desk", rootSpec(plan), rootTask(plan));
}

function resultEnvelope(h: Harness, from: string, summary: string, id: string): Envelope {
  return { id, from: `inbox:${from}`, principalId: `cell:${from}`, kind: "result", type: PAYLOAD.cellResult, payload: { childCellId: from, status: "completed", summary }, createdAt: h.clock.now() };
}

describe("coordinator (join_all / join_any): zero tokens, duplicates and late arrivals change nothing", () => {
  it("a duplicate report, a report from a stranger and a late report after the card: still k/n and one card", async () => {
    const h = await boot({ setup: (r) => r.codeProcessors.register(echo) });
    startFanOut(h, "prj_t1", [{ dup: true }, {}, { fail: true }]);
    await h.kernel.idle();

    const [act] = h.actions("prj_t1");
    expect(act).toMatchObject({ progress: { done: 3, total: 3 }, owner: "human" });
    const cards = h.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.clarify.prep.summary).toBe("已汇总 3 份结果（1 份未完成）");
    const body = h.kernel.context.getArtifactSync(cards[0]!.artifactId!)!.content.body;
    expect(body).toContain("**第0项**：item 0");
    expect(body).not.toContain("duplicate");
    expect(body).toContain("**第2项**（未完成）：item 2");

    // Late and stray reports while the card waits.
    h.kernel.inbox.enqueueSync("prj_t1", resultEnvelope(h, "prj_t1-w2", "late again", "late-1"));
    h.kernel.inbox.enqueueSync("prj_t1", resultEnvelope(h, "someone-else", "stray", "stray-1"));
    await h.kernel.idle();
    expect(h.kernel.gate.listApprovalsSync({ subjectKey: subjectKeys.project("prj_t1") })).toHaveLength(1);
    expect(h.actions("prj_t1")[0]).toMatchObject({ progress: { done: 3, total: 3 } });
    expect(h.kernel.context.getArtifactSync(cards[0]!.artifactId!)!.version).toBe(1);
    expect(h.script.requests).toEqual([]);

    // After the item finished and closed, a late report is dropped by the kernel; the books stay final.
    await h.kernel.resolveApproval(cards[0]!.actionId, { decision: "approve", seenArtifactVersion: 1 });
    await h.kernel.idle();
    expect(h.kernel.getCell("prj_t1")?.status).toBe("closed");
    h.kernel.inbox.enqueueSync("prj_t1", resultEnvelope(h, "prj_t1-w1", "very late", "late-2"));
    await h.kernel.idle();
    expect(h.kernel.inbox.listMessagesSync({ cellId: "prj_t1", envelopeId: "late-2" })[0]!.status).toBe("cancelled");
    expect(h.project("prj_t1")).toMatchObject({ lifecycle: "completed" });
    expect(h.actions("prj_t1")[0]).toMatchObject({ status: "done" });
  });

  it("re-delivering an already applied report is a no-op (inbox dedupe, and the root's own seen-list for retried claims)", async () => {
    const h = await boot({ setup: (r) => r.codeProcessors.register(echo) });
    startFanOut(h, "prj_t2", [{}, {}]);
    await h.kernel.idle();
    const st = h.state<CoordinatorState>("prj_t2", KEYS.coordinator)!;
    const seenResult = st.seen.find((id) => id.endsWith(":r1"))!;
    expect(seenResult).toBeDefined();
    // Re-deliver an already applied envelope under its own id to a fresh inbox row (as a retry would): no effect.
    const original = h.kernel.inbox.listMessagesSync({ cellId: "prj_t2", envelopeId: seenResult })[0]!.envelope;
    h.kernel.inbox.enqueueSync("prj_t2", { ...original, id: seenResult });
    await h.kernel.idle();
    expect(h.cards()).toHaveLength(1);
    expect(h.state<CoordinatorState>("prj_t2", KEYS.coordinator)!.slots["w1"]!.status).toBe("done");
  });
});

describe("wait_match (watcher): one reply, one timeout, one nudge", () => {
  async function chase(h: Harness, rootId: string) {
    const plan = chasePlan(rootId, item("报价"), {
      description: "等报价",
      parties: [{ id: "a", label: "甲", to: "channel:memory:a", thread: "memory:qa" }],
      dueAt: T0 + DAY,
    });
    h.kernel.spawnCell("desk", rootSpec(plan), rootTask(plan));
    await h.kernel.idle();
    return `${rootId}-p1`;
  }

  it("a second message after the reply and a late timer change nothing", async () => {
    const h = await boot();
    const w = await chase(h, "prj_w1");
    await h.memory.inject({ from: "a", text: "报价 100", threads: ["memory:qa"] });
    await h.kernel.idle();
    // The watcher is done and closed by its root, so a later message on that thread is a new item for the desk.
    const again = await h.kernel.ingest({ id: "m-2", from: "channel:memory:a", principalId: "memory:a", kind: "event", type: PAYLOAD.userMessage, payload: { text: "补充：含运费" }, threads: ["memory:qa"], createdAt: h.clock.now() }, "memory");
    expect(again.routedBy).toBe("desk");
    await h.kernel.idle();
    const results = h.kernel.inbox.listMessagesSync({ cellId: "prj_w1", type: PAYLOAD.cellResult });
    expect(results).toHaveLength(1);
    expect(h.state<WatcherState>(w, KEYS.watcher)).toMatchObject({ status: "replied", reply: { text: "报价 100" } });
    expect(h.kernel.inbox.listMessagesSync({ cellId: w, type: PAYLOAD.timerFired }).map((m) => m.status)).toEqual(["cancelled"]);
    h.clock.set(T0 + 2 * DAY);
    await h.kernel.idle();
    expect(h.kernel.inbox.listMessagesSync({ cellId: "prj_w1", type: GTD_PAYLOAD.watch })).toEqual([]);
    expect(h.cards()).toHaveLength(1); // only the summary card
  });

  it("duplicate timeouts draft one nudge and ask for the card once", async () => {
    const h = await boot();
    const w = await chase(h, "prj_w2");
    const timer = (id: string): Envelope => ({ id, from: `timer:${w}`, principalId: `cell:${w}`, kind: "event", type: PAYLOAD.timerFired, payload: { label: "等待超时检查", data: { gtd: "timeout" } }, createdAt: h.clock.now() });
    h.clock.set(T0 + DAY);
    h.kernel.inbox.enqueueSync(w, timer("dup-timeout"));
    await h.kernel.idle();
    const overdue = h.kernel.inbox.listMessagesSync({ cellId: "prj_w2", type: GTD_PAYLOAD.watch }).filter((m) => (m.envelope.payload as { event: string }).event === "overdue");
    expect(overdue).toHaveLength(1);
    expect(h.cards()).toHaveLength(1);
    expect(h.kernel.context.getArtifactSync(`${w}-nudge`)!.version).toBe(1);
    // The reply arrives while the nudge card waits: the card is taken down, the wait completes.
    await h.memory.inject({ from: "a", text: "抱歉晚了，报价 120", threads: ["memory:qa"] });
    await h.kernel.idle();
    const cards = h.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.clarify.cardType).toBe("response");
    expect(h.actions("prj_w2")[0]!.waiting!.parties[0]).toMatchObject({ replied: true, repliedAt: T0 + DAY });
    expect(h.memory.deliveries).toEqual([]);
    void HOUR;
  });
});

describe("setProjectLifecycleSync (for the app's Radar buttons)", () => {
  it("cancels a project and its open actions in one commit", async () => {
    const h = await boot({ setup: (r) => r.codeProcessors.register(echo) });
    const plan = chasePlan("prj_s1", item("等回复"), { description: "等回复", parties: [{ id: "a", label: "甲", thread: "memory:x" }], dueAt: T0 + DAY });
    h.kernel.spawnCell("desk", rootSpec(plan), rootTask(plan));
    await h.kernel.idle();
    await h.kernel.closeCell("prj_s1", "cancelled");
    expect(setProjectLifecycleSync(h.kernel.context, "prj_s1", "cancelled", h.clock.now())).toBe(true);
    expect(h.project("prj_s1")).toMatchObject({ lifecycle: "cancelled", completedAt: h.clock.now() });
    expect(h.kernel.context.listStateSync("prj_s1", gtdKeys.actionPrefix).map((e) => (e.value as { status: string }).status)).toEqual(["cancelled"]);
    expect(setProjectLifecycleSync(h.kernel.context, "desk", "cancelled", h.clock.now())).toBe(false);
  });
});
