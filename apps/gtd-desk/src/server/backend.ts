import type { KernelOptions } from "@ng/cell";
import {
  apiProviderConfigured,
  cliBinsFromEnv,
  cliModelsFromEnv,
  createModelClientFromEnv,
  DEFAULT_CLI_BINS,
  detectCli,
  parseAgentBackend,
  resolveAgentBackendFromEnv,
} from "@ng/loop";
import type { AgentEngine, CliEngine, ModelClient } from "@ng/protocol";

export type Env = Record<string, string | undefined>;

export interface BackendChoice {
  /** Spread into createKernel's options. */
  kernelOptions: Pick<KernelOptions, "model" | "agentBackend" | "cli">;
  /** What runs the agents, shown in the status bar: "claude", "codex", "agy", "anthropic", "openai", "demo", … */
  backend: string;
  /** The engine of llm cells, or "demo" for the scripted demo model. */
  engine: AgentEngine | "demo";
  /** Nothing real runs the agents: the UI labels itself as a demo. */
  demo: boolean;
  /** One line for the boot log: what was chosen and why. */
  reason: string;
}

export interface SelectBackendOptions {
  /** Explicit model (tests, embedding): wins over the environment, runs on the API loop. */
  model?: ModelClient;
  demoModel: () => ModelClient;
  /** Is this CLI installed and runnable? Default: `<bin> --version` succeeds (detectCli). */
  detect?: (engine: CliEngine, bin: string) => boolean;
}

/** Thrown at boot for a configuration that names a backend that cannot run. */
export class BackendConfigError extends Error {
  override name = "BackendConfigError";
}

/** A model provider is configured when the owner said which one, or Anthropic credentials are present. */
export function modelConfigured(env: Env): boolean {
  return apiProviderConfigured(env);
}

/**
 * `NG_CLI_BILL_REPORTED_COST`: whether the cost a CLI agent reports (Claude Code reports list-price USD even on a
 * subscription) is metered against the cells' cent budgets. Default on, so the budgets stay a real brake on a runaway
 * agent; set 0 when the CLI runs on a flat subscription and the cent budget should only count API usage. Tokens are
 * metered either way.
 */
export function billReportedCostFromEnv(env: Env): boolean {
  const v = env["NG_CLI_BILL_REPORTED_COST"]?.trim().toLowerCase();
  if (v === undefined || v === "") return true;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new BackendConfigError(`NG_CLI_BILL_REPORTED_COST must be 1 or 0, got "${env["NG_CLI_BILL_REPORTED_COST"]}"`);
}

function demoChoice(demoModel: () => ModelClient, reason: string): BackendChoice {
  return { kernelOptions: { model: demoModel(), agentBackend: "api" }, backend: "demo", engine: "demo", demo: true, reason };
}

function apiChoice(model: ModelClient, reason: string): BackendChoice {
  return { kernelOptions: { model, agentBackend: "api" }, backend: model.provider, engine: "api", demo: false, reason };
}

/**
 * The one place that turns configuration into what runs the agents (env in → kernel options out):
 *
 * 1. an explicit `model` (tests, embedding) → the API loop with it;
 * 2. `NG_DESK_DEMO=1` → demo mode;
 * 3. `NG_AGENT_BACKEND` = `claude` | `codex` | `agy` → that CLI agent (it must be installed: `NG_<CLI>_BIN` or PATH);
 *    `api` → the API provider (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, or `NG_MODEL_PROVIDER=openai` with
 *    `NG_OPENAI_BASE_URL`); naming one that cannot run is a BackendConfigError;
 * 4. `auto` (the default): the first installed of claude, codex, agy → else the API provider if configured → else demo.
 *
 * CLI settings: `NG_<CLI>_MODEL_STRONG` / `_FAST` (tier models), `NG_CLI_BILL_REPORTED_COST` (see
 * billReportedCostFromEnv). The CLI process gets this environment minus the kernel's own variables (CLI_ENV_DROP).
 */
export function selectBackend(env: Env, opts: SelectBackendOptions): BackendChoice {
  if (opts.model) return apiChoice(opts.model, `explicit model (${opts.model.provider})`);
  if (env["NG_DESK_DEMO"] === "1") return demoChoice(opts.demoModel, "NG_DESK_DEMO=1");

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
  const engine = resolveAgentBackendFromEnv(env, { detect: installed });
  const apiReady = apiProviderConfigured(env);

  if (engine === null) return demoChoice(opts.demoModel, "no CLI agent (claude, codex, agy) installed and no API model configured");
  if (engine === "api") {
    if (!apiReady) {
      throw new BackendConfigError("NG_AGENT_BACKEND=api needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN), or NG_MODEL_PROVIDER=openai with NG_OPENAI_BASE_URL");
    }
    let model: ModelClient;
    try {
      model = createModelClientFromEnv(env);
    } catch (err) {
      throw new BackendConfigError(err instanceof Error ? err.message : String(err));
    }
    return apiChoice(model, setting === "api" ? "NG_AGENT_BACKEND=api" : "no CLI agent installed; API model configured");
  }
  if (!installed(engine)) {
    throw new BackendConfigError(`NG_AGENT_BACKEND=${engine}, but "${binOf(engine)} --version" does not run (install it or set NG_${engine.toUpperCase()}_BIN)`);
  }
  const models = cliModelsFromEnv(engine, env);
  const billReportedCost = billReportedCostFromEnv(env);
  return {
    kernelOptions: {
      agentBackend: engine,
      cli: { [engine]: { ...(bins[engine] ? { bin: bins[engine] } : {}), ...(models ? { models } : {}), env, billReportedCost } },
    },
    backend: engine,
    engine,
    demo: false,
    reason: `${setting === "auto" ? "auto: installed CLI agent" : `NG_AGENT_BACKEND=${engine}`} (${binOf(engine)}${models ? `, models ${JSON.stringify(models)}` : ""}, reported cost ${billReportedCost ? "metered" : "not metered"})`,
  };
}
