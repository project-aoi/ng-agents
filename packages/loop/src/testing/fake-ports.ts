import {
  cellPrincipal,
  createEnvelope,
  DEFAULT_RESOURCE_PAGE_CHARS,
  inboxAddr,
  makeBounds,
  NgError,
  spillNotice,
  systemClock,
  TOOL_KINDS,
  type Address,
  type AuthorizeResult,
  type CancelScope,
  type CellInspection,
  type CellMessageDraft,
  type CellSpec,
  type ChildSummary,
  type Clock,
  type CommitResult,
  type CommitTx,
  type ControlAction,
  type DrainedSteerItem,
  type EmitOptions,
  type Envelope,
  type EnvelopeDraft,
  type EvidenceAppendResult,
  type EvidenceEntry,
  type ExecResult,
  type InboxAddr,
  type InspectCellOptions,
  type KnowledgePatch,
  type ModelMessage,
  type ParkedAddition,
  type PolicyBounds,
  type PromptSnapshot,
  type ProposedAction,
  type RunPorts,
  type ScheduleRule,
  type SelfSettleRequest,
  type SendToCellResult,
  type StateEntry,
  type StepOrExternalEvidence,
  type ToolKind,
  type VersionedArtifact,
  type WorkspaceOccupancy,
  type WorkspacePort,
} from "@ng/protocol";


export interface FakeRunOptions {
  cellId?: string;                      // default "cell1"
  epoch?: number;                       // default 1
  runId?: string;                       // default "run_1"
  parentId?: string | null;             // default "desk"
  depth?: number;
  /** Default: every tool kind, may send to `channel:*` and `inbox:*`, maxDepth 2. */
  bounds?: PolicyBounds;
  /** Default `{ processor: { kind: "llm" } }`; `parentId` is filled from `parentId`. */
  spec?: Partial<CellSpec>;
  clock?: Clock;
  system?: string;
  history?: ModelMessage[];
  /** The claimed batch. Strings become `user.message` envelopes from `channel:ui:owner`. */
  batch?: Array<Envelope | string>;
  roster?: ChildSummary[];
  /** Gate stand-in. Explicit decisions defer. */
  authorize?: (action: ProposedAction, opts?: { artifactVersion?: number }) => AuthorizeResult | Promise<AuthorizeResult>;
  exec?: (tool: ToolKind, args: unknown, signal?: AbortSignal) => ExecResult | Promise<ExecResult>;
  /** Spill threshold for tool_result/external text (Context's Inline & Spill). Default 4000 chars. */
  inlineLimit?: number;
  steer?: string[];
  /** Directory the workspace port reports as its root. */
  workspaceRoot?: string;
  /** Tool kinds `workspaceAccess` reports. Default: bounds.tools. */
  workspaceTools?: ToolKind[];
  /**
   * Kernel stand-in for `sendToCell` (cell-to-cell messages). Default: `delivered` (envelopeId = the draft's id, else a
   * generated one; targetStatus active). Every call is recorded in `log.cellMessages` with its result.
   */
  sendToCell?: (to: InboxAddr, message: CellMessageDraft) => SendToCellResult | Promise<SendToCellResult>;
  /**
   * Messages `drainInbound` hands the running Loop (as if they reached the cell mid-Run). More can be queued with
   * `ports.pushInbound`. Strings become `user.message` envelopes from `channel:ui:owner`. Unlike the kernel, the fake
   * absorbs for any cell (the test decides by what it queues).
   */
  inbound?: Array<Envelope | string>;
  /** Kernel stand-in for `settleSelf` (e.g. throw a `conflict` for open children). Default: record the request. */
  settleSelf?: (request: SelfSettleRequest) => void | Promise<void>;
  /** What `activeWorkspaces()` reports. Default []. */
  activeWorkspaces?: WorkspaceOccupancy[];
  /**
   * Kernel stand-in for `inspectCell`: a fixed answer or a function of the call. Default: `fakeInspection(cellId)`.
   * Every call is recorded in `log.inspections` with its result.
   */
  inspectCell?: CellInspection | ((cellId: string, opts: InspectCellOptions | undefined) => CellInspection | Promise<CellInspection>);
}

/** The canned answer of the fake `inspectCell` port. */
export function fakeInspection(cellId: string): CellInspection {
  return {
    cellId,
    title: "fake worker",
    state: "dormant",
    fromSeq: 1,
    toSeq: 3,
    more: false,
    directChats: 0,
    artifactIds: [],
    text: `#1 inbound: do the task\n#2 bash: pnpm test → exit 0\n#3 said: done`,
  };
}

export interface FakeLog {
  evidence: StepOrExternalEvidence[];
  authorizations: Array<{ action: ProposedAction; opts?: { artifactVersion?: number }; result: AuthorizeResult }>;
  notifications: Array<{ content: import("@ng/protocol").Deliverable; idempotencyKey: string }>;
  emitted: Array<{ type: string; payload: unknown; opts?: EmitOptions }>;
  scheduled: Array<{ env: EnvelopeDraft; rule: ScheduleRule }>;
  cancelled: CancelScope[];
  spawned: Array<{ spec: CellSpec; initialPayload: unknown; addr: InboxAddr }>;
  updated: Array<{ cellId: string; patch: Partial<CellSpec> }>;
  closed: Array<{ cellId: string; reason?: "completed" | "cancelled" }>;
  controls: Array<{ cellId: string; action: ControlAction; steerMessage?: string }>;
  commits: CommitTx[];
  inboxOut: NonNullable<CommitTx["inboxOut"]>;
  knowledge: KnowledgePatch[];
  parked: ParkedAddition[];
  execs: Array<{ tool: ToolKind; args: unknown }>;
  jobs: Array<{ jobId: string; command: string; input: string[]; cancelled: boolean }>;
  /** sendToCell calls, with what the (fake) kernel answered. */
  cellMessages: Array<{ to: InboxAddr; message: CellMessageDraft; result: SendToCellResult }>;
  /** Envelopes drainInbound handed to the Loop (each also appended to `snapshot.batch`). */
  drained: Envelope[];
  /** Envelopes requeued by `ports.requeueEnvelopes`. */
  requeued: Array<{ envelopeIds: string[]; reason: string }>;
  /** registerWait calls. */
  waits: Array<{ waitingFor: string; reason: string; timeoutAt?: number }>;
  /** clearWait calls (the party). */
  clearedWaits: string[];
  /** settleSelf requests, in call order (the kernel acts on the last one). */
  settled: SelfSettleRequest[];
  /** inspectCell calls (opts as passed), with what the (fake) kernel answered. */
  inspections: Array<{ cellId: string; opts?: InspectCellOptions; result: CellInspection }>;
}

export interface FakeRunPorts extends RunPorts {
  readonly log: FakeLog;
  readonly state: Map<string, unknown>;
  readonly artifacts: Map<string, VersionedArtifact>;
  readonly resources: Map<string, string>;
  /** Queue steer messages; the Loop picks them up at its next drainSteer(). */
  pushSteer(...messages: string[]): void;
  /** Queue messages that "reach the cell mid-Run"; the Loop picks them up at its next drainInbound(). */
  pushInbound(...messages: Array<Envelope | string>): void;
  /** Open waits as the fake kernel holds them (registerWait upserts per party, clearWait removes). */
  readonly openWaits: Map<string, { reason: string; timeoutAt?: number }>;
  /** Simulate the human saving a new version in the Engage editor. */
  humanEdit(artifactId: string, body: string): VersionedArtifact;
}

export interface FakeRun {
  ports: FakeRunPorts;
  snapshot: PromptSnapshot;
  /** A fresh, not-yet-aborted controller for `loop.run(snapshot, ports, controller.signal)`. */
  controller: AbortController;
}

export function defaultFakeBounds(): PolicyBounds {
  return makeBounds({
    tools: TOOL_KINDS,
    canSendTo: ["channel:*", "inbox:*"] as Address[],
    isolation: "none",
    maxConcurrentChildren: 4,
    maxDepth: 2,
  });
}

/** A user.message envelope as a Channel would deliver it. */
export function userMessage(text: string, opts: { id?: string; from?: Envelope["from"]; principalId?: string; at?: number } = {}): Envelope {
  return createEnvelope(
    {
      ...(opts.id ? { id: opts.id } : {}),
      from: opts.from ?? "channel:ui:owner",
      principalId: opts.principalId ?? "owner",
      kind: "event",
      type: "user.message",
      payload: { text },
      ...(opts.at !== undefined ? { createdAt: opts.at } : {}),
    },
    { now: () => opts.at ?? 0 },
  );
}

/** How the fake renders a batch envelope into the volatile tail (Context's real rendering differs; tests only need stability). */
export function renderEnvelope(env: Envelope): string {
  const p = env.payload as { text?: unknown } | null;
  const body = p && typeof p.text === "string" ? p.text : JSON.stringify(env.payload);
  return `[${env.type} from ${env.from}] ${body}`;
}

/**
 * In-memory RunPorts + a matching PromptSnapshot. Every port call is recorded in `ports.log`; Context behaviour
 * (versioned artifacts with conflicts and parking, Inline & Spill with `modelText`) is imitated closely enough to
 * test Loops, tools and code processors without a database.
 */
export function createFakeRun(opts: FakeRunOptions = {}): FakeRun {
  const clock = opts.clock ?? systemClock;
  const cellId = opts.cellId ?? "cell1";
  const epoch = opts.epoch ?? 1;
  const runId = opts.runId ?? "run_1";
  const parentId = opts.parentId === undefined ? "desk" : opts.parentId;
  const bounds = opts.bounds ?? defaultFakeBounds();
  const spec: CellSpec = { processor: { kind: "llm" }, ...opts.spec, ...(parentId ? { parentId } : {}) };
  const inlineLimit = opts.inlineLimit ?? 4000;

  const log: FakeLog = {
    evidence: [],
    authorizations: [],
    notifications: [],
    emitted: [],
    scheduled: [],
    cancelled: [],
    spawned: [],
    updated: [],
    closed: [],
    controls: [],
    commits: [],
    inboxOut: [],
    knowledge: [],
    parked: [],
    execs: [],
    jobs: [],
    cellMessages: [],
    drained: [],
    requeued: [],
    waits: [],
    clearedWaits: [],
    settled: [],
    inspections: [],
  };
  const state = new Map<string, unknown>();
  const artifacts = new Map<string, VersionedArtifact>();
  const versions = new Map<string,VersionedArtifact>();
  const resources = new Map<string, string>();
  let steerCounter = 0;
  const asSteer = (message: string): DrainedSteerItem => ({ envelopeId: `steer_${++steerCounter}`, message });
  const steerQueue: DrainedSteerItem[] = (opts.steer ?? []).map(asSteer);
  const scheduledIds = new Set<string>();
  let counter = 0;
  const next = (prefix: string) => `${prefix}_${++counter}`;
  let inboundCounter = 0;
  const asInbound = (e: Envelope | string): Envelope =>
    typeof e === "string" ? userMessage(e, { id: `inbound_${++inboundCounter}`, at: clock.now() }) : e;
  const inboundQueue: Envelope[] = (opts.inbound ?? []).map(asInbound);
  const openWaits = new Map<string, { reason: string; timeoutAt?: number }>();

  const defaultAuthorize = (action: ProposedAction, o?: { artifactVersion?: number }): AuthorizeResult => {
    if (action.sideEffect === "external") {
      return {
        type: "defer",
        actionId: next("act"),
        ...(o?.artifactVersion !== undefined ? { boundArtifactVersion: o.artifactVersion } : {}),
        approvalCard: action.card ?? { format: "card", body: action.summary },
      };
    }
    return { type: "allow" };
  };

  function commitSync(tx: CommitTx): CommitResult {
    log.commits.push(tx);
    let artifactVersion: number | undefined;
    if (tx.artifact) {
      const w = tx.artifact;
      const cur = artifacts.get(w.artifactId);
      const ok = cur
        ? w.expectedVersion === cur.version || (w.expectedVersion === undefined && w.updatedBy === "agent" && cur.updatedBy === "agent")
        : w.expectedVersion === undefined || w.expectedVersion === 0;
      if (!ok && cur) {
        if (w.updatedBy === "agent" && cur.updatedBy === "human") {
          log.parked.push({ id: next("park"), artifactId: w.artifactId, basedOnVersion: w.expectedVersion ?? cur.version, content: w.content, createdAt: clock.now(), dismissedAt: null });
        }
        return { ok: false, currentArtifact: cur };
      }
      if (!ok) throw new NgError("conflict", `artifact ${w.artifactId} does not exist (expectedVersion ${w.expectedVersion})`);
      const now = clock.now();
      artifactVersion = (cur?.version ?? 0) + 1;
      artifacts.set(w.artifactId, {
        artifactId: w.artifactId,
        version: artifactVersion,
        content: w.content,
        updatedBy: w.updatedBy,
        cellId,
        createdAt: cur?.createdAt ?? now,
        updatedAt: now,
      });
    }
    if (tx.artifact) versions.set(JSON.stringify([tx.artifact.artifactId,artifactVersion]),artifacts.get(tx.artifact.artifactId)!);
    for (const [k, v] of Object.entries(tx.statePatches ?? {})) {
      if (v === null || v === undefined) state.delete(k);
      else state.set(k, structuredClone(v));
    }
    log.inboxOut.push(...(tx.inboxOut ?? []));
    return artifactVersion === undefined ? { ok: true } : { ok: true, artifactVersion };
  }

  function appendEvidenceSync(record: StepOrExternalEvidence): EvidenceAppendResult {
    log.evidence.push(record);
    const seq = log.evidence.length;
    const text = record.kind === "tool_result" ? record.output : record.kind === "external" ? record.text : undefined;
    if (text === undefined) return { seq };
    if (text.length <= inlineLimit) return { seq, modelText: text };
    const uri = `res://${cellId}/${next("res")}`;
    resources.set(uri, text);
    const head = text.slice(0, inlineLimit);
    return { seq, spill: { uri, totalChars: text.length, inlineChars: head.length }, modelText: head + spillNotice(uri, text.length, head.length) };
  }

  const workspace: WorkspacePort = {
    cellId,
    root: opts.workspaceRoot ?? `/fake/workspaces/${cellId}`,
    async exec(tool, args, signal) {
      log.execs.push({ tool, args });
      if (opts.exec) return opts.exec(tool, args, signal);
      return { output: `${tool} ok`, exitCode: 0 };
    },
    async startJob(s) {
      const jobId = next("job");
      log.jobs.push({ jobId, command: s.command, input: [], cancelled: false });
      return { jobId };
    },
    async observeJob(jobId) {
      const job = log.jobs.find((j) => j.jobId === jobId);
      if (!job) throw new NgError("not_found", `no job ${jobId}`);
      return { state: job.cancelled ? "cancelled" : "running", tail: "" };
    },
    async writeJobInput(jobId, input) {
      log.jobs.find((j) => j.jobId === jobId)?.input.push(input);
    },
    async cancelJob(jobId) {
      const job = log.jobs.find((j) => j.jobId === jobId);
      if (job) job.cancelled = true;
    },
  };

  const listStateSync = (prefix: string): StateEntry[] =>
    [...state.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ cellId, key, value, updatedAt: clock.now() }));

  const ports: FakeRunPorts = {
    log,
    state,
    artifacts,
    resources,
    self: { cellId, epoch, runId, principalId: cellPrincipal(cellId), parentId, depth: opts.depth ?? (parentId ? 1 : 0), bounds, spec },
    workspace,
    async notifyOwner(content, idempotencyKey) {
      log.notifications.push({ content, idempotencyKey });
    },
    context: {
      async readState<T>(_cell: string, key: string) {
        return (state.has(key) ? structuredClone(state.get(key)) : null) as T | null;
      },
      async commit(_cell, tx) {
        return commitSync(tx);
      },
      async appendEvidence(_cell, record) {
        return appendEvidenceSync(record);
      },
      async readResource(_cell, uri, page) {
        let text: string | undefined = resources.get(uri);
        if (text === undefined && uri.startsWith("artifact://")) text = artifacts.get(uri.slice("artifact://".length).split("@")[0]!)?.content.body;
        if (text === undefined) throw new NgError("not_found", `no resource ${uri}`);
        const offset = page?.offset ?? 0;
        return text.slice(offset, offset + (page?.limit ?? DEFAULT_RESOURCE_PAGE_CHARS));
      },
      async searchHistory(_cell, query) {
        const q = query.toLowerCase();
        return log.evidence.flatMap((e, i) => {
          const text = "text" in e ? e.text : e.kind === "tool_result" ? e.output : "";
          return text.toLowerCase().includes(q) ? [{ seq: i + 1, cellId, runId: e.runId, kind: e.kind, text, at: e.at, source: "evidence" as const }] : [];
        });
      },
      async upsertSkillOrNote(_cell, patch) {
        log.knowledge.push(patch);
      },
      async listState(_cell, prefix) {
        return listStateSync(prefix);
      },
      async getArtifactVersion(id,version) { return versions.get(JSON.stringify([id,version])) ?? null; },
      async getArtifact(id) {
        return artifacts.get(id) ?? null;
      },
      async listArtifacts() {
        return [...artifacts.values()];
      },
    },
    async cancelScheduled(scope) {
      log.cancelled.push(scope);
    },
    isDirectChild(id) {
      if (log.closed.some(c => c.cellId === id)) return false;
      return !!opts.roster?.some(c => c.cellId === id && c.parentId === cellId && c.status !== "closed") ||
        log.spawned.some(c => c.addr === `inbox:${id}`);
    },
    async spawnCell(childSpec, initialPayload) {
      const addr = inboxAddr(next("child"));
      // Recorded as written; a spawner may leave the processor to the preset (SpawnSpec).
      log.spawned.push({ spec: childSpec as CellSpec, initialPayload, addr });
      return addr;
    },
    async updateCell(id, patch) {
      log.updated.push({ cellId: id, patch });
    },
    async closeCell(id, reason) {
      log.closed.push({ cellId: id, ...(reason ? { reason } : {}) });
    },
    async authorize(action, o) {
      const result = await (opts.authorize ?? defaultAuthorize)(action, o);
      log.authorizations.push({ action, ...(o ? { opts: o } : {}), result });
      return result;
    },
    drainSteer() {
      return steerQueue.splice(0);
    },
    requeueEnvelopes(envelopeIds, reason) {
      const ids = [...envelopeIds];
      if (ids.length === 0) return 0;
      log.requeued.push({ envelopeIds: ids, reason });
      return ids.length;
    },
    listEvidence(filter) {
      const afterSeq = filter?.afterSeq ?? 0;
      const entries: EvidenceEntry[] = log.evidence
        .map((record, i) => ({ seq: i + 1, cellId, record }))
        .filter((e) => e.seq > afterSeq && (filter?.runId === undefined || e.record.runId === filter.runId));
      return filter?.limit !== undefined ? entries.slice(0, filter.limit) : entries;
    },
    canForkSession(){ return true; },
    listOwnDecisions() { return []; },
    async emitToParent(type, payload, o) {
      if (!parentId) throw new NgError("invalid_argument", `cell ${cellId} has no parent`);
      log.emitted.push({ type, payload, ...(o ? { opts: o } : {}) });
    },
    async scheduleSelf(env, rule) {
      if (env.id && scheduledIds.has(env.id)) return "deduped";
      if (env.id) scheduledIds.add(env.id);
      log.scheduled.push({ env, rule });
      return "accepted";
    },
    async controlCell(id, cmd) {
      log.controls.push({ cellId: id, action: cmd.action, ...(cmd.steerMessage !== undefined ? { steerMessage: cmd.steerMessage } : {}) });
      return { applied: true, epoch: 1 };
    },
    async sendToCell(to, message) {
      const result: SendToCellResult = opts.sendToCell
        ? await opts.sendToCell(to, message)
        : { status: "delivered", envelopeId: message.id ?? next("msg"), targetStatus: "active" };
      log.cellMessages.push({ to, message, result });
      return result;
    },
    drainInbound() {
      const arrived = inboundQueue.splice(0);
      // Like the kernel: the rows join the claimed batch (the tools see them) and are rendered as hydrate would.
      for (const envelope of arrived) {
        snapshot.batch.envelopes.push(envelope);
        snapshot.batch.seqs.push(snapshot.batch.seqs.length + 1);
        log.drained.push(envelope);
      }
      return arrived.map((envelope) => ({ envelope, text: renderEnvelope(envelope) }));
    },
    async registerWait(wait) {
      log.waits.push({ ...wait });
      openWaits.set(wait.waitId ?? wait.refId ?? wait.waitingFor, { reason: wait.reason, ...(wait.timeoutAt !== undefined ? { timeoutAt: wait.timeoutAt } : {}) });
    },
    async clearWait(waitingFor) {
      log.clearedWaits.push(waitingFor);
      return openWaits.delete(waitingFor);
    },
    async settleSelf(request) {
      if (opts.settleSelf) await opts.settleSelf(request);
      log.settled.push({ ...request });
    },
    activeWorkspaces() {
      return opts.activeWorkspaces ?? [];
    },
    async inspectCell(target, o) {
      const answer = opts.inspectCell ?? fakeInspection;
      const result = typeof answer === "function" ? await answer(target, o) : answer;
      log.inspections.push({ cellId: target, ...(o !== undefined ? { opts: o } : {}), result });
      return result;
    },
    openWaits,
    pushInbound(...messages) {
      inboundQueue.push(...messages.map(asInbound));
    },
    pushSteer(...messages) {
      steerQueue.push(...messages.map(asSteer));
    },
    humanEdit(artifactId, body) {
      const cur = artifacts.get(artifactId);
      if (!cur) throw new NgError("not_found", `no artifact ${artifactId}`);
      const r = commitSync({ artifact: { artifactId, content: { ...cur.content, body }, updatedBy: "human", expectedVersion: cur.version } });
      if (!r.ok) throw new Error("unreachable");
      return artifacts.get(artifactId)!;
    },
    async workspaceAccess() {
      return { root: workspace.root, isolation: bounds.isolation, tools: opts.workspaceTools ?? [...bounds.tools] };
    },
  };

  const envelopes = (opts.batch ?? []).map((e, i) => (typeof e === "string" ? userMessage(e, { id: `env_${i + 1}`, at: clock.now() }) : e));
  const rosterText = opts.roster?.length
    ? [{ role: "user" as const, content: [{ type: "text" as const, text: `[children]\n${opts.roster.map((c) => `- ${c.cellId} ${c.title ?? ""} ${c.status}`).join("\n")}` }] }]
    : [];
  const snapshot: PromptSnapshot = {
    cellId,
    epoch,
    runId,
    mode: spec.contextMode ?? "isolated",
    spec,
    bounds,
    batch: {
      claimId: runId,
      cellId,
      epoch,
      workerId: "worker_1",
      envelopes,
      seqs: envelopes.map((_, i) => i + 1),
      claimedAt: clock.now(),
      leaseExpiresAt: clock.now() + 60_000,
    },
    system: { text: opts.system ?? "You are a test cell.", hash: "fake" },
    history: opts.history ?? [],
    historyUptoSeq: 0,
    tail: {
      roster: opts.roster ?? [],
      messages: [...rosterText, ...envelopes.map((e) => ({ role: "user" as const, content: [{ type: "text" as const, text: renderEnvelope(e) }] }))],
    },
    skills: [],
    createdAt: clock.now(),
  };

  return { ports, snapshot, controller: new AbortController() };
}
