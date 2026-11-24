import { afterEach, expect, it } from "vitest";
import { CELL_PAUSE_KEY, type CellPauseState } from "../src";
import { boot, cleanupAll, requestText, type Harness } from "./helpers";

afterEach(cleanupAll);

const owner = (h: Harness) => ({ principalId: h.kernel.ownerPrincipal });
function project(h: Harness, id = "proj"): void {
  h.kernel.spawnCell("desk", { id, preset: "project", title: "录音笔记", meta: { role: id, projectCellId: id } }, undefined, owner(h));
}

// Audit 2026-11-23 E05: the owner parked a project saying why; nothing kept the words, and three minutes later the desk
// resumed it on an older instruction.
it("a pause keeps who paused, when and with what words — on the cell, in its parent's roster and in inspect_cell", async () => {
  const h = await boot();
  project(h);
  h.clock.advance(60_000);
  expect(h.kernel.control("proj", { action: "pause", pauseReason: "parked", note: "先停一下，我还没想好，放回以后再说" }, owner(h))).toMatchObject({ applied: true });

  expect(h.kernel.context.readStateSync<CellPauseState>("proj", CELL_PAUSE_KEY)).toMatchObject({ by: "owner", reason: "parked", root: "proj", note: "先停一下，我还没想好，放回以后再说" });
  const notes = h.kernel.context.listEvidenceSync("proj").map((e) => e.record).filter((r) => r.kind === "system_note").map((r) => r.text);
  expect(notes.join("\n")).toMatch(/\[parked for later by the owner at 2026-11-17T01:01:00Z: "先停一下，我还没想好，放回以后再说"\./);
  expect(h.kernel.inspectCell("proj").text).toContain('parked for later by the owner at 2026-11-17T01:01:00Z: "先停一下，我还没想好，放回以后再说"');

  // The desk, woken by anything, finds the reason next to the project in its roster — not just "paused".
  let seen = "";
  h.script.add("desk", (req) => {
    seen = requestText(req);
    return { text: "好的" };
  });
  await h.ui.capture({ text: "录音笔记那个怎么样了" }, "owner");
  await h.kernel.idle();
  expect(seen).toContain('parked for later by the owner at 2026-11-17T01:01:00Z: "先停一下，我还没想好，放回以后再说"');
  expect(seen).toContain("ask the owner before you do");

  // Resumed: the open record is closed and the line is gone.
  h.clock.advance(60_000);
  h.kernel.control("proj", { action: "resume", note: "现在开始做" }, owner(h));
  expect(h.kernel.context.readStateSync<CellPauseState>("proj", CELL_PAUSE_KEY)).toMatchObject({ resumedBy: "owner", resumedAt: h.clock.now() });
  const after = h.kernel.inspectCell("proj").text;
  expect(after.split("\n")[0]).not.toContain("parked for later");
  expect(after).toContain('[resumed by the owner at 2026-11-17T01:02:00Z: "现在开始做"]');
});

// Audit 2026-11-23 E06: after a resume the worker got its instruction from before the pause again, unmarked, in the same
// second as the project got the owner's new words — and started before the project had looked.
it("after a resume the coordinator runs first, and an instruction from before the pause is shown as such", async () => {
  const h = await boot({ start: false });
  project(h);
  h.kernel.spawnCell("proj", { id: "w", preset: "worker", title: "实现", meta: { role: "w" } }, "实现录音与引擎接口", owner(h));
  h.clock.advance(60_000);
  h.kernel.control("proj", { action: "pause", pauseReason: "parked", note: "先停一下" }, owner(h));
  expect(h.kernel.context.readStateSync<CellPauseState>("w", CELL_PAUSE_KEY)).toMatchObject({ root: "proj" });
  h.clock.advance(60_000);
  h.kernel.sendToCell("proj", { text: "继续，但只做读文本和预览" }, owner(h));
  h.kernel.control("proj", { action: "resume" }, owner(h));

  const seen: Record<string, string> = {};
  let workerStartedWhileProjectRan = false;
  h.script.add("proj", async (req) => {
    seen["proj"] = requestText(req);
    // Give a worker that is not held back every chance to start.
    await new Promise((r) => setTimeout(r, 150));
    workerStartedWhileProjectRan = h.kernel.activeRuns().some((r) => r.cellId === "w") || seen["w"] !== undefined;
    return { text: "范围已核对" };
  });
  h.script.add("w", (req) => {
    seen["w"] = requestText(req);
    return { text: "done" };
  });
  await h.kernel.start();
  await h.kernel.idle();

  expect(workerStartedWhileProjectRan).toBe(false);
  // (The worker's result then wakes the project once more.)
  expect(h.of("run.started").map((e) => e.cellId).slice(0, 2)).toEqual(["proj", "w"]);
  // The worker's task predates the pause: it is told so. The project's message came after it: no such note.
  expect(seen["w"]).toContain("[from before a pause — the owner parked proj (above you, and you with it) at 2026-11-17T01:01:00Z: \"先停一下\"; the owner resumed it at 2026-11-17T01:02:00Z.");
  // Round 7 (uc74): who resumed it tells the worker what the old instruction is worth — the owner's own restart is
  // their go-ahead, and the project (which ran first) would have sent a newer message if anything changed.
  expect(seen["w"]).toContain("The owner resumed it themselves");
  expect(seen["w"]).toContain("a newer message wins; with none, these stand.");
  expect(seen["w"]).toMatch(/- \S+ \(cell\.task, sent 2026-11-17T01:00:00Z\)/);
  expect(seen["proj"]).not.toContain("[from before a pause");
});

it("a resumed cell with nothing to do itself does not hold the cells below it", async () => {
  const h = await boot({ start: false });
  project(h);
  h.kernel.spawnCell("proj", { id: "w", preset: "worker", title: "实现", meta: { role: "w" } }, "实现", owner(h));
  h.kernel.control("proj", { action: "pause" }, owner(h));
  h.kernel.control("proj", { action: "resume" }, owner(h));
  h.script.add("w", { text: "done" });
  await h.kernel.start();
  await h.kernel.idle();
  expect(h.of("run.started").map((e) => e.cellId)[0]).toBe("w");
});
