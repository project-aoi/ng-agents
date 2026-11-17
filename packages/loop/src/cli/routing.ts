import { CLI_ENGINES, NgError, type AgentEngine, type AgentLoop, type CliEngine, type ModelClient, type PromptSnapshot, type RunOutcome, type RunPorts } from "@ng/protocol";
import { CLI_SESSION_KEY } from "./loop";
import type { CliSessionRecord } from "./types";

export interface RoutingLoopOptions {
  /** The API tool loop; also runs every `code` processor. */
  api: AgentLoop;
  /** Engine for llm cells without `processor.engine`; null = none available (such Runs fail with a clear error). */
  defaultEngine: AgentEngine | null;
  /** Creates (once, on first use) the loop for a CLI engine. */
  cliLoop(engine: CliEngine): AgentLoop;
  /** Called per Run with the engine chosen (diagnostics). */
  onRoute?(e: { cellId: string; runId: string; engine: AgentEngine | "code" }): void;
}

export interface RoutingLoop extends AgentLoop {
  /** The engine an llm processor would run on (null = none available). */
  engineFor(processor: PromptSnapshot["spec"]["processor"]): AgentEngine | "code" | null;
  readonly defaultEngine: AgentEngine | null;
}

/**
 * Picks the executor per Run: `code` processors and `engine: "api"` → the API loop; a CLI engine (the processor's own,
 * else the kernel default) → that CLI's loop. A cell whose last CLI session belongs to another engine than the one now
 * running it loses that record, so a later switch back starts a fresh session primed with the full history instead of
 * resuming a session that missed these Runs.
 */
export function createRoutingLoop(opts: RoutingLoopOptions): RoutingLoop {
  const cli = new Map<CliEngine, AgentLoop>();
  const loopFor = (engine: CliEngine): AgentLoop => {
    let l = cli.get(engine);
    if (!l) cli.set(engine, (l = opts.cliLoop(engine)));
    return l;
  };

  function engineFor(processor: PromptSnapshot["spec"]["processor"]): AgentEngine | "code" | null {
    if (processor.kind === "code") return "code";
    return processor.engine ?? opts.defaultEngine;
  }

  async function run(snapshot: PromptSnapshot, ports: RunPorts, signal: AbortSignal): Promise<RunOutcome> {
    const engine = engineFor(snapshot.spec.processor);
    opts.onRoute?.({ cellId: snapshot.cellId, runId: snapshot.runId, engine: engine ?? "api" });
    if (engine === null) {
      throw new NgError("unsupported", "no agent backend is available for llm cells: install claude, codex or agy, or configure an API model");
    }
    if (engine === "code") return opts.api.run(snapshot, ports, signal);
    if (engine !== "api" && !(CLI_ENGINES as readonly string[]).includes(engine)) throw new NgError("invalid_argument", `unknown engine "${String(engine)}"`);
    const rec = await ports.context.readState<CliSessionRecord>(snapshot.cellId, CLI_SESSION_KEY).catch(() => null);
    if (rec && rec.engine !== engine) {
      await ports.context.commit(snapshot.cellId, { statePatches: { [CLI_SESSION_KEY]: null } }).catch(() => undefined);
    }
    return engine === "api" ? opts.api.run(snapshot, ports, signal) : loopFor(engine).run(snapshot, ports, signal);
  }

  return { run, engineFor, defaultEngine: opts.defaultEngine };
}

/**
 * Stand-in ModelClient when no API model is configured (CLI backend): code processors never call it, and an llm cell
 * that explicitly asks for `engine: "api"` gets a clear error instead of a crash.
 */
export class UnconfiguredModelClient implements ModelClient {
  readonly provider = "none";
  modelFor(): string {
    return "none";
  }
  async complete(): Promise<never> {
    throw new NgError("unsupported", 'this cell runs on engine "api", but the kernel has no API model configured (pass `model` to createKernel or use a CLI engine)');
  }
}
