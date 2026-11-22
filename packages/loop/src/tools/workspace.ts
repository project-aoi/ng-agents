import { z } from "zod";
import {
  bashArgsSchema,
  codeRpcArgsSchema,
  defineTool,
  editArgsSchema,
  readArgsSchema,
  writeArgsSchema,
  type ExecResult,
  type ToolResult,
  type Toolset,
} from "@ng/protocol";

export const WORKSPACE_TOOLSET = "workspace";

function execOutput(r: ExecResult): ToolResult {
  const parts = [r.output === "" ? "(no output)" : r.output];
  if (r.truncated) parts.push("[output truncated by the workspace]");
  const failed = r.exitCode !== undefined && r.exitCode !== 0;
  if (failed) parts.push(`[exit code ${r.exitCode}]`);
  return failed ? { output: parts.join("\n"), isError: true } : { output: parts.join("\n") };
}

// Flat object for the model (providers want `type: "object"` at the top); validated against the workspace's union.
const readInput = z.object({
  op: z.enum(["read_file", "list_dir", "search"]),
  path: z.string().optional().describe("file or directory, relative to the workspace root"),
  offset: z.number().int().min(0).optional().describe("read_file: 0-based first line"),
  limit: z.number().int().min(1).optional().describe("read_file: max lines"),
  depth: z.number().int().min(1).max(5).optional().describe("list_dir: levels to descend"),
  pattern: z.string().optional().describe("search: regex (ripgrep syntax)"),
  glob: z.string().optional().describe("search: file glob filter"),
  literal: z.boolean().optional().describe("search: treat pattern as a fixed string"),
  maxResults: z.number().int().min(1).optional(),
});

const read = defineTool({
  name: "read",
  kind: "read",
  description:
    "Look at the workspace: read_file (path, optional line offset/limit), list_dir (path, depth) or search (regex pattern, optional path/glob). Paths are relative to the workspace root.",
  input: readInput,
  async handler(args, ctx) {
    const parsed = readArgsSchema.safeParse(Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)));
    if (!parsed.success) return { output: `Invalid read: ${z.prettifyError(parsed.error)}`, isError: true };
    return execOutput(await ctx.ports.workspace.exec("read", parsed.data, ctx.signal));
  },
});

const write = defineTool({
  name: "write",
  kind: "write",
  description: "Create or overwrite a file in the workspace with the full given content.",
  input: writeArgsSchema,
  async handler(args, ctx) {
    return execOutput(await ctx.ports.workspace.exec("write", args, ctx.signal));
  },
});

const edit = defineTool({
  name: "edit",
  kind: "edit",
  description: "Replace oldText with newText in a file. oldText must match exactly and be unique unless replaceAll is set; read the file first.",
  input: editArgsSchema,
  async handler(args, ctx) {
    return execOutput(await ctx.ports.workspace.exec("edit", args, ctx.signal));
  },
});

const bash = defineTool({
  name: "bash",
  kind: "bash",
  description:
    "Run a shell command in the workspace (minimal environment, no host secrets). Returns stdout+stderr and the exit code. Anything slower than about a minute (full builds, test suites) belongs in job_start.",
  input: bashArgsSchema,
  async handler(args, ctx) {
    return execOutput(await ctx.ports.workspace.exec("bash", args, ctx.signal));
  },
});

const codeRpc = defineTool({
  name: "code_rpc",
  kind: "code_rpc",
  description:
    "Run a short JavaScript (ESM) program that calls the workspace tools (tools.read/write/edit/bash) and host-provided RPC/HTTP helpers; credentials are injected by the host and never visible. Only what it prints comes back — use it to chain many calls or filter large results in one step.",
  input: codeRpcArgsSchema,
  async handler(args, ctx) {
    return execOutput(await ctx.ports.workspace.exec("code_rpc", args, ctx.signal));
  },
});

const jobStart = defineTool({
  name: "job_start",
  kind: "bash",
  description:
    "Start a long-running command (build, test suite, migration) as a background job that outlives this run. You are woken with a job.result message when it ends, so you can finish your turn instead of waiting.",
  input: z.object({
    command: z.string().min(1),
    streamPreview: z.boolean().optional().describe("stream its output live to the user's preview"),
    timeoutMs: z.number().int().min(1_000).optional().describe("max runtime in ms (clamped to the workspace ceiling; defaults to workspace job timeout)"),
  }),
  async handler(args, ctx) {
    const spec: { command: string; streamPreview?: boolean; timeoutMs?: number } = { command: args.command };
    if (args.streamPreview !== undefined) spec.streamPreview = args.streamPreview;
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

/**
 * `workspace`: read, write, edit, bash, code_rpc, job_start, job_observe, job_input, job_cancel.
 * Each tool's `kind` is its workspace capability (job tools count as `bash`), so selectRunTools exposes only what is
 * in `processor.allowedTools ∩ bounds.tools`. Bounds are enforced again by the kernel's workspace port.
 */
export function workspaceToolset(): Toolset {
  return {
    name: WORKSPACE_TOOLSET,
    description: "Files, shell, code_rpc and background jobs in the cell's workspace.",
    tools: [read, write, edit, bash, codeRpc, jobStart, jobObserve, jobInput, jobCancel],
  };
}
