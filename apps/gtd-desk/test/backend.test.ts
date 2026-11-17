import { describe, expect, it } from "vitest";
import { ScriptedModelClient } from "@ng/loop";
import type { CliEngine } from "@ng/protocol";
import { BackendConfigError, billReportedCostFromEnv, selectBackend, type Env } from "../src/server/backend";

const demoModel = () => new ScriptedModelClient(() => ({}));

/** A fake "which CLIs are installed" probe; records the binaries it was asked about. */
function installed(...engines: CliEngine[]) {
  const asked: Array<[CliEngine, string]> = [];
  const detect = (engine: CliEngine, bin: string) => {
    asked.push([engine, bin]);
    return engines.includes(engine);
  };
  return { detect, asked };
}

const pick = (env: Env, ...engines: CliEngine[]) => selectBackend(env, { demoModel, detect: installed(...engines).detect });
const KEY = { ANTHROPIC_API_KEY: "sk-test" };

describe("backend selection (NG_AGENT_BACKEND × installed CLIs × API key × NG_DESK_DEMO)", () => {
  it.each([
    // [label, env, installed CLIs, expected backend label, demo]
    ["auto: nothing installed, no key → demo", {}, [], "demo", true],
    ["auto: only a key → the API provider", KEY, [], "anthropic", false],
    ["auto: openai-compatible endpoint → openai", { NG_MODEL_PROVIDER: "openai", NG_OPENAI_BASE_URL: "http://localhost:1234/v1", NG_MODEL_STRONG: "deepseek-chat", NG_MODEL_FAST: "deepseek-chat" }, [], "openai", false],
    ["auto: claude installed (and a key) → the CLI wins", KEY, ["claude"], "claude", false],
    ["auto: prefers claude, then codex, then agy", {}, ["agy", "codex"], "codex", false],
    ["auto: agy alone", {}, ["agy"], "agy", false],
    ["explicit auto behaves like the default", { NG_AGENT_BACKEND: "auto" }, ["codex"], "codex", false],
    ["explicit api with a key ignores installed CLIs", { ...KEY, NG_AGENT_BACKEND: "api" }, ["claude"], "anthropic", false],
    ["explicit codex even though claude is installed too", { NG_AGENT_BACKEND: "codex" }, ["claude", "codex"], "codex", false],
    ["NG_DESK_DEMO=1 wins over everything", { ...KEY, NG_AGENT_BACKEND: "claude", NG_DESK_DEMO: "1" }, ["claude"], "demo", true],
  ] as Array<[string, Env, CliEngine[], string, boolean]>)("%s", (_label, env, clis, backend, demo) => {
    const c = pick(env, ...clis);
    expect(c.backend).toBe(backend);
    expect(c.demo).toBe(demo);
    expect(c.reason).toBeTruthy();
  });

  it("a CLI choice configures the kernel's agent backend, binary, tier models, environment and cost accounting", () => {
    const env: Env = { NG_CLAUDE_BIN: "/opt/claude/bin/claude", NG_CLAUDE_MODEL_STRONG: "sonnet", NG_CLAUDE_MODEL_FAST: "", NG_CLI_BILL_REPORTED_COST: "0", HOME: "/home/me" };
    const probe = installed("claude");
    const c = selectBackend(env, { demoModel, detect: probe.detect });
    expect(probe.asked).toEqual([["claude", "/opt/claude/bin/claude"]]);
    expect(c).toMatchObject({ backend: "claude", engine: "claude", demo: false });
    expect(c.kernelOptions.model).toBeUndefined();
    expect(c.kernelOptions.agentBackend).toBe("claude");
    expect(c.kernelOptions.cli?.claude).toEqual({ bin: "/opt/claude/bin/claude", models: { strong: "sonnet", fast: "" }, env, billReportedCost: false });
  });

  it("an API choice hands the kernel a model client and the api engine", () => {
    const c = pick(KEY);
    expect(c.kernelOptions.agentBackend).toBe("api");
    expect(c.kernelOptions.model?.provider).toBe("anthropic");
    expect(c.kernelOptions.cli).toBeUndefined();
  });

  it("demo mode runs the demo model on the api engine", () => {
    const model = demoModel();
    const c = selectBackend({}, { demoModel: () => model, detect: () => false });
    expect(c).toMatchObject({ backend: "demo", engine: "demo", demo: true, kernelOptions: { model, agentBackend: "api" } });
  });

  it("an explicit model (tests, embedding) wins over the environment", () => {
    const model = new ScriptedModelClient(() => ({}));
    const c = selectBackend({ NG_AGENT_BACKEND: "claude", NG_DESK_DEMO: "1" }, { model, demoModel, detect: () => true });
    expect(c).toMatchObject({ backend: "scripted", engine: "api", demo: false, kernelOptions: { model } });
  });

  it("naming a backend that cannot run fails at boot with the variable to fix", () => {
    expect(() => pick({ NG_AGENT_BACKEND: "claude" })).toThrow(BackendConfigError);
    expect(() => pick({ NG_AGENT_BACKEND: "claude" })).toThrow(/NG_CLAUDE_BIN/);
    expect(() => pick({ NG_AGENT_BACKEND: "api" }, "claude")).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => pick({ NG_AGENT_BACKEND: "gpt" })).toThrow(/unknown backend "gpt"/);
    expect(() => pick({ NG_MODEL_PROVIDER: "openai", NG_OPENAI_BASE_URL: "http://localhost:1234/v1" })).toThrow(BackendConfigError);
  });

  it("probes each CLI at most once, and none once one is found", () => {
    const probe = installed("claude");
    selectBackend({}, { demoModel, detect: probe.detect });
    expect(probe.asked).toEqual([["claude", "claude"]]);
  });

  it("NG_CLI_BILL_REPORTED_COST: on by default, 0/1 style values, anything else is a config error", () => {
    expect(billReportedCostFromEnv({})).toBe(true);
    expect(billReportedCostFromEnv({ NG_CLI_BILL_REPORTED_COST: "off" })).toBe(false);
    expect(billReportedCostFromEnv({ NG_CLI_BILL_REPORTED_COST: "1" })).toBe(true);
    expect(() => billReportedCostFromEnv({ NG_CLI_BILL_REPORTED_COST: "maybe" })).toThrow(BackendConfigError);
  });
});
