import { afterEach, describe, expect, it } from "vitest";
import { cellsRepo, PAYLOAD, type HandbackPayload } from "@ng/protocol";
import { boot, cleanupAll, tool } from "./helpers";

afterEach(cleanupAll);

describe("ingress routing", () => {
  it("a filter watch (no thread) captures matching events; everything else goes to the desk", async () => {
    const h = await boot();
    h.kernel.spawnCell("desk", { id: "ci", preset: "checker", watches: [{ threadOrFilter: { type: "channel.event", "payload.event": "check_suite" } }] });
    const ev = (event: string) => ({ channelId: "memory", event, summary: `${event} happened` });
    const r1 = await h.kernel.ingest(
      { id: "e1", from: "channel:memory:gh", principalId: "memory:gh", kind: "event", type: "channel.event", payload: ev("check_suite"), createdAt: h.clock.now() },
      "memory",
    );
    const r2 = await h.kernel.ingest(
      { id: "e2", from: "channel:memory:gh", principalId: "memory:gh", kind: "event", type: "channel.event", payload: ev("pull_request"), createdAt: h.clock.now() },
      "memory",
    );
    expect(r1).toEqual({ envelopeId: "e1", routedBy: "watch", cellIds: ["ci"] });
    expect(r2).toEqual({ envelopeId: "e2", routedBy: "desk", cellIds: ["desk"] });
    await h.kernel.idle();
  });

  it("a paused subscription leaves both thread and filter traffic with the desk until resumed", async () => {
    const h = await boot({start:false});
    h.kernel.spawnCell("desk", {id:"watch",preset:"hub",watches:[
      {threadOrFilter:{thread:"memory:news"}},{threadOrFilter:{"payload.topic":"build"}},
    ]});
    const route = (id: string, byThread: boolean) => h.kernel.ingest({id, from:"channel:memory:test", principalId:"memory:test",
      type:PAYLOAD.userMessage, kind:"event", threads:byThread?["memory:news"]:[], payload:{text:"ping",topic:byThread?"news":"build"}, createdAt:h.clock.now()}, "memory");
    h.kernel.control("watch",{action:"pause"});
    expect(await route("paused-thread",true)).toMatchObject({cellIds:["desk"]});
    expect(await route("paused-filter",false)).toMatchObject({cellIds:["desk"]});
    expect(h.kernel.inbox.listMessagesSync({cellId:"watch"})).toEqual([]);
    h.kernel.control("watch",{action:"resume"});
    expect(await route("active-thread",true)).toMatchObject({cellIds:["watch"]});
    expect(await route("active-filter",false)).toMatchObject({cellIds:["watch"]});
  });

  it("keeps an active descendant of a paused project out of routing and execution", async () => {
    const { kernel, clock } = await boot({ start: false });
    kernel.spawnCell("desk", { id: "project", preset: "project" });
    kernel.spawnCell("project", { id: "hub", preset: "hub", watches: [{ threadOrFilter: { thread: "team" } }] });
    kernel.inbox.controlSync("project", { action: "pause", principalId: "owner" });
    expect(kernel.control("hub", { action: "resume" }).applied).toBe(false);
    expect(() => kernel.spawnCell("project", { id: "late", preset: "worker" })).toThrow(/paused/);

    cellsRepo(kernel.db).setStatus("hub", "active");
    expect(() => kernel.spawnCell("hub", { id: "deep", preset: "worker" })).toThrow(/paused/);
    const event = { id: "thread", from: "channel:ui:owner", principalId: "owner", kind: "event",
      type: PAYLOAD.userMessage, threads: ["team"], payload: { text: "ping" }, createdAt: clock.now() } as const;
    expect(await kernel.ingest({ ...event, threads: ["team"] }, "ui")).toMatchObject({ cellIds: ["desk"] });
    kernel.inbox.enqueueSync("hub", { ...event, threads: ["team"], id: "queued" });
    expect(kernel.inbox.claimNextRunSync("hub", "probe")).toBeNull();
    await kernel.start();
    await kernel.idle();
    expect(kernel.inbox.listMessagesSync({ cellId: "hub", envelopeId: "queued" })[0]?.status).toBe("pending");
    expect(kernel.control("project", { action: "resume" }).applied).toBe(true);
    await kernel.idle();
    expect(kernel.inbox.listMessagesSync({ cellId: "hub", envelopeId: "queued" })[0]?.status).toBe("done");
  });

  it("ingress needs a desk when nobody watches it (so an HTTP adapter answers non-2xx and the sender retries)", async () => {
    const h = await boot({ desk: false });
    await expect(h.memory.inject({ from: "x", text: "hi" })).rejects.toThrow(/no desk/);
  });

  it("an off-topic message in a watched thread is handed back to the desk with its original sender", async () => {
    const h = await boot();
    // Handing back a message does not end a persistent subscription.
    h.kernel.spawnCell("desk", { id: "w", preset: "hub", lifetime: "persistent", watches: [{ threadOrFilter: { thread: "memory:pr-108" } }] });
    h.script.add("hub", tool("handback", { reason: "a new, unrelated bug report" }));
    h.script.add("desk", { text: "triaged" });
    const env = await h.memory.inject({ from: "dave", text: "顺便说一下，登录页也坏了", threads: ["memory:pr-108"] });
    await h.kernel.idle();

    expect(h.kernel.inbox.listMessagesSync({ cellId: "w" })[0]).toMatchObject({ status: "handed_back", statusReason: "a new, unrelated bug report" });
    const [hb] = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.handback });
    expect(hb).toMatchObject({ status: "done" });
    expect(hb!.envelope).toMatchObject({ id: `${env.id}#handback#w`, principalId: "memory:dave", threads: ["memory:pr-108"] });
    expect((hb!.envelope.payload as HandbackPayload).original.id).toBe(env.id);
    expect(h.of("run.finished").map((e) => `${e.cellId}:${e.outcome}`).sort()).toEqual(["desk:completed", "w:completed"]);
  });

});
