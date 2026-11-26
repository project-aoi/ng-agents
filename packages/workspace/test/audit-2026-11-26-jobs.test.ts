import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCellsRoot, hasRepoOrInstructionAncestor, PAYLOAD, type JobResultPayload } from "@ng/protocol";
import { cleanupAll, harness, tempDir } from "./helpers";

afterEach(cleanupAll);

async function waitFor(pred: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("audit 2026-11-26 workspace & jobs fixes (A1, B5, B6, B9-3)", () => {
  it("B6: non-interactive job_start connects stdin to /dev/null (no EOF hang), rejects job_input clearly, and supports interactive: true", async () => {
    const h = harness();
    const work = tempDir("work");
    const port = await h.mgr.acquire("w1", { cwd: work });

    // A command that reads stdin to EOF when stdin is not a TTY would hang forever under stdio:["pipe",fd,fd].
    const { jobId } = await port.startJob({
      command: 'python3 -c "import sys; data = sys.stdin.read(); print(\'EOF_OK:\' + str(len(data)))"',
      timeoutMs: 4_000,
    });
    await waitFor(() => h.inbox.list("w1").some((e) => e.type === PAYLOAD.jobResult && (e.payload as JobResultPayload).jobId === jobId));
    const res = h.inbox.list("w1").find((e) => e.type === PAYLOAD.jobResult && (e.payload as JobResultPayload).jobId === jobId)!.payload as JobResultPayload;
    expect(res.state).toBe("succeeded");
    expect(res.tail).toContain("EOF_OK:0");

    // Non-interactive running job gives an actionable error on writeJobInput.
    const { jobId: sleepy } = await port.startJob({ command: "sleep 10" });
    await expect(port.writeJobInput(sleepy, "hello\n")).rejects.toThrow(/without interactive: true/);
    await port.cancelJob(sleepy);

    // Explicit interactive: true accepts stdin via writeJobInput.
    const { jobId: inter } = await port.startJob({
      command: 'read line; echo "GOT:$line"',
      interactive: true,
      timeoutMs: 4_000,
    });
    await port.writeJobInput(inter, "confirm-yes\n");
    await waitFor(() => h.inbox.list("w1").some((e) => e.type === PAYLOAD.jobResult && (e.payload as JobResultPayload).jobId === inter));
    const interRes = h.inbox.list("w1").find((e) => e.type === PAYLOAD.jobResult && (e.payload as JobResultPayload).jobId === inter)!.payload as JobResultPayload;
    expect(interRes.state).toBe("succeeded");
    expect(interRes.tail).toContain("GOT:confirm-yes");
  });

  it("B5: suppresses false job.warning when stdout is redirected but process group consumes CPU, or when near timeoutMs", async () => {
    const h = harness({ limits: { jobQuietWarningMs: 350, jobPollMs: 40 } });
    const work = tempDir("work");
    const port = await h.mgr.acquire("w1", { cwd: work });
    const redirLog = join(work, "redirected.log");

    // 1) Busy CPU job with stdout redirected away from output.log -> zero quiet warnings!
    const { jobId: cpuJob } = await port.startJob({
      command: `python3 -c "import time; t=time.monotonic()+0.95; x=1\nwhile time.monotonic()<t: x=(x*31+7)%1000003\nprint(x)" > "${redirLog}" 2>&1`,
      timeoutMs: 10_000,
    });
    await waitFor(() => h.inbox.list("w1").some((e) => e.type === PAYLOAD.jobResult && (e.payload as JobResultPayload).jobId === cpuJob), 6_000);
    const cpuWarnings = h.inbox.list("w1").filter((e) => e.type === PAYLOAD.jobWarning && (e.payload as { jobId: string }).jobId === cpuJob);
    expect(cpuWarnings).toEqual([]);

    // 2) Job whose timeoutMs <= jobQuietWarningMs -> zero quiet warning race before timeout!
    const { jobId: shortTimeout } = await port.startJob({
      command: "sleep 5",
      timeoutMs: 350,
    });
    await waitFor(() => h.inbox.list("w1").some((e) => e.type === PAYLOAD.jobResult && (e.payload as JobResultPayload).jobId === shortTimeout), 6_000);
    const timeoutWarnings = h.inbox.list("w1").filter((e) => e.type === PAYLOAD.jobWarning && (e.payload as { jobId: string }).jobId === shortTimeout);
    expect(timeoutWarnings).toEqual([]);

    // 3) Truly idle silent job (0 CPU, ample timeoutMs) still fires job.warning!
    const { jobId: hungJob } = await port.startJob({
      command: "sleep 5",
      timeoutMs: 10_000,
    });
    await waitFor(() => h.inbox.list("w1").some((e) => e.type === PAYLOAD.jobWarning && (e.payload as { jobId: string }).jobId === hungJob), 4_000);
    await port.cancelJob(hungJob);
  });

  it("A1 & B9-3: isolates default cell cwd outside host git/AGENTS.md repo, resolves symlinks, and marks closed workspaces", async () => {
    const rawBase = mkdtempSync(join(tmpdir(), "ngws-hostrepo-"));
    let fallbackDir: string | undefined;
    try {
      const hostRepo = join(rawBase, "host-repo");
      mkdirSync(join(hostRepo, "data"), { recursive: true });
      writeFileSync(join(hostRepo, "AGENTS.md"), "# Host unrelated rules\n");
      execFileSync("git", ["-C", hostRepo, "init", "-q", "-b", "main"]);
      const symlinkedData = join(rawBase, "sym-data");
      symlinkSync(join(hostRepo, "data"), symlinkedData);
      fallbackDir = defaultCellsRoot(symlinkedData);

      const h = harness({ dataDir: symlinkedData });
      const port = await h.mgr.acquire("desk");
      expect(port.root).toBe(realpathSync(port.root));
      expect(hasRepoOrInstructionAncestor(port.root)).toBe(false);
      expect(h.mgr.getWorkspaceSync("desk")?.status).toBe("active");

      h.mgr.markWorkspaceClosedSync("desk");
      expect(h.mgr.getWorkspaceSync("desk")?.status).toBe("closed");
    } finally {
      if (fallbackDir) rmSync(fallbackDir, { recursive: true, force: true });
      rmSync(rawBase, { recursive: true, force: true });
    }
  });
});
