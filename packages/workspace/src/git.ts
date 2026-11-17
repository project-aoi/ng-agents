import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { NgError } from "@ng/protocol";
import { runCapture } from "./exec/process";
import type { CommandRunner } from "./types";
import { isInside } from "./util";

/**
 * Overrides applied to every git command the kernel runs. A sandboxed cell can write hooks and config into the
 * repository it works on (a worktree shares `.git` with the base repo), so the kernel never runs repository hooks
 * or fsmonitor commands, never signs, and runs git with the minimal environment instead of its own (which may hold
 * secrets).
 */
const SAFE_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false"];

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class Git {
  constructor(
    private readonly runner: CommandRunner,
    private readonly env: Record<string, string>,
    readonly identity: { name: string; email: string },
  ) {}

  async run(cwd: string, args: readonly string[], timeoutMs = 300_000): Promise<GitResult> {
    const r = await runCapture(this.runner, { file: "git", args: [...SAFE_CONFIG, ...args], cwd, env: this.env }, { timeoutMs });
    if (r.error) throw new NgError("unsupported", `git ${args[0] ?? ""} could not run: ${r.error.message}`);
    return r;
  }

  async ok(cwd: string, args: readonly string[]): Promise<string> {
    const r = await this.run(cwd, args);
    if (r.code !== 0) throw new NgError("conflict", `git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  }

  async toplevel(repoPath: string): Promise<string> {
    if (!existsSync(repoPath)) throw new NgError("invalid_argument", `repository path does not exist: ${repoPath}`);
    const r = await this.run(repoPath, ["rev-parse", "--show-toplevel"]);
    if (r.code !== 0 || !r.stdout.trim()) throw new NgError("invalid_argument", `not a git repository: ${repoPath}`);
    return realpathSync(r.stdout.trim());
  }

  async resolveCommit(top: string, ref: string): Promise<string> {
    const r = await this.run(top, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    if (r.code !== 0 || !r.stdout.trim()) throw new NgError("invalid_argument", `cannot resolve "${ref}" to a commit in ${top}`);
    return r.stdout.trim();
  }

  async checkBranchName(top: string, branch: string): Promise<void> {
    const r = await this.run(top, ["check-ref-format", "--branch", branch]);
    if (r.code !== 0) throw new NgError("invalid_argument", `invalid branch name "${branch}"`);
  }

  async branchExists(top: string, branch: string): Promise<boolean> {
    return (await this.run(top, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  }

  async commitsAhead(top: string, baseSha: string, branch: string): Promise<number> {
    if (!(await this.branchExists(top, branch))) return 0;
    const out = await this.ok(top, ["rev-list", "--count", `${baseSha}..refs/heads/${branch}`]);
    return Number(out) || 0;
  }

  async deleteBranch(top: string, branch: string): Promise<void> {
    await this.run(top, ["branch", "-D", "--", branch]);
  }

  /** Commits every change (tracked, untracked, deletions) in `dir`; returns the new commit or null when clean. */
  async snapshot(dir: string, message: string): Promise<string | null> {
    const status = await this.ok(dir, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!status) return null;
    await this.ok(dir, ["add", "-A"]);
    await this.ok(dir, [
      "-c",
      `user.name=${this.identity.name}`,
      "-c",
      `user.email=${this.identity.email}`,
      "commit",
      "--no-verify",
      "--quiet",
      "-m",
      message,
    ]);
    return this.ok(dir, ["rev-parse", "HEAD"]);
  }
}

function realpathNearest(p: string): string {
  const tail: string[] = [];
  let cur = p;
  while (!existsSync(cur) && dirname(cur) !== cur) {
    tail.unshift(basename(cur));
    cur = dirname(cur);
  }
  return join(realpathSync(cur), ...tail);
}

export interface WorktreeInfo {
  top: string;
  baseSha: string;
  branch: string;
  createdBranch: boolean;
}

/**
 * `git worktree add` for one cell. Reuses the branch when it already exists (a cell re-acquired after destroy or
 * hibernate continues its own work); otherwise branches from `baseRef`. The worktree must live outside the
 * repository's working tree so it never shows up as untracked files there.
 */
export async function addWorktree(
  git: Git,
  spec: { repoPath: string; path: string; branch: string; baseRef?: string | undefined; knownBaseSha?: string | null | undefined },
): Promise<WorktreeInfo> {
  const top = await git.toplevel(spec.repoPath);
  if (isInside(top, realpathNearest(spec.path))) {
    throw new NgError("invalid_argument", `worktree path ${spec.path} is inside the repository ${top}; configure a dataDir outside it`);
  }
  await git.checkBranchName(top, spec.branch);
  const baseSha = spec.knownBaseSha ?? (await git.resolveCommit(top, spec.baseRef ?? "HEAD"));
  const exists = await git.branchExists(top, spec.branch);

  if (existsSync(spec.path)) rmSync(spec.path, { recursive: true, force: true });
  await git.run(top, ["worktree", "prune"]);
  mkdirSync(dirname(spec.path), { recursive: true });
  if (exists) await git.ok(top, ["worktree", "add", "--quiet", spec.path, spec.branch]);
  else await git.ok(top, ["worktree", "add", "--quiet", "-b", spec.branch, spec.path, baseSha]);
  return { top, baseSha, branch: spec.branch, createdBranch: !exists };
}

/**
 * Removes a worktree without losing work: uncommitted changes become a snapshot commit on the cell branch, and a
 * HEAD that was moved off the branch (detached or another branch) with unmerged commits gets a backup branch.
 */
export async function retireWorktree(
  git: Git,
  ws: { top: string; path: string; branch: string },
  message: string,
): Promise<{ snapshot: string | null; backupBranch: string | null }> {
  let snapshot: string | null = null;
  let backupBranch: string | null = null;
  if (existsSync(ws.path)) {
    snapshot = await git.snapshot(ws.path, message);
    const head = (await git.run(ws.path, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.trim();
    if (head && (await git.branchExists(ws.top, ws.branch))) {
      const onBranch = (await git.run(ws.top, ["merge-base", "--is-ancestor", head, `refs/heads/${ws.branch}`])).code === 0;
      if (!onBranch) {
        backupBranch = `${ws.branch}-head-${head.slice(0, 8)}`;
        await git.run(ws.top, ["branch", "--force", "--", backupBranch, head]);
      }
    }
    const r = await git.run(ws.top, ["worktree", "remove", "--force", "--force", ws.path]);
    if (r.code !== 0) rmSync(ws.path, { recursive: true, force: true });
  }
  await git.run(ws.top, ["worktree", "prune"]);
  return { snapshot, backupBranch };
}
