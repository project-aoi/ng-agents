import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isNgError } from "@ng/protocol";
import { cleanupAll, harness, initRepo, tempDir } from "./helpers";

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

  it("does not inherit host environment variables or secrets, and gets its own HOME", async () => {
    process.env.NG_SECRET_TEST_TOKEN = "s3cr3t-value-123";
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
    expect(vars.HOME).not.toBe(homedir());
    expect(vars.HOME!.startsWith(h.dataDir)).toBe(true);
    expect(vars.PATH).toBe(process.env.PATH);
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

  it("none uses the configured directory without confinement and never deletes it; without one it uses a scratch dir", async () => {
    const dir = tempDir("plain");
    const elsewhere = tempDir("elsewhere");
    writeFileSync(join(elsewhere, "x.txt"), "outside\n");
    const h = harness();
    const port = await h.mgr.acquire("w1", "none", { repoPath: dir });
    expect(port.root).toBe(dir);
    expect((await port.exec("read", { op: "read_file", path: join(elsewhere, "x.txt") })).output).toBe("outside\n");
    await h.mgr.destroy("w1");
    expect(readFileSync(join(elsewhere, "x.txt"), "utf8")).toBe("outside\n");
    mkdirSync(join(dir, "still-here"));

    const scratch = await h.mgr.acquire("w2", "none");
    expect(scratch.root.startsWith(join(h.dataDir, "scratch"))).toBe(true);
    await scratch.exec("write", { path: "tmp.txt", content: "t" });
    await h.mgr.destroy("w2");
    await expect(h.mgr.acquire("w2", "none").then((p) => p.exec("read", { op: "read_file", path: "tmp.txt" }))).rejects.toSatisfy((e) =>
      isNgError(e, "not_found"),
    );
  });

  it("cow_microvm and an unconfigured container are refused with a clear error", async () => {
    const h = harness();
    await expect(h.mgr.acquire("w1", "cow_microvm")).rejects.toThrow(/cow_microvm" is not available/);
    await expect(h.mgr.acquire("w1", "container")).rejects.toThrow(/container isolation is not configured/);
    expect(h.mgr.getWorkspaceSync("w1")).toMatchObject({ status: "failed" });
  });
});
