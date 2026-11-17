import { describe, expect, it } from "vitest";
import { artifactsRepo, isNgError, markdownDeliverable, textDeliverable } from "@ng/protocol";
import { setup } from "./helpers";

const agent = (body: string, expectedVersion?: number) => ({
  artifactId: "draft",
  content: markdownDeliverable(body, "回复草稿"),
  updatedBy: "agent" as const,
  ...(expectedVersion !== undefined ? { expectedVersion } : {}),
});
const human = (body: string, expectedVersion?: number) => ({
  artifactId: "draft",
  content: markdownDeliverable(body, "回复草稿"),
  updatedBy: "human" as const,
  ...(expectedVersion !== undefined ? { expectedVersion } : {}),
});

describe("versioned artifacts", () => {
  it("creates at v1, updates with the matching expectedVersion, keeps every version", () => {
    const h = setup();
    expect(h.store.commitSync("desk", { artifact: agent("v1") })).toEqual({ ok: true, artifactVersion: 1 });
    h.clock.advance(5);
    expect(h.store.commitSync("desk", { artifact: agent("v2", 1) })).toEqual({ ok: true, artifactVersion: 2 });
    expect(h.store.commitSync("desk", { artifact: human("v3 by me", 2) })).toEqual({ ok: true, artifactVersion: 3 });

    const a = h.store.getArtifactSync("draft")!;
    expect(a).toMatchObject({ artifactId: "draft", cellId: "desk", version: 3, updatedBy: "human", content: { body: "v3 by me", title: "回复草稿" } });
    expect(a.updatedAt).toBeGreaterThan(a.createdAt);
    expect(h.store.listArtifactVersionsSync("draft").map((v) => [v.version, v.updatedBy, v.content.body])).toEqual([
      [1, "agent", "v1"],
      [2, "agent", "v2"],
      [3, "human", "v3 by me"],
    ]);
    expect(h.store.getArtifactVersionSync("draft", 2)?.content.body).toBe("v2");
    expect(h.store.getArtifactVersionSync("draft", 9)).toBeNull();
    expect(h.store.listArtifactsSync("desk").map((x) => x.artifactId)).toEqual(["draft"]);
    // Gate and the kernel read the same rows through the protocol's read-only repo.
    expect(artifactsRepo(h.db).getVersion("draft", 3)?.content.body).toBe("v3 by me");
  });

  it("a background refresh never overwrites a human edit: it is rejected and parked", async () => {
    const h = setup();
    h.store.commitSync("desk", { artifact: agent("agent draft v1") });
    // The human opens v1 in the Engage editor and saves.
    expect(h.store.commitSync("desk", { artifact: human("human rewrite", 1) })).toEqual({ ok: true, artifactVersion: 2 });
    // Meanwhile a new message arrives and the agent refreshes from v1.
    const r = h.store.commitSync("desk", { artifact: agent("agent draft + new info from the supplier", 1) });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.currentArtifact).toMatchObject({ version: 2, updatedBy: "human", content: { body: "human rewrite" } });
    expect(r.parked).toMatchObject({ artifactId: "draft", basedOnVersion: 1, content: { body: "agent draft + new info from the supplier" } });
    expect((await h.store.getArtifact("draft"))?.content.body).toBe("human rewrite");

    // Without expectedVersion an agent write over a human version is also parked, never applied.
    const r2 = h.store.commitSync("desk", { artifact: agent("blind agent write") });
    expect(r2.ok).toBe(false);
    expect(h.store.listParkedSync("draft").map((p) => [p.basedOnVersion, p.content.body])).toEqual([
      [1, "agent draft + new info from the supplier"],
      [0, "blind agent write"],
    ]);
    expect(h.store.getArtifactSync("draft")?.version).toBe(2);
  });

  it("a human save on a stale version conflicts without parking (the UI shows the newer agent version)", () => {
    const h = setup();
    h.store.commitSync("desk", { artifact: agent("v1") });
    h.store.commitSync("desk", { artifact: agent("v2 agent", 1) });
    const r = h.store.commitSync("desk", { artifact: human("my edit of v1", 1) });
    expect(r).toMatchObject({ ok: false, currentArtifact: { version: 2, updatedBy: "agent" } });
    expect("parked" in r).toBe(false);
    // Human writes always need expectedVersion on an existing artifact.
    expect(h.store.commitSync("desk", { artifact: human("no version") })).toMatchObject({ ok: false });
    expect(h.store.listParkedSync("draft")).toEqual([]);
    expect(h.store.commitSync("desk", { artifact: human("my edit of v2", 2) })).toEqual({ ok: true, artifactVersion: 3 });
  });

  it("agent over agent without expectedVersion is accepted; a stale agent version conflicts without parking", () => {
    const h = setup();
    h.store.commitSync("desk", { artifact: agent("v1") });
    expect(h.store.commitSync("desk", { artifact: agent("v2") })).toEqual({ ok: true, artifactVersion: 2 });
    expect(h.store.commitSync("desk", { artifact: agent("stale", 1) })).toMatchObject({ ok: false, currentArtifact: { version: 2 } });
    expect(h.store.listParkedSync("draft")).toEqual([]);
  });

  it("expectedVersion on a missing artifact is an error, 0 means create", () => {
    const h = setup();
    let caught: unknown;
    try {
      h.store.commitSync("desk", { artifact: agent("x", 3) });
    } catch (e) {
      caught = e;
    }
    expect(isNgError(caught, "not_found")).toBe(true);
    expect(h.store.commitSync("desk", { artifact: agent("x", 0) })).toEqual({ ok: true, artifactVersion: 1 });
    expect(h.store.commitSync("desk", { artifact: agent("y", 0) })).toMatchObject({ ok: false });
  });

  it("explicit parking with a note, listing and dismissing", () => {
    const h = setup();
    h.store.commitSync("desk", { artifact: agent("v1") });
    h.events.length = 0;
    const p = h.store.parkAdditionSync("draft", { content: textDeliverable("供应商 C 刚回了报价"), basedOnVersion: 1, note: "新增报价信息" });
    expect(p).toMatchObject({ artifactId: "draft", basedOnVersion: 1, note: "新增报价信息", dismissedAt: null });
    expect(h.events).toEqual([{ topic: "artifact.changed", data: { cellId: "desk", artifactId: "draft", version: 1, updatedBy: "agent", parked: true } }]);
    h.clock.advance(1);
    h.store.dismissParkedSync(p.id);
    expect(h.store.listParkedSync("draft")).toEqual([]);
    expect(h.store.listParkedSync("draft", { includeDismissed: true })[0]?.dismissedAt).toBe(h.clock.now());
    expect(() => h.store.dismissParkedSync("nope")).toThrow(/not found/);
    expect(() => h.store.parkAdditionSync("missing", { content: textDeliverable("x"), basedOnVersion: 0 })).toThrow(/not found/);
  });
});
