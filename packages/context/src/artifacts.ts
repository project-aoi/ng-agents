import {
  afterCommit,
  all,
  artifactsRepo,
  deliverableSchema,
  get,
  newId,
  NgError,
  run,
  toJson,
  type ArtifactVersionRecord,
  type ArtifactWrite,
  type Deliverable,
  type ParkedAddition,
  type ParkInput,
  type VersionedArtifact,
} from "@ng/protocol";
import type { Deps } from "./deps";

interface ParkedRow {
  id: string;
  artifact_id: string;
  based_on_version: number;
  content: string;
  note: string | null;
  created_at: number;
  dismissed_at: number | null;
}

function toParked(r: ParkedRow): ParkedAddition {
  const p: ParkedAddition = {
    id: r.id,
    artifactId: r.artifact_id,
    basedOnVersion: r.based_on_version,
    content: JSON.parse(r.content) as Deliverable,
    createdAt: r.created_at,
    dismissedAt: r.dismissed_at,
  };
  if (r.note !== null) p.note = r.note;
  return p;
}

export function assertDeliverable(content: unknown, what: string): asserts content is Deliverable {
  const r = deliverableSchema.safeParse(content);
  if (!r.success) throw new NgError("invalid_argument", `${what}: invalid Deliverable (${r.error.issues[0]?.message ?? "invalid"})`);
}

/** Outcome of checking an artifact write against the current row, before anything is written. */
export type ArtifactDecision =
  | { kind: "create" }
  | { kind: "update"; current: VersionedArtifact }
  | { kind: "conflict"; current: VersionedArtifact; park: boolean };

export interface ArtifactsModule {
  get(artifactId: string): VersionedArtifact | null;
  listByCell(cellId: string): VersionedArtifact[];
  getVersion(artifactId: string, version: number): ArtifactVersionRecord | null;
  listVersions(artifactId: string): ArtifactVersionRecord[];
  decide(cellId: string, w: ArtifactWrite): ArtifactDecision;
  /** Applies a create/update decision; returns the new version. Emits artifact.changed after commit. */
  apply(cellId: string, w: ArtifactWrite, d: Exclude<ArtifactDecision, { kind: "conflict" }>): number;
  park(artifactId: string, input: ParkInput): ParkedAddition;
  listParked(artifactId: string, opts?: { includeDismissed?: boolean }): ParkedAddition[];
  dismissParked(parkedId: string): void;
}

export function createArtifacts(deps: Deps): ArtifactsModule {
  const { db, bus, clock } = deps;
  const repo = artifactsRepo(db);

  function decide(cellId: string, w: ArtifactWrite): ArtifactDecision {
    if (!w || typeof w.artifactId !== "string" || !w.artifactId) throw new NgError("invalid_argument", "artifact.artifactId is required");
    if (w.updatedBy !== "agent" && w.updatedBy !== "human") throw new NgError("invalid_argument", "artifact.updatedBy must be agent|human");
    if (w.expectedVersion !== undefined && (!Number.isInteger(w.expectedVersion) || w.expectedVersion < 0)) {
      throw new NgError("invalid_argument", "artifact.expectedVersion must be a non-negative integer");
    }
    assertDeliverable(w.content, `artifact "${w.artifactId}"`);
    const current = repo.get(w.artifactId);
    if (!current) {
      if (w.expectedVersion !== undefined && w.expectedVersion !== 0) {
        throw new NgError("not_found", `artifact "${w.artifactId}" does not exist (expectedVersion ${w.expectedVersion})`);
      }
      return { kind: "create" };
    }
    if (current.cellId !== cellId) {
      throw new NgError("invalid_argument", `artifact "${w.artifactId}" belongs to cell "${current.cellId}", not "${cellId}"`);
    }
    const matches =
      w.expectedVersion !== undefined
        ? w.expectedVersion === current.version
        : w.updatedBy === "agent" && current.updatedBy === "agent";
    if (matches) return { kind: "update", current };
    return { kind: "conflict", current, park: w.updatedBy === "agent" && current.updatedBy === "human" };
  }

  function apply(cellId: string, w: ArtifactWrite, d: Exclude<ArtifactDecision, { kind: "conflict" }>): number {
    const now = clock.now();
    const content = toJson(w.content);
    let version: number;
    if (d.kind === "create") {
      version = 1;
      run(
        db,
        `INSERT INTO artifacts (artifact_id, cell_id, version, title, format, content, updated_by, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        [w.artifactId, cellId, w.content.title ?? null, w.content.format, content, w.updatedBy, now, now],
      );
    } else {
      version = d.current.version + 1;
      // Conditional on the version we checked, so a concurrent writer on another connection cannot be overwritten.
      const r = run(
        db,
        `UPDATE artifacts SET version = ?, title = ?, format = ?, content = ?, updated_by = ?, updated_at = ?
         WHERE artifact_id = ? AND version = ?`,
        [version, w.content.title ?? null, w.content.format, content, w.updatedBy, now, w.artifactId, d.current.version],
      );
      if (r.changes !== 1) throw new NgError("conflict", `artifact "${w.artifactId}" changed concurrently`);
    }
    run(
      db,
      "INSERT INTO artifact_versions (artifact_id, version, content, updated_by, created_at) VALUES (?, ?, ?, ?, ?)",
      [w.artifactId, version, content, w.updatedBy, now],
    );
    afterCommit(db, () =>
      bus.emit("artifact.changed", { cellId, artifactId: w.artifactId, version, updatedBy: w.updatedBy }),
    );
    return version;
  }

  function park(artifactId: string, input: ParkInput): ParkedAddition {
    const current = repo.get(artifactId);
    if (!current) throw new NgError("not_found", `artifact "${artifactId}" not found`);
    assertDeliverable(input?.content, `parked addition for "${artifactId}"`);
    if (!Number.isInteger(input.basedOnVersion) || input.basedOnVersion < 0) {
      throw new NgError("invalid_argument", "basedOnVersion must be a non-negative integer");
    }
    if (input.note !== undefined && typeof input.note !== "string") throw new NgError("invalid_argument", "note must be a string");
    const id = newId("park", clock);
    run(
      db,
      `INSERT INTO artifact_parked (id, artifact_id, based_on_version, content, note, created_at, dismissed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [id, artifactId, input.basedOnVersion, toJson(input.content), input.note ?? null, clock.now()],
    );
    afterCommit(db, () =>
      bus.emit("artifact.changed", {
        cellId: current.cellId,
        artifactId,
        version: current.version,
        updatedBy: current.updatedBy,
        parked: true,
      }),
    );
    return toParked(get<ParkedRow>(db, "SELECT * FROM artifact_parked WHERE id = ?", [id])!);
  }

  return {
    get: (id) => repo.get(id) ?? null,
    listByCell: (cellId) => repo.listByCell(cellId),
    getVersion: (id, v) => repo.getVersion(id, v) ?? null,
    listVersions: (id) => repo.listVersions(id),
    decide,
    apply,
    park,
    listParked(artifactId, opts = {}) {
      const sql = `SELECT * FROM artifact_parked WHERE artifact_id = ?${opts.includeDismissed ? "" : " AND dismissed_at IS NULL"} ORDER BY created_at, id`;
      return all<ParkedRow>(db, sql, [artifactId]).map(toParked);
    },
    dismissParked(parkedId) {
      const row = get<ParkedRow>(db, "SELECT * FROM artifact_parked WHERE id = ?", [parkedId]);
      if (!row) throw new NgError("not_found", `parked addition "${parkedId}" not found`);
      if (row.dismissed_at !== null) return;
      run(db, "UPDATE artifact_parked SET dismissed_at = ? WHERE id = ?", [clock.now(), parkedId]);
      const current = repo.get(row.artifact_id);
      if (current) {
        afterCommit(db, () =>
          bus.emit("artifact.changed", {
            cellId: current.cellId,
            artifactId: current.artifactId,
            version: current.version,
            updatedBy: current.updatedBy,
            parked: true,
          }),
        );
      }
    },
  };
}
