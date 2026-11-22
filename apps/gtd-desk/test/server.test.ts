import { afterEach, describe, expect, it } from "vitest";
import { projectIdForApproval } from "@ng/presets";
import { gtdKeys, type ActionRecord, type ProjectProposalCard, type ProjectRecord, type SourceRecord } from "@ng/protocol";
import type { Kernel } from "@ng/cell";
import type {
  PlanSaveResponse,
  ProjectMutationResponse,
  RadarDTO,
  ReviewMutationResponse,
  SourcesMutationResponse,
  StatusDTO,
  WeeklyReviewDTO,
} from "../src/shared/api";
import { createDeskServer } from "../src/server/boot";
import { viewsForBusEvent } from "../src/server/events";
import { SecurityConfigError, isLoopbackHost } from "../src/server/security";
import { SKILL_SUGGESTION_PREFIX } from "../src/server/projections";
import { BUILTIN_SKILLS } from "@ng/presets";
import { bootDesk, bootRealDesk, cellMessages, cleanupAll, DAY, makeProject, makeReviewCard, requestText, tempDir, writeAction } from "./helpers";

afterEach(cleanupAll);

const TOKEN = "t0ken-for-tests-0123456789";

describe("the bearer-token rule (docs/01 坑 1)", () => {
  it("refuses to start on a non-loopback host without a token, or with a weak one", async () => {
    await expect(bootDesk({ host: "0.0.0.0", token: null })).rejects.toBeInstanceOf(SecurityConfigError);
    await expect(bootDesk({ host: "192.168.1.20", token: "short" })).rejects.toThrow(/too short/);
    await expect(createDeskServer({ env: { NG_DESK_HOST: "::" }, dataDir: tempDir("refuse"), webDir: null, log: () => undefined })).rejects.toBeInstanceOf(
      SecurityConfigError,
    );
    expect(["127.0.0.1", "127.8.0.1", "::1", "[::1]", "localhost"].every(isLoopbackHost)).toBe(true);
    expect(["0.0.0.0", "::", "10.0.0.2", "example.com"].some(isLoopbackHost)).toBe(false);
  });

  it("enforces the token on /api/* when set", async () => {
    const d = await bootDesk({ host: "0.0.0.0", token: TOKEN });
    const none = await d.req("GET", "/api/status");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await d.req("GET", "/api/status", undefined, { authorization: "Bearer wrong-token-0123456789" })).status).toBe(401);
    const ok = await d.req<StatusDTO>("GET", "/api/status", undefined, { authorization: `Bearer ${TOKEN}` });
    expect(ok.status).toBe(200);
    expect(ok.json.auth).toEqual({ tokenRequired: true });
    expect((await d.req("POST", "/api/capture", { text: "hi" })).status).toBe(401);
    // ?token= is only for the SSE stream (EventSource cannot send headers)
    expect((await d.req("GET", `/api/status?token=${TOKEN}`)).status).toBe(401);
    const sse = await d.server.app.request(`/api/events?token=${TOKEN}`);
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    await sse.body!.cancel();
  });

  it("on loopback without a token, rejects writes a foreign web page could forge", async () => {
    const d = await bootDesk();
    const cap = (headers: Record<string, string>, body = JSON.stringify({ text: "x" })) => d.server.app.request("/api/capture", { method: "POST", body, headers });
    expect((await cap({ "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect((await cap({ "content-type": "application/json", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await cap({ "content-type": "text/plain", "content-length": "12" })).status).toBe(415);
    expect((await d.server.app.request("http://evil.example/api/status")).status).toBe(403);
    expect((await d.server.app.request("/api/status", { headers: { host: "rebound.example:8790" } })).status).toBe(403);
    expect((await cap({ "content-type": "application/json", origin: "http://localhost:5173" })).status).toBe(200);
  });
});

describe("boot with the real presets", () => {
  it("registers @ng/presets before start, seeds the built-in playbooks, creates the desk with the inline preset and takes a capture", async () => {
    const d = await bootDesk({ registerPresets: undefined as never });
    expect(d.kernel.getCell("desk")).toMatchObject({ preset: "inline", status: "active", title: "主台" });
    expect(d.kernel.registry.presets.list().map((p) => p.name).sort()).toEqual(["checker", "hub", "inline", "project", "sensor", "worker"]);
    // The playbooks the presets' prompts refer to, as global skills (seedBuiltinSkills at boot).
    expect(d.kernel.context.listSkillsSync().map((x) => x.name).sort()).toEqual(BUILTIN_SKILLS.map((x) => x.name).sort());
    await d.post("/api/capture", { text: "把这篇文章存进阅读清单 https://example.com/a" });
    await d.kernel.idle();
    expect(d.script.requests.some((r) => r.cellId === "desk")).toBe(true);
  });

  it("requires an installed CLI at startup", async () => {
    await expect(createDeskServer({ env: {}, detectCli: () => false })).rejects.toThrow(/claude、codex 或 agy/);
  });

});

describe("live updates", () => {
  it("maps bus events to coarse view refreshes", () => {
    expect(viewsForBusEvent("inbox.enqueued", { cellId: "worker", reason: "enqueued" })).toEqual(expect.arrayContaining(["agents", "status"]));
    expect(viewsForBusEvent("approval.changed", { actionId: "a", cellId: "desk", subjectKey: "s", status: "pending" })).toEqual(expect.arrayContaining(["inbox", "activity"]));
    expect(viewsForBusEvent("state.changed", { cellId: "desk", keys: [gtdKeys.action("x")] })).toEqual(expect.arrayContaining(["inbox", "radar"]));
    expect(viewsForBusEvent("state.changed", { cellId: "s", keys: [gtdKeys.source] })).toEqual(["sources", "review"]);
    expect(viewsForBusEvent("state.changed", { cellId: "desk", keys: ["coord:state"] })).toEqual([]);
  });

  it("streams hello, then refresh events after a change", async () => {
    const d = await bootDesk();
    const res = await d.server.app.request("/api/events");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        text += decoder.decode(value);
      }
    };
    await until("event: hello");
    makeReviewCard(d.kernel);
    await until("event: refresh");
    expect(text).toMatch(/event: refresh\ndata: \{"views":\[[^\]]*"inbox"/);
    await reader.cancel();
  });
});

describe("⚡ sources", () => {
  it("create, pause, observe mode and delete a script source", async () => {
    const d = await bootDesk();
    const bad = await d.req("POST", "/api/sources", { title: "x", schedule: { cron: "every monday" }, check: { kind: "script", path: "a.sh" } });
    expect(bad.status).toBe(400);
    const c = await d.post<SourcesMutationResponse>("/api/sources", { title: "核心指标巡检", schedule: { cron: "0 9 * * 1", tz: "Asia/Shanghai" }, check: { kind: "script", path: "checks/metrics.sh" } });
    expect(c).toMatchObject({ outcome: "created", view: { sensors: [{ title: "核心指标巡检", scheduleText: "每周一 09:00（Asia/Shanghai）", processor: "code", mode: "active" }] } });
    const id = c.sensorId!;
    expect(d.kernel.getCell(id)!.spec).toMatchObject({ preset: "sensor", processor: { kind: "code", entry: "gtd.sensor_script",args:{script:"checks/metrics.sh"} }, schedules: [{ cron: "0 9 * * 1", tz: "Asia/Shanghai" }] });
    expect(d.kernel.inbox.listSchedulesSync({ cellId: id, activeOnly: true })).toHaveLength(1);
    // a script check runs commands in a directory of its own — never given a cwd (so never the owner's repository),
    // no worktree, no sandbox; nothing about read/write modes is asked any more (docs/05 proposal 03)
    expect(d.kernel.getCell(id)!.spec.cwd).toBeUndefined();
    expect(d.kernel.getCell(id)!.bounds.isolation).toBe("none");

    const p = await d.post<SourcesMutationResponse>(`/api/sources/${id}/pause`);
    expect(p.view.sensors[0]).toMatchObject({ status: "paused", statusLabel: "已暂停" });
    expect(d.kernel.getCell(id)!.status).toBe("paused");
    const m = await d.req<SourcesMutationResponse>("PUT", `/api/sources/${id}/mode`, { mode: "observe" });
    expect(m.json.view.sensors[0]).toMatchObject({ mode: "observe" });
    expect(d.kernel.context.readStateSync<SourceRecord>(id, gtdKeys.source)).toMatchObject({ mode: "observe", status: "paused" });
    const del = await d.req<SourcesMutationResponse>("DELETE", `/api/sources/${id}`);
    expect(del.json).toMatchObject({ outcome: "deleted", view: { sensors: [] } });
    expect(d.kernel.getCell(id)!.status).toBe("closed");
  });

  it("an llm source starts with its instruction as the first task", async () => {
    const d = await bootDesk();
    const c = await d.post<SourcesMutationResponse>("/api/sources", { title: "群反馈挖掘", schedule: { everyMinutes: 30 }, check: { kind: "llm", instruction: "看看研发群里有没有人反馈支付报错" }, mode: "observe" });
    const id = c.sensorId!;
    expect(d.kernel.getCell(id)!.spec.schedules).toEqual([{ cron: "*/30 * * * *" }]);
    await d.kernel.idle();
    expect(d.script.requests.some((r) => r.cellId === id)).toBe(true);
  });
});

describe("weekly review actions", () => {
  it("accepts a suggested skill", async () => {
    const d = await bootDesk();
    d.kernel.context.commitSync("desk", { statePatches: { [`${SKILL_SUGGESTION_PREFIX}reply-style`]: { name: "reply-style", description: "回复客户的语气", body: "- 先结论" } } });
    const before = d.kernel.context.listSkillsSync().map((x) => x.name);
    expect(before).not.toContain("reply-style");
    const s = await d.post<ReviewMutationResponse>("/api/review/skills/reply-style/accept");
    expect(s).toMatchObject({ outcome: "skill_saved", view: { skillSuggestions: [] } });
    // exactly one skill more than the built-in playbooks: the one accepted
    expect(d.kernel.context.listSkillsSync().map((x) => x.name).sort()).toEqual([...before, "reply-style"].sort());
    expect(d.kernel.context.getKnowledgeSync({ kind: "skill", name: "reply-style", scope: "global" })).toMatchObject({ description: "回复客户的语气" });


  });

  it("switches an llm source to a zero-token script check", async () => {
    const d = await bootDesk();
    const c = await d.post<SourcesMutationResponse>("/api/sources", { title: "指标", schedule: { cron: "0 9 * * *" }, check: { kind: "llm", instruction: "看指标" } });
    const r = await d.post<ReviewMutationResponse>(`/api/review/sensors/${c.sensorId}/code`, { entry: "script:checks/metrics.sh" });
    expect(r.outcome).toBe("switched_to_code");
    expect(d.kernel.getCell(c.sensorId!)!.spec.processor).toEqual({ kind: "code", entry: "gtd.sensor_script",args:{script:"checks/metrics.sh"} });
    expect(d.kernel.context.readStateSync<SourceRecord>(c.sensorId!, gtdKeys.source)!.processor).toBe("code");
    expect((await d.req("POST", `/api/review/sensors/${c.sensorId}/code`, { entry: "not-registered" })).status).toBe(400);
  });
});

function proposalCard(kernel: Kernel, title = "官网改版"): string {
  const proposal = { title, outcome: "新官网上线", actions: [{ title: "出设计稿", owner: "agent" as const }] };
  kernel.context.commitSync("desk", { artifact: { artifactId: `art_${title}`, content: { format: "json", body: JSON.stringify(proposal), data: proposal }, updatedBy: "agent" } });
  const card: ProjectProposalCard = {
    cardType: "project_proposal",
    subjectKey: `msg:${title}`,
    title,
    source: { label: "随手记", at: kernel.clock.now() },
    rawInput: { text: `想做${title}`, kind: "message" },
    prep: { summary: "", checked: [] },
    proposal,
    draft: { artifactId: `art_${title}`, version: 1 },
  };
  const r = kernel.gate.authorizeSync(
    { type: "project.start", proposal, artifactId: `art_${title}`, summary: "立项", subjectKey: card.subjectKey, sideEffect: "external", card: { format: "card", body: title, data: card } },
    { cellId: "desk", principalId: "cell:desk", epoch: kernel.getCell("desk")!.epoch, artifactVersion: 1 },
  );
  if (r.type !== "defer") throw new Error(r.type);
  return r.actionId;
}

describe("project proposal card", () => {
  it("edit plan saves with version protection; “先放进以后再说” creates the real project paused, nothing runs; activate starts that same project", async () => {
    const d = await bootRealDesk();
    const id = proposalCard(d.kernel);
    const plan = { outcome: "新官网上线", actions: [{ title: "出设计稿", owner: "agent" }, { title: "约设计师", owner: "human", effort: "15m" }] };
    const saved = await d.req<PlanSaveResponse>("PUT", `/api/human-items/${id}/plan`, { expectedVersion: 1, proposal: plan });
    expect(saved.json).toMatchObject({ outcome: "saved" });
    const edited = d.server.desk.listHumanItems().find(i => i.id === id)!;
    expect(edited).toMatchObject({ artifactVersion: 2, proposal: { actions: [{}, { title: "约设计师" }] } });
    const conflict = await d.req<PlanSaveResponse>("PUT", `/api/human-items/${id}/plan`, { expectedVersion: 1, proposal: plan });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ ok: false, outcome: "conflict", current: { version: 2 } });

    const parked = await d.post<{status:string;projectId:string}>(`/api/human-items/${id}/decide`, {
      optionId: "system.someday", seenItemRevision: edited.itemRevision, seenArtifactVersion: edited.artifactVersion,
    });
    expect(parked.status).toBe("someday");
    expect(d.server.desk.listHumanItems()).toHaveLength(0);
    const projectId = parked.projectId;
    // the real project cell (the id an approval would have given it), paused before it ever ran — not an empty
    // holder that is closed at once
    expect(projectId).toBe(projectIdForApproval(id));
    expect(d.kernel.getCell(projectId)).toMatchObject({ preset: "project", status: "paused", pauseReason: "parked", parentId: "desk" });
    const record = d.kernel.context.readStateSync<ProjectRecord>(projectId, gtdKeys.project)!;
    expect(record).toMatchObject({ lifecycle: "active", title: "官网改版" });
    expect(record.proposal!.actions).toHaveLength(2);
    // its first task waits in the queue, unclaimed
    expect(d.kernel.inbox.listMessagesSync({ cellId: projectId, type: "cell.task" })).toMatchObject([{ status: "pending" }]);
    await d.kernel.idle();
    expect(d.script.requests).toEqual([]);

    const radar = await d.get<RadarDTO>("/api/radar");
    expect(radar.someday.map((p) => p.id)).toEqual([projectId]);
    expect(radar.someday[0]!.buttons.map((b) => b.id)).toEqual(["activate", "cancel"]);
    const a = await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/activate`);
    expect(a).toMatchObject({ outcome: "activated", view: { someday: [] } });
    expect(a.view.projects.map((p) => p.id)).toEqual([projectId]);
    expect(d.kernel.getCell(projectId)!.status).toBe("active");
    expect(cellMessages(d.kernel, projectId).map((e) => (e.payload as { text: string }).text)).toEqual([expect.stringContaining("主人点了启动")]);
    await d.kernel.idle();
    // it ran once, with its brief (the plan the owner saw) and the owner's go-ahead in the same wake-up
    const runs = d.script.requests.filter((r) => r.cellId === projectId);
    expect(runs).toHaveLength(1);
    expect(requestText(runs[0]!.req)).toContain("约设计师");
    expect(requestText(runs[0]!.req)).toContain("主人点了启动");
    expect(d.kernel.context.readStateSync<ProjectRecord>(projectId, gtdKeys.project)).toMatchObject({ lifecycle: "active", title: "官网改版" });
  });
});

describe("escalations and completion", () => {

  it("project complete closes the tree and shows up in the weekly review", async () => {
    const d = await bootDesk();
    const p = makeProject(d.kernel, "季度总结");
    d.kernel.spawnCell(p, { id: "w", preset: "worker", title: "汇总数据" });
    const r = await d.post<ProjectMutationResponse>(`/api/projects/${p}/complete`);
    expect(r).toMatchObject({ outcome: "completed", view: { counts: { completedThisWeek: 1 } } });
    expect(r.view.review.completed).toMatchObject([{ kind: "project", title: "季度总结" }]);
    expect(d.kernel.getCell("w")!.status).toBe("closed");
  });


  it("unknown ids are 404s; a decided card is a 409", async () => {
    const d = await bootDesk();
    expect((await d.req("POST", "/api/human-items/missing/decide", { optionId: "done", seenItemRevision: 1 })).status).toBe(404);
    expect((await d.req("GET", "/api/artifacts/nope")).status).toBe(404);
    expect((await d.req("POST", "/api/projects/nope/pause")).status).toBe(404);
    expect((await d.req("GET", "/api/nothing-here")).status).toBe(404);
    const { actionId } = makeReviewCard(d.kernel);
    const choice = { optionId: "system.reply", seenArtifactVersion: 1, seenItemRevision: 1 };
    await d.post(`/api/human-items/${actionId}/decide`, choice);
    expect((await d.req("POST", `/api/human-items/${actionId}/decide`, choice)).status).toBe(409);
    const malformed = await d.server.app.request("/api/capture", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: { code: "invalid_json", message: "请求体不是合法的 JSON" } });
  });
});
