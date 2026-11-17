import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { NgError, type ExecResult } from "@ng/protocol";
import type { RpcContext, RpcHandlerDef, SecretInjector, WorkspaceLimits } from "../types";
import { abortError, errorMessage, killGroup } from "../util";
import { OutputCollector, supervise } from "./process";

/** Source of the child-side runtime; passed with `node -e`, so no file has to exist inside a sandbox. */
export const CODE_RPC_RUNNER_SOURCE = readFileSync(new URL("./code-rpc-runner.mjs", import.meta.url), "utf8");
const SENTINEL = "\u0001ngrpc\u0001";

/** `node --permission` without any `--allow-*` grant: no filesystem, child processes, workers, addons or WASI. */
export function codeRpcArgv(node: string): string[] {
  return [node, "--permission", "--input-type=module", "-e", CODE_RPC_RUNNER_SOURCE];
}

export interface CodeRpcHost {
  cellId: string;
  root: string;
  epoch(): number;
  /** A nested read/write/edit/bash call, executed with the port's own rules (confinement, read-only, env). */
  exec(tool: "read" | "write" | "edit" | "bash", args: unknown, signal: AbortSignal): Promise<ExecResult>;
  rpc: Record<string, RpcHandlerDef>;
  injectSecret?: SecretInjector | undefined;
  secretHosts?: Record<string, readonly string[]> | undefined;
  fetch: typeof fetch;
  limits: WorkspaceLimits;
}

interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** The script names a secret; the host resolves and attaches it. The value never enters the sandbox. */
  auth?: { secretRef: string; header?: string; scheme?: string; query?: string };
}

export function hostAllowed(patterns: readonly string[], hostname: string): boolean {
  const h = hostname.toLowerCase();
  return patterns.some((p) => {
    const q = p.toLowerCase();
    return q.startsWith("*.") ? h.endsWith(q.slice(1)) && h.length > q.length - 1 : h === q;
  });
}

/**
 * Runs one code_rpc execution against an already spawned runner child. Every `tools.*` call the script makes is
 * served here, in the kernel process: workspace tools through `host.exec`, `tools.http` through `host.fetch`
 * with secrets attached host-side, `tools.rpc` through registered handlers. Secret values obtained during the
 * execution are replaced by `[secret:<ref>]` in everything sent back to the child and in the output.
 */
export async function runCodeRpc(opts: {
  child: ChildProcess;
  code: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  killInside?: ((sig: "TERM" | "KILL") => void) | undefined;
  host: CodeRpcHost;
}): Promise<ExecResult> {
  const { child, host } = opts;
  const limits = host.limits;
  const out = new OutputCollector(limits.maxOutputChars);
  const secrets = new Map<string, string>();
  const inner = new AbortController();
  let calls = 0;
  let done: { ok: boolean; error?: string } | null = null;
  let stdoutBuf = "";

  const scrub = (s: string): string => {
    let r = s;
    for (const [value, ref] of secrets) if (value.length >= 4) r = r.split(value).join(`[secret:${ref}]`);
    return r;
  };
  const scrubDeep = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(scrubDeep);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubDeep(x)]));
    return v;
  };
  const remember = (value: string, ref: string) => {
    if (value) secrets.set(value, ref);
  };
  const resolveSecret = async (ref: string, ctx: { purpose: string; url?: string; method?: string; rpc?: string }): Promise<string> => {
    if (!host.injectSecret) throw new Error("secret injection is not configured for this workspace");
    const value = await host.injectSecret(ref, { cellId: host.cellId, epoch: host.epoch(), ...ctx });
    if (typeof value !== "string" || !value) throw new Error(`secret "${ref}" is not available`);
    remember(value, ref);
    return value;
  };

  const send = (msg: unknown) => {
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) return;
    let line: string;
    try {
      line = JSON.stringify(scrubDeep(msg));
    } catch (e) {
      const id = (msg as { id?: unknown }).id;
      line = JSON.stringify({ t: "result", id, ok: false, error: `result is not JSON-serializable: ${errorMessage(e)}` });
    }
    child.stdin.write(line + "\n");
  };

  const http = async (raw: unknown): Promise<unknown> => {
    if (!raw || typeof raw !== "object") throw new Error("tools.http expects { url, method?, headers?, body?, auth? }");
    const req = raw as HttpRequest;
    let url: URL;
    try {
      url = new URL(String(req.url));
    } catch {
      throw new Error(`invalid url: ${String(req.url)}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`unsupported protocol ${url.protocol}`);
    const method = String(req.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) if (typeof v === "string") headers[k.toLowerCase()] = v;
    let body: string | undefined;
    if (typeof req.body === "string") body = req.body;
    else if (req.body !== undefined && req.body !== null) {
      body = JSON.stringify(req.body);
      headers["content-type"] ??= "application/json";
    }
    if (req.auth) {
      const ref = String(req.auth.secretRef ?? "");
      if (!ref) throw new Error("auth.secretRef is required");
      if (host.secretHosts) {
        const allowed = host.secretHosts[ref];
        if (!allowed || !hostAllowed(allowed, url.hostname)) throw new Error(`secret "${ref}" may not be sent to ${url.hostname}`);
      }
      const value = await resolveSecret(ref, { purpose: `http ${method} ${url.host}`, url: url.origin + url.pathname, method });
      if (req.auth.query) url.searchParams.set(req.auth.query, value);
      else {
        const scheme = req.auth.scheme ?? "Bearer";
        headers[(req.auth.header ?? "authorization").toLowerCase()] = scheme ? `${scheme} ${value}` : value;
      }
    }
    const signal = AbortSignal.any([inner.signal, AbortSignal.timeout(req.timeoutMs ?? limits.httpTimeoutMs)]);
    const init: RequestInit = { method, headers, signal, redirect: req.auth ? "manual" : "follow" };
    if (body !== undefined) init.body = body;
    const res = await host.fetch(url, init);
    let text = await res.text();
    const truncated = text.length > limits.httpMaxResponseChars;
    if (truncated) text = text.slice(0, limits.httpMaxResponseChars);
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (resHeaders[k] = v));
    return { status: res.status, ok: res.ok, headers: resHeaders, body: text, ...(truncated ? { truncated } : {}) };
  };

  const rpc = async (raw: unknown): Promise<unknown> => {
    const { name, args } = (raw ?? {}) as { name?: unknown; args?: unknown };
    const def = typeof name === "string" ? host.rpc[name] : undefined;
    if (!def) throw new Error(`unknown rpc "${String(name)}"; available: ${Object.keys(host.rpc).join(", ") || "none"}`);
    const rpcName = name as string;
    const ctx: RpcContext = {
      cellId: host.cellId,
      epoch: host.epoch(),
      root: host.root,
      signal: inner.signal,
      secret: (ref, purpose) => resolveSecret(ref, { purpose: purpose ?? `rpc ${rpcName}`, rpc: rpcName }),
      fetch: host.fetch,
    };
    return await def.handler(args, ctx);
  };

  const handleCall = async (msg: { id: unknown; tool: unknown; args: unknown }) => {
    if (++calls > limits.codeRpcMaxCalls) {
      send({ t: "result", id: msg.id, ok: false, error: `too many tool calls in one code_rpc execution (limit ${limits.codeRpcMaxCalls})` });
      return;
    }
    try {
      let value: unknown;
      switch (msg.tool) {
        case "read":
        case "write":
        case "edit":
        case "bash":
          value = await host.exec(msg.tool, msg.args, inner.signal);
          break;
        case "http":
          value = await http(msg.args);
          break;
        case "rpc":
          value = await rpc(msg.args);
          break;
        default:
          throw new Error(`unknown tool "${String(msg.tool)}"`);
      }
      send({ t: "result", id: msg.id, ok: true, value: value === undefined ? null : value });
    } catch (e) {
      send({ t: "result", id: msg.id, ok: false, error: errorMessage(e) });
    }
  };

  let stopTimer: NodeJS.Timeout | null = null;
  const onDone = () => {
    child.stdin?.end();
    // Lingering timers or sockets in the script must not keep the execution alive after it finished.
    stopTimer = setTimeout(() => {
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      opts.killInside?.("KILL");
    }, 300);
  };

  const onLine = (line: string) => {
    if (!line.startsWith(SENTINEL)) {
      out.push(scrub(line) + "\n");
      return;
    }
    let msg: { t?: unknown; s?: unknown; id?: unknown; tool?: unknown; args?: unknown; ok?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line.slice(SENTINEL.length));
    } catch {
      out.push(scrub(line) + "\n");
      return;
    }
    if (msg.t === "out") out.push(scrub(String(msg.s ?? "")));
    else if (msg.t === "call") void handleCall({ id: msg.id, tool: msg.tool, args: msg.args });
    else if (msg.t === "done" && !done) {
      done = msg.ok ? { ok: true } : { ok: false, error: scrub(String(msg.error ?? "error")) };
      onDone();
    }
  };

  const rpcList = Object.entries(host.rpc).map(([name, d]) => ({ name, description: d.description ?? "" }));
  child.stdin?.on("error", () => {});
  child.stdin?.write(JSON.stringify({ t: "start", code: opts.code, rpcList }) + "\n");

  const r = await supervise(child, {
    timeoutMs: opts.timeoutMs,
    killGraceMs: limits.killGraceMs,
    signal: opts.signal,
    ...(opts.killInside ? { killInside: opts.killInside } : {}),
    onData: (chunk, stream) => {
      if (stream === "stderr") {
        out.push(scrub(chunk));
        return;
      }
      stdoutBuf += chunk;
      for (let i = stdoutBuf.indexOf("\n"); i !== -1; i = stdoutBuf.indexOf("\n")) {
        onLine(stdoutBuf.slice(0, i));
        stdoutBuf = stdoutBuf.slice(i + 1);
      }
    },
  });
  if (stdoutBuf) onLine(stdoutBuf);
  if (stopTimer) clearTimeout(stopTimer);
  inner.abort();
  secrets.clear();

  if (r.spawnError) throw new NgError("unsupported", `code_rpc could not start: ${r.spawnError.message}`);
  const finished = done as { ok: boolean; error?: string } | null;
  if (r.aborted && !finished) throw abortError(opts.signal);
  const result = (exitCode: number, note?: string): ExecResult => {
    if (note) out.push(`${out.text().endsWith("\n") || out.text() === "" ? "" : "\n"}${note}\n`);
    return out.truncated ? { output: out.text(), exitCode, truncated: true } : { output: out.text(), exitCode };
  };
  if (finished) return finished.ok ? result(0) : result(1, finished.error);
  if (r.timedOut) return result(124, `[code_rpc timed out after ${opts.timeoutMs}ms and was killed]`);
  return result(r.code ?? 1, `[code_rpc process exited (${r.signal ? `signal ${r.signal}` : `code ${r.code}`}) before finishing]`);
}
