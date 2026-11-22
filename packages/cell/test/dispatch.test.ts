import type { ModelRequest } from "@ng/loop/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  asClarifyCard,
  finalResultEnvelopeId,
  PAYLOAD,
  steerNoteText,
  timerFrom,
  type CellResultPayload,
  type CodeProcessor,
  type Registry,
} from "@ng/protocol";
import { boot, cleanupAll, HOUR, registerTestPresets, requestText, tool, waitFor, type Harness } from "./helpers";

afterEach(cleanupAll);

/** A promise the test resolves to let a model call return (deterministic "the model is thinking"). */
function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

/** Max number of Runs of the given cells that overlapped, from run.started/run.finished order. */
function maxOverlap(h: Harness, cellIds?: string[]): number {
  let cur = 0;
  let max = 0;
  for (const e of h.events) {
    if (e.topic !== "run.started" && e.topic !== "run.finished") continue;
    const cellId = (e.data as { cellId: string }).cellId;
    if (cellIds && !cellIds.includes(cellId)) continue;
    cur += e.topic === "run.started" ? 1 : -1;
    max = Math.max(max, cur);
  }
  return max;
}

const userTexts = (req: ModelRequest) => (requestText(req).match(/msg-\d+/g) ?? []).sort();

describe("dispatcher", () => {
  it("one Run per cell: messages arriving mid-Run coalesce into the next batch", async () => {
    const h = await boot();
    const g = gate();
    h.script.add(
      "desk",
      async () => {
        await g.wait;
        return { text: "first done" };
      },
      { text: "second done" },
    );
    await h.memory.inject({ from: "a", text: "msg-1" });
    await waitFor(() => h.kernel.activeRuns().length === 1, 5_000, "first run");
    for (let i = 2; i <= 5; i++) await h.memory.inject({ from: "a", text: `msg-${i}` });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.kernel.activeRuns()).toHaveLength(1);
    g.open();
    await h.kernel.idle();

    expect(maxOverlap(h, ["desk"])).toBe(1);
    expect(h.of("run.started")).toHaveLength(2);
    const reqs = h.script.callsOf("desk");
    expect(userTexts(reqs[1]!)).toEqual(expect.arrayContaining(["msg-2", "msg-3", "msg-4", "msg-5"]));
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk" }).every((m) => m.status === "done")).toBe(true);
  });

  it("processes later reminders after a malformed reminder rolls back", async () => {
    const failures: unknown[] = [];
    const h = await boot({
      start: false,
      kernel: { onError: error => failures.push(error) },
      setup(registry) {
        registry.presets.register({
          name: "inline",
          description: "reminder inbox",
          defaults: { processor: { kind: "llm" } },
          personalReminder(env) {
            return { id: env.id, draft: { title: env.id, subjectKey: env.id, category: "action",
              options: [{ id: "done", label: "已办完", effect: env.id === "broken" ? "reply" : "complete" }] } };
          },
        });
      },
    });
    for (const id of ["broken", "valid"]) {
      h.kernel.inbox.enqueueSync("desk", {
        id, from: timerFrom("desk"), principalId: "owner", kind: "event", type: PAYLOAD.timerFired,
        payload: { label: id }, createdAt: h.clock.now(),
      });
    }
    await h.kernel.start();
    await h.kernel.idle();
    expect(failures).toHaveLength(1);
    expect(h.kernel.humanItems.get("broken")).toBeUndefined();
    expect(h.kernel.humanItems.get("valid")).toMatchObject({ title: "valid", status: "pending" });
    expect(h.kernel.hub.listNotificationsSync().map(n => n.content.body)).toEqual(["⏰ 提醒：valid"]);
  });

  it("a global cap bounds Runs across cells; everything still runs", async () => {
    const h = await boot({ kernel: { maxConcurrentRuns: 2 } });
    const ids = ["w1", "w2", "w3", "w4", "w5"];
    for (const id of ids) {
      h.script.add(id, { text: "ok", delayMs: 20 });
      h.kernel.spawnCell("desk", { id, preset: "worker", meta: { role: id } }, "go");
    }
    await h.kernel.idle();
    expect(maxOverlap(h)).toBe(2); // the cap counts every cell's Runs, the desk's included
    expect(h.of("run.finished").filter((e) => ids.includes(e.cellId)).map((e) => e.outcome)).toEqual(Array(5).fill("completed"));
    // wakeable workers: each told the desk once that its turn settled and stays, dormant; the desk was woken by them
    expect(ids.map((id) => h.kernel.activityOf([id]).get(id)!.state)).toEqual(Array(5).fill("dormant"));
    const runOf = (id: string) => h.of("run.started").find((e) => e.cellId === id)!.runId;
    const results = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult });
    expect(results.map((m) => m.envelope.id).sort()).toEqual(ids.map((id) => `${id}:${runOf(id)}:settled`).sort());
    expect(results.map((m) => (m.envelope.payload as CellResultPayload).summary)).toEqual(Array(5).fill("ok"));
    expect(h.of("run.finished").filter((e) => e.cellId === "desk").length).toBeGreaterThanOrEqual(1);
  });

  it("cancel takes effect at once, independent of queue length: the Run is aborted, 300 queued messages are dropped", async () => {
    const h = await boot();
    h.script.add("worker", { text: "never", delayMs: 60_000 });
    h.kernel.spawnCell("desk", { id: "w", preset: "worker" }, "start");
    await waitFor(() => h.kernel.activeRuns().some((r) => r.cellId === "w"), 5_000, "run");
    for (let i = 0; i < 300; i++) {
      h.kernel.inbox.enqueueSync("w", {
        id: `q${i}`,
        from: "inbox:desk",
        principalId: "cell:desk",
        kind: "event",
        type: PAYLOAD.userMessage,
        payload: { text: `queued ${i}` },
        createdAt: h.clock.now(),
      });
    }
    const t0 = Date.now();
    expect(h.kernel.control("w", { action: "cancel" })).toMatchObject({ applied: true });
    await h.kernel.idle();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(h.of("run.finished").filter((e) => e.cellId === "w").map((e) => e.outcome)).toEqual(["cancelled"]);
    expect(h.kernel.getCell("w")).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect(h.count("inbox_messages WHERE cell_id = 'w' AND status IN ('pending','claimed','done')")).toBe(0);
  });

  it("pause aborts the Run and gives the batch back without using an attempt; nothing runs until resume", async () => {
    const h = await boot({ kernel: { maxAttempts: 1 } });
    h.script.add("worker", { text: "slow", delayMs: 60_000 }, { text: "resumed and done" });
    h.kernel.spawnCell("desk", { id: "w", preset: "worker" }, "start");
    await waitFor(() => h.kernel.activeRuns().some((r) => r.cellId === "w"), 5_000, "run");

    expect(h.kernel.control("w", { action: "pause" })).toMatchObject({ applied: true });
    await h.kernel.idle();
    expect(h.of("run.finished").map((e) => e.outcome)).toEqual(["cancelled"]);
    const task = h.kernel.inbox.listMessagesSync({ cellId: "w", type: PAYLOAD.cellTask })[0]!;
    expect(task).toMatchObject({ status: "pending", attempts: 0 }); // with maxAttempts 1 a counted attempt would be dead
    expect(h.kernel.getCell("w")!.status).toBe("paused");

    h.kernel.inbox.enqueueSync("w", { id: "more", from: "inbox:desk", principalId: "cell:desk", kind: "event", type: PAYLOAD.userMessage, payload: { text: "more" }, createdAt: h.clock.now() });
    await h.kernel.idle();
    expect(h.of("run.started")).toHaveLength(1);

    h.kernel.control("w", { action: "resume" });
    await h.kernel.idle();
    expect(h.of("run.finished").filter((e) => e.cellId === "w").map((e) => e.outcome)).toEqual(["cancelled", "completed"]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "w" }).map((m) => m.status)).toEqual(["done", "done"]);
    expect(h.kernel.gate.listPendingSync()).toEqual([]); // no escalation for a pause
    // the resumed Run took both messages, so the worker reported its turn once and stays, dormant
    expect(h.kernel.getCell("w")!.status).toBe("active");
    expect(h.kernel.activityOf(["w"]).get("w")!.state).toBe("dormant");
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => (m.envelope.payload as CellResultPayload).summary)).toEqual([
      "resumed and done",
    ]);
  });

  it("steer reaches the running Loop between steps, without a second Run", async () => {
    const h = await boot();
    const g = gate();
    h.script.add(
      "desk",
      async () => {
        await g.wait;
        return tool("set_state", { patches: { plan: "A" } });
      },
      (req) => {
        expect(requestText(req)).toContain(steerNoteText("改成方案 B"));
        return tool("set_state", { patches: { plan: "B" } });
      },
      { text: "switched" },
    );
    await h.ui.capture({ text: "按方案 A 写周报" });
    await waitFor(() => h.kernel.activeRuns().length === 1, 5_000, "run");
    expect(h.kernel.control("desk", { action: "steer", steerMessage: "改成方案 B" })).toMatchObject({ applied: true });
    g.open();
    await h.kernel.idle();
    expect(h.kernel.context.readStateSync("desk", "plan")).toBe("B");
    expect(h.of("run.started")).toHaveLength(1);
    const steer = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.controlSteer })[0]!;
    expect(steer).toMatchObject({ status: "done", statusReason: "drained mid-run" });
  });

  it("a timer set before a cancel never fires after it (epoch guard)", async () => {
    const h = await boot();
    h.script.add("hub", tool("set_reminder", { label: "follow up", inSeconds: 3600 }), { text: "set" });
    // a cell that lives on its timer (a one-shot one is closed, its timers with it, as soon as its Run completes)
    h.kernel.spawnCell("desk", { id: "w", preset: "hub", lifetime: "persistent" }, "go");
    await h.kernel.idle();
    const timer = h.kernel.inbox.listMessagesSync({ cellId: "w", type: PAYLOAD.timerFired })[0]!;
    expect(timer).toMatchObject({ status: "pending", expectedEpoch: 0 });
    h.kernel.control("w", { action: "cancel" });
    await h.kernel.idle();
    h.clock.advance(2 * HOUR);
    await h.kernel.idle();
    expect(h.of("run.started").filter((e) => e.cellId === "w")).toHaveLength(1);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "w", type: PAYLOAD.timerFired })[0]!.status).toBe("cancelled");
  });
});

describe("escalations", () => {
  it("a model that keeps failing ends as one escalation card (never a silent loss); continue requeues and it then succeeds", async () => {
    const h = await boot({ kernel: { maxAttempts: 2 } });
    h.script.add("desk", { error: new Error("upstream 529 overloaded") }, { error: new Error("upstream 529 overloaded") });
    await h.memory.inject({ from: "alice", text: "需要你看一下这个" });
    await h.kernel.idle();
    expect(h.of("run.finished").map((e) => e.outcome)).toEqual(["error"]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk" })[0]).toMatchObject({ status: "pending", attempts: 1 });

    h.clock.advance(2_000); // past the retry backoff
    await h.kernel.idle();
    expect(h.of("run.finished").map((e) => e.outcome)).toEqual(["error", "error"]);
    const [msg] = h.kernel.inbox.listMessagesSync({ cellId: "desk" });
    expect(msg!.status).toBe("dead");

    const cards = h.kernel.gate.listPendingSync();
    expect(cards).toHaveLength(1);
    const card = asClarifyCard(cards[0]!.card.data)!;
    expect(card).toMatchObject({ cardType: "escalation", subjectKey: "kernel:desk:retry_limit", escalation: { reason: "retry_limit" } });
    expect(card.rawInput).toEqual({ text: "需要你看一下这个", kind: "message" });
    expect(card.source.label).toBe("memory");

    h.script.add("desk", { text: "handled at last" });
    const item = h.kernel.humanItems.get(cards[0]!.actionId)!;
    expect(item.options[0]?.effect).toBe("execute");
    expect(await h.kernel.humanItems.decide(item.id, {optionId:item.options[0]!.id, seenItemRevision:item.itemRevision, note:"再试一次"}, "agent:helper")).toMatchObject({status:"continued"});
    await h.kernel.idle();
    expect(h.of("run.finished").map((e) => e.outcome)).toEqual(["error", "error", "completed"]);
    expect(h.kernel.gate.getApprovalSync(cards[0]!.actionId)!.status).toBe("executed");
    expect(h.kernel.gate.listPendingSync()).toEqual([]);
  });

  it("continues a step-limited task independently of its dead letters", async () => {
    const h = await boot({kernel:{maxAttempts:1}});
    h.kernel.spawnCell("desk", {id:"w", preset:"worker"});
    const stepRequest = h.kernel.gate.authorizeSync({
      type:"custom", name:"kernel.escalation", subjectKey:"kernel:w:step_limit", sideEffect:"external", summary:"超步",
      args:{kernel:true, cellId:"w", reason:"retry_limit", stepLimit:true},
    }, {cellId:"desk", epoch:0, principalId:"kernel:escalation"});
    if (stepRequest.type !== "defer") throw Error(stepRequest.type);
    h.script.add("worker", {error: Error("dead letter")});
    h.kernel.sendToCell("w", {text:"重新核查"});
    await h.kernel.idle();
    const step = h.kernel.humanItems.get(stepRequest.actionId)!;
    expect(step.subjectKey).toBe("kernel:w:step_limit");
    const dead = h.kernel.humanItems.list().find(i => i.subjectKey === "kernel:w:retry_limit")!;
    await h.kernel.humanItems.decide(step.id, {optionId:"system.execute", seenItemRevision:step.itemRevision, note:"再走一步"}, "owner");
    expect(h.kernel.inbox.listMessagesSync({cellId:"w", type:PAYLOAD.approvalResolved}).some(m => (m.envelope.payload as {note?:string}).note === "再走一步")).toBe(true);
    await h.kernel.humanItems.decide(dead.id, {optionId:"system.execute", seenItemRevision:dead.itemRevision}, "owner");
    await h.kernel.idle();
    expect(h.kernel.inbox.listMessagesSync({cellId:"w"}).filter(m => m.envelope.id.includes("#retry:"))).toHaveLength(1);
  });

  it("a second dead letter of the same item does not create a second card", async () => {
    const h = await boot({ kernel: { maxAttempts: 1 } });
    h.script.add("worker", { error: new Error("boom") }, { error: new Error("boom again") });
    h.kernel.spawnCell("desk", { id: "w", preset: "worker" }, "go");
    await h.kernel.idle();
    h.kernel.inbox.enqueueSync("w", { id: "m2", from: "inbox:desk", principalId: "cell:desk", kind: "event", type: PAYLOAD.userMessage, payload: { text: "again" }, createdAt: h.clock.now() });
    await h.kernel.idle();
    expect(h.kernel.inbox.listMessagesSync({ cellId: "w", status: ["dead"] })).toHaveLength(2);
    const cards = h.kernel.gate.listPendingSync();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ cellId: "w", subjectKey: "kernel:w:retry_limit" });
    const card = h.kernel.humanItems.get(cards[0]!.actionId)!;
    await h.kernel.humanItems.decide(card.id, {optionId:card.options[0]!.id, seenItemRevision:card.itemRevision}, "owner");
    await h.kernel.idle();
    expect(h.kernel.inbox.listMessagesSync({cellId:"w"}).filter(m => m.envelope.id.includes("#retry:"))).toHaveLength(2);
  });

});

describe("leaf results (docs/05 guard 1: the kernel is the single sender)", () => {
  // RunPorts.emitToParent(cell.result) from a leaf is staged as the candidate, never sent from the port: the settle
  // transaction stays the only sender, so the parent gets exactly one result with the emitted summary.
  it("a leaf's code processor that emits cell.result itself still reaches its parent exactly once (one-shot: its final result; wakeable: its turn's notice)", async () => {
    const emit: CodeProcessor = {
      name: "test.emit_result",
      async run({ ports }) {
        await ports.emitToParent(PAYLOAD.cellResult, { childCellId: ports.self.cellId, status: "completed", summary: "emitted directly" } satisfies CellResultPayload);
        return "completed";
      },
    };
    const h = await boot({
      setup(registry: Registry) {
        registerTestPresets(registry);
        registry.codeProcessors.register(emit);
      },
    });
    h.kernel.spawnCell("desk", { id: "e", preset: "checker", processor: { kind: "code", entry: emit.name } }, "go");
    await h.kernel.idle();
    expect(h.kernel.getCell("e")!.status).toBe("closed");
    const sent = () => h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => [m.envelope.id, (m.envelope.payload as CellResultPayload).summary]);
    expect(sent()).toEqual([[finalResultEnvelopeId("e", 0), "emitted directly"]]);

    // the same from a wakeable worker: one notice for its turn, which carries the emitted summary
    h.kernel.spawnCell("desk", { id: "f", preset: "worker", processor: { kind: "code", entry: emit.name } }, "go");
    await h.kernel.idle();
    expect(h.kernel.getCell("f")!.status).toBe("active");
    const run = h.of("run.started").find((e) => e.cellId === "f")!.runId;
    expect(sent()).toEqual([
      [finalResultEnvelopeId("e", 0), "emitted directly"],
      [`f:${run}:settled`, "emitted directly"],
    ]);
  });
});
