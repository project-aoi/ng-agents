import { CHANNEL_EVENT_TYPE, PAYLOAD, type ChannelAddr, type ChannelEventPayload, type Envelope, type UserMessagePayload } from "@ng/protocol";
import { BaseChannel, type BaseChannelOptions } from "../base";
import { bearer, httpJson, resolveAuth } from "../transport";
import type { DeliveryRequest, DeliveryResult, EditRequest, FetchLike, HttpChannelAdapter, HttpRequestLike, HttpResponseLike, SecretProvider } from "../types";
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
  renderText,
  requireSecret,
  safeEqual,
} from "../util";

export interface GithubChannelOptions extends Partial<Pick<BaseChannelOptions, "id" | "clock" | "ownerIds" | "ownerPrincipal" | "sendTimeoutMs">> {
  /** Webhook secret for `X-Hub-Signature-256`. */
  getWebhookSecret: SecretProvider;
  /** Token for the REST API (installation token or PAT), resolved per request. */
  getAuth?: SecretProvider;
  fetch?: FetchLike;
  apiBase?: string;                     // default https://api.github.com
  /** Our own bot/app logins: comments, reviews and PR events they cause are dropped so a reply never wakes us again. */
  ignoreLogins?: readonly string[];
  userAgent?: string;
}

type Json = Record<string, unknown>;
const TARGET = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}
function s(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function n(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

interface Mapped {
  type: string;
  payload: unknown;
  issue?: number;                       // the issue/PR the reply goes to
  threadNumbers: number[];
}

/**
 * GitHub App / repository webhooks. Inbound: `X-Hub-Signature-256` HMAC over the raw body, transport id from
 * `X-GitHub-Delivery`; issue_comment and pull_request_review become `user.message`, pull_request / check_suite /
 * workflow_run become `channel.event`, each with `threads: ["<id>:<owner>/<repo>#<n>"]`.
 * Outbound: target `<owner>/<repo>#<n>` → issue/PR comment; edit = PATCH of that comment.
 */
export class GithubChannel extends BaseChannel implements HttpChannelAdapter {
  readonly kind = "github";
  // GitHub has no idempotency key for comments; editing and deleting comments is supported.
  readonly capabilities = { idempotentSend: false, withdrawOrEdit: true, streamingPreview: false } as const;
  readonly #opts: GithubChannelOptions;
  readonly #ignore: ReadonlySet<string>;

  constructor(opts: GithubChannelOptions) {
    super({ ...opts, id: opts.id ?? "github" });
    this.#opts = opts;
    this.#ignore = new Set((opts.ignoreLogins ?? []).map((l) => l.toLowerCase()));
  }

  async handleRequest(req: HttpRequestLike): Promise<HttpResponseLike> {
    if (req.method.toUpperCase() !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
    let secret: string;
    try {
      secret = await requireSecret(this.#opts.getWebhookSecret, "GitHub webhook secret");
    } catch (err) {
      this.noteError(errorMessage(err));
      return jsonResponse(503, { error: "not_configured" });
    }
    const sig = headerOf(req, "x-hub-signature-256");
    if (!sig?.startsWith("sha256=")) return jsonResponse(401, { error: "missing_signature" });
    if (!safeEqual(sig.slice("sha256=".length).toLowerCase(), hmacSha256Hex(secret, rawBytes(req)))) {
      return jsonResponse(401, { error: "bad_signature" });
    }
    const event = headerOf(req, "x-github-event");
    const delivery = headerOf(req, "x-github-delivery");
    if (!event || !delivery) return jsonResponse(400, { error: "missing_event_headers" });
    if (event === "ping") return jsonResponse(200, { ok: true, pong: true });
    const body = parseJson(rawText(req));
    if (body === undefined || typeof body !== "object") return jsonResponse(400, { error: "invalid_json" });

    const b = obj(body);
    const repo = s(obj(b.repository).full_name);
    const login = s(obj(b.sender).login) ?? "unknown";
    if (!repo) return jsonResponse(200, { ok: true, ignored: true });
    const mapped = this.#map(event, b, repo, login);
    if (!mapped) return jsonResponse(200, { ok: true, ignored: true });

    const replyTo: ChannelAddr = this.addr(mapped.issue !== undefined ? `${repo}#${mapped.issue}` : repo);
    const env: Omit<Envelope, "to"> = {
      id: this.envelopeId(delivery),
      from: replyTo,
      principalId: this.principalFor(login),
      kind: "event",
      type: mapped.type,
      payload: mapped.payload,
      createdAt: this.clock.now(),
    };
    const threads = [...new Set(mapped.threadNumbers)].map((num) => this.thread(`${repo}#${num}`));
    if (threads.length) env.threads = threads;
    try {
      await this.emitIngress(env);
    } catch (err) {
      return ingressFailureResponse(err);
    }
    return jsonResponse(200, { ok: true, id: env.id });
  }

  #isSelf(login: string): boolean {
    return this.#ignore.has(login.toLowerCase());
  }

  #map(event: string, b: Json, repo: string, login: string): Mapped | null {
    const action = s(b.action);
    const sender = { id: login };
    const ev = (number: number | undefined, summary: string, url: string | undefined, data: Json): ChannelEventPayload => {
      const p: ChannelEventPayload = { channelId: this.id, event, summary: clip(summary), sender, data };
      if (action) p.action = action;
      if (url) p.url = url;
      p.replyTo = this.addr(number !== undefined ? `${repo}#${number}` : repo);
      return p;
    };

    switch (event) {
      case "issue_comment": {
        if (action !== "created" || this.#isSelf(login)) return null;
        const issue = obj(b.issue);
        const comment = obj(b.comment);
        const number = n(issue.number);
        if (number === undefined) return null;
        const payload: UserMessagePayload = {
          text: s(comment.body) ?? "",
          replyTo: this.addr(`${repo}#${number}`),
          sender,
          raw: { event, action, repo, number, title: s(issue.title), isPullRequest: issue.pull_request !== undefined, url: s(comment.html_url), commentId: n(comment.id) },
        };
        return { type: PAYLOAD.userMessage, payload, issue: number, threadNumbers: [number] };
      }
      case "pull_request_review": {
        if (action !== "submitted" || this.#isSelf(login)) return null;
        const review = obj(b.review);
        const pr = obj(b.pull_request);
        const number = n(pr.number);
        if (number === undefined) return null;
        const state = s(review.state)?.toLowerCase() ?? "commented";
        const body = s(review.body)?.trim();
        const payload: UserMessagePayload = {
          text: body ? body : `[review: ${state}]`,
          replyTo: this.addr(`${repo}#${number}`),
          sender,
          raw: { event, action, repo, number, title: s(pr.title), reviewState: state, url: s(review.html_url) },
        };
        return { type: PAYLOAD.userMessage, payload, issue: number, threadNumbers: [number] };
      }
      case "pull_request": {
        if (this.#isSelf(login)) return null;
        const pr = obj(b.pull_request);
        const number = n(pr.number);
        if (number === undefined) return null;
        const merged = pr.merged === true;
        const verb = action === "closed" && merged ? "merged" : (action ?? "updated");
        const head = obj(pr.head);
        const base = obj(pr.base);
        const payload = ev(number, `PR #${number} ${verb}: ${s(pr.title) ?? ""}`, s(pr.html_url), {
          repo, number, title: s(pr.title), state: s(pr.state), merged, draft: pr.draft === true,
          headRef: s(head.ref), headSha: s(head.sha), baseRef: s(base.ref),
        });
        return { type: CHANNEL_EVENT_TYPE, payload, issue: number, threadNumbers: [number] };
      }
      case "check_suite": {
        const suite = obj(b.check_suite);
        const prs = prNumbers(suite.pull_requests);
        const sha = s(suite.head_sha) ?? "";
        const outcome = s(suite.conclusion) ?? s(suite.status) ?? action ?? "updated";
        const repoUrl = s(obj(b.repository).html_url);
        const payload = ev(prs[0], `Checks ${outcome} on ${s(suite.head_branch) ?? sha.slice(0, 7)} (${sha.slice(0, 7)})`,
          repoUrl && sha ? `${repoUrl}/commit/${sha}` : undefined, {
            repo, status: s(suite.status), conclusion: s(suite.conclusion) ?? null, headBranch: s(suite.head_branch), headSha: sha,
            app: s(obj(suite.app).slug), pullRequests: prs,
          });
        const out: Mapped = { type: CHANNEL_EVENT_TYPE, payload, threadNumbers: prs };
        if (prs[0] !== undefined) out.issue = prs[0];
        return out;
      }
      case "workflow_run": {
        const runObj = obj(b.workflow_run);
        const prs = prNumbers(runObj.pull_requests);
        const outcome = s(runObj.conclusion) ?? s(runObj.status) ?? action ?? "updated";
        const name = s(runObj.name) ?? s(obj(b.workflow).name) ?? "workflow";
        const payload = ev(prs[0], `Workflow "${name}" ${outcome} on ${s(runObj.head_branch) ?? "?"}`, s(runObj.html_url), {
          repo, name, runId: n(runObj.id), runNumber: n(runObj.run_number), status: s(runObj.status),
          conclusion: s(runObj.conclusion) ?? null, headBranch: s(runObj.head_branch), headSha: s(runObj.head_sha),
          trigger: s(runObj.event), pullRequests: prs,
        });
        const out: Mapped = { type: CHANNEL_EVENT_TYPE, payload, threadNumbers: prs };
        if (prs[0] !== undefined) out.issue = prs[0];
        return out;
      }
      default:
        return null;
    }
  }

  #headers(token: string): Record<string, string> {
    return {
      ...bearer(token),
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": this.#opts.userAgent ?? "ng-agents",
    };
  }

  #base(): string {
    return (this.#opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  }

  async #token(): Promise<{ ok: true; value: string } | { ok: false; result: DeliveryResult }> {
    const get = this.#opts.getAuth;
    if (!get) return { ok: false, result: { status: "failed", error: "no GitHub token provider configured" } };
    return resolveAuth(() => requireSecret(get, "GitHub token"));
  }

  protected async transmit(req: DeliveryRequest): Promise<DeliveryResult> {
    const m = TARGET.exec(req.target);
    if (!m) return { status: "failed", error: `invalid GitHub target "${req.target}" (want <owner>/<repo>#<number>)` };
    const token = await this.#token();
    if (!token.ok) return token.result;
    const res = await httpJson(this.#opts.fetch ?? fetch, {
      url: `${this.#base()}/repos/${m[1]}/${m[2]}/issues/${m[3]}/comments`,
      method: "POST",
      headers: this.#headers(token.value),
      body: { body: renderText(req.content, { title: (t) => `**${t}**` }) },
      signal: req.signal,
    });
    if (!res.ok) return res.result;
    const id = obj(res.json).id;
    return { status: "sent", externalId: typeof id === "number" || typeof id === "string" ? String(id) : null };
  }

  async edit(req: EditRequest): Promise<DeliveryResult> {
    const m = TARGET.exec(req.target);
    if (!m) return { status: "failed", error: `invalid GitHub target "${req.target}"` };
    const token = await this.#token();
    if (!token.ok) return token.result;
    const res = await httpJson(this.#opts.fetch ?? fetch, {
      url: `${this.#base()}/repos/${m[1]}/${m[2]}/issues/comments/${encodeURIComponent(req.externalId)}`,
      method: "PATCH",
      headers: this.#headers(token.value),
      body: { body: renderText(req.content, { title: (t) => `**${t}**` }) },
      signal: req.signal,
    });
    return res.ok ? { status: "sent" } : res.result;
  }
}

function prNumbers(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const pr of v) {
    const num = n(obj(pr).number);
    if (num !== undefined) out.push(num);
  }
  return out;
}
