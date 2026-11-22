import {createSensorSpec,sensorProcessor} from "../shared/sensor";
import { z } from "zod";
import {
  anyCovers,
  CELL_STATUS_KEY,
  cellIdOf,
  defineTool,
  gtdKeys,
  isChannelAddr,
  isEnvelopeOfType,
  isNgError,
  newId,
  subjectKeys,
  type ActivityRecord,
  type ApprovalRevisePayload,
  type CellSpec,
  type ChannelAddr,
  type ChannelSendAction,
  type ProcessorSpec,
  type ProjectProposal,
  type ProjectRecord,
  type ProjectStartAction,
  type SendToCellResult,
  type ToolContext,
  type ToolDef,
  type ToolResult,
  type Toolset,
} from "@ng/protocol";
import type { ProjectInit } from "../project/launch";
import { cardDeliverable, prep as cardPrep, proposalCard, responseCard } from "../shared/cards";
import { KEYS, PROCESSORS, ROLES, TOOLSETS, type PresetsConfig } from "../shared/config";
import { errorText, isCwdError, repoInput, watchFilterInput } from "../shared/inputs";
import { notifyOwner } from "../shared/notify";
import { HUB_PROCESSOR, SENSOR_LLM_PROCESSOR, WORKER_PROCESSOR } from "../shared/processors";
import { clip, formatWhen, itemRawInput, itemSource, newActivity } from "../shared/records";
import type { SourceInit } from "../shared/sensor";
import {
  ACKNOWLEDGE_ACTION,
  closeLinkedActions,
  currentItem,
  isRestored,
  launchProject,
  readReplyItems,
  replyAddressOf,
  SETTLE_ERROR,
  settleDesk,
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
    output: "The owner moved this item back from the archive on purpose: it needs a card (present_to_owner, draft_reply, propose_project) or a project (start_project). Do not file it away again.",
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
      await ctx.ports.context.upsertSkillOrNote(self(ctx), { kind: "reference", name: list, description: `${list}（主人随手存下的内容）`, body: line, scope: "cell", mode: "append" });
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
      await ctx.ports.context.commit(self(ctx), { statePatches: { [gtdKeys.activity(id)]: a } });
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
      expectedVersion: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("required when updating a draft the owner edited themselves: read the artifact first and pass its current version"),
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
      subjectKey ??= env ? `reply:${args.to ?? replyAddressOf(env) ?? env.from}:${env.threads?.[0] ?? env.id}` : undefined;
      if (!subjectKey) return { output: "There is no message to reply to in this wake-up; give `to` and use send_message for a new conversation.", isError: true };
      let item = (await readReplyItems(ports)).find(i => i.subjectKey === subjectKey);
      const to = args.to ?? item?.target ?? replyAddressOf(env);
      if (!to || !isChannelAddr(to)) return { output: `No reply address: pass to as channel:<channelId>:<target>.`, isError: true };
      if (anyCovers([`${owner.split(":").slice(0, 2).join(":")}:*`], to)) return { output: "That is the owner's own address: use send_message for notes to the owner.", isError: true };
      const target: ChannelAddr = to;
      const title = args.title ?? item?.title ?? `回复：${clip(itemRawInput(env).text, 40) || "消息"}`;
      const targetLabel = args.targetLabel ?? item?.targetLabel ?? target;

      if (item?.status === "sent" && item.target === target && !revise) return "This reply was already sent.";
      let artifactId = item?.artifactId;
      let version: number;
      const content = { format: "text" as const, title, body: args.text };
      if (artifactId) {
        const cur = await ports.context.getArtifact(artifactId);
        if (!revise && cur?.updatedBy === "agent" && cur.content.body === content.body && cur.content.title === title &&
            cur.content.format === content.format && (args.expectedVersion === undefined || args.expectedVersion === cur.version)) {
          version = cur.version;
        } else {
          // BUG-032: NEVER auto-fill cur.version when cur.updatedBy === "human" (even during revise). Unless the model
          // explicitly read the human's edited version and passed expectedVersion, omit expectedVersion so Context keeps
          // the owner's version untouched and parks the agent's text beside it.
          const expected =
            args.expectedVersion !== undefined
              ? args.expectedVersion
              : cur && cur.updatedBy === "agent"
                ? cur.version
                : undefined;
          const r = await ports.context.commit(self(ctx), { artifact: { artifactId, content, updatedBy: "agent", ...(expected !== undefined ? { expectedVersion: expected } : {}) } });
          if (!r.ok && r.parked && item) {
            return `The owner has edited this draft themselves (v${r.currentArtifact.version}): their text and their card stay as they are, and your new version was put beside it for them to use. Read the artifact first and pass expectedVersion: ${r.currentArtifact.version} if they asked you to revise their edited text.`;
          }
          if (!r.ok) return { output: `The draft changed meanwhile (now v${r.currentArtifact.version} by ${r.currentArtifact.updatedBy}); read it and redraft.`, isError: true };
          version = r.artifactVersion ?? (cur?.version ?? 0) + 1;
        }
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
      const r = await ports.submitReply(action, version, revise?.id ?? env?.id ?? subjectKey);
      if (r.type === "deny") return { output: `Not allowed: ${r.feedback}`, isError: true };
      if (r.type === "delivery") {
        const sent = r.receipt === "sent";
        const statePatches: Record<string, unknown> = {};
        if (sent) {
          const done = newActivity(
            { id: `sent-${r.actionId}`, kind: "action_completed", title: `已回复${targetLabel}：${title}`, source: item.source, rawInput: item.rawInput.text, actionId: r.actionId, restorable: false }, t,
          );
          statePatches[gtdKeys.activity(done.id)] = done;
        }
        if (sent) await ports.context.commit(self(ctx), { statePatches });
        const messages = {
          sent: "A standing rule allowed it: sent (sent).",
          failed: "Delivery failed. The owner can retry on the failed-send card.",
          unknown: "Delivery status is unknown. The owner must verify the receipt before retrying.",
          pending: "This reply is already being sent. Wait for its receipt.",
          cancelled: "The owner closed this reply.",
        };
        return { output: `${messages[r.receipt]} Action ${r.actionId}, draft ${artifactId}.`, isError: !sent, data: { receipt: r.receipt, actionId: r.actionId } };
      }
      return { output: `Draft v${version} (${artifactId}) is on the owner's card ${r.actionId}. Nothing is sent until they confirm.`, endRun: "deferred_for_approval", data: { actionId: r.actionId, artifactId, version } };
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
      if (r !== "cancelled") return "This card has already been decided.";
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
      await ports.context.commit(self(ctx), { statePatches: { [gtdKeys.activity(a.id)]: a, ...linked } });
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

  // ---------- projects ----------

  const planInput = z
    .array(
      z.object({
        title: z.string().min(1),
        owner: z.enum(["agent", "human", "waiting"]),
        nextStep: z.string().optional(),
        phase: z.number().int().min(1).optional(),
      }),
    )
    .describe("first steps, if you already know them (recorded on the project's books; the project plans the rest)");

  const cwdRefusal = (err: unknown): ToolResult => ({
    output: `Not started: ${errorText(err)} Ask the owner for the absolute path of the repository on this machine (send_message to ${owner}, then wait with waitingFor "human") — never guess one.`,
    isError: true,
  });

  const startProject = tool({
    name: "start_project",
    description: [
      "Start a project for anything that takes more than a quick lookup (a task, a todo, a code change, research, an idea). A persistent project cell plans it, keeps its records and its report, and hands every piece of heavy work to workers; it starts at once and the owner gets a short notice.",
      "Put everything it needs into brief: the owner's exact words, constraints, links, what to deliver. cwd is the absolute path of the repository on this machine — ask the owner when you do not know it.",
      'mode "research_then_park" for an idea the owner only wants to keep for later: the project researches what it should be, saves a report and parks itself as someday.',
    ].join(" "),
    input: z.object({
      title: z.string().min(1).describe("short Chinese title shown in the owner's project list"),
      outcome: z.string().min(1).describe("what done looks like"),
      brief: z.string().min(1).describe("the request in full: the owner's words, constraints, links, what to deliver"),
      cwd: z.string().optional().describe("absolute path of the directory the work happens in"),
      repos: z.array(repoInput).optional().describe("the repositories involved, when there are several"),
      mode: z.enum(["now", "research_then_park"]).optional(),
      phases: z.array(z.string().min(1)).optional().describe("staged work: phases in order; the project runs one at a time, each after the owner's go-ahead"),
      plan: planInput.optional(),
      replyTo: replyToInput,
      replyLabel: z.string().optional(),
      continueConversation: z.boolean().optional().describe("the project continues from this conversation (it sees what you just discussed)"),
    }),
    async run(args, ctx) {
      if (args.replyTo !== undefined && !isChannelAddr(args.replyTo)) return { output: "replyTo must be channel:<channelId>:<target>.", isError: true };
      const env = currentItem(ctx);
      const raw = itemRawInput(env).text;
      const init: ProjectInit = {
        title: args.title,
        outcome: args.outcome,
        brief: args.brief,
        source: itemSource(env, now(ctx)),
        ...(raw ? { rawInput: raw } : {}),
        ...(args.cwd ? { cwd: args.cwd } : {}),
        ...(args.repos?.length ? { repos: args.repos.map((r) => ({ name: r.name, cwd: r.cwd, ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}) })) } : {}),
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.phases?.length ? { phases: args.phases } : {}),
        ...(args.plan?.length ? { plan: args.plan.map((a) => ({ title: a.title, owner: a.owner, ...(a.nextStep ? { nextStep: a.nextStep } : {}), ...(a.phase ? { phase: a.phase } : {}) })) } : {}),
        ...(args.replyTo ? { replyTo: args.replyTo as ChannelAddr, replyLabel: args.replyLabel ?? args.replyTo } : {}),
        ...(args.continueConversation ? { continueConversation: true } : {}),
      };
      let r: { projectId: string; started: boolean };
      try {
        r = await launchProject(ctx.ports, init, ctx.clock);
      } catch (err) {
        if (isCwdError(err)) return cwdRefusal(err);
        return { output: `Not started: ${errorText(err)}`, isError: true };
      }
      const park = args.mode === "research_then_park";
      await notifyOwner(ctx.ports, owner, park ? `已记下：${args.title}，先做个调研，完成后放进以后再说` : `已立项：${args.title}，后台开始推进`, `start:${r.projectId}`);
      return `Started project ${r.projectId}「${args.title}」 and told the owner. Pass later changes to it with steer_item; stop it with stop_item.`;
    },
  });

  const proposeProject = tool({
    name: "propose_project",
    description: [
      "Propose a project whose plan needs the owner's sign-off first (large, costly, or built on assumptions): one proposal card where the owner can edit the plan, approve it, or park it for later.",
      "On approval the project starts with the plan they approved (you are woken; apply_updates shows it).",
    ].join(" "),
    input: z.object({
      title: z.string().min(1),
      outcome: z.string().min(1).describe("what done looks like"),
      background: z.string().optional(),
      actions: z.array(z.object({ title: z.string().min(1), owner: z.enum(["agent", "human", "waiting"]), effort: effort.optional(), nextStep: z.string().optional() })).min(1),
      prep: prepInput.optional(),
      cwd: z.string().optional().describe("absolute path of the directory the work happens in"),
      repos: z.array(repoInput).optional(),
      phases: z.array(z.string().min(1)).optional(),
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
        ...(args.cwd ? { cwd: args.cwd } : {}),
        ...(args.repos ? { repos: args.repos } : {}),
        ...(args.phases ? { phases: args.phases } : {}),
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
      };
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
      if (r.type === "allow") {
        // BUG-032: standing rule allowed project.start directly — launch the project now and return projectId.
        const init: ProjectInit = {
          title: proposal.title,
          outcome: proposal.outcome,
          brief: ["已按主人的常设规则自动确认立项，按此方案开始推进。", proposal.background ?? ""].filter(Boolean).join("\n"),
          proposal,
          plan: proposal.actions.map((a) => ({ title: a.title, owner: a.owner, ...(a.nextStep ? { nextStep: a.nextStep } : {}), ...(a.effort ? { effort: a.effort } : {}) })),
          source: remembered.source,
          ...(remembered.rawInput.text ? { rawInput: remembered.rawInput.text } : {}),
          ...(proposal.cwd ? { cwd: proposal.cwd } : {}),
          ...(proposal.repos?.length ? { repos: proposal.repos } : {}),
          ...(proposal.phases?.length ? { phases: proposal.phases } : {}),
        };
        let launched: { projectId: string; started: boolean };
        try {
          launched = await launchProject(ports, init, ctx.clock);
        } catch (err) {
          if (isCwdError(err)) return cwdRefusal(err);
          return { output: `Not started: ${errorText(err)}`, isError: true };
        }
        await notifyOwner(ports, owner, `已按常设规则自动立项：${proposal.title}，后台开始推进`, `project:${launched.projectId}`);
        return {
          output: `A standing rule allowed it: started project ${launched.projectId}「${proposal.title}」 and told the owner.`,
          data: { projectId: launched.projectId, artifactId, started: launched.started },
        };
      }
      return { output: `The proposal card ${r.actionId} (draft ${artifactId}) is waiting for the owner; you are woken with the decision.`, endRun: "deferred_for_approval", data: { actionId: r.actionId, artifactId } };
    },
  });

  // ---------- items in flight: steer, stop, bring back ----------

  const closedItem = (id: string) =>
    `${id} has finished (it is closed): nothing was delivered. For more work on the same subject, start_project with a brief that names what it delivered (read_artifact with its cellId lists its reports); if you meant a parked item, use reactivate_item.`;

  function sendResult(id: string, r: SendToCellResult, delivered: string): ToolResult {
    switch (r.status) {
      case "delivered":
        return r.targetStatus === "paused"
          ? { output: `${id} is parked: it reads this when it is resumed (reactivate_item resumes it now).` }
          : { output: delivered };
      case "closed":
        return { output: closedItem(id), isError: true };
      case "not_found":
        return { output: `There is no item ${id}; check the id in the in-flight list.`, isError: true };
      case "refused":
        return { output: `Not allowed: ${r.reason}.`, isError: true };
    }
  }

  const steerItem = tool({
    name: "steer_item",
    description:
      "Pass the owner's new instruction or extra requirement to a project (or hub) in flight; it carries it out at its next turn, with the worker that already knows the work or a new one. urgent: it interrupts what the item is doing right now.",
    input: z.object({
      itemId: z.string().min(1),
      message: z.string().min(1).describe("the owner's words and anything the project needs with them"),
      urgent: z.boolean().optional(),
    }),
    async run(args, ctx) {
      const { ports } = ctx;
      if (args.urgent) {
        let r;
        try {
          r = await ports.controlCell(args.itemId, { action: "steer", steerMessage: args.message });
        } catch (err) {
          return { output: `There is no item ${args.itemId} under the desk (${errorText(err)}).`, isError: true };
        }
        if (r.applied) return `Passed on to ${args.itemId} at once; it takes it between its current steps.`;
        if (r.reason === "closed") return { output: closedItem(args.itemId), isError: true };
        return { output: `Not passed on: ${r.reason ?? "refused"}.`, isError: true };
      }
      if (!ports.sendToCell) return { output: "Messages to items are not available in this environment.", isError: true };
      const r = await ports.sendToCell(`inbox:${args.itemId}`, { text: args.message, summary: "主人的新要求", id: `${ctx.snapshot.runId}:${ctx.toolUseId}:steer` });
      return sendResult(args.itemId, r, `Passed on to ${args.itemId}; it takes it at its next turn.`);
    },
  });

  const stopItem = tool({
    name: "stop_item",
    description: "Stop a project (or hub) for good — the owner said stop, or it is no longer needed: its workers, waits and pending cards are cleared and its records are marked cancelled.",
    input: z.object({ itemId: z.string().min(1), reason: z.string().optional() }),
    async run(args, ctx) {
      const noItem = { output: `There is no item ${args.itemId} under the desk.`, isError: true };
      let before: ProjectRecord | null;
      try {
        before = await ctx.ports.context.readState<ProjectRecord>(args.itemId, gtdKeys.project);
        await ctx.ports.closeCell(args.itemId, "cancelled");
      } catch (err) {
        if (isNgError(err, "bounds_violation") || isNgError(err, "not_found")) return noItem;
        throw err;
      }
      const ended = before ? before.lifecycle === "completed" || before.lifecycle === "cancelled" : !ctx.snapshot.tail.roster.some((c) => c.cellId === args.itemId);
      if (ended) return `${args.itemId} had already ended${before ? ` (${before.lifecycle})` : ""}; nothing changed.`;
      return `Stopped ${args.itemId}${args.reason ? `（${args.reason}）` : ""}: everything it had running is cleared and its records say cancelled.`;
    },
  });

  const reactivateItem = tool({
    name: "reactivate_item",
    description:
      "Bring a parked project (someday, or paused) back: it is resumed and gets the owner's words; it continues from its records and its report instead of starting over.",
    input: z.object({ itemId: z.string().min(1), message: z.string().min(1).describe("what the owner said: go ahead, the changed scope, the next phase") }),
    async run(args, ctx) {
      const { ports } = ctx;
      let r;
      try {
        r = await ports.controlCell(args.itemId, { action: "resume" });
      } catch (err) {
        return { output: `There is no item ${args.itemId} under the desk (${errorText(err)}).`, isError: true };
      }
      if (!r.applied && r.reason === "closed") {
        const arts = await ports.context.listArtifacts(args.itemId).catch(() => []);
        const p = await ports.context.readState<ProjectRecord>(args.itemId, gtdKeys.project).catch(() => null);
        const left = [
          arts.length ? `its artifacts: ${arts.map((a) => `${a.artifactId} v${a.version}${a.content.title ? `「${a.content.title}」` : ""}`).join(", ")}` : "",
          p?.proposal ? `its plan: ${p.proposal.outcome}; ${p.proposal.actions.map((a) => a.title).join("、")}` : "",
          p?.summary ? `where it stood: ${p.summary}` : "",
        ].filter(Boolean);
        return {
          output: `${args.itemId} is closed (an item from before projects could be parked), so it cannot be resumed. Start a new project with start_project and name in its brief what the old one left${left.length ? ` — ${left.join("; ")}` : ""}, so nothing is redone.`,
          isError: true,
        };
      }
      if (!r.applied) return { output: `Not resumed: ${r.reason ?? "refused"}.`, isError: true };
      if (!ports.sendToCell) return { output: "Messages to items are not available in this environment.", isError: true };
      const s = await ports.sendToCell(`inbox:${args.itemId}`, { text: args.message, summary: "主人要继续推进", id: `${ctx.snapshot.runId}:${ctx.toolUseId}:resume` });
      return sendResult(args.itemId, s, `Resumed ${args.itemId} and passed on the owner's words; it continues from its records and report.`);
    },
  });

  // ---------- hubs and sources ----------

  const addHub = tool({
    name: "add_hub",
    description: [
      "Add a hub: a persistent front door for one stream of direct messages (code review requests, incident pings, task requests for a set of repositories).",
      "Messages matching watch go straight to it instead of the desk, batched over coalesceMinutes; it sends each topic to a worker in the right repository and forwards follow-ups. Off-topic messages come back to you.",
    ].join(" "),
    input: z.object({
      title: z.string().min(1).describe('short Chinese name, e.g. "代码评审直通"'),
      repos: z.array(repoInput).min(1),
      rules: z.string().min(1).describe("what belongs to it and how each kind of request is handled (review, investigate, fix), in plain words"),
      watch: z.object({ thread: z.string().optional().describe('"<channelId>:<threadId>"'), filter: watchFilterInput.optional() }),
      coalesceMinutes: z.number().min(0).max(60).optional().describe("batching window (default 2)"),
    }),
    async run(args, ctx) {
      if (!args.watch.thread && !args.watch.filter) return { output: "watch needs a thread or a filter (otherwise nothing reaches the hub).", isError: true };
      const id = newId("hub", ctx.clock);
      const coalesceMs = Math.round((args.coalesceMinutes ?? 2) * 60_000);
      const repos = args.repos.map((r) => ({ name: r.name, cwd: r.cwd, ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}) }));
      const source: SourceInit = { title: args.title, description: args.rules, kind: "channel", mode: "active", processor: "llm" };
      const spec: CellSpec = {
        id,
        preset: "hub",
        title: args.title,
        processor: HUB_PROCESSOR,
        watches: [{ threadOrFilter: { ...(args.watch.filter ?? {}), ...(args.watch.thread ? { thread: args.watch.thread } : {}) }, ...(coalesceMs > 0 ? { coalesceMs } : {}) }],
        meta: { role: ROLES.hub, gtd: { source } },
      };
      const instruction = [
        `你是「${args.title}」的直通入口。`,
        "## 负责的仓库",
        ...repos.map((r) => `- ${r.name}：${r.cwd}${r.defaultBranch ? `（默认分支 ${r.defaultBranch}）` : ""}`),
        "## 规则",
        args.rules,
      ].join("\n");
      try {
        await ctx.ports.spawnCell(spec, { instruction, input: { repos, rules: args.rules } });
      } catch (err) {
        return { output: `Not added: ${errorText(err)}`, isError: true };
      }
      await notifyOwner(ctx.ports, owner, `已添加直通入口：${args.title}`, `hub:${id}`);
      return `Hub ${id} added and the owner was told: matching messages now go straight to it${coalesceMs > 0 ? `, batched over ${args.coalesceMinutes ?? 2} minute(s)` : ""}.`;
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
        ? sensorProcessor(args.check)
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
      const spec = createSensorSpec(newId("src",ctx.clock),source,processor,args.watchThread);
      const addr = await ctx.ports.spawnCell(spec, { instruction: args.description ?? args.title });
      await notifyOwner(ctx.ports, owner, `已添加信源：${args.title}${args.mode === "observe" ? "（观察模式，只记笔记不出卡）" : ""}`, `source:${spec.id}`);
      return `Source added (${addr}). It stays silent unless it finds something.`;
    },
  });

  const applyUpdates = tool({
    name: "apply_updates",
    description:
      "Background events (reminders that came due, approved proposals, sent replies, finished projects) are applied to the owner's lists automatically when you wake. This shows what was applied and retries anything that failed.",
    input: z.object({}),
    async run(_args, ctx, settled) {
      const lines = [...books.take(ctx.snapshot.runId), ...settled];
      if (lines.length === 0) return "Nothing to apply.";
      return { output: lines.join("\n"), ...(settled.some((l) => l.startsWith(SETTLE_ERROR)) ? { isError: true } : {}) };
    },
  });

  return {
    name: TOOLSETS.desk,
    description: "The desk's GTD tools: captures, reminders, replies on cards, projects, hubs and sources, arbitration.",
    tools: [
      captureNote,
      remindMe,
      archiveNotification,
      draftReply,
      withdrawCard,
      presentToOwner,
      startProject,
      proposeProject,
      steerItem,
      stopItem,
      reactivateItem,
      addHub,
      addSource,
      applyUpdates,
      reviewWeek,
      suggestSkill,
      suggestCodeCheck,
    ],
  };
}
