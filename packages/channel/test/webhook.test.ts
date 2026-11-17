import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatePayload } from "@ng/protocol";
import { WebhookChannel, type WebhookChannelOptions } from "../src";
import { fakeFetch, json, netError, setup, text } from "./helpers";

const SECRET = "whsec-test";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function webhook(opts: Partial<WebhookChannelOptions> = {}) {
  const ctx = setup();
  const ch = new WebhookChannel({ id: "ops", clock: ctx.clock, getSigningSecret: () => SECRET, ownerIds: ["me"], ...opts });
  ctx.hub.register(ch);
  const post = (body: string, headers: Record<string, string> = {}) =>
    ctx.hub.handleHttp("ops", { method: "POST", headers: { "X-Signature-256": sign(body), ...headers }, rawBody: Buffer.from(body) });
  return { ...ctx, ch, post };
}

describe("WebhookChannel inbound", () => {
  it("accepts a correctly signed body and answers 200 only after the sink resolved", async () => {
    const { post, received } = webhook();
    const body = JSON.stringify({ id: "d-1", text: "部署完成了吗？", sender: { id: "me" }, thread: "deploy-42" });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, id: "ops:d-1" });
    expect(received[0]!.env).toMatchObject({
      id: "ops:d-1",
      from: "channel:ops:me",
      principalId: "owner",
      type: "user.message",
      threads: ["ops:deploy-42"],
      payload: { text: "部署完成了吗？", replyTo: "channel:ops:me", sender: { id: "me" } },
    });
  });

  it("rejects missing, wrong-secret, tampered and malformed signatures without emitting", async () => {
    const { hub, post, received } = webhook();
    const body = JSON.stringify({ text: "hi" });
    expect((await hub.handleHttp("ops", { method: "POST", headers: {}, rawBody: body })).status).toBe(401);
    expect((await post(body, { "X-Signature-256": sign(body, "other") })).status).toBe(401);
    expect((await post(`${body} `, { "X-Signature-256": sign(body) })).status).toBe(401);
    expect((await post(body, { "X-Signature-256": "sha256=abc" })).status).toBe(401);
    expect((await hub.handleHttp("ops", { method: "GET", headers: {}, rawBody: "" })).status).toBe(405);
    expect(received).toHaveLength(0);
    // A bare-hex signature is accepted too.
    expect((await post(body, { "X-Signature-256": sign(body).slice(7) })).status).toBe(200);
  });

  it("uses a stable transport id: header, then body id, then a hash of the body", async () => {
    const { post, received } = webhook();
    const body = JSON.stringify({ event: "alert", summary: "磁盘 90%" });
    await post(body, { "Idempotency-Key": "abc" });
    await post(body);
    await post(body);
    expect(received.map((r) => r.env.id)).toEqual(["ops:abc", received[1]!.env.id, received[1]!.env.id]);
    expect(received[1]!.env.id).toMatch(/^ops:[0-9a-f]{64}$/);
    expect(received[1]!.env).toMatchObject({ type: "channel.event", principalId: "ops:webhook", payload: { event: "alert", summary: "磁盘 90%" } });
    expect(validatePayload(received[1]!.env)).toEqual({ ok: true });
  });

  it("answers 500 when the sink fails (so the sender redelivers) and 503 when misconfigured", async () => {
    const { hub, post } = webhook();
    hub.onIngress(async () => {
      throw new Error("enqueue failed");
    });
    expect((await post(JSON.stringify({ text: "x" }))).status).toBe(500);
    const bad = webhook({ getSigningSecret: () => "" });
    expect((await bad.post(JSON.stringify({ text: "x" }))).status).toBe(503);
    const res = await bad.hub.handleHttp("missing", { method: "POST", headers: {}, rawBody: "" });
    expect(res.status).toBe(404);
  });

  it("honours a custom mapper, including dropping bodies", async () => {
    const { post, received } = webhook({
      map: (b) => ((b as { skip?: boolean }).skip ? null : { senderId: "bot", text: `custom:${(b as { v: string }).v}`, transportId: "fixed" }),
    });
    expect(JSON.parse((await post(JSON.stringify({ skip: true }))).body)).toEqual({ ok: true, ignored: true });
    await post(JSON.stringify({ v: "1" }));
    expect(received.map((r) => [r.env.id, (r.env.payload as { text: string }).text, r.env.principalId])).toEqual([["ops:fixed", "custom:1", "ops:bot"]]);
  });
});

describe("WebhookChannel outbound", () => {
  it("POSTs JSON with Idempotency-Key, auth and a body signature, and maps responses to honest receipts", async () => {
    const responses: Array<Response | Error> = [
      json(201, { id: 9 }),
      json(422, { error: "bad" }),
      json(502, {}),
      netError("ECONNREFUSED"),
      netError("ECONNRESET"),
    ];
    const f = fakeFetch(() => {
      const r = responses.shift()!;
      if (r instanceof Error) throw r;
      return r;
    });
    const { hub } = webhook({ url: (t) => `https://example.test/${t}`, fetch: f.fn, getAuth: () => ({ authorization: "Bearer t0k" }) });
    const send = (k: string) => hub.send({ target: "channel:ops:pager", content: text("磁盘告警"), idempotencyKey: k });
    expect(await send("ok")).toBe("sent");
    expect(hub.getOutboxSync("ok")?.externalId).toBe("9");
    const call = f.calls[0]!;
    expect(call).toMatchObject({ url: "https://example.test/pager", method: "POST" });
    expect(call.headers).toMatchObject({ "idempotency-key": "ok", authorization: "Bearer t0k", "x-signature-256": sign(call.rawBody) });
    expect(call.body).toEqual({ target: "pager", idempotencyKey: "ok", content: text("磁盘告警") });

    expect(await send("4xx")).toBe("failed");
    expect(hub.getOutboxSync("4xx")?.error).toMatch(/HTTP 422/);
    expect(await send("5xx")).toBe("unknown");
    expect(await send("refused")).toBe("failed");
    expect(hub.getOutboxSync("refused")?.error).toMatch(/ECONNREFUSED/);
    expect(await send("reset")).toBe("unknown");
  });

  it("an inbound-only webhook or a failing auth provider fails without a request", async () => {
    const f = fakeFetch(() => json(200, {}));
    const a = webhook({ fetch: f.fn });
    expect(await a.hub.send({ target: "channel:ops:x", content: text("x"), idempotencyKey: "a" })).toBe("failed");
    const b = webhook({ url: "https://example.test", fetch: f.fn, getAuth: () => { throw new Error("vault locked"); } });
    expect(await b.hub.send({ target: "channel:ops:x", content: text("x"), idempotencyKey: "b" })).toBe("failed");
    expect(b.hub.getOutboxSync("b")?.error).toMatch(/auth unavailable: vault locked/);
    expect(f.calls).toHaveLength(0);
  });

  it("a request that times out is unknown", async () => {
    const f = fakeFetch(
      (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    );
    const ctx = setup({ sendTimeoutMs: 20 });
    const ch = new WebhookChannel({ id: "slow", clock: ctx.clock, getSigningSecret: () => SECRET, url: "https://slow.test", fetch: f.fn });
    ctx.hub.register(ch);
    expect(await ctx.hub.send({ target: "channel:slow:x", content: text("x"), idempotencyKey: "s" })).toBe("unknown");
    expect(ch.capabilities).toEqual({ idempotentSend: false, withdrawOrEdit: false, streamingPreview: false });
  });
});
