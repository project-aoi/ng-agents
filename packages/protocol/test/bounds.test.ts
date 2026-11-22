import { describe, expect, it } from "vitest";
import {
  boundsViolations,
  deserializeBounds,
  describeBounds,
  isNgError,
  isSubsetBounds,
  makeBounds,
  serializeBounds,
  type PolicyBounds,
} from "../src";

const desk: PolicyBounds = makeBounds({
  tools: ["read", "write", "edit", "bash"],
  canSendTo: ["inbox:*", "channel:web:owner", "channel:memory:*"],
  maxConcurrentChildren: 5,
  maxDepth: 3,
});

const worker = (over: Parameters<typeof makeBounds>[0] = {}) =>
  makeBounds({
    tools: ["read", "edit", "bash"],
    canSendTo: ["inbox:desk"],
    maxConcurrentChildren: 2,
    maxDepth: 2,
    ...over,
  });

describe("isSubsetBounds", () => {
  it("accepts a narrower child", () => {
    expect(boundsViolations(worker(), desk)).toEqual([]);
    expect(isSubsetBounds(worker(), desk)).toBe(true);
  });

  it("rejects each kind of widening", () => {
    expect(isSubsetBounds(worker({ tools: ["read", "write", "edit", "bash"] }), makeBounds({ ...serializeBounds(desk), tools: ["read"] }))).toBe(false);
    expect(isSubsetBounds(worker({ canSendTo: ["channel:other:me"] }), desk)).toBe(false);
    expect(isSubsetBounds(worker({ maxConcurrentChildren: 6 }), desk)).toBe(false);
  });


  it("requires maxDepth to drop by one for a child, but not for narrowing", () => {
    expect(isSubsetBounds(worker({ maxDepth: 3 }), desk)).toBe(false);
    expect(isSubsetBounds(worker({ maxDepth: 2 }), desk)).toBe(true);
    expect(isSubsetBounds(worker({ maxDepth: 3 }), desk, { relation: "narrowing" })).toBe(true);
    const leaf = worker({ maxDepth: 0 });
    expect(isSubsetBounds(worker({ maxDepth: 0 }), leaf)).toBe(false);
  });

  it("covers addresses with trailing-* wildcards", () => {
    expect(isSubsetBounds(worker({ canSendTo: ["channel:memory:chat_1"] }), desk)).toBe(true);
    expect(isSubsetBounds(worker({ canSendTo: ["channel:memory:*"] }), desk)).toBe(true);
    const narrow = makeBounds({ ...serializeBounds(desk), canSendTo: ["channel:memory:chat_1"] });
    expect(isSubsetBounds(worker({ canSendTo: ["channel:memory:*"] }), narrow)).toBe(false);
  });

  it("always allows reporting back to the parent's own inbox when parentCellId is given", () => {
    const parent = makeBounds({ ...serializeBounds(worker()), canSendTo: ["inbox:desk"] });
    const child = worker({ canSendTo: ["inbox:proj-1"], maxDepth: 1 });
    expect(isSubsetBounds(child, parent)).toBe(false);
    expect(isSubsetBounds(child, parent, { parentCellId: "proj-1" })).toBe(true);
  });
});

describe("bounds serialization", () => {
  it("round-trips through JSON with sets restored", () => {
    const json = JSON.stringify(serializeBounds(desk));
    const back = deserializeBounds(json);
    expect(back.tools).toBeInstanceOf(Set);
    expect(serializeBounds(back)).toEqual(serializeBounds(desk));
    expect(isSubsetBounds(back, desk, { relation: "narrowing" })).toBe(true);
  });

  it("produces stable sorted arrays", () => {
    const b = makeBounds({ tools: ["write", "read"], canSendTo: ["inbox:z", "inbox:a", "inbox:a"] });
    expect(serializeBounds(b)).toMatchObject({ tools: ["read", "write"], canSendTo: ["inbox:a", "inbox:z"] });
  });

  it("rejects malformed input", () => {
    const bad = (x: unknown) => {
      try {
        deserializeBounds(x);
        return false;
      } catch (e) {
        return isNgError(e, "invalid_argument");
      }
    };
    expect(bad({ ...serializeBounds(desk), tools: ["fly"] })).toBe(true);
    expect(bad({ ...serializeBounds(desk), canSendTo: ["mailto:x"] })).toBe(true);
    expect(bad({ ...serializeBounds(desk), maxDepth: -1 })).toBe(true);
    expect(bad({ tools: [] })).toBe(true);
  });

  it("defaults to the most restrictive bounds", () => {
    expect(serializeBounds(makeBounds())).toEqual({
      tools: [],
      canSendTo: [],
      maxConcurrentChildren: 0,
      maxDepth: 0,
    });
    expect(describeBounds(desk)).toContain("Tools: bash, edit, read, write.");
  });
});
