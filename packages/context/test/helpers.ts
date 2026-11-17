import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  all,
  cellsRepo,
  createBus,
  createEnvelope,
  createRegistry,
  ManualClock,
  mergeAdjacentMessages,
  newId,
  NgError,
  openDatabase,
  run,
  type BusTopic,
  type CellInsert,
  type ClaimedBatch,
  type ContextMode,
  type ContextStore,
  type Db,
  type Envelope,
  type EnqueueResult,
  type InboxWriter,
  type ModelMessage,
  type PromptSnapshot,
  type ScheduleRule,
  type StepOrExternalEvidence,
} from "@ng/protocol";
import { createContextStore, type ContextStoreOptions } from "../src";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ng-context-"));
  dirs.push(d);
  return d;
}

/**
 * Stand-in for @ng/inbox: writes one row per enqueue into a test-only table on the same connection, so a rolled
 * back commit leaves no row. Cells listed in `reject` throw like the real Inbox does for an unknown cell.
 */
export class FakeInbox implements InboxWriter {
  readonly reject = new Set<string>();
  constructor(private readonly db: Db) {
    db.exec("CREATE TABLE IF NOT EXISTS test_inbox (cell_id TEXT NOT NULL, envelope_id TEXT NOT NULL, envelope TEXT NOT NULL, schedule TEXT)");
  }
  enqueueSync(cellId: string, env: Envelope, schedule?: ScheduleRule): EnqueueResult {
    if (this.reject.has(cellId)) throw new NgError("not_found", `cell "${cellId}" not found`);
    run(this.db, "INSERT INTO test_inbox (cell_id, envelope_id, envelope, schedule) VALUES (?, ?, ?, ?)", [
      cellId,
      env.id,
      JSON.stringify(env),
      schedule ? JSON.stringify(schedule) : null,
    ]);
    return "accepted";
  }
  rows(): Array<{ cellId: string; envelope: Envelope; schedule: ScheduleRule | null }> {
    return all<{ cell_id: string; envelope: string; schedule: string | null }>(this.db, "SELECT * FROM test_inbox ORDER BY rowid").map((r) => ({
      cellId: r.cell_id,
      envelope: JSON.parse(r.envelope) as Envelope,
      schedule: r.schedule ? (JSON.parse(r.schedule) as ScheduleRule) : null,
    }));
  }
}

export interface Harness {
  db: Db;
  clock: ManualClock;
  events: Array<{ topic: BusTopic; data: unknown }>;
  cells: ReturnType<typeof cellsRepo>;
  dataDir: string;
  inbox: FakeInbox;
  registry: ReturnType<typeof createRegistry>;
  store: ContextStore;
  makeStore(extra?: Partial<ContextStoreOptions>): ContextStore;
}

export function setup(opts: { cells?: CellInsert[]; store?: Partial<ContextStoreOptions> } = {}): Harness {
  const db = openDatabase(":memory:");
  const clock = new ManualClock(1_763_366_400_000);
  const bus = createBus();
  const events: Harness["events"] = [];
  bus.on("*", (topic, data) => events.push({ topic, data }));
  const cells = cellsRepo(db, clock);
  for (const c of opts.cells ?? [{ id: "desk" }]) cells.insert(c);
  const dataDir = tempDir();
  const inbox = new FakeInbox(db);
  const registry = createRegistry();
  const makeStore = (extra: Partial<ContextStoreOptions> = {}) =>
    createContextStore({ db, bus, clock, inbox, dataDir, registry, ...opts.store, ...extra });
  return { db, clock, events, cells, dataDir, inbox, registry, store: makeStore(), makeStore };
}

export function userEnvelope(clock: ManualClock, text: string, extra: Partial<Envelope> = {}): Envelope {
  return createEnvelope(
    { from: "channel:ui:owner", principalId: "owner", kind: "event", type: "user.message", payload: { text }, ...extra },
    clock,
  );
}

export function batchOf(cellId: string, envelopes: Envelope[], epoch = 0, clock?: ManualClock): ClaimedBatch {
  const now = clock?.now() ?? 0;
  return {
    claimId: newId("claim"),
    cellId,
    epoch,
    workerId: "w1",
    mode: "serial_coalesce",
    envelopes,
    seqs: envelopes.map((_, i) => i + 1),
    claimedAt: now,
    leaseExpiresAt: now + 60_000,
  };
}

export type Step = (runId: string) => StepOrExternalEvidence[];

/** What the kernel does around a Run: hydrate, then run_boundary start + one inbound per envelope, the Loop's steps, run_boundary end. */
export function simulateRun(
  h: Pick<Harness, "store" | "clock">,
  cellId: string,
  envelopes: Envelope[],
  steps: Step,
  o: { mode?: ContextMode; crash?: boolean } = {},
): PromptSnapshot {
  const batch = batchOf(cellId, envelopes, 0, h.clock);
  const snap = h.store.hydrateSync(cellId, batch, o.mode ?? "isolated");
  const runId = batch.claimId;
  const at = () => h.clock.now();
  h.store.appendEvidenceSync(cellId, { kind: "run_boundary", phase: "start", epoch: 0, runId, at: at() });
  for (const envelope of envelopes) h.store.appendEvidenceSync(cellId, { kind: "inbound", envelope, runId, at: at() });
  for (const rec of steps(runId)) {
    h.clock.advance(10);
    h.store.appendEvidenceSync(cellId, rec);
  }
  if (!o.crash) h.store.appendEvidenceSync(cellId, { kind: "run_boundary", phase: "end", epoch: 0, outcome: "completed", runId, at: at() });
  h.clock.advance(1000);
  return snap;
}

export const json = (x: unknown) => JSON.stringify(x);

/** The provider-facing invariants Context promises for `[...history, ...tail.messages]` after merging. */
export function assertWireInvariants(messages: readonly ModelMessage[]): string[] {
  const problems: string[] = [];
  const merged = mergeAdjacentMessages(messages.map((m) => ({ role: m.role, content: [...m.content] })));
  if (merged.length > 0 && merged[0]!.role !== "user") problems.push("does not start with a user message");
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i]!;
    if (i > 0 && merged[i - 1]!.role === m.role) problems.push(`roles do not alternate at ${i}`);
    if (m.role === "assistant") {
      const ids = m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
      const next = merged[i + 1];
      const answered = new Set(
        (next?.content ?? []).filter((b) => b.type === "tool_result").map((b) => (b as { toolUseId: string }).toolUseId),
      );
      for (const id of ids) if (!answered.has(id)) problems.push(`tool_use ${id} at ${i} is not answered in the next message`);
      if (m.content.some((b) => b.type === "tool_result")) problems.push(`assistant message ${i} holds a tool_result`);
    } else {
      const prev = merged[i - 1];
      const asked = new Set((prev?.role === "assistant" ? prev.content : []).filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id));
      let seenOther = false;
      for (const b of m.content) {
        if (b.type === "tool_use") problems.push(`user message ${i} holds a tool_use`);
        if (b.type === "tool_result") {
          if (seenOther) problems.push(`tool_result after text in message ${i}`);
          if (!asked.has(b.toolUseId)) problems.push(`orphan tool_result ${b.toolUseId} in message ${i}`);
        } else seenOther = true;
        if (b.type === "text" && b.text === "") problems.push(`empty text block in message ${i}`);
      }
    }
  }
  return problems;
}

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
