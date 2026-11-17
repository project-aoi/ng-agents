import { join } from "node:path";
import { NgError } from "@ng/protocol";
import { parse, stringify } from "yaml";

/** Agent Skills naming rule (agentskills.io): lowercase letters, digits and single hyphens, at most 64 chars. */
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isSkillName(name: string): boolean {
  return name.length <= 64 && SKILL_NAME.test(name);
}

export function assertSkillName(name: string): void {
  if (!isSkillName(name)) {
    throw new NgError("invalid_argument", `invalid skill name "${name}" (lowercase letters, digits and hyphens, at most 64 chars)`);
  }
}

/** Directory that holds the cell-scoped skills; not a valid skill name, so it can never clash with one. */
export const CELL_SKILLS_DIR = "_cells";

/** Path segment for a cell id: percent-encoded, dots included, so no id can traverse out of the skills tree. */
export function cellDirName(cellId: string): string {
  return encodeURIComponent(cellId).replace(/\./g, "%2E");
}

export function skillsRoot(dataDir: string): string {
  return join(dataDir, "skills");
}

export function skillDir(dataDir: string, name: string, cellId: string | null): string {
  return cellId === null
    ? join(skillsRoot(dataDir), name)
    : join(skillsRoot(dataDir), CELL_SKILLS_DIR, cellDirName(cellId), name);
}

export function skillFilePath(dataDir: string, name: string, cellId: string | null): string {
  return join(skillDir(dataDir, name, cellId), "SKILL.md");
}

export interface SkillFileContent {
  name: string;
  description: string;
  tags: string[];
  body: string;
  /** Front matter keys other than name/description/tags, preserved on rewrite (license, allowed-tools, metadata…). */
  extra: Record<string, unknown>;
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*$/m;

function readTags(fm: Record<string, unknown>): string[] {
  const raw = fm["tags"] ?? (fm["metadata"] as Record<string, unknown> | undefined)?.["tags"];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string" && t.length > 0);
  if (typeof raw === "string") return raw.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

/**
 * Parses `---\n<yaml>\n---\n<body>`. One blank line right after the closing fence belongs to the layout, not the
 * body, so serialize → parse returns the body unchanged. Throws NgError("invalid_argument") on a missing fence or
 * invalid YAML.
 */
export function parseSkillFile(text: string): SkillFileContent {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const open = OPEN.exec(src);
  if (!open) throw new NgError("invalid_argument", "SKILL.md must start with YAML front matter (---)");
  const rest = src.slice(open[0].length);
  // The closing fence may be the very first line (empty front matter).
  let yamlText: string;
  let after: string;
  if (/^---[ \t]*(\r?\n|$)/.test(rest)) {
    yamlText = "";
    after = rest.replace(/^---[ \t]*(\r?\n|$)/, "");
  } else {
    const close = CLOSE.exec(rest);
    if (!close) throw new NgError("invalid_argument", "SKILL.md front matter is not closed (---)");
    yamlText = rest.slice(0, close.index);
    after = rest.slice(close.index + close[0].length).replace(/^\r?\n/, "");
  }
  let fm: unknown;
  try {
    fm = yamlText.trim() ? parse(yamlText) : {};
  } catch (err) {
    throw new NgError("invalid_argument", `SKILL.md front matter is not valid YAML: ${(err as Error).message}`);
  }
  if (fm === null || fm === undefined) fm = {};
  if (typeof fm !== "object" || Array.isArray(fm)) throw new NgError("invalid_argument", "SKILL.md front matter must be a mapping");
  const map = fm as Record<string, unknown>;
  const body = after.startsWith("\r\n") ? after.slice(2) : after.startsWith("\n") ? after.slice(1) : after;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) if (k !== "name" && k !== "description" && k !== "tags") extra[k] = v;
  return {
    name: typeof map["name"] === "string" ? map["name"] : "",
    description: typeof map["description"] === "string" ? map["description"].replace(/\s+/g, " ").trim() : "",
    tags: readTags(map),
    body,
    extra,
  };
}

export function serializeSkillFile(skill: SkillFileContent): string {
  const fm: Record<string, unknown> = { name: skill.name, description: skill.description };
  if (skill.tags.length > 0) fm["tags"] = skill.tags;
  for (const [k, v] of Object.entries(skill.extra)) if (!(k in fm) && k !== "tags") fm[k] = v;
  return `---\n${stringify(fm, { lineWidth: 0 })}---\n\n${skill.body}`;
}
