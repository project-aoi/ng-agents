import {
  messageText,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStopReason,
  type ModelTier,
  type ModelUsage,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@ng/protocol";
import { toModelUsage, type ModelPrice } from "./pricing";

/** One model turn: text and/or tool calls. Omitted usage is estimated (≈ 4 chars per token). */
export interface ScriptTurn {
  text?: string;
  toolCalls?: Array<{ name: string; input?: unknown; id?: string }>;
  stopReason?: ModelStopReason;
  usage?: Partial<Pick<ModelUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "billedCents">>;
  /** Simulated latency; aborting the signal during it rejects like a real transport. */
  delayMs?: number;
  /** Reject instead of answering (transport/API failure). */
  error?: Error;
}

export interface ScriptContext {
  /** 0-based index of this call on this client. */
  callIndex: number;
  /** Text of the last user message (tool results excluded). */
  lastUserText: string;
  /** Tool results in the last user message (what the previous step's tools returned). */
  toolResults: ToolResultBlock[];
  /** Tool names offered in this request. */
  toolNames: string[];
}

export type ScriptResponder = (req: ModelRequest, ctx: ScriptContext) => ScriptTurn | Promise<ScriptTurn>;
/** A fixed sequence (each entry a turn or a responder for that call), or one responder for every call. */
export type Script = ReadonlyArray<ScriptTurn | ScriptResponder> | ScriptResponder;

export interface ScriptedModelClientOptions {
  models?: Partial<Record<ModelTier, string>>;
  /** Prices the fake usage (USD per MTok). Default: free (0 cents, tokens still counted). */
  price?: ModelPrice;
  /** What to do when a fixed script runs out: throw (default) or answer with an empty end_turn. */
  onExhausted?: "throw" | "end_turn";
}

/**
 * Deterministic ModelClient for tests and the demo mode. Records every request in `calls`. Tool call ids default to
 * `toolu_<runId>_<call>_<n>` so they stay unique across Runs of a cell.
 */
export class ScriptedModelClient implements ModelClient {
  readonly provider = "scripted";
  readonly calls: ModelRequest[] = [];
  readonly #script: Script;
  readonly #opts: ScriptedModelClientOptions;
  #next = 0;

  constructor(script: Script, opts: ScriptedModelClientOptions = {}) {
    this.#script = script;
    this.#opts = opts;
  }

  modelFor(tier: ModelTier): string {
    return this.#opts.models?.[tier] ?? `scripted-${tier}`;
  }

  /** Turns left in a fixed script (Infinity for a responder script). */
  get remaining(): number {
    return typeof this.#script === "function" ? Infinity : this.#script.length - this.#next;
  }

  async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    signal?.throwIfAborted();
    const callIndex = this.calls.length;
    this.calls.push(structuredClone(req));
    const ctx = scriptContext(req, callIndex);
    let step: ScriptTurn | ScriptResponder | undefined;
    if (typeof this.#script === "function") step = this.#script;
    else step = this.#script[this.#next++];
    if (step === undefined) {
      if (this.#opts.onExhausted === "end_turn") step = {};
      else throw new Error(`ScriptedModelClient: script exhausted after ${callIndex} call(s)`);
    }
    const turn = typeof step === "function" ? await step(req, ctx) : step;
    if (turn.delayMs) await sleep(turn.delayMs, signal);
    signal?.throwIfAborted();
    if (turn.error) throw turn.error;

    const content: Array<TextBlock | ToolUseBlock> = [];
    if (turn.text) content.push({ type: "text", text: turn.text });
    (turn.toolCalls ?? []).forEach((c, i) => {
      content.push({
        type: "tool_use",
        id: c.id ?? `toolu_${req.metadata?.runId ?? "run"}_${callIndex}_${i}`,
        name: c.name,
        input: c.input ?? {},
      });
    });
    const outputChars = (turn.text ?? "").length + JSON.stringify(turn.toolCalls ?? []).length;
    const counts = {
      inputTokens: turn.usage?.inputTokens ?? estimateTokens(JSON.stringify([req.system, req.messages, req.tools]).length),
      outputTokens: turn.usage?.outputTokens ?? estimateTokens(outputChars),
      cacheReadTokens: turn.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: turn.usage?.cacheWriteTokens ?? 0,
    };
    const usage = toModelUsage(counts, this.#opts.price ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    if (turn.usage?.billedCents !== undefined) usage.billedCents = turn.usage.billedCents;
    return {
      model: this.modelFor(req.tier),
      content,
      stopReason: turn.stopReason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
      usage,
    };
  }
}

/** Shorthands for writing scripts. */
export const say = (text: string, extra: Omit<ScriptTurn, "text"> = {}): ScriptTurn => ({ ...extra, text });
export const call = (name: string, input: unknown = {}, extra: Omit<ScriptTurn, "toolCalls"> = {}): ScriptTurn => ({
  ...extra,
  toolCalls: [{ name, input }],
});

export function scriptContext(req: ModelRequest, callIndex: number): ScriptContext {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  return {
    callIndex,
    lastUserText: lastUser ? messageText(lastUser) : "",
    toolResults: lastUser ? lastUser.content.filter((b): b is ToolResultBlock => b.type === "tool_result") : [],
    toolNames: req.tools.map((t) => t.name),
  };
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
