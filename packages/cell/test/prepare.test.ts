import { afterEach, describe, expect, it } from "vitest";
import type { PrepareRunInput, Registry } from "@ng/protocol";
import { boot, cleanupAll, registerTestPresets, tool } from "./helpers";

afterEach(cleanupAll);

/** The test desk preset with a prepareRun hook: records what it saw, handles batches made only of "bookkeeping" messages. */
function withHook(seen: Array<{ texts: string[]; runId: string }>, opts: { fail?: boolean } = {}) {
  return (registry: Registry) => {
    registerTestPresets(registry);
    const desk = registry.presets.require("inline");
    (desk as { prepareRun?: unknown }).prepareRun = async ({ snapshot, ports }: PrepareRunInput) => {
      const texts = snapshot.batch.envelopes.map((e) => (e.payload as { text?: string }).text ?? "");
      seen.push({ texts, runId: ports.self.runId });
      if (opts.fail) throw new Error("bookkeeping broke");
      await ports.context.commit(ports.self.cellId, { statePatches: { [`books:${snapshot.runId}`]: texts } });
      return texts.every((t) => t.startsWith("bookkeeping")) ? "handled" : undefined;
    };
  };
}

describe("PresetDef.prepareRun", () => {
  it("runs before the Loop on every Run, and a handled batch completes without calling the model", async () => {
    const seen: Array<{ texts: string[]; runId: string }> = [];
    const h = await boot({ setup: withHook(seen) });

    await h.memory.inject({ from: "alice", text: "bookkeeping: a reminder came due" });
    await h.kernel.idle();
    expect(seen.map((s) => s.texts)).toEqual([["bookkeeping: a reminder came due"]]);
    expect(h.script.requests).toHaveLength(0);
    const first = h.of("run.finished").at(-1)!;
    expect(first).toMatchObject({ cellId: "desk", outcome: "completed" });
    expect(h.kernel.context.readStateSync("desk", `books:${seen[0]!.runId}`)).toEqual(["bookkeeping: a reminder came due"]);

    // A batch with a real item still reaches the model, after the hook already kept the books.
    h.script.add("desk", tool("set_state", { patches: { replied: true } }));
    await h.memory.inject({ from: "alice", text: "can you look at this?" });
    await h.kernel.idle();
    expect(seen).toHaveLength(2);
    expect(h.script.callsOf("desk")).toHaveLength(2);
    expect(h.kernel.context.readStateSync("desk", `books:${seen[1]!.runId}`)).toEqual(["can you look at this?"]);
    expect(h.kernel.context.readStateSync("desk", "replied")).toBe(true);
  });

  it("a failing hook is reported and the Loop runs anyway", async () => {
    const seen: Array<{ texts: string[]; runId: string }> = [];
    const errors: string[] = [];
    const h = await boot({ setup: withHook(seen, { fail: true }), kernel: { onError: (err, where) => errors.push(`${where}: ${String(err)}`) } });
    await h.memory.inject({ from: "alice", text: "bookkeeping only" });
    await h.kernel.idle();
    expect(seen).toHaveLength(1);
    expect(errors.some((e) => e.startsWith("prepareRun of desk") && e.includes("bookkeeping broke"))).toBe(true);
    expect(h.script.callsOf("desk")).toHaveLength(1);
  });
});
