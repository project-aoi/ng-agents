import type { KernelOptions } from "@ng/cell";
import {
  cliBinsFromEnv,
  cliModelsFromEnv,
  DEFAULT_CLI_BINS,
  detectCli,
  parseAgentBackend,
} from "@ng/loop";
import { CLI_ENGINES, type CliEngine } from "@ng/protocol";

export type Env = Record<string, string | undefined>;

export interface BackendChoice {
  kernelOptions: Pick<KernelOptions, "agentBackend" | "cli">;
  engine: CliEngine;
  runners: readonly CliEngine[];
}

export interface SelectBackendOptions {
  detect?: (engine: CliEngine, bin: string) => boolean;
}

export class BackendConfigError extends Error {
  override name = "BackendConfigError";
}

export function selectBackend(env: Env, opts: SelectBackendOptions = {}): BackendChoice {
  const list = env["NG_AGENT_RUNNERS"];
  let setting: ReturnType<typeof parseAgentBackend>;
  try {
    setting = list === undefined ? (parseAgentBackend(env["NG_AGENT_BACKEND"]) ?? "auto") : undefined;
  } catch (err) {
    throw new BackendConfigError(err instanceof Error ? err.message : String(err));
  }
  const bins = cliBinsFromEnv(env);
  const binOf = (engine: CliEngine) => bins[engine] ?? DEFAULT_CLI_BINS[engine];
  const probe = opts.detect ?? ((engine: CliEngine, bin: string) => detectCli(engine, { bin, env }) !== null);
  const seen = new Map<CliEngine, boolean>();
  const installed = (engine: CliEngine) => {
    if (!seen.has(engine)) seen.set(engine, probe(engine, binOf(engine)));
    return seen.get(engine)!;
  };
  const runners: CliEngine[] = [];
  if (list !== undefined) {
    for (const entry of list.split(",")) {
      const value = entry.trim().toLowerCase();
      const runner = CLI_ENGINES.find((candidate) => candidate === value);
      if (!runner) throw new BackendConfigError(`NG_AGENT_RUNNERS: unknown runner "${entry}" (expected a comma-separated list of ${CLI_ENGINES.join(", ")})`);
      if (!runners.includes(runner)) runners.push(runner);
    }
  } else if (setting === "auto") {
    for (const candidate of CLI_ENGINES) {
      if (installed(candidate)) runners.push(candidate);
    }
  } else if (setting) {
    runners.push(setting);
  }
  const engine = runners[0];
  if (!engine) throw new BackendConfigError("请安装 claude、codex 或 agy 后再启动工作台");
  const cli: NonNullable<KernelOptions["cli"]> = {};
  for (const runner of runners) {
    if (!installed(runner)) {
      throw new BackendConfigError(`${list === undefined ? "NG_AGENT_BACKEND" : "NG_AGENT_RUNNERS"}: "${binOf(runner)} --version" does not run (install it or set NG_${runner.toUpperCase()}_BIN)`);
    }
    const models = cliModelsFromEnv(runner, env);
    cli[runner] = { bin: binOf(runner), ...(models ? { models } : {}), env };
  }
  return {
    engine,
    runners,
    kernelOptions: { agentBackend: engine, cli },
  };
}
