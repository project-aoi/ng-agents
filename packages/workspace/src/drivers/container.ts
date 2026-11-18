import { mkdirSync, rmSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { NgError, type WorkspaceAcquireOptions, type WorkspaceRecord } from "@ng/protocol";
import { runCapture } from "../exec/process";
import type { ContainerOptions, SpawnRequest } from "../types";
import { isInside } from "../util";
import { keepBranchIfAhead } from "./host";
import type { DriverDeps, IsolationDriver, Marker, ProcessRequest, Provisioned, ReleaseResult } from "./types";

const CLI_ENV_KEYS = ["PATH", "HOME", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];

/** Signals every process in the container whose environment carries the marker ($1 = NAME=value, $2 = signal). */
export const KILL_BY_MARKER_SCRIPT =
  'for d in /proc/[0-9]*; do if tr "\\000" "\\n" < "$d/environ" 2>/dev/null | grep -qxF "$1"; then kill -s "$2" "${d#/proc/}" 2>/dev/null; fi; done; exit 0';

const SNAPSHOT_SCRIPT =
  'if [ -n "$(git status --porcelain --untracked-files=all 2>/dev/null)" ]; then git add -A && git -c user.name="$1" -c user.email="$2" -c core.hooksPath=/dev/null commit --no-verify -q -m "$3" && echo snapshot; fi';

/**
 * Docker-backed isolation through the docker CLI. The host directory (a private clone of the base repository on
 * the cell branch, or an empty scratch directory) is bind-mounted at `mountPath`; file tools still operate on the
 * host side of that mount, every process runs through `docker exec`. A clone (not a worktree) is used because a
 * worktree's `.git` points into the base repository, which would have to be mounted writable and would let the
 * container plant hooks/config that the host later executes.
 */
export class ContainerDriver implements IsolationDriver {
  readonly level = "container" as const;
  readonly readOnly = false;
  readonly confine = true;

  constructor(
    private readonly deps: DriverDeps,
    private readonly options: ContainerOptions | undefined,
  ) {}

  private get o(): ContainerOptions {
    if (!this.options?.image) {
      throw new NgError("unsupported", 'container isolation is not configured (WorkspaceManagerOptions.container.image is required)');
    }
    return this.options;
  }

  private get mount(): string {
    return this.options?.mountPath ?? "/workspace";
  }
  private get jobsMount(): string {
    return this.options?.jobsMountPath ?? "/ng/jobs";
  }
  private get dockerBin(): string {
    return this.options?.docker ?? "docker";
  }

  aliases(): readonly string[] {
    return [this.mount];
  }
  shell(): string {
    return this.options?.shell ?? "/bin/sh";
  }
  node(): string {
    return this.options?.node ?? "node";
  }

  containerName(cellId: string): string {
    return `ng-${this.deps.slugOf(cellId)}`;
  }

  private containerEnv(): Record<string, string> {
    const id = this.deps.git.identity;
    return {
      HOME: "/tmp",
      GIT_AUTHOR_NAME: id.name,
      GIT_AUTHOR_EMAIL: id.email,
      GIT_COMMITTER_NAME: id.name,
      GIT_COMMITTER_EMAIL: id.email,
      ...this.options?.env,
    };
  }

  private cliEnv(): Record<string, string> {
    if (this.options?.cliEnv) return { ...this.options.cliEnv };
    const env: Record<string, string> = {};
    for (const k of CLI_ENV_KEYS) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    return env;
  }

  private docker(args: readonly string[], timeoutMs = 120_000) {
    return runCapture(this.deps.runner, { file: this.dockerBin, args, cwd: this.deps.dataDir, env: this.cliEnv() }, { timeoutMs });
  }

  runArgs(cellId: string, hostDir: string, jobsDir: string): string[] {
    const o = this.o;
    for (const p of [hostDir, jobsDir]) if (p.includes(",")) throw new NgError("invalid_argument", `bind mount path may not contain ",": ${p}`);
    const user = o.user ?? (typeof process.getuid === "function" && typeof process.getgid === "function" ? `${process.getuid()}:${process.getgid()}` : undefined);
    const args = [
      "run",
      "--detach",
      "--name",
      this.containerName(cellId),
      "--label",
      `ng.cell=${cellId}`,
      "--network",
      o.network ?? "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(o.pidsLimit ?? 512),
      "--init",
    ];
    if (user) args.push("--user", user);
    if (o.readOnlyRootfs !== false) args.push("--read-only", "--tmpfs", "/tmp:rw,mode=1777");
    if (o.memory) args.push("--memory", o.memory);
    if (o.cpus) args.push("--cpus", o.cpus);
    args.push(
      "--mount",
      `type=bind,source=${hostDir},target=${this.mount}`,
      "--mount",
      `type=bind,source=${jobsDir},target=${this.jobsMount}`,
      "--workdir",
      this.mount,
      ...(o.extraRunArgs ?? []),
      "--entrypoint",
      "sleep",
      o.image,
      "infinity",
    );
    return args;
  }

  async provision(cellId: string, opts: WorkspaceAcquireOptions, previous: WorkspaceRecord | undefined): Promise<Provisioned> {
    void this.o;
    const slug = this.deps.slugOf(cellId);
    const dir = join(this.deps.dataDir, "containers", slug);
    const repo = opts.repoPath ?? previous?.baseRepo ?? this.deps.defaultRepoPath;
    const git = this.deps.git;
    // A stale container of this cell (crash, failed destroy) still has the directory mounted; remove it first.
    await this.docker(["rm", "--force", this.containerName(cellId)]);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(this.deps.dataDir, "containers"), { recursive: true });

    let p: Provisioned;
    if (repo) {
      const top = await git.toplevel(repo);
      if (isInside(top, dir)) throw new NgError("invalid_argument", `container directory ${dir} is inside the repository ${top}`);
      const branch = opts.branch ?? previous?.branch ?? `ng/${slug}`;
      await git.checkBranchName(top, branch);
      const exists = await git.branchExists(top, branch);
      const baseSha = previous && previous.branch === branch && previous.baseRef ? previous.baseRef : await git.resolveCommit(top, opts.baseRef ?? "HEAD");
      await git.ok(this.deps.dataDir, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", top, dir]);
      if (exists) await git.ok(dir, ["checkout", "--quiet", "-B", branch, `refs/remotes/origin/${branch}`]);
      else await git.ok(dir, ["checkout", "--quiet", "-b", branch, baseSha]);
      p = { path: dir, baseRepo: top, baseRef: baseSha, branch, containerId: null };
    } else {
      mkdirSync(dir, { recursive: true });
      p = { path: dir, baseRepo: null, baseRef: null, branch: null, containerId: null };
    }

    const jobsDir = this.deps.jobsDirOf(cellId);
    mkdirSync(jobsDir, { recursive: true });
    const r = await this.docker(this.runArgs(cellId, dir, jobsDir));
    const id = r.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (r.error || r.code !== 0 || !id) {
      rmSync(dir, { recursive: true, force: true });
      throw new NgError("unsupported", `docker run failed: ${(r.error?.message ?? r.stderr).trim() || `exit ${r.code}`}`);
    }
    return { ...p, containerId: id };
  }

  toSandboxPath(ws: WorkspaceRecord, hostPath: string): string {
    if (ws.path && isInside(ws.path, hostPath)) return posix.join(this.mount, relative(ws.path, hostPath).split("\\").join("/"));
    const jobsDir = this.deps.jobsDirOf(ws.cellId);
    if (isInside(jobsDir, hostPath)) return posix.join(this.jobsMount, relative(jobsDir, hostPath).split("\\").join("/"));
    throw new NgError("invalid_argument", `${hostPath} is not visible inside the container`);
  }

  plan(ws: WorkspaceRecord, req: ProcessRequest): SpawnRequest {
    if (!ws.containerId) throw new NgError("conflict", `workspace of ${ws.cellId} has no container`);
    const args = ["exec", "--interactive", "--workdir", this.toSandboxPath(ws, req.cwd)];
    for (const [k, v] of Object.entries(this.containerEnv())) args.push("--env", `${k}=${v}`);
    args.push("--env", `${req.marker.name}=${req.marker.value}`, ws.containerId, ...req.argv);
    return {
      file: this.dockerBin,
      args,
      cwd: ws.path ?? this.deps.dataDir,
      env: { ...this.cliEnv(), [req.marker.name]: req.marker.value },
      detached: true,
    };
  }

  async killInside(ws: WorkspaceRecord, marker: Marker, sig: "TERM" | "KILL"): Promise<void> {
    if (!ws.containerId) return;
    await this.docker(["exec", ws.containerId, "/bin/sh", "-c", KILL_BY_MARKER_SCRIPT, "ng-kill", `${marker.name}=${marker.value}`, sig], 30_000);
  }

  /** docs/05 guard 4: stop the long-running container; the clone directory and its branch stay where they are. */
  async stopRuntime(ws: WorkspaceRecord): Promise<string[]> {
    if (!ws.containerId) return [];
    const r = await this.docker(["rm", "--force", ws.containerId]);
    return r.code !== 0 ? [`docker rm failed: ${(r.error?.message ?? r.stderr).trim()}`] : [];
  }

  async release(ws: WorkspaceRecord, mode: "destroy" | "hibernate"): Promise<ReleaseResult> {
    if (mode === "hibernate") throw new NgError("unsupported", "hibernate is implemented for git_worktree only");
    const warnings: string[] = [];
    let snapshot: string | null = null;
    const git = this.deps.git;
    const id = git.identity;

    // The snapshot commit runs inside the container: git filters/config in the clone are container-controlled.
    if (ws.containerId && ws.baseRepo && ws.branch) {
      const r = await this.docker(
        ["exec", "--workdir", this.mount, ws.containerId, "/bin/sh", "-c", SNAPSHOT_SCRIPT, "ng-snapshot", id.name, id.email, `ng: uncommitted work of cell ${ws.cellId} saved before workspace removal`],
        120_000,
      );
      if (r.code !== 0) warnings.push(`snapshot inside the container failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
      else if (r.stdout.includes("snapshot")) snapshot = "container";
    }
    if (ws.containerId) {
      const r = await this.docker(["rm", "--force", ws.containerId]);
      if (r.code !== 0) warnings.push(`docker rm failed: ${(r.error?.message ?? r.stderr).trim()}`);
    }

    let branchKept = false;
    if (ws.baseRepo && ws.branch && ws.baseRef && ws.path) {
      // Fetching (upload-pack on the clone) is the only git operation the host runs against the container-written repo.
      const f = await git.run(ws.baseRepo, ["fetch", "--quiet", "--no-tags", "--", ws.path, `+refs/heads/${ws.branch}:refs/heads/${ws.branch}`]);
      if (f.code !== 0) warnings.push(`could not fetch ${ws.branch} back from the container clone: ${f.stderr.trim()}`);
      branchKept = await keepBranchIfAhead(this.deps, ws.baseRepo, ws.baseRef, ws.branch);
      // A failed fetch must not leave the directory holding the only copy of the work behind.
      if (f.code !== 0) return { branchKept, snapshot, warnings };
    }
    if (ws.path && isInside(join(this.deps.dataDir, "containers"), ws.path)) rmSync(ws.path, { recursive: true, force: true });
    return { branchKept, snapshot, warnings };
  }
}

export const COW_MICROVM_UNAVAILABLE =
  'isolation driver "cow_microvm" is not available in this build: no microVM backend is implemented. Use "container" or "git_worktree".';

/** Selecting it fails loudly instead of silently degrading to weaker isolation. */
export class CowMicrovmDriver implements IsolationDriver {
  readonly level = "cow_microvm" as const;
  readonly readOnly = false;
  readonly confine = true;

  private fail(): never {
    throw new NgError("unsupported", COW_MICROVM_UNAVAILABLE);
  }
  aliases(): readonly string[] {
    return [];
  }
  provision(): Promise<Provisioned> {
    return Promise.reject(new NgError("unsupported", COW_MICROVM_UNAVAILABLE));
  }
  shell(): string {
    return this.fail();
  }
  node(): string {
    return this.fail();
  }
  plan(): SpawnRequest {
    return this.fail();
  }
  toSandboxPath(): string {
    return this.fail();
  }
  release(): Promise<ReleaseResult> {
    return Promise.resolve({ branchKept: false, snapshot: null, warnings: [] });
  }
}
