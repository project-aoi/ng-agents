// The 2026-11-23 end-to-end audit (docs/03-bugs/audits/2026-11-23-codex-e2e-workflows.md), control-plane side: the
// external agent relays and the owner decides (E02, E26), it sees what waits on the owner (E08, E27) and what a source
// found (E19), it can change a plan's stages (E17), each of its sessions is its own conversation (E35), the words that
// come with a pause are passed on (E05), and the workbench's own cells get none of the owner's tools (E01).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBSERVATION_NOTE, projectIdForApproval } from "@ng/presets";
import { CELL_STATUS_KEY, PAYLOAD, type ProjectProposal } from "@ng/protocol";
import { AGENT_INSTRUCTIONS, AGENT_TOOLS } from "../src/agent/guide";
import { CONVERSATION_HEADER, type AgentToolResult } from "../src/agent/routes";
import type { HumanItemDTO } from "../src/shared/api";
import { bootDesk, bootRealDesk, cleanupAll, makeProject, makeReviewCard, requestsOf, tempDir, tool, type TestDesk } from "./helpers";

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
    expect(prop("create_project", "brief")?.description).toContain("never \"主人要求\"");
    expect(prop("set_project_state", "note")?.description).toContain("Not your summary");
    expect(prop("decide_human_item", "note")?.description).toContain("Not your own additions");
    expect(doc("decide_human_item").description).toContain("passages marked for the owner to decide");
    expect(doc("decide_human_item").description).toContain("do not also send it with message_project or message_cell");
    expect(doc("message_cell").description).toContain('text "把上限改成 3"');
  });

  it("the server instructions are a few lines that hold without the skill; the detail is in the skill (E24)", () => {
    expect(AGENT_INSTRUCTIONS.length).toBeLessThan(1_200);
    expect(AGENT_INSTRUCTIONS).toContain("ng-desk skill");
    expect(AGENT_INSTRUCTIONS).toContain("Never answer or approve on their behalf");
    expect(AGENT_INSTRUCTIONS).toContain("`context`");
    // What a client lists: 36 tools without the instructions repeated under each.
    expect(AGENT_TOOLS).toHaveLength(36);
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
    expect(slow.text).toContain("No reply from the desk within 0.2 s");
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
    expect(JSON.stringify(task!.envelope.payload)).toContain("放进以后再说时主人（经主 Agent）的话：等我换了麦克风再说");
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
