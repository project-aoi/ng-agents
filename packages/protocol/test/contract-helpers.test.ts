import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  addressCovers,
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
  parsePrincipal,
  selectRunTools,
  stableStringify,
  topBallOwner,
  type ProposedAction,
  type ToolContext,
} from "../src";

describe("addresses and principals", () => {
  it("builds and parses addresses", () => {
    expect(inboxAddr("desk")).toBe("inbox:desk");
    expect(channelAddr("memory", "oc_123:thread")).toBe("channel:memory:oc_123:thread");
    expect(parseAddress("channel:memory:oc_123:thread")).toEqual({
      kind: "channel",
      addr: "channel:memory:oc_123:thread",
      channelId: "memory",
      target: "oc_123:thread",
    });
    expect(parseAddress("inbox:w1")).toEqual({ kind: "inbox", addr: "inbox:w1", cellId: "w1" });
    expect(parseAddress("channel:memory")).toBeNull();
    expect(parseAddress("timer:x")).toBeNull();
    expect(isInboxAddr("inbox:x")).toBe(true);
    expect(isChannelAddr("inbox:x")).toBe(false);
    expect(isAddress("channel:web:owner")).toBe(true);
    expect(() => channelAddr("a:b", "t")).toThrow();
    expect(addressCovers("channel:memory:*", "channel:memory:oc_1")).toBe(true);
    expect(addressCovers("inbox:desk", "inbox:desk2")).toBe(false);
  });

  it("parses principals", () => {
    expect(parsePrincipal("owner")).toEqual({ kind: "owner" });
    expect(parsePrincipal(cellPrincipal("w1"))).toEqual({ kind: "cell", cellId: "w1" });
    expect(parsePrincipal("memory:ou_42")).toEqual({ kind: "external", channelId: "memory", userId: "ou_42" });
    expect(parsePrincipal("me", "me")).toEqual({ kind: "owner" });
  });
});

describe("action hashing", () => {
  it("hashes the operation independently of display text", () => {
    const action = { type: "custom" as const, name: "review", args: { id: "a" }, summary: "审阅", subjectKey: "s", sideEffect: "internal" as const };
    expect(hashAction({ ...action, summary: "请审阅" })).toBe(hashAction(action));
    expect(hashAction({ ...action, args: { id: "b" } })).not.toBe(hashAction(action));
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
  it("aggregates the ball owner by priority human > agent > waiting over open actions", () => {
    expect(topBallOwner([{ owner: "waiting", status: "open" }, { owner: "agent", status: "open" }])).toBe("agent");
    expect(topBallOwner([{ owner: "agent", status: "open" }, { owner: "human", status: "open" }])).toBe("human");
    expect(topBallOwner([{ owner: "human", status: "done" }, { owner: "waiting", status: "open" }])).toBe("waiting");
    expect(topBallOwner([{ owner: "human", status: "cancelled" }])).toBeNull();
  });
});
