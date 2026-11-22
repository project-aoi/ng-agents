import { describe, expect, it, vi } from "vitest";
import { NgError, all, openDatabase, withTx, type ActionTokenVerifier, type Channel, type ChannelSendRequest } from "@ng/protocol";
import { MemoryChannel } from "../src";
import { setup, text } from "./helpers";

const ALICE = "channel:memory:alice" as const;

describe("ChannelHub registry", () => {
  it("registers, looks up and describes channels; refuses duplicates and ids with ':'", () => {
    const { hub, mem } = setup();
    expect(hub.get("memory")).toBe(mem);
    expect(hub.list()).toEqual([mem]);
    expect(hub.listInfoSync()).toEqual([
      {
        id: "memory",
        kind: "memory",
        capabilities: { idempotentSend: true, withdrawOrEdit: true, streamingPreview: true },
        status: { state: "ready", lastIngressAt: null, lastDeliveryAt: null, lastError: null },
      },
    ]);
    expect(() => hub.register(new MemoryChannel())).toThrow(/already registered/);
    const colon: Channel = { id: "a:b", capabilities: mem.capabilities, onIngress() {}, send: async () => "sent" };
    expect(() => hub.register(colon)).toThrow(/invalid channel id/);
    expect(hub.unregister("memory")).toBe(true);
    expect(hub.get("memory")).toBeUndefined();
  });
});

describe("ChannelHub.send — receipts and the outbox", () => {
  it("sends through the adapter, records the row and announces each transition after commit", async () => {
    const { hub, mem, clock, statuses } = setup();
    const r = await hub.send({ target: ALICE, content: text("你好"), idempotencyKey: "k1", cellId: "desk", actionId: "act_1" });
    expect(r).toBe("sent");
    expect(mem.deliveries).toEqual([
      { target: "alice", content: text("你好"), idempotencyKey: "k1", attempt: 1, outcome: "sent", externalId: "mem-1" },
    ]);
    expect(hub.getOutboxSync("k1")).toMatchObject({
      channelId: "memory",
      target: "alice",
      status: "sent",
      attempts: 1,
      externalId: "mem-1",
      cellId: "desk",
      actionId: "act_1",
      refused: false,
      error: null,
      sentAt: clock.now(),
    });
    expect(statuses("k1")).toEqual(["pending", "sent"]);
    expect(mem.status().lastDeliveryAt).toBe(clock.now());
  });

  it.each(["sent", "failed", "unknown"] as const)("a repeated key returns the stored %s receipt without contacting the adapter", async (outcome) => {
    const { hub, mem } = setup();
    mem.respondWith(outcome);
    expect(await hub.send({ target: ALICE, content: text("a"), idempotencyKey: "same" })).toBe(outcome);
    expect(await hub.send({ target: ALICE, content: text("a"), idempotencyKey: "same" })).toBe(outcome);
    expect(await hub.send({ target: "channel:memory:bob", content: text("different"), idempotencyKey: "same" })).toBe(outcome);
    expect(mem.deliveries).toHaveLength(1);
  });

  it("concurrent sends with one key share a single delivery", async () => {
    const { hub, mem } = setup();
    const [a, b, c] = await Promise.all([
      hub.send({ target: ALICE, content: text("x"), idempotencyKey: "dup" }),
      hub.send({ target: ALICE, content: text("x"), idempotencyKey: "dup" }),
      hub.send({ target: ALICE, content: text("x"), idempotencyKey: "dup" }),
    ]);
    expect([a, b, c]).toEqual(["sent", "sent", "sent"]);
    expect(mem.deliveries).toHaveLength(1);
  });

  it("unknown is never retried: neither by a resend nor by retryFailed", async () => {
    const { hub, mem } = setup();
    mem.respondWith("unknown", { error: "socket reset after write" });
    expect(await hub.send({ target: ALICE, content: text("x"), idempotencyKey: "u" })).toBe("unknown");
    expect(await hub.retryFailed("u")).toBe("unknown");
    expect(await hub.send({ target: ALICE, content: text("x"), idempotencyKey: "u" })).toBe("unknown");
    expect(mem.deliveries).toHaveLength(1);
    expect(hub.getOutboxSync("u")).toMatchObject({ status: "unknown", error: "socket reset after write", sentAt: null });
  });

  it("failed may be retried explicitly with the same key", async () => {
    const { hub, mem, statuses } = setup();
    mem.respondWith("failed", { error: "HTTP 400: channel_not_found" });
    expect(await hub.send({ target: ALICE, content: text("x"), idempotencyKey: "f" })).toBe("failed");
    expect(hub.getOutboxSync("f")).toMatchObject({ status: "failed", attempts: 1, error: "HTTP 400: channel_not_found", refused: false });
    expect(await hub.retryFailed("f")).toBe("sent");
    expect(mem.deliveries.map((d) => [d.attempt, d.outcome])).toEqual([[1, "failed"], [2, "sent"]]);
    expect(hub.getOutboxSync("f")).toMatchObject({ status: "sent", attempts: 2, error: null });
    expect(statuses("f")).toEqual(["pending", "failed", "pending", "sent"]);
    expect(await hub.retryFailed("f")).toBe("sent");
    expect(mem.deliveries).toHaveLength(2);
    await expect(hub.retryFailed("nope")).rejects.toThrow(NgError);
  });

  it("an adapter that hangs past the timeout yields unknown and its signal is aborted", async () => {
    const { hub, mem } = setup({ sendTimeoutMs: 20 });
    mem.respondWith("hang");
    expect(await hub.send({ target: ALICE, content: text("x"), idempotencyKey: "h" })).toBe("unknown");
    expect(hub.getOutboxSync("h")).toMatchObject({ status: "unknown", error: "timeout: no answer within 20 ms" });
  });

  it("an adapter that throws yields unknown, never sent", async () => {
    const { hub, mem } = setup();
    mem.respondWith("throw", { error: "ECONNRESET" });
    expect(await hub.send({ target: ALICE, content: text("x"), idempotencyKey: "t" })).toBe("unknown");
    expect(hub.getOutboxSync("t")?.error).toContain("ECONNRESET");
  });

  it("an unregistered channel fails without a delivery and can be retried once the channel exists", async () => {
    const { hub, clock } = setup();
    expect(await hub.send({ target: "channel:later:bob", content: text("x"), idempotencyKey: "l" })).toBe("failed");
    expect(hub.getOutboxSync("l")).toMatchObject({ status: "failed", attempts: 0, error: 'channel "later" is not registered' });
    expect(await hub.retryFailed("l")).toBe("failed");
    const later = new MemoryChannel({ id: "later", clock });
    hub.register(later);
    expect(await hub.retryFailed("l")).toBe("sent");
    expect(later.deliveries.map((d) => d.target)).toEqual(["bob"]);
  });

  it("rejects malformed requests before touching the outbox", async () => {
    const { hub, db } = setup();
    await expect(hub.send({ target: "inbox:desk" as never, content: text("x"), idempotencyKey: "a" })).rejects.toThrow(/not a channel address/);
    await expect(hub.send({ target: ALICE, content: text("x"), idempotencyKey: "" })).rejects.toThrow(/idempotencyKey/);
    await expect(hub.send({ target: ALICE, content: { format: "pdf", body: 1 } as never, idempotencyKey: "b" })).rejects.toThrow(/Deliverable/);
    expect(all(db, "SELECT * FROM outbox")).toEqual([]);
  });

  it("refuses to start network I/O inside a caller's transaction", async () => {
    const { hub, db, mem } = setup();
    let pending: Array<Promise<unknown>> = [];
    withTx(db, () => {
      pending = [
        hub.send({ target: ALICE, content: text("x"), idempotencyKey: "tx" }),
        hub.retryFailed("tx"),
        hub.flushBuffered(),
        hub.edit("tx", text("y")),
      ];
    });
    for (const p of pending) await expect(p).rejects.toSatisfy((e: unknown) => e instanceof NgError && e.code === "tx_misuse");
    expect(hub.getOutboxSync("tx")).toBeUndefined();
    expect(mem.deliveries).toHaveLength(0);
  });

  it("a row left pending by a crashed process reads as unknown and is never re-sent", async () => {
    const { db, clock, hub: crashed, mem } = setup({ sendTimeoutMs: 40 });
    mem.respondWith("hang");
    const inFlight = crashed.send({ target: ALICE, content: text("x"), idempotencyKey: "p", cellId: "desk" });

    // A second process (fresh hub, same database) after a restart.
    const { hub: restarted, mem: mem2 } = setup({ db, clock });
    expect(await restarted.send({ target: ALICE, content: text("x"), idempotencyKey: "p" })).toBe("unknown");
    expect(mem2.deliveries).toHaveLength(0);
    expect(restarted.recoverInterruptedSync()).toBe(1);
    expect(restarted.getOutboxSync("p")).toMatchObject({ status: "unknown", error: expect.stringContaining("interrupted") });
    expect(restarted.recoverInterruptedSync()).toBe(0);

    // The orphaned attempt finishing later must not overwrite the recovered state.
    expect(await inFlight).toBe("unknown");
    expect(restarted.getOutboxSync("p")?.error).toContain("interrupted");
  });

  it("recoverInterruptedSync leaves sends that are in flight in this process alone", async () => {
    const { hub, mem } = setup({ sendTimeoutMs: 30 });
    mem.respondWith("hang");
    const p = hub.send({ target: ALICE, content: text("x"), idempotencyKey: "live" });
    expect(hub.recoverInterruptedSync()).toBe(0);
    expect(await p).toBe("unknown");
    expect(hub.getOutboxSync("live")?.error).toContain("timeout");
  });

  it("resolveUnknownSync records a human verdict on an unknown send", async () => {
    const { hub, mem, clock } = setup();
    mem.respondWith("unknown", { error: "timeout" });
    await hub.send({ target: ALICE, content: text("x"), idempotencyKey: "v" });
    await hub.send({ target: ALICE, content: text("y"), idempotencyKey: "w" });
    expect(hub.resolveUnknownSync("w", "sent")).toBe("not_unknown");
    expect(hub.resolveUnknownSync("zz", "sent")).toBe("not_found");
    expect(hub.resolveUnknownSync("v", "failed", "对方没收到")).toBe("resolved");
    expect(hub.getOutboxSync("v")).toMatchObject({ status: "failed", error: "timeout; verified on the external side as failed: 对方没收到" });
    expect(await hub.retryFailed("v")).toBe("sent");
    expect(hub.getOutboxSync("v")?.sentAt).toBe(clock.now());
  });

  it("lists and filters outbox rows", async () => {
    const { hub, clock } = setup();
    await hub.send({ target: ALICE, content: text("1"), idempotencyKey: "o1", cellId: "desk" });
    clock.advance(10);
    await hub.send({ target: "channel:memory:bob", content: text("2"), idempotencyKey: "o2" });
    clock.advance(10);
    await hub.send({ target: "channel:nowhere:x", content: text("3"), idempotencyKey: "o3" });
    expect(hub.listOutboxSync().map((r) => r.idempotencyKey)).toEqual(["o3", "o2", "o1"]);
    expect(hub.listOutboxSync({ order: "oldest", limit: 2 }).map((r) => r.idempotencyKey)).toEqual(["o1", "o2"]);
    expect(hub.listOutboxSync({ status: ["failed"] }).map((r) => r.idempotencyKey)).toEqual(["o3"]);
    expect(hub.listOutboxSync({ cellId: "desk" }).map((r) => r.idempotencyKey)).toEqual(["o1"]);
    expect(hub.listOutboxSync({ channelId: "memory" })).toHaveLength(2);
  });

  it("drives a plain Channel (no deliver) through its send with respectDnd false", async () => {
    const { hub } = setup();
    const seen: ChannelSendRequest[] = [];
    const answers = ["sent", "buffered_dnd"] as const;
    const plain: Channel = {
      id: "plain",
      capabilities: { idempotentSend: false, withdrawOrEdit: false, streamingPreview: false },
      onIngress() {},
      async send(req) {
        seen.push(req);
        return answers[seen.length - 1]!;
      },
    };
    hub.register(plain);
    expect(await hub.send({ target: "channel:plain:t", content: text("x"), idempotencyKey: "p1", actionToken: undefined })).toBe("sent");
    expect(seen[0]).toEqual({ target: "t", content: text("x"), idempotencyKey: "p1", respectDnd: false });
    // An adapter that buffers on its own gives no trustworthy receipt.
    expect(await hub.send({ target: "channel:plain:t", content: text("x"), idempotencyKey: "p2" })).toBe("unknown");
    expect(hub.listInfoSync().find((i) => i.id === "plain")?.kind).toBe("custom");
  });
});

describe("ChannelHub.send — action tokens", () => {
  it("verifies a presented token against the full target and content", async () => {
    const verify = vi.fn<ActionTokenVerifier>(() => ({ ok: true }));
    const { hub, mem } = setup({ verifyToken: verify });
    expect(await hub.send({ target: ALICE, content: text("draft v2"), idempotencyKey: "act_1", actionToken: "tok" })).toBe("sent");
    expect(verify).toHaveBeenCalledWith("tok", { target: ALICE, content: text("draft v2") });
    expect(mem.deliveries).toHaveLength(1);
  });

  it("a refused token fails with the reason, never reaches the adapter and cannot be retried", async () => {
    const { hub, mem } = setup({ verifyToken: () => ({ ok: false, reason: "token already used" }) });
    expect(await hub.send({ target: ALICE, content: text("x"), idempotencyKey: "r", actionToken: "tok" })).toBe("failed");
    expect(hub.getOutboxSync("r")).toMatchObject({ status: "failed", refused: true, attempts: 0, error: "refused: token already used" });
    expect(await hub.retryFailed("r")).toBe("failed");
    expect(mem.deliveries).toHaveLength(0);
  });

  it("fails closed: a token with no verifier configured, or a verifier that throws, is refused", async () => {
    const a = setup();
    expect(await a.hub.send({ target: ALICE, content: text("x"), idempotencyKey: "n", actionToken: "tok" })).toBe("failed");
    expect(a.hub.getOutboxSync("n")?.error).toMatch(/no verifier/);
    const b = setup({ verifyToken: () => { throw new Error("gate down"); } });
    expect(await b.hub.send({ target: ALICE, content: text("x"), idempotencyKey: "n", actionToken: "tok" })).toBe("failed");
    expect(b.hub.getOutboxSync("n")?.error).toMatch(/gate down/);
    expect(a.mem.deliveries.length + b.mem.deliveries.length).toBe(0);
  });

  it("without requireToken a tokenless send is trusted; with it, refused", async () => {
    const open = setup({ verifyToken: () => ({ ok: false, reason: "x" }) });
    expect(await open.hub.send({ target: ALICE, content: text("x"), idempotencyKey: "k" })).toBe("sent");
    const strict = setup({ verifyToken: () => ({ ok: true }), requireToken: true });
    expect(await strict.hub.send({ target: ALICE, content: text("x"), idempotencyKey: "k" })).toBe("failed");
    expect(strict.hub.getOutboxSync("k")).toMatchObject({ refused: true, error: "refused: an action token is required" });
    expect(await strict.hub.send({ target: ALICE, content: text("x"), idempotencyKey: "k2", actionToken: "t" })).toBe("sent");
  });

  it("a verified token survives a transport failure: the retry needs no new token", async () => {
    let uses = 0;
    const { hub, mem } = setup({ verifyToken: () => (uses++ === 0 ? { ok: true } : { ok: false, reason: "token already used" }) });
    mem.respondWith("failed");
    expect(await hub.send({ target: ALICE, content: text("x"), idempotencyKey: "a1", actionToken: "tok" })).toBe("failed");
    expect(await hub.retryFailed("a1")).toBe("sent");
    expect(uses).toBe(1);
  });
});

describe("ChannelHub — DND (Engage focus)", () => {
  it("buffers non-urgent sends while focused; urgent and respectDnd:false go straight out", async () => {
    const { hub, mem, events } = setup();
    hub.setFocusSync(true);
    expect(hub.isFocusSync()).toBe(true);
    expect(await hub.send({ target: ALICE, content: text("周报好了"), idempotencyKey: "b1" })).toBe("buffered_dnd");
    expect(await hub.send({ target: ALICE, content: text("服务挂了"), idempotencyKey: "u1", urgent: true })).toBe("sent");
    expect(await hub.send({ target: ALICE, content: text("已批准的回复"), idempotencyKey: "a1", respectDnd: false })).toBe("sent");
    expect(await hub.send({ target: ALICE, content: text("第二条"), idempotencyKey: "b2" })).toBe("buffered_dnd");
    expect(await hub.send({ target: ALICE, content: text("周报好了"), idempotencyKey: "b1" })).toBe("buffered_dnd");
    expect(mem.deliveries.map((d) => d.idempotencyKey)).toEqual(["u1", "a1"]);
    expect(hub.bufferedCountSync()).toBe(2);
    expect(hub.listBufferedSync().map((r) => [r.idempotencyKey, r.attempts])).toEqual([["b1", 0], ["b2", 0]]);
    const focus = events.filter((e) => e.topic === "channel.focus").map((e) => e.data);
    expect(focus).toEqual([{ on: true, buffered: 0 }, { on: true, buffered: 1 }, { on: true, buffered: 2 }]);
  });

  it("leaving focus sends nothing by itself; flushBuffered delivers in order and returns receipts", async () => {
    const { hub, mem, clock, events } = setup();
    hub.setFocusSync(true);
    for (const k of ["n1", "n2", "n3"]) {
      await hub.send({ target: ALICE, content: text(k), idempotencyKey: k });
      clock.advance(1);
    }
    hub.setFocusSync(false);
    expect(events.filter((e) => e.topic === "channel.focus").at(-1)?.data).toEqual({ on: false, buffered: 3 });
    expect(mem.deliveries).toHaveLength(0);
    mem.respondWith("sent").respondWith("failed").respondWith("unknown");
    const r = await hub.flushBuffered();
    expect(r).toEqual({
      sent: 1,
      failed: 1,
      unknown: 1,
      receipts: [
        { idempotencyKey: "n1", channelId: "memory", target: "alice", receipt: "sent" },
        { idempotencyKey: "n2", channelId: "memory", target: "alice", receipt: "failed" },
        { idempotencyKey: "n3", channelId: "memory", target: "alice", receipt: "unknown" },
      ],
    });
    expect(mem.deliveries.map((d) => d.idempotencyKey)).toEqual(["n1", "n2", "n3"]);
    expect(hub.bufferedCountSync()).toBe(0);
    expect(await hub.flushBuffered()).toEqual({ sent: 0, failed: 0, unknown: 0, receipts: [] });
    expect(await hub.retryFailed("n2")).toBe("sent");
  });

  it("concurrent flushes deliver each buffered row exactly once", async () => {
    const { hub, mem } = setup();
    hub.setFocusSync(true);
    for (const k of ["c1", "c2", "c3"]) await hub.send({ target: ALICE, content: text(k), idempotencyKey: k });
    const [a, b] = await Promise.all([hub.flushBuffered(), hub.flushBuffered()]);
    expect(a.sent + b.sent).toBe(3);
    expect(mem.deliveries.map((d) => d.idempotencyKey)).toEqual(["c1", "c2", "c3"]);
  });

  it("focus is persisted, so a restarted hub keeps buffering", async () => {
    const { db, clock, hub } = setup();
    hub.setFocusSync(true);
    const again = setup({ db, clock });
    expect(again.hub.isFocusSync()).toBe(true);
    expect(await again.hub.send({ target: ALICE, content: text("x"), idempotencyKey: "z" })).toBe("buffered_dnd");
    again.hub.setFocusSync(false);
    expect(hub.isFocusSync()).toBe(false);
  });

  it("a buffered row whose channel disappeared fails on flush", async () => {
    const { hub } = setup();
    hub.setFocusSync(true);
    await hub.send({ target: ALICE, content: text("x"), idempotencyKey: "g" });
    hub.unregister("memory");
    expect(await hub.flushBuffered()).toMatchObject({ failed: 1, sent: 0 });
    expect(hub.getOutboxSync("g")).toMatchObject({ status: "failed", error: 'channel "memory" is not registered' });
  });
});

describe("ChannelHub.streamPreview", () => {
  it("passes chunks only to channels that declare streamingPreview", async () => {
    const { hub, mem, clock } = setup();
    const quiet = new MemoryChannel({ id: "quiet", clock, capabilities: { streamingPreview: false } });
    hub.register(quiet);
    await hub.streamPreview(ALICE, "正在");
    await hub.streamPreview("channel:quiet:bob", "drop me");
    await hub.streamPreview("channel:absent:bob", "drop me");
    expect(mem.previews).toEqual([{ target: "alice", chunk: "正在" }]);
    expect(quiet.previews).toEqual([]);
    await expect(hub.streamPreview("inbox:desk" as never, "x")).rejects.toThrow(/not a channel address/);
  });
});

describe("ChannelHub.edit", () => {
  it("edits a sent message on channels that support it and rewrites the stored content", async () => {
    const { hub, mem, clock } = setup();
    await hub.send({ target: ALICE, content: text("v1"), idempotencyKey: "e" });
    expect(await hub.edit("e", text("v2"))).toBe("edited");
    expect(mem.edits).toEqual([{ target: "alice", externalId: "mem-1", content: text("v2") }]);
    expect(hub.getOutboxSync("e")?.content).toEqual(text("v2"));

    const noEdit = new MemoryChannel({ id: "noedit", clock, capabilities: { withdrawOrEdit: false } });
    hub.register(noEdit);
    await hub.send({ target: "channel:noedit:x", content: text("v1"), idempotencyKey: "ne" });
    expect(await hub.edit("ne", text("v2"))).toBe("unsupported");

    mem.respondWith("failed");
    await hub.send({ target: ALICE, content: text("v1"), idempotencyKey: "nf" });
    expect(await hub.edit("nf", text("v2"))).toBe("not_sent");
  });

  it("checks a presented token like a send", async () => {
    const { hub, mem } = setup({ verifyToken: () => ({ ok: false, reason: "expired" }) });
    await hub.send({ target: ALICE, content: text("v1"), idempotencyKey: "e" });
    expect(await hub.edit("e", text("v2"), { actionToken: "t" })).toBe("refused");
    expect(mem.edits).toHaveLength(0);
    expect(hub.getOutboxSync("e")).toMatchObject({ content: text("v1"), error: "edit refused: expired" });
  });
});

describe("ChannelHub ingress", () => {
  it("hands adapter envelopes to the sink with the channel id and strips any `to`", async () => {
    const { hub, mem, received } = setup();
    const env = await mem.inject({ from: "alice", text: "在吗", threads: ["memory:t1"] });
    expect(received).toHaveLength(1);
    expect(received[0]!.channelId).toBe("memory");
    expect(received[0]!.env).toEqual(env);
    expect(env).toMatchObject({ from: "channel:memory:alice", principalId: "memory:alice", type: "user.message", kind: "event" });
    expect((await mem.inject({ from: "boss", text: "hi" })).principalId).toBe("owner");

    const spoof = new MemoryChannel({ id: "spoof" });
    hub.register(spoof);
    const sneaky = { id: "spoof:1", from: "channel:spoof:x", principalId: "spoof:x", kind: "event", type: "user.message", payload: {}, createdAt: 1, to: "inbox:other" };
    await (spoof as unknown as { emitIngress(e: unknown): Promise<void> }).emitIngress(sneaky);
    expect(received.at(-1)!.env).not.toHaveProperty("to");
  });

  it("refuses spoofed principals, foreign from addresses, and ingress with no sink wired", async () => {
    const { hub, mem, clock } = setup();
    const emit = (e: unknown) => (mem as unknown as { emitIngress(e: unknown): Promise<void> }).emitIngress(e);
    const base = { id: "m:1", from: "channel:memory:alice", principalId: "memory:alice", kind: "event", type: "user.message", payload: {}, createdAt: 1 };
    await expect(emit({ ...base, principalId: "cell:desk" })).rejects.toThrow(/principal/);
    await expect(emit({ ...base, principalId: "slack:U1" })).rejects.toThrow(/principal/);
    await expect(emit({ ...base, from: "channel:slack:C1" })).rejects.toThrow(/from/);
    await expect(emit({ ...base, id: "" })).rejects.toThrow(/missing id/);

    const db = openDatabase(":memory:");
    const { createChannelHub } = await import("../src");
    const lonely = createChannelHub({ db, bus: { emit() {}, on: () => () => {} } as never, clock });
    const ch = new MemoryChannel({ clock });
    lonely.register(ch);
    await expect(ch.inject({ from: "a", text: "x" })).rejects.toSatisfy((e: unknown) => e instanceof NgError && e.code === "unsupported");
    expect(ch.status().lastError).toMatch(/no ingress sink/);
  });

  it("an unregistered channel can no longer emit", async () => {
    const { hub, mem } = setup();
    hub.unregister("memory");
    await expect(mem.inject({ from: "a", text: "x" })).rejects.toThrow(/no longer registered/);
  });
});

describe("ChannelHub — 3-step Saga & actionId lookup (BUG-028)", () => {
  it("pitfall #1: prepareSendAttemptSync + deliverPreparedAttempt actually transmits (unlike hub.send on a pending key) and guards finalize by attemptSeq", async () => {
    const { hub, mem } = setup();
    const prep = hub.prepareSendAttemptSync({
      target: ALICE,
      content: text("hello saga"),
      idempotencyKey: "act_saga_1",
      actionId: "act_saga_1",
      respectDnd: false,
    });
    expect(prep).toMatchObject({ kind: "deliver", idempotencyKey: "act_saga_1", attemptSeq: 1 });
    expect(hub.getOutboxSync("act_saga_1")).toMatchObject({ status: "pending", attempts: 1, actionId: "act_saga_1" });

    // Pitfall check: calling hub.send on the same pre-written pending row would short-circuit to unknown without delivering!
    expect(await hub.send({ target: ALICE, content: text("hello saga"), idempotencyKey: "act_saga_1", respectDnd: false })).toBe("unknown");
    expect(mem.deliveries).toHaveLength(0);

    // deliverPreparedAttempt bypasses the short-circuit and transmits for real.
    if (prep.kind !== "deliver") throw new Error("expected deliver");
    const outcome = await hub.deliverPreparedAttempt(prep.rowId, prep.attemptSeq);
    expect(outcome).toMatchObject({ status: "sent" });
    expect(mem.deliveries).toHaveLength(1);

    // Finalizing with a mismatched attemptSeq is rejected; matching attemptSeq commits cleanly.
    expect(hub.finalizePreparedAttemptSync(prep.rowId, 99, { status: "failed", error: "stale" }).applied).toBe(false);
    expect(hub.finalizePreparedAttemptSync(prep.rowId, prep.attemptSeq, outcome).applied).toBe(true);
    expect(hub.getOutboxSync("act_saga_1")).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("stale attempt 1 cannot overwrite newer retry attempt 2; resolveUnknownByActionSync resolves the latest :retry: row", async () => {
    const { hub, mem } = setup();
    // 1) Normal retry via prepareSendAttemptSync reuses the failed row in place (attempts 1 -> 2) and blocks late attempt 1.
    const p1 = hub.prepareSendAttemptSync({ target: ALICE, content: text("v1"), idempotencyKey: "act_r1", actionId: "act_r1", respectDnd: false });
    if (p1.kind !== "deliver") throw new Error("expected deliver");
    mem.respondWith("failed");
    const o1 = await hub.deliverPreparedAttempt(p1.rowId, p1.attemptSeq);
    expect(hub.finalizePreparedAttemptSync(p1.rowId, p1.attemptSeq, o1).applied).toBe(true);
    expect(hub.getOutboxSync("act_r1")).toMatchObject({ status: "failed", attempts: 1 });

    const p2 = hub.prepareSendAttemptSync({ target: ALICE, content: text("v1"), idempotencyKey: "act_r1:retry:1", actionId: "act_r1", respectDnd: false });
    if (p2.kind !== "deliver") throw new Error("expected deliver");
    expect(p2.attemptSeq).toBe(2);
    mem.respondWith("unknown");
    const o2 = await hub.deliverPreparedAttempt(p2.rowId, p2.attemptSeq);
    expect(hub.finalizePreparedAttemptSync(p2.rowId, p2.attemptSeq, o2).applied).toBe(true);
    // Late attempt 1 finalizer cannot overwrite attempt 2.
    expect(hub.finalizePreparedAttemptSync(p2.rowId, 1, { status: "failed", error: "late" }).applied).toBe(false);
    expect(hub.getLatestOutboxByActionSync("act_r1")).toMatchObject({ status: "unknown", attempts: 2 });
    expect(hub.resolveUnknownByActionSync("act_r1", "sent")).toBe("resolved");
    expect(hub.getLatestOutboxByActionSync("act_r1")!.status).toBe("sent");

    // 2) When a separate :retry:1 key row exists for the same actionId (e.g. after a token-refused attempt 1),
    //    getLatestOutboxByActionSync and resolveUnknownByActionSync resolve the latest :retry:1 row, NOT the old row!
    const { hub: strictHub, mem: strictMem } = setup({
      verifyToken: (tok) => (tok === "good" ? { ok: true } : { ok: false, reason: "expired" }),
      requireToken: true,
    });
    expect(await strictHub.send({ target: ALICE, content: text("v1"), idempotencyKey: "act_r2", actionId: "act_r2", actionToken: "bad", respectDnd: false })).toBe("failed");
    expect(strictHub.getOutboxSync("act_r2")).toMatchObject({ status: "failed", refused: true });
    // Retry linked to the same actionId after a refused row generates a new :retry: key and goes unknown.
    const r2 = strictHub.prepareSendAttemptSync({ target: ALICE, content: text("v1"), idempotencyKey: "act_r2", actionId: "act_r2", actionToken: "good", respectDnd: false });
    if (r2.kind !== "deliver") throw new Error("expected deliver");
    expect(r2.idempotencyKey).toMatch(/^act_r2:retry:/);
    strictMem.respondWith("unknown");
    const out2 = await strictHub.deliverPreparedAttempt(r2.rowId, r2.attemptSeq);
    expect(strictHub.finalizePreparedAttemptSync(r2.rowId, r2.attemptSeq, out2).applied).toBe(true);
    expect(strictHub.getLatestOutboxByActionSync("act_r2")).toMatchObject({ idempotencyKey: r2.idempotencyKey, status: "unknown" });
    expect(strictHub.resolveUnknownByActionSync("act_r2", "sent")).toBe("resolved");
    expect(strictHub.getOutboxSync(r2.idempotencyKey)!.status).toBe("sent");
    expect(strictHub.getOutboxSync("act_r2")!.status).toBe("failed");
  });
});

it("keeps manual focus and concurrent editor leases independent and expires a crashed tab", async () => {
  const {hub,clock}=setup();
  hub.setEditorLeaseSync("first-tab",true);
  hub.setEditorLeaseSync("other-tab",true);
  hub.setFocusSync(true);
  hub.setEditorLeaseSync("first-tab",false);
  hub.setFocusSync(false);
  expect(hub.focusInfoSync()).toEqual({manual:false,editors:1});
  expect(await hub.send({target:ALICE,content:text("held"),idempotencyKey:"lease"})).toBe("buffered_dnd");
  expect((await hub.flushBuffered(true)).sent).toBe(0);
  clock.advance(45_001);
  expect(hub.expireEditorLeasesSync()).toBe(true);
  expect(hub.isFocusSync()).toBe(false);
  expect((await hub.flushBuffered(true)).sent).toBe(1);
});

it("keeps a prepared attempt in flight until the enclosing finalization commits", async () => {
  const {hub, db} = setup();
  const attempt = hub.prepareSendAttemptSync({target:ALICE, content:text("reply"), idempotencyKey:"rollback", respectDnd:false});
  if (attempt.kind !== "deliver") throw Error(attempt.kind);
  const delivery = await hub.deliverPreparedAttempt(attempt.rowId, attempt.attemptSeq);
  expect(() => withTx(db, () => {
    hub.finalizePreparedAttemptSync(attempt.rowId, attempt.attemptSeq, delivery);
    throw Error("rollback");
  })).toThrow("rollback");
  expect(hub.recoverInterruptedSync()).toBe(0);
  expect(hub.finalizePreparedAttemptSync(attempt.rowId, attempt.attemptSeq, delivery).applied).toBe(true);
  expect(hub.getOutboxSync("rollback")?.status).toBe("sent");
});
