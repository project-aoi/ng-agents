import { readHumanActionRecords } from "../src";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryChannel, UiChannel } from "@ng/channel";
import { createKernel, type Kernel, type KernelOptions } from "@ng/cell";
import { createScriptedLoop, ScriptedModelClient, type ModelRequest, type ScriptResponder, type ScriptTurn } from "@ng/loop/testing";
import { gtdKeys } from "../src/shared/keys";
import {
  asDecisionCard,
  createRegistry,
  ManualClock,
  type ActionRecord,
  type ActivityRecord,
  type ApprovalRecord,
  type BusTopic,
  type BusTopics,
  type DecisionCard,
  type ProjectRecord,
  type Registry,
  type SourceRecord,
} from "@ng/protocol";
import { registerPresets, type RegisterPresetsOptions } from "../src";

/** 2026-11-17 09:00 in Asia/Shanghai (a Tuesday). */
export const T0 = Date.UTC(2026, 10, 17, 1, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

const cleanups: Array<() => void | Promise<void>> = [];
const scripts: RoleScript[] = [];

export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ngpresets-${prefix}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Closes every kernel, then fails the test if a scripted responder's own assertion threw (the kernel would only retry). */
export async function cleanupAll(): Promise<void> {
  const errors = scripts.splice(0).flatMap((s) => s.errors);
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best effort
    }
  }
  if (errors.length) throw errors[0];
}

export type Turn = ScriptTurn | ScriptResponder;

/**
 * One scripted model for the whole kernel. Each request is answered from the queue of the requesting cell's role
 * (`spec.meta.role` — the presets set desk / project / worker / checker / checker / sensor / hub), then from that
 * role's default responder; otherwise an empty end_turn.
 */
export class RoleScript {
  readonly queues = new Map<string, Turn[]>();
  readonly defaults = new Map<string, ScriptResponder>();
  readonly requests: Array<{ role: string; cellId: string; req: ModelRequest }> = [];
  readonly errors: unknown[] = [];
  kernel!: Kernel;

  constructor() {
    scripts.push(this);
  }
  readonly model = new ScriptedModelClient(((req, ctx) => this.#answer(req, ctx)) as ScriptResponder);

  add(role: string, ...turns: Turn[]): this {
    const q = this.queues.get(role) ?? [];
    q.push(...turns);
    this.queues.set(role, q);
    return this;
  }

  setDefault(role: string, responder: ScriptResponder): this {
    this.defaults.set(role, responder);
    return this;
  }

  roleOf(cellId: string): string {
    const cell = this.kernel.getCell(cellId);
    const role = cell?.spec.meta?.["role"];
    return typeof role === "string" ? role : (cell?.preset ?? cellId);
  }

  callsOf(role: string): ModelRequest[] {
    return this.requests.filter((r) => r.role === role).map((r) => r.req);
  }

  pending(role: string): number {
    return this.queues.get(role)?.length ?? 0;
  }

  #answer(req: ModelRequest, ctx: Parameters<ScriptResponder>[1]): ScriptTurn | Promise<ScriptTurn> {
    const cellId = req.metadata?.cellId ?? "?";
    const role = this.roleOf(cellId);
    this.requests.push({ role, cellId, req });
    const next = this.queues.get(role)?.shift();
    try {
      if (next !== undefined) return typeof next === "function" ? next(req, ctx) : next;
      const dflt = this.defaults.get(role);
      return dflt ? dflt(req, ctx) : {};
    } catch (err) {
      this.errors.push(err);
      throw err;
    }
  }
}

export interface Harness {
  kernel: Kernel;
  clock: ManualClock;
  script: RoleScript;
  registry: Registry;
  memory: MemoryChannel;
  ui: UiChannel;
  events: Array<{ topic: BusTopic; data: unknown }>;
  of<K extends BusTopic>(topic: K): Array<BusTopics[K]>;
  /** Owner notifications, oldest first. */
  notices(): string[];
  /** Pending decision cards (snoozed included). */
  cards(): Array<ApprovalRecord & { decision: DecisionCard }>;
  actions(cellId?: string): ActionRecord[];
  activities(): ActivityRecord[];
  project(rootId: string): ProjectRecord | null;
  source(cellId: string): SourceRecord | null;
  state<T>(cellId: string, key: string): T | null;
  /** Desk runs so far. */
  deskRuns(): number;
}

export interface BootOptions {
  presets?: RegisterPresetsOptions;
  setup?: (registry: Registry) => void;
  kernel?: Partial<KernelOptions>;
}

export async function boot(opts: BootOptions = {}): Promise<Harness> {
  const dataDir = tempDir("data");
  const clock = new ManualClock(T0);
  const registry = createRegistry();
  // Tests that jump the clock across a Friday would otherwise also wake the desk for its weekly review.
  registerPresets(registry, { weeklyReview: false, ...opts.presets });
  opts.setup?.(registry);
  const script = new RoleScript();
  const memory = new MemoryChannel({ clock });
  const ui = new UiChannel({ clock });
  const kernel = createKernel({
    dataDir,
    clock,
    registry,
    loop: createScriptedLoop({ model: script.model, registry, clock }),
    channels: [memory, ui],
    retryBackoffMs: 1_000,
    workspace: { limits: { killGraceMs: 300, jobPollMs: 40 } },
    onError: () => undefined,
    ...opts.kernel,
  });
  script.kernel = kernel;
  cleanups.push(() => kernel.close());
  const events: Harness["events"] = [];
  kernel.bus.on("*", (topic, data) => events.push({ topic, data }));
  kernel.ensureRootCell({ id: "desk", preset: "inline" });
  await kernel.start();
  const h: Harness = {
    kernel,
    clock,
    script,
    registry,
    memory,
    ui,
    events,
    of<K extends BusTopic>(topic: K) {
      return events.filter((e) => e.topic === topic).map((e) => e.data as BusTopics[K]);
    },
    notices: () => kernel.hub.listNotificationsSync().reverse().map((r) => r.content.body),
    cards: () =>
      kernel.gate.listPendingSync({ includeSnoozed: true }).map((a) => {
        const decision = asDecisionCard(a.card.data);
        if (!decision) throw new Error(`approval ${a.actionId} has no DecisionCard`);
        return { ...a, decision };
      }),
    actions: (cellId) => kernel.context.queryStateSync({ keyPrefix: gtdKeys.actionPrefix, ...(cellId ? { cellIds: [cellId] } : {}) }).map((e) => e.value as ActionRecord).concat(readHumanActionRecords(kernel.db, kernel.deskCellId, cellId).map(e=>e.record)),
    activities: () => kernel.context.queryStateSync({ keyPrefix: gtdKeys.activityPrefix, cellIds: ["desk"] }).map((e) => e.value as ActivityRecord),
    project: rootId => kernel.context.readStateSync<ProjectRecord>(rootId, gtdKeys.project),
    source: (cellId) => kernel.context.readStateSync<SourceRecord>(cellId, gtdKeys.source),
    state: (cellId, key) => kernel.context.readStateSync(cellId, key),
    deskRuns: () => events.filter((e) => e.topic === "run.started" && (e.data as { cellId: string }).cellId === "desk").length,
  };
  return h;
}

export function tool(name: string, input: unknown = {}): ScriptTurn {
  return { toolCalls: [{ name, input }] };
}

/** All text a request showed the model (system excluded). */
export function requestText(req: ModelRequest): string {
  return req.messages
    .flatMap((m) => m.content)
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : JSON.stringify(b.input)))
    .join("\n");
}

/** The latest tool results in a request (what the previous step's tools returned). */
export function lastToolResult(req: ModelRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  return (last?.content ?? []).map((b) => (b.type === "tool_result" ? b.content : "")).join("\n");
}

/**
 * Does this request continue a Run after a tool call (rather than start on new messages)? A new batch is merged into
 * the same user message as the previous Run's last tool results, so only the final block tells.
 */
export function continuesRun(req: ModelRequest): boolean {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  return last?.content.at(-1)?.type === "tool_result";
}

/** The projects the desk started, oldest first. */
export function projects(h: Harness): string[] {
  return h.kernel.listCells({ parentId: "desk" }).filter((c) => c.spec.meta?.["role"] === "project").map((c) => c.id);
}

/** Children of a cell (any status), oldest first. */
export function childrenOf(h: Harness, cellId: string, role?: string): string[] {
  return h.kernel
    .listCells({ parentId: cellId })
    .filter((c) => role === undefined || c.spec.meta?.["role"] === role)
    .map((c) => c.id);
}

/** A git repository with one commit, as a project's directory on "the owner's machine". */
export function gitRepo(prefix = "repo"): string {
  const dir = tempDir(prefix);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

/** The system prompt a cell's latest model request carried. */
export function systemOf(h: Harness, cellId: string): string {
  const req = h.script.requests.filter((r) => r.cellId === cellId).at(-1)?.req;
  return req?.system ?? "";
}
