import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { NgError, type CellRecord, type CwdMode } from "@ng/protocol";
import type { KernelCore } from "./core";

// docs/05 principle 3/4: cells work in real directories of the owner's machine. The kernel never creates, snapshots
// or removes them; what it does own is *who may write where, when* — one writing cell per work tree at a time.

/** `~/x` → the owner's home; the result must be absolute. */
export function normalizeCwd(input: string): string {
  const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  if (!isAbsolute(expanded)) throw new NgError("invalid_argument", `cwd must be an absolute path (got "${input}")`);
  return resolve(expanded);
}

export function assertDirectory(path: string, what: string): void {
  let ok = false;
  try {
    ok = statSync(path).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new NgError("invalid_argument", `${what} is not an existing directory: ${path}. Ask the owner for the right path instead of guessing.`);
}

/** The kernel's own per-cell directory (under its data dir): the cwd of a cell nobody gave one. Never removed. */
export function ownCellDir(core: Pick<KernelCore, "dataDir">, cellId: string): string {
  return join(core.dataDir, "cells", encodeURIComponent(cellId));
}

type CwdCore = Pick<KernelCore, "dataDir" | "repoPath" | "registry">;

/** Presets that keep to themselves (`PresetDef.inheritCwd: false` — watchers, sensors) never fall back to a shared directory. */
function keepsPrivateDir(core: CwdCore, cell: Pick<CellRecord, "spec">): boolean {
  return cell.spec.preset !== undefined && core.registry.presets.get(cell.spec.preset)?.inheritCwd === false;
}

/**
 * Where the cell works: its (possibly inherited) `spec.cwd`; else the kernel's `repoPath`; else — and always for a
 * preset that does not inherit — the kernel's own per-cell directory.
 */
export function effectiveCwd(core: CwdCore, cell: Pick<CellRecord, "id" | "spec">): string {
  if (cell.spec.cwd) return cell.spec.cwd;
  if (core.repoPath && !keepsPrivateDir(core, cell)) return resolve(core.repoPath);
  return ownCellDir(core, cell.id);
}

/** Creates the kernel-owned fallback directory when that is what the cell uses (a configured cwd must already exist). */
export function ensureCwd(core: CwdCore, cell: Pick<CellRecord, "id" | "spec">): string {
  const cwd = effectiveCwd(core, cell);
  if (cwd === ownCellDir(core, cell.id)) mkdirSync(cwd, { recursive: true });
  return cwd;
}

export function cwdModeOf(cell: Pick<CellRecord, "spec">): CwdMode {
  return cell.spec.cwdMode === "write" ? "write" : "read";
}

const KEY_TTL_MS = 30_000;
const keyCache = new Map<string, { key: string; at: number }>();

/**
 * The unit of mutual exclusion for writers: the git work tree the directory belongs to (so `/repo` and
 * `/repo/packages/ui` queue together, while two separate worktrees of one repository run in parallel), or the real
 * path of a directory that is not in a work tree. Cached briefly: it is asked on every dispatch.
 */
export function workTreeKey(cwd: string): string {
  const hit = keyCache.get(cwd);
  const now = Date.now();
  if (hit && now - hit.at < KEY_TTL_MS) return hit.key;
  let key: string;
  try {
    key = realpathSync(cwd);
  } catch {
    key = resolve(cwd);
  }
  try {
    const top = execFileSync("git", ["-C", key, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    }).trim();
    if (top) key = realpathSync(top);
  } catch {
    // not a work tree (or no git): the directory itself is the unit
  }
  keyCache.set(cwd, { key, at: now });
  if (keyCache.size > 512) keyCache.delete(keyCache.keys().next().value!);
  return key;
}

/** For tests that create a repository after the directory was first seen. */
export function forgetWorkTreeKeys(): void {
  keyCache.clear();
}

/**
 * The write slot this cell competes for, or null when it takes none: read-mode cells never write, and a cell with an
 * explicit isolated workspace (git_worktree / container) writes into a private copy.
 */
export function writeSlotKey(core: CwdCore, cell: Pick<CellRecord, "id" | "spec" | "bounds">): string | null {
  if (cwdModeOf(cell) !== "write") return null;
  if (cell.bounds.isolation !== "none") return null;
  return workTreeKey(effectiveCwd(core, cell));
}
