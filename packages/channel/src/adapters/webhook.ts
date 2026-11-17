import { CHANNEL_EVENT_TYPE, PAYLOAD, type ChannelCapabilities, type ChannelEventPayload, type Envelope, type UserMessagePayload } from "@ng/protocol";
import { BaseChannel, type BaseChannelOptions } from "../base";
import { httpJson, resolveAuth } from "../transport";
import type { DeliveryRequest, DeliveryResult, FetchLike, HttpChannelAdapter, HttpRequestLike, HttpResponseLike, SecretProvider } from "../types";
import {
  clip,
  errorMessage,
  headerOf,
  hmacSha256Hex,
  ingressFailureResponse,
  jsonResponse,
  parseJson,
  rawBytes,
  rawText,
  requireSecret,
  safeEqual,
  sha256Hex,
} from "../util";

/** What a webhook body turns into. Return `null` from `map` to acknowledge and drop it. */
export interface WebhookMapped {
  senderId?: string;
  type?: string;                        // default: `user.message` when `payload` is absent and `text` is given, else `channel.event`
  payload?: unknown;
  text?: string;
  threads?: string[];                   // external thread ids; namespaced as `<channelId>:<thread>`
  transportId?: string;
  replyTarget?: string;
}

export interface WebhookChannelOptions extends Partial<Pick<BaseChannelOptions, "clock" | "ownerIds" | "ownerPrincipal" | "sendTimeoutMs">> {
  id: string;
  /** Shared HMAC-SHA256 secret: verifies inbound bodies and signs outbound ones. */
  getSigningSecret: SecretProvider;
  /** Inbound/outbound signature header, value `sha256=<hex>` (bare hex accepted inbound). Default `x-signature-256`. */
  signatureHeader?: string;
  /** Header carrying the sender's stable delivery id. Default `idempotency-key`; falls back to body `id`, then a body hash. */
  idHeader?: string;
  /** Outbound endpoint (fixed, or per target). Without it the channel is inbound-only and sends fail. */
  url?: string | ((target: string) => string);
  fetch?: FetchLike;
  /** Extra outbound headers (e.g. Authorization), resolved per request. */
  getAuth?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Declare true only if the receiver really dedupes on `Idempotency-Key`. */
  receiverHonorsIdempotencyKey?: boolean;
  /** Sender id when the body names none. Default `webhook`. */
  defaultSenderId?: string;
  map?: (body: unknown, req: HttpRequestLike) => WebhookMapped | null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : undefined;
}

/**
 * Generic signed webhook. Inbound: HMAC-SHA256 over the raw body, compared in constant time; a body with `text`
 * becomes `user.message`, anything else `channel.event`. Outbound: JSON POST `{ target, idempotencyKey, content }`
 * with an `Idempotency-Key` header and the same signature header.
 */
export class WebhookChannel extends BaseChannel implements HttpChannelAdapter {
  readonly kind = "webhook";
  readonly capabilities: ChannelCapabilities;
  readonly #opts: WebhookChannelOptions;
  readonly #sigHeader: string;

  constructor(opts: WebhookChannelOptions) {
    super(opts);
    this.#opts = opts;
    this.#sigHeader = (opts.signatureHeader ?? "x-signature-256").toLowerCase();
    this.capabilities = { idempotentSend: opts.receiverHonorsIdempotencyKey === true, withdrawOrEdit: false, streamingPreview: false };
  }

  async handleRequest(req: HttpRequestLike): Promise<HttpResponseLike> {
    if (req.method.toUpperCase() !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
    let secret: string;
    try {
      secret = await requireSecret(this.#opts.getSigningSecret, "webhook signing secret");
    } catch (err) {
      this.noteError(errorMessage(err));
      return jsonResponse(503, { error: "not_configured" });
    }
    const given = headerOf(req, this.#sigHeader);
    if (!given) return jsonResponse(401, { error: "missing_signature" });
    const bytes = rawBytes(req);
    const hex = given.startsWith("sha256=") ? given.slice("sha256=".length) : given;
    if (!safeEqual(hex.toLowerCase(), hmacSha256Hex(secret, bytes))) return jsonResponse(401, { error: "bad_signature" });

    const body = parseJson(rawText(req));
    if (body === undefined) return jsonResponse(400, { error: "invalid_json" });
    const mapped = (this.#opts.map ?? ((b) => this.#defaultMap(b)))(body, req);
    if (!mapped) return jsonResponse(200, { ok: true, ignored: true });

    const transportId = mapped.transportId ?? headerOf(req, this.#opts.idHeader ?? "idempotency-key") ?? str((body as { id?: unknown } | null)?.id) ?? sha256Hex(bytes);
    const senderId = mapped.senderId ?? this.#opts.defaultSenderId ?? "webhook";
    const replyTo = this.addr(mapped.replyTarget ?? senderId);
    let type = mapped.type;
    let payload = mapped.payload;
    if (payload === undefined) {
      if (mapped.text !== undefined) {
        const p: UserMessagePayload = { text: mapped.text, replyTo, sender: { id: senderId } };
        type ??= PAYLOAD.userMessage;
        payload = p;
      } else {
        const p: ChannelEventPayload = { channelId: this.id, event: "webhook", summary: "webhook event", replyTo, sender: { id: senderId }, data: body };
        type ??= CHANNEL_EVENT_TYPE;
        payload = p;
      }
    }
    const env: Omit<Envelope, "to"> = {
      id: this.envelopeId(transportId),
      from: replyTo,
      principalId: this.principalFor(senderId),
      kind: "event",
      type: type ?? CHANNEL_EVENT_TYPE,
      payload,
      createdAt: this.clock.now(),
    };
    if (mapped.threads?.length) env.threads = mapped.threads.map((t) => this.thread(t));
    try {
      await this.emitIngress(env);
    } catch (err) {
      return ingressFailureResponse(err);
    }
    return jsonResponse(200, { ok: true, id: env.id });
  }

  #defaultMap(body: unknown): WebhookMapped {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const sender = b.sender as Record<string, unknown> | string | undefined;
    const senderId = typeof sender === "string" ? sender : str(sender?.id);
    const out: WebhookMapped = {};
    if (senderId) out.senderId = senderId;
    const thread = str(b.thread);
    if (thread) out.threads = [thread];
    if (typeof b.text === "string") {
      out.text = b.text;
      return out;
    }
    const sid = senderId ?? this.#opts.defaultSenderId ?? "webhook";
    const p: ChannelEventPayload = {
      channelId: this.id,
      event: str(b.event) ?? str(b.type) ?? "webhook",
      summary: clip(str(b.summary) ?? str(b.title) ?? "webhook event", 300),
      replyTo: this.addr(sid),
      sender: { id: sid },
      data: body,
    };
    const action = str(b.action);
    if (action) p.action = action;
    const url = str(b.url);
    if (url) p.url = url;
    out.type = CHANNEL_EVENT_TYPE;
    out.payload = p;
    return out;
  }

  protected async transmit(req: DeliveryRequest): Promise<DeliveryResult> {
    const { url } = this.#opts;
    if (!url) return { status: "failed", error: `webhook channel "${this.id}" has no outbound url` };
    const fetchFn = this.#opts.fetch ?? fetch;
    const auth = await resolveAuth(async () => {
      const [secret, extra] = await Promise.all([requireSecret(this.#opts.getSigningSecret, "webhook signing secret"), this.#opts.getAuth?.() ?? {}]);
      return { secret, extra };
    });
    if (!auth.ok) return auth.result;
    const rawBody = JSON.stringify({ target: req.target, idempotencyKey: req.idempotencyKey, content: req.content });
    const res = await httpJson(fetchFn, {
      url: typeof url === "function" ? url(req.target) : url,
      method: "POST",
      headers: {
        ...auth.value.extra,
        "idempotency-key": req.idempotencyKey,
        [this.#sigHeader]: `sha256=${hmacSha256Hex(auth.value.secret, rawBody)}`,
      },
      rawBody,
      signal: req.signal,
    });
    if (!res.ok) return res.result;
    const id = str((res.json as { id?: unknown } | undefined)?.id);
    return { status: "sent", externalId: id ?? null };
  }
}
