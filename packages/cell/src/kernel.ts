import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createChannelHub } from "@ng/channel";
import { createContextStore } from "@ng/context";
import { createGate, DEFAULT_OWNER_ADDRESSES } from "@ng/gate";
import { createInbox } from "@ng/inbox";
import {
  createAgentLoop,
  createCliAgentLoop,
  createRoutingLoop,
  registerStandardToolsets,
  resolveAgentBackend,
  STANDARD_TOOLSETS,
  UnconfiguredModelClient,
} from "@ng/loop";
import {
  cellPrincipal,
  cellsRepo,
  createBus,
  createRegistry,
  NgError,
  openDatabase,
  systemClock,
  type AgentEngine,
  type AgentLoop,
  type Clock,
  type Db,
} from "@ng/protocol";
import { createWorkspaceManager } from "@ng/workspace";
import { createApprovals } from "./approvals";
import { DEFAULT_ROOT_BOUNDS, DEFAULTS } from "./constants";
import type { KernelCore } from "./core";
import { createDispatcher } from "./dispatcher";
import { createEscalations } from "./escalations";
import { createLifecycle } from "./lifecycle";
import { createReadModel } from "./readmodel";
import { ingest } from "./routing";
import { scratchRepo } from "./scratch";
import type { Kernel, KernelOptions } from "./types";

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
 *   const kernel = createKernel({ dataDir, model });
 *   registerPresets(kernel.registry);
 *   kernel.ensureRootCell({ id: "desk", preset: "inline", processor: … });
 *   await kernel.start();
 */
export function createKernel(opts: KernelOptions = {}): Kernel {
  // Resolved before anything touches the disk, so a kernel that cannot run llm cells fails fast.
  let agentBackend: AgentEngine | null = null;
  if (!opts.loop) {
    const setting = opts.agentBackend ?? (opts.model ? "api" : "auto");
    const bins = Object.fromEntries(Object.entries(opts.cli ?? {}).flatMap(([e, o]) => (o?.bin ? [[e, o.bin]] : [])));
    agentBackend = resolveAgentBackend(setting, { apiAvailable: Boolean(opts.model), bins });
    if (agentBackend === "api" && !opts.model) throw new NgError("invalid_argument", 'agentBackend "api" needs a model');
    if (agentBackend === null) {
      throw new NgError("invalid_argument", "createKernel needs a model, a ready-made loop, or an installed CLI agent (claude, codex or agy)");
    }
  }
  const onError =
    opts.onError ??
    ((err: unknown, where: string) => {
      console.error(`[kernel] ${where}:`, err);
    });

  // ---------- storage ----------
  const ownsDataDir = opts.dataDir === undefined;
  const dataDir = resolve(opts.dataDir ?? mkdtempSync(join(tmpdir(), "ng-kernel-")));
  mkdirSync(dataDir, { recursive: true });
  const ownsDb = typeof opts.db !== "object";
  const db: Db = typeof opts.db === "object" ? opts.db : openDatabase(opts.db ?? join(dataDir, "ng.db"));

  const clock = opts.clock ?? systemClock;
  const bus = opts.bus ?? createBus({ onError: (err, topic) => onError(err, `bus handler for ${topic}`) });
  const registry = opts.registry ?? createRegistry();
  const ownerPrincipal = opts.ownerPrincipal ?? DEFAULTS.ownerPrincipal;
  const ownerAddresses = [...(opts.ownerAddresses ?? DEFAULT_OWNER_ADDRESSES)];
  const deskCellId = opts.deskCellId ?? DEFAULTS.deskCellId;
  if (!registry.toolsets.has(STANDARD_TOOLSETS.workspace)) registerStandardToolsets(registry, { ownerAddresses, deskCellId });
  const cells = cellsRepo(db, clock);

  // ---------- primitives ----------
  const gate = createGate({
    db,
    bus,
    clock,
    ownerPrincipal,
    ownerAddresses,
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
    ...opts.gate,
  });
  const inbox = createInbox({
    db,
    bus,
    clock,
    ownerPrincipal,
    authorizeControl: (cellId, principalId, action) => gate.authorizeControlSync(cellId, principalId, action),
    resolveDesk: (cellId) => (cellId !== deskCellId && cells.get(deskCellId) ? deskCellId : cells.require(cellId).rootId),
    defaultLeaseMs: opts.leaseMs ?? DEFAULTS.leaseMs,
    maxAttempts: opts.maxAttempts ?? DEFAULTS.maxAttempts,
    onError: (err) => onError(err, "inbox"),
  });
  const context = createContextStore({
    db,
    bus,
    clock,
    inbox,
    dataDir,
    registry,
    rosterProvider: (cellId) => core.readModel.childSummaries(cellId),
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
    ...(opts.repoPath ? { defaultRepoPath: opts.repoPath } : {}),
    // Host-side secret proxy: the Gate decides (secret.use within bounds), the value never enters the sandbox.
    injectSecret: (secretRef, ctx) => {
      const r = gate.authorizeSync(
        {
          type: "secret.use",
          secretRef,
          purpose: ctx.purpose,
          summary: ctx.purpose,
          subjectKey: `cell:${ctx.cellId}`,
          sideEffect: "internal",
        },
        { cellId: ctx.cellId, principalId: cellPrincipal(ctx.cellId), epoch: ctx.epoch },
      );
      if (r.type !== "allow") throw new Error(r.type === "deny" ? r.feedback : `secret "${secretRef}" needs the owner's approval first`);
      return gate.injectSecretSync(r.actionToken, secretRef);
    },
  });
  const hub = createChannelHub({
    db,
    bus,
    clock,
    ownerPrincipal,
    ...opts.hubOptions,
    verifyToken: (token, req) => {
      const r = gate.verifyTokenSync(token, { type: "channel.send", target: req.target, content: req.content, summary: "", subjectKey: "", sideEffect: "external" });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
  });
  const loop: AgentLoop =
    opts.loop ??
    createRoutingLoop({
      api: createAgentLoop({ model: opts.model ?? new UnconfiguredModelClient(), registry, clock, ...opts.loopOptions }),
      defaultEngine: agentBackend,
      cliLoop: (engine) => createCliAgentLoop({ ...opts.cli?.[engine], engine, registry, clock }),
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
    deskCellId,
    ownerPrincipal,
    ownerAddresses,
    allowHostWrites: opts.allowHostWrites ?? false,
    rootBounds: { ...DEFAULT_ROOT_BOUNDS, ...Object.fromEntries(Object.entries(opts.rootBounds ?? {}).filter(([, v]) => v !== undefined)) },
    repoPath: opts.repoPath,
    leaseMs: opts.leaseMs ?? DEFAULTS.leaseMs,
    maxConcurrentRuns: Math.max(1, opts.maxConcurrentRuns ?? DEFAULTS.maxConcurrentRuns),
    retryBackoffMs: opts.retryBackoffMs ?? DEFAULTS.retryBackoffMs,
    maxRetryBackoffMs: opts.maxRetryBackoffMs ?? DEFAULTS.maxRetryBackoffMs,
    onError,
    track,
    pendingTasks: () => tasks.size,
    tasksSettled: async () => {
      await Promise.allSettled([...tasks]);
    },
    ensureScratchRepo: scratchRepo(join(dataDir, "base-repo")),
    lifecycle: undefined as never,
    dispatcher: undefined as never,
    escalations: undefined as never,
    approvals: undefined as never,
    readModel: undefined as never,
  };
  core.lifecycle = createLifecycle(core);
  core.dispatcher = createDispatcher(core, { idleTimeoutMs: DEFAULTS.idleTimeoutMs });
  core.escalations = createEscalations(core);
  core.approvals = createApprovals(core);
  core.readModel = createReadModel(core);
  const { dispatcher, lifecycle } = core;

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
        try {
          const closed = lifecycle.closeCellSync(ev.cellId, "cancelled", { principalId: ev.principalId });
          void track(lifecycle.cleanupClosed([...new Set([...closed, ...ids])]));
        } catch (err) {
          onError(err, `close after cancel of ${ev.cellId}`);
        }
      } else if (ev.action === "pause") {
        dispatcher.abortCells(ids, "pause");
        void track(
          Promise.all(ids.map((id) => workspace.cancelJobsForCell(id).catch((err: unknown) => onError(err, `cancel jobs of paused ${id}`)))),
        );
      }
    }),
  );

  let started = false;
  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribeClock: (() => void) | undefined;

  const kernel: Kernel = {
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
    dataDir,
    deskCellId,
    ownerPrincipal,
    ownerAddresses,

    async start() {
      if (started) return;
      if (stopped) throw new NgError("conflict", "this kernel was stopped; create a new one on the same database to continue");
      started = true;
      // A previous process's in-flight Runs died with it; their batches go back to the queue (one attempt each).
      inbox.recoverClaimsSync({ reason: "recovered at startup: the previous kernel stopped during this run" });
      hub.recoverInterruptedSync();
      core.approvals.reconcile();
      try {
        await workspace.recover();
      } catch (err) {
        onError(err, "workspace recovery");
      }
      // Leases are renewed before the inbox looks at a moved ManualClock, so a live Run is never expired by a test step.
      if (isSubscribable(clock)) unsubscribeClock = clock.subscribe(() => dispatcher.renewAll());
      heartbeat = setInterval(() => dispatcher.renewAll(), Math.max(1_000, Math.floor(core.leaseMs / 3)));
      heartbeat.unref?.();
      dispatcher.start();
      inbox.start();
      for (const id of inbox.dueCellIdsSync()) dispatcher.notify(id);
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      inbox.stop();
      unsubscribeClock?.();
      if (heartbeat) clearInterval(heartbeat);
      await dispatcher.stop();
      await Promise.allSettled([...tasks]);
      workspace.close();
      for (const u of unsubscribe) u();
    },

    async close() {
      await kernel.stop();
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
    control: (cellId, cmd, o) =>
      inbox.controlSync(cellId, {
        action: cmd.action,
        principalId: o?.principalId ?? ownerPrincipal,
        ...(cmd.steerMessage !== undefined ? { steerMessage: cmd.steerMessage } : {}),
      }),

    ingest: (raw, channelId) => ingest(core, raw, channelId),
    resolveApproval: (actionId, decision) => core.approvals.resolve(actionId, decision),
    resolveUnknownSend: (actionId, verdict, note) => core.approvals.resolveUnknownSend(actionId, verdict, note),
    async setFocus(on) {
      hub.setFocusSync(on);
      if (on) return null;
      const r = await track(hub.flushBuffered());
      return { sent: r.sent, failed: r.failed, unknown: r.unknown };
    },

    getCell: (cellId) => cells.get(cellId),
    listCells: (filter) => cells.list(filter),
    rosterFor: (cellId) => core.readModel.rosterFor(cellId),
    tree: (o) => core.readModel.tree(o),
    stats: () => core.readModel.stats(),
    activeRuns: () => dispatcher.activeRuns(),
  };
  return kernel;
}
