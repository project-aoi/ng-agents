import { existsSync, fstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isNgError, run, validatePayload, type JobResultPayload } from "@ng/protocol";
import { defaultCommandRunner, type CommandRunner } from "../src";
import { cleanupAll, harness, pidGone, waitFor } from "./helpers";

afterEach(cleanupAll);

const finished = (h: { mgr: { getJobSync(id: string): { state: string } | undefined } }, jobId: string) =>
  waitFor(() => {
    const j = h.mgr.getJobSync(jobId);
    return j && j.state !== "running" ? j : undefined;
  });

describe("jobs", () => {
  it("startJob returns at once; on exit exactly one job.result is enqueued with the epoch read at start", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1", "none");
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
    const port = await h.mgr.acquire("w1", "none");
    const { jobId } = await port.startJob({ command: "for i in 1 2 3; do echo step $i; done" });
    await finished(h, jobId);
    const payload = h.inbox.list("w1")[0]!.payload as JobResultPayload;
    expect(payload).toMatchObject({ state: "succeeded", exitCode: 0, logUri: "res://w1/log1" });
    expect(stored).toEqual([{ cellId: "w1", content: "step 1\nstep 2\nstep 3\n" }]);
  });

  it("observeJob shows the tail while running; writeJobInput feeds stdin", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1", "none");
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
    const port = await h.mgr.acquire("w1", "none");
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
    const p1 = await h.mgr.acquire("w1", "none");
    const p2 = await h.mgr.acquire("w2", "none");
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
    const port = await h.mgr.acquire("w1", "none");
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
    const port = await h.mgr.acquire("w1", "none");
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
    const port = await h.mgr.acquire("w1", "none");
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

  it("recover() marks a job whose process died with the old kernel as failed", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1", "none");
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
    await h.mgr.acquire("w1", "none");
    run(
      h.db,
      `INSERT INTO jobs (job_id, cell_id, epoch, command, cwd, state, pid, log_path, stream_preview, started_at, updated_at)
       VALUES ('job_recycled', 'w1', 0, 'make', NULL, 'running', ?, NULL, 0, 1, 1),
              ('job_unstarted', 'w1', 0, 'make', NULL, 'running', NULL, NULL, 0, 1, 1)`,
      [process.pid],
    );
    await h.mgr.recover();
    expect(h.mgr.getJobSync("job_recycled")).toMatchObject({ state: "failed" });
    expect(h.mgr.getJobSync("job_unstarted")!.error).toMatch(/before the job process was started/);
    expect(h.inbox.list("w1").map((e) => e.id).sort()).toEqual(["job_recycled:result", "job_unstarted:result"]);
  });

  it("streamPreview jobs emit job.output chunks", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1", "none");
    const { jobId } = await port.startJob({ command: "echo first; sleep 0.2; echo second", streamPreview: true });
    await finished(h, jobId);
    const text = h.events
      .filter((e) => e.topic === "job.output")
      .map((e) => (e.data as { jobId: string; chunk: string }).chunk)
      .join("");
    expect(text).toBe("first\nsecond\n");
  });

  it("streamPreview includes output written before the preview poller started", async () => {
    // Returns only once the job has written to its log, so the preview always starts after the first output.
    const runner: CommandRunner = {
      spawn(req) {
        const child = defaultCommandRunner.spawn(req);
        const logFd = Array.isArray(req.stdio) ? req.stdio[1] : undefined;
        if (typeof logFd === "number" && req.args.some((a) => a.includes("early-output"))) {
          const deadline = Date.now() + 5_000;
          while (fstatSync(logFd).size === 0 && Date.now() < deadline) {
            // busy-wait: the point is to not yield before the job wrote
          }
        }
        return child;
      },
    };
    const h = harness({ runner });
    const port = await h.mgr.acquire("w1", "none");
    const { jobId } = await port.startJob({ command: "echo early-output; sleep 0.1", streamPreview: true });
    await finished(h, jobId);
    const text = h.events
      .filter((e) => e.topic === "job.output")
      .map((e) => (e.data as { jobId: string; chunk: string }).chunk)
      .join("");
    expect(text).toBe("early-output\n");
  });

  it("enforces ownership, limits and cell state", async () => {
    const h = harness({ limits: { maxJobsPerCell: 1 } });
    const p1 = await h.mgr.acquire("w1", "none");
    const p2 = await h.mgr.acquire("w2", "none");
    const { jobId } = await p1.startJob({ command: "sleep 30" });
    await expect(p1.startJob({ command: "true" })).rejects.toSatisfy((e) => isNgError(e, "conflict"));
    await expect(p2.observeJob(jobId)).rejects.toSatisfy((e) => isNgError(e, "not_found"));
    await expect(p2.cancelJob(jobId)).rejects.toSatisfy((e) => isNgError(e, "not_found"));
    await p1.cancelJob(jobId);
    h.cells.setStatus("w2", "closed");
    await expect(p2.startJob({ command: "true" })).rejects.toSatisfy((e) => isNgError(e, "conflict"));
    await expect(p1.startJob({ command: "  " })).rejects.toSatisfy((e) => isNgError(e, "invalid_argument"));
  });

  it("destroy stops the cell's jobs and removes their logs", async () => {
    const h = harness();
    const port = await h.mgr.acquire("w1", "none");
    const { jobId } = await port.startJob({ command: "sleep 30" });
    const job = h.mgr.getJobSync(jobId)!;
    await h.mgr.destroy("w1");
    expect(h.mgr.getJobSync(jobId)!.state).toBe("cancelled");
    await waitFor(() => pidGone(job.pid!));
    expect(existsSync(dirname(job.logPath!))).toBe(false);
    expect(existsSync(port.root)).toBe(false);
  });
});
