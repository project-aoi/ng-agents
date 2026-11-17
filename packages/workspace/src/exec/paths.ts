import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { NgError } from "@ng/protocol";
import { isInside } from "../util";

export interface PathPolicy {
  /** Host root of the workspace as configured. */
  root: string;
  /** realpath(root): containment is checked against it so a symlinked root still works. */
  realRoot: string;
  /** false only for isolation "none" (the protocol allows leaving the root there). */
  confine: boolean;
  /** Absolute prefixes that denote the root from the sandbox's point of view (e.g. "/workspace" in a container). */
  aliases?: readonly string[];
}

export interface ResolvedPath {
  /** Host path to operate on (symlinks resolved when confined). */
  abs: string;
  /** Path relative to the real root, for messages and search output ("." for the root itself). */
  rel: string;
}

function escape(input: string, why: string): NgError {
  return new NgError("bounds_violation", `path "${input}" is outside the workspace (${why})`);
}

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves `input` (relative to the root, or absolute inside it) to a host path. When confined, rejects `..`
 * escapes, absolute paths elsewhere, and any symlink — at the target or in a parent — that leads out of the root,
 * including dangling links (a write would follow them). For not-yet-existing paths the deepest existing ancestor is
 * resolved and the missing tail re-appended, since the tail cannot be a link yet.
 */
export function resolveWorkspacePath(policy: PathPolicy, input: string): ResolvedPath {
  if (typeof input !== "string" || input.length === 0) throw new NgError("invalid_argument", "path must be a non-empty string");
  if (input.includes("\0")) throw new NgError("invalid_argument", "path contains a NUL byte");

  let p = input;
  for (const alias of policy.aliases ?? []) {
    if (p === alias || p.startsWith(alias.endsWith("/") ? alias : alias + "/")) {
      p = join(policy.root, p.slice(alias.length));
      break;
    }
  }
  const lexical = resolve(policy.root, p);
  if (!policy.confine) return { abs: lexical, rel: relative(policy.root, lexical) || "." };

  if (!isInside(policy.root, lexical) && !isInside(policy.realRoot, lexical)) throw escape(input, "resolves above the root");

  let existing = lexical;
  const tail: string[] = [];
  while (!lexists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    throw escape(input, "dangling symbolic link");
  }
  const abs = tail.length ? join(real, ...tail) : real;
  if (!isInside(policy.realRoot, abs)) throw escape(input, "a symbolic link leads out of the root");
  return { abs, rel: relative(policy.realRoot, abs) || "." };
}

export function makePathPolicy(root: string, confine: boolean, aliases?: readonly string[]): PathPolicy {
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // The root may not exist yet while a workspace is being provisioned; resolve lazily at first use.
  }
  return { root: resolve(root), realRoot, confine, ...(aliases ? { aliases } : {}) };
}
