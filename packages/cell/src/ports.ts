import { renderEnvelope } from "@ng/context";
import { deliveryAllowed } from "@ng/gate";
import {
  get, asClarifyCard, CELL_RESULT_CANDIDATE_KEY,
  cellPrincipal,
  createEnvelope,
  inboxAddr,
  isLeafLifetime,
  newId,
  parseAddress,
  withTx,
  NgError,
  PAYLOAD,
  TOOL_KINDS,
  timerFrom,
  type CancelScope,
  type CellRecord,
  type CellResultCandidate,
  type CellResultPayload,
  type ClaimedBatch,
  type CommitTx,
  type Envelope,
  type ExecResult,
  type PromptSnapshot,
  type RunPorts,
  type RunSelf,
  type ToolKind,
} from "@ng/protocol";
import type { ManagedWorkspacePort } from "@ng/workspace";
import type { KernelCore } from "./core";
import type { RunHandle } from "./dispatcher";
import { inspectCell } from "./inspect";
import { sendCellMessage } from "./messages";
import { ensureCwd } from "./workdir";

export interface RunContext {
  cell: CellRecord;
  batch: ClaimedBatch;
  handle: RunHandle;
  snapshot: PromptSnapshot;
}

/** Lease heartbeat from inside the Run: at most every leaseMs/4 of (possibly manual) clock time. */
const RENEW_FRACTION = 4;

/**
 * RunPorts bound to (cell, epoch, run, principal `cell:<id>`). Ports are the capability boundary — tools are not
 * trusted: every mutating port re-checks that this Run is still the cell's current one, workspace use is limited to
 * the cell's bounds, sends need an allowed
 * target, Context *writes* are pinned to the cell (reads are open across internal cells, docs/05), and cell management
 * is limited to its own descendants plus the few things a cell may change about itself.
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

  function pinned(id: string, what: string): void {
    if (id !== cellId) throw new NgError("invalid_argument", `${what}: a cell may only write its own context (got "${id}", this cell is "${cellId}")`);
  }

  /** docs/05 §5.1.3: any internal cell may *read* another cell's state and artifacts (a desk auditing a worker, a project reading its predecessor). */
  function readable(id: string, what: string): void {
    if (id !== cellId && !cells.get(id)) throw new NgError("not_found", `${what}: no cell "${id}"`);
  }

  function requireDescendant(id: string, what: string): void {
    if (!isDescendant(id)) throw new NgError("bounds_violation", `${what}: "${id}" is not a descendant of this cell`);
  }

  /** Enforcement reads the cell's current bounds, so an owner's narrowing applies to a Run already in flight. */
  const liveBounds = () => cells.get(cellId)?.bounds ?? bounds;
  const mayDeliver = (to: string) => to === inboxAddr(cellId) || deliveryAllowed(liveBounds(), cell.parentId, to);

  // ---------- host working directory ----------

  let acquiring: Promise<ManagedWorkspacePort> | null = null;
  let root = "";

  function acquire(): Promise<ManagedWorkspacePort> {
    acquiring ??= (async () => {
      const port = await core.workspace.acquire(cellId, { cwd: ensureCwd(core, cell) });
      root = port.root;
      // Closed while the workspace was being acquired: nothing was created that would need undoing.
      assertLive("workspace");
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
  }

  const workspace: RunPorts["workspace"] & { writeJobInput(jobId: string, input: string): Promise<void> } = {
    cellId,
    get root() {
      return root;
    },
    async exec(tool: "bash", args: unknown, signal?: AbortSignal): Promise<ExecResult> {
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
      readable(id, "readState");
      return context.readStateSync(id, key);
    },
    async listState(id, prefix) {
      readable(id, "listState");
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
    async searchHistory(id, query, o) {
      pinned(id, "searchHistory");
      return context.searchHistorySync(cellId, query, o);
    },
    async upsertSkillOrNote(id, patch) {
      pinned(id, "upsertSkillOrNote");
      assertLive("upsertSkillOrNote");
      context.upsertSkillOrNoteSync(cellId, patch);
    },
    async getArtifactVersion(id,version) { return context.getArtifactVersionSync(id,version); },
    async getArtifact(artifactId) {
      return context.getArtifactSync(artifactId);
    },
    async listArtifacts(id) {
      readable(id, "listArtifacts");
      return context.listArtifactsSync(id);
    },
  };

  // ---------- the ports ----------

  const ports: RunPorts = {
    self,
    workspace,
    context: ctx,

    async notifyOwner(content, idempotencyKey) {
      assertLive("notifyOwner");
      if (!deliveryAllowed(liveBounds(), cell.parentId, "channel:ui:owner")) throw new NgError("bounds_violation", "此分身不能直接通知主人");
      hub.notifyOwner({ cellId, content, idempotencyKey });
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

    isDirectChild(id) {
      const child = cells.get(id);
      return child?.parentId === cellId && child.status !== "closed";
    },
    async spawnCell(spec, initialPayload) {
      assertLive("spawnCell");
      return core.lifecycle.spawnCell(cellId, spec, initialPayload, { principalId });
    },

    async updateCell(targetId, patch) {
      assertLive("updateCell");
      // Its own watches/schedules/title/meta are the cell's to change (lifecycle refuses anything else on itself).
      if (targetId !== cellId) requireDescendant(targetId, "updateCell");
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

    drainSteer() {
      heartbeat();
      return inbox.drainSteerSync(cellId, runId).map((s) => ({ envelopeId: s.envelope.id, message: s.message, envelope: s.envelope }));
    },

    requeueEnvelopes(envelopeIds, reason) {
      return inbox.requeueClaimedSync(runId, envelopeIds, reason, { countAttempt: false });
    },

    createHumanItem(draft) {
      assertLive("createHumanItem");
      return core.humanItems.create(draft, cellId);
    },

    confirmCliInput(sessionId, throughSeq) {
      assertLive("confirm CLI input");
      handle.cliInput = { sessionId, throughSeq:Math.max(throughSeq, handle.cliInput?.sessionId === sessionId ? handle.cliInput.throughSeq : 0) };
    },

    listEvidence(o) {
      return context.listEvidenceSync(cellId, o);
    },

    canForkSession(parentId,uptoSeq,sessionId,delivered) {
      if (parentId !== self.parentId || context.lastEvidenceSeqSync(parentId) !== uptoSeq || core.dispatcher.running().some(r=>r.cellId===parentId)) return false;
      const current=context.readStateSync<{sessionId:string;lastDeliveredEvidenceSeq?:number}>(parentId,"cli:session");
      return current?.sessionId===sessionId && current.lastDeliveredEvidenceSeq===delivered &&
        !get(core.db,"SELECT 1 FROM evidence WHERE cell_id=? AND seq>? AND seq<=? AND kind IN ('system_note','inbound') LIMIT 1",[parentId,delivered,uptoSeq]);
    },
    listOwnDecisions() {
      return core.gate.listApprovalsSync({cellIds:[cellId]}).map(record => {
        const source = asClarifyCard(record.card.data)?.source.envelopeId;
        const row = source && get<{envelope:string}>(core.db, "SELECT envelope FROM inbox_messages WHERE envelope_id=? ORDER BY (cell_id=?) DESC, seq LIMIT 1", [source,cellId]);
        return {record, ...(row ? {envelope:JSON.parse(row.envelope) as Envelope} : {})};
      });
    },
    async emitToParent(type, payload, o = {}) {
      if (!cell.parentId) throw new NgError("invalid_argument", "a root cell has no parent to report to");
      assertLive("emitToParent");
      if (type === PAYLOAD.cellResult && isLeafLifetime(cell.spec.lifetime)) {
        // docs/05 guard 1: a leaf's result has exactly one sender — the settle transaction. Whatever reaches this port
        // (a code processor, a preset tool) becomes the candidate that transaction delivers; sent from here as well,
        // the parent would get two results, and one of them before the inbox was drained.
        const p = (payload ?? {}) as Partial<CellResultPayload>;
        const candidate: CellResultCandidate = {
          status: p.status ?? "completed",
          summary: typeof p.summary === "string" && p.summary ? p.summary : "Finished without a report.",
          ...(p.artifactId ? { artifactId: p.artifactId } : {}),
          ...(p.data !== undefined ? { data: p.data } : {}),
          at: clock.now(),
        };
        context.commitSync(cellId, { statePatches: { [CELL_RESULT_CANDIDATE_KEY]: candidate } });
        return;
      }
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

    async workspaceAccess() {
      assertLive("workspace");
      const port = await acquire();
      const b = liveBounds();
      const tools = TOOL_KINDS.filter((t) => b.tools.has(t));
      return { root: port.root, isolation: b.isolation, tools };
    },

    // ---------- docs/05 ----------

    async sendToCell(to, message) {
      assertLive("sendToCell");
      const parsed = parseAddress(to);
      if (!parsed || parsed.kind !== "inbox") return { status: "refused", reason: `"${to}" is not an inbox address (inbox:<cellId>)` };
      if (parsed.cellId === cellId) return { status: "refused", reason: "that is this cell's own inbox; use a reminder to wake yourself" };
      if (!deliveryAllowed(liveBounds(), cell.parentId, parsed.addr)) {
        return { status: "refused", reason: `${to} is outside this cell's send permissions` };
      }
      return sendCellMessage(core, {
        from: inboxAddr(cellId),
        principalId,
        sender: cellId,
        toCellId: parsed.cellId,
        id: message.id ?? `${runId}:msg:${++emitCounter}`,
        message,
      });
    },

    drainInbound() {
      heartbeat();
      if (runSignal.aborted) return [];
      const spec = cell.spec;
      // Hubs absorb by design; a leaf absorbs so that a follow-up is answered before its turn is reported as settled.
      if (!spec.absorbInbound && !isLeafLifetime(spec.lifetime)) return [];
      return withTx(core.db, () => {
        const rows = inbox.drainInboundSync(cellId, runId);
        if (rows.length === 0) return [];
        const at = clock.now();
        const batches = rc.snapshot.batch === batch ? [batch] : [batch, rc.snapshot.batch];
        const out = rows.map(({ envelope, seq }) => {
          // In the claim (handback and crash-release cover it), in the batch the tools search, and in the record.
          for (const b of batches) {
            b.envelopes.push(envelope);
            b.seqs.push(seq);
          }
          context.appendEvidenceSync(cellId, { kind: "inbound", envelope, runId, at });
          return { envelope, text: renderEnvelope(envelope) };
        });
        // Real work arrived: whatever started this Run, it now counts as an anchor.
        handle.stallOnly = false;
        return out;
      });
    },

    async registerWait(wait) {
      assertLive("wait");
      core.waits.register({ id: cellId, epoch: self.epoch }, wait, runId);
    },

    async clearWait(waitingFor) {
      assertLive("clear_wait");
      return core.waits.clear(cellId, waitingFor);
    },

    async settleSelf(request) {
      assertLive("settleSelf");
      if (request.action !== "complete" && request.action !== "cancel" && request.action !== "pause") {
        throw new NgError("invalid_argument", `unknown self action "${String(request.action)}"`);
      }
      if (!cell.parentId) throw new NgError("invalid_argument", "a root cell cannot close or park itself");
      if (!request.force) {
        // Dormant workers are not in the way (they are archived with this cell); anything still at work is.
        const open = core.readModel.blockingChildren(cellId);
        if (open.length > 0) {
          // docs/05 §4.2: closing (or pausing) cascades — never pull the plug on work that is still running.
          throw new NgError(
            "conflict",
            `${open.length} child cell(s) are still at work (${open.map((b) => `${b.cell.id}${b.cell.title ? ` "${b.cell.title}"` : ""}: ${b.why}`).join("; ")}). ` +
              `Wait for them (or close the ones that are no longer needed) before you ${request.action === "pause" ? "park" : "finish"}.`,
          );
        }
      }
      handle.selfSettle = { ...request };
    },

    activeWorkspaces() {
      return core.readModel.activeWorkspaces();
    },

    async inspectCell(targetId, o) {
      return inspectCell(core, targetId, o, { inspectorId: cellId });
    },
  };
  return ports;
}
