import type { Kernel } from "@ng/cell";
import { gtdKeys, type ActionRecord, type ContextStore, type ProjectLifecycle, type ProjectRecord, type SendToCellResult } from "@ng/protocol";
import { patchAction, patchProject } from "./records";

// For the app's synchronous endpoints: the owner acted on a project from the UI.

const ENDED: ReadonlySet<ProjectLifecycle> = new Set(["completed", "cancelled"]);

/**
 * Radar's lifecycle buttons: bring a project's record in line with what the owner decided, in one commit, next to the
 * kernel call that carries it out (closeCell for completed/cancelled, control pause for someday, resume for active).
 *
 * It agrees with the kernel's close hook (which settles the records of every cell it closes): a record that already
 * ended (completed/cancelled) is never flipped to the other ending, and repeating the current lifecycle changes
 * nothing — so calling it before or after closeCell gives the same books. Ending a project closes its open actions
 * (done for completed, cancelled for cancelled); someday keeps them (the project is only paused and resumes with
 * them). Returns false if the cell holds no project.
 */
export function setProjectLifecycleSync(
  context: Pick<ContextStore, "readStateSync" | "listStateSync" | "commitSync">,
  projectCellId: string,
  lifecycle: ProjectLifecycle,
  now: number,
): boolean {
  const project = context.readStateSync<ProjectRecord>(projectCellId, gtdKeys.project);
  if (!project) return false;
  if (project.lifecycle === lifecycle || (ENDED.has(project.lifecycle) && ENDED.has(lifecycle))) return true;
  // A lifecycle change re-arms the stall check (same as the kernel's close hook).
  const { stalledSince: _s, stalledNotifiedAt: _n, ...rest } = project;
  const patches: Record<string, unknown> = { [gtdKeys.project]: patchProject(rest, { lifecycle }, now) };
  if (ENDED.has(lifecycle)) {
    for (const e of context.listStateSync(projectCellId, gtdKeys.actionPrefix)) {
      const a = e.value as ActionRecord;
      if (a?.status !== "open") continue;
      patches[e.key] = patchAction(a, { status: lifecycle === "completed" ? "done" : "cancelled" }, now);
    }
  }
  context.commitSync(projectCellId, { statePatches: patches });
  return true;
}

/**
 * After the app changed a project's records itself (the owner ticked off a human action, settled one offline, edited
 * a step): tell the project in plain words, as the owner, so it wakes and decides what comes next (a wait on
 * "human" is answered by it). A paused project keeps the message until it is resumed. Returns the delivery result;
 * null when the project cell is closed or unknown (nothing to tell). In the caller's transaction.
 */
export function notifyProjectOfOwnerChangeSync(
  kernel: Pick<Kernel, "getCell" | "sendToCell" | "ownerPrincipal">,
  projectCellId: string,
  text: string,
  opts: { id?: string; principalId?: string } = {},
): SendToCellResult | null {
  const cell = kernel.getCell(projectCellId);
  if (!cell || cell.status === "closed") return null;
  return kernel.sendToCell(projectCellId, { text, summary: "主人更新了事项", ...(opts.id ? { id: opts.id } : {}) }, { principalId: opts.principalId ?? kernel.ownerPrincipal });
}
