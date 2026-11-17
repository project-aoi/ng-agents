import type { DeliveryResult, FetchLike } from "./types";
import { clip, errorMessage, parseJson } from "./util";

/** Error codes raised before any byte of the request reached the server: the message was definitely not sent. */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_INVALID_URL",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_INVALID_ARG",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function errorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface HttpCall {
  url: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  headers: Record<string, string>;
  body?: unknown;                       // JSON-serialized when present
  rawBody?: string;                     // already-serialized JSON (when the bytes must match a signature)
  signal: AbortSignal;
}

export type HttpOutcome =
  | { ok: true; status: number; text: string; json: unknown }
  | { ok: false; result: DeliveryResult };

/**
 * One outbound JSON request with honest failure classification: connection-level errors before sending → `failed`;
 * abort/timeout or a reset after the request left → `unknown`; 4xx → `failed` (the server refused it);
 * 5xx and anything else non-2xx → `unknown` (the server may have acted before failing).
 */
export async function httpJson(fetchFn: FetchLike, call: HttpCall): Promise<HttpOutcome> {
  const headers: Record<string, string> = { ...call.headers };
  const body = call.rawBody ?? (call.body !== undefined ? JSON.stringify(call.body) : undefined);
  if (body !== undefined) headers["content-type"] ??= "application/json; charset=utf-8";
  let res: Response;
  try {
    const init: RequestInit = { method: call.method, headers, signal: call.signal };
    if (body !== undefined) init.body = body;
    res = await fetchFn(call.url, init);
  } catch (err) {
    if (call.signal.aborted) return { ok: false, result: { status: "unknown", error: `aborted: ${errorMessage(call.signal.reason ?? err)}` } };
    const code = errorCode(err);
    if (code && NOT_SENT_CODES.has(code)) return { ok: false, result: { status: "failed", error: `not sent (${code}): ${errorMessage(err)}` } };
    return { ok: false, result: { status: "unknown", error: `transport error${code ? ` (${code})` : ""}: ${errorMessage(err)}` } };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // Status line arrived, body did not: for 2xx the server accepted the request, but we cannot read its answer.
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, text: "", json: undefined };
    return { ok: false, result: { status: "unknown", error: `HTTP ${res.status}, body unreadable: ${errorMessage(err)}` } };
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, text, json: parseJson(text) };
  const detail = `HTTP ${res.status}: ${clip(text, 200)}`;
  if (res.status >= 400 && res.status < 500) return { ok: false, result: { status: "failed", error: detail } };
  return { ok: false, result: { status: "unknown", error: detail } };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Resolves an auth callback; a failure here means nothing was sent. */
export async function resolveAuth<T>(get: () => T | Promise<T>): Promise<{ ok: true; value: T } | { ok: false; result: DeliveryResult }> {
  try {
    return { ok: true, value: await get() };
  } catch (err) {
    return { ok: false, result: { status: "failed", error: `auth unavailable: ${errorMessage(err)}` } };
  }
}
