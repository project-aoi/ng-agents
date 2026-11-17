import { describe, expect, it } from "vitest";
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
