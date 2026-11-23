import { describe, expect, it } from "vitest";
import { selectBackend } from "../src/server/backend";

describe("CLI selection", () => {
  it("prefers the first installed CLI", () => {
    expect(selectBackend({}, { detect: engine => engine !== "claude" }).engine).toBe("codex");
  });

  it("checks the configured binary and passes its tier models", () => {
    const env = { NG_AGENT_BACKEND: "agy", NG_AGY_BIN: "/tools/agy", NG_AGY_MODEL_FAST: "fast" };
    const choice = selectBackend(env, { detect: (engine, bin) => engine === "agy" && bin === env.NG_AGY_BIN });
    expect(choice.kernelOptions).toEqual({ agentBackend: "agy", cli: { agy: { bin: env.NG_AGY_BIN, models: { fast: "fast" }, env } } });
    expect(() => selectBackend(env, { detect: () => false })).toThrow(/NG_AGY_BIN/);
  });

  it("rejects an unknown engine", () => {
    expect(() => selectBackend({ NG_AGENT_BACKEND: "invalid" })).toThrow(/unknown backend/);
  });

  it("uses the ordered runner list and prepares each runner's own executable and models", () => {
    const env = { NG_AGENT_RUNNERS: "codex, claude, codex", NG_CLAUDE_BIN: "/tools/claude", NG_CLAUDE_MODEL_STRONG: "opus" };
    const choice = selectBackend(env, { detect: (engine, bin) => engine === "codex" || bin === "/tools/claude" });
    expect(choice.engine).toBe("codex");
    expect(choice.runners).toEqual(["codex", "claude"]);
    expect(choice.kernelOptions.cli?.claude).toEqual({ bin: "/tools/claude", models: { strong: "opus" }, env });
    expect(choice.kernelOptions.cli?.codex).toEqual({ bin: "codex", env });
    expect(() => selectBackend({ NG_AGENT_RUNNERS: "codex,unknown" }, { detect: () => true })).toThrow(/unknown runner/);
    expect(() => selectBackend(env, { detect: (engine) => engine === "codex" })).toThrow(/NG_CLAUDE_BIN/);
  });
});
