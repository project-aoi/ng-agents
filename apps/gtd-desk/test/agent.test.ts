// docs/05 §5.3 — the external main agent's control plane: `/api/agent/*` (and the MCP stdio server that proxies to it)
// with its own `agent:<id>` identity. The auth matrix on HTTP requests through the app, every tool against the
// scripted kernel, the owner-only refusals, and one end-to-end MCP session.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isNgError, gtdKeys, type ActionRecord, type ProjectRecord, type UserMessagePayload } from "@ng/protocol";
import { AGENT_INSTRUCTIONS, AGENT_SERVER_NAME, AGENT_TOOLS } from "../src/agent/guide";
import type { AgentToolResult } from "../src/agent/routes";
import { bootDesk, bootRealDesk, cellMessages, cleanupAll, requestText, requestsOf, tempDir, tool, writeAction, type TestDesk } from "./helpers";

afterEach(cleanupAll);

const OWNER_TOKEN = "owner-token-0123456789abcdef";
const AGENT_TOKEN = "agent-token-0123456789abcdef";
const OTHER_AGENT = "other-agent-token-0123456789";
const BIN = fileURLToPath(new URL("../bin/ng-mcp.mjs", import.meta.url));

async function call(d: TestDesk, name: string, args: Record<string, unknown> = {}, token: string | null = AGENT_TOKEN) {
  return d.req<AgentToolResult>("POST", `/api/agent/tools/${name}`, args, token ? { authorization: `Bearer ${token}` } : {});
}

/** A tool call that must succeed (HTTP 200, not isError). */
async function ok(d: TestDesk, name: string, args: Record<string, unknown> = {}, token: string | null = AGENT_TOKEN): Promise<AgentToolResult> {
  const r = await call(d, name, args, token);
  expect(r.status, `${name} → HTTP ${r.status}`).toBe(200);
  expect(r.json.isError, `${name}: ${r.json.text}`).toBeFalsy();
  return r.json;
}

async function refused(d: TestDesk, name: string, args: Record<string, unknown> = {}): Promise<AgentToolResult> {
  const r = await call(d, name, args);
  expect(r.status).toBe(200);
  expect(r.json.isError, r.json.text).toBe(true);
  return r.json;
}

const texts = (d: TestDesk, cellId: string) => cellMessages(d.kernel, cellId).map((e) => ({ text: (e.payload as { text: string }).text, principalId: e.principalId }));

describe("auth: a separate credential and a separate identity", () => {
  it("with tokens configured: the agent token acts as agent:<id>; the owner token, an unknown token or none are refused; the agent token opens nothing else", async () => {
    const d = await bootDesk({ host: "0.0.0.0", token: OWNER_TOKEN, agentTokens: { main: AGENT_TOKEN, ops: OTHER_AGENT } });
    const capture = await call(d, "capture", { text: "记一下：周五交周报" });
    expect(capture.status).toBe(200);
    const [msg] = d.kernel.inbox.listMessagesSync({ cellId: "desk", type: "user.message" });
    expect(msg!.envelope.principalId).toBe("agent:main");
    await call(d, "capture", { text: "另一个 agent 的" }, OTHER_AGENT);
    expect(d.kernel.inbox.listMessagesSync({ cellId: "desk", type: "user.message" }).map((m) => m.envelope.principalId)).toEqual(["agent:main", "agent:ops"]);

    const owner = await call(d, "workbench_overview", {}, OWNER_TOKEN);
    expect(owner.status).toBe(401);
    expect(JSON.stringify(owner.json)).toContain("owner's token is not accepted");
    expect((await call(d, "workbench_overview", {}, "unknown-token-0123456789abcdef")).status).toBe(401);
    expect((await call(d, "workbench_overview", {}, null)).status).toBe(401);
    expect((await d.req("GET", "/api/agent/tools")).status).toBe(401);
    expect((await d.req("GET", "/api/agent/tools", undefined, { authorization: `Bearer ${AGENT_TOKEN}` })).status).toBe(200);
    // the agent's credential is not the owner's: the rest of the API stays closed to it
    for (const path of ["/api/clarify", "/api/status", "/api/radar"]) {
      expect((await d.req("GET", path, undefined, { authorization: `Bearer ${AGENT_TOKEN}` })).status, path).toBe(401);
    }
    expect((await d.req("POST", "/api/capture", { text: "x" }, { authorization: `Bearer ${AGENT_TOKEN}` })).status).toBe(401);
    expect((await d.req("GET", "/api/clarify", undefined, { authorization: `Bearer ${OWNER_TOKEN}` })).status).toBe(200);
  });

  it("token-less on a loopback bind without any token: agent:local, never the owner", async () => {
    const d = await bootDesk();
    await ok(d, "capture", { text: "记一下：买牛奶" }, null);
    const [msg] = d.kernel.inbox.listMessagesSync({ cellId: "desk", type: "user.message" });
    expect(msg!.envelope).toMatchObject({ principalId: "agent:local", from: "channel:ui:owner", payload: { text: "记一下：买牛奶" } });
  });

  it("token-less is refused once agent tokens exist, and on a non-loopback bind (which needs the owner's token anyway)", async () => {
    const loop = await bootDesk({ agentTokens: { main: AGENT_TOKEN } });
    expect((await call(loop, "workbench_overview", {}, null)).status).toBe(401);
    expect((await call(loop, "workbench_overview", {})).status).toBe(200);
    const wide = await bootDesk({ host: "0.0.0.0", token: OWNER_TOKEN });
    const r = await call(wide, "workbench_overview", {}, null);
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.json)).toContain("agent token is required");
  });

  it("lists the tools of guide.ts with the server instructions", async () => {
    const d = await bootDesk({ agentTokens: { main: AGENT_TOKEN } });
    const r = await d.req<{ server: string; instructions: string; tools: Array<{ name: string }> }>("GET", "/api/agent/tools", undefined, { authorization: `Bearer ${AGENT_TOKEN}` });
    expect(r.json).toMatchObject({ server: AGENT_SERVER_NAME, instructions: AGENT_INSTRUCTIONS });
    expect(r.json.tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name));
  });
});

// ==================== the tools ====================

describe("tools", () => {
  it("unknown tools and invalid arguments are answers, not errors", async () => {
    const d = await bootDesk({ agentTokens: { main: AGENT_TOKEN } });
    expect((await refused(d, "delete_everything")).text).toContain('Unknown tool "delete_everything"');
    expect((await refused(d, "create_project", { title: "x" })).text).toMatch(/"outcome" is required; "brief" is required/);
    expect((await refused(d, "set_project_state", { id: "p", state: "archive" })).text).toContain('"state" must be one of "pause", "resume", "someday", "activate", "complete", "cancel"');
    expect((await refused(d, "capture", { text: "x", urgent: true })).text).toContain('unknown argument "urgent"');
    expect((await refused(d, "search", { query: 3 })).text).toContain('"query" must be a string');
    const bad = await d.req<AgentToolResult>("POST", "/api/agent/tools/capture", undefined, { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" });
    expect(bad.json.isError).toBe(true);
  });

  it("create_project → get_project → message_project → complete_action wakes the project as the agent, which answers its wait on the owner", async () => {
    const d = await bootRealDesk({ agentTokens: { main: AGENT_TOKEN } });
    const repo = tempDir("trae");
    d.script.add(
      "project",
      tool("track_action", { title: "要 Doubao work 的代码", owner: "human", nextStep: "找张三要代码，放到 ~/code/doubao" }),
      tool("wait", { reason: "等主人要来代码", waitingFor: "human" }),
    );
    const created = await ok(d, "create_project", { title: "Harness 对比", outcome: "一份对比报告", brief: "trae 本地有代码，Doubao 的要找张三要", cwd: repo });
    const { projectId } = created.data as { projectId: string };
    expect(created.text).toContain(`Started project ${projectId}「Harness 对比」`);
    expect(d.kernel.getCell(projectId)).toMatchObject({ preset: "project", principalId: "agent:main", parentId: "desk" });
    await d.kernel.idle();
    expect(d.kernel.context.readStateSync<ProjectRecord>(projectId, gtdKeys.project)).toMatchObject({ title: "Harness 对比", cwd: repo, source: { label: "主 Agent", principalId: "agent:main" } });

    const card = d.kernel.humanItems.create({title:"选择交付范围", subjectKey:"scope",
      options:[{id:"reply", label:"回复", effect:"reply"}]}, projectId);
    const got = await ok(d, "get_project", { id: projectId });
    for (const result of [got, await ok(d, "list_cards"), await ok(d, "get_cell", {id:projectId})]) {
      expect((result.data as {cards:{id:string}[]}).cards.map(c => c.id)).toEqual([card.id]);
    }
    const action = (got.data as { actions: Array<{ id: string; owner: string; status: string }> }).actions[0]!;
    expect(action).toMatchObject({ owner: "human", status: "open" });
    expect(got.text).toContain(`项目 ${projectId}「Harness 对比」`);
    expect(got.text).toContain(action.id);
    expect(got.text).toContain(`目录：${repo}`);
    expect(got.text).toContain("项目本身在等：human");

    const msg = await ok(d, "message_project", { id: projectId, text: "做完后用 /ship-mr 提 MR" });
    expect(msg.text).toContain(`Delivered to ${projectId}`);
    expect(texts(d, projectId)).toEqual([{ text: "做完后用 /ship-mr 提 MR", principalId: "agent:main" }]);
    await d.kernel.idle();
    // an agent speaking for the owner answers the project's wait on "human"
    expect(d.kernel.listWaits([projectId])).toEqual([]);
    d.script.add("project", tool("wait", { reason: "等主人要来代码", waitingFor: "human" }));
    await ok(d, "message_project", { id: projectId, text: "张三说明天给" });
    await d.kernel.idle();
    expect(d.kernel.listWaits([projectId]).map((w) => w.waitingFor)).toEqual(["human"]);

    const options = (await ok(d, "list_human_items", {})).data as {items: Array<{id:string;itemRevision:number}>};
    const item = options.items.find(i => i.id === action.id)!;
    const args = {id:item.id,optionId:"done",seenItemRevision:item.itemRevision,note:"代码在 ~/code/doubao"};
    expect((await ok(d, "decide_human_item", args)).data).toMatchObject({status:"resolved"});
    expect(d.kernel.context.readStateSync<ActionRecord>(projectId, gtdKeys.action(action.id))).toMatchObject({status:"done"});
    expect(d.kernel.inbox.listMessagesSync({cellId:projectId,type:"approval.resolved"}).at(-1)?.envelope).toMatchObject({
      principalId:"agent:main",delivery:"wakeup",payload:{note:args.note},
    });
    await d.kernel.idle();
    expect(d.kernel.listWaits([projectId])).toEqual([]);
    expect(requestsOf(d.script,projectId).at(-1)).toContain(args.note);
    await refused(d,"decide_human_item",args);
    await refused(d,"decide_human_item",{...args,id:"act_nope"});
  });

  it("create_project with a directory that does not exist asks for the right path instead of guessing", async () => {
    const d = await bootRealDesk({ agentTokens: { main: AGENT_TOKEN } });
    const r = await refused(d, "create_project", { title: "改 TUI", outcome: "复制出 Markdown", brief: "改表格复制", cwd: "/definitely/not/here" });
    expect(r.text).toContain("Ask the owner for the correct absolute path");
    expect(d.kernel.listCells({ parentId: "desk" })).toEqual([]);
  });

  it("set_project_state: pause, resume, someday, activate (the note reaches the project), cancel; a finished project is not messaged", async () => {
    const d = await bootRealDesk({ agentTokens: { main: AGENT_TOKEN } });
    d.script.add("project", tool("save_artifact", { artifactId: "art_r", title: "调研报告", body: "结论：先做极简档" }), tool("track_action", { title: "看报告", owner: "human", nextStep: "读报告" }));
    const { projectId } = (await ok(d, "create_project", { title: "极简模式", outcome: "调研报告", brief: "先调研", mode: "research_then_park" })).data as { projectId: string };
    await d.kernel.idle();
    expect((await ok(d, "set_project_state", { id: projectId, state: "pause" })).data).toMatchObject({ outcome: "paused" });
    expect(d.kernel.getCell(projectId)!.status).toBe("paused");
    expect((await ok(d, "set_project_state", { id: projectId, state: "resume" })).data).toMatchObject({ outcome: "resumed" });
    expect((await ok(d, "set_project_state", { id: projectId, state: "someday" })).data).toMatchObject({ outcome: "someday" });
    expect(d.kernel.context.readStateSync<ProjectRecord>(projectId, gtdKeys.project)!.lifecycle).toBe("someday");
    // a message to a parked project is kept for when it is activated
    expect((await ok(d, "message_project", { id: projectId, text: "范围缩小到第一阶段" })).text).toContain('parked ("someday")');
    expect((await refused(d, "set_project_state", { id: projectId, state: "resume" })).text).toContain("以后再说");
    await ok(d, "set_project_state", { id: projectId, state: "activate", note: "先做第一阶段" });
    expect(d.kernel.getCell(projectId)!.status).toBe("active");
    expect(texts(d, projectId).at(-1)).toMatchObject({ principalId: "agent:main", text: expect.stringContaining("主人（经主 Agent）的话：先做第一阶段") });
    await d.kernel.idle();
    const last = requestsOf(d.script, projectId).at(-1)!;
    expect(last).toContain("范围缩小到第一阶段");
    expect(last).toContain("先做第一阶段");

    expect((await ok(d, "set_project_state", { id: projectId, state: "cancel" })).data).toMatchObject({ outcome: "cancelled" });
    await d.kernel.idle();
    expect(d.kernel.getCell(projectId)).toMatchObject({ status: "closed", closeReason: "cancelled" });
    const closed = await refused(d, "message_project", { id: projectId, text: "再补一个录屏" });
    expect(closed.text).toContain("has already finished");
    expect(closed.text).toContain("create_project");
    expect(closed.text).toContain("art_r");
    expect((await refused(d, "message_project", { id: "proj_nope", text: "x" })).text).toContain('There is no project "proj_nope"');
    expect((await refused(d, "set_project_state", { id: projectId, state: "complete" })).text).toContain("已经取消");
  });

  it("get_project lists the reports of its workers, the dormant ones and the archived ones; a message to the finished project names them", async () => {
    const d = await bootRealDesk({ agentTokens: { main: AGENT_TOKEN } });
    d.script.add("project", tool("dispatch", { title: "调研竞品", instruction: "调研 3 家竞品" }));
    d.script.add("worker", tool("save_artifact", { artifactId: "art_w", title: "竞品调研", body: "A、B、C 三家" }), tool("report_to_parent", { kind: "result", text: "报告 art_w", artifactId: "art_w" }));
    const { projectId } = (await ok(d, "create_project", { title: "竞品调研", outcome: "报告", brief: "调研" })).data as { projectId: string };
    await d.kernel.idle();
    // A worker is not closed for finishing its turn: it rests, wakeable, and get_project says so.
    const worker = d.kernel.listCells({ parentId: projectId })[0]!;
    expect(worker.status).toBe("active");
    const got = await ok(d, "get_project", { id: projectId });
    expect(got.text).toContain("art_w v1「竞品调研」");
    expect(got.text).toContain(`${worker.id}「调研竞品」（worker，待命可唤醒`);
    expect((got.data as { artifacts: Array<{ id: string; cellId: string }> }).artifacts).toEqual([expect.objectContaining({ id: "art_w", cellId: worker.id })]);
    expect((got.data as { cells: Array<{ id: string; state: string }> }).cells).toEqual([expect.objectContaining({ id: worker.id, state: "待命可唤醒" })]);
    await ok(d, "set_project_state", { id: projectId, state: "complete" });
    await d.kernel.idle();
    // Archived with its project: still listed, as history.
    expect((await ok(d, "get_project", { id: projectId })).text).toContain(`${worker.id}「调研竞品」（worker，已归档`);
    expect((await refused(d, "message_project", { id: projectId, text: "再加一家" })).text).toContain("art_w");
  });

  it("add_action records an owner's action (with or without a next step) or a wait on the project's books and tells the project", async () => {
    const d = await bootRealDesk({ agentTokens: { main: AGENT_TOKEN } });
    const { projectId } = (await ok(d, "create_project", { title: "季度总结", outcome: "总结发出", brief: "写季度总结" })).data as { projectId: string };
    await d.kernel.idle();
    // A concrete next step is suggested, not required: without one the action is recorded and its title is the step.
    const bare = await ok(d, "add_action", { projectId, title: "约老板", owner: "human" });
    expect(bare.text).toContain("the owner's to-do");
    const bareId = (bare.data as { actionId: string }).actionId;
    expect(d.kernel.context.readStateSync<ActionRecord>(projectId, gtdKeys.action(bareId))).toMatchObject({ owner: "human", title: "约老板", nextStep: "约老板", status: "open" });
    expect(texts(d, projectId).at(-1)).toMatchObject({ principalId: "agent:main", text: expect.stringContaining("约老板") });
    const r = await ok(d, "add_action", { projectId, title: "约老板过一遍", owner: "human", nextStep: "发日历邀请，周四下午" });
    const actionId = (r.data as { actionId: string }).actionId;
    expect(d.kernel.context.readStateSync<ActionRecord>(projectId, gtdKeys.action(actionId))).toMatchObject({ owner: "human", nextStep: "发日历邀请，周四下午", status: "open" });
    expect(texts(d, projectId).at(-1)).toMatchObject({ principalId: "agent:main", text: expect.stringContaining("约老板过一遍") });
    await ok(d, "add_action", { projectId, title: "等财务出数", owner: "waiting" });
    const got = await ok(d, "get_project", { id: projectId });
    expect(got.text).toContain("等财务出数");
    expect((await ok(d, "workbench_overview")).text).toContain("约老板过一遍");
  });

  it("project proposals require the owner and ordinary review cards check the seen version", async () => {
    const d = await bootRealDesk({ agentTokens: { main: AGENT_TOKEN } });
    // BUG-020: a popped-up project_proposal card is also ownerOnly (external agents cannot self-approve a project card).
    d.script.add("desk", tool("propose_project", { title: "官网改版", outcome: "新版官网上线", actions: [{ title: "出设计稿", owner: "agent" }] }));
    await d.post("/api/capture", { text: "官网该改版了" });
    await d.kernel.idle();
    const proposal = (await d.get<{ cards: Array<{ id: string; cardType: string; itemRevision: number }> }>("/api/clarify")).cards.find((x) => x.cardType === "project_proposal")!;
    const listed2 = await ok(d, "list_cards");
    const proposalListed = (listed2.data as { cards: Array<{ id: string; ownerOnly: boolean; artifactVersion: number | null; humanEdited: boolean; itemRevision: number }> }).cards.find(
      (c) => c.id === proposal.id,
    )!;
    expect(proposalListed).toMatchObject({ ownerOnly: true, artifactVersion: 1, humanEdited: false, itemRevision: proposal.itemRevision });
    expect((await refused(d, "decide_card", { id: proposal.id, decision: "approve", seenVersion: 1, note: "主人说可以", seenItemRevision: 1 })).text).toContain("only the owner can approve card");
    expect(d.kernel.gate.getApprovalSync(proposal.id)!.status).toBe("pending");
    await expect(d.kernel.humanItems.decide(proposal.id, {optionId:"system.someday",
      seenArtifactVersion:1, seenItemRevision:proposal.itemRevision}, "owner")).rejects.toThrow(/以后再说/);
    expect(d.kernel.listCells({ parentId: "desk" }).some(x => x.title === "官网改版")).toBe(false);
    // The owner can approve it via the web UI.
    expect((await d.post<{ ok: boolean }>(`/api/clarify/${proposal.id}/approve`, { seenVersion: 1, seenItemRevision: proposal.itemRevision })).ok).toBe(true);
    expect(d.kernel.gate.getApprovalSync(proposal.id)).toMatchObject({ status: "approved", approverId: "owner" });
    expect(d.kernel.listCells({ parentId: "desk" }).some((x) => x.title === "官网改版" && x.preset === "project")).toBe(true);
    expect((await refused(d, "decide_card", { id: proposal.id, decision: "deny", seenItemRevision: 1 })).text).toContain("no longer pending");
    expect((await refused(d, "decide_card", { id: "act_nope", decision: "deny", seenItemRevision: 1 })).text).toContain('There is no card "act_nope"');

    // An ordinary non-ownerOnly card with a draft: MCP must forward caller-held seenVersion (never live DB read).
    const artId = "art_merge_1";
    const art = d.kernel.context.commitSync("desk", { artifact: { artifactId: artId, content: { format: "text", body: "方案 v1" }, updatedBy: "agent" } });
    if (!art.ok) throw new Error("artifact commit failed");
    const customCard = d.kernel.gate.authorizeSync(
      { type: "custom", name: "merge", summary: "合入变更", subjectKey: "merge:1", sideEffect: "external", artifactId: artId, args: {} },
      { cellId: "desk", epoch: 0, principalId: "cell:desk" },
    );
    if (customCard.type !== "defer") throw new Error("expected defer");
    // Human edits draft to v2 after agent saw v1.
    expect(
      d.kernel.context.commitSync("desk", {
        artifact: { artifactId: artId, content: { format: "text", body: "方案 v2（人改过）" }, updatedBy: "human", expectedVersion: 1 },
      }),
    ).toMatchObject({ ok: true, artifactVersion: 2 });
    // Calling decide_card without seenVersion or with stale seenVersion=1 must be rejected!
    expect((await refused(d, "decide_card", { id: customCard.actionId, decision: "approve", seenItemRevision: 1 })).data).toMatchObject({ outcome: "version_mismatch", currentVersion: 2 });
    expect((await refused(d, "decide_card", { id: customCard.actionId, decision: "approve", seenVersion: 1, seenItemRevision: 2 })).data).toMatchObject({ outcome: "version_mismatch", currentVersion: 2 });
    // Passing the actual v2 (and matching itemRevision) succeeds!
    const customListed = ((await ok(d, "list_cards")).data as { cards: Array<{ id: string; artifactVersion: number; humanEdited: boolean; itemRevision: number }> }).cards.find(
      (c) => c.id === customCard.actionId,
    )!;
    expect(customListed).toMatchObject({ artifactVersion: 2, humanEdited: true });
    expect((await ok(d, "decide_card", { id: customCard.actionId, decision: "approve", seenVersion: 2, seenItemRevision: customListed.itemRevision })).text).toContain("Approved");
    expect(d.kernel.gate.getApprovalSync(customCard.actionId)).toMatchObject({ status: "approved", approverId: "agent:main" });


  });

  it("capture hands the owner's words to the desk as an inbound message signed by the agent", async () => {
    const d = await bootRealDesk({ agentTokens: { main: AGENT_TOKEN } });
    d.script.add("desk", tool("capture_note", { title: "Rust async 文章", url: "https://example.com/rust-async" }));
    const r = await ok(d, "capture", { text: "https://example.com/rust-async 这篇存一下" });
    expect(r.text).toContain("Captured message");
    const [m] = d.kernel.inbox.listMessagesSync({ cellId: "desk", type: "user.message" });
    expect(m!.envelope).toMatchObject({ from: "channel:ui:owner", principalId: "agent:main", payload: { text: "https://example.com/rust-async 这篇存一下", replyTo: "channel:ui:owner" } });
    expect((m!.envelope.payload as UserMessagePayload).sender).toMatchObject({ id: "agent:main" });
    await d.kernel.idle();
    expect(requestText(d.script.requests.find((x) => x.role === "desk")!.req)).toContain("rust-async 这篇存一下");
    expect((await ok(d, "workbench_overview")).text).toContain("需要主人处理");
  });

  it("routes authenticated capture through watches, and retries the same client id once", async () => {
    const d = await bootDesk({agentTokens:{main:AGENT_TOKEN}});
    d.kernel.spawnCell("desk", {id:"sub",preset:"watcher",lifetime:"persistent",watches:[{threadOrFilter:{type:"user.message",principalId:"agent:main"}}]});
    const args={text:"路由给订阅者",clientId:"mcp-retry-1"};
    await ok(d,"capture",args);
    await ok(d,"capture",args);
    const watched = d.kernel.inbox.listMessagesSync({cellId:"sub",type:"user.message"});
    expect(watched).toHaveLength(1);
    expect(watched[0]!.envelope.principalId).toBe("agent:main");
    expect(d.kernel.inbox.listMessagesSync({cellId:"desk",type:"user.message"})).toHaveLength(0);
  });

  it("the overview shows the owner's actions, cards (ownerOnly marked), projects, parked ones, running cells and workspaces with ids", async () => {
    const d = await bootRealDesk({ agentTokens: { main: AGENT_TOKEN } });
    const repo = tempDir("repo");
    writeAction(d.kernel, "desk", { title: "给牙医回电话", owner: "human", nextStep: "打 010-1234" });
    d.script.add("desk", tool("propose_project", { title: "立项发布计划", outcome: "验证发布流程", actions: [{ title: "检查发布清单", owner: "agent" }] }));
    await d.post("/api/capture", { text: "先给我确认发布计划" });
    await d.kernel.idle();
    const proposal = d.kernel.humanItems.list().find(item => item.action?.type === "project.start")!;

    d.script.add("project", tool("dispatch", { title: "改 a.ts", instruction: "改 a" }));
    d.script.add("worker", { toolCalls: [{ name: "report_to_parent", input: { kind: "progress", text: "改了一半" } }] }, { delayMs: 60_000 });
    const { projectId } = (await ok(d, "create_project", { title: "改 a", outcome: "a 改好", brief: "改 a", cwd: repo })).data as { projectId: string };
    const { projectId: parked } = (await ok(d, "create_project", { title: "以后的点子", outcome: "调研", brief: "先记着" })).data as { projectId: string };
    await new Promise((r) => setTimeout(r, 200));
    await ok(d, "set_project_state", { id: parked, state: "someday" });
    const o = await ok(d, "workbench_overview");
    for (const head of ["需要主人处理", "待确认卡片", "进行中的项目", "已停靠", "正在运行", "工作目录占用"]) expect(o.text).toContain(head);
    expect(o.text).toContain("给牙医回电话");
    expect(o.text).toContain(`${proposal.id}「立项发布计划」`);
    expect(o.text).toContain(`${projectId}「改 a」`);
    expect(o.text).toContain(`${parked}「以后的点子」`);
    expect(o.text).toContain(repo);
    const data = o.data as { cards: Array<{ id: string; ownerOnly: boolean }>; projects: Array<{ id: string }>; parked: Array<{ id: string }>; running: Array<{ cellId: string }>; workspaces: unknown[] };
    expect(data.cards).toMatchObject([{ id: proposal.id, ownerOnly: true }]);
    expect(data.projects.map((p) => p.id)).toEqual([projectId]);
    expect(data.parked.map((p) => p.id)).toEqual([parked]);
    expect(data.running.length).toBeGreaterThan(0);
    expect(data.workspaces.length).toBeGreaterThan(0);
    // Who is active where — a fact, nobody queued or locked out.
    const ws = await ok(d, "list_workspaces");
    expect(ws.text).toContain(repo);
    expect(ws.text).toContain("「改 a.ts」（项目「改 a」）：正在工作");
    expect(ws.text).toContain("Nothing is locked");
    expect(ws.text).not.toMatch(/写入中|排队/);
    await d.kernel.stop();
  });


  it("read_artifact, search, save_preference, get_cell, spawn_cell and control_cell", async () => {
    const d = await bootRealDesk({ agentTokens: { main: AGENT_TOKEN } });
    d.kernel.context.commitSync("desk", { artifact: { artifactId: "art_x", content: { format: "markdown", title: "迁移方案", body: "选双写灰度" }, updatedBy: "agent" } });
    const art = await ok(d, "read_artifact", { id: "art_x" });
    expect(art.text).toContain("artifact art_x v1「迁移方案」");
    expect(art.text).toContain("选双写灰度");
    expect((await refused(d, "read_artifact", { id: "art_nope" })).text).toContain("There is no artifact");

    const pref = await ok(d, "save_preference", { name: "code-change-followup", text: "改完代码后直接用 /ship-mr 提 MR" });
    expect(pref.text).toContain('Saved the global preference "code-change-followup"');
    expect(d.kernel.context.getKnowledgeSync({ kind: "preference", name: "code-change-followup", scope: "global" })).toMatchObject({ body: "改完代码后直接用 /ship-mr 提 MR" });
    expect((await ok(d, "save_preference", { name: "code-change-followup", text: "改完代码后用 /ship-mr 提 MR，再补录屏" })).text).toContain("Replaced");
    // A rule for one repository and one kind of agent keeps its limits.
    const gate = await ok(d, "save_preference", { name: "trae-x-commit-gate", text: "改 Rust 代码后先跑 cargo clippy 再提交", cwdPrefix: "/work/trae-x/", roles: ["worker"] });
    expect(gate.text).toBe('Saved the preference "trae-x-commit-gate": only background agents working in /work/trae-x or below and whose role is worker see it, from their next turn on.');
    expect(gate.data).toMatchObject({ replaced: false, applies: { cwdPrefix: "/work/trae-x", roles: ["worker"] } });
    const gateRecord = () => d.kernel.context.getKnowledgeSync({ kind: "preference", name: "trae-x-commit-gate", scope: "global" });
    expect(gateRecord()?.applies).toEqual({ cwdPrefix: "/work/trae-x", roles: ["worker"] });
    expect((await ok(d, "list_preferences")).text).toContain("trae-x-commit-gate（");
    expect((await ok(d, "list_preferences")).text).toContain("；仅限目录 /work/trae-x，仅限角色 worker）");
    expect((await refused(d, "save_preference", { name: "x-gate", text: "t", cwdPrefix: "work/trae-x" })).text).toContain("cwdPrefix must be an absolute directory path");
    expect((await refused(d, "save_preference", { name: "x-gate", text: "t", roles: "worker" })).text).toContain('"roles" must be an array of strings');
    // Saved again without limits: it applies everywhere.
    expect((await ok(d, "save_preference", { name: "trae-x-commit-gate", text: "改 Rust 代码后先跑 cargo clippy" })).text).toContain('Replaced the global preference "trae-x-commit-gate"');
    expect(gateRecord()).not.toHaveProperty("applies");
    const found = await ok(d, "search", { query: "双写灰度" });
    expect(found.text).toMatch(/hit\(s\) for "双写灰度"/);
    expect((found.data as { hits: Array<{ source: string }> }).hits.some((h) => h.source === "artifact")).toBe(true);
    expect((await ok(d, "search", { query: "ship-mr" })).text).toContain("ship-mr");

    d.script.add("worker", tool("report_to_parent", { kind: "result", text: "仓库里有 3 个 harness 入口" }));
    const spawned = await ok(d, "spawn_cell", { preset: "worker", title: "看一眼仓库", instruction: "数一数 harness 入口" });
    expect(spawned.text).toContain("stays dormant");
    const cellId = (spawned.data as { cellId: string }).cellId;
    expect(d.kernel.getCell(cellId)).toMatchObject({ preset: "worker", parentId: "desk", principalId: "agent:main" });
    await d.kernel.idle();
    const cell = await ok(d, "get_cell", { id: cellId, tail: 5 });
    expect(cell.text).toContain(`cell ${cellId}「看一眼仓库」 — worker，待命可唤醒`);
    expect(cell.text).toContain("report_to_parent");
    expect(cell.data).toMatchObject({ state: "dormant" });
    expect((cell.data as { tail: unknown[] }).tail.length).toBeLessThanOrEqual(5);
    // The finished worker is woken by a message on its record.
    d.script.add("worker", { text: "又看了一遍，还是 3 个" });
    const woken = await ok(d, "control_cell", { id: cellId, action: "message", text: "再看一下" });
    expect(woken.text).toContain("was dormant and is woken by it");
    await d.kernel.idle();
    expect(d.kernel.listCells({ parentId: "desk" }).filter((c) => c.title === "看一眼仓库")).toHaveLength(1);
    expect((await refused(d, "control_cell", { id: "cell_nope", action: "message", text: "x" })).text).toContain('there is no cell "cell_nope"');
    expect((await refused(d, "control_cell", { id: "desk", action: "steer" })).text).toContain("needs text");

    const { projectId } = (await ok(d, "create_project", { title: "季度总结", outcome: "发出", brief: "写" })).data as { projectId: string };
    await d.kernel.idle();
    expect((await ok(d, "control_cell", { id: projectId, action: "pause" })).text).toContain("pause applied");
    expect(d.kernel.getCell(projectId)!.status).toBe("paused");
    expect((await ok(d, "control_cell", { id: projectId, action: "resume" })).text).toContain("resume applied");
    expect((await ok(d, "control_cell", { id: projectId, action: "message", text: "进展如何" })).text).toContain("Delivered");
    expect((await ok(d, "get_cell", { id: "desk" })).text).toContain("cell desk「主台」");

    // BUG-020: control_cell routes through DeskService (rejects root pause/cancel and syncs project lifecycle on cancel).
    expect((await refused(d, "control_cell", { id: "desk", action: "pause" })).text).toContain("不能暂停或叫停");
    expect((await refused(d, "control_cell", { id: "desk", action: "cancel" })).text).toContain("不能暂停或叫停");
    expect(d.kernel.getCell("desk")!.status).toBe("active");
    await ok(d, "add_action", { projectId, title: "还没做完的动作", owner: "human", nextStep: "做完" });
    expect((await ok(d, "control_cell", { id: projectId, action: "cancel" })).text).toContain("cancel applied");
    expect(d.kernel.getCell(projectId)!.status).toBe("closed");
    expect(d.kernel.context.readStateSync<{ lifecycle: string }>(projectId, "gtd:project")?.lifecycle).toBe("cancelled");

    // BUG-020: DeskActor principalId is strictly required (never falls back silently to owner).
    await expect(d.server.desk.approve("act_x", { seenItemRevision: 1 }, { principalId: "" })).rejects.toThrow(/principalId/);
    await expect(d.server.desk.deny("act_x", { seenItemRevision: 1 }, { principalId: "   " })).rejects.toThrow(/principalId/);
    await expect(d.server.desk.projectOp(projectId, "pause", { principalId: "" })).rejects.toThrow(/principalId/);
    await expect(d.server.desk.cellControl(projectId, { action: "pause" }, { principalId: "" })).rejects.toThrow(/principalId/);
    expect(() => d.server.desk.sendCellMessage("desk", { text: "hi", clientId: "c1" }, { principalId: "" })).toThrow(/principalId/);

    // spawn_cell takes any registered preset (no enum in its schema); the kernel answers for one that is not registered
    const presetSchema = (AGENT_TOOLS.find((t) => t.name === "spawn_cell")!.inputSchema as { properties: Record<string, { enum?: unknown }> }).properties["preset"]!;
    expect(presetSchema.enum).toBeUndefined();
    const watcher = await ok(d, "spawn_cell", { preset: "watcher", title: "盯 CI", instruction: "CI 绿了告诉我" });
    expect(d.kernel.getCell((watcher.data as { cellId: string }).cellId)).toMatchObject({ preset: "checker", parentId: "desk" });
    expect(await refused(d, "spawn_cell", { preset: "nope", title: "x", instruction: "y" })).toMatchObject({ text: 'Not done: unknown preset "nope"', data: { code: "invalid_argument" } });
  });
});

// ==================== the MCP stdio proxy ====================

interface Rpc {
  send(msg: Record<string, unknown>): void;
  next(): Promise<Record<string, unknown>>;
  close(): void;
}

function startMcp(env: Record<string, string>): Rpc {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [BIN], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const queue: Array<Record<string, unknown>> = [];
  const waiting: Array<(m: Record<string, unknown>) => void> = [];
  lines.on("line", (l) => {
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

describe("MCP stdio server (bin/ng-mcp.mjs)", () => {
  it("proxies a session to a running workbench: initialize → tools/list → tools/call", async () => {
    const d = await bootRealDesk({ agentTokens: { main: AGENT_TOKEN }, port: 0, env:{NG_OWNER_ADDRESSES:"channel:memory:owner"} });
    const { url } = await d.server.listen();
    const mcp = startMcp({ NG_DESK_URL: url, NG_AGENT_TOKEN: AGENT_TOKEN });
    try {
      mcp.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      const init = (await mcp.next()) as { id: number; result: { protocolVersion: string; serverInfo: { name: string }; instructions: string; capabilities: unknown } };
      expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: AGENT_SERVER_NAME }, capabilities: { tools: {} } } });
      expect(init.result.instructions).toBe(AGENT_INSTRUCTIONS);
      mcp.send({ method: "notifications/initialized" });
      mcp.send({ id: 2, method: "tools/list" });
      const list = (await mcp.next()) as { id: number; result: { tools: Array<{ name: string; inputSchema: unknown }> } };
      expect(list.id).toBe(2);
      expect(list.result.tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name));
      expect(list.result.tools[0]!.inputSchema).toEqual(AGENT_TOOLS[0]!.inputSchema);

      const item = d.kernel.humanItems.create({title:"选定交付范围",subjectKey:"scope",options:[{id:"research",label:"先调研",effect:"reply"}]},"desk");
      mcp.send({id:20,method:"tools/call",params:{name:"list_human_items",arguments:{}}});
      const listed = (await mcp.next()) as {result:{content:Array<{text:string}>}};
      const listedText = listed.result.content[0]!.text;
      expect(JSON.parse(listedText.slice(listedText.indexOf("\n")+1))).toContainEqual(expect.objectContaining({
        id:item.id,title:item.title,itemRevision:1,artifactVersion:null,options:expect.arrayContaining([expect.objectContaining({id:"research",label:"先调研"})])
      }));
      mcp.send({ id: 3, method: "tools/call", params: { name: "workbench_overview", arguments: {} } });
      const overview = (await mcp.next()) as { id: number; result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
      expect(overview.id).toBe(3);
      expect(overview.result.isError).toBeUndefined();
      expect(overview.result.content[0]!.text).toContain(item.title);
      mcp.send({id:21,method:"tools/call",params:{name:"decide_human_item",arguments:{id:item.id,optionId:"research",seenItemRevision:1,note:"看第一份"}}});
      const decision=(await mcp.next()) as {result:{content:Array<{text:string}>}};
      expect(JSON.parse(decision.result.content[0]!.text)).toMatchObject({status:"resolved",activityId:expect.any(String),restorable:true});

      mcp.send({ id: 4, method: "tools/call", params: { name: "create_project", arguments: { title: "MCP 立项", outcome: "完成", brief: "从 MCP 来的" } } });
      const created = (await mcp.next()) as { id: number; result: { content: Array<{ text: string }> } };
      expect(created.result.content[0]!.text).toMatch(/^Started project proj_\w+「MCP 立项」/);
      const project = d.kernel.listCells({ parentId: "desk" }).find((c) => c.title === "MCP 立项")!;
      expect(project.principalId).toBe("agent:main");

      mcp.send({ id: 5, method: "tools/call", params: { name: "create_project", arguments: { title: "缺字段" } } });
      const bad = (await mcp.next()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
      expect(bad.result.isError).toBe(true);
      expect(bad.result.content[0]!.text).toContain("Invalid arguments");
      mcp.send({ id: 6, method: "nope/method" });
      expect(await mcp.next()).toMatchObject({ id: 6, error: { code: -32601 } });
    } finally {
      mcp.close();
    }
  });

  it("explains an unreachable workbench instead of failing silently", async () => {
    const d = await bootDesk({ port: 0 });
    const { url } = await d.server.listen();
    await d.server.close();
    const mcp = startMcp({ NG_DESK_URL: url, NG_AGENT_TOKEN: AGENT_TOKEN, NG_MCP_TIMEOUT_MS: "5000" });
    try {
      mcp.send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
      const init = (await mcp.next()) as { result: { protocolVersion: string; instructions: string } };
      expect(init.result.protocolVersion).toBe("2024-11-05");
      expect(init.result.instructions).toContain("currently unavailable");
      expect(init.result.instructions).toContain("could not be reached");
      mcp.send({ id: 2, method: "tools/list" });
      const list = (await mcp.next()) as { result: { tools: Array<{ name: string; description: string }> } };
      expect(list.result.tools).toHaveLength(1);
      expect(list.result.tools[0]!.description).toContain("Unavailable right now");
      mcp.send({ id: 3, method: "tools/call", params: { name: "workbench_overview", arguments: {} } });
      const r = (await mcp.next()) as { result: { content: Array<{ text: string }>; isError: boolean } };
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0]!.text).toContain("pnpm start");
    } finally {
      mcp.close();
    }
  });
});

describe("agent tools: near-miss argument names", () => {
  it("understands the obvious aliases without touching a correct call", async () => {
    const { normalizeArgs } = await import("../src/agent/tools");
    const { AGENT_TOOLS } = await import("../src/agent/guide");
    const doc = (name: string) => AGENT_TOOLS.find((t) => t.name === name)!;
    expect(normalizeArgs(doc("message_project"), { id: "proj_1", message: "补录屏" })).toEqual({ id: "proj_1", text: "补录屏" });
    expect(normalizeArgs(doc("message_project"), { projectId: "proj_1", text: "x" })).toEqual({ id: "proj_1", text: "x" });
    expect(normalizeArgs(doc("decide_human_item"), {id:"act_9", optionId:"done", seenItemRevision:2})).toEqual({id:"act_9",optionId:"done",seenItemRevision:2});
    expect(normalizeArgs(doc("search"), { q: "周报" })).toEqual({ query: "周报" });
    expect(normalizeArgs(doc("set_project_state"), { id: "proj_1", op: "pause" })).toEqual({ id: "proj_1", state: "pause" });
    // Correct calls and genuinely unknown arguments are left exactly as given (validation still reports the latter).
    expect(normalizeArgs(doc("control_cell"), { id: "c1", action: "message", text: "hi" })).toEqual({ id: "c1", action: "message", text: "hi" });
    expect(normalizeArgs(doc("decide_card"), { id: "a1", decision: "deny", note: "no", bogus: 1 })).toEqual({ id: "a1", decision: "deny", note: "no", bogus: 1 });
  });
});
