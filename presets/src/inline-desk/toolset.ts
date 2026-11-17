import { z } from "zod";
import {
  anyCovers,
  defineTool,
  gtdKeys,
  isChannelAddr,
  isEnvelopeOfType,
  newId,
  subjectKeys,
  type ActivityRecord,
  type ApprovalRevisePayload,
  type CellSpec,
  type ChannelAddr,
  type ChannelSendAction,
  type ProcessorSpec,
  type ProjectProposal,
  type ProjectStartAction,
  type ToolContext,
  type ToolDef,
  type ToolResult,
  type Toolset,
} from "@ng/protocol";
import { cardDeliverable, prep as cardPrep, proposalCard, responseCard } from "../shared/cards";
import { KEYS, PROCESSORS, ROLES, TOOLSETS, type PresetsConfig } from "../shared/config";
import { readCoordinator } from "../shared/coordinator";
import { notifyOwner } from "../shared/notify";
import { GTD_PAYLOAD, type GtdCommand } from "../shared/payloads";
import { chasePlan, fanOutPlan, SENSOR_LLM_PROCESSOR, singlePlan, toolKinds, type PartyPlan } from "../shared/plan";
import { clip, formatWhen, itemRawInput, itemSource, newActivity } from "../shared/records";
import type { SourceInit } from "../shared/sensor";
import {
  ACKNOWLEDGE_ACTION,
  closeLinkedActions,
  currentItem,
  isRestored,
  itemInfo,
  readReplyItems,
  replyAddressOf,
  SETTLE_ERROR,
  settleDesk,
  startItem,
  type DeskBooks,
  type ProposalItem,
  type ReminderData,
  type ReplyItem,
} from "./items";

const effort = z.enum(["15m", "45m", "low_energy"]);
const prepInput = z
  .object({
    summary: z.string().min(1).describe("what you checked before asking, one or two sentences"),
    checked: z.array(z.object({ label: z.string(), uri: z.string(), detail: z.string().optional() })).optional(),
  })
  .describe("shown on the card: what you looked at");
const replyToInput = z.string().optional().describe("channel address of the person who asked, if the result should go back to them (sent only after the owner confirms)");

function parseTime(at: string | undefined, minutes: number | undefined, now: number): number | string {
  if (at !== undefined) {
    const t = Date.parse(at);
    if (Number.isNaN(t)) return `Cannot parse "${at}"; use ISO 8601 with an offset, e.g. 2026-11-20T15:00:00+08:00.`;
    return t;
  }
  if (minutes !== undefined) return now + minutes * 60_000;
  return "Give at or inMinutes.";
}

function prepOf(p: z.infer<typeof prepInput> | undefined, fallback: string) {
  return cardPrep(p?.summary ?? fallback, (p?.checked ?? []).map((c) => ({ label: c.label, uri: c.uri, ...(c.detail ? { detail: c.detail } : {}) })));
}

/** `gtd.desk`: the desk's GTD-aware composites. Each one runs the desk's bookkeeping for this wake-up first. */
export function deskToolset(cfg: PresetsConfig, books: DeskBooks): Toolset {
  const owner = cfg.ownerAddress;

  /** Every desk tool first applies the wake-up's deterministic follow-ups, whichever tool the model picked. */
  function tool<S extends z.ZodType>(def: { name: string; description: string; input: S; run(args: z.output<S>, ctx: ToolContext, settled: string[]): Promise<ToolResult | string> }): ToolDef {
    return defineTool({
      name: def.name,
      kind: "kernel",
      description: def.description,
      input: def.input,
      async handler(args, ctx) {
        const settled = await settleDesk(cfg, ctx);
        const r = await def.run(args, ctx, settled);
        const res: ToolResult = typeof r === "string" ? { output: r } : r;
        if (settled.length && def.name !== "apply_updates") res.output = `${res.output}\n(Also applied: ${settled.join("；")})`;
        return res;
      },
    });
  }

  const now = (ctx: ToolContext) => ctx.clock.now();
  const self = (ctx: ToolContext) => ctx.ports.self.cellId;
  const restoredRefusal = {
    output: "The owner moved this item back from the archive on purpose: it needs a card (present_to_owner, draft_reply, propose_project, or hand it off). Do not file it away again.",
    isError: true,
  };

  // ---------- personal, zero side effect: done directly, no card ----------

  const captureNote = tool({
    name: "capture_note",
    description:
      "Save something the owner wants kept (a link for the reading list, a note, an idea). Done at once with a light notice to the owner — no card. Use for the owner's own zero-side-effect captures only.",
    input: z.object({
      title: z.string().min(1).describe("short title in Chinese"),
      content: z.string().optional(),
      url: z.string().optional(),
      list: z.string().optional().describe('which list, e.g. "阅读清单"; default "随手记"'),
    }),
    async run(args, ctx) {
      if (isRestored(ctx)) return restoredRefusal;
      const list = args.list ?? "随手记";
      const t = now(ctx);
      const env = currentItem(ctx);
      const line = `- ${args.title}${args.url ? ` ${args.url}` : ""}${args.content ? `：${args.content}` : ""}（${formatWhen(t, cfg.timeZone)}）\n`;
      await ctx.ports.context.upsertSkillOrNote(self(ctx), { kind: "note", name: list, description: `${list}（主人随手存下的内容）`, body: line, scope: "cell", mode: "append" });
      const a: ActivityRecord = newActivity(
        {
          id: newId("note", ctx.clock),
          kind: "note_saved",
          title: `已存入${list}：${args.title}`,
          ...(args.url || args.content ? { detail: args.url ?? args.content! } : {}),
          source: itemSource(env, t),
          rawInput: itemRawInput(env).text,
          ...(env ? { envelope: env } : {}),
          restorable: true,
        },
        t,
      );
      await ctx.ports.context.commit(self(ctx), { statePatches: { [gtdKeys.activity(a.id)]: a } });
      await notifyOwner(ctx.ports, owner, `已存入${list}：${args.title}`, `note:${a.id}`);
      return `Saved to "${list}" and the owner was told. Nothing else is needed for it.`;
    },
  });

  const remindMe = tool({
    name: "remind_me",
    description:
      "Set a personal reminder for the owner. Done at once with a light notice — no card. When it fires, call apply_updates: it becomes a quick to-do in the owner's focus list and the owner is notified.",
    input: z.object({
      text: z.string().min(1).describe('what to remind, in Chinese, e.g. "给牙医打电话约时间"'),
      at: z.string().optional().describe(`ISO 8601 with offset; times the owner names are in their time zone, ${cfg.timeZone} (message times you see are UTC)`),
      inMinutes: z.number().int().min(1).optional(),
      effort: effort.optional(),
    }),
    async run(args, ctx) {
      const t = now(ctx);
      const when = parseTime(args.at, args.inMinutes, t);
      if (typeof when === "string") return { output: when, isError: true };
      if (when <= t) return { output: "That time has already passed.", isError: true };
      const id = newId("rem", ctx.clock);
      const data: ReminderData = { kind: "reminder", id, text: args.text, remindAt: when, ...(args.effort ? { effort: args.effort } : {}) };
      await ctx.ports.scheduleSelf(
        { id: `gtd-reminder:${id}`, type: "timer.fired", payload: { label: `提醒：${args.text}`, data: { gtd: data }, subjectKey: `reminder:${id}` } },
        { deliverAt: when, cancelGroup: `reminder:${id}` },
      );
      const env = currentItem(ctx);
      const whenText = formatWhen(when, cfg.timeZone);
      const a: ActivityRecord = newActivity(
        { id, kind: "reminder_set", title: `已设好提醒：${args.text}`, detail: whenText, remindAt: when, source: itemSource(env, t), rawInput: itemRawInput(env).text, restorable: false },
        t,
      );
      await ctx.ports.context.commit(self(ctx), { statePatches: { [gtdKeys.activity(id)]: a, [KEYS.reminder(id)]: data } });
      await notifyOwner(ctx.ports, owner, `已设好 ${whenText} 的提醒：${args.text}`, `reminder-set:${id}`);
      return `Reminder set for ${new Date(when).toISOString()} (cancel with cancel_scheduled cancelGroup "reminder:${id}"). The owner was told.`;
    },
  });

  const archiveNotification = tool({
    name: "archive_notification",
    description: "File a pure notification that needs nothing from the owner (FYI, automated status mail). Silent: it only shows in the archived count and can be moved back to the owner's queue.",
    input: z.object({ title: z.string().min(1).describe("short Chinese title"), detail: z.string().optional() }),
    async run(args, ctx) {
      if (isRestored(ctx)) return restoredRefusal;
      const t = now(ctx);
      const env = currentItem(ctx);
      const a: ActivityRecord = newActivity(
        {
          id: newId("ntf", ctx.clock),
          kind: "notification_archived",
          title: args.title,
          ...(args.detail ? { detail: args.detail } : {}),
          source: itemSource(env, t),
          rawInput: itemRawInput(env).text,
          ...(env ? { envelope: env } : {}),
          restorable: true,
        },
        t,
      );
      await ctx.ports.context.commit(self(ctx), { statePatches: { [gtdKeys.activity(a.id)]: a } });
      return "Archived silently.";
    },
  });

  // ---------- replies: one card per item, kept across redrafts ----------

  const draftReply = tool({
    name: "draft_reply",
    description: [
      "Draft a reply to someone (not the owner) and put it on the owner's confirmation card; nothing is sent until the owner confirms that exact version.",
      "Also use it to redraft after the owner asks for changes, or when a follow-up arrives in a thread whose reply is still waiting: it updates that same card with a new version (a draft the owner already edited themselves is kept, and your new text is put beside it).",
      "Defaults to answering the person who sent the current message.",
    ].join(" "),
    input: z.object({
      text: z.string().min(1).describe("the full reply text"),
      to: z.string().optional().describe("channel:<channelId>:<target>; default: whoever sent the current message"),
      title: z.string().optional().describe("card title in Chinese, e.g. 回复张三：限流阈值"),
      targetLabel: z.string().optional().describe('recipient as the owner would name them, e.g. "张三（飞书）"'),
      prep: prepInput.optional(),
    }),
    async run(args, ctx) {
      const { ports } = ctx;
      const t = now(ctx);
      const revise = ctx.snapshot.batch.envelopes.find((e) => isEnvelopeOfType(e, "approval.revise"));
      const reviseSubject = revise ? (revise.payload as ApprovalRevisePayload & { subjectKey?: string }).subjectKey : undefined;
      const env = currentItem(ctx);
      let subjectKey = reviseSubject;
      if (!subjectKey && env?.threads?.length) {
        // A follow-up in a thread whose reply still waits on a card belongs to that item (one card per item).
        const threads = new Set(env.threads);
        const open = (await readReplyItems(ports)).filter((i) => i.status === "pending" && i.actionId && i.threads?.some((th) => threads.has(th)));
        if (open.length === 1) subjectKey = open[0]!.subjectKey;
      }
      subjectKey ??= env ? subjectKeys.inbound(env.id) : undefined;
      if (!subjectKey) return { output: "There is no message to reply to in this wake-up; give `to` and use send_message for a new conversation.", isError: true };
      const key = KEYS.reply(subjectKey);
      let item = await ports.context.readState<ReplyItem>(self(ctx), key);
      const to = args.to ?? item?.target ?? replyAddressOf(env);
      if (!to || !isChannelAddr(to)) return { output: `No reply address: pass to as channel:<channelId>:<target>.`, isError: true };
      if (anyCovers([`${owner.split(":").slice(0, 2).join(":")}:*`], to)) return { output: "That is the owner's own address: use send_message for notes to the owner.", isError: true };
      const target: ChannelAddr = to;
      const title = args.title ?? item?.title ?? `回复：${clip(itemRawInput(env).text, 40) || "消息"}`;
      const targetLabel = args.targetLabel ?? item?.targetLabel ?? target;

      let artifactId = item?.artifactId;
      let version: number;
      const content = { format: "text" as const, title, body: args.text };
      if (artifactId) {
        const cur = await ports.context.getArtifact(artifactId);
        // Only the owner's own redraft request may replace a version they edited; otherwise Context parks our text
        // beside theirs (docs/04 §3: background updates never overwrite handwritten changes).
        const expected = cur && (revise || cur.updatedBy === "agent") ? cur.version : undefined;
        const r = await ports.context.commit(self(ctx), { artifact: { artifactId, content, updatedBy: "agent", ...(expected !== undefined ? { expectedVersion: expected } : {}) } });
        if (!r.ok && r.parked && item) {
          await ports.context.commit(self(ctx), { statePatches: { [key]: { ...item, updatedAt: t } } });
          return `The owner has edited this draft themselves (v${r.currentArtifact.version}): their text and their card stay as they are, and your new version was put beside it for them to use. Nothing else to do.`;
        }
        if (!r.ok) return { output: `The draft changed meanwhile (now v${r.currentArtifact.version} by ${r.currentArtifact.updatedBy}); read it and redraft.`, isError: true };
        version = r.artifactVersion ?? (cur?.version ?? 0) + 1;
      } else {
        artifactId = newId("art", ctx.clock);
        const r = await ports.context.commit(self(ctx), { artifact: { artifactId, content, updatedBy: "agent" } });
        version = r.ok ? (r.artifactVersion ?? 1) : 1;
      }
      item = {
        subjectKey,
        title,
        target,
        targetLabel,
        artifactId,
        status: "pending",
        source: item?.source ?? itemSource(env, t),
        rawInput: item?.rawInput ?? itemRawInput(env),
        ...(item?.envelope ?? env ? { envelope: (item?.envelope ?? env)! } : {}),
        ...((item?.threads ?? env?.threads) ? { threads: (item?.threads ?? env?.threads)! } : {}),
        ...(item?.actionId ? { actionId: item.actionId } : {}),
        createdAt: item?.createdAt ?? t,
        updatedAt: t,
      };
      const card = responseCard(
        { subjectKey, title, source: item.source, rawInput: item.rawInput, prep: prepOf(args.prep, revise ? "按主人的修改意见重拟了一版。" : "") },
        { artifactId, version },
        { target, targetLabel },
        "send",
      );
      const action: ChannelSendAction = { type: "channel.send", target, content, artifactId, summary: title, subjectKey, sideEffect: "external", card: cardDeliverable(card, args.text) };
      const r = await ports.authorize(action, { artifactVersion: version });
      if (r.type === "deny") return { output: `Not allowed: ${r.feedback}`, isError: true };
      if (r.type === "allow") {
        const receipt = await ports.notifyChannel({ target, content, idempotencyKey: `reply:${artifactId}:v${version}`, actionToken: r.actionToken });
        await ports.context.commit(self(ctx), { statePatches: { [key]: { ...item, status: receipt === "sent" ? "sent" : "pending", updatedAt: t } } });
        return `A standing rule allowed it: sent (${receipt}).`;
      }
      await ports.context.commit(self(ctx), { statePatches: { [key]: { ...item, actionId: r.actionId } } });
      return { output: `Draft v${version} is on the owner's card. Nothing is sent until they confirm.`, endRun: "deferred_for_approval", data: { actionId: r.actionId, artifactId, version } };
    },
  });

  const withdrawCard = tool({
    name: "withdraw_card",
    description:
      "Take down a pending reply card that is no longer needed (e.g. someone else already answered in the group). It is archived and can be moved back. Defaults to the card of the thread the current message is in.",
    input: z.object({ reason: z.string().min(1).describe('why, in Chinese, e.g. "群里李四已经回答了"'), subjectKey: z.string().optional() }),
    async run(args, ctx) {
      const { ports } = ctx;
      const pending = (await readReplyItems(ports)).filter((i) => i.status === "pending" && i.actionId);
      let item: ReplyItem | undefined;
      if (args.subjectKey) item = pending.find((i) => i.subjectKey === args.subjectKey);
      else {
        const threads = new Set(currentItem(ctx)?.threads ?? []);
        const byThread = pending.filter((i) => i.threads?.some((th) => threads.has(th)));
        item = byThread.length === 1 ? byThread[0] : pending.length === 1 ? pending[0] : undefined;
      }
      if (!item) {
        const list = pending.map((i) => `${i.subjectKey}（${i.title}）`).join("；") || "none";
        return { output: `Which card? Pending reply cards: ${list}. Pass subjectKey.`, isError: true };
      }
      const r = ports.withdrawApproval ? await ports.withdrawApproval({ actionId: item.actionId! }, args.reason) : "not_pending";
      const t = now(ctx);
      const a: ActivityRecord = newActivity(
        {
          id: `withdrawn-${item.actionId}`,
          kind: "card_withdrawn",
          title: `已撤下：${item.title}`,
          detail: args.reason,
          source: item.source,
          rawInput: item.rawInput.text,
          ...(item.envelope ? { envelope: item.envelope } : {}),
          actionId: item.actionId!,
          restorable: true,
        },
        t,
      );
      const linked = await closeLinkedActions(ports, item.actionId!, "cancelled", t);
      await ports.context.commit(self(ctx), { statePatches: { [KEYS.reply(item.subjectKey)]: { ...item, status: "withdrawn", updatedAt: t }, [gtdKeys.activity(a.id)]: a, ...linked } });
      return r === "cancelled" ? "Card withdrawn and archived." : "The card was no longer pending (already decided); archived the item.";
    },
  });

  const presentToOwner = tool({
    name: "present_to_owner",
    description:
      "Put an item in front of the owner on a card when they should see or acknowledge it but nothing goes out (e.g. something they moved back from the archive, a finding they must know about). One card per item; confirming just files it as seen.",
    input: z.object({
      title: z.string().min(1).describe("card title in Chinese"),
      summary: z.string().min(1).describe("what it is and what (if anything) the owner might do, in Chinese"),
      prep: prepInput.optional(),
    }),
    async run(args, ctx) {
      const { ports } = ctx;
      const t = now(ctx);
      const env = currentItem(ctx);
      const subjectKey = env ? subjectKeys.inbound(env.id) : subjectKeys.cell(self(ctx));
      const artifactId = newId("art", ctx.clock);
      const content = { format: "markdown" as const, title: args.title, body: args.summary };
      const saved = await ports.context.commit(self(ctx), { artifact: { artifactId, content, updatedBy: "agent" } });
      const version = saved.ok ? (saved.artifactVersion ?? 1) : 1;
      const card = responseCard(
        { subjectKey, title: args.title, source: itemSource(env, t), rawInput: itemRawInput(env), prep: prepOf(args.prep, "") },
        { artifactId, version },
        { target: owner, targetLabel: "我" },
        "accept",
      );
      const r = await ports.authorize(
        { type: "custom", name: ACKNOWLEDGE_ACTION, artifactId, summary: args.title, subjectKey, sideEffect: "external", card: cardDeliverable(card, args.summary) },
        { artifactVersion: version },
      );
      if (r.type === "deny") return { output: `Not allowed: ${r.feedback}`, isError: true };
      return r.type === "defer" ? { output: "The card is waiting for the owner.", endRun: "deferred_for_approval" } : "A standing rule accepted it.";
    },
  });

  // ---------- weekly review: what to make permanent ----------

  const reviewWeek = tool({
    name: "review_week",
    description:
      "Facts for the weekly review: replies of the last 7 days the owner rewrote before sending (your first draft vs. what they sent), and sources that use a model on every check. Use them to suggest a skill or a zero-cost check.",
    input: z.object({}),
    async run(_args, ctx) {
      const { ports } = ctx;
      const since = now(ctx) - 7 * 24 * 3_600_000;
      const lines: string[] = [];
      for (const item of await readReplyItems(ports)) {
        if (item.status !== "sent" || item.updatedAt < since) continue;
        const cur = await ports.context.getArtifact(item.artifactId);
        if (!cur || cur.updatedBy !== "human" || cur.version < 2) continue;
        const first = await ports.context.readResource(self(ctx), `artifact://${item.artifactId}@1`).catch(() => "");
        lines.push(`## ${item.title}（发给${item.targetLabel}）\n你的初稿：\n${clip(first, 600)}\n主人发出的版本：\n${clip(cur.content.body, 600)}`);
      }
      for (const child of ctx.snapshot.tail.roster) {
        if (child.preset !== "sensor") continue;
        const src = await ports.context.readState<{ title: string; processor: string; runCount: number; hitCount: number; description?: string }>(child.cellId, gtdKeys.source);
        if (src?.processor === "llm") lines.push(`## 信源 ${child.cellId}：${src.title}\n每次检查都用模型：已检查 ${src.runCount} 次，命中 ${src.hitCount} 次。规则：${src.description ?? "（未写明）"}`);
      }
      const existing = (await ports.context.listState(self(ctx), "desk:suggestion:")).map((e) => e.key);
      if (existing.length) lines.push(`Already suggested (not yet decided): ${existing.join(", ")}`);
      return lines.length ? lines.join("\n\n") : "Nothing notable this week.";
    },
  });

  const suggestSkill = tool({
    name: "suggest_skill",
    description:
      "Offer the owner a SKILL.md distilled from a habit you observed (e.g. how they always rewrite a kind of reply). It appears in their weekly review; they decide whether to save it.",
    input: z.object({
      name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64).describe("slug, e.g. supplier-reply-tone"),
      description: z.string().min(1).describe("when to use it, one line"),
      body: z.string().min(1).describe("the procedure / rules, markdown"),
      reason: z.string().optional().describe("what you observed, in Chinese, shown to the owner"),
    }),
    async run(args, ctx) {
      const suggestion = { name: args.name, description: args.description, body: args.body, ...(args.reason ? { reason: args.reason } : {}), createdAt: now(ctx) };
      await ctx.ports.context.commit(self(ctx), { statePatches: { [KEYS.skillSuggestion(args.name)]: suggestion } });
      return `Suggested skill "${args.name}"; the owner sees it in the weekly review.`;
    },
  });

  const suggestCodeCheck = tool({
    name: "suggest_code_check",
    description: "Suggest switching a source that runs a model on every check to a fixed zero-cost check (when its rule is mechanical). Shown in the owner's weekly review.",
    input: z.object({
      sourceId: z.string().min(1),
      entry: z.string().optional().describe("a registered check name or script:<path> that would replace the model"),
      reason: z.string().min(1).describe("why, in Chinese"),
    }),
    async run(args, ctx) {
      const src = await ctx.ports.context.readState(args.sourceId, gtdKeys.source).catch(() => null);
      if (!src) return { output: `${args.sourceId} is not one of your sources.`, isError: true };
      await ctx.ports.context.commit(self(ctx), { statePatches: { [KEYS.sensorSuggestion(args.sourceId)]: { ...(args.entry ? { entry: args.entry } : {}), reason: args.reason, createdAt: now(ctx) } } });
      return "Suggested; the owner sees it in the weekly review.";
    },
  });

  // ---------- projects and background work ----------

  const proposeProject = tool({
    name: "propose_project",
    description: [
      "Propose a project for something that needs several steps: the owner gets one proposal card and can edit the plan, approve it, or park it for later.",
      "On approval (you are woken; call apply_updates) the project starts: agent actions each get a background worker, human and waiting actions are listed for the owner.",
    ].join(" "),
    input: z.object({
      title: z.string().min(1),
      outcome: z.string().min(1).describe("what done looks like"),
      background: z.string().optional(),
      actions: z.array(z.object({ title: z.string().min(1), owner: z.enum(["agent", "human", "waiting"]), effort: effort.optional(), nextStep: z.string().optional() })).min(1),
      prep: prepInput.optional(),
      research: z.boolean().optional().describe("agent actions only read and report (no repository changes)"),
      repoPath: z.string().optional().describe("repository the agent actions work in"),
    }),
    async run(args, ctx) {
      const { ports } = ctx;
      const t = now(ctx);
      const env = currentItem(ctx);
      const subjectKey = env ? subjectKeys.inbound(env.id) : subjectKeys.cell(self(ctx));
      const proposal: ProjectProposal = {
        title: args.title,
        outcome: args.outcome,
        ...(args.background ? { background: args.background } : {}),
        actions: args.actions.map((a) => ({ title: a.title, owner: a.owner, ...(a.effort ? { effort: a.effort } : {}), ...(a.nextStep ? { nextStep: a.nextStep } : {}) })),
      };
      const artifactId = newId("art", ctx.clock);
      const saved = await ports.context.commit(self(ctx), {
        artifact: { artifactId, content: { format: "json", title: args.title, body: JSON.stringify(proposal, null, 2), data: proposal }, updatedBy: "agent" },
      });
      const version = saved.ok ? (saved.artifactVersion ?? 1) : 1;
      const remembered: ProposalItem = {
        source: itemSource(env, t),
        rawInput: itemRawInput(env),
        ...(env ? { envelope: env } : {}),
        ...(args.research !== undefined ? { research: args.research } : {}),
        ...(args.repoPath ? { repoPath: args.repoPath } : {}),
      };
      await ports.context.commit(self(ctx), { statePatches: { [KEYS.proposal(artifactId)]: remembered } });
      const card = proposalCard(
        { subjectKey, title: args.title, source: remembered.source, rawInput: remembered.rawInput, prep: prepOf(args.prep, args.background ?? "") },
        proposal,
        { artifactId, version },
      );
      const body = [proposal.outcome, ...proposal.actions.map((a) => `- [${a.owner}] ${a.title}`)].join("\n");
      // artifactId on the action binds the approval to the plan version the owner saw (edits go through "✎").
      const action: ProjectStartAction = { type: "project.start", proposal, artifactId, summary: `立项：${args.title}`, subjectKey, sideEffect: "external", card: cardDeliverable(card, body) };
      const r = await ports.authorize(action, { artifactVersion: version });
      if (r.type === "deny") return { output: `Not allowed: ${r.feedback}`, isError: true };
      if (r.type === "allow") return "A standing rule allowed it; call apply_updates to start it.";
      return { output: "Proposal card is waiting for the owner. You will be woken with the decision.", endRun: "deferred_for_approval", data: { actionId: r.actionId, artifactId } };
    },
  });

  const delegate = tool({
    name: "delegate",
    description: [
      "Hand one piece of slow or multi-step work (look into code, fix a bug, write a document, research a question) to a background worker right away; it shows to the owner as 🟢 being handled and the owner gets a short acknowledgement.",
      "When it is done, its result comes back as one card. continueConversation lets the worker continue from this conversation (e.g. fix the bug you just discussed).",
    ].join(" "),
    input: z.object({
      title: z.string().min(1).describe("short Chinese title shown in the owner's lists"),
      instruction: z.string().min(1).describe("what to do, what done looks like, what to report"),
      outcome: z.string().optional(),
      research: z.boolean().optional().describe("read-only research: no repository checkout, no file changes"),
      repoPath: z.string().optional(),
      continueConversation: z.boolean().optional(),
      directLine: z.boolean().optional().describe("let the worker talk with the owner directly while it works"),
      replyTo: replyToInput,
      replyLabel: z.string().optional(),
    }),
    async run(args, ctx) {
      const rootId = newId("prj", ctx.clock);
      if (args.replyTo !== undefined && !isChannelAddr(args.replyTo)) return { output: "replyTo must be channel:<channelId>:<target>.", isError: true };
      const item = itemInfo(ctx, args.title, {
        ...(args.outcome ? { outcome: args.outcome } : {}),
        ...(args.replyTo ? { replyTo: args.replyTo as ChannelAddr, replyLabel: args.replyLabel ?? args.replyTo } : {}),
      });
      const plan = singlePlan(rootId, item, {
        instruction: args.instruction,
        ...(args.research !== undefined ? { research: args.research } : {}),
        ...(args.repoPath ? { repo: { repoPath: args.repoPath } } : {}),
        ...(args.continueConversation ? { fork: true } : {}),
        ...(args.directLine ? { directLine: { ownerAddress: owner, thread: `ui:${rootId}` } } : {}),
      });
      await startItem(ctx.ports, cfg, plan, { ...(args.continueConversation ? { fork: true } : {}), notice: `已交给后台处理：${args.title}`, noticeKey: `start:${rootId}` });
      return `Started item ${rootId} ("${args.title}"); the owner was told. Steer it with steer_item, stop it with stop_item.${args.directLine ? ` Direct line thread: ui:${rootId}.` : ""}`;
    },
  });

  const fanOut = tool({
    name: "fan_out",
    description:
      "Run the same kind of work over many items in parallel (e.g. research 15 competitors). One row for the owner with progress k/N; when all are back, one summary card. Each item gets its own background worker.",
    input: z.object({
      title: z.string().min(1),
      instruction: z.string().min(1).describe("what each worker does and reports"),
      items: z.array(z.object({ title: z.string().min(1), instruction: z.string().optional(), input: z.unknown().optional() })).min(2),
      label: z.string().optional().describe('progress label, e.g. "正在并发整理竞品资料"'),
      outcome: z.string().optional(),
      research: z.boolean().optional(),
      repoPath: z.string().optional(),
      replyTo: replyToInput,
      replyLabel: z.string().optional(),
    }),
    async run(args, ctx) {
      if (args.replyTo !== undefined && !isChannelAddr(args.replyTo)) return { output: "replyTo must be channel:<channelId>:<target>.", isError: true };
      const rootId = newId("prj", ctx.clock);
      const item = itemInfo(ctx, args.title, {
        ...(args.outcome ? { outcome: args.outcome } : {}),
        ...(args.replyTo ? { replyTo: args.replyTo as ChannelAddr, replyLabel: args.replyLabel ?? args.replyTo } : {}),
      });
      const plan = fanOutPlan(rootId, item, {
        instruction: args.instruction,
        items: args.items,
        ...(args.label ? { label: args.label } : {}),
        ...(args.research !== undefined ? { research: args.research } : {}),
        ...(args.repoPath ? { repo: { repoPath: args.repoPath } } : {}),
      });
      await startItem(ctx.ports, cfg, plan, { notice: `已开始并行处理 ${args.items.length} 项：${args.title}`, noticeKey: `start:${rootId}` });
      return `Started item ${rootId} with ${args.items.length} workers; the owner was told.`;
    },
  });

  const chaseReplies = tool({
    name: "chase_replies",
    description: [
      "Wait for replies from one or more people (e.g. three suppliers' quotes): their replies on the given threads come straight in and are counted (已回 2/3);",
      "anyone late gets a prepared follow-up the owner confirms on one card. When all (or, with join any, the first) are in, one summary card.",
    ].join(" "),
    input: z.object({
      title: z.string().min(1),
      description: z.string().min(1).describe('what is awaited, e.g. "等待供应商报价回信"'),
      parties: z
        .array(
          z.object({
            label: z.string().min(1),
            to: z.string().optional().describe("channel address follow-ups go to"),
            thread: z.string().optional().describe('thread their reply arrives on, "<channelId>:<threadId>"'),
            principalId: z.string().optional().describe("only this sender counts as their reply"),
            dueAt: z.string().optional().describe("ISO 8601, if different from the overall deadline"),
          }),
        )
        .min(1),
      dueAt: z.string().optional().describe("deadline, ISO 8601 with offset"),
      waitHours: z.number().min(0).optional(),
      join: z.enum(["all", "any"]).optional(),
      interpret: z.boolean().optional().describe("judge each reply with a small model (default: any message from them counts)"),
      nudgeText: z.string().optional(),
      replyTo: replyToInput,
      replyLabel: z.string().optional(),
    }),
    async run(args, ctx) {
      const t = now(ctx);
      const due = args.dueAt !== undefined ? Date.parse(args.dueAt) : t + (args.waitHours !== undefined ? args.waitHours * 3_600_000 : cfg.defaultWaitMs);
      if (Number.isNaN(due)) return { output: `Cannot parse dueAt "${args.dueAt}".`, isError: true };
      const parties: PartyPlan[] = [];
      for (const [i, p] of args.parties.entries()) {
        if (p.to !== undefined && !isChannelAddr(p.to)) return { output: `parties[${i}].to must be channel:<channelId>:<target>.`, isError: true };
        const pd = p.dueAt !== undefined ? Date.parse(p.dueAt) : undefined;
        if (pd !== undefined && Number.isNaN(pd)) return { output: `Cannot parse parties[${i}].dueAt.`, isError: true };
        parties.push({
          id: `p${i + 1}`,
          label: p.label,
          ...(p.to ? { to: p.to as ChannelAddr } : {}),
          ...(p.thread ? { thread: p.thread } : {}),
          ...(p.principalId ? { principalId: p.principalId } : {}),
          ...(pd !== undefined ? { dueAt: pd } : {}),
        });
      }
      if (args.replyTo !== undefined && !isChannelAddr(args.replyTo)) return { output: "replyTo must be channel:<channelId>:<target>.", isError: true };
      const rootId = newId("prj", ctx.clock);
      const item = itemInfo(ctx, args.title, args.replyTo ? { replyTo: args.replyTo as ChannelAddr, replyLabel: args.replyLabel ?? args.replyTo } : {});
      const plan = chasePlan(rootId, item, {
        description: args.description,
        parties,
        dueAt: due,
        ...(args.join ? { join: args.join } : {}),
        ...(args.interpret ? { interpret: true } : {}),
        ...(args.nudgeText ? { nudgeText: args.nudgeText } : {}),
      });
      await startItem(ctx.ports, cfg, plan, { notice: `已开始跟进：${args.description}（${parties.length} 方，${formatWhen(due, cfg.timeZone)} 到期）`, noticeKey: `start:${rootId}` });
      return `Started item ${rootId}: waiting on ${parties.length} replies until ${new Date(due).toISOString()}; the owner was told.`;
    },
  });

  const addSource = tool({
    name: "add_source",
    description: [
      "Add a mailbox source: a scheduled or conditional check (e.g. every Monday 9:00 look at the metrics; watch a group for payment complaints).",
      "It stays silent when nothing is found and posts to you only on a hit. mode observe = only keep observation notes, never create items (for a source the owner does not trust yet).",
      "check: a registered zero-cost check; script: a script path; otherwise a small model filters with your description.",
    ].join(" "),
    input: z.object({
      title: z.string().min(1),
      description: z.string().optional().describe("what counts as a hit"),
      cron: z.string().optional().describe("5-field cron"),
      tz: z.string().optional(),
      watchThread: z.string().optional().describe('watch messages on this thread, "<channelId>:<threadId>"'),
      check: z.string().optional(),
      script: z.string().optional(),
      mode: z.enum(["active", "observe"]).optional(),
    }),
    async run(args, ctx) {
      if (!args.cron && !args.watchThread) return { output: "Give cron or watchThread.", isError: true };
      const processor: ProcessorSpec = args.check
        ? { kind: "code", entry: args.check }
        : args.script
          ? { kind: "code", entry: PROCESSORS.sensorScript, args: { script: args.script } }
          : SENSOR_LLM_PROCESSOR;
      const source: SourceInit = {
        title: args.title,
        ...(args.description ? { description: args.description } : {}),
        kind: args.cron ? "cron" : "watch",
        ...(args.cron ? { schedule: { cron: args.cron, ...(args.tz ? { tz: args.tz } : {}) } } : {}),
        mode: args.mode ?? "active",
        processor: processor.kind,
      };
      const spec: CellSpec = {
        id: newId("src", ctx.clock),
        preset: "sensor",
        title: args.title,
        processor,
        bounds: args.script ? { isolation: "git_worktree", tools: toolKinds("read", "bash") } : { isolation: "none", tools: toolKinds("read") },
        meta: { role: ROLES.sensor, gtd: { source } },
      };
      if (args.cron) spec.schedules = [{ cron: args.cron, ...(args.tz ? { tz: args.tz } : {}) }];
      if (args.watchThread) spec.watches = [{ threadOrFilter: { thread: args.watchThread } }];
      const addr = await ctx.ports.spawnCell(spec, { instruction: args.description ?? args.title });
      await notifyOwner(ctx.ports, owner, `已添加信源：${args.title}${args.mode === "observe" ? "（观察模式，只记笔记不出卡）" : ""}`, `source:${spec.id}`);
      return `Source added (${addr}). It stays silent unless it finds something.`;
    },
  });

  // ---------- steering items in flight ----------

  const steerItem = tool({
    name: "steer_item",
    description: "Pass the owner's new instruction to a background item while it works (takes effect at once, even mid-task).",
    input: z.object({ itemId: z.string().min(1), message: z.string().min(1) }),
    async run(args, ctx) {
      const st = await readCoordinator(ctx.ports, args.itemId).catch(() => null);
      if (!st) return { output: `No background item ${args.itemId} (see the in-flight list).`, isError: true };
      const targets = Object.values(st.slots).filter((s) => s.status === "running" && !s.partyId).map((s) => s.cellId);
      if (st.editor) targets.push(st.editor.cellId);
      if (targets.length === 0) return { output: "Nothing of that item is working right now.", isError: true };
      for (const id of targets) await ctx.ports.controlCell(id, { action: "steer", steerMessage: args.message });
      return `Passed on to ${targets.length} worker(s).`;
    },
  });

  const stopItem = tool({
    name: "stop_item",
    description: "Stop a background item for good (the owner said stop / no longer needed): its work, waits and pending card are cleared and it is marked cancelled.",
    input: z.object({ itemId: z.string().min(1), reason: z.string().optional() }),
    async run(args, ctx) {
      const st = await readCoordinator(ctx.ports, args.itemId).catch(() => null);
      if (!st) return { output: `No background item ${args.itemId}.`, isError: true };
      if (st.finished) return "It has already finished.";
      // A paused item (paused from the owner's project list) must run once more to wind itself down.
      if (ctx.snapshot.tail.roster.some((c) => c.cellId === args.itemId && c.status === "paused")) await ctx.ports.controlCell(args.itemId, { action: "resume" });
      const cmd: GtdCommand = { command: "stop", ...(args.reason ? { reason: args.reason } : {}) };
      const to = `inbox:${args.itemId}` as const;
      await ctx.ports.context.commit(self(ctx), {
        inboxOut: [{ to, envelope: { id: `${args.itemId}:stop`, from: `inbox:${self(ctx)}`, to, principalId: ctx.ports.self.principalId, kind: "event", type: GTD_PAYLOAD.command, payload: cmd, createdAt: now(ctx) } }],
      });
      return "Stopping it now; its records are marked cancelled.";
    },
  });

  const applyUpdates = tool({
    name: "apply_updates",
    description:
      "Background events (reminders that came due, approved proposals, finished background items, sent replies) are applied to the owner's lists automatically when you wake. This shows what was applied and retries anything that failed.",
    input: z.object({}),
    async run(_args, ctx, settled) {
      const lines = [...books.take(ctx.snapshot.runId), ...settled];
      if (lines.length === 0) return "Nothing to apply.";
      return { output: lines.join("\n"), ...(settled.some((l) => l.startsWith(SETTLE_ERROR)) ? { isError: true } : {}) };
    },
  });

  return {
    name: TOOLSETS.desk,
    description: "The desk's GTD tools: captures, reminders, replies on cards, projects and background items.",
    tools: [
      captureNote,
      remindMe,
      archiveNotification,
      draftReply,
      withdrawCard,
      presentToOwner,
      proposeProject,
      delegate,
      fanOut,
      chaseReplies,
      addSource,
      steerItem,
      stopItem,
      applyUpdates,
      reviewWeek,
      suggestSkill,
      suggestCodeCheck,
    ],
  };
}
