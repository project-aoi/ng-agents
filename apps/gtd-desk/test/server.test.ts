import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, type ActionRecord, type ProjectProposalCard, type ProjectRecord, type SourceRecord } from "@ng/protocol";
import type { Kernel } from "@ng/cell";
import type {
  ApproveResponse,
  ClarifyMutationResponse,
  ClarifyQueueDTO,
  EngageMutationResponse,
  ProjectMutationResponse,
  RadarDTO,
  ReviewMutationResponse,
  SourcesMutationResponse,
  StatusDTO,
  WeeklyReviewDTO,
} from "../src/shared/api";
import { createDeskServer } from "../src/server/boot";
import { PLACEHOLDER_DEMO } from "../src/server/demo";
import { viewsForBusEvent } from "../src/server/events";
import { SecurityConfigError, isLoopbackHost } from "../src/server/security";
import { SKILL_SUGGESTION_PREFIX } from "../src/server/projections";
import { bootDesk, cleanupAll, DAY, makeProject, makeReplyCard, tempDir, writeAction } from "./helpers";

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

  it("enforces the token on /api/* when set; webhooks authenticate by signature instead", async () => {
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
    const hook = await d.req("POST", "/hooks/github", { zen: "hi" });
    expect(hook.status).toBe(404);
    expect(hook.json).toEqual({ error: "unknown_channel" });
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
  it("registers @ng/presets before start, creates the desk with the inline preset and takes a capture", async () => {
    const d = await bootDesk({ registerPresets: undefined as never });
    expect(d.kernel.getCell("desk")).toMatchObject({ preset: "inline", status: "active", title: "主台" });
    expect(d.kernel.registry.presets.list().map((p) => p.name).sort()).toEqual(["inline", "sensor", "watcher", "worker"]);
    await d.post("/api/capture", { text: "把这篇文章存进阅读清单 https://example.com/a" });
    await d.kernel.idle();
    expect(d.script.requests.some((r) => r.cellId === "desk")).toBe(true);
    expect((await d.get<StatusDTO>("/api/status")).demo).toBe(false);
  });

  it("starts in demo mode when no CLI agent is installed and no model is configured", async () => {
    const server = await createDeskServer({ env: {}, detectCli: () => false, demo: PLACEHOLDER_DEMO, dataDir: tempDir("demo"), kernel: { db: ":memory:" }, webDir: null, log: () => undefined });
    try {
      const s = (await (await server.app.request("/api/status")).json()) as StatusDTO;
      expect(s).toMatchObject({ demo: true, backend: "demo" });
    } finally {
      await server.close();
    }
  });
});

describe("live updates", () => {
  it("maps bus events to coarse view refreshes", () => {
    expect(viewsForBusEvent("approval.changed", { actionId: "a", cellId: "desk", subjectKey: "s", status: "pending" })).toContain("clarify");
    expect(viewsForBusEvent("state.changed", { cellId: "desk", keys: [gtdKeys.action("x")] })).toEqual(expect.arrayContaining(["engage", "radar"]));
    expect(viewsForBusEvent("state.changed", { cellId: "s", keys: [gtdKeys.source] })).toEqual(["sources", "review"]);
    expect(viewsForBusEvent("state.changed", { cellId: "desk", keys: ["coord:state"] })).toEqual([]);
    expect(viewsForBusEvent("channel.focus", { on: true, buffered: 0 })).toEqual(["status", "engage"]);
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
    makeReplyCard(d.kernel);
    await until("event: refresh");
    expect(text).toMatch(/event: refresh\ndata: \{"views":\[[^\]]*"clarify"/);
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
    expect(d.kernel.getCell(id)!.spec).toMatchObject({ preset: "sensor", processor: { kind: "code", entry: "script:checks/metrics.sh" }, schedules: [{ cron: "0 9 * * 1", tz: "Asia/Shanghai" }] });
    expect(d.kernel.inbox.listSchedulesSync({ cellId: id, activeOnly: true })).toHaveLength(1);
    // a script check runs bash, so it gets its own worktree instead of the owner's directory
    expect(d.kernel.getCell(id)!.bounds.isolation).toBe("git_worktree");
    expect([...d.kernel.getCell(id)!.bounds.tools].sort()).toEqual(["bash", "read"]);

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
  it("accepts a suggested skill and enables an auto rule for a class approved unedited five times", async () => {
    const d = await bootDesk();
    d.kernel.context.commitSync("desk", { statePatches: { [`${SKILL_SUGGESTION_PREFIX}reply-style`]: { name: "reply-style", description: "回复客户的语气", body: "- 先结论" } } });
    const s = await d.post<ReviewMutationResponse>("/api/review/skills/reply-style/accept");
    expect(s).toMatchObject({ outcome: "skill_saved", view: { skillSuggestions: [] } });
    expect(d.kernel.context.listSkillsSync().map((x) => x.name)).toEqual(["reply-style"]);

    for (let i = 0; i < 5; i++) {
      const { actionId } = makeReplyCard(d.kernel, { text: `第 ${i} 次回复` });
      expect((await d.post<ApproveResponse>(`/api/clarify/${actionId}/approve`, { seenVersion: 1 })).outcome).toBe("sent");
    }
    const review = await d.get<WeeklyReviewDTO>("/api/review");
    expect(review.ruleSuggestions).toMatchObject([{ actionClass: "channel.send|channel:memory:*", label: "通过 测试通道 对外发送消息", streak: 5 }]);
    expect(review.completed.filter((c) => c.kind === "reply")).toHaveLength(5);
    const enable = review.ruleSuggestions[0]!.buttons[0]!.endpoint!;
    const r = await d.post<ReviewMutationResponse>(enable.path, enable.body);
    expect(r).toMatchObject({ outcome: "rule_enabled", view: { ruleSuggestions: [] } });
    expect(d.kernel.gate.listPolicyRulesSync()).toMatchObject([{ match: { type: "channel.send", target: "channel:memory:*" }, effect: "allow", maxUses: 20 }]);
  });

  it("switches an llm source to a zero-token script check", async () => {
    const d = await bootDesk();
    const c = await d.post<SourcesMutationResponse>("/api/sources", { title: "指标", schedule: { cron: "0 9 * * *" }, check: { kind: "llm", instruction: "看指标" } });
    const r = await d.post<ReviewMutationResponse>(`/api/review/sensors/${c.sensorId}/code`, { entry: "script:checks/metrics.sh" });
    expect(r.outcome).toBe("switched_to_code");
    expect(d.kernel.getCell(c.sensorId!)!.spec.processor).toEqual({ kind: "code", entry: "script:checks/metrics.sh" });
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
  it("edit plan saves with version protection; someday parks it without running anything; activate re-proposes it", async () => {
    const d = await bootDesk();
    const id = proposalCard(d.kernel);
    const plan = { outcome: "新官网上线", actions: [{ title: "出设计稿", owner: "agent" }, { title: "约设计师", owner: "human", effort: "15m" }] };
    const saved = await d.req<ClarifyMutationResponse>("PUT", `/api/clarify/${id}/plan`, { expectedVersion: 1, proposal: plan });
    expect(saved.json).toMatchObject({ outcome: "saved", card: { sourceBar: { version: 2 }, proposal: { actions: [{}, { title: "约设计师" }] } } });
    const conflict = await d.req<ClarifyMutationResponse>("PUT", `/api/clarify/${id}/plan`, { expectedVersion: 1, proposal: plan });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ ok: false, outcome: "conflict", current: { version: 2 } });

    const s = await d.post<ClarifyMutationResponse>(`/api/clarify/${id}/someday`);
    expect(s).toMatchObject({ outcome: "someday", view: { remaining: 0 } });
    const projectId = s.projectId!;
    expect(d.kernel.getCell(projectId)!.status).toBe("closed");
    const record = d.kernel.context.readStateSync<ProjectRecord & { proposal: { actions: unknown[] } }>(projectId, gtdKeys.project)!;
    expect(record).toMatchObject({ lifecycle: "someday", title: "官网改版" });
    expect(record.proposal.actions).toHaveLength(2);
    await d.kernel.idle();
    expect(d.script.requests).toEqual([]);

    const radar = await d.get<RadarDTO>("/api/radar");
    expect(radar.someday.map((p) => p.id)).toEqual([projectId]);
    const a = await d.post<ProjectMutationResponse>(`/api/projects/${projectId}/activate`);
    expect(a).toMatchObject({ outcome: "reproposed", view: { someday: [] } });
    const q = await d.get<ClarifyQueueDTO>("/api/clarify");
    expect(q.cards).toMatchObject([{ id: a.cardId, cardType: "project_proposal", title: "官网改版", proposal: { actions: [{}, { title: "约设计师" }] } }]);
    const ok = await d.post<ApproveResponse>(`/api/clarify/${a.cardId}/approve`, { seenVersion: q.cards[0]!.sourceBar.version });
    expect(ok).toMatchObject({ outcome: "approved", message: "已确认立项，Agent 开始推进" });
  });
});

describe("escalations and completion", () => {
  it("extend on a budget card raises the budget; resolve offline closes the waiting task and finishes its records", async () => {
    const d = await bootDesk();
    const before = d.kernel.gate.usageSync("desk").raisedTokens;
    const card = { cardType: "escalation", subjectKey: "cell:desk", title: "主台的预算已用完", source: { label: "系统", at: 0 }, rawInput: { text: "x", kind: "system" }, prep: { summary: "", checked: [] }, escalation: { reason: "budget_exhausted", explanation: "已用完" } };
    const b = d.kernel.gate.authorizeSync(
      { type: "custom", name: "escalation.budget_exhausted", summary: "预算", subjectKey: "cell:desk", sideEffect: "external", card: { format: "card", body: "x", data: card } },
      { cellId: "desk", principalId: "cell:desk", epoch: d.kernel.getCell("desk")!.epoch },
    );
    if (b.type !== "defer") throw new Error(b.type);
    const r = await d.post<ClarifyMutationResponse>(`/api/clarify/${b.actionId}/extend`);
    expect(r).toMatchObject({ outcome: "continued", message: "已追加额度，继续推进" });
    expect(d.kernel.gate.usageSync("desk").raisedTokens).toBeGreaterThan(before);

    const p = makeProject(d.kernel, "比价");
    d.kernel.spawnCell(p, { id: "wq", preset: "watcher", title: "等 C", bounds: { canSendTo: ["channel:memory:*"] } });
    const wait = writeAction(d.kernel, "wq", { title: "等 C 报价", owner: "waiting" });
    const { actionId } = makeReplyCard(d.kernel, { cellId: "wq", target: "channel:memory:supplier-c", subjectKey: "cell:wq" });
    const off = await d.post<ClarifyMutationResponse>(`/api/clarify/${actionId}/resolve-offline`);
    expect(off).toMatchObject({ outcome: "resolved_offline", message: "已完结，并结束了 1 项相关后台任务" });
    expect(d.kernel.getCell("wq")!.status).toBe("closed");
    expect(d.kernel.context.readStateSync<ActionRecord>("wq", gtdKeys.action(wait.id))).toMatchObject({ status: "done" });
    expect(d.kernel.getCell(p)!.status).toBe("active");
  });

  it("project complete closes the tree and shows up in the weekly review", async () => {
    const d = await bootDesk();
    const p = makeProject(d.kernel, "季度总结");
    d.kernel.spawnCell(p, { id: "w", preset: "worker", title: "汇总数据" });
    const r = await d.post<ProjectMutationResponse>(`/api/projects/${p}/complete`);
    expect(r).toMatchObject({ outcome: "completed", view: { counts: { completedThisWeek: 1 } } });
    expect(r.view.review.completed).toMatchObject([{ kind: "project", title: "季度总结" }]);
    expect(d.kernel.getCell("w")!.status).toBe("closed");
  });

  it("sending from Engage with an unknown receipt finishes the item and leaves the verification in Clarify", async () => {
    const d = await bootDesk();
    const { actionId } = makeReplyCard(d.kernel);
    const t = await d.post<ClarifyMutationResponse>(`/api/clarify/${actionId}/to-human`);
    d.memory.respondWith("unknown");
    const r = await d.post<EngageMutationResponse>(`/api/engage/${t.engageItem!.cellId}/${t.engageItem!.actionId}/send`, { seenVersion: 1 });
    expect(r).toMatchObject({ ok: false, outcome: "unknown", view: { items: [] } });
    expect(r.message).toContain("发送结果未知，请核实");
    expect(r.status.clarify.pending).toBe(1);
    expect((await d.get<ClarifyQueueDTO>("/api/clarify")).cards).toMatchObject([{ id: actionId, state: "send_unknown" }]);
  });

  it("unknown ids are 404s; a decided card is a 409", async () => {
    const d = await bootDesk();
    expect((await d.req("GET", "/api/clarify/act_nope")).status).toBe(404);
    expect((await d.req("POST", "/api/clarify/act_nope/snooze", { until: d.clock.now() + DAY })).status).toBe(404);
    expect((await d.req("POST", "/api/engage/desk/nope/done")).status).toBe(404);
    expect((await d.req("GET", "/api/artifacts/nope")).status).toBe(404);
    expect((await d.req("POST", "/api/projects/nope/pause")).status).toBe(404);
    expect((await d.req("GET", "/api/nothing-here")).status).toBe(404);
    const { actionId } = makeReplyCard(d.kernel);
    await d.post(`/api/clarify/${actionId}/approve`, { seenVersion: 1 });
    expect((await d.req("POST", `/api/clarify/${actionId}/someday`)).status).toBe(409);
    const malformed = await d.server.app.request("/api/capture", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: { code: "invalid_json", message: "请求体不是合法的 JSON" } });
  });
});
