import { afterEach, describe, expect, it } from "vitest";
import {
  asClarifyCard,
  CELL_RESULT_CANDIDATE_KEY,
  finalResultEnvelopeId,
  PAYLOAD,
  steerNoteText,
  type CellResultCandidate,
  type CellResultPayload,
  type CodeProcessor,
  type ModelRequest,
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
    // one-shot workers: each delivered exactly one final result and was closed; the desk was woken by them
    expect(ids.map((id) => h.kernel.getCell(id)!.status)).toEqual(Array(5).fill("closed"));
    const results = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult });
    expect(results.map((m) => m.envelope.id).sort()).toEqual(ids.map((id) => finalResultEnvelopeId(id, 0)));
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
    // the resumed Run took both messages, so the one-shot worker reported once and closed
    expect(h.kernel.getCell("w")).toMatchObject({ status: "closed", closeReason: "completed" });
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
    h.script.add("watcher", tool("set_reminder", { label: "follow up", inSeconds: 3600 }), { text: "set" });
    h.kernel.spawnCell("desk", { id: "w", preset: "watcher" }, "go");
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
    expect(card).toMatchObject({ cardType: "escalation", subjectKey: `msg:${msg!.envelope.id}`, escalation: { reason: "retry_limit" } });
    expect(card.rawInput).toEqual({ text: "需要你看一下这个", kind: "message" });
    expect(card.source.label).toBe("memory");

    h.script.add("desk", { text: "handled at last" });
    expect(await h.kernel.resolveApproval(cards[0]!.actionId, { decision: "continue" })).toMatchObject({ status: "continued" });
    await h.kernel.idle();
    expect(h.of("run.finished").map((e) => e.outcome)).toEqual(["error", "error", "completed"]);
    expect(h.kernel.gate.getApprovalSync(cards[0]!.actionId)!.status).toBe("executed");
    expect(h.kernel.gate.listPendingSync()).toEqual([]);
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
    expect(cards[0]).toMatchObject({ cellId: "w", subjectKey: "cell:w" });
  });

  it("budget hard stop → an escalation card even though the budget is gone; raising it lets the cell continue", async () => {
    const h = await boot();
    h.script.add("worker", { text: "thinking hard", usage: { inputTokens: 600, outputTokens: 600 } });
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", title: "修 CI", bounds: { maxTokens: 1_000 } }, "fix CI");
    await h.kernel.idle();
    expect(h.of("run.finished").map((e) => e.outcome)).toEqual(["budget_stopped"]);
    const [pending] = h.kernel.gate.listPendingSync();
    const card = asClarifyCard(pending!.card.data)!;
    expect(card).toMatchObject({ cardType: "escalation", subjectKey: "cell:w", title: "「修 CI」的预算已用完", escalation: { reason: "budget_exhausted", usage: { limitTokens: 1_000 } } });
    expect(pending!.cellId).toBe("w");

    // further stops on the same item do not stack cards
    h.kernel.inbox.enqueueSync("w", { id: "poke", from: "inbox:desk", principalId: "cell:desk", kind: "event", type: PAYLOAD.userMessage, payload: { text: "poke" }, createdAt: h.clock.now() });
    await h.kernel.idle();
    expect(h.kernel.gate.listPendingSync()).toHaveLength(1);

    h.script.add("worker", { text: "continuing", usage: { inputTokens: 10, outputTokens: 10 } });
    expect(await h.kernel.resolveApproval(pending!.actionId, { decision: "continue", raise: { tokens: 5_000 } })).toMatchObject({ status: "continued" });
    expect(h.kernel.gate.usageSync("w")).toMatchObject({ raisedTokens: 5_000, state: "ok" });
    await h.kernel.idle();
    // a budget stop is never a result: the one-shot worker stayed open until the Run after the raise completed
    expect(h.of("run.finished").filter((e) => e.cellId === "w").map((e) => e.outcome)).toEqual(["budget_stopped", "budget_stopped", "completed"]);
    const resolved = h.kernel.inbox.listMessagesSync({ cellId: "w", type: PAYLOAD.approvalResolved })[0]!;
    expect(resolved).toMatchObject({ status: "done" });
    expect(resolved.envelope.payload).toMatchObject({ status: "executed", decision: "continue" });
    expect(h.kernel.getCell("w")).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => (m.envelope.payload as CellResultPayload).summary)).toEqual([
      "continuing",
    ]);
  });

  it("resolve_offline on an escalation closes the affected cell and withdraws the card", async () => {
    const h = await boot();
    h.script.add("worker", { text: "x", usage: { inputTokens: 2_000, outputTokens: 0 } });
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", bounds: { maxTokens: 1_000 } }, "go");
    await h.kernel.idle();
    const [card] = h.kernel.gate.listPendingSync();
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "resolve_offline" })).toEqual({
      status: "resolved_offline",
      actionId: card!.actionId,
      closedCellIds: ["w"],
    });
    expect(h.kernel.getCell("w")).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.kernel.gate.getApprovalSync(card!.actionId)!.status).toBe("cancelled");
  });
});

describe("DND", () => {
  it("focus buffers the owner's notifications but never parent/child traffic", async () => {
    // A one-shot child stages its result (what report_to_parent does); the kernel delivers it when the Run settles.
    const report: CodeProcessor = {
      name: "test.report",
      async run({ ports, clock }) {
        const r: CellResultCandidate = { status: "completed", summary: "child finished during focus", at: clock.now() };
        await ports.context.commit(ports.self.cellId, { statePatches: { [CELL_RESULT_CANDIDATE_KEY]: r } });
        return "completed";
      },
    };
    const h = await boot({
      setup(registry: Registry) {
        registerTestPresets(registry);
        registry.codeProcessors.register(report);
      },
    });
    h.kernel.hub.setFocusSync(true);
    h.script.add("desk", tool("send_message", { to: "channel:ui:owner", text: "子任务完成了", summary: "notify" }), { text: "ok" });
    h.kernel.spawnCell("desk", { id: "c", preset: "worker", processor: { kind: "code", entry: "test.report" } }, "go");
    await h.kernel.idle();

    // the child's result woke the desk at once, focus or not
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => [m.status, (m.envelope.payload as CellResultPayload).summary])).toEqual([
      ["done", "child finished during focus"],
    ]);
    expect(h.of("run.finished").filter((e) => e.cellId === "desk").map((e) => e.outcome)).toEqual(["completed"]);
    // ...while the desk's notice to the owner waits for the end of focus
    expect(h.kernel.hub.listOutboxSync({ channelId: "ui" }).map((o) => o.status)).toEqual(["buffered_dnd"]);
    expect(h.kernel.stats()).toMatchObject({ bufferedNotifications: 1, focus: true });

    h.kernel.hub.setFocusSync(false);
    expect(await h.kernel.hub.flushBuffered()).toMatchObject({ sent: 1 });
  });
});

describe("competing workers", () => {
  it("a cell that asks for a pool gets parallel Runs, one message each", async () => {
    const h = await boot();
    const g = gate();
    for (let i = 0; i < 3; i++) {
      h.script.add("pool", async () => {
        await g.wait;
        return { text: "done" };
      });
    }
    // a pool lives on (a one-shot cell must claim serially: drain-then-close needs one claim to decide on)
    h.kernel.spawnCell("desk", { id: "p", preset: "worker", lifetime: "persistent", claimMode: "competing_workers", maxParallelRuns: 3, meta: { role: "pool" } });
    for (let i = 0; i < 3; i++) {
      h.kernel.inbox.enqueueSync("p", { id: `j${i}`, from: "inbox:desk", principalId: "cell:desk", kind: "event", type: PAYLOAD.userMessage, payload: { text: `job ${i}` }, createdAt: h.clock.now() });
    }
    await waitFor(() => h.kernel.activeRuns().length === 3, 5_000, "three parallel runs");
    g.open();
    await h.kernel.idle();
    expect(maxOverlap(h, ["p"])).toBe(3);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "p" }).every((m) => m.status === "done")).toBe(true);
    expect(h.kernel.getCell("p")!.status).toBe("active");
  });

  it("a one-shot cell cannot ask for a pool", async () => {
    const h = await boot();
    expect(() => h.kernel.spawnCell("desk", { id: "p", preset: "worker", claimMode: "competing_workers", maxParallelRuns: 3 })).toThrow(
      "a one_shot cell claims serially (claimMode serial_coalesce)",
    );
  });
});

describe("one-shot results (docs/05 guard 1: the kernel is the single sender)", () => {
  // RunPorts.emitToParent(cell.result) from a one_shot cell is staged as the candidate, never sent from the port: the
  // settle transaction stays the only sender, so the parent gets exactly one result with the emitted summary.
  it("a one-shot code processor that emits cell.result itself still reaches its parent exactly once", async () => {
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
    h.kernel.spawnCell("desk", { id: "e", preset: "worker", processor: { kind: "code", entry: emit.name } }, "go");
    await h.kernel.idle();
    expect(h.kernel.getCell("e")!.status).toBe("closed");
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => (m.envelope.payload as CellResultPayload).summary)).toEqual([
      "emitted directly",
    ]);
  });
});
