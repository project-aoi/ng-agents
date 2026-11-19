import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memorySecretStore } from "@ng/gate";
import { PAYLOAD, type CodeProcessor, type Registry, type ToolKind, type WorkspaceOccupancy } from "@ng/protocol";
import { boot, cleanupAll, git, initRepo, registerTestPresets, waitFor } from "./helpers";

afterEach(cleanupAll);

/**
 * Tries a list of workspace operations and records each outcome in state (`op:<name>` → "ok: …" | "error: …"), plus
 * what the kernel reports while the Run is in flight: `access` (workspaceAccess) and `occupancy` (activeWorkspaces).
 * Woken only by its own job's result, it just notes that (`woken`) instead of trying everything again.
 */
const tryTools: CodeProcessor = {
  name: "test.try_tools",
  async run({ ports, args, snapshot }) {
    const types = snapshot.batch.envelopes.map((e) => e.type);
    if (types.length > 0 && types.every((t) => t === PAYLOAD.jobResult)) {
      await ports.context.commit(ports.self.cellId, { statePatches: { woken: types.join(",") } });
      return "completed";
    }
    const ops = args["ops"] as Array<{ name: string; tool?: ToolKind; args?: unknown; job?: string }>;
    const patches: Record<string, unknown> = {};
    try {
      patches["access"] = ports.workspaceAccess ? await ports.workspaceAccess() : null;
    } catch (err) {
      patches["access"] = `error: ${(err as Error).message}`;
    }
    patches["occupancy"] = ports.activeWorkspaces ? ports.activeWorkspaces() : null;
    for (const op of ops) {
      try {
        if (op.job) {
          const { jobId } = await ports.workspace.startJob({ command: op.job });
          patches[`op:${op.name}`] = `ok: ${jobId}`;
        } else {
          const r = await ports.workspace.exec(op.tool!, op.args);
          patches[`op:${op.name}`] = `ok: ${r.output}`;
        }
      } catch (err) {
        patches[`op:${op.name}`] = `error: ${(err as Error).message}`;
      }
    }
    patches["root"] = ports.workspace.root;
    await ports.context.commit(ports.self.cellId, { statePatches: patches });
    return "completed";
  },
};

function setup(registry: Registry): void {
  registerTestPresets(registry);
  registry.codeProcessors.register(tryTools);
}

const OPS = [
  { name: "list", tool: "read", args: { op: "list_dir", path: "." } },
  { name: "write", tool: "write", args: { path: "note.txt", content: "x" } },
  { name: "edit", tool: "edit", args: { path: "note.txt", oldText: "x", newText: "y" } },
  { name: "bash", tool: "bash", args: { command: "echo hi" } },
  { name: "code_rpc", tool: "code_rpc", args: { code: "console.log(1)" } },
  { name: "job", job: "echo hi" },
];

describe("workspace port", () => {
  it("a coordinator works in the owner's real directory with all its tools: nothing is refused, and while its Run is in flight it is listed as active there", async () => {
    const repo = initRepo();
    const h = await boot({ setup, desk: false, kernel: { repoPath: repo } });
    h.kernel.createRootCell({ id: "desk", preset: "inline", processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS } } });
    h.kernel.inbox.enqueueSync("desk", { id: "go", from: "channel:ui:owner", principalId: "owner", kind: "event", type: PAYLOAD.userMessage, payload: { text: "go" }, createdAt: h.clock.now() });
    await h.kernel.idle();
    const s = (k: string) => h.kernel.context.readStateSync<string>("desk", `op:${k}`)!;
    expect(s("list")).toMatch(/^ok: .*README\.md/s);
    // nothing about a coordinator locks it out of writing: every write path works
    expect(s("write")).toMatch(/^ok:/);
    expect(s("edit")).toMatch(/^ok:/);
    expect(s("bash")).toBe("ok: hi\n");
    expect(s("code_rpc")).toBe("ok: 1\n");
    expect(s("job")).toMatch(/^ok: /);
    expect(readFileSync(join(repo, "note.txt"), "utf8")).toBe("y");
    expect(h.kernel.context.readStateSync("desk", "root")).toBe(repo);
    // its job ran to the end and its result woke the cell
    await waitFor(() => h.kernel.context.readStateSync("desk", "woken") === PAYLOAD.jobResult, 10_000, "the job result");
    expect(h.kernel.workspace.listJobsSync({ cellId: "desk" })).toHaveLength(1);
    // reported: every tool in bounds, and nothing about a mode
    const access = h.kernel.context.readStateSync<{ root: string; isolation: string; tools: ToolKind[] }>("desk", "access")!;
    expect(access).toEqual({ root: repo, isolation: "none", tools: expect.arrayContaining(["read", "write", "edit", "bash", "code_rpc"]) });
    // while it ran, it was the one cell active in that work tree
    const occ = h.kernel.context.readStateSync<WorkspaceOccupancy[]>("desk", "occupancy")!;
    expect(occ).toEqual([{ key: repo, active: [expect.objectContaining({ cellId: "desk", state: "running", cwd: repo, projectCellId: null, projectTitle: null })] }]);
    // and once nothing of it is in flight, the work tree is no longer listed
    await h.kernel.idle();
    expect(h.kernel.activeWorkspaces()).toEqual([]);
  });

  it("cwdMode is accepted and stored but changes nothing: root cells with or without it work in the owner's directory itself with every tool (allowHostWrites does nothing either) and are listed only while running", async () => {
    const repo = initRepo();
    const h = await boot({ setup, desk: false, kernel: { repoPath: repo, allowHostWrites: true } });
    const go = (cellId: string) =>
      h.kernel.inbox.enqueueSync(cellId, { id: `go-${cellId}`, from: "channel:cli:owner", principalId: "owner", kind: "event", type: PAYLOAD.userMessage, payload: { text: "go" }, createdAt: h.clock.now() });
    const occupancyOf = (cellId: string) => h.kernel.context.readStateSync<WorkspaceOccupancy[]>(cellId, "occupancy")!.find((o) => o.key === repo)!;
    h.kernel.createRootCell({ id: "ro", processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS.slice(0, 4) } } }, { bounds: { maxDepth: 0 } });
    go("ro");
    await h.kernel.idle();
    expect(h.kernel.context.readStateSync<string>("ro", "op:bash")).toBe("ok: hi\n");
    expect(h.kernel.context.readStateSync("ro", "root")).toBe(repo);
    expect(readFileSync(join(repo, "note.txt"), "utf8")).toBe("y");
    expect(h.kernel.context.readStateSync("ro", "access")).not.toHaveProperty("cwdMode");
    expect(occupancyOf("ro").active.map((u) => [u.cellId, u.state])).toEqual([["ro", "running"]]);
    // the single-local-cell CLI shape, with the old declaration: the same
    h.kernel.createRootCell({ id: "cli", cwdMode: "write", processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS.slice(0, 4) } } }, { bounds: { maxDepth: 0 } });
    expect(h.kernel.getCell("cli")!.spec.cwdMode).toBe("write");
    go("cli");
    await h.kernel.idle();
    expect(h.kernel.context.readStateSync<string>("cli", "op:bash")).toBe("ok: hi\n");
    expect(h.kernel.context.readStateSync("cli", "root")).toBe(repo);
    expect(readFileSync(join(repo, "note.txt"), "utf8")).toBe("y");
    expect(h.kernel.context.readStateSync("cli", "access")).not.toHaveProperty("cwdMode");
    // "ro" is done: only the cell that is running is listed
    expect(occupancyOf("cli").active.map((u) => [u.cellId, u.state])).toEqual([["cli", "running"]]);
    expect(existsSync(join(repo, "note.txt"))).toBe(true);
  });

  it("tools outside the cell's bounds are refused at the port; code_rpc needs write+edit+bash", async () => {
    const h = await boot({ setup });
    h.kernel.spawnCell(
      "desk",
      { id: "ro", preset: "worker", processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS } }, bounds: { tools: new Set<ToolKind>(["read", "code_rpc"]) } },
      "go",
    );
    await h.kernel.idle();
    const s = (k: string) => h.kernel.context.readStateSync<string>("ro", `op:${k}`)!;
    expect(s("list")).toMatch(/^ok:/);
    expect(s("write")).toMatch(/^error: .*"write" tool, which is outside this cell's bounds/);
    expect(s("bash")).toMatch(/^error: .*outside this cell's bounds/);
    expect(s("job")).toMatch(/^error: starting a job needs the "bash" tool/);
    expect(s("code_rpc")).toMatch(/^error: code_rpc can write files and run commands/);
  });

  it("secrets reach host-side code only through the Gate, and only for cells whose bounds include them", async () => {
    const h = await boot({
      setup,
      kernel: {
        secrets: memorySecretStore({ github: "ghp_super_secret_value" }),
        rootBounds: { secretRefs: ["github"] },
        workspace: {
          limits: { killGraceMs: 300, jobPollMs: 40, previewPollMs: 25 },
          rpc: { probe: { handler: async (_args, ctx) => `len=${(await ctx.secret("github", "probe")).length}` } },
        },
      },
    });
    const code = { name: "rpc", tool: "code_rpc", args: { code: "console.log(await tools.rpc('probe', {}))" } };
    h.kernel.spawnCell("desk", { id: "granted", preset: "worker", processor: { kind: "code", entry: "test.try_tools", args: { ops: [code] } }, bounds: { secretRefs: new Set(["github"]) } }, "go");
    h.kernel.spawnCell("desk", { id: "plain", preset: "worker", processor: { kind: "code", entry: "test.try_tools", args: { ops: [code] } } }, "go");
    await h.kernel.idle();
    expect(h.kernel.context.readStateSync<string>("granted", "op:rpc")).toBe("ok: len=22\n");
    const denied = h.kernel.context.readStateSync<string>("plain", "op:rpc")!;
    expect(denied).toMatch(/outside this cell's bounds/);
    expect(denied).not.toContain("ghp_super_secret_value");
  });

  it("a worker writes in the configured repository itself by default (host, no automatic worktree)", async () => {
    const repo = initRepo();
    const h = await boot({ setup, kernel: { repoPath: repo } });
    h.kernel.spawnCell("desk", { id: "fix", preset: "worker", processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS.slice(0, 4) } } }, "go");
    await h.kernel.idle();
    expect(h.kernel.getCell("fix")!.bounds.isolation).toBe("none");
    expect(h.kernel.context.readStateSync<string>("fix", "root")).toBe(repo);
    expect(readFileSync(join(repo, "note.txt"), "utf8")).toBe("y");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(repo, "branch", "--list")).toBe("* main");
    expect(existsSync(join(h.dataDir, "workspace", "worktrees"))).toBe(false);
    // the worker's turn settled and it rests, dormant; the file it wrote is the owner's now
    expect(h.kernel.getCell("fix")!.status).toBe("active");
    expect(h.kernel.activityOf(["fix"]).get("fix")!.state).toBe("dormant");
    expect(readFileSync(join(repo, "note.txt"), "utf8")).toBe("y");
  });

  it("git_worktree is opt-in: the cell works on its own branch, the base checkout is untouched, and closing removes nothing", async () => {
    const repo = initRepo();
    const h = await boot({ setup, kernel: { repoPath: repo } });
    h.kernel.spawnCell(
      "desk",
      { id: "fix", preset: "worker", bounds: { isolation: "git_worktree" }, processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS.slice(0, 4) } } },
      "go",
    );
    await h.kernel.idle();
    const root = h.kernel.context.readStateSync<string>("fix", "root")!;
    expect(root).not.toBe(repo);
    expect(root.startsWith(join(h.dataDir, "workspace", "worktrees"))).toBe(true);
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("y");
    expect(existsSync(join(repo, "note.txt"))).toBe(false);
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ng/fix");
    // the worker rests once its turn settled; closing it — guard 4 — leaves worktree, branch and files as they are
    expect(h.kernel.getCell("fix")!.status).toBe("active");
    expect(await h.kernel.closeCell("fix", "completed")).toEqual({ closed: ["fix"] });
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("y");
    expect(git(root, "status", "--porcelain")).toBe("?? note.txt");
    expect(git(repo, "branch", "--list", "ng/fix")).toContain("ng/fix");
    expect(h.kernel.workspace.getWorkspaceSync("fix")!.status).toBe("active");
  });

  it("git_worktree without any repository is refused clearly (no scratch repository is made up)", async () => {
    const h = await boot({ setup });
    h.kernel.spawnCell("desk", { id: "iso", preset: "worker", bounds: { isolation: "git_worktree" }, processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS.slice(0, 1) } } }, "go");
    await h.kernel.idle();
    expect(h.kernel.context.readStateSync<string>("iso", "op:list")).toBe(
      "error: git_worktree needs a repository: pass repoPath (spec.meta.workspace.repoPath) or configure defaultRepoPath",
    );
    expect(existsSync(join(h.dataDir, "base-repo"))).toBe(false);
    expect(h.kernel.workspace.getWorkspaceSync("iso")).toMatchObject({
      isolation: "git_worktree",
      status: "failed",
      path: null,
      baseRepo: null,
      error: "git_worktree needs a repository: pass repoPath (spec.meta.workspace.repoPath) or configure defaultRepoPath",
    });
  });
});
