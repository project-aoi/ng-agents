import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isChannelAddr,
  NgError,
  normalizeToolResult,
  parsePrincipal,
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
  speaks,
} from "@ng/protocol";
import { raceAbort } from "../loop";
import { agyAdapter } from "./adapters/agy";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import { startToolBridge, type BridgeCallResult, type ToolBridge } from "./bridge";
import { cliEnvironment } from "./env";
import { spawnCli, type CliProcess } from "./process";
import { launchChoice, type CliModelChoice } from "./models";
import { rebuildFreshPrompt, renderEvidenceExternal, renderEvidenceInbound, type AppendedInput } from "./input";
import { CLI_MCP_SERVER, kernelSystem } from "./instructions";
import { forkNoteIndex, freshPrompt, historyCoversTask, historyUnderOwnSystem, tailText } from "./render";
import type { CliAdapter, CliCapabilities, CliDriver, CliEvent, CliModels, CliSessionRecord, DriverIO, LaunchRequest } from "./types";

/** Set in the environment of every CLI process a cell runs (and so of whatever that CLI starts): the cell's id. */
export const WORKBENCH_CELL_ENV = "NG_WORKBENCH_CELL_ID";
/** Context state key holding the cell's CLI session (CliSessionRecord). */
export const CLI_SESSION_KEY = "cli:session";
/** Set by the kernel on a fork_prefix child: the parent's CliSessionRecord at spawn time. */
export const CLI_FORK_SESSION_KEY = "cli:session:fork";
/** Set by updateCell({ resetSession: true }) so an in-flight Run cannot overwrite the reset when it exits. */
export const CLI_SESSION_RESET_KEY = "cli:session:reset";
export { CLI_MCP_SERVER } from "./instructions";

export const RUN_ENDED_NOTICE =
  "[The kernel ended this run with that result. Stop now: make no further tool calls and do no further work. What you have said or sent in this turn has been delivered: do not repeat or summarise it. If something is still unsaid to whoever reads you, say it in one short sentence; otherwise answer with nothing but \"OK\". You will be woken with the next message.]";
/** Letters and digits only: how a text is compared with one that was already said, whatever its punctuation. */
const bare = (text: string) => text.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
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
   * Asked at the start of every Run, before `models`: the owner's current choice for the tier/role (the workbench's
   * model switch), so a change applies to the next Run without a restart. `undefined` = fall back to `models`.
   */
  resolveModel?: (tier: ModelTier, ctx?: { spec: PromptSnapshot["spec"]; engine: CliEngine }) => CliModelChoice | undefined | Promise<CliModelChoice | undefined>;
  /** Tier when processor.modelTier is absent. Default "strong". */
  defaultTier?: ModelTier;
  /** Base environment for the CLI (default process.env), filtered by cliEnvironment. */
  env?: Record<string, string | undefined>;
  /** Variable names exempt from CLI_ENV_DROP (e.g. ANTHROPIC_API_KEY when the owner's CLI login is an API key). */
  keepEnv?: readonly string[];
  dropEnv?: readonly (string | RegExp)[];
  /** After a kernel tool ends the Run, how long the CLI may take to finish its turn before it is stopped. Default 45 s. */
  endRunGraceMs?: number;
  /** SIGTERM → SIGKILL grace. Default 3 s. */
  killGraceMs?: number;
  /** How often steer messages are polled (also the lease heartbeat). Default 250 ms. */
  pollMs?: number;
  /** Idle (no-progress) limit for one Run, excluding host sleep/suspend gaps. Default 20 minutes. */
  runTimeoutMs?: number;
  /** Extra CLI arguments (appended to the adapter's). */
  extraArgs?: readonly string[];
  /** Node binary for the MCP shim. Default: this process's. */
  nodePath?: string;
  /**
   * Where running CLI processes are put on record (`<dataDir>/cli-procs`), so the next kernel can stop the ones a
   * crashed kernel left behind (reapOrphanedCliProcesses) before it starts another agent in the same directory.
   */
  processRegistry?: { dir: string; ownerInstanceId: string };
  /** Replace the adapter (tests). */
  adapter?: CliAdapter;
  /** Diagnostics: invocations, CLI notices, refused permissions, stderr of failed processes. */
  onDebug?(event: CliDebugEvent): void;
}

export type CliDebugEvent =
  | { type: "launch"; engine: CliEngine; cellId: string; runId: string; argv: readonly string[]; cwd: string; session?: LaunchRequest["session"]; caps: CliCapabilities; permissions: string }
  | { type: "notice"; cellId: string; text: string }
  /** `stopped`: the loop itself ended the process (the turn's run-ending tool was called, or the Run was stopped) — not a failure. */
  | { type: "exit"; cellId: string; code: number | null; signal: string | null; stderr: string; stopped?: boolean };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EvidenceInput = DistributiveOmit<StepOrExternalEvidence, "runId" | "at">;
type EndOutcome = NonNullable<ToolResult["endRun"]>;
type StopReason = "cancelled" | "timeout" | "steps";
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
 * 2. Kernel tools: a per-Run loopback MCP bridge exposes the tools selected for this cell.
 * 3. Session: resume the cell's CLI session (Context state CLI_SESSION_KEY) with only the volatile tail; otherwise a
 *    fresh session with the frozen system text as the CLI's system prompt and the rendered history as the first
 *    message; fork_prefix children fork the parent's session when the CLI can. A failed resume/fork falls back to fresh.
 * 4. Assistant text, tool calls, results and steer notes are recorded as evidence.
 */
export function createCliAgentLoop(opts: CliAgentLoopOptions): AgentLoop & { readonly engine: CliEngine; readonly adapter: CliAdapter } {
  const engine = opts.engine;
  const adapter = opts.adapter ?? cliAdapterFor(engine);
  const clock = opts.clock ?? systemClock;
  const bin = opts.bin ?? adapter.defaultBin;
  const models: CliModels = { ...adapter.defaultModels, ...opts.models };
  const endRunGraceMs = opts.endRunGraceMs ?? 45_000;
  const killGraceMs = opts.killGraceMs ?? 3_000;
  const pollMs = opts.pollMs ?? 250;
  const runTimeoutMs = opts.runTimeoutMs ?? 20 * 60_000;
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


    const { parentId: _specParent, ...specRest } = snapshot.spec;
    const cellSpec = ports.self.parentId ? { ...specRest, parentId: ports.self.parentId } : specRest;
    const tools = selectRunTools(opts.registry.resolveTools(processor.toolsets ?? []), processor, snapshot.bounds, cellSpec);
    const byName = new Map<string, ToolDef>(tools.map((t) => [t.name, t]));

    const access = await ports.workspaceAccess();
    const caps = capabilitiesOf(access, processor);
    const tier = processor.modelTier ?? opts.defaultTier ?? "strong";
    // The owner's switch first; a failure to read it must not stop the Run (the static setting or the CLI's own
    // default model still works).
    let chosen: CliModelChoice | undefined = processor.model ? { model: processor.model, effort: processor.effort } : undefined;
    if (!chosen) {
      try {
        chosen = await opts.resolveModel?.(tier, { spec: snapshot.spec, engine });
      } catch {
        chosen = undefined;
      }
    }
    const launch = chosen ? launchChoice(engine, chosen) : { model: models[tier] ? models[tier] : undefined, effort: undefined };
    const effort = launch.effort;
    // One key for "which model answers": a session is only resumed with the model and effort it was created with.
    const model = launch.model ? (effort ? `${launch.model}@${effort}` : launch.model) : undefined;
    const maxSteps = processor.maxSteps;

    // ---------- input ----------
    const initialBatchIds = new Set(snapshot.batch.envelopes.map((e) => e.id));
    // Words after the tool that ended the Run answer a person who spoke in it and has not been sent a message since, or
    // are the only words of the Run (said or sent); otherwise they recap it. "OK" is what RUN_ENDED_NOTICE asks for.
    const said = new Set<string>();
    let spokenCount = 0;
    const sentTexts = new Set<string>();
    const isPerson = (principalId: string) => ["owner", "agent"].includes(parsePrincipal(principalId).kind);
    let personWaits = snapshot.batch.envelopes.some((e) => e.delivery !== "silent_inject" && isPerson(e.principalId) && speaks(e));
    const worthKeeping = (closing: string) => (personWaits || said.size === 0) && bare(closing) !== "ok" && !said.has(bare(closing));
    const speak = async (text: string) => {
      if (text.trim()) {
        said.add(bare(text));
        spokenCount++;
      }
      await append({ kind: "assistant_text", text, model: sessionModel ?? model ?? engine });
    };
    const tracked = new Map<string, AppendedInput>();
    const initialSteerItems: AppendedInput[] = [];
    for (const m of ports.drainSteer()) {
      const text = steerNoteText(m.message, m.envelope?.principalId);
      const item: AppendedInput = { envelopeId: m.envelopeId, kind: "steer", text, status: "queued" };
      tracked.set(item.envelopeId, item);
      initialSteerItems.push(item);
      if (m.envelope && isPerson(m.envelope.principalId)) personWaits = true;
    }
    const inputOf = (tail: string) => [tail, ...initialSteerItems.map((i) => i.text)].filter((t) => t.trim()).join("\n\n");
    // What a session of this cell's own starts from (also the fallback when a resume or a fork fails).
    const input = inputOf(tailText(snapshot));
    if (!input) return "completed";
    // A fork_prefix cell without its parent's session to continue: its own role as the system prompt.
    const ownSystem = snapshot.system.own;
    const ownHistory = ownSystem !== undefined && snapshot.spec.fork ? historyUnderOwnSystem(snapshot.history, cellId, snapshot.spec.fork.fromCellId) : snapshot.history;

    // ---------- session plan ----------
    const MAX_COMPACTIONS_PER_NATIVE_SESSION = 3;
    const own = await ports.context.readState<CliSessionRecord>(cellId, CLI_SESSION_KEY);
    const initialResetAt = await ports.context.readState<number>(cellId, CLI_SESSION_RESET_KEY);
    const sameModel = (r: CliSessionRecord) => (r.model ?? "") === (model ?? "");
    const curCompactions = snapshot.compactions ?? 0;
    const compactionsSinceSession = own ? curCompactions - (own.compactionsAtSessionStart ?? 0) : 0;
    const sessionResetRequested = initialResetAt !== null && (!own || initialResetAt >= own.updatedAt);
    const sessionBloated = own !== null && compactionsSinceSession >= MAX_COMPACTIONS_PER_NATIVE_SESSION;
    if (sessionBloated && !sessionResetRequested) {
      debug({
        type: "notice",
        cellId,
        text: `${engine}: native session ${own.sessionId} crossed ${compactionsSinceSession} compactions; rolling over smoothly to a fresh session with structured summary`,
      });
    }
    let plan: { session?: LaunchRequest["session"]; prompt: string; forkedFrom?: string; parentHash?: string };
    let releaseParent: (()=>void) | undefined;
    let sessionBaselineSeq = snapshot.historyUptoSeq;
    if (own && !sessionResetRequested && !sessionBloated && own.engine === engine && own.cwd === access.root && own.systemHash === snapshot.system.hash && sameModel(own)) {
      sessionBaselineSeq = own.lastDeliveredEvidenceSeq;
      const resumedInput = inputOf(tailText(snapshot, { resumed: true })) || input;
      const seenEnvelopes = new Set([...initialBatchIds, ...tracked.keys()]);
      const missed = ports.listEvidence?.({ afterSeq: sessionBaselineSeq }) ?? [];
      const catchup = missed.flatMap(({ seq, record }) => {
        if (seq > snapshot.historyUptoSeq) return [];
        if (record.kind === "external") return [renderEvidenceExternal(record)];
        if (record.kind !== "inbound" && record.kind !== "system_note") return [];
        const id = record.kind === "inbound" ? record.envelope.id : record.envelopeId;
        if (id && seenEnvelopes.has(id)) return [];
        if (id) seenEnvelopes.add(id);
        return [record.kind === "inbound" ? renderEvidenceInbound(record.envelope) : record.text];
      });
      plan = { session: { id: own.sessionId, mode: "resume" }, prompt: [...(catchup.length ? ["[Earlier events already handled while you were asleep — use as context]\n" + catchup.join("\n")] : []), resumedInput].join("\n\n") };
    } else {
      const freshInput = inputOf(tailText(snapshot, { resumed: historyCoversTask(ownHistory, snapshot.tail.originalTask) })) || input;
      plan = { prompt: freshPrompt(ownHistory, freshInput) };
      const forkIdx = snapshot.mode === "fork_prefix" && adapter.canFork && !own ? forkNoteIndex(snapshot.history) : -1;
      if (forkIdx >= 0) {
        const parent = await ports.context.readState<CliSessionRecord>(cellId, CLI_FORK_SESSION_KEY);
        const point = snapshot.spec.fork;
        if (parent && point && parent.engine === engine && sameModel(parent) && parent.cwd === access.root
            && !activeCells.has(point.fromCellId) && !readingParent.has(point.fromCellId) &&
            ports.canForkSession(point.fromCellId,point.uptoSeq,parent.sessionId,parent.lastDeliveredEvidenceSeq,parent.systemHash)) {
          sessionBaselineSeq = parent.lastDeliveredEvidenceSeq;
          plan = { session: { id: parent.sessionId, mode: "fork" }, prompt: freshPrompt(snapshot.history.slice(forkIdx), input), forkedFrom: parent.sessionId, parentHash: parent.systemHash };
          // The fork note is the first "earlier" message the child shows; the parent's part is in the forked session.
          plan.prompt = plan.prompt.replace(/^\[Earlier conversation[^\]]*\]\n\n/, "");
        }
      }
    }

    // ---------- Run state ----------
    const tmpDir = mkdtempSync(join(tmpdir(), `ng-cli-${engine}-`));
    // The parent's system text only where the parent's session is continued (a native fork); otherwise the cell's own.
    const systemFor = (session: LaunchRequest["session"]) =>
      kernelSystem(session?.mode === "fork" || ownSystem === undefined ? snapshot.system.text : ownSystem, adapter, caps, tools);
    const systemFile = join(tmpDir, "system.md");
    const env = cliEnvironment(opts.env ?? process.env, {
      ...(opts.keepEnv ? { keep: opts.keepEnv } : {}),
      ...(opts.dropEnv ? { drop: opts.dropEnv } : {}),
      // Marks every process below as started by a workbench cell: the owner's own entrances into the workbench (the
      // external-agent MCP shim) stay closed to it.
      set: { ...adapter.env, [WORKBENCH_CELL_ENV]: cellId },
    });

    let sessionId: string | null = plan.session?.mode === "resume" ? plan.session.id : null;
    let sessionProgress = false;
    let awaitingSessionConfirmation = false;
    let eventChain = Promise.resolve();
    let sessionModel: string | null = null;
    let sessionCreatedAt = own && plan.session?.mode === "resume" ? own.createdAt : clock.now();
    let sessionCompactionsBase = own && plan.session?.mode === "resume" ? (own.compactionsAtSessionStart ?? 0) : curCompactions;
    let endOutcome: EndOutcome | undefined;
    /** The turn in which a tool ended the Run is over: nothing the CLI says after that is this Run's. */
    let closingDone = false;
    let refused = false;
    let awaitsWakeup = false;
    let stopReason: StopReason | null = null;
    let steps = 0;
    let completedTurns = 0;
    let callCounter = 0;
    let leg = 0;
    const live: { proc: CliProcess | null; driver: CliDriver | null; legTurns: number; turnSteps: number } = {
      proc: null,
      driver: null,
      legTurns: 0,
      turnSteps: 0,
    };
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    let persist: Promise<unknown> = Promise.resolve();
    const io: DriverIO = {
      acceptingPrompts: () => !endOutcome && !stopReason,
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
        compactionsAtSessionStart: sessionCompactionsBase,
        ...(plan.forkedFrom ? { forkedFrom: plan.forkedFrom } : {}),
      };
      const patches: Record<string, unknown> = { [CLI_SESSION_KEY]: rec };
      if (plan.forkedFrom) patches[CLI_FORK_SESSION_KEY] = null;
      if (sessionResetRequested) patches[CLI_SESSION_RESET_KEY] = null;
      persist = persist
        .then(async () => {
          // If resetSession: true was requested during this Run, do not overwrite the reset with the old session.
          const latestResetAt = await ports.context.readState<number>(cellId, CLI_SESSION_RESET_KEY);
          if (latestResetAt !== null && (initialResetAt === null || latestResetAt > initialResetAt)) return;
          await ports.context.commit(cellId, { statePatches: patches });
        })
        .catch(() => undefined);
    };

    /**
     * The session has taken something in. It is put on record now, not only when the Run ends: a kernel that dies in
     * the middle of a cell's very first turn must find the session again, or the next Run primes a second one with
     * the same task.
     */
    const progressed = () => {
      if (sessionProgress) return;
      sessionProgress = true;
      persistSession(false);
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
    let lastProgressAt = Date.now();
    let lastBeatAt = lastProgressAt;
    let asleepSinceProgressMs = 0;
    const touchActivity = () => {
      const now = Date.now();
      lastProgressAt = now;
      lastBeatAt = now;
      asleepSinceProgressMs = 0;
    };
    const idleBeatMs = Math.min(1_000, Math.max(50, Math.floor(runTimeoutMs / 6)));
    const runTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - lastBeatAt;
      lastBeatAt = now;
      if (gap > idleBeatMs + Math.max(1_000, idleBeatMs)) {
        asleepSinceProgressMs += gap - idleBeatMs;
      }
      if (now - lastProgressAt - asleepSinceProgressMs >= runTimeoutMs) {
        if (live.turnSteps > 0) confirmTurn(leg, live.legTurns + 1);
        stop("timeout");
      }
    }, idleBeatMs);
    runTimer.unref?.();

    // ---------- kernel tools over MCP ----------
    async function callTool(name: string, args: unknown, meta: { requestId: string; signal: AbortSignal }): Promise<BridgeCallResult> {
      touchActivity();
      if (endOutcome || stopReason) {
        if (endOutcome) interruptAndKill();
        return { text: RUN_ALREADY_ENDED, isError: true };
      }
      const callLeg = leg;
      const callTurn = live.legTurns + 1;
      const callSignal = AbortSignal.any([signal, meta.signal]);
      const stale = () => callSignal.aborted || callLeg !== leg;
      if (stale()) return {text: RUN_ALREADY_ENDED, isError: true};
      progressed();
      const tool = byName.get(name)!;
      const toolUseId = `mcp_${runId}_${++callCounter}`;
      await append({ kind: "tool_call", toolUseId, name, input: args });
      await countStep();
      if (stopReason === "steps") {
        await append({ kind:"tool_result", toolUseId, name, output:RUN_ALREADY_ENDED, isError:true });
        return {text:RUN_ALREADY_ENDED, isError:true};
      }
      if (stale()) return {text: RUN_ALREADY_ENDED, isError: true};
      let result: ToolResult;
      try {
        result = normalizeToolResult(
          await raceAbort(Promise.resolve(tool.handler(args, { ports, snapshot, signal: callSignal, toolUseId, clock })), callSignal),
        );
      } catch (err) {
        result = { output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      touchActivity();
      const ev = await append({ kind: "tool_result", toolUseId, name, output: result.output, ...(result.isError ? { isError: true } : {}) });
      let text = ev.modelText ?? result.output;
      if (stale()) return {text: RUN_ALREADY_ENDED, isError: true};
      if (result.awaitsWakeup) awaitsWakeup = true;
      if (result.sent && !result.isError) {
        if (result.sent.text.trim()) {
          said.add(bare(result.sent.text));
          sentTexts.add(bare(result.sent.text));
        }
        if (isChannelAddr(result.sent.to)) personWaits = false;
      }
      if (result.endRun) {
        // The CLI demonstrably processed the active turn of this leg to invoke this tool: confirm items belonging to
        // this active turn (including turn_end follow-ups), while leaving any mid-turn queued steers unconfirmed.
        await eventChain;
        if (stale()) return {text: RUN_ALREADY_ENDED, isError: true};
        confirmTurn(callLeg, callTurn);
        if (endOutcome === undefined || RUN_END_PRECEDENCE.indexOf(result.endRun) < RUN_END_PRECEDENCE.indexOf(endOutcome)) endOutcome = result.endRun;
        text = `${text}\n\n${RUN_ENDED_NOTICE}`;
        armEndGrace();
      }
      const structuredContent =
        result.data !== null && typeof result.data === "object" && !Array.isArray(result.data)
          ? (result.data as Record<string, unknown>)
          : undefined;
      return { text, ...(result.isError ? { isError: true } : {}), ...(structuredContent ? { structuredContent } : {}) };
    }

    function confirmTurn(legNo: number, turn: number) {
      if (endOutcome || stopReason === "cancelled" || stopReason === "timeout" || signal.aborted) return;
      progressed();
      for (const item of tracked.values()) {
        if (item.status !== "sent" || item.sentInLeg !== legNo || (item.confirmAtTurn ?? 1) !== turn) continue;
        item.status = "confirmed";
      }
      awaitingSessionConfirmation = !sessionId;
      confirmCursor();
    }

    function confirmCursor() {
      if (sessionId && ports.confirmCliInput && ports.listEvidence) {
        let through = sessionBaselineSeq;
        for (const { seq, record } of ports.listEvidence({ afterSeq: through })) {
          if (record.kind !== "inbound" && record.kind !== "system_note" && record.kind !== "external") continue;
          if (seq > snapshot.historyUptoSeq) {
            const id = record.kind === "inbound" ? record.envelope.id : record.kind === "system_note" ? record.envelopeId : undefined;
            if (!id || (!initialBatchIds.has(id) && tracked.get(id)?.status !== "confirmed")) break;
          }
          through = seq;
        }
        ports.confirmCliInput(sessionId, through);
      }
    }

    async function countStep(): Promise<void> {
      steps++;
      live.turnSteps++;
      if (maxSteps !== undefined && steps > maxSteps && !endOutcome) {
        confirmTurn(leg, live.legTurns + 1);
        stop("steps");
      }
    }

    let bridge: ToolBridge | null = null;
    try {
      const runnerOptions = tools.some((t) => t.runnerOptions) && ports.describeRunnerOptions
        ? await raceAbort(ports.describeRunnerOptions(), signal)
        : "";
      signal.throwIfAborted();
      bridge = await startToolBridge({
        serverName: CLI_MCP_SERVER,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.runnerOptions && runnerOptions ? `${t.description}\n\n${runnerOptions}` : t.description,
          inputSchema: t.inputSchema,
        })),
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
              !plan.parentHash || !ports.canForkSession(point.fromCellId,point.uptoSeq,nextSession.id,sessionBaselineSeq,plan.parentHash)) {
            nextSession=undefined;
            sessionBaselineSeq = snapshot.historyUptoSeq;
            nextPrompt=freshPrompt(ownHistory, inputOf(tailText(snapshot, { resumed: historyCoversTask(ownHistory, snapshot.tail.originalTask) })) || input);
            delete plan.forkedFrom;
          } else {
            readingParent.set(point.fromCellId,new Promise<void>(resolve=>{
              releaseParent=()=>{readingParent.delete(point.fromCellId);resolve();releaseParent=undefined;};
            }));
          }
        }
        const systemText = systemFor(nextSession);
        writeFileSync(systemFile, systemText, { mode: 0o600 });
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
        if (stopReason === "timeout") {
          if (steps > 0 || completedTurns > 0) {
            confirmCursor();
            await append({
              kind: "system_note",
              text: `[run stopped after ${Math.max(1, Math.round(runTimeoutMs / 1_000))}s without progress (idle timeout); the kernel wakes you to continue]`,
            });
            requeueUnconfirmed("run hit idle timeout before mid-run input was confirmed");
            return "timeout";
          }
          throw new Error(`${engine} run exceeded ${runTimeoutMs} ms without progress and was stopped`);
        }
        if (endOutcome) {
          requeueUnconfirmed("run ended by tool before mid-run input was confirmed");
          return finish(endOutcome);
        }
        if (stopReason === "steps") {
          // The step limit leaves work for the next run.
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
          sessionCreatedAt = clock.now();
          sessionCompactionsBase = curCompactions;
          delete plan.forkedFrom;
          nextSession = undefined;
          nextPromptItems = out.relaunchItems;
          nextPrompt = rebuildFreshPrompt(snapshot, initialBatchIds, ports, tracked, out.relaunchItems, ownHistory);
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
              nextSession = undefined;
              nextPromptItems = out.relaunchItems;
              nextPrompt = rebuildFreshPrompt(snapshot, initialBatchIds, ports, tracked, out.relaunchItems, ownHistory);
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
      clearInterval(runTimer);
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
      live.turnSteps = 0;
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
      let claudeQueuedThrough = 0;
      eventChain = Promise.resolve();

      async function recordSent(items: readonly AppendedInput[], turn: number) {
        for (const item of items) {
          item.status = "sent";
          item.sentInLeg = legNo;
          item.confirmAtTurn = turn;
          if (item.kind === "steer" && !item.evidenceRecorded) {
            await append({ kind: "system_note", text: item.text, envelopeId: item.envelopeId });
            item.evidenceRecorded = true;
          }
        }
      }
      await recordSent(promptItems, 1);

      const finishInput = () => {
        if (!finished) {
          finished = true;
          d.finish(io);
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
      const deliver = async (items: AppendedInput[], mode: DeliverMode) => {
        if (items.length === 0 || finished || stopReason || endOutcome) return;
        if (engine === "claude" && claudeQueuedThrough > legTurns) {
          pendingSteer.push(...items);
          return;
        }
        const joined = items.map((i) => i.text).join("\n\n");
        if (d.steer(joined, io)) {
          const targetTurn = Math.max(nextConfirmTurn, legTurns + (turnActive ? 1 : 0)) + 1;
          nextConfirmTurn = targetTurn;
          if (engine === "claude") claudeQueuedThrough = targetTurn;
          await recordSent(items, targetTurn);
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
            if (a.envelope.delivery !== "silent_inject" && isPerson(a.envelope.principalId) && speaks(a.envelope)) personWaits = true;
          }
          return items;
        } catch (err) {
          debug({ type: "notice", cellId, text: `absorbing follow-ups failed: ${err instanceof Error ? err.message : String(err)}` });
          return [];
        }
      };

      const handle = async (e: CliEvent): Promise<void> => {
        if (e.type !== "notice") touchActivity();
        if ((endOutcome || refused) && e.type !== "session") {
          // The closing words after the tool that ended the Run (the kernel asked for them: RUN_ENDED_NOTICE) are
          // what the owner reads as the answer — "方案已提交，等你确认后开始" — so they go on the record.
          // Only up to the end of that turn: text after it answers input the kernel has put back in the queue.
          if (e.type === "text" && endOutcome && !refused && !closingDone && e.text.trim() && worthKeeping(e.text)) await speak(e.text);
          if (e.type === "tool_start") interruptAndKill();
          if (e.type === "turn_end") {
            closingDone = true;
            finished = true;
            killNow();
          }
          return;
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
              await deliver(items, "interrupt");
            }
            break;
          case "text":
            progressed();
            if (e.text.trim() && !(personWaits && spokenCount === 0) && sentTexts.has(bare(e.text))) break;
            await speak(e.text);
            break;
          case "tool_start": {
            if (endOutcome || stopReason) {
              d.interrupt(io);
              killNow();
              break;
            }
            progressed();
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
          case "turn_end":
            legTurns++;
            live.legTurns = legTurns;
            live.turnSteps = 0;
            if (e.ok && !e.stopped) {
              completedTurns++;
              state.turnOk = true;
              confirmTurn(legNo, legTurns);
            } else if (e.refused) {
              refused = true;
              confirmTurn(legNo, legTurns);
              finished = true;
              killNow();
              break;
            } else if (e.ok && e.stopped && legTurns === 1 && !signal.aborted && !stopReason) {
              // The adapter acknowledged the original prompt. A later interrupted correction still needs a retry.
              progressed();
              awaitingSessionConfirmation = !sessionId;
              confirmCursor();
            } else if (!e.ok && (!e.stopped || e.error)) {
              state.turnError = e.error ?? "turn failed";
              finished = true;
              killNow();
              break;
            }
            turnActive = Boolean(e.more) || (engine === "claude" && e.ok && claudeQueuedThrough > legTurns);
            if (turnActive) break;
            if (e.ok && !endOutcome && !stopReason && !refused) {
              const items: AppendedInput[] = [];
              if (pendingSteer.length && state.sawSession) {
                items.push(...pendingSteer);
                pendingSteer = [];
              }
              // The turn ended by itself: only now are follow-ups taken in. They are part of this Run's claim from
              // here on, so they must reach the model before the Run may end (live input, or a resume of the session).
              if (e.ok && !e.stopped) items.push(...absorbInbound());
              if (items.length) {
                await deliver(items, "turn_end");
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
        killGraceMs,
        ...(opts.processRegistry ? { registry: { ...opts.processRegistry, runId, cellId } } : {}),
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
            const text = steerNoteText(m.message, m.envelope?.principalId);
            const item: AppendedInput = { envelopeId: m.envelopeId, kind: "steer", text, status: "queued" };
            tracked.set(item.envelopeId, item);
            items.push(item);
            if (m.envelope && isPerson(m.envelope.principalId)) personWaits = true;
          }
          if (!ended) await deliver(items, "interrupt");
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
      debug({ type: "exit", cellId, code: exit.code, signal: exit.signal, stderr: state.stderr, ...(endOutcome || stopReason ? { stopped: true } : {}) });
      return state;
    }
  }

  return { engine, adapter, run };
}

/** Kernel-side capabilities → what the CLI may do. */
export function capabilitiesOf(access: WorkspaceAccess, processor: LlmProcessorSpec): CliCapabilities {
  const allowedTools = processor.allowedTools ? new Set<ToolKind>(processor.allowedTools) : null;
  const has = (k: ToolKind) => access.tools.includes(k) && (allowedTools === null || allowedTools.has(k));
  const write = has("write");
  const edit = has("edit");
  const bash = has("bash");
  return { root: access.root, write, edit, bash, readOnly: !(write || edit || bash), web: true };
}
