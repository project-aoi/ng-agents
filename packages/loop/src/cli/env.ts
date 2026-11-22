import { CLI_ENGINES, type AgentEngine, type CliEngine, type ModelTier } from "@ng/protocol";
import { probeVersion } from "./process";
import type { CliModels } from "./types";

export type AgentBackendSetting = "auto" | AgentEngine;

export const DEFAULT_CLI_BINS: Readonly<Record<CliEngine, string>> = { claude: "claude", codex: "codex", agy: "agy" };

/**
 * The local CLI receives its own login environment, with workbench settings and parent session markers removed.
 */
export const CLI_ENV_DROP: readonly (string | RegExp)[] = [
  /^NG_/,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  /^CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_.*|EXECPATH|SSE_PORT)$/,
  /^CODEX_(THREAD_ID|SANDBOX.*|SESSION_ID|INTERNAL_.*)$/,
  /^ANTIGRAVITY_(CONVERSATION_ID|PROJECT_ID|CSRF_TOKEN|LS_ADDRESS|SIDECAR_.*)$/,
];

/**
 * The CLI process environment: the kernel's environment (HOME, PATH, locale, the owner's CLI configuration and
 * login) minus CLI_ENV_DROP and `drop`, with `keep` names exempted from dropping and `set` laid on top.
 */
export function cliEnvironment(
  base: Record<string, string | undefined> = process.env,
  opts: { keep?: readonly string[]; drop?: readonly (string | RegExp)[]; set?: Record<string, string> } = {},
): Record<string, string> {
  const keep = new Set(opts.keep ?? []);
  const rules = [...CLI_ENV_DROP, ...(opts.drop ?? [])];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (!keep.has(k) && rules.some((r) => (typeof r === "string" ? r === k : r.test(k)))) continue;
    out[k] = v;
  }
  return { ...out, ...opts.set };
}

const versionCache = new Map<string, string | null>();

/** Version of an installed CLI (`<bin> --version`), cached per binary; null when not installed or not runnable. */
export function detectCli(engine: CliEngine, opts: { bin?: string; env?: Record<string, string | undefined>; refresh?: boolean } = {}): string | null {
  const bin = opts.bin ?? DEFAULT_CLI_BINS[engine];
  if (!opts.refresh && versionCache.has(bin)) return versionCache.get(bin)!;
  const v = probeVersion(bin, cliEnvironment(opts.env ?? process.env));
  versionCache.set(bin, v);
  return v;
}

export function parseAgentBackend(value: string | undefined): AgentBackendSetting | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "auto" || (CLI_ENGINES as readonly string[]).includes(v)) return v as AgentBackendSetting;
  throw new Error(`NG_AGENT_BACKEND: unknown backend "${value}" (expected auto | claude | codex | agy)`);
}

export function resolveAgentBackend(
  setting: AgentBackendSetting,
  opts: { env?: Record<string, string | undefined>; bins?: Partial<Record<CliEngine, string>>; detect?: (engine: CliEngine) => boolean },
): AgentEngine | null {
  if (setting !== "auto") return setting;
  const detect = opts.detect ?? ((e: CliEngine) => detectCli(e, { ...(opts.bins?.[e] ? { bin: opts.bins[e] } : {}), ...(opts.env ? { env: opts.env } : {}) }) !== null);
  for (const engine of CLI_ENGINES) if (detect(engine)) return engine;
  return null;
}

export function resolveAgentBackendFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: { detect?: (engine: CliEngine) => boolean } = {},
): AgentEngine | null {
  const setting = parseAgentBackend(env["NG_AGENT_BACKEND"]) ?? "auto";
  return resolveAgentBackend(setting, { env, bins: cliBinsFromEnv(env), ...(opts.detect ? { detect: opts.detect } : {}) });
}

export function cliBinsFromEnv(env: Record<string, string | undefined> = process.env): Partial<Record<CliEngine, string>> {
  const out: Partial<Record<CliEngine, string>> = {};
  for (const e of CLI_ENGINES) {
    const v = env[`NG_${e.toUpperCase()}_BIN`];
    if (v) out[e] = v;
  }
  return out;
}

/**
 * Per-CLI tier models from `NG_<CLI>_MODEL_STRONG` / `NG_<CLI>_MODEL_FAST` (e.g. `NG_CLAUDE_MODEL_FAST=haiku`). An empty
 * value means the CLI's own default model. Unset tiers keep the adapter defaults.
 */
export function cliModelsFromEnv(engine: CliEngine, env: Record<string, string | undefined> = process.env): CliModels | undefined {
  const out: CliModels = {};
  let any = false;
  for (const tier of ["strong", "fast"] as const satisfies readonly ModelTier[]) {
    const v = env[`NG_${engine.toUpperCase()}_MODEL_${tier.toUpperCase()}`];
    if (v === undefined) continue;
    any = true;
    out[tier] = v.trim();
  }
  return any ? out : undefined;
}
