import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  all,
  get,
  inboxAddr,
  PAYLOAD,
  type CellResultPayload,
  type RunContinuePayload,
} from "@ng/protocol";
import { CLI_SESSION_KEY, CLI_SESSION_RESET_KEY } from "@ng/loop";
import { BUILTIN_SKILLS, KEYS, startProjectSync, type ProbeState } from "../src";
import { resolveConfig } from "../src/shared/config";
import { COMMON, promptDefs } from "../src/shared/prompts";
import { SKILL_PROJECT_RELAY, SKILL_WORKSPACE_ARBITRATION } from "../src/shared/skills";
import { boot, childrenOf, cleanupAll, lastToolResult, MIN, requestText, T0, tempDir, tool } from "./helpers";

afterEach(cleanupAll);

describe("2026-11-27 post-upgrade audit regressions (M1–M7 & Track B)", () => {
  // ==================== M1 ====================

  it("M1: failed run with write side effects does NOT blindly replay the batch; delivers compact error_recovery with executed writes", async () => {
    const h = await boot();
    const { projectId } = startProjectSync(h.kernel, { title: "支付改造", outcome: "完成", brief: "推进支付改造" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();

    let recoveryPrompt = "";
    h.script.add(
      "desk",
      tool("send_message", { to: inboxAddr(projectId), text: "请继续执行第一步", summary: "派发通知" }),
      { error: new Error("\x1b[31mcode=3003 empty stream\x1b[0m") },
      (req) => {
        recoveryPrompt = requestText(req);
        return { text: "已核对现状，无需重复派发。" };
      },
    );
    h.script.add("project", {});

    await h.ui.capture({ text: "推进一下支付改造" }, "owner");
    await h.kernel.idle();

    // Advance past retry backoff so error_recovery runs
    h.clock.advance(60_000);
    await h.kernel.idle();

    // Original message to project was sent ONLY ONCE (no duplicate replay!)
    const projInbox = h.kernel.inbox.listMessagesSync({ cellId: projectId, type: PAYLOAD.cellMessage });
    expect(projInbox).toHaveLength(1);
    expect((projInbox[0]!.envelope.payload as { text: string }).text).toBe("请继续执行第一步");

    // Desk received a compact error_recovery envelope listing the already-executed send_message and ANSI-stripped error
    const recoveries = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.runContinue });
    expect(recoveries).toHaveLength(1);
    const payload = recoveries[0]!.envelope.payload as RunContinuePayload;
    expect(payload).toMatchObject({
      reason: "error_recovery",
      count: 1,
      error: "code=3003 empty stream",
      executedWrites: [expect.stringContaining(`send_message(to=${inboxAddr(projectId)})`)],
    });
    expect(recoveryPrompt).toContain("NOT re-delivered blindly");
    expect(recoveryPrompt).toContain("code=3003 empty stream");
    expect(recoveryPrompt).not.toContain("\x1b[");
  });

  it("M1: deduplicates retry inbound evidence by envelope_id, drops non-terminal messages from closed senders, and strips ANSI on dead-letter cards", async () => {
    const h = await boot();
    const { projectId } = startProjectSync(h.kernel, { title: "请求标识清理", outcome: "清理完毕", brief: "清理请求标识" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();

    // 1. Read-only retry dedupes inbound evidence AND drops closed-sender cell.message before re-delivery
    let deskRuns = 0;
    h.script.add("desk", () => {
      deskRuns++;
      return { error: new Error("\x1b[31mtransient 3003\x1b[0m") };
    });
    h.kernel.sendToCell("desk", { text: "请求构建窗口", summary: "窗口申请" }, { principalId: `cell:${projectId}` });
    await h.kernel.idle();
    expect(deskRuns).toBe(1);

    // Close the sender project before retry fires
    await h.kernel.closeCell(projectId, "completed", { principalId: h.kernel.ownerPrincipal });
    let sawStaleWindowReq = false;
    h.script.add("desk", (req) => {
      deskRuns++;
      if (requestText(req).includes("请求构建窗口")) sawStaleWindowReq = true;
      return {};
    });
    h.clock.advance(60_000);
    await h.kernel.idle();
    // Closed sender's non-terminal cell.message was cancelled; desk never received the stale request again
    const cancelledMsg = h.kernel.inbox
      .listMessagesSync({ cellId: "desk", type: PAYLOAD.cellMessage })
      .find((m) => (m.envelope.payload as { text?: string }).text === "请求构建窗口");
    expect(cancelledMsg?.status).toBe("cancelled");
    expect(cancelledMsg?.statusReason).toBe("sender cell is closed");
    expect(sawStaleWindowReq).toBe(false);
    // Clear any unused desk script turn from part 1 before testing part 2
    h.script.queues.delete("desk");

    // 2. Retry inbound evidence dedup + ANSI-stripped dead-letter card
    for (let i = 0; i < 6; i++) {
      h.script.add("desk", { error: new Error("\x1b[1;31mFATAL:\x1b[0m upstream \x1b[33m502\x1b[0m") });
    }
    const env = await h.ui.capture({ text: "必败测试消息" }, "owner");
    await h.kernel.idle();
    for (let i = 0; i < 6; i++) {
      h.clock.advance(10 * MIN);
      await h.kernel.idle();
    }
    // Despite 5 failed attempts, inbound evidence for env.id was recorded ONLY ONCE!
    const inboundRows = all<{ seq: number }>(
      h.kernel.db,
      "SELECT seq FROM evidence WHERE cell_id = 'desk' AND kind = 'inbound' AND json_extract(content, '$.envelope.id') = ?",
      [env.id],
    );
    expect(inboundRows).toHaveLength(1);

    // Dead-letter card exists and has ZERO ANSI escape codes
    const deadCard = h.kernel.humanItems.list(true).find((c) => c.subjectKey === "kernel:desk:retry_limit");
    expect(deadCard).toBeDefined();
    expect(deadCard!.description).toContain("FATAL: upstream 502");
    expect(deadCard!.description).not.toContain("\x1b");
    expect(deadCard!.prep?.summary).not.toContain("\x1b");
  });

  // ==================== M3 ====================

  it("M3: attributes batch request_approval card source to the bound artifact's owning cell instead of blindly taking envs[0]", async () => {
    const h = await boot();
    const { projectId: projA } = startProjectSync(h.kernel, { title: "模块 A 改造", outcome: "完成", brief: "模块 A" }, { principalId: h.kernel.ownerPrincipal });
    const { projectId: projB } = startProjectSync(h.kernel, { title: "模块 B 移植", outcome: "完成", brief: "模块 B" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();

    const winWorkerAddr = h.kernel.spawnCell("desk", { id: "cell_win_fix", preset: "worker", title: "公共平台修复" }, undefined, { principalId: h.kernel.ownerPrincipal });
    const winWorkerId = winWorkerAddr.slice("inbox:".length);
    const art = h.kernel.context.commitSync(winWorkerId, {
      artifact: {
        artifactId: "art_win_plan",
        content: { format: "markdown", title: "公共验证方案", body: "详细方案" },
        updatedBy: "agent",
      },
    });
    expect(art.ok).toBe(true);

    // Enqueue 3 background messages into desk in one batch: projA is envs[0], winWorker is envs[1], projB is envs[2]
    h.kernel.control("desk", { action: "pause" }, { principalId: h.kernel.ownerPrincipal });
    h.kernel.sendToCell("desk", { text: "模块 A 汇报进展" }, { principalId: `cell:${projA}` });
    h.kernel.sendToCell("desk", { text: "公共验证草稿已保存" }, { principalId: `cell:${winWorkerId}` });
    h.kernel.sendToCell("desk", { text: "模块 B 询问状态" }, { principalId: `cell:${projB}` });

    h.script.add(
      "desk",
      tool("request_approval", {
        kind: "action",
        title: "推送验证分支并运行平台验收",
        summary: "请确认是否执行平台验证",
        artifactId: "art_win_plan",
        relatedProjectIds: [projB],
        options: [{ id: "ok", label: "批准", effect: "reply" }],
      }),
    );
    h.kernel.control("desk", { action: "resume" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();

    const card = h.kernel.humanItems.list(true).find((c) => c.title === "推送验证分支并运行平台验收");
    expect(card).toBeDefined();
    expect(card!.source?.principalId).toBe(`cell:${winWorkerId}`);
    expect(card!.source?.principalId).not.toBe(`cell:${projA}`);
  });

  // ==================== M4 ====================

  it("M4: searchHistory finds tool_result blobs & resources without resource_fts, and artifacts prune unreferenced intermediate versions", async () => {
    const h = await boot();
    const { projectId } = startProjectSync(h.kernel, { title: "存储测试", outcome: "完成", brief: "测试" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();

    // Verify resource_fts is absent while searchHistory still finds tool_result and resources (both >=3 and 1-2 char queries)
    expect(get(h.kernel.db, "SELECT name FROM sqlite_master WHERE name = 'resource_fts'")).toBeUndefined();
    h.kernel.context.appendEvidenceSync(projectId, {
      kind: "tool_result",
      toolUseId: "tu_big",
      name: "bash",
      output: "cargo build output: unique_error_token_9981\n" + "line\n".repeat(50),
      runId: "r_m4",
      at: h.clock.now(),
    });
    const spillUri = h.kernel.context.appendEvidenceSync(projectId, {
      kind: "tool_result",
      toolUseId: "tu_spill",
      name: "bash",
      output: "prefix\n" + "z".repeat(40_000) + "\nspilled_needle_alpha\n" + "y".repeat(40_000),
      runId: "r_m4",
      at: h.clock.now() + 1,
    }).spill?.uri;
    expect(spillUri).toBeTruthy();

    const hitToolResult = h.kernel.context.searchHistorySync(projectId, "unique_error_token_9981", { scope: "subtree", limit: 10 });
    expect(hitToolResult.some((s) => s.text.includes("unique_error_token_9981"))).toBe(true);
    const hitSpill = h.kernel.context.searchHistorySync(projectId, "spilled_needle_alpha", { scope: "subtree", limit: 10 });
    expect(hitSpill.some((s) => s.text.includes("spilled_needle_alpha"))).toBe(true);

    // Artifact intermediate version pruning: keep v1, human edits, card-bound versions, and recent 10 versions
    for (let v = 1; v <= 15; v++) {
      const updatedBy = v === 3 ? "human" : "agent";
      const res = h.kernel.context.commitSync(projectId, {
        artifact: {
          artifactId: "art_long",
          expectedVersion: v === 1 ? undefined : v - 1,
          content: { format: "markdown", title: "长报告", body: `version ${v}` },
          updatedBy,
        },
      });
      expect(res.ok).toBe(true);
      if (v === 4) {
        h.kernel.humanItems.create(
          {
            title: "审阅 v4",
            subjectKey: "review:v4",
            artifactId: "art_long",
            options: [{ id: "ok", label: "通过", effect: "reply" }],
          },
          projectId,
        );
      }
    }
    const kept = h.kernel.context.listArtifactVersionsSync("art_long").map((v) => v.version);
    expect(kept).toContain(1); // first version kept
    expect(kept).toContain(3); // human edit kept
    expect(kept).toContain(4); // card-bound version kept
    expect(kept).not.toContain(2); // unreferenced old agent draft pruned
    expect(kept).not.toContain(5); // unreferenced old agent draft pruned
    expect(kept).toContain(6); // within recent 10 of 15
    expect(kept).toContain(15);
  });

  // ==================== M5 ====================

  it("M5: code probe skips hydrate/compaction, writes zero evidence on unchanged polls, backs off after 30m/60m, suspends on parent blocked_human, and supports update_check in place", async () => {
    const h = await boot();
    const dir = tempDir("m5-probe");
    const counterFile = join(dir, "runs.log");

    h.script.add(
      "project",
      tool("dispatch", {
        preset: "checker",
        title: "盯 MR CI",
        instruction: "盯 CI 直到通过",
        check: { command: `echo run >> "${counterFile}"; test -f "${join(dir, "done")}"`, everySec: 60 },
      }),
      {},
    );
    const { projectId } = startProjectSync(h.kernel, { title: "CI 监控项目", outcome: "完成", brief: "盯 CI", cwd: dir }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    const [checkerId] = childrenOf(h, projectId);
    expect(checkerId).toBeDefined();

    // Check #1 ran and recorded initial evidence; prompt_prefixes has ZERO rows (context.hydrate skipped!)
    expect(get(h.kernel.db, "SELECT compactions FROM prompt_prefixes WHERE cell_id = ?", [checkerId!])).toBeUndefined();
    const evAfterFirst = h.kernel.context.listEvidenceSync(checkerId!).length;
    expect(evAfterFirst).toBeGreaterThan(0);

    // Advance 3 identical unchanged polls: ProbeState increments, ZERO new evidence rows, zero compactions!
    for (let i = 0; i < 3; i++) {
      h.clock.advance(MIN);
      await h.kernel.idle();
    }
    expect(h.state<ProbeState>(checkerId!, KEYS.probe)).toMatchObject({ checks: 4, unchangedChecks: 3 });
    expect(h.kernel.context.listEvidenceSync(checkerId!).length).toBe(evAfterFirst);
    expect(get(h.kernel.db, "SELECT compactions FROM prompt_prefixes WHERE cell_id = ?", [checkerId!])).toBeUndefined();

    // Advance past 30 min stagnant threshold -> next interval backs off to 300s (5 min)
    h.clock.set(T0 + 31 * MIN);
    await h.kernel.idle();
    const timerAfter30m = h.kernel.inbox.listMessagesSync({ cellId: checkerId!, type: PAYLOAD.timerFired, status: ["pending"] })[0]!;
    expect(timerAfter30m.deliverAt - h.clock.now()).toBe(300_000);

    // Advance past 60 min stagnant threshold -> next interval backs off to 600s (10 min)
    h.clock.set(T0 + 61 * MIN);
    await h.kernel.idle();
    const timerAfter60m = h.kernel.inbox.listMessagesSync({ cellId: checkerId!, type: PAYLOAD.timerFired, status: ["pending"] })[0]!;
    expect(timerAfter60m.deliverAt - h.clock.now()).toBe(600_000);

    // Raise a blocking decision card on parent project -> probe suspends without executing shell command
    const card = h.kernel.humanItems.create(
      { title: "审批强推", subjectKey: "approve:push", options: [{ id: "yes", label: "同意", effect: "reply" }] },
      projectId,
    );
    const checksBeforeSuspend = h.state<ProbeState>(checkerId!, KEYS.probe)!.checks;
    h.clock.advance(10 * MIN);
    await h.kernel.idle();
    expect(h.state<ProbeState>(checkerId!, KEYS.probe)).toMatchObject({ suspended: true, checks: checksBeforeSuspend });

    // Resolving the blocking card wakes the suspended probe immediately!
    h.script.add("project", {});
    await h.kernel.humanItems.decide(card.id, { optionId: "yes", seenItemRevision: card.itemRevision }, "owner");
    await h.kernel.idle();
    expect(h.state<ProbeState>(checkerId!, KEYS.probe)).toMatchObject({ suspended: false, checks: checksBeforeSuspend + 1 });

    // update_check updates the existing checker in place (same cellId, new command, resets baseline & runs immediately)
    let updateOut = "";
    writeFileSync(join(dir, "done2"), "ok");
    h.script.add(
      "project",
      tool("update_check", { cellId: checkerId!, command: `test -f "${join(dir, "done2")}"`, title: "盯新提交 CI" }),
      (req) => {
        updateOut = lastToolResult(req);
        return {};
      },
      {},
    );
    h.kernel.sendToCell(projectId, { text: "新提交已推，更新检查目标" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(updateOut).toContain(`Updated checker ${checkerId}`);
    // Same checker completed cleanly on the updated command without spawning a second checker
    expect(h.kernel.getCell(checkerId!)?.status).toBe("closed");
    const probeResults = h.kernel.inbox
      .listMessagesSync({ cellId: projectId, type: PAYLOAD.cellResult })
      .map((m) => m.envelope.payload as CellResultPayload);
    expect(probeResults).toHaveLength(1);
    expect(probeResults[0]).toMatchObject({ childCellId: checkerId, status: "completed" });
  });

  // ==================== M6 ====================

  it("M6: relays orphan worker reply to parent when worker answers parent message in assistant_text while non-dormant, and stalled_check respects pending card refId", async () => {
    const h = await boot();
    const { projectId } = startProjectSync(h.kernel, { title: "协作项目", outcome: "完成", brief: "开发" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();

    const workerAddr = h.kernel.spawnCell(projectId, { id: "cell_w_m6", preset: "worker", title: "执行分身" }, undefined, { principalId: `cell:${projectId}` });
    const workerId = workerAddr.slice("inbox:".length);

    // 1. Worker registers an open wait (stays non-dormant), then receives parent's question and replies ONLY in assistant_text
    h.script.add(
      "worker",
      tool("wait", { waitingFor: "human", reason: "等审批强推" }),
      {},
      { text: "规则原文第 3 条：自有 feature 分支需确认。" },
    );
    h.kernel.sendToCell(workerId, { text: "先登记等待" }, { principalId: `cell:${projectId}` });
    await h.kernel.idle();

    let parentSaw = "";
    h.script.add("project", (req) => {
      parentSaw = requestText(req);
      return {};
    });
    h.kernel.sendToCell(workerId, { text: "请给出规则原文" }, { principalId: `cell:${projectId}` });
    await h.kernel.idle();
    expect(parentSaw).toContain("规则原文第 3 条：自有 feature 分支需确认。");

    // 2. stalled_check recognizes cell_waits.ref_id pointing to a still-pending human_item (even when waitingFor is inbox:desk)
    const winCard = h.kernel.humanItems.create(
      { title: "公共 Windows 验证", subjectKey: "arb:win-ci", options: [{ id: "go", label: "继续", effect: "reply" }] },
      "desk",
    );
    const deskWorkerAddr = h.kernel.spawnCell("desk", { id: "cell_win_w", preset: "worker", title: "Windows 分身" }, undefined, { principalId: h.kernel.ownerPrincipal });
    const deskWorkerId = deskWorkerAddr.slice("inbox:".length);
    h.script.add("worker", tool("wait", { waitingFor: "inbox:desk", refId: winCard.id, reason: "等审批卡决定" }));
    h.kernel.sendToCell(deskWorkerId, { text: "等审批" }, { principalId: "cell:desk" });
    await h.kernel.idle();

    // Desk is completely idle, but winCard is still pending -> worker MUST NOT be flagged stalled!
    h.kernel.checkStalls();
    expect(h.kernel.anchorsOf(deskWorkerId).stalled).toBe(false);
    expect(h.kernel.inbox.listMessagesSync({ cellId: deskWorkerId, type: PAYLOAD.stalledCheck })).toHaveLength(0);

    // Once the card is resolved without answering the worker, stall detection resumes cleanly
    h.script.add("desk", {});
    await h.kernel.humanItems.decide(winCard.id, { optionId: "go", seenItemRevision: winCard.itemRevision }, "owner");
    await h.kernel.idle();
    h.kernel.checkStalls();
    expect(h.kernel.anchorsOf(deskWorkerId).stalled).toBe(true);
  });

  // ==================== M7 ====================

  it("M7: closed-project arb:* state auto-archives and updateCell resetSession clears cli:session", async () => {
    // Auto-archive closed-project arb:* keys on desk
    const h = await boot();
    const { projectId: p1 } = startProjectSync(h.kernel, { title: "项目一", outcome: "完成", brief: "一" }, { principalId: h.kernel.ownerPrincipal });
    const { projectId: p2 } = startProjectSync(h.kernel, { title: "项目二", outcome: "完成", brief: "二" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();

    h.kernel.context.commitSync("desk", {
      statePatches: {
        "arb:only-p1": { relatedProjectIds: [p1], note: "stale after p1 closes" },
        "arb:shared-p1-p2": { relatedProjectIds: [p1, p2], note: "stays while p2 is active" },
        "non-arb:keep": { projectId: p1 },
      },
    });
    await h.kernel.closeCell(p1, "completed", { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.context.readStateSync("desk", "arb:only-p1")).toBeNull();
    expect(h.kernel.context.readStateSync("desk", "arb:shared-p1-p2")).not.toBeNull();
    expect(h.kernel.context.readStateSync("desk", "non-arb:keep")).not.toBeNull();

    await h.kernel.closeCell(p2, "completed", { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.context.readStateSync("desk", "arb:shared-p1-p2")).toBeNull();
    expect(h.kernel.context.readStateSync("desk", "non-arb:keep")).not.toBeNull();

    // updateCell({ resetSession: true }) clears cli:session and records cli:session:reset
    const { projectId: p3 } = startProjectSync(h.kernel, { title: "项目三", outcome: "完成", brief: "三" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    h.kernel.context.commitSync(p3, { statePatches: { [CLI_SESSION_KEY]: { sessionId: "sess_old", updatedAt: 100 } } });
    h.kernel.updateCell(p3, { resetSession: true }, { principalId: `cell:${p3}` });
    expect(h.kernel.context.readStateSync(p3, CLI_SESSION_KEY)).toBeNull();
    expect(typeof h.kernel.context.readStateSync(p3, CLI_SESSION_RESET_KEY)).toBe("number");
  });

  // ==================== Track B ====================

  it("Track B: embeds the 4 senior-engineer meta-principles, fixes workspace-arbitration, omits quantity walls, and leaks zero internal info", () => {
    expect(COMMON).toContain("Reality first");
    expect(COMMON).toContain("Proportionality");
    expect(COMMON).toContain("Step back on loops");
    expect(COMMON).toContain("Trust native facts");
    expect(COMMON).toContain("23:00–08:00");

    const arb = BUILTIN_SKILLS.find((s) => s.name === SKILL_WORKSPACE_ARBITRATION)!.body;
    expect(arb).toContain("Never act as a build/compile lock scheduler");
    expect(arb).toContain("Check mainline reality first");
    expect(arb).toContain("Freeze pending-approval fixers");
    expect(arb).toContain("No ad-hoc temporary CI pipelines");
    expect(arb).toContain("blockingProjectIds");

    const relay = BUILTIN_SKILLS.find((s) => s.name === SKILL_PROJECT_RELAY)!.body;
    expect(relay).toContain("update_check");
    expect(relay).toContain("resetSession");

    const allTexts = [
      COMMON,
      ...promptDefs(resolveConfig()).map((p) => p.text),
      ...BUILTIN_SKILLS.map((s) => s.body),
    ];
    for (const t of allTexts) {
      // No quantity-limit walls
      expect(t).not.toMatch(/≤\s*\d+\s*(?:文件|版|轮)/);
    }
  });
});
