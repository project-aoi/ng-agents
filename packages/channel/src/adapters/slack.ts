import { PAYLOAD, type Envelope, type UserMessagePayload } from "@ng/protocol";
import { BaseChannel, type BaseChannelOptions } from "../base";
import { bearer, httpJson, resolveAuth } from "../transport";
import type { DeliveryRequest, DeliveryResult, EditRequest, FetchLike, HttpChannelAdapter, HttpRequestLike, HttpResponseLike, SecretProvider } from "../types";
import {
  errorMessage,
  headerOf,
  hmacSha256Hex,
  ingressFailureResponse,
  jsonResponse,
  parseJson,
  rawBytes,
  rawText,
  renderText,
  requireSecret,
  safeEqual,
} from "../util";

export interface SlackChannelOptions extends Partial<Pick<BaseChannelOptions, "id" | "clock" | "ownerIds" | "ownerPrincipal" | "sendTimeoutMs">> {
  /** App signing secret for `X-Slack-Signature` (v0). */
  getSigningSecret: SecretProvider;
  /** Bot token (xoxb-…) for chat.postMessage / chat.update, resolved per request. */
  getAuth?: SecretProvider;
  fetch?: FetchLike;
  apiBase?: string;                     // default https://slack.com/api
  /** Our bot's user id / bot id. Events from them (and from our own app id) are ignored. */
  botUserId?: string;
  botId?: string;
  /** Requests whose timestamp is further than this from now are rejected as replays. Default 300 s. */
  replayWindowSec?: number;
}

type Json = Record<string, unknown>;
function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}
function s(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const AMBIGUOUS_ERRORS = new Set(["fatal_error", "internal_error"]);

/** Message subtypes that are still a person speaking; everything else (edits, deletes, joins, bot_message) is dropped. */
const HUMAN_SUBTYPES = new Set(["thread_broadcast", "file_share", "me_message"]);

/**
 * Slack Events API. Inbound: v0 signature over `v0:<timestamp>:<body>` with a replay window, `url_verification`,
 * `message` / `app_mention` events → `user.message` with `threads: ["<id>:<channel>:<thread_ts>"]` (a top-level
 * message is its own thread root). The envelope id is `<id>:<channel>:<ts>`, so a retried delivery and the
 * message+app_mention pair for one message dedupe in the Inbox. Our own bot's messages are ignored.
 * Outbound target: `<channel>` or `<channel>:<thread_ts>` → chat.postMessage (in-thread); edit → chat.update.
 */
export class SlackChannel extends BaseChannel implements HttpChannelAdapter {
  readonly kind = "slack";
  // chat.postMessage has no idempotency key; chat.update / chat.delete exist.
  readonly capabilities = { idempotentSend: false, withdrawOrEdit: true, streamingPreview: false } as const;
  readonly #opts: SlackChannelOptions;

  constructor(opts: SlackChannelOptions) {
    super({ ...opts, id: opts.id ?? "slack" });
    this.#opts = opts;
  }

  async handleRequest(req: HttpRequestLike): Promise<HttpResponseLike> {
    if (req.method.toUpperCase() !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
    let secret: string;
    try {
      secret = await requireSecret(this.#opts.getSigningSecret, "Slack signing secret");
    } catch (err) {
      this.noteError(errorMessage(err));
      return jsonResponse(503, { error: "not_configured" });
    }
    const ts = headerOf(req, "x-slack-request-timestamp");
    const sig = headerOf(req, "x-slack-signature");
    if (!ts || !sig) return jsonResponse(401, { error: "missing_signature" });
    const tsNum = Number(ts);
    const windowSec = this.#opts.replayWindowSec ?? 300;
    if (!Number.isFinite(tsNum) || Math.abs(this.clock.now() / 1000 - tsNum) > windowSec) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }
    const expected = `v0=${hmacSha256Hex(secret, `v0:${ts}:`, rawBytes(req))}`;
    if (!safeEqual(sig.toLowerCase(), expected)) return jsonResponse(401, { error: "bad_signature" });

    const body = obj(parseJson(rawText(req)));
    if (body.type === "url_verification") return jsonResponse(200, { challenge: s(body.challenge) ?? "" });
    if (body.type !== "event_callback") return jsonResponse(200, { ok: true, ignored: true });
    const event = obj(body.event);
    if (event.type !== "message" && event.type !== "app_mention") return jsonResponse(200, { ok: true, ignored: true });
    const subtype = s(event.subtype);
    if (subtype && !HUMAN_SUBTYPES.has(subtype)) return jsonResponse(200, { ok: true, ignored: true });
    if (this.#isSelf(body, event)) return jsonResponse(200, { ok: true, ignored: true });

    const channel = s(event.channel);
    const msgTs = s(event.ts);
    const user = s(event.user);
    if (!channel || !msgTs || !user) return jsonResponse(200, { ok: true, ignored: true });
    const root = s(event.thread_ts) ?? msgTs;
    const replyTo = this.addr(`${channel}:${root}`);
    const payload: UserMessagePayload = {
      text: s(event.text) ?? "",
      replyTo,
      sender: { id: user },
      raw: { event: event.type, team: s(body.team_id), channel, ts: msgTs, threadTs: root, channelType: s(event.channel_type), eventId: s(body.event_id) },
    };
    const env: Omit<Envelope, "to"> = {
      id: this.envelopeId(`${channel}:${msgTs}`),
      from: replyTo,
      principalId: this.principalFor(user),
      kind: "event",
      type: PAYLOAD.userMessage,
      payload,
      threads: [this.thread(`${channel}:${root}`)],
      createdAt: this.clock.now(),
    };
    try {
      await this.emitIngress(env);
    } catch (err) {
      return ingressFailureResponse(err);
    }
    return jsonResponse(200, { ok: true, id: env.id });
  }

  #isSelf(body: Json, event: Json): boolean {
    const { botUserId, botId } = this.#opts;
    if (botId && event.bot_id === botId) return true;
    if (botUserId && event.user === botUserId) return true;
    const appId = s(body.api_app_id);
    if (appId && (event.app_id === appId || obj(event.bot_profile).app_id === appId)) return true;
    if (Array.isArray(body.authorizations)) {
      for (const a of body.authorizations) {
        const auth = obj(a);
        if (auth.is_bot === true && auth.user_id !== undefined && auth.user_id === event.user) return true;
      }
    }
    return false;
  }

  #split(target: string): { channel: string; threadTs?: string } {
    const i = target.indexOf(":");
    return i < 0 ? { channel: target } : { channel: target.slice(0, i), threadTs: target.slice(i + 1) };
  }

  async #call(method: string, body: Json, signal: AbortSignal): Promise<DeliveryResult> {
    const get = this.#opts.getAuth;
    if (!get) return { status: "failed", error: "no Slack bot token provider configured" };
    const token = await resolveAuth(() => requireSecret(get, "Slack bot token"));
    if (!token.ok) return token.result;
    const base = (this.#opts.apiBase ?? "https://slack.com/api").replace(/\/+$/, "");
    const res = await httpJson(this.#opts.fetch ?? fetch, { url: `${base}/${method}`, method: "POST", headers: bearer(token.value), body, signal });
    if (!res.ok) return res.result;
    const json = obj(res.json);
    if (json.ok !== true) {
      const code = s(json.error) ?? "ok=false";
      // Slack documents these two as "some aspect of the operation may have succeeded"; the rest are refusals.
      const status = AMBIGUOUS_ERRORS.has(code) ? "unknown" : "failed";
      return { status, error: `slack ${method}: ${code}` };
    }
    return { status: "sent", externalId: s(json.ts) ?? null };
  }

  protected async transmit(req: DeliveryRequest): Promise<DeliveryResult> {
    const { channel, threadTs } = this.#split(req.target);
    if (!channel) return { status: "failed", error: `invalid Slack target "${req.target}"` };
    const body: Json = { channel, text: renderText(req.content, { title: (t) => `*${t}*` }) };
    if (threadTs) body.thread_ts = threadTs;
    return this.#call("chat.postMessage", body, req.signal);
  }

  async edit(req: EditRequest): Promise<DeliveryResult> {
    const { channel } = this.#split(req.target);
    const r = await this.#call("chat.update", { channel, ts: req.externalId, text: renderText(req.content, { title: (t) => `*${t}*` }) }, req.signal);
    return r.status === "sent" ? { status: "sent" } : r;
  }
}
