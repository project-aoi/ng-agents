import { afterEach, describe, expect, it } from "vitest";
import { isNgError, PAYLOAD, type CellResultPayload } from "@ng/protocol";
import { boot, cleanupAll, requestText, tempDir, type Harness } from "./helpers";

afterEach(cleanupAll);

// The owner's switch for budget limits: off means no cell is stopped, held or refused for its budget — and usage is
// still counted, so what was spent stays visible.

const outcomes = (h: Harness, id: string) => h.of("run.finished").filter((e) => e.cellId === id).map((e) => e.outcome);
const heavy = { inputTokens: 3_000, outputTokens: 2_000 };

describe("budget limits switched off", () => {
  it("from the start: a cell far past its limit just works; no card, no stop, usage still counted", async () => {
    const h = await boot({ kernel: { budgetLimits: false } });
    expect(h.kernel.budgetLimits()).toEqual({ enforced: false });
    h.script.add("worker", { text: "long analysis", usage: heavy });
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", bounds: { maxTokens: 1_000 } }, "analyse everything");
    await h.kernel.idle();
    expect(outcomes(h, "w")).toEqual(["completed"]);
    expect(h.kernel.gate.listPendingSync()).toEqual([]);
    expect(h.kernel.gate.usageSync("w")).toMatchObject({ subtreeTokens: 5_000, limitTokens: 1_000, state: "ok", limitedBy: null, enforced: false });
    expect(h.of("ledger.alert")).toEqual([]);
    // A child can still be started under a ledger that would be exhausted.
    expect(() => h.kernel.spawnCell("desk", { id: "w2", preset: "worker", bounds: { maxTokens: 1_000 } })).not.toThrow();
  });

  it("at runtime: the stopped cell goes on, the held one starts with everything that waited, and their cards are answered", async () => {
    const h = await boot();
    expect(h.kernel.budgetLimits()).toEqual({ enforced: true });
    // One worker is stopped in the middle of its run, a project is then held at the stop with a message waiting.
    h.script.add("worker", { text: "half way", usage: heavy });
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", title: "修 CI", bounds: { maxTokens: 1_000 } }, "fix CI");
    h.kernel.spawnCell("desk", { id: "proj", preset: "project", title: "调研", meta: { role: "proj" }, bounds: { maxTokens: 1_000 } });
    h.script.add("proj", { text: "planning", usage: heavy });
    h.kernel.sendToCell("proj", { text: "start" }, { principalId: "cell:desk" });
    await h.kernel.idle();
    h.kernel.sendToCell("proj", { text: "second message" }, { principalId: "cell:desk" });
    await h.kernel.idle();
    expect(outcomes(h, "w")).toEqual(["budget_stopped"]);
    expect(outcomes(h, "proj")).toEqual(["budget_stopped"]);
    expect(h.kernel.gate.listPendingSync()).toHaveLength(2);

    h.script.add("worker", { text: "finished the fix", usage: heavy });
    let projSaw = "";
    h.script.add("proj", (req) => {
      projSaw = requestText(req);
      return { text: "continuing", usage: heavy };
    });
    const r = h.kernel.setBudgetLimits(false);
    expect(r).toMatchObject({ enforced: false, changed: true, releasedCells: ["proj"] });
    expect(r.continuedCards).toHaveLength(2);
    await h.kernel.idle();

    expect(h.kernel.gate.listPendingSync()).toEqual([]);
    expect(outcomes(h, "w")).toEqual(["budget_stopped", "completed"]);
    expect(outcomes(h, "proj")).toEqual(["budget_stopped", "completed"]);
    expect(projSaw).toContain("second message");
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => (m.envelope.payload as CellResultPayload).summary)).toEqual(["finished the fix"]);
    // No budget was raised to get there: the limits are simply not applied.
    expect(h.kernel.gate.usageSync("w")).toMatchObject({ raisedTokens: 0, state: "ok", enforced: false });
    // Flipping to the value it already has changes nothing.
    expect(h.kernel.setBudgetLimits(false)).toMatchObject({ changed: false, releasedCells: [], continuedCards: [] });
  });

  it("is the owner's alone, is remembered across restarts, and switching it back on stops cells again", async () => {
    const dataDir = tempDir("data");
    const h = await boot({ dataDir });
    for (const principalId of ["agent:claude", "cell:desk"]) {
      let err: unknown;
      try {
        h.kernel.setBudgetLimits(false, { principalId });
      } catch (e) {
        err = e;
      }
      expect(isNgError(err, "bounds_violation")).toBe(true);
    }
    expect(h.kernel.budgetLimits().enforced).toBe(true);
    h.kernel.setBudgetLimits(false);
    await h.kernel.close();

    // No option given: the stored choice applies.
    const h2 = await boot({ dataDir });
    expect(h2.kernel.budgetLimits().enforced).toBe(false);
    h2.script.add("worker", { text: "spent a lot", usage: heavy });
    h2.kernel.spawnCell("desk", { id: "w", preset: "worker", bounds: { maxTokens: 1_000 } }, "go");
    await h2.kernel.idle();
    expect(outcomes(h2, "w")).toEqual(["completed"]);

    // Back on: the ledger is over its limit, so the next wake-up is held and the owner gets the card.
    expect(h2.kernel.setBudgetLimits(true)).toMatchObject({ enforced: true, changed: true });
    expect(h2.kernel.gate.usageSync("w")).toMatchObject({ state: "hard_stop", enforced: true });
    h2.kernel.sendToCell("w", { text: "one more" }, { principalId: "cell:desk" });
    await h2.kernel.idle();
    expect(outcomes(h2, "w")).toEqual(["completed"]);
    expect(h2.kernel.gate.listPendingSync()).toHaveLength(1);
    await h2.kernel.close();

    // An explicit option wins over the stored choice for that process.
    const h3 = await boot({ dataDir, kernel: { budgetLimits: false } });
    expect(h3.kernel.budgetLimits().enforced).toBe(false);
  });
});
