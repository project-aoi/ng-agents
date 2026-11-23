// Proposal 07 — what the owner can do in the web view, the external main agent can do through its tools: the tools that
// have no case in agent.test.ts (documents and plans, sources, weekly review, activity, models, topology), what the
// older tools gained, and a check that no human HTTP route is left without a tool.

import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, projectIdForApproval } from "@ng/presets";
import type { ProjectRecord, SourceState } from "@ng/presets/records";
import type { CliModelCatalog, CliModelInfo } from "@ng/loop";
import { createRegistry, ManualClock, PAYLOAD, type ActionRecord, type CliEngine, type ProjectProposal } from "@ng/protocol";
import { AGENT_TOOLS } from "../src/agent/guide";
import type { AgentToolResult } from "../src/agent/routes";
import { dropNulls, normalizeArgs, validateArgs } from "../src/agent/tools";
import { SENSOR_SUGGESTION_PREFIX, SKILL_SUGGESTION_PREFIX } from "../src/server/projections";
import type { ActivityListDTO, HumanItemDTO, ModelsDTO, SourcesDTO, TopologyDTO } from "../src/shared/api";
import { agentRedraft, bootDesk, bootRealDesk, cleanupAll, inboundEnvelope, makeProject, makeReviewCard, T0, tempDir, tool, writeActivity, type TestDesk } from "./helpers";

afterEach(cleanupAll);

async function call(d: TestDesk, name: string, args: Record<string, unknown> = {}): Promise<AgentToolResult> {
  const r = await d.req<AgentToolResult>("POST", `/api/agent/tools/${name}`, args);
  expect(r.status, `${name} → HTTP ${r.status}`).toBe(200);
  return r.json;
}

async function ok<T = Record<string, unknown>>(d: TestDesk, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; data: T }> {
  const r = await call(d, name, args);
  expect(r.isError, `${name}: ${r.text}`).toBeFalsy();
  return { text: r.text, data: r.data as T };
}

async function refused(d: TestDesk, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; data: Record<string, unknown> }> {
  const r = await call(d, name, args);
  expect(r.isError, r.text).toBe(true);
  return { text: r.text, data: r.data as Record<string, unknown> };
}

const doc = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;

describe("parity", () => {
  // The human routes and the tool that does the same. /api/events is the browser's own push stream.
  const TOOL_FOR: Record<string, string> = {
    "GET /api/status": "workbench_overview",
    "GET /api/models": "get_models",
    "PUT /api/models": "configure_models",
    "POST /api/capture": "capture",
    "GET /api/projects/closed": "workbench_overview",
    "GET /api/human-items": "list_human_items",
    "POST /api/human-items/:id/decide": "decide_human_item",
    "POST /api/human-activity/:id/undo": "undo_human_decision",
    "POST /api/projects/:id/reopen": "reopen_project",
    "PUT /api/human-items/:id/plan": "save_plan",
    "GET /api/artifacts/:artifactId": "read_artifact",
    "PUT /api/artifacts/:artifactId": "save_artifact",
    "POST /api/artifacts/:artifactId/parked/:parkedId/dismiss": "dismiss_parked",
    "GET /api/radar": "workbench_overview",
    ...Object.fromEntries(["pause", "resume", "cancel", "complete", "someday", "activate"].map((op) => [`POST /api/projects/:projectId/${op}`, "set_project_state"])),
    "POST /api/projects/:projectId/actions": "add_action",
    "GET /api/agents/topology": "get_topology",
    "GET /api/cells/:cellId/timeline": "inspect_cell",
    "GET /api/resources": "read_resource",
    "POST /api/cells/:cellId/messages": "message_cell",
    "POST /api/cells/:cellId/control": "control_cell",
    "POST /api/cells/:cellId/trigger": "control_cell",
    "GET /api/review": "get_review",
    "POST /api/review/skills/:name/accept": "resolve_review_suggestion",
    "POST /api/review/skills/:name/dismiss": "resolve_review_suggestion",
    "POST /api/review/sensors/:sensorId/code": "resolve_review_suggestion",
    "GET /api/activity": "list_activity",
    "POST /api/activity/:cellId/:activityId/restore": "restore_activity",
    "GET /api/sources": "list_sources",
    "POST /api/sources": "create_source",
    "POST /api/sources/:sensorId/pause": "manage_source",
    "POST /api/sources/:sensorId/resume": "manage_source",
    "PUT /api/sources/:sensorId/mode": "manage_source",
    "DELETE /api/sources/:sensorId": "manage_source",
  };

  it("every human route has a tool, and every tool is implemented", async () => {
    const d = await bootDesk();
    const routes = d.server.app.routes
      .filter((r) => r.method !== "ALL" && r.path.startsWith("/api/") && !r.path.startsWith("/api/agent/") && r.path !== "/api/events")
      .map((r) => `${r.method} ${r.path}`);
    expect([...new Set(routes)].sort()).toEqual(Object.keys(TOOL_FOR).sort());
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...new Set(Object.values(TOOL_FOR))]));
    expect(new Set(names).size).toBe(36);
    for (const name of names) expect((await call(d, name, { "no-such-argument": 1 })).text, name).toContain('unknown argument "no-such-argument"');
  });
});

describe("structured arguments", () => {
  it("says which entry and field of a structured argument is wrong, before anything runs", () => {
    const plan = { id: "c", expectedVersion: 1, outcome: "o", actions: [{ title: "a", owner: "human" }] };
    expect(validateArgs(doc("save_plan"), plan)).toBeNull();
    const why = (patch: Record<string, unknown>) => validateArgs(doc("save_plan"), { ...plan, ...patch });
    expect(why({ actions: [{ title: "a", owner: "human" }, { owner: "boss", when: "now" }] })).toMatch(
      /unknown argument "actions\[1\]\.when"; "actions\[1\]\.title" is required; "actions\[1\]\.owner" must be one of "human", "agent", "waiting"/,
    );
    expect(why({ actions: ["a"] })).toContain('"actions[0]" must be an object');
    expect(why({ actions: { title: "a" } })).toContain('"actions" must be an array of objects');
    expect(why({ runnerOverride: "codex" })).toContain('"runnerOverride" must be an object or null');
    expect(why({ runnerOverride: { model: "m" } })).toContain('"runnerOverride.engine" is required');
    expect(why({ runnerOverride: ["codex"] })).toContain('"runnerOverride" must be an object or null');
    expect(why({ runnerOverride: null })).toBeNull();
    expect(validateArgs(doc("capture"), { attachments: [{ label: "x" }] })).toContain('"attachments[0].uri" is required');
    expect(validateArgs(doc("save_artifact"), { id: "a", expectedVersion: 1, body: "", data: "{}" })).toMatch(/"data" must be an object\. Required/);
    // An emptied document is a save; a missing body is not.
    expect(validateArgs(doc("save_artifact"), { id: "a", expectedVersion: 1, body: "" })).toBeNull();
    expect(validateArgs(doc("save_artifact"), { id: "a", expectedVersion: 1 })).toContain('"body" is required');
  });

  it("drops the nulls a client sends for what it leaves out, at any depth, and keeps the one that means something", () => {
    const schema = doc("save_plan").inputSchema;
    expect(dropNulls({ id: "c", title: null, runnerOverride: null, actions: [{ title: "a", owner: "human", effort: null }], data: undefined }, schema)).toEqual({
      id: "c",
      runnerOverride: null,
      actions: [{ title: "a", owner: "human" }],
    });
    expect(dropNulls({ data: { keep: null } }, doc("save_artifact").inputSchema)).toEqual({ data: { keep: null } });
    expect(normalizeArgs(doc("manage_source"), { id: "src_1", action: "pause" })).toEqual({ sensorId: "src_1", action: "pause" });
  });
});

describe("documents", () => {
  it("saves a new version as the control plane's edit; a stale save writes nothing and hands back the current text and what is parked", async () => {
    const d = await bootDesk();
    d.kernel.context.commitSync("desk", { artifact: { artifactId: "art_r", content: { format: "markdown", title: "报告", body: "# v1" }, updatedBy: "agent" } });
    const saved = await ok(d, "save_artifact", { id: "art_r", expectedVersion: 1, body: "# v2\n\n  缩进保留  \n" });
    expect(saved.data).toMatchObject({ outcome: "saved", version: 2, updatedBy: "human", title: "报告", format: "markdown" });
    expect(d.kernel.context.getArtifactSync("art_r")).toMatchObject({ version: 2, updatedBy: "human", content: { body: "# v2\n\n  缩进保留  \n" } });

    // A background worker that was still on v1 is kept aside, not merged over the edit.
    expect(agentRedraft(d.kernel, "art_r", "后台基于 v1 的补充", 1)).toMatchObject({ ok: false });
    expect(d.kernel.context.getArtifactSync("art_r")).toMatchObject({ version: 2, updatedBy: "human" });
    const [aside] = d.kernel.context.listParkedSync("art_r");

    const stale = await refused(d, "save_artifact", { id: "art_r", expectedVersion: 1, body: "覆盖掉" });
    expect(stale.data).toMatchObject({ outcome: "conflict", version: 2, body: "# v2\n\n  缩进保留  \n", parked: [{ id: aside!.id, body: "后台基于 v1 的补充", basedOnVersion: 1 }] });
    expect(stale.text).toContain("nothing was written");
    expect(stale.text).toContain("expectedVersion 2");
    expect(stale.text).toContain("缩进保留");
    expect(stale.text).toContain(aside!.id);
    expect(d.kernel.context.getArtifactSync("art_r")!.version).toBe(2);

    const merged = await ok(d, "save_artifact", { id: "art_r", expectedVersion: 2, body: "合并稿", title: "终稿", format: "text" });
    expect(merged.text).toContain("1 parked addition");
    expect(d.kernel.context.getArtifactSync("art_r")).toMatchObject({ version: 3, content: { format: "text", title: "终稿", body: "合并稿" } });
    expect((await ok(d, "dismiss_parked", { artifactId: "art_r", parkedId: aside!.id })).data).toMatchObject({ parked: [] });
    expect(d.kernel.context.listParkedSync("art_r")).toEqual([]);
    await refused(d, "dismiss_parked", { artifactId: "art_r", parkedId: aside!.id });

    await ok(d, "save_artifact", { id: "art_r", expectedVersion: 3, body: "" });
    expect(d.kernel.context.getArtifactSync("art_r")!.content.body).toBe("");
    expect((await refused(d, "save_artifact", { id: "nope", expectedVersion: 1, body: "x" })).text).toContain("Not found");
    expect((await refused(d, "save_artifact", { id: "art_r", expectedVersion: 4, body: "{", format: "json" })).text).toContain("JSON");
  });

  it("read_artifact shows the history, the passages to decide and the parked additions; a long addition is read in full by its id", async () => {
    const d = await bootDesk();
    d.kernel.context.commitSync("desk", { artifact: { artifactId: "art_d", content: { format: "markdown", body: "旧" }, updatedBy: "agent" } });
    await ok(d, "save_artifact", { id: "art_d", expectedVersion: 1, body: "正文\n\n> [!DECISION] 迁移方案二选一\n> A：一次切换\n> B：双写\n\n尾" });
    const long = `${"长".repeat(5_000)}末尾`;
    agentRedraft(d.kernel, "art_d", long, 1);
    const [aside] = d.kernel.context.listParkedSync("art_d");

    const r = await ok(d, "read_artifact", { id: "art_d" });
    expect(r.data).toMatchObject({
      version: 2,
      versions: [{ version: 1, updatedBy: "agent" }, { version: 2, updatedBy: "human" }],
      decisions: [{ label: "迁移方案二选一", startLine: 2, endLine: 4 }],
      parked: [{ id: aside!.id, basedOnVersion: 1, body: long }],
    });
    expect(r.text).toContain("第 3–5 行「迁移方案二选一」：A：一次切换 B：双写");
    expect(r.text).toContain(`parkedId: "${aside!.id}"`);
    expect(r.text).not.toContain("末尾");
    expect(r.text.endsWith("---\n正文\n\n> [!DECISION] 迁移方案二选一\n> A：一次切换\n> B：双写\n\n尾")).toBe(true);

    const full = await ok(d, "read_artifact", { id: "art_d", parkedId: aside!.id, offset: 4_000 });
    expect(full.data).toMatchObject({ parkedId: aside!.id, basedOnVersion: 1, currentVersion: 2, hasMore: false });
    expect(full.text).toContain("末尾");
    expect((await refused(d, "read_artifact", { id: "art_d", parkedId: "gone" })).text).toContain(aside!.id);
    // An older version has its own text, and no passages of the current one.
    expect((await ok(d, "read_artifact", { id: "art_d", version: 1 })).data).toMatchObject({ version: 1, body: "旧", decisions: [] });
  });
});

describe("plans", () => {
  async function propose(d: TestDesk): Promise<HumanItemDTO> {
    d.script.add("desk", tool("propose_project", { title: "官网改版", outcome: "新版官网上线", background: "旧背景", actions: [{ title: "出设计稿", owner: "agent" }] }));
    await d.post("/api/capture", { text: "想做官网改版" });
    await d.kernel.idle();
    return (await ok<{ items: HumanItemDTO[] }>(d, "list_human_items")).data.items.find((i) => i.proposal)!;
  }

  it("revises the plan of a project card, refuses a stale revision with the current plan, and approves what it revised", async () => {
    const d = await bootRealDesk();
    const card = await propose(d);
    const plan = { id: card.id, expectedVersion: 1, outcome: "新版官网和博客上线", actions: [{ title: "约摄影", owner: "human", effort: "45m", nextStep: "打电话", extra: undefined }, { title: "出设计稿", owner: "agent" }] };
    const saved = await ok(d, "save_plan", plan);
    expect(saved.data).toMatchObject({ outcome: "saved", version: 2, updatedBy: "human" });
    const listed = (await ok<{ items: HumanItemDTO[] }>(d, "list_human_items")).data.items.find((i) => i.id === card.id)!;
    expect(listed).toMatchObject({ artifactVersion: 2, itemRevision: saved.data["itemRevision"], humanEdited: true, proposal: { title: "官网改版", outcome: "新版官网和博客上线", background: "旧背景" } });
    expect(listed.proposal!.actions).toEqual([{ title: "约摄影", owner: "human", effort: "45m", nextStep: "打电话" }, { title: "出设计稿", owner: "agent" }]);

    const stale = await refused(d, "save_plan", { ...plan, outcome: "覆盖掉" });
    expect(stale.data).toMatchObject({ outcome: "conflict", version: 2 });
    expect(stale.text).toContain("新版官网和博客上线");
    expect((await refused(d, "save_plan", { ...plan, expectedVersion: 2, runnerOverride: { engine: "codex", effort: "high" } })).text).toContain("推理强度");

    // The version the agent holds from before the revision no longer decides the card.
    await refused(d, "decide_human_item", { id: card.id, optionId: "system.execute", seenItemRevision: card.itemRevision, seenArtifactVersion: 1 });
    await ok(d, "decide_human_item", { id: card.id, optionId: "system.execute", seenItemRevision: listed.itemRevision, seenArtifactVersion: 2 });
    expect(d.kernel.gate.getApprovalSync(card.id)).toMatchObject({ status: "approved", approverId: "agent:local", humanEdited: true, boundVersion: 2 });
    const projectId = projectIdForApproval(card.id);
    await d.kernel.idle();
    expect(d.kernel.context.readStateSync<ProjectRecord>(projectId, gtdKeys.project)).toMatchObject({ outcome: "新版官网和博客上线" });
    expect((await refused(d, "save_plan", { ...plan, expectedVersion: 2 })).text).toContain("已经处理过");
  });

  it("a runner chosen for the plan stays until it is cleared with null", async () => {
    const d = await bootRealDesk();
    const card = await propose(d);
    const base = { id: card.id, outcome: "o", actions: [{ title: "a", owner: "agent" }] };
    const override = () => (d.kernel.context.getArtifactSync(card.artifactId!)!.content.data as ProjectProposal).runnerOverride;
    const runner = d.kernel.cliRunners[0] ?? "claude";
    await ok(d, "save_plan", { ...base, expectedVersion: 1, runnerOverride: { engine: runner } });
    expect(override()).toEqual({ engine: runner });
    await ok(d, "save_plan", { ...base, expectedVersion: 2 });
    expect(override()).toEqual({ engine: runner });
    await ok(d, "save_plan", { ...base, expectedVersion: 3, runnerOverride: null });
    expect(override()).toBeUndefined();
    const { actionId } = makeReviewCard(d.kernel);
    expect((await refused(d, "save_plan", { ...base, id: actionId, expectedVersion: 1 })).text).toContain("这不是立项卡");
  });
});

describe("sources", () => {
  it("adds each kind of check, lists it, pauses, resumes, changes its mode and deletes it", async () => {
    const d = await bootRealDesk();
    const script = join(tempDir("checks"), "metrics.mjs");
    writeFileSync(script, "console.log('')\n");
    const add = async (args: Record<string, unknown>) => (await ok<{ sensorId: string }>(d, "create_source", args)).data.sensorId;
    const byScript = await add({ title: "核心指标巡检", description: "看支付成功率", cron: "0 9 * * 1", tz: "Asia/Shanghai", checkKind: "script", scriptPath: script });
    const byModel = await add({ title: "群反馈挖掘", everyMinutes: 30, checkKind: "llm", instruction: "看看有没有人反馈支付报错", mode: "observe" });
    d.kernel.context.commitSync(byScript, { statePatches: { [gtdKeys.source]: { ...d.kernel.context.readStateSync<SourceState>(byScript, gtdKeys.source), lastError: "exit 1" } } });

    const list = await ok<SourcesDTO>(d, "list_sources");
    expect(list.data.sensors).toMatchObject([
      { id: byModel, title: "群反馈挖掘", scheduleText: "每 30 分钟", mode: "observe", processor: "llm" },
      { id: byScript, title: "核心指标巡检", scheduleText: "每周一 09:00（Asia/Shanghai）", mode: "active", processor: "code", description: "看支付成功率" },
    ].sort((a, b) => a.title.localeCompare(b.title, "zh")));
    expect(list.text).toContain("exit 1");
    expect(JSON.stringify(list.data)).not.toContain("buttons");

    await ok(d, "manage_source", { sensorId: byModel, action: "pause" });
    expect(d.kernel.getCell(byModel)!.status).toBe("paused");
    await ok(d, "manage_source", { sensorId: byModel, action: "resume" });
    expect(d.kernel.getCell(byModel)!.status).toBe("active");
    await ok(d, "manage_source", { sensorId: byModel, action: "set_mode", mode: "active" });
    expect(d.kernel.context.readStateSync<SourceState>(byModel, gtdKeys.source)!.mode).toBe("active");
    expect((await refused(d, "manage_source", { sensorId: byModel, action: "set_mode" })).text).toContain("needs mode");
    await ok(d, "manage_source", { id: byModel, action: "delete" });
    expect(d.kernel.getCell(byModel)).toMatchObject({ status: "closed" });
    expect((await refused(d, "manage_source", { sensorId: byModel, action: "pause" })).text).toContain("找不到这个信源");

    for (const [args, why] of [
      [{ title: "x", checkKind: "script", scriptPath: "a.sh" }, "exactly one of cron and everyMinutes"],
      [{ title: "x", cron: "0 9 * * 1", everyMinutes: 5, checkKind: "script", scriptPath: "a.sh" }, "exactly one of cron and everyMinutes"],
      [{ title: "x", everyMinutes: 5, tz: "UTC", checkKind: "script", scriptPath: "a.sh" }, "tz belongs to a cron"],
      [{ title: "x", everyMinutes: 5, checkKind: "script" }, 'needs scriptPath'],
      [{ title: "x", everyMinutes: 5, checkKind: "code", scriptPath: "a.sh" }, 'needs codeEntry'],
      [{ title: "x", everyMinutes: 5, checkKind: "llm" }, 'needs instruction'],
      [{ title: "x", everyMinutes: 5, checkKind: "code", codeEntry: "no.such.check" }, "没有名为 no.such.check 的检查"],
      [{ title: "x", cron: "every monday", checkKind: "script", scriptPath: "a.sh" }, "cron 需要 5 段"],
    ] as const) expect((await refused(d, "create_source", args)).text).toContain(why);
    expect((await ok<SourcesDTO>(d, "list_sources")).data.sensors.map((s) => s.id)).toEqual([byScript]);
  });

  it("control_cell trigger runs a script probe's check now, and refuses what is not a script or not running", async () => {
    const d = await bootRealDesk();
    const script = join(tempDir("checks"), "hit.mjs");
    writeFileSync(script, "console.log('命中了')\n");
    const { sensorId } = (await ok<{ sensorId: string }>(d, "create_source", { title: "巡检", cron: "0 9 * * 1", checkKind: "script", scriptPath: script })).data;
    await ok(d, "control_cell", { id: sensorId, action: "trigger" });
    expect(d.kernel.inbox.listMessagesSync({ cellId: sensorId, type: PAYLOAD.timerFired }).map((m) => m.envelope.principalId)).toContain("agent:local");
    await d.kernel.idle();
    expect(d.kernel.context.readStateSync<SourceState>(sensorId, gtdKeys.source)).toMatchObject({ runCount: 1, hitCount: 1 });
    expect((await refused(d, "control_cell", { id: "desk", action: "trigger" })).text).toContain("只有脚本探针可以手动触发检查");
    await ok(d, "manage_source", { sensorId, action: "pause" });
    expect((await refused(d, "control_cell", { id: sensorId, action: "trigger" })).text).toContain("暂停中");
    expect((await refused(d, "control_cell", { id: "nope", action: "trigger" })).text).toContain("no cell");
  });
});

describe("weekly review", () => {
  it("shows the week and its suggestions, and acts on each kind", async () => {
    const d = await bootRealDesk();
    const project = makeProject(d.kernel, "支付重试改造");
    await d.kernel.closeCell(project, "completed", { principalId: d.kernel.ownerPrincipal });
    const { sensorId } = (await ok<{ sensorId: string }>(d, "create_source", { title: "指标", cron: "0 9 * * *", checkKind: "llm", instruction: "看指标" })).data;
    const suggest = (slug: string, name: string) => ({ [`${SKILL_SUGGESTION_PREFIX}${slug}`]: { name, description: `${name} 的做法`, body: "- 先结论\n- 再依据", reason: "本周 4 次" } });
    d.kernel.context.commitSync("desk", {
      statePatches: { ...suggest("s-1", "reply-style"), ...suggest("s-2", "report-style"), [`${SENSOR_SUGGESTION_PREFIX}${sensorId}`]: { entry: "script:checks/m.sh", reason: "逻辑固定" } },
    });
    const review = await ok<{ completed: Array<{ title: string }>; skillSuggestions: Array<{ name: string }>; sensorSuggestions: Array<{ sensorId: string; entry: string | null }> }>(d, "get_review");
    expect(review.data.completed).toMatchObject([{ title: "支付重试改造" }]);
    expect(review.data.skillSuggestions.map((s) => s.name)).toEqual(["reply-style", "report-style"]);
    expect(review.data.sensorSuggestions).toMatchObject([{ sensorId, entry: "script:checks/m.sh" }]);
    for (const part of ["支付重试改造", "- 再依据", "已备好 script:checks/m.sh"]) expect(review.text).toContain(part);

    // The suggestion's name, though it is stored under another slug.
    await ok(d, "resolve_review_suggestion", { action: "accept_skill", name: "reply-style" });
    expect(d.kernel.context.listSkillsSync()).toContainEqual(expect.objectContaining({ name: "reply-style" }));
    await ok(d, "resolve_review_suggestion", { action: "dismiss_skill", name: "report-style" });
    expect(d.kernel.context.listSkillsSync().map((s) => s.name)).not.toContain("report-style");
    expect(d.kernel.context.listStateSync("desk", SKILL_SUGGESTION_PREFIX)).toEqual([]);
    expect((await refused(d, "resolve_review_suggestion", { action: "accept_skill", name: "reply-style" })).text).toContain("已经不在了");
    expect((await refused(d, "resolve_review_suggestion", { action: "dismiss_skill" })).text).toContain("needs name");

    await ok(d, "resolve_review_suggestion", { action: "sensor_to_code", sensorId });
    expect(d.kernel.getCell(sensorId)!.spec.processor).toMatchObject({ kind: "code" });
    expect((await ok<SourcesDTO>(d, "list_sources")).data.sensors).toMatchObject([{ id: sensorId, processor: "code" }]);
    expect((await refused(d, "resolve_review_suggestion", { action: "sensor_to_code", sensorId: "nope" })).text).toContain("needs entry");
    expect((await refused(d, "resolve_review_suggestion", { action: "sensor_to_code" })).text).toContain("needs sensorId");
  });
});

describe("activity", () => {
  it("lists what was filed away by kind, says how each entry is taken back, and hands one back to the desk", async () => {
    const d = await bootDesk();
    const env = inboundEnvelope(d.kernel, "【通知】周五全员会改到下午 4 点", "hr");
    const act = writeActivity(d.kernel, { kind: "notification_archived", title: "全员会改时间", envelope: env, restorable: true });
    writeActivity(d.kernel, { kind: "note_saved", title: "阅读清单" });
    const { actionId } = makeReviewCard(d.kernel);
    const decided = await ok<{ activityId: string }>(d, "decide_human_item", { id: actionId, optionId: "system.deny", seenItemRevision: 1, seenArtifactVersion: 1 });

    const all = await ok<ActivityListDTO & { items: Array<{ undo: boolean }> }>(d, "list_activity");
    expect(all.data.counts).toMatchObject({ notification_archived: 1, note_saved: 1, card_withdrawn: 1 });
    expect(all.data.items).toHaveLength(3);
    expect(all.data.items.find((i) => i.id === decided.data.activityId)).toMatchObject({ undo: true, restorable: true });
    const lineOf = (id: string) => all.text.split("\n").find((l) => l.includes(id))!;
    expect(lineOf(act.id)).toContain("可移回：restore_activity");
    expect(lineOf(act.id)).toContain("cellId desk");
    expect(lineOf(decided.data.activityId)).toContain("可撤销：undo_human_decision");
    expect((await ok<ActivityListDTO>(d, "list_activity", { kind: "note_saved" })).data.items.map((i) => i.title)).toEqual(["阅读清单"]);
    await refused(d, "list_activity", { kind: "everything" });

    await ok(d, "restore_activity", { cellId: "desk", activityId: act.id });
    const [handback] = d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.handback });
    expect(handback!.envelope).toMatchObject({ principalId: "agent:local", payload: { original: { id: env.id } } });
    expect((await refused(d, "restore_activity", { cellId: "desk", activityId: act.id })).text).toContain("已经移回过了");
    expect((await refused(d, "restore_activity", { cellId: "desk", activityId: "nope" })).text).toContain("找不到这条记录");
    // The desk has read the decision by now, so taking it back reaches it as a correction.
    await d.kernel.idle();
    expect((await ok(d, "undo_human_decision", { activityId: decided.data.activityId })).data).toMatchObject({ status: "corrected" });
    const undone = await ok<ActivityListDTO>(d, "list_activity", { kind: "card_withdrawn" });
    expect(undone.data.items).toMatchObject([{ id: decided.data.activityId, restorable: false, restoredAt: d.clock.now() }]);
    expect(undone.text).toContain("已移回");
  });
});

describe("models", () => {
  const OPUS: CliModelInfo = { id: "opus", label: "Opus 5.5", description: "Most capable", efforts: ["low", "high", "xhigh"] };
  const HAIKU: CliModelInfo = { id: "haiku", label: "Haiku 5", efforts: [] };

  async function bootCli() {
    const clock = new ManualClock(T0);
    const calls: CliEngine[] = [];
    const d = await bootDesk({
      clock,
      env: { NG_AGENT_BACKEND: "claude", NG_CLAUDE_BIN: "/nonexistent/ng-test-claude" },
      detectCli: () => true,
      kernel: {
        modelSwitch: {
          fetch: async (engine: CliEngine): Promise<CliModelCatalog> => {
            calls.push(engine);
            return { engine, models: [OPUS, HAIKU], recommended: { model: "opus", effort: "xhigh" }, fetchedAt: clock.now() };
          },
        },
      },
    });
    return { d, calls };
  }

  it("lists every runner's models and what each tier and role really uses; asks the CLI again only with refresh", async () => {
    const { d, calls } = await bootCli();
    const m = await ok<ModelsDTO>(d, "get_models");
    expect(m.data).toEqual(await d.get<ModelsDTO>("/api/models"));
    for (const part of ["默认 runner：claude", "opus「Opus 5.5」推理强度：low、high、xhigh — Most capable", "haiku「Haiku 5」推理强度：无", "strong：auto → opus · xhigh", "worker：inherit → claude · opus · xhigh"]) expect(m.text).toContain(part);
    expect(calls).toHaveLength(1);
    await ok(d, "get_models", { refresh: true });
    expect(calls).toHaveLength(2);
    const overview = await ok(d, "workbench_overview");
    expect(overview.data).toMatchObject({ backend: "claude", model: "Opus 5.5 · xhigh" });
    expect(overview.text).toContain("执行后端：claude · Opus 5.5 · xhigh");
  });

  it("changes the default runner, a tier and a role; says what is missing or impossible and changes nothing then", async () => {
    const { d } = await bootCli();
    await ok(d, "configure_models", { target: "tier", tier: "strong", mode: "fixed", model: "opus", effort: "high" });
    expect((await ok<ModelsDTO>(d, "get_models")).data).toMatchObject({ selection: { strong: { mode: "fixed", model: "opus", effort: "high" } }, effective: { strong: { model: "opus", effort: "high" } } });
    await ok(d, "configure_models", { target: "role", role: "worker", mode: "custom", runner: "claude", model: "haiku" });
    expect((await ok<ModelsDTO>(d, "get_models")).data.effectiveRoles.worker).toMatchObject({ runner: "claude", choice: { model: "haiku" }, inherited: false });
    const back = await ok<ModelsDTO>(d, "configure_models", { target: "role", role: "worker", mode: "inherit" });
    expect(back.data.roles.worker).toEqual({ mode: "inherit" });
    await ok(d, "configure_models", { target: "tier", tier: "strong", mode: "auto" });
    await ok(d, "configure_models", { target: "runner", runner: "claude" });
    const before = (await ok<ModelsDTO>(d, "get_models")).data;

    for (const [args, why] of [
      [{ target: "runner" }, "needs runner"],
      [{ target: "tier", mode: "auto" }, "needs tier"],
      [{ target: "tier", tier: "fast" }, '"auto" or "fixed"'],
      [{ target: "tier", tier: "fast", mode: "custom" }, '"auto" or "fixed"'],
      [{ target: "tier", tier: "fast", mode: "fixed" }, "needs model"],
      [{ target: "tier", tier: "fast", mode: "auto", model: "opus" }, "takes no model"],
      [{ target: "tier", tier: "fast", mode: "fixed", model: "gpt-9" }, "模型列表里没有"],
      [{ target: "tier", tier: "fast", mode: "fixed", model: "opus", effort: "max" }, "不提供推理强度"],
      [{ target: "tier", tier: "fast", mode: "auto", engine: "codex" }, "默认 runner 已切换"],
      [{ target: "role", mode: "inherit" }, "needs role"],
      [{ target: "role", role: "hub", mode: "auto" }, '"inherit" or "custom"'],
      [{ target: "role", role: "hub", mode: "custom", model: "opus" }, "needs runner"],
      [{ target: "role", role: "hub", mode: "inherit", model: "opus" }, "takes no runner"],
      [{ target: "role", role: "hub", mode: "custom", runner: "codex" }, "未启用"],
      [{ target: "everything" }, '"target" must be one of'],
    ] as const) expect((await refused(d, "configure_models", args)).text, JSON.stringify(args)).toContain(why);
    expect((await ok<ModelsDTO>(d, "get_models")).data).toEqual(before);
  });

  it("says so when no CLI drives the workbench", async () => {
    const d = await bootDesk();
    const m = await ok<ModelsDTO>(d, "get_models");
    if (!m.data.available) {
      expect(m.text).toContain("没有可切换的模型");
      expect((await refused(d, "configure_models", { target: "runner", runner: "claude" })).text).toContain("没有可切换的模型");
    }
  });
});

describe("topology, cells and projects", () => {
  it("draws who works for whom, folds closed cells unless asked, and narrows to one project", async () => {
    const d = await bootDesk();
    const cwd = tempDir("repo");
    const project = makeProject(d.kernel, "支付重试改造", { cwd });
    const other = makeProject(d.kernel, "官网改版");
    d.kernel.spawnCell(project, { id: "w1", preset: "worker", title: "核心退避编码", cwd, lifetime: "persistent" }, undefined, { principalId: d.kernel.ownerPrincipal });
    d.kernel.spawnCell(project, { id: "w2", preset: "worker", title: "旧活" }, undefined, { principalId: d.kernel.ownerPrincipal });
    await d.kernel.closeCell("w2", "completed", { principalId: d.kernel.ownerPrincipal });

    const t = await ok<TopologyDTO>(d, "get_topology");
    expect(t.data.nodes.map((n) => n.cellId)).toEqual(expect.arrayContaining(["desk", project, other, "w1"]));
    expect(t.data.nodes.map((n) => n.cellId)).not.toContain("w2");
    const lines = t.text.split("\n");
    expect(lines.some((l) => l.startsWith(`  - ${project}「支付重试改造」项目协调`) && l.includes("另有 1 个已归档") && l.includes(`目录 ${cwd}`))).toBe(true);
    expect(lines.some((l) => l.startsWith("    - w1「核心退避编码」执行分身"))).toBe(true);
    expect((await ok<TopologyDTO>(d, "get_topology", { includeArchived: true })).data.nodes.map((n) => n.cellId)).toContain("w2");
    expect((await ok<TopologyDTO>(d, "get_topology", { projectId: project })).data.nodes.map((n) => n.cellId)).not.toContain(other);
    expect((await refused(d, "get_topology", { projectId: "nope" })).text).toContain("找不到这个项目");
  });

  it("get_project and get_cell show the whiteboard, the running commands and the question a cell has asked the owner", async () => {
    const registry = createRegistry();
    registry.codeProcessors.register({
      name: "test.job",
      async run({ ports }) {
        await ports.workspace.startJob({ command: "echo 进度 1/3; sleep 30" });
        return "completed";
      },
    });
    const d = await bootDesk({ kernel: { registry } });
    const project = makeProject(d.kernel, "支付重试改造", { cwd: tempDir("repo") });
    d.kernel.context.upsertSkillOrNoteSync(project, { kind: "working_note", name: "board", description: "白板", body: "w1 在改退避，范围只到 retry.ts", scope: "cell", mode: "upsert" });
    d.kernel.spawnCell(project, { id: "w1", preset: "worker", title: "跑测试", lifetime: "persistent", processor: { kind: "code", entry: "test.job" } }, "go", { principalId: d.kernel.ownerPrincipal });
    await d.kernel.idle();

    const p = await ok<{ notes: string; jobs: Array<{ cellId: string; command: string }> }>(d, "get_project", { id: project });
    expect(p.data.notes).toContain("范围只到 retry.ts");
    expect(p.data.jobs).toMatchObject([{ cellId: "w1", command: "echo 进度 1/3; sleep 30" }]);
    expect(p.text).toContain("项目白板\n## board\nw1 在改退避");
    expect(p.text).toContain("（w1） 自 ");
    const cell = await ok<{ jobs: Array<{ jobId: string }>; branch: string | null; notes: string | null; pendingQuestion: unknown }>(d, "get_cell", { id: "w1" });
    expect(cell.data).toMatchObject({ jobs: [{ command: "echo 进度 1/3; sleep 30" }], notes: null, pendingQuestion: null });
    expect((await ok<{ notes: string }>(d, "get_cell", { id: project })).data.notes).toContain("范围只到 retry.ts");

    d.script.add("desk", { text: "仓库的绝对路径是哪个？" });
    await ok(d, "chat_with_desk", { text: "帮我改一下支付" });
    await d.kernel.idle();
    const asked = await ok<{ pendingQuestion: { id: string; text: string } }>(d, "get_cell", { id: "desk" });
    expect(asked.data.pendingQuestion).toMatchObject({ text: "仓库的绝对路径是哪个？" });
    expect(asked.text).toContain(`${asked.data.pendingQuestion.id}，用 chat_with_desk 带 replyToId 回答`);
  });

  it("capture takes links, a voice transcript or a bare link; add_action takes the kind of time; snoozed items are listed when asked", async () => {
    const d = await bootDesk();
    const link = { label: "设计稿", uri: "https://example.com/d" };
    await ok(d, "capture", { text: "看下这个", attachments: [link], voice: true });
    await ok(d, "capture", { attachments: [link] });
    expect(d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage }).map((m) => m.envelope)).toMatchObject([
      { principalId: "agent:local", payload: { text: "看下这个", attachments: [link] } },
      { principalId: "agent:local", payload: { attachments: [link] } },
    ]);
    expect(JSON.stringify(d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage })[0]!.envelope.payload)).toContain("voice");
    expect((await refused(d, "capture", { voice: true })).text).toContain("随手记不能为空");

    const project = makeProject(d.kernel, "装修");
    const { actionId } = (await ok<{ actionId: string }>(d, "add_action", { projectId: project, title: "打给物业", owner: "human", effort: "15m" })).data;
    const item = d.kernel.humanItems.get(actionId)!;
    expect(JSON.stringify(item)).toContain('"effort":"15m"');
    await refused(d, "add_action", { projectId: project, title: "x", owner: "human", effort: "2h" });

    await ok(d, "decide_human_item", { id: actionId, optionId: "system.defer", seenItemRevision: item.itemRevision, until: d.clock.now() + 3_600_000 });
    const ids = async (args: Record<string, unknown> = {}) => (await ok<{ items: HumanItemDTO[] }>(d, "list_human_items", args)).data.items.map((i) => i.id);
    expect(await ids()).not.toContain(actionId);
    expect(await ids({ includeSnoozed: true })).toContain(actionId);
    expect(JSON.stringify((await ok(d, "list_human_items", { includeSnoozed: true })).data)).not.toContain("ownerOnly");
    writeActivity(d.kernel, { kind: "note_saved", title: "阅读清单" });
    const overview = await ok<{ today: { notesSaved: number } }>(d, "workbench_overview");
    expect(overview.data.today.notesSaved).toBe(1);
    expect(overview.text).toContain("存笔记 1");
  });
});

it("the MCP server needs no credential and passes structured arguments and conflicts through", async () => {
  const d = await bootDesk({ port: 0 });
  d.kernel.context.commitSync("desk", { artifact: { artifactId: "art_m", content: { format: "text", body: "v1" }, updatedBy: "agent" } });
  const { url } = await d.server.listen();
  const bin = fileURLToPath(new URL("../bin/ng-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [bin], { env: { PATH: process.env["PATH"], NG_DESK_URL: url }, stdio: ["pipe", "pipe", "inherit"] });
  try {
    const waiting = new Map<number, (m: { result: Record<string, unknown> }) => void>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      const m = JSON.parse(line) as { id: number; result: Record<string, unknown> };
      waiting.get(m.id)?.(m);
    });
    let next = 0;
    const rpc = (method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = ++next;
        waiting.set(id, (m) => resolve(m.result));
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    const tools = (await rpc("tools/list", {})) as { tools: Array<{ name: string }> };
    expect(tools.tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name));
    const use = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    expect((await use("save_artifact", { id: "art_m", expectedVersion: 1, body: "经 MCP 改过" })).isError).toBeFalsy();
    const stale = await use("save_artifact", { id: "art_m", expectedVersion: 1, body: "x" });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain("经 MCP 改过");
    const bad = await use("save_plan", { id: "c", expectedVersion: 1, outcome: "o", actions: [{ title: "a" }] });
    expect(bad.content[0]!.text).toContain('"actions[0].owner" is required');
    expect(d.kernel.context.getArtifactSync("art_m")).toMatchObject({ version: 2, updatedBy: "human" });
  } finally {
    child.kill();
  }
});
