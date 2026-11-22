import { constants as osConstants } from "node:os";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { bashArgsSchema, newId, NgError, type Clock, type ExecResult, type WorkspaceRecord } from "@ng/protocol";
import { OutputCollector, supervise } from "./exec/process";
import type { JobManager } from "./jobs";
import type { WorkspaceStore } from "./store";
import type { CommandRunner, ManagedWorkspacePort, WorkspaceLimits } from "./types";
import { abortError, throwIfAborted } from "./util";

export const EXEC_MARKER = "NG_EXEC_ID";

interface PortDeps {
  clock: Clock;
  store: WorkspaceStore;
  jobs: JobManager;
  runner: CommandRunner;
  limits: WorkspaceLimits;
  shell: string;
  hostEnv(): Record<string, string>;
}

export function createPort(deps: PortDeps, initial: WorkspaceRecord): ManagedWorkspacePort {
  const cellId = initial.cellId;
  const root = initial.path!;
  const current = (): WorkspaceRecord => {
    const ws = deps.store.getWorkspace(cellId);
    if (ws?.status !== "active" || ws.path !== root) {
      throw new NgError("conflict", `the working directory of cell "${cellId}" changed; acquire it again`);
    }
    return ws;
  };
  async function exec(tool: "bash", input: unknown, signal?: AbortSignal): Promise<ExecResult> {
    throwIfAborted(signal);
    current();
    if (tool !== "bash") throw new NgError("invalid_argument", "expected a shell command");
    const args = bashArgsSchema.safeParse(input);
    if (!args.success) throw new NgError("invalid_argument", args.error.message);
    const { command, cwd = ".", timeoutMs = deps.limits.bashTimeoutMs } = args.data;
    const directory = resolve(root, cwd);
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new NgError("invalid_argument", `not a directory: ${cwd}`);
    const child = deps.runner.spawn({
      file: deps.shell, args: ["-c", command], cwd: directory,
      env: { ...deps.hostEnv(), [EXEC_MARKER]: newId("exec", deps.clock) },
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const out = new OutputCollector(deps.limits.maxOutputChars);
    const timeout = Math.min(timeoutMs, deps.limits.maxBashTimeoutMs);
    const result = await supervise(child, {
      timeoutMs: timeout, killGraceMs: deps.limits.killGraceMs, signal, onData: chunk => out.push(chunk),
    });
    if (result.spawnError) throw new NgError("unsupported", `shell could not start: ${result.spawnError.message}`);
    if (result.aborted) throw abortError(signal);
    const signalCode = result.signal ? osConstants.signals[result.signal] : 0;
    const exitCode = result.timedOut ? 124 : result.code ?? (signalCode ? 128 + signalCode : 1);
    if (result.timedOut) out.push(`\n[timed out after ${timeout}ms]\n`);
    return { output: out.text(), exitCode, ...(out.truncated ? { truncated: true } : {}) };
  }

  const ownJob = (jobId: string) => {
    const job = deps.store.getJob(jobId);
    if (!job || job.cellId !== cellId) throw new NgError("not_found", `job "${jobId}" not found in this workspace`);
    return job;
  };

  return {
    cellId,
    root,
    exec,
    async startJob(spec) {
      return deps.jobs.start(current(), spec);
    },
    async observeJob(jobId) {
      ownJob(jobId);
      return deps.jobs.observeSync(jobId)!;
    },
    async writeJobInput(jobId, input) {
      ownJob(jobId);
      if (typeof input !== "string") throw new NgError("invalid_argument", "input must be a string");
      await deps.jobs.writeInput(jobId, input);
    },
    async cancelJob(jobId) {
      ownJob(jobId);
      await deps.jobs.cancel(jobId, "cancelled by the cell", { silent: true });
    },
  };
}
