import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { NgError, type IsolationLevel, type WorkspaceAcquireOptions, type WorkspaceRecord } from "@ng/protocol";
import { addWorktree, retireWorktree } from "../git";
import type { SpawnRequest } from "../types";
import type { DriverDeps, IsolationDriver, ProcessRequest, Provisioned, ReleaseResult } from "./types";

function hostPlan(req: ProcessRequest): SpawnRequest {
  const [file, ...args] = req.argv;
  if (!file) throw new NgError("invalid_argument", "empty argv");
  return { file, args, cwd: req.cwd, env: { ...req.env, [req.marker.name]: req.marker.value }, detached: true };
}

/** A cell branch with commits beyond its base is kept so work is never silently lost; an untouched one is deleted. */
export async function keepBranchIfAhead(deps: DriverDeps, top: string, baseSha: string, branch: string): Promise<boolean> {
  if ((await deps.git.commitsAhead(top, baseSha, branch)) > 0) return true;
  await deps.git.deleteBranch(top, branch);
  return false;
}

function existingDir(path: string, what: string): string {
  const abs = resolve(path);
  let ok = false;
  try {
    ok = statSync(abs).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new NgError("invalid_argument", `${what} is not an existing directory: ${abs}`);
  return abs;
}

abstract class HostDriver implements IsolationDriver {
  abstract readonly level: IsolationLevel;
  abstract readonly readOnly: boolean;
  readonly confine: boolean = true;

  constructor(protected readonly deps: DriverDeps) {}

  aliases(): readonly string[] {
    return [];
  }
  shell(): string {
    return this.deps.hostShell;
  }
  node(): string {
    return this.deps.hostNode;
  }
  plan(_ws: WorkspaceRecord, req: ProcessRequest): SpawnRequest {
    return hostPlan(req);
  }
  toSandboxPath(_ws: WorkspaceRecord, hostPath: string): string {
    return hostPath;
  }
  abstract provision(cellId: string, opts: WorkspaceAcquireOptions, previous: WorkspaceRecord | undefined): Promise<Provisioned>;
  abstract release(ws: WorkspaceRecord, mode: "destroy" | "hibernate"): Promise<ReleaseResult>;
}

/**
 * No isolation (docs/05: the default): the cell's `cwd` on the owner's machine, used as it is. Paths may leave it. A
 * cell without a cwd gets the kernel's own per-cell directory under the data dir. Nothing is ever removed.
 */
export class NoneDriver extends HostDriver {
  readonly level = "none" as const;
  readonly readOnly = false;
  override readonly confine = false;

  async provision(cellId: string, opts: WorkspaceAcquireOptions): Promise<Provisioned> {
    const configured = opts.cwd ?? opts.repoPath ?? this.deps.defaultRepoPath;
    if (configured) return { path: existingDir(configured, "working directory"), baseRepo: null, baseRef: null, branch: null, containerId: null };
    const own = this.deps.cellDirOf(cellId);
    mkdirSync(own, { recursive: true });
    return { path: own, baseRepo: null, baseRef: null, branch: null, containerId: null };
  }

  async release(): Promise<ReleaseResult> {
    return { branchKept: false, snapshot: null, warnings: [] };
  }
}

/** Read and search only, on a shared directory. Enforced by the tool layer, not by the OS. */
export class SharedRoDriver extends HostDriver {
  readonly level = "shared_ro" as const;
  readonly readOnly = true;

  async provision(_cellId: string, opts: WorkspaceAcquireOptions): Promise<Provisioned> {
    const configured = opts.cwd ?? opts.repoPath ?? this.deps.defaultRepoPath;
    if (!configured) throw new NgError("invalid_argument", "shared_ro needs a directory: pass cwd or configure defaultRepoPath");
    const path = existingDir(configured, "shared directory");
    return { path, baseRepo: path, baseRef: null, branch: null, containerId: null };
  }

  async release(): Promise<ReleaseResult> {
    return { branchKept: false, snapshot: null, warnings: [] };
  }
}

/**
 * Explicit opt-in only (docs/05: the kernel never makes a worktree on its own): one `git worktree` per cell on its own
 * branch under `<dataDir>/worktrees/`. `release("destroy")` is no longer called by the kernel — closing a cell leaves
 * the worktree and its branch exactly as the cell left them; only `hibernate` (an explicit request) still packs it.
 */
export class GitWorktreeDriver extends HostDriver {
  readonly level = "git_worktree" as const;
  readonly readOnly = false;

  async provision(cellId: string, opts: WorkspaceAcquireOptions, previous: WorkspaceRecord | undefined): Promise<Provisioned> {
    const repo = opts.repoPath ?? previous?.baseRepo ?? this.deps.defaultRepoPath;
    if (!repo) {
      throw new NgError("invalid_argument", "git_worktree needs a repository: pass repoPath (spec.meta.workspace.repoPath) or configure defaultRepoPath");
    }
    const slug = this.deps.slugOf(cellId);
    const branch = opts.branch ?? previous?.branch ?? `ng/${slug}`;
    const path = join(this.deps.dataDir, "worktrees", slug);
    const knownBaseSha = previous && previous.branch === branch ? previous.baseRef : null;
    const info = await addWorktree(this.deps.git, { repoPath: repo, path, branch, baseRef: opts.baseRef, knownBaseSha });
    return { path, baseRepo: info.top, baseRef: info.baseSha, branch, containerId: null };
  }

  async release(ws: WorkspaceRecord, mode: "destroy" | "hibernate"): Promise<ReleaseResult> {
    if (!ws.baseRepo || !ws.branch || !ws.path || !ws.baseRef) return { branchKept: false, snapshot: null, warnings: ["incomplete workspace record"] };
    const git = this.deps.git;
    const message = mode === "hibernate" ? `ng: hibernate snapshot of cell ${ws.cellId}` : `ng: uncommitted work of cell ${ws.cellId} saved before workspace removal`;
    const { snapshot, backupBranch } = await retireWorktree(git, { top: ws.baseRepo, path: ws.path, branch: ws.branch }, message);
    const warnings = backupBranch ? [`HEAD had moved off ${ws.branch}; its commits are kept on ${backupBranch}`] : [];
    if (mode === "hibernate") return { branchKept: true, snapshot, warnings };
    return { branchKept: await keepBranchIfAhead(this.deps, ws.baseRepo, ws.baseRef, ws.branch), snapshot, warnings };
  }

  /** Brings a hibernated worktree back and turns the hibernate snapshot commit into uncommitted changes again. */
  async revive(ws: WorkspaceRecord, snapshotCommit: string | null): Promise<Provisioned> {
    const p = await this.provision(ws.cellId, {}, ws);
    if (snapshotCommit && existsSync(p.path)) {
      const head = (await this.deps.git.run(p.path, ["rev-parse", "HEAD"])).stdout.trim();
      if (head === snapshotCommit) await this.deps.git.ok(p.path, ["reset", "--quiet", "--mixed", "HEAD~1"]);
    }
    return p;
  }
}
