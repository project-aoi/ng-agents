import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CELL_STATUS_KEY,
  get,
  makeBounds,
  mergeAdjacentMessages,
  steerNoteText,
  type ChildSummary,
  type Envelope,
  type KnowledgeApplies,
  type ModelMessage,
  type PromptSnapshot,
  type StepOrExternalEvidence,
} from "@ng/protocol";
import { FORK_PENDING_TEXT, NO_RESULT_TEXT, renderEnvelope } from "../src";
import { assertWireInvariants, batchOf, json, prng, setup, simulateRun, userEnvelope, type Harness } from "./helpers";

const deskBounds = makeBounds({ tools: ["read"], canSendTo: ["inbox:*"], maxConcurrentChildren: 3, maxDepth: 2 });

function deskHarness(extra: Parameters<typeof setup>[0] = {}): Harness {
  const h = setup({
    cells: [
      {
        id: "desk",
        preset: "inline",
        spec: { preset: "inline", processor: { kind: "llm", prompt: "desk", skills: ["triage"] } },
        bounds: deskBounds,
      },
    ],
    ...extra,
  });
  h.registry.prompts.register({ name: "desk", text: "You are the desk. Triage every inbound item." });
  h.registry.prompts.register({ name: "worker", text: "You are a worker. Fix the bug you are given." });
  return h;
}

const reply = (text: string) => (runId: string): StepOrExternalEvidence[] => [{ kind: "assistant_text", text, runId, at: 0 }];

function toolTurn(name: string, output: string, runId: string, id: string): StepOrExternalEvidence[] {
  return [
    { kind: "assistant_text", text: `calling ${name}`, runId, at: 0 },
    { kind: "tool_call", toolUseId: id, name, input: { q: id }, runId, at: 0 },
    { kind: "tool_result", toolUseId: id, name, output, runId, at: 0 },
    { kind: "assistant_text", text: "done", runId, at: 0 },
  ];
}

/** history(n) must be an element-wise, byte-identical prefix of history(n+1); the batch shows up right after it. */
function expectPrefixStable(prev: PromptSnapshot, next: PromptSnapshot): void {
  expect(next.system.text).toBe(prev.system.text);
  expect(next.system.hash).toBe(prev.system.hash);
  expect(next.history.length).toBeGreaterThanOrEqual(prev.history.length);
  for (let i = 0; i < prev.history.length; i++) expect(json(next.history[i])).toBe(json(prev.history[i]));
  const batchMsgs = prev.tail.messages.slice((prev.tail.roster.length > 0 ? 1 : 0) + (prev.tail.notes?.length ?? 0));
  for (let i = 0; i < batchMsgs.length; i++) expect(json(next.history[prev.history.length + i])).toBe(json(batchMsgs[i]));
  // What the provider sees: merged history(n) minus its last message is identical, and that last message is a block prefix.
  const a = mergeAdjacentMessages(prev.history.map(clone));
  const b = mergeAdjacentMessages(next.history.map(clone));
  for (let i = 0; i < a.length - 1; i++) expect(json(b[i])).toBe(json(a[i]));
  if (a.length > 0) {
    const last = a[a.length - 1]!;
    const peer = b[a.length - 1]!;
    expect(peer.role).toBe(last.role);
    expect(json(peer.content.slice(0, last.content.length))).toBe(json(last.content));
  }
}

const clone = (m: ModelMessage): ModelMessage => ({ role: m.role, content: [...m.content] });

describe("hydrate: frozen system prefix", () => {
  it("builds system from the registered prompt, skills index, inlined skills, bounds and preferences — without timestamps", () => {
    const h = deskHarness();
    h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: "triage", description: "分拣规则", body: "先判断是否零副作用", mode: "upsert" });
    h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: "weekly-review", description: "周回顾", body: "...", mode: "upsert" });
    h.store.upsertSkillOrNoteSync("desk", { kind: "preference", scope: "global", name: "language", description: "回复语言", body: "Always answer in Chinese.", mode: "upsert" });
    const snap = h.store.hydrateSync("desk", batchOf("desk", [userEnvelope(h.clock, "hi")]), "isolated");
    expect(snap.system.text).toBe(
      [
        "You are the desk. Triage every inbound item.",
        '# Skills\nPlaybooks you can load on demand. Before doing one of these kinds of task, read its full instructions with read_resource("skill://<name>").\n- weekly-review: 周回顾',
        "# Skill: triage\n先判断是否零副作用",
        "# Your bounds\nTools: read.\nMay send to: inbox:*.\nIsolation: none.\nChildren: up to 3 concurrent, 2 more level(s) of spawning.",
        "# Long-term preferences\n- language: Always answer in Chinese.",
      ].join("\n\n"),
    );
    expect(snap.system.text).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(snap.skills.map((s) => s.name)).toEqual(["weekly-review"]);
    expect(snap).toMatchObject({ cellId: "desk", epoch: 0, runId: snap.batch.claimId, mode: "isolated", historyUptoSeq: 0, history: [] });
    expect(snap.spec.processor).toMatchObject({ prompt: "desk" });
    expect(snap.bounds.maxDepth).toBe(2);
  });

  it("caps the skills index", () => {
    const h = deskHarness({ store: { limits: { skillIndexMaxLines: 3 } } });
    for (const n of ["a", "b", "c", "d", "e"]) {
      h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: `skill-${n}`, description: n, body: n, mode: "upsert" });
    }
    const snap = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
    expect(snap.system.text).toContain("- skill-a: a\n- skill-b: b\n- … 3 more skills");
    expect(snap.skills.length).toBe(2);
  });

  it("does not list an inlined skill again as one to read on demand; with nothing else left there is no index", () => {
    const h = deskHarness();
    h.cells.insert({ id: "p", parentId: "desk", preset: "project", spec: { preset: "project", processor: { kind: "llm", prompt: "worker", skills: ["project-relay", "ghost"] } } });
    h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: "project-relay", description: "接力", body: "1. 派 worker", mode: "upsert" });
    const p = h.store.hydrateSync("p", batchOf("p", []), "isolated");
    expect(p.system.text).not.toContain("# Skills");
    expect(p.system.text).not.toContain("skill://");
    expect(p.system.text).toContain("# Skill: project-relay\n1. 派 worker");
    expect(p.system.text).toContain("# Skill: ghost\n(this skill is not installed)");
    expect(p.skills).toEqual([]);

    // Another skill installed later shows up in the index on refresh; the inlined one still does not.
    h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: "weekly-review", description: "周回顾", body: "...", mode: "upsert" });
    h.store.refreshPrefixSync("p");
    const p2 = h.store.hydrateSync("p", batchOf("p", []), "isolated");
    expect(p2.system.text).toContain("# Skills\n");
    expect(p2.skills.map((s) => s.name)).toEqual(["weekly-review"]);
    expect(p2.system.text.match(/project-relay/g)).toHaveLength(1);
    // The desk inlines only triage: project-relay stays in its index.
    const desk = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
    expect(desk.skills.map((s) => s.name)).toEqual(["project-relay", "weekly-review"]);
  });

  it("stays byte-identical while skills, preferences and the spec change, until refreshPrefix", () => {
    const h = deskHarness();
    const s1 = simulateRun(h, "desk", [userEnvelope(h.clock, "记一下：周五约牙医")], reply("已记录"));
    h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: "new-skill", description: "新技能", body: "x", mode: "upsert" });
    h.store.upsertSkillOrNoteSync("desk", { kind: "preference", scope: "global", name: "tone", description: "语气", body: "简洁", mode: "upsert" });
    h.cells.update("desk", { bounds: makeBounds({ tools: ["read", "write"], maxDepth: 1 }) });
    const s2 = simulateRun(h, "desk", [userEnvelope(h.clock, "还有，提醒我周四买花")], reply("好的"));
    const s3 = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
    expectPrefixStable(s1, s2);
    expectPrefixStable(s2, s3);
    expect(s3.system.text).not.toContain("new-skill");

    h.store.refreshPrefixSync("desk");
    const s4 = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
    expect(s4.system.text).toContain("- new-skill: 新技能");
    expect(s4.system.text).toContain("- tone: 简洁");
    expect(s4.system.text).toContain("Tools: read, write.");
    expect(s4.system.hash).not.toBe(s3.system.hash);
    expect(json(s4.history)).toBe(json(s3.history));
  });

  it("code processors get an empty prompt; a named prompt without a registry is an error", () => {
    const h = setup({ cells: [{ id: "sensor", spec: { processor: { kind: "code", entry: "check" } } }, { id: "llm", spec: { processor: { kind: "llm", prompt: "x" } } }] });
    const snap = h.store.hydrateSync("sensor", batchOf("sensor", []), "isolated");
    expect(snap.system.text.startsWith("# Your bounds")).toBe(true);
    const noRegistry = h.makeStore({ registry: undefined });
    expect(() => noRegistry.hydrateSync("llm", batchOf("llm", []), "isolated")).toThrow(/no registry/);
    expect(() => h.store.hydrateSync("llm", batchOf("llm", []), "isolated")).toThrow(/not registered/);
    const custom = h.makeStore({ resolvePrompt: (spec, cell) => `custom prompt for ${cell.id} (${spec.processor.kind})` });
    expect(custom.hydrateSync("llm", batchOf("llm", []), "isolated").system.text).toMatch(/^custom prompt for llm \(llm\)/);
  });

  it("rejects a batch for another cell", () => {
    const h = deskHarness();
    expect(() => h.store.hydrateSync("desk", batchOf("other", []), "isolated")).toThrow(/batch belongs/);
  });
});

describe("hydrate: preferences limited to a directory or a role", () => {
  const code = { kind: "code", entry: "noop" } as const;

  function scoped(): Harness & { pref(name: string, applies?: KnowledgeApplies): void; prefsOf(id: string): string[] } {
    const h = setup({
      cells: [
        { id: "desk", preset: "inline", spec: { preset: "inline", processor: code, meta: { role: "desk" } } },
        { id: "p", parentId: "desk", preset: "project", spec: { preset: "project", cwd: "/work/trae-x", processor: code, meta: { role: "project" } } },
        { id: "w", parentId: "p", preset: "worker", spec: { preset: "worker", cwd: "/work/trae-x/crates/core", processor: code, meta: { role: "worker" } } },
        { id: "w-old", parentId: "desk", preset: "worker", spec: { preset: "worker", cwd: "/work/trae-x-old", processor: code, meta: { role: "worker" } } },
        { id: "chk", parentId: "p", preset: "checker", spec: { preset: "checker", cwd: "/work/trae-x", processor: code, meta: { role: "checker" } } },
      ],
    });
    return {
      ...h,
      pref(name, applies) {
        h.store.upsertSkillOrNoteSync("desk", { kind: "preference", scope: "global", name, description: name, body: `rule ${name}`, mode: "upsert", ...(applies ? { applies } : {}) });
      },
      prefsOf(id) {
        h.store.refreshPrefixSync(id);
        const text = h.store.hydrateSync(id, batchOf(id, []), "isolated").system.text;
        return [...text.matchAll(/^- ([\w-]+): rule /gm)].map((m) => m[1]!);
      },
    };
  }

  it("shows a preference only to the cells inside its directory and of its roles; unlimited ones to every cell", () => {
    const h = scoped();
    h.pref("language");
    h.pref("rust-commit-gate", { cwdPrefix: "/work/trae-x", roles: ["worker"] });
    h.pref("repo-notes", { cwdPrefix: "/work/trae-x/" });
    h.pref("report-format", { roles: ["project"] });
    h.pref("quiet-watch", { roles: ["checker"] });
    expect(h.prefsOf("desk")).toEqual(["language"]);
    expect(h.prefsOf("p")).toEqual(["language", "repo-notes", "report-format"]);
    expect(h.prefsOf("w")).toEqual(["language", "repo-notes", "rust-commit-gate"]);
    // a sibling directory that only shares the name's beginning is outside
    expect(h.prefsOf("w-old")).toEqual(["language"]);
    expect(h.prefsOf("chk")).toEqual(["language", "quiet-watch", "repo-notes"]);
    h.pref("quiet-watch", { roles: ["checker", "inline"] });
    expect(h.prefsOf("chk")).toEqual(["language", "quiet-watch", "repo-notes"]);
    expect(h.prefsOf("desk")).toEqual(["language", "quiet-watch"]);
    // a filtered-out preference leaves no trace in that cell's prompt
    const deskText = h.store.hydrateSync("desk", batchOf("desk", []), "isolated").system.text;
    expect(deskText).not.toContain("rust-commit-gate");
    expect(deskText).not.toContain("trae-x");
  });

  it("stores the directory expanded and normalized, and changing a preference's reach takes effect on refresh", () => {
    const h = scoped();
    h.pref("home-code", { cwdPrefix: "~/code/", roles: [" Worker ", "worker"] });
    expect(h.store.getKnowledgeSync({ kind: "preference", scope: "global", name: "home-code" })?.applies).toEqual({ cwdPrefix: join(homedir(), "code"), roles: ["worker"] });
    h.cells.update("w", { spec: { preset: "worker", cwd: join(homedir(), "code", "app"), processor: code, meta: { role: "worker" } } });
    expect(h.prefsOf("w")).toEqual(["home-code"]);

    h.pref("gate", { cwdPrefix: "/work/trae-x", roles: ["worker"] });
    expect([h.prefsOf("p"), h.prefsOf("w-old")]).toEqual([[], []]);
    h.pref("gate", { roles: ["project"] });
    expect([h.prefsOf("p"), h.prefsOf("w-old")]).toEqual([["gate"], []]);
    // append keeps the reach unless given
    h.store.upsertSkillOrNoteSync("desk", { kind: "preference", scope: "global", name: "gate", body: "rule more", mode: "append" });
    expect(h.store.getKnowledgeSync({ kind: "preference", scope: "global", name: "gate" })).toMatchObject({ body: "rule gate\nrule more", applies: { roles: ["project"] } });
    h.store.upsertSkillOrNoteSync("desk", { kind: "preference", scope: "global", name: "gate", body: "rule last", mode: "append", applies: { roles: ["worker"] } });
    expect([h.prefsOf("p"), h.prefsOf("w-old")]).toEqual([[], ["gate"]]);
    // saved again without a reach: every cell
    h.pref("gate");
    expect(h.store.getKnowledgeSync({ kind: "preference", scope: "global", name: "gate" })).not.toHaveProperty("applies");
    expect([h.prefsOf("p"), h.prefsOf("w-old"), h.prefsOf("desk")]).toEqual([["gate"], ["gate"], ["gate"]]);
  });

  it("a fork_prefix child whose preferences differ from its parent's gets its own list in the fork note", () => {
    const h = scoped();
    h.pref("language");
    h.cells.insert({
      id: "fp",
      parentId: "desk",
      preset: "project",
      spec: { preset: "project", cwd: "/work/trae-x", contextMode: "fork_prefix", fork: { fromCellId: "desk", uptoSeq: 0 }, processor: code, meta: { role: "project" } },
    });
    const noteOf = (id: string) => {
      h.store.refreshPrefixSync(id);
      const s = h.store.hydrateSync(id, batchOf(id, []), "fork_prefix");
      return (s.history.at(-1)!.content[0] as { text: string }).text;
    };
    // same preferences as the desk: nothing repeated
    expect(noteOf("fp")).not.toContain("preferences");
    h.pref("repo-notes", { cwdPrefix: "/work/trae-x" });
    const note = noteOf("fp");
    expect(note).toContain('## Long-term preferences\n- language: rule language\n- repo-notes: rule repo-notes\nThese replace the long-term preferences in the system prompt above, which were cell "desk"\'s.');
    expect(h.store.hydrateSync("fp", batchOf("fp", []), "fork_prefix").system.text).not.toContain("repo-notes");
    // the other way round: the desk's only preference does not apply to the child
    h.pref("language", { roles: ["desk"] });
    h.pref("repo-notes", { cwdPrefix: "/elsewhere" });
    expect(noteOf("fp")).toContain('## Long-term preferences\nThe long-term preferences in the system prompt above were cell "desk"\'s; none of them apply to you.');
  });
});

describe("hydrate: history and tail", () => {
  it("renders the batch in the tail exactly as its inbound evidence renders in the next history", () => {
    const h = deskHarness();
    const env: Envelope = userEnvelope(h.clock, "帮我回一下供应商", { threads: ["memory:oc_1"], from: "channel:memory:oc_1", principalId: "owner" });
    const silent = userEnvelope(h.clock, "背景：上周已付定金", { delivery: "silent_inject" });
    const s1 = simulateRun(h, "desk", [env, silent], reply("好的"));
    expect(s1.tail.messages.map((m) => (m.content[0] as { text: string }).text)).toEqual([renderEnvelope(env), renderEnvelope(silent)]);
    // A user.message from a channel carries its envelope id after the time, so it can be handed back or answered by id.
    expect(renderEnvelope(env)).toBe(
      `[user.message · from channel:memory:oc_1 · principal owner · thread memory:oc_1 · at 2025-11-17T08:00:00.000Z · id ${env.id}]\n帮我回一下供应商`,
    );
    expect(renderEnvelope(silent)).toContain("· background ·");
    expect(renderEnvelope(silent)).toMatch(new RegExp(`· at [^·\\]]+ · id ${silent.id}\\]\\n背景：上周已付定金$`));
    // Only a message from outside (a channel) carries the id; one relayed by a cell does not.
    const relayed = userEnvelope(h.clock, "转述", { from: "inbox:w1" });
    expect(renderEnvelope(relayed)).not.toContain(relayed.id);
    expect(renderEnvelope(relayed)).toMatch(/· at [^·\]]+\]\n转述$/);
    const s2 = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
    expectPrefixStable(s1, s2);
    expect(s2.history.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(s2.historyUptoSeq).toBe(h.store.lastEvidenceSeqSync("desk"));
  });

  it("puts the in-flight children roster in the volatile tail only", () => {
    const h = deskHarness();
    h.cells.insert({ id: "w1", parentId: "desk", preset: "worker", title: "竞品资料整理" });
    h.cells.insert({ id: "w2", parentId: "desk", preset: "checker", title: "等报价" });
    h.cells.insert({ id: "done", parentId: "desk", status: "closed" });
    h.store.commitSync("w1", { statePatches: { [CELL_STATUS_KEY]: { text: "正在并发整理竞品资料", at: 1, progress: { done: 11, total: 15 } } } });
    const s1 = simulateRun(h, "desk", [userEnvelope(h.clock, "进度如何？")], reply("11/15"));
    expect(s1.tail.roster.map((c) => [c.cellId, c.statusLine])).toEqual([
      ["w1", "正在并发整理竞品资料 (11/15)"],
      ["w2", null],
    ]);
    expect((s1.tail.messages[0]!.content[0] as { text: string }).text).toBe(
      '[in-flight child cells: live status, not part of the conversation]\n- w1 · "竞品资料整理" · worker · active: 正在并发整理竞品资料 (11/15)\n- w2 · "等报价" · checker · active',
    );
    h.store.commitSync("w1", { statePatches: { [CELL_STATUS_KEY]: { text: "整理完毕", at: 2 } } });
    const s2 = simulateRun(h, "desk", [userEnvelope(h.clock, "现在呢？")], reply("done"));
    expectPrefixStable(s1, s2);
    expect(json(s2.history)).not.toContain("in-flight child cells");
    const custom = h.makeStore({ rosterProvider: () => [] });
    expect(custom.hydrateSync("desk", batchOf("desk", []), "isolated").tail.messages).toEqual([]);
  });

  it("renders each descendant at its depth with its working directory", () => {
    const base: Omit<ChildSummary, "cellId"> = { title: null, preset: "worker", status: "active", epoch: 0, lastRunAt: null, statusLine: null };
    const h = deskHarness({
      store: {
        rosterProvider: () => [
          { ...base, cellId: "proj", preset: "project", title: "Harness 对比", depth: 1, parentId: "desk", cwd: "/src/trae" },
          { ...base, cellId: "w1", depth: 2, parentId: "proj", cwd: "/src/trae/docs", statusLine: "写报告 (1/3)" },
          { ...base, cellId: "w1a", preset: null, depth: 3, parentId: "w1" },
          { ...base, cellId: "watch", preset: "checker", status: "paused", depth: 1, cwd: "/tmp/probe" },
          { ...base, cellId: "plain" },
        ],
      },
    });
    const snap = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
    expect((snap.tail.messages[0]!.content[0] as { text: string }).text).toBe(
      [
        "[in-flight child cells: live status, not part of the conversation]",
        '- proj · "Harness 对比" · project · active · cwd /src/trae',
        "  - w1 · worker · active · cwd /src/trae/docs: 写报告 (1/3)",
        "    - w1a · active",
        "- watch · checker · paused · cwd /tmp/probe",
        "- plain · worker · active",
      ].join("\n"),
    );
    expect(snap.tail.roster.map((c) => c.depth)).toEqual([1, 2, 3, 1, undefined]);
  });

  it("puts the kernel's tail notes verbatim after the roster and before the batch, never into history", () => {
    let notes: string[] = ["[active workspace] /src/trae (read) · /src/doubao (write)", "", "  \n", "[waiting] inbox:w1 since 10:00"];
    const h = deskHarness({ store: { tailNotesProvider: () => notes } });
    h.cells.insert({ id: "w1", parentId: "desk", preset: "worker", title: "竞品资料整理" });
    const env = userEnvelope(h.clock, "进度如何？");
    const s1 = simulateRun(h, "desk", [env], reply("还在等 w1"));
    const texts = s1.tail.messages.map((m) => (m.content[0] as { text: string }).text);
    expect(texts.slice(1)).toEqual([notes[0], notes[3], renderEnvelope(env)]);
    expect(texts[0]).toContain("in-flight child cells");
    expect(s1.tail.notes).toEqual([notes[0], notes[3]]);
    expect(s1.tail.messages.every((m) => m.role === "user")).toBe(true);

    notes = ["[waiting] nothing"];
    const s2 = simulateRun(h, "desk", [userEnvelope(h.clock, "现在呢？")], reply("ok"));
    expectPrefixStable(s1, s2);
    expect(json(s2.history)).not.toContain("[active workspace]");
    expect(json(s2.history)).not.toContain("[waiting]");
    expect(s2.tail.notes).toEqual(["[waiting] nothing"]);
    expect(assertWireInvariants([...s2.history, ...s2.tail.messages])).toEqual([]);

    // No provider, or nothing to say: no field and no messages.
    notes = ["", " "];
    expect("notes" in h.store.hydrateSync("desk", batchOf("desk", []), "isolated").tail).toBe(false);
    const bare = h.makeStore({ tailNotesProvider: undefined, rosterProvider: () => [] }).hydrateSync("desk", batchOf("desk", []), "isolated");
    expect(bare.tail).toEqual({ roster: [], messages: [] });
  });

  it("answers tool calls of a crashed run with a synthetic error at a position that never moves", () => {
    const h = deskHarness();
    const s1 = simulateRun(
      h,
      "desk",
      [userEnvelope(h.clock, "跑一下测试")],
      (runId) => [
        { kind: "tool_call", toolUseId: "a", name: "bash", input: {}, runId, at: 0 },
        { kind: "tool_call", toolUseId: "b", name: "read", input: {}, runId, at: 0 },
        { kind: "tool_result", toolUseId: "b", name: "read", output: "file", runId, at: 0 },
      ],
      { crash: true },
    );
    const next = batchOf("desk", [userEnvelope(h.clock, "怎么样了")]);
    const s2 = h.store.hydrateSync("desk", next, "isolated");
    const synthetic = s2.history.at(-1)!;
    expect(synthetic).toEqual({ role: "user", content: [{ type: "tool_result", toolUseId: "a", content: NO_RESULT_TEXT, isError: true }] });
    expect(assertWireInvariants([...s2.history, ...s2.tail.messages])).toEqual([]);
    // The kernel starts the next run; a late result for the closed call then becomes plain text instead of moving
    // the synthetic one.
    h.store.appendEvidenceSync("desk", { kind: "run_boundary", phase: "start", epoch: 0, runId: next.claimId, at: 0 });
    h.store.appendEvidenceSync("desk", { kind: "inbound", envelope: next.envelopes[0]!, runId: next.claimId, at: 0 });
    h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "a", name: "bash", output: "late", runId: s1.runId, at: 0 });
    const s3 = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
    expectPrefixStable(s2, s3);
    expect((s3.history.at(-1)!.content[0] as { text: string }).text).toBe("[tool result · bash · a]\nlate");
    expect(assertWireInvariants(s3.history)).toEqual([]);
  });

  it("renders steer notes verbatim and keeps alternation valid", () => {
    const h = deskHarness();
    simulateRun(h, "desk", [userEnvelope(h.clock, "调研竞品")], (runId) => [
      ...toolTurn("search", "results", runId, "t1"),
      { kind: "system_note", text: steerNoteText("只看国内的"), runId, at: 0 },
      { kind: "assistant_text", text: "好的，只看国内", runId, at: 0 },
    ]);
    const s = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
    expect(s.history.some((m) => m.content.some((b) => b.type === "text" && b.text === "[steer from the user while you were working] 只看国内的"))).toBe(true);
    expect(assertWireInvariants(s.history)).toEqual([]);
  });

  it("property: across many randomised runs, system and earlier history are byte-identical and the wire stays valid", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = prng(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
      const h = deskHarness({ store: { limits: { inlineChars: 300, spillHeadChars: 150, spillTailChars: 50 } } });
      h.cells.insert({ id: `kid${seed}`, parentId: "desk", preset: "worker" });
      let prev: PromptSnapshot | null = null;
      let toolSeq = 0;
      for (let n = 0; n < 12; n++) {
        // Things that happen between runs and must not disturb the prefix.
        if (rnd() < 0.3) h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: `s-${n}`, description: `d${n}`, body: "b", mode: "upsert" });
        if (rnd() < 0.3) h.store.upsertSkillOrNoteSync("desk", { kind: "preference", scope: "global", name: `p-${n}`, description: "d", body: `pref ${n}`, mode: "upsert" });
        if (rnd() < 0.3) h.store.commitSync(`kid${seed}`, { statePatches: { [CELL_STATUS_KEY]: { text: `step ${n}`, at: n } } });
        if (rnd() < 0.2) h.store.appendEvidenceSync("desk", { kind: "external", source: "sensor", text: `observed ${n} ${"z".repeat(Math.floor(rnd() * 600))}`, runId: null, at: n });
        if (rnd() < 0.15) h.store.appendEvidenceSync("desk", { kind: "system_note", text: `note ${n}`, runId: null, at: n });

        const envs = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) =>
          userEnvelope(h.clock, `msg ${n}.${i}`, rnd() < 0.3 ? { type: "cell.progress", payload: { childCellId: "k", text: "2/3", progress: { done: 2, total: 3 } }, kind: "result" } : {}),
        );
        const crash = rnd() < 0.15;
        const snap = simulateRun(
          h,
          "desk",
          envs,
          (runId) => {
            const out: StepOrExternalEvidence[] = [];
            const steps = Math.floor(rnd() * 4);
            for (let s = 0; s < steps; s++) {
              if (rnd() < 0.5) out.push({ kind: "assistant_text", text: `thinking ${n}.${s}`, runId, at: 0 });
              const calls = Math.floor(rnd() * 3);
              const ids = Array.from({ length: calls }, () => `tu${++toolSeq}`);
              for (const id of ids) out.push({ kind: "tool_call", toolUseId: id, name: pick(["bash", "read", "search_history"]), input: { id, n: [1, 2] }, runId, at: 0 });
              for (const id of ids) {
                if (crash && rnd() < 0.5) continue;
                out.push({ kind: "tool_result", toolUseId: id, name: "bash", output: rnd() < 0.2 ? "y".repeat(700) : `out ${id}`, isError: rnd() < 0.1, runId, at: 0 });
              }
              if (rnd() < 0.2) out.push({ kind: "system_note", text: steerNoteText(`steer ${n}`), runId, at: 0 });
            }
            if (rnd() < 0.7) out.push({ kind: "assistant_text", text: `answer ${n}`, runId, at: 0 });
            return out;
          },
          { crash },
        );
        const problems = assertWireInvariants([...snap.history, ...snap.tail.messages]);
        expect(problems, `seed ${seed} run ${n}`).toEqual([]);
        if (prev) expectPrefixStable(prev, snap);
        prev = snap;
      }
      const last = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
      expectPrefixStable(prev!, last);
      expect(assertWireInvariants(last.history)).toEqual([]);
    }
  });
});

describe("hydrate: fork_prefix", () => {
  function forkScenario() {
    const h = deskHarness();
    simulateRun(h, "desk", [userEnvelope(h.clock, "支付回调偶尔报签名错误")], (runId) => toolTurn("read", "callback.ts 内容", runId, "r1"));
    // Run 2: discussing the bug, the desk spawns a worker with the hot context.
    const batch = batchOf("desk", [userEnvelope(h.clock, "就按刚才的思路修吧")]);
    const parentSnap = h.store.hydrateSync("desk", batch, "isolated");
    const runId = batch.claimId;
    h.store.appendEvidenceSync("desk", { kind: "run_boundary", phase: "start", epoch: 0, runId, at: 1 });
    h.store.appendEvidenceSync("desk", { kind: "inbound", envelope: batch.envelopes[0]!, runId, at: 1 });
    h.store.appendEvidenceSync("desk", { kind: "assistant_text", text: "我派一个分身去修", runId, at: 2 });
    h.store.appendEvidenceSync("desk", { kind: "tool_call", toolUseId: "spawn1", name: "spawn_cell", input: { preset: "worker" }, runId, at: 3 });
    const uptoSeq = h.store.lastEvidenceSeqSync("desk");
    h.cells.insert({
      id: "fixer",
      parentId: "desk",
      preset: "worker",
      title: "修支付回调",
      spec: { preset: "worker", contextMode: "fork_prefix", fork: { fromCellId: "desk", uptoSeq }, processor: { kind: "llm", prompt: "worker" } },
      bounds: makeBounds({ tools: ["read", "edit", "bash"], canSendTo: ["inbox:desk"], isolation: "none" }),
    });
    h.store.appendEvidenceSync("desk", { kind: "tool_result", toolUseId: "spawn1", name: "spawn_cell", output: "inbox:fixer", runId, at: 4 });
    h.store.appendEvidenceSync("desk", { kind: "run_boundary", phase: "end", epoch: 0, outcome: "completed", runId, at: 5 });
    return { h, parentSnap, uptoSeq };
  }

  it("the child's prefix equals the parent's: same system bytes, parent's history up to the fork point, then a fork note", () => {
    const { h, parentSnap } = forkScenario();
    const task = { from: "kernel:spawn", principalId: "cell:desk", kind: "event", type: "cell.task", payload: { parentCellId: "desk", instruction: "修复签名校验" } } as const;
    const childBatch = batchOf("fixer", [userEnvelope(h.clock, "", task)]);
    const child = h.store.hydrateSync("fixer", childBatch, "fork_prefix");

    expect(child.system.text).toBe(parentSnap.system.text);
    expect(child.system.hash).not.toBe(parentSnap.system.hash);
    for (let i = 0; i < parentSnap.history.length; i++) expect(json(child.history[i])).toBe(json(parentSnap.history[i]));

    // Then the parent's in-flight run up to the spawn call (as the parent's own next history renders it)…
    const parentNext = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
    const k = parentSnap.history.length;
    for (let i = k; i < k + 3; i++) expect(json(child.history[i])).toBe(json(parentNext.history[i]));
    // …the spawn call answered for the child, and the fork note naming it, its instructions and bounds.
    expect(child.history[k + 3]).toEqual({ role: "user", content: [{ type: "tool_result", toolUseId: "spawn1", content: FORK_PENDING_TEXT }] });
    const note = (child.history[k + 4]!.content[0] as { text: string }).text;
    expect(note).toMatch(/^\[fork\] Everything above is the context of cell "desk"/);
    expect(note).toContain('You are now cell "fixer" ("修支付回调"), a worker cell');
    expect(note).toContain("## Your instructions\nYou are a worker. Fix the bug you are given.");
    expect(note).toContain("Tools: bash, edit, read.");
    expect(child.history.length).toBe(k + 5);
    expect(child.skills).toEqual(parentSnap.skills);
    expect(assertWireInvariants([...child.history, ...child.tail.messages])).toEqual([]);
  });

  it("the child's prefix stays stable across its own runs, even when the parent moves on", () => {
    const { h } = forkScenario();
    const c1 = simulateRun(h, "fixer", [userEnvelope(h.clock, "开始")], (r) => toolTurn("edit", "patched", r, "e1"), { mode: "fork_prefix" });
    simulateRun(h, "desk", [userEnvelope(h.clock, "顺便看看别的")], reply("ok"));
    h.store.refreshPrefixSync("desk");
    h.store.upsertSkillOrNoteSync("desk", { kind: "skill", scope: "global", name: "late", description: "x", body: "x", mode: "upsert" });
    const c2 = simulateRun(h, "fixer", [userEnvelope(h.clock, "继续")], reply("测试通过"), { mode: "fork_prefix" });
    expectPrefixStable(c1, c2);
    expect(c2.historyUptoSeq).toBeGreaterThan(c1.historyUptoSeq);
    expect(h.store.lastEvidenceSeqSync("fixer")).toBe(h.store.listEvidenceSync("fixer").at(-1)!.seq);
  });

  it("a grandchild forked from a forked child with no own records inherits through it", () => {
    const { h } = forkScenario();
    const upto = h.store.lastEvidenceSeqSync("fixer"); // no own evidence yet → the inherited fork point
    expect(upto).toBeGreaterThan(0);
    h.cells.insert({
      id: "gc",
      parentId: "fixer",
      spec: { contextMode: "fork_prefix", fork: { fromCellId: "fixer", uptoSeq: upto }, processor: { kind: "llm" } },
    });
    const fixer = h.store.hydrateSync("fixer", batchOf("fixer", []), "fork_prefix");
    const gc = h.store.hydrateSync("gc", batchOf("gc", []), "fork_prefix");
    expect(gc.system.text).toBe(fixer.system.text);
    for (let i = 0; i < fixer.history.length; i++) expect(json(gc.history[i])).toBe(json(fixer.history[i]));
    expect((gc.history.at(-1)!.content[0] as { text: string }).text).toContain('You are now cell "gc"');
  });

  it("isolated children start empty with their own system", () => {
    const { h } = forkScenario();
    h.cells.insert({ id: "iso", parentId: "desk", spec: { contextMode: "isolated", processor: { kind: "llm", prompt: "worker" } } });
    const s = h.store.hydrateSync("iso", batchOf("iso", [userEnvelope(h.clock, "task")]), "isolated");
    expect(s.history).toEqual([]);
    expect(s.system.text.startsWith("You are a worker.")).toBe(true);
    // fork_prefix requested without a recorded fork point behaves like isolated
    const s2 = h.store.hydrateSync("iso", batchOf("iso", []), "fork_prefix");
    expect(s2.history).toEqual([]);
  });
});

describe("hydrate: compaction", () => {
  const limits = { compactAtChars: 3000, keepRecentChars: 1000, summaryMaxChars: 600, inlineChars: 400, spillHeadChars: 200, spillTailChars: 100 };

  function compactions(h: Harness, cellId = "desk"): number {
    return get<{ c: number }>(h.db, "SELECT compactions AS c FROM prompt_prefixes WHERE cell_id = ?", [cellId])?.c ?? 0;
  }

  it("folds older turns into one summary at a run boundary, in big steps, keeping the prefix stable in between", () => {
    const h = deskHarness({ store: { limits } });
    let prev: PromptSnapshot | null = null;
    const boundaries: number[] = [];
    for (let n = 0; n < 40; n++) {
      const before = compactions(h);
      const snap = simulateRun(h, "desk", [userEnvelope(h.clock, `第 ${n} 条消息 ${"内容".repeat(40)}`)], (r) => toolTurn("bash", `output ${n} ${"x".repeat(150)}`, r, `t${n}`));
      expect(assertWireInvariants([...snap.history, ...snap.tail.messages]), `run ${n}`).toEqual([]);
      const size = json(snap.history).length;
      expect(size).toBeLessThan(limits.compactAtChars * 3);
      if (compactions(h) > before) {
        boundaries.push(n);
        expect((snap.history[0]!.content[0] as { text: string }).text).toMatch(/^\[summary of the earlier conversation: older turns \(evidence up to #\d+\) were compacted/);
        // The first kept record is the start of a turn: the inbound that opened it.
        expect((snap.history[1]!.content[0] as { text: string }).text).toMatch(/^\[user\.message/);
      } else if (prev) {
        expectPrefixStable(prev, snap);
      }
      prev = snap;
    }
    expect(boundaries.length).toBeGreaterThanOrEqual(2);
    // The boundary moves in big steps: several runs between compactions.
    for (let i = 1; i < boundaries.length; i++) expect(boundaries[i]! - boundaries[i - 1]!).toBeGreaterThanOrEqual(3);
    const summary = get<{ summary: string }>(h.db, "SELECT summary FROM prompt_prefixes WHERE cell_id = 'desk'")!.summary;
    expect(summary.length).toBeLessThanOrEqual(limits.summaryMaxChars);
    expect(summary).toContain("assistant called bash");
  });

  it("uses an injected async summariser on the async path only", async () => {
    const calls: number[] = [];
    const h = deskHarness({
      store: {
        limits,
        summarize: async (input) => {
          calls.push(input.messages.length);
          return `LLM summary of ${input.messages.length} messages (prev: ${input.previousSummary === null ? "none" : "yes"})`;
        },
      },
    });
    for (let n = 0; n < 12; n++) simulateRun(h, "desk", [userEnvelope(h.clock, `m${n} ${"长".repeat(200)}`)], reply(`r${n} ${"答".repeat(100)}`));
    // hydrateSync never calls an injected summariser, so nothing is compacted yet.
    expect(compactions(h)).toBe(0);
    expect(calls).toEqual([]);
    const snap = await h.store.hydrate("desk", batchOf("desk", [userEnvelope(h.clock, "next")]), "isolated");
    expect(calls.length).toBe(1);
    expect((snap.history[0]!.content[0] as { text: string }).text).toContain("LLM summary of");
    expect(compactions(h)).toBe(1);
    // A second async hydrate right after does not compact again.
    const snap2 = await h.store.hydrate("desk", batchOf("desk", []), "isolated");
    expect(calls.length).toBe(1);
    expect(json(snap2.history)).toBe(json(snap.history));
  });

  it("a failing summariser does not block the run; an explicit compact() reports it", async () => {
    const h = deskHarness({
      store: {
        limits,
        summarize: async () => {
          throw new Error("model unavailable");
        },
      },
    });
    for (let n = 0; n < 12; n++) simulateRun(h, "desk", [userEnvelope(h.clock, `m${n} ${"长".repeat(200)}`)], reply("ok"));
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const snap = await h.store.hydrate("desk", batchOf("desk", []), "isolated");
      expect((snap.history[0]!.content[0] as { text: string }).text).toMatch(/^\[user\.message/);
    } finally {
      console.error = original;
    }
    expect(errors.length).toBe(1);
    expect(compactions(h)).toBe(0);
    await expect(h.store.compact("desk")).rejects.toThrow("model unavailable");
  });

  it("compact() can be forced, and a forked child compacts into its own system", async () => {
    const h = deskHarness();
    simulateRun(h, "desk", [userEnvelope(h.clock, "a")], reply("b"));
    h.cells.insert({
      id: "kid",
      parentId: "desk",
      spec: { contextMode: "fork_prefix", fork: { fromCellId: "desk", uptoSeq: h.store.lastEvidenceSeqSync("desk") }, processor: { kind: "llm", prompt: "worker" } },
    });
    const before = h.store.hydrateSync("kid", batchOf("kid", []), "fork_prefix");
    expect(before.system.text.startsWith("You are the desk.")).toBe(true);
    simulateRun(h, "kid", [userEnvelope(h.clock, "go")], reply("went"), { mode: "fork_prefix" });
    expect(await h.store.compact("kid")).toBeNull(); // under budget
    const r = await h.store.compact("kid", { force: true });
    expect(r).toMatchObject({ cellId: "kid", compactions: 1 });
    const after = h.store.hydrateSync("kid", batchOf("kid", []), "fork_prefix");
    expect(after.system.text.startsWith("You are a worker.")).toBe(true);
    const forkPoint = h.cells.require("kid").spec.fork!.uptoSeq;
    expect((after.history[0]!.content[0] as { text: string }).text).toMatch(
      new RegExp(`^\\[summary of the earlier conversation: older turns \\(evidence up to #${forkPoint}\\)`),
    );
    // The inherited messages and the fork note are folded into the summary; the child's own run follows verbatim.
    expect(after.history.slice(1).some((m) => m.content.some((b) => b.type === "text" && b.text.startsWith("[fork]")))).toBe(false);
    expect(after.history.slice(1).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(assertWireInvariants(after.history)).toEqual([]);
  });
});

it("preserves the original assignment through repeated compactions of a large turn", async () => {
  const h=deskHarness({store:{limits:{compactAtChars:1800,keepRecentChars:500,summaryMaxChars:700}}});
  const task={...userEnvelope(h.clock,""),type:"cell.task",payload:{parentCellId:"lead",instruction:"check\n   release",artifactId:"art_release"}};
  simulateRun(h,"desk",[task],reply("x".repeat(2500)+"last work"));
  for(let i=0;i<2;i++) {
    await h.store.compact("desk",{force:true});
    const snap=h.store.hydrateSync("desk",batchOf("desk",[]),"isolated");
    expect(json(snap.history)).toContain("check release");
    expect(json(snap.history)).toContain("lead");
    expect(json(snap.tail.messages)).toContain("[original task]");
    expect(get<{summary:string}>(h.db, "SELECT summary FROM prompt_prefixes WHERE cell_id = 'desk'")!.summary.length).toBeLessThanOrEqual(700);
    if (i===0) expect(json(snap.history)).toMatch(/\[latest work\].*last work/);
  }
});

it("compacts a large multi-tool step only after its last result", async () => {
  const h = deskHarness({store:{limits:{compactAtChars:1800,keepRecentChars:500,inlineChars:8_000}}});
  simulateRun(h, "desk", [userEnvelope(h.clock, "run two checks")], runId => [
    { kind:"tool_call", toolUseId:"a", name:"read", input:{}, runId, at:0 },
    { kind:"tool_call", toolUseId:"b", name:"read", input:{}, runId, at:0 },
    { kind:"tool_result", toolUseId:"a", name:"read", output:"x".repeat(3_000), runId, at:0 },
    { kind:"tool_result", toolUseId:"b", name:"read", output:"last result", runId, at:0 },
    { kind:"assistant_text", text:"both checks complete", runId, at:0 },
  ]);
  await h.store.compact("desk", {force:true});
  const snap = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
  const lastResult = get<{seq:number}>(h.db, "SELECT MAX(seq) AS seq FROM evidence WHERE cell_id='desk' AND kind='tool_result'")!;
  expect(snap.summaryUptoSeq).toBe(lastResult.seq);
  expect(json(snap.history.at(-1))).toContain("both checks complete");
});

it("hydrates a legacy assignment with a null payload", () => {
  const h = deskHarness();
  const envelope = {...userEnvelope(h.clock, ""), type:"cell.task", payload:null};
  simulateRun(h,"desk",[envelope], reply("ready"));
  const snap = h.store.hydrateSync("desk", batchOf("desk", []), "isolated");
  expect(snap.tail.notes?.some(note=>note.startsWith("[original task]"))).toBeFalsy();
});
