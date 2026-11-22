import { afterEach, describe, expect, it } from "vitest";
import { CLI_FORK_SESSION_KEY, CLI_SESSION_KEY, type CliSessionRecord } from "@ng/loop";
import { installFakeCli } from "@ng/loop/testing";
import { join } from "node:path";
import { createEnvelope, inboxAddr, PAYLOAD, type CellResultPayload, type StepOrExternalEvidence } from "@ng/protocol";
import { createKernel } from "../src";
import { boot, cleanupAll, initRepo, tempDir, tool, TOOLSETS, type Harness } from "./helpers";

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
  it("runs a cell with engine set through its CLI loop while the desk uses the scripted fixture", async () => {
    const fakes = tempDir("fake-cli");
    const claude = installFakeCli(fakes, "claude", [
      { actions: [{ text: "noting it" }, { mcp: "set_state", args: { patches: { seen: "yes" } } }] },
    ]);
    const h = await boot({ kernel: { cli: { claude: cliOpts(claude) } } });
    expect(h.kernel.agentBackend).toBeNull();
    h.script.add("desk", tool("set_state", { patches: { desk: "api" } }), { text: "ok" });
    h.kernel.createRootCell({ id: "clicell", title: "CLI cell", processor: { kind: "llm", engine: "claude", toolsets: [TOOLSETS.context, TOOLSETS.comms] } });

    await h.memory.inject({ from: "alice", text: "hello desk" });
    message(h, "clicell", "hello cli");
    await h.kernel.idle();

    // Only the desk called the scripted test model.
    expect(h.kernel.context.readStateSync("desk", "desk")).toBe("api");
    expect(h.script.requests.map((r) => r.cellId)).not.toContain("clicell");
    // CLI cell: kernel tool through the MCP bridge, transcript mirrored, session persisted
    expect(h.kernel.context.readStateSync("clicell", "seen")).toBe("yes");
    const ev = evidence(h, "clicell");
    const kinds = ev.map(e => e.kind);
    expect(kinds.slice(0,2)).toEqual(["run_boundary","inbound"]);
    expect(kinds.slice(2,-1).sort()).toEqual(["assistant_text","tool_call","tool_result"]);
    expect(kinds.indexOf("tool_call")).toBeLessThan(kinds.indexOf("tool_result"));
    expect(ev.at(-1)).toMatchObject({ kind: "run_boundary", phase: "end", outcome: "completed" });
    const rec = h.kernel.context.readStateSync<CliSessionRecord>("clicell", CLI_SESSION_KEY)!;
    expect(rec.engine).toBe("claude");

    // docs/05: a root cell on the host is launched like any host cell — every built-in tool, unconfined, unsandboxed —
    // in the kernel's own directory for it (nobody gave it one)
    const launch = claude.launches()[0]!;
    const after = (flag: string) => launch[launch.indexOf(flag) + 1];
    expect(launch).not.toContain("--tools");
    expect(after("--permission-mode")).toBe("bypassPermissions");
    for (const f of ["--restricted", "--strict-mcp-config", "--settings"]) expect(launch).not.toContain(f);
    expect(claude.log().find((e) => e.type === "argv")!["cwd"]).toBe(join(h.dataDir, "cells", "clicell"));
  });

  it("runs a worker on the host in its cwd (unsandboxed) and a fork_prefix child forks the parent's CLI session", async () => {
    const fakes = tempDir("fake-cli");
    const codex = installFakeCli(fakes, "codex", [
      { actions: [{ native: "shell", input: { command: "make" }, output: "built" }, { mcp: "report_to_parent", args: { kind: "result", text: "built it" } }] },
      { actions: [{ mcp: "report_to_parent", args: { kind: "result", text: "built in the worktree" } }] },
    ]);
    const claude = installFakeCli(fakes, "claude", [
      { actions: [{ mcp: "set_state", args: { patches: { parent: 1 } } }] },
      { actions: [{ mcp: "report_to_parent", args: { kind: "result", text: "forked child done" } }] },
      { actions: [{ text: "child reported" }] },
    ]);
    const h = await boot({ kernel: { cli: { codex: cliOpts(codex), claude: cliOpts(claude) } } });
    h.script.add("desk", { text: "noted" }, { text: "noted" });
    const repo = initRepo();
    const codexProcessor = { kind: "llm" as const, engine: "codex" as const, toolsets: [TOOLSETS.workspace, TOOLSETS.context, TOOLSETS.comms] };

    // worker on codex, docs/05 default: the owner's real directory, no OS sandbox
    h.kernel.spawnCell("desk", { id: "build", preset: "worker", title: "build", cwd: repo, processor: codexProcessor }, "build it");
    await h.kernel.idle();
    const argvs = () => codex.log().filter((e) => e.type === "argv");
    const configs = () => codex.log().filter((e) => e.type === "codex_config");
    expect(argvs()[0]!["cwd"]).toBe(repo);
    expect(configs()[0]).toMatchObject({ sandbox: "danger-full-access", approval: "never", mcpApproval: "approve" });
    // the worker's settled turn reached the desk with what it reported; the worker stays, dormant, its session kept
    expect(h.kernel.getCell("build")!.status).toBe("active");
    expect(h.kernel.activityOf(["build"]).get("build")!.state).toBe("dormant");
    expect(h.kernel.context.readStateSync<CliSessionRecord>("build", CLI_SESSION_KEY)).toMatchObject({ engine: "codex" });
    const buildRun = h.of("run.started").find((e) => e.cellId === "build")!.runId;
    const deskEv = evidence(h, "desk");
    expect(
      deskEv.flatMap((e) => (e.kind === "inbound" && e.envelope.type === PAYLOAD.cellResult ? [[e.envelope.id, (e.envelope.payload as CellResultPayload).summary]] : [])),
    ).toEqual([[`build:${buildRun}:settled`, "built it"]]);

    // a CLI-run parent spawning a fork_prefix child: the kernel hands the child the parent's session to fork
    h.kernel.createRootCell({ id: "lead", cwd:repo, processor: { kind: "llm", engine: "claude", toolsets: [TOOLSETS.context, TOOLSETS.comms, TOOLSETS.cells] } });
    message(h, "lead", "unique-parent-start");
    await h.kernel.idle();
    const parentRec = h.kernel.context.readStateSync<CliSessionRecord>("lead", CLI_SESSION_KEY)!;
    const addr = h.kernel.spawnCell("lead", { contextMode: "fork_prefix", title: "sub", cwd:repo, processor: { kind: "llm", engine: "claude", toolsets: [TOOLSETS.context, TOOLSETS.comms] } }, "subtask");
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
    expect(claude.prompts()[2]).not.toContain("unique-parent-start");
  });

  it("requires an installed default CLI and runs unbound LLM cells with it", async () => {
    const fakes = tempDir("fake-cli");
    const agy = installFakeCli(fakes, "agy", [{ actions: [{ mcp: "set_state", args: { patches: { via: "agy" } } }] }]);
    const missing = `${fakes}/not-installed`;
    expect(() => createKernel({ agentBackend: "auto", cli: { claude: { bin: missing }, codex: { bin: missing }, agy: { bin: missing } } })).toThrow(/installed CLI agent/);

    const h = await boot({ kernel: { loop: undefined, agentBackend: "auto", cli: { claude: { bin: missing }, codex: { bin: missing }, agy: cliOpts(agy) } } });
    expect(h.kernel.agentBackend).toBe("agy");
    h.kernel.createRootCell({ id: "plain", processor: { kind: "llm", toolsets: [TOOLSETS.context] } });
    message(h, "plain", "hi");
    await h.kernel.idle();
    expect(h.kernel.context.readStateSync("plain", "via")).toBe("agy");
    expect(agy.log().find((e) => e.type === "acp_session")).toMatchObject({ method: "session/new" });
  });
});
