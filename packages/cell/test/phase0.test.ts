import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isNgError,
  PAYLOAD,
  processInspection,
  type ApprovalResolvedPayload,
  type ApprovalRevisePayload,
  type JobResultPayload,
} from "@ng/protocol";
import { boot, cleanupAll, sleep, tempDir, waitFor } from "./helpers";

afterEach(async () => {
  processInspection.useProc = origUseProc;
  processInspection.readEnvironment = origReadEnv;
  await cleanupAll();
});

const origUseProc = processInspection.useProc;
const origReadEnv = processInspection.readEnvironment;

describe("Phase 0 (@ng/cell) — BUG-020, BUG-027, BUG-028, BUG-034", () => {
  it("opens a second kernel for inspection of the same data directory", async () => {
    const first = await boot({ start: false });
    const reader = await boot({ dataDir: first.dataDir, start: false });
    expect(reader.kernel.getCell("desk")?.id).toBe("desk");
  });

  it("BUG-020: closeCell physically forbids closing the root cell", async () => {
    const h = await boot();
    await expect(h.kernel.closeCell("desk", "cancelled", { principalId: "owner" })).rejects.toSatisfy((e) =>
      isNgError(e, "bounds_violation"),
    );
    expect(h.kernel.getCell("desk")!.status).toBe("active");
  });

  it("BUG-021: approval.revise and approval.resolved attach compact humanDiff (<= 1500 chars) when human edited the draft", async () => {
    const h = await boot();
    h.kernel.context.commitSync("desk", {artifact:{artifactId:"draft",content:{format:"text",body:"第一行\n旧的第二行\n第三行"},updatedBy:"agent"}});
    h.kernel.gate.authorizeSync({type:"custom",name:"review",summary:"审阅草稿",subjectKey:"plan",artifactId:"draft",sideEffect:"external"}, {cellId:"desk",epoch:0,principalId:"cell:desk"});
    const [card] = h.kernel.gate.listPendingSync();

    // Human edits draft v1 -> v2.
    expect(
      h.kernel.context.commitSync("desk", {
        artifact: {
          artifactId: card!.artifactId!,
          content: { format: "text", body: "第一行\n主人改过的第二行\n第三行" },
          updatedBy: "human",
          expectedVersion: 1,
        },
      }),
    ).toMatchObject({ ok: true, artifactVersion: 2 });

    // Revise carries humanEdited: true and humanDiff!
    h.script.add("desk", { text: "saw human diff" });
    expect(
      await h.kernel.resolveApproval(card!.actionId, { decision: "revise", approverId: "owner", instruction: "把第三行也润色下" }),
    ).toMatchObject({ status: "revising" });
    await h.kernel.idle();
    const [reviseMsg] = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalRevise });
    const revPayload = reviseMsg!.envelope.payload as ApprovalRevisePayload;
    expect(revPayload.humanEdited).toBe(true);
    expect(revPayload.humanDiff).toContain("- 旧的第二行");
    expect(revPayload.humanDiff).toContain("+ 主人改过的第二行");
    expect(revPayload.humanDiff!.length).toBeLessThanOrEqual(1_500);

    // Approve v2 → approval.resolved also carries humanEdited: true and humanDiff!
    h.script.add("desk", { text: "noted" });
    expect(
      await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 2 }),
    ).toMatchObject({ status: "approved" });
    await h.kernel.idle();
    const [resMsg] = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved });
    const resPayload = resMsg!.envelope.payload as ApprovalResolvedPayload;
    expect(resPayload.humanEdited).toBe(true);
    expect(resPayload.humanDiff).toContain("- 旧的第二行");
    expect(resPayload.humanDiff).toContain("+ 主人改过的第二行");
  });

  it("BUG-034: inspect_cell preserves tail-200 + [res://...] on errors, formats job.result/approval.resolved cleanly, and keeps head 20% + tail 80% on truncation", async () => {
    const h = await boot();
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", title: "排查" });
    const ctx = h.kernel.context;

    // 1) Long error tool_result with a [res://...] pointer at the end.
    const bigErr = `${"noise-prefix-".repeat(60)}ROOT_CAUSE_ASSERTION_FAILED at line 99 [res://w/err_1]`;
    ctx.appendEvidenceSync("w", { runId: null, kind: "tool_result", name: "bash", toolUseId: "tu1", output: bigErr, isError: true, at: h.clock.now() });

    // 2) job.result inbound envelope.
    const jobPayload: JobResultPayload = { jobId: "job_7", command: "pnpm test", state: "failed", exitCode: 124, tail: "timed out", error: "timed out after 30s" };
    ctx.appendEvidenceSync("w", {
      runId: null,
      kind: "inbound",
      envelope: { id: "job_7:result", from: "kernel:workspace", principalId: "cell:w", kind: "result", type: PAYLOAD.jobResult, payload: jobPayload, createdAt: h.clock.now() },
      at: h.clock.now(),
    });

    // 3) approval.resolved inbound envelope.
    const appPayload: ApprovalResolvedPayload = {
      actionId: "act_9",
      status: "executed",
      action: { type: "custom", name: "deploy", summary: "发布", subjectKey: "s", sideEffect: "external" },
      approverId: "owner",
      humanEdited: true,
      note: "已核实",
    };
    ctx.appendEvidenceSync("w", {
      runId: null,
      kind: "inbound",
      envelope: { id: "act_9:resolved", from: "kernel:approval", principalId: "owner", kind: "result", type: PAYLOAD.approvalResolved, payload: appPayload, createdAt: h.clock.now() },
      at: h.clock.now(),
    });

    const summary = h.kernel.inspectCell("w", { detail: "summary", afterSeq: 0 });
    expect(summary.text).toContain("ROOT_CAUSE_ASSERTION_FAILED at line 99");
    expect(summary.text).toContain("[res://w/err_1]");
    expect(summary.text).toContain("job job_7 failed (exit 124): pnpm test");
    expect(summary.text).toContain('approval act_9 executed "发布" · note: 已核实');

    // 4) Over-maxChars truncation keeps head 20% + omitted marker + tail 80% (preserving recent records at the tail!).
    for (let i = 1; i <= 40; i++) {
      ctx.appendEvidenceSync("w", { runId: null, kind: "assistant_text", text: `step-${i}: ${"x".repeat(80)}`, at: h.clock.now() + i });
    }
    const truncated = h.kernel.inspectCell("w", { detail: "summary", afterSeq: 0, maxChars: 1200 });
    expect(truncated.text).toContain("omitted");
    expect(truncated.text).toContain("step-40:");
    expect(truncated.text).toContain("step-39:");
    // Tail portion is substantially larger than head portion (~80% vs ~20%).
    const omitIdx = truncated.text.indexOf("omitted");
    expect(omitIdx).toBeGreaterThan(0);
    expect(truncated.text.length - omitIdx).toBeGreaterThan(omitIdx * 2);
  });

  it("BUG-027: dispatcher defers a cell with an unknown-identity CLI orphan until re-probe clears it", async () => {
    const dataDir = tempDir("orphan-hold");
    const cliProcDir = join(dataDir, "cli-procs");
    mkdirSync(cliProcDir, { recursive: true });

    // Seed a cell "w" first, then stop kernel.
    const a = await boot({ dataDir });
    a.kernel.spawnCell("desk", { id: "w", preset: "worker" });
    await a.kernel.close();

    // Plant an orphan CLI record for cell "w" pointing at a live PID whose identity cannot be read (null).
    writeFileSync(
      join(cliProcDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, marker: "run_orphan", runId: "run_orphan", cellId: "w", cwd: dataDir, startedAt: Date.now() }),
    );
    processInspection.useProc = false;
    processInspection.readEnvironment = () => null;

    const b = await boot({ dataDir, desk: false, start: false });
    b.script.add("worker", { text: "finally ran" });
    await b.kernel.start();
    b.kernel.inbox.enqueueSync("w", {
      id: "wake-w",
      from: "inbox:desk",
      principalId: "cell:desk",
      kind: "event",
      type: PAYLOAD.userMessage,
      payload: { text: "work now" },
      createdAt: b.clock.now(),
    });
    // While identity stays unreadable (null), "w" must NOT be dispatched!
    await sleep(150);
    expect(b.of("run.started").filter((e) => e.cellId === "w")).toHaveLength(0);

    // Now the orphan exits / PID is recycled (readEnvironment shows unrelated env) → re-probe clears hold & dispatches "w"!
    processInspection.readEnvironment = () => "node unrelated NG_CLI_PROC=unrelated PATH=/usr/bin";
    await waitFor(() => b.of("run.finished").some((e) => e.cellId === "w"), 5_000, "w dispatched after orphan cleared");
    expect(b.of("run.finished").filter((e) => e.cellId === "w")[0]!.outcome).toBe("completed");
  });

});
