import { z } from "zod";
import { DEFAULT_RESOURCE_PAGE_CHARS, defineTool, newId, type Deliverable, type Toolset, type VersionedArtifact } from "@ng/protocol";
import { clip, firstLine, json, selfId } from "./util";

export const CONTEXT_TOOLSET = "kernel.context";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
const saveArtifact = defineTool({
  name: "save_artifact",
  kind: "kernel",
  description: [
    "Create or revise a human-visible draft (reply, proposal, report). Omit artifactId to create one.",
    "To revise an existing one — yours or one another cell created, such as a project's shared report — read it first and pass the expectedVersion you read (required): if someone saved a newer version in between, nothing is overwritten — you get the current version back to rework (and when that newer version is the human's, your text is kept beside it as a suggestion).",
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
    const cur = r.currentArtifact;
    const parked = cur.updatedBy === "human" ? " Your text was kept beside it as a suggestion; the human's version stays." : "";
    return {
      output: `Version conflict: ${cur.artifactId} is at v${cur.version} (last edited by ${cur.updatedBy}).${parked} To revise, save again with expectedVersion ${cur.version}. Current content:\n---\n${cur.content.body}`,
      isError: true,
      data: { artifactId: cur.artifactId, currentVersion: cur.version, updatedBy: cur.updatedBy },
    };
  },
});

const saveNote = defineTool({
  name: "save_note",
  kind: "kernel",
  description:
    "Keep something for later: a note (facts, links, decisions; searchable) or a preference (how the owner likes things done; shown to you in future runs). Same name replaces it unless append is set.",
  input: z.object({
    name: z.string().min(1),
    body: z.string().min(1),
    description: z.string().optional().describe("one line; defaults to the first line of body"),
    kind: z.enum(["note", "preference"]).optional(),
    scope: z.enum(["cell", "global"]).optional().describe("default: note → cell, preference → global"),
    append: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const kind = args.kind ?? "note";
    const scope = args.scope ?? (kind === "preference" ? "global" : "cell");
    await ctx.ports.context.upsertSkillOrNote(selfId(ctx), {
      kind,
      name: args.name,
      body: args.body,
      description: args.description ?? firstLine(args.body),
      scope,
      mode: args.append ? "append" : "upsert",
    });
    return `Saved ${kind} "${args.name}" (${scope}).`;
  },
});

const saveSkill = defineTool({
  name: "save_skill",
  kind: "kernel",
  description:
    "Write or replace a SKILL.md: a reusable procedure for a recurring kind of task. The description is what future runs see in the skills index, so say when to use it; the body is read on demand.",
  input: z.object({
    name: z.string().regex(SLUG, "lowercase slug, e.g. weekly-review"),
    description: z.string().min(1),
    body: z.string().min(1),
    scope: z.enum(["global", "cell"]).optional().describe("default global"),
  }),
  async handler(args, ctx) {
    const scope = args.scope ?? "global";
    await ctx.ports.context.upsertSkillOrNote(selfId(ctx), {
      kind: "skill",
      name: args.name,
      description: args.description,
      body: args.body,
      scope,
      mode: "upsert",
    });
    return `Saved skill "${args.name}" (${scope}).`;
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
  description:
    "Read a stored resource by URI, in pages: res://… (full output that was truncated), skill://<name> (a skill's body), note://<name>, artifact://<id>[@version].",
  input: z.object({
    uri: z.string().min(1),
    offset: z.number().int().min(0).optional().describe("character offset"),
    limit: z.number().int().min(1).optional().describe("characters (default and maximum 8000)"),
  }),
  async handler(args, ctx) {
    // One page never exceeds what stays inline (see EXPLICIT_READ_INLINE_CHARS), and it always says whether more
    // follows and where — so a long text is read by walking the offsets, never by guessing.
    const offset = args.offset ?? 0;
    const limit = Math.min(args.limit ?? DEFAULT_RESOURCE_PAGE_CHARS, DEFAULT_RESOURCE_PAGE_CHARS);
    const text = await ctx.ports.context.readResource(selfId(ctx), args.uri, { offset, limit: limit + 1 });
    if (text.length <= limit) return offset > 0 && text.length === 0 ? `(nothing at offset ${offset}: the resource ends before it)` : text;
    return `${text.slice(0, limit)}\n…[characters ${offset}–${offset + limit} shown; more follows: read_resource("${args.uri}", offset ${offset + limit})]`;
  },
});

/** `kernel.context`: read_state, set_state, read_artifact, save_artifact, save_note, save_skill, search_history, read_resource. */
export function contextToolset(): Toolset {
  return {
    name: CONTEXT_TOOLSET,
    description: "State, versioned drafts, notes/skills, history search and paged resources.",
    tools: [readState, setState, readArtifact, saveArtifact, saveNote, saveSkill, searchHistory, readResource],
  };
}
