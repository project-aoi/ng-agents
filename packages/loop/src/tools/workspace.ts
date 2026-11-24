import { z } from "zod";
import { defineTool, type Toolset } from "@ng/protocol";

export const WORKSPACE_TOOLSET = "workspace";

const jobStart = defineTool({
  name: "job_start",
  kind: "bash",
  description:
    "Start a long-running command (build, test suite, migration) as a background job that outlives this run. You are woken with a job.result message when it ends, so you can finish your turn instead of waiting.",
  input: z.object({
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1_000).optional().describe("max run time in ms. Default 30 minutes — give more for anything that may run longer (a soak test, a long build); clamped to the workspace ceiling. Time the machine was asleep does not count"),
  }),
  async handler(args, ctx) {
    const spec: { command: string; timeoutMs?: number } = { command: args.command };
    if (args.timeoutMs !== undefined) spec.timeoutMs = args.timeoutMs;
    const { jobId } = await ctx.ports.workspace.startJob(spec);
    return {
      output: `Started job ${jobId}. You will get a job.result message when it finishes; check on it with job_observe.`,
      data: { jobId },
      awaitsWakeup: true,
    };
  },
});

const jobObserve = defineTool({
  name: "job_observe",
  kind: "bash",
  description: "Show a background job's state and the tail of its output.",
  input: z.object({ jobId: z.string().min(1) }),
  async handler(args, ctx) {
    const r = await ctx.ports.workspace.observeJob(args.jobId);
    return { output: `state: ${r.state}\n--- output tail ---\n${r.tail || "(no output yet)"}`, data: { state: r.state } };
  },
});

const jobInput = defineTool({
  name: "job_input",
  kind: "bash",
  description: "Write text to a running job's stdin (include a trailing newline to submit a line).",
  input: z.object({ jobId: z.string().min(1), input: z.string() }),
  async handler(args, ctx) {
    const writeInput = ctx.ports.workspace.writeJobInput;
    if (!writeInput) return { output: "This workspace does not support job input.", isError: true };
    await writeInput.call(ctx.ports.workspace, args.jobId, args.input);
    return "Input written.";
  },
});

const jobCancel = defineTool({
  name: "job_cancel",
  kind: "bash",
  description: "Stop a background job.",
  input: z.object({ jobId: z.string().min(1) }),
  async handler(args, ctx) {
    await ctx.ports.workspace.cancelJob(args.jobId);
    return `Job ${args.jobId} cancelled.`;
  },
});

export function workspaceToolset(): Toolset {
  return {
    name: WORKSPACE_TOOLSET,
    description: "Start and supervise background jobs in the working directory.",
    tools: [jobStart, jobObserve, jobInput, jobCancel],
  };
}
