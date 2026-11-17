import { all, NgError, withTx, type Envelope } from "@ng/protocol";
import type { KernelCore } from "./core";
import { watchFilterMatches } from "./spec";
import type { IngestResult } from "./types";

interface WatchRow {
  cell_id: string;
  filter: string;
}

/** Cells whose active watches match the envelope: exact thread first (indexed), then filter-only watches. */
export function matchWatches(core: KernelCore, env: Omit<Envelope, "to">): string[] {
  const hits = new Set<string>();
  const consider = (rows: WatchRow[]) => {
    for (const r of rows) {
      if (hits.has(r.cell_id)) continue;
      const filter = JSON.parse(r.filter) as Record<string, unknown>;
      if (watchFilterMatches(filter, env as unknown as Record<string, unknown>)) hits.add(r.cell_id);
    }
  };
  for (const thread of env.threads ?? []) {
    consider(
      all<WatchRow>(
        core.db,
        `SELECT w.cell_id, w.filter FROM cell_watches w JOIN cells c ON c.id = w.cell_id
         WHERE w.active = 1 AND w.thread = ? AND c.status != 'closed' ORDER BY w.id`,
        [thread],
      ),
    );
  }
  consider(
    all<WatchRow>(
      core.db,
      `SELECT w.cell_id, w.filter FROM cell_watches w JOIN cells c ON c.id = w.cell_id
       WHERE w.active = 1 AND w.thread IS NULL AND c.status != 'closed' ORDER BY w.id`,
    ),
  );
  return [...hits];
}

/**
 * The hub's ingress sink. A message on a watched thread (or matching a watch filter) goes straight to the watching
 * cells (订阅直通), bypassing the desk; everything else goes to the desk. Durably enqueued before it resolves, so an
 * HTTP adapter answers 200 only for what is stored.
 */
export async function ingest(core: KernelCore, raw: Omit<Envelope, "to">, _channelId: string): Promise<IngestResult> {
  return withTx(core.db, () => {
    const watchers = matchWatches(core, raw);
    let cellIds = watchers;
    let routedBy: IngestResult["routedBy"] = "watch";
    if (cellIds.length === 0) {
      const desk = core.cells.get(core.deskCellId);
      if (!desk || desk.status === "closed") throw new NgError("not_found", `no desk cell "${core.deskCellId}" to receive ingress`);
      cellIds = [desk.id];
      routedBy = "desk";
    }
    for (const id of cellIds) core.inbox.enqueueSync(id, raw as Envelope);
    return { envelopeId: raw.id, routedBy, cellIds };
  });
}
