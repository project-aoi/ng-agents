// Calendar arithmetic in the server's local time zone (set TZ to change it): day boundaries for "今天", the
// weekly review slot.

const DAY = 24 * 3_600_000;

export function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday 00:00 of the current week. */
export function weekStart(now: number): number {
  const d = new Date(localMidnight(now));
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** The next `weekday` (0 = Sunday) at `hour`:00 strictly after now. */
export function nextWeekly(now: number, weekday: number, hour: number): number {
  const d = new Date(localMidnight(now));
  d.setHours(hour, 0, 0, 0);
  const ahead = (weekday - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + ahead);
  if (d.getTime() <= now) d.setDate(d.getDate() + 7);
  return d.getTime();
}

/** Whole local days from today to the day of `at` (0 = today, 1 = tomorrow, -1 = yesterday). */
export function dayDiff(at: number, now: number): number {
  return Math.round((localMidnight(at) - localMidnight(now)) / DAY);
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "今天 14:00" · "明天 09:00" · "11月20日 16:00" */
export function whenText(at: number, now: number): string {
  const diff = dayDiff(at, now);
  if (diff === 0) return `今天 ${hhmm(at)}`;
  if (diff === 1) return `明天 ${hhmm(at)}`;
  if (diff === -1) return `昨天 ${hhmm(at)}`;
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm(at)}`;
}

/** "今天到期" · "明天到期" · "3 天后到期" · "已超时 2 天" · "已超时" */
export function dueText(dueAt: number, now: number): string {
  const diff = dayDiff(dueAt, now);
  if (dueAt < now) return diff <= -1 ? `已超时 ${-diff} 天` : "已超时";
  if (diff === 0) return "今天到期";
  if (diff === 1) return "明天到期";
  return `${diff} 天后到期`;
}
