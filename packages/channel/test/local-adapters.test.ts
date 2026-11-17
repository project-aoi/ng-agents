import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { validatePayload, type BusTopics } from "@ng/protocol";
import { CliChannel, MemoryChannel, UiChannel } from "../src";
import { setup, text } from "./helpers";

describe("UiChannel", () => {
  it("capture() enqueues a user.message from the owner and waits for the sink", async () => {
    const { hub, clock, received, bus } = setup();
    const ui = new UiChannel({ clock, bus });
    hub.register(ui);
    const env = await ui.capture({ text: "  周五下午 3 点提醒我给牙医打电话 ", clientId: "c-1", voice: true, attachments: [{ label: "图", uri: "res://1" }] });
    expect(env).toEqual({
      id: "ui:c-1",
      from: "channel:ui:owner",
      principalId: "owner",
      kind: "event",
      type: "user.message",
      payload: {
        text: "周五下午 3 点提醒我给牙医打电话",
        replyTo: "channel:ui:owner",
        sender: { id: "owner" },
        attachments: [{ label: "图", uri: "res://1" }],
        voice: true,
      },
      createdAt: clock.now(),
    });
    expect(validatePayload(env)).toEqual({ ok: true });
    expect(received.map((r) => r.channelId)).toEqual(["ui"]);
    await expect(ui.capture({ text: "   " })).rejects.toThrow(/empty/);
  });

  it("a failing sink makes capture reject, so the UI can tell the user it was not saved", async () => {
    const { hub, clock } = setup();
    const ui = new UiChannel({ clock });
    hub.register(ui);
    hub.onIngress(async () => {
      throw new Error("disk full");
    });
    await expect(ui.capture({ text: "x" })).rejects.toThrow("disk full");
  });

  it("owner notifications live in the outbox and are announced on the bus; DND buffers them", async () => {
    const { hub, clock, events } = setup();
    hub.register(new UiChannel({ clock }));
    expect(await hub.send({ target: "channel:ui:owner", content: text("PR 已合入"), idempotencyKey: "n1" })).toBe("sent");
    const changed = events.filter((e) => e.topic === "outbox.changed").map((e) => e.data as BusTopics["outbox.changed"]);
    expect(changed.at(-1)).toMatchObject({ channelId: "ui", idempotencyKey: "n1", status: "sent" });
    expect(hub.listOutboxSync({ channelId: "ui", status: ["sent"] }).map((r) => r.content.body)).toEqual(["PR 已合入"]);

    hub.setFocusSync(true);
    expect(await hub.send({ target: "channel:ui:owner", content: text("非紧急"), idempotencyKey: "n2" })).toBe("buffered_dnd");
    expect(hub.bufferedCountSync()).toBe(1);
    expect(await hub.edit("n1", text("PR #108 已合入"))).toBe("edited");
  });

  it("streams preview chunks to listeners and as channel.preview bus events", async () => {
    const { hub, clock, bus, events } = setup();
    const ui = new UiChannel({ clock, bus });
    hub.register(ui);
    const got: string[] = [];
    const off = ui.onPreview((_t, c) => got.push(c));
    await hub.streamPreview("channel:ui:owner", "正在");
    off();
    await hub.streamPreview("channel:ui:owner", "检索");
    expect(got).toEqual(["正在"]);
    expect(events.filter((e) => e.topic === "channel.preview").map((e) => e.data)).toEqual([
      { channelId: "ui", target: "owner", chunk: "正在" },
      { channelId: "ui", target: "owner", chunk: "检索" },
    ]);
  });
});

describe("CliChannel", () => {
  function cli() {
    const ctx = setup();
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const ch = new CliChannel({ clock: ctx.clock, input, output });
    ctx.hub.register(ch);
    return { ...ctx, ch, input, output: () => out };
  }

  it("reads lines in order as owner messages and skips blank lines", async () => {
    const { ch, input, received } = cli();
    expect(ch.status().state).toBe("stopped");
    ch.start();
    expect(ch.status().state).toBe("ready");
    input.write("第一行\n\n第二行\n");
    await new Promise((r) => setImmediate(r));
    await ch.idle();
    expect(received.map((r) => [r.channelId, (r.env.payload as { text: string }).text, r.env.principalId, r.env.from])).toEqual([
      ["cli", "第一行", "owner", "channel:cli:console"],
      ["cli", "第二行", "owner", "channel:cli:console"],
    ]);
    ch.stop();
    expect(ch.status().state).toBe("stopped");
  });

  it("writes sends to stdout and streams previews without breaking lines", async () => {
    const { hub, output } = cli();
    await hub.streamPreview("channel:cli:console", "思考");
    await hub.streamPreview("channel:cli:console", "中…");
    expect(await hub.send({ target: "channel:cli:console", content: { format: "markdown", title: "结果", body: "完成", attachments: [{ label: "日志", uri: "res://x" }] }, idempotencyKey: "c1" })).toBe("sent");
    expect(output()).toBe("思考中…\n结果\n\n完成\n\n- 日志: res://x\n");
  });

  it("tells the user when a line could not be saved", async () => {
    const { hub, ch, input, output } = cli();
    hub.onIngress(async () => {
      throw new Error("db locked");
    });
    ch.start();
    input.write("丢失的消息\n");
    await new Promise((r) => setImmediate(r));
    await ch.idle();
    expect(output()).toContain("未能保存这条消息：db locked");
  });
});

describe("MemoryChannel", () => {
  it("is scriptable per delivery and records attempts, previews and edits", async () => {
    const mem = new MemoryChannel();
    mem.respondWith("failed", { times: 2, error: "nope" }).setDefault("unknown");
    const ctrl = new AbortController();
    const req = { target: "t", content: text("x"), idempotencyKey: "k", attempt: 1, signal: ctrl.signal };
    expect(await mem.deliver(req)).toEqual({ status: "failed", error: "nope" });
    expect(await mem.deliver(req)).toEqual({ status: "failed", error: "nope" });
    expect((await mem.deliver(req)).status).toBe("unknown");
    mem.setDefault("hang");
    const hung = mem.deliver(req);
    ctrl.abort();
    expect((await hung).status).toBe("unknown");
    expect(mem.deliveries.map((d) => d.outcome)).toEqual(["failed", "failed", "unknown", "hang"]);
    expect(mem.sent).toEqual([]);
    mem.reset();
    expect(await mem.send({ target: "t", content: text("x"), idempotencyKey: "k" })).toBe("sent");
    expect(mem.sent).toHaveLength(1);
  });

  it("injects as a named counterpart, keeping a transport id for redelivery dedupe", async () => {
    const { mem, received } = setup();
    await mem.inject({ from: "zhang", text: "报价发你了", id: "evt-9", threads: ["memory:deal-7"] });
    await mem.inject({ from: "zhang", text: "报价发你了", id: "evt-9", threads: ["memory:deal-7"] });
    expect(received.map((r) => r.env.id)).toEqual(["memory:evt-9", "memory:evt-9"]);
    expect(received[0]!.env).toMatchObject({ principalId: "memory:zhang", threads: ["memory:deal-7"], payload: { text: "报价发你了", sender: { id: "zhang" } } });
    const custom = await mem.inject({ from: "ci", type: "channel.event", payload: { channelId: "memory", event: "build", summary: "green" }, delivery: "silent_inject" });
    expect(validatePayload(custom)).toEqual({ ok: true });
    expect(custom.delivery).toBe("silent_inject");
  });
});
