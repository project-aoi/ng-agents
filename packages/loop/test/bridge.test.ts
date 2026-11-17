import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_SHIM_PATH, startToolBridge, type ToolBridge } from "../src";

interface Rpc {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** A stdio MCP client over the shim, the way a CLI agent talks to it. */
function stdioClient(bridge: ToolBridge) {
  const child = spawn(bridge.launch.command, bridge.launch.args, { env: { PATH: process.env["PATH"] ?? "", ...bridge.launch.env }, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  let buf = "";
  let stderr = "";
  const waiting = new Map<number, (m: Rpc) => void>();
  let id = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl)) as Rpc;
      buf = buf.slice(nl + 1);
      if (typeof msg.id === "number") waiting.get(msg.id)?.(msg);
    }
  });
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return {
    child,
    exited,
    stderr: () => stderr,
    request(method: string, params?: unknown): Promise<Rpc> {
      const rid = ++id;
      return new Promise((resolve) => {
        waiting.set(rid, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: rid, method, ...(params !== undefined ? { params } : {}) })}\n`);
      });
    },
    notify(method: string, params?: unknown) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })}\n`);
    },
  };
}

const bridges: ToolBridge[] = [];
afterEach(async () => {
  while (bridges.length) await bridges.pop()!.close();
});

async function bridge(call: Parameters<typeof startToolBridge>[0]["call"]): Promise<ToolBridge> {
  const b = await startToolBridge({
    tools: [
      { name: "echo", description: "Echo the input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "slow", description: "Takes a while", inputSchema: { type: "object", properties: {} } },
    ],
    instructions: "kernel tools",
    call,
  });
  bridges.push(b);
  return b;
}

describe("MCP tool bridge", () => {
  it("speaks MCP to a stdio client through the shim: handshake, tools/list, tools/call, errors", async () => {
    const calls: unknown[] = [];
    const b = await bridge(async (name, args) => {
      calls.push({ name, args });
      if ((args as { text?: string }).text === "boom") throw new Error("handler exploded");
      return { text: `echo: ${(args as { text: string }).text}` };
    });
    expect(b.launch.args).toEqual([MCP_SHIM_PATH]);
    expect(b.launch.env["NG_BRIDGE_PORT"]).toBe(String(b.port));
    expect(b.launch.env["NG_BRIDGE_TOKEN_FILE"]).toBe(b.tokenFile);

    const c = stdioClient(b);
    const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ng" }, instructions: "kernel tools" });
    c.notify("notifications/initialized");
    // an unknown protocol revision is answered with one the bridge supports
    expect((await c.request("initialize", { protocolVersion: "1999-01-01" })).result?.["protocolVersion"]).toBe("2025-06-18");
    expect((await c.request("ping")).result).toEqual({});

    const list = await c.request("tools/list");
    expect((list.result?.["tools"] as Array<{ name: string }>).map((t) => t.name)).toEqual(["echo", "slow"]);

    const ok = await c.request("tools/call", { name: "echo", arguments: { text: "hi" } });
    expect(ok.result).toEqual({ content: [{ type: "text", text: "echo: hi" }], isError: false });
    const thrown = await c.request("tools/call", { name: "echo", arguments: { text: "boom" } });
    expect(thrown.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Error: handler exploded" }] });
    const unknown = await c.request("tools/call", { name: "nope", arguments: {} });
    expect(unknown.result?.["isError"]).toBe(true);
    expect((await c.request("resources/read", {})).error?.code).toBe(-32601);
    expect(calls).toEqual([
      { name: "echo", args: { text: "hi" } },
      { name: "echo", args: { text: "boom" } },
    ]);
    expect(b.sessions()).toBe(1);

    // closing the bridge ends the shim (the CLI sees its server exit) and removes the credential
    await b.close();
    expect(await c.exited).toBe(0);
    expect(existsSync(b.tokenFile)).toBe(false);
  });

  it("serializes concurrent calls and honours notifications/cancelled", async () => {
    const order: string[] = [];
    const b = await bridge(async (name, args, meta) => {
      order.push(`start ${name}`);
      if (name === "slow") {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5_000);
          meta.signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          });
        });
        order.push(`end slow (aborted=${meta.signal.aborted})`);
        return { text: "slow done" };
      }
      order.push(`end ${name}`);
      return { text: String((args as { text: string }).text) };
    });
    const c = stdioClient(b);
    await c.request("initialize", { protocolVersion: "2025-11-25" });
    const slow = c.request("tools/call", { name: "slow", arguments: {} });
    const echo = c.request("tools/call", { name: "echo", arguments: { text: "after" } });
    await new Promise((r) => setTimeout(r, 100));
    c.notify("notifications/cancelled", { requestId: 2, reason: "user" });
    await Promise.all([slow, echo]);
    expect(order).toEqual(["start slow", "end slow (aborted=true)", "start echo", "end echo"]);
  });

  it("accepts only loopback connections that present the per-Run token", async () => {
    const b = await bridge(async () => ({ text: "should not run" }));
    const tryRaw = (first: string) =>
      new Promise<string>((resolve) => {
        const s = connect({ host: "127.0.0.1", port: b.port });
        let got = "";
        s.on("connect", () => {
          s.write(`${first}\n`);
          s.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
        });
        s.on("data", (d) => (got += d.toString()));
        s.on("close", () => resolve(got));
        s.on("error", () => resolve(got));
        setTimeout(() => s.destroy(), 1_000);
      });
    expect(await tryRaw(JSON.stringify({ ngBridgeAuth: "0".repeat(64) }))).toBe("");
    expect(await tryRaw(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }))).toBe("");
    expect(b.sessions()).toBe(0);

    // a shim with a wrong token file never gets a session either
    const env = { ...b.launch.env, NG_BRIDGE_TOKEN_FILE: "/nonexistent/token" };
    const child = spawn(b.launch.command, b.launch.args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    expect(code).toBe(3);
  });
});
