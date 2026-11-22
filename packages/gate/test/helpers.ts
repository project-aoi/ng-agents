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
  type ProjectStartAction,
  type Db,
  type PolicyBounds,
  type ProposedAction,
} from "@ng/protocol";
import { createGate, type GateOptions, type GateService } from "../src";

export const DESK_BOUNDS: BoundsInit = {
  tools: ["read", "write", "edit", "bash"],
  canSendTo: ["inbox:*", "channel:ui:*"],
  maxConcurrentChildren: 3,
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
    ...over,
  });
  const cells = cellsRepo(db, clock);
  const addCell: Fixture["addCell"] = (id, parentId, bounds) => {
    cells.insert({ id, parentId, ...(bounds ? { bounds: makeBounds(bounds) } : {}) });
  };
  addCell("desk", null, DESK_BOUNDS);
  return { db, clock, gate, cells, events, addCell };
}

export function withWorker(f: Fixture, id = "w1", requested: Partial<PolicyBounds> = {}): PolicyBounds {
  const parent = f.cells.require("desk");
  const bounds = f.gate.attenuate(parent.bounds, "desk", {
    tools: new Set(["read", "write", "edit", "bash"]),

    ...requested,
  });
  f.cells.insert({ id, parentId: "desk", bounds });
  return bounds;
}

export function meta(cellId: string, epoch = 0, extra: Partial<AuthorizeMeta> = {}): AuthorizeMeta {
  return { cellId, principalId: `cell:${cellId}`, epoch, ...extra };
}

export function proposal(over: Partial<ProjectStartAction> = {}): ProjectStartAction {
  return { type: "project.start", summary: "立项", proposal: { title: "测试项目", outcome:"交付报告", actions: [] }, subjectKey: "project:one", sideEffect: "external", ...over };
}

export function exec(tool: string, over: Record<string, unknown> = {}): ProposedAction {
  return { type: "custom", name:tool, summary: `run ${tool}`, subjectKey: "cell:w1", sideEffect: "internal", tool, args: {}, ...over } as ProposedAction;
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
