import {
  stableStringify, describeBounds,
  get,
  mergeAdjacentMessages,
  NgError,
  run,
  sha256Hex,
  textMessage,
  toJson,
  withTx,
  type CellRecord,
  type ChildSummary,
  type ClaimedBatch,
  type CompactionResult,
  type ContextMode,
  type KnowledgeRecord,
  type ModelMessage,
  type PromptSnapshot,
  type SkillIndexEntry,
} from "@ng/protocol";
import type { Deps, SummaryInput } from "./deps";
import type { EvidenceModule } from "./evidence";
import { appliesTo, type KnowledgeModule } from "./knowledge";
import {
  HISTORY_START_TEXT,
  messagesSize,
  recordSize,
  renderEnvelope,
  renderRecords,
  rosterMessage,
  summaryMessage,
} from "./render";
import { oneLine, safeHead, safeTail } from "./text";
import { referenceLine, referencesIn } from "./summarize";

interface PrefixRow {
  cell_id: string;
  text: string;
  hash: string;
  skills: string;
  epoch: number;
  created_at: number;
  inherited: string | null;
  fork_note: string | null;
  summary: string | null;
  summary_upto_seq: number;
  compactions: number;
}

/** Bound on fork-chain recursion; real chains are a few levels deep. */
const MAX_FORK_DEPTH = 32;

export interface CompactionPlan {
  cellId: string;
  mode: ContextMode;
  baseUpto: number;
  baseCompactions: number;
  uptoSeq: number;
  keptChars: number;
  latestExcerpt?: string;
  charsBefore: number;
  input: SummaryInput;
}

export interface HydrateModule {
  hydrate(cellId: string, batch: ClaimedBatch, mode: ContextMode, compactWith: ((input: SummaryInput) => string) | null): PromptSnapshot;
  planCompaction(cellId: string, mode: ContextMode, force: boolean): CompactionPlan | null;
  applyCompaction(plan: CompactionPlan, summary: string): CompactionResult | null;
  refreshPrefix(cellId: string): void;
  lastEvidenceSeq(cellId: string): number;
}

export interface HydrateDeps extends Deps {
  evidence: EvidenceModule;
  knowledge: KnowledgeModule;
  runtimeVersion:string;
  toolContract(cell: CellRecord): unknown;
  resolvePrompt(cell: CellRecord): string;
  roster(cellId: string): ChildSummary[];
  tailNotes(cellId: string): string[];
}

export function createHydrate(deps: HydrateDeps): HydrateModule {
  const { db, clock, cells, limits, evidence, knowledge } = deps;

  const readRow = (cellId: string) => get<PrefixRow>(db, "SELECT * FROM prompt_prefixes WHERE cell_id = ?", [cellId]);

  /** The cell's `processor.skills` with their bodies; `inlined` names those whose body was found and is in `sections`. */
  function inlinedSkills(cell: CellRecord): { sections: string[]; inlined: Set<string> } {
    const names = cell.spec.processor.kind === "llm" ? (cell.spec.processor.skills ?? []) : [];
    const inlined = new Set<string>();
    const sections = names.map((name) => {
      let body: string;
      try {
        body = knowledge.readBody(cell.id, "skill", name).trimEnd();
        inlined.add(name);
      } catch {
        body = "(this skill is not installed)";
      }
      return `# Skill: ${name}\n${body}`;
    });
    return { sections, inlined };
  }

  /** The long-term preferences this cell sees whose `applies` (directory, roles) matches it. */
  function preferencesFor(cell: CellRecord): KnowledgeRecord[] {
    return knowledge.visible(cell.id, "preference").filter((p) => appliesTo(p.applies, cell));
  }

  function skillsSection(skills: readonly SkillIndexEntry[]): { text: string; shown: SkillIndexEntry[] } | null {
    if (skills.length === 0) return null;
    const max = Math.max(1, limits.skillIndexMaxLines);
    const shown = skills.length > max ? skills.slice(0, max - 1) : [...skills];
    const lines = shown.map((s) => `- ${s.name}: ${oneLine(s.description, 240)}`);
    if (shown.length < skills.length) {
      lines.push(`- … ${skills.length - shown.length} more skills (search_history finds them by name or topic)`);
    }
    return {
      text: `# Skills\nPlaybooks you can load on demand. Before doing one of these kinds of task, read its full instructions with read_resource("skill://<name>").\n${lines.join("\n")}`,
      shown,
    };
  }

  function preferencesSection(prefs: readonly KnowledgeRecord[]): string | null {
    if (prefs.length === 0) return null;
    const lines = prefs.map((p) => {
      const body = p.body.trim().replace(/\n/g, "\n  ");
      return `- ${p.name}: ${body}`;
    });
    return `# Long-term preferences\n${lines.join("\n")}`;
  }

  /** The frozen system prefix of a cell. Deterministic in its inputs; no timestamps. */
  function systemHash(cell: CellRecord, text: string, forkNote = "", parentHash = ""): string {
    return sha256Hex(stableStringify({
      templateVersion: deps.runtimeVersion,
      text, parentHash, forkNote, processor: cell.spec.processor, bounds: describeBounds(cell.bounds),
      tools: deps.toolContract(cell),
      skills: knowledge.visible(cell.id,"skill").map(k => [k.name,k.description,k.body]),
      preferences: preferencesFor(cell).map(k => [k.name,k.body,k.applies]),
    }));
  }

  function originalTask(cellId: string): string | null {
    const row = get<{payload: string | null}>(db, `SELECT content -> '$.envelope.payload' AS payload FROM evidence
      WHERE cell_id=? AND kind='inbound' AND json_extract(content,'$.envelope.type')='cell.task' ORDER BY seq LIMIT 1`,[cellId]);
    if (!row?.payload) return null;
    const task = JSON.parse(row.payload);
    if (task == null) return null;
    const refs = referencesIn(task);
    const instruction = typeof task.instruction === "string" ? oneLine(task.instruction, 800) : "";
    const input = task.input === undefined ? "" : "input=" + stableStringify(task.input);
    return [`[original task] parent=${task.parentCellId ?? ""}`, instruction, input, ...refs].filter(Boolean).join(" ");
  }

  function buildSystem(cell: CellRecord): { text: string; skills: SkillIndexEntry[] } {
    const sections: string[] = [];
    const prompt = deps.resolvePrompt(cell).trimEnd();
    if (prompt) sections.push(prompt);
    const own = inlinedSkills(cell);
    // A skill whose full text is inlined below is not listed again as one to read on demand.
    const skills = skillsSection(knowledge.listSkills(cell.id).filter((s) => !own.inlined.has(s.name)));
    if (skills) sections.push(skills.text);
    sections.push(...own.sections);
    sections.push(`# Your bounds\n${describeBounds(cell.bounds)}`);
    const prefs = preferencesSection(preferencesFor(cell));
    if (prefs) sections.push(prefs);
    return { text: sections.join("\n\n"), skills: skills?.shown ?? [] };
  }

  /** What a fork_prefix child knows about itself; it stands after the inherited history (the system is the parent's). */
  function buildForkNote(cell: CellRecord, parent: CellRecord): string {
    const who = [`cell "${cell.id}"`];
    if (cell.title) who.push(`("${cell.title}")`);
    const kind = cell.preset ? `, a ${cell.preset} cell` : "";
    const parts = [
      `[fork] Everything above is the context of cell "${parent.id}" up to the moment it created this cell. ` +
        `You are now ${who.join(" ")}${kind} with your own task, bounds and history; continue from here on your own.`,
    ];
    const prompt = deps.resolvePrompt(cell).trimEnd();
    if (prompt) parts.push(`## Your instructions\n${prompt}`);
    for (const s of inlinedSkills(cell).sections) parts.push(`#${s}`);
    parts.push(`## Your bounds\n${describeBounds(cell.bounds)}`);
    // The inherited system lists the preferences that apply to the parent; when this cell's differ (another
    // directory or role), its own list stands here.
    const mine = preferencesSection(preferencesFor(cell));
    if (mine !== preferencesSection(preferencesFor(parent))) {
      parts.push(
        mine
          ? `#${mine}\nThese replace the long-term preferences in the system prompt above, which were cell "${parent.id}"'s.`
          : `## Long-term preferences\nThe long-term preferences in the system prompt above were cell "${parent.id}"'s; none of them apply to you.`,
      );
    }
    return parts.join("\n\n");
  }

  function forkParent(cell: CellRecord, mode: ContextMode): CellRecord | undefined {
    if (mode !== "fork_prefix" || !cell.spec.fork) return undefined;
    const parent = cells.get(cell.spec.fork.fromCellId);
    return parent && parent.id !== cell.id ? parent : undefined;
  }

  function ensurePrefix(cell: CellRecord, mode: ContextMode, depth = 0): PrefixRow {
    const existing = readRow(cell.id);
    if (existing) return existing;
    const parent = depth < MAX_FORK_DEPTH ? forkParent(cell, mode) : undefined;
    let ins: Pick<PrefixRow, "text" | "hash" | "skills" | "inherited" | "fork_note">;
    if (parent) {
      // Same system bytes and the parent's history up to the fork point: the provider cache can serve the child.
      const parentRow = ensurePrefix(parent, parent.spec.contextMode ?? "isolated", depth + 1);
      const inherited = renderHistory(parent, parentRow, cell.spec.fork!.uptoSeq, "fork").messages;
      ins = {
        text: parentRow.text,
        hash: systemHash(cell,parentRow.text,buildForkNote(cell,parent),parentRow.hash),
        skills: parentRow.skills,
        inherited: JSON.stringify(inherited),
        fork_note: buildForkNote(cell, parent),
      };
    } else {
      const sys = buildSystem(cell);
      ins = { text: sys.text, hash: systemHash(cell,sys.text), skills: toJson(sys.skills), inherited: null, fork_note: null };
    }
    run(
      db,
      `INSERT INTO prompt_prefixes (cell_id, text, hash, skills, epoch, created_at, inherited, fork_note, summary, summary_upto_seq, compactions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)
       ON CONFLICT(cell_id) DO NOTHING`,
      [cell.id, ins.text, ins.hash, ins.skills, cell.epoch, clock.now(), ins.inherited, ins.fork_note],
    );
    return readRow(cell.id)!;
  }

  /** The fixed head of a history (before the cell's own records): summary, inherited fork context, fork note. */
  function headMessages(row: PrefixRow, includeSummary: boolean): ModelMessage[] {
    const out: ModelMessage[] = [];
    if (includeSummary && row.summary !== null) out.push(summaryMessage(row.summary, row.summary_upto_seq));
    if (row.inherited !== null) out.push(...(JSON.parse(row.inherited) as ModelMessage[]));
    if (row.fork_note !== null) out.push(textMessage("user", row.fork_note));
    return out;
  }

  function renderHistory(
    cell: CellRecord,
    row: PrefixRow,
    upto: number | undefined,
    openAtEnd: "error" | "fork",
  ): { messages: ModelMessage[]; uptoSeq: number } {
    // A child may hydrate for the first time after its parent compacted past the fork point.
    const futureSummary = upto !== undefined && row.summary_upto_seq > upto;
    const messages = futureSummary ? [] : headMessages(row, true);
    const afterSeq = futureSummary ? 0 : row.summary_upto_seq;
    const records = evidence.list(cell.id, { afterSeq, ...(upto !== undefined ? { uptoSeq: upto } : {}) });
    messages.push(...renderRecords(records.map((r) => r.record), { openAtEnd }));
    if (messages[0]?.role === "assistant") messages.unshift(textMessage("user", HISTORY_START_TEXT));
    let uptoSeq = Math.max(afterSeq, records[records.length - 1]?.seq ?? 0);
    if (row.inherited !== null && cell.spec.fork) uptoSeq = Math.max(uptoSeq, cell.spec.fork.uptoSeq);
    return { messages, uptoSeq };
  }

  function planCompaction(cellId: string, mode: ContextMode, force: boolean): CompactionPlan | null {
    const cell = cells.require(cellId);
    const row = ensurePrefix(cell, mode);
    const head = headMessages(row, false);
    const headSize = (row.summary?.length ?? 0) + messagesSize(head);
    const records = evidence.list(cellId, { afterSeq: row.summary_upto_seq });
    const sizes = records.map((r) => recordSize(r.record));
    const total = headSize + sizes.reduce((a, b) => a + b, 0);
    if (!force && total <= limits.compactAtChars) return null;

    // Cut only where a turn starts (or at the end), so no tool_use is ever separated from its result.
    const isTurnStart = (i: number) => {
      const r = records[i]!.record;
      if (r.kind === "run_boundary") return r.phase === "start";
      if (r.kind !== "inbound") return false;
      const prev = records[i - 1]?.record;
      return !(prev?.kind === "run_boundary" && prev.phase === "start");
    };
    const suffix = new Array<number>(records.length + 1).fill(0);
    for (let i = records.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + sizes[i]!;
    // The earliest cut that keeps at most keepRecentChars: the boundary jumps forward in big steps, not every Run.
    let cut = records.length;
    let withinTurn = records.length;
    const openTools = new Set<string>();
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!.record;
      if (record.kind === "run_boundary") openTools.clear();
      if (!openTools.size && suffix[i]! <= limits.keepRecentChars) {
        if (isTurnStart(i)) {
          cut = i;
          break;
        }
        // A single oversized turn may fit only from the middle. Keep complete tool exchanges together.
        if (i > 0 && withinTurn === records.length) withinTurn = i;
      }
      if (record.kind === "tool_call") openTools.add(record.toolUseId);
      if (record.kind === "tool_result") openTools.delete(record.toolUseId);
    }
    if (cut === records.length) cut = withinTurn;
    if (cut === 0 && head.length === 0) return null;
    const folded = mergeAdjacentMessages([...head, ...renderRecords(records.slice(0, cut).map((r) => r.record), { openAtEnd: "error" })]);
    if (folded.length === 0 && row.summary === null) return null;
    // Folding only the inherited part: the summary then stands for the parent's history up to the fork point (the
    // child's own records all have larger seqs, so they are still rendered after it).
    const inheritedUpto = row.inherited !== null ? (cell.spec.fork?.uptoSeq ?? 0) : 0;
    const latest = suffix[cut] === 0 ? records.findLast((_, i) => sizes[i]! > 0) : undefined;
    return {
      cellId,
      mode,
      baseUpto: row.summary_upto_seq,
      baseCompactions: row.compactions,
      uptoSeq: cut > 0 ? records[cut - 1]!.seq : Math.max(row.summary_upto_seq, inheritedUpto),
      keptChars: suffix[cut]!,
      ...(latest ? {latestExcerpt:JSON.stringify(latest.record).slice(-Math.min(1500,limits.keepRecentChars))} : {}),
      charsBefore: total,
      input: { cellId, previousSummary: row.summary, messages: folded, maxChars: limits.summaryMaxChars },
    };
  }

  function applyCompaction(plan: CompactionPlan, summary: string): CompactionResult | null {
    if (typeof summary !== "string") throw new NgError("invalid_argument", "summariser must return a string");
    return withTx(db, () => {
      const row = readRow(plan.cellId);
      // Someone compacted (or refreshed past a compaction) while the summariser ran: drop this result.
      if (!row || row.summary_upto_seq !== plan.baseUpto || row.compactions !== plan.baseCompactions) return null;
      const cell = cells.require(plan.cellId);
      const task = originalTask(cell.id);
      const body = summary.split("\n").filter(line => !line.startsWith("[original task]") && !line.startsWith("[references] ")).join("\n");
      const refs = referenceLine(referencesIn(plan.input.previousSummary, plan.input.messages, summary, task));
      const available = Math.max(0, limits.summaryMaxChars - refs.length - (refs ? 1 : 0));
      const prefix = task ? safeHead(task, Math.floor(available / 2)) : "";
      const remaining = Math.max(0, available - prefix.length - (prefix ? 1 : 0));
      const latest = plan.latestExcerpt ? safeTail(plan.latestExcerpt, Math.floor(remaining / 2) - 15) : "";
      const suffix = latest ? "[latest work] " + latest : "";
      summary = [prefix, safeTail(body, remaining - suffix.length - (suffix ? 1 : 0)), suffix, refs].filter(Boolean).join("\n").trim();
      // The cache is lost at a compaction anyway, so the cell switches to its own, freshly built system prefix.
      const sys = buildSystem(cell);
      run(
        db,
        `UPDATE prompt_prefixes SET text = ?, hash = ?, skills = ?, epoch = ?, created_at = ?, inherited = NULL, fork_note = NULL,
           summary = ?, summary_upto_seq = ?, compactions = compactions + 1
         WHERE cell_id = ?`,
        [sys.text, systemHash(cell,sys.text), toJson(sys.skills), cell.epoch, clock.now(), summary, plan.uptoSeq, plan.cellId],
      );
      return {
        cellId: plan.cellId,
        summaryUptoSeq: plan.uptoSeq,
        foldedMessages: plan.input.messages.length,
        charsBefore: plan.charsBefore,
        charsAfter: summary.length + plan.keptChars,
        compactions: row.compactions + 1,
      };
    });
  }

  function refreshPrefix(cellId: string): void {
    const row = readRow(cellId);
    if (!row) return;
    const cell = cells.require(cellId);
    withTx(db, () => {
      const parent = row.fork_note !== null ? forkParent(cell, "fork_prefix") : undefined;
      if (parent) {
        const parentRow = ensurePrefix(parent, parent.spec.contextMode ?? "isolated");
        run(db, "UPDATE prompt_prefixes SET text = ?, hash = ?, skills = ?, fork_note = ?, epoch = ?, created_at = ? WHERE cell_id = ?", [
          parentRow.text,
          systemHash(cell,parentRow.text,buildForkNote(cell,parent),parentRow.hash),
          parentRow.skills,
          buildForkNote(cell, parent),
          cell.epoch,
          clock.now(),
          cellId,
        ]);
      } else {
        const sys = buildSystem(cell);
        run(db, "UPDATE prompt_prefixes SET text = ?, hash = ?, skills = ?, epoch = ?, created_at = ? WHERE cell_id = ?", [
          sys.text,
          systemHash(cell,sys.text),
          toJson(sys.skills),
          cell.epoch,
          clock.now(),
          cellId,
        ]);
      }
    });
  }

  function hydrate(
    cellId: string,
    batch: ClaimedBatch,
    mode: ContextMode,
    compactWith: ((input: SummaryInput) => string) | null,
  ): PromptSnapshot {
    if (mode !== "isolated" && mode !== "fork_prefix") throw new NgError("invalid_argument", `invalid context mode "${String(mode)}"`);
    if (!batch || batch.cellId !== cellId) throw new NgError("invalid_argument", `batch belongs to cell "${batch?.cellId}", not "${cellId}"`);
    if (compactWith) {
      const plan = planCompaction(cellId, mode, false);
      if (plan) applyCompaction(plan, compactWith(plan.input));
    }
    const cell = cells.require(cellId);
    const row = ensurePrefix(cell, mode);
    const history = renderHistory(cell, row, undefined, "error");
    const roster = deps.roster(cellId);
    const notes = (deps.tailNotes(cellId) ?? []).filter((n) => typeof n === "string" && n.trim() !== "");
    const task = originalTask(cell.id);
    if (task && cell.spec.processor.kind === "llm") notes.unshift(task);
    const tail: ModelMessage[] = [];
    if (roster.length > 0) tail.push(rosterMessage(roster));
    for (const note of notes) tail.push(textMessage("user", note));
    for (const env of batch.envelopes) tail.push(textMessage("user", renderEnvelope(env)));
    return {
      cellId,
      epoch: batch.epoch,
      runId: batch.claimId,
      mode,
      spec: cell.spec,
      bounds: cell.bounds,
      batch,
      system: { text: row.text, hash: row.hash },
      history: history.messages,
      historyUptoSeq: history.uptoSeq,
      summaryUptoSeq: row.summary_upto_seq,
      tail: notes.length > 0 ? { roster, messages: tail, notes } : { roster, messages: tail },
      skills: JSON.parse(row.skills) as SkillIndexEntry[],
      createdAt: clock.now(),
    };
  }

  return {
    hydrate,
    planCompaction,
    applyCompaction,
    refreshPrefix,
    lastEvidenceSeq(cellId) {
      const own = evidence.lastSeq(cellId);
      const fork = cells.get(cellId)?.spec.fork?.uptoSeq ?? 0;
      return Math.max(own, fork);
    },
  };
}
