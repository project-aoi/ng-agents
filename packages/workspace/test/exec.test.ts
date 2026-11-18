import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isNgError } from "@ng/protocol";
import { cleanupAll, harness, initRepo, tempDir, waitFor } from "./helpers";

afterEach(() => {
  delete process.env.NG_SECRET_TEST_TOKEN;
  cleanupAll();
});

const escapes = (e: unknown) => isNgError(e, "bounds_violation");

describe("bash", () => {
  it("runs in the workspace root; a non-zero exit is a result, not an exception", async () => {
    const h = harness({ defaultRepoPath: initRepo() });
    const port = await h.mgr.acquire("w1", "git_worktree");
    expect(await port.exec("bash", { command: "pwd" })).toEqual({ output: `${port.root}\n`, exitCode: 0 });
    expect((await port.exec("bash", { command: "pwd", cwd: "src" })).output).toBe(`${port.root}/src\n`);
    expect(await port.exec("bash", { command: "echo oops >&2; exit 5" })).toEqual({ output: "oops\n", exitCode: 5 });
    await expect(port.exec("bash", { command: "pwd", cwd: "../" })).rejects.toSatisfy(escapes);
    await expect(port.exec("bash", { command: "" })).rejects.toSatisfy((e) => isNgError(e, "invalid_argument"));
  });

  it("isolation none is the owner's own environment (real HOME, PATH, git identity) minus the kernel's NG_* configuration and secrets", async () => {
    process.env.NG_SECRET_TEST_TOKEN = "s3cr3t-value-123";
    process.env.NGWS_TEST_OWNER_VAR = "owner-setting";
    const h = harness();
    const port = await h.mgr.acquire("w1", "none");
    const r = await port.exec("bash", { command: "env" });
    expect(r.output).not.toContain("s3cr3t-value-123");
    expect(r.output).not.toContain("NG_SECRET_TEST_TOKEN");
    const vars = Object.fromEntries(
      r.output
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    // docs/05: nothing is redirected — the owner's dotfiles, ssh keys and CLI logins are where the tools expect them.
    expect(vars.HOME).toBe(process.env.HOME ?? homedir());
    expect(vars.PATH).toBe(process.env.PATH);
    expect(vars.NGWS_TEST_OWNER_VAR).toBe("owner-setting");
    expect(Object.keys(vars).some((k) => k.startsWith("GIT_AUTHOR") || k.startsWith("GIT_COMMITTER"))).toBe(Boolean(process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_NAME));
    expect(Object.keys(vars).filter((k) => k.startsWith("NG_") && k !== "NG_EXEC_ID")).toEqual([]);
    delete process.env.NGWS_TEST_OWNER_VAR;
  });

  it("an explicitly isolated workspace still gets a private HOME, a neutral identity and only allow-listed variables", async () => {
    process.env.NG_SECRET_TEST_TOKEN = "s3cr3t-value-123";
    const repo = initRepo();
    const h = harness({ defaultRepoPath: repo });
    const port = await h.mgr.acquire("w1", "git_worktree");
    const r = await port.exec("bash", { command: "env" });
    expect(r.output).not.toContain("s3cr3t-value-123");
    const vars = Object.fromEntries(
      r.output
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(vars.HOME).not.toBe(homedir());
    expect(vars.HOME!.startsWith(h.dataDir)).toBe(true);
    const allowed = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "HOME", "TMPDIR", "NG_EXEC_ID", "PWD", "SHLVL", "_", "OLDPWD"]);
    for (const k of Object.keys(vars)) if (!k.startsWith("GIT_")) expect(allowed.has(k), `unexpected variable ${k}`).toBe(true);
  });

  it("times out, kills the process group and reports exit code 124", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1", "none");
    const t0 = performance.now();
    const r = await port.exec("bash", { command: "echo start; sleep 20; echo never", timeoutMs: 300 });
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(r.exitCode).toBe(124);
    expect(r.output).toContain("start");
    expect(r.output).not.toContain("never");
    expect(r.output).toContain("timed out after 300ms");
  });

  it("caps output, keeping the head and the tail", async () => {
    const h = harness({ limits: { maxOutputChars: 1000 } });
    const port = await h.mgr.acquire("w1", "none");
    const r = await port.exec("bash", { command: "seq 1 50000" });
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThan(1100);
    expect(r.output.startsWith("1\n2\n3\n")).toBe(true);
    expect(r.output.trimEnd().endsWith("49999\n50000")).toBe(true);
    expect(r.output).toMatch(/characters omitted/);
  });

  it("does not hang on background processes and has no stdin", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1", "none");
    const t0 = performance.now();
    const r = await port.exec("bash", { command: "sleep 30 & cat; echo started" });
    expect(r).toEqual({ output: "started\n", exitCode: 0 });
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("rejects on abort", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1", "none");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(port.exec("bash", { command: "sleep 20" }, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(port.exec("bash", { command: "true" }, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("read / write / edit", () => {
  it("reads files with offset/limit, lists directories, writes and edits", async () => {
    const h = harness({ defaultRepoPath: initRepo() });
    const port = await h.mgr.acquire("w1", "git_worktree");
    await port.exec("write", { path: "docs/a/b.txt", content: "l1\nl2\nl3\nl4\n" });
    expect((await port.exec("read", { op: "read_file", path: "docs/a/b.txt" })).output).toBe("l1\nl2\nl3\nl4\n");
    const slice = await port.exec("read", { op: "read_file", path: "docs/a/b.txt", offset: 1, limit: 2 });
    expect(slice.output).toBe("l2\nl3\n[... showing lines 2-3 of 4; read again with offset 3 for more]\n");
    expect(slice.truncated).toBe(true);

    expect((await port.exec("read", { op: "list_dir" })).output).toBe("README.md\ndocs/\nsrc/\n");
    expect((await port.exec("read", { op: "list_dir", path: "docs", depth: 3 })).output).toBe("a/\na/b.txt\n");

    await port.exec("edit", { path: "docs/a/b.txt", oldText: "l2", newText: "L2" });
    expect(readFileSync(join(port.root, "docs/a/b.txt"), "utf8")).toBe("l1\nL2\nl3\nl4\n");
    await expect(port.exec("edit", { path: "docs/a/b.txt", oldText: "missing", newText: "x" })).rejects.toThrow(/not found/);
    await port.exec("write", { path: "dup.txt", content: "x y x" });
    await expect(port.exec("edit", { path: "dup.txt", oldText: "x", newText: "z" })).rejects.toThrow(/occurs 2 times/);
    await port.exec("edit", { path: "dup.txt", oldText: "x", newText: "$&z", replaceAll: true });
    expect(readFileSync(join(port.root, "dup.txt"), "utf8")).toBe("$&z y $&z");

    await expect(port.exec("read", { op: "read_file", path: "nope.txt" })).rejects.toSatisfy((e) => isNgError(e, "not_found"));
    await expect(port.exec("read", { op: "bogus" })).rejects.toSatisfy((e) => isNgError(e, "invalid_argument"));
    writeFileSync(join(port.root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    expect((await port.exec("read", { op: "read_file", path: "bin.dat" })).output).toMatch(/binary file/);
  });

  it("rejects path escapes through .., absolute paths and symlinks, but allows symlinks that stay inside", async () => {
    const outside = tempDir("outside");
    writeFileSync(join(outside, "secret.txt"), "top secret\n");
    const h = harness({ defaultRepoPath: initRepo() });
    const port = await h.mgr.acquire("w1", "git_worktree");
    const root = port.root;
    symlinkSync(join(outside, "secret.txt"), join(root, "link-file"));
    symlinkSync(outside, join(root, "link-dir"));
    symlinkSync(join(outside, "does-not-exist"), join(root, "dangling"));
    symlinkSync(join(root, "README.md"), join(root, "inside-link"));

    for (const path of ["../x", "src/../../x", "/etc/passwd", join(outside, "secret.txt"), "link-file", "link-dir/secret.txt"]) {
      await expect(port.exec("read", { op: "read_file", path }), path).rejects.toSatisfy(escapes);
    }
    await expect(port.exec("write", { path: "link-dir/new.txt", content: "x" })).rejects.toSatisfy(escapes);
    await expect(port.exec("write", { path: "link-file", content: "x" })).rejects.toSatisfy(escapes);
    await expect(port.exec("write", { path: "dangling", content: "x" })).rejects.toSatisfy(escapes);
    await expect(port.exec("edit", { path: "link-file", oldText: "top", newText: "no" })).rejects.toSatisfy(escapes);
    await expect(port.exec("read", { op: "list_dir", path: "link-dir" })).rejects.toSatisfy(escapes);
    await expect(port.exec("read", { op: "search", pattern: "secret", path: "../" })).rejects.toSatisfy(escapes);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("top secret\n");

    expect((await port.exec("read", { op: "read_file", path: "inside-link" })).output).toBe("hello\n");
    expect((await port.exec("read", { op: "read_file", path: join(root, "README.md") })).output).toBe("hello\n");
  });
});

describe("isolation levels", () => {
  it("shared_ro allows read and search only", async () => {
    const shared = tempDir("shared");
    writeFileSync(join(shared, "notes.md"), "项目进度：完成\n");
    const h = harness({ defaultRepoPath: shared });
    const port = await h.mgr.acquire("w1", "shared_ro");
    expect(port.root).toBe(shared);
    expect((await port.exec("read", { op: "read_file", path: "notes.md" })).output).toBe("项目进度：完成\n");
    expect((await port.exec("read", { op: "search", pattern: "项目进度" })).output).toBe("notes.md:1:项目进度：完成\n");
    await expect(port.exec("write", { path: "x.txt", content: "x" })).rejects.toSatisfy(escapes);
    await expect(port.exec("edit", { path: "notes.md", oldText: "完成", newText: "x" })).rejects.toSatisfy(escapes);
    await expect(port.exec("bash", { command: "touch x" })).rejects.toSatisfy(escapes);
    await expect(port.startJob({ command: "touch x" })).rejects.toSatisfy(escapes);
    expect(readFileSync(join(shared, "notes.md"), "utf8")).toBe("项目进度：完成\n");
    await h.mgr.destroy("w1");
    expect(readFileSync(join(shared, "notes.md"), "utf8")).toBe("项目进度：完成\n");
  });

  it("none works in the cell's cwd without confinement; nothing on disk is removed when the runtime is stopped", async () => {
    const dir = tempDir("plain");
    const elsewhere = tempDir("elsewhere");
    writeFileSync(join(elsewhere, "x.txt"), "outside\n");
    const h = harness();
    const port = await h.mgr.acquire("w1", "none", { cwd: dir });
    expect(port.root).toBe(dir);
    expect((await port.exec("read", { op: "read_file", path: join(elsewhere, "x.txt") })).output).toBe("outside\n");
    await port.exec("write", { path: "made-by-cell.txt", content: "keep me\n" });
    await h.mgr.stopRuntime("w1");
    expect(readFileSync(join(dir, "made-by-cell.txt"), "utf8")).toBe("keep me\n");
    expect(readFileSync(join(elsewhere, "x.txt"), "utf8")).toBe("outside\n");
    // The same cell, re-acquired, is back in the same directory with its file.
    expect((await (await h.mgr.acquire("w1", "none", { cwd: dir })).exec("read", { op: "read_file", path: "made-by-cell.txt" })).output).toBe("keep me\n");

    // No cwd: the kernel's own per-cell directory under the data dir — also never removed.
    const own = await h.mgr.acquire("w2", "none");
    expect(own.root).toBe(join(h.dataDir, "cells", "w2"));
    await own.exec("write", { path: "tmp.txt", content: "t" });
    await h.mgr.stopRuntime("w2");
    expect((await (await h.mgr.acquire("w2", "none")).exec("read", { op: "read_file", path: "tmp.txt" })).output.trim()).toBe("t");
    await expect(h.mgr.acquire("w2", "none", { cwd: join(dir, "missing") })).rejects.toSatisfy((e) => isNgError(e, "invalid_argument"));
  });

  it("cwdMode read is only a scheduling declaration: the port reads, searches, writes, edits, runs bash and starts jobs", async () => {
    const dir = tempDir("ro");
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    const h = harness();
    const port = await h.mgr.acquire("w1", "none", { cwd: dir, cwdMode: "read" });
    expect(port.root).toBe(dir);
    expect((await port.exec("read", { op: "read_file", path: "a.txt" })).output).toBe("alpha\n");
    expect((await port.exec("read", { op: "search", pattern: "alpha" })).output).toBe("a.txt:1:alpha\n");
    // Nothing is refused: the port does not police a read cell (only shared_ro is a read-only workspace).
    await port.exec("write", { path: "b.txt", content: "x" });
    await port.exec("edit", { path: "a.txt", oldText: "alpha", newText: "beta" });
    expect(await port.exec("bash", { command: "touch c.txt" })).toMatchObject({ exitCode: 0 });
    const { jobId } = await port.startJob({ command: "touch d.txt" });
    await waitFor(() => {
      const j = h.mgr.getJobSync(jobId);
      return j && j.state !== "running" ? j : undefined;
    });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("beta\n");
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("x");
    expect(existsSync(join(dir, "c.txt"))).toBe(true);
    expect(existsSync(join(dir, "d.txt"))).toBe(true);
    // Re-acquired with cwdMode "write", the same cell keeps the same directory and behaves the same.
    const rw = await h.mgr.acquire("w1", "none", { cwd: dir, cwdMode: "write" });
    expect(rw.root).toBe(dir);
    await rw.exec("write", { path: "e.txt", content: "y" });
    expect(readFileSync(join(dir, "e.txt"), "utf8")).toBe("y");
  });

  it("cow_microvm and an unconfigured container are refused with a clear error", async () => {
    const h = harness();
    await expect(h.mgr.acquire("w1", "cow_microvm")).rejects.toThrow(/cow_microvm" is not available/);
    await expect(h.mgr.acquire("w1", "container")).rejects.toThrow(/container isolation is not configured/);
    expect(h.mgr.getWorkspaceSync("w1")).toMatchObject({ status: "failed" });
  });
});
