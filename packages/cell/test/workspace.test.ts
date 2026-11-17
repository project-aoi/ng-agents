import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memorySecretStore } from "@ng/gate";
import { PAYLOAD, type CodeProcessor, type Registry, type ToolKind } from "@ng/protocol";
import { boot, cleanupAll, git, initRepo, registerTestPresets } from "./helpers";

afterEach(cleanupAll);

/** Tries a list of workspace operations and records each outcome in state (`op:<name>` → "ok: …" | "error: …"). */
const tryTools: CodeProcessor = {
  name: "test.try_tools",
  async run({ ports, args }) {
    const ops = args["ops"] as Array<{ name: string; tool?: ToolKind; args?: unknown; job?: string }>;
    const patches: Record<string, string> = {};
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
  it("isolation none is the owner's real directory: reads work, every write path is refused with a delegation hint", async () => {
    const repo = initRepo();
    const h = await boot({ setup, desk: false, kernel: { repoPath: repo } });
    h.kernel.createRootCell({ id: "desk", preset: "inline", processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS } } });
    h.kernel.inbox.enqueueSync("desk", { id: "go", from: "channel:ui:owner", principalId: "owner", kind: "event", type: PAYLOAD.userMessage, payload: { text: "go" }, createdAt: h.clock.now() });
    await h.kernel.idle();
    const s = (k: string) => h.kernel.context.readStateSync<string>("desk", `op:${k}`)!;
    expect(s("list")).toMatch(/^ok: .*README\.md/s);
    for (const op of ["write", "edit", "bash", "code_rpc", "job"]) {
      expect(s(op)).toMatch(/^error: .*isolation "none".*spawn_cell with preset "worker"/s);
    }
    expect(existsSync(join(repo, "note.txt"))).toBe(false);
    expect(h.kernel.context.readStateSync("desk", "root")).toBe(repo);
  });

  it("allowHostWrites lifts the guard (the single-local-cell CLI shape)", async () => {
    const repo = initRepo();
    const h = await boot({ setup, desk: false, kernel: { repoPath: repo, allowHostWrites: true } });
    h.kernel.createRootCell({ id: "cli", processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS.slice(0, 4) } } }, { bounds: { maxDepth: 0 } });
    h.kernel.inbox.enqueueSync("cli", { id: "go", from: "channel:cli:owner", principalId: "owner", kind: "event", type: PAYLOAD.userMessage, payload: { text: "go" }, createdAt: h.clock.now() });
    await h.kernel.idle();
    expect(h.kernel.context.readStateSync<string>("cli", "op:bash")).toBe("ok: hi\n");
    expect(readFileSync(join(repo, "note.txt"), "utf8")).toBe("y");
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

  it("git_worktree from the configured repository: the cell works on its own branch, the base checkout is untouched", async () => {
    const repo = initRepo();
    const h = await boot({ setup, kernel: { repoPath: repo } });
    h.kernel.spawnCell(
      "desk",
      { id: "fix", preset: "worker", processor: { kind: "code", entry: "test.try_tools", args: { ops: OPS.slice(0, 4) } } },
      "go",
    );
    await h.kernel.idle();
    const root = h.kernel.context.readStateSync<string>("fix", "root")!;
    expect(root).not.toBe(repo);
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("y");
    expect(existsSync(join(repo, "note.txt"))).toBe(false);
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ng/fix");
    await h.kernel.closeCell("fix", "completed");
    expect(existsSync(root)).toBe(false);
    // uncommitted work was snapshotted onto the kept branch, never lost
    expect(git(repo, "branch", "--list", "ng/fix")).toContain("ng/fix");
  });
});
