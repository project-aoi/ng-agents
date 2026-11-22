import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  all,
  cellsRepo,
  createBus,
  ManualClock,
  openDatabase,
  run,
  type BusTopic,
  type Db,
  type EnqueueResult,
  type Envelope,
  type InboxWriter,
} from "@ng/protocol";
import { createWorkspaceManager, type WorkspaceManager, type WorkspaceManagerOptions } from "../src";

const cleanups: Array<() => void> = [];

export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ngws-${prefix}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function cleanupAll(): void {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      // best effort
    }
  }
}

/** git in a temp repository only; HOME points at the repo so no user/system config leaks in. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
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

/**
 * Stands in for Inbox.enqueueSync. It writes into a table of the same database, so it takes part in the caller's
 * transaction exactly like the real inbox (a rollback removes the row). `failNext` simulates a crash inside the
 * completion transaction.
 */
export class FakeInbox implements InboxWriter {
  failNext = 0;
  calls = 0;

  constructor(private readonly db: Db) {
    db.exec(`CREATE TABLE IF NOT EXISTS fake_inbox (
      cell_id TEXT NOT NULL, envelope_id TEXT NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY (cell_id, envelope_id))`);
  }

  enqueueSync(cellId: string, env: Envelope): EnqueueResult {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("simulated failure inside the completion transaction");
    }
    const r = run(this.db, "INSERT OR IGNORE INTO fake_inbox (cell_id, envelope_id, envelope) VALUES (?, ?, ?)", [cellId, env.id, JSON.stringify(env)]);
    return r.changes ? "accepted" : "deduped";
  }

  list(cellId?: string): Envelope[] {
    const rows = all<{ envelope: string }>(
      this.db,
      cellId ? "SELECT envelope FROM fake_inbox WHERE cell_id = ? ORDER BY rowid" : "SELECT envelope FROM fake_inbox ORDER BY rowid",
      cellId ? [cellId] : [],
    );
    return rows.map((r) => JSON.parse(r.envelope) as Envelope);
  }
}

export interface Harness {
  db: Db;
  clock: ManualClock;
  bus: ReturnType<typeof createBus>;
  events: Array<{ topic: BusTopic; data: unknown }>;
  inbox: FakeInbox;
  dataDir: string;
  mgr: WorkspaceManager;
  cells: ReturnType<typeof cellsRepo>;
  /** Builds a second manager on the same database and data dir (a "restarted kernel"). */
  restart(extra?: Partial<WorkspaceManagerOptions>): WorkspaceManager;
}

export const FAST_LIMITS = { killGraceMs: 300, jobPollMs: 40, bashTimeoutMs: 20_000 };

export function harness(extra: Partial<WorkspaceManagerOptions> = {}, cellIds: string[] = ["desk", "w1", "w2"]): Harness {
  const db = openDatabase(":memory:");
  const clock = new ManualClock(1_000_000);
  const bus = createBus();
  const events: Harness["events"] = [];
  bus.on("*", (topic, data) => events.push({ topic, data }));
  const inbox = new FakeInbox(db);
  const dataDir = tempDir("data");
  const cells = cellsRepo(db, clock);
  for (const id of cellIds) cells.insert({ id, parentId: id === "desk" ? null : "desk" });
  const managers: WorkspaceManager[] = [];
  const make = (more: Partial<WorkspaceManagerOptions> = {}) => {
    const m = createWorkspaceManager({ db, bus, clock, dataDir, inbox, ...extra, ...more, limits: { ...FAST_LIMITS, ...extra.limits, ...more.limits } });
    managers.push(m);
    return m;
  };
  const mgr = make();
  cleanups.push(() => {
    for (const m of managers) m.close();
  });
  return { db, clock, bus, events, inbox, dataDir, mgr, cells, restart: make };
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 8000, stepMs = 20): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}
