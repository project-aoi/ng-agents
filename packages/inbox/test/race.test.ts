import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { all, cellsRepo, createBus, openDatabase, systemClock } from "@ng/protocol";
import { createInbox } from "../src";
import { msg } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface WorkerResult {
  claimed: number[];
  batches: number;
}

async function race(workers: number, preload: number, producePerWorker: number) {
  const dir = mkdtempSync(join(tmpdir(), "ng-inbox-race-"));
  dirs.push(dir);
  const path = join(dir, "ng.db");
  const db = openDatabase(path);
  cellsRepo(db, systemClock).insert({ id: "hot" });
  const inbox = createInbox({ db, bus: createBus(), clock: systemClock });
  for (let i = 0; i < preload; i++) inbox.enqueueSync("hot", msg({ id: `race-${i}` }));
  const total = preload + workers * producePerWorker;

  const shared = new SharedArrayBuffer(16);
  const flags = new Int32Array(shared);
  const threads = [...Array(workers)].map(
    (_, i) =>
      new Worker(new URL("./race-worker.ts", import.meta.url), {
        execArgv: ["--import", "tsx"],
        workerData: { path, cellId: "hot", workerId: `t${i}`, produce: producePerWorker, total, shared },
      }),
  );
  const results = threads.map(
    (w) =>
      new Promise<WorkerResult>((resolve, reject) => {
        w.once("message", resolve);
        w.once("error", reject);
      }),
  );
  await new Promise((r) => setTimeout(r, 300)); // let every thread reach the barrier
  Atomics.store(flags, 0, 1);
  Atomics.notify(flags, 0);
  const out = await Promise.all(results);

  const seqs = out.flatMap((r) => r.claimed);
  const statuses = all<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM inbox_messages GROUP BY status");
  const claims = all<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM inbox_claims GROUP BY status");
  db.close();
  return { seqs, maxHeld: Atomics.load(flags, 2), batches: out.map((r) => r.batches), statuses, claims };
}

describe("races across threads and connections (WAL file)", () => {

  it("serial_coalesce: never two live claims for the cell, nothing claimed twice", { timeout: 60_000 }, async () => {
    const r = await race(4, 20, 50);
    expect(r.maxHeld).toBe(1);
    expect(r.seqs).toHaveLength(220);
    expect(new Set(r.seqs).size).toBe(220);
    expect(r.statuses).toEqual([{ status: "done", n: 220 }]);
    // producers kept adding while Runs were in flight, so the work arrived in several coalesced batches, and
    // several threads took turns holding the cell — the max-held check above covered real contention
    expect(r.batches.reduce((a, b) => a + b, 0)).toBeGreaterThan(1);
    expect(r.batches.filter((b) => b > 0).length).toBeGreaterThan(1);
  });
});

describe("dispatcher polling stays read-only when nothing is due", () => {
  it("claim/tick/dueCellIds/nextWakeAt do not need the write lock another connection holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "ng-inbox-lock-"));
    dirs.push(dir);
    const path = join(dir, "ng.db");
    const writer = openDatabase(path);
    cellsRepo(writer, systemClock).insert({ id: "idle" });
    const db = openDatabase(path, { busyTimeoutMs: 50 });
    const inbox = createInbox({ db, bus: createBus(), clock: systemClock });
    inbox.enqueueSync("idle", msg({ id: "future" }), { deliverAt: Date.now() + 3_600_000 });

    writer.exec("BEGIN IMMEDIATE");
    try {
      const started = Date.now();
      expect(inbox.claimNextRunSync("idle", "k")).toBeNull();
      expect(inbox.tickSync()).toEqual({ fired: 0, dueCellIds: [], expiredClaims: 0 });
      expect(inbox.dueCellIdsSync()).toEqual([]);
      expect(inbox.nextWakeAtSync()).toBeGreaterThan(Date.now());
      expect(Date.now() - started).toBeLessThan(40); // no busy-wait on the held lock
      // writes do need the lock: they surface the contention (busy) instead of silently doing nothing
      expect(() => inbox.enqueueSync("idle", msg({ id: "now" }))).toThrow(/locked|busy/i);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
      db.close();
    }
  });
});
