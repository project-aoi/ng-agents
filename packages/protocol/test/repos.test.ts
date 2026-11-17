import { describe, expect, it } from "vitest";
import { ManualClock, artifactsRepo, isNgError, makeBounds, run } from "../src";
import { memDb, seedCells } from "./helpers";

describe("cellsRepo", () => {
  it("derives root/depth and walks the tree", () => {
    const db = memDb();
    const clock = new ManualClock(10);
    const cells = seedCells(db, clock, [
      { id: "desk", preset: "inline", bounds: makeBounds({ tools: ["read"], maxDepth: 3 }) },
      { id: "proj", parentId: "desk", title: "竞品调研" },
      { id: "w1", parentId: "proj", preset: "worker" },
      { id: "w2", parentId: "proj", preset: "worker" },
      { id: "w1a", parentId: "w1" },
    ]);
    const w1a = cells.require("w1a");
    expect(w1a).toMatchObject({ rootId: "desk", depth: 3, parentId: "w1", status: "active", epoch: 0, principalId: "owner" });
    expect(w1a.spec).toEqual({ processor: { kind: "llm" } });
    expect(cells.require("desk").bounds.tools.has("read")).toBe(true);
    expect(cells.ancestors("w1a").map((c) => c.id)).toEqual(["w1", "proj", "desk"]);
    expect(cells.ancestors("desk")).toEqual([]);
    expect(cells.descendants("desk").map((c) => c.id)).toEqual(["proj", "w1", "w2", "w1a"]);
    expect(cells.children("proj").map((c) => c.id)).toEqual(["w1", "w2"]);
    expect(cells.list({ preset: "worker" }).map((c) => c.id)).toEqual(["w1", "w2"]);
    expect(cells.list({ parentId: null }).map((c) => c.id)).toEqual(["desk"]);
  });

  it("bumps epoch, sets status and updates fields", () => {
    const db = memDb();
    const clock = new ManualClock(10);
    const cells = seedCells(db, clock, [{ id: "desk" }, { id: "w1", parentId: "desk" }]);
    expect(cells.bumpEpoch("w1")).toBe(1);
    expect(cells.bumpEpoch("w1")).toBe(2);
    expect(cells.getEpoch("w1")).toBe(2);
    expect(cells.getEpoch("missing")).toBeUndefined();

    clock.advance(5);
    cells.setStatus("w1", "closed", "cancelled");
    expect(cells.require("w1")).toMatchObject({ status: "closed", closeReason: "cancelled", closedAt: 15 });
    expect(cells.children("desk", { status: ["active", "paused"] })).toEqual([]);
    expect(cells.descendants("desk", { status: ["closed"] }).map((c) => c.id)).toEqual(["w1"]);

    const updated = cells.update("w1", { title: "修 Bug", lastRunAt: 20, bounds: makeBounds({ tools: ["bash"] }) });
    expect(updated).toMatchObject({ title: "修 Bug", lastRunAt: 20, updatedAt: 15 });
    expect([...updated.bounds.tools]).toEqual(["bash"]);

    const err = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e;
      }
      return null;
    };
    expect(isNgError(err(() => cells.bumpEpoch("missing")), "not_found")).toBe(true);
    expect(isNgError(err(() => cells.insert({ id: "w1" })), "duplicate")).toBe(true);
    expect(isNgError(err(() => cells.insert({ id: "x", parentId: "missing" })), "not_found")).toBe(true);
  });
});

describe("artifactsRepo", () => {
  it("reads current and historical versions", () => {
    const db = memDb();
    seedCells(db);
    const v1 = JSON.stringify({ format: "markdown", body: "初稿 v1" });
    const v2 = JSON.stringify({ format: "markdown", body: "初稿 v2" });
    run(db, "INSERT INTO artifacts (artifact_id, cell_id, version, format, content, updated_by, created_at, updated_at) VALUES ('a1','desk',2,'markdown',?,'human',1,2)", [v2]);
    run(db, "INSERT INTO artifact_versions VALUES ('a1',1,?,'agent',1)", [v1]);
    run(db, "INSERT INTO artifact_versions VALUES ('a1',2,?,'human',2)", [v2]);
    const repo = artifactsRepo(db);
    expect(repo.get("a1")).toMatchObject({ artifactId: "a1", version: 2, updatedBy: "human", cellId: "desk", content: { body: "初稿 v2" } });
    expect(repo.currentVersion("a1")).toBe(2);
    expect(repo.getVersion("a1", 1)?.content.body).toBe("初稿 v1");
    expect(repo.listVersions("a1").map((v) => v.updatedBy)).toEqual(["agent", "human"]);
    expect(repo.listByCell("desk")).toHaveLength(1);
    expect(repo.get("nope")).toBeUndefined();
  });
});
