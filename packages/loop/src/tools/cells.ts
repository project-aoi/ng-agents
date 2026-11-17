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
  filter: z.record(z.string(), z.unknown()).optional().describe("equality filter on envelope fields (type, principalId, from) or payload.<key>"),
  cancelGroup: z.string().optional(),
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
  canSendTo: z.array(z.string()).optional().describe("addresses; default is only your inbox"),
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
 * `kernel.cells`: spawn_cell, update_cell, control_cell, close_cell. Exposed only when `bounds.maxDepth > 0`.
 * The kernel attenuates the requested bounds (child ⊆ parent) and enforces maxConcurrentChildren; control is limited to
 * descendants by Gate.
 */
export function cellsToolset(registry: Registry): Toolset {
  const spawnCell = defineTool({
    name: "spawn_cell",
    kind: "kernel",
    availableFor: canSpawn,
    description: [
      "Start a child cell for work that should not block you: worker (own sandbox; code, research, multi-step tasks), watcher (waits for external replies / timeouts), sensor (scheduled or conditional check), inline (a light helper).",
      "It runs in the background and reports back to your inbox (cell.result / cell.progress); in-flight children are listed at the end of each wake-up message.",
      "Its permissions are always a subset of yours. Use contextMode fork_prefix when it should continue from this conversation.",
    ].join(" "),
    input: z.object({
      preset: z.enum(PRESET_NAMES),
      title: z.string().min(1).describe("short name shown to the user"),
      instruction: z.string().min(1).describe("what to do, what done looks like, what to report back"),
      input: z.unknown().optional().describe("structured data for the child"),
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
      workspace: z
        .object({ repoPath: z.string().optional(), baseRef: z.string().optional(), branch: z.string().optional() })
        .optional()
        .describe("repository the child's git worktree starts from"),
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
      const meta: Record<string, unknown> = { ...args.meta };
      if (args.workspace) meta["workspace"] = args.workspace;
      const spec: CellSpec = { preset: args.preset, title: args.title, processor };
      if (args.contextMode) spec.contextMode = args.contextMode;
      if (args.bounds) spec.bounds = toBounds(args.bounds);
      if (args.watches?.length) spec.watches = toWatches(args.watches);
      if (args.schedules?.length) spec.schedules = toSchedules(args.schedules);
      if (Object.keys(meta).length) spec.meta = meta;
      const addr = await ctx.ports.spawnCell(spec, args.input === undefined ? args.instruction : { instruction: args.instruction, input: args.input });
      return { output: `Spawned "${args.title}" (${args.preset}) as ${addr} — cell id ${cellIdOf(addr)}. It will report back to your inbox.`, data: { addr } };
    },
  });

  const updateCell = defineTool({
    name: "update_cell",
    kind: "kernel",
    availableFor: canSpawn,
    description: "Change a child cell's title, watches, schedules or meta (given fields replace the old ones).",
    input: z.object({
      cellId: z.string().min(1),
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
      await ctx.ports.updateCell(args.cellId, patch);
      return `Updated ${args.cellId}: ${Object.keys(patch).join(", ")}.`;
    },
  });

  const controlCell = defineTool({
    name: "control_cell",
    kind: "kernel",
    availableFor: canSpawn,
    description:
      "Steer a running child (the message reaches it between its steps, or wakes it), or pause/resume it. Works immediately, bypassing its queue.",
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
      return r.applied
        ? { output: `${args.action} applied to ${args.cellId}.`, data: r }
        : { output: `Not applied to ${args.cellId}: ${r.reason ?? "refused"}.`, isError: true, data: r };
    },
  });

  const closeCell = defineTool({
    name: "close_cell",
    kind: "kernel",
    availableFor: canSpawn,
    description:
      "Finish (completed) or abort (cancelled) a child cell and its whole subtree: its jobs, watches, sandboxes and pending timers are reclaimed and late results are ignored.",
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

