// @ng/context — primitive ③: business state, versioned artifacts with parking, append-only evidence with
// Inline & Spill, FTS5 search, SKILL.md/notes/preferences, and prefix-stable prompt snapshots (hydrate).

export { createContextStore } from "./store";
export { DEFAULT_LIMITS, type ContextLimits, type ContextStoreOptions, type Summarizer, type SummaryInput } from "./deps";
export { structuredSummary, truncatingSummary } from "./summarize";
export {
  FORK_PENDING_TEXT,
  HISTORY_START_TEXT,
  NO_RESULT_TEXT,
  renderEnvelope,
  AGENT_NOTE_LABEL,
  renderExternal,
  renderRecords,
} from "./render";
export {
  CELL_SKILLS_DIR,
  isSkillName,
  parseSkillFile,
  serializeSkillFile,
  skillFilePath,
  type SkillFileContent,
} from "./skillfile";
