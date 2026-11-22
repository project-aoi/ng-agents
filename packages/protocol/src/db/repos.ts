import { emptyBounds, deserializeBounds, serializeBounds } from "../bounds";
import { systemClock, type Clock } from "../clock";
import type { CellRecord, CellSpec, CellStatus, CloseReason, PresetName } from "../contract/cell";
import type { ArtifactVersionRecord, VersionedArtifact } from "../contract/context";
import type { Deliverable } from "../contract/deliverable";
import type { PolicyBounds } from "../contract/envelope";
import { NgError } from "../errors";
import { fromJson, toJson } from "../json";
import { all, get, run, type Db, type SqlParam } from "./sqlite";

// ==================== cells (owner @ng/cell) ====================

interface CellRow {
  id: string;
  parent_id: string | null;
  root_id: string;
  depth: number;
  preset: string | null;
  title: string | null;
  spec: string;
  bounds: string;
  epoch: number;
  status: string;
  close_reason: string | null;
  pause_reason: CellRecord["pauseReason"];
  principal_id: string;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  closed_at: number | null;
}

function toCell(r: CellRow): CellRecord {
  return {
    id: r.id,
    parentId: r.parent_id,
    rootId: r.root_id,
    depth: r.depth,
    preset: r.preset as PresetName | null,
    title: r.title,
    spec: fromJson<CellSpec>(r.spec),
    bounds: deserializeBounds(r.bounds),
    epoch: r.epoch,
    status: r.status as CellStatus,
    pauseReason:r.pause_reason,
    closeReason: r.close_reason as CloseReason | null,
    principalId: r.principal_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunAt: r.last_run_at,
    closedAt: r.closed_at,
  };
}

export interface CellInsert {
  id: string;
  parentId?: string | null;
  preset?: PresetName | null;
  title?: string | null;                // default spec.title
  spec?: CellSpec;                      // default { processor: { kind: "llm" } }
  bounds?: PolicyBounds;                // default emptyBounds()
  principalId?: string;                 // default "owner"
  status?: CellStatus;                  // default "active"
}

export interface CellPatch {
  title?: string | null;
  preset?: PresetName | null;
  spec?: CellSpec;
  bounds?: PolicyBounds;
  lastRunAt?: number | null;
}

export interface CellsRepo {
  get(id: string): CellRecord | undefined;
  /** Throws NgError("not_found"). */
  require(id: string): CellRecord;
  list(filter?: { status?: readonly CellStatus[]; parentId?: string | null; rootId?: string; preset?: PresetName }): CellRecord[];
  children(id: string, opts?: { status?: readonly CellStatus[] }): CellRecord[];
  /** Nearest first (parent, grandparent, …, root). */
  ancestors(id: string): CellRecord[];
  /** Breadth-first by depth, excluding the cell itself. */
  descendants(id: string, opts?: { status?: readonly CellStatus[] }): CellRecord[];
  getEpoch(id: string): number | undefined;
  /** epoch += 1, returns the new epoch. Throws NgError("not_found"). */
  bumpEpoch(id: string): number;
  /** `closed` also sets closed_at and close_reason (default "completed"). */
  setStatus(id: string, status: CellStatus, closeReason?: CloseReason, pauseReason?:"manual"|"parked"|"budget_declined"): void;
  /** root_id/depth are derived from the parent. Throws NgError("not_found") for an unknown parent, NgError("duplicate") for an existing id. */
  insert(init: CellInsert): CellRecord;
  update(id: string, patch: CellPatch): CellRecord;
}

/**
 * Typed access to `cells` (owner @ng/cell). Everyone may read through it. Writes are for @ng/cell, plus the two the
 * contract assigns elsewhere: Inbox.control (bumpEpoch on cancel, setStatus on pause/resume) and tests creating
 * fixtures. All methods are synchronous and run inside the caller's transaction if one is open. No bus events.
 */
export function cellsRepo(db: Db, clock: Clock = systemClock): CellsRepo {
  const SELECT = "SELECT * FROM cells";
  const statusClause = (statuses: readonly CellStatus[] | undefined, params: SqlParam[]) => {
    if (!statuses || statuses.length === 0) return "";
    params.push(...statuses);
    return ` AND status IN (${statuses.map(() => "?").join(",")})`;
  };

  const repo: CellsRepo = {
    get(id) {
      const r = get<CellRow>(db, `${SELECT} WHERE id = ?`, [id]);
      return r ? toCell(r) : undefined;
    },
    require(id) {
      const c = repo.get(id);
      if (!c) throw new NgError("not_found", `cell "${id}" not found`);
      return c;
    },
    list(filter = {}) {
      const params: SqlParam[] = [];
      let sql = `${SELECT} WHERE 1 = 1`;
      sql += statusClause(filter.status, params);
      if (filter.parentId !== undefined) {
        if (filter.parentId === null) sql += " AND parent_id IS NULL";
        else {
          sql += " AND parent_id = ?";
          params.push(filter.parentId);
        }
      }
      if (filter.rootId !== undefined) {
        sql += " AND root_id = ?";
        params.push(filter.rootId);
      }
      if (filter.preset !== undefined) {
        sql += " AND preset = ?";
        params.push(filter.preset);
      }
      sql += " ORDER BY depth, created_at, id";
      return all<CellRow>(db, sql, params).map(toCell);
    },
    children(id, opts = {}) {
      const params: SqlParam[] = [id];
      const sql = `${SELECT} WHERE parent_id = ?${statusClause(opts.status, params)} ORDER BY created_at, id`;
      return all<CellRow>(db, sql, params).map(toCell);
    },
    ancestors(id) {
      return all<CellRow & { lvl: number }>(
        db,
        `WITH RECURSIVE up(id, lvl) AS (
           SELECT parent_id, 1 FROM cells WHERE id = ? AND parent_id IS NOT NULL
           UNION ALL
           SELECT c.parent_id, up.lvl + 1 FROM cells c JOIN up ON c.id = up.id WHERE c.parent_id IS NOT NULL
         )
         SELECT cells.*, up.lvl FROM up JOIN cells ON cells.id = up.id ORDER BY up.lvl`,
        [id],
      ).map(toCell);
    },
    descendants(id, opts = {}) {
      const params: SqlParam[] = [id];
      const filter = statusClause(opts.status, params);
      return all<CellRow>(
        db,
        `WITH RECURSIVE down(id) AS (
           SELECT id FROM cells WHERE parent_id = ?
           UNION ALL
           SELECT c.id FROM cells c JOIN down ON c.parent_id = down.id
         )
         SELECT cells.* FROM down JOIN cells ON cells.id = down.id WHERE 1 = 1${filter}
         ORDER BY cells.depth, cells.created_at, cells.id`,
        params,
      ).map(toCell);
    },
    getEpoch(id) {
      return get<{ epoch: number }>(db, "SELECT epoch FROM cells WHERE id = ?", [id])?.epoch;
    },
    bumpEpoch(id) {
      const r = get<{ epoch: number }>(db, "UPDATE cells SET epoch = epoch + 1, updated_at = ? WHERE id = ? RETURNING epoch", [
        clock.now(),
        id,
      ]);
      if (!r) throw new NgError("not_found", `cell "${id}" not found`);
      return r.epoch;
    },
    setStatus(id, status, closeReason,pauseReason="manual") {
      const now = clock.now();
      const r =
        status === "closed"
          ? run(
              db,
              "UPDATE cells SET status = 'closed', pause_reason=NULL, close_reason = ?, closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE id = ?",
              [closeReason ?? "completed", now, now, id],
            )
          : run(db, "UPDATE cells SET status = ?, pause_reason=?, close_reason = NULL, closed_at = NULL, updated_at = ? WHERE id = ?", [status,status==="paused" ? pauseReason : null, now, id]);
      if (r.changes === 0) throw new NgError("not_found", `cell "${id}" not found`);
    },
    insert(init) {
      if (repo.get(init.id)) throw new NgError("duplicate", `cell "${init.id}" already exists`);
      const parent = init.parentId ? repo.require(init.parentId) : undefined;
      const spec: CellSpec = init.spec ?? { processor: { kind: "llm" } };
      const now = clock.now();
      run(
        db,
        `INSERT INTO cells (id, parent_id, root_id, depth, preset, title, spec, bounds, epoch, status, principal_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          init.id,
          parent?.id ?? null,
          parent ? parent.rootId : init.id,
          parent ? parent.depth + 1 : 0,
          init.preset ?? spec.preset ?? null,
          init.title ?? spec.title ?? null,
          toJson(spec),
          toJson(serializeBounds(init.bounds ?? emptyBounds())),
          init.status ?? "active",
          init.principalId ?? "owner",
          now,
          now,
        ],
      );
      if (init.status==="paused") repo.setStatus(init.id,"paused");
      return repo.require(init.id);
    },
    update(id, patch) {
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if (patch.title !== undefined) {
        sets.push("title = ?");
        params.push(patch.title);
      }
      if (patch.preset !== undefined) {
        sets.push("preset = ?");
        params.push(patch.preset);
      }
      if (patch.spec !== undefined) {
        sets.push("spec = ?");
        params.push(toJson(patch.spec));
      }
      if (patch.bounds !== undefined) {
        sets.push("bounds = ?");
        params.push(toJson(serializeBounds(patch.bounds)));
      }
      if (patch.lastRunAt !== undefined) {
        sets.push("last_run_at = ?");
        params.push(patch.lastRunAt);
      }
      sets.push("updated_at = ?");
      params.push(clock.now(), id);
      const r = run(db, `UPDATE cells SET ${sets.join(", ")} WHERE id = ?`, params);
      if (r.changes === 0) throw new NgError("not_found", `cell "${id}" not found`);
      return repo.require(id);
    },
  };
  return repo;
}

// ==================== artifacts (owner @ng/context) — read-only ====================

interface ArtifactRow {
  artifact_id: string;
  cell_id: string;
  version: number;
  content: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  artifact_id: string;
  version: number;
  content: string;
  updated_by: string;
  created_at: number;
  cell_id: string | null;
}

function toArtifact(r: ArtifactRow): VersionedArtifact {
  return {
    artifactId: r.artifact_id,
    version: r.version,
    content: fromJson<Deliverable>(r.content),
    updatedBy: r.updated_by as VersionedArtifact["updatedBy"],
    cellId: r.cell_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface ArtifactsRepo {
  get(artifactId: string): VersionedArtifact | undefined;
  currentVersion(artifactId: string): number | undefined;
  getVersion(artifactId: string, version: number): ArtifactVersionRecord | undefined;
  listVersions(artifactId: string): ArtifactVersionRecord[];
  listByCell(cellId: string): VersionedArtifact[];
}

/** Read-only view of `artifacts`/`artifact_versions` for Gate (version checks) and the kernel (sending a bound version). */
export function artifactsRepo(db: Db): ArtifactsRepo {
  const toVersion = (r: VersionRow): ArtifactVersionRecord => ({
    artifactId: r.artifact_id,
    version: r.version,
    content: fromJson<Deliverable>(r.content),
    updatedBy: r.updated_by as VersionedArtifact["updatedBy"],
    createdAt: r.created_at,
    cellId: r.cell_id ?? null,
  });
  return {
    get(artifactId) {
      const r = get<ArtifactRow>(db, "SELECT * FROM artifacts WHERE artifact_id = ?", [artifactId]);
      return r ? toArtifact(r) : undefined;
    },
    currentVersion(artifactId) {
      return get<{ version: number }>(db, "SELECT version FROM artifacts WHERE artifact_id = ?", [artifactId])?.version;
    },
    getVersion(artifactId, version) {
      const r = get<VersionRow>(db, "SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?", [artifactId, version]);
      return r ? toVersion(r) : undefined;
    },
    listVersions(artifactId) {
      return all<VersionRow>(db, "SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version", [artifactId]).map(toVersion);
    },
    listByCell(cellId) {
      return all<ArtifactRow>(db, "SELECT * FROM artifacts WHERE cell_id = ? ORDER BY updated_at DESC, artifact_id", [cellId]).map(
        toArtifact,
      );
    },
  };
}
