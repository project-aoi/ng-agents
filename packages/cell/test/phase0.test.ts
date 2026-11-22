import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isNgError,
  PAYLOAD,
  processInspection,
  type ApprovalResolvedPayload,
  type ApprovalRevisePayload,
  type ChannelSendAction,
  type JobResultPayload,
} from "@ng/protocol";
import { boot, cleanupAll, sleep, tempDir, tool, waitFor } from "./helpers";

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

  it("BUG-020: resolveApproval checks actor, ownerOnly, version and itemRevision BEFORE consulting inflight", async () => {
    const h = await boot();
    h.script.add("desk", tool("send_message", { to: "channel:memory:alice", text: "草稿 v1", summary: "reply to Alice" }));
    await h.memory.inject({ from: "alice", text: "在吗" });
    await h.kernel.idle();
    const [card] = h.kernel.gate.listPendingSync();
    expect(card).toBeDefined();

    // Missing/blank approverId throws invalid_argument immediately.
    await expect(h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "" })).rejects.toSatisfy((e) =>
      isNgError(e, "invalid_argument"),
    );

    // Hold the real send in flight using a deterministic gate on memory.deliver.
    let releaseSend!: () => void;
    let sendStarted!: () => void;
    const inFlight = new Promise<void>((r) => (sendStarted = r));
    const gateSend = new Promise<void>((r) => (releaseSend = r));
    const origDeliver = h.memory.deliver.bind(h.memory);
    h.memory.deliver = async (req) => {
      sendStarted();
      await gateSend;
      return origDeliver(req);
    };
    const ownerSend = h.kernel.resolveApproval(card!.actionId, {
      decision: "approve",
      approverId: "owner",
      seenArtifactVersion: 1,
      seenItemRevision: card!.itemRevision,
    });
    await inFlight;

    // While owner's send is actively in-flight:
    // 1) agent:* must be rejected with bounds_violation (NOT piggyback on owner's in-flight promise!)
    await expect(
      h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "agent:main", seenArtifactVersion: 1 }),
    ).rejects.toSatisfy((e) => isNgError(e, "bounds_violation"));

    // 2) owner with wrong seenArtifactVersion must be rejected with version_mismatch!
    expect(
      await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 99 }),
    ).toMatchObject({ status: "version_mismatch", currentVersion: 1 });

    // 3) owner with wrong seenItemRevision must be rejected with revision_mismatch!
    expect(
      await h.kernel.resolveApproval(card!.actionId, {
        decision: "approve",
        approverId: "owner",
        seenArtifactVersion: 1,
        seenItemRevision: 999,
      }),
    ).toMatchObject({ status: "revision_mismatch" });

    // A second tab saw v2 while the first tab was already sending v1.
    h.kernel.context.commitSync("desk", { artifact: { artifactId: card!.artifactId!, expectedVersion: 1, updatedBy: "human", content: { format: "text", body: "late v2" } } });
    expect(await h.kernel.resolveApproval(card!.actionId, {
      decision: "approve", approverId: "owner", seenArtifactVersion: 2, seenItemRevision: card!.itemRevision,
    })).toMatchObject({ status: "version_mismatch", currentVersion: 2 });

    // Owner's original send completes cleanly once.
    releaseSend();
    expect(await ownerSend).toMatchObject({ status: "sent", artifactVersion: 1 });
    expect(h.memory.deliveries).toHaveLength(1);
  });

  it("BUG-028: 3-step Saga forwards known external delivery to live parent if the issuing child cell closed mid-flight", async () => {
    const h = await boot();
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", bounds: { canSendTo: ["channel:memory:*"] } });
    h.script.add("worker", tool("send_message", { to: "channel:memory:bob", text: "给 Bob 的回复", summary: "reply Bob" }));
    h.kernel.inbox.enqueueSync("w", {
      id: "go",
      from: "inbox:desk",
      principalId: "cell:desk",
      kind: "event",
      type: PAYLOAD.userMessage,
      payload: { text: "go" },
      createdAt: h.clock.now(),
    });
    await h.kernel.idle();
    const [card] = h.kernel.gate.listPendingSync();
    expect(card!.cellId).toBe("w");

    // Hold the send in flight; close child cell "w" while the external send is mid-flight!
    let releaseSend!: () => void;
    let sendStarted!: () => void;
    const inFlight = new Promise<void>((r) => (sendStarted = r));
    const gateSend = new Promise<void>((r) => (releaseSend = r));
    const origDeliver = h.memory.deliver.bind(h.memory);
    h.memory.deliver = async (req) => {
      sendStarted();
      await gateSend;
      return origDeliver(req);
    };
    h.script.add("desk", { text: "noted forwarded delivery" });
    const sending = h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 });
    await inFlight;
    await h.kernel.closeCell("w", "cancelled", { principalId: "owner" });
    expect(h.kernel.getCell("w")!.status).toBe("closed");

    // External send finishes sent — receipt is preserved and forwarded to live parent ("desk")!
    releaseSend();
    expect(await sending).toMatchObject({ status: "sent", artifactVersion: 1 });
    expect(h.kernel.gate.getApprovalSync(card!.actionId)!.status).toBe("executed");
    const forwarded = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.envelope.payload).toMatchObject({ actionId: card!.actionId, status: "executed", outcome: { receipt: "sent" } });
    await h.kernel.idle();
  });

  it("BUG-028: resolveUnknownSend requires owner, wakes the owning cell (not silent) and carries the user's note", async () => {
    const h = await boot();
    h.script.add("desk", tool("send_message", { to: "channel:memory:alice", text: "草稿", summary: "reply Alice" }));
    await h.memory.inject({ from: "alice", text: "hi" });
    await h.kernel.idle();
    const [card] = h.kernel.gate.listPendingSync();

    h.memory.respondWith("unknown");
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({
      status: "unknown",
    });

    // External agent cannot resolve unknown send.
    expect(() => h.kernel.resolveUnknownSend(card!.actionId, "sent", { approverId: "agent:main", seenAttempt: 1, seenItemRevision: h.kernel.gate.getApprovalSync(card!.actionId)!.itemRevision, note: "nope" })).toThrow(/needs the owner/);

    // Owner verifies → wakes desk with delivery: "wakeup" and forwards the note!
    let sawNote = false;
    h.script.add("desk", (req) => {
      if (JSON.stringify(req.messages).includes("我在飞书确认对方已收到")) sawNote = true;
      return { text: "ok" };
    });
    expect(h.kernel.resolveUnknownSend(card!.actionId, "sent", { approverId: "owner", seenAttempt: 1, seenItemRevision: h.kernel.gate.getApprovalSync(card!.actionId)!.itemRevision, note: "我在飞书确认对方已收到" })).toBe("resolved");
    const envs = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved });
    const verifyEnv = envs.find((m) => (m.envelope.payload as ApprovalResolvedPayload).status === "executed");
    expect(verifyEnv).toBeDefined();
    expect(verifyEnv!.envelope.delivery).toBe("wakeup");
    expect(verifyEnv!.envelope.payload).toMatchObject({ status: "executed", note: "我在飞书确认对方已收到" });
    await h.kernel.idle();
    expect(sawNote).toBe(true);
  });

  it("BUG-028 + BUG-021: retry failure receipts carry attemptSeq (:a1, :a2) so consecutive failures are not deduplicated away", async () => {
    const h = await boot();
    h.script.add("desk", tool("send_message", { to: "channel:memory:alice", text: "草稿", summary: "reply Alice" }));
    await h.memory.inject({ from: "alice", text: "hi" });
    await h.kernel.idle();
    const [card] = h.kernel.gate.listPendingSync();

    h.memory.respondWith("failed").respondWith("failed");
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({ status: "failed" });
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({ status: "failed" });
    const failedMsgs = h.kernel.inbox
      .listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved })
      .filter((m) => (m.envelope.payload as ApprovalResolvedPayload).status === "failed");
    expect(failedMsgs).toHaveLength(2);
    expect(failedMsgs.map((m) => m.envelope.id)).toEqual([`${card!.actionId}:resolved:failed:a1`, `${card!.actionId}:resolved:failed:a2`]);
  });

  it("BUG-028: reconcile() delivers missing approval.resolved for non-channel.send approved cards on restart", async () => {
    const dataDir = tempDir("reconcile-non-send");
    const a = await boot({ dataDir });
    a.script.add("desk", tool("request_approval", { kind: "action", title: "合入变更", summary: "merge pr", action: { name: "merge_pr", args: { pr: 42 } } }));
    await a.ui.capture({ text: "帮我合入 PR 42" });
    await a.kernel.idle();
    const [card] = a.kernel.gate.listPendingSync();
    expect(card!.action.type).toBe("custom");
    // Simulate a crash right after approveSync committed but before approval.resolved landed in inbox:
    expect(a.kernel.gate.approveSync(card!.actionId, "owner")).toBe("approved");
    expect(a.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved })).toEqual([]);
    await a.kernel.close();

    // Second boot runs reconcile() → delivers approval.resolved for the non-send approved card!
    const b = await boot({ dataDir, desk: false, start: false });
    b.script.add("desk", { text: "merging PR 42" });
    await b.kernel.start();
    await b.kernel.idle();
    const msgs = b.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ status: "done" });
    expect(msgs[0]!.envelope.payload).toMatchObject({ actionId: card!.actionId, status: "approved" });

    // Third boot: deduped row is already 'done', reconcile() accepts it cleanly with no errors.
    await b.kernel.close();
    const errs: unknown[] = [];
    const c = await boot({ dataDir, desk: false, start: false, kernel: { onError: (e) => errs.push(e) } });
    await c.kernel.start();
    await c.kernel.idle();
    expect(errs).toEqual([]);
  });

  it("BUG-028: continue checks approveSync before raising budget (stale seenItemRevision never raises budget)", async () => {
    const h = await boot();
    h.script.add("worker", { text: "thinking hard", usage: { inputTokens: 600, outputTokens: 600 } });
    h.kernel.spawnCell("desk", { id: "w", preset: "worker", title: "跑任务", bounds: { maxTokens: 1_000 } }, "go");
    await h.kernel.idle();
    const [card] = h.kernel.gate.listPendingSync();
    expect(h.kernel.gate.usageSync("w").raisedTokens).toBe(0);

    // Stale seenItemRevision must NOT raise the cell's budget!
    const res = await h.kernel.resolveApproval(card!.actionId, {
      decision: "continue",
      approverId: "owner",
      raise: { tokens: 5_000 },
      seenItemRevision: 999,
    });
    expect(res).toMatchObject({ status: "revision_mismatch", currentRevision: card!.itemRevision });
    expect(h.kernel.gate.usageSync("w").raisedTokens).toBe(0);
    expect(h.kernel.gate.getApprovalSync(card!.actionId)!.status).toBe("pending");
  });

  it("BUG-021: approval.revise and approval.resolved attach compact humanDiff (<= 1500 chars) when human edited the draft", async () => {
    const h = await boot();
    h.script.add("desk", tool("send_message", { to: "channel:memory:alice", text: "第一行\n旧的第二行\n第三行", summary: "reply Alice" }));
    await h.memory.inject({ from: "alice", text: "问个事" });
    await h.kernel.idle();
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
    ).toMatchObject({ status: "sent", artifactVersion: 2 });
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

  it("Review fixes: failed send retry after editing draft v1->v2 sends v2 via fresh token & :retry: row; inspect_cell exposes resumeAfterSeq", async () => {
    const h = await boot();
    h.kernel.context.commitSync("desk", {
      artifact: { artifactId: "art_retry_edit", content: { format: "markdown", body: "v1 body" }, updatedBy: "agent" },
    });
    const sendAction: ChannelSendAction = {
      type: "channel.send",
      target: "channel:memory:alice",
      content: { format: "markdown", body: "v1 body" },
      summary: "发给 Alice",
      subjectKey: "send:alice:retryedit",
      sideEffect: "external",
      artifactId: "art_retry_edit",
      card: { format: "markdown", title: "确认发送", body: "发给 Alice" },
    };
    const auth = h.kernel.gate.authorizeSync(sendAction, { cellId: "desk", principalId: "cell:desk", epoch: 0, artifactVersion: 1 });
    expect(auth.type).toBe("defer");
    const actionId = auth.type === "defer" ? auth.actionId : "";

    // Attempt 1 fails transport.
    h.memory.respondWith("failed");
    h.script.add("desk", { text: "noted failure" });
    expect(await h.kernel.resolveApproval(actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({
      status: "failed",
      artifactVersion: 1,
    });
    await h.kernel.idle();

    // Owner edits draft to v2 before retrying.
    h.kernel.context.commitSync("desk", {
      artifact: { artifactId: "art_retry_edit", expectedVersion: 1, content: { format: "markdown", body: "v2 edited body" }, updatedBy: "human" },
    });
    // Retry with stale v1 first → version_mismatch and gate rebinds boundVersion -> 2 & bumps itemRevision!
    const revBefore = h.kernel.gate.getApprovalSync(actionId)!.itemRevision;
    expect(await h.kernel.resolveApproval(actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({
      status: "version_mismatch",
      currentVersion: 2,
    });
    expect(h.kernel.gate.getApprovalSync(actionId)!.boundVersion).toBe(2);
    expect(h.kernel.gate.getApprovalSync(actionId)!.itemRevision).toBe(revBefore + 1);

    // Retry with v2 succeeds and delivers v2 edited body!
    h.memory.respondWith("sent");
    h.script.add("desk", { text: "sent v2" });
    expect(await h.kernel.resolveApproval(actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 2 })).toMatchObject({
      status: "sent",
      artifactVersion: 2,
    });
    expect(h.memory.deliveries.at(-1)?.content.body).toBe("v2 edited body");
    expect(h.kernel.hub.getLatestOutboxByActionSync(actionId)?.idempotencyKey).toContain(":retry:");

    // Cancelled card returns already_cancelled (not version_mismatch) even when draft changed.
    const auth2 = h.kernel.gate.authorizeSync(
      { ...sendAction, subjectKey: "send:alice:cancel", card: { format: "markdown", title: "确认发送2", body: "s2" } },
      { cellId: "desk", principalId: "cell:desk", epoch: 0, artifactVersion: 2 },
    );
    const aid2 = auth2.type === "defer" ? auth2.actionId : "";
    h.kernel.gate.withdrawSync(aid2, "withdrawn");
    expect(await h.kernel.resolveApproval(aid2, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({
      status: "already_cancelled",
    });

    // inspect_cell truncation returns resumeAfterSeq matching the footer.
    for (let i = 1; i <= 40; i++) {
      h.kernel.context.appendEvidenceSync("desk", { runId: null, kind: "assistant_text", text: `line-${i}: ${"z".repeat(80)}`, at: h.clock.now() + i });
    }
    const insp = h.kernel.inspectCell("desk", { detail: "summary", afterSeq: 0, maxChars: 1200 });
    expect(insp.more).toBe(true);
    expect(insp.resumeAfterSeq).toBeTypeOf("number");
    expect(insp.text).toContain(`afterSeq ${insp.resumeAfterSeq}`);
  });

  it("Review fixes: reconcile skips non-send approved cards for closed cells, and desk-held escalation for a closed child can still be dismissed", async () => {
    const dataDir = tempDir("reconcile-closed");
    const a = await boot({ dataDir });
    a.kernel.spawnCell("desk", { id: "c1", preset: "worker" });

    // Non-send approval on c1 that becomes approved, then c1 is closed before restart.
    const auth = a.kernel.gate.authorizeSync(
      {
        type: "custom",
        name: "deploy.preview",
        args: {},
        summary: "preview",
        subjectKey: "sub:c1",
        sideEffect: "external",
        card: { format: "markdown", title: "preview", body: "preview" },
      },
      { cellId: "c1", principalId: "cell:c1", epoch: 0 },
    );
    const aid = auth.type === "defer" ? auth.actionId : "";
    a.kernel.gate.approveSync(aid, "owner");
    await a.kernel.closeCell("c1", "cancelled", { principalId: "owner" });
    await a.kernel.close();

    // Restart: reconcile() must NOT forward c1's non-send approval to desk!
    const b = await boot({ dataDir, desk: false, start: false });
    await b.kernel.start();
    const forwarded = b.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved }).filter((m) =>
      m.envelope.id.startsWith(`${aid}:`),
    );
    expect(forwarded).toHaveLength(0);

    // Desk-held kernel escalation pointing at closed child c1 can still be dismissed cleanly.
    const esc = b.kernel.gate.authorizeSync(
      {
        type: "custom",
        name: "kernel.escalation",
        args: { reason: "retry_limit", cellId: "c1" },
        summary: "c1 stuck",
        subjectKey: "esc:c1",
        sideEffect: "external",
        card: { format: "markdown", title: "c1 stuck", body: "c1 stuck" },
      },
      { cellId: "desk", principalId: "kernel:escalation", epoch: 0 },
    );
    const escId = esc.type === "defer" ? esc.actionId : "";
    expect(await b.kernel.resolveApproval(escId, { decision: "dismiss", approverId: "owner" })).toMatchObject({ status: "dismissed" });
  });
});
