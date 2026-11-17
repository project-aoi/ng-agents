import type { NotificationDTO, StatusDTO } from "../../shared/api";
import { backgroundText, projectClarify } from "./clarify";
import { readActivities, type ProjectionInput } from "./common";
import { focusText } from "./engage";
import { radarProjects } from "./radar";
import { localMidnight, nextWeekly, whenText } from "./time";

const NOTIFICATION_LIMIT = 20;

/** Light notices to the owner are the `ui` channel's outbox rows (the workbench itself is the transport). */
export function notifications(input: ProjectionInput): NotificationDTO[] {
  const out: NotificationDTO[] = [];
  for (const row of input.kernel.hub.listOutboxSync({ channelId: "ui", status: ["sent", "buffered_dnd"], limit: NOTIFICATION_LIMIT })) {
    out.push({
      id: row.id,
      ...(row.content.title !== undefined ? { title: row.content.title } : {}),
      text: row.content.body,
      at: row.sentAt ?? row.createdAt,
      state: row.status === "sent" ? "delivered" : "held",
    });
  }
  return out;
}

export function projectStatus(input: ProjectionInput): StatusDTO {
  const { kernel, now, settings } = input;
  const stats = kernel.stats();
  const clarify = projectClarify(input);
  const since = localMidnight(now);
  const today = { archivedNotifications: 0, notesSaved: 0, remindersSet: 0, cardsWithdrawn: 0, since };
  for (const a of readActivities(kernel)) {
    if (a.record.at < since) continue;
    if (a.record.kind === "notification_archived") today.archivedNotifications++;
    else if (a.record.kind === "note_saved") today.notesSaved++;
    else if (a.record.kind === "reminder_set") today.remindersSet++;
    else if (a.record.kind === "card_withdrawn") today.cardsWithdrawn++;
  }
  const radar = radarProjects(input);
  const nextReviewAt = nextWeekly(now, settings.weeklyReview.weekday, settings.weeklyReview.hour);
  const focus = { on: stats.focus, buffered: stats.bufferedNotifications };

  const clarifyLine: string[] = [];
  if (today.archivedNotifications > 0) clarifyLine.push(`后台已静默归档 ${today.archivedNotifications} 条通知`);
  if (today.notesSaved > 0) clarifyLine.push(`自动存好 ${today.notesSaved} 条随手笔记`);
  const bg = backgroundText(stats.busyCells, stats.waitingCells);
  clarifyLine.push(bg);
  const radarLine = [`${radar.counts.active} 个进行中项目`];
  if (radar.counts.stalled > 0) radarLine.push(`${radar.counts.stalled} 个停滞待补下一步`);
  radarLine.push(`下次周回顾 ${whenText(nextReviewAt, now)}`);

  return {
    generatedAt: now,
    demo: settings.demo,
    backend: settings.backend,
    auth: { tokenRequired: settings.tokenRequired },
    focus,
    clarify: { pending: clarify.remaining, snoozed: clarify.snoozed },
    background: {
      running: stats.busyCells,
      jobs: stats.runningJobs,
      waiting: stats.waitingCells,
      total: stats.backgroundCells,
      paused: stats.pausedCells,
    },
    today,
    radar: { activeProjects: radar.counts.active, stalledProjects: radar.counts.stalled, somedayProjects: radar.counts.someday, nextReviewAt },
    statusLine: {
      clarify: clarifyLine.join(" · "),
      engage: focusText(focus.on, focus.buffered),
      radar: radarLine.join(" · "),
    },
    notifications: notifications(input),
  };
}
