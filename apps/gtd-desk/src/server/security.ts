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
}

/** Throws unless the bind is safe: non-loopback hosts need a token of reasonable strength. */
export function securityPolicyFor(bindHost: string, token: string | null | undefined, extraHosts: readonly string[] = []): SecurityPolicy {
  const t = token ? token.trim() : "";
  if (t && t.length < 16) throw new SecurityConfigError("NG_DESK_TOKEN is too short: use at least 16 random characters (e.g. `openssl rand -hex 24`).");
  const loopback = isLoopbackHost(bindHost);
  if (!loopback && !t) {
    throw new SecurityConfigError(
      `Refusing to listen on ${bindHost}: a non-loopback address exposes the desk to the network. Set NG_DESK_TOKEN (bearer token) or bind 127.0.0.1.`,
    );
  }
  const hosts = new Set(["localhost", "127.0.0.1", "::1", ...extraHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)]);
  if (loopback && !["localhost", "127.0.0.1", "::1"].includes(bindHost.toLowerCase())) hosts.add(bindHost.toLowerCase());
  return { token: t || null, allowedHosts: loopback ? hosts : extraHosts.length ? hosts : null };
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
