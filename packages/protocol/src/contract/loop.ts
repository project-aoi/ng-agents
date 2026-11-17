import { z } from "zod";
import type { Clock } from "../clock";
import { NgError } from "../errors";
import type { CellSpec, RunPorts } from "./cell";
import type { PromptSnapshot } from "./context";
import type { PolicyBounds, ToolKind } from "./envelope";

// docs/02 §二 — ④ Loop, verbatim (comments translated). Extensions follow the `[ext]` marker.

// ==================== ④ Loop: one bounded execution (llm inference or deterministic code) ====================
export type ProcessorSpec =
  | { kind: "llm"; allowedTools?: readonly ToolKind[]; skills?: readonly string[]; modelTier?: "fast" | "strong"; maxSteps?: number;
      prompt?: string;                  // [ext] registered prompt name (Registry.prompts)
      toolsets?: readonly string[];     // [ext] registered toolset names (Registry.toolsets), filtered by selectRunTools
      engine?: AgentEngine;             // [ext] who executes this cell's Runs; absent = the kernel's default backend
    }
  | { kind: "code"; entry: string;      // zero-token deterministic processor or local check script (all/any join bookkeeping, scheduled checks, ...)
      args?: Record<string, unknown>;   // [ext] static JSON configuration handed to the processor
    };
// [ext] `skills`: names of skills whose bodies are inlined into the frozen system prefix (all others appear only in the index).
// [ext] `entry`: a registered CodeProcessor name, or `script:<path>` run through the cell's workspace
//       (exit 0 + empty stdout = nothing to report; non-empty stdout is reported to the parent as `source.hit`).

export interface AgentLoop {
  run(snapshot: PromptSnapshot, ports: RunPorts /* [ext] RunPorts extends CellPorts */, signal: AbortSignal): Promise<
    | "completed"                       // finished normally (with nothing to send it just goes back to sleep — no empty message)
    | "yielded_waiting"                 // set up a wait/watch or started an async background Job; releases this Run ($0 while waiting)
    | "deferred_for_approval"           // Gate.defer produced a pending card; state persisted, Run released
    | "cancelled"
    | "budget_stopped"
  >;
}

// ==================== [ext] ====================

export type RunOutcome = "completed" | "yielded_waiting" | "deferred_for_approval" | "cancelled" | "budget_stopped";

/**
 * [ext] Who executes an `llm` Run (docs/02 §四.8 "Loop 对接外部 CLI 适配器"): `api` = @ng/loop's own tool loop over a
 * ModelClient; the others = an installed CLI coding agent (Claude Code, OpenAI Codex CLI, Google Antigravity CLI) whose
 * native file/shell tools work in the cell's workspace and which reaches the kernel tools over a per-Run MCP bridge.
 */
export type AgentEngine = "api" | "claude" | "codex" | "agy";
export type CliEngine = Exclude<AgentEngine, "api">;
export const AGENT_ENGINES = ["api", "claude", "codex", "agy"] as const satisfies readonly AgentEngine[];
export const CLI_ENGINES = ["claude", "codex", "agy"] as const satisfies readonly CliEngine[];
export type LlmProcessorSpec = Extract<ProcessorSpec, { kind: "llm" }>;
export type CodeProcessorSpec = Extract<ProcessorSpec, { kind: "code" }>;

/** Precedence when several tool calls in one step ask to end the Run. */
export const RUN_END_PRECEDENCE = ["deferred_for_approval", "yielded_waiting", "completed"] as const;

export type JsonSchema = { [key: string]: unknown };

/**
 * `kind` drives bounds filtering:
 * - a ToolKind: the tool touches the workspace with that capability; exposed only if the kind is in
 *   `bounds.tools` and (when set) in `processor.allowedTools`.
 * - "kernel": the tool only uses kernel ports (state, notes, reminders, spawn/close cells, propose actions);
 *   exposed whenever its toolset is listed. Ports and Gate still enforce bounds at call time.
 */
export type ToolDefKind = ToolKind | "kernel";

export interface ToolResult {
  output: string;                       // what the model sees as the tool_result content
  isError?: boolean;
  data?: unknown;                       // structured detail kept in evidence, not shown to the model
  /** End the Run after this step (the remaining tool calls of the step still run). See RUN_END_PRECEDENCE. */
  endRun?: "completed" | "yielded_waiting" | "deferred_for_approval";
  /**
   * [ext] This call arranged a future wake-up for the cell (e.g. started a Job). The Run keeps going, but if it would
   * end `completed` it reports `yielded_waiting` instead.
   */
  awaitsWakeup?: boolean;
}

export type ToolHandlerReturn = ToolResult | string | Promise<ToolResult | string>;

export interface ToolContext {
  ports: RunPorts;
  snapshot: PromptSnapshot;
  signal: AbortSignal;
  toolUseId: string;
  clock: Clock;
}

export interface ToolDef {
  name: string;                         // /^[a-zA-Z0-9_-]{1,64}$/, unique across the toolsets of one cell
  description: string;
  inputSchema: JsonSchema;              // JSON Schema (type: "object") handed to the model
  kind: ToolDefKind;
  /** Receives the raw model input; tools built with defineTool validate it first. A thrown error becomes an isError result. */
  handler(args: unknown, ctx: ToolContext): ToolHandlerReturn;
  /**
   * [ext] Static availability for a cell, decided only from its effective bounds and resolved spec (both fixed for the
   * cell's life, so the tool list stays byte-stable across Runs), e.g. spawn tools need `maxDepth > 0`.
   * Absent = available. Never base it on runtime state (children count, time, ...).
   */
  availableFor?(cell: { bounds: PolicyBounds; spec?: CellSpec }): boolean;
}

export interface Toolset {
  name: string;
  description?: string;
  tools: readonly ToolDef[];
}

export interface CodeProcessorInput {
  snapshot: PromptSnapshot;
  ports: RunPorts;
  signal: AbortSignal;
  args: Record<string, unknown>;        // ProcessorSpec.code.args ?? {}
  clock: Clock;
}

/** Zero-token deterministic processor (e.g. join_all bookkeeping, a sensor check). Must return quickly and never call a model. */
export interface CodeProcessor {
  name: string;
  description?: string;
  run(input: CodeProcessorInput): Promise<RunOutcome>;
}

/** A named system prompt. Frozen into the cell's prefix on first hydrate. */
export interface PromptDef {
  name: string;
  description?: string;
  text: string;
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function assertToolName(name: string): void {
  if (!TOOL_NAME.test(name)) throw new NgError("invalid_argument", `invalid tool name "${name}" (must match ${TOOL_NAME})`);
}

/**
 * Build a ToolDef from a zod schema: the JSON Schema is derived from it and the handler only ever sees parsed input
 * (invalid input becomes an isError tool result, so the model can correct itself).
 */
export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  kind: ToolDefKind;
  input: S;
  handler(args: z.output<S>, ctx: ToolContext): ToolHandlerReturn;
  availableFor?: ToolDef["availableFor"]; // [ext]
}): ToolDef {
  assertToolName(def.name);
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(def.input, { io: "input" }) as JsonSchema;
  const tool: ToolDef = {
    name: def.name,
    description: def.description,
    inputSchema,
    kind: def.kind,
    handler(args, ctx) {
      const parsed = def.input.safeParse(args);
      if (!parsed.success) {
        return { output: `Invalid input for ${def.name}: ${z.prettifyError(parsed.error)}`, isError: true };
      }
      return def.handler(parsed.data, ctx);
    },
  };
  if (def.availableFor) tool.availableFor = def.availableFor;
  return tool;
}

/**
 * The tools a Run may expose to the model, given the processor's allowedTools and the cell's bounds
 * ([ext] and, when given, each tool's `availableFor` with the cell's resolved spec).
 */
export function selectRunTools(tools: readonly ToolDef[], processor: LlmProcessorSpec, bounds: PolicyBounds, spec?: CellSpec): ToolDef[] {
  const allowed = processor.allowedTools ? new Set<ToolKind>(processor.allowedTools) : null;
  return tools.filter(
    (t) =>
      (t.kind === "kernel" || (bounds.tools.has(t.kind) && (allowed === null || allowed.has(t.kind)))) &&
      (t.availableFor === undefined || t.availableFor({ bounds, spec })),
  );
}

export function normalizeToolResult(r: ToolResult | string): ToolResult {
  return typeof r === "string" ? { output: r } : r;
}
