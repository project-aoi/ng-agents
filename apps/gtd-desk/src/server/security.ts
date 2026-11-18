import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

// docs/01 §四 坑 1: a control plane reachable without authentication is a remote-execution hole. The desk binds to
// loopback by default, refuses any other bind without a bearer token, and even on loopback rejects requests a
// web page in the owner's browser could forge (cross-site writes, DNS-rebinding Host headers).

export class SecurityConfigError extends Error {
  override name = "SecurityConfigError";
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  if (isIP(h) === 6) return h === "::1" || h === "0:0:0:0:0:0:0:1" || h.startsWith("::ffff:127.");
  return false;
}

export interface SecurityPolicy {
  /** Required on every /api/* request when set (`Authorization: Bearer <token>`; `?token=` only on the SSE stream). */
  token: string | null;
  /** Host header names accepted (lowercase, no port). null = any (the token is the guard). */
  allowedHosts: ReadonlySet<string> | null;
  /**
   * docs/05 §5.3 — credentials of external main agents for `/api/agent/*`, agent id → token. Separate from the owner's
   * token on purpose: whoever holds one of these acts as `agent:<id>` (may orchestrate, may never approve an outward
   * send or raise a budget), and the owner's token is not accepted on the agent API at all.
   */
  agentTokens: ReadonlyMap<string, string>;
  /** The desk is bound to a loopback address. */
  loopback: boolean;
}

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** `NG_AGENT_TOKEN` (agent id "main") and `NG_AGENT_TOKENS` ("id:token,id2:token2"). */
export function agentTokensFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const single = env["NG_AGENT_TOKEN"]?.trim();
  if (single) out["main"] = single;
  for (const part of (env["NG_AGENT_TOKENS"] ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    if (i <= 0) throw new SecurityConfigError(`NG_AGENT_TOKENS: "${part.slice(0, 12)}…" is not of the form id:token`);
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export type AgentAuth = { ok: true; principalId: `agent:${string}`; agentId: string } | { ok: false; reason: string };

/**
 * Who is calling the agent API.
 * - A presented agent token → that agent.
 * - No agent token configured, loopback bind, and no owner token either (the default local setup, where the whole
 *   API is already open to local software): `agent:local` — still an agent, never the owner.
 * - Anything else is refused; in particular the owner's token does not open the agent API (two separate credentials).
 */
export function agentAuthFor(policy: SecurityPolicy, presented: string | null): AgentAuth {
  if (presented) {
    for (const [agentId, token] of policy.agentTokens) {
      if (tokenMatches(presented, token)) return { ok: true, principalId: `agent:${agentId}`, agentId };
    }
    if (policy.token && tokenMatches(presented, policy.token)) {
      return { ok: false, reason: "the owner's token is not accepted on the agent API: configure NG_AGENT_TOKEN for the agent" };
    }
    return { ok: false, reason: "unknown agent token" };
  }
  if (policy.agentTokens.size === 0 && policy.loopback && policy.token === null) return { ok: true, principalId: "agent:local", agentId: "local" };
  return { ok: false, reason: "an agent token is required (Authorization: Bearer <NG_AGENT_TOKEN>)" };
}

/** Throws unless the bind is safe: non-loopback hosts need a token of reasonable strength. */
export function securityPolicyFor(
  bindHost: string,
  token: string | null | undefined,
  extraHosts: readonly string[] = [],
  agents: Readonly<Record<string, string>> = {},
): SecurityPolicy {
  const t = token ? token.trim() : "";
  const agentTokens = new Map<string, string>();
  for (const [id, raw] of Object.entries(agents)) {
    const at = raw.trim();
    if (!AGENT_ID.test(id)) throw new SecurityConfigError(`agent id "${id}" is invalid: use lowercase letters, digits, "-" or "_" (it becomes the principal agent:${id}).`);
    if (at.length < 16) throw new SecurityConfigError(`the token of agent "${id}" is too short: use at least 16 random characters (e.g. \`openssl rand -hex 24\`).`);
    if (t && at === t) throw new SecurityConfigError(`agent "${id}" must not share the owner's token: the two credentials carry different rights.`);
    if ([...agentTokens.values()].includes(at)) throw new SecurityConfigError(`agent "${id}" shares its token with another agent: each agent needs its own.`);
    agentTokens.set(id, at);
  }
  if (t && t.length < 16) throw new SecurityConfigError("NG_DESK_TOKEN is too short: use at least 16 random characters (e.g. `openssl rand -hex 24`).");
  const loopback = isLoopbackHost(bindHost);
  if (!loopback && !t) {
    throw new SecurityConfigError(
      `Refusing to listen on ${bindHost}: a non-loopback address exposes the desk to the network. Set NG_DESK_TOKEN (bearer token) or bind 127.0.0.1.`,
    );
  }
  const hosts = new Set(["localhost", "127.0.0.1", "::1", ...extraHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)]);
  if (loopback && !["localhost", "127.0.0.1", "::1"].includes(bindHost.toLowerCase())) hosts.add(bindHost.toLowerCase());
  return { token: t || null, allowedHosts: loopback ? hosts : extraHosts.length ? hosts : null, agentTokens, loopback };
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

export function tokenMatches(presented: string | null | undefined, expected: string): boolean {
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

export function bearerOf(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1]!.trim() : null;
}

/** Host header without the port, lowercase, IPv6 brackets removed. */
export function hostnameOf(hostHeader: string | undefined | null): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]"));
  const i = h.lastIndexOf(":");
  return i > 0 && h.indexOf(":") === i ? h.slice(0, i) : h;
}

/**
 * A state-changing request is accepted only from the desk's own pages: no foreign Origin, no `Sec-Fetch-Site:
 * cross-site`, and a JSON body (a cross-site HTML form cannot send `application/json` without a CORS preflight,
 * which the desk never answers).
 */
export function crossSiteReason(req: { method: string; url: string; header(name: string): string | undefined }): string | null {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  const site = req.header("sec-fetch-site");
  if (site === "cross-site") return "cross-site request";
  const origin = req.header("origin");
  if (origin && origin !== "null") {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      return "malformed Origin";
    }
    const self = new URL(req.url);
    // Any loopback origin is local software (e.g. the web client's dev server proxying from another port).
    const sameHost = o.host === self.host || (isLoopbackHost(o.hostname) && isLoopbackHost(self.hostname));
    if (!sameHost) return `foreign Origin ${o.host}`;
  } else if (origin === "null") {
    return "opaque Origin";
  }
  const type = req.header("content-type");
  const length = req.header("content-length");
  const hasBody = (length !== undefined && length !== "0") || req.header("transfer-encoding") !== undefined;
  if (hasBody && !(type ?? "").toLowerCase().startsWith("application/json")) return "body must be application/json";
  return null;
}
