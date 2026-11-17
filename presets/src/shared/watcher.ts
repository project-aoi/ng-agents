import { z } from "zod";
import {
  defineTool,
  isEnvelopeOfType,
  PAYLOAD,
  projectCellIdOf,
  subjectKeys,
  type ApprovalResolvedPayload,
  type ChannelSendAction,
  type CodeProcessor,
  type CustomAction,
  type EscalationCard,
  type Envelope,
  type RunOutcome,
  type RunPorts,
  type TimerFiredPayload,
  type Toolset,
  type UserMessagePayload,
} from "@ng/protocol";
import { cardDeliverable, nudgeCard, prep } from "./cards";
import { KEYS, PROCESSORS, TOOLSETS, type PresetsConfig } from "./config";
import { GTD_PAYLOAD, type GtdCommand, type WatchEvent } from "./payloads";
import type { PartyPlan } from "./plan";
import { clip, formatWhen } from "./records";

// thread-watcher bookkeeping for one party: the reply arriving (an early reply cancels the timeout), the timeout
// (a drafted nudge, reported to the root, which decides when the card may appear), the owner's decision on the nudge
// card (sent → check again later; "再等 1 天" → wait until then; "线下已解决" closes this watcher).

interface WatcherMeta {
  slot: string;
  party: PartyPlan;
  description: string;
  itemTitle: string;
  nudgeText?: string;
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

function metaOf(ports: RunPorts): WatcherMeta {
  const m = ports.self.spec.meta?.["gtd"] as WatcherMeta | undefined;
  if (!m?.party || !m.slot) throw new Error("watcher: spec.meta.gtd { slot, party, description } is missing");
  return m;
}

const isTimeout = (env: Envelope) =>
  isEnvelopeOfType(env, "timer.fired") &&
  ((env.payload.data as { gtd?: unknown } | undefined)?.gtd === "timeout" || env.payload.label.startsWith("schedule:"));

class WatcherCore {
  readonly meta: WatcherMeta;
  st!: WatcherState;
  outcome: RunOutcome = "completed";

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

  async save(): Promise<void> {
    await this.ports.context.commit(this.self, { statePatches: { [KEYS.watcher]: this.st } });
  }

  seen(env: Envelope): boolean {
    if (this.st.seen.includes(env.id)) return true;
    this.st.seen = [...this.st.seen, env.id].slice(-200);
    return false;
  }

  async #emit(e: WatchEvent): Promise<void> {
    await this.ports.emitToParent(GTD_PAYLOAD.watch, e, { id: `${this.self}:${e.event}:${this.now}` });
  }

  async onReply(text: string, from: string, at = this.now): Promise<void> {
    if (this.st.status === "replied") return;
    this.st.status = "replied";
    this.st.reply = { text, at, from };
    await this.ports.cancelScheduled({ cellId: this.self, cancelGroup: "timeout" });
    if (this.st.cardActionId) await this.ports.withdrawApproval?.({ actionId: this.st.cardActionId }, "对方已回复");
    delete this.st.cardActionId;
    const { party, slot } = this.meta;
    await this.ports.emitToParent(
      PAYLOAD.cellResult,
      { childCellId: this.self, status: "completed", summary: `${party.label}已回复：${clip(text, 500)}`, data: { gtd: { slot, partyId: party.id, reply: text, from, at } } },
      { id: `${this.self}:reply` },
    );
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
    await this.#emit({ event: "overdue", slot: this.meta.slot, dueAt: this.st.dueAt ?? this.now });
  }

  /** The root gave this watcher the item's one card slot. */
  async onRaise(cmd: Extract<GtdCommand, { command: "raise_nudge" }>): Promise<void> {
    if (this.st.status !== "overdue") {
      await this.#emit({ event: "nudge_closed", slot: this.meta.slot, dueAt: this.st.dueAt ?? this.now, outcome: "not_overdue" });
      return;
    }
    const { party, description } = this.meta;
    const project = projectCellIdOf(this.ports.self.spec);
    const subjectKey = project ? subjectKeys.project(project) : subjectKeys.cell(this.self);
    const replied = cmd.waiting.parties.filter((p) => p.replied).length;
    const since = this.st.dueAt !== undefined ? `在 ${formatWhen(this.st.dueAt, this.cfg.timeZone)} 前` : "";
    const explanation = `${party.label}${since}还没有回复（${description}，已回 ${replied}/${cmd.waiting.parties.length}）。已拟好催问，确认后发出并继续跟进。`;
    const base = {
      subjectKey,
      title: `${party.label}还没回复：${description}`,
      source: cmd.source,
      rawInput: cmd.rawInput,
      prep: prep(`核对了等待状态：${party.label}确实还没回复${this.st.nudges ? `（已催过 ${this.st.nudges} 次）` : ""}。`),
    };
    const art = this.st.nudgeArtifactId ? await this.ports.context.getArtifact(this.st.nudgeArtifactId) : null;
    let action: ChannelSendAction | CustomAction;
    if (party.to && art) {
      const card = nudgeCard(base, explanation, cmd.waiting, { artifactId: art.artifactId, version: art.version }, party.to);
      action = { type: "channel.send", target: party.to, content: art.content, artifactId: art.artifactId, summary: `催问${party.label}`, subjectKey, sideEffect: "external", card: cardDeliverable(card, art.content.body) };
    } else {
      const card: EscalationCard = { ...base, cardType: "escalation", escalation: { reason: "waiting_timeout", explanation, waiting: cmd.waiting } };
      action = { type: "custom", name: "gtd.waiting_timeout", args: { slot: this.meta.slot }, summary: base.title, subjectKey, sideEffect: "external", card: cardDeliverable(card, explanation) };
    }
    const r = await this.ports.authorize(action, art && action.type === "channel.send" ? { artifactVersion: art.version } : undefined);
    if (r.type === "defer") {
      this.st.cardActionId = r.actionId;
      this.outcome = "deferred_for_approval";
    } else if (r.type === "allow" && action.type === "channel.send") {
      // A standing rule ("固定模板催问可自动发") allows it: send now and keep following up.
      const receipt = await this.ports.notifyChannel({ target: action.target, content: action.content!, idempotencyKey: `${this.self}:nudge:${this.st.nudges}`, actionToken: r.actionToken });
      await this.#followUp(receipt === "sent" ? "nudged" : "nudge_closed", this.now + this.cfg.followUpMs, receipt);
    } else {
      await this.#followUp("nudge_closed", this.now + this.cfg.followUpMs, r.type);
    }
  }

  async onResolved(p: ApprovalResolvedPayload & { decision?: string; until?: number }): Promise<void> {
    if (!this.st.cardActionId || p.actionId !== this.st.cardActionId) return;
    if (p.status === "pending" || p.status === "superseded") return;
    delete this.st.cardActionId;
    const later = this.now + this.cfg.followUpMs;
    if (p.status === "executed") return this.#followUp("nudged", later, "sent");
    if (p.decision === "continue" || p.status === "approved") return this.#followUp("extended", p.until ?? later, "extended");
    return this.#followUp("nudge_closed", later, p.status);
  }

  async #followUp(event: "nudged" | "extended" | "nudge_closed", dueAt: number, outcome: string): Promise<void> {
    if (this.st.status === "replied") return;
    if (event === "nudged") this.st.nudges += 1;
    this.st.status = "waiting";
    this.st.dueAt = dueAt;
    this.st.timers += 1;
    await this.ports.scheduleSelf(
      { id: `${this.self}:timeout:${this.st.timers}`, type: PAYLOAD.timerFired, payload: { label: "等待超时检查", data: { gtd: "timeout" } } satisfies TimerFiredPayload },
      { deliverAt: dueAt, cancelGroup: "timeout" },
    );
    const e: WatchEvent = event === "nudge_closed" ? { event, slot: this.meta.slot, dueAt, outcome } : { event, slot: this.meta.slot, dueAt };
    await this.#emit(e);
  }

  /** Everything that needs no judgment. `messages` decides what a message from the party means (code: it is the reply). */
  async settle(envelopes: readonly Envelope[], opts: { messages: boolean; timeouts: boolean }): Promise<void> {
    for (const env of envelopes) {
      if (env.type === PAYLOAD.cellTask || this.seen(env)) continue;
      if (env.type === GTD_PAYLOAD.command) {
        const cmd = env.payload as GtdCommand;
        if (cmd.command === "raise_nudge") await this.onRaise(cmd);
      } else if (isEnvelopeOfType(env, "approval.resolved")) {
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
    description: "Watcher bookkeeping for one party: reply, timeout with a drafted nudge, the owner's decision on the nudge card.",
    async run({ snapshot, ports, clock }) {
      const w = new WatcherCore(cfg, ports, clock.now());
      await w.load();
      await w.settle(snapshot.batch.envelopes, { messages: true, timeouts: true });
      await w.save();
      return w.outcome;
    },
  };
}

/** Tools of the llm watcher: the model only judges messages and may word the nudge; bookkeeping stays in code. */
export function watcherToolset(cfg: PresetsConfig): Toolset {
  async function core(ctx: Parameters<Parameters<typeof defineTool>[0]["handler"]>[1], timeouts = false): Promise<WatcherCore> {
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
        description: "The awaited person has answered what you are waiting for. Records it, stops the timeout and reports to your parent.",
        input: z.object({ summary: z.string().min(1).describe("what they answered, briefly, in Chinese") }),
        async handler(args, ctx) {
          const w = await core(ctx);
          const env = ctx.snapshot.batch.envelopes.find((e) => e.type === PAYLOAD.userMessage);
          await w.onReply(args.summary, env?.principalId ?? "unknown", env?.createdAt);
          await w.save();
          return end(w, "Reply recorded and reported.");
        },
      }),
      defineTool({
        name: "draft_nudge",
        kind: "kernel",
        description: "The wait timed out without a reply: save a short, polite follow-up message (Chinese unless the thread uses another language). The owner decides whether it is sent.",
        input: z.object({ text: z.string().min(1).optional().describe("the follow-up; omit to use the standard wording") }),
        async handler(args, ctx) {
          const w = await core(ctx);
          await w.onTimeout(args.text);
          await w.save();
          return end(w, "Follow-up drafted; your parent decides when it is shown to the owner.");
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
