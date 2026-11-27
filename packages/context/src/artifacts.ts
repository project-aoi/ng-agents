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

function hasTitle(title: string | undefined): title is string {
  return typeof title === "string" && title.trim() !== "";
}

/**
 * [BUG-006] A title changes only when a non-empty new one is given: a version saved without a title (an agent revising
 * the body, any upsert that leaves it out) keeps the artifact's current title, in the row and in the version history.
 */
function withKeptTitle(next: Deliverable, current: Deliverable): Deliverable {
  if (hasTitle(next.title) || !hasTitle(current.title)) return next;
  return { ...next, title: current.title };
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
  decide(w: ArtifactWrite): ArtifactDecision;
  /**
   * Applies a create/update decision made by `cellId` (the creator on create; any cell may revise); returns the new
   * version. Emits artifact.changed (with the artifact's own cellId) after commit.
   */
  apply(cellId: string, w: ArtifactWrite, d: Exclude<ArtifactDecision, { kind: "conflict" }>): number;
  park(artifactId: string, input: ParkInput): ParkedAddition;
  listParked(artifactId: string, opts?: { includeDismissed?: boolean }): ParkedAddition[];
  dismissParked(parkedId: string): void;
}

export function createArtifacts(deps: Deps): ArtifactsModule {
  const { db, bus, clock } = deps;
  const repo = artifactsRepo(db);
  const KEEP_RECENT_AGENT_VERSIONS = 10;
  let hasHumanItemsTable: boolean | null = null;

  function pruneIntermediateVersions(artifactId: string, currentVersion: number): void {
    if (currentVersion <= KEEP_RECENT_AGENT_VERSIONS + 1) return;
    if (hasHumanItemsTable === null) {
      hasHumanItemsTable = get(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'human_items'") !== undefined;
    }
    const cutoff = currentVersion - KEEP_RECENT_AGENT_VERSIONS;
    const guardHumanItems = hasHumanItemsTable
      ? `AND NOT EXISTS (
           SELECT 1 FROM human_items h
           WHERE h.artifact_id = artifact_versions.artifact_id
             AND (h.bound_version = artifact_versions.version OR h.proposed_version = artifact_versions.version)
         )`
      : "";
    run(
      db,
      `DELETE FROM artifact_versions
       WHERE artifact_id = ?
         AND version > 1
         AND version <= ?
         AND updated_by = 'agent'
         AND NOT EXISTS (
           SELECT 1 FROM artifact_parked p
           WHERE p.artifact_id = artifact_versions.artifact_id
             AND p.dismissed_at IS NULL
             AND p.based_on_version = artifact_versions.version
         )
         ${guardHumanItems}`,
      [artifactId, cutoff],
    );
  }

  function decide(w: ArtifactWrite): ArtifactDecision {
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
    // [docs/05 §3.4 guard 3] An authorized writer may revise an artifact from the version it read: an update without
    // expectedVersion is a conflict like a stale one, so concurrent revisers can never silently overwrite each other.
    if (w.expectedVersion === current.version) return { kind: "update", current };
    return { kind: "conflict", current, park: w.updatedBy === "agent" && current.updatedBy === "human" };
  }

  function apply(cellId: string, w: ArtifactWrite, d: Exclude<ArtifactDecision, { kind: "conflict" }>): number {
    const now = clock.now();
    const stored = d.kind === "create" ? w.content : withKeptTitle(w.content, d.current.content);
    const content = toJson(stored);
    const owner = d.kind === "create" ? cellId : d.current.cellId;
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
      // The title column follows the same rule as the content: only a non-empty new title replaces it.
      const r = run(
        db,
        `UPDATE artifacts SET version = ?, title = COALESCE(?, title), format = ?, content = ?, updated_by = ?, updated_at = ?
         WHERE artifact_id = ? AND version = ?`,
        [version, hasTitle(stored.title) ? stored.title : null, stored.format, content, w.updatedBy, now, w.artifactId, d.current.version],
      );
      if (r.changes !== 1) throw new NgError("conflict", `artifact "${w.artifactId}" changed concurrently`);
    }
    // A human edit is committed through some cell (e.g. the UI uses the owner), but that cell did not write it.
    run(
      db,
      "INSERT INTO artifact_versions (artifact_id, version, content, updated_by, created_at, cell_id) VALUES (?, ?, ?, ?, ?, ?)",
      [w.artifactId, version, content, w.updatedBy, now, w.updatedBy === "agent" ? cellId : null],
    );
    pruneIntermediateVersions(w.artifactId, version);
    afterCommit(db, () =>
      bus.emit("artifact.changed", { cellId: owner, artifactId: w.artifactId, version, updatedBy: w.updatedBy }),
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
