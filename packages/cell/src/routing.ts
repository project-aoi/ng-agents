import { all, NgError, withTx, type Envelope } from "@ng/protocol";
import type { KernelCore } from "./core";
import { watchFilterMatches } from "./spec";
import type { IngestResult } from "./types";

interface WatchRow {
  id: number;
  cell_id: string;
  filter: string;
  coalesce_ms: number | null;
}

export interface WatchHit {
  cellId: string;
  watchId: number;
  /** docs/05 §3.3: batching window of the watch that matched (null: deliver at once). */
  coalesceMs: number | null;
}

/** Cells whose active watches match the envelope: exact thread first (indexed), then filter-only watches. One hit per cell (its first matching watch). */
export function matchWatches(core: KernelCore, env: Omit<Envelope, "to">): WatchHit[] {
  const hits = new Map<string, WatchHit>();
  const consider = (rows: WatchRow[]) => {
    for (const r of rows) {
      if (hits.has(r.cell_id)) continue;
      const filter = JSON.parse(r.filter) as Record<string, unknown>;
      if (watchFilterMatches(filter, env as unknown as Record<string, unknown>) && core.cells.isActiveInTree(r.cell_id)) hits.set(r.cell_id, { cellId: r.cell_id, watchId: r.id, coalesceMs: r.coalesce_ms });
    }
  };
  for (const thread of env.threads ?? []) {
    consider(
      all<WatchRow>(
        core.db,
        `SELECT w.id, w.cell_id, w.filter, w.coalesce_ms FROM cell_watches w JOIN cells c ON c.id = w.cell_id
         WHERE w.active = 1 AND w.thread = ? AND c.status = 'active' ORDER BY w.id`,
        [thread],
      ),
    );
  }
  consider(
    all<WatchRow>(
      core.db,
      `SELECT w.id, w.cell_id, w.filter, w.coalesce_ms FROM cell_watches w JOIN cells c ON c.id = w.cell_id
       WHERE w.active = 1 AND w.thread IS NULL AND c.status = 'active' ORDER BY w.id`,
    ),
  );
  return [...hits.values()];
}

/**
 * The hub's ingress sink. A message on a watched thread (or matching a watch filter) goes straight to the watching
 * cells (订阅直通), bypassing the desk; everything else goes to the desk. Durably enqueued before it resolves, so an
 * HTTP adapter answers 200 only for what is stored — and what is stored stays queryable (a subscriber that starts later
 * checks the record instead of hoping to catch the edge, docs/05 principle 5).
 * A watch with `coalesceMs` delivers into a fixed batching window keyed by that watch (`coalesce:<watchId>`).
 */
export async function ingest(core: KernelCore, raw: Omit<Envelope, "to">, _channelId: string): Promise<IngestResult> {
  return withTx(core.db, () => {
    const hits = matchWatches(core, raw);
    if (hits.length === 0) {
      const desk = core.cells.get(core.deskCellId);
      if (!desk || desk.status === "closed") throw new NgError("not_found", `no desk cell "${core.deskCellId}" to receive ingress`);
      core.inbox.enqueueSync(desk.id, raw as Envelope);
      return { envelopeId: raw.id, routedBy: "desk", cellIds: [desk.id] };
    }
    const coalesced: string[] = [];
    for (const h of hits) {
      if (h.coalesceMs !== null && h.coalesceMs > 0) {
        core.inbox.enqueueSync(h.cellId, raw as Envelope, { coalesce: { key: `coalesce:${h.watchId}`, windowMs: h.coalesceMs } });
        coalesced.push(h.cellId);
      } else core.inbox.enqueueSync(h.cellId, raw as Envelope);
    }
    return { envelopeId: raw.id, routedBy: "watch", cellIds: hits.map((h) => h.cellId), ...(coalesced.length ? { coalesced } : {}) };
  });
}
