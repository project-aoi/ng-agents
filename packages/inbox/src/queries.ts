import { all, get, type CellsRepo, type Db, type InboxMessageFilter, type InboxMessageRecord, type InboxScheduleRecord, type SqlParam } from "@ng/protocol";
import { toClaim, toMessage, toSchedule, type ClaimRow, type MessageRow, type ScheduleRow } from "./rows";
import type { InboxClaimRecord, InboxClaimStatus } from "./types";

export function inboxQueries(db: Db, cells: CellsRepo) {
  function listMessagesSync(filter: InboxMessageFilter = {}): InboxMessageRecord[] {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (filter.cellId !== undefined) {
      where.push("cell_id = ?");
      params.push(filter.cellId);
    }
    if (filter.status !== undefined) {
      if (filter.status.length === 0) return [];
      where.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    if (filter.type !== undefined) {
      where.push("type = ?");
      params.push(filter.type);
    }
    if (filter.cancelGroup !== undefined) {
      where.push("cancel_group = ?");
      params.push(filter.cancelGroup);
    }
    if (filter.envelopeId !== undefined) {
      where.push("envelope_id = ?");
      params.push(filter.envelopeId);
    }
    if (filter.claimId !== undefined) {
      where.push("claim_id = ?");
      params.push(filter.claimId);
    }
    if (filter.deliverAfter !== undefined) {
      where.push("deliver_at > ?");
      params.push(filter.deliverAfter);
    }
    let sql = `SELECT * FROM inbox_messages${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq`;
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(Math.max(0, Math.floor(filter.limit)));
    }
    return all<MessageRow>(db, sql, params).map(toMessage);
  }

  function listSchedulesSync(filter: { cellId?: string; activeOnly?: boolean } = {}): InboxScheduleRecord[] {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (filter.cellId !== undefined) {
      where.push("cell_id = ?");
      params.push(filter.cellId);
    }
    if (filter.activeOnly) where.push("active = 1");
    const sql = `SELECT * FROM inbox_schedules${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
    return all<ScheduleRow>(db, sql, params).map(toSchedule);
  }

  function pendingCountsSync(cellIds?: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    const params: SqlParam[] = [];
    let sql = "SELECT cell_id, expected_epoch, COUNT(*) AS n FROM inbox_messages WHERE status = 'pending'";
    if (cellIds !== undefined) {
      if (cellIds.length === 0) return out;
      for (const id of cellIds) out[id] = 0;
      sql += ` AND cell_id IN (${cellIds.map(() => "?").join(", ")})`;
      params.push(...cellIds);
    }
    sql += " GROUP BY cell_id, expected_epoch";
    const epochs = new Map<string, number | undefined>();
    for (const r of all<{ cell_id: string; expected_epoch: number | null; n: number }>(db, sql, params)) {
      if (!epochs.has(r.cell_id)) epochs.set(r.cell_id, cells.getEpoch(r.cell_id));
      // Stale-epoch rows are still `pending` until the next claim drops them; they will never be delivered.
      if (r.expected_epoch !== null && r.expected_epoch !== epochs.get(r.cell_id)) continue;
      out[r.cell_id] = (out[r.cell_id] ?? 0) + r.n;
    }
    return out;
  }

  function getClaimSync(claimId: string): InboxClaimRecord | undefined {
    const r = get<ClaimRow>(db, "SELECT * FROM inbox_claims WHERE claim_id = ?", [claimId]);
    return r ? toClaim(r) : undefined;
  }

  function listClaimsSync(filter: { cellId?: string; status?: readonly InboxClaimStatus[]; limit?: number } = {}): InboxClaimRecord[] {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (filter.cellId !== undefined) {
      where.push("cell_id = ?");
      params.push(filter.cellId);
    }
    if (filter.status !== undefined) {
      if (filter.status.length === 0) return [];
      where.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    let sql = `SELECT * FROM inbox_claims${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY claimed_at, claim_id`;
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(Math.max(0, Math.floor(filter.limit)));
    }
    return all<ClaimRow>(db, sql, params).map(toClaim);
  }

  return { listMessagesSync, listSchedulesSync, pendingCountsSync, getClaimSync, listClaimsSync };
}
