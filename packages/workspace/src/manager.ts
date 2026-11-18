import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  cellsRepo,
  ISOLATION_LEVELS,
  newId,
  NgError,
  systemClock,
  type IsolationLevel,
  type WorkspaceAcquireOptions,
  type WorkspaceRecord,
} from "@ng/protocol";
import { ContainerDriver, COW_MICROVM_UNAVAILABLE, CowMicrovmDriver } from "./drivers/container";
import { GitWorktreeDriver, NoneDriver, SharedRoDriver } from "./drivers/host";
import type { DriverDeps, IsolationDriver, Provisioned } from "./drivers/types";
import { DEFAULT_ENV_ALLOWLIST, defaultCommandRunner, pickHostEnv } from "./exec/process";
import { detectRipgrep } from "./exec/search";
import { Git } from "./git";
import { JobManager } from "./jobs";
import { createPort } from "./port";
import { WorkspaceStore } from "./store";
import type { ManagedWorkspacePort, WorkspaceLimits, WorkspaceManager, WorkspaceManagerOptions } from "./types";
import { errorMessage, KeyedMutex, slugify } from "./util";

export const DEFAULT_LIMITS: WorkspaceLimits = {
  bashTimeoutMs: 120_000,
  maxBashTimeoutMs: 600_000,
  maxOutputChars: 50_000,
  readMaxLines: 2000,
  readMaxChars: 200_000,
  listMaxEntries: 1000,
  searchMaxResults: 200,
  codeRpcTimeoutMs: 120_000,
  codeRpcMaxCalls: 500,
  httpTimeoutMs: 30_000,
  httpMaxResponseChars: 200_000,
  jobTailChars: 4000,
  jobResultTailChars: 2000,
  storedLogMaxChars: 1_000_000,
  killGraceMs: 3000,
  maxJobsPerCell: 8,
  jobPollMs: 1000,
  previewPollMs: 250,
};

const DEFAULT_IDENTITY = { name: "ng-agents", email: "ng-agents@localhost" };

/** Separates the snapshot commit (or "clean") from the unique part of a hibernate snapshot id. */
const SNAPSHOT_SEP = ".";

export function createWorkspaceManager(opts: WorkspaceManagerOptions): WorkspaceManager {
  const clock = opts.clock ?? systemClock;
  mkdirSync(resolve(opts.dataDir), { recursive: true });
  // Real path: workspace roots are compared against realpath()-resolved tool paths (and mapped into containers).
  const dataDir = realpathSync(resolve(opts.dataDir));
  const limits: WorkspaceLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const runner = opts.runner ?? defaultCommandRunner;
  const store = new WorkspaceStore(opts.db, clock);
  const cells = cellsRepo(opts.db, clock);
  const identity = opts.gitIdentity ?? DEFAULT_IDENTITY;
  const hostEnv = pickHostEnv(opts.envAllowlist ?? DEFAULT_ENV_ALLOWLIST);
  const hostShell = opts.shell ?? (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
  const ripgrep = opts.ripgrep === false ? null : (opts.ripgrep ?? detectRipgrep(hostEnv.PATH));

  const kernelHome = join(dataDir, "kernel-home");
  mkdirSync(kernelHome, { recursive: true });
  const git = new Git(runner, { ...hostEnv, HOME: kernelHome, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }, identity);

  const slugOf = (cellId: string) => slugify(cellId);
  const jobsDirOf = (cellId: string) => join(dataDir, "jobs", slugOf(cellId));
  const homeOf = (cellId: string) => join(dataDir, "home", slugOf(cellId));

  const cellDirOf = (cellId: string) => join(dataDir, "cells", slugOf(cellId));
  /**
   * Environment of a cell's processes.
   * - isolation "none" / "shared_ro" (docs/05: the owner's real machine): the kernel's own environment as the owner
   *   started it — real HOME, PATH, git identity, ssh agent, CLI logins — minus the kernel's configuration and secrets
   *   (`NG_*`). Nothing is redirected: `git commit` is the owner's, `git push` finds their keys.
   * - explicit isolation (git_worktree / container): allow-listed variables, a per-cell HOME and a neutral identity.
   */
  const sandboxEnv = (cellId: string): Record<string, string> => {
    const isolation = store.getWorkspace(cellId)?.isolation ?? "none";
    if (isolation === "none" || isolation === "shared_ro") {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("NG_")) env[k] = v;
      return { ...env, ...opts.env };
    }
    const home = homeOf(cellId);
    mkdirSync(join(home, "tmp"), { recursive: true });
    return {
      ...hostEnv,
      HOME: home,
      TMPDIR: join(home, "tmp"),
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_TERMINAL_PROMPT: "0",
      ...opts.env,
    };
  };
  const deps: DriverDeps = {
    dataDir,
    runner,
    git,
    defaultRepoPath: opts.defaultRepoPath,
    hostShell,
    hostNode: process.execPath,
    slugOf,
    jobsDirOf,
    cellDirOf,
  };
  const gitDriver = new GitWorktreeDriver(deps);
  const drivers: Record<IsolationLevel, IsolationDriver> = {
    none: new NoneDriver(deps),
    shared_ro: new SharedRoDriver(deps),
    git_worktree: gitDriver,
    container: new ContainerDriver(deps, opts.container),
    cow_microvm: new CowMicrovmDriver(),
  };

  const cellLock = new KeyedMutex();
  // git worktree/branch bookkeeping of one repository is not safe to run concurrently; serialize all of it.
  const repoLock = new KeyedMutex();
  const withRepoLock = <T>(fn: () => Promise<T>) => repoLock.run("git", fn);

  const workspaceOf = (cellId: string) => {
    const ws = store.getWorkspace(cellId);
    return ws ? { ws, driver: drivers[ws.isolation] } : undefined;
  };

  const jobs = new JobManager({
    db: opts.db,
    bus: opts.bus,
    clock,
    store,
    cells,
    inbox: opts.inbox,
    resources: opts.resources,
    runner,
    limits,
    jobsDirOf,
    sandboxEnv,
    workspaceOf,
  });

  const portDeps = {
    clock,
    store,
    cells,
    jobs,
    runner,
    limits,
    ripgrep,
    sandboxEnv,
    rpc: opts.rpc ?? {},
    injectSecret: opts.injectSecret,
    secretHosts: opts.secretHosts,
    fetch: opts.fetch ?? globalThis.fetch,
  };
  const makePort = (ws: WorkspaceRecord): ManagedWorkspacePort => createPort(portDeps, drivers[ws.isolation], ws);

  const activate = (cellId: string, isolation: IsolationLevel, p: Provisioned): WorkspaceRecord =>
    store.upsertWorkspace({ cellId, isolation, ...p, status: "active", snapshotId: null, error: null });

  const recordFailure = (cellId: string, isolation: IsolationLevel, prev: WorkspaceRecord | undefined, err: unknown) => {
    if (prev) store.patchWorkspace(cellId, { isolation, status: "failed", error: errorMessage(err) });
    else {
      store.upsertWorkspace({ cellId, isolation, path: null, baseRepo: null, baseRef: null, branch: null, containerId: null, status: "failed", error: errorMessage(err) });
    }
  };

  const needsRepoLock = (level: IsolationLevel) => level === "git_worktree" || level === "container";

  const revive = async (ws: WorkspaceRecord): Promise<ManagedWorkspacePort> => {
    const sha = ws.snapshotId?.split(SNAPSHOT_SEP).pop();
    try {
      const p = await withRepoLock(() => gitDriver.revive(ws, sha && sha !== "clean" ? sha : null));
      return makePort(activate(ws.cellId, ws.isolation, p));
    } catch (err) {
      store.patchWorkspace(ws.cellId, { error: `restore failed: ${errorMessage(err)}` });
      throw err;
    }
  };

  const manager: WorkspaceManager = {
    get searchBackend() {
      return ripgrep ?? "builtin";
    },

    async acquire(cellId: string, isolation: IsolationLevel, acquireOpts: WorkspaceAcquireOptions = {}) {
      if (!(ISOLATION_LEVELS as readonly string[]).includes(isolation)) throw new NgError("invalid_argument", `unknown isolation "${String(isolation)}"`);
      if (isolation === "cow_microvm") throw new NgError("unsupported", COW_MICROVM_UNAVAILABLE);
      return cellLock.run(cellId, async () => {
        cells.require(cellId);
        const prev = store.getWorkspace(cellId);
        const live = prev && (prev.status === "active" || prev.status === "hibernated");
        if (live && prev.isolation !== isolation) {
          throw new NgError("conflict", `cell "${cellId}" already has a ${prev.isolation} workspace; destroy it before acquiring ${isolation}`);
        }
        // A host cell works where its spec says; a row from an earlier acquire with another directory is replaced.
        const moved = (isolation === "none" || isolation === "shared_ro") && acquireOpts.cwd !== undefined && prev?.path !== resolve(acquireOpts.cwd);
        if (prev?.status === "active" && prev.path && existsSync(prev.path) && !moved) return makePort(prev);
        if (prev?.status === "hibernated" && prev.isolation === "git_worktree") return revive(prev);

        const driver = drivers[isolation];
        try {
          const run = () => driver.provision(cellId, acquireOpts, prev);
          const p = needsRepoLock(isolation) ? await withRepoLock(run) : await run();
          return makePort(activate(cellId, isolation, p));
        } catch (err) {
          recordFailure(cellId, isolation, prev, err);
          throw err;
        }
      });
    },

    async hibernate(cellId: string) {
      return cellLock.run(cellId, async () => {
        const ws = store.getWorkspace(cellId);
        if (!ws || ws.status !== "active") throw new NgError("not_found", `cell "${cellId}" has no active workspace`);
        if (ws.isolation !== "git_worktree") throw new NgError("unsupported", `hibernate is implemented for git_worktree only (this workspace is ${ws.isolation})`);
        await jobs.cancelForCell(cellId, "workspace hibernated");
        const r = await withRepoLock(() => gitDriver.release(ws, "hibernate"));
        const snapshotId = `${newId("wsnap", clock)}${SNAPSHOT_SEP}${r.snapshot ?? "clean"}`;
        store.patchWorkspace(cellId, { status: "hibernated", snapshotId, error: r.warnings.join("; ") || null });
        return snapshotId;
      });
    },

    async restore(snapshotId: string) {
      const found = store.getWorkspaceBySnapshot(snapshotId);
      if (!found) throw new NgError("not_found", `no workspace snapshot "${snapshotId}"`);
      return cellLock.run(found.cellId, async () => {
        const ws = store.getWorkspace(found.cellId)!;
        if (ws.status !== "hibernated" || ws.snapshotId !== snapshotId) throw new NgError("conflict", `snapshot "${snapshotId}" is no longer restorable (workspace is ${ws.status})`);
        return revive(ws);
      });
    },

    async stopRuntime(cellId: string) {
      await cellLock.run(cellId, async () => {
        // Resolves when every job's process group is confirmed gone (see JobManager.cancel).
        await jobs.cancelForCell(cellId, "cancelled with the cell");
        const ws = store.getWorkspace(cellId);
        if (!ws || !ws.containerId) return;
        // Only a container is the kernel's to stop. Directories, branches and worktrees — the owner's or ones a cell
        // made for itself — are never touched here (docs/05 principle 3).
        const driver = drivers[ws.isolation];
        try {
          const warnings = (await driver.stopRuntime?.(ws)) ?? [];
          store.patchWorkspace(cellId, { status: "destroyed", containerId: null, error: warnings.join("; ") || null });
        } catch (err) {
          store.patchWorkspace(cellId, { status: "failed", error: `stopping the container failed: ${errorMessage(err)}` });
          throw err;
        }
      });
    },
    destroy(cellId: string) {
      return manager.stopRuntime(cellId);
    },
    cancelJobsForCell(cellId: string) {
      return jobs.cancelForCell(cellId, "cancelled with the cell");
    },

    recover() {
      return jobs.recover();
    },

    getJobSync(jobId: string) {
      return store.getJob(jobId);
    },
    listJobsSync(filter) {
      return store.listJobs(filter);
    },
    getWorkspaceSync(cellId: string) {
      return store.getWorkspace(cellId);
    },
    observeJobSync(jobId: string) {
      return jobs.observeSync(jobId);
    },
    close() {
      jobs.close();
    },
  };
  return manager;
}
