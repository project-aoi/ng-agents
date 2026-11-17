#!/usr/bin/env node
// stdio MCP server stub that a CLI agent spawns: it authenticates to the kernel's per-Run tool bridge on loopback
// and then relays newline-delimited JSON-RPC both ways. The MCP protocol itself is spoken by the bridge.
//
// Environment (set per Run by the kernel, never inherited): NG_BRIDGE_PORT, NG_BRIDGE_TOKEN_FILE.
// Plain ESM without dependencies so any Node >= 18 can run it from the source tree.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

const port = Number(process.env.NG_BRIDGE_PORT);
const tokenFile = process.env.NG_BRIDGE_TOKEN_FILE;
if (!Number.isInteger(port) || port <= 0 || !tokenFile) {
  process.stderr.write("ng mcp shim: NG_BRIDGE_PORT and NG_BRIDGE_TOKEN_FILE are required\n");
  process.exit(2);
}

let token;
try {
  token = readFileSync(tokenFile, "utf8").trim();
} catch (err) {
  process.stderr.write(`ng mcp shim: cannot read the bridge token (${err instanceof Error ? err.message : String(err)}); the run has probably ended\n`);
  process.exit(3);
}

const socket = connect({ host: "127.0.0.1", port });
socket.setNoDelay(true);
socket.on("connect", () => {
  socket.write(`${JSON.stringify({ ngBridgeAuth: token })}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("error", (err) => {
  process.stderr.write(`ng mcp shim: bridge connection failed: ${err.message}\n`);
  process.exit(4);
});
// The bridge closes the connection when the Run ends; the CLI sees the server exit.
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
