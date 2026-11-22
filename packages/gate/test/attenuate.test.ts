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
import { rng, setup } from "./helpers";

const PARENT_PATTERNS = [
  "inbox:*",
  "inbox:desk",
  "inbox:p1",
  "inbox:p*",
  "channel:*",
  "channel:memory:*",
  "channel:memory:oc_1",
  "channel:memory:oc_*",
  "channel:ui:owner",
  "channel:other:C1",
  "channel:other:*",
];
const REQUEST_PATTERNS: unknown[] = [
  ...PARENT_PATTERNS,
  "inbox:p1x",
  "inbox:w-9",
  "channel:memory:oc_2",
  "channel:memory:oc_10*",
  "channel:ui:other",
  "inbox:",
  "channel:x",
  "*",
  "foo",
  "",
  7,
  null,
];
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

    isolation: pick(r, ISOLATION_LEVELS),
    maxConcurrentChildren: Math.floor(r() * 6),

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
  if (r() < 0.6) req["isolation"] = pick(r, [...ISOLATION_LEVELS, "contianer", 3, null]);
  for (const k of ["maxConcurrentChildren", "maxDepth"]) {
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
    canSendTo: ["inbox:desk", "inbox:p1", "channel:memory:oc_1", "channel:ui:*"],

    isolation: "none",
    maxConcurrentChildren: 4,

    maxDepth: 2,
  });

  it("omitted fields: parent's tools/isolation/limits, the parent inbox plus the parent's inboxes (no channels), depth − 1", () => {
    const c = attenuateBounds(parent, "proj");
    expect([...c.tools].sort()).toEqual(["bash", "read", "write"]);
    expect(c.canSendTo).toEqual(["inbox:desk", "inbox:p1", "inbox:proj"]);
    expect(c.isolation).toBe("none");
    expect([c.maxConcurrentChildren, c.maxDepth]).toEqual([4, 1]);
  });

  it("honours a request that is already inside the parent exactly", () => {
    const c = attenuateBounds(parent, "proj", {
      tools: new Set(["read"]),
      canSendTo: ["channel:memory:oc_1"],

      isolation: "none",
      maxConcurrentChildren: 1,

      maxDepth: 0,
    });
    expect(serializeBounds(c)).toEqual({
      tools: ["read"],
      canSendTo: ["channel:memory:oc_1", "inbox:desk", "inbox:p1", "inbox:proj"],

      isolation: "none",
      maxConcurrentChildren: 1,

      maxDepth: 0,
    });
  });

  it("clamps a request that is wider than the parent instead of failing", () => {
    const c = attenuateBounds(parent, "proj", {
      tools: new Set(["read", "edit"]),
      canSendTo: ["channel:other:C1", "channel:memory:*", "inbox:*"],

      isolation: "none",
      maxConcurrentChildren: 99,

      maxDepth: 5,
    });
    expect([...c.tools]).toEqual(["read"]);
    // memory:* ∩ {memory:oc_1} = oc_1 ; inbox:* ∩ {inbox:desk, inbox:p1, inbox:proj} = those three; the other channel is dropped.
    expect(c.canSendTo).toEqual(["channel:memory:oc_1", "inbox:desk", "inbox:p1", "inbox:proj"]);
    expect(c.isolation).toBe("none");
    expect([c.maxConcurrentChildren, c.maxDepth]).toEqual([4, 1]);
  });

  it("a malformed list narrows to nothing rather than falling back to the parent's", () => {
    const c = attenuateBounds(parent, "p", { tools: {} as never, canSendTo: 5 as never });
    expect(c.tools.size).toBe(0);
    expect(c.canSendTo).toEqual(["inbox:desk", "inbox:p", "inbox:p1"]);
  });

  it("inbox patterns are inherited whatever the request; channel addresses need a request within the parent's", () => {
    const wide = makeBounds({ ...serializeBounds(parent), canSendTo: ["inbox:*", "channel:memory:*", "channel:ui:*"] });
    // inbox:* passes down as inbox:* (it covers the parent inbox too), even when the request lists nothing
    expect(attenuateBounds(wide, "proj").canSendTo).toEqual(["inbox:*"]);
    expect(attenuateBounds(wide, "proj", { canSendTo: [] }).canSendTo).toEqual(["inbox:*"]);
    expect(attenuateBounds(wide, "proj", { canSendTo: ["inbox:proj"] }).canSendTo).toEqual(["inbox:*"]);
    expect(attenuateBounds(wide, "proj", { canSendTo: ["channel:memory:oc_1", "channel:other:C1"] }).canSendTo).toEqual(["channel:memory:oc_1", "inbox:*"]);
    // a parent that can only reach the desk passes on just that
    const deskOnly = makeBounds({ ...serializeBounds(parent), canSendTo: ["inbox:desk", "channel:memory:*"] });
    expect(attenuateBounds(deskOnly, "proj").canSendTo).toEqual(["inbox:desk", "inbox:proj"]);
    expect(attenuateBounds(deskOnly, "proj", { canSendTo: ["inbox:*"] }).canSendTo).toEqual(["inbox:desk", "inbox:proj"]);
    expect(attenuateBounds(deskOnly, "proj", { canSendTo: ["channel:memory:*"] }).canSendTo).toEqual(["channel:memory:*", "inbox:desk", "inbox:proj"]);
    // a parent with no inbox patterns gives only its own inbox
    const channelsOnly = makeBounds({ ...serializeBounds(parent), canSendTo: ["channel:memory:*"] });
    expect(attenuateBounds(channelsOnly, "proj").canSendTo).toEqual(["inbox:proj"]);
  });

  it("garbage numbers clamp to 0 and infinities to the parent's value", () => {
    const c = attenuateBounds(parent, "p", {

      maxConcurrentChildren: Number.POSITIVE_INFINITY,
      maxDepth: 0.9,
    });
    expect([c.maxConcurrentChildren, c.maxDepth]).toEqual([4, 0]);
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
    expect(intersectPatterns(["channel:memory:*"], ["channel:memory:oc_*"])).toEqual(["channel:memory:oc_*"]);
    expect(intersectPatterns(["channel:memory:oc_*"], ["channel:memory:*"])).toEqual(["channel:memory:oc_*"]);
    expect(intersectPatterns(["channel:memory:*"], ["channel:other:*"])).toEqual([]);
    expect(intersectPatterns(["inbox:a", "inbox:*"], ["inbox:*"])).toEqual(["inbox:*"]);
    expect(intersectPatterns(["not-an-address", "inbox:"], ["inbox:*", "channel:*"])).toEqual([]);
  });
});

describe("stored bounds", () => {
  it("never exceeds the stored parent bounds even when the caller passes wider ones", () => {
    const f = setup();
    f.addCell("narrow", "desk", { tools: ["read"], canSendTo: ["inbox:desk"], isolation: "none", maxDepth: 1, maxConcurrentChildren: 1 });
    const wide = makeBounds({ tools: TOOL_KINDS, canSendTo: ["inbox:*", "channel:*" as Address], isolation: "none", maxConcurrentChildren: 9, maxDepth: 5 });
    const c = f.gate.attenuate(wide, "narrow", { tools: new Set(TOOL_KINDS), canSendTo: ["channel:memory:x"] });
    expect(isSubsetBounds(c, f.cells.require("narrow").bounds, { parentCellId: "narrow" })).toBe(true);
    // the request's channel is outside the stored parent; the stored parent's own inbox reach is inherited
    expect(serializeBounds(c)).toMatchObject({ tools: ["read"], canSendTo: ["inbox:desk", "inbox:narrow"], isolation: "none", maxDepth: 0 });
  });

  it("randomized: always ⊆ the passed parent and the stored parent", () => {
    const r = rng(99);
    for (let i = 0; i < 200; i++) {
      const f = setup();
      const stored = randomParent(r);
      f.addCell("p", "desk", serializeBounds(stored));
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
      const expected = attenuateBounds(meetBounds(passed, f.cells.require("p").bounds), "p", requested);
      expect(serializeBounds(c)).toEqual(serializeBounds(expected));
    }
  });
});
