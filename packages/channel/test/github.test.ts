import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatePayload, type ChannelEventPayload, type UserMessagePayload } from "@ng/protocol";
import { GithubChannel, type GithubChannelOptions } from "../src";
import { fakeFetch, json, setup, text } from "./helpers";

const SECRET = "gh-secret";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const repository = { full_name: "acme/api", html_url: "https://github.com/acme/api" };

function github(opts: Partial<GithubChannelOptions> = {}) {
  const ctx = setup();
  const ch = new GithubChannel({ clock: ctx.clock, getWebhookSecret: () => SECRET, ownerIds: ["octo-owner"], ignoreLogins: ["ng-bot[bot]"], ...opts });
  ctx.hub.register(ch);
  const deliver = (event: string, payload: unknown, delivery = `d-${Math.random()}`) => {
    const body = JSON.stringify(payload);
    return ctx.hub.handleHttp("github", {
      method: "POST",
      headers: { "X-GitHub-Event": event, "X-GitHub-Delivery": delivery, "X-Hub-Signature-256": sign(body), "Content-Type": "application/json" },
      rawBody: body,
    });
  };
  return { ...ctx, ch, deliver };
}

describe("GithubChannel signature", () => {
  it("matches GitHub's documented test vector and rejects anything else", async () => {
    const { hub, received } = github({ getWebhookSecret: () => "It's a Secret to Everybody" });
    const base = { method: "POST", rawBody: "Hello, World!" };
    const headers = { "x-github-event": "issue_comment", "x-github-delivery": "vec-1" };
    const ok = await hub.handleHttp("github", {
      ...base,
      headers: { ...headers, "x-hub-signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17" },
    });
    // Signature accepted; the vector's body is not JSON, so the request then fails parsing — never a 401.
    expect(ok.status).toBe(400);
    expect(JSON.parse(ok.body)).toEqual({ error: "invalid_json" });
    const bad = await hub.handleHttp("github", {
      ...base,
      headers: { ...headers, "x-hub-signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e18" },
    });
    expect(bad.status).toBe(401);
    expect((await hub.handleHttp("github", { ...base, headers })).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("answers ping and ignores unsubscribed events with 200", async () => {
    const { deliver, received } = github();
    expect(JSON.parse((await deliver("ping", { zen: "Keep it logically awesome." })).body)).toEqual({ ok: true, pong: true });
    expect(JSON.parse((await deliver("star", { action: "created", repository, sender: { login: "x" } })).body)).toMatchObject({ ignored: true });
    expect(received).toHaveLength(0);
  });
});

describe("GithubChannel event mapping", () => {
  it("issue_comment → user.message on the issue thread, transport id from X-GitHub-Delivery", async () => {
    const { deliver, received } = github();
    const payload = {
      action: "created",
      issue: { number: 108, title: "Fix flaky test", pull_request: { url: "x" } },
      comment: { id: 555, body: "能不能顺便把超时调大？", html_url: "https://github.com/acme/api/pull/108#issuecomment-555" },
      repository,
      sender: { login: "alice" },
    };
    const res = await deliver("issue_comment", payload, "guid-1");
    expect(res.status).toBe(200);
    await deliver("issue_comment", payload, "guid-1");
    const env = received[0]!.env;
    expect(received.map((r) => r.env.id)).toEqual(["github:guid-1", "github:guid-1"]);
    expect(env).toMatchObject({
      from: "channel:github:acme/api#108",
      principalId: "github:alice",
      type: "user.message",
      threads: ["github:acme/api#108"],
    });
    const p = env.payload as UserMessagePayload;
    expect(p).toMatchObject({ text: "能不能顺便把超时调大？", replyTo: "channel:github:acme/api#108", sender: { id: "alice" } });
    expect(p.raw).toMatchObject({ isPullRequest: true, commentId: 555, number: 108 });
    expect(validatePayload(env)).toEqual({ ok: true });
  });

  it("maps the owner's login to the owner principal and drops our own bot's comments", async () => {
    const { deliver, received } = github();
    const mk = (login: string) => ({ action: "created", issue: { number: 1 }, comment: { id: 1, body: "hi" }, repository, sender: { login } });
    await deliver("issue_comment", mk("octo-owner"));
    expect(JSON.parse((await deliver("issue_comment", mk("ng-bot[bot]"))).body)).toMatchObject({ ignored: true });
    expect(JSON.parse((await deliver("issue_comment", { ...mk("bob"), action: "deleted" })).body)).toMatchObject({ ignored: true });
    expect(received.map((r) => r.env.principalId)).toEqual(["owner"]);
  });

  it("pull_request_review → user.message (body, or the review state when empty)", async () => {
    const { deliver, received } = github();
    await deliver("pull_request_review", {
      action: "submitted",
      review: { state: "APPROVED", body: null, html_url: "https://github.com/acme/api/pull/108#pullrequestreview-1" },
      pull_request: { number: 108, title: "Fix flaky test" },
      repository,
      sender: { login: "carol" },
    });
    const env = received[0]!.env;
    expect(env).toMatchObject({ type: "user.message", threads: ["github:acme/api#108"], principalId: "github:carol" });
    expect((env.payload as UserMessagePayload).text).toBe("[review: approved]");
  });

  it("pull_request → channel.event; closed+merged reads as merged", async () => {
    const { deliver, received } = github();
    await deliver("pull_request", {
      action: "closed",
      pull_request: { number: 108, title: "Fix flaky test", state: "closed", merged: true, html_url: "https://github.com/acme/api/pull/108", head: { ref: "fix", sha: "abc" }, base: { ref: "main" } },
      repository,
      sender: { login: "alice" },
    });
    const env = received[0]!.env;
    expect(env).toMatchObject({ type: "channel.event", threads: ["github:acme/api#108"], from: "channel:github:acme/api#108" });
    const p = env.payload as ChannelEventPayload;
    expect(p).toMatchObject({ channelId: "github", event: "pull_request", action: "closed", summary: "PR #108 merged: Fix flaky test", url: "https://github.com/acme/api/pull/108" });
    expect(p.data).toMatchObject({ merged: true, headRef: "fix", baseRef: "main" });
    expect(validatePayload(env)).toEqual({ ok: true });
  });

  it("check_suite and workflow_run → channel.event on every associated PR thread, even when our bot pushed", async () => {
    const { deliver, received } = github();
    await deliver("check_suite", {
      action: "completed",
      check_suite: { status: "completed", conclusion: "failure", head_branch: "fix", head_sha: "0123456789abcdef", app: { slug: "github-actions" }, pull_requests: [{ number: 108 }, { number: 109 }] },
      repository,
      sender: { login: "ng-bot[bot]" },
    });
    await deliver("workflow_run", {
      action: "completed",
      workflow_run: { id: 77, name: "CI", run_number: 12, status: "completed", conclusion: "success", head_branch: "fix", head_sha: "0123456", event: "push", html_url: "https://github.com/acme/api/actions/runs/77", pull_requests: [{ number: 108 }] },
      workflow: { name: "CI" },
      repository,
      sender: { login: "alice" },
    });
    await deliver("workflow_run", {
      action: "requested",
      workflow_run: { id: 78, name: "Nightly", status: "queued", head_branch: "main", pull_requests: [] },
      repository,
      sender: { login: "alice" },
    });
    const [suite, run, nightly] = received.map((r) => r.env);
    expect(suite).toMatchObject({ type: "channel.event", threads: ["github:acme/api#108", "github:acme/api#109"], from: "channel:github:acme/api#108" });
    expect(suite!.payload).toMatchObject({ event: "check_suite", summary: "Checks failure on fix (0123456)", data: { conclusion: "failure", pullRequests: [108, 109] } });
    expect(run!.payload).toMatchObject({ event: "workflow_run", summary: 'Workflow "CI" success on fix', url: "https://github.com/acme/api/actions/runs/77", data: { runId: 77 } });
    expect(nightly).not.toHaveProperty("threads");
    expect(nightly!.from).toBe("channel:github:acme/api");
  });

  it("returns 500 when the sink cannot persist, so GitHub redelivers", async () => {
    const { hub, deliver } = github();
    hub.onIngress(async () => {
      throw new Error("enqueue failed");
    });
    const res = await deliver("issue_comment", { action: "created", issue: { number: 1 }, comment: { id: 1, body: "x" }, repository, sender: { login: "a" } });
    expect(res.status).toBe(500);
  });
});

describe("GithubChannel outbound", () => {
  it("posts an issue comment with the token from getAuth and edits it by comment id", async () => {
    const f = fakeFetch((call) => (call.method === "POST" ? json(201, { id: 9001 }) : json(200, { id: 9001 })));
    const { hub } = github({ fetch: f.fn, getAuth: async () => "ghs_token", apiBase: "https://ghe.example/api/v3/" });
    const content = { format: "markdown" as const, title: "修复说明", body: "已把超时调到 30s。" };
    expect(await hub.send({ target: "channel:github:acme/api#108", content, idempotencyKey: "act_1" })).toBe("sent");
    expect(hub.getOutboxSync("act_1")?.externalId).toBe("9001");
    expect(f.calls[0]).toMatchObject({
      url: "https://ghe.example/api/v3/repos/acme/api/issues/108/comments",
      method: "POST",
      body: { body: "**修复说明**\n\n已把超时调到 30s。" },
    });
    expect(f.calls[0]!.headers).toMatchObject({ authorization: "Bearer ghs_token", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });

    expect(await hub.edit("act_1", text("更正：超时 60s"))).toBe("edited");
    expect(f.calls[1]).toMatchObject({ url: "https://ghe.example/api/v3/repos/acme/api/issues/comments/9001", method: "PATCH", body: { body: "更正：超时 60s" } });
  });

  it("fails without a request for bad targets or a missing token provider; 5xx is unknown", async () => {
    const f = fakeFetch(() => json(502, { message: "Bad gateway" }));
    const a = github({ fetch: f.fn, getAuth: () => "t" });
    expect(await a.hub.send({ target: "channel:github:not-a-target", content: text("x"), idempotencyKey: "a" })).toBe("failed");
    expect(a.hub.getOutboxSync("a")?.error).toMatch(/invalid GitHub target/);
    expect(f.calls).toHaveLength(0);
    expect(await a.hub.send({ target: "channel:github:acme/api#1", content: text("x"), idempotencyKey: "b" })).toBe("unknown");
    const b = github({ fetch: f.fn });
    expect(await b.hub.send({ target: "channel:github:acme/api#1", content: text("x"), idempotencyKey: "c" })).toBe("failed");
    expect(b.ch.capabilities).toEqual({ idempotentSend: false, withdrawOrEdit: true, streamingPreview: false });
  });
});
