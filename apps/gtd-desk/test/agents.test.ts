// 分身实况 (Agents): the topology, one cell's timeline, a person's message to a cell, its controls, spilled outputs and
// the live tail — plus the Radar fields and the control-plane tools that go with them.

import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { forgetWorkTreeKeys, type CellSpecInput } from "@ng/cell";
import { gtdKeys } from "@ng/presets";
import {
  createBus,
  KERNEL_FROM,
  PAYLOAD,
  pullCursorKey,
  steerNoteText,
  type CellMessagePayload,
  type CodeProcessor,
  type Envelope,
  type ProjectRecord,
  type Registry,
  type StepOrExternalEvidence,
} from "@ng/protocol";
import type {
  CellControlResponse,
  CellTimelineDTO,
  CellTriggerResponse,
  DeskEvent,
  ProjectMutationResponse,
  RadarDTO,
  ResourcePageDTO,
  SendCellMessageResponse,
  StatusDTO,
  TimelineItemDTO,
  TopologyDTO,
  TopologyNodeDTO,
} from "../src/shared/api";
import type { AgentToolResult } from "../src/agent/routes";

import { createEventHub } from "../src/server/events";
import { projectReview } from "../src/server/projections/review";
import { DEFAULT_SETTINGS, inputOf } from "../src/server/projections/common";
import { bootDesk, cleanupAll, HOUR, makeReviewCard, registerTestPresets, requestText, tempDir, tool, writeAction, writeProject, type TestDesk } from "./helpers";

afterEach(cleanupAll);

const AGENT_TOKEN = "agent-token-0123456789abcdef";
const noop: CodeProcessor = { name: "test.noop", run: async () => "completed" };

function boot(opts: Parameters<typeof bootDesk>[0] = {}): Promise<TestDesk> {
  return bootDesk({
    registerPresets: (r: Registry) => {
      registerTestPresets(r);
      r.codeProcessors.register(noop);
    },
    ...opts,
  });
}

/** A git work tree on branch feat/retry. */
function gitRepo(): string {
  const repo = tempDir("repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "symbolic-ref", "HEAD", "refs/heads/feat/retry"]);
  forgetWorkTreeKeys();
  return repo;
}

/** A coordinating cell holding a project record (scripted as role "project"; it may inspect_cell its workers). */
function project(d: TestDesk, id: string, title: string, extra: Partial<CellSpecInput> = {}): void {
  d.kernel.spawnCell("desk", { id, preset: "project", title, ...extra, meta: { role: "project", projectCellId: id } });
  writeProject(d.kernel, id, { title, ...(extra.cwd ? { cwd: extra.cwd } : {}) });
}

/** A wakeable worker (scripted by its own id). */
function worker(d: TestDesk, id: string, parent: string, title: string, task?: string, extra: Partial<CellSpecInput> = {}): void {
  d.kernel.spawnCell(parent, { id, preset: "worker", title, lifetime: "wakeable", meta: { role: id }, ...extra }, task);
}

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nodeOf = (t: TopologyDTO, id: string): TopologyNodeDTO => t.nodes.find((n) => n.cellId === id)!;
const kinds = (items: readonly TimelineItemDTO[]) => items.map((i) => i.kind);
const of = <K extends TimelineItemDTO["kind"]>(items: readonly TimelineItemDTO[], kind: K) => items.filter((i): i is Extract<TimelineItemDTO, { kind: K }> => i.kind === kind);
/** Machinery words that must never reach a person. */
const INTERNAL = /\b(claim|epoch|silent_inject|serial_coalesce|kernel\.|run_\w+|cell\.result|cell\.task)\b/;

async function agentCall(d: TestDesk, name: string, args: Record<string, unknown> = {}) {
  return d.req<AgentToolResult>("POST", `/api/agent/tools/${name}`, args, { authorization: `Bearer ${AGENT_TOKEN}` });
}
async function agentOk(d: TestDesk, name: string, args: Record<string, unknown> = {}): Promise<AgentToolResult> {
  const r = await agentCall(d, name, args);
  expect(r.status, `${name} → HTTP ${r.status}`).toBe(200);
  expect(r.json.isError, `${name}: ${r.json.text}`).toBeFalsy();
  return r.json;
}
async function agentRefused(d: TestDesk, name: string, args: Record<string, unknown> = {}): Promise<AgentToolResult> {
  const r = await agentCall(d, name, args);
  expect(r.status).toBe(200);
  expect(r.json.isError, r.json.text).toBe(true);
  return r.json;
}

// ==================== topology ====================

describe("GET /api/agents/topology", () => {
  it("roles, layers and states, parents before children; waits; archived children folded; a project filter", async () => {
    const d = await boot();
    const k = d.kernel;
    const repo = gitRepo();
    project(d, "proj", "支付重试改造", { cwd: repo });
    d.script.add("w1", { text: "已提交 9f2c1" });
    worker(d, "w1", "proj", "核心退避编码", "实现指数退避");
    d.script.add("w2", tool("wait", { reason: "目录里有陌生改动，等项目指示", waitingFor: "inbox:proj" }));
    worker(d, "w2", "proj", "压测脚本", "写压测脚本");
    k.spawnCell("proj", { id: "wt", preset: "checker", title: "等 CI", lifetime: "one_shot", schedules: [{ deliverAt: k.clock.now() + HOUR }] });
    d.clock.advance(1); // siblings are listed in creation order
    k.spawnCell("desk", { id: "s1", preset: "sensor", title: "报错巡检", schedules: [{ cron: "*/30 * * * *" }] });
    d.clock.advance(1);
    project(d, "old", "旧项目");
    worker(d, "ow", "old", "旧分身");
    await k.idle();
    await k.closeCell("old", "completed");

    const t = await d.get<TopologyDTO>("/api/agents/topology");
    expect(t.deskCellId).toBe("desk");
    expect(t.nodes.map((n) => n.cellId)).toEqual(["desk", "proj", "w1", "w2", "wt", "s1"]);
    expect(nodeOf(t, "desk")).toMatchObject({ roleLabel: "总助理", layer: 0, parentId: null, projectId: null, archivedChildren: 1, engine: null, processorType: "llm", canChat: true, stateLabel: "待命" });
    expect(nodeOf(t, "proj")).toMatchObject({ roleLabel: "项目协调", layer: 1, projectId: "proj", title: "支付重试改造", state: "waiting", stateLabel: "待命", cwd: repo, gitRoot: repo, unpulledCount: 0 });
    expect(nodeOf(t, "w1")).toMatchObject({
      roleLabel: "执行分身",
      layer: 2,
      parentId: "proj",
      projectId: "proj",
      state: "dormant",
      stateLabel: "已待命 · 发消息即唤醒",
      stateDetail: null,
      canChat: true,
      gitRoot: repo,
      hadDirectUserChat: false,
      modelTier: "strong",
    });
    // The project has not looked at what its worker did: its task and what it said.
    expect(nodeOf(t, "w1").unpulledCount).toBeGreaterThanOrEqual(2);
    expect(nodeOf(t, "w1").lastEvidenceSeq).toBeGreaterThan(0);
    expect(nodeOf(t, "w2")).toMatchObject({ state: "waiting", stateLabel: "等待协同", stateDetail: "等「支付重试改造」回信" });
    expect(nodeOf(t, "wt")).toMatchObject({ roleLabel: "外部盯梢", layer: 2, state: "waiting", stateLabel: "等待外部", stateDetail: expect.stringMatching(/^下次检查 /) });
    expect(nodeOf(t, "s1")).toMatchObject({ roleLabel: "信源巡检", layer: 0, state: "waiting", modelTier: "fast" });
    expect(t.waits).toEqual([{ fromCellId: "w2", targetCellId: "proj", targetLabel: "项目协调「支付重试改造」", description: "目录里有陌生改动，等项目指示", since: expect.any(Number) }]);
    expect(t.counts).toMatchObject({ running: 0, dormant: 1, archived: 2 });
    for (const n of t.nodes) expect(`${n.stateLabel} ${n.stateDetail ?? ""}`).not.toMatch(INTERNAL);

    // With the archive: the finished project and its worker, as history (nobody can talk to them).
    const all = await d.get<TopologyDTO>("/api/agents/topology?includeArchived=1");
    expect(all.nodes.map((n) => n.cellId)).toEqual(["desk", "proj", "w1", "w2", "wt", "s1", "old", "ow"]);
    expect(nodeOf(all, "ow")).toMatchObject({ state: "archived", stateLabel: "已归档", canChat: false, parentId: "old" });

    // One project: its subtree and its ancestors.
    const one = await d.get<TopologyDTO>("/api/agents/topology?projectId=proj");
    expect(one.nodes.map((n) => n.cellId)).toEqual(["desk", "proj", "w1", "w2", "wt"]);
    expect((await d.req("GET", "/api/agents/topology?projectId=nope")).status).toBe(404);
    expect((await d.req("GET", "/api/agents/topology?includeArchived=yes")).status).toBe(400);

    // The owner's ball: an open action of theirs on the project's books, a card of the desk's.
    const act = writeAction(k, "proj", { title: "确认最大重试次数", owner: "human", nextStep: "回复 3 还是 5" });
    const card = makeReviewCard(k);
    const b = await d.get<TopologyDTO>("/api/agents/topology");
    expect(nodeOf(b, "proj")).toMatchObject({ state: "blocked_human", stateLabel: "等你拍板", stateDetail: "等你处理：确认最大重试次数", humanItemId: act.id });
    expect(nodeOf(b, "desk")).toMatchObject({ state: "blocked_human", pendingCardId: card.actionId, humanItemId: null });

    // The project pulls: its inspect_cell moves its cursor and the worker has nothing unread any more.
    d.script.add("project", tool("inspect_cell", { cellId: "w1" }));
    k.sendToCell("proj", { text: "进展？" }, { principalId: "cell:desk" });
    await k.idle();
    expect(nodeOf(await d.get<TopologyDTO>("/api/agents/topology"), "w1").unpulledCount).toBe(0);
    // The owner talks to the worker directly: it says so, and there is something unread again.
    d.script.add("w1", { text: "改成 3 次了" });
    await d.post<SendCellMessageResponse>("/api/cells/w1/messages", { text: "最大重试改成 3", clientId: "c-1" });
    await k.idle();
    const after = nodeOf(await d.get<TopologyDTO>("/api/agents/topology"), "w1");
    expect(after).toMatchObject({ hadDirectUserChat: true, state: "dormant" });
    expect(after.unpulledCount).toBeGreaterThan(0);
  });

  it("a worker at work: running, its work tree highlighted; messages while it runs are queued for the end of its step or steer it", async () => {
    const d = await boot();
    const k = d.kernel;
    const repo = gitRepo();
    project(d, "proj", "支付重试改造", { cwd: repo });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    d.script.add("w1", async () => {
      await held;
      return { text: "退避已实现" };
    });
    worker(d, "w1", "proj", "核心退避编码", "实现指数退避");
    worker(d, "w2", "proj", "压测脚本");
    await waitFor(() => k.activeRuns().some((r) => r.cellId === "w1"));

    const t = await d.get<TopologyDTO>("/api/agents/topology");
    expect(nodeOf(t, "w1")).toMatchObject({ state: "running", stateLabel: "运行中" });
    expect(t.counts.running).toBe(1);
    expect(t.workspaces).toEqual([{ gitRoot: repo, label: expect.any(String), activeCellIds: ["w1"] }]);
    const radar = await d.get<RadarDTO>("/api/radar");
    expect(radar.projects[0]!.agents).toEqual({ total: 2, running: 1, href: "#/agents?project=proj", label: "2 个分身（1 个在跑） →" });

    const tl = await d.get<CellTimelineDTO>("/api/cells/w1/timeline");
    expect(tl.composer).toMatchObject({ mode: "running", enabled: true, canSteer: true, syncTo: { cellId: "proj", title: "支付重试改造" } });
    const queued = await d.post<SendCellMessageResponse>("/api/cells/w1/messages", { text: "顺便补个单测", clientId: "m-1" });
    expect(queued).toMatchObject({ ok: true, outcome: "delivered", id: "m-1", message: "已顺手补充，本轮收尾时处理；已同步给所属项目「支付重试改造」" });
    const steer = await d.post<SendCellMessageResponse>("/api/cells/w1/messages", { text: "先别改对外 API", clientId: "m-2", mode: "steer" });
    expect(steer.message).toBe("已打断插话，它马上就会看到；已同步给所属项目「支付重试改造」");
    release();
    await k.idle();

    const items = (await d.get<CellTimelineDTO>("/api/cells/w1/timeline")).items;
    const chats = of(items, "user_chat");
    expect(chats.find((c) => c.id === "m-1")).toMatchObject({ mode: "enqueue", text: "顺便补个单测", senderLabel: "你", direct: true, syncedTo: "支付重试改造" });
    expect(chats.find((c) => c.mode === "steer")).toMatchObject({ text: "先别改对外 API", senderLabel: "你" });
    // Both reached the project too (in the owner's words), without waking it for each.
    expect(k.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.cellDirectChat }).map((m) => (m.envelope.payload as { mode: string }).mode)).toEqual(["enqueue", "steer"]);
    expect(nodeOf(await d.get<TopologyDTO>("/api/agents/topology"), "w1").state).toBe("dormant");
    expect((await d.get<TopologyDTO>("/api/agents/topology")).workspaces).toEqual([]);
  });
});

// ==================== timeline ====================

describe("GET /api/cells/:cellId/timeline", () => {
  /** A worker that never runs; its record is written here, step by step, as the loops write it. */
  async function recorded() {
    const d = await boot();
    const k = d.kernel;
    const repo = gitRepo();
    project(d, "proj", "支付重试改造", { cwd: repo });
    worker(d, "w1", "proj", "核心退避编码");
    const t0 = k.clock.now();
    let at = t0;
    const add = (r: Record<string, unknown>, when = at) => k.context.appendEvidenceSync("w1", { runId: "run_1", at: when, ...r } as StepOrExternalEvidence).seq;
    const env = (type: string, payload: unknown, extra: Partial<Envelope> = {}): Envelope =>
      ({ id: `env-${type}-${at}`, from: KERNEL_FROM.spawn, principalId: "cell:proj", kind: "event", type, payload, createdAt: at, ...extra }) as Envelope;
    const step = (id: string, name: string, input: unknown, output: string, ms = 10) => {
      add({ kind: "tool_call", toolUseId: id, name, input });
      at += ms;
      add({ kind: "tool_result", toolUseId: id, name, output });
    };
    add({ kind: "run_boundary", phase: "start", epoch: 0 });
    add({ kind: "inbound", envelope: env(PAYLOAD.cellTask, { parentCellId: "proj", instruction: "实现指数退避，跑通单测后提交" }) });
    step("t1", "Read", { file_path: `${repo}/src/retry.ts` }, "export function retry() {}");
    step("t2", "Grep", { pattern: "maxRetries" }, "src/retry.ts:3");
    step("t3", "Read", { file_path: `${repo}/src/backoff.ts` }, "export const base = 100;");
    step("t4", "Edit", { file_path: `${repo}/src/retry.ts`, old_string: "5", new_string: "backoff(5)" }, "ok");
    step("t5", "Bash", { command: "pnpm test" }, `${"✓ retry ".repeat(1_500)}\nTests 14 passed`, 4_200);
    add({ kind: "assistant_text", text: "已完成退避实现并提交 9f2c1，单测 14/14 通过。" });
    add({ kind: "system_note", text: steerNoteText("先别动对外 API") });
    add({ kind: "tool_call", toolUseId: "t6", name: "send_message", input: { to: "channel:ui:owner", text: "最大重试次数要改成 3 吗？", summary: "问主人" } });
    add({ kind: "tool_result", toolUseId: "t6", name: "send_message", output: "Sent to the owner." });
    k.context.commitSync("w1", { artifact: { artifactId: "art_r", content: { format: "markdown", title: "退避方案", body: "# 退避\n指数退避，最多 5 次" }, updatedBy: "agent" } });
    step("t7", "save_artifact", { title: "退避方案", body: "# 退避" }, "Saved art_r v1.");
    add({ kind: "inbound", envelope: env(PAYLOAD.jobResult, { jobId: "j1", command: "pnpm build", state: "succeeded", exitCode: 0, tail: "" }, { from: KERNEL_FROM.workspace, principalId: "cell:w1" }) });
    add({ kind: "inbound", envelope: env(PAYLOAD.stalledCheck, { projectCellId: "proj", stalledSince: t0, detail: "x" }, { from: KERNEL_FROM.stall, principalId: "kernel" }) });
    add({ kind: "inbound", envelope: env(PAYLOAD.timerFired, { label: "复核结果" }) });
    return { d, k, repo, add, env };
  }

  it("interleaves the task, folded tool steps, replies, the owner's words and plain events; the header knows the node", async () => {
    const { d, repo } = await recorded();
    const t = await d.get<CellTimelineDTO>("/api/cells/w1/timeline");
    expect(kinds(t.items)).toEqual(["dispatch_brief", "tool_group", "assistant_reply", "user_chat", "assistant_reply", "tool_group", "artifact_event", "system_event", "system_event", "system_event"]);
    const [brief, group, said, steer, asked, saved, art] = t.items as [
      Extract<TimelineItemDTO, { kind: "dispatch_brief" }>,
      Extract<TimelineItemDTO, { kind: "tool_group" }>,
      Extract<TimelineItemDTO, { kind: "assistant_reply" }>,
      Extract<TimelineItemDTO, { kind: "user_chat" }>,
      Extract<TimelineItemDTO, { kind: "assistant_reply" }>,
      Extract<TimelineItemDTO, { kind: "tool_group" }>,
      Extract<TimelineItemDTO, { kind: "artifact_event" }>,
    ];
    expect(brief).toMatchObject({ fromLabel: "项目协调「支付重试改造」", text: "实现指数退避，跑通单测后提交" });
    expect(group).toMatchObject({ summary: "执行了 5 步操作：读取 3 个文件 · 修改 src/retry.ts · 运行 pnpm test（通过）", failed: 0 });
    expect(group.steps.map((s) => [s.name, s.brief, s.ok])).toEqual([
      ["Read", `${repo}/src/retry.ts`, true],
      ["Grep", "maxRetries", true],
      ["Read", `${repo}/src/backoff.ts`, true],
      ["Edit", `${repo}/src/retry.ts`, true],
      ["Bash", "pnpm test", true],
    ]);
    const bash = group.steps[4]!;
    expect(bash).toMatchObject({ durationMs: 4_200, spillUri: expect.stringMatching(/^res:\/\//) });
    expect(bash.output!.length).toBeLessThanOrEqual(1_201);
    expect(bash.output).not.toContain("characters are left out");
    expect(said).toMatchObject({ text: "已完成退避实现并提交 9f2c1，单测 14/14 通过。", toOwner: false, question: false });
    expect(steer).toMatchObject({ mode: "steer", text: "先别动对外 API", senderLabel: "你", direct: true, syncedTo: "支付重试改造" });
    // A message to the owner is a reply in the conversation, not a step.
    expect(asked).toMatchObject({ text: "最大重试次数要改成 3 吗？", toOwner: true, question: true });
    expect(saved).toMatchObject({ summary: "执行了 1 步操作：保存报告", steps: [{ name: "save_artifact" }] });
    expect(art).toMatchObject({ verb: "created", artifact: { artifactId: "art_r", title: "退避方案", version: 1 } });
    expect(JSON.stringify(t.items.map((i) => ("text" in i ? i.text : "summary" in i ? i.summary : "")))).not.toMatch(INTERNAL);

    expect(t.pendingQuestion).toEqual({ id: asked.id, text: "最大重试次数要改成 3 吗？" });
    expect(t.breadcrumb).toEqual([
      { cellId: "desk", label: "总助理" },
      { cellId: "proj", label: "支付重试改造" },
      { cellId: "w1", label: "分身：核心退避编码" },
    ]);
    expect(t).toMatchObject({ branch: "feat/retry", notes: null, unpulled: [], jobs: [], hasEarlier: false, firstSeq: brief.seq });
    expect(t.node).toMatchObject({ cellId: "w1", state: "dormant" });
    expect(t.artifacts).toEqual([{ artifactId: "art_r", title: "退避方案", version: 1, updatedAt: expect.any(Number) }]);
    expect(t.controls.map((b) => b.id)).toEqual(["pause", "cancel"]);
    expect(t.controls[1]).toMatchObject({ label: "■ 紧急叫停", confirm: expect.any(String), endpoint: { method: "POST", path: "/api/cells/w1/control", body: { action: "cancel" } } });
    expect(t.composer).toMatchObject({ mode: "wake", enabled: true, canSteer: false, syncTo: { cellId: "proj", title: "支付重试改造" } });

    // The full spilled output pages through /api/resources.
    const page = await d.get<ResourcePageDTO>(`/api/resources?uri=${encodeURIComponent(bash.spillUri!)}&offset=0&limit=5000`);
    expect(page).toMatchObject({ uri: bash.spillUri, offset: 0, limit: 5_000, hasMore: true });
    expect(page.content).toHaveLength(5_000);
    expect(page.totalChars).toBeGreaterThan(10_000);
  });

  it("pages: the newest N, older ones before a seq, newer ones after a seq (an open tool group is sent again whole)", async () => {
    const { d, k, add, env } = await recorded();
    const t = await d.get<CellTimelineDTO>("/api/cells/w1/timeline");
    const last3 = await d.get<CellTimelineDTO>("/api/cells/w1/timeline?limit=3");
    expect(kinds(last3.items)).toEqual(["system_event", "system_event", "system_event"]);
    expect(last3).toMatchObject({ hasEarlier: true, lastSeq: t.lastSeq });
    const older = await d.get<CellTimelineDTO>(`/api/cells/w1/timeline?beforeSeq=${last3.firstSeq}&limit=2`);
    expect(kinds(older.items)).toEqual(["tool_group", "artifact_event"]);
    const newer = await d.get<CellTimelineDTO>(`/api/cells/w1/timeline?afterSeq=${t.items[2]!.seq}`);
    expect(newer.items.map((i) => i.id)).toEqual(t.items.slice(3).map((i) => i.id));
    // Asked from the middle of a tool group: the whole group comes again, with the id the client already has.
    const mid = await d.get<CellTimelineDTO>(`/api/cells/w1/timeline?afterSeq=${(t.items[1] as { steps: Array<{ seq: number }> }).steps[2]!.seq}`);
    expect(mid.items[0]).toMatchObject({ id: t.items[1]!.id, kind: "tool_group", steps: expect.any(Array) });
    expect((await d.get<CellTimelineDTO>(`/api/cells/w1/timeline?afterSeq=${t.lastSeq}`)).items).toEqual([]);
    expect((await d.req("GET", "/api/cells/w1/timeline?afterSeq=-1")).status).toBe(400);
    expect((await d.req("GET", "/api/cells/nope/timeline")).status).toBe(404);

    // The owner answers: the question is no longer pending; the answer is the owner's bubble, under its own id.
    const payload: CellMessagePayload = { fromCellId: "owner", text: "改成 3", replyToId: t.pendingQuestion!.id };
    add({ kind: "inbound", envelope: env(PAYLOAD.cellMessage, payload, { id: "c-9", from: KERNEL_FROM.control, principalId: k.ownerPrincipal }) });
    const answered = await d.get<CellTimelineDTO>("/api/cells/w1/timeline");
    expect(answered.pendingQuestion).toBeNull();
    expect(answered.items.at(-1)).toMatchObject({ id: "c-9", kind: "user_chat", text: "改成 3", direct: true, replyToId: t.pendingQuestion!.id });
  });

  it("a project's header: its notes, what its workers did that it has not pulled yet; the parent's view of a settled turn", async () => {
    const d = await boot();
    const k = d.kernel;
    project(d, "proj", "支付重试改造");
    k.context.upsertSkillOrNoteSync("proj", { kind: "working_note", scope: "cell", name: "board", description: "白板", body: "- w1：退避已提交 9f2c1", mode: "upsert" });
    d.script.add("w1", { text: "退避已实现，提交 9f2c1" });
    worker(d, "w1", "proj", "核心退避编码", "实现指数退避");
    await k.idle();
    const t = await d.get<CellTimelineDTO>("/api/cells/proj/timeline");
    expect(t.notes).toBe("## board\n- w1：退避已提交 9f2c1");
    expect(t.unpulled).toEqual([{ cellId: "w1", title: "核心退避编码", count: expect.any(Number), preview: "退避已实现，提交 9f2c1", hadDirectUserChat: false }]);
    expect(of(t.items, "milestone").map((m) => m.text)).toEqual(["分身「核心退避编码」这一轮结束，项目已收到通知：退避已实现，提交 9f2c1"]);
    expect(t.composer).toMatchObject({ mode: "coordinator", enabled: true, syncTo: null });

    // The owner speaks to the worker: the project's record shows it in plain words once the copy is taken in.
    d.script.add("w1", { text: "好的" });
    await d.post("/api/cells/w1/messages", { text: "最大重试改成 3", clientId: "c-1", notifyParent: "wakeup" });
    await k.idle();
    const p = await d.get<CellTimelineDTO>("/api/cells/proj/timeline");
    expect(of(p.items, "system_event").map((e) => e.text)).toContain("你直接对分身「核心退避编码」说：最大重试改成 3");
  });

  it("the composer adapts: the desk, a script probe, an archived worker, a paused one", async () => {
    const d = await boot();
    const k = d.kernel;
    project(d, "proj", "支付重试改造");
    k.spawnCell("proj", { id: "probe", preset: "checker", title: "MR 探针", processor: { kind: "code", entry: "test.noop" }, lifetime: "persistent" });
    project(d, "old", "旧项目");
    worker(d, "ow", "old", "旧分身");
    worker(d, "wp", "proj", "暂停的分身");
    await k.closeCell("old", "completed");
    k.control("wp", { action: "pause" });

    const desk = await d.get<CellTimelineDTO>("/api/cells/desk/timeline");
    expect(desk.composer).toMatchObject({ mode: "desk", enabled: true, syncTo: null });
    expect(desk.controls).toEqual([]);
    const probe = await d.get<CellTimelineDTO>("/api/cells/probe/timeline");
    expect(probe.node).toMatchObject({ processorType: "code", canChat: false, engine: null, modelTier: null });
    expect(probe.composer).toMatchObject({ mode: "script", enabled: false, hint: "这是零算力确定性脚本探针，不接受自然语言对话" });
    expect(probe.composer.quick.map((b) => b.id)).toEqual(["trigger", "pause"]);
    const archived = await d.get<CellTimelineDTO>("/api/cells/ow/timeline");
    expect(archived.composer).toMatchObject({ mode: "archived", enabled: false, quick: [{ id: "open_desk", href: "#/agents/desk" }] });
    expect(archived.controls).toEqual([]);
    const paused = await d.get<CellTimelineDTO>("/api/cells/wp/timeline");
    expect(paused.composer).toMatchObject({ mode: "paused", enabled: true });
    expect(paused.controls.map((b) => b.id)).toEqual(["resume", "cancel"]);

    // "立即触发一次检查": the probe runs its check now.
    const runs = () => d.script.requests.filter(r => r.cellId === "probe").length;
    const before = runs();
    const r = await d.post<CellTriggerResponse>("/api/cells/probe/trigger");
    expect(r).toMatchObject({ ok: true, outcome: "triggered", message: "已触发一次检查" });
    await k.idle();
    expect(runs()).toBe(before); // a script: no model was asked
    expect(k.inbox.listMessagesSync({ cellId: "probe", type: PAYLOAD.timerFired })).toMatchObject([{ status: "done" }]);
    expect((await d.post<CellTriggerResponse>("/api/cells/proj/trigger")).outcome).toBe("not_applied");
  });
});

// ==================== messages and controls ====================

describe("POST /api/cells/:cellId/messages", () => {
  it("wakes a dormant worker on its record once per clientId, resolves the question it answers, copies it to the project", async () => {
    const d = await boot();
    const k = d.kernel;
    project(d, "proj", "支付重试改造");
    d.script.add("w1", { text: "退避已实现，最大重试 5 次可以吗？" });
    worker(d, "w1", "proj", "核心退避编码", "实现退避");
    await k.idle();
    const q = (await d.get<CellTimelineDTO>("/api/cells/w1/timeline")).pendingQuestion!;
    expect(q.text).toBe("退避已实现，最大重试 5 次可以吗？");

    let saw = "";
    d.script.add("w1", (req) => {
      saw = requestText(req);
      return { text: "改成 3 次了" };
    });
    const r = await d.post<SendCellMessageResponse>("/api/cells/w1/messages", { text: "改成 3", clientId: "c-1", replyToId: q.id });
    expect(r).toMatchObject({ ok: true, outcome: "delivered", id: "c-1", message: "已发送，分身已被唤醒；已同步给所属项目「支付重试改造」" });
    expect(r.timeline!.node.cellId).toBe("w1");
    expect(r.status.generatedAt).toBe(k.clock.now());
    expect((await d.post<SendCellMessageResponse>("/api/cells/w1/messages", { text: "改成 3", clientId: "c-1" })).outcome).toBe("duplicate");
    const [msg] = k.inbox.listMessagesSync({ cellId: "w1", envelopeId: "c-1" });
    expect(msg!.envelope).toMatchObject({ principalId: "owner", payload: { replyToId: q.id, replyToText: q.text, conversationId: "web" } });
    await k.idle();
    expect(saw).toContain("改成 3");
    const items = (await d.get<CellTimelineDTO>("/api/cells/w1/timeline")).items;
    expect(items.filter((i) => i.id === "c-1")).toMatchObject([{ kind: "user_chat", replyToId: q.id, syncedTo: "支付重试改造" }]);
    const copies = k.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.cellDirectChat });
    expect(copies.map((m) => m.envelope.delivery)).toEqual(["silent_inject"]);

    d.script.add("w1", { text: "加了" });
    const woke = await d.post<SendCellMessageResponse>("/api/cells/w1/messages", { text: "再加个测试", clientId: "c-2", notifyParent: "wakeup" });
    expect(woke.message).toContain("并唤醒了项目协调");
    expect(k.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.cellDirectChat }).map((m) => m.envelope.delivery)).toEqual(["silent_inject", "wakeup"]);
    await k.idle();
  });

  it("brings back a worker closed under an open project; refuses script probes and cells archived with their project; the desk takes a user message", async () => {
    const d = await boot();
    const k = d.kernel;
    project(d, "proj", "支付重试改造");
    d.script.add("w1", { text: "v1" });
    worker(d, "w1", "proj", "核心退避编码", "实现退避");
    k.spawnCell("proj", { id: "probe", preset: "checker", processor: { kind: "code", entry: "test.noop" }, lifetime: "persistent" });
    await k.idle();
    await k.closeCell("w1", "completed");
    d.script.add("w1", { text: "v2" });
    const back = await d.post<SendCellMessageResponse>("/api/cells/w1/messages", { text: "再改一处", clientId: "c-1" });
    expect(back).toMatchObject({ ok: true, outcome: "reopened", message: "分身已重新打开，会沿原上下文接着做；已同步给所属项目「支付重试改造」" });
    await k.idle();
    expect(k.getCell("w1")!.status).toBe("active");

    expect(await d.post<SendCellMessageResponse>("/api/cells/probe/messages", { text: "hi", clientId: "c-2" })).toMatchObject({ ok: false, outcome: "refused_script", message: expect.stringContaining("零算力确定性脚本探针") });
    await k.closeCell("proj", "completed");
    expect(await d.post<SendCellMessageResponse>("/api/cells/w1/messages", { text: "还在吗", clientId: "c-3" })).toMatchObject({ ok: false, outcome: "refused_archived", message: expect.stringContaining("已随所属项目归档") });
    expect(await d.post<SendCellMessageResponse>("/api/cells/nope/messages", { text: "x", clientId: "c-4" })).toMatchObject({ ok: false, outcome: "not_found", timeline: null });

    let saw = "";
    d.script.add("desk", (req) => {
      saw = requestText(req);
      return {};
    });
    expect(await d.post<SendCellMessageResponse>("/api/cells/desk/messages", { text: "帮我把支付重试改成指数退避", clientId: "d-1" })).toMatchObject({ outcome: "delivered", message: "已发给总助理" });
    expect(k.inbox.listMessagesSync({ cellId: "desk", envelopeId: "d-1" })[0]!.envelope).toMatchObject({ type: PAYLOAD.userMessage, principalId: "owner", from: KERNEL_FROM.control });
    await k.idle();
    expect(saw).toContain("帮我把支付重试改成指数退避");
    expect(of((await d.get<CellTimelineDTO>("/api/cells/desk/timeline")).items, "user_chat")).toMatchObject([{ id: "d-1", senderLabel: "你", direct: true, syncedTo: null }]);

    for (const bad of [{ text: "", clientId: "x" }, { text: "x" }, { text: "x", clientId: "has space" }, { text: "x", clientId: "x", mode: "shout" }, { text: "x", clientId: "x", notifyParent: "loud" }]) {
      expect((await d.req("POST", "/api/cells/desk/messages", bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("POST /api/cells/:cellId/control", () => {
  it("pauses, resumes and stops a worker; a project goes through its own buttons; the desk is never stopped", async () => {
    const d = await boot();
    const k = d.kernel;
    project(d, "proj", "支付重试改造");
    worker(d, "w1", "proj", "核心退避编码");
    const p = await d.post<CellControlResponse>("/api/cells/w1/control", { action: "pause" });
    expect(p).toMatchObject({ ok: true, outcome: "paused", message: "已暂停「核心退避编码」", node: { cellId: "w1", state: "paused" } });
    expect((await d.post<CellControlResponse>("/api/cells/w1/control", { action: "resume" })).outcome).toBe("resumed");
    const c = await d.post<CellControlResponse>("/api/cells/w1/control", { action: "cancel" });
    expect(c).toMatchObject({ ok: true, outcome: "cancelled", node: { state: "archived" } });
    expect(c.message).toContain("文件和分支都留在原处");
    expect(k.getCell("w1")).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect((await d.post<CellControlResponse>("/api/cells/w1/control", { action: "pause" })).outcome).toBe("not_applied");

    expect(await d.post<CellControlResponse>("/api/cells/desk/control", { action: "cancel" })).toMatchObject({ ok: false, outcome: "not_applied" });
    expect(k.getCell("desk")!.status).toBe("active");
    expect((await d.post<CellControlResponse>("/api/cells/proj/control", { action: "pause" })).outcome).toBe("paused");
    const stop = await d.post<CellControlResponse>("/api/cells/proj/control", { action: "cancel" });
    expect(stop.outcome).toBe("cancelled");
    expect(k.context.readStateSync<ProjectRecord>("proj", gtdKeys.project)!.lifecycle).toBe("cancelled");
    expect((await d.post<CellControlResponse>("/api/cells/nope/control", { action: "pause" })).outcome).toBe("not_found");
    expect((await d.req("POST", "/api/cells/proj/control", { action: "explode" })).status).toBe(400);
  });
});

describe("GET /api/resources", () => {
  it("pages through a spilled output (limit capped at 64000); only res:// URIs; unknown ones are 404", async () => {
    const d = await boot();
    const uri = d.kernel.context.writeResourceSync("desk", "0123456789".repeat(7_000));
    const first = await d.get<ResourcePageDTO>(`/api/resources?uri=${encodeURIComponent(uri)}&limit=100000`);
    expect(first).toMatchObject({ uri, offset: 0, limit: 64_000, totalChars: 70_000, hasMore: true });
    expect(first.content).toHaveLength(64_000);
    const rest = await d.get<ResourcePageDTO>(`/api/resources?uri=${encodeURIComponent(uri)}&offset=64000`);
    expect(rest).toMatchObject({ offset: 64_000, limit: 16_000, hasMore: false });
    expect(rest.content).toHaveLength(6_000);
    expect((await d.req("GET", `/api/resources?uri=${encodeURIComponent("reference://x")}`)).status).toBe(400);
    expect((await d.req("GET", `/api/resources?uri=${encodeURIComponent("res://desk/nope")}`)).status).toBe(404);
  });
});

// ==================== live tail ====================

describe("SSE: cell_tail", () => {
  it("coalesces new records per cell (latest seq wins), and leaves no timer behind on close", async () => {
    const bus = createBus();
    const hub = createEventHub({ bus }, { debounceMs: 20 });
    const seen: DeskEvent[] = [];
    hub.subscribe((e) => seen.push(e));
    for (const seq of [11, 12, 13]) bus.emit("evidence.appended", { cellId: "w1", seq, kind: "tool_call", runId: "r" });
    bus.emit("evidence.appended", { cellId: "w2", seq: 14, kind: "assistant_text", runId: "r" });
    await sleep(60);
    expect(seen.filter((e) => e.event === "cell_tail")).toEqual([
      { event: "cell_tail", data: { cellId: "w1", lastSeq: 13 } },
      { event: "cell_tail", data: { cellId: "w2", lastSeq: 14 } },
    ]);
    // Changes behind the Agents view refresh it.
    bus.emit("cell.changed", { cellId: "w1", change: "status", status: "paused" });
    await sleep(60);
    expect(seen.at(-1)).toMatchObject({ event: "refresh", data: { views: expect.arrayContaining(["agents"]) } });
    bus.emit("evidence.appended", { cellId: "w1", seq: 15, kind: "tool_result", runId: "r" });
    hub.close();
    await sleep(60);
    expect(seen.filter((e) => e.event === "cell_tail")).toHaveLength(2);
  });
});

// ==================== Radar and BUG-011 ====================

describe("Radar: reports and the way into the Agents view (BUG-010); BUG-011", () => {
  it("a project's row lists its reports (its workers' too, newest first) and its cells; a dormant worker is resting", async () => {
    const d = await boot();
    const k = d.kernel;
    project(d, "proj", "竞品调研");
    k.context.commitSync("proj", { artifact: { artifactId: "art_plan", content: { format: "markdown", title: "调研计划", body: "x" }, updatedBy: "agent" } });
    d.clock.advance(1_000);
    d.script.add("w1", tool("save_artifact", { artifactId: "art_w", title: "竞品调研报告", body: "A、B、C 三家" }), { text: "报告写好了" });
    worker(d, "w1", "proj", "调研 A", "调研三家");
    await k.idle();
    worker(d, "w2", "proj", "调研 B");
    await k.closeCell("w2", "completed");
    const row = (await d.get<RadarDTO>("/api/radar")).projects[0]!;
    expect(row.artifacts.map((a) => [a.artifactId, a.title, a.version])).toEqual([
      ["art_w", "竞品调研报告", 1],
      ["art_plan", "调研计划", 1],
    ]);
    expect(row.agents).toEqual({ total: 1, running: 0, href: "#/agents?project=proj", label: "1 个分身 →" });
    expect(row.workers).toMatchObject([{ cellId: "w1", state: "idle" }]);
    // Any of them opens in the shared report drawer.
    expect((await d.get<{ body: string; title: string }>("/api/artifacts/art_w")).body).toBe("A、B、C 三家");
  });

  it("011.1: the waiting ball says 等待外部 and what is awaited; 011.2: the weekly review lists deliveries and the owner's own work only", async () => {
    const d = await boot();
    const k = d.kernel;
    project(d, "proj", "发版");
    k.spawnCell("proj", { id: "wt", preset: "checker", title: "等 CI", lifetime: "one_shot", schedules: [{ deliverAt: k.clock.now() + HOUR }] });
    const row = (await d.get<RadarDTO>("/api/radar")).projects[0]!;
    expect(row.ball).toMatchObject({ owner: "waiting", label: "🟡 等待外部", text: expect.stringMatching(/^「等 CI」下次检查 /) });

    const t = k.clock.now();
    writeAction(k, "proj", { title: "派 worker 改代码", owner: "agent", status: "done", completedAt: t - HOUR });
    writeAction(k, "proj", { title: "等 CI 绿", owner: "waiting", status: "done", completedAt: t - HOUR });
    writeAction(k, "proj", { title: "和老板对齐范围", owner: "human", status: "done", completedAt: t - HOUR });
    project(d, "done", "旧项目");
    writeProject(k, "done", { title: "旧项目", lifecycle: "completed", completedAt: t - 2 * HOUR });
    const review = projectReview(inputOf(k, { ...DEFAULT_SETTINGS }));
    expect(review.completed.map((c) => [c.kind, c.title])).toEqual([
      ["action", "和老板对齐范围"],
      ["project", "旧项目"],
    ]);
  });

  it("011.3: a parked project is not also paused — no double badge, not counted as paused; get_project says activate", async () => {
    const d = await boot({ agentTokens: { main: AGENT_TOKEN } });
    const k = d.kernel;
    project(d, "park", "极简模式");
    project(d, "hold", "周报");
    expect((await d.post<ProjectMutationResponse>("/api/projects/park/someday")).outcome).toBe("someday");
    expect(k.getCell("park")!.status).toBe("paused");
    let radar = await d.get<RadarDTO>("/api/radar");
    expect(radar.someday).toMatchObject([{ id: "park", lifecycle: "someday", paused: false }]);
    expect((await d.get<StatusDTO>("/api/status")).background.paused).toBe(0);
    await d.post("/api/projects/hold/pause");
    radar = await d.get<RadarDTO>("/api/radar");
    expect(radar.projects).toMatchObject([{ id: "hold", paused: true }]);
    expect((await d.get<StatusDTO>("/api/status")).background.paused).toBe(1);
    const got = await agentOk(d, "get_project", { id: "park" });
    expect(got.text).toContain("以后再说（停靠中");
    expect(got.text).toContain("set_project_state activate，不是 resume");
    expect(got.text).not.toMatch(/状态：someday；paused/);
  });
});

// ==================== the external agent ====================

describe("control plane: chat_with_desk, message_cell, inspect_cell, read_resource / read_artifact paging, get_project", () => {
  it("chat_with_desk: the owner's words reach the desk as the agent's; its replies are read back from a cursor; an answer carries replyToId", async () => {
    const d = await boot({ agentTokens: { main: AGENT_TOKEN } });
    const k = d.kernel;
    d.script.add("desk", tool("send_message", { to: "channel:ui:owner", text: "代码在哪个本地目录下呀？", summary: "问路径" }));
    const sent = await agentOk(d, "chat_with_desk", { text: "帮我把支付重试改成指数退避" });
    expect(sent.text).toContain("Passed to the desk as the owner's words");
    expect(sent.text).toContain("No reply from the desk yet");
    const { cursor, messageId } = sent.data as { cursor: number; messageId: string };
    expect(k.inbox.listMessagesSync({ cellId: "desk", envelopeId: messageId })[0]!.envelope).toMatchObject({
      type: PAYLOAD.userMessage,
      principalId: "agent:main",
      payload: { text: "帮我把支付重试改成指数退避", conversationId: "agent:main" },
    });
    await k.idle();
    const read = await agentOk(d, "chat_with_desk", { since: cursor });
    const replies = (read.data as { replies: Array<{ id: string; text: string; question: boolean; toOwner: boolean }> }).replies;
    expect(replies).toEqual([expect.objectContaining({ text: "代码在哪个本地目录下呀？", question: true, toOwner: true })]);
    expect(read.text).toContain(`answer with replyToId ${replies[0]!.id}`);

    let saw = "";
    d.script.add("desk", (req) => {
      saw = requestText(req);
      return {};
    });
    await agentOk(d, "chat_with_desk", { text: "在 ~/dev/pay-core", replyToId: replies[0]!.id });
    await k.idle();
    expect(saw).toContain("在 ~/dev/pay-core");
    expect(saw).toContain("代码在哪个本地目录下呀？");
    // The desk's own record shows who said it.
    expect(of((await d.get<CellTimelineDTO>("/api/cells/desk/timeline")).items, "user_chat").map((c) => c.senderLabel)).toEqual(["你（经主 Agent）", "你（经主 Agent）"]);
    expect((await agentRefused(d, "chat_with_desk", {})).text).toContain("Give text");
  });

  it("message_cell wakes a dormant worker and says its project got a copy; refusals are plain; inspect_cell reads without moving the project's cursor", async () => {
    const d = await boot({ agentTokens: { main: AGENT_TOKEN } });
    const k = d.kernel;
    project(d, "proj", "支付重试改造");
    d.script.add("w1", { text: "退避已实现" });
    worker(d, "w1", "proj", "核心退避编码", "实现指数退避");
    k.spawnCell("proj", { id: "probe", preset: "checker", processor: { kind: "code", entry: "test.noop" }, lifetime: "persistent" });
    await k.idle();
    d.script.add("w1", { text: "改成 3 次了" });
    const r = await agentOk(d, "message_cell", { id: "w1", text: "最大重试改成 3" });
    expect(r.text).toContain("w1 was dormant and is woken by it");
    expect(r.text).toContain("Its project proj「支付重试改造」 was given a copy of the owner's words");
    expect(k.inbox.listMessagesSync({ cellId: "proj", type: PAYLOAD.cellDirectChat })[0]!.envelope.principalId).toBe("agent:main");
    await k.idle();
    expect((await agentRefused(d, "message_cell", { id: "probe", text: "hi" })).text).toContain("deterministic script probe");
    expect((await agentRefused(d, "message_cell", { id: "nope", text: "hi" })).text).toContain('there is no cell "nope"');

    const seen = await agentOk(d, "inspect_cell", { id: "w1" });
    expect(seen.text).toContain("实现指数退避");
    expect(seen.text).toContain("the owner, directly (agent:main): 最大重试改成 3");
    expect(k.context.readStateSync("proj", pullCursorKey("w1"))).toBeNull();

    // get_project shows what the project has not taken in yet, read live; once it pulls, the section is gone.
    const got = await agentOk(d, "get_project", { id: "proj" });
    expect(got.text).toContain("尚未汇总至项目的 Worker 最新动态");
    expect(got.text).toContain("最大重试改成 3");
    expect(got.data).toMatchObject({ unpulled: [{ cellId: "w1" }], cells: expect.arrayContaining([expect.objectContaining({ id: "w1", state: "待命可唤醒" })]) });
    d.script.add("project", tool("inspect_cell", { cellId: "w1" }));
    k.sendToCell("proj", { text: "看看 w1" }, { principalId: "cell:desk" });
    await k.idle();
    expect((await agentOk(d, "get_project", { id: "proj" })).text).not.toContain("尚未汇总至项目的 Worker 最新动态");

    await k.closeCell("proj", "completed");
    expect((await agentRefused(d, "message_cell", { id: "w1", text: "还在吗" })).text).toContain("archived with a project that has finished");
  });

  it("read_resource and read_artifact page through long text; versions can be read", async () => {
    const d = await boot({ agentTokens: { main: AGENT_TOKEN } });
    const k = d.kernel;
    const uri = k.context.writeResourceSync("desk", "a".repeat(10_000) + "b".repeat(10_000));
    const p1 = await agentOk(d, "read_resource", { uri });
    expect(p1.text).toContain(`${uri} — characters 0–8000 of 20000; the rest: read_resource { uri, offset: 8000 }`);
    expect(p1.data).toMatchObject({ offset: 0, totalChars: 20_000, hasMore: true });
    const p3 = await agentOk(d, "read_resource", { uri, offset: 16_000, limit: 10_000 });
    expect(p3.data).toMatchObject({ hasMore: false });
    expect(p3.text).toContain("(to the end)");
    expect((await agentRefused(d, "read_resource", { uri: "res://desk/nope" })).text).toContain("Not found");

    k.context.commitSync("desk", { artifact: { artifactId: "art_big", content: { format: "markdown", title: "大报告", body: "v1 body" }, updatedBy: "agent" } });
    k.context.commitSync("desk", { artifact: { artifactId: "art_big", content: { format: "markdown", title: "大报告", body: "x".repeat(30_000) }, updatedBy: "agent", expectedVersion: 1 } });
    const a = await agentOk(d, "read_artifact", { id: "art_big", limit: 10_000 });
    expect(a.text).toContain("artifact art_big v2「大报告」");
    expect(a.text).toContain('characters 0–10000 of 30000; the rest: read_artifact { id: "art_big", offset: 10000 }');
    expect(a.data).toMatchObject({ version: 2, hasMore: true, totalChars: 30_000 });
    const old = await agentOk(d, "read_artifact", { id: "art_big", version: 1 });
    expect(old.text).toContain("artifact art_big v1「大报告」");
    expect(old.text).toContain("（当前版本是 v2）");
    expect(old.text).toContain("v1 body");
    expect((await agentRefused(d, "read_artifact", { id: "art_big", version: 7 })).text).toContain("has no version 7");
  });

});

