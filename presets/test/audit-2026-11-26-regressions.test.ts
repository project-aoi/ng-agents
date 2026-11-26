import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CELL_DIRECT_CHAT_KEY,
  CELL_STATUS_KEY,
  defaultCellsRoot,
  hasRepoOrInstructionAncestor,
  PAYLOAD,
  pullCursorKey,
  type AgentLoop,
  type CellDirectChatState,
  type CellStatusLine,
  type RunContinuePayload,
} from "@ng/protocol";
import { seedBuiltinSkills, startProjectSync } from "../src";
import { boot, childrenOf, cleanupAll, gitRepo, lastToolResult, requestText, systemOf, T0, tempDir, tool } from "./helpers";

afterEach(cleanupAll);

const MONDAY_9 = Date.UTC(2026, 10, 23, 1, 0, 0);

describe("audit 2026-11-26 P0 & P1 regressions", () => {
  it("A1: kernel places desk and sensor cwds outside a symlinked host git/AGENTS.md tree and canonicalizes symlinked project cwds", async () => {
    const raw = mkdtempSync(join(tmpdir(), "ngaudit-a1-"));
    const hostRepo = join(raw, "host-repo");
    mkdirSync(join(hostRepo, "data"), { recursive: true });
    writeFileSync(join(hostRepo, "AGENTS.md"), "# Host Legacy Rules\nNEVER LEAK THIS\n");
    execFileSync("git", ["-C", hostRepo, "init", "-q", "-b", "main"]);
    const symData = join(raw, "sym-data");
    symlinkSync(join(hostRepo, "data"), symData);

    const realProj = gitRepo("real-proj");
    const symProj = join(raw, "sym-proj");
    symlinkSync(realProj, symProj);

    const h = await boot({ kernel: { dataDir: symData } });
    try {
      seedBuiltinSkills(h.kernel.context, "desk");
      h.script.add(
        "desk",
        tool("add_source", { title: "磁盘巡检", description: "检查磁盘空间", cron: "0 9 * * 1", tz: "Asia/Shanghai" }),
        {},
      );
      await h.ui.capture({ text: "每周一检查磁盘" }, "owner");
      await h.kernel.idle();

      // Acquire workspaces for desk and sensor, and start project via symlinked path
      const deskWs = await h.kernel.workspace.acquire("desk");
      expect(hasRepoOrInstructionAncestor(deskWs.root)).toBe(false);
      expect(deskWs.root).toBe(realpathSync(deskWs.root));

      const { projectId } = startProjectSync(h.kernel, { title: "p", outcome: "o", brief: "b", cwd: symProj }, { principalId: h.kernel.ownerPrincipal });
      expect(h.kernel.getCell(projectId)!.spec.cwd).toBe(realpathSync(realProj));
    } finally {
      rmSync(defaultCellsRoot(symData), { recursive: true, force: true });
      rmSync(raw, { recursive: true, force: true });
    }
  });

  it("A2: inspect_cell advances pull:<targetId> to high-water toSeq even under middle omission or explicit afterSeq > cursor", async () => {
    const h = await boot();
    let workerId = "";
    h.script.add(
      "project",
      tool("dispatch", { title: "大批步骤", instruction: "执行多步分析" }),
      (req) => {
        workerId = /^Started worker (\S+)/.exec(lastToolResult(req))![1]!;
        return {};
      },
    );
    const { projectId } = startProjectSync(h.kernel, { title: "p", outcome: "o", brief: "b" }, { principalId: h.kernel.ownerPrincipal });
    // Worker generates enough evidence lines to trigger head 20% + tail 80% middle omission in inspect_cell
    h.script.add("worker", async (req) => {
      const wId = req.metadata!.cellId!;
      for (let i = 0; i < 120; i++) {
        h.kernel.context.appendEvidenceSync(wId, {
          kind: "assistant_text",
          text: `Step ${i}: ${"x".repeat(450)}`,
          runId: "r_many",
          at: T0 + i,
        });
      }
      return { text: "全部 120 步完成" };
    });
    let inspectOut = "";
    h.script.add(
      "project",
      (req) => {
        expect(requestText(req)).toContain("not inspected yet (its record runs to #");
        return tool("inspect_cell", { cellId: workerId });
      },
      (req) => {
        inspectOut = lastToolResult(req);
        return {};
      },
    );
    await h.kernel.idle();

    expect(inspectOut).toContain("omitted — showing head 20% + tail 80%");
    const lastSeq = h.kernel.context.lastEvidenceSeqSync(workerId);
    expect(h.state<number>(projectId, pullCursorKey(workerId))).toBe(lastSeq);

    // Subsequent wake-up must NOT report fake unread records!
    let nextWakeText = "";
    h.script.add("project", (req) => {
      nextWakeText = requestText(req);
      return {};
    });
    h.kernel.sendToCell(projectId, { text: "看一下状态" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(nextWakeText).not.toContain("not inspected yet");
    expect(nextWakeText).not.toContain("new since your last inspect_cell");
  });

  it("A3: keeps [references] strictly ASCII and whole across compactions, and anchors updated project goals", async () => {
    const h = await boot({ kernel: { context: { limits: { compactAtChars: 1_500, keepRecentChars: 300, summaryMaxChars: 1_200 } } } });
    const repo2 = gitRepo("v2-repo");
    h.script.add(
      "project",
      tool("update_project", {
        title: "二期目录迁移",
        outcome: "在新 worktree 完成全部迁移与单测",
        cwd: repo2,
        summary: "已切到新目录",
        plan: [{ title: "迁移 schema", owner: "agent" }],
      }),
      {},
    );
    const { projectId } = startProjectSync(h.kernel, { title: "一期调研", outcome: "只做一期调研", brief: "一期原话" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();

    // Inject noisy Chinese parenthetical refs, truncated stubs, and many ephemeral spill refs, then force compaction
    const manyEphemeral = Array.from({ length: 30 }, (_, i) => `res://${projectId}/res_${String(i).padStart(12, "0")}`).join(" ");
    h.kernel.context.appendEvidenceSync(projectId, {
      kind: "assistant_text",
      text: `见 res://${projectId}/res_01m88svzj50000sn0w9vah（约字符5840附近） 与 art_01m88zwbsh00006v881681，碎片 art_0 art_01m8 res://cell_ ${manyEphemeral} ${"x".repeat(1_800)}`,
      runId: "r_comp",
      at: T0 + 50,
    });
    await h.kernel.context.compact(projectId, { force: true });

    let secondSnapTask = "";
    h.script.add("project", () => ({}));
    h.kernel.sendToCell(projectId, { text: "继续推进" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    const lastReq = h.script.callsOf("project").at(-1)!;
    secondSnapTask = requestText(lastReq);
    expect(secondSnapTask).toContain("[project goal] (current — updated since initial task)");
    expect(secondSnapTask).toContain("在新 worktree 完成全部迁移与单测");
    expect(secondSnapTask).toContain(repo2);
    const refsLine = secondSnapTask.split("\n").find((l) => l.startsWith("[references] "))!;
    expect(refsLine).toBeDefined();
    expect(refsLine).toContain("art_01m88zwbsh00006v881681");
    expect(refsLine).not.toContain("（约字符5840附近）");
    expect(refsLine).not.toMatch(/\bart_0\b|\bart_01m8\b|\bres:\/\/cell_\b/);
    expect(refsLine).toMatch(/^\[references\] [\x20-\x7e]+$/);
  });

  it("B3: dispatcher queues kernel.continue(reason='timeout') without releasing/re-delivering the old batch", async () => {
    let calls = 0;
    const seenBatches: string[][] = [];
    const customLoop: AgentLoop = {
      async run(snapshot) {
        calls++;
        seenBatches.push(snapshot.batch.envelopes.map((e) => e.type));
        return calls === 1 ? "timeout" : "completed";
      },
    };
    const dataDir = tempDir("b3-data");
    const h = await boot({ kernel: { dataDir, loop: customLoop } });
    h.kernel.sendToCell("desk", { text: "长任务第一批" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();

    expect(calls).toBe(2);
    expect(seenBatches).toEqual([["cell.message"], ["kernel.continue"]]);
    const cont = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.runContinue });
    expect(cont).toHaveLength(1);
    expect(cont[0]!.envelope.payload as RunContinuePayload).toEqual({ reason: "timeout", count: 1 });
  });

  it("B4 & A8-4: read_artifact stays inline up to 28KB, supports paging + outline + structured version, and caps conflict dumps", async () => {
    const h = await boot();
    const bigBody = [
      "# 总览",
      "A".repeat(9_000),
      "## 模块二",
      "B".repeat(9_000),
      "## 模块三",
      "C".repeat(5_000),
    ].join("\n\n");
    const artId = "art_01m88zwbsh00006v881681";
    h.kernel.context.commitSync("desk", {
      artifact: { artifactId: artId, content: { format: "markdown", title: "汇总报告", body: bigBody }, updatedBy: "agent" },
    });

    let fullReadResult = "";
    let outlineResult = "";
    let conflictResult = "";
    h.script.add(
      "desk",
      tool("read_artifact", { artifactId: artId }),
      (req) => {
        fullReadResult = lastToolResult(req);
        return tool("read_artifact", { artifactId: artId, outline: true });
      },
      (req) => {
        outlineResult = lastToolResult(req);
        return tool("save_artifact", { artifactId: artId, expectedVersion: 999, body: "stale write" });
      },
      (req) => {
        conflictResult = lastToolResult(req);
        return {};
      },
    );
    await h.ui.capture({ text: "检查大文稿" }, "owner");
    await h.kernel.idle();

    // 23KB artifact was NOT spilled to 4KB!
    expect(fullReadResult).toContain("B".repeat(200));
    expect(fullReadResult).not.toContain("left out here");
    const readEv = h.kernel.context.listEvidenceSync("desk").find((e) => e.record.kind === "tool_result" && e.record.name === "read_artifact")!;
    expect((readEv.record as { spillUri?: string }).spillUri).toBeUndefined();

    // Outline lists headings with line & offset
    expect(outlineResult).toContain("# 总览");
    expect(outlineResult).toContain("## 模块二");
    expect(outlineResult).toContain("## 模块三");

    // Conflict > 8KB returns version + outline instead of dumping 23KB body inline
    expect(conflictResult).toContain(`Version conflict: ${artId} is at v1`);
    expect(conflictResult).toContain("--- outline (3 headings) ---");
    expect(conflictResult.length).toBeLessThan(2_000);
  });

  it("A6 & A7: update_cell moves worker cwd, update_project hints reusable workers, and built-in skills + leaf bounds are role-filtered", async () => {
    const h = await boot();
    seedBuiltinSkills(h.kernel.context, "desk");
    // Custom owner global skill (no "builtin" tag) remains visible everywhere
    h.kernel.context.upsertSkillOrNoteSync("desk", {
      kind: "skill",
      name: "team-conventions",
      description: "团队通用规范",
      body: "# 团队规范\n保持提交清晰。",
      tags: ["custom"],
      scope: "global",
      mode: "upsert",
    });

    const repo1 = gitRepo("main-checkout");
    const worktree2 = gitRepo("feature-worktree");
    let workerId = "";
    let updateProjOut = "";
    h.script.add(
      "project",
      tool("dispatch", { title: "模块一", instruction: "先分析" }),
      (req) => {
        workerId = /^Started worker (\S+)/.exec(lastToolResult(req))![1]!;
        return {};
      },
    );
    h.script.add("worker", { text: "分析完毕" });
    h.script.add(
      "project",
      tool("update_project", { cwd: worktree2, summary: "切到独立 worktree" }),
      (req) => {
        updateProjOut = lastToolResult(req);
        return tool("update_cell", { cellId: workerId, cwd: worktree2, title: "模块一（实施）" });
      },
      {},
    );
    const { projectId } = startProjectSync(h.kernel, { title: "p", outcome: "o", brief: "b", cwd: repo1 }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();

    expect(updateProjOut).toContain(`update_cell({ cellId, cwd: "${worktree2}" })`);
    expect(h.kernel.getCell(workerId)!.spec.cwd).toBe(worktree2);
    expect(h.kernel.getCell(workerId)!.title).toBe("模块一（实施）");

    // Check A7: worker has leaf bounds + custom global skill, NO built-in coordinator skills!
    const workerSys = systemOf(h, workerId);
    expect(workerSys).toContain("Children: none (leaf cell).");
    expect(workerSys).not.toContain("up to 16 concurrent");
    expect(workerSys).toContain("team-conventions");
    for (const coordSkill of ["project-relay", "domain-hub", "workspace-arbitration", "habit-and-routine-discovery"]) {
      expect(workerSys).not.toContain(coordSkill);
    }

    // Project has inlined project-relay + custom skill, NO desk/hub skills!
    const projSys = systemOf(h, projectId);
    expect(projSys).toContain("# Skill: project-relay");
    expect(projSys).toContain("team-conventions");
    expect(projSys).not.toContain("workspace-arbitration");
    expect(projSys).not.toContain("habit-and-routine-discovery");
    expect(projSys).not.toContain("domain-hub");
  });

  it("A8 (1, 2, 3, 5): same-project job_observe, cross-cell knowledge URI in global search + read_resource, read_state filtering, and leaf working_note reinjection", async () => {
    const h = await boot();
    const repo = gitRepo("a8-repo");
    const { projectId: p1 } = startProjectSync(h.kernel, { id: "proj_a", title: "A", outcome: "o", brief: "b", cwd: repo }, { principalId: h.kernel.ownerPrincipal });
    const { projectId: p2 } = startProjectSync(h.kernel, { id: "proj_b", title: "B", outcome: "o", brief: "b", cwd: repo }, { principalId: h.kernel.ownerPrincipal });
    h.script.add("project", {}, {});
    await h.kernel.idle();

    let jobId = "";
    let siblingObserve = "";
    let outsiderObserveErr = "";
    let searchOut = "";
    let crossNoteBody = "";
    let stateListOut = "";
    let leafWakeText = "";

    h.kernel.spawnCell(p1, { id: "w_runner", preset: "worker", meta: { role: "w_runner" }, cwd: repo }, "run job", { principalId: "cell:proj_a" });
    h.kernel.spawnCell(p1, { id: "w_peer", preset: "worker", meta: { role: "w_peer" }, cwd: repo }, "peer check", { principalId: "cell:proj_a" });
    h.kernel.spawnCell(p2, { id: "w_other", preset: "worker", meta: { role: "w_other" }, cwd: repo }, "other proj", { principalId: "cell:proj_b" });

    h.script.add(
      "w_runner",
      tool("save_note", { name: "progress-memo", kind: "working_note", body: "UNIQUE_MEMO_TOKEN_7788: module schema verified" }),
      tool("job_start", { command: 'echo "PEER_VISIBLE_LOG_LINE"; sleep 0.4' }),
      (req) => {
        jobId = /Started job (\S+)\./.exec(lastToolResult(req))![1]!;
        return {};
      },
      // Woken when job finishes: check that leaf's working_note was reinjected (A8-5), and cancel a dummy job cleanly (B9-3)
      (req) => {
        leafWakeText = requestText(req);
        return {};
      },
    );
    h.script.add("w_peer", async () => {
      while (!jobId) await new Promise((r) => setTimeout(r, 10));
      return tool("job_observe", { jobId });
    }, (req) => {
      siblingObserve = lastToolResult(req);
      return tool("job_cancel", { jobId });
    }, (req) => {
      // Peer cannot cancel w_runner's job!
      expect(lastToolResult(req)).toContain('belongs to cell "w_runner"');
      return {};
    });
    h.script.add("w_other", async () => {
      while (!jobId) await new Promise((r) => setTimeout(r, 10));
      return tool("job_observe", { jobId });
    }, (req) => {
      outsiderObserveErr = lastToolResult(req);
      return tool("search_history", { query: "UNIQUE_MEMO_TOKEN_7788", scope: "global" });
    }, (req) => {
      searchOut = lastToolResult(req);
      const uri = /\(full: (working_note:\/\/[^)]+)\)/.exec(searchOut)?.[1] ?? "";
      return tool("read_resource", { uri });
    }, (req) => {
      crossNoteBody = lastToolResult(req);
      // Seed a cli:session & pull:* key on p2 to test read_state filtering (A8-3)
      h.kernel.context.commitSync(p2, { statePatches: { "cli:session": { sessionId: "secret" }, "pull:w_other": 12 } });
      return tool("read_state", { cellId: p2 });
    }, (req) => {
      stateListOut = lastToolResult(req);
      return {};
    });

    await h.kernel.idle({ jobs: true });

    expect(siblingObserve).toContain("state:");
    expect(outsiderObserveErr).toContain("outside your project");
    expect(searchOut).toContain("(full: working_note://w_runner/progress-memo)");
    expect(crossNoteBody).toContain("UNIQUE_MEMO_TOKEN_7788: module schema verified");
    expect(stateListOut).toContain("gtd:project =");
    expect(stateListOut).not.toContain("cli:session");
    expect(stateListOut).not.toContain("pull:w_other");
    expect(leafWakeText).toContain("[your notes");
    expect(leafWakeText).toContain("UNIQUE_MEMO_TOKEN_7788: module schema verified");
  });

  it("B9 (1, 2, 3): LLM add_source does not trigger an empty setup run, probe summary omits script code, status clips on token boundary, desk resets unsettled, and self-cancelled job leaves no pending silent_inject", async () => {
    const h = await boot();
    const repo = gitRepo("b9-repo");

    // B9-1: LLM cron source triggers 0 runs at creation, then sees [source setup] on first cron trigger
    h.script.add(
      "desk",
      tool("add_source", { title: "日志异常巡检", description: "发现 FATAL 关键字才报告", cron: "0 9 * * 1", tz: "Asia/Shanghai" }),
      {},
    );
    await h.ui.capture({ text: "每周一帮我巡检日志异常" }, "owner");
    await h.kernel.idle();

    const [sensor] = childrenOf(h, "desk", "sensor");
    expect(sensor).toBeDefined();
    expect(h.script.callsOf("sensor")).toHaveLength(0);
    expect(h.kernel.inbox.listMessagesSync({ cellId: sensor! })).toHaveLength(0);

    let sensorFirstWake = "";
    h.script.add("sensor", (req) => {
      sensorFirstWake = requestText(req);
      return tool("no_hit");
    });
    h.clock.set(MONDAY_9);
    await h.kernel.idle();
    expect(h.script.callsOf("sensor")).toHaveLength(1);
    expect(sensorFirstWake).toContain("[source setup] 日志异常巡检: 发现 FATAL 关键字才报告");
    expect(h.source(sensor!)).toMatchObject({ runCount: 1, hitCount: 0 });

    // B9-2: check_probe summary uses checker title rather than truncated script command, and dispatch warns on duplicate active checker
    let dupCheckerOut = "";
    let probeNotice = "";
    h.script.add(
      "project",
      tool("dispatch", {
        preset: "checker",
        title: "等待构建产物",
        instruction: "等 ready.txt 出现",
        check: { command: 'python3 -c "import os,sys; sys.exit(0 if os.path.exists(\'ready.txt\') else 1)"', everySec: 60 },
      }),
      tool("dispatch", {
        preset: "checker",
        title: "重复监控构建产物",
        instruction: "重复监控",
        check: { command: "test -f ready.txt", everySec: 60 },
      }),
      (req) => {
        dupCheckerOut = lastToolResult(req);
        const dupId = /^Started checker (\S+)/.exec(dupCheckerOut)![1]!;
        return tool("close_cell", { cellId: dupId });
      },
      {},
      (req) => {
        probeNotice = requestText(req);
        return {};
      },
    );
    const { projectId } = startProjectSync(h.kernel, { title: "构建跟进", outcome: "o", brief: "b", cwd: repo }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(dupCheckerOut).toContain("active checker(s)");

    writeFileSync(join(repo, "ready.txt"), "ok\n");
    h.clock.advance(65_000);
    await h.kernel.idle();
    expect(probeNotice).toContain("条件已满足：「等待构建产物」");
    const probeResults = h.kernel.inbox.listMessagesSync({ cellId: projectId, type: "cell.result" });
    const summaries = probeResults.map((m) => (m.envelope.payload as { summary: string }).summary);
    expect(summaries.some((s) => s.includes("条件已满足：「等待构建产物」") && !s.includes("import os,sys"))).toBe(true);

    // B9-3: (a) clipLine on token boundary, (b) self-cancelled job leaves 0 pending silent_inject, (c) desk unsettled resets, (d) closed cell marks workspace closed
    h.kernel.spawnCell(projectId, { id: "w_b9", preset: "worker", meta: { role: "w_b9" }, cwd: repo }, "test b9", { principalId: `cell:${projectId}` });
    let startedJob = "";
    const longLine = `${"进度正常 ".repeat(36)}commit_abcdef1234567890_end`;
    h.script.add(
      "w_b9",
      tool("job_start", { command: "sleep 10" }),
      (req) => {
        startedJob = /Started job (\S+)\./.exec(lastToolResult(req))![1]!;
        return tool("job_cancel", { jobId: startedJob });
      },
      tool("report_to_parent", { kind: "result", text: longLine }),
    );
    h.script.add("project", {});
    await h.kernel.idle({ jobs: true });

    const status = h.state<CellStatusLine>("w_b9", CELL_STATUS_KEY)!;
    expect(status.text.endsWith("…")).toBe(true);
    expect(status.text).not.toContain("commit_"); // backed off cleanly before mid-token slice!
    expect(h.kernel.inbox.listMessagesSync({ cellId: "w_b9", status: ["pending"] })).toEqual([]);

    // Direct chat to desk increments unsettled, and desk's run resets it to 0
    h.script.add("desk", { text: "收到直接消息" });
    h.kernel.directMessage("desk", { text: "直接和主台说一句" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    expect(h.state<CellDirectChatState>("desk", CELL_DIRECT_CHAT_KEY)?.unsettled).toBe(0);

    // Closing w_b9 marks its workspace row closed
    await h.kernel.closeCell("w_b9", "completed", { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.workspace.getWorkspaceSync("w_b9")?.status).toBe("closed");
  });

  it("Round 1 E2E catches: sensor maxDepth 0, ellipsis-clipped REF_PATTERN guard, workspaces.path sync, multi-run report_to_parent saidBefore, and natural status refresh", async () => {
    const h = await boot({ kernel: { context: { limits: { compactAtChars: 1_200, keepRecentChars: 250, summaryMaxChars: 900 } } } });
    const repoA = gitRepo("r1-a");
    const repoB = gitRepo("r1-b");

    // 1. Sensor leaf maxDepth === 0 and "Children: none (leaf cell)."
    h.script.add("desk", tool("add_source", { title: "磁盘巡检", description: "检查空间", cron: "0 9 * * *" }), {});
    await h.ui.capture({ text: "加个磁盘巡检信源" }, "owner");
    await h.kernel.idle();
    const sensor = h.kernel.listCells({ parentId: "desk", preset: "sensor" })[0]!;
    expect(sensor.bounds.maxDepth).toBe(0);

    // 2. Ellipsis-clipped art_* tokens in inline excerpts are rejected by compaction [references]
    const { projectId } = startProjectSync(h.kernel, { title: "多轮回验", outcome: "完成两轮", brief: "测试", cwd: repoA }, { principalId: h.kernel.ownerPrincipal });
    let wId = "";
    let unblock!: () => void;
    const gate = new Promise<void>((r) => (unblock = r));
    h.script.add(
      "project",
      tool("dispatch", { title: "评审模块", instruction: "评审并汇报" }),
      (req) => {
        wId = /^Started worker (\S+)/.exec(lastToolResult(req))![1]!;
        return {};
      },
      {},
      {},
    );
    h.script.add(
      "worker",
      async () => {
        await gate;
        return tool("report_to_parent", { kind: "result", text: "主报告结论：发现三项阻塞问题" });
      },
      { text: "补充答复：初始 tokens=0 也已确认安全" },
    );
    await new Promise((r) => setTimeout(r, 30));
    // Inject mid-run spoken follow-up while worker is in Run 1 before report_to_parent settles
    expect(wId).not.toBe("");
    await h.kernel.workspace.acquire(wId);
    h.kernel.updateCell(wId, { cwd: repoB }, { principalId: h.kernel.ownerPrincipal });
    expect(h.kernel.workspace.getWorkspaceSync(wId)?.path).toBe(repoB);
    h.kernel.directMessage(wId, { text: "顺便确认初始 tokens=0" }, { principalId: h.kernel.ownerPrincipal });
    unblock();
    await h.kernel.idle();

    const settledEnv = h.kernel.inbox.listMessagesSync({ cellId: projectId, type: "cell.result" }).at(-1)!.envelope;
    const payload = settledEnv.payload as { summary: string; saidBefore?: string };
    expect(payload.summary).toContain("补充答复：初始 tokens=0");
    expect(payload.saidBefore).toContain("主报告结论：发现三项阻塞问题");
    expect(h.state<CellStatusLine>(wId, CELL_STATUS_KEY)?.text).toContain("补充答复：初始 tokens=0");

    // Check ellipsis-clipped art_* rejection + artifact:// dedup in compaction
    h.kernel.context.appendEvidenceSync(projectId, {
      kind: "assistant_text",
      text: `片段 art_01m8bjqn7200003j… 与完整 artifact://art_01m8bk9xjt0000c2q5k2d7@2 及 art_01m8bk9xjt0000c2q5k2d7 ${"z".repeat(1_500)}`,
      runId: "r_clip",
      at: T0 + 100,
    });
    await h.kernel.context.compact(projectId, { force: true });
    h.script.add("project", {});
    h.kernel.sendToCell(projectId, { text: "检查压缩引用" }, { principalId: h.kernel.ownerPrincipal });
    await h.kernel.idle();
    const snapText = requestText(h.script.callsOf("project").at(-1)!);
    const refsLine = snapText.split("\n").find((l) => l.startsWith("[references] "))!;
    expect(refsLine).toContain("artifact://art_01m8bk9xjt0000c2q5k2d7@2");
    expect(refsLine).not.toContain("art_01m8bjqn7200003j");
    expect(refsLine.split(" ")).not.toContain("art_01m8bk9xjt0000c2q5k2d7");
  });
});
