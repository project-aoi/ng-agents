import {runtimeVersion} from "./release";
import { createHumanItems } from "./human-items";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createChannelHub } from "@ng/channel";
import { createContextStore } from "@ng/context";
import { createGate } from "@ng/gate";
import { createInbox } from "@ng/inbox";
import {
  createCodeLoop,
  createCliAgentLoop,
  createRoutingLoop,
  reapOrphanedCliProcesses,
  registerStandardToolsets,
  resolveAgentBackend,
  STANDARD_TOOLSETS,
} from "@ng/loop";
import {
  cellsRepo,
  KERNEL_FROM,
  newId,
  createBus,
  createRegistry,
  NgError,
  openDatabase,
  systemClock,
  withTx,
  type AgentEngine,
  type AgentLoop,
  type Clock,
  type Db,
  type CliEngine,
} from "@ng/protocol";
import { createWorkspaceManager } from "@ng/workspace";
import { createKeepAwake } from "./awake";
import { DEFAULT_ROOT_BOUNDS, DEFAULTS } from "./constants";
import type { KernelCore } from "./core";
import { createDispatcher } from "./dispatcher";
import { createEscalations } from "./escalations";
import { createLifecycle } from "./lifecycle";
import { createModelSettings, type ModelSettings } from "./models";
import { createReadModel } from "./readmodel";
import { inspectCell } from "./inspect";
import { ccDirectChat, directMessage, isPersonPrincipal, sendCellMessage } from "./messages";
import { ingest } from "./routing";
import { createStallMonitor } from "./stall";
import type { Kernel, KernelOptions } from "./types";
import { createWaits } from "./waits";

interface SubscribableClock extends Clock {
  subscribe(listener: (now: number) => void): () => void;
}

function isSubscribable(clock: Clock): clock is SubscribableClock {
  return typeof (clock as Partial<SubscribableClock>).subscribe === "function";
}

/**
 * ⑦ The kernel: wires the six primitives into one runtime — supervision tree and epochs, the dispatcher (one Run per
 * cell, a global cap, control that takes effect immediately), ingress routing, approval execution, escalations and
 * the close cascade. Everything is built with defaults from a few options:
 *
 *   const kernel = createKernel({ dataDir, agentBackend: "auto" });
 *   registerPresets(kernel.registry);
 *   kernel.ensureRootCell({ id: "desk", preset: "inline", processor: … });
 *   await kernel.start();
 */
export function createKernel(opts: KernelOptions = {}): Kernel {
  const ownsDataDir = opts.dataDir === undefined;
  const dataDir = resolve(opts.dataDir ?? mkdtempSync(join(tmpdir(), "ng-kernel-")));
  mkdirSync(dataDir, { recursive: true });
  // Resolve the backend before opening the workbench database.
  let agentBackend: AgentEngine | null = null;
  if (opts.agentBackend || !opts.loop) {
    const setting = opts.agentBackend ?? "auto";
    const bins = Object.fromEntries(Object.entries(opts.cli ?? {}).flatMap(([e, o]) => (o?.bin ? [[e, o.bin]] : [])));
    agentBackend = resolveAgentBackend(setting, { bins });
    if (agentBackend === null) {
      throw new NgError("invalid_argument", "createKernel requires an installed CLI agent (claude, codex or agy)");
    }
  }
  const onError =
    opts.onError ??
    ((err: unknown, where: string) => {
      console.error(`[kernel] ${where}:`, err);
    });

  // ---------- storage ----------
  const ownsDb = typeof opts.db !== "object";
  const db: Db = typeof opts.db === "object" ? opts.db : openDatabase(opts.db ?? join(dataDir, "ng.db"));

  const clock = opts.clock ?? systemClock;
  const bus = opts.bus ?? createBus({ onError: (err, topic) => onError(err, `bus handler for ${topic}`) });
  const registry = opts.registry ?? createRegistry();
  const ownerPrincipal = opts.ownerPrincipal ?? DEFAULTS.ownerPrincipal;
  const deskCellId = opts.deskCellId ?? DEFAULTS.deskCellId;
  if (!registry.toolsets.has(STANDARD_TOOLSETS.workspace)) registerStandardToolsets(registry, { deskCellId });
  const cells = cellsRepo(db, clock);

  // ---------- primitives ----------
  const gate = createGate({
    db,
    bus,
    clock,
    ownerPrincipal,
    onSuperseded: (record, actor) => core.humanItems.superseded(record, actor),
  });
  const inbox = createInbox({
    db,
    bus,
    clock,
    ownerPrincipal,
    cancelCellSync: (id,principalId)=>{core.lifecycle.closeCellSync(id,"cancelled",{principalId});},
    authorizeControl: (cellId, principalId, action) => gate.authorizeControlSync(cellId, principalId, action),
    resolveDesk: (cellId) => (cellId !== deskCellId && cells.get(deskCellId) ? deskCellId : cells.require(cellId).rootId),
    defaultLeaseMs: opts.leaseMs ?? DEFAULTS.leaseMs,
    maxAttempts: opts.maxAttempts ?? DEFAULTS.maxAttempts,
    onError: (err) => onError(err, "inbox"),
  });
  const context = createContextStore({
    runtimeVersion:runtimeVersion(),
    db,
    bus,
    clock,
    inbox,
    dataDir,
    registry,
    rosterProvider: (cellId) => core.readModel.childSummaries(cellId),
    tailNotesProvider: (cellId) => core.readModel.tailNotes(cellId),
    ...opts.context,
  });
  const workspace = createWorkspaceManager({
    ...opts.workspace,
    db,
    bus,
    clock,
    dataDir: join(dataDir, "workspace"),
    inbox,
    resources: context,
  });
  const hub = createChannelHub({
    db,
    bus,
    clock,
    ownerPrincipal,
  });
  // ---------- the owner's model switch (one per CLI engine, created on first use) ----------
  const modelSwitch = opts.modelSwitch ? (opts.modelSwitch === true ? {} : opts.modelSwitch) : null;
  const modelSettingsByEngine = new Map<CliEngine, ModelSettings>();
  const modelSettingsOf = (engine: CliEngine): ModelSettings | null => {
    if (!modelSwitch) return null;
    let s = modelSettingsByEngine.get(engine);
    if (!s) {
      const cli = opts.cli?.[engine];
      s = createModelSettings({
        engine,
        dataDir,
        clock,
        ...(cli?.bin ? { bin: cli.bin } : {}),
        ...(cli?.env ? { env: cli.env } : {}),
        ...(cli?.models ? { initial: cli.models } : {}),
        ...modelSwitch,
        onError: (err, where) => onError(err, where),
      });
      modelSettingsByEngine.set(engine, s);
    }
    return s;
  };

  /** Running CLI agent processes are on record here, so a restart can stop the ones a crashed kernel left behind. */
  const cliProcDir = join(dataDir, "cli-procs");
  const loop: AgentLoop = createRoutingLoop({
    local: opts.loop ?? createCodeLoop(registry, clock),
    defaultEngine: agentBackend,
    cliLoop: (engine) => {
      const settings = modelSettingsOf(engine);
      return createCliAgentLoop({ procDir: cliProcDir, ...opts.cli?.[engine], ...(settings ? { resolveModel: (tier) => settings.resolve(tier) } : {}), engine, registry, clock });
    },
  });

  // ---------- background work tracking (for idle()) ----------
  const tasks = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    const t = p.finally(() => tasks.delete(t));
    tasks.add(t);
    t.catch(() => undefined);
    return p;
  };

  const core: KernelCore = {
    defaultEngine:agentBackend,
    db,
    bus,
    clock,
    registry,
    cells,
    inbox,
    context,
    gate,
    workspace,
    hub,
    loop,
    dataDir,
    cliProcDir,
    deskCellId,
    ownerPrincipal,
    rootBounds: { ...DEFAULT_ROOT_BOUNDS, ...Object.fromEntries(Object.entries(opts.rootBounds ?? {}).filter(([, v]) => v !== undefined)) },
    repoPath: opts.repoPath,
    leaseMs: opts.leaseMs ?? DEFAULTS.leaseMs,
    maxConcurrentRuns: Math.max(1, opts.maxConcurrentRuns ?? DEFAULTS.maxConcurrentRuns),
    retryBackoffMs: opts.retryBackoffMs ?? DEFAULTS.retryBackoffMs,
    maxRetryBackoffMs: opts.maxRetryBackoffMs ?? DEFAULTS.maxRetryBackoffMs,
    maxStepContinuations: Math.max(0, opts.maxStepContinuations ?? DEFAULTS.maxStepContinuations),
    stallGraceMs: Math.max(0, opts.stallGraceMs ?? DEFAULTS.stallGraceMs),
    onError,
    track,
    pendingTasks: () => tasks.size,
    tasksSettled: async () => {
      await Promise.allSettled([...tasks]);
    },
    lifecycle: undefined as never,
    dispatcher: undefined as never,
    escalations: undefined as never,
    humanItems: undefined as never,
    readModel: undefined as never,
    waits: undefined as never,
    stall: undefined as never,
  };
  core.waits = createWaits(core);
  core.lifecycle = createLifecycle(core);
  core.dispatcher = createDispatcher(core, { idleTimeoutMs: DEFAULTS.idleTimeoutMs });
  core.escalations = createEscalations(core);
  core.humanItems = createHumanItems(core);
  core.readModel = createReadModel(core);
  core.stall = createStallMonitor(core);
  const { dispatcher, lifecycle } = core;
  const keepAwake = createKeepAwake({
    bus,
    isBusy: () => dispatcher.activeRuns().length > 0 || workspace.listJobsSync({ state: ["running"] }).length > 0,
    onError: (err) => onError(err, "keep awake"),
  });

  for (const ch of opts.channels ?? []) hub.register(ch);
  hub.onIngress(async (raw, channelId) => {
    await ingest(core, raw, channelId);
  });

  // ---------- wiring ----------
  const unsubscribe: Array<() => void> = [];
  unsubscribe.push(bus.on("inbox.enqueued", (e) => dispatcher.notify(e.cellId)));
  unsubscribe.push(
    bus.on("inbox.dead", (e) => {
      core.escalations.deadLetter(e);
    }),
  );
  unsubscribe.push(
    inbox.onControl((ev) => {
      const ids = ev.cells.map((c) => c.cellId);
      if (ev.action === "cancel") {
        // The Inbox already advanced epochs and cleared the queue; stop the Runs at once, then finish the cascade.
        dispatcher.abortCells(ids, "cancel");
      } else if (ev.action === "pause") {
        dispatcher.abortCells(ids, "pause");
        void track(
          Promise.all(ids.map((id) => workspace.cancelJobsForCell(id).catch((err: unknown) => onError(err, `cancel jobs of paused ${id}`)))),
        );
      }
    }),
  );

  // Preferences live in each cell's frozen system prefix. A preference saved today must reach the cells that are
  // already alive (the desk, running projects), not only the ones created afterwards — "the owner stops repeating
  // themselves" (docs/05 §4.2). Their prefix is rebuilt at their next Run; that costs each of them one cache miss.
  unsubscribe.push(
    bus.on("knowledge.changed", (e) => {
      if (e.kind !== "preference" && e.kind !== "skill") return;
      try {
        const affected = e.scope === "global" || e.cellId === null ? cells.list({ status: ["active", "paused"] }) : [cells.get(e.cellId), ...cells.descendants(e.cellId, { status: ["active", "paused"] })];
        for (const c of affected.sort((a,b)=>(a?.depth ?? 0)-(b?.depth ?? 0))) if (c && c.status !== "closed") context.refreshPrefixSync(c.id);
      } catch (err) {
        onError(err, "refresh prefixes after a preference change");
      }
    }),
  );
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let stopped = false;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribeClock: (() => void) | undefined;

  async function startRuntime() {
    // Refresh already-materialized persistent prefixes in parent order after a new release or an offline skill edit.
    for (const c of cells.list({status:["active","paused"]}).sort((a,b)=>a.depth-b.depth)) context.refreshPrefixSync(c.id);
    // Ask the backend CLI for its models now, so the first Run does not have to wait for the list.
    if (agentBackend) modelSettingsOf(agentBackend)?.warm();
    // A previous process's in-flight Runs died with it; their batches go back to the queue (one attempt each).
    inbox.recoverClaimsSync({ reason: "recovered at startup: the previous kernel stopped during this run" });
    try {
      // A kernel that was killed leaves its CLI agents running (they have their own process groups) while their
      // batches were just taken back above: stop them before anything is dispatched into the same directories.
      for (const r of await reapOrphanedCliProcesses(cliProcDir)) {
        if (r.killed) onError(new Error(`stopped a CLI agent (pid ${r.pid}) of cell "${r.cellId}" left running in ${r.cwd} by the previous kernel`), "recovery");
        else if (r.status === "unknown") {
          dispatcher.holdForUnknownOrphan(r.cellId);
          onError(new Error(`deferred cell "${r.cellId}": CLI pid ${r.pid} in ${r.cwd} is alive with unreadable identity; checking the recorded identity for up to 30 seconds`), "recovery");
        }
      }
    } catch (err) {
      onError(err, "CLI process recovery");
    }
    try {
      // Resume interrupted cancellations. Jobs whose exit cannot be verified remain active in the workspace.
      await workspace.recover();
    } catch (err) {
      onError(err, "workspace recovery");
    }
    // A cell that was closed (its settle transaction committed) just before the previous kernel died may have left
    // Jobs running: their runtime is stopped before the dispatcher hands anyone that directory (docs/05 guard 4).
    const orphaned = new Set(workspace.listJobsSync({ state: ["running"] }).filter((j) => cells.get(j.cellId)?.status === "closed").map((j) => j.cellId));
    await Promise.all([...orphaned].map((id) => workspace.cancelJobsForCell(id).catch((err: unknown) => onError(err, `stop runtime of closed cell ${id}`))));
    // Leases are renewed before the inbox looks at a moved ManualClock, so a live Run is never expired by a test step.
    const sweep = () => {
      dispatcher.renewAll();
    };
    sweep();
    if (isSubscribable(clock)) unsubscribeClock = clock.subscribe(sweep);
    heartbeat = setInterval(sweep, Math.min(15_000, Math.max(1_000, Math.floor(core.leaseMs / 3))));
    heartbeat.unref?.();
    dispatcher.start();
    inbox.start();
    for (const id of inbox.dueCellIdsSync()) dispatcher.notify(id);
    core.stall.start();
    keepAwake.start();
  }

  async function stopKernel() {
    await starting?.catch(() => undefined);
    core.stall.stop();
    keepAwake.stop();
    inbox.stop();
    unsubscribeClock?.();
    if (heartbeat) clearInterval(heartbeat);
    await dispatcher.stop();
    await Promise.allSettled([...tasks]);
    workspace.close();
    for (const u of unsubscribe) u();
  }

  const kernel: Kernel = {
    humanItems: core.humanItems,
    db,
    bus,
    clock,
    registry,
    inbox,
    context,
    gate,
    workspace,
    hub,
    loop,
    agentBackend,
    modelSettings(engine) {
      const e = engine ?? (agentBackend ? agentBackend : null);
      return e ? modelSettingsOf(e) : null;
    },
    dataDir,
    deskCellId,
    ownerPrincipal,

    async start() {
      if (stopped) throw new NgError("conflict", "this kernel was stopped; create a new one on the same database to continue");
      return starting ??= startRuntime();
    },

    async stop() {
      stopped = true;
      return stopping ??= stopKernel();
    },

    async close() {
      await kernel.stop();
      if (closed) return;
      closed = true;
      if (ownsDb) {
        try {
          db.close();
        } catch (err) {
          onError(err, "close database");
        }
      }
      if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true });
    },

    idle: (o) => dispatcher.idle(o),

    createRootCell: (spec, o) => lifecycle.createRootCell(spec, o),
    ensureRootCell: (spec, o) => lifecycle.ensureRootCell(spec, o),
    spawnCell: (parentId, spec, initialPayload, o) => lifecycle.spawnCell(parentId, spec, initialPayload, o),
    updateCell: (cellId, patch, o) => lifecycle.updateCell(cellId, patch, o),
    closeCell: (cellId, reason, o) => lifecycle.closeCell(cellId, reason, o),
    control: (cellId, cmd, o) => {
      const principalId = o?.principalId ?? ownerPrincipal;
      const command = { action: cmd.action, principalId,...(cmd.pauseReason ? {pauseReason:cmd.pauseReason} : {}), ...(cmd.steerMessage !== undefined ? { steerMessage: cmd.steerMessage } : {}) };
      if (cmd.action !== "steer" || !isPersonPrincipal(core, principalId)) return inbox.controlSync(cellId, command);
      // A person's steer is a direct message like any other: the worker's parent gets the words in the same transaction.
      return withTx(db, () => {
        const r = inbox.controlSync(cellId, command);
        const target = cells.get(cellId);
        if (r.applied && target) ccDirectChat(core, target, { text: cmd.steerMessage ?? "", mode: "steer", messageId: newId("msg", clock), principalId });
        return r;
      });
    },

    ingest: (raw, channelId) => ingest(core, raw, channelId),
    reopenProject: core.lifecycle.reopenProject,
    getCell: (cellId) => cells.get(cellId),
    listCells: (filter) => cells.list(filter),
    rosterFor: (cellId) => core.readModel.rosterFor(cellId),
    tree: (o) => core.readModel.tree(o),
    stats: () => core.readModel.stats(),
    activeRuns: () => dispatcher.activeRuns(),
    activeWorkspaces: () => core.readModel.activeWorkspaces(),
    activityOf: (cellIds) => core.readModel.activityOf(cellIds),
    directMessage: (cellId, message, o) => directMessage(core, cellId, message, o?.principalId ?? ownerPrincipal),
    inspectCell: (cellId, o) => inspectCell(core, cellId, o),
    anchorsOf: (cellId) => core.readModel.anchorsOf(cellId),
    listWaits: (cellIds) => core.waits.list(cellIds),
    sendToCell: (cellId, message, o) => {
      const principalId = o?.principalId ?? ownerPrincipal;
      return sendCellMessage(core, { from: KERNEL_FROM.control, principalId, sender: principalId, toCellId: cellId, id: message.id ?? newId("msg", clock), message });
    },
    checkStalls: () => void core.stall.evaluate(),

  };
  return kernel;
}
