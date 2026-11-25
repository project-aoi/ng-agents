import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { NgError } from "../errors";
import { ALL_SCHEMAS } from "../schema";
import type { SchemaModule } from "../schema/types";

export type Db = DatabaseSync;
export type SqlParam = SQLInputValue;
export type SqlParams = readonly SqlParam[] | Record<string, SqlParam>;

export interface OpenDatabaseOptions {
  /** SQLITE busy timeout for lock waits between connections (ms). Default 5000. */
  busyTimeoutMs?: number;
  /** Schema modules to apply (default: all owners, in dependency order). */
  schemas?: readonly SchemaModule[];
}

/**
 * Opens (creating parent directories) the single system database: WAL, foreign keys on, busy timeout, and every
 * owner's schema applied idempotently with one `schema_versions` row per owner. `":memory:"` is fine for tests.
 */
export function openDatabase(path: string, opts: OpenDatabaseOptions = {}): Db {
  const busy = opts.busyTimeoutMs ?? 5000;
  if (path !== ":memory:" && !path.startsWith("file:")) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: busy });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busy))}`);
  applySchemas(db, opts.schemas ?? ALL_SCHEMAS);
  return db;
}

// ==================== transactions ====================

interface TxState {
  depth: number;
  seq: number;
  /** One callback list per open level; a released savepoint merges into its parent, a rolled-back one is dropped. */
  levels: Array<Array<() => void>>;
}

const txStates = new WeakMap<Db, TxState>();

function stateOf(db: Db): TxState {
  let st = txStates.get(db);
  if (!st) {
    st = { depth: 0, seq: 0, levels: [] };
    txStates.set(db, st);
  }
  return st;
}

function assertNotPromise(value: unknown): void {
  if (value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function") {
    throw new NgError("tx_misuse", "withTx callback must be synchronous (it returned a Promise); node:sqlite transactions cannot span awaits");
  }
}

/**
 * Runs `fn` in a transaction. The outermost call uses BEGIN IMMEDIATE/COMMIT; nested calls use SAVEPOINTs, so a
 * `*Sync` primitive method can run inside a caller's transaction and roll back alone. A throw rolls back the current
 * level and rethrows. `fn` must be synchronous.
 */
export function withTx<T>(db: Db, fn: () => T): T {
  const st = stateOf(db);
  if (st.depth === 0) {
    if (db.isTransaction) {
      throw new NgError("tx_misuse", "a transaction was opened on this connection outside withTx");
    }
    db.exec("BEGIN IMMEDIATE");
    st.depth = 1;
    st.levels = [[]];
    let result: T;
    try {
      result = fn();
      assertNotPromise(result);
      db.exec("COMMIT");
    } catch (err) {
      st.depth = 0;
      st.levels = [];
      if (db.isTransaction) db.exec("ROLLBACK");
      throw err;
    }
    const callbacks = st.levels.flat();
    st.depth = 0;
    st.levels = [];
    runCallbacks(callbacks);
    return result;
  }

  const name = `ng_sp_${++st.seq}`;
  db.exec(`SAVEPOINT ${name}`);
  st.depth++;
  st.levels.push([]);
  try {
    const result = fn();
    assertNotPromise(result);
    db.exec(`RELEASE ${name}`);
    const mine = st.levels.pop() ?? [];
    st.depth--;
    st.levels[st.levels.length - 1]?.push(...mine);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    st.levels.pop();
    st.depth--;
    throw err;
  }
}

/**
 * Run `cb` once the outermost transaction commits (immediately if none is open). Dropped if the enclosing
 * transaction or savepoint rolls back. This is how primitives emit bus events "after commit" even when their
 * `*Sync` method runs inside someone else's transaction.
 */
export function afterCommit(db: Db, cb: () => void): void {
  const st = txStates.get(db);
  if (!st || st.depth === 0) {
    runCallbacks([cb]);
    return;
  }
  st.levels[st.levels.length - 1]!.push(cb);
}

export function inTransaction(db: Db): boolean {
  return (txStates.get(db)?.depth ?? 0) > 0;
}

function runCallbacks(callbacks: Array<() => void>): void {
  for (const cb of callbacks) {
    try {
      cb();
    } catch (err) {
      console.error("[withTx] afterCommit callback threw:", err);
    }
  }
}

// ==================== schema ====================

/** Creates all owners' tables atomically, runs pending schema migrations, and records the schema each owner opened. */
export function applySchemas(db: Db, modules: readonly SchemaModule[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    owner      TEXT PRIMARY KEY,
    version    INTEGER NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const needsMigration = modules.some((m) => {
    const row = get<{ version: number }>(db, "SELECT version FROM schema_versions WHERE owner = ?", [m.owner]);
    return row !== undefined && row.version < m.version;
  });
  // SQLite requires PRAGMA foreign_keys = OFF outside a transaction when a migration rebuilds a referenced table.
  const toggleFk = needsMigration && !inTransaction(db);
  if (toggleFk) db.exec("PRAGMA foreign_keys = OFF");
  try {
    withTx(db, () => {
      for (const module of modules) {
        const row = get<{ version: number }>(db, "SELECT version FROM schema_versions WHERE owner = ?", [module.owner]);
        if (!row) {
          db.exec(module.ddl);
          run(db, "INSERT INTO schema_versions(owner, version, applied_at) VALUES (?, ?, ?)", [module.owner, module.version, Date.now()]);
          continue;
        }
        if (row.version > module.version) {
          throw new NgError("schema", `${module.owner}: expected schema v${module.version}, found v${row.version}`);
        }
        if (row.version < module.version) {
          let cur = row.version;
          while (cur < module.version) {
            const step = module.migrations.find((m) => m.from === cur);
            if (!step || step.to <= cur || step.to > module.version) {
              throw new NgError("schema", `${module.owner}: expected schema v${module.version}, found v${row.version}`);
            }
            step.run(db);
            cur = step.to;
          }
          run(db, "UPDATE schema_versions SET version = ?, applied_at = ? WHERE owner = ?", [module.version, Date.now(), module.owner]);
        }
        db.exec(module.ddl);
      }
    });
  } finally {
    if (toggleFk) db.exec("PRAGMA foreign_keys = ON");
  }
  if (toggleFk) {
    const violations = all(db, "PRAGMA foreign_key_check");
    if (violations.length > 0) {
      throw new NgError("schema", `foreign key check failed after schema migration (${violations.length} violation(s))`);
    }
  }
}

export function schemaVersions(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of all<{ owner: string; version: number }>(db, "SELECT owner, version FROM schema_versions")) out[r.owner] = r.version;
  return out;
}

// ==================== query helpers ====================

const stmtCache = new WeakMap<Db, Map<string, StatementSync>>();

/** Prepared statements are cached per connection and SQL text. */
export function prepare(db: Db, sql: string): StatementSync {
  let cache = stmtCache.get(db);
  if (!cache) stmtCache.set(db, (cache = new Map()));
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

function bind(params: SqlParams | undefined): SqlParam[] | [Record<string, SqlParam>] {
  if (params === undefined) return [];
  return Array.isArray(params) ? (params as SqlParam[]) : [params as Record<string, SqlParam>];
}

/** All rows. Params are positional (`?`) as an array, or named (`:name`/`$name`/`@name`) as an object without prefixes. */
export function all<T = Record<string, unknown>>(db: Db, sql: string, params?: SqlParams): T[] {
  return prepare(db, sql).all(...(bind(params) as SqlParam[])) as T[];
}

export function get<T = Record<string, unknown>>(db: Db, sql: string, params?: SqlParams): T | undefined {
  return prepare(db, sql).get(...(bind(params) as SqlParam[])) as T | undefined;
}

export function run(db: Db, sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number } {
  const r = prepare(db, sql).run(...(bind(params) as SqlParam[]));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/** SQLite has no boolean: store 0/1. */
export function toBool(v: unknown): boolean {
  return v === 1 || v === 1n || v === true;
}

export function fromBool(v: boolean | undefined | null): 0 | 1 {
  return v ? 1 : 0;
}

/** Exclusive upper bound for a key-prefix range scan: `key >= prefix AND key < prefixUpperBound(prefix)` uses the index. */
export function prefixUpperBound(prefix: string): string {
  return prefix + "\u{10FFFF}";
}
