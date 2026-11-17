import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ManualClock, validatePayload, type UserMessagePayload } from "@ng/protocol";
import { SlackChannel, type SlackChannelOptions } from "../src";
import { fakeFetch, json, setup, text } from "./helpers";

const SECRET = "slack-signing";
const NOW_SEC = 1_760_000_000;

function slack(opts: Partial<SlackChannelOptions> = {}, nowSec = NOW_SEC) {
  const ctx = setup({ clock: new ManualClock(nowSec * 1000) });
  const ch = new SlackChannel({ clock: ctx.clock, getSigningSecret: () => SECRET, ownerIds: ["UOWNER"], botUserId: "UBOT", botId: "BBOT", ...opts });
  ctx.hub.register(ch);
  const post = (payload: unknown, o: { ts?: number; secret?: string; sig?: string } = {}) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const ts = String(o.ts ?? nowSec);
    const sig = o.sig ?? `v0=${createHmac("sha256", o.secret ?? SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
    return ctx.hub.handleHttp("slack", { method: "POST", headers: { "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig }, rawBody: body });
  };
  return { ...ctx, ch, post };
}

const callback = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "event_callback",
  team_id: "T1",
  api_app_id: "AAPP",
  event_id: `Ev${Math.random()}`,
  event,
  ...extra,
});

describe("SlackChannel signing", () => {
  it("matches Slack's documented v0 test vector", async () => {
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    const { post } = slack({ getSigningSecret: () => "8f742231b10e8888abcd99yyyzzz85a5" }, 1531420618 + 60);
    const good = await post(body, { ts: 1531420618, sig: "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503" });
    expect(good.status).toBe(200);
    const bad = await post(body, { ts: 1531420618, sig: "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b504" });
    expect(bad.status).toBe(401);
  });

  it("rejects stale timestamps (replay), wrong secrets and missing headers", async () => {
    const { post, hub, received } = slack();
    const ev = callback({ type: "message", channel: "C1", user: "U1", text: "hi", ts: "1.0" });
    expect((await post(ev, { ts: NOW_SEC - 301 })).status).toBe(401);
    expect((await post(ev, { ts: NOW_SEC + 301 })).status).toBe(401);
    expect((await post(ev, { secret: "nope" })).status).toBe(401);
    expect((await hub.handleHttp("slack", { method: "POST", headers: {}, rawBody: "{}" })).status).toBe(401);
    expect(received).toHaveLength(0);
    expect((await post(ev, { ts: NOW_SEC - 299 })).status).toBe(200);
  });

  it("answers url_verification with the challenge", async () => {
    const { post } = slack();
    const res = await post({ type: "url_verification", token: "x", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
  });
});

describe("SlackChannel events", () => {
  it("a thread reply becomes user.message on slack:<channel>:<thread_ts>", async () => {
    const { post, received } = slack();
    const res = await post(callback({ type: "message", channel: "C42", user: "U7", text: "报价什么时候能给？", ts: "1700000123.000200", thread_ts: "1700000000.000100", channel_type: "channel" }));
    expect(res.status).toBe(200);
    const env = received[0]!.env;
    expect(env).toMatchObject({
      id: "slack:C42:1700000123.000200",
      from: "channel:slack:C42:1700000000.000100",
      principalId: "slack:U7",
      type: "user.message",
      threads: ["slack:C42:1700000000.000100"],
    });
    expect(env.payload as UserMessagePayload).toMatchObject({ text: "报价什么时候能给？", replyTo: "channel:slack:C42:1700000000.000100", sender: { id: "U7" } });
    expect(validatePayload(env)).toEqual({ ok: true });
  });

  it("a top-level message is its own thread root; message + app_mention for one message share an envelope id", async () => {
    const { post, received } = slack();
    await post(callback({ type: "message", channel: "C1", user: "UOWNER", text: "<@UBOT> 看下", ts: "5.5" }));
    await post(callback({ type: "app_mention", channel: "C1", user: "UOWNER", text: "<@UBOT> 看下", ts: "5.5" }));
    expect(received.map((r) => r.env.id)).toEqual(["slack:C1:5.5", "slack:C1:5.5"]);
    expect(received[0]!.env).toMatchObject({ threads: ["slack:C1:5.5"], principalId: "owner" });
  });

  it("ignores our own bot, edits/deletes/joins and other bots' bot_message events", async () => {
    const { post, received } = slack();
    const ignored = [
      callback({ type: "message", channel: "C1", user: "UBOT", text: "my reply", ts: "1" }),
      callback({ type: "message", channel: "C1", bot_id: "BBOT", user: "UX", text: "my reply", ts: "2" }),
      callback({ type: "message", channel: "C1", user: "UY", app_id: "AAPP", text: "from our app", ts: "3" }),
      callback({ type: "message", channel: "C1", user: "UZ", text: "x", ts: "4" }, { authorizations: [{ user_id: "UZ", is_bot: true }] }),
      callback({ type: "message", subtype: "message_changed", channel: "C1", ts: "5" }),
      callback({ type: "message", subtype: "bot_message", channel: "C1", bot_id: "BOTHER", text: "deploy", ts: "6" }),
      callback({ type: "reaction_added", user: "U1" }),
      { type: "app_rate_limited" },
    ];
    for (const ev of ignored) {
      const res = await post(ev);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ ignored: true });
    }
    await post(callback({ type: "message", subtype: "thread_broadcast", channel: "C1", user: "U1", text: "也发到频道", ts: "7", thread_ts: "6.9" }));
    expect(received.map((r) => r.env.id)).toEqual(["slack:C1:7"]);
  });

  it("returns 500 when the sink cannot persist (Slack retries; the id dedupes)", async () => {
    const { hub, post } = slack();
    hub.onIngress(async () => {
      throw new Error("enqueue failed");
    });
    expect((await post(callback({ type: "message", channel: "C1", user: "U1", text: "x", ts: "1" }))).status).toBe(500);
  });
});

describe("SlackChannel outbound", () => {
  it("chat.postMessage in-thread with the bot token; edit via chat.update", async () => {
    const f = fakeFetch((call) => json(200, { ok: true, channel: "C42", ts: call.url.endsWith("postMessage") ? "1700000200.000300" : "x" }));
    const { hub } = slack({ fetch: f.fn, getAuth: () => "xoxb-123" });
    const r = await hub.send({ target: "channel:slack:C42:1700000000.000100", content: { format: "text", title: "报价", body: "下周一给到" }, idempotencyKey: "s1" });
    expect(r).toBe("sent");
    expect(f.calls[0]).toMatchObject({
      url: "https://slack.com/api/chat.postMessage",
      method: "POST",
      body: { channel: "C42", text: "*报价*\n\n下周一给到", thread_ts: "1700000000.000100" },
    });
    expect(f.calls[0]!.headers.authorization).toBe("Bearer xoxb-123");
    expect(hub.getOutboxSync("s1")?.externalId).toBe("1700000200.000300");

    expect(await hub.edit("s1", text("改为下周二"))).toBe("edited");
    expect(f.calls[1]).toMatchObject({ url: "https://slack.com/api/chat.update", body: { channel: "C42", ts: "1700000200.000300", text: "改为下周二" } });

    await hub.send({ target: "channel:slack:C99", content: text("top-level"), idempotencyKey: "s2" });
    expect(f.calls[2]!.body).toEqual({ channel: "C99", text: "top-level" });
  });

  it("ok:false is failed, except Slack's ambiguous fatal/internal errors which are unknown; 429 is failed", async () => {
    const answers = [json(200, { ok: false, error: "channel_not_found" }), json(200, { ok: false, error: "internal_error" }), json(429, { ok: false, error: "ratelimited" })];
    const f = fakeFetch(() => answers.shift()!);
    const { hub } = slack({ fetch: f.fn, getAuth: () => "xoxb-123" });
    const send = (k: string) => hub.send({ target: "channel:slack:C1", content: text("x"), idempotencyKey: k });
    expect(await send("a")).toBe("failed");
    expect(hub.getOutboxSync("a")?.error).toBe("slack chat.postMessage: channel_not_found");
    expect(await send("b")).toBe("unknown");
    expect(await send("c")).toBe("failed");
  });
});
