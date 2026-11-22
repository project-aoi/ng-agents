import { CLI_ENGINES, NgError, type AgentEngine, type AgentLoop, type CliEngine, type PromptSnapshot, type RunOutcome, type RunPorts } from "@ng/protocol";
import { CLI_SESSION_KEY } from "./loop";
import type { CliSessionRecord } from "./types";

export interface RoutingLoopOptions {
  /** Executes locally assigned runs. */
  local: AgentLoop;
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
    if (engine) opts.onRoute?.({ cellId: snapshot.cellId, runId: snapshot.runId, engine });
    if (engine === "code" || engine === null) return opts.local.run(snapshot, ports, signal);
    if (!(CLI_ENGINES as readonly string[]).includes(engine)) throw new NgError("invalid_argument", `unknown engine "${String(engine)}"`);
    const rec = await ports.context.readState<CliSessionRecord>(snapshot.cellId, CLI_SESSION_KEY).catch(() => null);
    if (rec && rec.engine !== engine) {
      await ports.context.commit(snapshot.cellId, { statePatches: { [CLI_SESSION_KEY]: null } }).catch(() => undefined);
    }
    return loopFor(engine).run(snapshot, ports, signal);
  }

  return { run, engineFor, defaultEngine: opts.defaultEngine };
}
