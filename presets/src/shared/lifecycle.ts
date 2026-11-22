import { actionBooks } from "./human-actions";
import { gtdKeys } from "./keys";
import type { ProjectRecord } from "./product-records";
import { type PresetDef } from "@ng/protocol";

export const gtdLifecycle: Pick<PresetDef, "onCellClosed" | "onCellReopened"> = {
  onCellClosed(cell, reason, context, clock, store) {
    const now = clock.now();
    const changes: Record<string, unknown> = {};
    const project = context.readStateSync<ProjectRecord>(cell.id, gtdKeys.project);
    if (project?.lifecycle === "active") {
      changes[gtdKeys.project] = { ...project, lifecycle: reason, updatedAt: now, ...(reason === "completed" ? { completedAt: now } : {}) };
    }
    const books = actionBooks(store, cell.id);
    for (const action of books.list()) {
      if (action.status === "open") books.write({
        ...action, status: reason === "completed" ? "done" : "cancelled", updatedAt: now,
        ...(reason === "completed" ? { completedAt: now } : {closedEpoch: cell.epoch}),
      });
    }
    if (Object.keys(changes).length) context.commitSync(cell.id, { statePatches: changes });
  },
  onCellReopened(cell, context, clock, store) {
    const books = actionBooks(store, cell.id);
    for (const action of books.list()) {
      if (action.status !== "cancelled" || action.closedEpoch !== cell.epoch - 1) continue;
      const {closedEpoch, completedAt, ...record} = action;
      books.write({...record, status: "open", updatedAt: clock.now()});
    }
    const project = context.readStateSync<ProjectRecord>(cell.id, gtdKeys.project);
    if (!project) return;
    const { completedAt, ...fields } = project;
    context.commitSync(cell.id, { statePatches: { [gtdKeys.project]: { ...fields, lifecycle: "active", updatedAt: clock.now() } } });
  },
};
