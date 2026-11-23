import { describe, expect, it } from "vitest";
import { createBus, isNgError, markdownDeliverable, MAX_RESOURCE_PAGE_CHARS, run, spillNotice, withTx, type BusTopics } from "@ng/protocol";
import { batchOf, setup, userEnvelope } from "./helpers";

const LIMITS = { inlineChars: 400, spillHeadChars: 200, spillTailChars: 100 };

describe("evidence and Inline & Spill", () => {
  it("is append-only", () => {
    const h = setup();
    const { seq } = h.store.appendEvidenceSync("desk", { kind: "system_note", text: "hello", runId: null, at: 1 });
    expect(() => run(h.db, "UPDATE evidence SET text = 'x' WHERE seq = ?", [seq])).toThrow(/append-only/);
    expect(h.store.listEvidenceSync("desk")).toEqual([{ seq, cellId: "desk", record: { kind: "system_note", text: "hello", runId: null, at: 1 } }]);
    expect(h.store.lastEvidenceSeqSync("desk")).toBe(seq);
  });

  it("rejects malformed records", () => {
    const h = setup();
    expect(() => h.store.appendEvidenceSync("desk", { kind: "bogus" } as never)).toThrow(/unknown kind/);
    expect(() => h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "t", name: "x", runId: null, at: 1 } as never)).toThrow(
      /output/,
    );
    expect(() => h.store.appendEvidenceSync("nope", { kind: "system_note", text: "x", runId: null, at: 1 })).toThrow(/FOREIGN KEY/);
  });

  it("names the exact missing range, and never clips a page the agent explicitly asked to read", () => {
    const h = setup({ store: { limits: LIMITS } });
    const big = "x".repeat(5149);
    const cut = h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "t1", name: "bash", output: big, runId: "run1", at: 5 });
    // head 200 + tail 100 are inline; the notice says precisely what is gone and how to read exactly that.
    expect(cut.modelText).toContain(`4849 of 5149 characters are left out here: the first 200 characters are above and the last 100 below`);
    expect(cut.modelText).toContain(`read_resource("${cut.spill!.uri}", offset 200, limit 4849)`);
    // A report read on purpose, and a page of a spilled output, stay whole (otherwise reading the gap leaves a new gap).
    for (const name of ["read_artifact", "read_resource"]) {
      const whole = h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: `t-${name}`, name, output: big, runId: "run1", at: 6 });
      expect(whole.spill).toBeUndefined();
      expect(whole.modelText ?? big).toBe(big);
    }
    // …up to a bound: a huge document is still spilled, with pages to walk.
    const huge = h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "t9", name: "read_artifact", output: "y".repeat(40_000), runId: "run1", at: 7 });
    expect(huge.modelText).toContain("go on page by page");
  });

  it("keeps the largest read_resource page whole (with its paging line), but not more", () => {
    const h = setup({ store: { limits: LIMITS } });
    const note = `\n…[characters 0–${MAX_RESOURCE_PAGE_CHARS} shown; more follows: read_resource("artifact://art_report", offset ${MAX_RESOURCE_PAGE_CHARS}, limit ${MAX_RESOURCE_PAGE_CHARS})]`;
    const page = "p".repeat(MAX_RESOURCE_PAGE_CHARS) + note;
    const whole = h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "t1", name: "read_resource", output: page, runId: "run1", at: 1 });
    expect(whole.spill).toBeUndefined();
    expect(whole.modelText).toBe(page);
    // The same size from another tool is cut as usual; read_resource output beyond a page is cut too.
    for (const name of ["read_artifact", "bash"]) {
      expect(h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: `t-${name}`, name, output: page, runId: "run1", at: 2 }).spill).toBeDefined();
    }
    const over = h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "t3", name: "read_resource", output: "q".repeat(MAX_RESOURCE_PAGE_CHARS * 2), runId: "run1", at: 3 });
    expect(over.spill).toBeDefined();
  });

  it("E22: inspect_cell bounds its own answer, so a full inspection stays whole up to that bound", () => {
    const h = setup({ store: { limits: LIMITS } });
    const full = "i".repeat(39_000);
    const whole = h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "t1", name: "inspect_cell", output: full, runId: "run1", at: 1 });
    expect(whole.spill).toBeUndefined();
    expect(whole.modelText).toBe(full);
    const over = h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "t2", name: "inspect_cell", output: "j".repeat(60_000), runId: "run1", at: 2 });
    expect(over.spill).toBeDefined();
  });

  it("announces each appended record after commit with its stored seq", () => {
    const h = setup({ cells: [{ id: "desk" }, { id: "w1", parentId: "desk" }] });
    const bus = createBus();
    const store = h.makeStore({ bus, rescanSkillsOnCreate: false });
    const heard: Array<BusTopics["evidence.appended"]> = [];
    // A subscriber can read the row the moment it hears about it.
    const readable: boolean[] = [];
    bus.on("evidence.appended", (e) => {
      heard.push(e);
      readable.push(store.listEvidenceSync(e.cellId, { afterSeq: e.seq - 1, limit: 1 })[0]?.seq === e.seq);
    });

    const a = store.appendEvidenceSync("desk", { kind: "run_boundary", phase: "start", epoch: 0, runId: "run1", at: 1 });
    const b = store.appendEvidenceSync("w1", { kind: "tool_result", toolUseId: "t1", name: "bash", output: "z".repeat(5000), runId: "run2", at: 2 });
    const c = store.appendEvidenceSync("desk", { kind: "system_note", text: "a note from the UI", runId: null, at: 3 });
    expect(heard).toEqual([
      { cellId: "desk", seq: a.seq, kind: "run_boundary", runId: "run1" },
      { cellId: "w1", seq: b.seq, kind: "tool_result", runId: "run2" },
      { cellId: "desk", seq: c.seq, kind: "system_note", runId: null },
    ]);
    expect(readable).toEqual([true, true, true]);

    // Inside a caller's transaction: nothing until the outer commit, then one event per record, in order.
    heard.length = 0;
    const seqs = withTx(h.db, () => {
      const first = store.appendEvidenceSync("desk", { kind: "assistant_text", text: "one", runId: "run3", at: 4 }).seq;
      const second = store.appendEvidenceSync("desk", { kind: "assistant_text", text: "two", runId: "run3", at: 5 }).seq;
      expect(heard).toEqual([]);
      return [first, second];
    });
    expect(heard).toEqual(seqs.map((seq) => ({ cellId: "desk", seq, kind: "assistant_text", runId: "run3" })));

    // A rolled back append announces nothing.
    heard.length = 0;
    expect(() =>
      withTx(h.db, () => {
        store.appendEvidenceSync("desk", { kind: "system_note", text: "lost", runId: null, at: 6 });
        throw new Error("caller failed");
      }),
    ).toThrow("caller failed");
    expect(heard).toEqual([]);
    expect(readable.every(Boolean)).toBe(true);
  });

  it("spills large tool output to a resource, keeps head/tail inline and reads it back in pages", async () => {
    const h = setup({ store: { limits: LIMITS } });
    const lines = Array.from({ length: 300 }, (_, i) => `line ${String(i).padStart(3, "0")} 测试输出`);
    const big = lines.join("\n");
    const r = h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "t1", name: "bash", output: big, runId: "run1", at: 5 });
    expect(r.spill).toMatchObject({ totalChars: big.length, inlineChars: 300 });
    const uri = r.spill!.uri;
    expect(uri).toMatch(/^res:\/\/desk\/res_/);
    expect(r.modelText).toBe(`${big.slice(0, 200)}${spillNotice(uri, big.length, 200, 100)}\n${big.slice(-100)}`);

    const [stored] = h.store.listEvidenceSync("desk");
    expect(stored!.record).toMatchObject({ kind: "tool_result", output: r.modelText, spillUri: uri });

    // Paged reads over the whole original text.
    let rebuilt = "";
    for (let offset = 0; offset < big.length; offset += 1000) rebuilt += h.store.readResourceSync("desk", uri, { offset, limit: 1000 });
    expect(rebuilt).toBe(big);
    expect(h.store.readResourceSync("desk", uri)).toBe(big.slice(0, 8000));
    expect(await h.store.readResource("desk", uri, { offset: big.length - 5, limit: 100 })).toBe(big.slice(-5));
    expect(() => h.store.readResourceSync("desk", uri, { offset: -1, limit: 10 })).toThrow(/offset/);

    // History shows the model exactly modelText.
    const snap = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
    const blocks = snap.history.flatMap((m) => m.content);
    expect(blocks.some((b) => b.type === "text" && b.text.includes(r.modelText!))).toBe(true);
  });

  it("spills external text too and renders modelText as history will", () => {
    const h = setup({ store: { limits: LIMITS } });
    const text = "竞品价格表。".repeat(200);
    const r = h.store.appendEvidenceSync("desk", { kind: "external", source: "web", title: "竞品价格", uri: "https://x", text, runId: null, at: 1 });
    expect(r.spill?.totalChars).toBe(text.length);
    expect(r.modelText!.startsWith("[external · web · 竞品价格 · https://x]\n")).toBe(true);
    const snap = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
    expect(snap.history).toEqual([{ role: "user", content: [{ type: "text", text: r.modelText }] }]);
  });

  it("never splits a surrogate pair at the spill cut", () => {
    const h = setup({ store: { limits: { inlineChars: 10, spillHeadChars: 5, spillTailChars: 5 } } });
    const text = "abcd😀😀😀😀😀😀efgh";
    const r = h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "t", name: "x", output: text, runId: null, at: 1 });
    expect(() => encodeURIComponent(r.modelText!)).not.toThrow();
  });

  it("small outputs stay inline", () => {
    const h = setup({ store: { limits: LIMITS } });
    const r = h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "t", name: "x", output: "ok", runId: null, at: 1 });
    expect(r.spill).toBeUndefined();
    expect(r.modelText).toBe("ok");
  });

  it("any cell reads any cell's resources; an unknown one is not_found", () => {
    const h = setup({
      cells: [{ id: "desk" }, { id: "p", parentId: "desk" }, { id: "w1", parentId: "p" }, { id: "w2", parentId: "p" }, { id: "other" }],
    });
    const uri = h.store.writeResourceSync("w1", "job log", { source: "job:1" });
    expect(h.store.readResourceSync("w1", uri)).toBe("job log");
    expect(h.store.readResourceSync("p", uri)).toBe("job log"); // parent reads its child's report
    expect(h.store.readResourceSync("desk", uri)).toBe("job log");
    expect(h.store.readResourceSync("w2", uri, { offset: 4, limit: 3 })).toBe("log"); // a sibling checks the worker's log
    expect(h.store.readResourceSync("other", uri)).toBe("job log"); // another tree entirely
    const parentUri = h.store.writeResourceSync("p", "parent notes");
    expect(h.store.readResourceSync("w1", parentUri)).toBe("parent notes");
    h.cells.setStatus("w1", "closed");
    expect(h.store.readResourceSync("p", uri)).toBe("job log"); // a closed worker's output stays readable
    let caught: unknown;
    try {
      h.store.readResourceSync("w2", "res://w1/missing");
    } catch (e) {
      caught = e;
    }
    expect(isNgError(caught, "not_found")).toBe(true);
    expect(() => h.store.readResourceSync("w1", "ftp://x")).toThrow(/unsupported/);
  });

  it("serves artifact:// with an optional version to any cell", () => {
    const h = setup({ cells: [{ id: "desk" }, { id: "w", parentId: "desk" }, { id: "w2", parentId: "desk" }, { id: "other" }] });
    h.store.commitSync("w", { artifact: { artifactId: "a1", content: markdownDeliverable("first"), updatedBy: "agent" } });
    h.store.commitSync("w", { artifact: { artifactId: "a1", content: markdownDeliverable("second"), updatedBy: "agent", expectedVersion: 1 } });
    expect(h.store.readResourceSync("desk", "artifact://a1")).toBe("second");
    expect(h.store.readResourceSync("w", "artifact://a1@1")).toBe("first");
    expect(h.store.readResourceSync("w", "artifact://a1@2", { offset: 1, limit: 3 })).toBe("eco");
    expect(h.store.readResourceSync("w2", "artifact://a1@1")).toBe("first");
    expect(h.store.readResourceSync("other", "artifact://a1")).toBe("second");
    expect(() => h.store.readResourceSync("w", "artifact://a1@7")).toThrow(/no version 7/);
    let caught: unknown;
    try {
      h.store.readResourceSync("other", "artifact://missing");
    } catch (e) {
      caught = e;
    }
    expect(isNgError(caught, "not_found")).toBe(true);
  });

  it("lists evidence by run and after a seq", () => {
    const h = setup();
    const env = userEnvelope(h.clock, "hi");
    h.store.appendEvidenceSync("desk", { kind: "inbound", envelope: env, runId: "r1", at: 1 });
    const { seq } = h.store.appendEvidenceSync("desk", { kind: "assistant_text", text: "hello", runId: "r1", at: 2 });
    h.store.appendEvidenceSync("desk", { kind: "assistant_text", text: "again", runId: "r2", at: 3 });
    expect(h.store.listEvidenceSync("desk", { runId: "r1" }).map((e) => e.record.kind)).toEqual(["inbound", "assistant_text"]);
    expect(h.store.listEvidenceSync("desk", { afterSeq: seq }).map((e) => (e.record as { text: string }).text)).toEqual(["again"]);
    expect(h.store.listEvidenceSync("desk", { limit: 1 }).length).toBe(1);
  });
});
