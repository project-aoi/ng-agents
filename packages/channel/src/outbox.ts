import { all, fromBool, fromJson, get, run, toBool, toJson, type Db, type Deliverable, type OutboxFilter, type OutboxRecord, type OutboxStatus, type SqlParam } from "@ng/protocol";

export interface OutboxRow {
  id: string;
  idempotency_key: string;
  channel_id: string;
  target: string;
  content: string;
  status: OutboxStatus;
  urgent: number;
  refused: number;
  cell_id: string | null;
  action_id: string | null;
  attempts: number;
  error: string | null;
  external_id: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}

export function toRecord(r: OutboxRow): OutboxRecord {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    channelId: r.channel_id,
    target: r.target,
    content: fromJson<Deliverable>(r.content),
    status: r.status,
    urgent: toBool(r.urgent),
    refused: toBool(r.refused),
    cellId: r.cell_id,
    actionId: r.action_id,
    attempts: r.attempts,
    error: r.error,
    externalId: r.external_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sentAt: r.sent_at,
  };
}

export function rowByKey(db: Db, key: string): OutboxRow | undefined {
  return get<OutboxRow>(db, "SELECT * FROM outbox WHERE idempotency_key = ?", [key]);
}

export function rowById(db: Db, id: string): OutboxRow | undefined {
  return get<OutboxRow>(db, "SELECT * FROM outbox WHERE id = ?", [id]);
}

export interface NewRow {
  id: string;
  idempotencyKey: string;
  channelId: string;
  target: string;
  content: Deliverable;
  status: OutboxStatus;
  urgent: boolean;
  refused: boolean;
  cellId: string | null;
  actionId: string | null;
  attempts: number;
  error: string | null;
  now: number;
}

export function insertRow(db: Db, r: NewRow): void {
  run(
    db,
    `INSERT INTO outbox (id, idempotency_key, channel_id, target, content, status, urgent, refused, cell_id, action_id,
                         attempts, error, external_id, created_at, updated_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    [r.id, r.idempotencyKey, r.channelId, r.target, toJson(r.content), r.status, fromBool(r.urgent), fromBool(r.refused),
      r.cellId, r.actionId, r.attempts, r.error, r.now, r.now],
  );
}

/** Newest first by default (notification lists); `order: "oldest"` gives delivery order (buffered flush). */
export function listRows(db: Db, filter: OutboxFilter = {}): OutboxRow[] {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (filter.status && filter.status.length > 0) {
    where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
    params.push(...filter.status);
  }
  if (filter.channelId !== undefined) {
    where.push("channel_id = ?");
    params.push(filter.channelId);
  }
  if (filter.cellId !== undefined) {
    where.push("cell_id = ?");
    params.push(filter.cellId);
  }
  const dir = filter.order === "oldest" ? "ASC" : "DESC";
  let sql = `SELECT * FROM outbox${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ${dir}, rowid ${dir}`;
  if (filter.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(Math.max(0, Math.floor(filter.limit)));
  }
  return all<OutboxRow>(db, sql, params);
}

export function countByStatus(db: Db, status: OutboxStatus): number {
  return get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM outbox WHERE status = ?", [status])?.n ?? 0;
}

// ==================== channel_state ====================

export const GLOBAL_STATE = "*";

export function readState<T>(db: Db, channelId: string, key: string): T | undefined {
  const r = get<{ value: string }>(db, "SELECT value FROM channel_state WHERE channel_id = ? AND key = ?", [channelId, key]);
  return r ? fromJson<T>(r.value) : undefined;
}

export function writeState(db: Db, channelId: string, key: string, value: unknown, now: number): void {
  run(
    db,
    `INSERT INTO channel_state (channel_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [channelId, key, toJson(value), now],
  );
}
