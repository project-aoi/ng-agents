import { gtdKeys, sensorPreset, createScriptSensor } from "@ng/presets";
import { gtdLifecycle, writeActionRecordSync } from "@ng/presets";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryChannel } from "@ng/channel";
import { STANDARD_TOOLSETS } from "@ng/loop";
import { createScriptedLoop, type ModelRequest, ScriptedModelClient, type ScriptResponder, type ScriptTurn } from "@ng/loop/testing";
import type { ActivityRecord, ProjectRecord, SourceState } from "@ng/presets/records";
import {
  ManualClock,
  newId,
  PAYLOAD,
  subjectKeys,
  type ActionRecord,
  type Envelope,
  createRegistry,
  type Registry,
} from "@ng/protocol";
import type { Kernel } from "@ng/cell";
import { registerPresets } from "@ng/presets";
import { createDeskServer, type DeskServer, type DeskServerOptions } from "../src/server/boot";

export const T0 = Date.UTC(2026, 10, 17, 1, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

const cleanups: Array<() => void | Promise<void>> = [];

export async function cleanupAll(): Promise<void> {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best effort
    }
  }
}

export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ngdesk-${prefix}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ==================== scripted model keyed by role (spec.meta.role, else preset) ====================

export type Turn = ScriptTurn | ScriptResponder;

export class RoleScript {
  readonly queues = new Map<string, Turn[]>();
  readonly requests: Array<{ role: string; cellId: string; req: ModelRequest }> = [];
  kernel!: Kernel;
  readonly model = new ScriptedModelClient(((req, ctx) => this.#answer(req, ctx)) as ScriptResponder);

  add(role: string, ...turns: Turn[]): this {
    const q = this.queues.get(role) ?? [];
    q.push(...turns);
    this.queues.set(role, q);
    return this;
  }

  #answer(req: ModelRequest, ctx: Parameters<ScriptResponder>[1]): ScriptTurn | Promise<ScriptTurn> {
    const cellId = req.metadata?.cellId ?? "?";
    const cell = this.kernel.getCell(cellId);
    const r = cell?.spec.meta?.["role"];
    const role = typeof r === "string" ? r : (cell?.preset ?? cellId);
    this.requests.push({ role, cellId, req });
    const next = this.queues.get(role)?.shift();
    if (next === undefined) return {};
    return typeof next === "function" ? next(req, ctx) : next;
  }
}

export function tool(name: string, input: unknown = {}): ScriptTurn {
  return { toolCalls: [{ name, input }] };
}

/** All text a request showed the model (system excluded). */
export function requestText(req: ModelRequest): string {
  return req.messages
    .flatMap((m) => m.content)
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : JSON.stringify((b as { input?: unknown }).input)))
    .join("\n");
}

/** Stand-in presets until @ng/presets lands: just enough processor wiring for the API and projections. */
export function registerTestPresets(registry: Registry): void {
  registry.codeProcessors.register(createScriptSensor());
  const T = STANDARD_TOOLSETS;
  registry.presets.register({...gtdLifecycle,
    name: "inline",
    approvedSpawn(record) {
      if (record.action.type === "project.start") return {
        spec: { id: `project-${record.actionId}`, preset: "project", processor: {kind:"llm"} },
        task: { instruction: record.action.proposal?.outcome ?? record.action.summary },
      };
    },
    description: "test desk",
    defaults: { processor: { kind: "llm", toolsets: [T.context, T.comms, T.schedule, T.cells] }, meta: { role: "desk" } },
  });
  registry.presets.register({...gtdLifecycle, name: "project", projectRoot: true, description:"test project", defaults:{lifetime:"persistent",processor:{kind:"llm",toolsets:[T.context,T.comms,T.cells]},meta:{role:"project"}}});
  registry.presets.register({...gtdLifecycle, name: "worker", description: "test worker", defaults: { processor: { kind: "llm", toolsets: [T.context, T.comms] }, ccParent:true,lifetime:"wakeable",meta: { role: "worker" } } });
  registry.presets.register({...gtdLifecycle, name: "checker", description: "test checker", defaults: { processor: { kind: "llm", modelTier: "fast", toolsets: [T.context, T.comms, T.schedule] }, ccParent:true,lifetime:"one_shot",meta: { role: "checker" } } });
  registry.presets.register({...sensorPreset(), ...gtdLifecycle, name: "sensor", description: "test sensor", defaults: { processor: { kind: "llm", modelTier: "fast", toolsets: [T.context, T.comms] }, meta: { role: "sensor" } } });
}

// ==================== a desk server on an in-memory kernel ====================

export interface TestDesk {
  server: DeskServer;
  kernel: Kernel;
  clock: ManualClock;
  script: RoleScript;
  memory: MemoryChannel;
  req<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: T; headers: Headers }>;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
}

export async function bootDesk(opts: Partial<DeskServerOptions> & { clock?: ManualClock } = {}): Promise<TestDesk> {
  const clock = opts.clock ?? new ManualClock(T0);
  const script = new RoleScript();
  const memory = new MemoryChannel({ clock });
  const registry = opts.kernel?.registry ?? createRegistry();
  const server = await createDeskServer({
    env: {},
    dataDir: tempDir("data"),
    detectCli: () => true,
    clock,
    channels: [memory],
    registerPresets: registerTestPresets,
    webDir: null,
    log: () => undefined,
    onError: () => undefined,
    ...opts,
    kernel: { registry, ...(opts.detectCli ? {} : { loop: createScriptedLoop({model: script.model, registry, clock}), agentBackend: undefined }), db: ":memory:", retryBackoffMs: 1_000, ...opts.kernel },
  });
  script.kernel = server.kernel;
  cleanups.push(() => server.close());
  async function req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await server.app.request(path, init);
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }
  return {
    server,
    kernel: server.kernel,
    clock,
    script,
    memory,
    req,
    async get<T>(path: string) {
      const r = await req<T>("GET", path);
      if (r.status !== 200) throw new Error(`GET ${path} → ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    },
    async post<T>(path: string, body: unknown = {}) {
      const r = await req<T>("POST", path, body);
      if (r.status !== 200) throw new Error(`POST ${path} → ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    },
  };
}

/** A desk with the real presets (project, hub, worker, checker …) and the scripted model; no weekly-review timer. */
export function bootRealDesk(opts: Partial<DeskServerOptions> & { clock?: ManualClock } = {}): Promise<TestDesk> {
  return bootDesk({ registerPresets: (registry, o) => registerPresets(registry, { ...o, weeklyReview: false }), ...opts });
}

/** The cell.message envelopes a cell has received (any status), oldest first. */
export function cellMessages(kernel: Kernel, cellId: string): Envelope[] {
  return kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.cellMessage }).map((m) => m.envelope);
}

/** Model requests a cell made, as plain text. */
export function requestsOf(script: RoleScript, cellId: string): string[] {
  return script.requests.filter((r) => r.cellId === cellId).map((r) => requestText(r.req));
}

// ==================== writing records and cards directly ====================

export function writeAction(kernel: Kernel, cellId: string, a: Partial<ActionRecord> & Pick<ActionRecord, "title" | "owner">): ActionRecord {
  const t = kernel.clock.now();
  const record: ActionRecord = { id: newId("act", kernel.clock), status: "open", createdAt: t, updatedAt: t, ...a };
  writeActionRecordSync(kernel, cellId, record);
  return record;
}

type ProjectSetup = Partial<Omit<ProjectRecord, "lifecycle">> & {cwd?: string; lifecycle?: ProjectRecord["lifecycle"] | "someday"};

export function writeProject(kernel: Kernel, cellId: string, p: ProjectSetup & Pick<ProjectRecord, "title">): ProjectRecord {
  const t = kernel.clock.now();
  const { cwd, lifecycle = "active", ...fields } = p;
  if (cwd) kernel.updateCell(cellId, { cwd }, { principalId: kernel.ownerPrincipal });
  if (lifecycle === "someday") kernel.control(cellId, { action: "pause", pauseReason: "parked" }, { principalId: kernel.ownerPrincipal });
  const record: ProjectRecord = { lifecycle: lifecycle === "someday" ? "active" : lifecycle, createdAt: t, updatedAt: t, ...fields };
  kernel.context.commitSync(cellId, { statePatches: { [gtdKeys.project]: record } });
  return record;
}

export function writeActivity(kernel: Kernel, a: Partial<ActivityRecord> & Pick<ActivityRecord, "kind" | "title">, cellId = "desk"): ActivityRecord {
  const record: ActivityRecord = { id: newId("acty", kernel.clock), at: kernel.clock.now(), restorable: false, ...a };
  kernel.context.commitSync(cellId, { statePatches: { [gtdKeys.activity(record.id)]: record } });
  return record;
}

export function writeSource(kernel: Kernel, cellId: string, s: Partial<SourceState> & Pick<SourceState, "title">): SourceState {
  const t = kernel.clock.now();
  const record: SourceState = { mode: "active", runCount: 0, hitCount: 0, createdAt: t, updatedAt: t, ...s };
  kernel.context.commitSync(cellId, { statePatches: { [gtdKeys.source]: record } });
  return record;
}

/** A project root cell under the desk holding `gtd:project`. */
export function makeProject(kernel: Kernel, title: string, p: ProjectSetup = {}): string {
  const id = newId("proj", kernel.clock);
  kernel.spawnCell("desk", { id, preset: "project", title, meta: { projectCellId: id }, stallPolicy: "monitor" }, undefined, { principalId: kernel.ownerPrincipal });
  writeProject(kernel, id, { title, ...p });
  return id;
}

/** An inbound user.message envelope as a channel would have produced it (stored in the desk's inbox as done). */
export function inboundEnvelope(kernel: Kernel, text: string, from = "alice"): Envelope {
  return {
    id: newId("env", kernel.clock),
    from: `channel:memory:${from}`,
    principalId: `memory:${from}`,
    kind: "event",
    type: PAYLOAD.userMessage,
    payload: { text, replyTo: `channel:memory:${from}`, sender: { id: from } },
    createdAt: kernel.clock.now(),
  };
}

export interface ReviewCardOptions {
  cellId?: string;
  text?: string;
  subjectKey?: string;
  title?: string;
  rawInput?: string;
  envelopeId?: string;
}

/** A review decision bound to a versioned draft. */
export function makeReviewCard(kernel: Kernel, o: ReviewCardOptions = {}): { actionId: string; artifactId: string; subjectKey: string } {
  const cellId = o.cellId ?? "desk";
  const text = o.text ?? "您好，接口下周二上线。";
  const artifactId = newId("art", kernel.clock);
  const subjectKey = o.subjectKey ?? subjectKeys.inbound(newId("env", kernel.clock));
  const saved = kernel.context.commitSync(cellId, { artifact: { artifactId, content: { format: "text", body: text }, updatedBy: "agent" } });
  if (!saved.ok) throw new Error("draft not saved");
  const title = o.title ?? "审阅发布计划";
  const card = { format: "card" as const, title, body: text };
  const cell = kernel.getCell(cellId)!;
  const r = kernel.gate.authorizeSync(
    {
      type: "custom",
      name: "review",
      artifactId,
      summary: title,
      subjectKey,
      sideEffect: "external",
      card,
    },
    { cellId, principalId: `cell:${cellId}`, epoch: cell.epoch, artifactVersion: 1 },
  );
  if (r.type !== "defer") throw new Error(`expected a card, got ${r.type}`);
  return { actionId: r.actionId, artifactId, subjectKey };
}

/** The background rewrites a draft (agent over agent: accepted). */
export function agentRedraft(kernel: Kernel, artifactId: string, body: string, expectedVersion?: number) {
  const a = kernel.context.getArtifactSync(artifactId)!;
  return kernel.context.commitSync(a.cellId, {
    artifact: { artifactId, content: { format: a.content.format, body }, updatedBy: "agent", ...(expectedVersion !== undefined ? { expectedVersion } : {}) },
  });
}
