import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  actionClassOf,
  addressCovers,
  asClarifyCard,
  cardButtons,
  cellPrincipal,
  channelAddr,
  createRegistry,
  defineTool,
  hashAction,
  inboxAddr,
  isAddress,
  isChannelAddr,
  isInboxAddr,
  isNgError,
  makeBounds,
  mergeAdjacentMessages,
  parseAddress,
  parseGtdKey,
  parsePrincipal,
  gtdKeys,
  selectRunTools,
  stableStringify,
  topBallOwner,
  type ClarifyCard,
  type ProposedAction,
  type ToolContext,
} from "../src";

describe("addresses and principals", () => {
  it("builds and parses addresses", () => {
    expect(inboxAddr("desk")).toBe("inbox:desk");
    expect(channelAddr("feishu", "oc_123:thread")).toBe("channel:feishu:oc_123:thread");
    expect(parseAddress("channel:feishu:oc_123:thread")).toEqual({
      kind: "channel",
      addr: "channel:feishu:oc_123:thread",
      channelId: "feishu",
      target: "oc_123:thread",
    });
    expect(parseAddress("inbox:w1")).toEqual({ kind: "inbox", addr: "inbox:w1", cellId: "w1" });
    expect(parseAddress("channel:feishu")).toBeNull();
    expect(parseAddress("timer:x")).toBeNull();
    expect(isInboxAddr("inbox:x")).toBe(true);
    expect(isChannelAddr("inbox:x")).toBe(false);
    expect(isAddress("channel:web:owner")).toBe(true);
    expect(() => channelAddr("a:b", "t")).toThrow();
    expect(addressCovers("channel:feishu:*", "channel:feishu:oc_1")).toBe(true);
    expect(addressCovers("inbox:desk", "inbox:desk2")).toBe(false);
  });

  it("parses principals", () => {
    expect(parsePrincipal("owner")).toEqual({ kind: "owner" });
    expect(parsePrincipal(cellPrincipal("w1"))).toEqual({ kind: "cell", cellId: "w1" });
    expect(parsePrincipal("feishu:ou_42")).toEqual({ kind: "external", channelId: "feishu", userId: "ou_42" });
    expect(parsePrincipal("me", "me")).toEqual({ kind: "owner" });
  });
});

describe("hashAction / actionClassOf", () => {
  const send: ProposedAction = {
    type: "channel.send",
    summary: "回复张三",
    subjectKey: "msg:1",
    sideEffect: "external",
    target: "channel:feishu:oc_1",
    content: { format: "text", body: "好的，周五前给你" },
    artifactId: "art_1",
  };

  it("binds only operative fields", () => {
    const same = { ...send, summary: "different", subjectKey: "x", artifactId: "other", card: { format: "card" as const, body: "" } };
    expect(hashAction(same)).toBe(hashAction(send));
    expect(hashAction({ ...send, content: { format: "text", body: "改了" } })).not.toBe(hashAction(send));
    const { summary, subjectKey, sideEffect, artifactId, ...rest } = send;
    void summary, subjectKey, sideEffect, artifactId;
    expect(stableStringify(rest)).toContain('"target":"channel:feishu:oc_1"');
  });

  it("classifies actions coarsely", () => {
    expect(actionClassOf(send)).toBe("channel.send|channel:feishu:*");
    expect(actionClassOf({ type: "custom", summary: "", subjectKey: "s", sideEffect: "internal", name:"check" })).toBe("custom|check");
  });

  it("stableStringify sorts keys and drops undefined", () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [3, undefined] } })).toBe('{"a":{"c":[3,null]},"b":1}');
  });
});

describe("registry and tools", () => {
  const ctx = {} as ToolContext;
  const readTool = defineTool({
    name: "read_file",
    description: "read",
    kind: "read",
    input: z.object({ path: z.string() }),
    handler: (a) => `read ${a.path}`,
  });
  const noteTool = defineTool({
    name: "save_note",
    description: "note",
    kind: "kernel",
    input: z.object({ text: z.string().min(1) }),
    handler: (a) => ({ output: `saved ${a.text}`, endRun: "completed" }),
  });
  const bashTool = defineTool({ name: "bash", description: "sh", kind: "bash", input: z.object({ command: z.string() }), handler: () => "ok" });

  it("derives JSON schema and validates input", async () => {
    expect(readTool.inputSchema).toMatchObject({ type: "object", properties: { path: { type: "string" } }, required: ["path"] });
    expect(readTool.inputSchema).not.toHaveProperty("$schema");
    expect(await readTool.handler({ path: "a.ts" }, ctx)).toBe("read a.ts");
    expect(await noteTool.handler({ text: "" }, ctx)).toMatchObject({ isError: true });
    expect(() => defineTool({ name: "bad name", description: "", kind: "kernel", input: z.object({}), handler: () => "" })).toThrow();
  });

  it("registers by name, refuses duplicates and resolves toolsets", () => {
    const reg = createRegistry();
    reg.toolsets.register({ name: "readonly", tools: [readTool, noteTool] });
    reg.toolsets.register({ name: "shell", tools: [bashTool] });
    expect(reg.resolveTools(["readonly", "shell"]).map((t) => t.name)).toEqual(["read_file", "save_note", "bash"]);
    reg.toolsets.register({ name: "dup", tools: [readTool] });
    const err = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e;
      }
      return null;
    };
    expect(isNgError(err(() => reg.resolveTools(["readonly", "dup"])), "duplicate")).toBe(true);
    expect(isNgError(err(() => reg.resolveTools(["missing"])), "not_found")).toBe(true);
    expect(isNgError(err(() => reg.toolsets.register({ name: "shell", tools: [] })), "duplicate")).toBe(true);
    expect(isNgError(err(() => reg.prompts.require("x")), "not_found")).toBe(true);
    reg.prompts.register({ name: "desk", text: "你是轻装主台" });
    expect(reg.prompts.list().map((p) => p.name)).toEqual(["desk"]);
    expect(() => reg.codeProcessors.register({ name: "script:x", run: async () => "completed" })).toThrow();
  });

  it("selectRunTools filters by bounds and allowedTools, always keeping kernel tools", () => {
    const all = [readTool, noteTool, bashTool];
    const bounds = makeBounds({ tools: ["read", "bash"] });
    expect(selectRunTools(all, { kind: "llm" }, bounds).map((t) => t.name)).toEqual(["read_file", "save_note", "bash"]);
    expect(selectRunTools(all, { kind: "llm", allowedTools: ["read"] }, bounds).map((t) => t.name)).toEqual(["read_file", "save_note"]);
    expect(selectRunTools(all, { kind: "llm", allowedTools: ["bash"] }, makeBounds({ tools: ["read"] })).map((t) => t.name)).toEqual([
      "save_note",
    ]);
  });
});

describe("mergeAdjacentMessages", () => {
  it("merges same-role runs and keeps tool_result first", () => {
    const merged = mergeAdjacentMessages([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "file" }] },
      { role: "user", content: [{ type: "text", text: "roster" }] },
      { role: "user", content: [{ type: "text", text: "new batch" }, { type: "tool_result", toolUseId: "t9", content: "late" }] },
    ]);
    expect(merged.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(merged[2]!.content.map((b) => b.type)).toEqual(["tool_result", "tool_result", "text", "text"]);
  });
});

describe("gtd conventions", () => {
  it("builds and parses keys", () => {
    expect(gtdKeys.action("a1")).toBe("gtd:action:a1");
    expect(parseGtdKey("gtd:action:a1")).toEqual({ kind: "action", id: "a1" });
    expect(parseGtdKey("gtd:activity:x")).toEqual({ kind: "activity", id: "x" });
    expect(parseGtdKey("gtd:project")).toEqual({ kind: "project" });
    expect(parseGtdKey("gtd:action:")).toBeNull();
    expect(parseGtdKey("other")).toBeNull();
  });

  it("aggregates the ball owner by priority human > agent > waiting over open actions", () => {
    expect(topBallOwner([{ owner: "waiting", status: "open" }, { owner: "agent", status: "open" }])).toBe("agent");
    expect(topBallOwner([{ owner: "agent", status: "open" }, { owner: "human", status: "open" }])).toBe("human");
    expect(topBallOwner([{ owner: "human", status: "done" }, { owner: "waiting", status: "open" }])).toBe("waiting");
    expect(topBallOwner([{ owner: "human", status: "cancelled" }])).toBeNull();
  });

  it("gives each card type its buttons", () => {
    const base = {
      subjectKey: "msg:1",
      title: "回复张三",
      source: { label: "飞书转发", at: 0 },
      rawInput: { text: "接口什么时候好？", kind: "message" as const },
      prep: { summary: "查了 PR #108", checked: [] },
    };
    const response: ClarifyCard = {
      ...base,
      cardType: "response",
      draft: { artifactId: "a1", version: 2 },
      reply: { target: "channel:feishu:oc_1", targetLabel: "张三" },
      confirmVerb: "send",
    };
    expect(cardButtons(response).map((b) => b.label)).toEqual(["✓ 确认发送", "🎙 按住口述修改意见", "⏱ 推迟到下午", "下一张 →"]);
    expect(
      cardButtons({ ...base, cardType: "project_proposal", proposal: { title: "竞品", outcome: "报告", actions: [] } }).map((b) => b.id),
    ).toEqual(["confirm", "edit_plan", "someday", "skip"]);
    expect(
      cardButtons({ ...base, cardType: "escalation", escalation: { reason: "waiting_timeout", explanation: "C 未回" } }).map((b) => b.label),
    ).toEqual(["✓ 发送催问并继续跟进", "⏱ 再等 1 天", "✓ 线下已解决，直接完结", "下一张 →"]);
    expect(
      cardButtons({ ...base, cardType: "escalation", escalation: { reason: "budget_exhausted", explanation: "超额" } })[0],
    ).toMatchObject({ id: "extend", primary: true });
    expect(asClarifyCard(response)).toBe(response);
    expect(asClarifyCard({ cardType: "nope" })).toBeNull();
  });
});
