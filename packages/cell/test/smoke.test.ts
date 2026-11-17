import { afterEach, describe, expect, it } from "vitest";
import { boot, cleanupAll, tool } from "./helpers";

afterEach(cleanupAll);

describe("smoke", () => {
  it("a message to the desk runs one Run and completes its claim", async () => {
    const h = await boot();
    h.script.add("desk", tool("set_state", { patches: { seen: true } }), { text: "done" });
    await h.memory.inject({ from: "alice", text: "hello" });
    await h.kernel.idle();
    expect(h.kernel.context.readStateSync("desk", "seen")).toBe(true);
    expect(h.of("run.finished").map((e) => e.outcome)).toEqual(["completed"]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk" }).map((m) => m.status)).toEqual(["done"]);
  });
});
