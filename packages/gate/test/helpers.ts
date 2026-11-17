import {
  ManualClock,
  cellsRepo,
  createBus,
  makeBounds,
  openDatabase,
  run,
  type AuthorizeMeta,
  type AuthorizeResult,
  type BoundsInit,
  type BusTopic,
  type CellsRepo,
  type ChannelAddr,
  type Db,
  type PolicyBounds,
  type ProposedAction,
} from "@ng/protocol";
import { createGate, memorySecretStore, type GateOptions, type GateService } from "../src";

export const SECRET_VALUE = "ghp_TOP_SECRET_value_0123456789";
export const OWNER_UI: ChannelAddr = "channel:ui:owner";

export const DESK_BOUNDS: BoundsInit = {
  tools: ["read", "write", "edit", "bash", "code_rpc"],
  canSendTo: ["inbox:*", "channel:ui:*", "channel:feishu:*"],
  secretRefs: ["github", "feishu"],
  isolation: "none",
  maxConcurrentChildren: 3,
  maxTokens: 1_000_000,
  maxCents: 10_000,
  maxDepth: 3,
};

export interface Fixture {
  db: Db;
  clock: ManualClock;
  gate: GateService;
  cells: CellsRepo;
  events: Array<{ topic: BusTopic; data: unknown }>;
  addCell(id: string, parentId: string | null, bounds?: BoundsInit): void;
}

export function setup(over: Partial<GateOptions> = {}): Fixture {
  const db = openDatabase(":memory:");
  const clock = new ManualClock(1_000_000);
  const bus = createBus();
  const events: Fixture["events"] = [];
  bus.on("*", (topic, data) => events.push({ topic, data }));
  const gate = createGate({
    db,
    bus,
    clock,
    secrets: memorySecretStore({ github: SECRET_VALUE }),
    ownerAddresses: ["channel:ui:*"],
    ...over,
  });
  const cells = cellsRepo(db, clock);
  const addCell: Fixture["addCell"] = (id, parentId, bounds) => {
    cells.insert({ id, parentId, ...(bounds ? { bounds: makeBounds(bounds) } : {}) });
  };
  addCell("desk", null, DESK_BOUNDS);
  return { db, clock, gate, cells, events, addCell };
}

/** desk → w1 (worker, git_worktree, may report to desk only) with bounds from gate.attenuate. */
export function withWorker(f: Fixture, id = "w1", requested: Partial<PolicyBounds> = {}): PolicyBounds {
  const parent = f.cells.require("desk");
  const bounds = f.gate.attenuate(parent.bounds, "desk", {
    tools: new Set(["read", "write", "edit", "bash"]),
    secretRefs: new Set(["github"]),
    isolation: "git_worktree",
    maxTokens: 100_000,
    maxCents: 1_000,
    ...requested,
  });
  f.cells.insert({ id, parentId: "desk", bounds });
  return bounds;
}

export function meta(cellId: string, epoch = 0, extra: Partial<AuthorizeMeta> = {}): AuthorizeMeta {
  return { cellId, principalId: `cell:${cellId}`, epoch, ...extra };
}

export function send(target: string, over: Record<string, unknown> = {}): ProposedAction {
  return {
    type: "channel.send",
    summary: "回复张三的报价问题",
    subjectKey: "msg:env_1",
    sideEffect: "external",
    target,
    content: { format: "text", body: "报价单已附上" },
    ...over,
  } as ProposedAction;
}

export function exec(tool: string, over: Record<string, unknown> = {}): ProposedAction {
  return { type: "workspace.exec", summary: `run ${tool}`, subjectKey: "cell:w1", sideEffect: "internal", tool, args: {}, ...over } as ProposedAction;
}

export function secretUse(secretRef: string, over: Record<string, unknown> = {}): ProposedAction {
  return { type: "secret.use", summary: "call GitHub API", subjectKey: "cell:w1", sideEffect: "internal", secretRef, ...over } as ProposedAction;
}

export function putArtifact(
  db: Db,
  a: { artifactId: string; cellId: string; version: number; body: string; by?: "agent" | "human"; at?: number },
): void {
  const content = JSON.stringify({ format: "markdown", body: a.body });
  const by = a.by ?? "agent";
  const at = a.at ?? 1;
  run(
    db,
    `INSERT INTO artifacts (artifact_id, cell_id, version, title, format, content, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'markdown', ?, ?, ?, ?)
     ON CONFLICT(artifact_id) DO UPDATE SET version = excluded.version, content = excluded.content,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [a.artifactId, a.cellId, a.version, content, by, at, at],
  );
  run(db, "INSERT INTO artifact_versions (artifact_id, version, content, updated_by, created_at) VALUES (?, ?, ?, ?, ?)", [
    a.artifactId,
    a.version,
    content,
    by,
    at,
  ]);
}

export function expectType<T extends AuthorizeResult["type"]>(r: AuthorizeResult, type: T): Extract<AuthorizeResult, { type: T }> {
  if (r.type !== type) throw new Error(`expected ${type}, got ${JSON.stringify(r)}`);
  return r as Extract<AuthorizeResult, { type: T }>;
}

/** Deterministic PRNG (mulberry32) for property tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
