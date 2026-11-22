import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { cellsRepo, NgError, systemClock } from "@ng/protocol";
import { defaultCommandRunner } from "./exec/process";
import { JobManager } from "./jobs";
import { createPort } from "./port";
import { WorkspaceStore } from "./store";
import type { WorkspaceLimits, WorkspaceManager, WorkspaceManagerOptions } from "./types";
import { slugify } from "./util";

export const DEFAULT_LIMITS: WorkspaceLimits = {
  bashTimeoutMs: 120_000,
  maxBashTimeoutMs: 600_000,
  maxOutputChars: 50_000,
  jobTailChars: 4000,
  jobResultTailChars: 2000,
  storedLogMaxChars: 1_000_000,
  killGraceMs: 3000,
  maxJobsPerCell: 8,
  jobTimeoutMs: 30 * 60_000,
  maxJobTimeoutMs: 4 * 60 * 60_000,
  jobQuietWarningMs: 5 * 60_000,
  jobPollMs: 1000,
};

export function createWorkspaceManager(opts: WorkspaceManagerOptions): WorkspaceManager {
  const clock = opts.clock ?? systemClock;
  mkdirSync(opts.dataDir, { recursive: true });
  const dataDir = realpathSync(opts.dataDir);
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const runner = opts.runner ?? defaultCommandRunner;
  const store = new WorkspaceStore(opts.db, clock);
  const cells = cellsRepo(opts.db, clock);
  const shell = opts.shell ?? (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
  const hostEnv = () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("NG_")) env[key] = value;
    }
    return { ...env, ...opts.env };
  };
  const jobs = new JobManager({
    db: opts.db, bus: opts.bus, clock, store, cells, inbox: opts.inbox, resources: opts.resources,
    runner, limits, shell, hostEnv, jobsDirOf: id => join(dataDir, "jobs", slugify(id)),
  });
  return {
    async acquire(cellId, options = {}) {
      cells.require(cellId);
      const configured = options.cwd ?? opts.defaultRepoPath;
      const path = configured ? resolve(configured) : join(dataDir, "cells", slugify(cellId));
      if (!configured) mkdirSync(path, { recursive: true });
      if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
        const error = `working directory does not exist: ${path}`;
        store.upsertWorkspace({ cellId, path, status: "failed", error });
        throw new NgError("invalid_argument", error);
      }
      const current = store.getWorkspace(cellId);
      const ws = current?.status === "active" && current.path === path ? current
        : store.upsertWorkspace({ cellId, path, status: "active" });
      return createPort({ clock, store, runner, limits, shell, hostEnv, jobs }, ws);
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
}
