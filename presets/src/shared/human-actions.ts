import {
  afterCommit, all, get, gtdKeys, NgError, run, withTx,
  type ActionBooks, type ActionRecord, type ActionStore, type ApprovalStatus, type Db, type HumanItemStatus,
} from "@ng/protocol";

interface ActionItemRow {
  action_id: string;
  cell_id: string | null;
  category: string;
  subject_key: string;
  related_project_ids: string;
  card: string;
  artifact_id: string | null;
  effort: ActionRecord["effort"] | null;
  due_at: number | null;
  status: HumanItemStatus;
  status_reason: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

export function readHumanActionRecords(db: Db, deskCellId: string, cellId?: string) {
  const rows = all<ActionItemRow>(db, `SELECT * FROM human_items
    WHERE category='action' AND status_reason IS NOT 'reassigned'
    ${cellId ? "AND COALESCE(cell_id,?)=?" : ""} ORDER BY created_at,action_id`,
    cellId ? [deskCellId,cellId] : []);
  return rows.map(row => {
    const card = JSON.parse(row.card);
    const projects: string[] = JSON.parse(row.related_project_ids);
    const status = row.status === "resolved" ? "done" : row.status === "cancelled" ? "cancelled" : "open";
    const record: ActionRecord = {
      id: row.action_id, owner: "human", status, title: card.title,
      ...(card.data?.prep?.summary ? { nextStep: card.body } : !card.data?.prep && card.body ? { nextStep: card.body } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(card.data?.source && { source: card.data.source }),
      ...(card.data?.prep?.checked?.length && { references: card.data.prep.checked }),
      ...(card.data?.phase && { phase: card.data.phase }),
      ...(card.data?.cellId && { cellId: card.data.cellId }),
      ...(row.artifact_id && { artifactId: row.artifact_id }),
      ...(projects[0] && { projectCellId: projects[0] }),
      ...(row.effort && { effort: row.effort }),
      ...(row.due_at !== null && { dueAt: row.due_at }),
      ...(status === "done" && { completedAt: row.resolved_at ?? row.updated_at }),
    };
    return { cellId: row.cell_id ?? deskCellId, key: row.action_id, record, updatedAt: record.updatedAt };
  });
}

export function writeActionRecordSync(store: ActionStore, cellId: string, record: ActionRecord): void {
  const { db, bus, context, deskCellId } = store;
  const key = gtdKeys.action(record.id);
  withTx(db, () => {
    const issuer = cellId === deskCellId && !record.projectCellId ? null : cellId;
    const prior = get<ActionItemRow>(db, "SELECT * FROM human_items WHERE action_id=?", [record.id]);
    const subject = `action:${cellId}:${record.id}`;
    if (prior && (prior.cell_id !== issuer || prior.subject_key !== subject || prior.category !== "action"))
      throw new NgError("conflict", "这个行动编号已被使用");
    const changed = (status: ApprovalStatus) => afterCommit(db, () => bus.emit("approval.changed", {
      cellId, actionId: record.id, subjectKey: subject, status,
    }));
    if (record.owner !== "human") {
      if (prior && prior.status_reason !== "reassigned") {
        run(db, `UPDATE human_items SET disposition='cancelled',status_reason='reassigned',snoozed_until=NULL,
          resolved_at=?,updated_at=?,item_revision=item_revision+1 WHERE action_id=?`,
          [record.updatedAt, record.updatedAt, record.id]);
        changed("cancelled");
      }
      context.commitSync(cellId, { statePatches: { [key]: record } });
      return;
    }
    const cell = get<{ epoch: number; preset: string; status: string }>(db, "SELECT epoch,preset,status FROM cells WHERE id=?", [cellId]);
    if (!cell) throw new NgError("not_found", "找不到行动所属的任务");
    if (record.status === "open" && cell.status === "closed") throw new NgError("conflict", "任务已结束");
    const projectId = record.projectCellId ?? (cell.preset === "project" ? cellId : undefined);
    const disposition = record.status === "open" ? "pending" : record.status === "done" ? "executed" : "cancelled";
    const card = {
      format: "card", title: record.title, body: record.nextStep ?? record.title,
      data: { phase: record.phase, cellId: record.cellId, source: record.source,
        prep: { summary: record.nextStep ?? "", checked: record.references ?? [] } },
    };
    const options = [{ id: "done", label: "已办完", effect: issuer ? "reply" : "complete", input: { mode: "optional" } }];
    const action = { type: "custom", name: "human.action", summary: record.title, sideEffect: "none", subjectKey: subject };
    run(db, `INSERT INTO human_items(action_id,cell_id,epoch,principal_id,subject_key,action_type,action,action_hash,
        card,options,disposition,category,related_project_ids,effort,due_at,artifact_id,created_at,updated_at,resolved_at)
      VALUES(?,?,?,?,?,'custom',?,'',?,?,?,'action',?,?,?,?,?,?,?)
      ON CONFLICT(action_id) DO UPDATE SET epoch=excluded.epoch,action=excluded.action,card=excluded.card,options=excluded.options,
        disposition=excluded.disposition,status_reason=NULL,related_project_ids=excluded.related_project_ids,effort=excluded.effort,
        due_at=excluded.due_at,artifact_id=excluded.artifact_id,updated_at=excluded.updated_at,resolved_at=excluded.resolved_at,
        snoozed_until=CASE WHEN excluded.disposition='pending' AND human_items.disposition='pending' THEN human_items.snoozed_until END,
        item_revision=human_items.item_revision+1`,
      [record.id,issuer,issuer ? cell.epoch : null,issuer ? `cell:${issuer}` : "owner",subject,JSON.stringify(action),
       JSON.stringify(card),JSON.stringify(options),disposition,JSON.stringify(projectId ? [projectId] : []),record.effort ?? null,
       record.dueAt ?? null, record.artifactId ?? null, record.createdAt, record.updatedAt,
       disposition === "pending" ? null : record.completedAt ?? record.updatedAt]);
    if (context.readStateSync(cellId, key)) context.commitSync(cellId, { statePatches: { [key]: null } });
    changed(disposition);
  });
}

export function actionBooks(store: ActionStore, cellId: string): ActionBooks {
  return {
    list() {
      const actions = store.context.listStateSync(cellId, gtdKeys.actionPrefix).map(entry => entry.value as ActionRecord);
      return actions.concat(readHumanActionRecords(store.db, store.deskCellId, cellId).map(entry => entry.record));
    },
    write(record) { writeActionRecordSync(store, cellId, record); },
  };
}
