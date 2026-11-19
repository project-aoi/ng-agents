import { describe, expect, it } from "vitest";
import {
  ISOLATION_LEVELS,
  TOOL_KINDS,
  anyCovers,
  boundsViolations,
  deserializeBounds,
  isNgError,
  isSubsetBounds,
  makeBounds,
  serializeBounds,
  type Address,
  type PolicyBounds,
} from "@ng/protocol";
import { attenuateBounds, intersectPatterns, meetBounds } from "../src";
import { exec, expectType, meta, rng, setup } from "./helpers";

const PARENT_PATTERNS = [
  "inbox:*",
  "inbox:desk",
  "inbox:p1",
  "inbox:p*",
  "channel:*",
  "channel:feishu:*",
  "channel:feishu:oc_1",
  "channel:feishu:oc_*",
  "channel:ui:owner",
  "channel:slack:C1",
  "channel:slack:*",
];
const REQUEST_PATTERNS: unknown[] = [
  ...PARENT_PATTERNS,
  "inbox:p1x",
  "inbox:w-9",
  "channel:feishu:oc_2",
  "channel:feishu:oc_10*",
  "channel:github:org/repo#1",
  "inbox:",
  "channel:x",
  "*",
  "foo",
  "",
  7,
  null,
];
const SECRETS = ["github", "feishu", "aws", "slack"];
const NUMBERS: unknown[] = [-5, 0, 1, 2, 2.7, 3, 10, 999, 1e9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "10", null];

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}
function subset<T>(r: () => number, xs: readonly T[], p = 0.5): T[] {
  return xs.filter(() => r() < p);
}

function randomParent(r: () => number): PolicyBounds {
  return makeBounds({
    tools: subset(r, TOOL_KINDS),
    canSendTo: subset(r, PARENT_PATTERNS, 0.3) as PolicyBounds["canSendTo"],
    secretRefs: subset(r, SECRETS),
    isolation: pick(r, ISOLATION_LEVELS),
    maxConcurrentChildren: Math.floor(r() * 6),
    maxTokens: r() < 0.1 ? 0 : Math.floor(r() * 1_000_000),
    maxCents: r() < 0.1 ? 0 : Math.round(r() * 100_000) / 100,
    maxDepth: Math.floor(r() * 5),
  });
}

function randomList(r: () => number, pool: readonly unknown[]): unknown {
  const roll = r();
  if (roll < 0.1) return {}; // a Set that went through JSON
  if (roll < 0.15) return "read";
  if (roll < 0.2) return 42;
  const xs = subset(r, pool, 0.35);
  return r() < 0.5 ? xs : new Set(xs);
}

function randomRequest(r: () => number): Partial<PolicyBounds> | undefined {
  if (r() < 0.1) return undefined;
  const req: Record<string, unknown> = {};
  if (r() < 0.6) req["tools"] = randomList(r, [...TOOL_KINDS, "rm", "", 5, null]);
  if (r() < 0.6) req["canSendTo"] = randomList(r, REQUEST_PATTERNS);
  if (r() < 0.6) req["secretRefs"] = randomList(r, [...SECRETS, "", "vault", 1]);
  if (r() < 0.6) req["isolation"] = pick(r, [...ISOLATION_LEVELS, "contianer", 3, null]);
  for (const k of ["maxConcurrentChildren", "maxTokens", "maxCents", "maxDepth"]) {
    if (r() < 0.6) req[k] = r() < 0.5 ? pick(r, NUMBERS) : Math.floor(r() * 2_000_000);
  }
  return req as Partial<PolicyBounds>;
}

function assertWellFormed(b: PolicyBounds): void {
  const round = deserializeBounds(JSON.parse(JSON.stringify(serializeBounds(b))));
  expect(serializeBounds(round)).toEqual(serializeBounds(b));
}

describe("attenuateBounds — property: the child is always ⊆ the parent", () => {
  it("holds for 5000 randomized parents and (often malformed) requests", () => {
    const r = rng(0xc0ffee);
    let derived = 0;
    for (let i = 0; i < 5000; i++) {
      const parent = randomParent(r);
      const parentCellId = pick(r, ["desk", "p1", "w-9", "x:y", ""]);
      const requested = randomRequest(r);
      const run = () => attenuateBounds(parent, parentCellId, requested);
      if (parent.maxDepth === 0) {
        expect(run).toThrow();
        try {
          run();
        } catch (e) {
          expect(isNgError(e, "bounds_violation")).toBe(true);
        }
        continue;
      }
      const child = run();
      derived++;
      const ctx = { seed: i, parent: serializeBounds(parent), parentCellId, requested, child: serializeBounds(child) };
      expect(boundsViolations(child, parent, parentCellId ? { parentCellId } : {}), JSON.stringify(ctx)).toEqual([]);
      assertWellFormed(child);
      if (requested?.maxDepth === undefined) expect(child.maxDepth).toBe(parent.maxDepth - 1);
      expect(child.maxDepth).toBeLessThanOrEqual(parent.maxDepth - 1);
      if (parentCellId) expect(anyCovers(child.canSendTo, `inbox:${parentCellId}`)).toBe(true);
      // inbox reachability is inherited whatever the request; channels only on request
      for (const p of parent.canSendTo) if (p.startsWith("inbox:")) expect(anyCovers(child.canSendTo, p), JSON.stringify(ctx)).toBe(true);
      if (requested?.canSendTo === undefined) expect(child.canSendTo.filter((a) => !a.startsWith("inbox:"))).toEqual([]);
      // budget limits are static caps: an omitted one is the parent's number
      if (requested?.maxTokens === undefined) expect(child.maxTokens).toBe(parent.maxTokens);
      if (requested?.maxCents === undefined) expect(child.maxCents).toBe(parent.maxCents);
      if (requested?.secretRefs === undefined) expect(child.secretRefs.size).toBe(0);
    }
    expect(derived).toBeGreaterThan(3000);
  });

  it("narrows monotonically down a chain until depth runs out", () => {
    const r = rng(42);
    for (let i = 0; i < 300; i++) {
      let parent = makeBounds({ ...serializeBounds(randomParent(r)), maxDepth: 1 + Math.floor(r() * 4) });
      let parentId = "root";
      let depth = 0;
      while (parent.maxDepth > 0) {
        const child = attenuateBounds(parent, parentId, randomRequest(r));
        expect(isSubsetBounds(child, parent, { parentCellId: parentId })).toBe(true);
        expect(child.maxDepth).toBeLessThan(parent.maxDepth);
        parent = child;
        parentId = `c${++depth}`;
      }
      expect(() => attenuateBounds(parent, parentId)).toThrow(/maxDepth/);
    }
  });

  it("meetBounds is ⊆ both inputs (narrowing relation)", () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const a = randomParent(r);
      const b = randomParent(r);
      const m = meetBounds(a, b);
      expect(isSubsetBounds(m, a, { relation: "narrowing" })).toBe(true);
      expect(isSubsetBounds(m, b, { relation: "narrowing" })).toBe(true);
      assertWellFormed(m);
    }
  });
});

describe("attenuateBounds — field rules", () => {
  const parent = makeBounds({
    tools: ["read", "write", "bash"],
    canSendTo: ["inbox:desk", "inbox:p1", "channel:feishu:oc_1", "channel:ui:*"],
    secretRefs: ["github", "feishu"],
    isolation: "git_worktree",
    maxConcurrentChildren: 4,
    maxTokens: 50_000,
    maxCents: 300,
    maxDepth: 2,
  });

  it("omitted fields: parent's tools/isolation/limits, the parent inbox plus the parent's inboxes (no channels), no secrets, depth − 1", () => {
    const c = attenuateBounds(parent, "proj");
    expect([...c.tools].sort()).toEqual(["bash", "read", "write"]);
    expect(c.canSendTo).toEqual(["inbox:desk", "inbox:p1", "inbox:proj"]);
    expect(c.secretRefs.size).toBe(0);
    expect(c.isolation).toBe("git_worktree");
    expect([c.maxConcurrentChildren, c.maxTokens, c.maxCents, c.maxDepth]).toEqual([4, 50_000, 300, 1]);
  });

  it("honours a request that is already inside the parent exactly", () => {
    const c = attenuateBounds(parent, "proj", {
      tools: new Set(["read"]),
      canSendTo: ["channel:feishu:oc_1"],
      secretRefs: new Set(["github"]),
      isolation: "container",
      maxConcurrentChildren: 1,
      maxTokens: 1000,
      maxCents: 2.5,
      maxDepth: 0,
    });
    expect(serializeBounds(c)).toEqual({
      tools: ["read"],
      canSendTo: ["channel:feishu:oc_1", "inbox:desk", "inbox:p1", "inbox:proj"],
      secretRefs: ["github"],
      isolation: "container",
      maxConcurrentChildren: 1,
      maxTokens: 1000,
      maxCents: 2.5,
      maxDepth: 0,
    });
  });

  it("clamps a request that is wider than the parent instead of failing", () => {
    const c = attenuateBounds(parent, "proj", {
      tools: new Set(["read", "edit", "code_rpc"]),
      canSendTo: ["channel:slack:C1", "channel:feishu:*", "inbox:*"],
      secretRefs: new Set(["aws", "github"]),
      isolation: "none",
      maxConcurrentChildren: 99,
      maxTokens: 10_000_000,
      maxCents: 1e9,
      maxDepth: 5,
    });
    expect([...c.tools]).toEqual(["read"]);
    // feishu:* ∩ {feishu:oc_1} = oc_1 ; inbox:* ∩ {inbox:desk, inbox:p1, inbox:proj} = those three; slack is dropped.
    expect(c.canSendTo).toEqual(["channel:feishu:oc_1", "inbox:desk", "inbox:p1", "inbox:proj"]);
    expect([...c.secretRefs]).toEqual(["github"]);
    expect(c.isolation).toBe("git_worktree");
    expect([c.maxConcurrentChildren, c.maxTokens, c.maxCents, c.maxDepth]).toEqual([4, 50_000, 300, 1]);
  });

  it("isolation is a floor: weaker requests keep the parent's, stronger ones win, unknown ones fail closed", () => {
    expect(attenuateBounds(parent, "p", { isolation: "shared_ro" }).isolation).toBe("git_worktree");
    expect(attenuateBounds(parent, "p", { isolation: "none" }).isolation).toBe("git_worktree");
    expect(attenuateBounds(parent, "p", { isolation: "container" }).isolation).toBe("container");
    expect(attenuateBounds(parent, "p", { isolation: "contianer" as never }).isolation).toBe("cow_microvm");
    const host = makeBounds({ ...serializeBounds(parent), isolation: "none" });
    expect(attenuateBounds(host, "p", { isolation: "shared_ro" }).isolation).toBe("shared_ro");
  });

  it("a malformed list narrows to nothing rather than falling back to the parent's", () => {
    const c = attenuateBounds(parent, "p", { tools: {} as never, secretRefs: "github" as never, canSendTo: 5 as never });
    expect(c.tools.size).toBe(0);
    expect(c.secretRefs.size).toBe(0);
    expect(c.canSendTo).toEqual(["inbox:desk", "inbox:p", "inbox:p1"]);
  });

  it("inbox patterns are inherited whatever the request; channel addresses need a request within the parent's", () => {
    const wide = makeBounds({ ...serializeBounds(parent), canSendTo: ["inbox:*", "channel:feishu:*", "channel:ui:*"] });
    // inbox:* passes down as inbox:* (it covers the parent inbox too), even when the request lists nothing
    expect(attenuateBounds(wide, "proj").canSendTo).toEqual(["inbox:*"]);
    expect(attenuateBounds(wide, "proj", { canSendTo: [] }).canSendTo).toEqual(["inbox:*"]);
    expect(attenuateBounds(wide, "proj", { canSendTo: ["inbox:proj"] }).canSendTo).toEqual(["inbox:*"]);
    expect(attenuateBounds(wide, "proj", { canSendTo: ["channel:feishu:oc_1", "channel:slack:C1"] }).canSendTo).toEqual(["channel:feishu:oc_1", "inbox:*"]);
    // a parent that can only reach the desk passes on just that
    const deskOnly = makeBounds({ ...serializeBounds(parent), canSendTo: ["inbox:desk", "channel:feishu:*"] });
    expect(attenuateBounds(deskOnly, "proj").canSendTo).toEqual(["inbox:desk", "inbox:proj"]);
    expect(attenuateBounds(deskOnly, "proj", { canSendTo: ["inbox:*"] }).canSendTo).toEqual(["inbox:desk", "inbox:proj"]);
    expect(attenuateBounds(deskOnly, "proj", { canSendTo: ["channel:feishu:*"] }).canSendTo).toEqual(["channel:feishu:*", "inbox:desk", "inbox:proj"]);
    // a parent with no inbox patterns gives only its own inbox
    const channelsOnly = makeBounds({ ...serializeBounds(parent), canSendTo: ["channel:feishu:*"] });
    expect(attenuateBounds(channelsOnly, "proj").canSendTo).toEqual(["inbox:proj"]);
  });

  it("garbage numbers clamp to 0 and infinities to the parent's value", () => {
    const c = attenuateBounds(parent, "p", {
      maxTokens: Number.NaN,
      maxCents: -3,
      maxConcurrentChildren: Number.POSITIVE_INFINITY,
      maxDepth: 0.9,
    });
    expect([c.maxTokens, c.maxCents, c.maxConcurrentChildren, c.maxDepth]).toEqual([0, 0, 4, 0]);
  });

  it("throws bounds_violation when the parent has no depth left", () => {
    const leaf = makeBounds({ ...serializeBounds(parent), maxDepth: 0 });
    expect(() => attenuateBounds(leaf, "leaf")).toThrow();
    try {
      attenuateBounds(leaf, "leaf", {});
    } catch (e) {
      expect(isNgError(e, "bounds_violation")).toBe(true);
    }
  });

  it("intersectPatterns returns the exact intersection of two wildcard languages", () => {
    expect(intersectPatterns(["channel:feishu:*"], ["channel:feishu:oc_*"])).toEqual(["channel:feishu:oc_*"]);
    expect(intersectPatterns(["channel:feishu:oc_*"], ["channel:feishu:*"])).toEqual(["channel:feishu:oc_*"]);
    expect(intersectPatterns(["channel:feishu:*"], ["channel:slack:*"])).toEqual([]);
    expect(intersectPatterns(["inbox:a", "inbox:*"], ["inbox:*"])).toEqual(["inbox:*"]);
    expect(intersectPatterns(["not-an-address", "inbox:"], ["inbox:*", "channel:*"])).toEqual([]);
  });
});

describe("Gate.attenuate — persisted state", () => {
  /** desk (1M tokens) → proj (400k, 150k already spent) → leaf (300k). */
  function projectWithLeaf() {
    const f = setup();
    const proj = f.gate.attenuate(f.cells.require("desk").bounds, "desk", { maxTokens: 400_000, maxCents: 5_000, maxDepth: 2 });
    f.cells.insert({ id: "proj", parentId: "desk", bounds: proj });
    f.gate.meter("proj", { tokens: 150_000, billedCents: 0 });
    f.cells.insert({ id: "leaf", parentId: "proj", bounds: f.gate.attenuate(proj, "proj", { maxTokens: 300_000 }) });
    return f;
  }

  it("a child gets the parent's static cap, not what the chain has left at spawn time", () => {
    const f = setup();
    const proj = f.gate.attenuate(f.cells.require("desk").bounds, "desk", { maxTokens: 400_000, maxCents: 5_000 });
    f.cells.insert({ id: "proj", parentId: "desk", bounds: proj });
    f.gate.meter("proj", { tokens: 150_000, billedCents: 4_000 });
    // proj has only 250k / 1000¢ left; none of that is frozen into a new child
    expect(f.gate.attenuate(proj, "proj", {})).toMatchObject({ maxTokens: 400_000, maxCents: 5_000 });
    expect(f.gate.attenuate(proj, "proj", { maxTokens: 300_000 })).toMatchObject({ maxTokens: 300_000, maxCents: 5_000 });
    // still clamped to the parent's static number
    expect(f.gate.attenuate(proj, "proj", { maxTokens: 900_000, maxCents: 9_000 })).toMatchObject({ maxTokens: 400_000, maxCents: 5_000 });

    // an almost spent ancestor does not shrink a new child either
    f.addCell("other", "desk", { maxTokens: 900_000, maxCents: 9_000, maxDepth: 2, tools: ["read"] });
    f.gate.meter("other", { tokens: 800_000, billedCents: 0 });
    expect(f.gate.usageSync("desk").subtreeTokens).toBe(950_000);
    expect(f.gate.attenuate(f.cells.require("desk").bounds, "desk", {})).toMatchObject({ maxTokens: 1_000_000, maxCents: 10_000 });
  });

  it("an exhausted ancestor still stops the child's spending through the live chain ledgers", () => {
    const f = projectWithLeaf();
    expect(f.gate.usageSync("leaf")).toMatchObject({ limitTokens: 300_000, state: "ok" });
    // 250k is within the leaf's own 300k, but proj (150k + 250k) reaches its 400k
    expect(f.gate.meter("leaf", { tokens: 250_000, billedCents: 0 })).toBe("hard_stop");
    expect(f.gate.usageSync("leaf")).toMatchObject({ subtreeTokens: 250_000, limitTokens: 300_000, state: "hard_stop", limitedBy: "proj" });
    expect(expectType(f.gate.authorizeSync(exec("read"), meta("leaf")), "deny").feedback).toMatch(/ancestor cell "proj"/);
  });

  it("a later raise of the ancestor reaches the child at once, without re-deriving its bounds", () => {
    const f = projectWithLeaf();
    f.gate.meter("leaf", { tokens: 250_000, billedCents: 0 });
    const before = serializeBounds(f.cells.require("leaf").bounds);
    f.gate.raiseBudgetSync("proj", { tokens: 200_000 }, "owner");
    expect(serializeBounds(f.cells.require("leaf").bounds)).toEqual(before);
    // proj is at 400k / 600k now; only the leaf's own 250k / 300k is left to warn about
    expect(f.gate.usageSync("leaf")).toMatchObject({ limitTokens: 300_000, state: "warn", limitedBy: "leaf" });
    expectType(f.gate.authorizeSync(exec("read"), meta("leaf")), "allow");
    expect(f.gate.meter("leaf", { tokens: 40_000, billedCents: 0 })).toBe("warn");
  });

  it("never exceeds the stored parent bounds even when the caller passes wider ones", () => {
    const f = setup();
    f.addCell("narrow", "desk", { tools: ["read"], canSendTo: ["inbox:desk"], isolation: "container", maxTokens: 10, maxCents: 1, maxDepth: 1, maxConcurrentChildren: 1 });
    const wide = makeBounds({ tools: TOOL_KINDS, canSendTo: ["inbox:*", "channel:*" as Address], secretRefs: ["github"], isolation: "none", maxConcurrentChildren: 9, maxTokens: 1e6, maxCents: 1e6, maxDepth: 5 });
    const c = f.gate.attenuate(wide, "narrow", { tools: new Set(TOOL_KINDS), canSendTo: ["channel:feishu:x"], secretRefs: new Set(["github"]) });
    expect(isSubsetBounds(c, f.cells.require("narrow").bounds, { parentCellId: "narrow" })).toBe(true);
    // the request's channel is outside the stored parent; the stored parent's own inbox reach is inherited
    expect(serializeBounds(c)).toMatchObject({ tools: ["read"], canSendTo: ["inbox:desk", "inbox:narrow"], secretRefs: [], isolation: "container", maxDepth: 0 });
  });

  it("randomized: always ⊆ the passed parent and the stored parent, whatever the ledgers say", () => {
    const r = rng(99);
    for (let i = 0; i < 200; i++) {
      const f = setup();
      const stored = randomParent(r);
      f.addCell("p", "desk", serializeBounds(stored));
      if (r() < 0.7) f.gate.meter("p", { tokens: Math.floor(r() * 600_000), billedCents: Math.floor(r() * 2_000) });
      if (r() < 0.3) f.gate.meter("desk", { tokens: Math.floor(r() * 1_200_000), billedCents: Math.floor(r() * 12_000) });
      const passed = randomParent(r);
      const requested = randomRequest(r);
      const run = () => f.gate.attenuate(passed, "p", requested);
      if (Math.min(stored.maxDepth, passed.maxDepth) === 0) {
        expect(run).toThrow();
        continue;
      }
      const c = run();
      expect(isSubsetBounds(c, passed, { parentCellId: "p" })).toBe(true);
      expect(isSubsetBounds(c, stored, { parentCellId: "p" })).toBe(true);
      // spending is not frozen in: the result is what the static parent bounds alone give
      const unspent = attenuateBounds(meetBounds(passed, f.cells.require("p").bounds), "p", requested);
      expect(serializeBounds(c)).toEqual(serializeBounds(unspent));
    }
  });
});
