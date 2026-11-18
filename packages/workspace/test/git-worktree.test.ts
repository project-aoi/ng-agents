import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isNgError } from "@ng/protocol";
import { cleanupAll, git, harness, initRepo } from "./helpers";

afterEach(cleanupAll);

describe("git_worktree isolation", () => {
  it("gives two cells separate worktrees on separate branches that do not see each other's edits", async () => {
    const repo = initRepo();
    const h = harness({ defaultRepoPath: repo });
    const a = await h.mgr.acquire("w1", "git_worktree");
    const b = await h.mgr.acquire("w2", "git_worktree");

    expect(a.root).not.toBe(b.root);
    expect(a.root.startsWith(h.dataDir)).toBe(true);
    expect(a.root.startsWith(repo)).toBe(false);
    expect(git(a.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ng/w1");
    expect(git(b.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ng/w2");

    await a.exec("edit", { path: "src/app.ts", oldText: "42", newText: "43" });
    await a.exec("write", { path: "only-a.txt", content: "a\n" });
    await b.exec("write", { path: "src/app.ts", content: "export const answer = 0;\n" });

    expect(readFileSync(join(a.root, "src/app.ts"), "utf8")).toBe("export const answer = 43;\n");
    expect(readFileSync(join(b.root, "src/app.ts"), "utf8")).toBe("export const answer = 0;\n");
    expect(existsSync(join(b.root, "only-a.txt"))).toBe(false);
    // The base repository's working tree is untouched by either cell.
    expect(readFileSync(join(repo, "src/app.ts"), "utf8")).toBe("export const answer = 42;\n");
    expect(git(repo, "status", "--porcelain")).toBe("");

    const viaBash = await b.exec("bash", { command: "cat src/app.ts; test -e only-a.txt && echo present || echo absent" });
    expect(viaBash.output).toContain("answer = 0");
    expect(viaBash.output).toContain("absent");

    const rec = h.mgr.getWorkspaceSync("w1")!;
    expect(rec).toMatchObject({ isolation: "git_worktree", status: "active", branch: "ng/w1", baseRepo: repo, path: a.root });
    expect(rec.baseRef).toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("acquire is idempotent for the same cell and refuses a different isolation", async () => {
    const repo = initRepo();
    const h = harness({ defaultRepoPath: repo });
    const a1 = await h.mgr.acquire("w1", "git_worktree");
    const a2 = await h.mgr.acquire("w1", "git_worktree");
    expect(a2.root).toBe(a1.root);
    await expect(h.mgr.acquire("w1", "none")).rejects.toSatisfy((e) => isNgError(e, "conflict"));
    await expect(h.mgr.acquire("nope", "git_worktree")).rejects.toSatisfy((e) => isNgError(e, "not_found"));
  });

  it("requires a repository and records the failure", async () => {
    const h = harness();
    await expect(h.mgr.acquire("w1", "git_worktree")).rejects.toSatisfy((e) => isNgError(e, "invalid_argument"));
    expect(h.mgr.getWorkspaceSync("w1")).toMatchObject({ status: "failed" });
    expect(h.mgr.getWorkspaceSync("w1")!.error).toMatch(/needs a repository/);
  });

  it("stopping the runtime leaves an explicit worktree, its branch and its uncommitted work exactly as they are", async () => {
    const repo = initRepo();
    const h = harness({ defaultRepoPath: repo });
    const a = await h.mgr.acquire("w1", "git_worktree");
    await a.exec("bash", { command: "echo fix > fix.txt && git add fix.txt && git commit -qm 'fix bug'" });
    await a.exec("write", { path: "draft.md", content: "unfinished\n" });
    const head = git(a.root, "rev-parse", "HEAD");

    await h.mgr.stopRuntime("w1");
    await h.mgr.destroy("w1"); // the deprecated name does the same and no more
    expect(existsSync(a.root)).toBe(true);
    expect(git(repo, "worktree", "list")).toContain(a.root);
    expect(git(repo, "branch", "--list", "ng/w1")).toContain("ng/w1");
    // No snapshot commit was made on the cell's behalf: HEAD is where the cell left it and the draft is still uncommitted.
    expect(git(a.root, "rev-parse", "HEAD")).toBe(head);
    expect(git(a.root, "status", "--porcelain")).toBe("?? draft.md");
    expect(h.mgr.getWorkspaceSync("w1")).toMatchObject({ status: "active", branch: "ng/w1" });

    const again = await h.mgr.acquire("w1", "git_worktree");
    expect(again.root).toBe(a.root);
    expect(readFileSync(join(again.root, "draft.md"), "utf8")).toBe("unfinished\n");
  });

  it("hibernate removes the worktree but keeps the work; restore brings uncommitted changes back uncommitted", async () => {
    const repo = initRepo();
    const h = harness({ defaultRepoPath: repo });
    const a = await h.mgr.acquire("w1", "git_worktree");
    await a.exec("write", { path: "notes.txt", content: "half done\n" });
    await a.exec("edit", { path: "README.md", oldText: "hello", newText: "hello world" });

    const snap = await h.mgr.hibernate("w1");
    expect(existsSync(a.root)).toBe(false);
    expect(h.mgr.getWorkspaceSync("w1")).toMatchObject({ status: "hibernated", snapshotId: snap });

    const back = await h.mgr.restore(snap);
    expect(readFileSync(join(back.root, "notes.txt"), "utf8")).toBe("half done\n");
    const status = git(back.root, "status", "--porcelain");
    expect(status).toContain("?? notes.txt");
    expect(status).toMatch(/^ ?M README\.md$/m);
    expect(git(back.root, "log", "--format=%s")).not.toMatch(/hibernate snapshot/);
    expect(h.mgr.getWorkspaceSync("w1")).toMatchObject({ status: "active", snapshotId: null });
    await expect(h.mgr.restore(snap)).rejects.toSatisfy((e) => isNgError(e, "not_found"));
  });

  it("hibernate is refused for non-worktree workspaces", async () => {
    const h = harness();
    await h.mgr.acquire("w1", "none");
    await expect(h.mgr.hibernate("w1")).rejects.toSatisfy((e) => isNgError(e, "unsupported"));
  });

  it("refuses a dataDir inside the base repository", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, ".gitignore"), "data/\n");
    const h = harness({ defaultRepoPath: repo, dataDir: join(repo, "data") });
    await expect(h.mgr.acquire("w1", "git_worktree")).rejects.toThrow(/inside the repository/);
  });
});
