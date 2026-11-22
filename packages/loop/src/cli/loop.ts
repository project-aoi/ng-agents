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
import { launchChoice, type CliModelChoice } from "./models";
import { rebuildFreshPrompt, renderEvidenceInbound, type AppendedInput } from "./input";
import { forkNoteIndex, freshPrompt, tailText } from "./render";
import type { CliAdapter, CliCapabilities, CliDriver, CliEvent, CliModels, CliSessionRecord, DriverIO, LaunchRequest } from "./types";

/** Context state key holding the cell's CLI session (CliSessionRecord). */
export const CLI_SESSION_KEY = "cli:session";
/** Set by the kernel on a fork_prefix child: the parent's CliSessionRecord at spawn time. */
export const CLI_FORK_SESSION_KEY = "cli:session:fork";
/** MCP server name the kernel tools are published under. */
export const CLI_MCP_SERVER = "ng";
/**
 * Workspace tools the CLI's own file/shell tools replace (the kernel-only job tools stay on MCP). `code_rpc` is among
 * them: it exists for API models without a shell, and a CLI agent that is offered it tends to route every command
 * through it instead of its own, much better, shell.
 */
export const NATIVE_REPLACED_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash", "code_rpc"]);

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
  /**
   * Asked at the start of every Run, before `models`: the owner's current choice for the tier (the workbench's model
   * switch), so a change applies to the next Run without a restart. `undefined` = fall back to `models`.
   */
  resolveModel?: (tier: ModelTier) => CliModelChoice | undefined | Promise<CliModelChoice | undefined>;
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
  /**
   * Where running CLI processes are put on record (`<dataDir>/cli-procs`), so the next kernel can stop the ones a
   * crashed kernel left behind (reapOrphanedCliProcesses) before it starts another agent in the same directory.
   */
  procDir?: string;
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
/** How a batch of extra input reaches the CLI: a steer may cut the running turn short, a follow-up never does. */
type DeliverMode = "interrupt" | "turn_end";

interface LegOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  sawSession: boolean;
  turnOk: boolean;
  turnError: string | undefined;
  resumeFailed: string | undefined;
  /** Whether a live steer triggered an intentional interrupt/kill in this leg (Codex). */
  interruptedForSteer: boolean;
  /** Envelope IDs already submitted as the initial prompt of this leg (avoid duplicating on same-session resume). */
  promptItemIds: ReadonlySet<string>;
  /** Unconfirmed steer/inbound items (in arrival order) that must be carried to the next leg or requeued. */
  relaunchItems: AppendedInput[];
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

  const activeCells = new Set<string>();
  const readingParent = new Map<string,Promise<void>>();
  async function run(snapshot: PromptSnapshot, ports: RunPorts, signal: AbortSignal): Promise<RunOutcome> {
    if (signal.aborted) return "cancelled";
    const processor = snapshot.spec.processor;
    if (processor.kind !== "llm") throw new NgError("invalid_argument", `the ${engine} loop runs llm processors only`);
    try {
      activeCells.add(snapshot.cellId);
      const forkInProgress = readingParent.get(snapshot.cellId);
      if (forkInProgress) await raceAbort(forkInProgress, signal);
      if (signal.aborted) return "cancelled";
      return await runLlm(snapshot, ports, signal, processor);
    } catch (err) {
      if (signal.aborted) return "cancelled";
      throw err;
    } finally { activeCells.delete(snapshot.cellId); }
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
    // The owner's switch first; a failure to read it must not stop the Run (the static setting or the CLI's own
    // default model still works).
    let chosen: CliModelChoice | undefined;
    try {
      chosen = await opts.resolveModel?.(tier);
    } catch {
      chosen = undefined;
    }
    const launch = chosen ? launchChoice(engine, chosen) : { model: models[tier] ? models[tier] : undefined, effort: undefined };
    const effort = launch.effort;
    // One key for "which model answers": a session is only resumed with the model and effort it was created with.
    const model = launch.model ? (effort ? `${launch.model}@${effort}` : launch.model) : undefined;
    const maxSteps = processor.maxSteps;

    // ---------- input ----------
    const initialBatchIds = new Set(snapshot.batch.envelopes.map((e) => e.id));
    const tracked = new Map<string, AppendedInput>();
    const steerSeqToEnvelopeId = new Map<number, string>();
    const initialTail = tailText(snapshot);
    const initialSteerItems: AppendedInput[] = [];
    for (const m of ports.drainSteer()) {
      const text = steerNoteText(m.message);
      const item: AppendedInput = { envelopeId: m.envelopeId, kind: "steer", text, status: "queued" };
      tracked.set(item.envelopeId, item);
      initialSteerItems.push(item);
    }
    const input = [initialTail, ...initialSteerItems.map((i) => i.text)].filter((t) => t.trim()).join("\n\n");
    if (!input) return "completed";

    // ---------- session plan ----------
    const own = await ports.context.readState<CliSessionRecord>(cellId, CLI_SESSION_KEY);
    const sameModel = (r: CliSessionRecord) => (r.model ?? "") === (model ?? "");
    let plan: { session?: LaunchRequest["session"]; prompt: string; forkedFrom?: string };
    let releaseParent: (()=>void) | undefined;
    let forkDelivered: number | undefined;
    let forkBase: CliSessionRecord["reported"];
    const priorCursor = own?.lastDeliveredEvidenceSeq ?? 0;
    if (own && own.engine === engine && own.cwd === access.root && own.systemHash === snapshot.system.hash && sameModel(own)) {
      const missed = (ports.listEvidence?.({ afterSeq: priorCursor }) ?? []).filter(entry =>
        entry.seq <= snapshot.historyUptoSeq && (entry.record.kind === "system_note" ||
        (entry.record.kind === "inbound" && !initialBatchIds.has(entry.record.envelope.id))));
      const seenEnvelopes = new Set<string>();
      const catchup = missed.flatMap(({ record }) => {
        if (record.kind === "system_note") return [record.text];
        if (record.kind !== "inbound" || seenEnvelopes.has(record.envelope.id)) return [];
        seenEnvelopes.add(record.envelope.id);
        return [renderEvidenceInbound(record.envelope)];
      });
      plan = { session: { id: own.sessionId, mode: "resume" }, prompt: [...(catchup.length ? ["[Earlier events already handled while you were asleep — use as context]\n" + catchup.join("\n")] : []), input].join("\n\n") };
    } else {
      plan = { prompt: freshPrompt(snapshot.history, input) };
      const forkIdx = snapshot.mode === "fork_prefix" && adapter.canFork && !own ? forkNoteIndex(snapshot.history) : -1;
      if (forkIdx >= 0) {
        const parent = await ports.context.readState<CliSessionRecord>(cellId, CLI_FORK_SESSION_KEY);
        const point = snapshot.spec.fork;
        if (parent && point && parent.engine === engine && sameModel(parent) && (engine !== "claude" || parent.cwd===access.root)
            && !activeCells.has(point.fromCellId) && !readingParent.has(point.fromCellId) && parent.lastDeliveredEvidenceSeq !== undefined &&
            ports.canForkSession(point.fromCellId,point.uptoSeq,parent.sessionId,parent.lastDeliveredEvidenceSeq)) {
          forkDelivered = parent.lastDeliveredEvidenceSeq;
          forkBase = parent.reported;
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
    const env = cliEnvironment(opts.env ?? process.env, {
      ...(opts.keepEnv ? { keep: opts.keepEnv } : {}),
      ...(opts.dropEnv ? { drop: opts.dropEnv } : {}),
      ...(adapter.env ? { set: { ...adapter.env } } : {}),
    });

    let sessionId: string | null = plan.session?.mode === "resume" ? plan.session.id : null;
    // Totals of the session that were already metered (CLIs that report running totals). A resumed session continues
    // from its own record; a fork starts from its parent's history, so from the parent's figure.
    const zeroUsage = { tokens: 0, cached: 0 };
    let reported = plan.session?.mode === "resume" ? (own?.reported ?? zeroUsage) : plan.session?.mode === "fork" ? (forkBase ?? zeroUsage) : zeroUsage;
    let sessionBaselineSeq = plan.session?.mode === "resume" ? priorCursor : plan.session?.mode === "fork" ? (forkDelivered ?? snapshot.historyUptoSeq) : snapshot.historyUptoSeq;
    let sessionProgress = false;
    let awaitingSessionConfirmation = false;
    let eventChain = Promise.resolve();
    let sessionModel: string | null = null;
    let sessionCreatedAt = own && plan.session?.mode === "resume" ? own.createdAt : clock.now();
    let endOutcome: EndOutcome | undefined;
    let refused = false;
    let awaitsWakeup = false;
    let stopReason: StopReason | null = null;
    let steps = 0;
    let callCounter = 0;
    let leg = 0;
    const live: { proc: CliProcess | null; driver: CliDriver | null; legTurns: number } = { proc: null, driver: null, legTurns: 0 };
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    let persist: Promise<unknown> = Promise.resolve();
    const io: DriverIO = {
      write: (line) => live.proc?.write(line) ?? false,
      end: () => live.proc?.endInput(),
    };

    const requeueUnconfirmed = (reason: string): void => {
      const ids = [...tracked.values()].filter((x) => x.status !== "confirmed").map((x) => x.envelopeId);
      if (ids.length > 0) ports.requeueEnvelopes?.(ids, reason);
    };

    const persistSession = (final: boolean) => {
      if (!sessionId || (sessionId !== own?.sessionId && !sessionProgress)) return;
      const rec: CliSessionRecord = {
        engine,
        sessionId,
        model: model ?? null,
        cwd: access.root,
        systemHash: snapshot.system.hash,
        lastDeliveredEvidenceSeq: sessionBaselineSeq,
        createdAt: sessionCreatedAt,
        updatedAt: clock.now(),
        runs: (own && own.sessionId === sessionId ? own.runs : 0) + (final ? 1 : 0),
        ...(plan.forkedFrom ? { forkedFrom: plan.forkedFrom } : {}),
        ...(reported.tokens > 0 ? { reported } : {}),
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
      sessionProgress = true;
      const tool = byName.get(name)!;
      const toolUseId = `mcp_${runId}_${++callCounter}`;
      await append({ kind: "tool_call", toolUseId, name, input: args });
      await countStep();
      if (stopReason === "steps") {
        await append({ kind:"tool_result", toolUseId, name, output:RUN_ALREADY_ENDED, isError:true });
        return {text:RUN_ALREADY_ENDED, isError:true};
      }
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
        // The CLI demonstrably processed the active turn of this leg to invoke this tool: confirm items belonging to
        // this active turn (including turn_end follow-ups), while leaving any mid-turn queued steers unconfirmed.
        await eventChain;
        await confirmTurn(leg, live.legTurns + 1);
        if (endOutcome === undefined || RUN_END_PRECEDENCE.indexOf(result.endRun) < RUN_END_PRECEDENCE.indexOf(endOutcome)) endOutcome = result.endRun;
        text = `${text}\n\n${RUN_ENDED_NOTICE}`;
        armEndGrace();
      }
      return { text, ...(result.isError ? { isError: true } : {}) };
    }

    async function confirmTurn(legNo: number, turn: number) {
      if (stopReason === "cancelled" || stopReason === "timeout" || signal.aborted) return;
      sessionProgress = true;
      for (const item of tracked.values()) {
        if (item.status !== "sent" || item.sentInLeg !== legNo || (item.confirmAtTurn ?? 1) !== turn) continue;
        item.status = "confirmed";
        if (item.kind === "steer") {
          const ev = await append({kind:"system_note", text:item.text});
          steerSeqToEnvelopeId.set(ev.seq, item.envelopeId);
        }
      }
      awaitingSessionConfirmation = !sessionId;
      confirmCursor();
    }

    function confirmCursor() {
      if (sessionId && ports.confirmCliInput && ports.listEvidence) {
        let through = sessionBaselineSeq;
        for (const { seq, record } of ports.listEvidence({ afterSeq: through })) {
          if (record.kind !== "inbound" && record.kind !== "system_note") continue;
          if (seq > snapshot.historyUptoSeq) {
            const id = record.kind === "inbound" ? record.envelope.id : steerSeqToEnvelopeId.get(seq);
            if (!id || (!initialBatchIds.has(id) && tracked.get(id)?.status !== "confirmed")) break;
          }
          through = seq;
        }
        ports.confirmCliInput(sessionId, through);
      }
    }

    async function countStep(): Promise<void> {
      steps++;
      if (maxSteps !== undefined && steps > maxSteps && !endOutcome) {
        await confirmTurn(leg, live.legTurns + 1);
        stop("steps");
      }
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
      let nextPromptItems: AppendedInput[] = initialSteerItems;
      const failedSessions = new Set<string>();
      let totalFreshRebuilds = 0;
      const MAX_FRESH_REBUILDS = 2;
      let relaunchesWithoutProgress = 0;
      const MAX_RELAUNCHES_WITHOUT_PROGRESS = 4;
      for (;;) {
        leg++;
        if (nextSession?.mode === "fork") {
          const point=snapshot.spec.fork!;
          if (activeCells.has(point.fromCellId) || readingParent.has(point.fromCellId) ||
              !ports.canForkSession(point.fromCellId,point.uptoSeq,nextSession.id,forkDelivered!)) {
            nextSession=undefined;
            sessionBaselineSeq = snapshot.historyUptoSeq;
            nextPrompt=freshPrompt(snapshot.history,input);
            delete plan.forkedFrom;
            reported=zeroUsage;
          } else {
            readingParent.set(point.fromCellId,new Promise<void>(resolve=>{
              releaseParent=()=>{readingParent.delete(point.fromCellId);resolve();releaseParent=undefined;};
            }));
          }
        }
        const req: LaunchRequest = {
          engine,
          bin,
          cwd: access.root,
          caps,
          model: launch.model,
          effort,
          system: systemText,
          systemFile,
          prompt: nextPrompt,
          ...(nextSession ? { session: nextSession } : {}),
          mcp,
          tmpDir,
          extraArgs: opts.extraArgs ?? [],
        };
        const out = await runLeg(req, nextPromptItems);
        releaseParent?.();
        if (stopReason === "cancelled" || signal.aborted) return "cancelled";
        if (stopReason === "budget") {
          requeueUnconfirmed("run stopped by budget before mid-run input was confirmed");
          return "budget_stopped";
        }
        if (stopReason === "timeout") throw new Error(`${engine} run exceeded ${runTimeoutMs} ms and was stopped`);
        if (endOutcome) {
          requeueUnconfirmed("run ended by tool before mid-run input was confirmed");
          return finish(endOutcome);
        }
        if (stopReason === "steps") {
          // Same outcome as the API loop: work is left, so this is not "completed" (docs/05 guard 1).
          await append({ kind: "system_note", text: `[run stopped after ${maxSteps} tool calls (step limit); the kernel wakes you to continue]` });
          requeueUnconfirmed("run hit step limit before mid-run input was confirmed");
          return "step_limit";
        }
        if (refused) {
          requeueUnconfirmed("model refused before mid-run input was confirmed");
          return "refused";
        }
        const resumeTrouble =
          req.session !== undefined &&
          !failedSessions.has(req.session.id) &&
          totalFreshRebuilds < MAX_FRESH_REBUILDS &&
          (out.resumeFailed !== undefined || (!out.sawSession && !out.turnOk));
        if (resumeTrouble) {
          failedSessions.add(req.session!.id);
          totalFreshRebuilds++;
          debug({ type: "notice", cellId, text: `${engine}: ${req.session!.mode} of session ${req.session!.id} failed (${out.resumeFailed ?? out.turnError ?? `exit ${out.code}`}); starting a fresh session primed with the history` });
          if (req.session!.mode === "resume") forgetSession();
          else persist = persist.then(() => ports.context.commit(cellId, { statePatches: { [CLI_FORK_SESSION_KEY]: null } })).catch(() => undefined);
          sessionId = null;
          sessionProgress = false;
          awaitingSessionConfirmation = false;
          sessionBaselineSeq = snapshot.historyUptoSeq;
          reported = zeroUsage;
          sessionCreatedAt = clock.now();
          delete plan.forkedFrom;
          nextSession = undefined;
          nextPromptItems = out.relaunchItems;
          nextPrompt = rebuildFreshPrompt(snapshot, initialBatchIds, ports, tracked, steerSeqToEnvelopeId, out.relaunchItems);
          continue;
        }
        const canRelaunch =
          out.relaunchItems.length > 0 &&
          out.turnError === undefined &&
          (out.turnOk || out.interruptedForSteer);
        if (canRelaunch) {
          if (out.turnOk) relaunchesWithoutProgress = 0;
          else relaunchesWithoutProgress++;
          if (relaunchesWithoutProgress <= MAX_RELAUNCHES_WITHOUT_PROGRESS) {
            if (sessionId) {
              // On Codex interrupt+resume of the same session, items already sent in this leg's prompt are in the
              // session history; send only the newly arrived items in the resume prompt while still confirming all
              // tracked items on turn_end (or carrying them all into rebuildFreshPrompt if resume fails).
              const promptTexts = out.interruptedForSteer
                ? out.relaunchItems.filter((i) => !out.promptItemIds.has(i.envelopeId))
                : out.relaunchItems;
              if (promptTexts.length > 0) {
                nextSession = { id: sessionId, mode: "resume" };
                nextPromptItems = out.relaunchItems;
                nextPrompt = promptTexts.map((i) => i.text).join("\n\n");
                continue;
              }
            } else if (totalFreshRebuilds < MAX_FRESH_REBUILDS) {
              totalFreshRebuilds++;
              // No session to continue (the CLI never reported one): rebuild from SQLite evidence + unconfirmed inputs.
              reported = zeroUsage;
              nextSession = undefined;
              nextPromptItems = out.relaunchItems;
              nextPrompt = rebuildFreshPrompt(snapshot, initialBatchIds, ports, tracked, steerSeqToEnvelopeId, out.relaunchItems);
              continue;
            }
          }
          // Exhausted retries: return unconfirmed envelopes to pending so the next Run picks them up.
          requeueUnconfirmed("cli exhausted relaunch retries before mid-run input was confirmed");
          if (out.turnOk) return finish("completed");
        }
        if (out.turnOk && out.turnError === undefined) {
          requeueUnconfirmed("cli exited before mid-run input was confirmed");
          return finish("completed");
        }
        const detail = out.turnError ?? (out.code === 127 ? `could not start "${bin}"` : `exited with code ${out.code ?? out.signal}`);
        throw new Error(`${engine} CLI failed: ${detail}${out.stderr.trim() ? `\n${out.stderr.trim().slice(-1_500)}` : ""}`);
      }
    } finally {
      releaseParent?.();
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

    async function runLeg(req: LaunchRequest, promptItems: readonly AppendedInput[]): Promise<LegOutcome> {
      const d = adapter.createDriver(req);
      live.driver = d;
      live.legTurns = 0;
      debug({ type: "launch", engine, cellId, runId, argv: d.argv, cwd: req.cwd, ...(req.session ? { session: req.session } : {}), caps, permissions: adapter.describePermissions(caps) });
      const legNo = leg;
      const native = new Map<string, string>();
      const promptItemIds = new Set(promptItems.map((i) => i.envelopeId));
      const state: LegOutcome = {
        code: null,
        signal: null,
        stderr: "",
        sawSession: false,
        turnOk: false,
        turnError: undefined,
        resumeFailed: undefined,
        interruptedForSteer: false,
        promptItemIds,
        relaunchItems: [],
      };
      let finished = false;
      let finishTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingSteer: AppendedInput[] = [];
      let legTurns = 0;
      let turnActive = true;
      let nextConfirmTurn = 1;
      eventChain = Promise.resolve();

      for (const item of promptItems) {
        item.status = "sent";
        item.sentInLeg = legNo;
        item.confirmAtTurn = 1;
      }

      const finishInput = () => {
        if (!finished) {
          finished = true;
          d.finish(io);
        } else if (legTurns < nextConfirmTurn) {
          return;
        }
        if (finishTimer) return;
        // A CLI that keeps running after its input is done is stopped.
        finishTimer = setTimeout(() => killNow(), Math.max(killGraceMs, 5_000));
      };

      /**
       * Hand extra input to the CLI as a single joined turn. A CLI with live input takes it on stdin; however, even
       * when `d.steer()` returns `true`, each item stays unconfirmed (`status = "sent"`, `confirmAtTurn`) until its
       * target turn completes cleanly — catching closed-stdin races and queued multi-steer partial exits.
       */
      const deliver = (items: AppendedInput[], mode: DeliverMode) => {
        if (items.length === 0 || finished || stopReason || endOutcome) return;
        const joined = items.map((i) => i.text).join("\n\n");
        if (d.steer(joined, io)) {
          const targetTurn = Math.max(nextConfirmTurn, legTurns + (turnActive ? 1 : 0)) + 1;
          nextConfirmTurn = targetTurn;
          for (const item of items) {
            item.status = "sent";
            item.sentInLeg = legNo;
            item.confirmAtTurn = targetTurn;
          }
          turnActive = true;
          return;
        }
        if (mode === "interrupt" && (!state.sawSession || !sessionId)) {
          // Interrupt + resume needs the session to exist on the CLI's side first.
          pendingSteer.push(...items);
          return;
        }
        if (mode === "interrupt") {
          state.interruptedForSteer = true;
          finished = true;
          killNow();
        } else {
          finishInput();
        }
      };
      /** docs/05 §3.3: messages that reached the cell during this turn join the Run (the kernel port decides who absorbs). */
      const absorbInbound = (): AppendedInput[] => {
        try {
          const drained = ports.drainInbound?.() ?? [];
          const items: AppendedInput[] = [];
          for (const a of drained) {
            const existing = tracked.get(a.envelope.id);
            if (existing) {
              if (existing.status !== "confirmed") items.push(existing);
              continue;
            }
            const item: AppendedInput = { envelopeId: a.envelope.id, kind: "inbound", text: a.text, status: "queued" };
            tracked.set(item.envelopeId, item);
            items.push(item);
          }
          return items;
        } catch (err) {
          debug({ type: "notice", cellId, text: `absorbing follow-ups failed: ${err instanceof Error ? err.message : String(err)}` });
          return [];
        }
      };

      const handle = async (e: CliEvent): Promise<void> => {
        if (finishTimer && nextConfirmTurn > legTurns && ["text", "tool_start", "tool_end", "usage"].includes(e.type)) {
          clearTimeout(finishTimer);
          finishTimer = undefined;
        }
        switch (e.type) {
          case "session":
            releaseParent?.();
            state.sawSession = true;
            if (e.model) sessionModel = e.model;
            if (sessionId !== e.sessionId) {
              sessionId = e.sessionId;
              if (awaitingSessionConfirmation) {
                confirmCursor();
                awaitingSessionConfirmation = false;
              }
              persistSession(false);
            }
            if (pendingSteer.length) {
              const items = pendingSteer;
              pendingSteer = [];
              deliver(items, "interrupt");
            }
            break;
          case "text":
            sessionProgress = true;
            await append({ kind: "assistant_text", text: e.text, model: sessionModel ?? model ?? engine });
            break;
          case "tool_start": {
            if (endOutcome || stopReason) {
              d.interrupt(io);
              killNow();
              break;
            }
            sessionProgress = true;
            const id = `cli_${runId}_${legNo}_${e.id}`;
            native.set(e.id, id);
            await append({ kind: "tool_call", toolUseId: id, name: e.name, input: e.input });
            await countStep();
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
            let tokens = Math.max(0, Math.round(e.tokens));
            let cached = Math.max(0, Math.round(e.cached ?? 0));
            if (e.sessionTotal) {
              // Only what this turn added is metered. A total below the one already seen means the CLI's counters
              // started over (a rebuilt session): everything it reports is new.
              const base = tokens >= reported.tokens ? reported : zeroUsage;
              reported = { tokens, cached };
              tokens -= base.tokens;
              cached = Math.max(0, cached - base.cached);
              persistSession(false);
            }
            cached = Math.min(cached, tokens);
            const r = ports.meter({ tokens, billedCents: opts.billReportedCost === false ? 0 : Math.max(0, e.cents), ...(cached > 0 ? { cachedTokens: cached } : {}) });
            if (r === "hard_stop" && !endOutcome) stop("budget");
            break;
          }
          case "turn_end":
            legTurns++;
            live.legTurns = legTurns;
            if (e.ok && !e.stopped) {
              state.turnOk = true;
              await confirmTurn(legNo, legTurns);
            } else if (e.stopped && e.ok && !e.refused && stopReason !== "cancelled" && stopReason !== "timeout") {
              // A stopped turn confirms its original prompt, not a steer queued for a later turn.
              await confirmTurn(legNo, legTurns);
            } else if (e.refused) refused = true;
            else if (!e.ok && !e.stopped) state.turnError = e.error ?? "turn failed";
            turnActive = Boolean(e.more);
            if (e.more) break;
            if (!endOutcome && !stopReason && !refused) {
              const items: AppendedInput[] = [];
              if (pendingSteer.length && state.sawSession) {
                items.push(...pendingSteer);
                pendingSteer = [];
              }
              // The turn ended by itself: only now are follow-ups taken in. They are part of this Run's claim from
              // here on, so they must reach the model before the Run may end (live input, or a resume of the session).
              if (e.ok && !e.stopped) items.push(...absorbInbound());
              if (items.length) {
                deliver(items, "turn_end");
                if (!finished) break;
              }
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
        ...(opts.procDir ? { registry: { dir: opts.procDir, runId, cellId } } : {}),
        onLine: (line) => {
          let events: CliEvent[];
          try {
            events = d.onLine(line, io);
          } catch (err) {
            debug({ type: "notice", cellId, text: `${engine}: unparsable output (${err instanceof Error ? err.message : String(err)})` });
            return;
          }
          for (const e of events) eventChain = eventChain.then(() => handle(e)).catch((err: unknown) => debug({ type: "notice", cellId, text: `event handling failed: ${err instanceof Error ? err.message : String(err)}` }));
        },
      });
      live.proc = p;
      d.start(io);
      if (stopReason) killNow();

      const poll = setInterval(() => {
        if (finished || stopReason || endOutcome) return;
        let msgs: ReturnType<RunPorts["drainSteer"]>;
        try {
          msgs = ports.drainSteer();
        } catch {
          return;
        }
        if (msgs.length === 0) return;
        eventChain = eventChain.then(async () => {
          const ended = Boolean(finished || stopReason || endOutcome);
          const items: AppendedInput[] = [];
          for (const m of msgs) {
            const existing = tracked.get(m.envelopeId);
            if (existing) {
              if (existing.status !== "confirmed") items.push(existing);
              continue;
            }
            const text = steerNoteText(m.message);
            const item: AppendedInput = { envelopeId: m.envelopeId, kind: "steer", text, status: "queued" };
            tracked.set(item.envelopeId, item);
            items.push(item);
          }
          if (!ended) deliver(items, "interrupt");
        });
      }, pollMs);

      const exit = await p.exited;
      clearInterval(poll);
      if (finishTimer) clearTimeout(finishTimer);
      await eventChain;
      live.proc = null;
      live.driver = null;
      state.code = exit.code;
      state.signal = exit.signal;
      state.stderr = p.stderrTail();
      // Any item written to this leg whose confirmation turn never completed goes back to queued in arrival order.
      const unconfirmed: AppendedInput[] = [];
      for (const item of tracked.values()) {
        if (item.status === "confirmed") continue;
        if (item.status === "sent" && item.sentInLeg === legNo) {
          item.status = "queued";
          delete item.sentInLeg;
          delete item.confirmAtTurn;
        }
        unconfirmed.push(item);
      }
      if (!endOutcome && !stopReason && !refused) {
        state.relaunchItems = unconfirmed;
      }
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
  const host = access.isolation === "none";
  // On the host the agent researches like the owner would (docs/05 scenario 5), so its web tools are on.
  return { root: access.root, isolation: access.isolation, write, edit, bash, readOnly: !(write || edit || bash), web: web || host, access: host ? "host" : "workspace" };
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

/**
 * What a CLI agent must know about being a cell, appended to the cell's frozen system text: a coding CLI arrives with
 * its own habits (its own way of asking the user, a task list nobody sees), so this says which of them do not apply
 * and where the kernel's tools take over. Its own sub-agents are its own business: they run inside this cell's
 * process and budget and are welcome — what a cell may not do is ask a terminal nobody is sitting at.
 */
function kernelSystem(frozen: string, adapter: CliAdapter, caps: CliCapabilities, tools: readonly ToolDef[]): string {
  const example = tools[0] ? adapter.mcpToolName(CLI_MCP_SERVER, tools[0].name) : adapter.mcpToolName(CLI_MCP_SERVER, "set_state");
  const directory = caps.readOnly
    ? `- Directory: \`${caps.root}\`. This workspace is read-only (its isolation level allows reading and searching only). ${adapter.readOnlyHowTo(caps)}`
    : caps.access === "host"
      ? `- Directory: \`${caps.root}\`. You work with this CLI's own file and shell tools, as you normally would, on the owner's real machine with no sandbox — the red lines above are the only guard, so keep to them. Nothing reserves this directory for you: another cell, or the owner, may be working in it at the same time.`
      : `- Directory: \`${caps.root}\`, an isolated workspace of your own. You may change files and run commands inside it.`;
  const lines = [
    frozen.trimEnd(),
    "",
    "## How this cell runs",
    `- Kernel tools: the MCP server "${CLI_MCP_SERVER}" provides them (${tools.map((t) => t.name).join(", ") || "none"}); this client names them like ${example}. They are how what you do reaches the rest of the workbench: reports, waits, messages to cells and people, state, artifacts, reminders, background jobs. Tool names in your instructions (report_to_parent, wait, send_message, …) mean these. Reading files, editing and running commands are not their job — that is what this CLI's own tools are for.`,
    directory,
    "- Nobody is at this terminal. Never use this CLI's ask-the-user or plan-approval features: a question put there blocks the run and is never answered. To ask the owner something, use the kernel tools, or simply say it in your reply when the owner is talking to you directly. This CLI's own sub-agents are yours to use for your own work; other cells are reached only through the kernel tools.",
    "- When a kernel tool result says the run has ended, stop at once: no further tool calls, no further work, no closing summary.",
  ];
  return lines.join("\n");
}
