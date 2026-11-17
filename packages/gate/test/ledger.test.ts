import { describe, expect, it } from "vitest";
import { all } from "@ng/protocol";
import { exec, expectType, meta, setup, withWorker } from "./helpers";

const alerts = (f: ReturnType<typeof setup>) => f.events.filter((e) => e.topic === "ledger.alert").map((e) => e.data);

describe("dual ledger", () => {
  it("meter adds to the cell's own ledger and to every ancestor's subtree rollup", () => {
    const f = setup();
    withWorker(f, "proj", { maxTokens: 500_000, maxCents: 5_000, maxDepth: 2 });
    f.cells.insert({ id: "leaf", parentId: "proj", bounds: f.gate.attenuate(f.cells.require("proj").bounds, "proj", { maxTokens: 100_000 }) });
    expect(f.gate.meter("leaf", { tokens: 1_000, billedCents: 12.5 })).toBe("ok");
    expect(f.gate.meter("proj", { tokens: 500, billedCents: 1 })).toBe("ok");
    expect(f.gate.usageSync("leaf")).toMatchObject({ ownTokens: 1_000, subtreeTokens: 1_000, ownCents: 12.5, subtreeCents: 12.5, limitTokens: 100_000 });
    expect(f.gate.usageSync("proj")).toMatchObject({ ownTokens: 500, subtreeTokens: 1_500, ownCents: 1, subtreeCents: 13.5 });
    expect(f.gate.usageSync("desk")).toMatchObject({ ownTokens: 0, subtreeTokens: 1_500, subtreeCents: 13.5, state: "ok", limitedBy: null });
    expect(all(f.db, "SELECT cell_id, tokens, cents FROM usage_log ORDER BY id")).toEqual([
      { cell_id: "leaf", tokens: 1_000, cents: 12.5 },
      { cell_id: "proj", tokens: 500, cents: 1 },
    ]);
  });

  it("hard-stops on tokens even when the provider bills $0 (subscription blind spot, docs/01 坑 2)", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 1_000, maxCents: 1_000 });
    expect(f.gate.meter("w1", { tokens: 600, billedCents: 0 })).toBe("ok");
    expect(f.gate.meter("w1", { tokens: 200, billedCents: 0 })).toBe("warn");
    expect(f.gate.meter("w1", { tokens: 199, billedCents: 0 })).toBe("warn");
    expect(f.gate.meter("w1", { tokens: 1, billedCents: 0 })).toBe("hard_stop");
    expect(f.gate.usageSync("w1")).toMatchObject({ subtreeTokens: 1_000, subtreeCents: 0, state: "hard_stop", limitedBy: "w1" });
    expect(alerts(f)).toEqual([
      { cellId: "w1", level: "warn" },
      { cellId: "w1", level: "hard_stop" },
    ]);
    expect(f.gate.meter("w1", { tokens: 0, billedCents: 0 })).toBe("hard_stop");
    expect(alerts(f)).toHaveLength(2); // announced once per crossing
    expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "deny");
  });

  it("hard-stops on cents independently", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 1_000_000, maxCents: 100 });
    expect(f.gate.meter("w1", { tokens: 10, billedCents: 100 })).toBe("hard_stop");
  });

  it("an ancestor's limit stops the whole subtree; limitedBy names the cell to raise", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 1_000_000 });
    f.addCell("w2", "desk", { tools: ["read"], maxTokens: 1_000_000, maxCents: 10_000 });
    expect(f.gate.meter("w2", { tokens: 999_999, billedCents: 0 })).toBe("warn");
    expect(f.gate.meter("w1", { tokens: 1, billedCents: 0 })).toBe("hard_stop");
    expect(f.gate.usageSync("w1")).toMatchObject({ state: "hard_stop", limitedBy: "desk", subtreeTokens: 1 });
    expect(alerts(f)).toContainEqual({ cellId: "desk", level: "hard_stop" });
    expect(expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "deny").feedback).toMatch(/ancestor cell "desk"/);
  });

  it("raiseBudget (追加额度继续) lifts the stop, is audited, and re-arms alerts", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 1_000, maxCents: 1_000 });
    f.gate.meter("w1", { tokens: 1_000, billedCents: 0 });
    const u = f.gate.raiseBudgetSync("w1", { tokens: 4_000 }, "owner");
    expect(u).toMatchObject({ limitTokens: 5_000, raisedTokens: 4_000, state: "ok", limitedBy: null });
    expect(all(f.db, "SELECT cell_id, tokens, cents, approver_id FROM budget_raises")).toEqual([
      { cell_id: "w1", tokens: 4_000, cents: 0, approver_id: "owner" },
    ]);
    expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "allow");
    expect(f.gate.meter("w1", { tokens: 4_000, billedCents: 0 })).toBe("hard_stop");
    expect(alerts(f).filter((a) => (a as { level: string }).level === "hard_stop")).toHaveLength(2);
    expect(() => f.gate.raiseBudgetSync("w1", { tokens: -1 }, "owner")).toThrow(/≥ 0/);
    expect(() => f.gate.raiseBudgetSync("ghost", { tokens: 1 }, "owner")).toThrow(/not found/);
  });

  it("a zero limit is exhausted from the start", () => {
    const f = setup();
    f.addCell("free", "desk", { tools: ["read"], maxTokens: 1_000, maxCents: 0 });
    expect(f.gate.usageSync("free").state).toBe("hard_stop");
    expectType(f.gate.authorizeSync(exec("read"), meta("free")), "deny");
  });

  it("rejects usage that is negative, non-finite or for an unknown cell (no refunds through meter)", () => {
    const f = setup();
    expect(() => f.gate.meter("desk", { tokens: -100, billedCents: 0 })).toThrow(/tokens/);
    expect(() => f.gate.meter("desk", { tokens: 1, billedCents: -1 })).toThrow(/billedCents/);
    expect(() => f.gate.meter("desk", { tokens: Number.NaN, billedCents: 0 })).toThrow(/tokens/);
    expect(() => f.gate.meter("desk", { tokens: 1, billedCents: Number.POSITIVE_INFINITY })).toThrow(/billedCents/);
    expect(() => f.gate.meter("ghost", { tokens: 1, billedCents: 0 })).toThrow(/not found/);
    expect(f.gate.meter("desk", { tokens: 0.2, billedCents: 0 })).toBe("ok");
    expect(f.gate.usageSync("desk").ownTokens).toBe(1); // fractional tokens round up
  });
});
