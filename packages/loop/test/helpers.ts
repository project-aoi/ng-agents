import { z } from "zod";
import { createRegistry, defineTool, ManualClock, type Registry, type Toolset } from "@ng/protocol";
import { registerStandardToolsets } from "../src";
import type { FakeRunPorts } from "../src/testing";

export const clock = () => new ManualClock(Date.UTC(2026, 10, 17, 8, 0, 0));

/** A toolset of probes for loop tests. */
export function probeToolset(): Toolset {
  return {
    name: "probe",
    tools: [
      defineTool({ name: "echo", kind: "kernel", description: "echo", input: z.object({ text: z.string() }), handler: (a) => `echo: ${a.text}` }),
      defineTool({
        name: "boom",
        kind: "kernel",
        description: "throws",
        input: z.object({}),
        handler: () => {
          throw new Error("kaboom");
        },
      }),
      defineTool({ name: "big", kind: "kernel", description: "long output", input: z.object({}), handler: () => "x".repeat(10_000) }),
      defineTool({ name: "hang", kind: "kernel", description: "never returns", input: z.object({}), handler: () => new Promise<string>(() => undefined) }),
      defineTool({
        name: "steer_me",
        kind: "kernel",
        description: "queues a steer message as if the user typed mid-run",
        input: z.object({ message: z.string() }),
        handler: (a, ctx) => {
          (ctx.ports as FakeRunPorts).pushSteer(a.message);
          return "ok";
        },
      }),
      defineTool({ name: "done", kind: "kernel", description: "ends run", input: z.object({}), handler: () => ({ output: "bye", endRun: "completed" }) }),
      defineTool({ name: "shell", kind: "bash", description: "bash-kind probe", input: z.object({}), handler: () => "sh" }),
      defineTool({ name: "peek", kind: "read", description: "read-kind probe", input: z.object({}), handler: () => "peeked" }),
    ],
  };
}

export function makeRegistry(): Registry {
  const registry = createRegistry();
  registerStandardToolsets(registry);
  registry.toolsets.register(probeToolset());
  registry.presets.register({
    name: "worker",
    description: "isolated worker",
    defaults: { contextMode: "isolated", processor: { kind: "llm", modelTier: "strong", toolsets: ["workspace", "kernel.comms"], maxSteps: 40 } },
  });
  registry.presets.register({
    name: "sensor",
    description: "check",
    defaults: { processor: { kind: "code", entry: "script:checks/metrics.sh" } },
  });
  return registry;
}
