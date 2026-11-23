import { afterEach, expect, it } from "vitest";
import { startProjectSync } from "../src";
import { boot, childrenOf, cleanupAll, requestText, tool } from "./helpers";

afterEach(cleanupAll);

// Audit 2026-11-23 E10: the notes a project reads at a wake-up describe its records after the wake-up's bookkeeping —
// not the state before it, which made projects close actions and clear waits that were already settled.
it("a worker's result: the notes show its actions closed, the answered wait gone, and each owner action once", async () => {
  const h = await boot();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let worker = "";
  let seen = "";
  h.script.setDefault("worker", async () => {
    await gate;
    return { text: "改好了，测试也补了" };
  });
  h.script.add(
    "project",
    tool("dispatch", { title: "改代码", instruction: "改代码" }),
    (req) => {
      worker = childrenOf(h, req.metadata!.cellId!)[0]!;
      return {
        toolCalls: [
          // The same worker takes a second piece of work: it now carries two actions.
          { name: "track_action", input: { title: "补测试", owner: "agent", cellId: worker } },
          { name: "track_action", input: { title: "验收：改动", owner: "human", nextStep: "看一下结果" } },
        ],
      };
    },
    () => tool("wait", { reason: "等它做完", waitingFor: `inbox:${worker}` }),
    (req) => {
      seen = requestText(req);
      return {};
    },
  );
  const { projectId } = startProjectSync(h.kernel, { title: "修复导出", outcome: "导出可用", brief: "修复导出" }, { principalId: h.kernel.ownerPrincipal });
  const deadline = Date.now() + 10_000;
  while (h.kernel.listWaits([projectId]).length === 0) {
    if (Date.now() > deadline) throw new Error("the project never registered its wait");
    await new Promise((r) => setTimeout(r, 10));
  }
  release();
  await h.kernel.idle();

  // Both actions the worker carried are closed, and the model is told so instead of finding them listed as open.
  expect(h.actions(projectId).filter((a) => a.cellId === worker).map((a) => [a.title, a.status]).sort()).toEqual([["改代码", "done"], ["补测试", "done"]]);
  expect(seen).toContain("[actions closed for you at this wake-up");
  const from = seen.indexOf("[your open actions]");
  const next = seen.indexOf("\n[", from);
  const open = seen.slice(from, next < 0 ? undefined : next);
  expect(seen).toMatch(/\[actions closed for you[^\n]*\n(- act_\S+ "(改代码|补测试)" \(cell \S+\)\n?){2}/);
  expect(open).toContain("验收：改动");
  expect(open).not.toContain("改代码");
  expect(open).not.toContain("补测试");
  // The wait this result answers is not shown as open any more.
  expect(seen).toContain("[waits answered by this wake-up");
  expect(seen).not.toContain("[your open waits]");
  expect(h.kernel.listWaits([projectId])).toEqual([]);
  // The owner's action appears under the actions only — not a second time as a card.
  expect(seen).not.toContain("[your open cards]");
});
