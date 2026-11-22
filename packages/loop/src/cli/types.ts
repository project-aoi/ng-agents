import type { CliEngine, ModelTier } from "@ng/protocol";
import type { McpServerLaunch } from "./bridge";

/** Model per tier; `""` = the CLI's own default model (from the owner's CLI configuration). */
export type CliModels = Partial<Record<ModelTier, string>>;

/**
 * What the cell may do in its workspace, after the kernel's own refusals (WorkspaceAccess.tools) and the processor's
 * `allowedTools`. Each adapter maps it onto its CLI's permission and sandbox flags.
 */
export interface CliCapabilities {
  root: string;
  write: boolean;
  edit: boolean;
  bash: boolean;
  /** None of write/edit/bash: the CLI must not change anything. */
  readOnly: boolean;
  /** Native web tools (fetch/search) offered to the agent. */
  web: boolean;

}

/** Normalized events parsed from a CLI's output stream. MCP calls to the kernel bridge are not reported here (the bridge records them). */
export type CliEvent =
  | { type: "session"; sessionId: string; model?: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; output: string; isError?: boolean }
  /**
   * The CLI finished processing its input. `more`: it has further queued input of ours to answer (another turn_end
   * follows). `stopped`: the turn was interrupted on our request.
   */
  | { type: "turn_end"; ok: boolean; error?: string; more?: boolean; stopped?: boolean; /** docs/05: the model refused (not an error to retry). */ refused?: boolean }
  /** The requested resume/fork could not find the session. */
  | { type: "resume_failed"; message: string }
  /** Diagnostic worth keeping (e.g. a refused permission request). */
  | { type: "notice"; text: string };

export interface DriverIO {
  /** Returns false when stdin is already closed/destroyed so the caller knows the line was NOT accepted. */
  write(line: string): boolean;
  /** Close the CLI's stdin. */
  end(): void;
}

export interface LaunchRequest {
  engine: CliEngine;
  bin: string;
  cwd: string;
  caps: CliCapabilities;
  model: string | undefined;
  /** Reasoning effort, for CLIs that take it separately from the model (Claude Code, Codex). */
  effort?: string | undefined;
  /** Text appended to the CLI's own system prompt (fresh sessions). */
  system: string;
  /** The same text on disk (0600), for CLIs that take a file. */
  systemFile: string;
  /** First user input of this process. */
  prompt: string;
  /** Session to continue (resume) or to copy (fork); absent = fresh session. */
  session?: { id: string; mode: "resume" | "fork" };
  mcp: { serverName: string; launch: McpServerLaunch };
  /** Private per-Run directory (0700) for generated config files. */
  tmpDir: string;
  extraArgs: readonly string[];
}

/**
 * One CLI process for one Run (or one leg of it). The loop owns the process; the driver turns intents into stdin
 * lines and stdout lines into events.
 */
export interface CliDriver {
  readonly argv: readonly string[];
  /** Called once the process is spawned (e.g. write the first user message, or the ACP handshake). */
  start(io: DriverIO): void;
  onLine(line: string, io: DriverIO): CliEvent[];
  /**
   * Deliver a user message while the process runs. `false` = this CLI has no live input: the loop interrupts the
   * process and resumes the session with the text instead.
   */
  steer(text: string, io: DriverIO): boolean;
  /** Ask the CLI to stop the current turn (it should then end with turn_end). Best effort; the loop kills after a grace period. */
  interrupt(io: DriverIO): void;
  /** Nothing more to say: let the process exit. */
  finish(io: DriverIO): void;
}

export interface CliAdapter {
  readonly engine: CliEngine;
  readonly defaultBin: string;
  readonly defaultModels: CliModels;
  /** Native session fork (fork_prefix children continue a copy of the parent's CLI session). */
  readonly canFork: boolean;
  /** How MCP tool names look to this CLI's model, for the kernel note. */
  mcpToolName(server: string, tool: string): string;
  createDriver(req: LaunchRequest): CliDriver;
  /** Human-readable account of what the flags request and what the CLI's sandbox enforces, for the evidence log. */
  describePermissions(caps: CliCapabilities): string;
  /**
   * One sentence for the agent itself on how a *read-only* cell reads with this CLI (which of its tools work and
   * which are refused). Each CLI differs — Codex reads through a read-only shell, Claude Code has no shell at all —
   * and an agent told only "you cannot run commands" may conclude it cannot read files.
   */
  readOnlyHowTo(caps: CliCapabilities): string;
  /** Environment variables this CLI needs to behave as a cell (laid over the filtered kernel environment). */
  readonly env?: Readonly<Record<string, string>>;
}

/** Persisted per cell (Context state `CLI_SESSION_KEY`) so the next Run resumes the CLI session. */
export interface CliSessionRecord {
  engine: CliEngine;
  sessionId: string;
  model: string | null;
  cwd: string;
  /** PromptSnapshot.system.hash the session was primed with. */
  systemHash: string;
  lastDeliveredEvidenceSeq?: number;
  createdAt: number;
  updatedAt: number;
  runs: number;
  forkedFrom?: string;
}
