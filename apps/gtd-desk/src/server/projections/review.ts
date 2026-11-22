import type { WeeklyReviewDTO } from "../../shared/api";
import {
  linkedApprovalId,
  projectOfAction,
  readActions,
  readProjects,
  readSources,
  SENSOR_SUGGESTION_PREFIX,
  SKILL_SUGGESTION_PREFIX,
  type ProjectionInput,
  type SensorSuggestion,
  type SkillSuggestion,
} from "./common";
import { button, channelLabel, enc, post, waitingDeadline, waitingDTO } from "./format";
import { dueText, nextWeekly, weekStart } from "./time";

const WEEK = 7 * 24 * 3_600_000;
/** An llm source that ran this often is worth a zero-token check (docs/04 §4.2). */
export const SENSOR_SUGGEST_MIN_RUNS = 4;
function isSkillSuggestion(v: unknown): v is SkillSuggestion {
  const s = v as Partial<SkillSuggestion> | null;
  return !!s && typeof s.name === "string" && typeof s.description === "string" && typeof s.body === "string";
}

export function projectReview(input: ProjectionInput): WeeklyReviewDTO {
  const { kernel, now, settings } = input;
  const ws = weekStart(now);
  const projects = readProjects(kernel);
  const projectTitle = new Map(projects.map((p) => [p.cellId, p.record.title]));
  const projectCells = new Set(projectTitle.keys());
  const actions = readActions(kernel);

  const completed: WeeklyReviewDTO["completed"] = [];
  for (const a of actions) {
    if (a.record.status !== "done" || (a.record.completedAt ?? a.record.updatedAt) < ws) continue;
    // BUG-011.2: "本周完结" is what was delivered — whole projects (below) and what the owner did themselves; the
    // agent and waiting steps inside a project are the project's own detail, not the owner's week.
    if (a.record.owner !== "human") continue;
    const pid = projectOfAction(kernel, a, projectCells);
    completed.push({ kind: "action", title: a.record.title, at: a.record.completedAt ?? a.record.updatedAt, project: pid ? (projectTitle.get(pid) ?? null) : null });
  }
  for (const p of projects) {
    if (p.record.lifecycle === "completed" && (p.record.completedAt ?? p.record.updatedAt) >= ws) {
      completed.push({ kind: "project", title: p.record.title, at: p.record.completedAt ?? p.record.updatedAt, project: null });
    }
  }
  let editedDrafts = 0;
  for (const r of kernel.gate.listApprovalsSync({ status: ["executed", "approved"] })) {
    if ((r.resolvedAt ?? r.updatedAt) < ws) continue;
    if (r.humanEdited) editedDrafts++;
  }
  completed.sort((a, b) => b.at - a.at);

  const overdueWaits: WeeklyReviewDTO["overdueWaits"] = [];
  for (const a of actions) {
    if (a.record.status !== "open" || a.record.owner !== "waiting") continue;
    const due = waitingDeadline(a.record.waiting) ?? a.record.dueAt ?? null;
    if (due === null || due >= now) continue;
    const pid = projectOfAction(kernel, a, projectCells);
    const w = waitingDTO(a.record.waiting, now);
    overdueWaits.push({
      cellId: a.cellId,
      actionId: a.record.id,
      title: a.record.title,
      project: pid ? (projectTitle.get(pid) ?? null) : null,
      dueAt: due,
      text: w ? `${w.text}` : dueText(due, now),
    });
  }
  overdueWaits.sort((a, b) => a.dueAt - b.dueAt);

  const existingSkills = new Set(kernel.context.listSkillsSync().map((s) => s.name));
  const skillSuggestions: WeeklyReviewDTO["skillSuggestions"] = [];
  for (const e of kernel.context.listStateSync(kernel.deskCellId, SKILL_SUGGESTION_PREFIX)) {
    if (!isSkillSuggestion(e.value) || existingSkills.has(e.value.name)) continue;
    const slug = e.key.slice(SKILL_SUGGESTION_PREFIX.length);
    const base = `/api/review/skills/${enc(slug)}`;
    skillSuggestions.push({
      name: e.value.name,
      description: e.value.description,
      reason: e.value.reason ?? "",
      body: e.value.body,
      buttons: [
        button({ id: "accept_skill", label: "一键保存为技能", primary: true, endpoint: post(`${base}/accept`) }),
        button({ id: "dismiss_skill", label: "不用了", endpoint: post(`${base}/dismiss`) }),
      ],
    });
  }

  const prepared = new Map<string, SensorSuggestion>();
  for (const e of kernel.context.listStateSync(kernel.deskCellId, SENSOR_SUGGESTION_PREFIX)) {
    if (e.value && typeof e.value === "object") prepared.set(e.key.slice(SENSOR_SUGGESTION_PREFIX.length), e.value as SensorSuggestion);
  }
  const sensorSuggestions: WeeklyReviewDTO["sensorSuggestions"] = [];
  for (const s of readSources(kernel)) {
    const cell = kernel.getCell(s.cellId);
    if (!cell || cell.status === "closed" || s.record.processor !== "llm") continue;
    const p = prepared.get(s.cellId);
    if (!p && s.record.runCount < SENSOR_SUGGEST_MIN_RUNS) continue;
    const entry = typeof p?.entry === "string" && p.entry ? p.entry : null;
    const path = `/api/review/sensors/${enc(s.cellId)}/code`;
    sensorSuggestions.push({
      sensorId: s.cellId,
      title: s.record.title,
      runCount: s.record.runCount,
      hitCount: s.record.hitCount,
      reason: p?.reason ?? `这个信源已经用大模型跑了 ${s.record.runCount} 次（命中 ${s.record.hitCount} 次）。如果检查逻辑是固定的，换成零 Token 的脚本检查更省。`,
      entry,
      buttons: [
        entry
          ? button({ id: "switch_to_code", label: "切换为脚本检查", primary: true, endpoint: post(path, { entry }) })
          : button({
              id: "switch_to_code",
              label: "切换为脚本检查",
              primary: true,
              endpoint: post(path),
              input: { field: "entry", kind: "text", placeholder: "script:checks/metrics.sh" },
            }),
      ],
    });
  }

  return {
    generatedAt: now,
    weekStart: ws,
    nextReviewAt: nextWeekly(now, settings.weeklyReview.weekday, settings.weeklyReview.hour),
    completed,
    overdueWaits,
    editedDrafts,
    skillSuggestions,
    sensorSuggestions,
  };
}
