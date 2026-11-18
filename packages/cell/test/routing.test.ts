import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD, type HandbackPayload } from "@ng/protocol";
import { boot, cleanupAll, tool } from "./helpers";

afterEach(cleanupAll);

describe("ingress routing", () => {
  it("a filter watch (no thread) captures matching events; everything else goes to the desk", async () => {
    const h = await boot();
    h.kernel.spawnCell("desk", { id: "ci", preset: "watcher", watches: [{ threadOrFilter: { type: "channel.event", "payload.event": "check_suite" } }] });
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

  it("ingress needs a desk when nobody watches it (so an HTTP adapter answers non-2xx and the sender retries)", async () => {
    const h = await boot({ desk: false });
    await expect(h.memory.inject({ from: "x", text: "hi" })).rejects.toThrow(/no desk/);
  });

  it("an off-topic message in a watched thread is handed back to the desk with its original sender", async () => {
    const h = await boot();
    h.kernel.spawnCell("desk", { id: "w", preset: "watcher", watches: [{ threadOrFilter: { thread: "memory:pr-108" } }] });
    h.script.add("watcher", tool("handback", { reason: "a new, unrelated bug report" }));
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

  it("a 1:1 direct line: the owner grants a worker their channel and a thread; both directions skip the desk", async () => {
    const h = await boot();
    // a direct line outlives one piece of work: a persistent worker (a one-shot one would be closed after its first Run)
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", lifetime: "persistent", processor: { kind: "llm", toolsets: ["kernel.comms"] } });
    expect(h.kernel.getCell("w")!.bounds.canSendTo).toEqual(["inbox:*"]); // cells only, no channel
    // without the grant the worker cannot reach the owner at all
    h.script.add("worker", tool("send_message", { to: "channel:ui:owner", text: "进展：修好一半", summary: "progress" }));
    h.kernel.inbox.enqueueSync("w", { id: "t1", from: "inbox:desk", principalId: "cell:desk", kind: "event", type: PAYLOAD.userMessage, payload: { text: "go" }, createdAt: h.clock.now() });
    await h.kernel.idle();
    expect(h.kernel.hub.listOutboxSync({ channelId: "ui" })).toEqual([]);
    const refused = h.kernel.context.listEvidenceSync("w").map((e) => e.record).find((r) => r.kind === "tool_result" && r.name === "send_message");
    expect(refused).toMatchObject({
      isError: true,
      output: "This cell has no channel it may send to. Report to your parent (report_to_parent) or ask the desk (send_message to inbox:desk) instead.",
    });
    expect(h.kernel.gate.listApprovalsSync({ cellIds: ["w"] })).toEqual([]);

    h.kernel.updateCell("w", { bounds: { canSendTo: ["inbox:desk", "channel:ui:owner"] }, watches: [{ threadOrFilter: { thread: "ui:fix-login" } }] });
    expect(h.kernel.getCell("w")!.bounds.canSendTo).toEqual(["channel:ui:owner", "inbox:*"]);
    h.script.add("worker", tool("send_message", { to: "channel:ui:owner", text: "进展：修好一半", summary: "progress" }), { text: "sent" });
    await h.ui.capture({ text: "先别改样式，只修逻辑", threads: ["ui:fix-login"] });
    await h.kernel.idle();
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage })).toEqual([]);
    expect(h.kernel.hub.listOutboxSync({ channelId: "ui" }).map((o) => [o.status, o.cellId])).toEqual([["sent", "w"]]);
    expect(h.kernel.gate.listPendingSync()).toEqual([]);
  });
});
