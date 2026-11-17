import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ManualClock, validatePayload, type UserMessagePayload } from "@ng/protocol";
import { FeishuChannel, feishuDecrypt, feishuSignature, feishuUuid, type FeishuChannelOptions } from "../src";
import { fakeFetch, json, setup, text } from "./helpers";

const TOKEN = "verif-token";
const KEY = "encrypt-key";
const NOW_SEC = 1_760_000_000;

function encrypt(plain: string, key = KEY): string {
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-cbc", createHash("sha256").update(key).digest(), iv);
  return Buffer.concat([iv, c.update(plain, "utf8"), c.final()]).toString("base64");
}

function feishu(opts: Partial<FeishuChannelOptions> = {}) {
  const ctx = setup({ clock: new ManualClock(NOW_SEC * 1000) });
  const ch = new FeishuChannel({ clock: ctx.clock, getVerificationToken: () => TOKEN, ownerIds: ["ou_owner"], ...opts });
  ctx.hub.register(ch);
  const post = (body: string, headers: Record<string, string> = {}) => ctx.hub.handleHttp("feishu", { method: "POST", headers, rawBody: body });
  return { ...ctx, ch, post };
}

function messageEvent(message: Record<string, unknown>, sender: Record<string, unknown> = {}) {
  return {
    schema: "2.0",
    header: { event_id: "ev-1", token: TOKEN, create_time: "1760000000000", event_type: "im.message.receive_v1", tenant_key: "t", app_id: "cli_x" },
    event: {
      sender: { sender_id: { open_id: "ou_alice", user_id: "u1" }, sender_type: "user", tenant_key: "t", ...sender },
      message: { message_id: "om_1", chat_id: "oc_group", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "hello" }), ...message },
    },
  };
}

describe("FeishuChannel crypto helpers", () => {
  it("decrypts Feishu's documented example", () => {
    expect(feishuDecrypt("P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=", "test key")).toBe("hello world");
  });

  it("uuid stays within Feishu's 50-character limit and is stable", () => {
    expect(feishuUuid("act_short")).toBe("act_short");
    const long = "x".repeat(80);
    expect(feishuUuid(long)).toHaveLength(50);
    expect(feishuUuid(long)).toBe(feishuUuid(long));
  });
});

describe("FeishuChannel inbound (no encrypt key)", () => {
  it("answers the URL challenge only with the right verification token", async () => {
    const { post } = feishu();
    const ok = await post(JSON.stringify({ challenge: "ajls384kdjx98XX", token: TOKEN, type: "url_verification" }));
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ challenge: "ajls384kdjx98XX" });
    expect((await post(JSON.stringify({ challenge: "c", token: "wrong", type: "url_verification" }))).status).toBe(401);
  });

  it("im.message.receive_v1 in a group → user.message on the chat and its reply chain", async () => {
    const { post, received } = feishu();
    const body = messageEvent({
      content: JSON.stringify({ text: "@_user_1 方案什么时候能好？" }),
      mentions: [{ key: "@_user_1", name: "小助手", id: { open_id: "ou_bot" } }],
    });
    const res = await post(JSON.stringify(body));
    expect(res.status).toBe(200);
    const env = received[0]!.env;
    expect(env).toMatchObject({
      id: "feishu:om_1",
      from: "channel:feishu:oc_group:om_1",
      principalId: "feishu:ou_alice",
      type: "user.message",
      threads: ["feishu:oc_group", "feishu:oc_group:om_1"],
    });
    expect(env.payload as UserMessagePayload).toMatchObject({ text: "@小助手 方案什么时候能好？", replyTo: "channel:feishu:oc_group:om_1", sender: { id: "ou_alice" } });
    expect(validatePayload(env)).toEqual({ ok: true });
  });

  it("a reply carries its root message id; p2p answers go to the chat; post messages are flattened", async () => {
    const { post, received } = feishu();
    await post(JSON.stringify(messageEvent({ message_id: "om_2", root_id: "om_1", parent_id: "om_1" })));
    await post(JSON.stringify(messageEvent({ message_id: "om_3", chat_id: "oc_dm", chat_type: "p2p" }, { sender_id: { open_id: "ou_owner" } })));
    await post(JSON.stringify(messageEvent({
      message_id: "om_4",
      message_type: "post",
      content: JSON.stringify({ title: "周报", content: [[{ tag: "text", text: "进度 " }, { tag: "at", user_name: "张三" }], [{ tag: "text", text: "完成 80%" }]] }),
    })));
    const [reply, dm, rich] = received.map((r) => r.env);
    expect(reply).toMatchObject({ threads: ["feishu:oc_group", "feishu:oc_group:om_1"], from: "channel:feishu:oc_group:om_1" });
    expect(dm).toMatchObject({ from: "channel:feishu:oc_dm", principalId: "owner" });
    expect((rich!.payload as UserMessagePayload).text).toBe("周报\n进度 @张三\n完成 80%");
  });

  it("rejects a bad event token and ignores app senders, other events and v1 callbacks", async () => {
    const { post, received } = feishu();
    const bad = messageEvent({});
    bad.header.token = "wrong";
    expect((await post(JSON.stringify(bad))).status).toBe(401);
    const fromApp = messageEvent({}, { sender_type: "app" });
    expect(JSON.parse((await post(JSON.stringify(fromApp))).body)).toMatchObject({ ignored: true });
    const other = messageEvent({});
    other.header.event_type = "im.chat.member.user.added_v1";
    expect(JSON.parse((await post(JSON.stringify(other))).body)).toMatchObject({ ignored: true });
    expect((await post(JSON.stringify({ uuid: "u", token: TOKEN, event: {} }))).status).toBe(200);
    expect((await post(JSON.stringify({ uuid: "u", token: "x", event: {} }))).status).toBe(401);
    expect((await post(JSON.stringify({ encrypt: "abc" }))).status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

describe("FeishuChannel inbound (encrypt key configured)", () => {
  const signed = (raw: string, o: { ts?: number; nonce?: string; key?: string } = {}) => {
    const ts = String(o.ts ?? NOW_SEC);
    const nonce = o.nonce ?? "n0nce";
    return { "X-Lark-Request-Timestamp": ts, "X-Lark-Request-Nonce": nonce, "X-Lark-Signature": feishuSignature(ts, nonce, o.key ?? KEY, raw) };
  };

  it("decrypts the challenge and the events, verifying X-Lark-Signature", async () => {
    const { post, received } = feishu({ getEncryptKey: () => KEY });
    const challenge = JSON.stringify({ encrypt: encrypt(JSON.stringify({ challenge: "c-1", token: TOKEN, type: "url_verification" })) });
    expect(JSON.parse((await post(challenge)).body)).toEqual({ challenge: "c-1" });

    const raw = JSON.stringify({ encrypt: encrypt(JSON.stringify(messageEvent({}))) });
    expect((await post(raw, signed(raw))).status).toBe(200);
    expect(received.map((r) => r.env.id)).toEqual(["feishu:om_1"]);
  });

  it("rejects missing, wrong or stale signatures, undecryptable and plaintext bodies", async () => {
    const { post, received } = feishu({ getEncryptKey: () => KEY });
    const raw = JSON.stringify({ encrypt: encrypt(JSON.stringify(messageEvent({}))) });
    expect((await post(raw)).status).toBe(401);
    expect((await post(raw, signed(raw, { key: "other" }))).status).toBe(401);
    expect((await post(raw, signed(raw, { ts: NOW_SEC - 1000 }))).status).toBe(401);
    expect((await post(`${raw} `, signed(raw))).status).toBe(401);
    const wrongKey = JSON.stringify({ encrypt: encrypt(JSON.stringify(messageEvent({})), "other") });
    expect((await post(wrongKey, signed(wrongKey))).status).toBe(401);
    expect((await post(JSON.stringify(messageEvent({})))).status).toBe(401);
    expect(received).toHaveLength(0);
  });
});

describe("FeishuChannel outbound", () => {
  it("creates chat messages with uuid and receive_id_type, replies to a message, edits by message id", async () => {
    let n = 0;
    const f = fakeFetch(() => json(200, { code: 0, msg: "success", data: { message_id: `om_out_${++n}` } }));
    const { hub } = feishu({ fetch: f.fn, getAuth: async () => "t-tenant" });
    expect(await hub.send({ target: "channel:feishu:oc_group", content: { format: "text", title: "提醒", body: "明早 10 点评审" }, idempotencyKey: "act_9" })).toBe("sent");
    expect(f.calls[0]).toMatchObject({
      url: "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
      method: "POST",
      body: { receive_id: "oc_group", msg_type: "text", content: JSON.stringify({ text: "提醒\n\n明早 10 点评审" }), uuid: "act_9" },
    });
    expect(f.calls[0]!.headers.authorization).toBe("Bearer t-tenant");
    expect(hub.getOutboxSync("act_9")?.externalId).toBe("om_out_1");

    const longKey = `approval:${"z".repeat(60)}`;
    await hub.send({ target: "channel:feishu:oc_group:om_1", content: text("收到"), idempotencyKey: longKey });
    expect(f.calls[1]).toMatchObject({ url: "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply", body: { msg_type: "text", uuid: feishuUuid(longKey) } });

    await hub.send({ target: "channel:feishu:ou_owner", content: text("私信"), idempotencyKey: "dm" });
    expect(f.calls[2]!.url).toBe("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id");

    expect(await hub.edit("act_9", text("改到 11 点"))).toBe("edited");
    expect(f.calls[3]).toMatchObject({ url: "https://open.feishu.cn/open-apis/im/v1/messages/om_out_1", method: "PUT", body: { msg_type: "text", content: JSON.stringify({ text: "改到 11 点" }) } });
  });

  it("a non-zero code is failed, 5xx is unknown, and a failing tenant-token provider sends nothing", async () => {
    const answers = [json(200, { code: 230002, msg: "bot not in chat" }), json(503, { code: 1 })];
    const f = fakeFetch(() => answers.shift()!);
    const { hub } = feishu({ fetch: f.fn, getAuth: () => "t" });
    expect(await hub.send({ target: "channel:feishu:oc_x", content: text("x"), idempotencyKey: "a" })).toBe("failed");
    expect(hub.getOutboxSync("a")?.error).toBe("feishu code 230002: bot not in chat");
    expect(await hub.send({ target: "channel:feishu:oc_x", content: text("x"), idempotencyKey: "b" })).toBe("unknown");

    const g = fakeFetch(() => json(200, { code: 0 }));
    const noAuth = feishu({ fetch: g.fn, getAuth: () => Promise.reject(new Error("token refresh failed")) });
    expect(await noAuth.hub.send({ target: "channel:feishu:oc_x", content: text("x"), idempotencyKey: "c" })).toBe("failed");
    expect(g.calls).toHaveLength(0);
    expect(noAuth.ch.capabilities).toEqual({ idempotentSend: true, withdrawOrEdit: true, streamingPreview: false });
  });
});
