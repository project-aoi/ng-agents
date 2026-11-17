import { createDecipheriv, createHash } from "node:crypto";
import { PAYLOAD, type Envelope, type UserMessagePayload } from "@ng/protocol";
import { BaseChannel, type BaseChannelOptions } from "../base";
import { bearer, httpJson, resolveAuth } from "../transport";
import type { DeliveryRequest, DeliveryResult, EditRequest, FetchLike, HttpChannelAdapter, HttpRequestLike, HttpResponseLike, SecretProvider } from "../types";
import {
  errorMessage,
  headerOf,
  ingressFailureResponse,
  jsonResponse,
  parseJson,
  rawText,
  renderText,
  requireSecret,
  safeEqual,
  sha256Hex,
} from "../util";

export interface FeishuChannelOptions extends Partial<Pick<BaseChannelOptions, "id" | "clock" | "ownerIds" | "ownerPrincipal" | "sendTimeoutMs">> {
  /** Verification Token from the app's event subscription page (checked on every callback). */
  getVerificationToken: SecretProvider;
  /** Encrypt Key, when configured on the app: bodies arrive encrypted and callbacks carry `X-Lark-Signature`. */
  getEncryptKey?: SecretProvider;
  /** tenant_access_token provider for the IM API, resolved per request. */
  getAuth?: SecretProvider;
  fetch?: FetchLike;
  apiBase?: string;                     // default https://open.feishu.cn/open-apis (Lark: https://open.larksuite.com/open-apis)
  replayWindowSec?: number;             // default 300
}

type Json = Record<string, unknown>;
function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}
function s(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** AES-256-CBC with key = sha256(encryptKey); the first 16 bytes of the base64 payload are the IV. */
export function feishuDecrypt(encrypted: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const buf = Buffer.from(encrypted, "base64");
  const decipher = createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString("utf8");
}

/** `X-Lark-Signature` = sha256(timestamp + nonce + encryptKey + body), hex. */
export function feishuSignature(timestamp: string, nonce: string, encryptKey: string, body: string): string {
  return sha256Hex(timestamp, nonce, encryptKey, body);
}

/** Feishu dedupes requests carrying the same `uuid` for one hour; it accepts at most 50 characters. */
export function feishuUuid(idempotencyKey: string): string {
  return idempotencyKey.length <= 50 ? idempotencyKey : sha256Hex(idempotencyKey).slice(0, 50);
}

function messageText(type: string | undefined, content: string | undefined, mentions: unknown): string {
  const c = obj(parseJson(content ?? ""));
  if (type === "text") {
    let text = s(c.text) ?? "";
    if (Array.isArray(mentions)) {
      for (const m of mentions) {
        const key = s(obj(m).key);
        if (key) text = text.split(key).join(`@${s(obj(m).name) ?? ""}`);
      }
    }
    return text;
  }
  if (type === "post") {
    const post = Array.isArray(c.content) ? c : obj(c.zh_cn ?? c.en_us ?? Object.values(c)[0]);
    const lines: string[] = [];
    if (s(post.title)) lines.push(s(post.title)!);
    if (Array.isArray(post.content)) {
      for (const para of post.content) {
        if (!Array.isArray(para)) continue;
        lines.push(para.map((el) => s(obj(el).text) ?? (obj(el).tag === "at" ? `@${s(obj(el).user_name) ?? ""}` : "")).join(""));
      }
    }
    return lines.join("\n");
  }
  return `[${type ?? "message"}]`;
}

/**
 * Feishu / Lark event callback v2. Inbound: URL challenge, Verification Token check, and — with an Encrypt Key —
 * decryption plus `X-Lark-Signature` (with a replay window). `im.message.receive_v1` from a user becomes
 * `user.message` with `threads: ["<id>:<chat_id>", "<id>:<chat_id>:<root message id>"]` (a message with no root is
 * its own root). Outbound target: `<chat_id>` (or `ou_…` open_id / `on_…` union_id) → im/v1/messages;
 * `<chat_id>:<message_id>` → reply to that message. Every send carries `uuid` (Feishu's one-hour idempotency).
 */
export class FeishuChannel extends BaseChannel implements HttpChannelAdapter {
  readonly kind = "feishu";
  // `uuid` dedupes for one hour; messages can be edited (text/post) and recalled.
  readonly capabilities = { idempotentSend: true, withdrawOrEdit: true, streamingPreview: false } as const;
  readonly #opts: FeishuChannelOptions;

  constructor(opts: FeishuChannelOptions) {
    super({ ...opts, id: opts.id ?? "feishu" });
    this.#opts = opts;
  }

  async handleRequest(req: HttpRequestLike): Promise<HttpResponseLike> {
    if (req.method.toUpperCase() !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
    let token: string;
    let encryptKey: string | undefined;
    try {
      token = await requireSecret(this.#opts.getVerificationToken, "Feishu verification token");
      if (this.#opts.getEncryptKey) encryptKey = await requireSecret(this.#opts.getEncryptKey, "Feishu encrypt key");
    } catch (err) {
      this.noteError(errorMessage(err));
      return jsonResponse(503, { error: "not_configured" });
    }
    const raw = rawText(req);
    const outer = obj(parseJson(raw));
    let body = outer;
    if (encryptKey !== undefined) {
      const enc = s(outer.encrypt);
      if (!enc) return jsonResponse(401, { error: "expected_encrypted_body" });
      try {
        body = obj(JSON.parse(feishuDecrypt(enc, encryptKey)));
      } catch {
        return jsonResponse(401, { error: "decrypt_failed" });
      }
    } else if (outer.encrypt !== undefined) {
      return jsonResponse(400, { error: "encrypted_body_without_key" });
    }

    if (body.type === "url_verification") {
      if (!safeEqual(s(body.token) ?? "", token)) return jsonResponse(401, { error: "bad_token" });
      return jsonResponse(200, { challenge: s(body.challenge) ?? "" });
    }

    if (encryptKey !== undefined) {
      const ts = headerOf(req, "x-lark-request-timestamp");
      const nonce = headerOf(req, "x-lark-request-nonce");
      const sig = headerOf(req, "x-lark-signature");
      if (!ts || !nonce || !sig) return jsonResponse(401, { error: "missing_signature" });
      const tsNum = Number(ts);
      if (!Number.isFinite(tsNum) || Math.abs(this.clock.now() / 1000 - tsNum) > (this.#opts.replayWindowSec ?? 300)) {
        return jsonResponse(401, { error: "stale_timestamp" });
      }
      if (!safeEqual(sig.toLowerCase(), feishuSignature(ts, nonce, encryptKey, raw))) return jsonResponse(401, { error: "bad_signature" });
    }

    if (body.schema !== "2.0") {
      // v1 callbacks are not subscribed by this adapter; acknowledge after the token check so Feishu stops retrying.
      if (!safeEqual(s(body.token) ?? "", token)) return jsonResponse(401, { error: "bad_token" });
      return jsonResponse(200, { ok: true, ignored: true });
    }
    const header = obj(body.header);
    if (!safeEqual(s(header.token) ?? "", token)) return jsonResponse(401, { error: "bad_token" });
    if (header.event_type !== "im.message.receive_v1") return jsonResponse(200, { ok: true, ignored: true });

    const event = obj(body.event);
    const sender = obj(event.sender);
    if (sender.sender_type !== "user") return jsonResponse(200, { ok: true, ignored: true });
    const openId = s(obj(sender.sender_id).open_id);
    const msg = obj(event.message);
    const messageId = s(msg.message_id);
    const chatId = s(msg.chat_id);
    if (!openId || !messageId || !chatId) return jsonResponse(200, { ok: true, ignored: true });
    const rootId = s(msg.root_id) ?? messageId;
    const chatType = s(msg.chat_type);
    // In a group, answer in the message's reply chain; in a 1:1 chat, just post to the chat.
    const replyTo = this.addr(chatType === "p2p" ? chatId : `${chatId}:${rootId}`);
    const payload: UserMessagePayload = {
      text: messageText(s(msg.message_type), s(msg.content), msg.mentions),
      replyTo,
      sender: { id: openId },
      raw: { event: "im.message.receive_v1", messageId, rootId: s(msg.root_id), parentId: s(msg.parent_id), chatId, chatType, messageType: s(msg.message_type), eventId: s(header.event_id) },
    };
    const env: Omit<Envelope, "to"> = {
      id: this.envelopeId(messageId),
      from: replyTo,
      principalId: this.principalFor(openId),
      kind: "event",
      type: PAYLOAD.userMessage,
      payload,
      threads: [this.thread(chatId), this.thread(`${chatId}:${rootId}`)],
      createdAt: this.clock.now(),
    };
    try {
      await this.emitIngress(env);
    } catch (err) {
      return ingressFailureResponse(err);
    }
    return jsonResponse(200, { ok: true, id: env.id });
  }

  #base(): string {
    return (this.#opts.apiBase ?? "https://open.feishu.cn/open-apis").replace(/\/+$/, "");
  }

  async #call(url: string, method: "POST" | "PUT", body: Json, signal: AbortSignal): Promise<DeliveryResult> {
    const get = this.#opts.getAuth;
    if (!get) return { status: "failed", error: "no Feishu tenant token provider configured" };
    const token = await resolveAuth(() => requireSecret(get, "Feishu tenant access token"));
    if (!token.ok) return token.result;
    const res = await httpJson(this.#opts.fetch ?? fetch, { url, method, headers: bearer(token.value), body, signal });
    if (!res.ok) return res.result;
    const json = obj(res.json);
    if (json.code !== 0) return { status: "failed", error: `feishu code ${String(json.code)}: ${s(json.msg) ?? "error"}` };
    return { status: "sent", externalId: s(obj(json.data).message_id) ?? null };
  }

  protected async transmit(req: DeliveryRequest): Promise<DeliveryResult> {
    const i = req.target.indexOf(":");
    const receiveId = i < 0 ? req.target : req.target.slice(0, i);
    const replyToMessage = i < 0 ? undefined : req.target.slice(i + 1);
    if (!receiveId) return { status: "failed", error: `invalid Feishu target "${req.target}"` };
    const content = JSON.stringify({ text: renderText(req.content) });
    const uuid = feishuUuid(req.idempotencyKey);
    if (replyToMessage) {
      return this.#call(`${this.#base()}/im/v1/messages/${encodeURIComponent(replyToMessage)}/reply`, "POST",
        { msg_type: "text", content, uuid }, req.signal);
    }
    const idType = receiveId.startsWith("ou_") ? "open_id" : receiveId.startsWith("on_") ? "union_id" : "chat_id";
    return this.#call(`${this.#base()}/im/v1/messages?receive_id_type=${idType}`, "POST",
      { receive_id: receiveId, msg_type: "text", content, uuid }, req.signal);
  }

  async edit(req: EditRequest): Promise<DeliveryResult> {
    const r = await this.#call(`${this.#base()}/im/v1/messages/${encodeURIComponent(req.externalId)}`, "PUT",
      { msg_type: "text", content: JSON.stringify({ text: renderText(req.content) }) }, req.signal);
    return r.status === "sent" ? { status: "sent" } : r;
  }
}
