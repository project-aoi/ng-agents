import { all as rows, type ActivityRecord } from "@ng/protocol";
import type { ActivityKind, ActivityListDTO } from "../../shared/api";
import { readActivities, type ProjectionInput } from "./common";
import { button, enc, post, sourceInfo } from "./format";

export const ACTIVITY_LABEL: Readonly<Record<ActivityKind, string>> = {
  notification_archived: "已静默归档",
  note_saved: "已存好笔记",
  reminder_set: "已设好提醒",
  card_withdrawn: "已撤卡归档",
  action_completed: "已办完",
};

const LIMIT = 200;

export function projectActivity(input: ProjectionInput, kind?: ActivityKind): ActivityListDTO {
  const { kernel, now } = input;
  const decisions = rows<{id:string; item_id:string; at:number; undone_at:number|null; title:string; disposition:string; cell_id:string|null; revision:number; after_revision:number}>(kernel.db, `
    SELECT a.id,a.item_id,a.at,a.undone_at,a.after_revision,h.item_revision AS revision,h.cell_id,
      COALESCE(json_extract(h.card,'$.title'), json_extract(h.action,'$.summary'), h.subject_key) AS title,h.disposition FROM human_item_activity a JOIN human_items h ON h.action_id=a.item_id
    ORDER BY a.at DESC`).map(r => {
    const record:ActivityRecord = {id:r.id,title:r.title,at:r.at,actionId:r.item_id,
      kind:["cancelled","denied"].includes(r.disposition) ? "card_withdrawn" : "action_completed",
      detail:"已处理待办", restorable:r.undone_at===null && r.revision===r.after_revision,
      ...(r.undone_at!==null ? {restoredAt:r.undone_at} : {})};
    return {cellId:r.cell_id ?? kernel.deskCellId,key:r.id,record,updatedAt:r.at};
  });
  const decisionIds = new Set(decisions.map(d=>d.record.id));
  const all = [...readActivities(kernel), ...decisions].sort((a, b) => b.record.at - a.record.at || b.key.localeCompare(a.key));
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
        buttons: restorable ? [button({ id: "restore", label: decisionIds.has(r.id) ? "撤销决定" : "移回待确认", primary: true, endpoint: post(`/api/activity/${enc(a.cellId)}/${enc(r.id)}/restore`) })] : [],
      };
    });
  return { generatedAt: now, items, counts };
}
