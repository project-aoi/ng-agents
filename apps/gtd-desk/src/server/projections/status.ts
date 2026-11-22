import type { NotificationDTO, StatusDTO } from "../../shared/api";
import { backgroundText, projectClarify } from "./clarify";
import { readActivities, readProjects, type DeskKernel, type ProjectionInput } from "./common";
import { radarProjects } from "./radar";
import { localMidnight, nextWeekly, whenText } from "./time";

const NOTIFICATION_LIMIT = 20;

export function notifications(input: ProjectionInput): NotificationDTO[] {
  return input.kernel.hub.listNotificationsSync(NOTIFICATION_LIMIT).map(row => ({
    id: row.id,
    ...(row.content.title !== undefined ? { title: row.content.title } : {}),
    text: row.content.body,
    at: row.createdAt,
  }));
}

/**
 * BUG-011.3: cells paused by the owner. A project parked in "以后再说" is paused underneath (and so is everything below
 * it), but that is its parked state, not a pause — it is counted in the Radar's someday list instead.
 */
function pausedCount(kernel: DeskKernel): number {
  const parked = new Set(readProjects(kernel).filter((p) => p.record.lifecycle === "someday").map((p) => p.cellId));
  const cells = new Map(kernel.listCells({ status: ["active", "paused"] }).map((c) => [c.id, c]));
  let n = 0;
  for (const c of cells.values()) {
    if (c.status !== "paused") continue;
    let underParked = false;
    for (let p: typeof c | undefined = c; p; p = p.parentId ? cells.get(p.parentId) : undefined) {
      if (parked.has(p.id)) {
        underParked = true;
        break;
      }
    }
    if (!underParked) n++;
  }
  return n;
}

/** "2 个分身在跑 · 1 个在等 · 3 个待命可唤醒" — the cells below the desk, by what they are doing. */
function agentsLine(kernel: DeskKernel): string {
  const open = kernel.listCells({ status: ["active", "paused"] }).filter((c) => c.parentId !== null);
  const n = { working: 0, waiting: 0, dormant: 0 };
  for (const a of kernel.activityOf(open.map((c) => c.id)).values()) {
    if (a.state === "working") n.working++;
    else if (a.state === "waiting") n.waiting++;
    else if (a.state === "dormant") n.dormant++;
  }
  const parts: string[] = [];
  if (n.working) parts.push(`${n.working} 个分身在跑`);
  if (n.waiting) parts.push(`${n.waiting} 个在等`);
  if (n.dormant) parts.push(`${n.dormant} 个待命可唤醒`);
  return parts.length ? parts.join(" · ") : "没有在途的分身";
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

  const clarifyLine: string[] = [];
  if (today.archivedNotifications > 0) clarifyLine.push(`后台已静默归档 ${today.archivedNotifications} 条通知`);
  if (today.notesSaved > 0) clarifyLine.push(`自动存好 ${today.notesSaved} 条随手笔记`);
  const bg = backgroundText(stats.busyCells, stats.waitingCells);
  clarifyLine.push(bg);
  const radarLine = [`${radar.counts.active} 个进行中项目`];
  if (radar.counts.stalled > 0) radarLine.push(`${radar.counts.stalled} 个停滞待补下一步`);
  radarLine.push(`下次周回顾 ${whenText(nextReviewAt, now)}`);

  return {
    humanPending:kernel.humanItems.list().length,
    generatedAt: now,
    backend: settings.backend,
    auth: { tokenRequired: settings.tokenRequired },
    clarify: { pending: clarify.remaining, snoozed: clarify.snoozed },
    background: {
      running: stats.busyCells,
      jobs: stats.runningJobs,
      waiting: stats.waitingCells,
      total: stats.backgroundCells,
      paused: pausedCount(kernel),
    },
    today,
    radar: { activeProjects: radar.counts.active, stalledProjects: radar.counts.stalled, somedayProjects: radar.counts.someday, nextReviewAt },
    statusLine: {
      clarify: clarifyLine.join(" · "),
      radar: radarLine.join(" · "),
      agents: agentsLine(kernel),
    },
    notifications: notifications(input),
  };
}
