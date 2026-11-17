import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * git_worktree needs a base repository. When the owner configured none (research workers that only need a private
 * directory), the kernel keeps an empty repository with one empty commit at `<dir>` and branches every worktree
 * from it. Created on first use; git runs with a minimal environment and no hooks.
 */
export function scratchRepo(dir: string): () => Promise<string> {
  let pending: Promise<string> | null = null;
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  const git = (args: string[]) =>
    run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: dir, env, timeout: 60_000 });

  async function init(): Promise<string> {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, ".git"))) await git(["init", "-q", "-b", "main"]);
    const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"]).then(
      () => true,
      () => false,
    );
    if (!head) {
      await git(["-c", "user.name=ng-agents", "-c", "user.email=ng-agents@localhost", "commit", "--allow-empty", "-q", "-m", "ng-agents scratch base"]);
    }
    return realpathSync(dir);
  }

  return () => {
    pending ??= init().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}
