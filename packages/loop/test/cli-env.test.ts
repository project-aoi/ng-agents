import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentLoop, PromptSnapshot, RunOutcome, RunPorts } from "@ng/protocol";
import {
  cliEnvironment,
  cliModelsFromEnv,
  CLI_SESSION_KEY,
  createRoutingLoop,
  detectCli,
  parseAgentBackend,
  resolveAgentBackendFromEnv,
  UnconfiguredModelClient,
} from "../src";
import { createFakeRun, installFakeCli } from "../src/testing";

const dir = mkdtempSync(join(tmpdir(), "ngcli-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("CLI environment", () => {
  it("keeps the owner's CLI login and config, drops kernel secrets and parent-agent session markers", () => {
    const env = cliEnvironment({
      HOME: "/home/u",
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/home/u/.claude-alt",
      CODEX_HOME: "/home/u/.codex",
      NG_SECRET_GITHUB: "ghp_x",
      NG_OPENAI_API_KEY: "sk-x",
      NG_AGENT_BACKEND: "claude",
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      UNDEFINED: undefined,
    });
    expect(env).toEqual({ HOME: "/home/u", PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/u/.claude-alt", CODEX_HOME: "/home/u/.codex" });
    expect(cliEnvironment({ ANTHROPIC_API_KEY: "k", NG_SECRET_X: "s" }, { keep: ["ANTHROPIC_API_KEY"], set: { A: "1" } })).toEqual({ ANTHROPIC_API_KEY: "k", A: "1" });
    expect(cliEnvironment({ GITHUB_TOKEN: "g" }, { drop: [/TOKEN$/] })).toEqual({});
  });
});

describe("agent backend resolution", () => {
  const none = () => false;
  it("reads NG_AGENT_BACKEND", () => {
    expect(resolveAgentBackendFromEnv({ NG_AGENT_BACKEND: "codex" }, { detect: none })).toBe("codex");
    expect(resolveAgentBackendFromEnv({ NG_AGENT_BACKEND: "API" }, { detect: none })).toBe("api");
    expect(() => parseAgentBackend("gpt")).toThrow(/unknown backend/);
  });

  it("auto: first installed of claude, codex, agy; else api with a provider key; else none", () => {
    expect(resolveAgentBackendFromEnv({}, { detect: (e) => e !== "claude" })).toBe("codex");
    expect(resolveAgentBackendFromEnv({ NG_AGENT_BACKEND: "auto" }, { detect: (e) => e === "agy" })).toBe("agy");
    expect(resolveAgentBackendFromEnv({ ANTHROPIC_API_KEY: "k" }, { detect: none })).toBe("api");
    expect(resolveAgentBackendFromEnv({ NG_MODEL_PROVIDER: "openai", NG_OPENAI_BASE_URL: "http://x" }, { detect: none })).toBe("api");
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

  it("routes code processors and engine api to the API loop, CLI engines to their (lazily created) loop", async () => {
    const seen: string[] = [];
    const created: string[] = [];
    const routing = createRoutingLoop({
      api: stub("api", seen),
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
    await go("b", { kind: "llm", engine: "api" });
    await go("c", { kind: "code", entry: "join" });
    await go("d", { kind: "llm", engine: "agy" });
    await go("e", { kind: "llm" });
    expect(seen).toEqual(["claude:a", "api:b", "api:c", "agy:d", "claude:e"]);
    expect(created).toEqual(["claude", "agy"]);
    expect(routing.engineFor({ kind: "llm", engine: "codex" })).toBe("codex");
  });

  it("drops a CLI session record when another engine runs the cell", async () => {
    const routing = createRoutingLoop({ api: stub("api", []), defaultEngine: "api", cliLoop: (e) => stub(e, []) });
    const r = createFakeRun({ spec: { processor: { kind: "llm" } } });
    r.ports.state.set(CLI_SESSION_KEY, { engine: "claude", sessionId: "s" });
    await routing.run(r.snapshot, r.ports, r.controller.signal);
    expect(r.ports.state.has(CLI_SESSION_KEY)).toBe(false);
  });

  it("fails clearly without any backend, and an API Run without a configured model", async () => {
    const routing = createRoutingLoop({ api: stub("api", []), defaultEngine: null, cliLoop: (e) => stub(e, []) });
    const r = createFakeRun({ spec: { processor: { kind: "llm" } } });
    await expect(routing.run(r.snapshot, r.ports, r.controller.signal)).rejects.toThrow(/no agent backend/);
    await expect(new UnconfiguredModelClient().complete()).rejects.toThrow(/no API model/);
  });
});
