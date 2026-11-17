import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NgError,
  normalizeToolResult,
  RUN_END_PRECEDENCE,
  selectRunTools,
  steerNoteText,
  systemClock,
  type AgentLoop,
  type CliEngine,
  type Clock,
  type LlmProcessorSpec,
  type ModelTier,
  type PromptSnapshot,
  type Registry,
  type RunOutcome,
  type RunPorts,
  type StepOrExternalEvidence,
  type ToolDef,
  type ToolKind,
  type ToolResult,
  type WorkspaceAccess,
} from "@ng/protocol";
import { raceAbort } from "../loop";
import { agyAdapter } from "./adapters/agy";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import { startToolBridge, type BridgeCallResult, type ToolBridge } from "./bridge";
import { cliEnvironment } from "./env";
import { spawnCli, type CliProcess } from "./process";
import { forkNoteIndex, freshPrompt, tailText } from "./render";
import type { CliAdapter, CliCapabilities, CliDriver, CliEvent, CliModels, CliSessionRecord, DriverIO, LaunchRequest } from "./types";

/** Context state key holding the cell's CLI session (CliSessionRecord). */
export const CLI_SESSION_KEY = "cli:session";
/** Set by the kernel on a fork_prefix child: the parent's CliSessionRecord at spawn time. */
export const CLI_FORK_SESSION_KEY = "cli:session:fork";
/** MCP server name the kernel tools are published under. */
export const CLI_MCP_SERVER = "ng";
/** Workspace tools the CLI's own file/shell tools replace (the kernel-only job tools and code_rpc stay on MCP). */
export const NATIVE_REPLACED_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash"]);

export const RUN_ENDED_NOTICE =
  "[The kernel ended this run with that result. Stop now: make no further tool calls and do no further work; reply with at most one short sentence. You will be woken with the next message.]";
export const RUN_ALREADY_ENDED = "Not executed: this run has already ended. Stop now; you will be woken with the next message.";

export function cliAdapterFor(engine: CliEngine): CliAdapter {
  switch (engine) {
    case "claude":
      return claudeAdapter();
    case "codex":
      return codexAdapter();
    case "agy":
      return agyAdapter();
  }
}

export interface CliAgentLoopOptions {
  engine: CliEngine;
  /** The shared registry (toolsets named by processor.toolsets). */
  registry: Registry;
  clock?: Clock;
  /** CLI executable. Default: the engine's command name on PATH. */
  bin?: string;
  /** Tier → model; `""` = the CLI's own default. Merged over the adapter defaults (strong = CLI default). */
  models?: CliModels;
  /** Tier when processor.modelTier is absent. Default "strong". */
  defaultTier?: ModelTier;
  /** Base environment for the CLI (default process.env), filtered by cliEnvironment. */
  env?: Record<string, string | undefined>;
  /** Variable names exempt from CLI_ENV_DROP (e.g. ANTHROPIC_API_KEY when the owner's CLI login is an API key). */
  keepEnv?: readonly string[];
  dropEnv?: readonly (string | RegExp)[];
  /** Offer the CLI's native web tools. Default false (the API loop has none either). */
  web?: boolean;
  /** Meter the cost a CLI reports (Claude Code reports list-price cost even on a subscription). Default true. */
  billReportedCost?: boolean;
  /** After a kernel tool ends the Run, how long the CLI may take to finish its turn before it is stopped. Default 10 s. */
  endRunGraceMs?: number;
  /** SIGTERM → SIGKILL grace. Default 3 s. */
  killGraceMs?: number;
  /** How often steer messages are polled (also the lease heartbeat). Default 250 ms. */
  pollMs?: number;
  /** Hard limit for one Run. Default 60 minutes. */
  runTimeoutMs?: number;
  /** Extra CLI arguments (appended to the adapter's). */
  extraArgs?: readonly string[];
  /** Node binary for the MCP shim. Default: this process's. */
  nodePath?: string;
  /** Replace the adapter (tests). */
  adapter?: CliAdapter;
  /** Diagnostics: invocations, CLI notices, refused permissions, stderr of failed processes. */
  onDebug?(event: CliDebugEvent): void;
}

export type CliDebugEvent =
  | { type: "launch"; engine: CliEngine; cellId: string; runId: string; argv: readonly string[]; cwd: string; session?: LaunchRequest["session"]; caps: CliCapabilities; permissions: string }
  | { type: "notice"; cellId: string; text: string }
  | { type: "exit"; cellId: string; code: number | null; signal: string | null; stderr: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EvidenceInput = DistributiveOmit<StepOrExternalEvidence, "runId" | "at">;
type EndOutcome = NonNullable<ToolResult["endRun"]>;
type StopReason = "cancelled" | "budget" | "timeout" | "steps";

interface LegOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  sawSession: boolean;
  turnOk: boolean;
  turnError: string | undefined;
  resumeFailed: string | undefined;
  /** Steer texts that need an interrupt + resume (CLI without live input). */
  relaunchWith: string[];
}

/**
 * ④ Loop backed by an installed CLI coding agent. One `run` = one bounded Run:
 *
 * 1. Capabilities: WorkspaceAccess (root, kernel-allowed tool kinds) ∩ processor.allowedTools → read-only or writing,
 *    mapped by the adapter onto the CLI's own permission/sandbox flags. cwd = the workspace root.
 * 2. Kernel tools: selectRunTools (same names, descriptions, schemas as the API loop) minus the workspace tools the CLI
 *    replaces natively, served by a per-Run loopback MCP bridge bound to this Run's ports.
 * 3. Session: resume the cell's CLI session (Context state CLI_SESSION_KEY) with only the volatile tail; otherwise a
 *    fresh session with the frozen system text as the CLI's system prompt and the rendered history as the first
 *    message; fork_prefix children fork the parent's session when the CLI can. A failed resume/fork falls back to fresh.
 * 4. Everything the CLI does is mirrored into evidence (assistant text, tool calls and results, steer notes) and every
 *    reported usage is metered. endRun from a kernel tool ends the Run with the same outcome as the API loop (the CLI
 *    is told to stop and is stopped if it does not); abort kills the process tree; hard_stop → budget_stopped.
 */
export function createCliAgentLoop(opts: CliAgentLoopOptions): AgentLoop & { readonly engine: CliEngine; readonly adapter: CliAdapter } {
  const engine = opts.engine;
  const adapter = opts.adapter ?? cliAdapterFor(engine);
  const clock = opts.clock ?? systemClock;
  const bin = opts.bin ?? adapter.defaultBin;
  const models: CliModels = { ...adapter.defaultModels, ...opts.models };
  const endRunGraceMs = opts.endRunGraceMs ?? 10_000;
  const killGraceMs = opts.killGraceMs ?? 3_000;
  const pollMs = opts.pollMs ?? 250;
  const runTimeoutMs = opts.runTimeoutMs ?? 60 * 60_000;
  const debug = (e: CliDebugEvent) => {
    try {
      opts.onDebug?.(e);
    } catch {
      // diagnostics never break a Run
    }
  };

  async function run(snapshot: PromptSnapshot, ports: RunPorts, signal: AbortSignal): Promise<RunOutcome> {
    if (signal.aborted) return "cancelled";
    const processor = snapshot.spec.processor;
    if (processor.kind !== "llm") throw new NgError("invalid_argument", `the ${engine} loop runs llm processors only`);
    try {
      return await runLlm(snapshot, ports, signal, processor);
    } catch (err) {
      if (signal.aborted) return "cancelled";
      throw err;
    }
  }

  async function runLlm(snapshot: PromptSnapshot, ports: RunPorts, signal: AbortSignal, processor: LlmProcessorSpec): Promise<RunOutcome> {
    const cellId = snapshot.cellId;
    const runId = snapshot.runId;
    const append = (rec: EvidenceInput) => ports.context.appendEvidence(cellId, { ...rec, runId, at: clock.now() } as StepOrExternalEvidence);

    if (ports.meter({ tokens: 0, billedCents: 0 }) === "hard_stop") return "budget_stopped";

    const { parentId: _specParent, ...specRest } = snapshot.spec;
    const cellSpec = ports.self.parentId ? { ...specRest, parentId: ports.self.parentId } : specRest;
    const tools = selectRunTools(opts.registry.resolveTools(processor.toolsets ?? []), processor, snapshot.bounds, cellSpec).filter(
      (t) => !(NATIVE_REPLACED_TOOLS.has(t.name) && t.kind === t.name),
    );
    const byName = new Map<string, ToolDef>(tools.map((t) => [t.name, t]));

    const access = await workspaceAccess(ports);
    if (access.isolation === "container" || access.isolation === "cow_microvm") {
      throw new NgError(
        "unsupported",
        `the ${engine} CLI runs on the host and cannot enter a ${access.isolation} workspace; give this cell engine "api" or a git_worktree workspace`,
      );
    }
    const caps = capabilitiesOf(access, processor, opts.web ?? false);
    const tier = processor.modelTier ?? opts.defaultTier ?? "strong";
    const model = models[tier] ? models[tier] : undefined;
    const maxSteps = processor.maxSteps;

    // ---------- input ----------
    const steerNotes: string[] = [];
    for (const m of ports.drainSteer()) {
      const text = steerNoteText(m);
      await append({ kind: "system_note", text });
      steerNotes.push(text);
    }
    const input = [tailText(snapshot), ...steerNotes].filter((t) => t.trim()).join("\n\n");
    if (!input) return "completed";

    // ---------- session plan ----------
    const own = await ports.context.readState<CliSessionRecord>(cellId, CLI_SESSION_KEY);
    const sameModel = (r: CliSessionRecord) => (r.model ?? "") === (model ?? "");
    let plan: { session?: LaunchRequest["session"]; prompt: string; forkedFrom?: string };
    if (own && own.engine === engine && own.cwd === access.root && own.systemHash === snapshot.system.hash && sameModel(own)) {
      plan = { session: { id: own.sessionId, mode: "resume" }, prompt: input };
    } else {
      plan = { prompt: freshPrompt(snapshot.history, input) };
      const forkIdx = snapshot.mode === "fork_prefix" && adapter.canFork && !own ? forkNoteIndex(snapshot.history) : -1;
      if (forkIdx >= 0) {
        const parent = await ports.context.readState<CliSessionRecord>(cellId, CLI_FORK_SESSION_KEY);
        if (parent && parent.engine === engine && sameModel(parent)) {
          plan = { session: { id: parent.sessionId, mode: "fork" }, prompt: freshPrompt(snapshot.history.slice(forkIdx), input), forkedFrom: parent.sessionId };
          // The fork note is the first "earlier" message the child shows; the parent's part is in the forked session.
          plan.prompt = plan.prompt.replace(/^\[Earlier conversation[^\]]*\]\n\n/, "");
        }
      }
    }

    // ---------- Run state ----------
    const tmpDir = mkdtempSync(join(tmpdir(), `ng-cli-${engine}-`));
    const systemText = kernelSystem(snapshot.system.text, adapter, caps, tools);
    const systemFile = join(tmpDir, "system.md");
    writeFileSync(systemFile, systemText, { mode: 0o600 });
    const env = cliEnvironment(opts.env ?? process.env, { ...(opts.keepEnv ? { keep: opts.keepEnv } : {}), ...(opts.dropEnv ? { drop: opts.dropEnv } : {}) });

    let sessionId: string | null = plan.session?.mode === "resume" ? plan.session.id : null;
    let sessionModel: string | null = null;
    let sessionCreatedAt = own && plan.session?.mode === "resume" ? own.createdAt : clock.now();
    let endOutcome: EndOutcome | undefined;
    let awaitsWakeup = false;
    let stopReason: StopReason | null = null;
    let steps = 0;
    let callCounter = 0;
    let leg = 0;
    const live: { proc: CliProcess | null; driver: CliDriver | null } = { proc: null, driver: null };
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    let persist: Promise<unknown> = Promise.resolve();
    const io: DriverIO = {
      write: (line) => live.proc?.write(line),
      end: () => live.proc?.endInput(),
    };

    const persistSession = (final: boolean) => {
      if (!sessionId) return;
      const rec: CliSessionRecord = {
        engine,
        sessionId,
        model: model ?? null,
        cwd: access.root,
        systemHash: snapshot.system.hash,
        createdAt: sessionCreatedAt,
        updatedAt: clock.now(),
        runs: (own && own.sessionId === sessionId ? own.runs : 0) + (final ? 1 : 0),
        ...(plan.forkedFrom ? { forkedFrom: plan.forkedFrom } : {}),
      };
      const patches: Record<string, unknown> = { [CLI_SESSION_KEY]: rec };
      if (plan.forkedFrom) patches[CLI_FORK_SESSION_KEY] = null;
      persist = persist.then(() => ports.context.commit(cellId, { statePatches: patches })).catch(() => undefined);
    };

    const killNow = (grace = killGraceMs) => {
      if (live.proc) void live.proc.kill(grace);
    };
    const interruptAndKill = (grace = killGraceMs) => {
      if (live.driver && live.proc) live.driver.interrupt(io);
      killNow(grace);
    };
    const stop = (reason: StopReason) => {
      if (stopReason) return;
      stopReason = reason;
      interruptAndKill();
    };
    const armEndGrace = () => {
      if (endTimer) return;
      endTimer = setTimeout(() => interruptAndKill(), endRunGraceMs);
    };
    const forgetSession = () => {
      persist = persist.then(() => ports.context.commit(cellId, { statePatches: { [CLI_SESSION_KEY]: null } })).catch(() => undefined);
    };

    const onAbort = () => stop("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    const runTimer = setTimeout(() => stop("timeout"), runTimeoutMs);

    // ---------- kernel tools over MCP ----------
    async function callTool(name: string, args: unknown, meta: { requestId: string; signal: AbortSignal }): Promise<BridgeCallResult> {
      if (endOutcome || stopReason) {
        if (endOutcome) interruptAndKill();
        return { text: RUN_ALREADY_ENDED, isError: true };
      }
      const tool = byName.get(name)!;
      const toolUseId = `mcp_${runId}_${++callCounter}`;
      await append({ kind: "tool_call", toolUseId, name, input: args });
      countStep();
      let result: ToolResult;
      try {
        result = normalizeToolResult(
          await raceAbort(Promise.resolve(tool.handler(args, { ports, snapshot, signal, toolUseId, clock })), AbortSignal.any([signal, meta.signal])),
        );
      } catch (err) {
        result = { output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      const ev = await append({ kind: "tool_result", toolUseId, name, output: result.output, ...(result.isError ? { isError: true } : {}) });
      let text = ev.modelText ?? result.output;
      if (result.awaitsWakeup) awaitsWakeup = true;
      if (result.endRun) {
        if (endOutcome === undefined || RUN_END_PRECEDENCE.indexOf(result.endRun) < RUN_END_PRECEDENCE.indexOf(endOutcome)) endOutcome = result.endRun;
        text = `${text}\n\n${RUN_ENDED_NOTICE}`;
        armEndGrace();
      }
      return { text, ...(result.isError ? { isError: true } : {}) };
    }

    function countStep(): void {
      steps++;
      if (maxSteps !== undefined && steps > maxSteps && !endOutcome) stop("steps");
    }

    let bridge: ToolBridge | null = null;
    try {
      bridge = await startToolBridge({
        serverName: CLI_MCP_SERVER,
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        call: callTool,
        ...(opts.nodePath ? { nodePath: opts.nodePath } : {}),
      });
      const mcp = { serverName: bridge.serverName, launch: bridge.launch };

      let nextPrompt = plan.prompt;
      let nextSession = plan.session;
      let fellBack = false;
      for (;;) {
        leg++;
        const req: LaunchRequest = {
          engine,
          bin,
          cwd: access.root,
          caps,
          model,
          system: systemText,
          systemFile,
          prompt: nextPrompt,
          ...(nextSession ? { session: nextSession } : {}),
          mcp,
          tmpDir,
          extraArgs: opts.extraArgs ?? [],
        };
        const out = await runLeg(req);
        if (stopReason === "cancelled" || signal.aborted) return "cancelled";
        if (stopReason === "budget") return "budget_stopped";
        if (stopReason === "timeout") throw new Error(`${engine} run exceeded ${runTimeoutMs} ms and was stopped`);
        if (endOutcome) return finish(endOutcome);
        if (stopReason === "steps") {
          await append({ kind: "system_note", text: `[run stopped after ${maxSteps} tool calls (step limit); continue on the next wake-up]` });
          return finish("completed");
        }
        const resumeTrouble =
          req.session !== undefined && (out.resumeFailed !== undefined || (!out.sawSession && !out.turnOk && out.relaunchWith.length === 0));
        if (resumeTrouble && !fellBack) {
          fellBack = true;
          debug({ type: "notice", cellId, text: `${engine}: ${req.session!.mode} of session ${req.session!.id} failed (${out.resumeFailed ?? out.turnError ?? `exit ${out.code}`}); starting a fresh session primed with the history` });
          if (req.session!.mode === "resume") forgetSession();
          else persist = persist.then(() => ports.context.commit(cellId, { statePatches: { [CLI_FORK_SESSION_KEY]: null } })).catch(() => undefined);
          sessionId = null;
          sessionCreatedAt = clock.now();
          delete plan.forkedFrom;
          nextSession = undefined;
          nextPrompt = freshPrompt(snapshot.history, [input, ...out.relaunchWith].join("\n\n"));
          continue;
        }
        if (out.relaunchWith.length > 0 && sessionId) {
          nextSession = { id: sessionId, mode: "resume" };
          nextPrompt = out.relaunchWith.join("\n\n");
          continue;
        }
        if (out.turnOk && out.turnError === undefined) return finish("completed");
        const detail = out.turnError ?? (out.code === 127 ? `could not start "${bin}"` : `exited with code ${out.code ?? out.signal}`);
        throw new Error(`${engine} CLI failed: ${detail}${out.stderr.trim() ? `\n${out.stderr.trim().slice(-1_500)}` : ""}`);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(runTimer);
      if (endTimer) clearTimeout(endTimer);
      if (live.proc) await live.proc.kill(killGraceMs);
      persistSession(true);
      await persist;
      await bridge?.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }

    function finish(outcome: EndOutcome): RunOutcome {
      return outcome === "completed" && awaitsWakeup ? "yielded_waiting" : outcome;
    }

    async function runLeg(req: LaunchRequest): Promise<LegOutcome> {
      const d = adapter.createDriver(req);
      live.driver = d;
      debug({ type: "launch", engine, cellId, runId, argv: d.argv, cwd: req.cwd, ...(req.session ? { session: req.session } : {}), caps, permissions: adapter.describePermissions(caps) });
      const legNo = leg;
      const native = new Map<string, string>();
      const state: LegOutcome = { code: null, signal: null, stderr: "", sawSession: false, turnOk: false, turnError: undefined, resumeFailed: undefined, relaunchWith: [] };
      let finished = false;
      let finishTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingSteer: string[] = [];
      let chain: Promise<void> = Promise.resolve();

      const finishInput = () => {
        if (finished) return;
        finished = true;
        d.finish(io);
        // A CLI that keeps running after its input is done is stopped.
        finishTimer = setTimeout(() => killNow(), Math.max(killGraceMs, 5_000));
      };

      const deliverSteer = (texts: string[]) => {
        if (texts.length === 0 || finished || stopReason || endOutcome) return;
        const delivered = texts.every((t) => d.steer(t, io));
        if (!delivered) {
          // Interrupt + resume needs the session to exist on the CLI's side first.
          if (!state.sawSession || !sessionId) {
            pendingSteer.push(...texts);
            return;
          }
          state.relaunchWith.push(...texts);
          finished = true;
          killNow();
        }
      };

      const handle = async (e: CliEvent): Promise<void> => {
        switch (e.type) {
          case "session":
            state.sawSession = true;
            if (e.model) sessionModel = e.model;
            if (sessionId !== e.sessionId) {
              sessionId = e.sessionId;
              persistSession(false);
            }
            if (pendingSteer.length) {
              const texts = pendingSteer;
              pendingSteer = [];
              deliverSteer(texts);
            }
            break;
          case "text":
            await append({ kind: "assistant_text", text: e.text, model: sessionModel ?? model ?? engine });
            break;
          case "tool_start": {
            if (endOutcome || stopReason) {
              d.interrupt(io);
              killNow();
              break;
            }
            const id = `cli_${runId}_${legNo}_${e.id}`;
            native.set(e.id, id);
            await append({ kind: "tool_call", toolUseId: id, name: e.name, input: e.input });
            countStep();
            break;
          }
          case "tool_end": {
            let id = native.get(e.id);
            if (!id) {
              id = `cli_${runId}_${legNo}_${e.id}`;
              await append({ kind: "tool_call", toolUseId: id, name: e.name, input: {} });
            }
            native.delete(e.id);
            await append({ kind: "tool_result", toolUseId: id, name: e.name, output: e.output || "(no output)", ...(e.isError ? { isError: true } : {}) });
            break;
          }
          case "usage": {
            const r = ports.meter({ tokens: Math.max(0, Math.round(e.tokens)), billedCents: opts.billReportedCost === false ? 0 : Math.max(0, e.cents) });
            if (r === "hard_stop" && !endOutcome) stop("budget");
            break;
          }
          case "turn_end":
            if (e.ok) state.turnOk = true;
            else if (!e.stopped) state.turnError = e.error ?? "turn failed";
            if (e.more) break;
            if (!endOutcome && !stopReason && pendingSteer.length && state.sawSession) {
              const texts = pendingSteer;
              pendingSteer = [];
              deliverSteer(texts);
              if (!finished) break;
            }
            finishInput();
            break;
          case "resume_failed":
            state.resumeFailed = e.message;
            finished = true;
            killNow();
            break;
          case "notice":
            debug({ type: "notice", cellId, text: e.text });
            break;
        }
      };

      const p = spawnCli(d.argv, {
        cwd: req.cwd,
        env,
        onLine: (line) => {
          let events: CliEvent[];
          try {
            events = d.onLine(line, io);
          } catch (err) {
            debug({ type: "notice", cellId, text: `${engine}: unparsable output (${err instanceof Error ? err.message : String(err)})` });
            return;
          }
          for (const e of events) chain = chain.then(() => handle(e)).catch((err: unknown) => debug({ type: "notice", cellId, text: `event handling failed: ${err instanceof Error ? err.message : String(err)}` }));
        },
      });
      live.proc = p;
      d.start(io);
      if (stopReason) killNow();

      const poll = setInterval(() => {
        if (finished || stopReason || endOutcome) return;
        let msgs: string[];
        try {
          msgs = ports.drainSteer();
        } catch {
          return;
        }
        if (msgs.length === 0) return;
        chain = chain.then(async () => {
          const texts: string[] = [];
          for (const m of msgs) {
            const text = steerNoteText(m);
            await append({ kind: "system_note", text });
            texts.push(text);
          }
          deliverSteer(texts);
        });
      }, pollMs);

      const exit = await p.exited;
      clearInterval(poll);
      if (finishTimer) clearTimeout(finishTimer);
      await chain;
      live.proc = null;
      live.driver = null;
      state.code = exit.code;
      state.signal = exit.signal;
      state.stderr = p.stderrTail();
      if (pendingSteer.length && !endOutcome && !stopReason) state.relaunchWith.push(...pendingSteer);
      debug({ type: "exit", cellId, code: exit.code, signal: exit.signal, stderr: state.stderr });
      return state;
    }
  }

  return { engine, adapter, run };
}

/** Kernel-side capabilities → what the CLI may do. */
export function capabilitiesOf(access: WorkspaceAccess, processor: LlmProcessorSpec, web: boolean): CliCapabilities {
  const allowedTools = processor.allowedTools ? new Set<ToolKind>(processor.allowedTools) : null;
  const has = (k: ToolKind) => access.tools.includes(k) && (allowedTools === null || allowedTools.has(k));
  const write = has("write");
  const edit = has("edit");
  const bash = has("bash");
  return { root: access.root, isolation: access.isolation, write, edit, bash, readOnly: !(write || edit || bash), web };
}

async function workspaceAccess(ports: RunPorts): Promise<WorkspaceAccess> {
  if (ports.workspaceAccess) return ports.workspaceAccess();
  // Ports without workspaceAccess (older/hand-written): the root appears once the workspace has been acquired.
  if (!ports.workspace.root) {
    try {
      await ports.workspace.exec("read", { op: "list_dir", path: ".", depth: 1 });
    } catch {
      // the root may still be known; checked below
    }
  }
  if (!ports.workspace.root) throw new NgError("unsupported", "these RunPorts expose no workspace root for a CLI agent");
  return { root: ports.workspace.root, isolation: ports.workspace.isolation, tools: [...ports.self.bounds.tools] };
}

function kernelSystem(frozen: string, adapter: CliAdapter, caps: CliCapabilities, tools: readonly ToolDef[]): string {
  const example = tools[0] ? adapter.mcpToolName(CLI_MCP_SERVER, tools[0].name) : adapter.mcpToolName(CLI_MCP_SERVER, "set_state");
  const lines = [
    frozen.trimEnd(),
    "",
    "## How this cell runs",
    `- The MCP server "${CLI_MCP_SERVER}" provides this cell's kernel tools (${tools.map((t) => t.name).join(", ") || "none"}); this client names them like ${example}. Use them for state, drafts, messages to people, approvals, reports to your parent, children, reminders and background jobs.`,
    `- Your working directory is this cell's workspace${caps.readOnly ? " and it is read-only for you: do not try to change files or run commands that modify anything." : "."}`,
    "- When a kernel tool result says the run has ended, stop at once: no further tool calls and no further work.",
  ];
  return lines.join("\n");
}
