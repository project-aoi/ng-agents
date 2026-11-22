import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_ENGINES, createRegistry, type CliEngine } from "@ng/protocol";
import { CLI_SESSION_KEY, createCliAgentLoop, registerStandardToolsets, STANDARD_TOOLSETS, type CliDebugEvent, type CliSessionRecord } from "../src";
import { createFakeRun } from "../src/testing";

// Opt-in: spends a little of the owner's CLI subscription. NG_LIVE_CLI=claude,codex,agy (or "all").
const wanted = new Set(
  (process.env["NG_LIVE_CLI"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .flatMap((s) => (s === "all" ? [...CLI_ENGINES] : s ? [s] : [])),
);

describe.each([...CLI_ENGINES])("live %s (NG_LIVE_CLI)", (engine: CliEngine) => {
  it.skipIf(!wanted.has(engine))(
    "reads its workspace read-only, calls one kernel tool through the bridge and finishes",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `ng-live-${engine}-`)));
      writeFileSync(join(root, "README.md"), "The secret word is: pelican\n");
      const registry = createRegistry();
      registerStandardToolsets(registry);
      const debug: CliDebugEvent[] = [];
      const loop = createCliAgentLoop({ engine, registry, onDebug: (e) => debug.push(e), runTimeoutMs: 240_000 });
      const r = createFakeRun({
        cellId: `live-${engine}`,
        workspaceRoot: root,
        system: "You are a test cell of the ng kernel. Be terse.",
        spec: { processor: { kind: "llm", modelTier: "fast", toolsets: [STANDARD_TOOLSETS.context], allowedTools: ["read"] } },
        batch: ['Read README.md in your working directory, then call the set_state tool with patches {"smoke": "<the secret word>"}. Then reply with exactly: DONE'],
      });
      try {
        const outcome = await loop.run(r.snapshot, r.ports, r.controller.signal);
        const launch = debug.find((d) => d.type === "launch");
        const report = (
          JSON.stringify(
            {
              engine,
              outcome,
              argv: launch?.type === "launch" ? launch.argv : null,
              permissions: launch?.type === "launch" ? launch.permissions : null,
              state: Object.fromEntries(r.ports.state),
              evidence: r.ports.log.evidence.map((e) => ({ kind: e.kind, ...("name" in e ? { name: e.name } : {}), ...("text" in e ? { text: e.text.slice(0, 200) } : {}), ...("output" in e ? { output: e.output.slice(0, 200) } : {}) })),
              notices: debug.filter((d) => d.type !== "launch"),
            },
            null,
            1,
          )
        );
        // The default reporter hides console output of passing tests; keep the evidence of the paid run on disk.
        writeFileSync(join(tmpdir(), `ng-live-cli-${engine}.json`), report);
        console.log(report);
        expect(outcome).toBe("completed");
        expect(r.ports.state.get("smoke")).toBe("pelican");
        expect((r.ports.state.get(CLI_SESSION_KEY) as CliSessionRecord).engine).toBe(engine);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
