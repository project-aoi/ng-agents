import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { CliEngine } from "@ng/protocol";
import { cliEnvironment } from "./env";

/**
 * The models a CLI agent offers, asked from the CLI itself — never a list kept in this repository: the catalogue and
 * the model a vendor considers its best change with every CLI release and with the owner's account.
 *
 * - Claude Code: the `initialize` control request of its stream-json mode answers with `models[]` (the first entry is
 *   its "default (recommended)" alias with the model it resolves to).
 * - Codex: `codex debug models` prints the catalogue as JSON, with a `priority` (1 = shown first).
 * - Antigravity: `agy models` prints `id<TAB>label` lines; the reasoning effort is part of the id
 *   (`gemini-4-carbon-high`), so the variants of one family are folded into one model with efforts.
 */

export interface CliModelInfo {
  /** What the owner selects (Claude: alias or full name; Codex: slug; Antigravity: the family id without effort). */
  id: string;
  label: string;
  description?: string;
  /** Reasoning efforts this model offers, weakest first; empty when the model has no such setting. */
  efforts: string[];
}

export interface CliModelChoice {
  model: string;
  effort?: string;
}

export interface CliModelCatalog {
  engine: CliEngine;
  models: CliModelInfo[];
  /** The CLI's own first choice at the effort `preferredEffort` picks; null when the list is empty. */
  recommended: CliModelChoice | null;
  fetchedAt: number;
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
const rank = (e: string) => {
  const i = (EFFORT_ORDER as readonly string[]).indexOf(e.toLowerCase());
  return i === -1 ? EFFORT_ORDER.length : i;
};
export const sortEfforts = (efforts: readonly string[]) => [...new Set(efforts.map((e) => e.toLowerCase()))].sort((a, b) => rank(a) - rank(b));

/**
 * The effort used when the owner did not pick one: "xhigh" where the model offers it, otherwise the strongest it
 * offers below that. The levels above xhigh ("max", "ultra") are for the owner to choose deliberately.
 */
export function preferredEffort(efforts: readonly string[]): string | undefined {
  const sorted = sortEfforts(efforts);
  if (sorted.length === 0) return undefined;
  const cap = rank("xhigh");
  const within = sorted.filter((e) => rank(e) <= cap);
  return (within.length ? within : sorted.slice(0, 1)).at(-1);
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

function recommend(models: readonly CliModelInfo[], preferredId?: string): CliModelChoice | null {
  const m = (preferredId ? models.find((x) => x.id === preferredId) : undefined) ?? models[0];
  if (!m) return null;
  const effort = preferredEffort(m.efforts);
  return effort ? { model: m.id, effort } : { model: m.id };
}

/** Claude Code `initialize` control response → models. The "default" alias is not listed; it names the recommendation. */
export function parseClaudeModels(response: unknown): { models: CliModelInfo[]; recommended: CliModelChoice | null } {
  const raw = Array.isArray(asRecord(response)["models"]) ? (asRecord(response)["models"] as unknown[]).map(asRecord) : [];
  const models: CliModelInfo[] = [];
  let defaultResolved: string | undefined;
  const resolvedOf = new Map<string, string>();
  for (const m of raw) {
    const id = str(m["value"]);
    if (!id) continue;
    const resolved = str(m["resolvedModel"]) ?? id;
    if (id === "default") {
      defaultResolved = resolved;
      continue;
    }
    resolvedOf.set(id, resolved);
    const description = str(m["description"]);
    models.push({
      id,
      label: str(m["displayName"]) ?? id,
      ...(description ? { description } : {}),
      efforts: sortEfforts(Array.isArray(m["supportedEffortLevels"]) ? (m["supportedEffortLevels"] as unknown[]).filter((e): e is string => typeof e === "string") : []),
    });
  }
  const preferred = defaultResolved ? models.find((m) => resolvedOf.get(m.id) === defaultResolved)?.id : undefined;
  return { models, recommended: recommend(models, preferred) };
}

/** `codex debug models` JSON → the listed models in the catalogue's own order (priority 1 first). */
export function parseCodexModels(json: unknown): { models: CliModelInfo[]; recommended: CliModelChoice | null } {
  const root = asRecord(json);
  const raw = (Array.isArray(root["models"]) ? (root["models"] as unknown[]) : Array.isArray(json) ? (json as unknown[]) : []).map(asRecord);
  const listed = raw
    .filter((m) => str(m["slug"]) && (m["visibility"] === undefined || m["visibility"] === "list"))
    .sort((a, b) => (typeof a["priority"] === "number" ? a["priority"] : Infinity) - (typeof b["priority"] === "number" ? b["priority"] : Infinity));
  const models = listed.map((m): CliModelInfo => {
    const description = str(m["description"]);
    const levels = Array.isArray(m["supported_reasoning_levels"]) ? (m["supported_reasoning_levels"] as unknown[]) : [];
    return {
      id: str(m["slug"])!,
      label: str(m["display_name"]) ?? str(m["slug"])!,
      ...(description ? { description } : {}),
      efforts: sortEfforts(levels.map((l) => (typeof l === "string" ? l : str(asRecord(l)["effort"]))).filter((e): e is string => Boolean(e))),
    };
  });
  return { models, recommended: recommend(models) };
}

const AGY_EFFORT_LABEL = /^(.*\S)\s*\((minimal|low|medium|high|xhigh|max|ultra)\)$/i;

/**
 * `agy models` text → models, in the order families first appear. `gemini-4-carbon-high  Gemini 4 Carbon (High)` and
 * its siblings become one model `gemini-4-carbon` with efforts; an entry without an effort stays as it is.
 */
export function parseAgyModels(text: string): { models: CliModelInfo[]; recommended: CliModelChoice | null } {
  const models: CliModelInfo[] = [];
  const byId = new Map<string, CliModelInfo>();
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue; // progress lines ("Fetching available models...") have no tab
    const rawId = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (!rawId || !label || /\s/.test(rawId)) continue;
    const m = AGY_EFFORT_LABEL.exec(label);
    const effort = m?.[2]?.toLowerCase();
    const family = effort && rawId.toLowerCase().endsWith(`-${effort}`) ? rawId.slice(0, -(effort.length + 1)) : null;
    if (m && effort && family) {
      let info = byId.get(family);
      if (!info) {
        info = { id: family, label: m[1]!, efforts: [] };
        byId.set(family, info);
        models.push(info);
      }
      info.efforts = sortEfforts([...info.efforts, effort]);
    } else if (!byId.has(rawId)) {
      const info: CliModelInfo = { id: rawId, label, efforts: [] };
      byId.set(rawId, info);
      models.push(info);
    }
  }
  return { models, recommended: recommend(models) };
}

/**
 * A choice as the CLI is launched with it. Antigravity has no separate effort setting — the effort is the id's suffix.
 */
export function launchChoice(engine: CliEngine, choice: CliModelChoice): { model: string; effort: string | undefined } {
  if (engine === "agy") return { model: choice.effort ? `${choice.model}-${choice.effort}` : choice.model, effort: undefined };
  return { model: choice.model, effort: choice.effort };
}

export interface ListCliModelsOptions {
  bin?: string;
  /** Base environment (default process.env); filtered like a cell's CLI process. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  now?: () => number;
}

const DEFAULT_BIN: Record<CliEngine, string> = { claude: "claude", codex: "codex", agy: "agy" };

function run(bin: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, cwd: tmpdir(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args.join(" ")} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

/** One `initialize` control request to a throw-away Claude Code process; nothing is sent to a model. */
function claudeInitialize(bin: string, env: Record<string, string>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], { env, cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`${bin} did not answer the model list request within ${timeoutMs}ms`))), timeoutMs);
    child.on("error", (e) => finish(() => reject(e)));
    child.on("exit", () => finish(() => reject(new Error(`${bin} exited before answering the model list request: ${err.trim().slice(0, 300)}`))));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: Record<string, unknown>;
        try {
          msg = asRecord(JSON.parse(line));
        } catch {
          continue;
        }
        if (msg["type"] !== "control_response") continue;
        const outer = asRecord(msg["response"]);
        if (outer["subtype"] === "error") return finish(() => reject(new Error(`${bin}: ${str(outer["error"]) ?? "model list request refused"}`)));
        const inner = asRecord(outer["response"]);
        return finish(() => resolve(Object.keys(inner).length ? inner : outer));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "ng-models", request: { subtype: "initialize" } })}\n`);
  });
}

/** Ask the CLI for its models. Rejects when the CLI cannot be run or answers nothing usable. */
export async function listCliModels(engine: CliEngine, opts: ListCliModelsOptions = {}): Promise<CliModelCatalog> {
  const bin = opts.bin ?? DEFAULT_BIN[engine];
  const env = cliEnvironment(opts.env ?? process.env);
  const timeoutMs = opts.timeoutMs ?? 45_000;
  let parsed: { models: CliModelInfo[]; recommended: CliModelChoice | null };
  if (engine === "claude") parsed = parseClaudeModels(await claudeInitialize(bin, env, timeoutMs));
  else if (engine === "codex") parsed = parseCodexModels(JSON.parse(await run(bin, ["debug", "models"], env, timeoutMs)));
  else parsed = parseAgyModels(await run(bin, ["models"], env, timeoutMs));
  if (parsed.models.length === 0) throw new Error(`${bin} listed no models`);
  return { engine, ...parsed, fetchedAt: (opts.now ?? Date.now)() };
}
