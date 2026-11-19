import { describe, expect, it } from "vitest";
import { all, get, isNgError, withTx, type BoundsInit } from "@ng/protocol";
// Not re-exported from the package index; imported from the module that defines them.
import { DEFAULT_CACHE_READ_WEIGHT, DEFAULT_WRAP_UP } from "../src/gate";
import { exec, expectType, meta, setup, withWorker, type Fixture } from "./helpers";

const alerts = (f: ReturnType<typeof setup>) => f.events.filter((e) => e.topic === "ledger.alert").map((e) => e.data);
const raisedEvents = (f: Fixture) => f.events.filter((e) => e.topic === "ledger.raised").map((e) => e.data);
const usageLog = (f: Fixture) => all(f.db, "SELECT cell_id, tokens, raw_tokens, cached_tokens, cents FROM usage_log ORDER BY id");

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

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

  it("only the owner may raise a budget: an agent on the control plane cannot spend past a hard stop (docs/05 guard 3)", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 1_000, maxCents: 1_000 });
    f.gate.meter("w1", { tokens: 1_000, billedCents: 0 });
    let err: unknown;
    try {
      f.gate.raiseBudgetSync("w1", { tokens: 4_000 }, "agent:ops");
    } catch (e) {
      err = e;
    }
    expect(isNgError(err, "bounds_violation")).toBe(true);
    expect((err as Error).message).toBe("raising a budget needs the owner; agent:ops may not");
    expect(f.gate.usageSync("w1")).toMatchObject({ raisedTokens: 0, state: "hard_stop" });
    expect(all(f.db, "SELECT * FROM budget_raises")).toEqual([]);
    expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "deny");
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

describe("prompt-cache reads are charged at a weight", () => {
  it("default weight 0.1: cache reads count a tenth, the rest in full; usage_log keeps the raw and cached numbers", () => {
    expect(DEFAULT_CACHE_READ_WEIGHT).toBe(0.1);
    const f = setup();
    withWorker(f, "w1", { maxTokens: 100_000, maxCents: 1_000 });
    // 1000 uncached + 9000 cached × 0.1 = 1900
    expect(f.gate.meter("w1", { tokens: 10_000, cachedTokens: 9_000, billedCents: 3 })).toBe("ok");
    expect(f.gate.meter("w1", { tokens: 500, billedCents: 0 })).toBe("ok");
    expect(f.gate.usageSync("w1")).toMatchObject({ ownTokens: 2_400, subtreeTokens: 2_400, ownCents: 3 });
    expect(f.gate.usageSync("desk")).toMatchObject({ ownTokens: 0, subtreeTokens: 2_400 });
    expect(usageLog(f)).toEqual([
      { cell_id: "w1", tokens: 1_900, raw_tokens: 10_000, cached_tokens: 9_000, cents: 3 },
      { cell_id: "w1", tokens: 500, raw_tokens: 500, cached_tokens: 0, cents: 0 },
    ]);
  });

  it("limits act on the weighted charge: a mostly cached turn does not exhaust the budget", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 10_000, maxCents: 1_000 });
    // 50k reported, 49k of them from cache → 1000 + 4900 = 5900 charged, 59% of the limit
    expect(f.gate.meter("w1", { tokens: 50_000, cachedTokens: 49_000, billedCents: 0 })).toBe("ok");
    expect(f.gate.usageSync("w1")).toMatchObject({ subtreeTokens: 5_900, state: "ok" });
    expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "allow");
  });

  it("a custom cacheReadWeight scales the charge; weight 1 charges raw tokens as before; out-of-range weights clamp to 0..1", () => {
    const charged = (cacheReadWeight: number) => {
      const f = setup({ cacheReadWeight });
      f.gate.meter("desk", { tokens: 8_000, cachedTokens: 4_000, billedCents: 0 });
      return f.gate.usageSync("desk").ownTokens;
    };
    expect(charged(0.25)).toBe(5_000);
    expect(charged(1)).toBe(8_000);
    expect(charged(0)).toBe(4_000);
    expect(charged(5)).toBe(8_000);
    expect(charged(-1)).toBe(4_000);
    // with weight 1 the log still tells the cache reads apart
    const f = setup({ cacheReadWeight: 1 });
    f.gate.meter("desk", { tokens: 8_000, cachedTokens: 4_000, billedCents: 0 });
    expect(usageLog(f)).toEqual([{ cell_id: "desk", tokens: 8_000, raw_tokens: 8_000, cached_tokens: 4_000, cents: 0 }]);
  });

  it("a fractional charge rounds up to a whole token", () => {
    const f = setup();
    f.gate.meter("desk", { tokens: 10, cachedTokens: 3, billedCents: 0 }); // 7 + 0.3
    expect(f.gate.usageSync("desk").ownTokens).toBe(8);
  });

  it("cachedTokens above tokens is clamped to tokens; a negative or non-finite one is invalid_argument and charges nothing", () => {
    const f = setup();
    f.gate.meter("desk", { tokens: 1_000, cachedTokens: 5_000, billedCents: 0 });
    expect(usageLog(f)).toEqual([{ cell_id: "desk", tokens: 100, raw_tokens: 1_000, cached_tokens: 1_000, cents: 0 }]);
    for (const cachedTokens of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5" as never]) {
      const err = thrown(() => f.gate.meter("desk", { tokens: 10, cachedTokens, billedCents: 1 }));
      expect(isNgError(err, "invalid_argument"), String(cachedTokens)).toBe(true);
      expect((err as Error).message).toMatch(/cachedTokens/);
    }
    expect(f.gate.usageSync("desk")).toMatchObject({ ownTokens: 100, ownCents: 0 });
    expect(usageLog(f)).toHaveLength(1);
  });
});

describe("wrap-up allowance (LedgerViewOptions.wrapUp)", () => {
  const BIG: BoundsInit = { tools: ["read"], maxTokens: 10_000_000, maxCents: 100_000, maxDepth: 1 };

  it("defaults to 5% of a limit, at most 200k tokens / 200 cents", () => {
    expect(DEFAULT_WRAP_UP).toEqual({ ratio: 0.05, maxTokens: 200_000, maxCents: 200 });
  });

  it("the wrap-up view stops at limit + allowance; the plain view still stops at the limit", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 10_000, maxCents: 1_000 }); // wrap-up stop: 10_500 tokens
    expect(f.gate.meter("w1", { tokens: 10_000, billedCents: 0 })).toBe("hard_stop");
    expect(f.gate.usageSync("w1")).toMatchObject({ limitTokens: 10_000, state: "hard_stop", limitedBy: "w1" });
    expect(f.gate.usageSync("w1", { wrapUp: true })).toMatchObject({ limitTokens: 10_000, state: "warn", limitedBy: "w1" });
    // just under limit + allowance
    expect(f.gate.meter("w1", { tokens: 499, billedCents: 0 }, { wrapUp: true })).toBe("warn");
    expect(f.gate.usageSync("w1").state).toBe("hard_stop");
    // at it
    expect(f.gate.meter("w1", { tokens: 1, billedCents: 0 }, { wrapUp: true })).toBe("hard_stop");
    expect(f.gate.usageSync("w1", { wrapUp: true })).toMatchObject({ subtreeTokens: 10_500, state: "hard_stop", limitedBy: "w1" });
  });

  it("applies to cents the same way", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 100_000, maxCents: 1_000 }); // wrap-up stop: 1_050 cents
    expect(f.gate.meter("w1", { tokens: 0, billedCents: 1_049 }, { wrapUp: true })).toBe("warn");
    expect(f.gate.meter("w1", { tokens: 0, billedCents: 0 })).toBe("hard_stop");
    expect(f.gate.meter("w1", { tokens: 0, billedCents: 1 }, { wrapUp: true })).toBe("hard_stop");
  });

  it("the allowance is capped in absolute terms on a big limit; GateOptions.wrapUp overrides the defaults", () => {
    const f = setup();
    // 5% of 10M tokens / 100k cents would be 500k / 5000; the caps are 200k / 200
    f.addCell("big", null, BIG);
    expect(f.gate.meter("big", { tokens: 10_199_999, billedCents: 100_199 }, { wrapUp: true })).toBe("warn");
    expect(f.gate.meter("big", { tokens: 1, billedCents: 0 }, { wrapUp: true })).toBe("hard_stop");
    f.addCell("bigc", null, BIG);
    expect(f.gate.meter("bigc", { tokens: 0, billedCents: 100_199 }, { wrapUp: true })).toBe("warn");
    expect(f.gate.meter("bigc", { tokens: 0, billedCents: 1 }, { wrapUp: true })).toBe("hard_stop");

    const tight = setup({ wrapUp: { maxTokens: 1_000 } });
    tight.addCell("big", null, BIG);
    expect(tight.gate.meter("big", { tokens: 10_000_999, billedCents: 0 }, { wrapUp: true })).toBe("warn");
    expect(tight.gate.meter("big", { tokens: 1, billedCents: 0 }, { wrapUp: true })).toBe("hard_stop");

    const off = setup({ wrapUp: { ratio: 0 } });
    off.addCell("big", null, BIG);
    expect(off.gate.meter("big", { tokens: 10_000_000, billedCents: 0 }, { wrapUp: true })).toBe("hard_stop");
  });

  it("a limit of 0 gets no allowance", () => {
    const f = setup();
    f.addCell("free", "desk", { tools: ["read"], maxTokens: 1_000, maxCents: 0 });
    expect(f.gate.usageSync("free", { wrapUp: true })).toMatchObject({ state: "hard_stop", limitedBy: "free" });
    expectType(f.gate.authorizeSync(exec("read"), meta("free", 0, { wrapUp: true })), "deny");
  });

  it("ledger.alert and stopped_at follow the real limit whatever the view", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 10_000, maxCents: 1_000 });
    expect(f.gate.meter("w1", { tokens: 8_000, billedCents: 0 }, { wrapUp: true })).toBe("warn");
    expect(alerts(f)).toEqual([{ cellId: "w1", level: "warn" }]);
    // reaching the limit is announced as a hard stop, though the wrap-up caller is told "warn"
    expect(f.gate.meter("w1", { tokens: 2_000, billedCents: 0 }, { wrapUp: true })).toBe("warn");
    expect(alerts(f)).toEqual([
      { cellId: "w1", level: "warn" },
      { cellId: "w1", level: "hard_stop" },
    ]);
    expect(get<{ stopped_at: number | null }>(f.db, "SELECT stopped_at FROM ledger WHERE cell_id = 'w1'")!.stopped_at).toBe(f.clock.now());
    // crossing limit + allowance announces nothing new
    expect(f.gate.meter("w1", { tokens: 500, billedCents: 0 }, { wrapUp: true })).toBe("hard_stop");
    expect(alerts(f)).toHaveLength(2);
  });

  it("authorize with wrapUp allows an immediate action the plain view denies for budget, until limit + allowance", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 10_000, maxCents: 1_000 });
    f.gate.meter("w1", { tokens: 10_000, billedCents: 0 });
    expect(expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "deny").feedback).toMatch(/budget exhausted/);
    expectType(f.gate.authorizeSync(exec("read"), meta("w1", 0, { wrapUp: true })), "allow");
    f.gate.meter("w1", { tokens: 500, billedCents: 0 }, { wrapUp: true });
    expect(expectType(f.gate.authorizeSync(exec("read"), meta("w1", 0, { wrapUp: true })), "deny").feedback).toMatch(
      /budget exhausted: this cell used 10500\/10000 tokens/,
    );
  });

  it("every ledger on the chain gets its allowance: a coordinator under an exhausted ancestor can still wrap up", () => {
    const f = setup();
    withWorker(f, "proj", { maxTokens: 1_000_000 });
    f.addCell("w2", "desk", { tools: ["read"], maxTokens: 1_000_000, maxCents: 10_000 });
    f.gate.meter("w2", { tokens: 1_000_000, billedCents: 0 }); // desk is spent
    expect(expectType(f.gate.authorizeSync(exec("read"), meta("proj")), "deny").feedback).toMatch(/ancestor cell "desk"/);
    expectType(f.gate.authorizeSync(exec("read"), meta("proj", 0, { wrapUp: true })), "allow");
    expect(f.gate.usageSync("proj", { wrapUp: true })).toMatchObject({ state: "warn", limitedBy: "desk" });
    // desk's allowance: min(5% of 1M, 200k) = 50k
    expect(f.gate.meter("proj", { tokens: 50_000, billedCents: 0 }, { wrapUp: true })).toBe("hard_stop");
    expect(f.gate.usageSync("proj", { wrapUp: true })).toMatchObject({ state: "hard_stop", limitedBy: "desk" });
    expectType(f.gate.authorizeSync(exec("read"), meta("proj", 0, { wrapUp: true })), "deny");
  });
});

/** desk (1M) → proj (400k) → leaf (100k); `other` under desk spent 900k, so leaf and desk are stopped while proj is not. */
function stoppedChain(): Fixture {
  const f = setup();
  withWorker(f, "proj", { maxTokens: 400_000, maxCents: 5_000, maxDepth: 2 });
  f.cells.insert({ id: "leaf", parentId: "proj", bounds: f.gate.attenuate(f.cells.require("proj").bounds, "proj", { maxTokens: 100_000 }) });
  f.addCell("other", "desk", { tools: ["read"], maxTokens: 1_000_000, maxCents: 10_000 });
  f.gate.meter("other", { tokens: 900_000, billedCents: 0 });
  f.gate.meter("leaf", { tokens: 100_000, billedCents: 0 });
  return f;
}

describe("raiseChainSync (one \"continue\" for the whole chain)", () => {
  it("raises every ledger on the chain that is stopped right now, leaves the others alone, and the cell may act again", () => {
    const f = stoppedChain();
    expect(f.gate.usageSync("leaf")).toMatchObject({ state: "hard_stop", limitedBy: "leaf" });
    expect(f.gate.usageSync("proj").state).toBe("hard_stop"); // through desk
    // default: half of each limit again, tokens and cents alike
    expect(f.gate.raiseChainSync("leaf", "owner")).toEqual([
      { cellId: "leaf", tokens: 50_000, cents: 2_500 },
      { cellId: "desk", tokens: 500_000, cents: 5_000 },
    ]);
    expect(f.gate.usageSync("leaf")).toMatchObject({ limitTokens: 150_000, raisedTokens: 50_000, raisedCents: 2_500, state: "ok", limitedBy: null });
    expect(f.gate.usageSync("proj")).toMatchObject({ raisedTokens: 0, raisedCents: 0, state: "ok" });
    expect(f.gate.usageSync("desk")).toMatchObject({ limitTokens: 1_500_000, raisedTokens: 500_000, raisedCents: 5_000 });
    expectType(f.gate.authorizeSync(exec("read"), meta("leaf")), "allow");
    expect(all(f.db, "SELECT cell_id, tokens, cents, approver_id FROM budget_raises ORDER BY id")).toEqual([
      { cell_id: "leaf", tokens: 50_000, cents: 2_500, approver_id: "owner" },
      { cell_id: "desk", tokens: 500_000, cents: 5_000, approver_id: "owner" },
    ]);
    // nothing is stopped any more: a second click raises nothing
    expect(f.gate.raiseChainSync("leaf", "owner")).toEqual([]);
  });

  it("siblings under a stopped ancestor: the second call does not raise the shared ancestor again", () => {
    const f = setup();
    withWorker(f, "s1", { maxTokens: 1_000_000 });
    withWorker(f, "s2", { maxTokens: 1_000_000 });
    f.gate.meter("s1", { tokens: 600_000, billedCents: 0 });
    f.gate.meter("s2", { tokens: 400_000, billedCents: 0 });
    expect(f.gate.usageSync("s1")).toMatchObject({ state: "hard_stop", limitedBy: "desk" });
    expect(f.gate.usageSync("s2")).toMatchObject({ state: "hard_stop", limitedBy: "desk" });
    expect(f.gate.raiseChainSync("s1", "owner")).toEqual([{ cellId: "desk", tokens: 500_000, cents: 5_000 }]);
    expect(f.gate.raiseChainSync("s2", "owner")).toEqual([]);
    expect(f.gate.usageSync("desk")).toMatchObject({ raisedTokens: 500_000, raisedCents: 5_000 });
    expect(f.gate.usageSync("s2")).toMatchObject({ state: "ok", limitedBy: null });
    expect(all(f.db, "SELECT cell_id FROM budget_raises")).toEqual([{ cell_id: "desk" }]);
  });

  it("the default raise always leaves hard_stop: past a big overshoot it adds the overshoot plus a quarter, and at least 1", () => {
    const f = setup();
    withWorker(f, "w1", { maxTokens: 1_000, maxCents: 1_000 });
    f.gate.meter("w1", { tokens: 3_000, billedCents: 0 }); // 2000 over the limit
    expect(f.gate.raiseChainSync("w1", "owner")).toEqual([{ cellId: "w1", tokens: 2_250, cents: 500 }]);
    expect(f.gate.usageSync("w1")).toMatchObject({ limitTokens: 3_250, state: "warn" });

    f.addCell("free", "desk", { tools: ["read"], maxTokens: 1_000, maxCents: 0 }); // stopped from the start
    expect(f.gate.raiseChainSync("free", "owner")).toEqual([{ cellId: "free", tokens: 500, cents: 1 }]);
    expect(f.gate.usageSync("free")).toMatchObject({ limitCents: 1, state: "ok" });
  });

  it("an explicit `add` raises each stopped ledger by exactly that", () => {
    const f = stoppedChain();
    expect(f.gate.raiseChainSync("leaf", "owner", { tokens: 1_000, cents: 7 })).toEqual([
      { cellId: "leaf", tokens: 1_000, cents: 7 },
      { cellId: "desk", tokens: 1_000, cents: 7 },
    ]);
    expect(f.gate.usageSync("leaf")).toMatchObject({ raisedTokens: 1_000, raisedCents: 7, state: "warn" });
    expect(f.gate.usageSync("desk")).toMatchObject({ raisedTokens: 1_000, raisedCents: 7 });
    expect(f.gate.usageSync("proj")).toMatchObject({ raisedTokens: 0, raisedCents: 0 });
  });

  it("raises nothing when nothing on the chain is stopped", () => {
    const f = setup();
    withWorker(f, "w1");
    f.gate.meter("w1", { tokens: 90_000, billedCents: 0 }); // warn only
    expect(f.gate.raiseChainSync("w1", "owner")).toEqual([]);
    expect(all(f.db, "SELECT * FROM budget_raises")).toEqual([]);
    expect(raisedEvents(f)).toEqual([]);
  });

  it("only the owner may raise the chain; anyone else is refused and nothing is raised", () => {
    const f = stoppedChain();
    for (const who of ["agent:ops", "cell:leaf", "cell:desk"]) {
      const err = thrown(() => f.gate.raiseChainSync("leaf", who));
      expect(isNgError(err, "bounds_violation"), who).toBe(true);
      expect((err as Error).message).toBe(`raising a budget needs the owner; ${who} may not`);
    }
    expect(isNgError(thrown(() => f.gate.raiseChainSync("leaf", "")), "invalid_argument")).toBe(true);
    expect(f.gate.usageSync("leaf")).toMatchObject({ raisedTokens: 0, state: "hard_stop" });
    expect(f.gate.usageSync("desk")).toMatchObject({ raisedTokens: 0 });
    expect(all(f.db, "SELECT * FROM budget_raises")).toEqual([]);
    expect(raisedEvents(f)).toEqual([]);
    expect(() => f.gate.raiseChainSync("ghost", "owner")).toThrow(/not found/);
  });
});

describe("ledger.raised", () => {
  it("raiseBudgetSync emits ledger.raised { cellId } once per raise", () => {
    const f = setup();
    withWorker(f, "w1");
    f.gate.raiseBudgetSync("w1", { tokens: 10 }, "owner");
    f.gate.raiseBudgetSync("desk", { cents: 5 }, "owner");
    f.gate.raiseBudgetSync("w1", { tokens: 10 }, "owner");
    expect(raisedEvents(f)).toEqual([{ cellId: "w1" }, { cellId: "desk" }, { cellId: "w1" }]);
  });

  it("raiseChainSync emits one per ledger it raised", () => {
    const f = stoppedChain();
    f.gate.raiseChainSync("leaf", "owner");
    expect(raisedEvents(f)).toEqual([{ cellId: "leaf" }, { cellId: "desk" }]);
  });

  it("is emitted after commit: nothing while the transaction is open, nothing if it rolls back", () => {
    const f = setup();
    withWorker(f, "w1");
    expect(() =>
      withTx(f.db, () => {
        f.gate.raiseBudgetSync("w1", { tokens: 10 }, "owner");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(raisedEvents(f)).toEqual([]);
    expect(f.gate.usageSync("w1").raisedTokens).toBe(0);

    let seenInside: unknown[] = [];
    withTx(f.db, () => {
      f.gate.raiseBudgetSync("w1", { tokens: 10 }, "owner");
      seenInside = raisedEvents(f);
    });
    expect(seenInside).toEqual([]);
    expect(raisedEvents(f)).toEqual([{ cellId: "w1" }]);
  });
});

describe("budget limits switched off (GateOptions.budgetEnforced)", () => {
  it("meters as before but warns about nothing, stops nothing and denies nothing; switching back on applies the limits again", () => {
    let on = false;
    const f = setup({ budgetEnforced: () => on });
    withWorker(f, "w1", { maxTokens: 1_000, maxCents: 1_000 });
    expect(f.gate.meter("w1", { tokens: 5_000, billedCents: 2_000 })).toBe("ok");
    expect(f.gate.usageSync("w1")).toMatchObject({ subtreeTokens: 5_000, subtreeCents: 2_000, limitTokens: 1_000, state: "ok", limitedBy: null, enforced: false });
    expect(alerts(f)).toEqual([]);
    expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "allow");
    // Nothing is stopped, so a chain raise has nothing to raise.
    expect(f.gate.raiseChainSync("w1", "owner")).toEqual([]);

    on = true;
    expect(f.gate.usageSync("w1")).toMatchObject({ state: "hard_stop", limitedBy: "w1", enforced: true });
    expectType(f.gate.authorizeSync(exec("read"), meta("w1")), "deny");
    expect(f.gate.meter("w1", { tokens: 0, billedCents: 0 })).toBe("hard_stop");
  });
});
