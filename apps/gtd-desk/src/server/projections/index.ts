// Read models of the three views, the top bar and the drawers: pure functions of the kernel's stores and a clock
// reading. They never write; the endpoints in ../desk.ts do.

export { DEFAULT_SETTINGS, inputOf, SENSOR_SUGGESTION_PREFIX, SKILL_SUGGESTION_PREFIX } from "./common";
export type { DeskKernel, DeskSettings, ProjectionInput, SensorSuggestion, SkillSuggestion } from "./common";
export { projectRadar, radarProjects, STALLED_TEXT } from "./radar";
export { projectReview } from "./review";
export { notifications, projectStatus } from "./status";
export { projectSources, cronText } from "./sources";
export { projectActivity } from "./activity";
