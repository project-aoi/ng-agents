import { retireDeskState } from "./retire-desk-state";
import {
  all,
  get,
  cellsRepo,
  gtdKeys,
  NgError,
  newId,
  run,
  type ActionRecord,
  type Clock,
  type Db,
  type StateDomain,
  type StateEntry,
  type StateQuery,
} from "@ng/protocol";

interface BoundAction {
  cell_id: string;
  key: string;
  fields: string;
  item_id: string;
  epoch: number | null;
  issuer_epoch: number | null;
  status: string;
  status_reason: string | null;
  updated_at: number;
  card: string;
  resolved_at: number | null;
  due_at: number | null;
  effort: ActionRecord["effort"] | null;
}

export function humanActionDomain(db: Db, clock: Clock): StateDomain {
  const select = `SELECT o.cell_id,o.key,o.fields,o.item_id,h.epoch,c.epoch AS issuer_epoch,h.status,h.status_reason,h.card,h.resolved_at,h.updated_at,h.due_at,h.effort
    FROM human_item_origins o JOIN human_items h ON h.action_id=o.item_id LEFT JOIN cells c ON c.id=h.cell_id`;

  function entry(row: BoundAction): StateEntry {
    const fields = JSON.parse(row.fields) as ActionRecord;
    const card = JSON.parse(row.card) as { title: string; body: string };
    const unfinishedAtClose = row.status_reason === "issuer_closed" && cells.get(row.cell_id)?.closeReason === "completed";
    const record: ActionRecord = {
      ...fields,
      id: row.key.slice(gtdKeys.actionPrefix.length),
      title: fields.title ?? card.title,
      owner: "human",
      status: unfinishedAtClose
            ? "open"
            : row.status === "resolved"
              ? "done"
              : row.status === "cancelled"
                ? "cancelled"
                : "open",
      ...(row.status === "resolved" ? { completedAt: row.resolved_at ?? fields.completedAt ?? row.updated_at } : {}),
      updatedAt: row.updated_at,
      ...(row.due_at !== null ? { dueAt: row.due_at } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
    };
    return { cellId: row.cell_id, key: row.key, value: record, updatedAt: row.updated_at };
  }

  function write(cellId: string, key: string, value: unknown): boolean {
    if (!key.startsWith(gtdKeys.actionPrefix)) return false;
    const record = value as ActionRecord | undefined;
    const existing = get<BoundAction>(db, select + " WHERE o.cell_id=? AND o.key=?", [cellId, key]);
    if (!record || record.owner !== "human") {
      if (existing) {
        run(db, "DELETE FROM human_item_origins WHERE cell_id=? AND key=?", [cellId, key]);
          run(
            db,
            "UPDATE human_items SET disposition='cancelled',status_reason='reassigned',updated_at=?,item_revision=item_revision+1 WHERE action_id=?",
            [clock.now(), existing.item_id],
          );
      }
      return false;
    }
    if (!record.id || gtdKeys.action(record.id) !== key || !record.title) throw new NgError("invalid_argument", "invalid personal action");
    const project = record.projectCellId ?? get<{ id: string }>(db, "SELECT id FROM cells WHERE id=? AND preset='project'", [cellId])?.id;
    const subject = `action:${cellId}:${record.id}`;
    const prior = get<{ action_id: string }>(
      db,
      "SELECT action_id FROM human_items WHERE subject_key=? AND status_reason='reassigned' ORDER BY updated_at DESC LIMIT 1",
      [subject],
    );
    let id = existing?.item_id ?? prior?.action_id;
    const personal =
      !project &&
      !record.cellId &&
      get<{ parent_id: string | null }>(db, "SELECT parent_id FROM cells WHERE id=?", [cellId])?.parent_id === null;
    const now = Number.isFinite(record.updatedAt) ? record.updatedAt : clock.now();
    const disposition = record.status === "done" ? "executed" : record.status === "cancelled" ? "cancelled" : "pending";
    const { status, owner, updatedAt, ...fields } = record;
    const card = JSON.stringify({
      format: "card",
      title: record.title,
      body: record.nextStep ?? record.title,
      data: { source: record.source, prep: { summary: record.nextStep ?? "", checked: record.references ?? [] } },
    });
    if (!id) {
      id = get(db, "SELECT 1 FROM human_items WHERE action_id=?", [record.id]) ? newId("act", clock) : record.id;
      const action = {
        type: "custom",
        name: "human.action",
        subjectKey: subject,
        summary: record.title,
        sideEffect: "none",
        args: { actionId: record.id },
      };
      const issuer = personal ? null : cellId;
      const epoch = issuer ? get<{ epoch: number }>(db, "SELECT epoch FROM cells WHERE id=?", [issuer])!.epoch : null;
      run(
        db,
        `INSERT INTO human_items(action_id,cell_id,epoch,principal_id,subject_key,action_type,action,action_hash,card,options,
        disposition,category,related_project_ids,effort,due_at,artifact_id,created_at,updated_at)
        VALUES(?,?,?, ?,?,'custom',?,'',?, ?,?,'action',?,?,?,?,?,?)`,
        [
          id,
          issuer,
          epoch,
          `cell:${cellId}`,
          subject,
          JSON.stringify(action),
          card,
          JSON.stringify([
            {
              id: "done",
              label: "已办完",
              effect: personal ? "complete" : "reply",
              input: { mode: "optional" },
            },
          ]),
          disposition,
          JSON.stringify(project ? [project] : []),
          record.effort ?? null,
          record.dueAt ?? null,
          record.artifactId ?? null,
          record.createdAt ?? now,
          now,
        ],
      );
    } else {
      const old = existing?.item_id === id && (entry(existing).value as ActionRecord);
      if (!old || existing?.epoch !== existing?.issuer_epoch || JSON.stringify(old) !== JSON.stringify(record))
        run(
          db,
          `UPDATE human_items SET card=?, disposition=?, status_reason=NULL, snoozed_until=NULL, epoch=(SELECT epoch FROM cells WHERE id=human_items.cell_id), effort=?, due_at=?,
        artifact_id=?,item_revision=item_revision+1,updated_at=? WHERE action_id=?`,
          [card, disposition, record.effort ?? null, record.dueAt ?? null, record.artifactId ?? null, now, id],
        );
    }
    run(
      db,
      `INSERT INTO human_item_origins(cell_id,key,item_id,fields) VALUES(?,?,?,?)
      ON CONFLICT(cell_id,key) DO UPDATE SET item_id=excluded.item_id,fields=excluded.fields`,
      [cellId, key, id, JSON.stringify(fields)],
    );
    return true;
  }

  const cells = cellsRepo(db, clock);
  function serialize(cellId: string, key: string, value: unknown) {
    if (!value || typeof value !== "object") return value;
    if (key === gtdKeys.project) {
      const { cwd, stalledSince, stalledNotifiedAt, ...fields } = value as import("@ng/protocol").ProjectRecord;
      const cell = cells.require(cellId);
      if (cell.spec.stallPolicy !== "monitor") cells.update(cellId, { spec: { ...cell.spec, stallPolicy: "monitor" } });
      if (fields.lifecycle === "someday" && cell.status !== "closed") {
        cells.setStatus(cellId, "paused", undefined, "parked");
        fields.lifecycle = "active";
      }
      return fields;
    }
    if (key === gtdKeys.source) {
      const { status, processor, schedule, ...fields } = value as import("@ng/protocol").SourceRecord;
      return fields;
    }
    return value;
  }
  function project(entry: StateEntry): StateEntry {
    if (entry.key !== gtdKeys.project && entry.key !== gtdKeys.source) return entry;
    const cell = cells.require(entry.cellId);
    if (entry.key === gtdKeys.project) {
      const record = entry.value as import("@ng/protocol").ProjectRecord;
      const stall = get<{ since: number; notified_at: number | null }>(db, "SELECT * FROM cell_stalls WHERE cell_id=?", [cell.id]);
      return {
        ...entry,
        value: {
          ...record,
          ...(cell.spec.cwd ? { cwd: cell.spec.cwd } : {}),
          ...(cell.pauseReason === "parked" ? { lifecycle: "someday" } : {}),
          ...(stall ? { stalledSince: stall.since, ...(stall.notified_at !== null ? { stalledNotifiedAt: stall.notified_at } : {}) } : {}),
        },
      };
    }
    const source = entry.value as import("@ng/protocol").SourceRecord;
    const schedule = get<{ cron: string; tz: string | null }>(
      db,
      "SELECT cron,tz FROM inbox_schedules WHERE cell_id=? AND active=1 ORDER BY created_at,id LIMIT 1",
      [cell.id],
    );
    return {
      ...entry,
      value: {
        ...source,
        status: cell.status === "paused" ? "paused" : source.lastError ? "error" : "ok",
        processor: cell.spec.processor.kind === "llm" ? "llm" : "code",
        ...(schedule
          ? {
              schedule: {
                ...(schedule.cron ? { cron: schedule.cron } : {}),
                ...(schedule.tz ? { tz: schedule.tz } : {}),
              },
            }
          : {}),
      },
    };
  }
  return {
    id: "gtd.personal-actions",
    serialize,
    project,
    migrate() {
      for (const e of all<{ cell_id: string; key: string; value: string }>(
        db,
        "SELECT cell_id,key,value FROM cell_state WHERE key IN ('gtd:project','gtd:source')",
      )) {
        const old = JSON.parse(e.value);
        if (e.key === gtdKeys.project) {
          const c = cells.require(e.cell_id);
          if (typeof old.cwd === "string" && old.cwd.startsWith("/") && c.spec.cwd !== old.cwd)
            cells.update(c.id, { spec: { ...c.spec, cwd: old.cwd } });
          if (typeof old.stalledSince === "number")
            run(db, "INSERT OR IGNORE INTO cell_stalls(cell_id,since,notified_at) VALUES(?,?,?)", [
              c.id,
              old.stalledSince,
              old.stalledNotifiedAt ?? null,
            ]);
        }
        const value = JSON.stringify(serialize(e.cell_id, e.key, old));
        if (value !== e.value) run(db, "UPDATE cell_state SET value=? WHERE cell_id=? AND key=?", [value, e.cell_id, e.key]);
      }
      retireDeskState(db, clock);
      const old = all<{ cell_id: string; key: string; value: string; updated_at: number }>(
        db,
        "SELECT cell_id,key,value,updated_at FROM cell_state WHERE key GLOB 'gtd:action:*' AND json_extract(value,'$.owner')='human'",
      );
      for (const r of old) {
        const source = JSON.parse(r.value);
        if (typeof source.title !== "string" || !["open", "done", "cancelled"].includes(source.status)) continue;
        const normalized = {
          ...source,
          id: source.id ?? r.key.slice(gtdKeys.actionPrefix.length),
          createdAt: source.createdAt ?? r.updated_at,
          updatedAt: source.updatedAt ?? r.updated_at,
        };
        if (write(r.cell_id, r.key, normalized)) run(db, "DELETE FROM cell_state WHERE cell_id=? AND key=?", [r.cell_id, r.key]);
      }
    },
    read(cellId, key) {
      if (!key.startsWith(gtdKeys.actionPrefix)) return;
      const r = get<BoundAction>(db, select + " WHERE o.cell_id=? AND o.key=?", [cellId, key]);
      return r && entry(r);
    },
    query(q: StateQuery) {
      if (!gtdKeys.actionPrefix.startsWith(q.keyPrefix) && !q.keyPrefix.startsWith(gtdKeys.actionPrefix)) return [];
      if (q.cellIds?.length === 0) return [];
      const filter = q.cellIds ? " AND o.cell_id IN (" + q.cellIds.map(() => "?").join(",") + ")" : "";
      return all<BoundAction>(db, select + " WHERE substr(o.key,1,length(?))=?" + filter, [q.keyPrefix, q.keyPrefix, ...(q.cellIds ?? [])]).map(
        entry,
      );
    },
    write,
  };
}
