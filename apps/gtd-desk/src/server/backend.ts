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
}

export interface SelectBackendOptions {
  detect?: (engine: CliEngine, bin: string) => boolean;
}

export class BackendConfigError extends Error {
  override name = "BackendConfigError";
}

export function selectBackend(env: Env, opts: SelectBackendOptions = {}): BackendChoice {
  let setting: ReturnType<typeof parseAgentBackend>;
  try {
    setting = parseAgentBackend(env["NG_AGENT_BACKEND"]) ?? "auto";
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
  const engine = setting === "auto" ? CLI_ENGINES.find(installed) : setting;
  if (!engine) throw new BackendConfigError("请安装 claude、codex 或 agy 后再启动工作台");
  if (!installed(engine)) {
    throw new BackendConfigError(`NG_AGENT_BACKEND=${engine}, but "${binOf(engine)} --version" does not run (install it or set NG_${engine.toUpperCase()}_BIN)`);
  }
  const models = cliModelsFromEnv(engine, env);
  return {
    engine,
    kernelOptions: {
      agentBackend: engine,
      cli: { [engine]: { bin: binOf(engine), ...(models ? { models } : {}), env } },
    },
  };
}
