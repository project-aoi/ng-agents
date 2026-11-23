import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentLoop, PromptSnapshot, RunOutcome, RunPorts } from "@ng/protocol";
import {
  cliEnvironment,
  cliModelsFromEnv,
  createRoutingLoop,
  detectCli,
  parseAgentBackend,
  resolveAgentBackendFromEnv,
} from "../src";
import { createFakeRun, installFakeCli } from "../src/testing";

const dir = mkdtempSync(join(tmpdir(), "ngcli-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("CLI environment", () => {
  it("keeps the owner's CLI login and config, drops workbench settings, API keys and parent-agent session markers", () => {
    const env = cliEnvironment({
      HOME: "/home/u",
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/home/u/.claude-alt",
      CODEX_HOME: "/home/u/.codex",
      NG_DESK_HOST: "0.0.0.0",
      NG_DESK_DATA_DIR: "/home/u/.ng-desk",
      NG_AGENT_BACKEND: "claude",
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      UNDEFINED: undefined,
    });
    expect(env).toEqual({ HOME: "/home/u", PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/u/.claude-alt", CODEX_HOME: "/home/u/.codex" });
    expect(cliEnvironment({ ANTHROPIC_API_KEY: "k", NG_DESK_DATA_DIR: "/d" }, { keep: ["ANTHROPIC_API_KEY"], set: { A: "1" } })).toEqual({ ANTHROPIC_API_KEY: "k", A: "1" });
    expect(cliEnvironment({ GITHUB_TOKEN: "g" }, { drop: [/TOKEN$/] })).toEqual({});
  });
});

describe("agent backend resolution", () => {
  const none = () => false;
  it("reads NG_AGENT_BACKEND", () => {
    expect(resolveAgentBackendFromEnv({ NG_AGENT_BACKEND: "codex" }, { detect: none })).toBe("codex");
    expect(() => parseAgentBackend("gpt")).toThrow(/unknown backend/);
  });

  it("selects the first installed CLI", () => {
    expect(resolveAgentBackendFromEnv({}, { detect: (e) => e !== "claude" })).toBe("codex");
    expect(resolveAgentBackendFromEnv({ NG_AGENT_BACKEND: "auto" }, { detect: (e) => e === "agy" })).toBe("agy");
    expect(resolveAgentBackendFromEnv({}, { detect: none })).toBeNull();
  });

  it("detects an installed CLI by running --version; per-CLI tier models from the environment", () => {
    const fake = installFakeCli(dir, "codex");
    expect(detectCli("codex", { bin: fake.bin, refresh: true })).toBe("9.9.9");
    expect(detectCli("agy", { bin: join(dir, "missing-agy"), refresh: true })).toBeNull();
    expect(resolveAgentBackendFromEnv({ NG_CLAUDE_BIN: join(dir, "missing"), NG_CODEX_BIN: fake.bin, NG_AGY_BIN: join(dir, "missing") })).toBe("codex");
    expect(cliModelsFromEnv("claude", { NG_CLAUDE_MODEL_FAST: "haiku", NG_CLAUDE_MODEL_STRONG: "" })).toEqual({ fast: "haiku", strong: "" });
    expect(cliModelsFromEnv("agy", {})).toBeUndefined();
  });
});

describe("routing loop", () => {
  function stub(name: string, seen: string[]): AgentLoop {
    return {
      async run(snapshot: PromptSnapshot): Promise<RunOutcome> {
        seen.push(`${name}:${snapshot.cellId}`);
        return "completed";
      },
    };
  }

  it("routes code locally and creates each CLI loop once", async () => {
    const seen: string[] = [];
    const created: string[] = [];
    const routing = createRoutingLoop({
      local: stub("local", seen),
      defaultEngine: "claude",
      cliLoop: (e) => {
        created.push(e);
        return stub(e, seen);
      },
    });
    const go = async (cellId: string, processor: PromptSnapshot["spec"]["processor"], ports?: RunPorts) => {
      const r = createFakeRun({ cellId, spec: { processor } });
      return routing.run(r.snapshot, ports ?? r.ports, r.controller.signal);
    };
    await go("a", { kind: "llm" });
    await go("c", { kind: "code", entry: "join" });
    await go("d", { kind: "llm", engine: "agy" });
    await go("e", { kind: "llm" });
    expect(seen).toEqual(["claude:a", "local:c", "agy:d", "claude:e"]);
    expect(created).toEqual(["claude", "agy"]);
    expect(routing.engineFor({ kind: "llm", engine: "codex" })).toBe("codex");
  });


});
