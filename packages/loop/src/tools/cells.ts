import { z } from "zod";
import {
  cellIdOf,
  defineTool,
  isAddress,
  PRESET_NAMES,
  TOOL_KINDS,
  ISOLATION_LEVELS,
  type Address,
  type CellSpec,
  type PolicyBounds,
  type ProcessorSpec,
  type Registry,
  type ScheduleRule,
  type Toolset,
} from "@ng/protocol";

export const CELLS_TOOLSET = "kernel.cells";

const watchInput = z.object({
  thread: z.string().optional().describe('external thread id "<channelId>:<threadId>", e.g. "github:org/repo#108"'),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'match on envelope fields (type, principalId, from) or payload.<key> (payload.text, payload.eventKind, payload.mentions, payload.tags, payload.sender.id). A value is compared for equality, or use one operator: {"$in": [..]}, {"$contains": "x"} (substring of a string / element of a list, case-insensitive), {"$anyKeyword": ["a", "b"]}',
    ),
  cancelGroup: z.string().optional(),
  coalesceMinutes: z
    .number()
    .min(0)
    .max(24 * 60)
    .optional()
    .describe("batch what this watch routes: messages that arrive within this window after the first one are delivered together (a fixed window; while the cell is running they reach it at once)"),
});
const scheduleInput = z.object({
  at: z.string().optional().describe("ISO 8601 time with offset, one-shot"),
  cron: z.string().optional(),
  tz: z.string().optional().describe("IANA timezone for cron"),
  idleSec: z.number().int().min(1).optional(),
  cancelGroup: z.string().optional(),
});

const boundsInput = z.object({
  tools: z.array(z.enum(TOOL_KINDS)).optional(),
  canSendTo: z.array(z.string()).optional().describe("channel addresses the child may send to (inboxes are always reachable)"),
  secretRefs: z.array(z.string()).optional(),
  isolation: z.enum(ISOLATION_LEVELS).optional(),
  maxConcurrentChildren: z.number().int().min(0).optional(),
  maxTokens: z.number().int().min(0).optional(),
  maxCents: z.number().min(0).optional(),
  maxDepth: z.number().int().min(0).optional(),
});

function toWatches(watches: Array<z.infer<typeof watchInput>>): NonNullable<CellSpec["watches"]> {
  return watches.map((w) => ({
    threadOrFilter: { ...w.filter, ...(w.thread ? { thread: w.thread } : {}) },
    ...(w.cancelGroup ? { cancelGroup: w.cancelGroup } : {}),
    ...(w.coalesceMinutes ? { coalesceMs: Math.round(w.coalesceMinutes * 60_000) } : {}),
  }));
}

function toSchedules(schedules: Array<z.infer<typeof scheduleInput>>): ScheduleRule[] {
  return schedules.map((s) => {
    const rule: ScheduleRule = {};
    if (s.at) {
      const t = Date.parse(s.at);
      if (Number.isNaN(t)) throw new Error(`invalid schedule time "${s.at}" (use ISO 8601 with an offset)`);
      rule.deliverAt = t;
    }
    if (s.cron) rule.cron = s.cron;
    if (s.tz) rule.tz = s.tz;
    if (s.idleSec) rule.idleSec = s.idleSec;
    if (s.cancelGroup) rule.cancelGroup = s.cancelGroup;
    if ([rule.deliverAt, rule.cron, rule.idleSec].filter((v) => v !== undefined).length !== 1) {
      throw new Error("each schedule needs exactly one of at, cron or idleSec");
    }
    return rule;
  });
}

function toBounds(b: z.infer<typeof boundsInput>): Partial<PolicyBounds> {
  const out: { -readonly [K in keyof PolicyBounds]?: PolicyBounds[K] } = {};
  if (b.tools) out.tools = new Set(b.tools);
  if (b.canSendTo) {
    const bad = b.canSendTo.filter((a) => !isAddress(a) && !/^(inbox:|channel:).*\*$/.test(a));
    if (bad.length) throw new Error(`not addresses: ${bad.join(", ")}`);
    out.canSendTo = b.canSendTo as Address[];
  }
  if (b.secretRefs) out.secretRefs = new Set(b.secretRefs);
  if (b.isolation) out.isolation = b.isolation;
  if (b.maxConcurrentChildren !== undefined) out.maxConcurrentChildren = b.maxConcurrentChildren;
  if (b.maxTokens !== undefined) out.maxTokens = b.maxTokens;
  if (b.maxCents !== undefined) out.maxCents = b.maxCents;
  if (b.maxDepth !== undefined) out.maxDepth = b.maxDepth;
  return out;
}

const canSpawn = ({ bounds }: { bounds: PolicyBounds }) => bounds.maxDepth > 0;

/**
 * `kernel.cells`: spawn_cell, update_cell, control_cell, close_cell. All but update_cell (own watches/schedules) need `bounds.maxDepth > 0`.
 * The kernel attenuates the requested bounds (child ⊆ parent) and enforces maxConcurrentChildren; control is limited to
 * descendants by Gate.
 */
export function cellsToolset(registry: Registry): Toolset {
  const spawnCell = defineTool({
    name: "spawn_cell",
    kind: "kernel",
    availableFor: canSpawn,
    description: [
      "Start a child cell for work that should not block you. It runs in the background and reports to your inbox (cell.result / cell.progress); your in-flight cells are listed at the end of every wake-up message.",
      "Presets — worker: a one-shot executor for one piece of work (reads/changes code, runs commands, researches); it reports once and the kernel closes it. project: a persistent coordinator that owns one outcome over many steps (keeps the plan, the records and the shared artifacts; hands every piece of heavy work to one-shot workers). watcher: a light one-shot checker that looks at a condition now and then (an MR merged? a reply arrived? a file appeared?) and reports when it holds. sensor: a persistent scheduled source. hub: a persistent router for one stream of direct messages. inline: a light helper.",
      "cwd is the directory on this machine the child works in (an absolute path that exists; ask the owner when you do not know it — never guess). cwdMode read = analysis only, runs in parallel with anything; write = may change files and run commands — the kernel lets one writer at a time into a work tree and queues the rest, so just spawn. A child without cwd inherits yours.",
      "Its permissions are always a subset of yours. Give it everything it needs in the instruction: it does not see your conversation (unless contextMode fork_prefix).",
    ].join(" "),
    input: z.object({
      preset: z.enum(PRESET_NAMES),
      title: z.string().min(1).describe("short name shown to the user"),
      instruction: z.string().min(1).describe("what to do, the context it needs (branch, earlier findings, artifact ids), what done looks like, what to report back"),
      input: z.unknown().optional().describe("structured data for the child"),
      cwd: z.string().optional().describe("absolute path of the directory it works in; default: yours"),
      cwdMode: z.enum(["read", "write"]).optional().describe("default: write for worker/watcher/sensor, read for project/hub/inline"),
      contextMode: z.enum(["isolated", "fork_prefix"]).optional(),
      modelTier: z.enum(["fast", "strong"]).optional(),
      allowedTools: z.array(z.enum(TOOL_KINDS)).optional().describe("workspace tools the child's model may see"),
      toolsets: z.array(z.string()).optional().describe("replaces the preset's toolsets"),
      code: z
        .object({ entry: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() })
        .optional()
        .describe("run a registered code processor or script:<path> instead of a model"),
      bounds: boundsInput.optional(),
      watches: z.array(watchInput).optional(),
      schedules: z.array(scheduleInput).optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
    }),
    async handler(args, ctx) {
      const preset = registry.presets.get(args.preset);
      if (!preset) return { output: `Preset "${args.preset}" is not available.`, isError: true };
      let processor: ProcessorSpec;
      const base = preset.defaults.processor;
      if (args.code) {
        processor = { kind: "code", entry: args.code.entry, ...(args.code.args ? { args: args.code.args } : {}) };
      } else if (base?.kind === "code") {
        processor = base;
      } else {
        processor = {
          ...(base ?? { kind: "llm" as const }),
          ...(args.modelTier ? { modelTier: args.modelTier } : {}),
          ...(args.allowedTools ? { allowedTools: args.allowedTools } : {}),
          ...(args.toolsets ? { toolsets: args.toolsets } : {}),
        };
      }
      const spec: CellSpec = { preset: args.preset, title: args.title, processor };
      if (args.cwd) spec.cwd = args.cwd;
      if (args.cwdMode) spec.cwdMode = args.cwdMode;
      if (args.contextMode) spec.contextMode = args.contextMode;
      if (args.bounds) spec.bounds = toBounds(args.bounds);
      if (args.watches?.length) spec.watches = toWatches(args.watches);
      if (args.schedules?.length) spec.schedules = toSchedules(args.schedules);
      if (args.meta && Object.keys(args.meta).length) spec.meta = args.meta;
      const addr = await ctx.ports.spawnCell(spec, args.input === undefined ? args.instruction : { instruction: args.instruction, input: args.input });
      const mode = args.cwdMode ?? preset.defaults.cwdMode ?? "read";
      const queue = mode === "write" ? " If another cell is writing in the same work tree it starts when that one is done — nothing for you to manage." : "";
      return {
        output: `Spawned "${args.title}" (${args.preset}) as ${addr} — cell id ${cellIdOf(addr)}. It reports back to your inbox.${queue}`,
        data: { addr },
        // It will wake this cell with its result: a run that ends here is waiting, not finished.
        awaitsWakeup: true,
      };
    },
  });
  const updateCell = defineTool({
    name: "update_cell",
    kind: "kernel",
    description:
      "Change a cell's title, watches, schedules or meta (given fields replace the old ones). cellId is a child's id — or leave it out to change your own watches/schedules, e.g. to start watching a thread or drop a schedule you no longer need.",
    input: z.object({
      cellId: z.string().min(1).optional().describe("default: this cell"),
      title: z.string().min(1).optional(),
      watches: z.array(watchInput).optional(),
      schedules: z.array(scheduleInput).optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
    }),
    async handler(args, ctx) {
      const patch: Partial<CellSpec> = {};
      if (args.title) patch.title = args.title;
      if (args.watches) patch.watches = toWatches(args.watches);
      if (args.schedules) patch.schedules = toSchedules(args.schedules);
      if (args.meta) patch.meta = args.meta;
      if (Object.keys(patch).length === 0) return { output: "Nothing to update.", isError: true };
      const target = args.cellId ?? ctx.ports.self.cellId;
      await ctx.ports.updateCell(target, patch);
      return `Updated ${target === ctx.ports.self.cellId ? "this cell" : target}: ${Object.keys(patch).join(", ")}.`;
    },
  });
  const controlCell = defineTool({
    name: "control_cell",
    kind: "kernel",
    availableFor: canSpawn,
    description:
      "Urgent control of a descendant cell, bypassing its queue: steer (a correction that reaches it between its steps — on some engines it interrupts the current turn — or wakes it), pause, resume. For an ordinary follow-up that can wait for its current step, use send_message to inbox:<cellId> instead.",
    input: z.object({
      cellId: z.string().min(1),
      action: z.enum(["steer", "pause", "resume"]),
      message: z.string().optional().describe("required for steer"),
    }),
    async handler(args, ctx) {
      if (args.action === "steer" && !args.message) return { output: "steer needs a message.", isError: true };
      const r = await ctx.ports.controlCell(args.cellId, {
        action: args.action,
        ...(args.message !== undefined ? { steerMessage: args.message } : {}),
      });
      if (r.applied) return { output: `${args.action} applied to ${args.cellId}.`, data: r };
      const closed = /closed/i.test(r.reason ?? "");
      return {
        output: closed
          ? `NOT APPLIED — ${args.cellId} is closed (it already finished). If the work still needs doing, start a new worker with spawn_cell and give it the context.`
          : `Not applied to ${args.cellId}: ${r.reason ?? "refused"}.`,
        isError: true,
        data: r,
      };
    },
  });

  const closeCell = defineTool({
    name: "close_cell",
    kind: "kernel",
    availableFor: canSpawn,
    description:
      "Finish (completed) or abort (cancelled) a descendant cell and its whole subtree: its runs, background jobs, watches and pending timers are stopped and late results are ignored. Files, branches and directories are left exactly as they are.",
    input: z.object({ cellId: z.string().min(1), reason: z.enum(["completed", "cancelled"]).optional() }),
    async handler(args, ctx) {
      await ctx.ports.closeCell(args.cellId, args.reason ?? "completed");
      return `Closed ${args.cellId} (${args.reason ?? "completed"}).`;
    },
  });

  return {
    name: CELLS_TOOLSET,
    description: "Spawn, steer and close child cells (requires maxDepth > 0).",
    tools: [spawnCell, updateCell, controlCell, closeCell],
  };
}

