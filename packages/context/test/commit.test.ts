import { describe, expect, it } from "vitest";
import { createEnvelope, gtdKeys, markdownDeliverable, textDeliverable, withTx } from "@ng/protocol";
import { setup } from "./helpers";

const env = (h: ReturnType<typeof setup>, id: string) =>
  createEnvelope({ id, from: "inbox:w1", principalId: "cell:w1", kind: "result", type: "cell.progress", payload: { childCellId: "w1", text: "2/3" } }, h.clock);

describe("state", () => {
  it("reads, lists by prefix, deletes with null/undefined, and queries across cells", () => {
    const h = setup({ cells: [{ id: "desk" }, { id: "p1", parentId: "desk" }, { id: "p2", parentId: "desk" }] });
    const s = h.store;
    s.commitSync("p1", { statePatches: { [gtdKeys.action("a")]: { title: "A" }, [gtdKeys.action("b")]: { title: "B" }, "gtd:project": { title: "P1" } } });
    s.commitSync("p2", { statePatches: { [gtdKeys.action("c")]: { title: "C" }, other: 1 } });
    expect(s.readStateSync("p1", gtdKeys.action("a"))).toEqual({ title: "A" });
    expect(s.readStateSync("p1", "missing")).toBeNull();
    expect(s.listStateSync("p1", gtdKeys.actionPrefix).map((e) => e.key)).toEqual(["gtd:action:a", "gtd:action:b"]);

    const all = s.queryStateSync({ keyPrefix: gtdKeys.actionPrefix });
    expect(all.map((e) => `${e.cellId}/${e.key}`)).toEqual(["p1/gtd:action:a", "p1/gtd:action:b", "p2/gtd:action:c"]);
    expect(s.queryStateSync({ keyPrefix: "gtd:", cellIds: ["p2"] }).map((e) => e.key)).toEqual(["gtd:action:c"]);
    expect(s.queryStateSync({ keyPrefix: "gtd:", cellIds: [] })).toEqual([]);

    s.commitSync("p1", { statePatches: { [gtdKeys.action("a")]: null, [gtdKeys.action("b")]: undefined } });
    expect(s.listStateSync("p1", gtdKeys.actionPrefix)).toEqual([]);
    const changed = h.events.filter((e) => e.topic === "state.changed").map((e) => e.data);
    expect(changed.at(-1)).toEqual({ cellId: "p1", keys: ["gtd:action:a", "gtd:action:b"] });
  });

  it("async twins delegate to the sync core", async () => {
    const h = setup();
    expect(await h.store.commit("desk", { statePatches: { k: [1, 2] } })).toEqual({ ok: true });
    expect(await h.store.readState("desk", "k")).toEqual([1, 2]);
    expect((await h.store.listState("desk", "")).map((e) => e.key)).toEqual(["k"]);
    expect((await h.store.queryState({ keyPrefix: "k" })).length).toBe(1);
  });
});

describe("commit atomicity", () => {
  it("applies state, artifact and inboxOut together, emitting after commit", () => {
    const h = setup({ cells: [{ id: "desk" }, { id: "w1", parentId: "desk" }] });
    const r = h.store.commitSync("w1", {
      statePatches: { "cell:status": { text: "working", at: 1 } },
      artifact: { artifactId: "draft-1", content: textDeliverable("hello"), updatedBy: "agent" },
      inboxOut: [{ to: "inbox:desk", envelope: env(h, "e1"), schedule: { cancelGroup: "g" } }],
    });
    expect(r).toEqual({ ok: true, artifactVersion: 1 });
    expect(h.inbox.rows()).toEqual([
      { cellId: "desk", envelope: expect.objectContaining({ id: "e1", to: "inbox:desk" }), schedule: { cancelGroup: "g" } },
    ]);
    expect(h.events.map((e) => e.topic)).toEqual(["state.changed", "artifact.changed"]);
  });

  it("an artifact version conflict leaves state and inboxOut untouched", () => {
    const h = setup({ cells: [{ id: "desk" }, { id: "w1", parentId: "desk" }] });
    h.store.commitSync("w1", { artifact: { artifactId: "d", content: textDeliverable("v1"), updatedBy: "agent" } });
    h.store.commitSync("w1", { artifact: { artifactId: "d", content: textDeliverable("human v2"), updatedBy: "human", expectedVersion: 1 } });
    h.events.length = 0;

    const r = h.store.commitSync("w1", {
      statePatches: { progress: 5 },
      artifact: { artifactId: "d", content: textDeliverable("agent refresh"), updatedBy: "agent", expectedVersion: 1 },
      inboxOut: [{ to: "inbox:desk", envelope: env(h, "e2") }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.currentArtifact).toMatchObject({ artifactId: "d", version: 2, updatedBy: "human", content: { body: "human v2" } });
    expect(h.store.readStateSync("w1", "progress")).toBeNull();
    expect(h.inbox.rows()).toEqual([]);
    expect(h.store.getArtifactSync("d")?.version).toBe(2);
    // The only surviving write is the parked agent content (and its event).
    expect(h.events.map((e) => [e.topic, (e.data as { parked?: boolean }).parked])).toEqual([["artifact.changed", true]]);
  });

  it("an inbox failure rolls back state and artifact", () => {
    const h = setup({ cells: [{ id: "desk" }, { id: "w1", parentId: "desk" }] });
    h.inbox.reject.add("ghost");
    expect(() =>
      h.store.commitSync("w1", {
        statePatches: { a: 1 },
        artifact: { artifactId: "d", content: textDeliverable("x"), updatedBy: "agent" },
        inboxOut: [
          { to: "inbox:desk", envelope: env(h, "ok") },
          { to: "inbox:ghost", envelope: env(h, "boom") },
        ],
      }),
    ).toThrow(/ghost/);
    expect(h.store.readStateSync("w1", "a")).toBeNull();
    expect(h.store.getArtifactSync("d")).toBeNull();
    expect(h.store.listArtifactVersionsSync("d")).toEqual([]);
    expect(h.inbox.rows()).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("nests inside a caller's transaction: events wait for the outer commit, a rollback leaves no trace", () => {
    const h = setup();
    withTx(h.db, () => {
      h.store.commitSync("desk", { statePatches: { a: 1 }, inboxOut: [{ to: "inbox:desk", envelope: env(h, "n1") }] });
      expect(h.events).toEqual([]);
    });
    expect(h.events.map((e) => e.topic)).toEqual(["state.changed"]);

    h.events.length = 0;
    expect(() =>
      withTx(h.db, () => {
        h.store.commitSync("desk", { statePatches: { b: 2 }, inboxOut: [{ to: "inbox:desk", envelope: env(h, "n2") }] });
        throw new Error("caller failed");
      }),
    ).toThrow("caller failed");
    expect(h.store.readStateSync("desk", "b")).toBeNull();
    expect(h.inbox.rows().map((r) => r.envelope.id)).toEqual(["n1"]);
    expect(h.events).toEqual([]);
  });

  it("rejects malformed input before touching anything", () => {
    const h = setup();
    expect(() => h.store.commitSync("desk", { inboxOut: [{ to: "channel:x:y" as never, envelope: env(h, "x") }] })).toThrow(/inbox address/);
    expect(() =>
      h.store.commitSync("desk", { inboxOut: [{ to: "inbox:desk", envelope: { ...env(h, "x"), to: "inbox:other" } }] }),
    ).toThrow(/differs/);
    expect(() =>
      h.store.commitSync("desk", { artifact: { artifactId: "d", content: { format: "pdf", body: "x" } as never, updatedBy: "agent" } }),
    ).toThrow(/Deliverable/);
    expect(() => h.store.commitSync("nope", { statePatches: { a: 1 } })).toThrow(/FOREIGN KEY/);
    expect(h.inbox.rows()).toEqual([]);
  });

  it("another cell may revise an artifact in the same commit as its own state; the artifact keeps its creating cell", () => {
    const h = setup({ cells: [{ id: "desk" }, { id: "w1", parentId: "desk" }] });
    h.store.commitSync("w1", { artifact: { artifactId: "d", content: markdownDeliverable("# x"), updatedBy: "agent" } });
    const r = h.store.commitSync("desk", {
      statePatches: { reviewed: true },
      artifact: { artifactId: "d", content: textDeliverable("y"), updatedBy: "agent", expectedVersion: 1 },
    });
    expect(r).toEqual({ ok: true, artifactVersion: 2 });
    expect(h.store.readStateSync("desk", "reviewed")).toBe(true);
    expect(h.store.getArtifactSync("d")).toMatchObject({ cellId: "w1", version: 2, content: { body: "y" } });
  });
});
