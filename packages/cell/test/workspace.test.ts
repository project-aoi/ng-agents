import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    const ops = args["ops"] as Array<{ name: string; tool?: "bash"; args?: unknown; job?: string }>;
    const patches: Record<string, unknown> = {};
    try {
      patches["access"] = await ports.workspaceAccess();
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
  { name: "bash", tool: "bash", args: { command: "printf y > note.txt; echo hi" } },
  { name: "job", job: "printf y > note.txt; echo hi" },
];

describe("workspace port", () => {
  it("a coordinator works in the owner's real directory with all its tools: nothing is refused, and while its Run is in flight it is listed as active there", async () => {
    const repo = initRepo();
    const h = await boot({ setup, desk: false, kernel: { repoPath: repo } });
    h.kernel.createRootCell({ id: "desk", preset: "inline", processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS } } });
    h.kernel.inbox.enqueueSync("desk", { id: "go", from: "channel:ui:owner", principalId: "owner", kind: "event", type: PAYLOAD.userMessage, payload: { text: "go" }, createdAt: h.clock.now() });
    await h.kernel.idle();
    const s = (k: string) => h.kernel.context.readStateSync<string>("desk", `op:${k}`)!;
    // nothing about a coordinator locks it out of writing: every write path works
    expect(s("bash")).toBe("ok: hi\n");
    expect(s("job")).toMatch(/^ok: /);
    expect(readFileSync(join(repo, "note.txt"), "utf8")).toBe("y");
    expect(h.kernel.context.readStateSync("desk", "root")).toBe(repo);
    // its job ran to the end and its result woke the cell
    await waitFor(() => h.kernel.context.readStateSync("desk", "woken") === PAYLOAD.jobResult, 10_000, "the job result");
    expect(h.kernel.workspace.listJobsSync({ cellId: "desk" })).toHaveLength(1);
    // reported: every tool in bounds, and nothing about a mode
    const access = h.kernel.context.readStateSync<{ root: string; isolation: string; tools: ToolKind[] }>("desk", "access")!;
    expect(access).toEqual({ root: repo, isolation: "none", tools: expect.arrayContaining(["read", "write", "edit", "bash"]) });
    // while it ran, it was the one cell active in that work tree
    const occ = h.kernel.context.readStateSync<WorkspaceOccupancy[]>("desk", "occupancy")!;
    expect(occ).toEqual([{ key: repo, active: [expect.objectContaining({ cellId: "desk", state: "running", cwd: repo, projectCellId: null, projectTitle: null })] }]);
    // and once nothing of it is in flight, the work tree is no longer listed
    await h.kernel.idle();
    expect(h.kernel.activeWorkspaces()).toEqual([]);
  });

  it("tools outside the cell's bounds are refused at the port", async () => {
    const h = await boot({ setup });
    h.kernel.spawnCell(
      "desk",
      { id: "ro", preset: "worker", processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS } }, bounds: { tools: new Set<ToolKind>(["read"]) } },
      "go",
    );
    await h.kernel.idle();
    const s = (k: string) => h.kernel.context.readStateSync<string>("ro", `op:${k}`)!;
    expect(s("bash")).toMatch(/^error: .*outside this cell's bounds/);
    expect(s("job")).toMatch(/^error: starting a job needs the "bash" tool/);
  });

  it("a worker writes in the configured repository itself by default (host, no automatic worktree)", async () => {
    const repo = initRepo();
    const h = await boot({ setup, kernel: { repoPath: repo } });
    h.kernel.spawnCell("desk", { id: "fix", preset: "worker", processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS.slice(0, 1) } } }, "go");
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

});
