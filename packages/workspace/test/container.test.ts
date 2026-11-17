import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isNgError, type JobResultPayload } from "@ng/protocol";
import { defaultCommandRunner, KILL_BY_MARKER_SCRIPT, type CommandRunner, type SpawnRequest } from "../src";
import { cleanupAll, git, harness, initRepo, waitFor } from "./helpers";

afterEach(() => {
  delete process.env.NG_SECRET_TEST_TOKEN;
  cleanupAll();
});

/**
 * The Docker daemon is not reachable in this environment, so the container driver is verified through an injected
 * runner: every `docker` invocation is recorded, `run`/`rm` are answered, and `exec` is emulated by running the
 * in-container argv on the host with the bind mounts translated (so bash, jobs and code_rpc really execute).
 */
class FakeDocker implements CommandRunner {
  calls: SpawnRequest[] = [];
  mounts: Array<{ source: string; target: string }> = [];
  runFails: string | null = null;

  docker(sub: string): SpawnRequest[] {
    return this.calls.filter((c) => c.file === "docker" && c.args[0] === sub);
  }

  #map(p: string): string {
    for (const m of this.mounts) if (p === m.target || p.startsWith(m.target + "/")) return m.source + p.slice(m.target.length);
    return p;
  }

  spawn(req: SpawnRequest): ChildProcess {
    if (req.file !== "docker") return defaultCommandRunner.spawn(req);
    this.calls.push(req);
    const [sub, ...rest] = req.args;
    const reply = (script: string) => spawn("/bin/sh", ["-c", script], { stdio: req.stdio ?? ["ignore", "pipe", "pipe"], detached: req.detached ?? false });
    if (sub === "run") {
      if (this.runFails) return reply(`echo '${this.runFails}' >&2; exit 125`);
      this.mounts = rest.filter((a) => a.startsWith("type=bind,")).map((a) => {
        const kv = Object.fromEntries(a.split(",").map((p) => p.split("=") as [string, string]));
        return { source: kv.source!, target: kv.target! };
      });
      return reply("echo 0123456789abcdef");
    }
    if (sub === "exec") {
      let i = 0;
      let workdir = "/";
      const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
      while (i < rest.length && rest[i]!.startsWith("--")) {
        const flag = rest[i]!;
        if (flag === "--workdir") workdir = rest[++i]!;
        else if (flag === "--env") {
          const kv = rest[++i]!;
          env[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
        }
        i++;
      }
      i++; // container id
      const argv = rest.slice(i).map((a) => this.#map(a));
      if (argv[0] === "node") argv[0] = process.execPath;
      if (argv.includes(KILL_BY_MARKER_SCRIPT)) {
        // Emulate the in-container kill on the host: signal processes carrying the marker.
        const [marker, sig] = argv.slice(-2);
        return spawn("/bin/sh", ["-c", KILL_BY_MARKER_SCRIPT, "ng-kill", marker!, sig!], { stdio: "ignore" });
      }
      return spawn(argv[0]!, argv.slice(1), {
        cwd: this.#map(workdir),
        env: { ...env, ...Object.fromEntries(Object.entries(req.env).filter(([k]) => k.startsWith("NG_"))) },
        stdio: req.stdio ?? ["ignore", "pipe", "pipe"],
        detached: req.detached ?? false,
      });
    }
    return reply("exit 0");
  }
}

const IMAGE = "ghcr.io/example/sandbox:1";

describe("container driver (command construction verified with a fake runner; no Docker daemon here)", () => {
  it("creates a locked-down container with the workspace bind-mounted and runs bash through docker exec", async () => {
    process.env.NG_SECRET_TEST_TOKEN = "s3cr3t";
    const fake = new FakeDocker();
    const h = harness({ runner: fake, container: { image: IMAGE } });
    const port = await h.mgr.acquire("w1", "container");

    const [rm, ...rest] = fake.calls;
    expect(rm!.args).toEqual(["rm", "--force", "ng-w1"]);
    const run = fake.docker("run")[0]!;
    expect(rest[0]).toBe(run);
    const a = run.args;
    const uid = `${process.getuid!()}:${process.getgid!()}`;
    expect(a.slice(0, 16)).toEqual([
      "run", "--detach", "--name", "ng-w1", "--label", "ng.cell=w1", "--network", "none", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--pids-limit", "512", "--init", "--user",
    ]);
    expect(a[16]).toBe(uid);
    expect(a).toContain("--read-only");
    expect(a).toContain(`type=bind,source=${port.root},target=/workspace`);
    expect(a.slice(-4)).toEqual(["--entrypoint", "sleep", IMAGE, "infinity"]);
    expect(h.mgr.getWorkspaceSync("w1")).toMatchObject({ isolation: "container", containerId: "0123456789abcdef", status: "active", branch: null });

    const r = await port.exec("bash", { command: "pwd; echo $HOME; env | grep -c SECRET || true", cwd: "." });
    expect(r).toEqual({ output: `${port.root}\n/tmp\n0\n`, exitCode: 0 });
    const exec = fake.docker("exec").at(-1)!;
    expect(exec.args.slice(0, 4)).toEqual(["exec", "--interactive", "--workdir", "/workspace"]);
    expect(exec.args).toContain("0123456789abcdef");
    expect(exec.args.slice(-3)).toEqual(["/bin/sh", "-c", "pwd; echo $HOME; env | grep -c SECRET || true"]);
    expect(exec.args.join(" ")).not.toContain("s3cr3t");
    expect(Object.values(exec.env).join(" ")).not.toContain("s3cr3t");
    expect(exec.args.find((x) => x.startsWith("--env") || x.startsWith("NG_EXEC_ID="))).toBeDefined();

    // Paths as the container sees them are accepted and mapped to the host side of the mount.
    await port.exec("write", { path: "/workspace/a.txt", content: "A" });
    expect(readFileSync(`${port.root}/a.txt`, "utf8")).toBe("A");
    await expect(port.exec("read", { op: "read_file", path: "/etc/passwd" })).rejects.toSatisfy((e) => isNgError(e, "bounds_violation"));
  });

  it("runs jobs inside the container with the exit file on the jobs mount, and cancels them inside the container", async () => {
    const fake = new FakeDocker();
    const h = harness({ runner: fake, container: { image: IMAGE } });
    const port = await h.mgr.acquire("w1", "container");
    const done = await port.startJob({ command: "echo in-container; exit 4" });
    const finished = await waitFor(() => (h.mgr.getJobSync(done.jobId)!.state !== "running" ? h.mgr.getJobSync(done.jobId) : undefined));
    expect(finished).toMatchObject({ state: "failed", exitCode: 4 });
    expect((h.inbox.list("w1")[0]!.payload as JobResultPayload).tail).toBe("in-container\n");
    const jobExec = fake.docker("exec").find((c) => c.args.includes(`NG_JOB_ID=${done.jobId}`))!;
    expect(jobExec.args).toContain(`/ng/jobs/${done.jobId}/exit`);
    expect(jobExec.detached).toBe(true);

    const long = await port.startJob({ command: "sleep 30" });
    await port.cancelJob(long.jobId);
    const kill = fake.docker("exec").find((c) => c.args.includes(KILL_BY_MARKER_SCRIPT))!;
    expect(kill.args).toEqual(["exec", "0123456789abcdef", "/bin/sh", "-c", KILL_BY_MARKER_SCRIPT, "ng-kill", `NG_JOB_ID=${long.jobId}`, "TERM"]);
    expect(h.mgr.getJobSync(long.jobId)!.state).toBe("cancelled");
  });

  it("code_rpc runs node inside the container", async () => {
    const fake = new FakeDocker();
    const h = harness({ runner: fake, container: { image: IMAGE, node: "node" } });
    const port = await h.mgr.acquire("w1", "container");
    const r = await port.exec("code_rpc", { code: 'console.log((await tools.bash("echo hi")).output.trim())' });
    expect(r).toEqual({ output: "hi\n", exitCode: 0 });
    const nodeExec = fake.docker("exec").find((c) => c.args.includes("--permission"))!;
    expect(nodeExec.args.slice(nodeExec.args.indexOf("0123456789abcdef") + 1, -1)).toEqual(["node", "--permission", "--input-type=module", "-e"]);
  });

  it("with a repository: works on a private clone, and destroy brings the branch back (snapshot taken inside the container)", async () => {
    const repo = initRepo();
    const fake = new FakeDocker();
    const h = harness({ runner: fake, container: { image: IMAGE }, defaultRepoPath: repo });
    const port = await h.mgr.acquire("w1", "container");
    expect(git(port.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ng/w1");
    expect(readFileSync(`${port.root}/.git/HEAD`, "utf8")).toContain("ng/w1"); // a real .git dir, not a worktree link
    await port.exec("write", { path: "feature.txt", content: "new\n" });

    await h.mgr.destroy("w1");
    const snap = fake.docker("exec").find((c) => c.args.includes("ng-snapshot"))!;
    expect(snap.args.slice(0, 4)).toEqual(["exec", "--workdir", "/workspace", "0123456789abcdef"]);
    expect(fake.docker("rm").at(-1)!.args).toEqual(["rm", "--force", "0123456789abcdef"]);
    expect(existsSync(port.root)).toBe(false);
    expect(git(repo, "show", "ng/w1:feature.txt")).toBe("new");
    expect(h.mgr.getWorkspaceSync("w1")).toMatchObject({ status: "destroyed", branch: "ng/w1", containerId: null });
  });

  it("a failing docker run is reported and leaves nothing behind", async () => {
    const fake = new FakeDocker();
    fake.runFails = "Cannot connect to the Docker daemon";
    const h = harness({ runner: fake, container: { image: IMAGE } });
    await expect(h.mgr.acquire("w1", "container")).rejects.toThrow(/docker run failed: Cannot connect to the Docker daemon/);
    expect(h.mgr.getWorkspaceSync("w1")).toMatchObject({ status: "failed" });
    expect(existsSync(`${h.dataDir}/containers/w1`)).toBe(false);
  });
});
