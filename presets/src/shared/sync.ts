import { gtdKeys, type ActionRecord, type ContextStore, type ProjectLifecycle, type ProjectRecord } from "@ng/protocol";
import { patchAction, patchProject } from "./records";

/**
 * For the app's synchronous endpoints (Radar cancel / complete / someday): bring a project root's records in line with
 * what the owner decided, in one commit. Call it alongside the kernel's control/closeCell — once a root is closed its
 * own coordinator can no longer run, so whoever closes it from outside keeps the books. Open actions become
 * `cancelled` (lifecycle cancelled/someday) or `done` (completed). Returns false if the cell holds no project.
 */
export function setProjectLifecycleSync(
  context: Pick<ContextStore, "readStateSync" | "listStateSync" | "commitSync">,
  rootCellId: string,
  lifecycle: ProjectLifecycle,
  now: number,
): boolean {
  const project = context.readStateSync<ProjectRecord>(rootCellId, gtdKeys.project);
  if (!project) return false;
  const patches: Record<string, unknown> = { [gtdKeys.project]: patchProject(project, { lifecycle }, now) };
  if (lifecycle !== "active") {
    for (const e of context.listStateSync(rootCellId, gtdKeys.actionPrefix)) {
      const a = e.value as ActionRecord;
      if (a.status !== "open") continue;
      patches[e.key] = patchAction(a, { status: lifecycle === "completed" ? "done" : "cancelled" }, now);
    }
  }
  context.commitSync(rootCellId, { statePatches: patches });
  return true;
}
