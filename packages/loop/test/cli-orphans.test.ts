import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupAlive, processInspection, processIdentity } from "@ng/protocol";
import { createCliOwner, cliProcessAlive, cliProcessStatus, probeOrphanCliCell, reapOrphanedCliProcesses, spawnCli } from "../src";

// docs/05 guard 4 + BUG-027: a CLI agent runs in its own process group, so a kernel that is killed leaves it running.
// Every CLI process is on record while it lives; the next kernel inspects it cross-platform (Linux /proc or macOS ps -E)
// and reaps confirmed orphans, cleans gone/recycled records, and preserves records whose identity cannot be read (null).

const dirs: string[] = [];
const pids: number[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ng-cli-procs-"));
  dirs.push(d);
  return d;
}
const origUseProc = processInspection.useProc;
const origReadIdentity = processInspection.readIdentity;
const origReadEnv = processInspection.readEnvironment;
const origListParentChild = processInspection.listParentChild;
afterEach(() => {
  processInspection.useProc = origUseProc;
  processInspection.readIdentity = origReadIdentity;
  processInspection.readEnvironment = origReadEnv;
  processInspection.listParentChild = origListParentChild;
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

describe("orphaned CLI processes (cross-platform 3-state)", () => {
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

  it("preserves the real CLI's TERM handler when a registered shell wrapper is stopped", async () => {
    const dir = tmp();
    const script = "trap 'printf yes > flushed; exit 0' TERM; echo ready; while :; do sleep 30; done";
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const p = spawnCli(["/bin/sh", "-c", script], {
      cwd:dir, env, onLine(line) { if (line === "ready") ready(); },
      registry:{dir, runId:"graceful", cellId:"worker"},
    });
    pids.push(p.pid);
    await started;
    await p.kill(500);
    expect(readFileSync(join(dir, "flushed"), "utf8")).toBe("yes");
    expect(existsSync(join(dir, `${p.pid}.json`))).toBe(false);
  });

  it("what a dead kernel left running is stopped with its whole tree before the call returns — even a TERM-ignoring agent", async () => {
    const dir = tmp();
    // Cross-platform (macOS + Linux): the "agent" ignores SIGTERM and spawns a detached helper child in its own group.
    const js = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });",
      "fs.writeFileSync('agent.pid', String(process.pid));",
      "fs.writeFileSync('helper.pid', String(c.pid));",
      "c.unref();",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const p = spawnCli([process.execPath, "-e", js], { cwd: dir, env, onLine: () => undefined, registry: { dir, runId: "run_2", cellId: "w2" } });
    pids.push(p.pid);
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(dir, "helper.pid")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const helper = Number(readFileSync(join(dir, "helper.pid"), "utf8").trim());
    const agent = Number(readFileSync(join(dir, "agent.pid"), "utf8"));
    pids.push(agent, helper);
    const rec = JSON.parse(readFileSync(join(dir, `${p.pid}.json`), "utf8")) as { marker: string };
    expect(cliProcessStatus(p.pid, rec.marker)).toBe(true);
    expect(cliProcessAlive(p.pid, rec.marker)).toBe(true);
    // The kernel "dies": nobody is left to stop the process, only the record remains.
    const record = readFileSync(join(dir, `${p.pid}.json`), "utf8");

    const t0 = Date.now();
    const reaping = reapOrphanedCliProcesses(dir, { graceMs: 300 });
    await new Promise(r => setTimeout(r, 75));
    expect(() => process.kill(agent, 0)).not.toThrow();
    expect(existsSync(join(dir, `${p.pid}.json`))).toBe(true);
    const reaped = await reaping;
    expect(reaped).toEqual([{ pid: p.pid, cellId: "w2", runId: "run_2", cwd: dir, killed: true, status: "killed" }]);
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(cliProcessStatus(p.pid, rec.marker)).toBe(false);
    expect(cliProcessAlive(p.pid, rec.marker)).toBe(false);
    await p.exited;
    expect(() => process.kill(agent, 0)).toThrow();
    expect(() => process.kill(helper, 0)).toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);

    // A stale record (the pid is gone, or now belongs to someone else) kills nothing and is cleaned up.
    writeFileSync(join(dir, `${process.pid}.json`), record.replace(`"pid":${p.pid}`, `"pid":${process.pid}`));
    expect(await reapOrphanedCliProcesses(dir)).toEqual([{ pid: process.pid, cellId: "w2", runId: "run_2", cwd: dir, killed: false, status: "gone" }]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  it("BUG-027: when a live pid's identity is unreadable (null), reap does NOT kill it and keeps its record on disk", async () => {
    const dir = tmp();
    const record = { pid: process.pid, marker: "run_x", runId: "run_x", cellId: "w3", cwd: dir, startedAt: Date.now() };
    const file = join(dir, `${process.pid}.json`);
    writeFileSync(file, JSON.stringify(record));

    processInspection.useProc = false;
    processInspection.readEnvironment = () => null;
    expect(cliProcessStatus(process.pid, "run_x")).toBeNull();
    const reaped = await reapOrphanedCliProcesses(dir);
    expect(reaped).toEqual([{ pid: process.pid, cellId: "w3", runId: "run_x", cwd: dir, killed: false, status: "unknown" }]);
    expect(probeOrphanCliCell(dir,"w3")).toBe("unknown");
    const identity=processIdentity(process.pid)!;
    expect(identity).toBeTruthy();
    expect(cliProcessStatus(process.pid,"run_x",identity)).toBe(true);
    expect(cliProcessStatus(process.pid,"run_x",identity+"-different")).toBe(false);
    writeFileSync(file,JSON.stringify({...record,unknownSince:Date.now()-31_000}));
    expect(probeOrphanCliCell(dir,"w3")).toBe("clear");
    expect(existsSync(file)).toBe(false);
    expect(()=>process.kill(process.pid,0)).not.toThrow();
  });

  it("a missing or unreadable record directory is simply empty", async () => {
    expect(await reapOrphanedCliProcesses(join(tmp(), "nope"))).toEqual([]);
    const dir = tmp();
    writeFileSync(join(dir, "123.json"), "{not json");
    expect(await reapOrphanedCliProcesses(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("uses the same process identity after the system time zone changes", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Honolulu";
      const first = processIdentity(process.pid);
      expect(first).toBeTruthy();
      process.env.TZ = "Asia/Taipei";
      expect(processIdentity(process.pid)).toBe(first);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("spares a detached descendant whose recorded identity changes before the hard kill", async () => {
    const dir = tmp();
    const helper = [
      'const fs = require("fs");',
      'process.on("SIGTERM", () => fs.writeFileSync("replaced", ""));',
      'fs.writeFileSync("helper", String(process.pid)); setInterval(() => {}, 1000);',
    ].join(" ");
    const leader = spawnCli([process.execPath, "-e", `
      require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(helper)}], {detached:true, stdio:"ignore"});
      setInterval(() => {}, 1000);
    `], { cwd: dir, env, onLine: () => {} });
    pids.push(leader.pid);
    await expect.poll(() => existsSync(join(dir, "helper"))).toBe(true);
    const helperPid = Number(readFileSync(join(dir, "helper"), "utf8"));
    pids.push(helperPid);
    processInspection.readIdentity = pid => pid === helperPid && existsSync(join(dir, "replaced"))
      ? "different process" : origReadIdentity(pid);
    await leader.kill(150);
    expect(existsSync(join(dir, "replaced"))).toBe(true);
    expect(() => process.kill(helperPid, 0)).not.toThrow();
  });

  it("distinguishes live and stopped kernel instances sharing one process and cell", async () => {
    const dir = tmp();
    const active = createCliOwner();
    const prior = createCliOwner();
    const launch = (ownerInstanceId: string, runId: string) => spawnCli([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      cwd: dir, env, onLine: () => undefined, registry: { dir, runId, cellId: "worker", ownerInstanceId },
    });
    const healthy = launch(active.ownerInstanceId, "run_live");
    const orphan = launch(prior.ownerInstanceId, "run_old");
    pids.push(healthy.pid, orphan.pid);
    try {
      const options = { cellId: "worker", ownerInstanceId: active.ownerInstanceId, graceMs: 100 };
      expect((await reapOrphanedCliProcesses(dir, options)).map(r => r.status)).toEqual(["owned"]);
      expect(probeOrphanCliCell(dir, "worker", options)).toBe("unknown");
      prior.release();
      expect((await reapOrphanedCliProcesses(dir, options)).map(r => [r.pid, r.status])).toEqual([[orphan.pid, "killed"]]);
      expect(probeOrphanCliCell(dir, "worker", options)).toBe("clear");
      expect(existsSync(join(dir, `${healthy.pid}.json`))).toBe(true);
      await healthy.kill(100);
    } finally {
      active.release();
      prior.release();
    }
  });

  it("reaps a marked helper remaining in a group whose leader already exited", async () => {
    const dir = tmp();
    const helper = 'process.on("SIGTERM", () => {}); require("fs").writeFileSync("ready", String(process.pid)); setInterval(() => {}, 1000)';
    const leader = spawn(process.execPath, ["-e", `
      const child = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(helper)}], {stdio:"ignore"});
      child.unref();
    `], { cwd: dir, env: {...env, NG_CLI_PROC:"leftover"}, detached:true, stdio:"ignore" });
    const pid = leader.pid!;
    pids.push(pid);
    await once(leader, "exit");
    await expect.poll(() => existsSync(join(dir, "ready"))).toBe(true);
    pids.push(Number(readFileSync(join(dir, "ready"), "utf8")));
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({pid, marker:"leftover", runId:"run", cellId:"w", cwd:dir}));
    expect(probeOrphanCliCell(dir, "w")).toBe("alive");
    expect((await reapOrphanedCliProcesses(dir, { graceMs: 100 }))[0]?.status).toBe("killed");
    expect(groupAlive(pid)).toBe(false);
  });
});
