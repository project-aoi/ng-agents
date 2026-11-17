import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isNgError, type Deliverable, type SendReceipt } from "@ng/protocol";
import type { DeliveryResult, HttpRequestLike, HttpResponseLike } from "./types";

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

// ==================== timeouts ====================

/** Default for the hub and for an adapter's direct `send`: long enough for slow APIs, short enough for a UI click. */
export const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/**
 * Runs one transport attempt with a deadline. A timeout aborts `signal` and yields `unknown` (the request may have
 * left); a throw yields `unknown` for the same reason. Adapters return `failed` themselves when they know nothing
 * was sent.
 */
export async function runWithTimeout(
  attempt: (signal: AbortSignal) => Promise<DeliveryResult>,
  timeoutMs: number,
): Promise<DeliveryResult> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DeliveryResult>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort(new Error(`send timed out after ${timeoutMs} ms`));
      resolve({ status: "unknown", error: `timeout: no answer within ${timeoutMs} ms` });
    }, timeoutMs);
  });
  const work = Promise.resolve()
    .then(() => attempt(ctrl.signal))
    .then(normalizeResult, (err: unknown) => ({ status: "unknown", error: `transport error: ${errorMessage(err)}` }) as DeliveryResult);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeResult(r: unknown): DeliveryResult {
  const v = r as Partial<DeliveryResult> | null | undefined;
  if (v?.status === "sent") return { status: "sent", externalId: (v as { externalId?: string | null }).externalId ?? null };
  if (v?.status === "failed" || v?.status === "unknown") {
    return { status: v.status, error: (v as { error?: string }).error || v.status };
  }
  return { status: "unknown", error: `adapter returned an invalid result: ${JSON.stringify(r)}` };
}

export function receiptToResult(receipt: SendReceipt): DeliveryResult {
  switch (receipt) {
    case "sent":
      return { status: "sent" };
    case "failed":
      return { status: "failed", error: "adapter reported failed" };
    case "unknown":
      return { status: "unknown", error: "adapter reported unknown" };
    default:
      // The hub already applied DND; an adapter that buffers on its own gives no delivery receipt we could trust.
      return { status: "unknown", error: "adapter buffered the message itself (respectDnd was false)" };
  }
}

// ==================== rendering ====================

/** Plain-text rendering of a Deliverable for text-only transports: title, body, then attachment links. */
export function renderText(content: Deliverable, opts: { title?: (title: string) => string } = {}): string {
  const parts: string[] = [];
  if (content.title) parts.push(opts.title ? opts.title(content.title) : content.title);
  if (content.body) parts.push(content.body);
  if (content.attachments?.length) parts.push(content.attachments.map((a) => `- ${a.label}: ${a.uri}`).join("\n"));
  return parts.join("\n\n");
}

// ==================== HTTP helpers ====================

export function headerOf(req: HttpRequestLike, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() !== want) continue;
    if (Array.isArray(v)) return v[0];
    return v;
  }
  return undefined;
}

export function rawBytes(req: HttpRequestLike): Buffer {
  return typeof req.rawBody === "string" ? Buffer.from(req.rawBody, "utf8") : Buffer.from(req.rawBody);
}

export function rawText(req: HttpRequestLike): string {
  return typeof req.rawBody === "string" ? req.rawBody : Buffer.from(req.rawBody).toString("utf8");
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function jsonResponse(status: number, body: unknown): HttpResponseLike {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
}

export function hmacSha256Hex(secret: string, ...parts: Array<string | Uint8Array>): string {
  const h = createHmac("sha256", secret);
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

export function sha256Hex(...parts: Array<string | Uint8Array>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

/** Constant-time string comparison (length is not secret). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * The hub could not durably accept the envelope: answer non-2xx so the sender redelivers (with the same transport
 * id, which the Inbox dedupes). 503 when no sink is wired yet, 500 otherwise.
 */
export function ingressFailureResponse(err: unknown): HttpResponseLike {
  const status = isNgError(err, "unsupported") ? 503 : 500;
  return jsonResponse(status, { error: "ingress_failed" });
}

/** A secret provider that returned nothing is a misconfiguration; refuse rather than accept unsigned traffic. */
export async function requireSecret(get: () => string | Promise<string>, what: string): Promise<string> {
  const v = await get();
  if (typeof v !== "string" || v.length === 0) throw new Error(`${what} is not configured`);
  return v;
}

/** Cuts text for error messages and envelope summaries. */
export function clip(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
