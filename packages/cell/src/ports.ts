import { deliveryAllowed } from "@ng/gate";
import {
  cellPrincipal,
  createEnvelope,
  inboxAddr,
  isChannelAddr,
  newId,
  NgError,
  PAYLOAD,
  TOOL_KINDS,
  timerFrom,
  type CancelScope,
  type CellRecord,
  type ClaimedBatch,
  type CommitTx,
  type Envelope,
  type ExecResult,
  type PromptSnapshot,
  type RunPorts,
  type RunSelf,
  type ToolKind,
  type WorkspaceAcquireOptions,
} from "@ng/protocol";
import type { ManagedWorkspacePort } from "@ng/workspace";
import { HOST_MUTATING_TOOLS, hostWriteRefusal } from "./constants";
import type { KernelCore } from "./core";
import type { RunHandle } from "./dispatcher";

export interface RunContext {
  cell: CellRecord;
  batch: ClaimedBatch;
  handle: RunHandle;
  snapshot: PromptSnapshot;
}

/** Lease heartbeat from inside the Run: at most every leaseMs/4 of (possibly manual) clock time. */
const RENEW_FRACTION = 4;

/** The isolation, base repository and branch a cell's workspace is acquired with. */
export async function acquireOptionsFor(core: KernelCore, cell: CellRecord): Promise<WorkspaceAcquireOptions> {
  const meta = cell.spec.meta?.["workspace"];
  const opts: WorkspaceAcquireOptions = meta && typeof meta === "object" ? { ...(meta as WorkspaceAcquireOptions) } : {};
  const iso = cell.bounds.isolation;
  if ((iso === "git_worktree" || iso === "container") && !opts.repoPath && !core.repoPath) opts.repoPath = await core.ensureScratchRepo();
  return opts;
}

/**
 * RunPorts bound to (cell, epoch, run, principal `cell:<id>`). Ports are the capability boundary — tools are not
 * trusted: every mutating port re-checks that this Run is still the cell's current one, workspace use is limited to
 * the cell's bounds (and refused on the owner's real directory), sends need a Gate token and an allowed target,
 * Context access is pinned to the cell, and cell management is limited to its own descendants.
 */
export function buildRunPorts(core: KernelCore, rc: RunContext): RunPorts {
  const { cells, inbox, gate, context, hub, clock } = core;
  const { cell, batch, handle } = rc;
  const cellId = cell.id;
  const runId = batch.claimId;
  const principalId = cellPrincipal(cellId);
  const bounds = cell.bounds;
  const runSignal = handle.controller.signal;
  let emitCounter = 0;
  let lastRenewAt = clock.now();

  const self: RunSelf = {
    cellId,
    epoch: batch.epoch,
    runId,
    principalId,
    parentId: cell.parentId,
    depth: cell.depth,
    bounds,
    spec: cell.spec,
  };

  function assertLive(what: string): void {
    if (runSignal.aborted) throw new NgError("stale_epoch", `${what}: this run was stopped; end your turn`);
    const cur = cells.get(cellId);
    if (!cur || cur.status === "closed" || cur.epoch !== self.epoch) {
      throw new NgError("stale_epoch", `${what}: this task was cancelled or closed; stop here`);
    }
  }

  function heartbeat(): void {
    const now = clock.now();
    if (now - lastRenewAt < core.leaseMs / RENEW_FRACTION) return;
    lastRenewAt = now;
    inbox.renewLeaseSync(runId, core.leaseMs);
  }

  const isDescendant = (id: string) => id !== cellId && cells.ancestors(id).some((a) => a.id === cellId);
  const ownOrDescendant = (id: string) => id === cellId || isDescendant(id);
  const sameLineage = (id: string) => ownOrDescendant(id) || cells.ancestors(cellId).some((a) => a.id === id);

  function pinned(id: string, what: string, allow: (id: string) => boolean = (x) => x === cellId): void {
    if (!allow(id)) throw new NgError("invalid_argument", `${what}: a cell may only use its own context (got "${id}", this cell is "${cellId}")`);
  }

  function requireDescendant(id: string, what: string): void {
    if (!isDescendant(id)) throw new NgError("bounds_violation", `${what}: "${id}" is not a descendant of this cell`);
  }

  /** Enforcement reads the cell's current bounds, so an owner's narrowing applies to a Run already in flight. */
  const liveBounds = () => cells.get(cellId)?.bounds ?? bounds;
  const mayDeliver = (to: string) => to === inboxAddr(cellId) || deliveryAllowed(liveBounds(), cell.parentId, to);

  // ---------- workspace (acquired lazily, with the isolation of the effective bounds) ----------

  let acquiring: Promise<ManagedWorkspacePort> | null = null;
  let root = "";

  function acquire(): Promise<ManagedWorkspacePort> {
    acquiring ??= (async () => {
      const port = await core.workspace.acquire(cellId, bounds.isolation, await acquireOptionsFor(core, cell));
      root = port.root;
      try {
        assertLive("workspace");
      } catch (err) {
        // Closed while the workspace was being created: the close cleanup may already have run, so remove it here.
        void core.track(core.workspace.destroy(cellId).catch((e: unknown) => core.onError(e, `destroy late workspace of ${cellId}`)));
        throw err;
      }
      return port;
    })().catch((err: unknown) => {
      acquiring = null;
      throw err;
    });
    return acquiring;
  }

  function checkTool(tool: ToolKind, what: string = tool): void {
    if (!(TOOL_KINDS as readonly string[]).includes(tool)) throw new NgError("invalid_argument", `unknown tool kind "${String(tool)}"`);
    const bounds = liveBounds();
    if (!bounds.tools.has(tool)) {
      throw new NgError("bounds_violation", `${what} needs the "${tool}" tool, which is outside this cell's bounds (allowed: ${[...bounds.tools].sort().join(", ") || "none"})`);
    }
    if (tool === "code_rpc" && !(["write", "edit", "bash"] as const).every((t) => bounds.tools.has(t))) {
      // code_rpc scripts call write/edit/bash through the workspace host, past this port.
      throw new NgError("bounds_violation", "code_rpc can write files and run commands, so it needs write, edit and bash in this cell's bounds");
    }
    if (bounds.isolation === "none" && !core.allowHostWrites && HOST_MUTATING_TOOLS.has(tool)) {
      throw new NgError("bounds_violation", hostWriteRefusal(what));
    }
  }

  const workspace: RunPorts["workspace"] & { writeJobInput(jobId: string, input: string): Promise<void> } = {
    cellId,
    isolation: bounds.isolation,
    get root() {
      return root;
    },
    async exec(tool: ToolKind, args: unknown, signal?: AbortSignal): Promise<ExecResult> {
      assertLive("workspace exec");
      checkTool(tool);
      const port = await acquire();
      return port.exec(tool, args, signal ? AbortSignal.any([signal, runSignal]) : runSignal);
    },
    async startJob(spec) {
      assertLive("job_start");
      checkTool("bash", "starting a job");
      return (await acquire()).startJob(spec);
    },
    async observeJob(jobId) {
      return (await acquire()).observeJob(jobId);
    },
    async writeJobInput(jobId, input) {
      assertLive("job_input");
      checkTool("bash", "job input");
      return (await acquire()).writeJobInput(jobId, input);
    },
    async cancelJob(jobId) {
      return (await acquire()).cancelJob(jobId);
    },
  };

  // ---------- context, pinned to this cell ----------

  function sanitizeOut(tx: CommitTx): CommitTx {
    if (!tx.inboxOut?.length) return tx;
    const inboxOut = tx.inboxOut.map((o) => {
      if (!mayDeliver(o.to)) throw new NgError("bounds_violation", `this cell may not deliver to ${o.to}; report to its parent instead`);
      // The kernel binds the sender: a cell cannot speak as the owner or as another cell.
      const envelope: Envelope = { ...o.envelope, from: inboxAddr(cellId), principalId };
      return { ...o, envelope };
    });
    return { ...tx, inboxOut };
  }

  const ctx: RunPorts["context"] = {
    async readState(id, key) {
      pinned(id, "readState", ownOrDescendant);
      return context.readStateSync(id, key);
    },
    async listState(id, prefix) {
      pinned(id, "listState", ownOrDescendant);
      return context.listStateSync(id, prefix);
    },
    async commit(id, tx) {
      pinned(id, "commit");
      assertLive("commit");
      return context.commitSync(cellId, sanitizeOut(tx));
    },
    async appendEvidence(id, record) {
      pinned(id, "appendEvidence");
      return context.appendEvidenceSync(cellId, record);
    },
    async readResource(id, uri, page) {
      pinned(id, "readResource");
      return context.readResourceSync(cellId, uri, page);
    },
    async searchHistory(id, query) {
      pinned(id, "searchHistory");
      return context.searchHistorySync(cellId, query);
    },
    async upsertSkillOrNote(id, patch) {
      pinned(id, "upsertSkillOrNote");
      assertLive("upsertSkillOrNote");
      context.upsertSkillOrNoteSync(cellId, patch);
    },
    async getArtifact(artifactId) {
      const a = context.getArtifactSync(artifactId);
      return a && sameLineage(a.cellId) ? a : null;
    },
    async listArtifacts(id) {
      pinned(id, "listArtifacts", ownOrDescendant);
      return context.listArtifactsSync(id);
    },
  };

  // ---------- the ports ----------

  const ports: RunPorts = {
    self,
    workspace,
    context: ctx,

    async notifyChannel(req) {
      assertLive("send");
      if (!isChannelAddr(req.target)) throw new NgError("invalid_argument", `"${req.target}" is not a channel address (channel:<channelId>:<target>)`);
      if (!deliveryAllowed(liveBounds(), cell.parentId, req.target)) {
        throw new NgError("bounds_violation", `this cell may not send to ${req.target}; report to its parent instead`);
      }
      if (!req.actionToken) throw new NgError("bounds_violation", "a send needs a Gate action token: call authorize first");
      return hub.send({
        target: req.target,
        content: req.content,
        idempotencyKey: req.idempotencyKey,
        actionToken: req.actionToken,
        ...(req.respectDnd !== undefined ? { respectDnd: req.respectDnd } : {}),
        cellId,
      });
    },

    async streamPreview(target, chunk) {
      if (!isChannelAddr(target) || !deliveryAllowed(liveBounds(), cell.parentId, target)) return;
      await hub.streamPreview(target, chunk);
    },

    async cancelScheduled(scope: CancelScope) {
      pinned(scope.cellId, "cancelScheduled");
      if (scope.cancelGroup === undefined && scope.envelopeId === undefined) {
        // The unfiltered form also drops unclaimed messages; only closeCell may do that.
        throw new NgError("invalid_argument", "cancelScheduled needs a cancelGroup or an envelopeId");
      }
      inbox.cancelScheduledSync(scope);
      if (scope.cancelGroup !== undefined) core.lifecycle.deactivateWatches(cellId, scope.cancelGroup);
    },

    async spawnCell(spec, initialPayload) {
      assertLive("spawnCell");
      return core.lifecycle.spawnCell(cellId, spec, initialPayload, { principalId });
    },

    async updateCell(targetId, patch) {
      assertLive("updateCell");
      requireDescendant(targetId, "updateCell");
      core.lifecycle.updateCell(targetId, patch, { principalId });
    },

    async closeCell(targetId, reason) {
      assertLive("closeCell");
      requireDescendant(targetId, "closeCell");
      const closed = core.lifecycle.closeCellSync(targetId, reason ?? "completed", { principalId });
      void core.track(core.lifecycle.cleanupClosed(closed));
    },

    async authorize(action, o) {
      return gate.authorizeSync(action, {
        cellId,
        principalId,
        epoch: self.epoch,
        ...(o?.artifactVersion !== undefined ? { artifactVersion: o.artifactVersion } : {}),
      });
    },

    meter(usage) {
      heartbeat();
      return gate.meter(cellId, usage);
    },

    drainSteer() {
      heartbeat();
      return inbox.drainSteerSync(cellId);
    },

    async emitToParent(type, payload, o = {}) {
      if (!cell.parentId) throw new NgError("invalid_argument", "a root cell has no parent to report to");
      assertLive("emitToParent");
      const parent = cells.require(cell.parentId);
      const to = inboxAddr(parent.id);
      const envelope = createEnvelope(
        {
          id: o.id ?? `${runId}:${type}:${++emitCounter}`,
          from: inboxAddr(cellId),
          to,
          principalId,
          kind: o.kind ?? (type === PAYLOAD.cellResult ? "result" : "event"),
          type,
          payload,
          expectedEpoch: parent.epoch,
          ...(o.delivery ? { delivery: o.delivery } : {}),
          ...(o.threads ? { threads: o.threads } : {}),
          ...(o.producerModel ? { producerModel: o.producerModel } : {}),
        },
        clock,
      );
      context.commitSync(cellId, { inboxOut: [{ to, envelope }] });
    },

    async scheduleSelf(draft, rule) {
      assertLive("scheduleSelf");
      const envelope = createEnvelope(
        {
          id: draft.id ?? newId("tmr", clock),
          from: timerFrom(cellId),
          principalId,
          kind: draft.kind ?? "event",
          type: draft.type,
          payload: draft.payload,
          expectedEpoch: self.epoch,
          ...(draft.delivery ? { delivery: draft.delivery } : {}),
          ...(draft.threads ? { threads: draft.threads } : {}),
          ...(draft.producerModel ? { producerModel: draft.producerModel } : {}),
        },
        clock,
      );
      return inbox.enqueueSync(cellId, envelope, rule);
    },

    async controlCell(targetId, cmd) {
      assertLive("controlCell");
      requireDescendant(targetId, "controlCell");
      return inbox.controlSync(targetId, {
        action: cmd.action,
        principalId,
        ...(cmd.steerMessage !== undefined ? { steerMessage: cmd.steerMessage } : {}),
      });
    },

    async handback(envelopeId, reason) {
      assertLive("handback");
      inbox.handbackSync(runId, envelopeId, reason);
    },

    async withdrawApproval(ref, reason) {
      assertLive("withdrawApproval");
      const rec =
        ref.actionId !== undefined ? gate.getApprovalSync(ref.actionId) : ref.subjectKey !== undefined ? gate.findPendingBySubjectSync(ref.subjectKey) : undefined;
      // A cell may take down only what it asked the owner itself.
      if (!rec || rec.cellId !== cellId || rec.status !== "pending") return "not_pending";
      return gate.withdrawSync(rec.actionId, reason);
    },

    async workspaceAccess() {
      assertLive("workspace");
      const port = await acquire();
      const b = liveBounds();
      let tools = TOOL_KINDS.filter((t) => b.tools.has(t));
      // The same refusals checkTool and the read-only drivers apply to the kernel's own workspace tools.
      if (b.isolation === "none" && !core.allowHostWrites) tools = tools.filter((t) => !HOST_MUTATING_TOOLS.has(t));
      if (b.isolation === "shared_ro") tools = tools.filter((t) => t === "read");
      return { root: port.root, isolation: b.isolation, tools };
    },
  };
  return ports;
}
