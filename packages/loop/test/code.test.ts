import { describe, expect, it } from "vitest";
import { isNgError, type CodeProcessor } from "@ng/protocol";
import { createCodeLoop } from "../src";
import { createFakeRun } from "../src/testing";
import { makeRegistry } from "./helpers";

describe("code runs", () => {
  it("runs a registered code processor with its args, without making a model call", async () => {
    const registry = makeRegistry();
    const seen: unknown[] = [];
    const join: CodeProcessor = {
      name: "join_all_test",
      async run({ args, snapshot, ports }) {
        seen.push(args, snapshot.batch.envelopes.length);
        await ports.context.commit(ports.self.cellId, { statePatches: { joined: true } });
        return "yielded_waiting";
      },
    };
    registry.codeProcessors.register(join);
    const { ports, snapshot, controller } = createFakeRun({ spec: { processor: { kind: "code", entry: "join_all_test", args: { expect: 3 } } }, batch: ["a", "b"] });
    const outcome = await createCodeLoop(registry).run(snapshot, ports, controller.signal);
    expect(outcome).toBe("yielded_waiting");
    expect(seen).toEqual([{ expect: 3 }, 2]);
    expect(ports.state.get("joined")).toBe(true);
  });

  it("fails loudly for an unregistered entry, and reports cancelled when aborted mid-processor", async () => {
    const registry = makeRegistry();
    const loop = createCodeLoop(registry);
    const a = createFakeRun({ spec: { processor: { kind: "code", entry: "missing" } } });
    await expect(loop.run(a.snapshot, a.ports, a.controller.signal)).rejects.toSatisfy((e) => isNgError(e, "not_found"));

    registry.codeProcessors.register({ name: "slow", run: () => new Promise(() => undefined) });
    const b = createFakeRun({ spec: { processor: { kind: "code", entry: "slow" } } });
    const p = loop.run(b.snapshot, b.ports, b.controller.signal);
    setTimeout(() => b.controller.abort(), 5);
    expect(await p).toBe("cancelled");
  });

});
