import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

const REPO_OR_INSTRUCTION_MARKERS = [".git", "AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;

/** Canonical real path when `path` exists on disk; otherwise `resolve(path)`. */
export function realOrResolved(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** True if `dir` or any ancestor directory contains a git checkout or agent instruction file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`). */
export function hasRepoOrInstructionAncestor(dir: string): boolean {
  let cur = realOrResolved(dir);
  for (;;) {
    for (const marker of REPO_OR_INSTRUCTION_MARKERS) {
      if (existsSync(join(cur, marker))) return true;
    }
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * Clean host directory for cells without an explicit `cwd` (`desk`, `sensor`, etc.).
 * When `dataDir` itself has no git/instruction ancestor, `<realDataDir>/cells` is already clean.
 * When `dataDir` sits inside a host git repo or under a stray `AGENTS.md`, default cells move out to an isolated
 * clean directory under `tmpdir()/ng-desk-cells/<hash>` (never touching the user's `$HOME`, per P-SAFE-1) and
 * canonicalize symlinks via `realpathSync`.
 */
export function defaultCellsRoot(dataDir: string): string {
  const realData = realOrResolved(dataDir);
  if (!hasRepoOrInstructionAncestor(realData)) {
    return join(realData, "cells");
  }
  const tag = sha256Hex(realData).slice(0, 12);
  const realTmp = realOrResolved(tmpdir());
  const tmpCells = join(realTmp, "ng-desk-cells", tag);
  mkdirSync(tmpCells, { recursive: true });
  return realOrResolved(tmpCells);
}
