import { describe, expect, it } from "vitest";
import { isNgError, markdownDeliverable } from "@ng/protocol";
import { setup, userEnvelope } from "./helpers";

function seed() {
  const h = setup({
    cells: [{ id: "desk" }, { id: "p", parentId: "desk" }, { id: "w", parentId: "p" }, { id: "sib", parentId: "p" }],
    store: { limits: { inlineChars: 400, spillHeadChars: 200, spillTailChars: 100 } },
  });
  const s = h.store;
  const at = () => h.clock.advance(1000);
  s.appendEvidenceSync("w", { kind: "inbound", envelope: userEnvelope(h.clock, "帮我催一下供应商 C 的报价单"), runId: "r1", at: at() });
  s.appendEvidenceSync("w", { kind: "assistant_text", text: "好的，我会在明天上午跟进报价。", runId: "r1", at: at() });
  s.appendEvidenceSync("w", { kind: "tool_call", toolUseId: "t1", name: "bash", input: { command: "pnpm test" }, runId: "r1", at: at() });
  s.appendEvidenceSync("w", {
    kind: "tool_result",
    toolUseId: "t1",
    name: "bash",
    output: `FAIL payment.test.ts 支付回调签名错误\n${"x".repeat(1000)}\n测试结束`,
    runId: "r1",
    at: at(),
  });
  s.appendEvidenceSync("w", { kind: "external", source: "feishu", title: "群聊反馈", text: "用户反馈支付报错三次", runId: null, at: at() });
  s.appendEvidenceSync("sib", { kind: "assistant_text", text: "兄弟分身的报价单记录", runId: "r9", at: at() });
  s.upsertSkillOrNoteSync("p", { kind: "note", scope: "cell", name: "报价约定", description: "项目共享笔记", body: "报价单需含税", mode: "upsert" });
  s.upsertSkillOrNoteSync("sib", { kind: "note", scope: "cell", name: "兄弟笔记", description: "不可见", body: "报价单草稿", mode: "upsert" });
  s.upsertSkillOrNoteSync("desk", { kind: "preference", scope: "global", name: "语言", description: "回复语言", body: "报价单一律中文", mode: "upsert" });
  return h;
}

describe("searchHistory", () => {
  it("finds Chinese substrings with the trigram index, within the cell, its ancestors' notes and global knowledge", async () => {
    const h = seed();
    const hits = await h.store.searchHistory("w", "报价单");
    const keys = hits.map((s) => `${s.source}:${s.cellId}:${s.kind}`).sort();
    expect(keys).toEqual(["evidence:w:inbound", "knowledge:null:preference", "knowledge:p:note"]);
    const note = hits.find((s) => s.kind === "note")!;
    expect(note).toMatchObject({ uri: "note://报价约定", title: "报价约定", runId: null });
    expect(note.text).toContain("报价单需含税");
    expect(h.store.readResourceSync("w", note.uri!)).toBe("报价单需含税");
    for (const s of hits) expect(typeof s.rank).toBe("number");
  });

  it("falls back to LIKE for 1-2 character queries and combines terms", () => {
    const h = seed();
    expect(h.store.searchHistorySync("w", "报价").map((s) => s.kind).sort()).toEqual(["assistant_text", "inbound", "note", "preference"]);
    expect(h.store.searchHistorySync("w", "支付").map((s) => s.kind).sort()).toEqual(["external", "tool_result"]);
    // a long term through FTS plus a short term through LIKE
    const both = h.store.searchHistorySync("w", "支付回调 签名");
    expect(both.map((s) => s.kind)).toEqual(["tool_result"]);
    expect(both[0]!.spillUri).toMatch(/^res:\/\/w\//);
    expect(both[0]!.uri).toBe(both[0]!.spillUri);
    expect(both[0]!.text).toContain("支付回调签名错误");
    const ext = h.store.searchHistorySync("w", "群聊反馈");
    expect(ext[0]).toMatchObject({ kind: "external", title: "群聊反馈" });
  });

  it("never parses user input as FTS syntax and respects the limit", () => {
    const h = seed();
    for (const q of ['"报价', "NEAR(a b)", "a OR b", "*", "报价单 AND", "'; DROP TABLE evidence; --", "%_\\"]) {
      expect(() => h.store.searchHistorySync("w", q)).not.toThrow();
    }
    expect(h.store.searchHistorySync("w", "   ")).toEqual([]);
    expect(h.store.searchHistorySync("w", "报价", { limit: 2 }).length).toBe(2);
  });

  it("a fork_prefix child also searches its inherited history up to the fork point", () => {
    const h = seed();
    const upto = h.store.lastEvidenceSeqSync("w");
    h.store.appendEvidenceSync("w", { kind: "assistant_text", text: "fork 之后的报价单更新", runId: "r2", at: 1 });
    h.cells.insert({ id: "child", parentId: "w", spec: { processor: { kind: "llm" }, contextMode: "fork_prefix", fork: { fromCellId: "w", uptoSeq: upto } } });
    const texts = h.store.searchHistorySync("child", "报价单").filter((s) => s.source === "evidence").map((s) => s.text);
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("催一下供应商");
  });
});

/**
 * desk ─┬─ proj ─┬─ w1 (closed)
 *       │        └─ w2 ── g
 *       └─ sib
 * other (a separate root)
 */
function tree() {
  const h = setup({
    cells: [
      { id: "desk" },
      { id: "proj", parentId: "desk" },
      { id: "w1", parentId: "proj" },
      { id: "w2", parentId: "proj" },
      { id: "g", parentId: "w2" },
      { id: "sib", parentId: "desk" },
      { id: "other" },
    ],
    store: { limits: { inlineChars: 400, spillHeadChars: 200, spillTailChars: 100 } },
  });
  const s = h.store;
  const at = () => h.clock.advance(1000);
  s.appendEvidenceSync("w1", { kind: "assistant_text", text: "周报数据源在 warehouse.orders_daily 表", runId: "r1", at: at() });
  // The token sits in the middle of a long output: neither the inline head nor the tail kept in evidence has it.
  const spill = s.appendEvidenceSync("w1", {
    kind: "tool_result",
    toolUseId: "t1",
    name: "bash",
    output: `HEADMARK ${"x".repeat(1000)} zq_middle_token ${"y".repeat(1000)}`,
    runId: "r1",
    at: at(),
  });
  s.commitSync("w2", { artifact: { artifactId: "report", content: markdownDeliverable("本周 GMV 来自 metrics_v3 看板", "周报草稿"), updatedBy: "agent" } });
  s.commitSync("g", {
    statePatches: {
      "notes:datasource": { text: "埋点数据源 kafka-topic-clicks", count: 3 },
      "cli:session": { sessionId: "xyzSecretSession" },
      "cell:result": { summary: "xyzSecretSession result" },
    },
  });
  s.appendEvidenceSync("sib", { kind: "assistant_text", text: "sibling mentions warehouse.orders_daily too", runId: "r2", at: at() });
  s.appendEvidenceSync("other", { kind: "assistant_text", text: "other root: warehouse.orders_daily", runId: "r3", at: at() });
  s.upsertSkillOrNoteSync("sib", { kind: "note", scope: "cell", name: "sib-note", description: "x", body: "metrics_v3 口径说明", mode: "upsert" });
  h.cells.setStatus("w1", "closed");
  return { h, spillUri: spill.spill!.uri };
}

const keyOf = (x: { source: string; cellId: string | null; kind: string }) => `${x.source}:${x.cellId}:${x.kind}`;

describe("searchHistory scopes", () => {
  it("lineage is the default and does not look into children, artifacts, state or resources", async () => {
    const { h } = tree();
    for (const q of ["warehouse.orders_daily", "metrics_v3", "kafka-topic-clicks", "zq_middle_token"]) {
      expect(h.store.searchHistorySync("proj", q)).toEqual([]);
      expect(h.store.searchHistorySync("proj", q, { scope: "lineage" })).toEqual([]);
      expect(await h.store.searchHistory("proj", q)).toEqual([]);
    }
    expect(h.store.searchHistorySync("w1", "warehouse.orders_daily").map(keyOf)).toEqual(["evidence:w1:assistant_text"]);
  });

  it("subtree finds a closed descendant's evidence, artifact bodies, state values and the middle of a spilled resource", async () => {
    const { h, spillUri } = tree();
    const sub = (q: string) => h.store.searchHistorySync("proj", q, { scope: "subtree" });

    expect(sub("warehouse.orders_daily").map(keyOf)).toEqual(["evidence:w1:assistant_text"]); // not sib, not other

    const [art] = sub("metrics_v3");
    expect(sub("metrics_v3")).toHaveLength(1); // sib's note is outside proj's lineage
    expect(art).toMatchObject({ source: "artifact", kind: "artifact", cellId: "w2", seq: 1, uri: "artifact://report", title: "周报草稿", runId: null });
    expect(art!.text).toContain("metrics_v3");
    expect(typeof art!.rank).toBe("number");
    expect(h.store.readResourceSync("proj", art!.uri!)).toBe("本周 GMV 来自 metrics_v3 看板");

    expect(sub("kafka-topic-clicks")).toEqual([
      expect.objectContaining({ source: "state", kind: "state", cellId: "g", seq: 0, title: "notes:datasource", text: "埋点数据源 kafka-topic-clicks" }),
    ]);
    // CLI session records and the cell result are bookkeeping, never hits.
    expect(sub("xyzSecretSession")).toEqual([]);

    const [res] = sub("zq_middle_token");
    expect(sub("zq_middle_token")).toHaveLength(1);
    expect(res).toMatchObject({ source: "resource", kind: "resource", cellId: "w1", seq: 0, uri: spillUri, runId: "r1", title: "tool:bash" });
    expect(res!.text).toMatch(/^…x+ zq_middle_token y+…$/);
    const offset = h.store.readResourceSync("proj", spillUri, { offset: 0, limit: 5000 }).indexOf("zq_middle_token");
    expect(h.store.readResourceSync("proj", spillUri, { offset, limit: 15 })).toBe("zq_middle_token");

    // A match the evidence already shows (spill head) is reported once, as evidence pointing at the resource.
    expect(sub("HEADMARK")).toEqual([expect.objectContaining({ source: "evidence", kind: "tool_result", uri: spillUri, spillUri })]);
    // The async twin passes the options through.
    expect((await h.store.searchHistory("proj", "metrics_v3", { scope: "subtree" })).map(keyOf)).toEqual(["artifact:w2:artifact"]);
  });

  it("subtree is the cell and its descendants only", () => {
    const { h } = tree();
    expect(h.store.searchHistorySync("w2", "warehouse.orders_daily", { scope: "subtree" })).toEqual([]);
    expect(h.store.searchHistorySync("w2", "kafka-topic-clicks", { scope: "subtree" }).map(keyOf)).toEqual(["state:g:state"]);
    expect(h.store.searchHistorySync("g", "metrics_v3", { scope: "subtree" })).toEqual([]);
    expect(h.store.searchHistorySync("desk", "warehouse.orders_daily", { scope: "subtree" }).map(keyOf).sort()).toEqual([
      "evidence:sib:assistant_text",
      "evidence:w1:assistant_text",
    ]);
  });

  it("short terms fall back to LIKE on the new sources too", () => {
    const { h } = tree();
    const hits = h.store.searchHistorySync("proj", "看板", { scope: "subtree" });
    expect(hits.map(keyOf)).toEqual(["artifact:w2:artifact"]);
    expect(hits[0]!.rank).toBeUndefined();
    expect(h.store.searchHistorySync("proj", "埋点", { scope: "subtree" }).map(keyOf)).toEqual(["state:g:state"]);
    // long (FTS) and short (LIKE) terms combined
    expect(h.store.searchHistorySync("proj", "metrics_v3 看板", { scope: "subtree" }).map(keyOf)).toEqual(["artifact:w2:artifact"]);
    expect(h.store.searchHistorySync("proj", "metrics_v3 埋点", { scope: "subtree" })).toEqual([]);
  });

  it("global searches every cell's evidence, artifacts, state, resources and knowledge", () => {
    const { h } = tree();
    const g = (q: string, limit?: number) => h.store.searchHistorySync("other", q, { scope: "global", ...(limit ? { limit } : {}) });
    expect(g("warehouse.orders_daily").map(keyOf).sort()).toEqual([
      "evidence:other:assistant_text",
      "evidence:sib:assistant_text",
      "evidence:w1:assistant_text",
    ]);
    expect(g("metrics_v3").map(keyOf).sort()).toEqual(["artifact:w2:artifact", "knowledge:sib:note"]);
    expect(g("kafka-topic-clicks").map(keyOf)).toEqual(["state:g:state"]);
    expect(g("zq_middle_token").map(keyOf)).toEqual(["resource:w1:resource"]);
    expect(g("warehouse.orders_daily", 2)).toHaveLength(2);
    expect(g("xyzSecretSession")).toEqual([]);
  });

  it("keeps the indexes in step with every write: updates, deletes and later spills", () => {
    const { h } = tree();
    const sub = (q: string) => h.store.searchHistorySync("proj", q, { scope: "subtree" });
    h.store.commitSync("proj", { artifact: { artifactId: "report", content: markdownDeliverable("改用 metrics_v4 看板"), updatedBy: "agent", expectedVersion: 1 } });
    expect(sub("metrics_v3")).toEqual([]);
    expect(sub("metrics_v4")).toEqual([expect.objectContaining({ source: "artifact", cellId: "w2", seq: 2 })]);
    expect(sub("metrics_v4")[0]!.title).toBeUndefined();

    h.store.commitSync("g", { statePatches: { "notes:datasource": "now clickhouse_events" } });
    expect(sub("kafka-topic-clicks")).toEqual([]);
    expect(sub("clickhouse_events")).toEqual([expect.objectContaining({ title: "notes:datasource", text: "now clickhouse_events" })]);
    h.store.commitSync("g", { statePatches: { "notes:datasource": null } });
    expect(sub("clickhouse_events")).toEqual([]);

    // A state value without strings is still found by its key.
    h.store.commitSync("w2", { statePatches: { "budget:spent": 42 } });
    expect(sub("budget:spent")).toEqual([expect.objectContaining({ source: "state", text: "42" })]);

    const uri = h.store.writeResourceSync("w2", "job log: deploy_target=staging-7");
    expect(sub("staging-7")).toEqual([expect.objectContaining({ source: "resource", uri, cellId: "w2" })]);
  });

  it("rejects an unknown scope", () => {
    const { h } = tree();
    let caught: unknown;
    try {
      h.store.searchHistorySync("proj", "x", { scope: "everything" as never });
    } catch (e) {
      caught = e;
    }
    expect(isNgError(caught, "invalid_argument")).toBe(true);
  });
});
