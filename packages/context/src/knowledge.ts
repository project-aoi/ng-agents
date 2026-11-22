import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  afterCommit,
  all,
  fromJson,
  get,
  newId,
  NgError,
  run,
  toJson,
  withTx,
  type CellRecord,
  type KnowledgeApplies,
  type KnowledgeKind,
  type KnowledgePatch,
  type KnowledgeRecord,
  type KnowledgeScope,
  type SkillIndexEntry,
  type SkillRescanReport,
} from "@ng/protocol";
import type { Deps } from "./deps";
import {
  assertSkillName,
  CELL_SKILLS_DIR,
  isSkillName,
  parseSkillFile,
  serializeSkillFile,
  skillDir,
  skillFilePath,
  skillsRoot,
  type SkillFileContent,
} from "./skillfile";
import { compareStrings } from "./text";

interface KnowledgeRow {
  seq: number;
  id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  cell_id: string | null;
  name: string;
  description: string;
  body: string;
  tags: string;
  created_at: number;
  updated_at: number;
  applies: string | null;
}

function toRecord(r: KnowledgeRow): KnowledgeRecord {
  const applies = r.applies ? fromJson<KnowledgeApplies | null>(r.applies, null) : null;
  return {
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    cellId: r.cell_id,
    name: r.name,
    description: r.description,
    body: r.body,
    tags: fromJson<string[]>(r.tags, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(applies ? { applies } : {}),
  };
}

const KINDS: readonly KnowledgeKind[] = ["skill", "working_note", "reference", "preference"];
const SCOPES: readonly KnowledgeScope[] = ["global", "cell"];

/** `~` / `~/x` → under the owner's home, then resolved: the expansion the kernel applies to `spec.cwd`. null if relative. */
function absoluteDir(input: string): string | null {
  const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  return isAbsolute(expanded) ? resolve(expanded) : null;
}

/** `path` is `dir` or below it, on a path-segment boundary (`/a/b` covers `/a/b/c`, not `/a/bc`). Both resolved. */
function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Validates a patch's `applies` and brings it to its stored form; null = applies to every cell. */
function normalizeApplies(kind: KnowledgeKind, applies: unknown): KnowledgeApplies | null {
  if (applies === undefined || applies === null) return null;
  if (kind !== "preference") throw new NgError("invalid_argument", `cwdPrefix and roles only limit preferences, not a ${kind}`);
  if (typeof applies !== "object" || Array.isArray(applies)) throw new NgError("invalid_argument", "applies must be an object { cwdPrefix?, roles? }");
  const unknown = Object.keys(applies).filter((k) => k !== "cwdPrefix" && k !== "roles");
  if (unknown.length > 0) throw new NgError("invalid_argument", `applies takes only cwdPrefix and roles (got ${unknown.join(", ")})`);
  const { cwdPrefix, roles } = applies as { cwdPrefix?: unknown; roles?: unknown };
  const out: KnowledgeApplies = {};
  if (cwdPrefix !== undefined && cwdPrefix !== null) {
    const dir = typeof cwdPrefix === "string" && cwdPrefix.trim() ? absoluteDir(cwdPrefix.trim()) : null;
    if (!dir) throw new NgError("invalid_argument", `cwdPrefix must be an absolute directory path (got ${JSON.stringify(cwdPrefix)})`);
    out.cwdPrefix = dir;
  }
  if (roles !== undefined && roles !== null) {
    if (!Array.isArray(roles) || !roles.every((r) => typeof r === "string")) throw new NgError("invalid_argument", "roles must be an array of strings");
    const list = [...new Set(roles.map((r) => r.trim().toLowerCase()).filter(Boolean))];
    if (list.length > 0) out.roles = list; // an empty list limits nothing
  }
  return out.cwdPrefix !== undefined || out.roles !== undefined ? out : null;
}

/**
 * Whether a preference limited by `applies` is shown to `cell`: its `spec.cwd` lies in `cwdPrefix` (a cell without a
 * cwd never matches one), and its `spec.meta.role` or preset is one of `roles`. No `applies` → every cell.
 */
export function appliesTo(applies: KnowledgeApplies | undefined, cell: Pick<CellRecord, "preset" | "spec">): boolean {
  if (!applies) return true;
  if (applies.cwdPrefix !== undefined) {
    const dir = absoluteDir(applies.cwdPrefix);
    const cwd = typeof cell.spec.cwd === "string" && cell.spec.cwd ? absoluteDir(cell.spec.cwd) : null;
    if (!dir || !cwd || !isWithin(cwd, dir)) return false;
  }
  if (applies.roles !== undefined) {
    const role = cell.spec.meta?.["role"];
    const mine = [typeof role === "string" ? role : null, cell.spec.preset ?? cell.preset].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    if (!applies.roles.some((r) => mine.includes(r.toLowerCase()))) return false;
  }
  return true;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

function normalizeTags(tags: unknown): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) {
    throw new NgError("invalid_argument", "knowledge tags must be an array of strings");
  }
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

function appendText(existing: string, addition: string): string {
  if (!existing) return addition;
  return existing.endsWith("\n") ? existing + addition : `${existing}\n${addition}`;
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function readSkillFile(path: string): SkillFileContent | null {
  if (!existsSync(path)) return null;
  try {
    return parseSkillFile(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export interface KnowledgeModule {
  get(q: { kind: KnowledgeKind; name: string; scope: KnowledgeScope; cellId?: string }): KnowledgeRecord | null;
  list(filter?: { kind?: KnowledgeKind; cellId?: string; includeGlobal?: boolean }): KnowledgeRecord[];
  /** Knowledge a cell sees: global, ancestors' cell scope, its own — one record per name, nearest scope wins; sorted by name. */
  visible(cellId: string | undefined, kind: KnowledgeKind): KnowledgeRecord[];
  listSkills(cellId?: string): SkillIndexEntry[];
  upsert(cellId: string, patch: KnowledgePatch): void;
  rescan(): SkillRescanReport;
  /** Reads the nearest visible knowledge entry of this kind, using its file for a skill when present. */
  readBody(cellId: string, kind: KnowledgeKind, name: string): string;
  /** Cells whose cell-scoped knowledge `cellId` sees, nearest first (itself, parent, …, root). */
  chain(cellId: string): string[];
}

export function createKnowledge(deps: Deps): KnowledgeModule {
  const { db, bus, clock, cells, dataDir } = deps;

  const rowOf = (kind: KnowledgeKind, scope: KnowledgeScope, cellId: string | null, name: string) =>
    get<KnowledgeRow>(
      db,
      "SELECT * FROM knowledge WHERE kind = ? AND scope = ? AND COALESCE(cell_id, '') = ? AND name = ?",
      [kind, scope, cellId ?? "", name],
    );

  const emitChanged = (kind: KnowledgeKind, name: string, scope: KnowledgeScope, cellId: string | null) =>
    afterCommit(db, () => bus.emit("knowledge.changed", { kind, name, scope, cellId }));

  function chain(cellId: string): string[] {
    return [cellId, ...cells.ancestors(cellId).map((c) => c.id)];
  }

  function visible(cellId: string | undefined, kind: KnowledgeKind): KnowledgeRecord[] {
    const ids = cellId ? chain(cellId) : [];
    const rows = all<KnowledgeRow>(
      db,
      `SELECT * FROM knowledge WHERE kind = ? AND (scope = 'global'${ids.length ? ` OR cell_id IN (${ids.map(() => "?").join(",")})` : ""})`,
      [kind, ...ids],
    );
    const rankOf = (r: KnowledgeRow) => (r.scope === "global" ? ids.length : ids.indexOf(r.cell_id ?? ""));
    const best = new Map<string, KnowledgeRow>();
    for (const r of rows) {
      const prev = best.get(r.name);
      if (!prev || rankOf(r) < rankOf(prev)) best.set(r.name, r);
    }
    return [...best.values()].sort((a, b) => compareStrings(a.name, b.name)).map(toRecord);
  }

  function writeSkill(name: string, cellId: string | null, description: string, body: string, tags: string[]): void {
    const path = skillFilePath(dataDir, name, cellId);
    const extra = readSkillFile(path)?.extra ?? {};
    writeFileAtomic(path, serializeSkillFile({ name, description, tags, body, extra }));
  }

  function removeSkillFile(name: string, cellId: string | null): void {
    const path = skillFilePath(dataDir, name, cellId);
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    // Level-3 scripts may live next to SKILL.md; only an empty directory is removed.
    try {
      rmdirSync(skillDir(dataDir, name, cellId));
    } catch {
      /* not empty or already gone */
    }
  }

  function insertRow(kind: KnowledgeKind, scope: KnowledgeScope, cellId: string | null, name: string, d: string, body: string, tags: string[], applies: string | null = null) {
    const now = clock.now();
    run(
      db,
      `INSERT INTO knowledge (id, kind, scope, cell_id, name, description, body, tags, created_at, updated_at, applies)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("kn", clock), kind, scope, cellId, name, d, body, toJson(tags), now, now, applies],
    );
  }

  function updateRow(seq: number, d: string, body: string, tags: string[], applies: string | null = null) {
    run(db, "UPDATE knowledge SET description = ?, body = ?, tags = ?, updated_at = ?, applies = ? WHERE seq = ?", [d, body, toJson(tags), clock.now(), applies, seq]);
  }

  function upsert(cellId: string, patch: KnowledgePatch): void {
    if (!patch || typeof patch !== "object") throw new NgError("invalid_argument", "knowledge patch must be an object");
    const { kind, scope, mode } = patch;
    if (!KINDS.includes(kind)) throw new NgError("invalid_argument", `invalid knowledge kind "${String(kind)}"`);
    if (!SCOPES.includes(scope)) throw new NgError("invalid_argument", `invalid knowledge scope "${String(scope)}"`);
    if (mode !== "upsert" && mode !== "append" && mode !== "delete") throw new NgError("invalid_argument", `invalid knowledge mode "${String(mode)}"`);
    if (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 200 || /[\r\n]/.test(patch.name)) {
      throw new NgError("invalid_argument", "knowledge name must be a non-empty single line of at most 200 chars");
    }
    const name = patch.name;
    if (kind === "skill") assertSkillName(name);
    const owner = scope === "cell" ? cellId : null;
    if (owner !== null && !cells.get(owner)) throw new NgError("not_found", `cell "${owner}" not found`);
    const existing = rowOf(kind, scope, owner, name);

    if (mode === "delete") {
      if (kind === "skill") removeSkillFile(name, owner);
      if (!existing) return;
      withTx(db, () => {
        run(db, "DELETE FROM knowledge WHERE seq = ?", [existing.seq]);
        emitChanged(kind, name, scope, owner);
      });
      return;
    }

    if (patch.body !== undefined && typeof patch.body !== "string") throw new NgError("invalid_argument", "knowledge body must be a string");
    if (patch.description !== undefined && typeof patch.description !== "string") {
      throw new NgError("invalid_argument", "knowledge description must be a string");
    }
    const description = patch.description?.replace(/\s+/g, " ").trim();
    const tags = patch.tags === undefined ? undefined : normalizeTags(patch.tags);
    const given = normalizeApplies(kind, patch.applies);
    // upsert replaces the whole preference, its reach included (absent = every cell); append keeps it unless given.
    const applies = mode === "append" && patch.applies === undefined ? (existing?.applies ?? null) : given ? toJson(given) : null;
    let next: { description: string; body: string; tags: string[] };
    if (mode === "upsert") {
      if (description === undefined || patch.body === undefined) {
        throw new NgError("invalid_argument", "knowledge upsert requires description and body");
      }
      next = { description, body: patch.body, tags: tags ?? (existing ? fromJson<string[]>(existing.tags, []) : []) };
    } else {
      if (patch.body === undefined) throw new NgError("invalid_argument", "knowledge append requires body");
      next = existing
        ? { description: description ?? existing.description, body: appendText(existing.body, patch.body), tags: tags ?? fromJson<string[]>(existing.tags, []) }
        : { description: description ?? "", body: patch.body, tags: tags ?? [] };
    }

    // File first: if the DB write then fails, the next rescan re-indexes the file; the reverse would lose the edit.
    if (kind === "skill") writeSkill(name, owner, next.description, next.body, next.tags);
    withTx(db, () => {
      if (existing) updateRow(existing.seq, next.description, next.body, next.tags, applies);
      else insertRow(kind, scope, owner, name, next.description, next.body, next.tags, applies);
      emitChanged(kind, name, scope, owner);
    });
  }

  function rescan(): SkillRescanReport {
    const report: SkillRescanReport = { added: [], updated: [], removed: [], unchanged: 0, errors: [] };
    const root = skillsRoot(dataDir);
    type Found = { cellId: string | null; name: string; path: string; content: SkillFileContent | null };
    const found: Found[] = [];
    const listDirs = (dir: string): string[] => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort(compareStrings);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    };
    const collect = (cellId: string | null, base: string) => {
      for (const name of listDirs(base)) {
        if (cellId === null && name === CELL_SKILLS_DIR) continue;
        const path = join(base, name, "SKILL.md");
        if (!existsSync(path)) continue;
        if (!isSkillName(name)) {
          report.errors.push({ path, message: `directory name "${name}" is not a valid skill name` });
          continue;
        }
        let content: SkillFileContent | null = null;
        try {
          content = parseSkillFile(readFileSync(path, "utf8"));
        } catch (err) {
          report.errors.push({ path, message: (err as Error).message });
        }
        found.push({ cellId, name, path, content });
      }
    };
    collect(null, root);
    for (const dirName of listDirs(join(root, CELL_SKILLS_DIR))) {
      let cellId: string;
      try {
        cellId = decodeURIComponent(dirName);
      } catch {
        report.errors.push({ path: join(root, CELL_SKILLS_DIR, dirName), message: "undecodable cell directory name" });
        continue;
      }
      if (!cells.get(cellId)) {
        report.errors.push({ path: join(root, CELL_SKILLS_DIR, dirName), message: `unknown cell "${cellId}"` });
        continue;
      }
      collect(cellId, join(root, CELL_SKILLS_DIR, dirName));
    }

    const label = (cellId: string | null, name: string) => (cellId === null ? name : `${cellId}/${name}`);
    const keyOf = (cellId: string | null, name: string) => `${cellId ?? ""}\u0000${name}`;
    withTx(db, () => {
      const seen = new Set<string>();
      for (const f of found) {
        seen.add(keyOf(f.cellId, f.name));
        if (!f.content) continue; // unparseable: keep whatever is indexed
        const scope: KnowledgeScope = f.cellId === null ? "global" : "cell";
        if (f.content.name && f.content.name !== f.name) {
          report.errors.push({ path: f.path, message: `front matter name "${f.content.name}" differs from directory "${f.name}"; using the directory name` });
        }
        const row = rowOf("skill", scope, f.cellId, f.name);
        const { description, body, tags } = f.content;
        if (!row) {
          insertRow("skill", scope, f.cellId, f.name, description, body, tags);
          report.added.push(label(f.cellId, f.name));
        } else if (row.description !== description || row.body !== body || !sameTags(fromJson<string[]>(row.tags, []), tags)) {
          updateRow(row.seq, description, body, tags);
          report.updated.push(label(f.cellId, f.name));
        } else {
          report.unchanged++;
          continue;
        }
        emitChanged("skill", f.name, scope, f.cellId);
      }
      for (const row of all<KnowledgeRow>(db, "SELECT * FROM knowledge WHERE kind = 'skill' ORDER BY seq")) {
        if (seen.has(keyOf(row.cell_id, row.name))) continue;
        run(db, "DELETE FROM knowledge WHERE seq = ?", [row.seq]);
        report.removed.push(label(row.cell_id, row.name));
        emitChanged("skill", row.name, row.scope, row.cell_id);
      }
    });
    return report;
  }

  function readBody(cellId: string, kind: KnowledgeKind, name: string): string {
    const rec = visible(cellId, kind).find((r) => r.name === name);
    if (kind === "skill" && isSkillName(name)) {
      // The file is the source of truth for skills; it may have been edited since the last rescan.
      const fromFile = readSkillFile(skillFilePath(dataDir, name, rec ? rec.cellId : null));
      if (fromFile) return fromFile.body;
    }
    if (!rec) throw new NgError("not_found", `${kind} "${name}" not found`);
    return rec.body;
  }

  return {
    get(q) {
      if (q.scope === "cell" && !q.cellId) throw new NgError("invalid_argument", "cellId is required for scope \"cell\"");
      const r = rowOf(q.kind, q.scope, q.scope === "cell" ? q.cellId! : null, q.name);
      return r ? toRecord(r) : null;
    },
    list(filter = {}) {
      const where: string[] = [];
      const params: string[] = [];
      if (filter.kind) {
        where.push("kind = ?");
        params.push(filter.kind);
      }
      if (filter.cellId !== undefined) {
        where.push(filter.includeGlobal === false ? "(scope = 'cell' AND cell_id = ?)" : "((scope = 'cell' AND cell_id = ?) OR scope = 'global')");
        params.push(filter.cellId);
      }
      const sql = `SELECT * FROM knowledge${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY kind, scope, COALESCE(cell_id, ''), name`;
      return all<KnowledgeRow>(db, sql, params).map(toRecord);
    },
    visible,
    listSkills(cellId) {
      return visible(cellId, "skill").map((r) => ({ name: r.name, description: r.description, scope: r.scope, tags: r.tags }));
    },
    upsert,
    rescan,
    readBody,
    chain,
  };
}
