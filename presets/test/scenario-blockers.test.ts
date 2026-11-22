import type { ModelRequest } from "@ng/loop/testing";
import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD } from "@ng/protocol";
import { startProjectSync } from "../src";
import { boot, childrenOf, cleanupAll, continuesRun, gitRepo, lastToolResult, requestText, systemOf, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

const KEY = "ci-develop-lint";
const TITLE = "develop 分支 lint 任务挂了";
const FIXED = "ci已修复（MR !77），可以 rebase develop 然后继续推进";


/** Each project dispatches one feature worker on its first run, then just ends its turns. */
function projectsDispatchOnce(h: Harness): void {
  h.script.setDefault("project", (req: ModelRequest) => {
    const self = req.metadata!.cellId!;
    if (continuesRun(req) || childrenOf(h, self).length > 0) return {};
    return tool("dispatch", { title: "实现 feature", instruction: "在本仓库实现 feature 并让 CI 通过后报告。" });
  });
}

describe("docs/05 scenario 4 — several workers blocked by the same CI failure: one fixer, everyone woken", () => {
  it("two workers of two projects ask the desk; with its own note, spawn_cell and send_message the desk starts one fixer, wakes the waiter and learns the other was stopped meanwhile", async () => {
    const h = await boot();
    projectsDispatchOnce(h);
    const fixers: string[] = [];
    const steps = new Map<string, number>();
    // Feature workers: CI fails for a reason outside their change → ask the desk and sleep; after the desk's word → finish.
    // The fixer: works until the owner says CI is green again, then reports.
    h.script.setDefault("worker", (req) => {
      const self = req.metadata!.cellId!;
      if (continuesRun(req)) return {};
      const n = steps.get(self) ?? 0;
      steps.set(self, n + 1);
      if (h.kernel.getCell(self)?.parentId === "desk") return n === 0 ? tool("wait", { reason: "修复中" }) : tool("report_to_parent", { kind: "result", text: "develop 的 lint 已修复（MR !77 已合入）" });
      if (n === 0) {
        return {
          toolCalls: [
            { name: "send_message", input: { to: "inbox:desk", summary: "工作区冲突/公共受阻请求裁决", text: `cwd: ${h.kernel.getCell(self)!.spec.cwd}\nbranch: feat/x\nCI develop lint 任务失败，与本改动无关。` } },
            { name: "wait", input: { reason: "等待 desk 裁决", waitingFor: "inbox:desk" } },
          ],
        };
      }
      expect(requestText(req)).toContain("ci已修复");
      return tool("report_to_parent", { kind: "result", text: "已 rebase develop，CI 通过，feature 完成。" });
    });

    const repo1 = gitRepo("svc1");
    const repo2 = gitRepo("svc2");
    // 1. The first report: the desk looks at its note (nothing open), starts one fixer and notes the blocker.
    h.script.add(
      "desk",
      (req) => {
        expect(requestText(req)).toContain("工作区冲突/公共受阻请求裁决");
        // the tools for this are the general primitives; there is no blocker tool
        const names = req.tools.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(["read_state", "set_state", "spawn_cell", "send_message"]));
        expect(names).not.toContain("open_blocker");
        expect(names).not.toContain("resolve_blocker");
        // The report can wake the desk before the sender registers its wait.
        return tool("spawn_cell", { preset: "worker", title: "修复公共 CI", meta:{relatedProjectIds:[p1]}, cwd: repo1, instruction: "在独立 worktree 基于 origin/develop 修复 lint，提 MR 并合入。" });
      },
      (req) => {
        fixers.push(/cell id (\S+)\. It starts now; you are woken when its turn is over\./.exec(lastToolResult(req))![1]!);
        return tool("wait", { reason: "修复中" });
      },
    );
    const p1 = startProjectSync(h.kernel, { title: "服务一的 feature", outcome: "feature 上线", brief: "实现 feature", cwd: repo1 }).projectId;
    await h.kernel.idle();
    const w1 = childrenOf(h, p1)[0]!;
    expect(h.kernel.listWaits([w1])).toEqual([expect.objectContaining({ waitingFor: "inbox:desk" })]);
    expect(fixers).toHaveLength(1);
    expect(h.kernel.getCell(fixers[0]!)).toMatchObject({ parentId: "desk", preset: "worker", spec: { cwd: repo1, lifetime: "wakeable" } });
    expect(h.kernel.listWaits([w1])[0]?.waitingFor).toBe("inbox:desk");

    // 2. The same cause from another project: the desk's note says a fixer is on it, so the reporter only joins the note.
    h.script.add(
      "desk",
      (req) => {
        expect(requestText(req)).toContain("工作区冲突/公共受阻请求裁决");
        expect(requestText(req)).toContain(repo2);
        expect(requestText(req)).toContain(fixers[0]!);
        return tool("wait", { reason: "joined" });
      },
    );
    const p2 = startProjectSync(h.kernel, { title: "服务二的 bugfix", outcome: "bug 修复", brief: "修 bug", cwd: repo2 }).projectId;
    await h.kernel.idle();
    const w2 = childrenOf(h, p2)[0]!;
    expect(h.kernel.listWaits([w2])).toEqual([expect.objectContaining({ waitingFor: "inbox:desk" })]);
    expect(h.kernel.listWaits([w1,w2])).toHaveLength(2);
    // exactly one fixer for the one cause
    expect(childrenOf(h, "desk", "worker")).toEqual(fixers);

    // 3. Meanwhile the owner stops the second worker; its project keeps the action open for a successor.
    await h.kernel.closeCell(w2, "cancelled");
    await h.kernel.idle();
    expect(h.actions(p2)).toEqual([expect.objectContaining({ status: "open", owner: "agent" })]);
    expect(h.actions(p2)[0]!.cellId).toBeUndefined();

    // 4. The fixer's turn ends: the desk is told (never swallowed), writes to every waiter in its note and clears it.
    // The waiter that was stopped meanwhile comes back as not delivered.
    h.script.add(
      "desk",
      (req) => {
        expect(requestText(req)).toContain("develop 的 lint 已修复");
        expect(requestText(req)).toContain(w1);
        return {
          toolCalls: [w1, w2].map((id) => ({ name: "send_message", input: { to: `inbox:${id}`, summary: "公共问题已处理", text: FIXED } })),
        };
      },
      (req) => {
        const out = lastToolResult(req);
        expect(out).toContain(`Delivered to ${w1}.`);
        expect(out).toContain(`NOT DELIVERED — ${w2} is closed (it was cancelled). Nothing was stored.`);
        return tool("wait", { reason:"resolved" });
      },
    );
    expect(h.kernel.sendToCell(fixers[0]!, { text: "主人：CI 已经绿了，收尾吧" })).toMatchObject({ status: "delivered" });
    await h.kernel.idle();

    expect(h.script.pending("desk")).toBe(0);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => (m.envelope.payload as { childCellId: string }).childCellId)).toContain(fixers[0]);
    // the fixer rests (dormant): the desk could send it more, nothing keeps it busy
    expect(h.kernel.getCell(fixers[0]!)).toMatchObject({ status: "active" });
    expect(h.kernel.activityOf([fixers[0]!]).get(fixers[0]!)!.state).toBe("dormant");
    expect(h.state("desk", "desk:arbitration")).toBeNull();
    // the live waiter was woken by the desk's message and finished its own work; its project's books close the action
    expect(h.kernel.activityOf([w1]).get(w1)!.state).toBe("dormant");
    expect(h.kernel.listWaits([w1])).toEqual([]);
    expect(h.actions(p1)).toEqual([expect.objectContaining({ status: "done", owner: "agent" })]);
    // the closed one got nothing; its project still has the open action for a successor
    expect(h.kernel.inbox.listMessagesSync({ cellId: w2 }).some((m) => JSON.stringify(m.envelope.payload).includes("ci已修复"))).toBe(false);
    expect(h.actions(p2)).toEqual([expect.objectContaining({ status: "open", owner: "agent" })]);
    expect(childrenOf(h, "desk", "worker")).toEqual(fixers);
  });

  it("the primitives the desk relies on: its note is plain state it reads back and clears; a fixer without a real directory is not started; a message to a cell that does not exist is not delivered", async () => {
    const h = await boot();
    h.script.add(
      "desk",
      (req) => {
        for (const removed of ["open_blocker", "resolve_blocker"]) expect(req.tools.map((t) => t.name)).not.toContain(removed);
        return tool("spawn_cell", { preset: "worker", title: "修", instruction: "修", cwd: "/definitely/not/here" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain("is not an existing directory: /definitely/not/here");
        expect(lastToolResult(req)).toContain("Ask the owner for the right path instead of guessing.");
        return tool("send_message", { to: "inbox:nope", summary: "公共问题已处理", text: "好了" });
      },
      (req) => {
        expect(lastToolResult(req)).toContain('NOT DELIVERED — there is no cell "nope".');
        return tool("set_state", { patches: { ["desk:arbitration"]: { "svc-down": { title: "测试环境挂了", fixer: null, waiters: ["desk"] } } } });
      },
      (req) => {
        expect(lastToolResult(req)).toContain("reserved");
        return tool("wait",{reason:"done"});
      },
    );
    await h.ui.capture({ text: "测试一下仲裁笔记" });
    await h.kernel.idle();
    expect(h.script.pending("desk")).toBe(0);
    expect(childrenOf(h, "desk", "worker")).toEqual([]);
    expect(h.state("desk", "desk:arbitration")).toBeNull();
    // the desk's prompt tells it to keep exactly this note
    expect(systemOf(h, "desk")).toContain("relatedProjectIds");
  });
});
