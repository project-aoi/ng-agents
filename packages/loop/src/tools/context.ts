import { z } from "zod";
import {
  DEFAULT_RESOURCE_PAGE_CHARS,
  defineTool,
  MAX_RESOURCE_PAGE_CHARS,
  newId,
  type Deliverable,
  type ToolResult,
  type Toolset,
  type VersionedArtifact,
} from "@ng/protocol";
import { clip, firstLine, json, selfId } from "./util";

export const CONTEXT_TOOLSET = "kernel.context";



/**
 * Authoritative kernel / GTD / CLI state keys that models must never overwrite directly through `set_state`
 * (BUG-020). Dedicated workbench tools manage these records. Note: `gtd:action:*` and
 * `hub:topics` remain writable model state.
 */
const RESERVED_STATE_KEYS: ReadonlySet<string> = new Set(["gtd:project", "gtd:source", "gtd:activity", "desk:arbitration"]);
const RESERVED_STATE_PREFIXES: readonly string[] = ["desk:reply:", "desk:proposal:", "desk:reminder:", "gtd:project:", "gtd:source:", "gtd:activity:", "cli:", "sys:", "cell:", "pull:"];

export function isReservedStateKey(key: string): boolean {
  return RESERVED_STATE_KEYS.has(key) || RESERVED_STATE_PREFIXES.some((p) => key.startsWith(p));
}

function describeArtifact(a: VersionedArtifact, withBody: boolean): string {
  const head = `${a.artifactId} v${a.version} (last edited by ${a.updatedBy})${a.content.title ? ` — ${a.content.title}` : ""}`;
  return withBody ? `${head}\nformat: ${a.content.format}\n---\n${a.content.body}` : head;
}

const readState = defineTool({
  name: "read_state",
  kind: "kernel",
  description:
    "Read saved state: one key, or every key under a prefix. Yours by default; pass cellId to read another cell's (a child's records, a project's `gtd:project` and `gtd:action:` entries, the desk's ledger). Reading is open; writing is always your own.",
  input: z.object({ key: z.string().min(1).optional(), prefix: z.string().optional(), cellId: z.string().min(1).optional().describe("default: this cell") }),
  async handler(args, ctx) {
    const cellId = args.cellId ?? selfId(ctx);
    if (args.key !== undefined) {
      const v = await ctx.ports.context.readState(cellId, args.key);
      return v === null ? `${args.key}: (not set)` : `${args.key} = ${json(v)}`;
    }
    const entries = await ctx.ports.context.listState(cellId, args.prefix ?? "");
    if (entries.length === 0) return `No state under "${args.prefix ?? ""}"${args.cellId ? ` in ${args.cellId}` : ""}.`;
    return entries.map((e) => `${e.key} = ${json(e.value)}`).join("\n");
  },
});
const setState = defineTool({
  name: "set_state",
  kind: "kernel",
  description: "Save values in this cell's state (JSON per key; null deletes the key). All keys are written atomically.",
  input: z.object({ patches: z.record(z.string(), z.unknown()) }),
  async handler(args, ctx) {
    const keys = Object.keys(args.patches);
    if (keys.length === 0) return { output: "No keys given.", isError: true };
    const blocked = keys.filter(isReservedStateKey);
    if (blocked.length > 0) {
      return {
        output: `Refused: reserved state key(s) ${blocked.join(", ")} cannot be written directly with set_state (gtd:project, gtd:source, gtd:activity, cli:*, sys:*, cell:*, pull:* are managed by dedicated tools and the kernel).`,
        isError: true,
      };
    }
    await ctx.ports.context.commit(selfId(ctx), { statePatches: args.patches });
    return `Saved ${keys.join(", ")}.`;
  },
});

const readArtifact = defineTool({
  name: "read_artifact",
  kind: "kernel",
  description:
    "Read a draft/document (artifact) with its current version — any cell's, by id. Without an id: list the artifacts of this cell, or of cellId (e.g. the reports a project's workers saved).",
  input: z.object({ artifactId: z.string().min(1).optional(), cellId: z.string().min(1).optional().describe("list this cell's artifacts instead of yours") }),
  async handler(args, ctx) {
    if (args.artifactId) {
      const a = await ctx.ports.context.getArtifact(args.artifactId);
      return a ? { output: describeArtifact(a, true), data: { version: a.version } } : { output: `No artifact ${args.artifactId}.`, isError: true };
    }
    const list = await ctx.ports.context.listArtifacts(args.cellId ?? selfId(ctx));
    return list.length ? list.map((a) => describeArtifact(a, false)).join("\n") : `${args.cellId ?? "This cell"} has no artifacts.`;
  },
});

/**
 * How a rejected artifact write is reported, by save_artifact and patch_artifact alike. The store keeps an agent's
 * losing text beside a human's newer version (parked), so `parked` defaults to "the current version is the human's";
 * a caller that never got as far as committing passes false.
 */
function artifactConflict(cur: VersionedArtifact, retry: string, parked = cur.updatedBy === "human"): ToolResult {
  const kept = parked ? " Your text was kept beside it as a suggestion; the human's version stays." : "";
  return {
    output: `Version conflict: ${cur.artifactId} is at v${cur.version} (last edited by ${cur.updatedBy}).${kept} ${retry} Current content:\n---\n${cur.content.body}`,
    isError: true,
    data: { artifactId: cur.artifactId, currentVersion: cur.version, updatedBy: cur.updatedBy },
  };
}

const saveArtifact = defineTool({
  name: "save_artifact",
  kind: "kernel",
  description: [
    "Create or revise a human-visible draft (reply, proposal, report). Omit artifactId to create one; to change part of an existing artifact use patch_artifact.",
    "To revise an existing one — yours or one another cell created, such as a project's shared report — read it first and pass the expectedVersion you read (required): if someone saved a newer version in between, nothing is overwritten — you get the current version back to rework (and when that newer version is the human's, your text is kept beside it as a suggestion).",
    "Without title, a revision keeps the current title.",
  ].join(" "),
  input: z.object({
    artifactId: z.string().min(1).optional(),
    expectedVersion: z.number().int().min(0).optional(),
    title: z.string().optional(),
    format: z.enum(["text", "markdown", "json"]).optional().describe("default markdown"),
    body: z.string(),
  }),
  async handler(args, ctx) {
    const artifactId = args.artifactId ?? newId("art", ctx.clock);
    const content: Deliverable = { format: args.format ?? "markdown", body: args.body };
    if (args.title) content.title = args.title;
    if (content.format === "json") {
      try {
        content.data = JSON.parse(args.body);
      } catch {
        return { output: "format json needs a valid JSON body.", isError: true };
      }
    }
    const r = await ctx.ports.context.commit(selfId(ctx), {
      artifact: {
        artifactId,
        content,
        updatedBy: "agent",
        ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
      },
    });
    if (r.ok) return { output: `Saved ${artifactId} v${r.artifactVersion ?? "?"}.`, data: { artifactId, version: r.artifactVersion } };
    return artifactConflict(r.currentArtifact, `To revise, save again with expectedVersion ${r.currentArtifact.version}.`);
  },
});

// ---------- patch_artifact: revise part of a (large) text artifact ----------

const EDIT_OPS = ["replace", "append", "prepend", "replace_section"] as const;
type ArtifactEdit = { op: (typeof EDIT_OPS)[number]; find?: string; replace?: string; all?: boolean; heading?: string; text?: string };

/** Formats that are plain text end to end (json keeps a parsed copy in `data`, a card is a structured approval). */
const PATCHABLE_FORMATS: ReadonlySet<Deliverable["format"]> = new Set(["text", "markdown"]);

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 1-based line number of a character offset. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** Every start offset of `needle` in `hay`, overlapping ones included (so "matches once" really means one place). */
function occurrences(hay: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) at.push(i);
  return at;
}

interface MdHeading {
  level: number;
  text: string;
  line: number;
  /** Offset of the heading line, and just past it (after its newline, or the end of the body). */
  start: number;
  end: number;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

function parseHeading(line: string): { level: number; text: string } | null {
  const m = ATX_HEADING.exec(line);
  if (!m) return null;
  // A closing run of #s ("## Title ##") is not part of the text.
  return { level: m[1]!.length, text: (m[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim() };
}

/** ATX headings (`#` … `######`) outside fenced code blocks, in order. */
function markdownHeadings(body: string): MdHeading[] {
  const out: MdHeading[] = [];
  let fence: { char: string; len: number } | null = null;
  for (let start = 0, line = 1; start <= body.length; line++) {
    const nl = body.indexOf("\n", start);
    const stop = nl === -1 ? body.length : nl;
    const raw = body.slice(start, stop).replace(/\r$/, "");
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (f) {
      const run = f[1]!;
      if (!fence) fence = { char: run[0]!, len: run.length };
      else if (run[0] === fence.char && run.length >= fence.len && raw.trim() === run) fence = null;
    } else if (!fence) {
      const h = parseHeading(raw);
      if (h) out.push({ ...h, line, start, end: nl === -1 ? body.length : nl + 1 });
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  return out;
}

/** Body of a Markdown section replaced by `text`, keeping the blank lines that framed the old section. */
function replaceSection(body: string, h: MdHeading, next: MdHeading | undefined, text: string): string {
  const sectionEnd = next ? next.start : body.length;
  const old = body.slice(h.end, sectionEnd);
  const lead = /^(?:[ \t]*\r?\n)*/.exec(old)![0];
  const rest = old.slice(lead.length);
  const trail = rest ? (/\r?\n(?:[ \t]*\r?\n)*$/.exec(rest)?.[0] ?? "") : "";
  const core = text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
  let replacement = core === "" ? (next && lead ? "\n" : "") : lead + core + (trail || (next ? "\n" : ""));
  // The heading was the last line, without a newline: the new content starts on the next line.
  if (replacement && h.end === body.length && !body.endsWith("\n")) replacement = `\n${replacement}`;
  return body.slice(0, h.end) + replacement + body.slice(sectionEnd);
}

/** What is wrong with an edit's fields for its op, or null. */
function editInputError(e: ArtifactEdit): string | null {
  switch (e.op) {
    case "replace":
      if (!e.find) return 'needs find (the exact text to change, not empty) and replace (its new text; "" deletes it)';
      if (typeof e.replace !== "string") return 'needs replace (the new text; "" deletes the find text)';
      return null;
    case "append":
    case "prepend":
      return e.text ? null : "needs text (what to add, not empty)";
    case "replace_section":
      if (!e.heading?.trim()) return 'needs heading (the heading line, e.g. "## Results")';
      return typeof e.text === "string" ? null : 'needs text (the section\'s new content; "" empties it)';
  }
}

/**
 * Applies the edits in order, each to the result of the ones before. All or nothing: the first edit that cannot be
 * applied exactly as asked stops everything and is named in the error.
 */
function applyEdits(body: string, edits: readonly ArtifactEdit[]): { ok: true; body: string } | { ok: false; error: string } {
  let out = body;
  for (const [i, e] of edits.entries()) {
    const which = `edit ${i + 1} (${e.op})`;
    const bad = editInputError(e);
    if (bad) return { ok: false, error: `${which} ${bad}.` };
    switch (e.op) {
      case "replace": {
        const find = e.find!;
        const at = occurrences(out, find);
        if (at.length === 0) {
          return { ok: false, error: `${which}: the find text does not occur in the body${i > 0 ? " (as left by the edits before it)" : ""}. It must match exactly, spaces and line breaks included.` };
        }
        if (e.all) {
          out = out.split(find).join(e.replace!);
        } else if (at.length > 1) {
          const lines = [...new Set(at.slice(0, 50).map((o) => lineAt(out, o)))];
          const where = lines.slice(0, 10).join(", ") + (lines.length > 10 || at.length > 50 ? ", …" : "");
          return { ok: false, error: `${which}: the find text occurs ${at.length} times (lines ${where}). Make it longer so it matches exactly one place, or set all: true to change every occurrence.` };
        } else {
          out = out.slice(0, at[0]) + e.replace! + out.slice(at[0]! + find.length);
        }
        break;
      }
      case "append":
        out = !out || out.endsWith("\n") || e.text!.startsWith("\n") ? out + e.text! : `${out}\n${e.text!}`;
        break;
      case "prepend":
        out = !out || e.text!.endsWith("\n") || out.startsWith("\n") ? e.text! + out : `${e.text!}\n${out}`;
        break;
      case "replace_section": {
        const headings = markdownHeadings(out);
        const want = e.heading!.trim();
        const wanted = parseHeading(want);
        const matches = headings.filter((h) => (wanted && want.startsWith("#") ? h.level === wanted.level && h.text === wanted.text : h.text === want));
        if (matches.length !== 1) {
          const list = (hs: MdHeading[]) => hs.map((h) => `line ${h.line}: ${"#".repeat(h.level)} ${h.text}`).join("; ");
          if (matches.length > 1) {
            return { ok: false, error: `${which}: the heading "${want}" occurs ${matches.length} times (${list(matches)}). Pass the full heading line with its #s, or use replace with a unique passage.` };
          }
          const known = headings.length ? ` Headings in the body: ${list(headings.slice(0, 40))}${headings.length > 40 ? "; …" : ""}.` : " The body has no Markdown headings.";
          return { ok: false, error: `${which}: no heading "${want}" in the body.${known}` };
        }
        const h = matches[0]!;
        out = replaceSection(out, h, headings.find((x) => x.start > h.start && x.level <= h.level), e.text!);
        break;
      }
    }
  }
  return { ok: true, body: out };
}

const patchArtifact = defineTool({
  name: "patch_artifact",
  kind: "kernel",
  description: [
    "Change part of an existing text or Markdown artifact without re-sending all of it — the way to correct or extend a long report.",
    'Each edit is one of: { op: "replace", find, replace, all? } — find must be copied exactly from the body and occur once (all: true changes every occurrence; replace "" deletes it);',
    '{ op: "replace_section", heading, text } — replaces everything under that Markdown heading up to the next heading of the same or higher level (the heading line stays; give the line with its #s, e.g. "## Results", or just its text when that is unique);',
    '{ op: "append", text } / { op: "prepend", text } — adds text on its own line(s) at the end / start.',
    "Edits apply in order, each to the result of the ones before, and all or nothing: if one cannot be applied (find not found, or found more than once; heading missing or not unique) nothing is saved and the error says which edit failed and why.",
    "Pass the expectedVersion you read (required): if someone saved a newer version in between, nothing is overwritten — you get the current version back (and when it is the human's, your edited text is kept beside it as a suggestion).",
    "The result gives the new version and size. The title is kept unless you pass title. To create an artifact or rewrite it whole, use save_artifact.",
  ].join(" "),
  input: z.object({
    artifactId: z.string().min(1),
    expectedVersion: z.number().int().min(1).describe("the version you read (read_artifact shows it)"),
    edits: z
      .array(
        z.object({
          op: z.enum(EDIT_OPS),
          find: z.string().optional().describe("replace: the exact text to change"),
          replace: z.string().optional().describe('replace: its new text ("" deletes it)'),
          all: z.boolean().optional().describe("replace: change every occurrence of find (default: find must occur once)"),
          heading: z.string().optional().describe('replace_section: the heading line, e.g. "## Results"'),
          text: z.string().optional().describe("append / prepend: the text to add; replace_section: the section's new content"),
        }),
      )
      .min(1),
    title: z.string().optional().describe("a new title; omit to keep the current one"),
  }),
  async handler(args, ctx) {
    const { artifactId, expectedVersion } = args;
    const cur = await ctx.ports.context.getArtifact(artifactId);
    if (!cur) return { output: `No artifact ${artifactId}. To create one, use save_artifact.`, isError: true };
    if (!PATCHABLE_FORMATS.has(cur.content.format)) {
      const instead = cur.content.format === "json" ? " Save the whole new JSON with save_artifact (format json) instead." : "";
      return { output: `${artifactId} is a ${cur.content.format} artifact; patch_artifact only edits text and Markdown bodies.${instead}`, isError: true };
    }
    const retry = (v: number) => `To revise, read it again and patch with expectedVersion ${v}.`;
    const stale = cur.version !== expectedVersion;
    let base = cur.content.body;
    if (stale) {
      // Apply the edits to the version that was read, then let the store reject the write: the conflict (and, over a
      // human's version, keeping the edited text beside it) goes exactly the way it does for save_artifact.
      try {
        base = await ctx.ports.context.readResource(selfId(ctx), `artifact://${artifactId}@${expectedVersion}`, { offset: 0, limit: Number.MAX_SAFE_INTEGER });
      } catch {
        return artifactConflict(cur, retry(cur.version), false);
      }
    }
    const patched = applyEdits(base, args.edits);
    if (!patched.ok) {
      if (stale) return artifactConflict(cur, retry(cur.version), false);
      return { output: `${patched.error} Nothing was saved; ${artifactId} stays at v${cur.version}.`, isError: true, data: { artifactId, version: cur.version } };
    }
    const title = args.title?.trim() ? args.title : undefined;
    if (!stale && patched.body === base && (title === undefined || title === cur.content.title)) {
      return { output: `No change: the edits leave ${artifactId} v${cur.version} as it was, so nothing was saved.`, data: { artifactId, version: cur.version } };
    }
    const content: Deliverable = { ...cur.content, body: patched.body, ...(title !== undefined ? { title } : {}) };
    const r = await ctx.ports.context.commit(selfId(ctx), { artifact: { artifactId, content, updatedBy: "agent", expectedVersion } });
    if (!r.ok) return artifactConflict(r.currentArtifact, retry(r.currentArtifact.version));
    const n = args.edits.length;
    const renamed = title !== undefined && title !== cur.content.title ? `; title now "${title}"` : "";
    return {
      output: `Saved ${artifactId} v${r.artifactVersion ?? "?"} (${thousands(patched.body.length)} chars, ${n} edit${n === 1 ? "" : "s"} applied${renamed}).`,
      data: { artifactId, version: r.artifactVersion, chars: patched.body.length, edits: n },
    };
  },
});

const saveNote = defineTool({
  name: "save_note",
  kind: "kernel",
  description:
    "Use working_note for your working memory, reference for a bookmark or observation read on demand, and preference for an owner instruction shared with future runs. Same name replaces it unless append is set. " +
    "A preference is shown to every cell unless you limit it: a rule that only makes sense in one repository or for one kind of cell — e.g. a Rust repo's commit gate — should name that directory (cwdPrefix) and/or role (roles); leave both out for a rule about how the owner wants things done everywhere. " +
    "Saving a preference again replaces its limits too (absent = everywhere), so restate them when you refine a limited one; append keeps them.",
  input: z.object({
    name: z.string().min(1),
    body: z.string().min(1),
    description: z.string().optional().describe("one line; defaults to the first line of body"),
    kind: z.enum(["working_note", "reference", "note", "preference"]).optional(),
    scope: z.enum(["cell", "global"]).optional().describe("default: note → cell, preference → global"),
    append: z.boolean().optional(),
    cwdPrefix: z
      .string()
      .min(1)
      .optional()
      .describe("preference only: absolute path of a directory (~/ allowed); only cells working in it or below it see the preference"),
    roles: z
      .array(z.string().min(1))
      .optional()
      .describe('preference only: only cells of these roles see it — "worker", "project", "checker", "reply_watcher", "desk", "hub", "sensor" (a cell matches by its role or its preset name)'),
  }),
  async handler(args, ctx) {
    const kind = args.kind === "note" ? "working_note" : args.kind ?? "working_note";
    if (kind !== "preference" && (args.cwdPrefix !== undefined || args.roles !== undefined)) {
      return { output: `cwdPrefix and roles only limit a preference; a ${kind} cannot take them. Leave them out, or save with kind "preference".`, isError: true };
    }
    const scope = args.scope ?? (kind === "preference" ? "global" : "cell");
    const applies = { ...(args.cwdPrefix !== undefined ? { cwdPrefix: args.cwdPrefix } : {}), ...(args.roles?.length ? { roles: args.roles } : {}) };
    const limits = [applies.cwdPrefix ? `cells in ${applies.cwdPrefix}` : "", applies.roles ? `roles ${applies.roles.join(", ")}` : ""].filter(Boolean);
    await ctx.ports.context.upsertSkillOrNote(selfId(ctx), {
      kind,
      name: args.name,
      body: args.body,
      description: args.description ?? firstLine(args.body),
      scope,
      mode: args.append ? "append" : "upsert",
      ...(limits.length > 0 ? { applies } : {}),
    });
    return `Saved ${kind} "${args.name}" (${scope}${limits.length > 0 ? `; only for ${limits.join(" and ")}` : ""}).`;
  },
});

const searchHistory = defineTool({
  name: "search_history",
  kind: "kernel",
  description: [
    "Full-text search (Chinese and English) over what was said, done and saved.",
    "scope lineage (default): this cell's own messages, tool output and notes, plus shared notes. scope subtree: also everything below you — closed workers included — with their artifacts, state and the full text of long tool outputs. scope global: every cell on the workbench — use it before starting something new (is there already a project, a report or a preference about this?) and to find how something was done before.",
  ].join(" "),
  input: z.object({ query: z.string().min(1), scope: z.enum(["lineage", "subtree", "global"]).optional() }),
  async handler(args, ctx) {
    const hits = (await ctx.ports.context.searchHistory(selfId(ctx), args.query, args.scope ? { scope: args.scope } : undefined)).slice(0, 20);
    if (hits.length === 0) return `No matches for "${args.query}"${args.scope ? ` (scope ${args.scope})` : ""}.`;
    return hits
      .map((h) => {
        const cell = h.cellId && h.cellId !== selfId(ctx) ? ` cell ${h.cellId}` : "";
        const where =
          h.source === "knowledge"
            ? `${h.kind} ${h.title ?? ""}`.trim()
            : h.source === "evidence"
              ? `#${h.seq} ${h.kind} ${new Date(h.at).toISOString()}${cell}`
              : `${h.source}${h.title ? ` ${h.title}` : ""}${cell}`;
        const full = h.spillUri ?? h.uri;
        return `- [${where}] ${clip(h.text.replace(/\s+/g, " "), 300)}${full ? ` (full: ${full})` : ""}`;
      })
      .join("\n");
  },
});
const readResource = defineTool({
  name: "read_resource",
  kind: "kernel",
  description: [
    "Read a stored resource by URI, in pages: res://… (full output that was truncated), skill://<name> (a skill's body), note://<name>, artifact://<id>[@version].",
    `A page is ${DEFAULT_RESOURCE_PAGE_CHARS} characters unless you pass limit (up to ${MAX_RESOURCE_PAGE_CHARS}, to read a large document in few calls); each page says whether more follows and from which offset.`,
  ].join(" "),
  input: z.object({
    uri: z.string().min(1),
    offset: z.number().int().min(0).optional().describe("character offset"),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`characters: default ${DEFAULT_RESOURCE_PAGE_CHARS}, up to ${MAX_RESOURCE_PAGE_CHARS} when you need a large document in few calls`),
  }),
  async handler(args, ctx) {
    // One page never exceeds what Context keeps inline for read_resource (MAX_RESOURCE_PAGE_CHARS plus this paging
    // line), and it always says whether more follows and where — so a long text is read by walking the offsets, never
    // by guessing. An explicit page size is repeated in the next call so the walk keeps it.
    const offset = args.offset ?? 0;
    const limit = Math.min(args.limit ?? DEFAULT_RESOURCE_PAGE_CHARS, MAX_RESOURCE_PAGE_CHARS);
    const text = await ctx.ports.context.readResource(selfId(ctx), args.uri, { offset, limit: limit + 1 });
    if (text.length <= limit) return offset > 0 && text.length === 0 ? `(nothing at offset ${offset}: the resource ends before it)` : text;
    const pageSize = args.limit !== undefined ? `, limit ${limit}` : "";
    return `${text.slice(0, limit)}\n…[characters ${offset}–${offset + limit} shown; more follows: read_resource("${args.uri}", offset ${offset + limit}${pageSize})]`;
  },
});

/**
 * `kernel.context`: read_state, set_state, read_artifact, save_artifact, patch_artifact, save_note,
 * search_history, read_resource.
 */
export function contextToolset(): Toolset {
  return {
    name: CONTEXT_TOOLSET,
    description: "State, versioned drafts, notes/skills, history search and paged resources.",
    tools: [readState, setState, readArtifact, saveArtifact, patchArtifact, saveNote, searchHistory, readResource],
  };
}
