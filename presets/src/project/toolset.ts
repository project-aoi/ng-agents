import { z } from "zod";
import { normalizeCwd } from "@ng/cell";
import {
  CELL_STATUS_KEY,
  cellIdOf,
  defineTool,
  gtdKeys,
  isNgError,
  newId,
  type ActionRecord,
  type BallOwner,
  type CellSpec,
  type InboxAddr,
  type ProcessorSpec,
  type ProjectRecord,
  type ToolContext,
  type ToolDef,
  type ToolResult,
  type Toolset,
} from "@ng/protocol";
import { TOOLSETS } from "../shared/config";
import { errorText, isCwdError, parseIso, scheduleInput, toSchedule, toWatch, watchInput } from "../shared/inputs";
import { PROBE, probeProcessor } from "../shared/probe";
import { CHECKER_PROCESSOR, WORKER_PROCESSOR } from "../shared/processors";
import { clip, newAction, newProject, patchAction, patchProject, statusLine } from "../shared/records";
import { readActions, readProject, waitingFor } from "./books";

// `gtd.project`: the project cell's own records — dispatch, track_action, update_project,
// finish_project. Records live in the project's state (gtd:project, gtd:action:<id>); every result says in plain
// words what was recorded and what happens next.

const effort = z.enum(["15m", "45m", "low_energy"]);
const OWNER_LABEL: Readonly<Record<BallOwner, string>> = { agent: "agent", human: "the owner", waiting: "waiting" };

const hasParent = ({ spec }: { spec?: CellSpec }) => spec === undefined || Boolean(spec.parentId);

function describe(a: ActionRecord): string {
  return `${a.id}「${a.title}」(${OWNER_LABEL[a.owner]}${a.cellId ? `, carried by ${a.cellId}` : ""})`;
}

/** The record, created from the cell when a project was started without a seed (plain spawn_cell). */
async function projectOf(ctx: ToolContext): Promise<ProjectRecord> {
  const p = await readProject(ctx.ports);
  if (p) return p;
  const spec = ctx.ports.self.spec;
  return newProject({ title: spec.title ?? ctx.ports.self.cellId }, ctx.clock.now());
}

async function save(ctx: ToolContext, patches: Record<string, unknown>): Promise<void> {
  await ctx.ports.context.commit(ctx.ports.self.cellId, { statePatches: patches });
}

const checkInput = z
  .object({
    command: z
      .string()
      .min(1)
      .describe(
        'a shell command run in the checker\'s directory (the project\'s) whose exit status says yes or no, e.g. "gh pr view 142 --json state -q .state | grep -qx MERGED", "test -d /abs/path/to/dir", "glab ci status --branch feat/x | grep -q success"',
      ),
    everySec: z.number().int().min(PROBE.minEverySec).optional().describe(`seconds between checks (default ${PROBE.everySec}, at least ${PROBE.minEverySec})`),
    until: z
      .enum(["exit_zero", "output_changes"])
      .optional()
      .describe('"exit_zero" (default): it reports when the command exits 0. "output_changes": the first check records what the command prints, and it reports when a later check prints something else'),
    deadlineHours: z.number().positive().optional().describe("stop after this many hours and report failed (default: no deadline)"),
  })
  .describe(
    'checker only — a command that tests the condition. No model runs for such a checker: the command runs now and then every everySec seconds, costing nothing while the answer is "not yet". You are woken once: when the condition holds (with what the command printed), when the deadline passes, or when the command cannot run at all twice in a row (not found, not executable, timed out). Use it whenever an exit status can say yes or no; leave it out when deciding needs reading and judgment.',
  );

/** What a model checker is told about the schedule it was given, so it does not set reminders on top of it. */
function scheduleNote(rules: NonNullable<CellSpec["schedules"]>): string {
  const lines: string[] = [];
  for (const r of rules) {
    if (r.cron) lines.push(`[You are woken on a fixed schedule: cron "${r.cron}"${r.tz ? ` (${r.tz})` : ""}. Do not set reminders of your own — when the answer is "not yet", just wait with waitingFor "external".]`);
    else if (r.deliverAt !== undefined) lines.push(`[You are also woken once at ${new Date(r.deliverAt).toISOString()}.]`);
  }
  return lines.join("\n");
}

function spawnRefusal(err: unknown): ToolResult {
  if (isCwdError(err)) {
    return {
      output: `Not started: ${errorText(err)} Ask the owner for the right absolute path (send_message to the owner, then wait with waitingFor "human") — never guess one.`,
      isError: true,
    };
  }
  return { output: `Not started: ${errorText(err)}`, isError: true };
}

export function projectToolset(): Toolset {
  function tool<S extends z.ZodType>(def: { name: string; description: string; input: S; run(args: z.output<S>, ctx: ToolContext): Promise<ToolResult | string> }): ToolDef {
    return defineTool({ name: def.name, kind: "kernel", description: def.description, input: def.input, availableFor: hasParent, handler: (args, ctx) => def.run(args, ctx) });
  }
  const self = (ctx: ToolContext) => ctx.ports.self.cellId;

  const dispatch = tool({
    name: "dispatch",
    description: [
      "Hand one piece of work to a new child and put it on the books in the same step.",
      'preset "worker" (default): reads or changes code, runs tests, researches. You are woken when its turn is over; it then rests and a send_message to it continues it with everything it knows. preset "checker": a light checker of one outside condition (an MR merged, CI green, a path exists); it looks now, keeps checking, reports when the condition holds and is then closed — with check, a command does the checking and no model runs until it reports.',
      "The child sees nothing of your conversation: the instruction carries everything. It starts at once — nothing queues or locks a directory, so if someone is already changing that repository (the note \"active workspaces\"), say in the instruction how to share it. The action it carries is closed for you when its turn ends well.",
    ].join(" "),
    input: z.object({
      title: z.string().min(1).describe("short Chinese title of this piece of work (shown to the owner)"),
      instruction: z
        .string()
        .min(1)
        .describe("the goal; the directory; what the previous step left (branch, commits, uncommitted changes); material (paths, links, artifact id and version); the owner's preferences; how to verify; what to report"),
      preset: z.enum(["worker", "checker"]).optional().describe('default "worker" ("checker" when check is given)'),
      cwd: z.string().optional().describe("absolute path of the directory it works in. Default: the project's (for a second writer in the same repository, give the path of a git worktree, or tell it in the instruction to create one)"),
      actionId: z.string().optional().describe("an action already on the books that this carries out (e.g. a planned step); default: a new action"),
      phase: z.number().int().min(1).optional().describe("phase of a staged project"),
      modelTier: z.enum(["fast", "strong"]).optional(),
      check: checkInput.optional(),
      watches: z.array(watchInput).optional().describe("checker: messages to route to it (e.g. the MR's thread); each one makes it look at once"),
      schedules: z
        .array(scheduleInput)
        .optional()
        .describe(
          'checker without check, rarely needed: a fixed rhythm to wake it on, as cron (e.g. {"cron": "*/10 * * * *"}), instead of the one reminder at a time it sets itself, fitted to what it saw. It is told so in its task and sets no reminders of its own. Usually leave it out. Not with check (the command keeps its own timer).',
        ),
    }),
    async run(args, ctx) {
      const check = args.check;
      const preset = args.preset ?? (check ? "checker" : "worker");
      // One timer source per checker (BUG-005): a check keeps its own, a model checker either gets a fixed cron
      // rhythm or sets its own reminders.
      if (check && preset !== "checker") return { output: 'Not started: check is for a checker — give preset "checker" (or leave preset out).', isError: true };
      if (check && args.schedules?.length) return { output: "Not started: a checker with check keeps its own timer (check.everySec); leave schedules out.", isError: true };
      const actions = await readActions(ctx.ports);
      const existing = args.actionId !== undefined ? actions.find((a) => a.id === args.actionId) : undefined;
      const base: ProcessorSpec = preset === "checker" ? CHECKER_PROCESSOR : WORKER_PROCESSOR;
      const actionId = existing?.id ?? newId("act", ctx.clock);
      const now = ctx.clock.now();
      const everySec = check?.everySec ?? PROBE.everySec;
      const processor: ProcessorSpec = check
        ? probeProcessor({
            command: check.command,
            everySec,
            until: check.until ?? "exit_zero",
            ...(check.deadlineHours !== undefined ? { deadlineAt: now + check.deadlineHours * 3_600_000 } : {}),
            timeoutMs: Math.min(PROBE.timeoutMs, everySec * 1000),
          })
        : args.modelTier && base.kind === "llm"
          ? { ...base, modelTier: args.modelTier }
          : base;
      const spec: CellSpec = { preset, title: args.title, processor, meta: { gtd: { actionId } } };
      // Default: where the project works — a worker to do the work there, a checker so the repository, its remotes
      // and the forge CLI's context are at hand. Whatever the project passes explicitly is what the child gets.
      const cwd = args.cwd;
      if (cwd) spec.cwd = cwd;
      let addr: InboxAddr;
      let instruction = args.instruction;
      try {
        if (args.watches?.length) spec.watches = args.watches.map((w) => toWatch(w));
        if (args.schedules?.length) spec.schedules = args.schedules.map(toSchedule);
        const note = preset === "checker" && !check && spec.schedules ? scheduleNote(spec.schedules) : "";
        if (note) instruction = `${instruction}\n\n${note}`;
        addr = await ctx.ports.spawnCell(spec, instruction);
      } catch (err) {
        return spawnRefusal(err);
      }
      const childId = cellIdOf(addr);
      const owner: BallOwner = preset === "checker" ? "waiting" : "agent";
      const action = existing
        ? patchAction(existing, { title: args.title, owner, cellId: childId, nextStep: null, ...(existing.status !== "open" ? { status: "open" as const, completedAt: null } : {}), ...(args.phase ? { phase: args.phase } : {}), ...(owner === "waiting" ? { waiting: waitingFor(args.title) } : {}) }, now)
        : newAction(
            { id: actionId, title: args.title, owner, cellId: childId, projectCellId: self(ctx), ...(args.phase ? { phase: args.phase } : {}), ...(owner === "waiting" ? { waiting: waitingFor(args.title) } : {}) },
            now,
          );
      ctx.ports.actionBooks!.write(action);
      const started = `Started ${preset} ${childId} for action ${actionId}「${args.title}」 (recorded as ${owner === "agent" ? "being handled by an agent" : "waiting"}).`;
      const where = cwd ?? ctx.ports.self.spec.cwd;
      const deadline = check?.deadlineHours !== undefined;
      const next = check
        ? ` No model runs for it: it runs \`${clip(check.command, 200)}\` now and then every ${everySec}s${where ? ` in ${where}` : ""}${deadline ? ` for up to ${check.deadlineHours}h` : ""}, at no cost while the answer is "not yet". You are woken once: when the condition holds, ${deadline ? "when the deadline passes, " : ""}or if the command cannot run at all.`
        : ` It is running now; you are woken when its turn is over${preset === "worker" ? " — then inspect_cell shows what it did, and send_message continues it" : ""}.`;
      return { output: started + next, data: { cellId: childId, actionId }, awaitsWakeup: true };
    },
  });

  const trackAction = tool({
    name: "track_action",
    description: [
      "Create or update an action on the project's books — who has the ball for each open piece.",
      'Create (no id): title and owner are required; for owner "human" give a concrete nextStep the owner can act on. Update (id): give only what changes; status "done"/"cancelled" closes it, "open" reopens it.',
    ].join(" "),
    input: z.object({
      id: z.string().optional().describe("the action to update; omit to create one"),
      title: z.string().min(1).optional(),
      owner: z.enum(["agent", "human", "waiting"]).optional(),
      status: z.enum(["open", "done", "cancelled"]).optional(),
      nextStep: z.string().min(1).optional().describe('the next physical step, e.g. "向张三要 Doubao work 的代码，放到 ~/code/doubao"'),
      phase: z.number().int().min(1).optional(),
      artifactId: z.string().optional(),
      effort: effort.optional(),
      dueAt: z.string().optional().describe("ISO 8601 with offset"),
      cellId: z
        .string()
        .optional()
        .describe("the cell of yours carrying it — e.g. a worker you sent more work with send_message; when that cell's turn ends well, the action is closed for you"),
    }),
    async run(args, ctx) {
      const now = ctx.clock.now();
      const due = args.dueAt !== undefined ? parseIso(args.dueAt, "dueAt") : undefined;
      if (typeof due === "string") return { output: due, isError: true };
      if (args.cellId !== undefined && !ctx.ports.isDirectChild(args.cellId)) {
        return { output: `${args.cellId} is not one of your cells (see the list at the end of your wake-up message).`, isError: true };
      }
      const fields = {
        ...(args.title ? { title: args.title } : {}),
        ...(args.owner ? { owner: args.owner } : {}),
        ...(args.nextStep ? { nextStep: args.nextStep } : {}),
        ...(args.phase ? { phase: args.phase } : {}),
        ...(args.artifactId ? { artifactId: args.artifactId } : {}),
        ...(args.effort ? { effort: args.effort } : {}),
        ...(due !== undefined ? { dueAt: due } : {}),
        ...(args.cellId ? { cellId: args.cellId } : {}),
      };
      let action: ActionRecord;
      if (args.id === undefined) {
        if (!args.title || !args.owner) return { output: "A new action needs title and owner.", isError: true };
        action = newAction(
          { ...fields, id: newId("act", ctx.clock), title: args.title, owner: args.owner, projectCellId: self(ctx), ...(args.status ? { status: args.status } : {}), ...(args.owner === "waiting" ? { waiting: waitingFor(args.title) } : {}) },
          now,
        );
      } else {
        const cur = (await readActions(ctx.ports)).find((a) => a.id === args.id);
        if (!cur) return { output: `There is no action ${args.id}; leave id out to create one.`, isError: true };
        action = patchAction(cur, { ...fields, ...(args.status ? { status: args.status } : {}), ...(args.status === "open" ? { completedAt: null } : {}) }, now);
      }
      ctx.ports.actionBooks!.write(action);
      const next =
        action.status !== "open"
          ? "It is closed."
          : action.owner === "human"
            ? `${action.nextStep ? "" : "It has no nextStep yet: the owner sees it on their list without knowing what to do — add the concrete step. "}Tell the owner once (send_message), then wait with waitingFor "human"; you are woken when they tick it off or answer.`
            : action.owner === "agent" && !action.cellId
              ? "Nobody is on it yet: dispatch it with this actionId when it is time — or, when a worker that already knows the work takes it (send_message), record that worker here with cellId."
              : "";
      return { output: `Recorded action ${action.id}「${action.title}」: ${OWNER_LABEL[action.owner]}, ${action.status}. ${next}`.trim(), data: { id: action.id } };
    },
  });

  const updateProject = tool({
    name: "update_project",
    description: "Keep the project's record current: the one-line summary on the owner's board (where things stand), and if they changed, its title, outcome or directory.",
    input: z.object({
      summary: z.string().min(1).optional().describe("one line in Chinese: where things stand"),
      outcome: z.string().min(1).optional().describe("what done looks like"),
      title: z.string().min(1).optional(),
      cwd: z.string().optional().describe("absolute path where the project's work happens now"),
    }),
    async run(args, ctx) {
      const cwd = args.cwd !== undefined ? normalizeCwd(args.cwd) : undefined;
      const now = ctx.clock.now();
      const patch: Partial<ProjectRecord> = {
        ...(args.summary ? { summary: args.summary } : {}),
        ...(args.outcome ? { outcome: args.outcome } : {}),
        ...(args.title ? { title: args.title } : {}),
      };
      if (Object.keys(patch).length === 0 && !cwd) return { output: "Nothing to update.", isError: true };
      if (args.title || args.cwd) await ctx.ports.updateCell(self(ctx),{...(args.title ? {title:args.title} : {}),...(cwd ? {cwd} : {})});
      const next = patchProject(await projectOf(ctx), patch, now);
      await save(ctx, { [gtdKeys.project]: next, ...(args.summary ? { [CELL_STATUS_KEY]: statusLine(clip(args.summary, 200), now) } : {}) });

      return `Project record updated${args.summary ? "; the owner's board shows the new summary" : ""}.`;
    },
  });

  const finishProject = tool({
    name: "finish_project",
    description: [
      "Record the project's end on the owner's board and close (or park) the project cell in one step.",
      '"completed": done and accepted. "someday": parked with everything kept, to be brought back later. "cancelled": stopped; what is still running under the project is stopped with it.',
      "Nothing is checked for you: whether the owner has accepted, whether every piece of accepted work has reported, and whether a habit the owner taught you should be saved first are yours to judge (the result lists the actions that were still open). Child cells still open are named instead of closed, unless closeChildren is true.",
    ].join(" "),
    input: z.object({
      outcome: z.enum(["completed", "cancelled", "someday"]),
      summary: z.string().min(1).describe("what was delivered and where it is (artifact, MR link), or why it stops — plain Chinese"),
      retro: z.string().optional().describe("the reusable habits of the owner you saved as preferences during this project, by name — kept on the record"),
      closeChildren: z.boolean().optional().describe("true: also stop child cells that are still open (always the case for cancelled)"),
    }),
    async run(args, ctx) {
      const { ports } = ctx;
      const now = ctx.clock.now();
      const project = await projectOf(ctx);
      const open = (await readActions(ports)).filter((a) => a.status === "open");
      const force = args.outcome === "cancelled" || args.closeChildren === true;
      const patches: Record<string, unknown> = {};
      // The books follow what happened: a cancelled project's open actions are cancelled with it. For the other
      // outcomes they are left as the project left them and only reported back.
      if (args.outcome === "cancelled") for (const a of open.filter(record => record.owner !== "human")) patches[gtdKeys.action(a.id)] = patchAction(a, { status: "cancelled" }, now);
      const record = patchProject(project, { lifecycle: args.outcome === "someday" ? "active" : args.outcome, summary: args.summary }, now) as ProjectRecord & { retro?: string };
      if (args.retro) record.retro = args.retro;
      patches[gtdKeys.project] = record;
      const label = args.outcome === "completed" ? "已完成" : args.outcome === "cancelled" ? "已停止" : "已放进以后再说";
      patches[CELL_STATUS_KEY] = statusLine(`${label}：${clip(args.summary.split("\n")[0]!, 150)}`, now);
      try {
        if (!ports.settleSelf) return { output: "Project settlement is unavailable.", isError: true };
        await ports.settleSelf({ action: args.outcome === "completed" ? "complete" : args.outcome === "cancelled" ? "cancel" : "pause", summary: args.summary, ...(args.outcome==="someday" ? {pauseReason:"parked" as const} : {}), statePatches: patches, ...(force ? { force: true } : {}) });
      } catch (err) {
        if (isNgError(err, "conflict")) return { output: `Nothing was recorded or closed: ${errorText(err)} Call again with closeChildren: true if stopping them is what you mean.`, isError: true };
        throw err;
      }
      const what = "Requested project settlement after this run drains";
      const left = args.outcome !== "cancelled" && open.length > 0 ? ` Note: these actions were still open on the books — ${open.map(describe).join("; ")}.` : "";
      return { output: `${what}; stop here.${left}`, endRun: "completed" };
    },
  });

  return {
    name: TOOLSETS.project,
    description: "A project's own books: dispatch work, track who has the ball, wait for a reply, keep the record current, finish.",
    tools: [dispatch, trackAction, updateProject, finishProject],
  };
}

