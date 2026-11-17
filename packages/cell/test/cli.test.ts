import { afterEach, describe, expect, it } from "vitest";
import { CLI_FORK_SESSION_KEY, CLI_SESSION_KEY, type CliSessionRecord } from "@ng/loop";
import { installFakeCli } from "@ng/loop/testing";
import { createEnvelope, inboxAddr, PAYLOAD, type StepOrExternalEvidence } from "@ng/protocol";
import { createKernel } from "../src";
import { boot, cleanupAll, tempDir, tool, TOOLSETS, type Harness } from "./helpers";

afterEach(cleanupAll);

function message(h: Harness, cellId: string, text: string) {
  h.kernel.inbox.enqueueSync(
    cellId,
    createEnvelope({ from: "channel:ui:owner", to: inboxAddr(cellId), principalId: "owner", kind: "event", type: PAYLOAD.userMessage, payload: { text } }, h.clock),
  );
}

const evidence = (h: Harness, cellId: string): StepOrExternalEvidence[] => h.kernel.context.listEvidenceSync(cellId).map((e) => e.record);
const cliOpts = (fake: { bin: string; env: Record<string, string | undefined> }) => ({ bin: fake.bin, env: fake.env, pollMs: 30, killGraceMs: 500 });

describe("kernel with CLI engines", () => {
  it("runs a cell with engine set through its CLI loop while the desk runs through the API loop", async () => {
    const fakes = tempDir("fake-cli");
    const claude = installFakeCli(fakes, "claude", [
      { actions: [{ text: "noting it" }, { mcp: "set_state", args: { patches: { seen: "yes" } } }, { usage: { tokens: 700, costUsd: 0.01 } }] },
    ]);
    const h = await boot({ kernel: { cli: { claude: cliOpts(claude) } } });
    expect(h.kernel.agentBackend).toBe("api");
    h.script.add("desk", tool("set_state", { patches: { desk: "api" } }), { text: "ok" });
    h.kernel.createRootCell({ id: "clicell", title: "CLI cell", processor: { kind: "llm", engine: "claude", toolsets: [TOOLSETS.context, TOOLSETS.comms] } });

    await h.memory.inject({ from: "alice", text: "hello desk" });
    message(h, "clicell", "hello cli");
    await h.kernel.idle();

    // desk: API loop (the scripted model saw its request); the CLI cell never reached the model client
    expect(h.kernel.context.readStateSync("desk", "desk")).toBe("api");
    expect(h.script.requests.map((r) => r.cellId)).not.toContain("clicell");
    // CLI cell: kernel tool through the MCP bridge, transcript mirrored, usage on the shared ledger, session persisted
    expect(h.kernel.context.readStateSync("clicell", "seen")).toBe("yes");
    const ev = evidence(h, "clicell");
    expect(ev.map((e) => e.kind)).toEqual(["run_boundary", "inbound", "assistant_text", "tool_call", "tool_result", "run_boundary"]);
    expect(ev.at(-1)).toMatchObject({ kind: "run_boundary", phase: "end", outcome: "completed" });
    const usage = h.kernel.gate.usageSync("clicell");
    expect(usage.ownTokens).toBeGreaterThanOrEqual(700);
    expect(usage.ownCents).toBeCloseTo(1, 5);
    const rec = h.kernel.context.readStateSync<CliSessionRecord>("clicell", CLI_SESSION_KEY)!;
    expect(rec.engine).toBe("claude");

    // a root cell on isolation "none" without allowHostWrites is read-only for the CLI, in the owner's directory
    const launch = claude.launches()[0]!;
    expect(launch.join(" ")).toContain("--tools Read,Grep,Glob ");
    expect(launch.join(" ")).toContain("--permission-mode dontAsk");
  });

  it("gives a writing worker its git worktree as cwd and workspace-write; a fork_prefix child forks the parent's CLI session", async () => {
    const fakes = tempDir("fake-cli");
    const codex = installFakeCli(fakes, "codex", [
      { actions: [{ native: "shell", input: { command: "make" }, output: "built" }, { mcp: "report_to_parent", args: { kind: "result", text: "built it" } }] },
    ]);
    const claude = installFakeCli(fakes, "claude", [
      { actions: [{ mcp: "set_state", args: { patches: { parent: 1 } } }] },
      { actions: [{ mcp: "report_to_parent", args: { kind: "result", text: "forked child done" } }] },
      { actions: [{ text: "child reported" }] },
    ]);
    const h = await boot({ kernel: { cli: { codex: cliOpts(codex), claude: cliOpts(claude) } } });
    h.script.add("desk", { text: "noted" }, { text: "noted" });

    // worker on codex
    h.kernel.spawnCell("desk", { preset: "worker", title: "build", processor: { kind: "llm", engine: "codex", toolsets: [TOOLSETS.workspace, TOOLSETS.context, TOOLSETS.comms] } }, "build it");
    await h.kernel.idle();
    const log = codex.log();
    const argv = log.find((e) => e.type === "argv")!;
    expect(String(argv["cwd"])).toContain(`${h.dataDir}/workspace/worktrees/`);
    expect(log.find((e) => e.type === "codex_config")).toMatchObject({ sandbox: "workspace-write", approval: "never", mcpApproval: "approve" });
    const deskEv = evidence(h, "desk");
    expect(deskEv.some((e) => e.kind === "inbound" && e.envelope.type === PAYLOAD.cellResult)).toBe(true);

    // a CLI-run parent spawning a fork_prefix child: the kernel hands the child the parent's session to fork
    h.kernel.createRootCell({ id: "lead", processor: { kind: "llm", engine: "claude", toolsets: [TOOLSETS.context, TOOLSETS.comms, TOOLSETS.cells] } });
    message(h, "lead", "start");
    await h.kernel.idle();
    const parentRec = h.kernel.context.readStateSync<CliSessionRecord>("lead", CLI_SESSION_KEY)!;
    const addr = h.kernel.spawnCell("lead", { contextMode: "fork_prefix", title: "sub", processor: { kind: "llm", engine: "claude", toolsets: [TOOLSETS.context, TOOLSETS.comms] } }, "subtask");
    const childId = addr.slice("inbox:".length);
    await h.kernel.idle();
    const launches = claude.launches();
    expect(launches[1]).toEqual(expect.arrayContaining(["--resume", parentRec.sessionId, "--fork-session"]));
    const childRec = h.kernel.context.readStateSync<CliSessionRecord>(childId, CLI_SESSION_KEY)!;
    expect(childRec.forkedFrom).toBe(parentRec.sessionId);
    expect(h.kernel.context.readStateSync(childId, CLI_FORK_SESSION_KEY)).toBeNull();
    // the parent was woken by the child's result and resumed its own session with only the new input
    expect(launches[2]).toEqual(expect.arrayContaining(["--resume", parentRec.sessionId]));
    expect(launches[2]).not.toContain("--fork-session");
    expect(claude.prompts()[2]).toContain("forked child done");
    expect(claude.prompts()[2]).not.toContain("start");
  });

  it("needs a model, a loop or an installed CLI; a CLI default backend makes the model optional", async () => {
    const fakes = tempDir("fake-cli");
    const agy = installFakeCli(fakes, "agy", [{ actions: [{ mcp: "set_state", args: { patches: { via: "agy" } } }] }]);
    const missing = `${fakes}/not-installed`;
    expect(() => createKernel({ agentBackend: "auto", cli: { claude: { bin: missing }, codex: { bin: missing }, agy: { bin: missing } } })).toThrow(/installed CLI agent/);
    expect(() => createKernel({ agentBackend: "api" })).toThrow(/needs a model/);

    const h = await boot({ kernel: { model: undefined, agentBackend: "auto", cli: { claude: { bin: missing }, codex: { bin: missing }, agy: cliOpts(agy) } } });
    expect(h.kernel.agentBackend).toBe("agy");
    h.kernel.createRootCell({ id: "plain", processor: { kind: "llm", toolsets: [TOOLSETS.context] } });
    message(h, "plain", "hi");
    await h.kernel.idle();
    expect(h.kernel.context.readStateSync("plain", "via")).toBe("agy");
    expect(agy.log().find((e) => e.type === "acp_session")).toMatchObject({ method: "session/new" });
  });
});
