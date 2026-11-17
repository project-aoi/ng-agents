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
  const all = readActivities(kernel).sort((a, b) => b.record.at - a.record.at || b.key.localeCompare(a.key));
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
        buttons: restorable ? [button({ id: "restore", label: "移回待确认", primary: true, endpoint: post(`/api/activity/${enc(a.cellId)}/${enc(r.id)}/restore`) })] : [],
      };
    });
  return { generatedAt: now, items, counts };
}
