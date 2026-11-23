import { isIP } from "node:net";

// The desk has no accounts and no tokens: whoever reaches the port operates the workbench (proposal 07). It binds to
// loopback by default, and the guards here only keep web pages in the owner's browser from driving it: cross-site
// writes are rejected, and so are foreign Host headers (DNS rebinding) on a loopback bind or wherever
// NG_DESK_ALLOWED_HOSTS names the accepted ones.

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  if (isIP(h) === 6) return h === "::1" || h === "0:0:0:0:0:0:0:1" || h.startsWith("::ffff:127.");
  return false;
}

export interface SecurityPolicy {
  /** Host header names accepted (lowercase, no port). null = any. */
  allowedHosts: ReadonlySet<string> | null;
  /** The desk is bound to a loopback address. */
  loopback: boolean;
}

/** A loopback bind accepts its own names and `extraHosts`; any other bind accepts every Host unless `extraHosts` names the accepted ones. */
export function securityPolicyFor(bindHost: string, extraHosts: readonly string[] = []): SecurityPolicy {
  const loopback = isLoopbackHost(bindHost);
  const hosts = new Set(["localhost", "127.0.0.1", "::1", ...extraHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)]);
  if (loopback && !["localhost", "127.0.0.1", "::1"].includes(bindHost.toLowerCase())) hosts.add(bindHost.toLowerCase());
  return { allowedHosts: loopback ? hosts : extraHosts.length ? hosts : null, loopback };
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
