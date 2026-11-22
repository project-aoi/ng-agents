import {gtdLifecycle,humanActionDomain} from "../../../presets/src";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryChannel, UiChannel } from "@ng/channel";
import { ScriptedModelClient, STANDARD_TOOLSETS, type ScriptResponder, type ScriptTurn } from "@ng/loop";
import {
  all,
  createRegistry,
  ManualClock,
  type BusTopic,
  type BusTopics,
  type ModelRequest,
  type Registry,
} from "@ng/protocol";
import { createKernel, type CellSpecInput, type Kernel, type KernelOptions } from "../src";

export const T0 = Date.UTC(2026, 10, 17, 1, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

const cleanups: Array<() => void | Promise<void>> = [];

export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ngcell-${prefix}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function cleanupAll(): Promise<void> {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best effort
    }
  }
}

/** git in a temp repository only; HOME points at it so no user/system config leaks in. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  }).trim();
}

export function initRepo(): string {
  const dir = tempDir("repo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  writeFileSync(join(dir, "README.md"), "hello\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "app.ts"), "export const answer = 42;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls a condition in real time (for things that happen in other processes, e.g. a job). */
export async function waitFor(cond: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// ==================== scripted model, keyed by role ====================

export type Turn = ScriptTurn | ScriptResponder;

/**
 * One ScriptedModelClient for the whole kernel; each request is answered from the queue of the requesting cell's
 * role (`spec.meta.role`, else its preset, else its id). An exhausted queue answers an empty end_turn (the Run ends).
 */
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

  roleOf(cellId: string): string {
    const cell = this.kernel.getCell(cellId);
    const role = cell?.spec.meta?.["role"];
    return typeof role === "string" ? role : (cell?.preset ?? cellId);
  }

  callsOf(role: string): ModelRequest[] {
    return this.requests.filter((r) => r.role === role).map((r) => r.req);
  }

  #answer(req: ModelRequest, ctx: Parameters<ScriptResponder>[1]): ScriptTurn | Promise<ScriptTurn> {
    const cellId = req.metadata?.cellId ?? "?";
    const role = this.roleOf(cellId);
    this.requests.push({ role, cellId, req });
    const next = this.queues.get(role)?.shift();
    if (next === undefined) return {};
    return typeof next === "function" ? next(req, ctx) : next;
  }
}

// ==================== kernel harness ====================

export const TOOLSETS = STANDARD_TOOLSETS;

/**
 * Minimal ad-hoc presets: just enough processor wiring for kernel tests (the real presets live in @ng/presets).
 * They mirror the real shapes: the desk, projects and hubs coordinate and persist; a worker is a wakeable leaf on the
 * host (isolation "none") — its parent is told when a turn settles and it stays, dormant; a watcher is a one-shot
 * leaf the kernel closes once it has reported and its inbox is drained.
 */
export function registerTestPresets(registry: Registry): void {
  const all = [TOOLSETS.context, TOOLSETS.comms, TOOLSETS.schedule, TOOLSETS.cells, TOOLSETS.workspace];
  registry.presets.register({...gtdLifecycle,
    name: "inline", stateDomain:humanActionDomain,
    description: "test desk",
    defaults: { processor: { kind: "llm", toolsets: all }, lifetime: "persistent", meta: { role: "desk" } },
  });
  registry.presets.register({...gtdLifecycle,
    name: "project",
    description: "test project coordinator",
    defaults: { stallPolicy:"monitor",processor: { kind: "llm", toolsets: all }, lifetime: "persistent", meta: { role: "project" } },
  });
  registry.presets.register({...gtdLifecycle,
    name: "hub",
    description: "test domain hub",
    defaults: { processor: { kind: "llm", toolsets: all }, lifetime: "persistent", absorbInbound: true, meta: { role: "hub" } },
  });
  registry.presets.register({...gtdLifecycle,
    name: "worker",
    description: "test worker",
    defaults: {
      processor: { kind: "llm", toolsets: [TOOLSETS.workspace, TOOLSETS.context, TOOLSETS.comms, TOOLSETS.cells] },
      ccParent:true,lifetime: "wakeable",
      meta: { role: "worker" },
    },
    requestBounds: () => ({ maxDepth: 0 }),
  });
  registry.presets.register({...gtdLifecycle,
    name: "watcher",
    description: "test watcher",
    defaults: {
      processor: { kind: "llm", modelTier: "fast", toolsets: [TOOLSETS.context, TOOLSETS.comms, TOOLSETS.schedule] },
      ccParent:true,lifetime: "one_shot",
      meta: { role: "watcher" },
    },
    requestBounds: () => ({ maxDepth: 0 }),
  });
}

export interface Harness {
  kernel: Kernel;
  clock: ManualClock;
  script: RoleScript;
  registry: Registry;
  memory: MemoryChannel;
  ui: UiChannel;
  dataDir: string;
  events: Array<{ topic: BusTopic; data: unknown }>;
  of<K extends BusTopic>(topic: K): Array<BusTopics[K]>;
  /** Count rows of a table matching a SQL condition. */
  count(sql: string, params?: Array<string | number>): number;
}

export interface BootOptions {
  kernel?: Partial<KernelOptions>;
  /** Registers presets/processors (default registerTestPresets). */
  setup?: (registry: Registry) => void;
  /** Desk spec (default `{ id: "desk", preset: "inline" }`), or false for none. */
  desk?: (CellSpecInput & { id: string }) | false;
  start?: boolean;
  dataDir?: string;
  clock?: ManualClock;
}

export async function boot(opts: BootOptions = {}): Promise<Harness> {
  const dataDir = opts.dataDir ?? tempDir("data");
  const clock = opts.clock ?? new ManualClock(T0);
  const registry = createRegistry();
  (opts.setup ?? registerTestPresets)(registry);
  const script = new RoleScript();
  const memory = new MemoryChannel({ clock });
  const ui = new UiChannel({ clock });
  const kernel = createKernel({
    dataDir,
    clock,
    registry,
    model: script.model,
    channels: [memory, ui],
    retryBackoffMs: 1_000,
    workspace: { limits: { killGraceMs: 300, jobPollMs: 40, previewPollMs: 25 } },
    onError: () => undefined,
    ...opts.kernel,
  });
  script.kernel = kernel;
  cleanups.push(() => kernel.close());
  const events: Harness["events"] = [];
  kernel.bus.on("*", (topic, data) => events.push({ topic, data }));
  if (opts.desk !== false) kernel.ensureRootCell(opts.desk ?? { id: "desk", preset: "inline" });
  if (opts.start !== false) await kernel.start();
  return {
    kernel,
    clock,
    script,
    registry,
    memory,
    ui,
    dataDir,
    events,
    of<K extends BusTopic>(topic: K) {
      return events.filter((e) => e.topic === topic).map((e) => e.data as BusTopics[K]);
    },
    count(sql, params = []) {
      return (all<{ n: number }>(kernel.db, `SELECT COUNT(*) AS n FROM ${sql}`, params)[0]?.n ?? 0);
    },
  };
}

/** A tool call turn (shorthand for scripts). */
export function tool(name: string, input: unknown = {}): ScriptTurn {
  return { toolCalls: [{ name, input }] };
}

/** Text of the latest tool result in a request (what the previous step's tool returned). */
export function lastToolResult(req: ModelRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  const r = last?.content.filter((b) => b.type === "tool_result") ?? [];
  return r.map((b) => (b.type === "tool_result" ? b.content : "")).join("\n");
}

/** All text the model was shown in a request (system excluded). */
export function requestText(req: ModelRequest): string {
  return req.messages
    .flatMap((m) => m.content)
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : JSON.stringify(b.input)))
    .join("\n");
}
