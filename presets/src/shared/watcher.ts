import { z } from "zod";
import {
  CELL_RESULT_CANDIDATE_KEY,
  defineTool,
  isEnvelopeOfType,
  PAYLOAD,
  projectCellIdOf,
  subjectKeys,
  type ApprovalResolvedPayload,
  type CellProgressPayload,
  type CellResultCandidate,
  type CellSpec,
  type ChannelAddr,
  type ChannelSendAction,
  type CodeProcessor,
  type CustomAction,
  type EscalationCard,
  type Envelope,
  type ItemSource,
  type RunOutcome,
  type RunPorts,
  type TimerFiredPayload,
  type ToolContext,
  type Toolset,
  type UserMessagePayload,
  type WaitingSet,
} from "@ng/protocol";
import { cardDeliverable, nudgeCard, prep } from "./cards";
import { KEYS, PROCESSORS, ROLES, TOOLSETS, type PresetsConfig } from "./config";
import { REPLY_WATCHER_LLM_PROCESSOR, toolKinds, WAIT_MATCH_PROCESSOR } from "./processors";
import { clip, formatWhen, type RawInput } from "./records";

// The reply watcher (await_reply): waits for one party's reply on the project's behalf. Persistent until the reply
// arrives; then it hands the kernel its result (a CellResultCandidate) and closes itself, so the project receives one
// plain `cell.result` ("<who>已回复：<gist>"). A timeout drafts a nudge and puts it on the owner's card itself (the
// project's one card slot is Gate's rule: subject project:<id>); deadlines that move are reported as silent
// `cell.progress` notes the project reads at its next turn.

/** The one party a reply watcher waits for. */
export interface ReplyParty {
  id: string;
  /** As the owner names them, e.g. "供应商 C". */
  label: string;
  /** Where a nudge goes. */
  to?: ChannelAddr;
  /** Watched thread ("<channelId>:<threadId>"): their reply there reaches the watcher directly. */
  thread?: string;
  /** Only this sender counts as their reply. */
  principalId?: string;
  dueAt?: number;
}

/** `spec.meta.gtd` of a reply watcher. */
export interface ReplyWatchMeta {
  party: ReplyParty;
  description: string;
  itemTitle: string;
  nudgeText?: string;
  /** The project's action this wait is recorded under. */
  actionId?: string;
  source?: ItemSource;
  rawInput?: RawInput;
}

/** `data.gtd` of what a reply watcher reports: the reply (cell.result) or a moved deadline (cell.progress). */
export interface ReplyWatchReport {
  kind: "reply" | "reply_wait";
  partyId: string;
  event?: "overdue" | "nudged" | "extended" | "nudge_closed";
  dueAt?: number;
  reply?: string;
  from?: string;
  at?: number;
}

export interface WatcherState {
  v: 1;
  status: "waiting" | "overdue" | "replied";
  dueAt?: number;
  nudges: number;
  nudgeArtifactId?: string;
  cardActionId?: string;
  reply?: { text: string; at: number; from: string };
  timers: number;
  seen: string[];
}

export function replyWatcherSpec(party: ReplyParty, o: Omit<ReplyWatchMeta, "party"> & { interpret?: boolean }): CellSpec {
  const { interpret, ...meta } = o;
  const spec: CellSpec = {
    preset: "watcher",
    title: `等待${party.label}回复`,
    processor: interpret ? REPLY_WATCHER_LLM_PROCESSOR : WAIT_MATCH_PROCESSOR,
    // It lives until the reply comes (or the owner settles it); it never touches a directory.
    lifetime: "persistent",
    bounds: { tools: toolKinds(), canSendTo: party.to ? [party.to] : [] },
    meta: { role: ROLES.watcher, gtd: { party, ...meta } satisfies ReplyWatchMeta },
  };
  const filter = { ...(party.thread ? { thread: party.thread } : {}), ...(party.principalId ? { principalId: party.principalId } : {}) };
  if (Object.keys(filter).length > 0) spec.watches = [{ threadOrFilter: filter, cancelGroup: "reply" }];
  if (party.dueAt !== undefined) spec.schedules = [{ deliverAt: party.dueAt, cancelGroup: "timeout" }];
  return spec;
}

function metaOf(ports: RunPorts): ReplyWatchMeta {
  const m = ports.self.spec.meta?.["gtd"] as ReplyWatchMeta | undefined;
  if (!m?.party?.id) throw new Error("reply watcher: spec.meta.gtd { party, description } is missing");
  return m;
}

const isTimeout = (env: Envelope) =>
  isEnvelopeOfType(env, "timer.fired") &&
  ((env.payload.data as { gtd?: unknown } | undefined)?.gtd === "timeout" || env.payload.label.startsWith("schedule:"));

class WatcherCore {
  readonly meta: ReplyWatchMeta;
  st!: WatcherState;
  outcome: RunOutcome = "completed";
  #candidate: CellResultCandidate | null = null;

  constructor(
    readonly cfg: PresetsConfig,
    readonly ports: RunPorts,
    readonly now: number,
  ) {
    this.meta = metaOf(ports);
  }

  get self(): string {
    return this.ports.self.cellId;
  }

  async load(): Promise<void> {
    const st = await this.ports.context.readState<WatcherState>(this.self, KEYS.watcher);
    this.st = st ?? { v: 1, status: "waiting", nudges: 0, timers: 0, seen: [], ...(this.meta.party.dueAt !== undefined ? { dueAt: this.meta.party.dueAt } : {}) };
  }

  /** Saves the state; once replied, the result is handed to the kernel, which delivers it and closes this cell. */
  async save(): Promise<void> {
    await this.ports.context.commit(this.self, { statePatches: { [KEYS.watcher]: this.st, ...(this.#candidate ? { [CELL_RESULT_CANDIDATE_KEY]: this.#candidate } : {}) } });
    if (this.st.status === "replied") await this.ports.settleSelf?.({ action: "complete", summary: this.#summary() });
  }

  seen(env: Envelope): boolean {
    if (this.st.seen.includes(env.id)) return true;
    this.st.seen = [...this.st.seen, env.id].slice(-200);
    return false;
  }

  #summary(): string {
    return `${this.meta.party.label}已回复：${clip(this.st.reply?.text ?? "", 500)}`;
  }

  #waiting(): WaitingSet {
    const { party, description } = this.meta;
    const due = this.st.dueAt ?? party.dueAt;
    return {
      description,
      parties: [{ id: party.id, label: party.label, replied: this.st.status === "replied", ...(due !== undefined ? { dueAt: due } : {}) }],
      join: "all",
      ...(due !== undefined ? { dueAt: due } : {}),
      cancelGroup: "timeout",
    };
  }

  /** A silent note for the project: it reads it at its next turn; its books move the party's deadline. */
  async #progress(event: NonNullable<ReplyWatchReport["event"]>, text: string): Promise<void> {
    const report: ReplyWatchReport = { kind: "reply_wait", partyId: this.meta.party.id, event, ...(this.st.dueAt !== undefined ? { dueAt: this.st.dueAt } : {}) };
    const payload: CellProgressPayload = { childCellId: this.self, text, data: { gtd: report } };
    await this.ports.emitToParent(PAYLOAD.cellProgress, payload, { id: `${this.self}:${event}:${this.st.timers}:${this.st.nudges}`, delivery: "silent_inject" });
  }

  async onReply(text: string, from: string, at = this.now): Promise<void> {
    if (this.st.status === "replied") return;
    this.st.status = "replied";
    this.st.reply = { text, at, from };
    await this.ports.cancelScheduled({ cellId: this.self, cancelGroup: "timeout" });
    if (this.st.cardActionId) await this.ports.withdrawApproval?.({ actionId: this.st.cardActionId }, "对方已回复");
    delete this.st.cardActionId;
    const report: ReplyWatchReport = { kind: "reply", partyId: this.meta.party.id, reply: text, from, at };
    this.#candidate = { status: "completed", summary: this.#summary(), data: { gtd: report }, at: this.now };
  }

  async onTimeout(text?: string): Promise<void> {
    if (this.st.status !== "waiting") return;
    const { party, description } = this.meta;
    const body = text ?? this.meta.nudgeText ?? `您好，想跟进一下：${description}。方便的话请回复一下，谢谢！`;
    const artifactId = this.st.nudgeArtifactId ?? `${this.self}-nudge`;
    const cur = await this.ports.context.getArtifact(artifactId);
    await this.ports.context.commit(this.self, {
      artifact: { artifactId, content: { format: "text", title: `催问${party.label}`, body }, updatedBy: "agent", ...(cur ? { expectedVersion: cur.version } : {}) },
    });
    this.st.nudgeArtifactId = artifactId;
    this.st.status = "overdue";
    await this.#raiseNudge();
    if (this.st.status === "overdue") await this.#progress("overdue", `${party.label}到期还没有回复（${description}），已拟好催问，等主人在待确认里决定是否发出。`);
  }

  /** The nudge card (one per project subject: a newer card of the project replaces an older one). */
  async #raiseNudge(): Promise<void> {
    const { party, description } = this.meta;
    const project = projectCellIdOf(this.ports.self.spec);
    const subjectKey = project ? subjectKeys.project(project) : subjectKeys.cell(this.self);
    const since = this.st.dueAt !== undefined ? `在 ${formatWhen(this.st.dueAt, this.cfg.timeZone)} 前` : "";
    const explanation = `${party.label}${since}还没有回复（${description}）。已拟好催问，确认后发出并继续跟进。`;
    const base = {
      subjectKey,
      title: `${party.label}还没回复：${description}`,
      source: this.meta.source ?? { label: "等待回复", at: this.now },
      rawInput: this.meta.rawInput ?? { text: description, kind: "system" as const },
      prep: prep(`核对了等待状态：${party.label}确实还没回复${this.st.nudges ? `（已催过 ${this.st.nudges} 次）` : ""}。`),
    };
    const waiting = this.#waiting();
    const art = this.st.nudgeArtifactId ? await this.ports.context.getArtifact(this.st.nudgeArtifactId) : null;
    let action: ChannelSendAction | CustomAction;
    if (party.to && art) {
      const card = nudgeCard(base, explanation, waiting, { artifactId: art.artifactId, version: art.version }, party.to);
      action = { type: "channel.send", target: party.to, content: art.content, artifactId: art.artifactId, summary: `催问${party.label}`, subjectKey, sideEffect: "external", card: cardDeliverable(card, art.content.body) };
    } else {
      const card: EscalationCard = { ...base, cardType: "escalation", escalation: { reason: "waiting_timeout", explanation, waiting } };
      action = { type: "custom", name: "gtd.waiting_timeout", args: { partyId: party.id }, summary: base.title, subjectKey, sideEffect: "external", card: cardDeliverable(card, explanation) };
    }
    const r = await this.ports.authorize(action, art && action.type === "channel.send" ? { artifactVersion: art.version } : undefined);
    if (r.type === "defer") {
      this.st.cardActionId = r.actionId;
      this.outcome = "deferred_for_approval";
    } else if (r.type === "allow" && action.type === "channel.send") {
      // A standing rule ("固定模板催问可自动发") allows it: send now and keep following up.
      const receipt = await this.ports.notifyChannel({ target: action.target, content: action.content!, idempotencyKey: `${this.self}:nudge:${this.st.nudges}`, actionToken: r.actionToken });
      await this.#followUp(receipt === "sent" ? "nudged" : "nudge_closed", this.now + this.cfg.followUpMs);
    } else {
      await this.#followUp("nudge_closed", this.now + this.cfg.followUpMs);
    }
  }

  async onResolved(p: ApprovalResolvedPayload & { decision?: string; until?: number }): Promise<void> {
    if (!this.st.cardActionId || p.actionId !== this.st.cardActionId) return;
    if (p.status === "pending" || p.status === "superseded") return;
    delete this.st.cardActionId;
    const later = this.now + this.cfg.followUpMs;
    if (p.status === "executed") return this.#followUp("nudged", later);
    if (p.decision === "continue" || p.status === "approved") return this.#followUp("extended", p.until ?? later);
    return this.#followUp("nudge_closed", later);
  }

  async #followUp(event: "nudged" | "extended" | "nudge_closed", dueAt: number): Promise<void> {
    if (this.st.status === "replied") return;
    if (event === "nudged") this.st.nudges += 1;
    this.st.status = "waiting";
    this.st.dueAt = dueAt;
    this.st.timers += 1;
    await this.ports.scheduleSelf(
      { id: `${this.self}:timeout:${this.st.timers}`, type: PAYLOAD.timerFired, payload: { label: "等待超时检查", data: { gtd: "timeout" } } satisfies TimerFiredPayload },
      { deliverAt: dueAt, cancelGroup: "timeout" },
    );
    const when = formatWhen(dueAt, this.cfg.timeZone);
    const what = event === "nudged" ? "催问已发出" : event === "extended" ? "主人决定再等等" : "这次先不催";
    await this.#progress(event, `${this.meta.party.label}还没回复：${what}，${when} 再看一次。`);
  }

  /** Everything that needs no judgment. `messages`: a message from the party is the reply (the code path). */
  async settle(envelopes: readonly Envelope[], opts: { messages: boolean; timeouts: boolean }): Promise<void> {
    for (const env of envelopes) {
      if (env.type === PAYLOAD.cellTask || this.seen(env)) continue;
      if (isEnvelopeOfType(env, "approval.resolved")) {
        await this.onResolved(env.payload as ApprovalResolvedPayload & { decision?: string; until?: number });
      } else if (opts.timeouts && isTimeout(env)) {
        await this.onTimeout();
      } else if (opts.messages && isEnvelopeOfType(env, "user.message")) {
        await this.onReply((env.payload as UserMessagePayload).text, env.principalId, env.createdAt);
      }
    }
  }
}

/** Code path (default): any message routed here by the party's watch is the reply. Zero tokens. */
export function createWaitMatch(cfg: PresetsConfig): CodeProcessor {
  return {
    name: PROCESSORS.waitMatch,
    description: "Reply watcher for one party: the reply closes it with a result for the project; a timeout puts a drafted nudge on the owner's card.",
    async run({ snapshot, ports, clock }) {
      const w = new WatcherCore(cfg, ports, clock.now());
      await w.load();
      await w.settle(snapshot.batch.envelopes, { messages: true, timeouts: true });
      await w.save();
      return w.outcome;
    },
  };
}

/** Tools of the llm reply watcher: the model only judges messages and may word the nudge; bookkeeping stays in code. */
export function watcherToolset(cfg: PresetsConfig): Toolset {
  async function core(ctx: ToolContext, timeouts = false): Promise<WatcherCore> {
    const w = new WatcherCore(cfg, ctx.ports, ctx.clock.now());
    await w.load();
    await w.settle(ctx.snapshot.batch.envelopes, { messages: false, timeouts });
    return w;
  }
  const end = (w: WatcherCore, output: string) => ({ output, endRun: w.outcome === "deferred_for_approval" ? ("deferred_for_approval" as const) : ("completed" as const) });

  return {
    name: TOOLSETS.watcher,
    description: "Waiting-for-a-reply bookkeeping (replies, timeouts, nudges).",
    tools: [
      defineTool({
        name: "record_reply",
        kind: "kernel",
        description: "The awaited person has answered what you are waiting for. Records it, stops the timeout and reports to your parent; your job is then done.",
        input: z.object({ summary: z.string().min(1).describe("what they answered, briefly, in Chinese") }),
        async handler(args, ctx) {
          const w = await core(ctx);
          const env = ctx.snapshot.batch.envelopes.find((e) => e.type === PAYLOAD.userMessage);
          await w.onReply(args.summary, env?.principalId ?? "unknown", env?.createdAt);
          await w.save();
          return end(w, "Reply recorded; it goes to your parent and this wait is closed. Stop here.");
        },
      }),
      defineTool({
        name: "draft_nudge",
        kind: "kernel",
        description: "The wait timed out without a reply: save a short, polite follow-up message (Chinese unless the thread uses another language). It goes on the owner's card; they decide whether it is sent.",
        input: z.object({ text: z.string().min(1).optional().describe("the follow-up; omit to use the standard wording") }),
        async handler(args, ctx) {
          const w = await core(ctx);
          await w.onTimeout(args.text);
          await w.save();
          return end(w, "Follow-up drafted and put in front of the owner. Stop here.");
        },
      }),
      defineTool({
        name: "update_watch",
        kind: "kernel",
        description:
          "Apply this wake-up's bookkeeping when there is no new message to judge (setup, the owner's decision on a follow-up card, your parent's instructions; a timeout gets the standard follow-up wording).",
        input: z.object({}),
        async handler(_args, ctx) {
          const w = await core(ctx, true);
          await w.save();
          return end(w, `Status: ${w.st.status}${w.st.dueAt ? `, next check ${new Date(w.st.dueAt).toISOString()}` : ""}.`);
        },
      }),
    ],
  };
}
