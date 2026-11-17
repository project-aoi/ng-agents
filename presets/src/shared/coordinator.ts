import {
  gtdKeys,
  inboxAddr,
  isNgError,
  KERNEL_FROM,
  PAYLOAD,
  subjectKeys,
  type ActionRecord,
  type ApprovalResolvedPayload,
  type ApprovalRevisePayload,
  type CellProgressPayload,
  type CellResultPayload,
  type CellSpec,
  type ChannelSendAction,
  type CodeProcessor,
  type ContextStore,
  type CodeProcessorInput,
  type CustomAction,
  type Envelope,
  type ProjectRecord,
  type ProposedAction,
  type RunOutcome,
  type RunPorts,
  type WaitingSet,
} from "@ng/protocol";
import { cardDeliverable, prep, responseCard, type CardBase } from "./cards";
import { KEYS, ROLES, type PresetsConfig } from "./config";
import { GTD_PAYLOAD, type GtdCommand, type WatchEvent } from "./payloads";
import { childCellId, EDITOR_PROCESSOR, type GroupPlan, type ItemPlan } from "./plan";
import { clip, keyOf, newAction, newProject, patchAction, patchProject, statusLine } from "./records";

// The item/project root: a zero-token coordinator (docs/03 §四 "④ Loop(code) 零 Token 精确汇合"). It owns the
// item's records (gtd:project + one gtd:action per group) and keeps them current from its children's reports;
// it raises at most one card at a time for the whole item (subject = project:<rootId>).

type SlotStatus = "running" | "done" | "failed" | "cancelled";

interface SlotState {
  cellId: string;
  groupId: string;
  label: string;
  status: SlotStatus;
  summary?: string;
  artifactId?: string;
  at?: number;
  /** Closed from outside (the owner settled it offline) rather than reported. */
  offline?: boolean;
  /** watcher slots */
  partyId?: string;
  dueAt?: number;
  overdue?: boolean;
}

type GroupStatus = "open" | "collected" | "delivered" | "cancelled";

type CardRequest = { type: "result"; groupId: string } | { type: "nudge"; slot: string };

type ActiveCard =
  | { type: "result"; groupId: string; actionId: string; artifactId: string; action: ProposedAction }
  | { type: "nudge"; slot: string };

export interface CoordinatorState {
  v: 1;
  plan: ItemPlan;
  slots: Record<string, SlotState>;
  groups: Record<string, { status: GroupStatus }>;
  queue: CardRequest[];
  active: ActiveCard | null;
  editor: { cellId: string; n: number } | null;
  editors: number;
  finished: null | "completed" | "cancelled";
  /** Envelope ids already applied (a retried batch must not count a result twice). */
  seen: string[];
}

const SEEN_CAP = 500;

/** Readable by the desk (steer/stop) and the app: the coordinator's private bookkeeping of one item. */
export async function readCoordinator(ports: RunPorts, rootId: string): Promise<CoordinatorState | null> {
  return ports.context.readState<CoordinatorState>(rootId, KEYS.coordinator);
}

/**
 * True while an action of this item hands the ball to the owner only through a Clarify card (its result or a nudge is
 * on a card, or queued for the item's one card slot): the owner's part is that card, not a to-do of its own.
 */
export function awaitsCard(st: CoordinatorState | null, actionId: string): boolean {
  if (!st || st.finished) return false;
  const groupOfSlot = (slot: string) => st.slots[slot]?.groupId;
  const about = (c: CardRequest | ActiveCard) => (c.type === "result" ? c.groupId : groupOfSlot(c.slot));
  return (st.active !== null && about(st.active) === actionId) || st.queue.some((q) => about(q) === actionId);
}

/**
 * For the app's synchronous endpoints: the owner changed an item's records or cards without its cells being woken
 * (checked off its last open action in Engage; dismissed or took over its result or nudge card, which the kernel only
 * tells the owning cell silently). Wakes the item root or watcher so it applies that now — completing the item when
 * nothing is left, or setting a watcher's next check. In the caller's transaction; false when the cell is neither.
 */
export function syncItemAfterOwnerChangeSync(
  context: Pick<ContextStore, "readStateSync" | "commitSync">,
  cellId: string,
  opts: { principalId: string; now: number; id: string },
): boolean {
  const root = context.readStateSync<CoordinatorState>(cellId, KEYS.coordinator);
  const watcher = root ? null : context.readStateSync<{ status?: string }>(cellId, KEYS.watcher);
  if (root ? root.finished !== null : !watcher || watcher.status === "replied") return false;
  const to = inboxAddr(cellId);
  const cmd: GtdCommand = { command: "sync" };
  context.commitSync(cellId, {
    inboxOut: [{ to, envelope: { id: opts.id, from: KERNEL_FROM.router, to, principalId: opts.principalId, kind: "event", type: GTD_PAYLOAD.command, payload: cmd, createdAt: opts.now } }],
  });
  return true;
}

export function createCoordinator(cfg: PresetsConfig, name: string, defaultJoin: "all" | "any"): CodeProcessor {
  return {
    name,
    description: `Item/project root: spawns its children, joins their results (${defaultJoin}) with zero tokens, keeps gtd:project and gtd:action current, raises one card at a time.`,
    run: (input) => new Coordinator(cfg, input, defaultJoin).run(),
  };
}

class Coordinator {
  readonly #cfg: PresetsConfig;
  readonly #in: CodeProcessorInput;
  readonly #ports: RunPorts;
  readonly #self: string;
  readonly #now: number;
  readonly #defaultJoin: "all" | "any";
  #st: CoordinatorState | null = null;
  #project: ProjectRecord | null = null;
  #actions = new Map<string, ActionRecord>();
  #dirty = new Set<string>();
  #outcome: RunOutcome = "completed";
  /** The item's final report, sent only after its records are committed (the parent closes the root on receipt). */
  #finished: CellResultPayload | null = null;

  constructor(cfg: PresetsConfig, input: CodeProcessorInput, defaultJoin: "all" | "any") {
    this.#cfg = cfg;
    this.#in = input;
    this.#ports = input.ports;
    this.#self = input.ports.self.cellId;
    this.#now = input.clock.now();
    this.#defaultJoin = defaultJoin;
  }

  async run(): Promise<RunOutcome> {
    const ctx = this.#ports.context;
    this.#st = await ctx.readState<CoordinatorState>(this.#self, KEYS.coordinator);
    this.#project = await ctx.readState<ProjectRecord>(this.#self, gtdKeys.project);
    for (const e of await ctx.listState(this.#self, gtdKeys.actionPrefix)) {
      const a = e.value as ActionRecord;
      this.#actions.set(a.id, a);
    }

    for (const env of this.#in.snapshot.batch.envelopes) {
      if (this.#st?.seen.includes(env.id)) continue;
      await this.#apply(env);
      if (this.#st) this.#st.seen = [...this.#st.seen, env.id].slice(-SEEN_CAP);
    }
    if (!this.#st) return "completed";

    if (!this.#st.finished) {
      await this.#collectGroups();
      await this.#pumpCards();
      await this.#finishIfDone();
    }
    await this.#save();
    if (this.#finished) await this.#ports.emitToParent(PAYLOAD.cellResult, this.#finished, { id: `${this.#self}:finished` });
    return this.#outcome;
  }

  // ---------- envelopes ----------

  async #apply(env: Envelope): Promise<void> {
    if (env.type === PAYLOAD.cellTask) {
      if (!this.#st) await this.#init(env);
      return;
    }
    const st = this.#st;
    if (!st || st.finished) return;
    switch (env.type) {
      case PAYLOAD.cellResult:
        return this.#onResult(env.payload as CellResultPayload);
      case PAYLOAD.cellProgress:
        return this.#onProgress(env.payload as CellProgressPayload);
      case GTD_PAYLOAD.watch:
        return this.#onWatch(env.payload as WatchEvent);
      case PAYLOAD.approvalResolved:
        return this.#onResolved(env.payload as ApprovalResolvedPayload & { decision?: string });
      case PAYLOAD.approvalRevise:
        return this.#onRevise(env.payload as ApprovalRevisePayload);
      case GTD_PAYLOAD.command: {
        const cmd = env.payload as GtdCommand;
        if (cmd.command === "stop") await this.#stop(cmd.reason);
        return;
      }
      default:
        return;
    }
  }

  async #init(env: Envelope): Promise<void> {
    const plan = (env.payload as { input?: ItemPlan }).input;
    if (!plan || !Array.isArray(plan.groups)) throw new Error("coordinator: cell.task carries no ItemPlan in input");
    const now = this.#now;
    const st: CoordinatorState = { v: 1, plan, slots: {}, groups: {}, queue: [], active: null, editor: null, editors: 0, finished: null, seen: [] };
    this.#project = newProject({ title: plan.item.title, ...(plan.item.outcome ? { outcome: plan.item.outcome } : {}), source: plan.item.source }, now);
    this.#dirty.add(gtdKeys.project);

    for (const g of plan.groups) {
      st.groups[g.id] = { status: "open" };
      for (const c of g.children) {
        const cellId = childCellId(this.#self, c.slot);
        st.slots[c.slot] = {
          cellId,
          groupId: g.id,
          label: c.label,
          status: "running",
          ...(c.party ? { partyId: c.party.id, ...(c.party.dueAt !== undefined ? { dueAt: c.party.dueAt } : {}) } : {}),
        };
      }
      this.#setAction(newAction(this.#groupAction(g, st), now));
    }
    this.#st = st;
    // Spawned after the records are prepared; fixed ids make a retried first Run skip children that already exist.
    for (const g of plan.groups) {
      for (const c of g.children) {
        try {
          await this.#ports.spawnCell({ ...c.spec, id: childCellId(this.#self, c.slot) }, c.payload);
        } catch (err) {
          if (!isNgError(err, "duplicate")) throw err;
        }
      }
    }
  }

  #groupAction(g: GroupPlan, st: CoordinatorState): Omit<ActionRecord, "status" | "createdAt" | "updatedAt"> {
    const plan = st.plan;
    const n = g.children.length;
    const base: Omit<ActionRecord, "status" | "createdAt" | "updatedAt"> = {
      id: g.id,
      title: g.title,
      owner: g.owner,
      projectCellId: this.#self,
      source: plan.item.source,
      ...(g.effort ? { effort: g.effort } : {}),
      ...(g.nextStep ? { nextStep: g.nextStep } : {}),
    };
    if (g.waiting && n > 0) {
      base.waiting = this.#waitingSet(g, st);
      base.progress = { done: 0, total: n, label: "已回" };
      if (g.waiting.dueAt !== undefined) base.dueAt = g.waiting.dueAt;
    } else if (g.waiting) {
      base.waiting = { description: g.waiting.description, parties: [], join: g.join };
    } else if (n > 1) {
      base.progress = { done: 0, total: n, label: g.label ?? g.title };
    }
    return base;
  }

  #waitingSet(g: GroupPlan, st: CoordinatorState): WaitingSet {
    const parties = g.children.map((c) => {
      const s = st.slots[c.slot];
      const p = c.party!;
      return {
        id: p.id,
        label: p.label,
        replied: s?.status === "done",
        ...(s?.status === "done" && s.at !== undefined ? { repliedAt: s.at } : {}),
        ...((s?.dueAt ?? p.dueAt) !== undefined ? { dueAt: s?.dueAt ?? p.dueAt } : {}),
      };
    });
    return {
      description: g.waiting!.description,
      parties,
      join: g.join,
      ...(g.waiting!.dueAt !== undefined ? { dueAt: g.waiting!.dueAt } : {}),
      cancelGroup: "timeout",
    };
  }

  #slotOfCell(cellId: string): [string, SlotState] | undefined {
    for (const [slot, s] of Object.entries(this.#st!.slots)) if (s.cellId === cellId) return [slot, s];
    return undefined;
  }

  async #onResult(p: CellResultPayload): Promise<void> {
    const st = this.#st!;
    if (st.editor && p.childCellId === st.editor.cellId) return this.#onEditorResult(p);
    const hit = this.#slotOfCell(p.childCellId);
    // Unknown child, or a slot that already reported: a duplicate or a late arrival changes nothing.
    if (!hit || hit[1].status !== "running") return;
    const [slot, s] = hit;
    const data = p.data as { synthetic?: boolean; gtd?: { at?: unknown; reply?: unknown } } | undefined;
    const synthetic = data?.synthetic === true;
    s.status = p.status === "completed" ? "done" : p.status === "cancelled" ? "cancelled" : "failed";
    s.summary = synthetic && p.status === "completed" ? "已标记为线下解决" : typeof data?.gtd?.reply === "string" ? data.gtd.reply : p.summary;
    if (synthetic) s.offline = true;
    s.at = typeof data?.gtd?.at === "number" ? data.gtd.at : this.#now;
    if (p.artifactId) s.artifactId = p.artifactId;
    s.overdue = false;
    st.queue = st.queue.filter((q) => !(q.type === "nudge" && q.slot === slot));
    if (st.active?.type === "nudge" && st.active.slot === slot) st.active = null; // closing the watcher withdraws its card
    await this.#closeChild(s.cellId, "completed");
    this.#refreshGroup(s.groupId);
  }

  #onProgress(p: CellProgressPayload): void {
    const hit = this.#slotOfCell(p.childCellId);
    if (!hit || hit[1].status !== "running") return;
    const g = this.#group(hit[1].groupId);
    const a = this.#actions.get(g.id);
    // A lone worker's own progress ("第 1 轮") is the action's progress; a fan-out counts children instead.
    if (a && a.status === "open" && g.children.length === 1 && p.progress) this.#setAction(patchAction(a, { progress: p.progress }, this.#now));
  }

  #onWatch(e: WatchEvent): void {
    const st = this.#st!;
    const s = st.slots[e.slot];
    if (!s || s.status !== "running") return;
    s.dueAt = e.dueAt;
    if (e.event === "overdue") {
      s.overdue = true;
      const queued = st.queue.some((q) => q.type === "nudge" && q.slot === e.slot) || (st.active?.type === "nudge" && st.active.slot === e.slot);
      if (!queued) st.queue.push({ type: "nudge", slot: e.slot });
    } else {
      s.overdue = false;
      if (st.active?.type === "nudge" && st.active.slot === e.slot) st.active = null;
    }
    this.#refreshGroup(s.groupId);
  }

  async #onResolved(p: ApprovalResolvedPayload & { decision?: string }): Promise<void> {
    const st = this.#st!;
    const active = st.active;
    if (active?.type !== "result" || active.actionId !== p.actionId) return;
    // failed / unknown: the card keeps showing the real outcome; nothing is resent automatically.
    if (p.status === "failed" || p.status === "unknown" || p.status === "pending" || p.status === "superseded") return;
    st.active = null;
    st.groups[active.groupId]!.status = "delivered";
    const a = this.#actions.get(active.groupId);
    if (a?.status === "open") this.#setAction(patchAction(a, { status: "done", nextStep: null }, this.#now));
  }

  async #onRevise(p: ApprovalRevisePayload): Promise<void> {
    const st = this.#st!;
    const active = st.active;
    if (active?.type !== "result" || active.actionId !== p.actionId) return;
    const art = await this.#ports.context.getArtifact(active.artifactId);
    if (!art) return;
    if (st.editor) await this.#closeChild(st.editor.cellId, "cancelled");
    st.editors += 1;
    const id = childCellId(this.#self, `edit${st.editors}`);
    const spec: CellSpec = { id, preset: "inline", title: "按意见改稿", processor: EDITOR_PROCESSOR, meta: { role: ROLES.editor } };
    await this.#ports.spawnCell(spec, {
      instruction: "按主人的口述意见改写这份草稿，改好后用 submit_draft 交回全文。",
      input: { feedback: p.instruction, draft: art.content.body, title: art.content.title ?? st.plan.item.title, request: st.plan.item.rawInput.text },
    });
    st.editor = { cellId: id, n: st.editors };
  }

  async #onEditorResult(p: CellResultPayload): Promise<void> {
    const st = this.#st!;
    const editorId = st.editor!.cellId;
    st.editor = null;
    await this.#closeChild(editorId, "completed");
    const text = (p.data as { draft?: unknown } | undefined)?.draft;
    const active = st.active;
    if (typeof text !== "string" || !text.trim() || active?.type !== "result") return;
    const cur = await this.#ports.context.getArtifact(active.artifactId);
    if (!cur) return;
    const content = { ...cur.content, body: text };
    const r = await this.#ports.context.commit(this.#self, { artifact: { artifactId: active.artifactId, content, updatedBy: "agent", expectedVersion: cur.version } });
    if (!r.ok) return; // the owner saved meanwhile: their text stands, ours was parked beside it
    // Same subject, same cell, same action → Gate updates the card in place, bound to the new version.
    await this.#raiseResultCard(active.groupId, active.artifactId, r.artifactVersion ?? cur.version + 1);
  }

  async #stop(reason?: string): Promise<void> {
    const st = this.#st!;
    for (const s of Object.values(st.slots)) {
      if (s.status !== "running") continue;
      s.status = "cancelled";
      s.at = this.#now;
      await this.#closeChild(s.cellId, "cancelled");
    }
    if (st.editor) await this.#closeChild(st.editor.cellId, "cancelled");
    st.editor = null;
    if (st.active?.type === "result") await this.#ports.withdrawApproval?.({ actionId: st.active.actionId }, reason ?? "已停止");
    st.active = null;
    st.queue = [];
    for (const g of Object.keys(st.groups)) st.groups[g]!.status = "cancelled";
    for (const a of this.#actions.values()) if (a.status === "open") this.#setAction(patchAction(a, { status: "cancelled" }, this.#now));
    await this.#finish("cancelled", reason);
  }

  // ---------- groups and cards ----------

  #group(id: string): GroupPlan {
    return this.#st!.plan.groups.find((g) => g.id === id)!;
  }

  #slotsOf(groupId: string): Array<[string, SlotState]> {
    return Object.entries(this.#st!.slots).filter(([, s]) => s.groupId === groupId);
  }

  /** Re-derive the group's action (progress, waiting set, ball owner) from its slots. */
  #refreshGroup(groupId: string): void {
    const st = this.#st!;
    const g = this.#group(groupId);
    const a = this.#actions.get(groupId);
    if (!a || a.status !== "open" || g.children.length === 0) return;
    const slots = this.#slotsOf(groupId);
    const finished = slots.filter(([, s]) => s.status !== "running").length;
    const nudging = st.active?.type === "nudge" && this.#st!.slots[st.active.slot]?.groupId === groupId ? st.slots[st.active.slot] : undefined;
    const patch: Parameters<typeof patchAction>[1] = {};
    if (g.waiting) {
      patch.waiting = this.#waitingSet(g, st);
      patch.progress = { done: slots.filter(([, s]) => s.status === "done").length, total: slots.length, label: "已回" };
    } else if (g.children.length > 1) {
      patch.progress = { done: finished, total: slots.length, label: g.label ?? g.title };
    }
    if (st.groups[groupId]!.status === "open") {
      // While a nudge card waits for the owner, the ball is with the owner; otherwise with whoever was asked.
      patch.owner = nudging ? "human" : g.owner;
      patch.nextStep = nudging ? `在待确认里决定是否催问${nudging.label}` : (g.nextStep ?? null);
    }
    this.#setAction(patchAction(a, patch, this.#now));
  }

  async #collectGroups(): Promise<void> {
    const st = this.#st!;
    for (const g of st.plan.groups) {
      if (st.groups[g.id]!.status !== "open" || g.children.length === 0) continue;
      const slots = this.#slotsOf(g.id);
      const join = g.join ?? this.#defaultJoin;
      const done = slots.filter(([, s]) => s.status === "done");
      const complete = join === "any" ? done.length > 0 || slots.every(([, s]) => s.status !== "running") : slots.every(([, s]) => s.status !== "running");
      if (!complete) continue;
      for (const [, s] of slots) {
        if (s.status !== "running") continue;
        s.status = "cancelled";
        await this.#closeChild(s.cellId, "cancelled");
      }
      st.groups[g.id]!.status = "collected";
      st.queue = st.queue.filter((q) => !(q.type === "nudge" && st.slots[q.slot]?.groupId === g.id));
      this.#refreshGroup(g.id);
      const a = this.#actions.get(g.id);
      // Nothing to show when the owner settled every part offline themselves ("✓ 线下已解决，直接完结").
      const reported = slots.some(([, s]) => s.status !== "cancelled" && !s.offline);
      if (g.card && reported) {
        st.queue.push({ type: "result", groupId: g.id });
        if (a?.status === "open") this.#setAction(patchAction(a, { owner: "human", nextStep: "在待确认里查看结果并确认", effort: a.effort ?? "15m" }, this.#now));
      } else {
        st.groups[g.id]!.status = "delivered";
        if (a?.status === "open") this.#setAction(patchAction(a, { status: "done" }, this.#now));
      }
    }
  }

  async #pumpCards(): Promise<void> {
    const st = this.#st!;
    while (!st.active && st.queue.length > 0) {
      const next = st.queue.shift()!;
      if (next.type === "nudge") {
        const s = st.slots[next.slot];
        if (!s || s.status !== "running" || !s.overdue) continue;
        st.active = { type: "nudge", slot: next.slot };
        const g = this.#group(s.groupId);
        const cmd: GtdCommand = { command: "raise_nudge", waiting: this.#waitingSet(g, st), itemTitle: st.plan.item.title, source: st.plan.item.source, rawInput: st.plan.item.rawInput };
        await this.#send(s.cellId, GTD_PAYLOAD.command, cmd, `${this.#self}:nudge:${next.slot}:${this.#now}`);
        this.#refreshGroup(s.groupId);
      } else {
        await this.#raiseResultCard(next.groupId);
      }
    }
  }

  /** The group's one result card: a summary draft bound to the action (send it back to the requester, or accept it). */
  async #raiseResultCard(groupId: string, artifactId?: string, version?: number): Promise<void> {
    const st = this.#st!;
    const g = this.#group(groupId);
    const item = st.plan.item;
    const slots = this.#slotsOf(groupId).map(([, s]) => s);
    const ok = slots.filter((s) => s.status === "done");
    const failed = slots.filter((s) => s.status === "failed");
    const n = slots.length;

    let draftId = artifactId;
    let draftVersion = version;
    if (!draftId) {
      draftId = `${this.#self}-result-${g.id}`;
      const body = this.#summaryBody(g, slots);
      const title = this.#resultTitle(g, ok.length, n);
      const existing = await this.#ports.context.getArtifact(draftId);
      const r = await this.#ports.context.commit(this.#self, {
        artifact: { artifactId: draftId, content: { format: "markdown", title, body }, updatedBy: "agent", ...(existing ? { expectedVersion: existing.version } : {}) },
      });
      draftVersion = r.ok ? (r.artifactVersion ?? 1) : (existing?.version ?? 1);
    }
    const art = await this.#ports.context.getArtifact(draftId);
    if (!art) return;
    draftVersion ??= art.version;
    const title = art.content.title ?? this.#resultTitle(g, ok.length, n);
    const subjectKey = subjectKeys.project(this.#self);
    const checked = slots.filter((s) => s.artifactId).map((s) => ({ label: s.label, uri: `artifact://${s.artifactId}` }));
    const base: CardBase = {
      subjectKey,
      title,
      source: item.source,
      rawInput: item.rawInput,
      prep: prep(n > 1 ? `已汇总 ${n} 份结果${failed.length ? `（${failed.length} 份未完成）` : ""}` : clip(ok[0]?.summary ?? failed[0]?.summary ?? "", 300), checked),
    };
    const draft = { artifactId: draftId, version: draftVersion };
    let action: ChannelSendAction | CustomAction;
    if (item.replyTo) {
      const card = responseCard(base, draft, { target: item.replyTo, targetLabel: item.replyLabel ?? item.replyTo }, "send");
      action = {
        type: "channel.send",
        target: item.replyTo,
        content: art.content,
        artifactId: draftId,
        summary: title,
        subjectKey,
        sideEffect: "external",
        card: cardDeliverable(card, art.content.body),
      };
    } else {
      const card = responseCard(base, draft, { target: this.#cfg.ownerAddress, targetLabel: "我" }, "accept");
      action = {
        type: "custom",
        name: "gtd.accept_result",
        args: { rootId: this.#self, groupId },
        artifactId: draftId,
        summary: title,
        subjectKey,
        // Nothing leaves the system, but accepting a background result is the owner's call: it must become a card.
        sideEffect: "external",
        card: cardDeliverable(card, art.content.body),
      };
    }
    const r = await this.#ports.authorize(action, { artifactVersion: draftVersion });
    if (r.type === "defer") {
      const { card: _card, ...stored } = action;
      st.active = { type: "result", groupId, actionId: r.actionId, artifactId: draftId, action: stored as ProposedAction };
      this.#outcome = "deferred_for_approval";
    } else {
      // A standing rule allowed it (or it was refused): nothing waits on the owner.
      st.groups[groupId]!.status = "delivered";
      const a = this.#actions.get(groupId);
      if (a?.status === "open") this.#setAction(patchAction(a, { status: "done", nextStep: null }, this.#now));
    }
  }

  #resultTitle(g: GroupPlan, ok: number, n: number): string {
    if (g.waiting) return `${g.waiting.description}：已回 ${ok}/${n}`;
    if (n > 1) return `${g.title}：结果已齐 ${ok}/${n}`;
    return `${g.title}：已完成`;
  }

  #summaryBody(g: GroupPlan, slots: SlotState[]): string {
    const st = this.#st!;
    if (slots.length === 1 && !g.waiting) {
      const s = slots[0]!;
      return s.status === "done" ? (s.summary ?? "") : `未完成：${s.summary ?? ""}`;
    }
    const lines = [`# ${g.waiting?.description ?? g.title}`, ""];
    if (st.plan.item.outcome) lines.push(`目标：${st.plan.item.outcome}`, "");
    for (const s of slots) {
      const mark = s.status === "done" ? "" : s.status === "failed" ? "（未完成）" : "（已停止）";
      lines.push(`- **${s.label}**${mark}：${(s.summary ?? "").replace(/\s*\n\s*/g, " ")}`);
    }
    return lines.join("\n");
  }

  async #finishIfDone(): Promise<void> {
    const st = this.#st!;
    if (st.active || st.queue.length > 0 || st.editor) return;
    if (Object.values(st.slots).some((s) => s.status === "running")) return;
    if ([...this.#actions.values()].some((a) => a.status === "open")) return;
    await this.#finish("completed");
  }

  async #finish(lifecycle: "completed" | "cancelled", reason?: string): Promise<void> {
    const st = this.#st!;
    st.finished = lifecycle;
    if (this.#project) {
      this.#project = patchProject(this.#project, { lifecycle }, this.#now);
      this.#dirty.add(gtdKeys.project);
    }
    const title = st.plan.item.title;
    const summary = lifecycle === "completed" ? `「${title}」已完成` : `「${title}」已停止${reason ? `：${reason}` : ""}`;
    this.#finished = {
      childCellId: this.#self,
      status: lifecycle === "cancelled" ? "cancelled" : "completed",
      summary,
      data: { gtd: { finished: true, lifecycle } },
    };
  }

  // ---------- effects ----------

  async #closeChild(cellId: string, reason: "completed" | "cancelled"): Promise<void> {
    try {
      await this.#ports.closeCell(cellId, reason);
    } catch (err) {
      if (!isNgError(err, "not_found")) throw err;
    }
  }

  async #send(cellId: string, type: string, payload: unknown, id: string): Promise<void> {
    const to = inboxAddr(cellId);
    await this.#ports.context.commit(this.#self, {
      inboxOut: [{ to, envelope: { id, from: inboxAddr(this.#self), to, principalId: this.#ports.self.principalId, kind: "event", type, payload, createdAt: this.#now } }],
    });
  }

  #setAction(a: ActionRecord): void {
    this.#actions.set(a.id, a);
    this.#dirty.add(gtdKeys.action(a.id));
  }

  #statusText(): { text: string; progress?: { done: number; total: number; label?: string } } {
    const st = this.#st!;
    if (st.finished) return { text: st.finished === "completed" ? "已完成" : "已停止" };
    if (st.active?.type === "result") return { text: `等主人确认：${st.plan.item.title}` };
    const open = [...this.#actions.values()].filter((a) => a.status === "open");
    const a = open.find((x) => x.owner === "human") ?? open.find((x) => x.owner === "agent") ?? open[0];
    if (!a) return { text: st.plan.item.title };
    if (a.waiting && a.waiting.parties.length) {
      const k = a.waiting.parties.filter((p) => p.replied).length;
      return { text: `${a.waiting.description} 已回 ${k}/${a.waiting.parties.length}`, ...(a.progress ? { progress: a.progress } : {}) };
    }
    return { text: a.progress ? `${a.progress.label ?? a.title}` : a.title, ...(a.progress ? { progress: a.progress } : {}) };
  }

  async #save(): Promise<void> {
    const patches: Record<string, unknown> = { [KEYS.coordinator]: this.#st };
    for (const key of this.#dirty) {
      if (key === gtdKeys.project) patches[key] = this.#project;
      else patches[key] = this.#actions.get(key.slice(gtdKeys.actionPrefix.length));
    }
    const s = this.#statusText();
    patches[keyOf.status] = statusLine(s.text, this.#now, s.progress);
    await this.#ports.context.commit(this.#self, { statePatches: patches });
  }
}
