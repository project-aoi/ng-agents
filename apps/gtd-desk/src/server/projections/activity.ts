import type { ActivityRecord } from "@ng/presets/records";
import { all as rows } from "@ng/protocol";
import type { ActivityKind, ActivityListDTO } from "../../shared/api";
import { readActivities, type DeskKernel, type ProjectionInput } from "./common";
import { button, enc, post, sourceInfo } from "./format";

export const ACTIVITY_LABEL: Readonly<Record<ActivityKind, string>> = {
  notification_archived: "已静默归档",
  note_saved: "已存好笔记",
  reminder_set: "已设好提醒",
  card_withdrawn: "已撤卡归档",
  action_completed: "已办完",
};

const LIMIT = 200;

/**
 * Cards a cell withdrew by itself (the plan changed, a project took the card over): no decision of the owner's, but
 * they left the owner's list. The reasons left out belong to something else that is on record in its own right.
 */
export function withdrawnCards(kernel: DeskKernel, since = 0): Array<{ id: string; at: number; title: string; reason: string | null; cellId: string | null }> {
  return rows(kernel.db, `
    SELECT h.action_id AS id, h.resolved_at AS at, h.status_reason AS reason, h.cell_id AS cellId,
      COALESCE(json_extract(h.card,'$.title'), json_extract(h.action,'$.summary'), h.subject_key) AS title
    FROM human_items h WHERE h.category='decision' AND h.disposition='cancelled' AND h.resolved_at>=?
      AND COALESCE(h.status_reason,'') NOT IN ('replied','reassigned','issuer_closed','project_closed','someday')
      AND NOT EXISTS (SELECT 1 FROM human_item_activity a WHERE a.item_id=h.action_id AND a.after_disposition IN ('denied','cancelled'))
    ORDER BY h.resolved_at DESC LIMIT ?`, [since, LIMIT]);
}

export function projectActivity(input: ProjectionInput, kind?: ActivityKind): ActivityListDTO {
  const { kernel, now } = input;
  const decisions = rows<{id:string; item_id:string; at:number; undone_at:number|null; title:string; disposition:string; cell_id:string|null; revision:number; after_revision:number; reason:string|null; note:string|null}>(kernel.db, `
    SELECT a.id,a.item_id,a.at,a.undone_at,a.after_revision,h.item_revision AS revision,h.cell_id,h.status_reason AS reason,json_extract(h.outcome,'$.note') AS note,
      COALESCE(json_extract(h.card,'$.title'), json_extract(h.action,'$.summary'), h.subject_key) AS title,a.after_disposition AS disposition FROM human_item_activity a JOIN human_items h ON h.action_id=a.item_id
    ORDER BY a.at DESC`).map(r => {
    const record:ActivityRecord = {id:r.id,title:r.title,at:r.at,actionId:r.item_id,
      kind:["cancelled","denied"].includes(r.disposition) ? "card_withdrawn" : "action_completed",
      // Closed by the background on the owner's word: they see what it took them to have said (and can undo it).
      detail: r.reason === "settled_in_conversation" ? `后台按你在对话里的话结清${r.note ? `：「${r.note}」` : ""}` : "已处理待办",
      restorable:r.undone_at===null && r.revision===r.after_revision,
      ...(r.undone_at!==null ? {restoredAt:r.undone_at} : {})};
    return {cellId:r.cell_id ?? kernel.deskCellId,key:r.id,record,updatedAt:r.at};
  });
  const withdrawn = withdrawnCards(kernel).map(r => {
    const record:ActivityRecord = {id:`withdrawn-${r.id}`,title:r.title,at:r.at,actionId:r.id,kind:"card_withdrawn",
      detail:r.reason?.trim() ? `后台撤回：${r.reason.trim()}` : "后台撤回", restorable:false};
    return {cellId:r.cellId ?? kernel.deskCellId,key:record.id,record,updatedAt:r.at};
  });
  const decisionIds = new Set(decisions.map(d=>d.record.id));
  const all = [...readActivities(kernel), ...decisions, ...withdrawn].sort((a, b) => b.record.at - a.record.at || b.key.localeCompare(a.key));
  const counts: Record<ActivityKind, number> = { notification_archived: 0, note_saved: 0, reminder_set: 0, card_withdrawn: 0, action_completed: 0 };
  for (const a of all) counts[a.record.kind]++;
  const items = all
    .filter((a) => kind === undefined || a.record.kind === kind)
    .slice(0, LIMIT)
    .map((a) => {
      const r = a.record;
      const restorable = r.restorable && !r.restoredAt;
      return {
        cellId: a.cellId,
        id: r.id,
        kind: r.kind,
        kindLabel: ACTIVITY_LABEL[r.kind],
        title: r.title,
        detail: r.detail ?? null,
        at: r.at,
        source: sourceInfo(r.source),
        rawInput: r.rawInput ?? null,
        remindAt: r.remindAt ?? null,
        restorable,
        restoredAt: r.restoredAt ?? null,
        buttons: restorable ? [decisionIds.has(r.id)
          ? button({ id: "undo", label: "撤销决定", primary: true, endpoint: post(`/api/human-activity/${enc(r.id)}/undo`) })
          : button({ id: "restore", label: "交回主台", primary: true, endpoint: post(`/api/activity/${enc(a.cellId)}/${enc(r.id)}/restore`) })] : [],
      };
    });
  return { generatedAt: now, items, counts };
}
