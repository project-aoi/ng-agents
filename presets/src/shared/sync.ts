import type { Kernel } from "@ng/cell";
import type { SendToCellResult } from "@ng/protocol";

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
