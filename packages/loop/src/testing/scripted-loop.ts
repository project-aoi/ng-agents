import {
  normalizeToolResult,
  RUN_END_PRECEDENCE,
  selectRunTools,
  steerNoteText,
  systemClock,
  type AgentLoop,
  type Clock,
  type LlmProcessorSpec,
  type ModelTier,
  type PromptSnapshot,
  type Registry,
  type RunOutcome,
  type RunPorts,
  type StepOrExternalEvidence,
  type ToolContext,
  type ToolDef,
  type ToolResult,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@ng/protocol";
import { Conversation } from "./conversation";
import { createCodeLoop, raceAbort } from "../loop";
import type { ModelClient, ModelResponse } from "./model";

interface ScriptedLoopOptions {
  model: ModelClient;
  /** The shared registry: toolsets (processor.toolsets) and code processors (processor.entry). */
  registry: Registry;
  clock?: Clock;
  /** Tier when `processor.modelTier` is absent. Default "strong". */
  defaultTier?: ModelTier;
  /** Model calls per Run when `processor.maxSteps` is absent. Default 32. */
  defaultMaxSteps?: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EvidenceInput = DistributiveOmit<StepOrExternalEvidence, "runId" | "at">;

export const TRUNCATED_CALL_OUTPUT =
  "Not executed: your output hit the output-token limit before this call was complete. Retry with a smaller input (for example, write the file in parts).";

/**
 * ④ Loop. Stateless: one call to `run` is one bounded Run; everything durable goes through `ports`.
 *
 * llm Runs: tools = registry.resolveTools(processor.toolsets) filtered by selectRunTools (allowedTools ∩ bounds,
 * `availableFor`), so the list is the same on every Run of the cell. Each step: drain steer → model call →
 * evidence (assistant_text / tool_call) → tools in order (tool_result evidence; the model sees Context's `modelText`,
 * i.e. the spilled form) → stop on `endRun`, on a reply without tool calls, at maxSteps, on abort.
 *
 * Outcomes: `completed` (also: no tool call, maxSteps reached), `yielded_waiting` (a tool said endRun
 * yielded_waiting, or `awaitsWakeup` on a Run that would otherwise complete), `deferred_for_approval`, `cancelled`
 * `step_limit` (maxSteps model calls with work left) and `refused` (the model's stop reason is a refusal).
 * Model/transport errors are rethrown for the kernel to release/retry the claim; tool exceptions become error results.
 *
 * Code runs invoke the registered processor named by the cell spec.
 * No model calls.
 */
export function createScriptedLoop(opts: ScriptedLoopOptions): AgentLoop {
  const clock = opts.clock ?? systemClock;
  const code = createCodeLoop(opts.registry, clock);
  const defaultMaxSteps = opts.defaultMaxSteps ?? 32;

  async function run(snapshot: PromptSnapshot, ports: RunPorts, signal: AbortSignal): Promise<RunOutcome> {
    if (signal.aborted) return "cancelled";
    const processor = snapshot.spec.processor;
    try {
      return processor.kind === "code" ? await code.run(snapshot, ports, signal) : await runLlm(snapshot, ports, signal, processor);
    } catch (err) {
      if (signal.aborted) return "cancelled";
      throw err;
    }
  }

  async function runLlm(snapshot: PromptSnapshot, ports: RunPorts, signal: AbortSignal, processor: LlmProcessorSpec): Promise<RunOutcome> {
    const model = opts.model;
    const cellId = snapshot.cellId;
    const runId = snapshot.runId;
    // RunSelf.parentId is authoritative (the stored spec may omit it); both are fixed for the cell's life.
    const { parentId: _specParent, ...specRest } = snapshot.spec;
    const cellSpec = ports.self.parentId ? { ...specRest, parentId: ports.self.parentId } : specRest;
    const tools = selectRunTools(opts.registry.resolveTools(processor.toolsets ?? []), processor, snapshot.bounds, cellSpec);
    const byName = new Map<string, ToolDef>(tools.map((t) => [t.name, t]));
    const toolSpecs = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const tier = processor.modelTier ?? opts.defaultTier ?? "strong";
    const maxSteps = processor.maxSteps ?? defaultMaxSteps;
    const conv = Conversation.fromSnapshot(snapshot);

    const append = (rec: EvidenceInput) =>
      ports.context.appendEvidence(cellId, { ...rec, runId, at: clock.now() } as StepOrExternalEvidence);

    const injectSteer = async (): Promise<number> => {
      const messages = ports.drainSteer();
      for (const m of messages) {
        const text = steerNoteText(m.message, m.envelope?.principalId);
        await append({ kind: "system_note", text, envelopeId: m.envelopeId });
        conv.appendUserText(text);
      }
      return messages.length;
    };

    /**
     * docs/05 §3.3: messages that reached the cell while this Run works join it (same claim, already recorded as
     * `inbound` evidence by the kernel) — a follow-up is answered here instead of after a stale report. The port
     * decides who absorbs (hubs, one-shot cells); for everyone else it returns nothing.
     */
    const injectInbound = (): number => {
      const arrived = ports.drainInbound?.() ?? [];
      for (const a of arrived) conv.appendUserText(a.text);
      return arrived.length;
    };


    let steps = 0;
    let awaitsWakeup = false;
    const finish = (outcome: "completed" | "yielded_waiting" | "deferred_for_approval"): RunOutcome =>
      outcome === "completed" && awaitsWakeup ? "yielded_waiting" : outcome;

    await injectSteer();
    if (conv.lastRole !== "user") return "completed";

    for (;;) {
      if (signal.aborted) return "cancelled";
      if (steps >= maxSteps) {
        // Work is left (the model has not answered the latest input): never report that as completed. The kernel
        // queues a continuation, and asks the owner after a few in a row (docs/05 guard 1).
        await append({ kind: "system_note", text: `[run stopped after ${maxSteps} model calls (step limit); the kernel wakes you to continue]` });
        return "step_limit";
      }

      const response: ModelResponse = await raceAbort(
        model.complete(
          {
            tier,
            system: snapshot.system.text,
            messages: conv.forRequest(),
            tools: toolSpecs,
            ...(conv.stablePrefixEnd ? { cacheHints: { stablePrefixEnd: conv.stablePrefixEnd } } : {}),
            metadata: { cellId, runId },
          },
          signal,
        ),
        signal,
      );
      steps++;

      for (const block of response.content) {
        if (block.type === "text") await append({ kind: "assistant_text", text: block.text, model: response.model });
        else await append({ kind: "tool_call", toolUseId: block.id, name: block.name, input: block.input });
      }
      conv.appendAssistant(response.content);
      const calls = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

      if (signal.aborted) return "cancelled";

      if (response.stopReason === "refusal") {
        if (calls.length) await recordUnexecuted(calls, "Not executed: the model declined this turn.");
        // A refusal is not a result (docs/05 guard 1): a one-shot cell reports `failed`, a coordinator raises a card.
        return "refused";
      }
      if (calls.length === 0) {
        // A steer or a follow-up that arrived while the model was answering gets its reply in this Run.
        if (steps < maxSteps && (await injectSteer()) + injectInbound() > 0) continue;
        return finish("completed");
      }

      const results: ToolResultBlock[] = [];
      let endRun: ToolResult["endRun"];
      for (const [i, call] of calls.entries()) {
        if (signal.aborted) return "cancelled";
        const truncated = response.stopReason === "max_tokens" && i === calls.length - 1;
        const result = truncated ? { output: TRUNCATED_CALL_OUTPUT, isError: true } : await executeTool(call, { ports, snapshot, signal, toolUseId: call.id, clock });
        if (signal.aborted) return "cancelled";
        const ev = await append({
          kind: "tool_result",
          toolUseId: call.id,
          name: call.name,
          output: result.output,
          ...(result.isError ? { isError: true } : {}),
        });
        results.push({ type: "tool_result", toolUseId: call.id, content: ev.modelText ?? result.output, ...(result.isError ? { isError: true } : {}) });
        if (result.awaitsWakeup) awaitsWakeup = true;
        if (result.endRun && (endRun === undefined || RUN_END_PRECEDENCE.indexOf(result.endRun) < RUN_END_PRECEDENCE.indexOf(endRun))) {
          endRun = result.endRun;
        }
      }
      conv.appendToolResults(results);
      if (endRun) return finish(endRun);
      if (steps < maxSteps) {
        await injectSteer();
        injectInbound();
      }
    }

    async function recordUnexecuted(calls: ToolUseBlock[], output: string): Promise<void> {
      const results: ToolResultBlock[] = [];
      for (const call of calls) {
        const ev = await append({ kind: "tool_result", toolUseId: call.id, name: call.name, output, isError: true });
        results.push({ type: "tool_result", toolUseId: call.id, content: ev.modelText ?? output, isError: true });
      }
      conv.appendToolResults(results);
    }

    async function executeTool(call: ToolUseBlock, ctx: ToolContext): Promise<ToolResult> {
      const tool = byName.get(call.name);
      if (!tool) {
        return { output: `Unknown tool "${call.name}". Available tools: ${[...byName.keys()].join(", ") || "none"}.`, isError: true };
      }
      try {
        return normalizeToolResult(await raceAbort(Promise.resolve(tool.handler(call.input, ctx)), signal));
      } catch (err) {
        if (signal.aborted) throw err;
        return { output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
  }

  return { run };
}
