import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, matchesGlob, relative, sep } from "node:path";
import { NgError, type ExecResult } from "@ng/protocol";
import type { CommandRunner } from "../types";
import { looksBinary } from "./fs-tools";
import { resolveWorkspacePath, type PathPolicy } from "./paths";
import { runCapture } from "./process";

export interface SearchArgs {
  pattern: string;
  path?: string | undefined;
  glob?: string | undefined;
  literal?: boolean | undefined;
  maxResults?: number | undefined;
}

export const MAX_LINE_CHARS = 300;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Looks for an executable `rg` on PATH (a shell function or alias named rg does not count). */
export function detectRipgrep(pathEnv: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "rg");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line;
}

function finish(lines: string[], max: number, more: boolean): ExecResult {
  if (lines.length === 0) return { output: "No matches.\n" };
  let output = lines.join("\n") + "\n";
  if (more) output += `[... stopped at ${max} matches; narrow the pattern, path or glob]\n`;
  return more ? { output, truncated: true } : { output };
}

// ---------- ripgrep ----------

export async function searchWithRipgrep(
  rg: string,
  runner: CommandRunner,
  policy: PathPolicy,
  args: SearchArgs,
  max: number,
  env: Record<string, string>,
): Promise<ExecResult> {
  const target = resolveWorkspacePath(policy, args.path ?? ".");
  const base = policy.confine ? policy.realRoot : policy.root;
  const rgArgs = ["--line-number", "--no-heading", "--with-filename", "--color=never", "--no-messages", "--max-columns", String(MAX_LINE_CHARS), "--max-columns-preview"];
  if (args.literal) rgArgs.push("--fixed-strings");
  if (args.glob) rgArgs.push("--glob", args.glob);
  rgArgs.push("-e", args.pattern, "--", target.rel);
  const r = await runCapture(runner, { file: rg, args: rgArgs, cwd: base, env });
  if (r.error) throw r.error;
  if (r.code === 2) throw new NgError("invalid_argument", `search failed: ${r.stderr.trim() || "ripgrep error"}`);
  const lines = r.stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (l.startsWith("./") ? l.slice(2) : l));
  return finish(lines.slice(0, max), max, lines.length > max);
}

// ---------- built-in fallback ----------

interface IgnoreRule {
  base: string;                         // directory (relative to the search base, "" for the base) holding the .gitignore
  pattern: string;
  dirOnly: boolean;
  anchored: boolean;
}

function parseGitignore(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    // Negations are not supported by this approximation; skipping them errs on the side of searching more files.
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (line) rules.push({ base, pattern: line, dirOnly, anchored });
  }
  return rules;
}

function ignored(rules: readonly IgnoreRule[], relPath: string, name: string, isDir: boolean): boolean {
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base && !(relPath === r.base || relPath.startsWith(r.base + "/"))) continue;
    const local = r.base ? relPath.slice(r.base.length + 1) : relPath;
    if (r.anchored ? matchesGlob(local, r.pattern) || matchesGlob(local, r.pattern + "/**") : matchesGlob(name, r.pattern)) return true;
  }
  return false;
}

/** ripgrep-style glob: a pattern without "/" matches the file name at any depth; a leading "!" excludes. */
function globFilter(glob: string | undefined): (rel: string, name: string) => boolean {
  if (!glob) return () => true;
  const negate = glob.startsWith("!");
  const g = negate ? glob.slice(1) : glob;
  const test = g.includes("/") ? (rel: string) => matchesGlob(rel, g) : (_rel: string, name: string) => matchesGlob(name, g);
  return (rel, name) => test(rel, name) !== negate;
}

function compile(args: SearchArgs): RegExp {
  const source = args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.pattern;
  try {
    return new RegExp(source, "u");
  } catch {
    try {
      return new RegExp(source);
    } catch (e) {
      throw new NgError("invalid_argument", `invalid search pattern: ${(e as Error).message}`);
    }
  }
}

/**
 * Approximates `rg` defaults: hidden entries, `.git`, `node_modules`, binary and very large files are skipped,
 * `.gitignore` files are honoured (without negation), symlinks are not followed (so search cannot leave the root).
 */
export function searchBuiltin(policy: PathPolicy, args: SearchArgs, max: number, signal?: AbortSignal): ExecResult {
  const target = resolveWorkspacePath(policy, args.path ?? ".");
  const base = policy.confine ? policy.realRoot : policy.root;
  const re = compile(args);
  const accept = globFilter(args.glob);
  const lines: string[] = [];
  let more = false;

  const toRel = (abs: string) => relative(base, abs).split(sep).join("/");

  const searchFile = (abs: string) => {
    let buf: Buffer;
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) return;
      buf = readFileSync(abs);
    } catch {
      return;
    }
    if (looksBinary(buf)) return;
    const rel = toRel(abs);
    const text = buf.toString("utf8").split("\n");
    for (let i = 0; i < text.length; i++) {
      const line = text[i]!.replace(/\r$/, "");
      if (re.test(line)) {
        if (lines.length >= max) {
          more = true;
          return;
        }
        lines.push(`${rel}:${i + 1}:${clip(line)}`);
      }
    }
  };

  const walk = (dir: string, rules: readonly IgnoreRule[]) => {
    if (more || signal?.aborted) return;
    let local = rules;
    try {
      const gi = readFileSync(join(dir, ".gitignore"), "utf8");
      local = [...rules, ...parseGitignore(gi, toRel(dir) === "" ? "" : toRel(dir))];
    } catch {
      // no .gitignore here
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (more) return;
      if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink()) continue;
      const abs = join(dir, e.name);
      const rel = toRel(abs);
      if (e.isDirectory()) {
        if (!ignored(local, rel, e.name, true)) walk(abs, local);
      } else if (e.isFile()) {
        if (!ignored(local, rel, e.name, false) && accept(rel, e.name)) searchFile(abs);
      }
    }
  };

  let st;
  try {
    st = statSync(target.abs);
  } catch {
    throw new NgError("not_found", `no such file or directory: ${args.path ?? "."}`);
  }
  if (st.isDirectory()) walk(target.abs, []);
  else searchFile(target.abs);
  return finish(lines, max, more);
}
