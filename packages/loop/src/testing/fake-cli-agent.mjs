#!/usr/bin/env node
// Deterministic stand-in for the CLI agents, speaking each one's real wire format (captured from claude 2.1.326,
// codex-cli 0.167.0 and agy 1.5.8) and acting as a real MCP client of the kernel's tool bridge.
//
//   node fake-cli-agent.mjs <claude|codex|agy> [the CLI's own arguments...]
//
// FAKECLI_SCENARIO = JSON file { store, log, turns: [{ actions: [...] }] }. Each user input (first prompt, steer,
// resume prompt) consumes the next turn, counted across processes in `<store>/turn`. Actions:
//   { text }                                   assistant text
//   { mcp, args }                              tools/call on the kernel bridge (result logged)
//   { native, input, output, kind?, path? }    a native tool (agy: asks the client for permission first)
//   { item: {...} }                            codex only: a raw item emitted as item.completed (e.g. custom_tool_call)
//   { sleep: ms }                              interruptible wait (cancel/interrupt/steer)
//   { fail: message }                          the turn fails
// Everything observable is appended to `log` as JSON lines (argv, cwd, env names, prompts, MCP results, decisions, the
// system text each CLI was handed: claude_system / codex_config.developerInstructions / acp_session.systemPrompt).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const engine = process.argv[2];
const argv = process.argv.slice(3);
if (argv.includes("--version")) {
  process.stdout.write(`9.9.9 (fake ${engine})\n`);
  process.exit(0);
}
const scenario = JSON.parse(readFileSync(process.env.FAKECLI_SCENARIO, "utf8"));
mkdirSync(scenario.store, { recursive: true });
const log = (o) => appendFileSync(scenario.log, `${JSON.stringify({ engine, pid: process.pid, ...o })}\n`);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

log({ type: "argv", argv, cwd: process.cwd(), envNames: Object.keys(process.env).filter((k) => /^NG_|SECRET|API_KEY|CLAUDECODE/.test(k)) });

function nextTurn() {
  const f = join(scenario.store, "turn");
  const n = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
  writeFileSync(f, String(n + 1));
  return scenario.turns[n] ?? { actions: [{ text: "(no scripted turn)" }] };
}

const sessionFile = (id) => join(scenario.store, `session-${id}.json`);
function newSession(from) {
  const id = randomUUID();
  writeFileSync(sessionFile(id), JSON.stringify({ id, engine, from: from ?? null, prompts: [] }));
  return id;
}
const sessionExists = (id) => existsSync(sessionFile(id));
function recordPrompt(id, text) {
  const s = JSON.parse(readFileSync(sessionFile(id), "utf8"));
  s.prompts.push(text);
  writeFileSync(sessionFile(id), JSON.stringify(s));
}

// ---------- minimal MCP client ----------
function mcpClient(server) {
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  let id = 0;
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const rid = ++id;
      waiting.set(rid, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: rid, method, params })}\n`);
    });
  let ready = (async () => {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `fake-${engine}`, version: "0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await request("tools/list", {});
    const tools = list.result?.tools ?? [];
    log({ type: "mcp_ready", protocolVersion: init.result?.protocolVersion, tools: tools.map((t) => t.name), descriptions: Object.fromEntries(tools.map((t) => [t.name, t.description])) });
    return list.result?.tools ?? [];
  })();
  return {
    ready,
    async call(name, args) {
      await ready;
      const r = await request("tools/call", { name, arguments: args });
      const text = (r.result?.content ?? []).map((c) => c.text).join("\n");
      log({ type: "mcp_result", name, text, isError: r.result?.isError === true });
      return { text, isError: r.result?.isError === true };
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

// ---------- turn runner (format-neutral; emitters per engine) ----------
async function runTurn(turn, emit, mcp, signal) {
  for (const a of turn.actions ?? []) {
    if (signal?.aborted) return { stopped: true };
    if (a.text !== undefined) emit.text(a.text);
    else if (a.mcp !== undefined) {
      const callId = `call_${randomUUID().slice(0, 8)}`;
      emit.mcpStart?.(callId, a.mcp, a.args ?? {});
      const r = await mcp.call(a.mcp, a.args ?? {});
      emit.mcpEnd?.(callId, a.mcp, a.args ?? {}, r);
    } else if (a.native !== undefined) {
      const callId = `tool_${randomUUID().slice(0, 8)}`;
      await emit.native(callId, a);
    } else if (a.item !== undefined) emit.item?.(a.item);
    else if (a.waitFile) {
      log({type:"waiting_file", path:a.waitFile});
      while (!existsSync(a.waitFile) && !signal?.aborted) await sleep(10, signal);
    }
    else if (a.awaitQueuedInput) await emit.awaitQueuedInput();
    else if (a.sleep !== undefined) await sleep(a.sleep, signal);
    else if (a.exit !== undefined) process.exit(a.exit);
    else if (a.fail !== undefined) return { error: a.fail };
  }
  return { stopped: signal?.aborted === true };
}

function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ======================= claude =======================
async function claude() {
  const mcpConfig = JSON.parse(readFileSync(argValue("--mcp-config"), "utf8"));
  const server = Object.values(mcpConfig.mcpServers)[0];
  const serverName = Object.keys(mcpConfig.mcpServers)[0];
  const systemFile = argValue("--append-system-prompt-file");
  if (systemFile) log({ type: "claude_system", text: readFileSync(systemFile, "utf8") });
  const resume = argValue("--resume");
  const fork = argv.includes("--fork-session");
  let sessionId;
  if (resume) {
    if (!sessionExists(resume)) {
      out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: resume });
      process.stderr.write(`No conversation found with session ID: ${resume}\n`);
      process.exit(1);
    }
    sessionId = fork ? newSession(resume) : resume;
  } else sessionId = newSession();
  const mcp = mcpClient(server);
  await mcp.ready;
  const sendInit = () => out({ type: "system", subtype: "init", session_id: sessionId, model: argValue("--model") ?? "claude-fake", tools: ["Read"], mcp_servers: [{ name: serverName, status: "connected" }] });

  let delayedInit = process.env.FAKECLI_DELAY_INIT === "1";
  if (!delayedInit) sendInit();
  const queue = [];
  let wake = null;
  let eof = false;
  let current = null;
  let rbuf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    rbuf += d;
    let nl;
    while ((nl = rbuf.indexOf("\n")) >= 0) {
      const line = rbuf.slice(0, nl);
      rbuf = rbuf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
        log({ type: "interrupt" });
        current?.abort();
        continue;
      }
      if (msg.type === "user") {
        queue.push(msg.message.content.map((c) => c.text).join("\n"));
        wake?.();
      }
    }
  });
  process.stdin.on("end", () => {
    eof = true;
    wake?.();
  });

  let msgN = 0;
  for (;;) {
    if (queue.length === 0) {
      if (eof) break;
      await new Promise((r) => (wake = r));
      wake = null;
      continue;
    }
    const prompt = queue.shift();
    log({ type: "prompt", text: prompt, session: sessionId });
    recordPrompt(sessionId, prompt);
    current = new AbortController();
    const mcpPrefix = `mcp__${serverName}__`;
    const emit = {
      async awaitQueuedInput() {
        if (!queue.length && !eof) await new Promise(resolve => { wake = resolve; });
        wake = null;
      },
      text: (t) => out({ type: "assistant", message: { id: `msg_${++msgN}`, role: "assistant", content: [{ type: "text", text: t }] }, parent_tool_use_id: null, session_id: sessionId }),
      mcpStart: (id, name, args) => out({ type: "assistant", message: { id: `msg_${++msgN}`, role: "assistant", content: [{ type: "tool_use", id, name: `${mcpPrefix}${name}`, input: args }] }, parent_tool_use_id: null, session_id: sessionId }),
      mcpEnd: (id, _name, _args, r) => {
        out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: r.text }], is_error: r.isError }] }, parent_tool_use_id: null, session_id: sessionId });
        if (delayedInit) {
          delayedInit = false;
          sendInit();
        }
      },
      native: async (id, a) => {
        out({ type: "assistant", message: { id: `msg_${++msgN}`, role: "assistant", content: [{ type: "tool_use", id, name: a.native, input: a.input ?? {} }] }, parent_tool_use_id: null, session_id: sessionId });
        out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: a.output ?? "ok", is_error: false }] }, parent_tool_use_id: null, session_id: sessionId });
      },
    };
    const turn = nextTurn();
    const interrupt = () => current.abort();
    if (turn.acknowledgeInterrupt) process.once("SIGTERM", interrupt);
    const r = await runTurn(turn, emit, mcp, current.signal);
    if (turn.acknowledgeInterrupt) process.off("SIGTERM", interrupt);
    const isError = Boolean(r.error || (r.stopped && !turn.acknowledgeInterrupt));
    out({
      type: "result",
      subtype: isError ? "error_during_execution" : "success",
      is_error: isError,
      num_turns: 1,
      result: r.error ?? "done",
      session_id: sessionId,
      ...(turn.omitQueuedTurnCount ? {} : { queued_turn_count: queue.length }),
    });
    if (turn.exitAfterTurn) break;
    if (r.stopped && !isError) log({ type: "interrupt_ack" });
    msgN = 0;
    current = null;
  }
  mcp.close();
  log({ type: "exit" });
  process.exit(0);
}

// ======================= codex =======================
function parseToml(v) {
  const t = v.trim();
  if (t.startsWith("{")) {
    const o = {};
    for (const m of t.slice(1, -1).matchAll(/([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*")/g)) o[m[1]] = JSON.parse(m[2]);
    return o;
  }
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

async function codex() {
  const cfg = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-c") {
      const kv = argv[++i];
      const eq = kv.indexOf("=");
      cfg[kv.slice(0, eq)] = parseToml(kv.slice(eq + 1));
    }
  }
  const sub = argv[1] === "resume" || argv[1] === "fork" ? argv[1] : null;
  const positional = argv.filter((a, i) => !a.startsWith("-") && !(i > 0 && ["-c", "-m", "-s", "-C"].includes(argv[i - 1])) && a !== "exec" && a !== sub);
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  prompt = prompt.trim();
  let threadId;
  if (sub) {
    const id = positional[0];
    if (!sessionExists(id)) {
      process.stderr.write(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${id} (code -32600)\n`);
      process.exit(1);
    }
    threadId = sub === "fork" ? newSession(id) : id;
  } else threadId = newSession();
  const names = [...new Set(Object.keys(cfg).filter((k) => k.startsWith("mcp_servers.")).map((k) => k.split(".")[1]))];
  const serverName = names[0];
  const server = { command: cfg[`mcp_servers.${serverName}.command`], args: cfg[`mcp_servers.${serverName}.args`], env: cfg[`mcp_servers.${serverName}.env`] };
  log({ type: "codex_config", sandbox: argValue("-s") ?? cfg["sandbox_mode"], approval: cfg["approval_policy"], mcpApproval: cfg[`mcp_servers.${serverName}.default_tools_approval_mode`], developerInstructions: cfg["developer_instructions"] ?? null });
  const mcp = mcpClient(server);
  await mcp.ready;
  out({ type: "thread.started", thread_id: threadId });
  out({ type: "turn.started" });
  log({ type: "prompt", text: prompt, session: threadId });
  recordPrompt(threadId, prompt);
  let item = 0;
  const emit = {
    text: (t) => out({ type: "item.completed", item: { id: `item_${item++}`, type: "agent_message", text: t } }),
    mcpStart: (id, name, args) => out({ type: "item.started", item: { id: `item_${item}`, type: "mcp_tool_call", server: serverName, tool: name, arguments: args, status: "in_progress" } }),
    mcpEnd: (id, name, args, r) => out({ type: "item.completed", item: { id: `item_${item++}`, type: "mcp_tool_call", server: serverName, tool: name, arguments: args, result: { content: [{ type: "text", text: r.text }] }, status: "completed" } }),
    item: (raw) => out({ type: "item.completed", item: { id: `item_${item++}`, ...raw } }),
    native: async (id, a) => {
      out({ type: "item.started", item: { id: `item_${item}`, type: "command_execution", command: a.input?.command ?? "true", status: "in_progress" } });
      out({ type: "item.completed", item: { id: `item_${item++}`, type: "command_execution", command: a.input?.command ?? "true", aggregated_output: a.output ?? "", exit_code: 0, status: "completed" } });
    },
  };
  const ac = new AbortController();
  process.on("SIGTERM", () => {
    log({ type: "sigterm" });
    process.exit(143);
  });
  const r = await runTurn(nextTurn(), emit, mcp, ac.signal);
  if (r.error) out({ type: "turn.failed", error: { message: r.error } });
  else out({ type: "turn.completed" });
  mcp.close();
  log({ type: "exit" });
  process.exit(0);
}

// ======================= agy (ACP) =======================
async function agy() {
  let mcp = null;
  let sessionId = null;
  let current = null;
  let pending = new Map();
  let rid = 0;
  const update = (u) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
  const askClient = (method, params) =>
    new Promise((resolve) => {
      const id = `fake_${++rid}`;
      pending.set(id, resolve);
      out({ jsonrpc: "2.0", id, method, params });
    });

  async function prompt(id, text) {
    log({ type: "prompt", text, session: sessionId });
    recordPrompt(sessionId, text);
    current = new AbortController();
    const signal = current.signal;
    const emit = {
      text: (t) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }),
      mcpStart: (cid, name, args) => update({ sessionUpdate: "tool_call", toolCallId: cid, name: `mcp_ng_${name}`, rawInput: args, status: "in_progress", kind: "other", title: `Run mcp_ng_${name}` }),
      mcpEnd: (cid, name) => update({ sessionUpdate: "tool_call_update", toolCallId: cid, name: `mcp_ng_${name}`, status: "completed", kind: "other" }),
      native: async (cid, a) => {
        const toolCall = { toolCallId: cid, name: a.native, kind: a.kind ?? "execute", title: a.native, rawInput: a.input ?? {}, status: "pending", ...(a.path ? { locations: [{ path: a.path }] } : {}) };
        update({ sessionUpdate: "tool_call", ...toolCall });
        const resp = await askClient("session/request_permission", { sessionId, toolCall, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
        const allowed = resp.result?.outcome?.optionId === "allow";
        log({ type: "permission", tool: a.native, kind: toolCall.kind, allowed });
        update({ sessionUpdate: "tool_call_update", toolCallId: cid, name: a.native, status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? (a.output ?? "ok") : "denied" } }] });
      },
    };
    const turn = nextTurn();
    const running = runTurn(turn, emit, mcp, signal);
    const r = turn.acknowledgeCancelDuringTool ? await Promise.race([
      running, new Promise(resolve => signal.addEventListener("abort", () => resolve({stopped: true}), {once: true})),
    ]) : await running;
    if (current?.signal === signal) current = null;
    if (r.error) out({ jsonrpc: "2.0", id, error: { code: -32603, message: r.error } });
    else out({ jsonrpc: "2.0", id, result: { stopReason: turn.refused ? "refusal" : signal.aborted ? "cancelled" : "end_turn" } });
  }

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method === undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        continue;
      }
      switch (msg.method) {
        case "initialize":
          out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } } } });
          break;
        case "session/new":
        case "session/resume": {
          const p = msg.params;
          if (msg.method === "session/resume" && !sessionExists(p.sessionId)) {
            out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `Failed to read session ${p.sessionId}; retry, or load it with session/load` } });
            break;
          }
          sessionId = msg.method === "session/resume" ? p.sessionId : newSession();
          log({ type: "acp_session", method: msg.method, cwd: p.cwd, systemPrompt: p._meta?.antigravity?.systemPrompt?.append ?? null, mcpServers: p.mcpServers.map((s) => s.name) });
          const s = p.mcpServers[0];
          mcp = mcpClient({ command: s.command, args: s.args, env: Object.fromEntries(s.env.map((e) => [e.name, e.value])) });
          void mcp.ready.then(() => out({ jsonrpc: "2.0", id: msg.id, result: { sessionId, models: { currentModelId: "gemini-fake" }, modes: { currentModeId: "default" } } }));
          break;
        }
        case "session/set_model":
          log({ type: "set_model", modelId: msg.params.modelId });
          out({ jsonrpc: "2.0", id: msg.id, result: {} });
          break;
        case "session/prompt":
          void prompt(msg.id, msg.params.prompt.map((b) => b.text).join("\n"));
          break;
        case "session/cancel":
          log({ type: "cancel" });
          current?.abort();
          break;
        default:
          if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
      }
    }
  });
  process.stdin.on("end", () => {
    log({ type: "exit" });
    mcp?.close();
    process.exit(0);
  });
}

if (engine === "claude") await claude();
else if (engine === "codex") await codex();
else if (engine === "agy") await agy();
else {
  process.stderr.write(`fake-cli: unknown engine ${engine}\n`);
  process.exit(2);
}
