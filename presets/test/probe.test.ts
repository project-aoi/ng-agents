import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CELL_STATUS_KEY, PAYLOAD, type CellResultPayload, type CellStatusLine } from "@ng/protocol";
import { KEYS, startProjectSync, type ProbeState } from "../src";
import { boot, childrenOf, cleanupAll, lastToolResult, MIN, requestText, T0, tempDir, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

// BUG-005: a checker given a check command spends nothing while the answer is "not yet". Real shell commands against a
// temp directory — the project's, which the checker works in.

/** A project in `dir` that dispatches one checker with `dispatchArgs`, then just ends its turns. */
async function probeIn(h: Harness, dir: string, dispatchArgs: Record<string, unknown>): Promise<{ project: string; checker: string; output: string }> {
  let output = "";
  h.script.add(
    "project",
    tool("dispatch", { preset: "checker", title: "等发布标记", instruction: "等目录里出现发布标记后报告。", ...dispatchArgs }),
    (req) => {
      output = lastToolResult(req);
      return {};
    },
  );
  const { projectId } = startProjectSync(h.kernel, { title: "发布", outcome: "发布完成", brief: "等发布", cwd: dir });
  await h.kernel.idle();
  return { project: projectId, checker: childrenOf(h, projectId)[0]!, output };
}

const results = (h: Harness, project: string) => h.kernel.inbox.listMessagesSync({ cellId: project, type: PAYLOAD.cellResult }).map((m) => m.envelope.payload as CellResultPayload);
const pendingTimers = (h: Harness, cellId: string) => h.kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.timerFired, status: ["pending"] });
const status = (h: Harness, cellId: string) => h.state<CellStatusLine>(cellId, CELL_STATUS_KEY)?.text ?? "";
const modelCalls = (h: Harness, cellId: string) => h.script.requests.filter((r) => r.cellId === cellId).length;

describe("a checker with a check command", () => {
  it("costs nothing while the answer is 'not yet', keeps exactly one timer, and reports once when the command succeeds — then it is closed", async () => {
    const h = await boot();
    const dir = tempDir("release");
    // A relative path: the command runs in the project's directory.
    const { project, checker, output } = await probeIn(h, dir, { check: { command: "test -f flag", everySec: 60 } });
    expect(output).toContain(`Started checker ${checker}`);
    expect(output).toContain("No model runs for it: it runs `test -f flag` now and then every 60s");
    expect(h.kernel.getCell(checker)).toMatchObject({ status: "active", spec: { lifetime: "one_shot", processor: { kind: "code", entry: "gtd.check_probe" } } });
    expect(h.actions(project)).toEqual([expect.objectContaining({ owner: "waiting", status: "open", cellId: checker })]);

    // The first look happened at once: not yet. One reminder, no repeating schedule, no model.
    expect(status(h, checker)).toMatch(/^未就绪 · 第 1 次检查 · /);
    expect(pendingTimers(h, checker).map((m) => m.deliverAt)).toEqual([T0 + MIN]);
    expect(h.kernel.inbox.listSchedulesSync({ cellId: checker, activeOnly: true })).toEqual([]);
    expect(h.state<ProbeState>(checker, KEYS.probe)).toMatchObject({ checks: 1, cannotRun: 0, lastExit: 1 });

    h.clock.advance(MIN);
    await h.kernel.idle();
    expect(status(h, checker)).toMatch(/^未就绪 · 第 2 次检查 · /);
    expect(pendingTimers(h, checker).map((m) => m.deliverAt)).toEqual([T0 + 2 * MIN]);

    // Something else wakes it early (its project writes to it): it looks at once, and the next look is set afresh —
    // still one timer, not two.
    h.clock.advance(20_000);
    h.kernel.sendToCell(checker, { text: "现在看一下" }, { principalId: `cell:${project}` });
    await h.kernel.idle();
    expect(status(h, checker)).toMatch(/^未就绪 · 第 3 次检查 · /);
    expect(pendingTimers(h, checker).map((m) => m.deliverAt)).toEqual([T0 + 2 * MIN + 20_000]);
    expect(results(h, project)).toEqual([]);
    // The project's roster shows where it stands.
    expect(h.kernel.activityOf([checker]).get(checker)!.state).toBe("waiting");

    let projectSaw = "";
    h.script.add("project", (req) => {
      projectSaw = requestText(req);
      return {};
    });
    writeFileSync(join(dir, "flag"), "v2\n");
    h.clock.advance(MIN);
    await h.kernel.idle();

    const [result] = results(h, project);
    expect(results(h, project)).toHaveLength(1);
    expect(result).toMatchObject({ childCellId: checker, status: "completed", childState: "closed", data: { check: { command: "test -f flag", checks: 4, exitCode: 0, outcome: "holds" } } });
    expect(result!.summary).toMatch(/^条件已满足：`test -f flag` 在 .+ 返回 0（第 4 次检查）。没有输出。$/);
    expect(projectSaw).toContain("条件已满足");
    expect(h.kernel.getCell(checker)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(pendingTimers(h, checker)).toEqual([]);
    expect(h.kernel.inbox.listSchedulesSync({ cellId: checker, activeOnly: true })).toEqual([]);
    expect(h.actions(project)).toEqual([expect.objectContaining({ status: "done", cellId: checker })]);
    // Four checks, zero tokens.
    expect(modelCalls(h, checker)).toBe(0);
    // What it did is on its record for inspect_cell.
    expect(h.kernel.inspectCell(checker, { afterSeq: 0, detail: "full" }).text).toContain("[check #4 · exit 0]");
  });

  it("a command that cannot run — not found, also hidden in a pipeline — is retried once, then reported as failed", async () => {
    const h = await boot();
    const dir = tempDir("release");
    const { project, checker } = await probeIn(h, dir, { check: { command: "ng-no-such-forge-cli pr view 1 | grep -qx MERGED", everySec: 30 } });
    expect(status(h, checker)).toMatch(/^检查命令没能运行（exit 1：命令不存在），稍后再试 · 第 1 次检查 · /);
    expect(pendingTimers(h, checker)).toHaveLength(1);
    expect(results(h, project)).toEqual([]);

    h.script.add("project", {});
    h.clock.advance(30_000);
    await h.kernel.idle();
    const [result] = results(h, project);
    expect(result).toMatchObject({ status: "failed", childState: "closed", data: { check: { outcome: "cannot_run", checks: 2 } } });
    expect(result!.summary).toContain("检查命令连续 2 次没能运行，已停止监听：`ng-no-such-forge-cli pr view 1 | grep -qx MERGED`");
    expect(result!.summary).toContain("（exit 1：命令不存在，");
    expect(h.kernel.getCell(checker)).toMatchObject({ status: "closed" });
    // The project's books: the wait is still open, without a cell — the project decides what comes next.
    expect(h.actions(project)).toEqual([expect.objectContaining({ status: "open", owner: "waiting" })]);
    expect(h.actions(project)[0]!.cellId).toBeUndefined();
    expect(modelCalls(h, checker)).toBe(0);
  });

  it("one failure to run between good checks is forgiven; a deadline that passes ends it as failed, looked at exactly then", async () => {
    const h = await boot();
    const dir = tempDir("release");
    // Runs (exit 1) unless a file says "broken"; 0.05 h = 3 minutes.
    writeFileSync(join(dir, "mode"), "ok\n");
    const { project, checker } = await probeIn(h, dir, { check: { command: 'if grep -q broken mode; then exit 127; fi; test -f flag', everySec: 120, deadlineHours: 0.05 } });
    expect(pendingTimers(h, checker).map((m) => m.deliverAt)).toEqual([T0 + 2 * MIN]);

    writeFileSync(join(dir, "mode"), "broken\n");
    h.clock.advance(2 * MIN);
    await h.kernel.idle();
    expect(status(h, checker)).toMatch(/^检查命令没能运行（exit 127：命令不存在）/);
    expect(h.state<ProbeState>(checker, KEYS.probe)).toMatchObject({ checks: 2, cannotRun: 1 });
    // The next look is the deadline itself, not two minutes later.
    expect(pendingTimers(h, checker).map((m) => m.deliverAt)).toEqual([T0 + 3 * MIN]);

    writeFileSync(join(dir, "mode"), "ok\n");
    h.script.add("project", {});
    h.clock.advance(MIN);
    await h.kernel.idle();
    const [result] = results(h, project);
    expect(result).toMatchObject({ status: "failed", data: { check: { outcome: "deadline", checks: 3, exitCode: 1, deadlineAt: T0 + 3 * MIN } } });
    expect(result!.summary).toMatch(/^到期仍未满足，已停止监听：`.+` 检查了 3 次，截止时间 .+ 已过；最后一次 exit 1。$/);
    expect(h.kernel.getCell(checker)?.status).toBe("closed");
    expect(modelCalls(h, checker)).toBe(0);
  });

  it('until "output_changes": the first check is the baseline; it reports when the output differs, with both', async () => {
    const h = await boot();
    const dir = tempDir("release");
    writeFileSync(join(dir, "state"), "pipeline: running\n");
    const { project, checker } = await probeIn(h, dir, { check: { command: "cat state", everySec: 60, until: "output_changes" } });
    expect(h.state<ProbeState>(checker, KEYS.probe)).toMatchObject({ checks: 1, last: "pipeline: running", lastExit: 0 });
    expect(status(h, checker)).toMatch(/^未就绪 · 第 1 次检查/);

    h.clock.advance(MIN);
    await h.kernel.idle();
    expect(status(h, checker)).toMatch(/^未就绪 · 第 2 次检查/);
    expect(results(h, project)).toEqual([]);

    writeFileSync(join(dir, "state"), "pipeline: failed (job lint)\n");
    h.script.add("project", {});
    h.clock.advance(MIN);
    await h.kernel.idle();
    const [result] = results(h, project);
    expect(result).toMatchObject({ status: "completed", data: { check: { outcome: "changed", checks: 3, previous: "pipeline: running", output: "pipeline: failed (job lint)" } } });
    expect(result!.summary).toContain("之前：pipeline: running");
    expect(result!.summary).toContain("现在：pipeline: failed (job lint)");
    expect(h.kernel.getCell(checker)?.status).toBe("closed");
    expect(modelCalls(h, checker)).toBe(0);
  });
});

describe("dispatch keeps one timer source per checker", () => {
  it("check with schedules and check for a worker are refused; a cron rhythm is told to the checker", async () => {
    const h = await boot();
    const dir = tempDir("repo");
    let checker = "";
    let checkerTask = "";
    h.script.add(
      "project",
      tool("dispatch", { preset: "checker", title: "等", instruction: "等", check: { command: "true" }, schedules: [{ cron: "*/10 * * * *" }] }),
      (req) => {
        expect(lastToolResult(req)).toContain("a checker with check keeps its own timer (check.everySec); leave schedules out.");
        return tool("dispatch", { preset: "worker", title: "等", instruction: "等", check: { command: "true" } });
      },
      (req) => {
        expect(lastToolResult(req)).toContain('check is for a checker — give preset "checker"');
        expect(childrenOf(h, projectId)).toEqual([]);
        return tool("dispatch", { preset: "checker", title: "等 MR !9 合入", instruction: "检查 MR !9 是否合入。", schedules: [{ cron: "*/10 * * * *", tz: "Asia/Shanghai" }] });
      },
      (req) => {
        checker = /^Started checker (\S+)/.exec(lastToolResult(req))![1]!;
        return {};
      },
    );
    h.script.add("checker", (req) => {
      checkerTask = requestText(req);
      return tool("wait", { reason: "还没合入", waitingFor: "external" });
    });
    const { projectId } = startProjectSync(h.kernel, { title: "p", outcome: "o", brief: "b", cwd: dir });
    await h.kernel.idle();
    expect(h.script.pending("project")).toBe(0);
    expect(childrenOf(h, projectId)).toEqual([checker]);
    expect(h.kernel.getCell(checker)!.spec.schedules).toEqual([expect.objectContaining({ cron: "*/10 * * * *", tz: "Asia/Shanghai" })]);
    expect(checkerTask).toContain("检查 MR !9 是否合入。");
    expect(checkerTask).toContain('[You are woken on a fixed schedule: cron "*/10 * * * *" (Asia/Shanghai). Do not set reminders of your own');
    // That schedule is its one timer source: nothing else was attached.
    expect(h.kernel.inbox.listSchedulesSync({ cellId: checker, activeOnly: true })).toHaveLength(1);
    expect(pendingTimers(h, checker)).toEqual([]);
  });
});
