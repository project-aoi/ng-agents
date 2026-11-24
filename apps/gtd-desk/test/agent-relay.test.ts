// The 2026-11-23 end-to-end audit (docs/03-bugs/audits/2026-11-23-codex-e2e-workflows.md), control-plane side: the
// external agent relays and the owner decides (E02, E26), it sees what waits on the owner (E08, E27) and what a source
// found (E19), it can change a plan's stages (E17), each of its sessions is its own conversation (E35), the words that
// come with a pause are passed on (E05), and the workbench's own cells get none of the owner's tools (E01).
// The last part holds the regressions of the rerun (docs/03-bugs/audits/2026-11-23-codex-e2e-rerun.md): ids R01–R09,
// M09–M21 and L01–L03 of that audit.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CELL_PAUSE_KEY, type CellPauseState } from "@ng/cell";
import { gtdKeys, OBSERVATION_NOTE, projectIdForApproval } from "@ng/presets";
import type { SourceState } from "@ng/presets/records";
import { CELL_STATUS_KEY, createEnvelope, get, KERNEL_FROM, PAYLOAD, type Envelope, type ProjectProposal } from "@ng/protocol";
import { AGENT_INSTRUCTIONS, AGENT_TOOLS } from "../src/agent/guide";
import { CONVERSATION_HEADER, type AgentToolResult } from "../src/agent/routes";
import type { ActivityListDTO, ArtifactDTO, CellTimelineDTO, HumanItemDTO, HumanItemsResponse, RadarDTO, SendCellMessageResponse, StatusDTO, WeeklyReviewDTO } from "../src/shared/api";
import { agentRedraft, bootDesk, bootRealDesk, cleanupAll, makeProject, makeReviewCard, MIN, requestsOf, T0, tempDir, tool, type TestDesk } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupAll();
});

const BIN = fileURLToPath(new URL("../bin/ng-mcp.mjs", import.meta.url));
const NOTE_LABEL = "[note added by the owner's coding agent — not the owner's words]";

async function call(d: TestDesk, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<AgentToolResult> {
  const r = await d.req<AgentToolResult>("POST", `/api/agent/tools/${name}`, args, headers);
  expect(r.status, `${name} → HTTP ${r.status}`).toBe(200);
  return r.json;
}

async function ok<T = Record<string, unknown>>(d: TestDesk, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<{ text: string; data: T }> {
  const r = await call(d, name, args, headers);
  expect(r.isError, `${name}: ${r.text}`).toBeFalsy();
  return { text: r.text, data: r.data as T };
}

async function refused(d: TestDesk, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await call(d, name, args);
  expect(r.isError, r.text).toBe(true);
  return r.text;
}

const doc = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;
const prop = (name: string, p: string) => (doc(name).inputSchema as { properties: Record<string, { description?: string }> }).properties[p];

// ==================== E02 / E24: the owner's words, the agent's note, and short server instructions ====================

describe("the owner's words and the agent's own note travel apart (E02)", () => {
  it("every tool that passes words on takes only the owner's words in text and the agent's additions in context", () => {
    for (const name of ["chat_with_desk", "message_project", "message_cell", "control_cell"]) {
      expect(prop(name, "text")?.description, name).toMatch(/only (what the owner said|the owner's words)/);
      expect(prop(name, "context")?.description, name).toContain("not the owner's words");
    }
    // Briefs and notes say how to keep them apart; a decision names the passages the owner must answer first.
    // Audit 2026-11-23 rerun R07: a brief holds only the owner's request; the agent's own reading has a field of its own.
    expect(prop("create_project", "brief")?.description).toContain("Nothing of your own in here");
    expect(prop("create_project", "context")?.description).toContain("not the owner's words");
    expect(prop("save_plan", "context")?.description).toContain("not the owner's words");
    expect(prop("set_project_state", "note")?.description).toContain("Not your summary");
    expect(prop("decide_human_item", "note")?.description).toContain("Not your own additions");
    expect(doc("decide_human_item").description).toContain("passages marked for the owner to decide");
    expect(doc("decide_human_item").description).toContain("do not also send it with message_project or message_cell");
    expect(doc("message_cell").description).toContain('text "把上限改成 3"');
  });

  it("the server instructions are a few lines that hold without the skill; the detail is in the skill (E24)", () => {
    // Audit 2026-11-23 rerun L05: shortened further (about 520 characters).
    expect(AGENT_INSTRUCTIONS.length).toBeLessThan(700);
    expect(AGENT_INSTRUCTIONS).toContain("ng-desk skill");
    expect(AGENT_INSTRUCTIONS).toContain("never answer, approve, restart or choose for them");
    expect(AGENT_INSTRUCTIONS).toContain("`context`");
    // What a client lists: 38 tools without the instructions repeated under each.
    expect(AGENT_TOOLS).toHaveLength(38);
    expect(JSON.stringify(AGENT_TOOLS).length).toBeLessThan(36_000);
  });

  it("chat_with_desk, message_project, message_cell and control_cell hand the note to the kernel beside the owner's words", async () => {
    const d = await bootDesk();
    const project = makeProject(d.kernel, "支付重试改造");
    d.kernel.spawnCell(project, { id: "w1", preset: "worker", title: "改重试", lifetime: "wakeable", meta: { role: "w1" } }, undefined, { principalId: d.kernel.ownerPrincipal });
    await d.kernel.idle();
    const sent = vi.spyOn(d.kernel, "directMessage");
    const note = "主人上周说过只改 HTTP 层";

    const chat = await ok(d, "chat_with_desk", { text: "现在开始吗？", context: note });
    expect(chat.text).toContain("as the owner's words, with your note marked as yours");
    await ok(d, "message_project", { id: project, text: "先别合", context: note });
    const cell = await ok(d, "message_cell", { id: "w1", text: "把上限改成 3", context: note });
    expect(cell.text).toContain("Your note went with them, marked as yours");
    await ok(d, "control_cell", { id: "w1", action: "message", text: "再跑一遍测试", context: note });
    expect(sent.mock.calls.map(([id, m]) => [id, m.text, (m as { agentContext?: string }).agentContext])).toEqual([
      ["desk", "现在开始吗？", note],
      [project, "先别合", note],
      ["w1", "把上限改成 3", note],
      ["w1", "再跑一遍测试", note],
    ]);
    // Without context nothing extra goes along; context alone is not a message.
    await ok(d, "message_cell", { id: "w1", text: "好" });
    expect(sent.mock.calls.at(-1)![1]).not.toHaveProperty("agentContext");
    expect(await refused(d, "chat_with_desk", { context: note })).toContain("context goes with text");
  });

  // Needs the kernel to carry DirectMessage.agentContext into the payloads it builds (packages/cell/src/messages.ts):
  // user.message to the desk, cell.message to a cell, and the cell.direct_chat copy its project gets.
  it("the desk, a worker and the worker's project read the note after the owner's words, labelled as the agent's", async () => {
    const d = await bootDesk();
    const note = "工作台里有一份停靠的报告：只用本地资料";
    await ok(d, "chat_with_desk", { text: "工作台怎么说？", context: note });
    const [m] = d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage });
    expect(m!.envelope.payload).toMatchObject({ text: "工作台怎么说？", agentContext: note });
    await d.kernel.idle();
    const prompt = requestsOf(d.script, "desk").at(-1)!;
    expect(prompt.indexOf("工作台怎么说？")).toBeLessThan(prompt.indexOf(`${NOTE_LABEL}\n${note}`));

    const project = makeProject(d.kernel, "支付重试改造");
    d.kernel.spawnCell(project, { id: "w1", preset: "worker", title: "改重试", lifetime: "wakeable", meta: { role: "w1" } }, undefined, { principalId: d.kernel.ownerPrincipal });
    await d.kernel.idle();
    await ok(d, "message_cell", { id: "w1", text: "把上限改成 3", context: "主人说的上限是重试次数" });
    expect(d.kernel.inbox.listMessagesSync({ cellId: "w1", type: PAYLOAD.cellMessage }).at(-1)!.envelope.payload).toMatchObject({ text: "把上限改成 3", agentContext: "主人说的上限是重试次数" });
    expect(d.kernel.inbox.listMessagesSync({ cellId: project, type: PAYLOAD.cellDirectChat }).at(-1)!.envelope.payload).toMatchObject({ text: "把上限改成 3", agentContext: "主人说的上限是重试次数" });
    await d.kernel.idle();
    expect(requestsOf(d.script, "w1").at(-1)).toContain(`把上限改成 3`);
    expect(requestsOf(d.script, "w1").at(-1)).toContain(`${NOTE_LABEL}\n主人说的上限是重试次数`);
  });
});

// ==================== E02 / E08: questions are the owner's, and the overview shows them ====================

describe("questions for the owner (E02, E08)", () => {
  it("the overview lists the desk's open question in 待我处理 until the owner's answer goes back", async () => {
    const d = await bootDesk();
    d.script.add("desk", { text: "要改的仓库在本机哪个目录？" });
    await ok(d, "chat_with_desk", { text: "帮我改一下支付重试" });
    await d.kernel.idle();
    const o = await ok<{ questions: Array<{ cellId: string; id: string; text: string; answerWith: string }> }>(d, "workbench_overview");
    expect(o.data.questions).toEqual([expect.objectContaining({ cellId: "desk", text: "要改的仓库在本机哪个目录？", answerWith: "chat_with_desk" })]);
    const q = o.data.questions[0]!;
    expect(o.text).toMatch(/待我处理（1）\n- 主台在问主人：要改的仓库在本机哪个目录？/);
    expect(o.text).toContain(`a question for the owner — put it to them, and send their answer back with chat_with_desk and replyToId ${q.id}; do not answer it yourself.`);

    d.script.add("desk", { text: "好的，交给项目了。" });
    await ok(d, "chat_with_desk", { text: "在 ~/dev/pay", replyToId: q.id });
    await d.kernel.idle();
    const after = await ok<{ questions: unknown[] }>(d, "workbench_overview");
    expect(after.data.questions).toEqual([]);
    expect(after.text).toContain("待我处理（0）");
  });

  it("a worker's question counts once the owner has spoken to it, or when it was sent to the owner; one for its project does not", async () => {
    const d = await bootDesk();
    const project = makeProject(d.kernel, "支付重试改造");
    d.script.add("w1", { text: "退避写好了，要不要顺手补测试？" });
    d.script.add("w2", { text: "改好了，要不要再跑一遍？" });
    d.kernel.spawnCell(project, { id: "w1", preset: "worker", title: "改重试", lifetime: "wakeable", meta: { role: "w1" } }, "改退避", { principalId: d.kernel.ownerPrincipal });
    d.kernel.spawnCell(project, { id: "w2", preset: "worker", title: "改日志", lifetime: "wakeable", meta: { role: "w2" } }, "改日志", { principalId: d.kernel.ownerPrincipal });
    await d.kernel.idle();
    expect((await ok<{ questions: unknown[] }>(d, "workbench_overview")).data.questions).toEqual([]);
    d.script.add("w1", { text: "上限要改成几次？" });
    await ok(d, "message_cell", { id: "w1", text: "把重试上限也改一下" });
    await d.kernel.idle();
    const o = await ok<{ questions: Array<{ cellId: string; answerWith: string }> }>(d, "workbench_overview");
    expect(o.data.questions).toEqual([expect.objectContaining({ cellId: "w1", answerWith: "message_cell" })]);
    expect(o.text).toContain("w1「改重试」在问主人：上限要改成几次？");
    // get_cell words it the same way.
    expect((await ok(d, "get_cell", { id: "w1" })).text).toContain("send their answer back with message_cell and replyToId");
  });

  it("chat_with_desk waits (bounded) for the desk's reply to the message it just sent", async () => {
    const d = await bootDesk();
    d.script.add("desk", { text: "先查一下有没有同题项目。" , toolCalls: [{ name: "read_state", input: {} }] }, { text: "已有一个停靠的报告，要重新启动它吗？" });
    const r = await ok<{ waited: string; replies: Array<{ text: string; question: boolean; forOwner: boolean }> }>(d, "chat_with_desk", { text: "我想给 notes-cli 加个导出", waitSeconds: 20 });
    expect(r.data.waited).toBe("settled");
    expect(r.data.replies.at(-1)).toMatchObject({ text: "已有一个停靠的报告，要重新启动它吗？", question: true, forOwner: true });
    expect(r.text).toContain("已有一个停靠的报告，要重新启动它吗？");
    expect(r.text).toContain("do not answer it yourself");
    expect(prop("chat_with_desk", "waitSeconds")?.description).toContain("at most 30");

    // Time up while the desk is still on it: say so, and how to read it later.
    d.script.add("desk", { text: "查完了", delayMs: 2_000 });
    const t0 = Date.now();
    const slow = await ok<{ waited: string }>(d, "chat_with_desk", { text: "那个导出做到哪了？", waitSeconds: 0.2 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(slow.data.waited).toBe("timeout");
    expect(slow.text).toContain("The desk is still working on it (no final answer within 0.2 s)");
    await d.kernel.stop();
  });
});

// ==================== E27: what else the overview shows ====================

describe("the overview shows hubs and the desk's own workers (E27)", () => {
  it("lists a live hub with its status and a worker the desk started with the first line of its latest result", async () => {
    const d = await bootRealDesk();
    d.kernel.spawnCell("desk", { id: "hub_review", preset: "hub", title: "评审中枢" }, undefined, { principalId: d.kernel.ownerPrincipal });
    d.kernel.context.commitSync("hub_review", { statePatches: { [CELL_STATUS_KEY]: { text: "MR !12 评审有 2 个阻塞问题，等作者回应", at: d.clock.now() } } });
    d.script.add("worker", tool("report_to_parent", { kind: "result", text: "共享修复在分支 fix/ci-shared，还没合入 main\n细节见报告" }));
    const { cellId } = (await ok<{ cellId: string }>(d, "spawn_cell", { preset: "worker", title: "修共享 CI", instruction: "修 ci-shared" })).data;
    await d.kernel.idle();
    const o = await ok<{ hubs: Array<{ cellId: string; statusLine: string }>; deskWorkers: Array<{ cellId: string; latestResult: string }> }>(d, "workbench_overview");
    expect(o.text).toContain("领域中枢（1）\n- hub_review「评审中枢」（");
    expect(o.text).toContain("MR !12 评审有 2 个阻塞问题，等作者回应");
    expect(o.text).toContain(`主台直接派出的分身（1）\n- ${cellId}「修共享 CI」（worker，待命可唤醒） — 最近结果：共享修复在分支 fix/ci-shared，还没合入 main`);
    expect(o.data.hubs).toEqual([expect.objectContaining({ cellId: "hub_review", statusLine: "MR !12 评审有 2 个阻塞问题，等作者回应" })]);
    expect(o.data.deskWorkers).toEqual([expect.objectContaining({ cellId, latestResult: "共享修复在分支 fix/ci-shared，还没合入 main" })]);
  });
});

// ==================== E19: what a source found ====================

describe("what a source found (E19)", () => {
  it("list_sources shows an observe-mode source's latest notes and an active one's last hit; read_resource reads the whole note", async () => {
    const d = await bootRealDesk();
    const dir = tempDir("checks");
    const say = (name: string, line: string) => {
      const path = join(dir, name);
      writeFileSync(path, `console.log(${JSON.stringify(line)})\n`);
      return path;
    };
    const { sensorId: watched } = (await ok<{ sensorId: string }>(d, "create_source", { title: "夜间报告", cron: "0 3 * * *", checkKind: "script", scriptPath: say("night.mjs", "夜间报告失败：3 个用例超时"), mode: "observe" })).data;
    const { sensorId: active } = (await ok<{ sensorId: string }>(d, "create_source", { title: "CI 巡检", cron: "0 9 * * *", checkKind: "script", scriptPath: say("ci.mjs", "main 分支 CI 红了") })).data;
    for (const id of [watched, active]) await ok(d, "control_cell", { id, action: "trigger" });
    await d.kernel.idle();

    const list = await ok<{ sensors: Array<{ id: string; latestHits: string | null }> }>(d, "list_sources");
    expect(list.text).toContain("观察笔记（最近 1 条）");
    expect(list.text).toContain("夜间报告失败：3 个用例超时");
    expect(list.text).toContain("最近一次命中（已投进信箱）");
    expect(list.text).toContain("main 分支 CI 红了");
    expect(list.data.sensors.find((s) => s.id === watched)!.latestHits).toContain("夜间报告失败");

    const note = await ok<{ content: string; totalChars: number }>(d, "read_resource", { uri: `reference://${OBSERVATION_NOTE}`, cellId: watched });
    expect(note.data.content).toContain("夜间报告失败：3 个用例超时");
    expect(note.text).toContain(`reference://${OBSERVATION_NOTE} of ${watched}`);
    expect(await refused(d, "read_resource", { uri: `reference://${OBSERVATION_NOTE}` })).toContain("cellId");
    expect(await refused(d, "read_resource", { uri: "reference://nope", cellId: watched })).toContain("没有这份笔记");
    expect(await refused(d, "read_resource", { uri: "skill://x", cellId: watched })).toContain("只能读取");
  });
});

// ==================== E17: a plan's stages and directory ====================

describe("save_plan changes stages and the directory (E17)", () => {
  async function propose(d: TestDesk): Promise<HumanItemDTO> {
    d.script.add("desk", tool("propose_project", { title: "导出功能", outcome: "notes-cli 能导出 Markdown", phases: ["调研", "实现", "发布"], actions: [{ title: "写导出", owner: "agent" }] }));
    await d.post("/api/capture", { text: "给 notes-cli 加导出" });
    await d.kernel.idle();
    return (await ok<{ items: HumanItemDTO[] }>(d, "list_human_items")).data.items.find((i) => i.proposal)!;
  }

  it("replaces or clears the stages, sets a directory that exists, refuses one that does not; the approved project gets them", async () => {
    const d = await bootRealDesk();
    const card = await propose(d);
    const repo = tempDir("notes-cli");
    const plan = { id: card.id, outcome: "notes-cli 能导出 Markdown", actions: [{ title: "写导出", owner: "agent" }] };
    const listed = await ok(d, "list_human_items");
    expect(listed.text).toContain(`- ${card.id} 立项方案 v1：「导出功能」；阶段：1. 调研 → 2. 实现 → 3. 发布`);

    const two = await ok(d, "save_plan", { ...plan, expectedVersion: 1, phases: ["实现", "发布"], cwd: repo });
    expect(two.text).toContain("阶段：1. 实现 → 2. 发布");
    expect(two.text).toContain(`目录：${repo}`);
    const none = await ok<{ proposal: ProjectProposal }>(d, "save_plan", { ...plan, expectedVersion: 2, phases: [] });
    expect(none.text).toContain("不分阶段");
    expect(none.data.proposal).not.toHaveProperty("phases");
    expect(none.data.proposal.cwd).toBe(repo);
    expect(await refused(d, "save_plan", { ...plan, expectedVersion: 3, cwd: "/definitely/not/here" })).toContain("不存在");
    expect(await refused(d, "save_plan", { ...plan, expectedVersion: 3, repos: [{ name: "x", cwd: "relative/path" }] })).toContain("绝对路径");

    const item = (await ok<{ items: HumanItemDTO[] }>(d, "list_human_items")).data.items.find((i) => i.id === card.id)!;
    await ok(d, "decide_human_item", { id: card.id, optionId: "system.execute", seenItemRevision: item.itemRevision, seenArtifactVersion: 3 });
    const projectId = projectIdForApproval(card.id);
    expect(d.kernel.getCell(projectId)?.spec.cwd).toBe(repo);
  });
});

// ==================== E26 / E05: one answer goes once, and the words that come with a pause ====================

describe("the owner's words go with their decision (E26) and with a pause (E05)", () => {
  it("an approve option takes a note, and the note reaches the cell that asked", async () => {
    const d = await bootDesk();
    const { actionId } = makeReviewCard(d.kernel);
    const card = d.server.desk.listHumanItems().find((i) => i.id === actionId)!;
    expect(card.options.find((o) => o.id === "system.execute")).toMatchObject({ effect: "execute", input: { mode: "optional" } });
    await ok(d, "decide_human_item", { id: actionId, optionId: "system.execute", seenItemRevision: card.itemRevision, seenArtifactVersion: 1, note: "只发给张三" });
    expect(d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved }).at(-1)?.envelope.payload).toMatchObject({ status: "executed", note: "只发给张三" });
  });

  it("parking a proposal keeps the owner's words with the parked project", async () => {
    const d = await bootRealDesk();
    d.script.add("desk", tool("propose_project", { title: "播客计划", outcome: "每周一期", actions: [{ title: "选题", owner: "agent" }] }));
    await d.post("/api/capture", { text: "想做个播客" });
    await d.kernel.idle();
    const card = (await ok<{ items: HumanItemDTO[] }>(d, "list_human_items")).data.items.find((i) => i.proposal)!;
    expect(card.options.find((o) => o.id === "system.someday")).toMatchObject({ input: { mode: "optional" } });
    const control = vi.spyOn(d.kernel, "control");
    await ok(d, "decide_human_item", { id: card.id, optionId: "system.someday", seenItemRevision: card.itemRevision, seenArtifactVersion: 1, note: "等我换了麦克风再说" });
    const projectId = projectIdForApproval(card.id);
    expect(control).toHaveBeenCalledWith(projectId, expect.objectContaining({ action: "pause", pauseReason: "parked", note: "等我换了麦克风再说" }), expect.anything());
    const [task] = d.kernel.inbox.listMessagesSync({ cellId: projectId, type: PAYLOAD.cellTask });
    expect(JSON.stringify(task!.envelope.payload)).toContain("放进以后再说时主人（经编码助手）的话：等我换了麦克风再说");
    expect(d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.approvalResolved }).at(-1)?.envelope.payload).toMatchObject({ decision: "someday", note: "等我换了麦克风再说" });
  });

  it("someday, pause and a cell's pause pass the owner's words to the kernel", async () => {
    const d = await bootDesk();
    const parked = makeProject(d.kernel, "极简模式");
    const held = makeProject(d.kernel, "周报");
    d.kernel.spawnCell(held, { id: "w1", preset: "worker", title: "写周报", lifetime: "wakeable", meta: { role: "w1" } }, undefined, { principalId: d.kernel.ownerPrincipal });
    const other = makeProject(d.kernel, "官网");
    const control = vi.spyOn(d.kernel, "control");
    await ok(d, "set_project_state", { id: parked, state: "someday", note: "先停一下，我还没想好" });
    await ok(d, "set_project_state", { id: held, state: "pause", note: "等周一再说" });
    await ok(d, "set_project_state", { id: held, state: "resume" });
    await ok(d, "control_cell", { id: "w1", action: "pause", text: "先别动文件" });
    await ok(d, "control_cell", { id: other, action: "pause", text: "这周先不做" });
    const calls = control.mock.calls.map(([id, cmd]) => [id, cmd.action, cmd.note]);
    expect(calls).toEqual([
      [parked, "pause", "先停一下，我还没想好"],
      [held, "pause", "等周一再说"],
      [held, "resume", undefined],
      ["w1", "pause", "先别动文件"],
      [other, "pause", "这周先不做"],
    ]);
  });
});

// ==================== E01 / E35: the MCP server ====================

interface Rpc {
  send(msg: Record<string, unknown>): void;
  next(): Promise<Record<string, unknown>>;
  close(): void;
}

function startMcp(env: Record<string, string>): Rpc {
  const { NG_WORKBENCH_CELL_ID: _inherited, ...base } = process.env;
  const child = spawn(process.execPath, [BIN], { env: { ...base, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const queue: Array<Record<string, unknown>> = [];
  const waiting: Array<(m: Record<string, unknown>) => void> = [];
  createInterface({ input: child.stdout }).on("line", (l) => {
    const m = JSON.parse(l) as Record<string, unknown>;
    const w = waiting.shift();
    if (w) w(m);
    else queue.push(m);
  });
  return {
    send: (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`),
    next: () =>
      new Promise((resolve, reject) => {
        const m = queue.shift();
        if (m) return resolve(m);
        const timer = setTimeout(() => reject(new Error("no answer from the MCP server")), 20_000);
        waiting.push((x) => {
          clearTimeout(timer);
          resolve(x);
        });
      }),
    close: () => child.kill(),
  };
}

const textOf = (m: Record<string, unknown>) => ((m["result"] as { content: Array<{ text: string }> }).content[0]!.text);

describe("MCP server", () => {
  it("inside one of the workbench's own cells it offers no workbench tool and never calls the workbench (E01)", async () => {
    const d = await bootDesk({ port: 0 });
    const { url } = await d.server.listen();
    const mcp = startMcp({ NG_DESK_URL: url, NG_WORKBENCH_CELL_ID: "w_fixer" });
    try {
      mcp.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "0" } } });
      const init = (await mcp.next()) as { result: { protocolVersion: string; capabilities: unknown; instructions: string } };
      expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
      expect(init.result.instructions).toContain("inside the workbench's own background cell w_fixer");
      expect(init.result.instructions).toContain("not available");
      mcp.send({ method: "notifications/initialized" });
      mcp.send({ id: 2, method: "tools/list" });
      const list = (await mcp.next()) as { result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } };
      expect(list.result.tools).toEqual([{ name: "not_available_in_workbench_cell", description: init.result.instructions, inputSchema: { type: "object", properties: {} } }]);
      for (const [id, name] of [[3, "capture"], [4, "decide_human_item"]] as const) {
        mcp.send({ id, method: "tools/call", params: { name, arguments: { text: "记一下" } } });
        const r = await mcp.next();
        expect((r["result"] as { isError: boolean }).isError).toBe(true);
        expect(textOf(r)).toContain("control plane is not available");
      }
      mcp.send({ id: 5, method: "ping" });
      expect(await mcp.next()).toMatchObject({ id: 5, result: {} });
      expect(d.kernel.inbox.listMessagesSync({ cellId: "desk" })).toEqual([]);
    } finally {
      mcp.close();
    }
  });

  it("names each session with its own conversation id; an explicit one still wins (E35)", async () => {
    const d = await bootDesk({ port: 0 });
    const { url } = await d.server.listen();
    const project = makeProject(d.kernel, "支付重试改造");
    const sessions = [startMcp({ NG_DESK_URL: url }), startMcp({ NG_DESK_URL: url })];
    try {
      let id = 0;
      for (const mcp of sessions) {
        mcp.send({ id: ++id, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "codex-mcp-client", version: "0" } } });
        await mcp.next();
        mcp.send({ id: ++id, method: "tools/call", params: { name: "chat_with_desk", arguments: { text: `第 ${id} 句` } } });
        expect(textOf(await mcp.next())).toMatch(/conversation codex-mcp-client-[0-9a-f]{12}\)/);
      }
      sessions[0]!.send({ id: ++id, method: "tools/call", params: { name: "message_project", arguments: { id: project, text: "先别合" } } });
      await sessions[0]!.next();
      sessions[0]!.send({ id: ++id, method: "tools/call", params: { name: "chat_with_desk", arguments: { text: "换个线程", conversationId: "mine" } } });
      await sessions[0]!.next();
    } finally {
      for (const s of sessions) s.close();
    }
    const desk = d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage }).map((m) => (m.envelope.payload as { conversationId: string }).conversationId);
    expect(desk).toHaveLength(3);
    expect(desk[0]).toMatch(/^codex-mcp-client-[0-9a-f]{12}$/);
    expect(desk[1]).toMatch(/^codex-mcp-client-[0-9a-f]{12}$/);
    expect(desk[0]).not.toBe(desk[1]);
    expect(desk[2]).toBe("mine");
    const toProject = d.kernel.inbox.listMessagesSync({ cellId: project, type: PAYLOAD.cellMessage }).map((m) => (m.envelope.payload as { conversationId: string }).conversationId);
    expect(toProject).toEqual([desk[0]]);
    // Plain REST callers say nothing: the conversation is the agent's own id, as before; a header names one.
    await ok(d, "chat_with_desk", { text: "从 curl 来的" });
    await ok(d, "chat_with_desk", { text: "带头的" }, { [CONVERSATION_HEADER]: "term-2" });
    await ok(d, "chat_with_desk", { text: "坏头" }, { [CONVERSATION_HEADER]: "bad id with spaces" });
    expect(d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage }).slice(3).map((m) => (m.envelope.payload as { conversationId: string }).conversationId)).toEqual(["agent:local", "term-2", "agent:local"]);
  });
});

// ==================== Audit 2026-11-23 rerun (docs/03-bugs/audits/2026-11-23-codex-e2e-rerun.md) ====================

/** The cell.message envelopes a cell received, oldest first. */
const messagesTo = (d: TestDesk, cellId: string): Envelope[] => d.kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.cellMessage }).map((m) => m.envelope);
const textOf_ = (e: Envelope | undefined) => (e?.payload as { text: string } | undefined)?.text ?? "";

/** A pending project confirmation card the desk put up after a capture, as list_human_items shows it. */
async function proposed(d: TestDesk, proposal: Record<string, unknown>): Promise<HumanItemDTO> {
  d.script.add("desk", tool("propose_project", proposal));
  await d.post("/api/capture", { text: `想做${String(proposal["title"])}` });
  await d.kernel.idle();
  return (await ok<{ items: HumanItemDTO[] }>(d, "list_human_items")).data.items.find((i) => i.proposal?.title === proposal["title"])!;
}

describe("audit 2026-11-23 rerun: parked and reopened projects (R01, R03)", () => {
  // Audit 2026-11-23 rerun R01
  it("R01: who parked a project, when and with what words is shown; activate says the agent did it and whether the owner's words came along", async () => {
    const d = await bootDesk();
    const p = makeProject(d.kernel, "极简模式");
    await ok(d, "set_project_state", { id: p, state: "someday", note: "先停一下，我还没想好" });
    // The moment is shown on the owner's own clock (the host's zone here), not in UTC.
    const at = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(T0));
    const part = (t: string) => at.find((x) => x.type === t)!.value;
    const parked = `主人的编码助手于 ${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")} 放进以后再说，当时的话：「先停一下，我还没想好」`;
    expect(parked).not.toContain("Z ");

    const o = await ok<{ parked: Array<{ id: string; parkedBy: unknown }> }>(d, "workbench_overview");
    expect(o.text).toContain(`已停靠（重新启动前先问主人，除非主人此后明确说了现在开始）（1）\n- ${p}「极简模式」— 以后再说（${parked}）`);
    expect(o.data.parked).toEqual([expect.objectContaining({ id: p, parkedBy: { text: parked, by: "主人的编码助手", at: T0, note: "先停一下，我还没想好", parked: true } })]);
    const got = await ok<{ pausedBy: unknown }>(d, "get_project", { id: p });
    expect(got.text).toContain(`状态：以后再说（停靠中，什么都不运行；${parked}。`);
    expect(got.data.pausedBy).toMatchObject({ by: "主人的编码助手", note: "先停一下，我还没想好", parked: true });

    // Brought back without the owner's words: the answer and the project's wake-up both say so, and whose act it was.
    const back = await ok(d, "set_project_state", { id: p, state: "activate" });
    expect(back.text).toContain(`已从以后再说里拿出来（此前${parked}）`);
    expect(back.text).toContain("这次启动没有带主人的话，项目会先向主人确认再动手");
    const woke = messagesTo(d, p).at(-1)!;
    expect(woke.principalId).toBe("agent:local");
    expect(textOf_(woke)).toMatch(/^主人的编码助手把「极简模式」从以后再说里拿了出来。\n/);
    expect(textOf_(woke)).toContain(`停靠时的情况：${parked}。`);
    expect(textOf_(woke)).toContain("这次没有带来主人的话。");
    expect(textOf_(woke)).not.toContain("点了启动");
    await d.kernel.idle();
    // Its first turn after the resume is told, once, who parked and who resumed it.
    const first = requestsOf(d.script, p).at(-1)!;
    expect(first).toContain(`[back from a pause — the owner's coding agent parked this cell for later at 2026-11-17T01:00:00Z, with the words "先停一下，我还没想好". The owner's coding agent resumed it at 2026-11-17T01:00:00Z, without a word.`);
    expect(first).toContain("[resumed by the owner's coding agent at ");
    expect(first).not.toMatch(/resumed by the owner(?!'s coding agent)/);

    // With the owner's go-ahead as note: quoted to the project and kept as the words of the resume.
    // (The test clock stands still: each step gets its own minute, so a run that happened before the resume is not
    // taken for one after it.)
    d.clock.advance(MIN);
    await d.kernel.idle();
    await ok(d, "set_project_state", { id: p, state: "someday", note: "我还要想想" });
    d.clock.advance(MIN);
    const again = await ok(d, "set_project_state", { id: p, state: "activate", note: "现在开始做第一阶段" });
    expect(again.text).toContain("带去的话：「现在开始做第一阶段」");
    expect(textOf_(messagesTo(d, p).at(-1))).toContain("这次带来的主人的话：「现在开始做第一阶段」");
    expect(d.kernel.context.readStateSync<CellPauseState>(p, CELL_PAUSE_KEY)).toMatchObject({ reason: "parked", note: "我还要想想", resumedBy: "agent:local", resumeNote: "现在开始做第一阶段" });
    await d.kernel.idle();
    expect(requestsOf(d.script, p).at(-1)).toContain(
      `[back from a pause — the owner's coding agent parked this cell for later at 2026-11-17T01:01:00Z, with the words "我还要想想". The owner's coding agent resumed it at 2026-11-17T01:02:00Z, with the words "现在开始做第一阶段".`,
    );
  });

  // Audit 2026-11-23 rerun R03
  it("R03: reopen_project wakes the project with the owner's words (the agent's note apart); without words it says none came", async () => {
    const d = await bootDesk();
    const withWords = makeProject(d.kernel, "支付重试改造");
    const bare = makeProject(d.kernel, "日志清理");
    for (const id of [withWords, bare]) await d.kernel.closeCell(id, "completed", { principalId: d.kernel.ownerPrincipal });
    expect(await refused(d, "reopen_project", { projectId: withWords, context: "主人上次说过只改 HTTP 层" })).toContain("context goes with text");

    const r = await ok(d, "reopen_project", { projectId: withWords, text: "让原来那个分身把上限改回 5 次", context: "主人上次说过只改 HTTP 层" });
    expect(r.text).toContain(`Reopened ${withWords}: it wakes with the owner's words (your note marked as yours)`);
    expect(messagesTo(d, withWords).at(-1)).toMatchObject({
      principalId: "agent:local",
      payload: { text: "主人（经其编码助手）重新打开了这个项目，并说：\n让原来那个分身把上限改回 5 次", agentContext: "主人上次说过只改 HTTP 层" },
    });
    await d.kernel.idle();
    const prompt = requestsOf(d.script, withWords).at(-1)!;
    expect(prompt).toContain("让原来那个分身把上限改回 5 次");
    expect(prompt).toContain(`${NOTE_LABEL}\n主人上次说过只改 HTTP 层`);

    const b = await ok(d, "reopen_project", { projectId: bare });
    expect(b.text).toContain(`Reopened ${bare} without any words from the owner`);
    const woke = messagesTo(d, bare).at(-1)!;
    expect(textOf_(woke)).toBe("主人（经其编码助手）重新打开了这个项目，没有附带新的要求。");
    expect(woke.payload).not.toHaveProperty("agentContext");
  });
});

describe("audit 2026-11-23 rerun: a source switched from observe to active (R04)", () => {
  // Audit 2026-11-23 rerun R04
  it("R04: a hit noted while observing is reported at the next check after the switch, and the switch says so", async () => {
    const d = await bootRealDesk();
    const dir = tempDir("checks");
    const red = join(dir, "ci.mjs");
    writeFileSync(red, `console.log(${JSON.stringify("main 分支 CI 红了")})\n`);
    const { sensorId } = (await ok<{ sensorId: string }>(d, "create_source", { title: "CI 巡检", cron: "0 9 * * *", checkKind: "script", scriptPath: red, mode: "observe" })).data;
    const parent = d.kernel.getCell(sensorId)!.parentId!;
    const hits = () => d.kernel.inbox.listMessagesSync({ cellId: parent, type: PAYLOAD.sourceHit }).map((m) => (m.envelope.payload as { summary: string }).summary);
    const check = async () => {
      await ok(d, "control_cell", { id: sensorId, action: "trigger" });
      await d.kernel.idle();
    };
    await check();
    expect(d.kernel.context.readStateSync<SourceState>(sensorId, gtdKeys.source)).toMatchObject({ mode: "observe", hitCount: 1, lastHitDigest: expect.any(String) });
    expect(hits()).toEqual([]);

    const switched = await ok(d, "manage_source", { sensorId, action: "set_mode", mode: "active" });
    expect(switched.text).toContain("观察期间记下的命中还没有报给任何人，如果下次检查时仍然命中，会当作新命中报出来");
    // Round 8 (uc81): it stays "the last check hit" (forgetting it made the list read as cleared) and is marked as
    // not reported yet, so the next check reports it even when unchanged.
    expect(d.kernel.context.readStateSync<SourceState>(sensorId, gtdKeys.source)).toMatchObject({ lastHitDigest: expect.any(String), lastHitUnreported: true });
    expect((await ok(d, "list_sources")).text).toContain("上次检查仍然命中（观察期间记下的，还没有报出；下次检查仍在就报）");
    await check();
    expect(d.kernel.context.readStateSync<SourceState>(sensorId, gtdKeys.source)).not.toHaveProperty("lastHitUnreported");
    expect(hits()).toEqual([expect.stringContaining("main 分支 CI 红了")]);
    // Unchanged at the check after that: counted, not reported a second time.
    await check();
    expect(hits()).toHaveLength(1);

    // A source that noted nothing while observing says a problem still there is reported at the next check.
    const quiet = join(dir, "quiet.mjs");
    writeFileSync(quiet, "console.log('')\n");
    const { sensorId: other } = (await ok<{ sensorId: string }>(d, "create_source", { title: "夜间报告", cron: "0 3 * * *", checkKind: "script", scriptPath: quiet, mode: "observe" })).data;
    expect((await ok(d, "manage_source", { sensorId: other, action: "set_mode", mode: "active" })).text).toContain("现在仍有问题的话，下次检查就会报");
  });
});

describe("audit 2026-11-23 rerun: what waits on the owner (R06, M21/M03, L03)", () => {
  // Audit 2026-11-23 rerun R06
  it("R06: the desk waiting for the owner after words without a question mark is asking them — in 待我处理 and in chat_with_desk — until they answer", async () => {
    const d = await bootDesk();
    const asked = "请给我仓库的绝对路径，我好交给项目。";
    d.script.add("desk", { text: asked, toolCalls: [{ name: "wait", input: { reason: "等主人给仓库路径", waitingFor: "human" } }] });
    const r = await ok<{ cursor: number; waited: string; replies: Array<{ id: string; text: string; question: boolean; forOwner: boolean }> }>(d, "chat_with_desk", { text: "帮我改一下支付重试", waitSeconds: 20 });
    expect(r.data.waited).toBe("settled");
    expect(r.data.replies).toEqual([expect.objectContaining({ text: asked, question: true, forOwner: true })]);
    const q = r.data.replies[0]!;
    expect(r.text).toContain(`send their answer back with chat_with_desk and replyToId ${q.id}; do not answer it yourself`);
    const o = await ok<{ questions: Array<{ cellId: string; id: string; text: string }> }>(d, "workbench_overview");
    expect(o.data.questions).toEqual([expect.objectContaining({ cellId: "desk", id: q.id, text: asked })]);
    expect(o.text).toContain(`待我处理（1）\n- 主台在问主人：${asked}`);
    // M10: nothing new since — it is waiting for the owner's answer to that question.
    const since = await ok(d, "chat_with_desk", { since: r.data.cursor });
    expect(since.text).toContain(`Nothing new from the desk after #${r.data.cursor}: it is waiting for the owner's answer to its question ${q.id}`);

    d.script.add("desk", { text: "好的，记下了。" });
    await ok(d, "chat_with_desk", { text: "在 ~/dev/pay", replyToId: q.id, waitSeconds: 20 });
    expect(d.kernel.listWaits(["desk"])).toEqual([]);
    const after = await ok<{ questions: unknown[] }>(d, "workbench_overview");
    expect(after.data.questions).toEqual([]);
    expect(after.text).toContain("待我处理（0）");
  });

  // Audit 2026-11-23 rerun R06
  it("R06: a coordinator waiting for the owner after a message to them is asking them; once it holds an open item, that item is listed and not the message too", async () => {
    const d = await bootRealDesk();
    const said = "交付范围需要你定一下：只做导出，还是导出加导入。";
    d.script.add("project", tool("send_message", { to: "channel:ui:owner", text: said, summary: "问范围" }), tool("wait", { reason: "等主人定范围", waitingFor: "human" }));
    const { projectId } = (await ok<{ projectId: string }>(d, "create_project", { title: "导出功能", outcome: "notes-cli 能导出", brief: "主人的原话：「给 notes-cli 加个导出」" })).data;
    await d.kernel.idle();
    const asking = await ok<{ questions: Array<{ cellId: string; text: string; answerWith: string }> }>(d, "workbench_overview");
    expect(asking.data.questions).toEqual([expect.objectContaining({ cellId: projectId, text: said, answerWith: "message_cell" })]);

    const card = d.kernel.humanItems.create(
      { title: "定交付范围", subjectKey: "scope", options: [{ id: "export", label: "只做导出", effect: "reply" }, { id: "both", label: "导出加导入", effect: "reply" }] },
      projectId,
    );
    const o = await ok<{ questions: unknown[]; cards: Array<{ id: string }> }>(d, "workbench_overview");
    expect(o.data.questions).toEqual([]);
    expect(o.data.cards.map((c) => c.id)).toEqual([card.id]);
    expect(o.text).toContain(`待我处理（1）\n- ${card.id}「定交付范围」`);
    expect(o.text).not.toContain("在问主人");
  });

  // Live round 12 (uc06): the end of a hub's notice — "the author has not been told" — was cut off in the overview.
  it("a hub's last notice and its question to the owner are quoted whole", async () => {
    const d = await bootRealDesk();
    const said = `评审完成。${"已核对测试与文档。".repeat(50)}作者还没有收到这项答复。`;
    d.script.add("hub", tool("send_message", { to: "channel:ui:owner", text: said, summary: "评审" }));
    d.kernel.spawnCell("desk", { id: "hub_review", preset: "hub", title: "评审中枢" }, "评审 notes-cli 的 MR", { principalId: d.kernel.ownerPrincipal });
    await d.kernel.idle();
    expect((await ok(d, "workbench_overview")).text).toContain(said);
  });

  // Live round 12 (uc06): asked to set up a topic, the desk said nothing: the answer claimed the owner had been told.
  it("add_hub says the owner's notice has only the title", async () => {
    const d = await bootRealDesk();
    d.script.add("desk", tool("add_hub", { title: "评审专题", repos: [{ name: "a", cwd: tempDir("hub") }], watch: { thread: "ui:reviews" }, rules: "评审" }));
    await d.post("/api/capture", { text: "建一个评审专题" });
    await d.kernel.idle();
    const results = requestsOf(d.script, "desk").flatMap((r) => JSON.stringify(r).match(/Hub hub_[^"]*?Matching/g) ?? []);
    expect(results.join("")).toContain("has only its title");
  });

  // Audit 2026-11-23 rerun R06
  it("R06: a hub's line shows its last message to the owner and, under it, each worker with the first line of its latest result", async () => {
    const d = await bootRealDesk();
    d.script.add("hub", tool("send_message", { to: "channel:ui:owner", text: "请提供 MR 链接，我好安排评审。", summary: "要链接" }));
    d.kernel.spawnCell("desk", { id: "hub_review", preset: "hub", title: "评审中枢" }, "评审 notes-cli 的 MR", { principalId: d.kernel.ownerPrincipal });
    await d.kernel.idle();
    d.script.add("worker", tool("report_to_parent", { kind: "result", text: "建议暂缓合并：有 2 个阻塞问题\n细节见报告" }));
    d.kernel.spawnCell("hub_review", { id: "w_review", preset: "worker", title: "评审 MR !12" }, "评审 MR !12", { principalId: d.kernel.ownerPrincipal });
    await d.kernel.idle();

    const o = await ok<{ hubs: Array<{ cellId: string; lastToOwner: { text: string } | null; workers: Array<{ cellId: string; latestResult: string | null }> }> }>(d, "workbench_overview");
    expect(o.data.hubs).toEqual([
      expect.objectContaining({
        cellId: "hub_review",
        lastToOwner: expect.objectContaining({ text: "请提供 MR 链接，我好安排评审。" }),
        workers: [expect.objectContaining({ cellId: "w_review", latestResult: "建议暂缓合并：有 2 个阻塞问题" })],
      }),
    ]);
    expect(o.text).toMatch(/领域中枢（1）\n- hub_review「评审中枢」（[^\n]*）\n {2}↳ 最近对主人说（[^，]+，r\d+）：请提供 MR 链接，我好安排评审。\n {2}- w_review「评审 MR !12」（[^\n]*）— 最近结果：建议暂缓合并：有 2 个阻塞问题\n/);
  });

  // Audit 2026-11-23 rerun M21 / M03
  it("M21/M03: an item of a parked project says it can wait; an item shows what it asks, a decision card its choices", async () => {
    const d = await bootDesk();
    const p = makeProject(d.kernel, "极简模式");
    const { actionId } = (await ok<{ actionId: string }>(d, "add_action", { projectId: p, title: "约设计师", owner: "human", nextStep: "发日历邀请，周四下午" })).data;
    const card = d.kernel.humanItems.create(
      { title: "确认范围", description: "只做导出，还是导出加导入？", subjectKey: "scope", options: [{ id: "export", label: "只做导出", effect: "reply" }, { id: "both", label: "导出加导入", effect: "reply" }] },
      p,
    );
    const before = await ok(d, "workbench_overview");
    expect(before.text).toMatch(new RegExp(`- ${card.id}「确认范围」 rev=\\d+ · 极简模式\\n {2}↳ 只做导出，还是导出加导入？\\n {2}↳ 选项：只做导出 / 导出加导入`));
    expect(before.text).toMatch(new RegExp(`- ${actionId}「约设计师」 rev=\\d+ · 极简模式\\n {2}↳ 发日历邀请，周四下午`));

    await ok(d, "set_project_state", { id: p, state: "someday", note: "先停一下" });
    const o = await ok(d, "workbench_overview");
    for (const id of [actionId, card.id]) expect(o.text).toMatch(new RegExp(`- ${id}「[^」]+」 rev=\\d+ · 极简模式（项目已停靠在以后再说，这一项暂时不用办）\\n {2}↳ `));
  });

  // Audit 2026-11-23 rerun L03
  it("L03: a cell waiting for the owner reads 在等主人 in get_project and in the overview", async () => {
    const d = await bootDesk();
    const p = makeProject(d.kernel, "支付重试改造");
    d.script.add("w1", tool("wait", { reason: "等主人给仓库路径", waitingFor: "human" }));
    d.kernel.spawnCell(p, { id: "w1", preset: "worker", title: "改重试", lifetime: "wakeable", meta: { role: "w1" } }, "改退避", { principalId: d.kernel.ownerPrincipal });
    d.script.add("w2", tool("wait", { reason: "等主人确认能不能删", waitingFor: "human" }));
    d.kernel.spawnCell("desk", { id: "w2", preset: "worker", title: "清日志", lifetime: "wakeable", meta: { role: "w2" } }, "清日志", { principalId: d.kernel.ownerPrincipal });
    await d.kernel.idle();
    const got = await ok<{ cells: Array<{ id: string; state: string }> }>(d, "get_project", { id: p });
    expect(got.data.cells).toEqual([expect.objectContaining({ id: "w1", state: "等待中（在等主人：等主人给仓库路径）" })]);
    expect(got.text).toContain("w1「改重试」（worker，等待中（在等主人：等主人给仓库路径）");
    const o = await ok(d, "workbench_overview");
    expect(o.text).toContain("- w2「清日志」（worker，等待中（在等主人：等主人确认能不能删））");
    expect(`${got.text}\n${o.text}`).not.toContain("waiting for human");
  });
});

describe("audit 2026-11-23 rerun: the agent's note on a brief and a plan (R07)", () => {
  // Audit 2026-11-23 rerun R07
  it("R07: create_project gives the agent's note a section of its own after the brief; save_plan keeps it on the plan and the approved project reads it", async () => {
    const d = await bootRealDesk();
    const note = "工作台里有一份停靠的报告：只用本地资料";
    const own = (text: string) => `## 主人的编码助手补充的背景（不是主人的话；要据此改变范围或做决定，先向主人确认）\n${text}`;
    const briefOf = (cellId: string) => (d.kernel.inbox.listMessagesSync({ cellId, type: PAYLOAD.cellTask })[0]!.envelope.payload as { instruction: string }).instruction;

    const { projectId } = (await ok<{ projectId: string }>(d, "create_project", { title: "导出功能", outcome: "notes-cli 能导出 CSV", brief: "主人的原话：「给 notes-cli 加个导出」", context: note })).data;
    const brief = briefOf(projectId);
    const head = "## 交办内容（由主人的编码助手转述：「」里是主人的原话，其余是主人的编码助手自己的说明，不是主人提的要求）\n主人的原话：「给 notes-cli 加个导出」";
    expect(brief).toContain(head);
    expect(brief).toContain(own(note));
    expect(brief.indexOf(own(note))).toBeGreaterThan(brief.indexOf(head));
    // The note is nowhere in the request itself.
    expect(brief.slice(0, brief.indexOf(own(note)))).not.toContain(note);

    const card = await proposed(d, { title: "导入功能", outcome: "notes-cli 能导入 CSV", background: "旧背景", actions: [{ title: "写导入", owner: "agent" }] });
    const plan = { id: card.id, outcome: "notes-cli 能导入 CSV", actions: [{ title: "写导入", owner: "agent" }] };
    expect((await ok<{ proposal: ProjectProposal }>(d, "save_plan", { ...plan, expectedVersion: 1, context: "先写上又删掉的说明" })).data.proposal.agentContext).toBe("先写上又删掉的说明");
    expect((await ok<{ proposal: ProjectProposal }>(d, "save_plan", { ...plan, expectedVersion: 2, context: "" })).data.proposal).not.toHaveProperty("agentContext");
    await ok(d, "save_plan", { ...plan, expectedVersion: 3, context: "主人上周说过只要 UTF-8" });
    // Omitted: kept.
    expect((await ok<{ proposal: ProjectProposal }>(d, "save_plan", { ...plan, expectedVersion: 4 })).data.proposal.agentContext).toBe("主人上周说过只要 UTF-8");
    const item = (await ok<{ items: HumanItemDTO[] }>(d, "list_human_items")).data.items.find((i) => i.id === card.id)!;
    expect(item.proposal).toMatchObject({ agentContext: "主人上周说过只要 UTF-8", background: "旧背景" });

    await ok(d, "decide_human_item", { id: card.id, optionId: "system.execute", seenItemRevision: item.itemRevision, seenArtifactVersion: 5 });
    const approved = briefOf(projectIdForApproval(card.id));
    expect(approved).toContain("## 交办内容（主人在立项卡上确认过的方案）");
    expect(approved).toContain(own("主人上周说过只要 UTF-8"));
    expect(approved).not.toContain("先写上又删掉的说明");
  });
});

describe("audit 2026-11-23 rerun: a plan's passages for the owner to decide (R08)", () => {
  // Audit 2026-11-23 rerun R08
  it("R08: list_human_items and read_artifact name a plan's > [!DECISION] passages; save_plan says which ones a new version dropped", async () => {
    const d = await bootRealDesk();
    const second = "> [!DECISION] 先做哪个格式\n> CSV 还是 JSON";
    const card = await proposed(d, {
      title: "导出功能",
      outcome: "notes-cli 能导出",
      background: `导出给运营用。\n\n> [!DECISION] 保留 Unicode？\n> A：原样输出\n> B：转义输出\n\n${second}`,
      actions: [{ title: "写导出", owner: "agent" }],
    });
    const listed = await ok(d, "list_human_items");
    expect(listed.text).toContain(`- ${card.id} 立项方案 v1：`);
    expect(listed.text).toContain("；需要主人拍板的段落 2 处：「保留 Unicode？」、「先做哪个格式」");
    expect(card.artifact?.decisions.map((x) => x.label)).toEqual(["保留 Unicode？", "先做哪个格式"]);
    const art = await ok<{ decisions: Array<{ label: string; text: string }> }>(d, "read_artifact", { id: card.artifactId! });
    expect(art.data.decisions).toMatchObject([{ label: "保留 Unicode？", text: "A：原样输出\nB：转义输出" }, { label: "先做哪个格式", text: "CSV 还是 JSON" }]);
    expect(art.text).toContain("需要主人拍板的段落（2）\n- 「保留 Unicode？」：A：原样输出 B：转义输出\n- 「先做哪个格式」：CSV 还是 JSON");

    const actions = [{ title: "写导出", owner: "agent" }];
    const dropped = await ok<{ droppedDecisions: string[] }>(d, "save_plan", { id: card.id, expectedVersion: 1, outcome: "notes-cli 能导出", background: `导出给运营用。\n\n${second}`, actions });
    expect(dropped.data.droppedDecisions).toEqual(["保留 Unicode？"]);
    expect(dropped.text).toContain("No longer in it: 1 passage(s) marked for the owner to decide: 「保留 Unicode？」");
    expect(dropped.text).toContain("Still marked for the owner to decide (1): 「先做哪个格式」");
    // Background omitted: kept, nothing dropped.
    const kept = await ok<{ droppedDecisions: string[] }>(d, "save_plan", { id: card.id, expectedVersion: 2, outcome: "notes-cli 能导出 CSV", actions });
    expect(kept.data.droppedDecisions).toEqual([]);
    expect(kept.text).not.toContain("No longer in it");
    expect(kept.text).toContain("Still marked for the owner to decide (1)");
  });
});

describe("audit 2026-11-23 rerun: the owner's answer lands on its item (R09, M13)", () => {
  // Audit 2026-11-23 rerun R09 / M13
  it("M13: a refused decision says what is current — the revision, the choices, the draft version", async () => {
    const d = await bootDesk();
    const { actionId, artifactId } = makeReviewCard(d.kernel);
    const card = d.server.desk.listHumanItems().find((i) => i.id === actionId)!;
    const base = { id: actionId, optionId: "system.reply", seenItemRevision: card.itemRevision, seenArtifactVersion: 1 };
    const stale = card.itemRevision + 5;
    expect(await refused(d, "decide_human_item", { ...base, seenItemRevision: stale })).toContain(`事项已变动：现在是第 ${card.itemRevision} 版，提交的是第 ${stale} 版`);
    expect(await refused(d, "decide_human_item", { ...base, optionId: "nope" })).toMatch(/选项已变动：现在可选 \S*system\.reply/);
    await ok(d, "save_artifact", { id: artifactId, expectedVersion: 1, body: "您好，接口下周三上线。" });
    const now = d.server.desk.listHumanItems().find((i) => i.id === actionId)!;
    expect(await refused(d, "decide_human_item", { ...base, seenItemRevision: now.itemRevision })).toContain("草稿已变动：现在是 v2，提交的是 v1");
    const { seenArtifactVersion: _seen, ...unversioned } = base;
    expect(await refused(d, "decide_human_item", { ...unversioned, seenItemRevision: now.itemRevision })).toContain("草稿已变动：现在是 v2，提交的是没有带版本");
    // The web's 409 carries the same words; the item is still open.
    const web = await d.req<{ error: { message: string } }>("POST", `/api/human-items/${actionId}/decide`, { optionId: "system.reply", seenItemRevision: stale, seenArtifactVersion: 2 });
    expect(web.status).toBe(409);
    expect(web.json.error.message).toMatch(/^事项已变动：现在是第 \d+ 版/);
    expect(d.kernel.humanItems.get(actionId)!.status).toBe("pending");
  });

  // Audit 2026-11-23 rerun R09
  it("R09: the desk ticks off a reminder that fired on the owner's words (settle_item); an approval the Gate holds stays the owner's to decide", async () => {
    const d = await bootDesk();
    // A reminder that came due: a personal item, held by no cell.
    const reminder = d.kernel.humanItems.create({ title: "给花浇水", category: "action", subjectKey: "reminder:water", options: [{ id: "done", label: "办完", effect: "complete" }] }, null);
    const { actionId: review } = makeReviewCard(d.kernel);
    d.script.add("desk", tool("settle_item", { id: reminder.id, ownerWords: "浇水浇过了", itemRevision: 1 }), tool("settle_item", { id: review, ownerWords: "浇水浇过了", itemRevision: 1 }));
    await ok(d, "chat_with_desk", { text: "浇水浇过了", waitSeconds: 20 });

    expect(d.kernel.humanItems.get(reminder.id)).toMatchObject({ status: "resolved" });
    expect(get(d.kernel.db, "SELECT status_reason, approver_id, outcome FROM human_items WHERE action_id = ?", [reminder.id])).toEqual({
      status_reason: "settled_in_conversation",
      approver_id: "agent:local",
      outcome: JSON.stringify({ note: "浇水浇过了" }),
    });
    // The owner sees in the activity list what they were taken to have said, and can undo it.
    const activity = await d.get<ActivityListDTO>("/api/activity");
    expect(activity.items.find((i) => i.title === "给花浇水")).toMatchObject({ detail: "后台按你在对话里的话结清：「浇水浇过了」", buttons: [expect.objectContaining({ id: "undo" })] });
    expect(d.kernel.humanItems.get(review)).toMatchObject({ status: "pending" });
    const seen = requestsOf(d.script, "desk").join("\n");
    expect(seen).toContain(`Recorded: ${reminder.id} is settled on the owner's word`);
    expect(seen).toContain(`${review} approves an action`);
    expect((await ok<{ items: HumanItemDTO[] }>(d, "list_human_items")).data.items.map((i) => i.id)).toEqual([review]);
  });
});

describe("audit 2026-11-23 rerun: steering a cell and waiting for the desk (M09, M10)", () => {
  // Audit 2026-11-23 rerun M09
  it("M09: a steer to a worker whose turn is over says nothing was interrupted; to a running one, that it was", async () => {
    const d = await bootDesk();
    const project = makeProject(d.kernel, "支付重试改造");
    d.script.add("w1", { text: "退避写好了" });
    d.kernel.spawnCell(project, { id: "w1", preset: "worker", title: "改重试", lifetime: "wakeable", meta: { role: "w1" } }, "改退避", { principalId: d.kernel.ownerPrincipal });
    await d.kernel.idle();
    const dormant = await ok(d, "message_cell", { id: "w1", text: "上限改成 3", mode: "steer" });
    expect(dormant.text).toContain("w1 was not running (its turn had already ended), so nothing was interrupted");
    expect(dormant.text).toContain("is woken by it");
    expect(dormant.text).not.toContain("was interrupted with it");
    await d.kernel.idle();
    // The web view words it by the same state.
    const web = await d.post<SendCellMessageResponse>("/api/cells/w1/messages", { text: "再跑一遍测试", clientId: "m-1", mode: "steer" });
    expect(web.message).toContain("它这一轮已经结束，没有可打断的；消息已送达，会唤醒它处理");
    await d.kernel.idle();

    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    d.script.add("w1", async () => {
      started();
      await held;
      return { text: "好" };
    });
    await ok(d, "message_cell", { id: "w1", text: "看一下日志" });
    await running;
    const live = await ok(d, "message_cell", { id: "w1", text: "先别动对外 API", mode: "steer" });
    expect(live.text).toContain("w1 was interrupted with it");
    release();
    await d.kernel.idle();
  });

  // Audit 2026-11-23 rerun M10
  it("M10: when waitSeconds runs out and the desk has only said something on the way, the answer says it is still working and that is not its answer", async () => {
    const d = await bootDesk();
    let reachedSecondTurn!: () => void;
    const reached = new Promise<void>((r) => (reachedSecondTurn = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    d.script.add("desk", { text: "我先查一下有没有同题项目。", toolCalls: [{ name: "read_state", input: {} }] }, async () => {
      reachedSecondTurn();
      await held;
      return { text: "查完了：没有同题项目，可以新建。" };
    });
    const from = d.kernel.context.lastEvidenceSeqSync("desk");
    const pending = call(d, "chat_with_desk", { text: "我想给 notes-cli 加个导出", waitSeconds: 1 });
    // Its first words are on record before the wait runs out; its final answer is held back until after.
    await reached;
    const r = await pending;
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ waited: "timeout", stillWorking: true, replies: [expect.objectContaining({ text: "我先查一下有没有同题项目。" })] });
    expect(r.text).toContain("The desk is still working on it (no final answer within 1 s)");
    expect(r.text).toContain("on the way");
    expect(r.text).toContain("(not its answer)");
    // Live round 13 (uc03): a plan was decided without the desk's final answer having been read.
    expect(r.text).toMatch(/read it \(chat_with_desk \{ since: \d+ \}\) before you decide or pass on anything about this request/);
    // Read while it still runs: still working.
    expect((await ok<{ stillWorking: boolean }>(d, "chat_with_desk", { since: from })).data.stillWorking).toBe(true);

    release();
    await d.kernel.idle();
    const done = await ok<{ stillWorking: boolean; replies: Array<{ text: string }> }>(d, "chat_with_desk", { since: from });
    expect(done.data.stillWorking).toBe(false);
    expect(done.data.replies.map((x) => x.text)).toEqual(["我先查一下有没有同题项目。", "查完了：没有同题项目，可以新建。"]);
    expect(done.text).toContain(`The desk's replies after #${from}`);
  });
});

describe("audit 2026-11-23 rerun: a revised plan is what the owner sees (M18)", () => {
  // Audit 2026-11-23 rerun M18
  it("M18: after save_plan the card shows the plan's new title, description and proposal; a version says whether the owner's agent or the owner saved it", async () => {
    const d = await bootRealDesk();
    const card = await proposed(d, { title: "导出功能", outcome: "notes-cli 能导出 Markdown", actions: [{ title: "写导出", owner: "agent" }], prep: { summary: "建议同时支持 Markdown 和 HTML 两种导出" } });
    // The desk's preparatory note stands beside its own draft …
    expect(card.prep?.summary).toBe("建议同时支持 Markdown 和 HTML 两种导出");
    await ok(d, "save_plan", { id: card.id, expectedVersion: 1, title: "导出 CSV", outcome: "notes-cli 能导出 CSV", actions: [{ title: "写 CSV 导出", owner: "agent" }, { title: "试用一下", owner: "human" }] });
    const item = (await ok<{ items: HumanItemDTO[] }>(d, "list_human_items")).data.items.find((i) => i.id === card.id)!;
    // … and not beside a plan the owner or their agent has changed since (round 4, uc47: it recommended what the plan had dropped).
    expect(item.prep?.summary).toBe("");
    expect(item.title).toBe("导出 CSV");
    expect(item.description).toBe("notes-cli 能导出 CSV\n- [交给后台] 写 CSV 导出\n- [主人来做] 试用一下");
    expect(item.action).toMatchObject({ type: "project.start", proposal: { title: "导出 CSV", outcome: "notes-cli 能导出 CSV" } });
    expect(item.artifact).toMatchObject({ version: 2, updatedBy: "human", updatedByLabel: "你的编码助手（按你的意思）" });
    expect((await d.get<ArtifactDTO>(`/api/artifacts/${card.artifactId}`)).versionText).toContain("由你的编码助手（按你的意思）修改");

    const web = await d.req("PUT", `/api/human-items/${card.id}/plan`, { expectedVersion: 2, proposal: { outcome: "notes-cli 能导出 CSV 和 JSON", actions: [{ title: "写导出", owner: "agent" }] } });
    expect(web.status).toBe(200);
    expect(await d.get<ArtifactDTO>(`/api/artifacts/${card.artifactId}`)).toMatchObject({ version: 3, updatedByLabel: "你" });

    // A report saved with save_artifact likewise; a background rewrite after it is the agent's again.
    d.kernel.context.commitSync("desk", { artifact: { artifactId: "art_r", content: { format: "markdown", title: "调研", body: "草稿" }, updatedBy: "agent" } });
    await ok(d, "save_artifact", { id: "art_r", expectedVersion: 1, body: "按主人意思改过" });
    expect(await d.get<ArtifactDTO>("/api/artifacts/art_r")).toMatchObject({ version: 2, updatedByLabel: "你的编码助手（按你的意思）" });
    expect((await d.req("PUT", "/api/artifacts/art_r", { expectedVersion: 2, body: "主人自己改的" })).status).toBe(200);
    expect(await d.get<ArtifactDTO>("/api/artifacts/art_r")).toMatchObject({ version: 3, updatedByLabel: "你" });
    agentRedraft(d.kernel, "art_r", "后台重写", 3);
    expect(await d.get<ArtifactDTO>("/api/artifacts/art_r")).toMatchObject({ version: 4, updatedByLabel: "后台" });
  });
});

describe("audit 2026-11-23 rerun: the workbench's address (L01)", () => {
  // Audit 2026-11-23 rerun L01
  it("L01: the overview starts with the address the caller reached the workbench at, and the MCP server's instructions end with it", async () => {
    const d = await bootDesk({ port: 0 });
    const o = await ok<{ baseUrl: string }>(d, "workbench_overview");
    expect(o.text).toMatch(/^工作台概览（主人的本地时间 \d+月\d+日 \d\d:\d\d，即 [^；]+Z）\n\n工作台地址：http:\/\/localhost\n\n待我处理/);
    expect(o.data.baseUrl).toBe("http://localhost");

    const { url } = await d.server.listen();
    const base = url.replace(/\/+$/, "");
    const mcp = startMcp({ NG_DESK_URL: url });
    try {
      mcp.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "codex-mcp-client", version: "0" } } });
      const init = (await mcp.next()) as { result: { instructions: string } };
      expect(init.result.instructions.endsWith(`\nThe workbench is at ${base} (links for the owner start with this address).`)).toBe(true);
      mcp.send({ id: 2, method: "tools/call", params: { name: "workbench_overview", arguments: {} } });
      expect(textOf(await mcp.next())).toContain(`\n\n工作台地址：${base}\n\n`);
    } finally {
      mcp.close();
    }
  });
});

// ==================== Live rerun, round 1: what the external agent reads ====================

describe("live rerun round 1: what the external agent reads (uc02, uc04, uc06)", () => {
  const NOTICES = "它最近发给主人的通知";

  // Rerun round 1, uc02: the owner talked only to their coding agent, and it could not see what the project had told
  // them on the workbench (where the delivery was, what was still undecided).
  it("uc02: get_project lists the latest notices of the project and the cells below it, oldest first; none, no section", async () => {
    // The real presets: a project may notify the owner.
    const d = await bootRealDesk();
    const p = makeProject(d.kernel, "导出功能");
    const other = makeProject(d.kernel, "日志清理");
    d.kernel.spawnCell(p, { id: "w1", preset: "worker", title: "写导出", lifetime: "wakeable", meta: { role: "w1" } }, undefined, { principalId: d.kernel.ownerPrincipal });

    // Nothing told to the owner yet: no section, no data.
    const before = await ok<{ notices: unknown[] }>(d, "get_project", { id: p });
    expect(before.text).not.toContain(NOTICES);
    expect(before.data.notices).toEqual([]);

    // The project tells the owner where the delivery is (send_message to their workbench address) …
    const delivered = "导出做好了，在分支 feat/export，还没合入 main。\n要不要带表头还没定。";
    d.script.add("project", tool("send_message", { to: "channel:ui:owner", text: delivered, summary: "交付" }));
    await ok(d, "message_project", { id: p, text: "做完告诉我" });
    await d.kernel.idle();
    // … a worker below it leaves a notice a minute later, and another project one of its own.
    d.clock.advance(MIN);
    d.kernel.hub.notifyOwner({ cellId: "w1", content: { format: "text", body: "测试要你在本机跑一次" }, idempotencyKey: "w1-notice" });
    d.kernel.hub.notifyOwner({ cellId: other, content: { format: "text", body: "日志清理完了" }, idempotencyKey: "other-notice" });

    const got = await ok<{ notices: Array<{ cellId: string; at: number; text: string }> }>(d, "get_project", { id: p });
    expect(got.data.notices).toEqual([
      { cellId: p, at: T0, text: delivered },
      { cellId: "w1", at: T0 + MIN, text: "测试要你在本机跑一次" },
    ]);
    expect(got.text).toContain(`${NOTICES}（`);
    // One entry per notice; a notice's later lines are indented under it.
    // Times are the owner's clock (the host's zone here), like the parking record in the same answer.
    expect(got.text).toMatch(/- 11月1[67]日 \d{2}:00 导出做好了，在分支 feat\/export，还没合入 main。\n  要不要带表头还没定。\n- 11月1[67]日 \d{2}:01 测试要你在本机跑一次/);
    expect(got.text).not.toContain("日志清理完了");
    // The other project's own answer has its notice only.
    expect((await ok<{ notices: Array<{ text: string }> }>(d, "get_project", { id: other })).data.notices.map((n) => n.text)).toEqual(["日志清理完了"]);
  });

  // Rerun round 1, uc04: who parked a project and when was shown as "…T01:00:00Z" — the owner's clock read 09:00.
  it("uc04: who paused a project and when is told on the owner's clock (the desk's zone), not in UTC", async () => {
    // A zone that is neither UTC nor likely the host's: 2026-11-17T01:00Z is 20:00 the day before in New York.
    const d = await bootDesk({ env: { NG_DESK_TZ: "America/New_York" } });
    const p = makeProject(d.kernel, "周报");
    await d.post(`/api/projects/${p}/pause`);
    const got = await ok<{ pausedBy: { text: string } }>(d, "get_project", { id: p });
    expect(got.data.pausedBy).toMatchObject({ text: "主人于 11月16日 20:00 暂停，没有留话", by: "主人", at: T0, parked: false });
    expect(got.text).toContain("已暂停（主人于 11月16日 20:00 暂停，没有留话；");
  });

  // Rerun round 1, uc06: the owner's note for the review topic went to the hub with message_cell, bypassing the topic
  // and its window — nothing told the external agent which topic the hub collects or how a note reaches it.
  it("uc06: a hub's line in the overview names the topic it watches", async () => {
    const d = await bootRealDesk();
    const watches = [{ threadOrFilter: { thread: "ui:reviews" } }, { threadOrFilter: { thread: "ui:reviews" } }, { threadOrFilter: { type: "user.message" } }];
    d.kernel.spawnCell("desk", { id: "hub_review", preset: "hub", title: "评审中枢", watches }, undefined, { principalId: d.kernel.ownerPrincipal });
    d.kernel.spawnCell("desk", { id: "hub_plain", preset: "hub", title: "值班中枢" }, undefined, { principalId: d.kernel.ownerPrincipal });

    const o = await ok<{ hubs: Array<{ cellId: string; topics: string[] }> }>(d, "workbench_overview");
    // One entry per topic; a watch by filter is no topic.
    expect(Object.fromEntries(o.data.hubs.map((h) => [h.cellId, h.topics]))).toEqual({ hub_review: ["ui:reviews"], hub_plain: [] });
    expect(o.text).toMatch(/\n- hub_review「评审中枢」（[^\n]*；收 ui:reviews）/);
    expect(o.text).toMatch(/\n- hub_plain「值班中枢」（[^；\n]*）/);
    expect(o.text.split("\n").find((l) => l.startsWith("- hub_plain"))).not.toContain("收 ");
  });

  // Rerun round 1, uc06 and uc04: the skill sends a topic note through capture with threads. The rule on parked work is
  // no longer a line in the skill — the tool answers carry it (get_project of a parked project).
  it("uc06/uc04: the skill routes a topic note through capture with threads; get_project of a parked project says when activating is right", async () => {
    const skill = readFileSync(fileURLToPath(new URL("../main-agent/ng-desk/skills/ng-desk/SKILL.md", import.meta.url)), "utf8");
    expect(skill).toContain("`capture` with the owner's text and `threads: [\"ui:reviews\"]`");
    expect(skill).toContain("Do not `message_cell` the hub instead");
    expect(skill).not.toContain("Never restart parked work on your own");

    const d = await bootDesk();
    const p = makeProject(d.kernel, "极简模式");
    await ok(d, "set_project_state", { id: p, state: "someday", note: "先停一下" });
    expect((await ok(d, "get_project", { id: p })).text).toContain("重新启动前先问主人；启动用 set_project_state activate，不是 resume");
  });
});

// ==================== Live rerun, round 3: what waits for the owner on the web, and what a stop leaves behind ====================

describe("live rerun round 3: what waits for the owner (web counts, parking, timeline, weekly review)", () => {
  // Live rerun round 3 (uc02): the desk's question in words was in the external agent's overview only — the web's
  // 待我处理 and its count showed nothing waiting.
  it("the desk's open question is counted in /api/status and listed in /api/human-items until the owner answers it", async () => {
    const d = await bootDesk();
    const asked = "请给我仓库的绝对路径，我好交给项目。";
    d.script.add("desk", { text: asked, toolCalls: [{ name: "wait", input: { reason: "等主人给仓库路径", waitingFor: "human" } }] });
    await d.post("/api/capture", { text: "帮我改一下支付重试" });
    await d.kernel.idle();
    expect(d.kernel.listOpenWaits(["desk"])).toMatchObject([{ waitingFor: "human" }]);
    expect(d.kernel.humanItems.list()).toEqual([]);

    expect(await d.get<StatusDTO>("/api/status")).toMatchObject({ humanQuestions: 1, humanPending: 1 });
    const listed = await d.get<HumanItemsResponse>("/api/human-items");
    expect(listed.items).toEqual([]);
    expect(listed.questions).toEqual([{ cellId: "desk", from: "主台", text: asked, at: T0, stopped: false }]);

    // The owner answers in the workbench: no question is open any more.
    d.script.add("desk", { text: "好的，记下了。" });
    await d.post("/api/capture", { text: "在 ~/dev/pay" });
    await d.kernel.idle();
    expect(d.kernel.listOpenWaits(["desk"])).toEqual([]);
    expect(await d.get<StatusDTO>("/api/status")).toMatchObject({ humanQuestions: 0, humanPending: 0 });
    expect((await d.get<HumanItemsResponse>("/api/human-items")).questions).toEqual([]);
  });

  // Live rerun round 3 (uc04): parked right after a delivery, the owner heard only that it was stopped.
  it("set_project_state someday / pause names what still waits for the owner and the project's latest notice; with neither, the plain answer", async () => {
    const d = await bootDesk();
    const parked = makeProject(d.kernel, "导出功能");
    const card = d.kernel.humanItems.create(
      { title: "确认交付范围", subjectKey: "scope", options: [{ id: "export", label: "只做导出", effect: "reply" }, { id: "both", label: "导出加导入", effect: "reply" }] },
      parked,
    );
    const delivered = "导出做好了，在分支 feat/export，还没合入 main。";
    d.kernel.hub.notifyOwner({ cellId: parked, content: { format: "text", body: delivered }, idempotencyKey: "parked-notice" });

    const r = await ok<{ outcome: string; openItems: string[] }>(d, "set_project_state", { id: parked, state: "someday", note: "先停一下" });
    expect(r.text).toContain("「导出功能」已移进以后再说");
    expect(r.text).toContain("它还有 1 项在等主人：「确认交付范围」");
    expect(r.text).toContain(`它上一次发给主人的通知（`);
    expect(r.text).toContain(`，在这之前）：${delivered}`);
    expect(r.data.openItems).toEqual([card.id]);

    // pause: an item only — no notice line.
    const held = makeProject(d.kernel, "周报");
    const todo = d.kernel.humanItems.create({ title: "看一下周报草稿", subjectKey: "draft", options: [{ id: "ok", label: "看过了", effect: "reply" }] }, held);
    const p = await ok<{ openItems: string[] }>(d, "set_project_state", { id: held, state: "pause" });
    expect(p.text).toContain("它还有 1 项在等主人：「看一下周报草稿」");
    expect(p.text).not.toContain("它最近发给主人的通知");
    expect(p.data.openItems).toEqual([todo.id]);

    // Neither: the plain answer, nothing added.
    const quiet = makeProject(d.kernel, "日志清理");
    const plainSomeday = await ok<{ openItems: string[] }>(d, "set_project_state", { id: quiet, state: "someday" });
    expect(plainSomeday.text).toBe("「日志清理」已移进以后再说，后台任务已暂停，记录和报告都留着");
    expect(plainSomeday.data.openItems).toEqual([]);
    const idle = makeProject(d.kernel, "官网");
    expect((await ok(d, "set_project_state", { id: idle, state: "pause" })).text).toBe("已暂停「官网」");
  });

  // Live rerun round 3: the radar row of a parked project said nothing of who parked it, when, or why.
  it("a radar row carries who parked the project, when and with what words; a running project's row has none", async () => {
    const d = await bootDesk();
    const parked = makeProject(d.kernel, "播客计划");
    const running = makeProject(d.kernel, "周报");
    expect(d.kernel.control(parked, { action: "pause", pauseReason: "parked", note: "等我换了麦克风再说" }, { principalId: d.kernel.ownerPrincipal })).toMatchObject({ applied: true });
    const radar = await d.get<RadarDTO>("/api/radar");
    const rows = [...radar.projects, ...radar.someday];
    const row = (id: string) => rows.find((x) => x.id === id)!;
    expect(radar.someday.map((x) => x.id)).toEqual([parked]);
    expect(row(parked)).toMatchObject({ lifecycle: "someday" });
    expect(row(parked).pausedText).toMatch(/^主人于 \d{1,2}月\d{1,2}日 \d{2}:\d{2} 放进以后再说，当时的话：「等我换了麦克风再说」$/);
    expect(row(running).pausedText).toBeNull();
  });

  // Live rerun round 3: a turn that only changed the card it had already raised read "提交了一张卡等你确认" again.
  it("the timeline says a turn raised a card, and that a later turn only updated that same card", async () => {
    const d = await bootRealDesk();
    d.script.add("desk", tool("present_to_owner", { title: "CI 巡检发现", summary: "main 分支 CI 红了，要你知道" }));
    await d.post("/api/capture", { text: "CI 怎么了" });
    await d.kernel.idle();
    const [card] = d.kernel.humanItems.list();
    expect(card).toBeDefined();

    // A minute later the desk updates the card it raised (same subject): no second card.
    d.clock.advance(MIN);
    d.script.add("desk", tool("present_to_owner", { title: "CI 巡检发现（补充）", summary: "main 分支 CI 红了，原因是依赖升级", subjectKey: card!.subjectKey }));
    await d.post("/api/capture", { text: "原因查到了吗" });
    await d.kernel.idle();
    expect(d.kernel.humanItems.list().map((i) => [i.id, i.title])).toEqual([[card!.id, "CI 巡检发现（补充）"]]);

    const items = (await d.get<CellTimelineDTO>("/api/cells/desk/timeline")).items;
    expect(items.filter((i) => i.kind === "milestone").map((i) => (i as { text: string }).text)).toEqual(["提交了一张卡等你确认", "更新了等你确认的那张卡"]);

    // Round 4 (uc41): the card changing again later — here it is withdrawn — does not rewrite what those turns did.
    d.clock.advance(MIN);
    expect(d.kernel.humanItems.withdrawOwn(card!.id, "desk", "已由项目接手")).toBe("withdrawn");
    const later = (await d.get<CellTimelineDTO>("/api/cells/desk/timeline")).items;
    expect(later.filter((i) => i.kind === "milestone").map((i) => (i as { text: string }).text)).toEqual(["提交了一张卡等你确认", "更新了等你确认的那张卡"]);
  });

  // Live rerun round 3: the weekly review counted only the owner's edits of drafts held by the Gate.
  it("weekly review editedDrafts counts a cell's draft card the owner edited before deciding it", async () => {
    const d = await bootDesk();
    const saved = d.kernel.context.commitSync("desk", { artifact: { artifactId: "art_reply", content: { format: "text", body: "您好，接口下周二上线。" }, updatedBy: "agent" } });
    expect(saved.ok).toBe(true);
    const card = d.kernel.humanItems.create(
      { title: "回复草稿", subjectKey: "draft:reply", artifactId: "art_reply", options: [{ id: "final", label: "定稿", effect: "reply" }, { id: "revise", label: "请修改", effect: "revise", input: { mode: "required" } }] },
      "desk",
    );
    expect((await d.get<WeeklyReviewDTO>("/api/review")).editedDrafts).toBe(0);

    // The owner edits the draft in the workbench, then decides the card on the version they wrote.
    expect((await d.req("PUT", "/api/artifacts/art_reply", { expectedVersion: 1, body: "您好，接口下周三上线。" })).status).toBe(200);
    const now = d.server.desk.listHumanItems().find((i) => i.id === card.id)!;
    await d.post(`/api/human-items/${card.id}/decide`, { optionId: "final", seenItemRevision: now.itemRevision, seenArtifactVersion: 2 });
    await d.kernel.idle();
    expect(get(d.kernel.db, "SELECT action_hash, human_edited, status FROM human_items WHERE action_id = ?", [card.id])).toEqual({ action_hash: "", human_edited: 1, status: "resolved" });
    expect((await d.get<WeeklyReviewDTO>("/api/review")).editedDrafts).toBe(1);
  });
});

// ==================== Live rerun, round 4: what is left for the owner after an acceptance ====================

describe("live rerun round 4 (uc45): a project that just closed still tells where its work landed", () => {
  // Original condition: three deliveries were accepted, the projects closed, and "我还要做什么吗" was answered with
  // "没有待你处理的事项" — the overview, the first thing the agent reads, no longer named the projects, and their
  // closing notices (which branch, main unchanged, who merges) were nowhere in it.
  it("workbench_overview lists a project closed in the past day with its closing notice; an older one is left out", async () => {
    const d = await bootRealDesk();
    const p = makeProject(d.kernel, "改重试上限");
    const closing = "「改重试上限」已完成：改动在分支 change-max-retry-to-3，main 未改动，合并由你决定。";
    d.script.add("project", tool("finish_project", { outcome: "completed", summary: "改动在分支 change-max-retry-to-3，main 未改动，合并由你决定。" }));
    await ok(d, "message_project", { id: p, text: "验收通过" });
    await d.kernel.idle();
    expect(d.kernel.getCell(p)?.status).toBe("closed");

    const o = await ok(d, "workbench_overview");
    expect(o.text).toContain("24 小时内结束的项目");
    expect(o.text).toContain(`- ${p}「改重试上限」— 已完成`);
    expect(o.text).toMatch(new RegExp(`最后一条通知（[^）]+）：${closing}`));

    d.clock.advance(25 * 60 * MIN);
    expect((await ok(d, "workbench_overview")).text).not.toContain("24 小时内结束的项目");
  });
});

describe("live rerun round 4 (uc42, uc44): what the agent and the radar are shown", () => {
  // uc42: the project answered the owner's relayed "先别急着合" in its turn ("我还没有通知 MR 的其他参与者暂缓合并")
  // without a notice — the owner, who only talks to their agent, never saw it.
  it("get_project shows what the project said back to the owner's last words when it sent no notice; a notice replaces it", async () => {
    const d = await bootRealDesk();
    const p = makeProject(d.kernel, "表格复制修复");
    d.script.add("project", { text: "知道了。我还没有通知 MR 的其他参与者暂缓合并，维护者仍然可能合入。" });
    const sent = await ok(d, "message_project", { id: p, text: "先别急着合，我再看看" });
    await d.kernel.idle();
    // The relay itself says that the words were only passed on.
    expect(sent.text).toContain("so far only passed on");
    const got = await ok(d, "get_project", { id: p });
    expect(got.text).toContain("它对主人上一句话的答复（没有发通知，主人没看到）");
    expect(got.text).toContain("我还没有通知 MR 的其他参与者暂缓合并");

    // When it tells the owner in a notice, that is the answer: no second listing.
    d.script.add("project", tool("send_message", { to: "channel:ui:owner", text: "维护者还没被告知暂缓合并。", summary: "提醒" }), { text: "已告知主人。" });
    const again = await ok(d, "message_project", { id: p, text: "那你跟我说一声现在的情况" });
    await d.kernel.idle();
    const after = await ok(d, "get_project", { id: p });
    expect(after.text).not.toContain("它对主人上一句话的答复");
    expect(after.text).toContain("维护者还没被告知暂缓合并。");
    // The next relay comes back with where the project stood when it last told the owner.
    d.script.add("project", { text: "好。" });
    const third = await ok(d, "message_project", { id: p, text: "行" });
    expect(third.text).toContain("它上一次发给主人的通知（");
    expect(third.text).toContain("维护者还没被告知暂缓合并。");
    expect(again.text).not.toContain("它上一次发给主人的通知（");
    await d.kernel.idle();
  });

  // uc44: under 以后再说 the parked project's row read "🟢 Agent 处理中" with nothing running.
  it("a parked project's radar row has no ball in play; an active one keeps it", async () => {
    const d = await bootRealDesk();
    const p = makeProject(d.kernel, "语音转写");
    d.script.add("project", tool("track_action", { title: "实现文本确认流程", owner: "agent" }), { text: "记下了" });
    await ok(d, "message_project", { id: p, text: "开始做" });
    await d.kernel.idle();
    const live = (await d.get<RadarDTO>("/api/radar")).projects.find((r) => r.id === p)!;
    expect(live.ball).toMatchObject({ owner: "agent" });
    await ok(d, "set_project_state", { id: p, state: "someday", note: "先放一放" });
    const parked = (await d.get<RadarDTO>("/api/radar")).someday.find((r) => r.id === p)!;
    expect(parked.ball).toBeNull();
    expect(parked.pausedText).toContain("放进以后再说");
  });
});

describe("live rerun round 4 (uc41): a source that keeps finding the same failure does not read as cleared", () => {
  // Original condition: the second check found the same failure (reported once, by design) and list_sources said
  // "运行正常；跑了 2 次，命中 1 次" — the owner was told "最近一次运行正常".
  it("list_sources and the sources view say that the last check still hit and how often the same result came again", async () => {
    const d = await bootRealDesk();
    const dir = tempDir("checks-r4");
    const path = join(dir, "ci.mjs");
    writeFileSync(path, `console.log("main 分支 CI 红了")\n`);
    const { sensorId } = (await ok<{ sensorId: string }>(d, "create_source", { title: "CI 巡检", cron: "0 9 * * *", checkKind: "script", scriptPath: path })).data;
    await ok(d, "control_cell", { id: sensorId, action: "trigger" });
    await d.kernel.idle();
    const first = await ok(d, "list_sources");
    expect(first.text).toContain("跑了 1 次，记下或报出 1 次（结果不变时不重复）");
    expect(first.text).toContain("上次检查仍然命中");
    expect(first.text).not.toContain("运行正常");

    d.clock.advance(MIN);
    await ok(d, "control_cell", { id: sensorId, action: "trigger" });
    await d.kernel.idle();
    const second = await ok(d, "list_sources");
    expect(second.text).toContain("跑了 2 次，记下或报出 1 次");
    expect(second.text).toContain("上次检查仍然命中（同样的结果又出现 1 次，没有重复上报）");
    const row = (await d.get<{ sensors: Array<{ id: string; stillHitting: boolean; repeats: number; statusLabel: string }> }>("/api/sources")).sensors.find((x) => x.id === sensorId)!;
    expect(row).toMatchObject({ stillHitting: true, repeats: 1, statusLabel: "检查照常运行" });

    // The condition goes away: the next check says so.
    writeFileSync(path, "\n");
    d.clock.advance(MIN);
    await ok(d, "control_cell", { id: sensorId, action: "trigger" });
    await d.kernel.idle();
    expect((await ok(d, "list_sources")).text).toContain("上次检查没有命中");
  });
});

describe("live rerun round 4 (uc43): a relay can bring the project's answer back", () => {
  // Original condition: the owner answered the project's request through their agent; the project replied in its turn
  // "还需要之前提到的流水线与环境入口资料" and waited again — the agent had told the owner the project would go on.
  it("message_project with waitSeconds returns what the project said in that turn, or its notice; without it, only that the words were passed on", async () => {
    const d = await bootRealDesk();
    const p = makeProject(d.kernel, "上线手册");
    d.script.add("project", { text: "收到，但还需要之前提到的流水线与环境入口资料才能写完。" });
    const r = await ok<{ stillWorking: boolean; reply: string | null }>(d, "message_project", { id: p, text: "部署就是合并到 main 后由 CI 发布", waitSeconds: 5 });
    expect(r.text).toContain("它这一回合的答复（没有发通知，主人没看到）：收到，但还需要之前提到的流水线与环境入口资料才能写完。");
    expect(r.data).toMatchObject({ stillWorking: false, reply: "收到，但还需要之前提到的流水线与环境入口资料才能写完。" });

    // A notice sent in that turn is the answer.
    d.script.add("project", tool("send_message", { to: "channel:ui:owner", text: "手册按合并到 main 后由 CI 发布来写，今天给你。", summary: "安排" }), { text: "已告知主人，开始写手册。" });
    const n = await ok(d, "message_project", { id: p, text: "部署环境不用管", waitSeconds: 5 });
    expect(n.text).toContain("它这一回合发给主人的通知：手册按合并到 main 后由 CI 发布来写，今天给你。");
    expect(n.text).not.toContain("它这一回合的答复");

    // Round 9 (uc92): the wait is honoured with urgent too.
    d.script.add("project", tool("send_message", { to: "channel:ui:owner", text: "维护者还没有被告知暂缓合并，MR 仍可能被合入。", summary: "提醒" }), { text: "OK" });
    const urgent = await ok(d, "message_project", { id: p, text: "先别急着合", urgent: true, waitSeconds: 5 });
    expect(urgent.text).toContain("它这一回合发给主人的通知：维护者还没有被告知暂缓合并，MR 仍可能被合入。");

    // Without waiting the answer is the plain receipt.
    d.script.add("project", { text: "好的，这一条已经记下了。" });
    const plain = await ok(d, "message_project", { id: p, text: "标题用中文" });
    expect(plain.text).toContain("so far only passed on");
    expect(plain.text).not.toContain("它这一回合的答复");
    await d.kernel.idle();
  });
});

describe("live rerun rounds 3–4 (uc06): what the desk told the owner by itself reaches their agent", () => {
  // Round 3: the desk's answer to a request a hub had handed back was found by the agent only by searching for it.
  it("workbench_overview lists the desk's unprompted words of the past day; being a read, it changes nothing and lists them again", async () => {
    const d = await bootRealDesk();
    const SECTION = "主台最近对主人说的";
    // An answer the agent gets through chat_with_desk is in its hands already.
    d.script.add("desk", { text: "已经记下周五的提醒了，到时会出现在待我处理里。" });
    await ok(d, "chat_with_desk", { text: "周五提醒我联系牙医", waitSeconds: 5 });
    expect((await ok(d, "workbench_overview")).text).not.toContain(SECTION);

    // The owner asks in the web view and reads the answer there.
    d.script.add("desk", { text: "网页上问的这件事已经处理好了，不需要再转告。" });
    await d.post("/api/capture", { text: "帮我看下今天的安排" });
    await d.kernel.idle();
    expect((await ok(d, "workbench_overview")).text).not.toContain(SECTION);

    // Something comes back to the desk by itself (a cell hands a request back) and the desk answers the owner.
    d.clock.advance(MIN);
    d.script.add("desk", { text: "订盒饭这件事我这边办不了，午饭需要你自己下单。" });
    d.kernel.sendToCell("desk", { text: "订盒饭与评审无关，交回主台", summary: "交回" }, { principalId: "cell:hub_review" });
    await d.kernel.idle();
    const o = await ok(d, "workbench_overview");
    expect(o.text).toContain(SECTION);
    expect(o.text).toContain("订盒饭这件事我这边办不了，午饭需要你自己下单。");
    expect(o.text).not.toContain("已经记下周五的提醒了");
    expect(o.text).not.toContain("不需要再转告");
    // A retry or a second session of the agent gets the same; nothing was written for it.
    const before = JSON.stringify(d.kernel.context.listStateSync("desk", ""));
    const seq = d.kernel.context.lastEvidenceSeqSync("desk");
    expect((await ok(d, "workbench_overview")).text).toBe(o.text);
    expect(JSON.stringify(d.kernel.context.listStateSync("desk", ""))).toBe(before);
    expect(d.kernel.context.lastEvidenceSeqSync("desk")).toBe(seq);
    // A day later it is no news any more.
    d.clock.advance(25 * 60 * MIN);
    expect((await ok(d, "workbench_overview")).text).not.toContain(SECTION);
  });

  // Live round 11 (uc01): the owner's message had scrolled out of the items that were read, and the desk's answer to it
  // was listed as unprompted. Who started a turn is read from what that turn was given.
  it("an answer stays an answer wherever the items that are read begin", async () => {
    const d = await bootRealDesk();
    d.script.add("desk", tool("remind_me", { text: "给绿植浇水", inMinutes: 8 }), { text: "已设好今天 12:15 给绿植浇水的提醒。" });
    await ok(d, "chat_with_desk", { text: "12:15 提醒我给绿植浇水", waitSeconds: 5 });
    // Enough turns, all of them answers, for any reading window to begin inside the first one at some point.
    for (let i = 0; i < 24; i++) {
      d.script.add("desk", { text: `第 ${i} 个问题的回答。` });
      await d.post("/api/capture", { text: `第 ${i} 个问题` });
      await d.kernel.idle();
      expect((await ok(d, "workbench_overview")).text, `after ${i + 1} more turns`).not.toContain("主台最近对主人说的");
    }
  });

  // Live round 12 (uc01): the correction an undo sends is from the kernel on the owner's doing: it is no word of theirs.
  it("a turn that the owner's undo started is not one they spoke in", async () => {
    const d = await bootRealDesk();
    d.script.add("desk", { text: "已按撤销更正：构建日志仍待提供。" });
    d.kernel.inbox.enqueueSync("desk", createEnvelope({
      id: "act:undo:correction", from: KERNEL_FROM.control, principalId: d.kernel.ownerPrincipal, kind: "event", type: PAYLOAD.cellMessage,
      expectedEpoch: d.kernel.getCell("desk")!.epoch, payload: { fromCellId: "desk", text: "主人已撤回对事项的决定。请核实现状并更正。" } }, d.clock));
    await d.kernel.idle();
    expect((await ok(d, "workbench_overview")).text).toContain("已按撤销更正：构建日志仍待提供。");
    const items = (await d.get<CellTimelineDTO>("/api/cells/desk/timeline")).items;
    expect(items.find((i) => "text" in i && String(i.text).startsWith("主人已撤回"))).toMatchObject({ kind: "system_event" });
  });

  // Live round 13 (uc01): a card raised in that turn quoted the correction as the owner's message.
  it("a card the desk raises after an undo does not quote the correction as the owner's words", async () => {
    const d = await bootRealDesk();
    d.script.add("desk", tool("request_approval", { kind: "escalation", title: "夜间报告排查如何继续", summary: "接下来怎么处理？", subjectKey: "undo:x", escalation: { reason: "blocked", explanation: "你撤回了决定" }, options: [{ id: "ok", label: "知道了", effect: "reply" }] }));
    d.kernel.inbox.enqueueSync("desk", createEnvelope({
      id: "act:undo:card", from: KERNEL_FROM.control, principalId: d.kernel.ownerPrincipal, kind: "event", type: PAYLOAD.cellMessage,
      expectedEpoch: d.kernel.getCell("desk")!.epoch, payload: { fromCellId: "desk", text: "主人已撤回对事项的决定。请核实现状并更正。" } }, d.clock));
    await d.kernel.idle();
    const item = (await ok<{ items: HumanItemDTO[] }>(d, "list_human_items")).data.items.find((i) => i.title === "夜间报告排查如何继续")!;
    expect(JSON.stringify(item)).not.toContain("主人已撤回对事项");
    expect(JSON.stringify(item)).not.toContain('"对话"');
  });

  // Live round 11 (uc05): the desk's notice in a turn a worker's result had started was left out, folded into the owner's
  // earlier message.
  it("a notice the desk sends in a turn that a cell's result started is listed, in place of that turn's closing words", async () => {
    const d = await bootRealDesk();
    d.script.add("desk", { text: "好的，我让分身修。" });
    await d.post("/api/capture", { text: "修一下公共 CI" });
    await d.kernel.idle();
    const { cellId } = (await ok<{ cellId: string }>(d, "spawn_cell", { preset: "worker", title: "修共享 CI", instruction: "修好 CI" })).data;
    d.script.add("worker", { text: "已修好，在分支 fix/ci。" });
    d.script.add("desk", tool("send_message", { to: "channel:ui:owner", text: "公共 CI 已修好，在分支 fix/ci，等你合入。", summary: "CI" }), { text: "已通知主人。" });
    await d.kernel.idle();
    expect(d.kernel.getCell(cellId)).toBeDefined();
    const o = (await ok(d, "workbench_overview")).text;
    const said = o.slice(o.indexOf("主台最近对主人说的"));
    expect(said).toContain("公共 CI 已修好，在分支 fix/ci，等你合入。");
    expect(said.slice(0, said.indexOf("\n\n"))).not.toContain("已通知主人。");
    expect(said.slice(0, said.indexOf("\n\n"))).not.toContain("好的，我让分身修。");
  });
});

describe("live round 11 (uc03, uc06): a worker that is spoken to after it has reported", () => {
  it("its report comes first in the overview's latest result; the timeline gives its last words, and the report as what came before", async () => {
    const d = await bootRealDesk();
    d.script.add(
      "worker",
      () => {
        const worker = d.kernel.listCells({ parentId: "desk" }).find((c) => c.preset === "worker")!;
        d.kernel.sendToCell(worker.id, { text: "新桶为空算缺陷吗？" }, { principalId: d.kernel.ownerPrincipal });
        return { text: "评审完成：建议暂缓合并，有 2 个阻塞问题。" };
      },
      { text: "新桶为空不一定是缺陷。" },
    );
    d.script.add("desk", {});
    const { cellId } = (await ok<{ cellId: string }>(d, "spawn_cell", { preset: "worker", title: "评审 MR", instruction: "评审" })).data;
    await d.kernel.idle();
    expect((await ok(d, "workbench_overview")).text).toContain(`${cellId}「评审 MR」（worker，待命可唤醒） — 最近结果：评审完成：建议暂缓合并，有 2 个阻塞问题。；之后又说：新桶为空不一定是缺陷。`);
    const line = (await d.get<CellTimelineDTO>("/api/cells/desk/timeline")).items.find((i) => i.kind === "milestone" && i.text.includes("这一轮结束"));
    expect(line).toMatchObject({ text: "分身「评审 MR」这一轮结束：新桶为空不一定是缺陷。（再次收到消息之前报告过：评审完成：建议暂缓合并，有 2 个阻塞问题。）" });
  });
});

describe("live rerun round 5 (uc51): the desk's notes list a reminder set with remind_me before it is due", () => {
  // The production path: remind_me schedules a timer for the desk; the item in 待我处理 appears only when it fires.
  it("after remind_me, the desk's next wake-up lists the reminder among its timers; the overview lists it as upcoming", async () => {
    const d = await bootRealDesk();
    d.script.add("desk", tool("remind_me", { text: "联系牙医", inMinutes: 3 * 24 * 60 }), { text: "周五上午的提醒设好了。" });
    await d.post("/api/capture", { text: "周五提醒我联系牙医" });
    await d.kernel.idle();
    let seen = "";
    d.script.add("desk", (req: unknown) => {
      seen = JSON.stringify(req);
      return { text: "设好了，周五的那条还没到点。" };
    });
    await d.post("/api/capture", { text: "提醒都设好了吗？" });
    await d.kernel.idle();
    expect(seen).toContain("your timers that have not fired yet");
    expect(seen).toContain("提醒：联系牙医");
    expect((await ok(d, "workbench_overview")).text).toContain("已设好、还没到点的提醒");
  });
});

describe("live rerun round 5 (uc53, uc54): what the desk did in the turn comes back with chat_with_desk", () => {
  // The desk raised a plan card (which ends its turn without a word) — and the agent told the owner "工作台尚未返回方案".
  it("a card the desk raised in that turn is named as its answer; a notice it sent is quoted; a bare OK is not a reply to relay", async () => {
    const d = await bootRealDesk();
    d.script.add("desk", tool("propose_project", { title: "权限上线手册", outcome: "写出上线手册", actions: [{ title: "写手册", owner: "agent" }] }));
    const card = await ok(d, "chat_with_desk", { text: "先出方案：写一份权限上线手册", waitSeconds: 5 });
    expect(card.text).toContain("Cards of the desk waiting for the owner, raised since");
    expect(card.text).toContain("「权限上线手册」（立项方案）");

    expect(card.text).not.toContain("without a written reply");

    // start_project tells the owner by notice and the desk closes its turn with a bare "OK".
    d.clock.advance(MIN);
    const dir = tempDir("uc53-repo");
    d.script.add("desk", tool("start_project", { title: "对比报告", outcome: "写出对比报告", brief: "主人说：「写一份对比报告」", cwd: dir }), { text: "OK" });
    const started = await ok(d, "chat_with_desk", { text: "写一份对比报告", waitSeconds: 5 });
    expect(started.text).toContain("Notices the desk sent the owner since:");
    // Only what was raised since: the plan card from before is not named again.
    expect(started.text).not.toContain("Cards of the desk");
    expect(started.text).toContain("已立项：对比报告");
    expect(started.text).not.toMatch(/\[r\d+\] OK/);

    // Round 6 (uc62): the usual turn — a line in the chat first, then the tool that starts the project. The notice
    // still comes back, beside the chat line.
    const dir2 = tempDir("uc62-repo");
    d.script.add("desk", { text: "收到，我会按这个仓库安排修复。", toolCalls: [{ name: "start_project", input: { title: "修复表格复制", outcome: "复制为纯文本", brief: "主人说：「修复表格复制」", cwd: dir2 } }] }, { text: "好。" });
    const usual = await ok(d, "chat_with_desk", { text: "在这个仓库修表格复制", waitSeconds: 5 });
    expect(usual.text).toContain("收到，我会按这个仓库安排修复。");
    expect(usual.text).toContain("may be older than these):");
    expect(usual.text).toContain("已立项：修复表格复制");
    expect(usual.text).not.toContain("] 好。");
  });
});

describe("live rerun round 5 (uc57): a plan edit that loses part of the request is pointed out", () => {
  // Original condition: the agent replaced the plan's background with the owner's edit instruction alone ("改成只做一个
  // to_json(line)") and dropped the step "保留现有 parse 调用方式"; the worker read it as "replace parse" and removed it.
  it("save_plan names the steps that are gone and says that the background was replaced, and where the earlier one is", async () => {
    const d = await bootRealDesk();
    const background = "主人的要求：「给 log-tool 加 JSON 输出」。现有的 parse(line) 被其他脚本调用，调用方式必须保持不变；新功能只读取一行日志并输出一个 JSON 对象。";
    const card = await proposed(d, { title: "log-tool 增加 JSON 输出", outcome: "log-tool 能输出 JSON", background, actions: [{ title: "保留现有 parse 调用方式", owner: "agent" }, { title: "新增 JSON 输出入口", owner: "agent" }] });
    const r = await ok(d, "save_plan", { id: card.id, expectedVersion: 1, outcome: "只做一个 to_json(line)", background: "改成只做一个 to_json(line)", actions: [{ title: "实现 to_json(line)", owner: "agent" }] });
    expect(r.text).toContain("Steps of v1 that are gone or reworded: 「保留现有 parse 调用方式」、「新增 JSON 输出入口」");
    expect(r.text).toContain(`Its background was replaced (${background.length} → ${"改成只做一个 to_json(line)".length} characters; the earlier one: read_artifact version 1)`);

    // A change that keeps the steps and leaves the background alone says nothing of the kind.
    const again = await ok(d, "save_plan", { id: card.id, expectedVersion: 2, outcome: "只做一个 to_json(line)", actions: [{ title: "实现 to_json(line)", owner: "agent" }] });
    expect(again.text).not.toContain("gone or reworded");
    expect(again.text).not.toContain("background was replaced");
  });

  it("chat_with_desk without text says the desk is at rest with a card before the owner, not that it answers in the background", async () => {
    const d = await bootRealDesk();
    await proposed(d, { title: "导出功能", outcome: "notes-cli 能导出", actions: [{ title: "写导出", owner: "agent" }] });
    const r = await ok(d, "chat_with_desk", { since: d.kernel.context.lastEvidenceSeqSync("desk") });
    expect(r.text).toContain("Nothing new from the desk after #");
    expect(r.text).toContain("Cards of the desk waiting for the owner (list_human_items has the options):");
    expect(r.text).toContain("「导出功能」");
    expect(r.text).not.toContain("answers in the background");
  });
});

describe("live rerun round 6 (uc65): recording an acceptance says where the delivery sits", () => {
  // Original condition: "三件我都验收了…我还要做什么吗" — the agent recorded the acceptances while the projects were
  // still open (not yet under 24 小时内结束的项目), and nothing it had in hand said that two branches were unmerged.
  it("decide_human_item on a project's item comes back with what the project last told the owner", async () => {
    const d = await bootRealDesk();
    const p = makeProject(d.kernel, "改重试上限");
    // Long enough that the end — who merges — used to be cut (live round 11, uc07).
    const delivery = `改动在分支 fix/max-retry-3，main 未改动。${"已核对测试与文档。".repeat(60)}合并由维护者按 README 进行。`;
    d.kernel.hub.notifyOwner({ cellId: p, content: { format: "text", body: delivery }, idempotencyKey: "delivery" });
    d.clock.advance(MIN);
    d.kernel.hub.notifyOwner({ cellId: p, content: { format: "text", body: "重跑的 soak 也通过了。" }, idempotencyKey: "rerun" });
    const { actionId } = (await ok<{ actionId: string }>(d, "add_action", { projectId: p, title: "验收：重试上限改为 3", owner: "human" })).data;
    const item = (await ok<{ items: HumanItemDTO[] }>(d, "list_human_items")).data.items.find((i) => i.id === actionId)!;
    const r = await ok(d, "decide_human_item", { id: actionId, optionId: "done", seenItemRevision: item.itemRevision, note: "pay-core 验收了" });
    expect(r.text).toContain("这个项目最近发给主人的通知（");
    expect(r.text).toContain(delivery);
    // Round 8 (uc87): also when a later follow-up notice says nothing about the branch — the delivery notice before
    // it is still in the receipt.
    expect(r.text).toContain("重跑的 soak 也通过了。");
    await d.kernel.idle();
  });
});

describe("live rerun round 6 (uc68): a project's opening line is not an unsent answer once it has reported", () => {
  // Original condition: after a reopen the project said "我会把最大重试次数改回 5 次…", did the work and sent the
  // delivery notice — and get_project still offered that opening line as "主人没看到，转告一次", even after it closed.
  it("get_project drops the 'said back' section when the project has told the owner by notice since, or has closed", async () => {
    const d = await bootRealDesk();
    const SAID = "它对主人上一句话的答复";
    const p = makeProject(d.kernel, "调整重试");
    d.script.add("project", { text: "我会把最大重试次数改回 5 次，并同步检查测试和文档。" });
    await ok(d, "message_project", { id: p, text: "把重试改回 5 次" });
    await d.kernel.idle();
    expect((await ok(d, "get_project", { id: p })).text).toContain(SAID);

    // The work is delivered a few minutes later (after a worker's result, not in the turn that took the words).
    d.clock.advance(3 * MIN);
    d.kernel.hub.notifyOwner({ cellId: p, content: { format: "text", body: "重试已改回 5 次，提交在分支 retry-five，main 未改动。" }, idempotencyKey: "delivered" });
    const after = await ok(d, "get_project", { id: p });
    expect(after.text).not.toContain(SAID);
    expect(after.text).toContain("重试已改回 5 次");
  });
});

describe("live rerun round 6 (uc63): a relay the project takes in without a word says what it did", () => {
  // Original condition: on the owner's relayed answer the project withdrew its request for material and sent the
  // worker on, saying nothing; the agent, left with the earlier notice, told the owner to provide the material.
  it("message_project with waitSeconds names what the project did in that turn and what it still has open for the owner", async () => {
    const d = await bootRealDesk();
    const p = makeProject(d.kernel, "上线手册");
    const { actionId } = (await ok<{ actionId: string }>(d, "add_action", { projectId: p, title: "提供预发实际工程的位置", owner: "human" })).data;
    await d.kernel.idle();
    d.script.add("project", tool("track_action", { id: actionId, status: "cancelled" }), { text: "OK" });
    const r = await ok(d, "message_project", { id: p, text: "部署就是合并到 main 后由 CI 发布，不用别的资料", waitSeconds: 5 });
    expect(r.text).toContain("It has taken them in without a word for the owner.");
    expect(r.text).toMatch(/它这一回合做了：[^\n]*记录行动/);
    expect(r.text).toContain("它现在等主人的事项：没有");
    expect(r.text).not.toContain("它上一次发给主人的通知");
  });
});

describe("live rerun rounds 6–7 (uc61, uc71): a changed source result replaces the earlier one — and only then says so", () => {
  // Round 6: a second, different hit was added to the first on the card ("两项失败"). Round 7: the note that prevents
  // that was also put on the first report after observe mode, where there was no earlier report to replace.
  it("the note about replacing the earlier report is on a changed result only, not on the first report or after a clean check", async () => {
    const d = await bootRealDesk();
    const dir = tempDir("checks-r7");
    const path = join(dir, "ci.mjs");
    const say = (line: string) => writeFileSync(path, line ? `console.log(${JSON.stringify(line)})\n` : "\n");
    const NOTE = "取代这个信源上一次报的内容";
    const hits = () => d.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.sourceHit, status: ["pending", "claimed", "done"] }).map((m) => (m.envelope.payload as { summary: string }).summary);
    say("quasar-bridge link 失败");
    const { sensorId } = (await ok<{ sensorId: string }>(d, "create_source", { title: "夜间报告", cron: "0 3 * * *", checkKind: "script", scriptPath: path, mode: "observe" })).data;
    const trigger = async () => {
      d.clock.advance(MIN);
      await ok(d, "control_cell", { id: sensorId, action: "trigger" });
      await d.kernel.idle();
    };
    await trigger(); // observed only: a note, no report
    expect(hits()).toHaveLength(0);
    await ok(d, "manage_source", { id: sensorId, action: "set_mode", mode: "active" });
    await trigger(); // the first report
    expect(hits()).toHaveLength(1);
    expect(hits()[0]).not.toContain(NOTE);
    say("orbit-cache tests 失败");
    await trigger(); // a changed result: it replaces the one reported before
    expect(hits()).toHaveLength(2);
    expect(hits()[1]).toContain(NOTE);
    say("");
    await trigger(); // nothing found
    say("quasar-bridge link 失败");
    await trigger(); // news again, replacing nothing
    expect(hits()).toHaveLength(3);
    expect(hits()[2]).not.toContain(NOTE);
  });
});

describe("live rerun rounds 6–8 (uc64, uc74, uc76, uc82, uc84): what counts as a cell's open question to the owner", () => {
  // Rounds 6–8 tried to tell from a notice's wording whether it asks the owner something: requests were missed, a
  // hub's statement and a delivery report were listed, and a request stood beside the item that already carried it.
  // The rule that holds: a cell that waits for the owner and has nothing of its own on their list is asking with its
  // last words to them; with an item open, the item is the entry.
  it("a cell waiting for the owner with no item of its own is listed with its last words to them, whatever they end with", async () => {
    const d = await bootRealDesk();
    const q = makeProject(d.kernel, "录音环境");
    const req = "真实录音还未做。请告诉我录音要在哪个环境运行，供验证。";
    d.script.add("project", tool("send_message", { to: "channel:ui:owner", text: req, summary: "需要确认" }), tool("wait", { waitingFor: "human", reason: "等主人答复" }));
    await ok(d, "message_project", { id: q, text: "继续" });
    await d.kernel.idle();
    expect((await d.get<HumanItemsResponse>("/api/human-items")).questions).toEqual([expect.objectContaining({ cellId: q, text: req, stopped: false })]);
    expect((await d.get<StatusDTO>("/api/status")).humanQuestions).toBe(1);

    // Parked, it is still listed — marked as needing no answer for now.
    await ok(d, "set_project_state", { id: q, state: "someday", note: "先放一放" });
    expect((await d.get<HumanItemsResponse>("/api/human-items")).questions).toEqual([expect.objectContaining({ cellId: q, stopped: true })]);
    expect((await ok(d, "workbench_overview")).text).toContain("在问主人（它已停靠或暂停，这一项暂时不用答）");
    // … and so it is not counted among what waits for the owner.
    expect(await d.get<StatusDTO>("/api/status")).toMatchObject({ humanQuestions: 0, humanPending: 0 });
  });

  it("with an item of its own open, the item is the entry: its notice is not listed a second time as a question", async () => {
    const d = await bootRealDesk();
    const p = makeProject(d.kernel, "语音记笔记");
    d.script.add(
      "project",
      tool("track_action", { title: "提供可录音的环境", owner: "human", nextStep: "请告诉我语音功能在哪台机器上运行、是否已有麦克风" }),
      tool("send_message", { to: "channel:ui:owner", text: "文本流程已完成。语音功能要在哪台机器上运行？是否已有可用的麦克风？你此前要求不装包，我会继续遵守。", summary: "需要确认" }),
      tool("wait", { waitingFor: "human", reason: "等主人确认运行环境" }),
    );
    await ok(d, "message_project", { id: p, text: "现在开始，录音那段也做" });
    await d.kernel.idle();
    const items = await d.get<HumanItemsResponse>("/api/human-items");
    expect(items.items.map((i) => i.title)).toEqual(["提供可录音的环境"]);
    expect(items.questions).toEqual([]);
    expect((await d.get<StatusDTO>("/api/status")).humanPending).toBe(1);
  });

  // Round 9 (uc94, read from the source): the same when the notice ends in a question mark.
  it("with an item open, a notice that ends in a question mark is not listed beside it either", async () => {
    const d = await bootRealDesk();
    const p = makeProject(d.kernel, "语音记笔记");
    d.script.add(
      "project",
      tool("track_action", { title: "答复：现在开始做录音吗", owner: "human", nextStep: "回复开始或者先不做" }),
      tool("send_message", { to: "channel:ui:owner", text: "文本流程已完成。录音部分现在开始吗？", summary: "需要确认" }),
      tool("wait", { waitingFor: "human", reason: "等主人答复" }),
    );
    await ok(d, "message_project", { id: p, text: "先做文本流程" });
    await d.kernel.idle();
    const items = await d.get<HumanItemsResponse>("/api/human-items");
    expect(items.items.map((i) => i.title)).toEqual(["答复：现在开始做录音吗"]);
    expect(items.questions).toEqual([]);
    expect((await d.get<StatusDTO>("/api/status")).humanPending).toBe(1);
  });

  it("a statement that merely contains question words is no question when the cell is not waiting for the owner", async () => {
    const d = await bootRealDesk();
    const p = makeProject(d.kernel, "评审专题");
    d.script.add("project", tool("send_message", { to: "channel:ui:owner", text: "我会请原评审分身一并复核 tokens 封顶方案，以及 README 是否需要补充限流说明。", summary: "安排" }), { text: "OK" });
    await ok(d, "message_project", { id: p, text: "README 要不要补限流说明" });
    await d.kernel.idle();
    expect((await d.get<HumanItemsResponse>("/api/human-items")).questions).toEqual([]);
    expect((await d.get<StatusDTO>("/api/status")).humanQuestions).toBe(0);
  });
});
