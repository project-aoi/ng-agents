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
  sha256Hex,
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

/** Where a hit came from (`source.hit` payload `data.origin`): enough for the desk and the owner to follow it up. */
export interface HitOrigin {
  sourceTitle: string;
  sourceCellId: string;
  /** `script:<path>`, a registered check's name, or "model" (an llm source filtering by its rule). */
  check: string;
  /** The directory the check runs in. */
  cwd?: string;
  /** A report URL or path the check printed (also the hit's `uri` when it gave none). */
  location?: string;
}

const PRINTED_URL = /https?:\/\/[^\s"'<>()（），。；、]+/;
const PRINTED_PATH = /(?:^|[\s(（:：=])((?:~|\.{1,2})?\/[^\s"'<>,，;；()（）。、]+)/m;

/** A report location the check's output names: the first URL, else the first absolute path. */
function printedLocation(text: string): string | undefined {
  return PRINTED_URL.exec(text)?.[0] ?? PRINTED_PATH.exec(text)?.[1];
}

function originOf(ports: RunPorts, src: SourceState, hit: SensorHit): HitOrigin {
  const p = ports.self.spec.processor;
  const script = p.kind === "code" && p.entry === PROCESSORS.sensorScript ? p.args?.["script"] : undefined;
  const check = p.kind !== "code" ? "model" : typeof script === "string" ? `script:${script}` : p.entry;
  const location = hit.uri ?? (p.kind === "code" ? printedLocation(hit.rawInput ?? hit.summary) : undefined);
  return { sourceTitle: src.title, sourceCellId: ports.self.cellId, check, ...(ports.self.spec.cwd ? { cwd: ports.self.spec.cwd } : {}), ...(location ? { location } : {}) };
}

/** The line a code check's hit carries in its summary, in the owner's words. */
function originLine(o: HitOrigin): string {
  if (o.check === "model") return "";
  const what = o.check.startsWith("script:") ? `脚本 ${o.check.slice("script:".length)}` : `检查 ${o.check}`;
  return `\n（信源「${o.sourceTitle}」，${what}${o.cwd ? `，在 ${o.cwd} 运行` : ""}${o.location ? `；报告位置：${o.location}` : ""}）`;
}

/** Same hit = same title, text, excerpt, link and data (an llm source's differently worded report is a new one). */
function hitDigest(hit: SensorHit): string {
  return sha256Hex(JSON.stringify([hit.title ?? "", hit.summary, hit.rawInput ?? "", hit.uri ?? "", hit.data ?? null])).slice(0, 24);
}

export interface CheckOutcome {
  source: SourceState;
  /** The hit was the one already reported (unchanged since): counted, not reported again. */
  repeated: boolean;
}

/**
 * One finished check: SourceRecord counters, then the hit (if any) goes to the desk — or, in observe mode, into the
 * observation notes only. `runKey` makes a retried Run post the same hit only once. A hit identical to the last one
 * reported is counted but not reported again until a check finds nothing (recovery); a failed check changes neither.
 */
export async function recordCheck(ports: RunPorts, now: number, result: { hit: SensorHit | null; error?: string }, runKey: string): Promise<CheckOutcome> {
  const src = await ensureSource(ports, now);
  if (src.lastCheckKey === runKey) return { source: src, repeated: false };
  let appendReference: CommitTx["appendReference"];
  let repeated = false;
  const next: SourceState = { ...src, lastCheckKey: runKey, runCount: src.runCount + 1, lastRunAt: now, updatedAt: now };
  if (result.error) next.lastError = clip(result.error, 300);
  else delete next.lastError;
  const hit = result.hit;
  if (hit && !result.error) {
    const digest = hitDigest(hit);
    if (src.lastHitDigest === digest) {
      repeated = true;
      next.lastHitRepeats = (src.lastHitRepeats ?? 0) + 1;
    } else {
      next.lastHitDigest = digest;
      delete next.lastHitRepeats;
      next.hitCount = src.hitCount + 1;
      next.lastHitAt = now;
      const origin = originOf(ports, src, hit);
      const uri = origin.location;
      if (src.mode === "observe") {
        const line = `- ${new Date(now).toISOString()} ${hit.title ?? src.title}：${clip(hit.summary, 500)}${uri ? ` (${uri})` : ""}\n`;
        appendReference = { name: OBSERVATION_NOTE, description: `${src.title} 的观察记录`, body: line };
      } else {
        const data = hit.data !== undefined && (typeof hit.data !== "object" || hit.data === null || Array.isArray(hit.data)) ? { value: hit.data } : (hit.data as Record<string, unknown> | undefined);
        const payload: SourceHitPayload = {
          sourceCellId: ports.self.cellId,
          title: hit.title ?? src.title,
          summary: `${hit.summary}${originLine(origin)}`,
          ...(hit.rawInput !== undefined ? { rawInput: hit.rawInput } : {}),
          ...(uri !== undefined ? { uri } : {}),
          data: { ...data, origin },
        };
        await ports.emitToParent(PAYLOAD.sourceHit, payload, { id: `${ports.self.cellId}:hit:${runKey}` });
      }
    }
  } else if (!result.error) {
    // Nothing found: the condition is gone, so its next occurrence is news again.
    delete next.lastHitDigest;
    delete next.lastHitRepeats;
  }
  await ports.context.commit(ports.self.cellId, { statePatches: { [gtdKeys.source]: next }, appendReference });
  return { source: next, repeated };
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
          const r = await recordCheck(ctx.ports, ctx.clock.now(), { hit: { ...hit, ...(uri ? { uri } : {}), ...(artifactId ? { data: { artifactId } } : {}) } }, due[0]!.id);
          const output = r.repeated
            ? "Same as the hit already reported, unchanged since: counted, not reported again."
            : r.source.mode === "observe" ? "Noted (observation mode: no item created)." : "Reported to the desk.";
          return { output, endRun: "completed" };
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
