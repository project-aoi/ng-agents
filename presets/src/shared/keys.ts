export const gtdKeys = {
  /** In a project root cell → ProjectRecord. */
  project: "gtd:project",
  /** In a sensor cell → SourceRecord. */
  source: "gtd:source",
  /** In the cell that owns the action → ActionRecord. */
  action: (id: string) => `gtd:action:${id}`,
  actionPrefix: "gtd:action:",
  /** In the desk cell → ActivityRecord. */
  activity: (id: string) => `gtd:activity:${id}`,
  activityPrefix: "gtd:activity:",
} as const;
