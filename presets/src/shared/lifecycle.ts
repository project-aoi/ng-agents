import { gtdKeys, type ActionRecord, type PresetDef, type ProjectRecord } from "@ng/protocol";

export const gtdLifecycle: Pick<PresetDef, "onCellClosed" | "onCellReopened"> = {
  onCellClosed(cell, reason, context, clock) {
    const now = clock.now();
    const changes: Record<string, unknown> = {};
    const project = context.readStateSync<ProjectRecord>(cell.id, gtdKeys.project);
    if (project && ["active", "someday"].includes(project.lifecycle)) {
      const { stalledSince, stalledNotifiedAt, ...fields } = project;
      changes[gtdKeys.project] = { ...fields, lifecycle: reason, updatedAt: now, ...(reason === "completed" ? { completedAt: now } : {}) };
    }
    for (const entry of context.listStateSync(cell.id, gtdKeys.actionPrefix)) {
      const a = entry.value as ActionRecord;
      if (a?.status === "open" && reason !== "completed")
        changes[entry.key] = {
          ...a,
          status: "cancelled",
          updatedAt: now,
        };
    }
    if (Object.keys(changes).length) context.commitSync(cell.id, { statePatches: changes });
  },
  onCellReopened(cell, context, clock) {
    const project = context.readStateSync<ProjectRecord>(cell.id, gtdKeys.project);
    if (!project) return;
    const { completedAt, stalledSince, stalledNotifiedAt, ...fields } = project;
    context.commitSync(cell.id, { statePatches: { [gtdKeys.project]: { ...fields, lifecycle: "active", updatedAt: clock.now() } } });
  },
};
