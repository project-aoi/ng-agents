import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupAlive, isNgError, run, validatePayload, type JobRecord, type JobResultPayload } from "@ng/protocol";
import { JOB_MARKER } from "../src";
import { markedAlive, processHasMarker, processInspection, psEnvironment } from "../src/util";
import { AwakeClock } from "../src/jobs";
import { cleanupAll, harness, pidGone, waitFor } from "./helpers";

afterEach(cleanupAll);

const finished = <J extends { state: string }>(h: { mgr: { getJobSync(id: string): J | undefined } }, jobId: string) =>
  waitFor(() => {
    const j = h.mgr.getJobSync(jobId);
    return j && j.state !== "running" ? j : undefined;
  });

describe("jobs", () => {
  it("startJob returns at once; on exit exactly one job.result is enqueued with the epoch read at start", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "sleep 0.3; echo built ok; exit 3" });
    expect(h.mgr.getJobSync(jobId)).toMatchObject({ state: "running", epoch: 0, cellId: "w1", command: "sleep 0.3; echo built ok; exit 3" });
    expect(h.mgr.getJobSync(jobId)!.pid).toBeGreaterThan(0);

    // The cell is cancelled after the job started: the late result must still carry the old epoch, so the real
    // inbox drops it instead of waking the reopened cell.
    h.cells.bumpEpoch("w1");

    const job = await finished(h, jobId);
    expect(job).toMatchObject({ state: "failed", exitCode: 3, resultEnvelopeId: `${jobId}:result` });
    const envs = h.inbox.list("w1");
    expect(envs).toHaveLength(1);
    const env = envs[0]!;
    expect(env).toMatchObject({
      id: `${jobId}:result`,
      from: "kernel:workspace",
      to: "inbox:w1",
      principalId: "cell:w1",
      kind: "result",
      type: "job.result",
      expectedEpoch: 0,
      delivery: "wakeup",
    });
    const payload = env.payload as JobResultPayload;
    expect(payload).toMatchObject({ jobId, state: "failed", exitCode: 3 });
    expect(payload.tail).toContain("built ok");
    expect(validatePayload(env)).toEqual({ ok: true });

    const changes = h.events.filter((e) => e.topic === "job.changed").map((e) => (e.data as { state: string }).state);
    expect(changes).toEqual(["running", "failed"]);
  });

  it("a successful job reports succeeded with exit code 0 and stores its log when a resource writer is given", async () => {
    const stored: Array<{ cellId: string; content: string }> = [];
    const h = harness({
      resources: {
        writeResourceSync: (cellId, content) => {
          stored.push({ cellId, content });
          return `res://${cellId}/log1`;
        },
      },
    });
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "for i in 1 2 3; do echo step $i; done" });
    await finished(h, jobId);
    const payload = h.inbox.list("w1")[0]!.payload as JobResultPayload;
    expect(payload).toMatchObject({ state: "succeeded", exitCode: 0, logUri: "res://w1/log1" });
    expect(stored).toEqual([{ cellId: "w1", content: "step 1\nstep 2\nstep 3\n" }]);
  });

  it("observeJob shows the tail while running; writeJobInput feeds stdin", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "echo ready; read name; echo hello:$name" });
    await waitFor(() => h.mgr.observeJobSync(jobId)?.tail.includes("ready"));
    expect((await port.observeJob(jobId)).state).toBe("running");
    await port.writeJobInput(jobId, "ng\n");
    await finished(h, jobId);
    const obs = await port.observeJob(jobId);
    expect(obs).toEqual({ state: "succeeded", tail: "ready\nhello:ng\n" });
  });

  it("cancelJob records cancelled with one result and kills the whole group, even a SIGTERM-ignoring member", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "trap '' TERM; sleep 30 & echo $! > child.pid; wait" });
    const job = h.mgr.getJobSync(jobId)!;
    await waitFor(() => existsSync(join(port.root, "child.pid")));
    const t0 = performance.now();
    await port.cancelJob(jobId);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(h.mgr.getJobSync(jobId)).toMatchObject({ state: "cancelled", exitCode: null });
    await waitFor(() => pidGone(job.pid!));
    expect(() => process.kill(-job.pid!, 0)).toThrow();
    const envs = h.inbox.list("w1");
    expect(envs).toHaveLength(1);
    expect(envs[0]!.payload).toMatchObject({ state: "cancelled", exitCode: null });
    // The cell cancelled it itself: the result does not wake it again, it rides along with the next batch.
    expect(envs[0]!.delivery).toBe("silent_inject");
    await port.cancelJob(jobId);
    expect(h.inbox.list("w1")).toHaveLength(1);
  });

  it("cancelJobsForCell cancels only that cell's running jobs", async () => {
    const h = harness();
    const p1 = await h.mgr.acquire("w1");
    const p2 = await h.mgr.acquire("w2");
    const a = await p1.startJob({ command: "sleep 30" });
    const b = await p1.startJob({ command: "sleep 30" });
    const c = await p2.startJob({ command: "sleep 30" });
    expect(await h.mgr.cancelJobsForCell("w1")).toBe(2);
    expect(h.inbox.list("w1").map((e) => [e.id, e.delivery, (e.payload as JobResultPayload).state])).toEqual([
      [`${a.jobId}:result`, "wakeup", "cancelled"],
      [`${b.jobId}:result`, "wakeup", "cancelled"],
    ]);
    expect(h.mgr.getJobSync(a.jobId)!.state).toBe("cancelled");
    expect(h.mgr.getJobSync(b.jobId)!.state).toBe("cancelled");
    expect(h.mgr.getJobSync(c.jobId)!.state).toBe("running");
    expect(h.mgr.listJobsSync({ state: ["running"] }).map((j) => j.jobId)).toEqual([c.jobId]);
    await p2.cancelJob(c.jobId);
  });

  it("a failure inside the completion transaction rolls back the row update too; the job is completed exactly once later", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    h.inbox.failNext = 1;
    const { jobId } = await port.startJob({ command: "echo done; exit 7" });
    await waitFor(() => h.inbox.calls >= 1);
    // The row update and the enqueue live in one transaction: neither happened.
    expect(h.mgr.getJobSync(jobId)).toMatchObject({ state: "running", resultEnvelopeId: null });
    expect(h.inbox.list()).toHaveLength(0);
    // The live manager retries on its own.
    await waitFor(() => h.inbox.list().length === 1);
    expect(h.mgr.getJobSync(jobId)).toMatchObject({ state: "failed", exitCode: 7 });
    await h.mgr.recover();
    expect(h.inbox.list()).toHaveLength(1);
  });

  it("if the kernel dies mid-transaction, recover() in the next process finishes the job from its recorded exit status", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    h.inbox.failNext = 1;
    const { jobId } = await port.startJob({ command: "echo partial; exit 7" });
    await waitFor(() => h.inbox.calls >= 1);
    h.mgr.close(); // the kernel is gone before the retry
    expect(h.mgr.getJobSync(jobId)!.state).toBe("running");
    expect(existsSync(join(dirname(h.mgr.getJobSync(jobId)!.logPath!), "exit"))).toBe(true);

    const next = h.restart();
    await next.recover();
    expect(next.getJobSync(jobId)).toMatchObject({ state: "failed", exitCode: 7, resultEnvelopeId: `${jobId}:result` });
    await next.recover();
    const envs = h.inbox.list("w1");
    expect(envs).toHaveLength(1);
    expect((envs[0]!.payload as JobResultPayload).tail).toContain("partial");
  });

  it("recover() re-attaches a job that is still running and delivers its result when it ends", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "sleep 0.5; echo late; exit 0" });
    h.mgr.close();
    const next = h.restart();
    await next.recover();
    expect(next.getJobSync(jobId)!.state).toBe("running");
    const job = await finished({ mgr: next }, jobId);
    expect(job.state).toBe("succeeded");
    const envs = h.inbox.list("w1");
    expect(envs).toHaveLength(1);
    expect((envs[0]!.payload as JobResultPayload).tail).toContain("late");
    // writeJobInput is unavailable after a restart (the stdin pipe died with the old kernel) — documented.
  });

  it.each(["live", "reattached", "already exited"])("waits for background children before publishing the result of a %s job", async (mode) => {
    const h = harness({limits: {killGraceMs: 400}});
    const port = await h.mgr.acquire("w1");
    const body = 'process.on("SIGTERM", () => {}); console.log("helper ready"); setInterval(()=>{}, 1000)';
    const {jobId} = await port.startJob({command: `"${process.execPath}" -e '${body}' & while [ ! -f release ]; do sleep .05; done; exit 7`});
    const job = h.mgr.getJobSync(jobId)!;
    await waitFor(() => readFileSync(job.logPath!, "utf8").includes("helper ready"));
    let mgr = h.mgr;
    if (mode !== "live") {
      h.mgr.close();
      mgr = h.restart();
      if (mode === "reattached") await mgr.recover();
    }
    writeFileSync(join(port.root!, "release"), "");
    await waitFor(() => pidGone(job.pid!));
    expect(groupAlive(job.pid!)).toBe(true);
    expect(mgr.getJobSync(jobId)!.state).toBe("running");
    if (mode === "already exited") await mgr.recover();
    expect(await finished({mgr}, jobId)).toMatchObject({state:"failed", exitCode:7});
    expect(groupAlive(job.pid!)).toBe(false);
    expect(h.inbox.list("w1").filter(e => e.type === "job.result")).toHaveLength(1);
  });

  it("recovers the recorded exit only after a detached system sleep in the original group has gone", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({
      command: "/bin/sleep 30 & echo $! > child.pid; while [ ! -f release ]; do sleep .05; done; exit 7",
    });
    const job = h.mgr.getJobSync(jobId)!;
    await waitFor(() => existsSync(join(port.root, "child.pid")));
    const childPid = Number(readFileSync(join(port.root, "child.pid"), "utf8").trim());
    h.mgr.close();
    writeFileSync(join(port.root, "release"), "");
    await waitFor(() => pidGone(job.pid!));
    expect(pidGone(childPid)).toBe(false);
    const mgr = h.restart();
    const initial = { ...processInspection };
    try {
      if (process.platform === "darwin") {
        processInspection.readEnvironment = pid => pid === childPid ? null : initial.readEnvironment(pid);
      }
      await mgr.recover();
      expect(await finished({mgr}, jobId)).toMatchObject({state: "failed", exitCode: 7});
      expect(pidGone(childPid)).toBe(true);
      expect(h.inbox.list("w1").filter(e => e.type === "job.result")).toHaveLength(1);
    } finally {
      Object.assign(processInspection, initial);
    }
  });

  it("recover() marks a job whose process died with the old kernel as failed", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "sleep 30" });
    const pid = h.mgr.getJobSync(jobId)!.pid!;
    h.mgr.close();
    process.kill(-pid, "SIGKILL");
    await waitFor(() => pidGone(pid));
    const next = h.restart();
    await next.recover();
    expect(next.getJobSync(jobId)).toMatchObject({ state: "failed", exitCode: null });
    expect(next.getJobSync(jobId)!.error).toMatch(/no exit status/);
    expect(h.inbox.list("w1")).toHaveLength(1);
  });

  it("recover() never trusts a recycled pid: a live process without the job marker is neither adopted nor signalled", async () => {
    const h = harness();
    await h.mgr.acquire("w1");
    run(
      h.db,
      `INSERT INTO jobs (job_id, cell_id, epoch, command, cwd, state, pid, process_identity, log_path, started_at, updated_at)
       VALUES ('job_recycled', 'w1', 0, 'make', NULL, 'running', ?, 'different process', NULL, 1, 1),
              ('job_unstarted', 'w1', 0, 'make', NULL, 'running', NULL, NULL, NULL, 1, 1)`,
      [process.pid],
    );
    await h.mgr.recover();
    expect(h.mgr.getJobSync("job_recycled")).toMatchObject({ state: "failed" });
    expect(h.mgr.getJobSync("job_unstarted")!.error).toMatch(/before the job process was started/);
    expect(h.inbox.list("w1").map((e) => e.id).sort()).toEqual(["job_recycled:result", "job_unstarted:result"]);
  });



  it("enforces ownership, limits and cell state", async () => {
    const h = harness({ limits: { maxJobsPerCell: 1 } });
    const p1 = await h.mgr.acquire("w1");
    const p2 = await h.mgr.acquire("w2");
    const { jobId } = await p1.startJob({ command: "sleep 30" });
    await expect(p1.startJob({ command: "true" })).rejects.toSatisfy((e) => isNgError(e, "conflict"));
    await expect(p2.observeJob(jobId)).rejects.toSatisfy((e) => isNgError(e, "not_found"));
    await expect(p2.cancelJob(jobId)).rejects.toSatisfy((e) => isNgError(e, "not_found"));
    await p1.cancelJob(jobId);
    h.cells.setStatus("w2", "closed");
    await expect(p2.startJob({ command: "true" })).rejects.toSatisfy((e) => isNgError(e, "conflict"));
    await expect(p1.startJob({ command: "  " })).rejects.toSatisfy((e) => isNgError(e, "invalid_argument"));
  });

  it("cancelling stops the cell's jobs and waits for them; logs and the directory stay", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "echo started; sleep 30" });
    const job = h.mgr.getJobSync(jobId)!;
    await waitFor(() => readFileSync(job.logPath!, "utf8").includes("started"));
    await h.mgr.cancelJobsForCell("w1");
    // Resolved = recorded AND gone: no window in which the row says cancelled while the process still runs.
    expect(h.mgr.getJobSync(jobId)!.state).toBe("cancelled");
    expect(pidGone(job.pid!)).toBe(true);
    expect(readFileSync(job.logPath!, "utf8")).toContain("started");
    expect(existsSync(port.root)).toBe(true);
  });

  it("a cancel is 'cancelling' (still running, request recorded) until the whole process group is gone", async () => {
    const h = harness({ limits: { killGraceMs: 400 } });
    const port = await h.mgr.acquire("w1");
    // Ignores TERM, so the cancel has to wait out the grace period before SIGKILL.
    const { jobId } = await port.startJob({ command: "trap '' TERM; echo up; sleep 30 & wait" });
    const job = h.mgr.getJobSync(jobId)!;
    await waitFor(() => readFileSync(job.logPath!, "utf8").includes("up"));
    const cancelling = h.mgr.cancelJobsForCell("w1");
    await waitFor(() => h.mgr.getJobSync(jobId)!.cancelRequestedAt !== null);
    const mid = h.mgr.getJobSync(jobId)!;
    // What the dispatcher's write-slot check sees while the process is being killed: a running job.
    expect(mid.state).toBe("running");
    expect(h.mgr.listJobsSync({ cellId: "w1", state: ["running"] }).map((j) => j.jobId)).toEqual([jobId]);
    expect(h.inbox.list("w1")).toHaveLength(0);
    expect(await cancelling).toBe(1);
    expect(h.mgr.getJobSync(jobId)).toMatchObject({ state: "cancelled", error: "cancelled with the cell" });
    expect(() => process.kill(-job.pid!, 0)).toThrow();
    expect(h.inbox.list("w1").map((e) => (e.payload as JobResultPayload).state)).toEqual(["cancelled"]);
    // A second request while (or after) cancelling changes nothing.
    expect(await h.mgr.cancelJobsForCell("w1")).toBe(0);
    expect(h.inbox.list("w1")).toHaveLength(1);
  });

  it("the kernel dies between the cancel request and the kill: recover() kills the survivor before it returns, then records cancelled once", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "trap '' TERM; echo up; sleep 30; exit 0" });
    const job = h.mgr.getJobSync(jobId)!;
    await waitFor(() => readFileSync(job.logPath!, "utf8").includes("up"));
    // The request reached the database, then the process was gone before any signal was sent.
    run(h.db, "UPDATE jobs SET cancel_requested_at = 5, error = 'cancelled with the cell' WHERE job_id = ?", [jobId]);
    h.mgr.close();
    expect(pidGone(job.pid!)).toBe(false);

    const next = h.restart();
    // Still counted as running at startup, so its directory is not handed to another writer yet.
    expect(next.listJobsSync({ state: ["running"] }).map((j) => j.jobId)).toEqual([jobId]);
    await next.recover();
    // Nothing of the job can run any more (the group is empty). In this test the "old kernel" is this very process, so
    // the dead leader lingers as a zombie until Node reaps it — hence the group probe rather than the pid probe.
    await waitFor(() => pidGone(job.pid!));
    expect(() => process.kill(-job.pid!, 0)).toThrow();
    expect(next.getJobSync(jobId)).toMatchObject({ state: "cancelled", error: "cancelled with the cell", resultEnvelopeId: `${jobId}:result` });
    await next.recover();
    expect(h.inbox.list("w1")).toHaveLength(1);
  });

  it("the kernel dies after the kill but before recording it: recover() records cancelled, not a failure", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "sleep 30 & echo ready > started; wait" });
    await waitFor(() => existsSync(join(port.root, "started")));
    const pid = h.mgr.getJobSync(jobId)!.pid!;
    run(h.db, "UPDATE jobs SET cancel_requested_at = 5, error = 'stopped by the owner' WHERE job_id = ?", [jobId]);
    h.mgr.close();
    process.kill(-pid, "SIGKILL");
    await waitFor(() => pidGone(pid) && !groupAlive(pid));
    const next = h.restart();
    await next.recover();
    await waitFor(() => next.getJobSync(jobId)?.state === "cancelled");
    expect(next.getJobSync(jobId)).toMatchObject({ state: "cancelled", error: "stopped by the owner" });
    expect((h.inbox.list("w1")[0]!.payload as JobResultPayload).state).toBe("cancelled");
  });
});

/** Linux's procps prints the same shape as macOS's `ps -E` (command line, then the environment) with BSD-style `eww`. */
function procpsEnvironment(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "latin1", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}

const realPs = process.platform === "darwin" ? psEnvironment : process.platform === "linux" ? procpsEnvironment : null;

describe("process identity without /proc (macOS)", () => {
  const saved = { ...processInspection };
  afterEach(() => {
    Object.assign(processInspection, saved);
  });

  /** Takes the non-/proc path, with `read` standing in for `ps`; returns the pids it was asked about. */
  function withoutProc(read: (pid: number) => string | null): number[] {
    const calls: number[] = [];
    processInspection.useProc = false;
    processInspection.readIdentity = () => null;
    processInspection.readEnvironment = (pid) => {
      calls.push(pid);
      return read(pid);
    };
    return calls;
  }

  it("finds the marker among the environment `ps` appends to the command line, only as a whole NAME=value word", () => {
    // What `ps -E -ww -o command= -p <pid>` prints on macOS: the command line, then the environment, unquoted.
    const line = (env: string) => `/bin/sh -c exitf="$1"; shift; "$@" ng-job /tmp/j/exit /bin/sh -c make test PATH=/usr/bin:/bin HOME=/Users/me ${env} LANG=en_US.UTF-8\n`;
    withoutProc(() => line(`${JOB_MARKER}=job_abc`));
    expect(processHasMarker(process.pid, JOB_MARKER, "job_abc")).toBe(true);
    expect(markedAlive(process.pid, JOB_MARKER, "job_abc")).toBe(true);
    expect(markedAlive(process.pid, JOB_MARKER, "job_ab")).toBe(false);
    withoutProc(() => line(`X${JOB_MARKER}=job_abc`));
    expect(markedAlive(process.pid, JOB_MARKER, "job_abc")).toBe(false);
  });

  it("a recycled pid (alive, but without the marker) is not ours", () => {
    withoutProc(() => "node /usr/local/lib/node_modules/some-tool/cli.js NG_JOB_ID=another PATH=/usr/bin:/bin HOME=/Users/someone\n");
    expect(processHasMarker(process.pid, JOB_MARKER, "job_abc")).toBe(false);
    expect(markedAlive(process.pid, JOB_MARKER, "job_abc")).toBe(false);
  });

  it("distinguishes argv-only SIP output from a readable environment missing our marker", () => {
    processInspection.readCommand = () => "/usr/bin/sleep 30";
    withoutProc(() => "/usr/bin/sleep 30\n");
    expect(processHasMarker(process.pid, JOB_MARKER, "job_abc")).toBeNull();
    withoutProc(() => "/usr/bin/sleep 30 HOME=/Users/test\n");
    expect(processHasMarker(process.pid, JOB_MARKER, "job_abc")).toBe(false);
  });

  it("a live process whose environment cannot be read is not ours; a dead pid is not even looked up", async () => {
    const calls = withoutProc(() => null);
    expect(processHasMarker(process.pid, JOB_MARKER, "job_abc")).toBeNull();
    expect(markedAlive(process.pid, JOB_MARKER, "job_abc")).toBe(false);
    const gone = spawn("true", { stdio: "ignore" });
    await once(gone, "exit");
    calls.length = 0;
    expect(processHasMarker(gone.pid!, JOB_MARKER, "job_abc")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("recover() fails recycled pids immediately, and re-attaches unreadable (null) pids for confirmation without signalling them (BUG-027)", async () => {
    const h = harness();
    await h.mgr.acquire("w1");
    const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
    await once(stranger, "spawn");
    try {
      const probes = withoutProc((pid) => (pid === process.pid ? "node vitest NG_JOB_ID=another PATH=/usr/bin:/bin HOME=/Users/me\n" : null));
      const now = Date.now();
      run(
        h.db,
        `INSERT INTO jobs (job_id, cell_id, epoch, command, cwd, state, pid, log_path, started_at, updated_at)
         VALUES ('job_recycled', 'w1', 0, 'make', NULL, 'running', ?, NULL, ?, ?),
                ('job_unreadable', 'w1', 0, 'make', NULL, 'running', ?, NULL, ?, ?)`,
        [process.pid, now, now, stranger.pid!, now, now],
      );
      await h.mgr.recover();
      expect(h.mgr.getJobSync("job_recycled")).toMatchObject({ state: "failed" });
      await waitFor(() => h.inbox.list("w1").find(e => e.type === "job.warning"));

      expect(h.mgr.getJobSync("job_unreadable")).toMatchObject({ state: "running" });
      expect(h.inbox.list("w1").filter(e => e.id === "job_unreadable:result")).toHaveLength(0);
      expect(pidGone(stranger.pid!)).toBe(false);
      const later = Date.now()+31_000;
      const time = vi.spyOn(Date,"now").mockReturnValue(later);
      try {
        const before = probes.filter(pid => pid === stranger.pid).length;
        await waitFor(() => probes.filter(pid => pid === stranger.pid).length >= before + 3);
        expect(h.mgr.getJobSync("job_unreadable")?.state).toBe("running");
        expect(pidGone(stranger.pid!)).toBe(false);
        expect(h.inbox.list("w1").filter(e=>e.id==="job_unreadable:result")).toHaveLength(0);
        stranger.kill("SIGTERM");
        await once(stranger, "exit");
        await waitFor(() => h.mgr.getJobSync("job_unreadable")?.state === "failed");
      } finally { time.mockRestore(); }
    } finally {
      stranger.kill("SIGKILL");
    }
  });

  it("holds a recovered cancellation while the process identity is unreadable", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "while [ ! -f done ]; do sleep 0.05; done" });
    const pid = h.mgr.getJobSync(jobId)!.pid!;
    try {
      h.mgr.close();
      const calls = withoutProc(() => null);
      const next = h.restart();
      await next.recover();
      await expect(next.cancelJobsForCell("w1")).rejects.toSatisfy(e => isNgError(e, "conflict"));
      const n = calls.length;
      await waitFor(() => calls.length >= n + 5);
      expect(h.inbox.list("w1").filter(e => e.id === `${jobId}:warning:termination_pending`)).toHaveLength(1);
      expect(next.getJobSync(jobId)?.state).toBe("running");
      expect(pidGone(pid)).toBe(false);
      expect(h.inbox.list("w1").filter(e => e.type === "job.result")).toHaveLength(0);
      next.close();
      const again = h.restart();
      await again.recover();
      writeFileSync(join(port.root, "done"), "");
      expect(await finished({ mgr: again }, jobId)).toMatchObject({ state: "cancelled" });
      expect(h.inbox.list("w1").filter(e => e.type === "job.result")).toHaveLength(1);
    } finally {
      writeFileSync(join(port.root, "done"), "");
    }
  });

  it.runIf(realPs !== null)("with the real `ps`: recover() re-attaches a live job by its marker and reports it when it ends", async () => {
    withoutProc(realPs!);
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "while [ ! -f go ]; do sleep 0.05; done; echo late" });
    const pid = h.mgr.getJobSync(jobId)!.pid!;
    expect(markedAlive(pid, JOB_MARKER, jobId)).toBe(true);
    expect(markedAlive(pid, JOB_MARKER, "job_other")).toBe(false);
    expect(markedAlive(process.pid, JOB_MARKER, jobId)).toBe(false);
    h.mgr.close();
    const next = h.restart();
    await next.recover();
    expect(next.getJobSync(jobId)!.state).toBe("running");
    writeFileSync(join(port.root, "go"), "");
    const job = await finished({ mgr: next }, jobId);
    expect(job.state).toBe("succeeded");
    expect((h.inbox.list("w1")[0]!.payload as JobResultPayload).tail).toContain("late");
  });

  it("a re-attached job survives repeated unreadable probes and settles from its exit file", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "while [ ! -f go ]; do sleep 0.05; done" });
    const pid = h.mgr.getJobSync(jobId)!.pid!;
    let failures = 0;
    const calls = withoutProc(() => {
      if (failures > 0) {
        failures--;
        return null;
      }
      return `/bin/sh -c ng-job ${JOB_MARKER}=${jobId} PATH=/usr/bin:/bin`;
    });
    try {
      h.mgr.close();
      const next = h.restart();
      await next.recover();
      expect(next.getJobSync(jobId)!.state).toBe("running");

      failures = 2;
      const n = calls.length;
      await waitFor(() => calls.length >= n + 5);
      expect(failures).toBe(0);
      expect(next.getJobSync(jobId)!.state).toBe("running");

      failures = Number.POSITIVE_INFINITY;
      const before = calls.length;
      await waitFor(() => calls.length >= before + 5);
      expect(next.getJobSync(jobId)!.state).toBe("running");
      expect(pidGone(pid)).toBe(false);
      expect(h.inbox.list("w1").filter(e => e.type === "job.result")).toHaveLength(0);
      writeFileSync(join(port.root, "go"), "");
      expect(await finished({ mgr: next }, jobId)).toMatchObject({ state: "succeeded" });
      expect(h.inbox.list("w1").filter(e => e.type === "job.result")).toHaveLength(1);
    } finally {
      writeFileSync(join(port.root, "go"), "");
      await waitFor(() => pidGone(pid));
    }
  });

  it.runIf(process.platform === "darwin")("macOS: `ps -E` shows a real process's environment", async () => {
    // Use node (non-SIP binary) because macOS SIP strips `ps -E` environments from Apple platform binaries like /bin/sleep.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      env: { ...process.env, NG_TEST_MARK: "mark-123" },
      stdio: "ignore",
    });
    await once(child, "spawn");
    try {
      expect(psEnvironment(child.pid!)).toContain("NG_TEST_MARK=mark-123");
      expect(markedAlive(child.pid!, "NG_TEST_MARK", "mark-123")).toBe(true);
      expect(markedAlive(child.pid!, "NG_TEST_MARK", "other")).toBe(false);
      expect(markedAlive(process.pid, "NG_TEST_MARK", "mark-123")).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
    await once(child, "exit");
    expect(psEnvironment(child.pid!)).toBeNull();
  });
});

describe("job runtime timeout protection (BUG-027)", () => {
  it("warns once for a quiet running job, including across a restart", async () => {
    const h = harness({ limits: { jobQuietWarningMs: 120 } });
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "while [ ! -f done ]; do sleep 0.05; done" });
    try {
      const e = await waitFor(() => h.inbox.list("w1").find(e => e.type === "job.warning"));
      expect(e.payload).toMatchObject({ jobId, reason: "quiet" });
      expect(validatePayload(e).ok).toBe(true);
      h.mgr.close();
      const next = h.restart();
      await next.recover();
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(next.getJobSync(jobId)?.state).toBe("running");
      expect(h.inbox.list("w1").filter(e => e.id === `${jobId}:warning:quiet`)).toHaveLength(1);
      writeFileSync(join(port.root, "done"), "");
      expect(await finished({ mgr: next }, jobId)).toMatchObject({ state: "succeeded" });
    } finally {
      writeFileSync(join(port.root, "done"), "");
    }
  });

  it("kills a runaway job when timeoutMs elapses and wakes the cell with exitCode 124", async () => {
    const h = harness({ limits: { jobTimeoutMs: 250, maxJobTimeoutMs: 5_000, killGraceMs: 200 } });
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "echo started; sleep 30" });
    const pid = h.mgr.getJobSync(jobId)!.pid!;
    expect(h.mgr.getJobSync(jobId)!.timeoutMs).toBe(250);

    const job = await finished(h, jobId);
    expect(job).toMatchObject({ state: "failed", exitCode: 124 });
    expect(job.error).toMatch(/timed out/);
    await waitFor(() => pidGone(pid));
    const envs = h.inbox.list("w1");
    expect(envs).toHaveLength(1);
    expect(envs[0]!.payload).toMatchObject({ jobId, state: "failed", exitCode: 124, error: expect.stringMatching(/timed out/) });
  });

  it("enforces remaining timeoutMs after recover() re-attaches a surviving job", async () => {
    const h = harness({ limits: { jobTimeoutMs: 5_000, maxJobTimeoutMs: 10_000, killGraceMs: 200 } });
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "trap '' TERM; sleep 30; exit 0", timeoutMs: 400 });
    const pid = h.mgr.getJobSync(jobId)!.pid!;
    h.mgr.close();

    const next = h.restart();
    await next.recover();
    expect(next.getJobSync(jobId)!.state).toBe("running");
    const job = await finished({ mgr: next }, jobId);
    expect(job).toMatchObject({ state: "failed", exitCode: 124 });
    expect(job.error).toMatch(/timed out/);
    expect(() => process.kill(-pid, 0)).toThrow();
  });
});

// Audit 2026-11-23 rerun M02: a 6-minute soak test, frozen with the whole host for 92 s, was killed "after 6 minutes" at
// the thaw. A job's time limit is run time: when the timer fires, the time this process stood still since the timer was
// armed is given back. The standstill is simulated where the manager learns of it — its AwakeClock (whose own detection
// is pinned by the E32 test below) — and quiet warnings are off, so the clock's readers are the time-limit timer and, last, the job's result.
describe("a job's time limit does not count time the process stood still (M02)", () => {
  const T = 300;
  const X = 500;
  /** Firings of `setTimeout` may be a few ms early against Date.now (libuv's cached loop time). */
  const SLACK = 50;
  type Row = Pick<JobRecord, "state" | "cancelRequestedAt"> | undefined;
  interface Fire { from: number; to: number; stoodStill: number; after: Promise<Row> }

  /**
   * Watches the manager's AwakeClock: each time-limit firing with the standstill it was told (scripted, or the real
   * clock's answer when `standstills` is null) and the job's row right after the manager acted on it — it decides
   * synchronously (re-arm, or record the kill request), so the next macrotask sees the decision.
   */
  function watchFirings(row: () => Row, standstills: number[] | null) {
    const fires: Fire[] = [];
    const real = AwakeClock.prototype.asleepBetween;
    const spy = vi.spyOn(AwakeClock.prototype, "asleepBetween").mockImplementation(function (this: AwakeClock, from: number, to: number) {
      const stoodStill = standstills ? (standstills.shift() ?? 0) : real.call(this, from, to);
      const after = new Promise<Row>((resolve) => setImmediate(() => {
        const r = row();
        resolve(r && { state: r.state, cancelRequestedAt: r.cancelRequestedAt });
      }));
      fires.push({ from, to, stoodStill, after });
      return stoodStill;
    });
    return { fires, spy };
  }

  const limits = { jobTimeoutMs: T, maxJobTimeoutMs: 5_000, killGraceMs: 200, jobQuietWarningMs: 0 };

  it("a timer that fires after a standstill does not kill the job: it gets that time again, then times out", async () => {
    const h = harness({ limits });
    const port = await h.mgr.acquire("w1");
    let jobId = "";
    const { fires, spy } = watchFirings(() => h.mgr.getJobSync(jobId), [X, 0, X]);
    try {
      const startedAt = Date.now();
      ({ jobId } = await port.startJob({ command: "echo started; sleep 30" }));
      const pid = h.mgr.getJobSync(jobId)!.pid!;
      const job = await finished(h, jobId);
      expect(job).toMatchObject({ state: "failed", exitCode: 124 });
      // The limit it reports is the job's own, not the extended span.
      expect(job.error).toMatch(new RegExp(`timed out after ${T}ms`));
      expect(fires).toHaveLength(3); // two firings, then the result
      const [first, second] = fires as [Fire, Fire, Fire];
      // First firing: T after the job was armed, X of it standing still — the job is left running, no kill requested.
      expect(first.from).toBeGreaterThanOrEqual(startedAt);
      expect(first.to - first.from).toBeGreaterThanOrEqual(T - SLACK);
      expect(first.stoodStill).toBe(X);
      expect(await first.after).toEqual({ state: "running", cancelRequestedAt: null });
      // Re-armed at that firing for X: the second firing comes X later, finds no standstill and kills it.
      expect(second.from).toBeGreaterThanOrEqual(first.to);
      expect(second.to - second.from).toBeGreaterThanOrEqual(X - SLACK);
      expect(second.stoodStill).toBe(0);
      expect((await second.after)?.cancelRequestedAt).not.toBeNull();
      await waitFor(() => pidGone(pid));
      const results = h.inbox.list("w1").filter((e) => e.type === "job.result");
      expect(results).toHaveLength(1);
      expect(results[0]!.payload).toMatchObject({ jobId, state: "failed", exitCode: 124 });
      // Live rerun round 2 (uc27): the result gave wall time only, and a job that ran 344 s of wall time under a
      // 300 s limit was reported to the owner as "the time limit did not take effect". The result says how much of
      // its duration was standstill.
      const payload = results[0]!.payload as { durationMs: number; standstillMs?: number; note?: string };
      expect(payload.standstillMs).toBe(X);
      expect(payload.note).toContain("Only the time the job ran counts against its limit");
    } finally {
      spy.mockRestore();
    }
  });

  // Live rerun round 4 (uc47): a soak frozen for 91 s ended inside its 360 s limit and reported 333 s of wall time
  // with no word about the standstill — only a job whose limit timer had fired said so.
  it("a job that ends inside its limit still says how much of its duration the machine stood still", async () => {
    const h = harness({ limits });
    const port = await h.mgr.acquire("w1");
    const spy = vi.spyOn(AwakeClock.prototype, "asleepBetween").mockReturnValue(700);
    try {
      const { jobId } = await port.startJob({ command: "echo done" });
      expect(await finished(h, jobId)).toMatchObject({ state: "succeeded", exitCode: 0 });
      const [result] = h.inbox.list("w1").filter((e) => e.type === "job.result");
      const payload = result!.payload as { standstillMs?: number; note?: string };
      expect(payload.standstillMs).toBe(700);
      expect(payload.note).toContain("The machine stood still");
    } finally {
      spy.mockRestore();
    }
  });

  it("without a standstill the job is killed when its limit first fires", async () => {
    const h = harness({ limits });
    const port = await h.mgr.acquire("w1");
    let jobId = "";
    const { fires, spy } = watchFirings(() => h.mgr.getJobSync(jobId), null); // the manager's real clock
    try {
      ({ jobId } = await port.startJob({ command: "echo started; sleep 30" }));
      const job = await finished(h, jobId);
      expect(job).toMatchObject({ state: "failed", exitCode: 124 });
      expect(job.error).toMatch(new RegExp(`timed out after ${T}ms`));
      expect(fires).toHaveLength(2); // one firing, then the result
      expect(fires[0]!.to - fires[0]!.from).toBeGreaterThanOrEqual(T - SLACK);
      expect(fires[0]!.stoodStill).toBe(0);
      expect((await fires[0]!.after)?.cancelRequestedAt).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("a job re-attached after a restart gets a standstill back the same way", async () => {
    const h = harness({ limits });
    const port = await h.mgr.acquire("w1");
    const { jobId } = await port.startJob({ command: "echo started; sleep 30", timeoutMs: 400 });
    const pid = h.mgr.getJobSync(jobId)!.pid!;
    h.mgr.close(); // its timer goes with it: every firing below is the new manager's
    const next = h.restart();
    const { fires, spy } = watchFirings(() => next.getJobSync(jobId), [X, 0, X]);
    try {
      await next.recover();
      expect(next.getJobSync(jobId)!.state).toBe("running");
      const job = await finished({ mgr: next }, jobId);
      expect(job).toMatchObject({ state: "failed", exitCode: 124 });
      expect(job.error).toMatch(/timed out after 400ms/);
      expect(fires).toHaveLength(3); // two firings, then the result
      const [first, second] = fires as [Fire, Fire, Fire];
      expect(first.stoodStill).toBe(X);
      expect(await first.after).toEqual({ state: "running", cancelRequestedAt: null });
      expect(second.to - second.from).toBeGreaterThanOrEqual(X - SLACK);
      expect((await second.after)?.cancelRequestedAt).not.toBeNull();
      await waitFor(() => pidGone(pid));
    } finally {
      spy.mockRestore();
    }
  });
});

// Audit 2026-11-23 E32: after the whole host had been frozen for 100 s, a job was reported "no output for 5 minutes" —
// the frozen time was counted as quiet time.
describe("AwakeClock", () => {
  it("counts the spans in which the process itself stood still, and only their part inside the asked window", () => {
    let now = 1_000_000;
    const clock = new AwakeClock(5_000, () => now);
    for (let i = 0; i < 3; i++) {
      now += 5_000;
      clock.beat();
    }
    expect(clock.asleepBetween(1_000_000, now)).toBe(0);
    // A slow beat is a busy event loop, not a frozen process.
    now += 9_000;
    clock.beat();
    expect(clock.asleepBetween(1_000_000, now)).toBe(0);
    // 100 s without a beat: the process did not run for all of it but the one beat that was due.
    const before = now;
    now += 100_000;
    expect(clock.asleepBetween(1_000_000, now)).toBe(95_000);
    expect(clock.asleepBetween(before + 60_000, now)).toBe(40_000);
    expect(clock.asleepBetween(1_000_000, before)).toBe(0);
  });
});
