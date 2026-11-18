import { constants as osConstants } from "node:os";
import { statSync } from "node:fs";
import {
  execArgsSchemas,
  newId,
  NgError,
  TOOL_KINDS,
  type CellsRepo,
  type Clock,
  type ExecResult,
  type ToolKind,
  type WorkspaceRecord,
} from "@ng/protocol";
import type { IsolationDriver, Marker } from "./drivers/types";
import { codeRpcArgv, runCodeRpc } from "./exec/code-rpc";
import { editTool, listDirTool, readFileTool, writeTool } from "./exec/fs-tools";
import { makePathPolicy, resolveWorkspacePath, type PathPolicy } from "./exec/paths";
import { OutputCollector, supervise } from "./exec/process";
import { searchBuiltin, searchWithRipgrep } from "./exec/search";
import type { JobManager } from "./jobs";
import type { WorkspaceStore } from "./store";
import type { CommandRunner, ManagedWorkspacePort, RpcHandlerDef, SecretInjector, WorkspaceLimits } from "./types";
import { abortError, throwIfAborted } from "./util";

export const EXEC_MARKER = "NG_EXEC_ID";

export interface PortDeps {
  clock: Clock;
  store: WorkspaceStore;
  cells: CellsRepo;
  jobs: JobManager;
  runner: CommandRunner;
  limits: WorkspaceLimits;
  ripgrep: string | null;
  sandboxEnv(cellId: string): Record<string, string>;
  rpc: Record<string, RpcHandlerDef>;
  injectSecret: SecretInjector | undefined;
  secretHosts: Record<string, readonly string[]> | undefined;
  fetch: typeof fetch;
}

type ArgsSchema = (typeof execArgsSchemas)[ToolKind];

function parseArgs<S extends ArgsSchema>(tool: ToolKind, schema: S, args: unknown): ReturnType<S["parse"]> {
  const r = schema.safeParse(args);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.map(String).join(".") || "(args)"}: ${i.message}`).join("; ");
    throw new NgError("invalid_argument", `invalid ${tool} arguments: ${detail}`);
  }
  return r.data as ReturnType<S["parse"]>;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  const n = signal ? (osConstants.signals as Record<string, number | undefined>)[signal] : undefined;
  return n ? 128 + n : 1;
}

export function createPort(deps: PortDeps, driver: IsolationDriver, initial: WorkspaceRecord): ManagedWorkspacePort {
  const cellId = initial.cellId;
  const root = initial.path!;
  const policy: PathPolicy = makePathPolicy(root, driver.confine, driver.aliases(initial));
  const { limits } = deps;

  const current = (): WorkspaceRecord => {
    const ws = deps.store.getWorkspace(cellId);
    if (!ws || ws.status !== "active" || ws.path !== root) {
      throw new NgError("conflict", `the workspace of cell "${cellId}" is ${ws ? ws.status : "gone"}; acquire it again`);
    }
    return ws;
  };
  const writable = (tool: string) => {
    if (driver.readOnly) throw new NgError("bounds_violation", `${tool} is not allowed in a ${driver.level} workspace (read and search only)`);
  };
  const killInsideFor = (ws: WorkspaceRecord, marker: Marker) =>
    driver.killInside ? (sig: "TERM" | "KILL") => void driver.killInside!(ws, marker, sig).catch(() => {}) : undefined;

  const directory = (given: string | undefined): string => {
    const cwd = given ? resolveWorkspacePath(policy, given).abs : root;
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new NgError("invalid_argument", `not a directory: ${given}`);
    return cwd;
  };

  /** One supervised command (argv, no shell of its own) with collected output, a time limit and abort. */
  const runCommand = async (
    ws: WorkspaceRecord,
    what: string,
    argv: string[],
    o: { cwd: string; timeoutMs?: number | undefined; env?: Readonly<Record<string, string>> },
    signal?: AbortSignal,
  ): Promise<ExecResult> => {
    const timeoutMs = Math.min(o.timeoutMs ?? limits.bashTimeoutMs, limits.maxBashTimeoutMs);
    const marker = { name: EXEC_MARKER, value: newId("exec", deps.clock) };
    const plan = driver.plan(ws, { argv, cwd: o.cwd, env: { ...deps.sandboxEnv(cellId), ...o.env }, marker });
    const child = deps.runner.spawn({ ...plan, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = new OutputCollector(limits.maxOutputChars);
    const r = await supervise(child, {
      timeoutMs,
      killGraceMs: limits.killGraceMs,
      signal,
      onData: (chunk) => out.push(chunk),
      killInside: killInsideFor(ws, marker),
    });
    if (r.spawnError) throw new NgError("unsupported", `${what} could not start: ${r.spawnError.message}`);
    if (r.aborted) throw abortError(signal);
    let exitCode = r.code ?? signalExitCode(r.signal);
    if (r.timedOut) {
      exitCode = 124;
      out.push(`\n[timed out after ${timeoutMs}ms; the command and its process group were killed]\n`);
    }
    return out.truncated ? { output: out.text(), exitCode, truncated: true } : { output: out.text(), exitCode };
  };

  const bash = (ws: WorkspaceRecord, args: { command: string; timeoutMs?: number | undefined; cwd?: string | undefined }, signal?: AbortSignal): Promise<ExecResult> => {
    writable("bash");
    return runCommand(ws, "bash", [driver.shell(), "-c", args.command], { cwd: directory(args.cwd), timeoutMs: args.timeoutMs }, signal);
  };

  const exec = async (tool: ToolKind, args: unknown, signal?: AbortSignal): Promise<ExecResult> => {
    throwIfAborted(signal);
    if (!(TOOL_KINDS as readonly string[]).includes(tool)) throw new NgError("invalid_argument", `unknown tool kind "${String(tool)}"`);
    const ws = current();
    switch (tool) {
      case "read": {
        const a = parseArgs("read", execArgsSchemas.read, args);
        if (a.op === "read_file") return readFileTool(policy, a, limits);
        if (a.op === "list_dir") return listDirTool(policy, a, limits);
        const max = Math.min(a.maxResults ?? limits.searchMaxResults, 5000);
        return deps.ripgrep
          ? searchWithRipgrep(deps.ripgrep, deps.runner, policy, a, max, deps.sandboxEnv(cellId))
          : searchBuiltin(policy, a, max, signal);
      }
      case "write":
        writable("write");
        return writeTool(policy, parseArgs("write", execArgsSchemas.write, args));
      case "edit":
        writable("edit");
        return editTool(policy, parseArgs("edit", execArgsSchemas.edit, args));
      case "bash":
        return bash(ws, parseArgs("bash", execArgsSchemas.bash, args), signal);
      case "code_rpc": {
        const a = parseArgs("code_rpc", execArgsSchemas.code_rpc, args);
        const marker = { name: EXEC_MARKER, value: newId("exec", deps.clock) };
        const plan = driver.plan(ws, { argv: codeRpcArgv(driver.node()), cwd: root, env: deps.sandboxEnv(cellId), marker });
        const child = deps.runner.spawn({ ...plan, detached: true, stdio: ["pipe", "pipe", "pipe"] });
        return runCodeRpc({
          child,
          code: a.code,
          timeoutMs: Math.min(a.timeoutMs ?? limits.codeRpcTimeoutMs, limits.maxBashTimeoutMs),
          signal,
          killInside: killInsideFor(ws, marker),
          host: {
            cellId,
            root,
            epoch: () => deps.cells.getEpoch(cellId) ?? 0,
            exec: (nested, nestedArgs, nestedSignal) => exec(nested, nestedArgs, nestedSignal),
            rpc: deps.rpc,
            injectSecret: deps.injectSecret,
            secretHosts: deps.secretHosts,
            fetch: deps.fetch,
            limits,
          },
        });
      }
    }
  };

  const ownJob = (jobId: string) => {
    const job = deps.store.getJob(jobId);
    if (!job || job.cellId !== cellId) throw new NgError("not_found", `job "${jobId}" not found in this workspace`);
    return job;
  };

  return {
    cellId,
    isolation: initial.isolation,
    root,
    exec,
    async startJob(spec) {
      writable("starting a job");
      return deps.jobs.start(current(), driver, spec);
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
