import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CellSpec, ProcessorSpec } from "@ng/protocol";
import { SENSOR_LLM_PROCESSOR } from "./processors";
import { z } from "zod";
import { scriptCommand, shellQuote } from "./script-command";
import { gtdKeys } from "./keys";
import type { SourceRecord, SourceState } from "./product-records";
import {
  defineTool,
  PAYLOAD,
  type CommitTx,
  type CodeProcessor,
  type CodeProcessorInput,
  type Envelope,
  type RunPorts,
  type SourceHitPayload,
  type Toolset,
} from "@ng/protocol";
import { PROCESSORS, TOOLSETS } from "./config";
import { clip, newSource } from "./records";

// A sensor is a mailbox source, not a task (docs/03 原则 1): a normal run ends silently and only updates its
// SourceRecord; a hit posts one `source.hit` to the desk, or — in observe mode — is only written to its observation
// notes (原则 4).

export interface SensorHit {
  title?: string;
  summary: string;
  rawInput?: string;
  uri?: string;
  data?: unknown;
}

/** spec.meta.gtd.source of a sensor cell: the SourceRecord it starts with. */
export type SourceInit = Pick<SourceRecord, "title" | "kind" | "mode" | "processor"> & Partial<Pick<SourceRecord, "description" | "schedule">>;

export const OBSERVATION_NOTE = "观察笔记";

export function sourceInit(spec: CellSpec): SourceInit {
  const init = (spec.meta?.["gtd"] as { source?: SourceInit } | undefined)?.source;
  const rule = spec.schedules?.find(s => s.cron);
  return { title: spec.title ?? init?.title ?? "信源", kind: rule?.cron || !spec.watches?.length ? "cron" : "watch",
    mode: init?.mode ?? "active", processor: spec.processor.kind, ...(init?.description && {description: init.description}),
    ...(rule?.cron && {schedule:{cron:rule.cron, ...(rule.tz && {tz:rule.tz})}}) };
}

/** Read (or create from the spec) the cell's SourceRecord. */
export async function ensureSource(ports: RunPorts, now: number): Promise<SourceState> {
  const cur = await ports.context.readState<SourceState>(ports.self.cellId, gtdKeys.source);
  if (cur) return cur;
  const rec = newSource(sourceInit(ports.self.spec), now);
  await ports.context.commit(ports.self.cellId, { statePatches: { [gtdKeys.source]: rec } });
  return rec;
}

/**
 * One finished check: SourceRecord counters, then the hit (if any) goes to the desk — or, in observe mode, into the
 * observation notes only. `runKey` makes a retried Run post the same hit only once.
 */
export async function recordCheck(ports: RunPorts, now: number, result: { hit: SensorHit | null; error?: string }, runKey: string): Promise<SourceState> {
  const src = await ensureSource(ports, now);
  if (src.lastCheckKey === runKey) return src;
  let appendReference: CommitTx["appendReference"];
  const next: SourceState = { ...src, lastCheckKey: runKey, runCount: src.runCount + 1, lastRunAt: now, updatedAt: now };
  if (result.error) next.lastError = clip(result.error, 300);
  else delete next.lastError;
  const hit = result.hit;
  if (hit && !result.error) {
    next.hitCount = src.hitCount + 1;
    next.lastHitAt = now;
    if (src.mode === "observe") {
      const line = `- ${new Date(now).toISOString()} ${hit.title ?? src.title}：${clip(hit.summary, 500)}${hit.uri ? ` (${hit.uri})` : ""}\n`;
      appendReference = { name: OBSERVATION_NOTE, description: `${src.title} 的观察记录`, body: line };
    } else {
      const payload: SourceHitPayload = {
        sourceCellId: ports.self.cellId,
        title: hit.title ?? src.title,
        summary: hit.summary,
        ...(hit.rawInput !== undefined ? { rawInput: hit.rawInput } : {}),
        ...(hit.uri !== undefined ? { uri: hit.uri } : {}),
        ...(hit.data !== undefined ? { data: hit.data } : {}),
      };
      await ports.emitToParent(PAYLOAD.sourceHit, payload, { id: `${ports.self.cellId}:hit:${runKey}` });
    }
  }
  await ports.context.commit(ports.self.cellId, { statePatches: { [gtdKeys.source]: next }, appendReference });
  return next;
}

/** A check is due on a schedule firing or a watched message; the first `cell.task` only sets the source up. */
function dueEnvelopes(envs: readonly Envelope[]): Envelope[] {
  return envs.filter((e) => e.type !== PAYLOAD.cellTask && e.type !== "control.steer");
}

export interface SensorCheckInput extends CodeProcessorInput {
  source: SourceState;
  /** What woke the sensor (timer firings, watched messages). */
  due: Envelope[];
}

/**
 * Wrap a zero-token check as a sensor code processor: register the result under `name` and use it as the sensor's
 * `processor: { kind: "code", entry: name }`. Return null when there is nothing worth an item; throwing marks the
 * source as erroring (shown in the 信源 drawer) without creating an item.
 */
export function defineSensorCheck(name: string, check: (input: SensorCheckInput) => Promise<SensorHit | null> | SensorHit | null, description?: string): CodeProcessor {
  return {
    name,
    description: description ?? `sensor check ${name}`,
    async run(input) {
      const now = input.clock.now();
      const source = await ensureSource(input.ports, now);
      const due = dueEnvelopes(input.snapshot.batch.envelopes);
      const trigger = due[0];
      if (!trigger) return "completed";
      if (due.length > 1) {
        if (!input.ports.requeueEnvelopes) throw new Error("Cannot release unprocessed source inputs");
        input.ports.requeueEnvelopes(due.slice(1).map(e => e.id), "process each source input individually");
      }
      if (source.lastCheckKey === trigger.id) return "completed";
      let hit: SensorHit | null = null;
      let error: string | undefined;
      try {
        hit = await check({ ...input, source, due: [trigger] });
      } catch (err) {
        if (input.signal.aborted) throw err;
        error = err instanceof Error ? err.message : String(err);
      }
      await recordCheck(input.ports, now, error ? { hit: null, error } : { hit }, trigger.id);
      return "completed";
    },
  };
}

/** `args.script`: run through the cell's workspace; exit 0 + empty output = nothing, output = a hit, non-zero = error. */
export function createScriptSensor(): CodeProcessor {
  return defineSensorCheck(
    PROCESSORS.sensorScript,
    async ({ ports, args, signal, snapshot, due }) => {
      const script = args["script"];
      if (typeof script !== "string" || !script.trim()) throw new Error("sensor: args.script is missing");
      const json = JSON.stringify(due[0]);
      const large = Buffer.byteLength(shellQuote(json)) > 64 * 1024;
      const dir = large ? await mkdtemp(join(tmpdir(), "ng-sensor-")) : undefined;
      const timeoutMs = typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : 120_000;
      let res;
      try {
        const env: Record<string,string> = { NG_CELL_ID: ports.self.cellId, NG_RUN_ID: snapshot.runId, NG_ARGS: JSON.stringify(args) };
        if (dir) {
          env.NG_TRIGGER_FILE = join(dir, "trigger.json");
          await writeFile(env.NG_TRIGGER_FILE, json, { mode: 0o600 });
        } else env.NG_TRIGGER_JSON = json;
        res = await ports.workspace.exec("bash", { command: scriptCommand(script, env), timeoutMs }, signal);
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
      const out = res.output.trim();
      if ((res.exitCode ?? 0) !== 0) throw new Error(`exit ${res.exitCode}: ${clip(out.slice(-300), 300)}`);
      return out ? { summary: clip(out, 1_000), rawInput: out.slice(0, 20_000) } : null;
    },
    "Runs args.script as a zero-token check.",
  );
}

/** The llm (fast tier) filter's two exits; both keep the SourceRecord current and end the run. */
export function sensorToolset(): Toolset {
  return {
    name: TOOLSETS.sensor,
    description: "Report what a source check found.",
    tools: [
      defineTool({
        name: "report_hit",
        kind: "kernel",
        description: "Something here is worth the owner's attention (it becomes one item on their desk; in observation mode it is only noted). Use once per wake-up.",
        input: z.object({
          title: z.string().optional().describe("short headline in Chinese"),
          summary: z.string().min(1).describe("what was found and why it matters, in Chinese"),
          rawInput: z.string().optional().describe("the original message or data excerpt"),
          uri: z.string().optional(),
          artifactId: z.string().optional().describe("a draft you prepared for the owner with save_artifact (e.g. this week's report)"),
        }),
        async handler(args, ctx) {
          const due = dueEnvelopes(ctx.snapshot.batch.envelopes);
          // The setup message is not something observed.
          if (due.length === 0) {
            await ensureSource(ctx.ports, ctx.clock.now());
            return { output: "Nothing has been observed yet; this was only your setup.", endRun: "completed" };
          }
          const { artifactId, ...hit } = args;
          const uri = hit.uri ?? (artifactId ? `artifact://${artifactId}` : undefined);
          const src = await recordCheck(ctx.ports, ctx.clock.now(), { hit: { ...hit, ...(uri ? { uri } : {}), ...(artifactId ? { data: { artifactId } } : {}) } }, due[0]!.id);
          return { output: src.mode === "observe" ? "Noted (observation mode: no item created)." : "Reported to the desk.", endRun: "completed" };
        },
      }),
      defineTool({
        name: "no_hit",
        kind: "kernel",
        description: "Nothing worth an item this time. Ends the run silently.",
        input: z.object({ note: z.string().optional() }),
        async handler(_args, ctx) {
          const trigger = dueEnvelopes(ctx.snapshot.batch.envelopes)[0];
          if (trigger) await recordCheck(ctx.ports, ctx.clock.now(), { hit: null }, trigger.id);
          else await ensureSource(ctx.ports, ctx.clock.now());
          return { output: "OK.", endRun: "completed" };
        },
      }),
    ],
  };
}

export function sensorProcessor(entry: string): Extract<ProcessorSpec, { kind: "code" }> {
  if (!entry.startsWith("script:")) return { kind: "code", entry };
  const script = entry.slice(7).trim();
  if (!script) throw new Error("需要脚本路径");
  return { kind: "code", entry: PROCESSORS.sensorScript, args: { script } };
}
export function createSensorSpec(id:string,source:SourceInit,processor:ProcessorSpec = SENSOR_LLM_PROCESSOR,thread?:string): CellSpec {
  return {id,preset:"sensor",title:source.title,processor,meta:{role:"sensor",gtd:{source:{mode:source.mode, description:source.description}}},
    ...(source.schedule ? {schedules:[source.schedule]} : {}),...(thread ? {watches:[{threadOrFilter:{thread}}]} : {})};
}
