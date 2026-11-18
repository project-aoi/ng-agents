import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliProcessAlive, reapOrphanedCliProcesses, spawnCli } from "../src";

// docs/05 guard 4: a CLI agent runs in its own process group, so a kernel that is killed leaves it running. Every CLI
// process is on record while it lives; the next kernel stops what is still on record before it dispatches anything.

const dirs: string[] = [];
const pids: number[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ng-cli-procs-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
const linux = process.platform === "linux";

describe.runIf(linux)("orphaned CLI processes", () => {
  it("a process is on record while it runs and off it when it exits by itself", async () => {
    const dir = tmp();
    const p = spawnCli(["/bin/sh", "-c", "sleep 0.2"], { cwd: dir, env, onLine: () => undefined, registry: { dir, runId: "run_1", cellId: "w1" } });
    pids.push(p.pid);
    const file = join(dir, `${p.pid}.json`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: p.pid, runId: "run_1", cellId: "w1", cwd: dir });
    await p.exited;
    expect(existsSync(file)).toBe(false);
    expect(await reapOrphanedCliProcesses(dir)).toEqual([]);
  });

  it("what a dead kernel left running is stopped with its whole tree before the call returns — even a TERM-ignoring agent", async () => {
    const dir = tmp();
    // The "agent" ignores SIGTERM and has a helper child (an MCP server, a build) in a process group of its own.
    const script = "trap '' TERM; setsid sh -c 'sleep 60' & echo $! > helper.pid; wait";
    const p = spawnCli(["/bin/sh", "-c", script], { cwd: dir, env, onLine: () => undefined, registry: { dir, runId: "run_2", cellId: "w2" } });
    pids.push(p.pid);
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(dir, "helper.pid")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const helper = Number(readFileSync(join(dir, "helper.pid"), "utf8").trim());
    pids.push(helper);
    const rec = JSON.parse(readFileSync(join(dir, `${p.pid}.json`), "utf8")) as { marker: string };
    expect(cliProcessAlive(p.pid, rec.marker)).toBe(true);
    // The kernel "dies": nobody is left to stop the process, only the record remains. (Its exit handler would remove
    // the record in this same process, so the test keeps a copy as the next kernel would find it.)
    const record = readFileSync(join(dir, `${p.pid}.json`), "utf8");

    const t0 = Date.now();
    const reaped = await reapOrphanedCliProcesses(dir, { graceMs: 300 });
    expect(reaped).toEqual([{ pid: p.pid, cellId: "w2", runId: "run_2", cwd: dir, killed: true }]);
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(cliProcessAlive(p.pid, rec.marker)).toBe(false);
    await p.exited;
    expect(() => process.kill(helper, 0)).toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);

    // A stale record (the pid is gone, or now belongs to someone else) kills nothing and is cleaned up.
    writeFileSync(join(dir, `${process.pid}.json`), record.replace(`"pid":${p.pid}`, `"pid":${process.pid}`));
    expect(await reapOrphanedCliProcesses(dir)).toEqual([{ pid: process.pid, cellId: "w2", runId: "run_2", cwd: dir, killed: false }]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  it("a missing or unreadable record directory is simply empty", async () => {
    expect(await reapOrphanedCliProcesses(join(tmp(), "nope"))).toEqual([]);
    const dir = tmp();
    writeFileSync(join(dir, "123.json"), "{not json");
    expect(await reapOrphanedCliProcesses(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
