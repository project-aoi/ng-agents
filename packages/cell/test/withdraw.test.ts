import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD, type CodeProcessor, type Registry } from "@ng/protocol";
import { boot, cleanupAll, registerTestPresets } from "./helpers";

afterEach(cleanupAll);

describe("RunPorts.withdrawApproval", () => {
  it("takes down the cell's own pending card and refuses another cell's", async () => {
    const outcomes: string[] = [];
    const proc: CodeProcessor = {
      name: "test.card_then_withdraw",
      async run({ snapshot, ports }) {
        const self = ports.self.cellId;
        for (const env of snapshot.batch.envelopes) {
          const text = (env.payload as { instruction?: string; text?: string }).instruction ?? (env.payload as { text?: string }).text ?? "";
          if (env.type === PAYLOAD.cellTask && text === "raise") {
            const r = await ports.authorize({ type: "custom", name: "x", summary: "card", subjectKey: `s:${self}`, sideEffect: "external" });
            return r.type === "defer" ? "deferred_for_approval" : "completed";
          }
          if (text === "withdraw-own") outcomes.push(await ports.withdrawApproval!({ subjectKey: `s:${self}` }, "群里已有人回答"));
          if (text === "withdraw-other") outcomes.push(await ports.withdrawApproval!({ subjectKey: "s:a" }, "nope"));
        }
        return "completed";
      },
    };
    const h = await boot({
      setup(registry: Registry) {
        registerTestPresets(registry);
        registry.codeProcessors.register(proc);
      },
    });
    // persistent: both are talked to again after their first Run (a one-shot cell is closed once its Run completes)
    const spec = (id: string) => ({ id, preset: "worker" as const, lifetime: "persistent" as const, processor: { kind: "code" as const, entry: proc.name } });
    h.kernel.spawnCell("desk", spec("a"), "raise");
    h.kernel.spawnCell("desk", spec("b"), "other");
    await h.kernel.idle();
    const card = h.kernel.gate.findPendingBySubjectSync("s:a")!;
    expect(card.cellId).toBe("a");
    expect([h.kernel.getCell("a")!.status, h.kernel.getCell("b")!.status]).toEqual(["active", "active"]);

    const say = (cellId: string, text: string) =>
      h.kernel.inbox.enqueueSync(cellId, { id: `${cellId}-${text}`, from: "inbox:desk", principalId: "cell:desk", kind: "event", type: PAYLOAD.userMessage, payload: { text }, createdAt: h.clock.now() });
    say("b", "withdraw-other");
    await h.kernel.idle();
    expect(outcomes).toEqual(["not_pending"]);
    expect(h.kernel.gate.getApprovalSync(card.actionId)!.status).toBe("pending");

    say("a", "withdraw-own");
    await h.kernel.idle();
    expect(outcomes).toEqual(["not_pending", "cancelled"]);
    expect(h.kernel.gate.getApprovalSync(card.actionId)).toMatchObject({ status: "cancelled", statusReason: "群里已有人回答" });
    expect(h.kernel.gate.listPendingSync({ includeSnoozed: true })).toEqual([]);
  });
});
