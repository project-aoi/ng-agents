import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { isNgError } from "@ng/protocol";
import { cleanupAll, harness, initRepo } from "./helpers";

afterEach(() => {
  delete process.env.NG_SECRET_TEST_TOKEN;
  cleanupAll();
});


describe("bash", () => {
  it("runs in the workspace root; a non-zero exit is a result, not an exception", async () => {
    const h = harness({ defaultRepoPath: initRepo() });
    const port = await h.mgr.acquire("w1");
    expect(await port.exec("bash", { command: "pwd" })).toEqual({ output: `${port.root}\n`, exitCode: 0 });
    expect((await port.exec("bash", { command: "pwd", cwd: "src" })).output).toBe(`${port.root}/src\n`);
    expect(await port.exec("bash", { command: "echo oops >&2; exit 5" })).toEqual({ output: "oops\n", exitCode: 5 });
    await expect(port.exec("bash", { command: "" })).rejects.toSatisfy((e) => isNgError(e, "invalid_argument"));
  });

  it("isolation none is the owner's own environment (real HOME, PATH, git identity) minus the kernel's NG_* configuration and secrets", async () => {
    process.env.NG_SECRET_TEST_TOKEN = "s3cr3t-value-123";
    process.env.NGWS_TEST_OWNER_VAR = "owner-setting";
    const h = harness();
    const port = await h.mgr.acquire("w1");
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


  it("times out, kills the process group and reports exit code 124", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
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
    const port = await h.mgr.acquire("w1");
    const r = await port.exec("bash", { command: "seq 1 50000" });
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThan(1100);
    expect(r.output.startsWith("1\n2\n3\n")).toBe(true);
    expect(r.output.trimEnd().endsWith("49999\n50000")).toBe(true);
    expect(r.output).toMatch(/characters omitted/);
  });

  it("does not hang on background processes and has no stdin", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const t0 = performance.now();
    const r = await port.exec("bash", { command: "sleep 30 & cat; echo started" });
    expect(r).toEqual({ output: "started\n", exitCode: 0 });
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("rejects on abort", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(port.exec("bash", { command: "sleep 20" }, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(port.exec("bash", { command: "true" }, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
