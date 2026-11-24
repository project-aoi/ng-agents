import { resolve } from "node:path";
import { bootDesk, cleanupAll, makeProject, writeAction } from "../helpers";

// Only test-owned temporary data and the scripted in-memory kernel; no CLI or real workspace.
const desk = await bootDesk({
  port: 0,
  webDir: process.env["NG_SCROLL_WEB_DIR"] ?? resolve("apps/gtd-desk/dist/web"),
});
const drafts = Array.from({ length: 48 }, (_, i) => {
  const title = `待办 ${String(i + 1).padStart(2, "0")} / Item ${i + 1}`;
  const draft = { title, subjectKey: `scroll:${i}`, description: "本条为滚动回归的自建测试内容。",
    dueAt: desk.clock.now() + i * 1000, options: [{ id: "reply", label: "回复 / Reply", effect: "reply" as const }] };
  desk.kernel.humanItems.create(draft, "desk", `scroll-card-${i}`);
  return draft;
});
for (let i = 0; i < 32; i++) {
  const id = makeProject(desk.kernel, `项目 ${String(i + 1).padStart(2, "0")} / Project ${i + 1}`);
  writeAction(desk.kernel, id, { title: "核对测试产物 / Check fixture", owner: "agent" });
  writeAction(desk.kernel, id, { title: "整理测试依据 / Collect evidence", owner: "agent" });
  desk.kernel.spawnCell(id, { id: `scroll-worker-${i}`, preset: "worker", title: `测试分身 ${i + 1}` }, undefined,
    { principalId: desk.kernel.ownerPrincipal });
}
desk.server.app.post("/__test__/refresh", c => {
  // Existing cards keep their identity. A real bus event drives the real SSE refresh.
  desk.kernel.bus.emit("state.changed", { cellId: "desk", keys: ["gtd:project"] });
  return c.json({ ok: true });
});
desk.server.app.post("/__test__/update", async c => {
  const { mode } = await c.req.json<{ mode: string }>();
  if (mode === "insert") desk.kernel.humanItems.create({ ...drafts[0]!, subjectKey: "scroll:new", title: "新到期事项 / New item", dueAt: desk.clock.now() - 1000 }, "desk");
  if (mode === "move") desk.kernel.humanItems.create({ ...drafts[47]!, dueAt: desk.clock.now() - 2000 }, "desk");
  if (mode === "restore") desk.kernel.humanItems.create(drafts[47]!, "desk");
  return c.json({ ok: true });
});
console.log(JSON.stringify(await desk.server.listen()));
process.on("SIGTERM", () => { void cleanupAll().then(() => process.exit(0)); });
