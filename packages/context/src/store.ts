import { selectRunTools } from "@ng/protocol";
import {
  afterCommit,
  all,
  cellIdOf,
  cellsRepo,
  CELL_STATUS_KEY,
  get,
  isInboxAddr,
  NgError,
  isNgError,
  prefixUpperBound,
  RESOURCE_URI_PREFIX,
  run,
  toJson,
  withTx,
  type CellStatusLine,
  type ChildSummary,
  type CommitResult,
  type CommitTx,
  type ContextMode,
  type ContextStore,
  type KnowledgeKind,
  type ParkedAddition,
  type ResourcePage,
  type SearchScope,
  type StateEntry,
  type StateQuery,
} from "@ng/protocol";
import { createArtifacts } from "./artifacts";
import { DEFAULT_LIMITS, type ContextLimits, type ContextStoreOptions, type Deps } from "./deps";
import { createEvidence, pageOf, toEntry } from "./evidence";
import { createHydrate } from "./hydrate";
import { createKnowledge } from "./knowledge";
import { searchHistory } from "./search";
import { truncatingSummary } from "./summarize";

interface StateRow {
  cell_id: string;
  key: string;
  value: string;
  updated_at: number;
}

const toEntryState = (r: StateRow): StateEntry => ({ cellId: r.cell_id, key: r.key, value: JSON.parse(r.value), updatedAt: r.updated_at });

function resolveLimits(partial: Partial<ContextLimits> | undefined): ContextLimits {
  const l: ContextLimits = { ...DEFAULT_LIMITS, ...partial };
  for (const [k, v] of Object.entries(l)) {
    if (!Number.isInteger(v) || v < 0) throw new NgError("invalid_argument", `context limit ${k} must be a non-negative integer`);
  }
  if (l.spillHeadChars + l.spillTailChars > l.inlineChars) {
    throw new NgError("invalid_argument", "spillHeadChars + spillTailChars must not exceed inlineChars");
  }
  return l;
}

function formatStatusLine(value: unknown): string | null {
  if (!value || typeof value !== "object") return typeof value === "string" ? value : null;
  const line = value as Partial<CellStatusLine>;
  if (typeof line.text !== "string") return null;
  const p = line.progress;
  if (!p || typeof p.done !== "number" || typeof p.total !== "number") return line.text;
  return `${line.text} (${p.done}/${p.total}${p.label ? ` ${p.label}` : ""})`;
}

const SEARCH_SCOPES: readonly SearchScope[] = ["lineage", "subtree", "global"];

/** In the writing cell's state (a reserved `sys:` key): the ids of its own text parked beside this artifact. */
const parkedByKey = (artifactId: string) => `sys:parked:${artifactId}`;

const KNOWLEDGE_SCHEMES: ReadonlyArray<[string, KnowledgeKind]> = [
  ["skill://", "skill"],
  ["working_note://", "working_note"],
  ["reference://", "reference"],
  ["preference://", "preference"],
];

/**
 * ③ Context. All `*Sync` methods run in (or nest inside, via savepoints) one SQLite transaction; async methods
 * delegate to them, except `hydrate`/`compact`, which may await an injected summariser before the sync part.
 */
export function createContextStore(opts: ContextStoreOptions): ContextStore {
  const { db, bus, clock, inbox, registry } = opts;
  const cells = cellsRepo(db, clock);
  const deps: Deps = { db, bus, clock, cells, limits: resolveLimits(opts.limits), dataDir: opts.dataDir };
  const evidence = createEvidence(deps);
  const knowledge = createKnowledge(deps);
  const artifacts = createArtifacts(deps);

  const readStateSync = <T = unknown>(cellId: string, key: string): T | null => {
    const r = get<StateRow>(db,"SELECT * FROM cell_state WHERE cell_id=? AND key=?",[cellId,key]);
    return r ? toEntryState(r).value as T : null;
  };

  /** The store's own records in a cell's state (no state.changed: nothing outside the store reads them). */
  const writeBookkeeping = (cellId: string, key: string, value: unknown): void => {
    if (value === null) run(db, "DELETE FROM cell_state WHERE cell_id = ? AND key = ?", [cellId, key]);
    else
      run(
        db,
        `INSERT INTO cell_state (cell_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(cell_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [cellId, key, toJson(value), clock.now()],
      );
  };

  const defaultRoster = (cellId: string): ChildSummary[] =>
    cells.children(cellId, { status: ["active", "paused"] }).map((c) => ({
      cellId: c.id,
      title: c.title,
      preset: c.preset,
      status: c.status,
      epoch: c.epoch,
      lastRunAt: c.lastRunAt,
      statusLine: formatStatusLine(readStateSync(c.id, CELL_STATUS_KEY)),
    }));

  const hydrateMod = createHydrate({
    runtimeVersion:opts.runtimeVersion ?? "ng-context-06.1",
    toolContract(cell) {
      const p=cell.spec.processor;
      if (!registry || p.kind!=="llm") return [];
      return selectRunTools(registry.resolveTools(p.toolsets ?? []),p,cell.bounds,cell.spec).map(({name,description,inputSchema,kind})=>({name,description,inputSchema,kind}));
    },
    ...deps,
    evidence,
    knowledge,
    roster: opts.rosterProvider ?? defaultRoster,
    tailNotes: opts.tailNotesProvider ?? (() => []),
    resolvePrompt(cell) {
      if (opts.resolvePrompt) return opts.resolvePrompt(cell.spec, cell);
      const p = cell.spec.processor;
      if (p.kind !== "llm" || !p.prompt) return "";
      if (!registry) throw new NgError("invalid_argument", `cell "${cell.id}" names prompt "${p.prompt}" but the context store has no registry`);
      return registry.prompts.require(p.prompt).text;
    },
  });

  function validateCommit(tx: CommitTx): void {
    if (!tx || typeof tx !== "object") throw new NgError("invalid_argument", "commit: tx must be an object");
    if (tx.statePatches !== undefined) {
      if (!tx.statePatches || typeof tx.statePatches !== "object" || Array.isArray(tx.statePatches)) {
        throw new NgError("invalid_argument", "commit: statePatches must be an object");
      }
      for (const key of Object.keys(tx.statePatches)) if (!key) throw new NgError("invalid_argument", "commit: empty state key");
    }
    for (const out of tx.inboxOut ?? []) {
      if (!out || !isInboxAddr(out.to)) throw new NgError("invalid_argument", `commit: inboxOut target "${String(out?.to)}" is not an inbox address`);
      if (!out.envelope || typeof out.envelope !== "object") throw new NgError("invalid_argument", "commit: inboxOut envelope is required");
      if (out.envelope.to !== undefined && out.envelope.to !== out.to) {
        throw new NgError("invalid_argument", `commit: envelope.to "${out.envelope.to}" differs from inboxOut.to "${out.to}"`);
      }
    }
  }

  function commitSync(cellId: string, tx: CommitTx): CommitResult {
    validateCommit(tx);
    return withTx(db, (): CommitResult => {
      const decision = tx.artifact ? artifacts.decide(tx.artifact) : null;
      if (decision?.kind === "conflict") {
        // The whole commit is rejected; the only write that survives is the parked agent content (and the note of
        // whose it is).
        let parked: ParkedAddition | undefined;
        if (decision.park) {
          parked = artifacts.park(tx.artifact!.artifactId, {
            content: tx.artifact!.content,
            basedOnVersion: tx.artifact!.expectedVersion ?? 0,
          });
          const key = parkedByKey(tx.artifact!.artifactId);
          writeBookkeeping(cellId, key, [...(readStateSync<string[]>(cellId, key) ?? []), parked.id]);
        }
        return parked ? { ok: false, currentArtifact: decision.current, parked } : { ok: false, currentArtifact: decision.current };
      }

      const keys = Object.keys(tx.statePatches ?? {});
      if (keys.length > 0) {
        const now = clock.now();
        for (const key of keys) {
          const value = tx.statePatches![key];
          if (value === null || value === undefined) {
            run(db, "DELETE FROM cell_state WHERE cell_id = ? AND key = ?", [cellId, key]);
          } else {
            run(
              db,
              `INSERT INTO cell_state (cell_id, key, value, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(cell_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
              [cellId, key, toJson(value), now],
            );
          }
        }
        afterCommit(db, () => bus.emit("state.changed", { cellId, keys }));
      }

      if (tx.appendReference) {
        knowledge.upsert(cellId, { ...tx.appendReference, kind: "reference", scope: "cell", mode: "append" });
      }
      const version = decision ? artifacts.apply(cellId, tx.artifact!, decision) : undefined;
      if (version !== undefined && tx.artifact!.updatedBy === "agent") {
        // The cell saved a version of its own: what it had parked beside an older version is obsolete now.
        const key = parkedByKey(tx.artifact!.artifactId);
        const own = readStateSync<string[]>(cellId, key);
        if (own) {
          const open = new Set(artifacts.listParked(tx.artifact!.artifactId).map((p) => p.id));
          for (const id of own) if (open.has(id)) artifacts.dismissParked(id);
          writeBookkeeping(cellId, key, null);
        }
      }

      for (const out of tx.inboxOut ?? []) {
        inbox.enqueueSync(cellIdOf(out.to), { ...out.envelope, to: out.to }, out.schedule);
      }
      return version === undefined ? { ok: true } : { ok: true, artifactVersion: version };
    });
  }

  function readResourceSync(cellId: string, uri: string, page?: ResourcePage): string {
    if (typeof uri !== "string") throw new NgError("invalid_argument", "uri must be a string");
    // [docs/05] res:// and artifact:// are readable by any cell; knowledge keeps its nearest-visible-scope rule.
    if (uri.startsWith(RESOURCE_URI_PREFIX)) return evidence.readResource(uri, page);
    for (const [scheme, kind] of KNOWLEDGE_SCHEMES) {
      if (!uri.startsWith(scheme)) continue;
      const raw = uri.slice(scheme.length);
      if (!raw) throw new NgError("invalid_argument", `missing name in "${uri}"`);
      let decoded = raw;
      try { decoded = decodeURIComponent(raw); } catch { /* literal resource name */ }
      for (const name of new Set([raw, decoded])) {
        try { return pageOf(knowledge.readBody(cellId, kind, name), page); }
        catch (err) { if (!isNgError(err, "not_found")) throw err; }
      }
      throw new NgError("not_found", `knowledge resource "${uri}" not found`);
    }
    if (uri.startsWith("artifact://")) {
      const ref = uri.slice("artifact://".length);
      const m = /^(.+?)(?:@(\d+))?$/.exec(ref);
      if (!m) throw new NgError("invalid_argument", `invalid artifact URI "${uri}"`);
      const artifact = artifacts.get(m[1]!);
      if (!artifact) throw new NgError("not_found", `artifact "${m[1]}" not found`);
      if (m[2] === undefined) return pageOf(artifact.content.body, page);
      const v = artifacts.getVersion(artifact.artifactId, Number(m[2]));
      if (!v) throw new NgError("not_found", `artifact "${artifact.artifactId}" has no version ${m[2]}`);
      return pageOf(v.content.body, page);
    }
    throw new NgError("invalid_argument", `unsupported resource URI "${uri}"`);
  }

  async function compactAsync(cellId: string, mode: ContextMode, force: boolean, onSummaryError: "throw" | "skip") {
    const plan = hydrateMod.planCompaction(cellId, mode, force);
    if (!plan) return null;
    let summary: string;
    try {
      summary = await (opts.summarize ?? truncatingSummary)(plan.input);
      if (typeof summary !== "string") throw new NgError("invalid_argument", "summariser must return a string");
    } catch (err) {
      if (onSummaryError === "throw") throw err;
      // A summariser outage must not stop the cell: this Run uses the uncompacted (still prefix-stable) history and
      // the next hydrate tries again.
      console.error(`[context] summariser failed for cell "${cellId}"; hydrating without compaction:`, err);
      return null;
    }
    return hydrateMod.applyCompaction(plan, summary);
  }

  const store: ContextStore = {
    // ---------- sync core ----------
    readStateSync,
    listStateSync(cellId, keyPrefix) {
      return all<StateRow>(
        db,
        "SELECT * FROM cell_state WHERE cell_id = ? AND key >= ? AND key < ? ORDER BY key",
        [cellId, keyPrefix, prefixUpperBound(keyPrefix)],
      ).map(toEntryState);
    },
    queryStateSync(q: StateQuery) {
      if (q.cellIds !== undefined && q.cellIds.length === 0) return [];
      const params = [q.keyPrefix, prefixUpperBound(q.keyPrefix), ...(q.cellIds ?? [])];
      const cellFilter = q.cellIds ? ` AND cell_id IN (${q.cellIds.map(() => "?").join(",")})` : "";
      return all<StateRow>(db, `SELECT * FROM cell_state WHERE key >= ? AND key < ?${cellFilter} ORDER BY key, cell_id`, params).map(
        toEntryState,
      );
    },
    commitSync,
    hydrateSync(cellId, batch, mode) {
      // An injected summariser may be a model call, so only the built-in one runs on the sync path.
      return hydrateMod.hydrate(cellId, batch, mode, opts.summarize ? null : truncatingSummary);
    },
    refreshTailSync: (snapshot, extraNotes) => hydrateMod.refreshTail(snapshot, extraNotes),
    appendEvidenceSync: (cellId, record) => evidence.append(cellId, record),
    readResourceSync,
    searchHistorySync(cellId, query, o) {
      if (typeof query !== "string") throw new NgError("invalid_argument", "query must be a string");
      const scope = o?.scope ?? "lineage";
      if (!SEARCH_SCOPES.includes(scope)) throw new NgError("invalid_argument", `invalid search scope "${String(scope)}"`);
      return searchHistory(deps, knowledge.chain(cellId), cellId, query, { limit: o?.limit ?? deps.limits.searchLimit, scope });
    },
    upsertSkillOrNoteSync: (cellId, patch) => knowledge.upsert(cellId, patch),
    getArtifactSync: (artifactId) => artifacts.get(artifactId),
    listArtifactsSync: (cellId) => artifacts.listByCell(cellId),
    listArtifactVersionsSync: (artifactId) => artifacts.listVersions(artifactId),
    getArtifactVersionSync: (artifactId, version) => artifacts.getVersion(artifactId, version),
    listParkedSync: (artifactId, o) => artifacts.listParked(artifactId, o),
    dismissParkedSync: (parkedId) => withTx(db, () => artifacts.dismissParked(parkedId)),
    parkAdditionSync: (artifactId, addition) => withTx(db, () => artifacts.park(artifactId, addition)),
    getKnowledgeSync: (q) => knowledge.get(q),
    listKnowledgeSync: (filter) => knowledge.list(filter),
    listSkillsSync: (cellId) => knowledge.listSkills(cellId),
    rescanSkillsSync: () => knowledge.rescan(),
    writeResourceSync: (cellId, content, meta) => evidence.writeResource(cellId, content, meta),
    lastEvidenceSeqSync: (cellId) => hydrateMod.lastEvidenceSeq(cellId),
    listEvidenceSync: (cellId, o) => evidence.list(cellId, o).map(toEntry),
    refreshPrefixSync: (cellId) => hydrateMod.refreshPrefix(cellId),

    // ---------- async contract ----------
    async readState<T = unknown>(cellId: string, key: string) {
      return readStateSync<T>(cellId, key);
    },
    async commit(cellId, tx) {
      return commitSync(cellId, tx);
    },
    async hydrate(cellId, batch, mode) {
      if (opts.summarize) await compactAsync(cellId, mode, false, "skip");
      return hydrateMod.hydrate(cellId, batch, mode, opts.summarize ? null : truncatingSummary);
    },
    async compact(cellId, o = {}) {
      return compactAsync(cellId, o.mode ?? cells.require(cellId).spec.contextMode ?? "isolated", o.force ?? false, "throw");
    },
    async appendEvidence(cellId, record) {
      return evidence.append(cellId, record);
    },
    async readResource(cellId, uri, page) {
      return readResourceSync(cellId, uri, page);
    },
    async searchHistory(cellId, query, o) {
      return store.searchHistorySync(cellId, query, o);
    },
    async upsertSkillOrNote(cellId, patch) {
      knowledge.upsert(cellId, patch);
    },
    async listState(cellId, keyPrefix) {
      return store.listStateSync(cellId, keyPrefix);
    },
    async queryState(q) {
      return store.queryStateSync(q);
    },
    async getArtifactVersion(id,version) { return artifacts.getVersion(id,version); },
    async getArtifact(artifactId) {
      return artifacts.get(artifactId);
    },
    async listArtifacts(cellId) {
      return artifacts.listByCell(cellId);
    },
  };

  if (opts.rescanSkillsOnCreate !== false) knowledge.rescan();
  return store;
}
