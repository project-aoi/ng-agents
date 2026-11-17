import { describe, expect, it } from "vitest";
import {
  asClarifyCard,
  CELL_STATUS_KEY,
  createEnvelope,
  makeBounds,
  PAYLOAD,
  type ChannelSendAction,
  type Envelope,
  type ProposedAction,
  type ToolContext,
  type ToolDef,
} from "@ng/protocol";
import { createFakeRun, type FakeRun, type FakeRunOptions } from "../src/testing";
import { clock, makeRegistry } from "./helpers";

const registry = makeRegistry();

function tool(name: string): ToolDef {
  for (const ts of registry.toolsets.list()) {
    const t = ts.tools.find((x) => x.name === name);
    if (t) return t;
  }
  throw new Error(`no tool ${name}`);
}

let callCounter = 0;
async function invoke(run: FakeRun, name: string, input: unknown) {
  const ctx: ToolContext = { ports: run.ports, snapshot: run.snapshot, signal: run.controller.signal, toolUseId: `tu_${++callCounter}`, clock: c };
  const r = await tool(name).handler(input, ctx);
  return typeof r === "string" ? { output: r } : r;
}

const c = clock();
const fakeRun = (o: FakeRunOptions = {}) => createFakeRun({ clock: c, ...o });

const feishuMessage: Envelope = createEnvelope(
  {
    id: "env_feishu_1",
    from: "channel:feishu:oc_group",
    principalId: "feishu:ou_zhang",
    kind: "event",
    type: "user.message",
    payload: { text: "方案什么时候能好？" },
    threads: ["feishu:oc_group"],
  },
  c,
);

describe("kernel.comms send_message", () => {
  it("notifies the owner directly (notify_owner, token, idempotency key) without creating a draft", async () => {
    const run = fakeRun({ batch: ["提醒我下午三点开会"] });
    const r = await invoke(run, "send_message", { to: "channel:ui:owner", text: "三点有会", summary: "会议提醒" });
    expect(r.output).toBe("Sent.");
    const action = run.ports.log.authorizations[0]!.action as ChannelSendAction;
    expect(action).toMatchObject({ type: "channel.send", sideEffect: "notify_owner", target: "channel:ui:owner", subjectKey: "msg:env_1" });
    expect(action.card).toBeUndefined();
    expect(run.ports.artifacts.size).toBe(0);
    const send = run.ports.log.sends[0]!;
    expect(send).toMatchObject({ target: "channel:ui:owner", actionToken: "tok_1", respectDnd: true, content: { format: "text", body: "三点有会" } });
    expect(send.idempotencyKey).toMatch(/^run_1:tu_/);
  });

  it("sends outward as a versioned draft with a response card bound to that version", async () => {
    const run = fakeRun({ batch: [feishuMessage] });
    const r = await invoke(run, "send_message", {
      to: "channel:feishu:oc_group",
      text: "周五前给你初稿。",
      summary: "回复张三方案进度",
      targetLabel: "研发群（飞书）",
      prep: { summary: "查了排期表", checked: [{ label: "排期", uri: "note://schedule" }] },
    });
    expect(r.endRun).toBe("deferred_for_approval");
    const { action, opts } = run.ports.log.authorizations[0]!;
    const send = action as ChannelSendAction;
    expect(send.sideEffect).toBe("external");
    expect(send.artifactId).toMatch(/^art_/);
    expect(opts).toEqual({ artifactVersion: 1 });
    expect(run.ports.artifacts.get(send.artifactId!)!.content.body).toBe("周五前给你初稿。");
    const card = asClarifyCard(send.card?.data);
    expect(card).toMatchObject({
      cardType: "response",
      subjectKey: "msg:env_feishu_1",
      source: { label: "飞书", channelId: "feishu", principalId: "feishu:ou_zhang", envelopeId: "env_feishu_1" },
      rawInput: { text: "方案什么时候能好？", kind: "message" },
      prep: { summary: "查了排期表", checked: [{ label: "排期", uri: "note://schedule" }] },
      draft: { artifactId: send.artifactId, version: 1 },
      reply: { target: "channel:feishu:oc_group", targetLabel: "研发群（飞书）" },
      confirmVerb: "send",
    });
    expect(run.ports.log.sends).toHaveLength(0);
  });

  it("sends the current (human-edited) version of an existing draft and binds the approval to it", async () => {
    const run = fakeRun({ batch: [feishuMessage] });
    await invoke(run, "save_artifact", { artifactId: "art_reply", body: "初稿" });
    run.ports.humanEdit("art_reply", "人工改过的稿");
    await invoke(run, "send_message", { to: "channel:feishu:oc_group", artifactId: "art_reply", summary: "回复" });
    const { action, opts } = run.ports.log.authorizations[0]!;
    expect((action as ChannelSendAction).content!.body).toBe("人工改过的稿");
    expect(opts).toEqual({ artifactVersion: 2 });
  });

  it("builds an escalation card for a timeout nudge and reports receipts honestly when allowed", async () => {
    const run = fakeRun({
      batch: [feishuMessage],
      authorize: () => ({ type: "allow", actionToken: "tok_rule" }),
      notify: () => "unknown",
    });
    const r = await invoke(run, "send_message", {
      to: "channel:feishu:ou_c",
      text: "您好，报价方便今天发一下吗？",
      summary: "催供应商 C",
      nudge: { explanation: "供应商 C 已超时 1 天未回" },
    });
    const send = run.ports.log.authorizations[0]!.action as ChannelSendAction;
    expect(asClarifyCard(send.card?.data)).toMatchObject({
      cardType: "escalation",
      escalation: { reason: "waiting_timeout", nudgeTarget: "channel:feishu:ou_c", nudgeDraft: { version: 1 } },
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("Do not resend");
  });

  it("rejects non-channel targets and ambiguous content", async () => {
    const run = fakeRun();
    expect((await invoke(run, "send_message", { to: "inbox:desk", text: "x", summary: "s" })).isError).toBe(true);
    expect((await invoke(run, "send_message", { to: "channel:ui:owner", summary: "s" })).isError).toBe(true);
  });

  it("uses the project subject inside a project", async () => {
    const run = fakeRun({ spec: { meta: { projectCellId: "proj_1" } }, batch: [feishuMessage] });
    await invoke(run, "send_message", { to: "channel:ui:owner", text: "进度 2/3", summary: "进度" });
    expect(run.ports.log.authorizations[0]!.action.subjectKey).toBe("project:proj_1");
  });
});

describe("kernel.comms request_approval / report_to_parent / handback / wait", () => {
  it("proposes a project as a project.start action with a json draft and a proposal card", async () => {
    const run = fakeRun({ batch: [feishuMessage] });
    const r = await invoke(run, "request_approval", {
      kind: "project",
      title: "支付报错排查",
      summary: "立项：支付报错",
      proposal: {
        outcome: "支付成功率恢复到 99.9%",
        actions: [
          { title: "复现并定位报错", owner: "agent" },
          { title: "确认回滚窗口", owner: "human", effort: "15m", nextStep: "问运维值班" },
        ],
      },
    });
    expect(r.endRun).toBe("deferred_for_approval");
    const { action, opts } = run.ports.log.authorizations[0]!;
    expect(action).toMatchObject({ type: "project.start", sideEffect: "external", proposal: { title: "支付报错排查", actions: [{ owner: "agent" }, { owner: "human" }] } });
    const card = asClarifyCard(action.card?.data);
    expect(card?.cardType).toBe("project_proposal");
    const draftId = card?.cardType === "project_proposal" ? card.draft?.artifactId : undefined;
    expect(run.ports.artifacts.get(draftId!)!.content.format).toBe("json");
    expect(opts).toEqual({ artifactVersion: 1 });
    expect(action.artifactId).toBe(draftId);
  });

  it("goes ahead immediately when a standing rule allows the request", async () => {
    const run = fakeRun({ authorize: () => ({ type: "allow", actionToken: "tok" }) });
    const r = await invoke(run, "request_approval", { kind: "action", title: "合并 PR #108", summary: "merge #108", action: { name: "merge_pr", args: { pr: 108 } } });
    expect(r.output).toContain("go ahead");
    expect(r.endRun).toBeUndefined();
    expect(run.ports.log.authorizations[0]!.action).toMatchObject({ type: "custom", name: "merge_pr", args: { pr: 108 }, sideEffect: "external" });
  });

  it("escalates as a custom action with an escalation card", async () => {
    const run = fakeRun();
    await invoke(run, "request_approval", { kind: "escalation", title: "CI 连续失败", summary: "CI 卡住", escalation: { reason: "retry_limit", explanation: "已修 3 轮仍失败" } });
    const action = run.ports.log.authorizations[0]!.action as Extract<ProposedAction, { type: "custom" }>;
    expect(action.name).toBe("escalation.retry_limit");
    expect(asClarifyCard(action.card?.data)).toMatchObject({ cardType: "escalation", escalation: { reason: "retry_limit" } });
  });

  it("reports results and silent progress to the parent and updates the roster status line", async () => {
    const run = fakeRun({ cellId: "w1" });
    await invoke(run, "report_to_parent", { kind: "progress", text: "报价已回 2/3", progress: { done: 2, total: 3 } });
    await invoke(run, "report_to_parent", { kind: "result", text: "三家报价已收齐，C 最低", artifactId: "art_cmp" });
    expect(run.ports.log.emitted).toEqual([
      { type: PAYLOAD.cellProgress, payload: { childCellId: "w1", text: "报价已回 2/3", progress: { done: 2, total: 3 } }, opts: { delivery: "silent_inject" } },
      { type: PAYLOAD.cellResult, payload: { childCellId: "w1", status: "completed", summary: "三家报价已收齐，C 最低", artifactId: "art_cmp" } },
    ]);
    expect(run.ports.state.get(CELL_STATUS_KEY)).toMatchObject({ text: "三家报价已收齐，C 最低" });
  });

  it("hands back through the kernel port when present, else commits the handback envelope to the desk", async () => {
    const withPort = fakeRun({ cellId: "watch1", batch: [feishuMessage] });
    const calls: Array<[string, string]> = [];
    Object.assign(withPort.ports, { handback: async (id: string, reason: string) => void calls.push([id, reason]) });
    await invoke(withPort, "handback", { reason: "新问题，与报价无关" });
    expect(calls).toEqual([["env_feishu_1", "新问题，与报价无关"]]);

    const fallback = fakeRun({ cellId: "watch1", batch: [feishuMessage] });
    await invoke(fallback, "handback", { reason: "新问题" });
    const out = fallback.ports.log.inboxOut[0]!;
    expect(out.to).toBe("inbox:desk");
    expect(out.envelope).toMatchObject({
      id: "env_feishu_1#handback#watch1",
      type: "handback",
      principalId: "feishu:ou_zhang",
      payload: { fromCellId: "watch1", reason: "新问题", original: { id: "env_feishu_1" } },
    });
  });

  it("wait ends the run as yielded_waiting", async () => {
    expect(await invoke(fakeRun(), "wait", { reason: "nothing new" })).toMatchObject({ endRun: "yielded_waiting" });
  });
});

describe("kernel.context", () => {
  it("creates, revises and reports a human conflict without overwriting (agent text is parked)", async () => {
    const run = fakeRun();
    const created = await invoke(run, "save_artifact", { title: "周报", body: "v1" });
    const id = (created.data as { artifactId: string }).artifactId;
    expect(created.output).toBe(`Saved ${id} v1.`);
    expect((await invoke(run, "save_artifact", { artifactId: id, expectedVersion: 1, body: "v2" })).output).toBe(`Saved ${id} v2.`);
    run.ports.humanEdit(id, "人工 v3");
    const conflict = await invoke(run, "save_artifact", { artifactId: id, expectedVersion: 2, body: "agent v3" });
    expect(conflict.isError).toBe(true);
    expect(conflict.output).toContain("at v3 (last edited by human)");
    expect(conflict.output).toContain("人工 v3");
    expect(run.ports.artifacts.get(id)!.content.body).toBe("人工 v3");
    expect(run.ports.log.parked).toHaveLength(1);
    const read = await invoke(run, "read_artifact", { artifactId: id });
    expect(read.output).toContain(`${id} v3 (last edited by human)`);
  });

  it("reads/writes state, notes, skills, search and resources", async () => {
    const run = fakeRun();
    await invoke(run, "set_state", { patches: { "gtd:action:a1": { title: "x" }, tmp: 1 } });
    await invoke(run, "set_state", { patches: { tmp: null } });
    expect(await invoke(run, "read_state", { prefix: "gtd:" })).toMatchObject({ output: expect.stringContaining('"title": "x"') });
    expect((await invoke(run, "read_state", { key: "tmp" })).output).toBe("tmp: (not set)");
    await invoke(run, "save_note", { name: "reading-list", body: "https://example.com/a\n更多", append: true });
    await invoke(run, "save_note", { name: "tone", body: "回复同事用简短中文", kind: "preference" });
    await invoke(run, "save_skill", { name: "weekly-review", description: "每周五回顾时用", body: "1. ..." });
    expect(run.ports.log.knowledge).toEqual([
      { kind: "note", name: "reading-list", body: "https://example.com/a\n更多", description: "https://example.com/a", scope: "cell", mode: "append" },
      { kind: "preference", name: "tone", body: "回复同事用简短中文", description: "回复同事用简短中文", scope: "global", mode: "upsert" },
      { kind: "skill", name: "weekly-review", description: "每周五回顾时用", body: "1. ...", scope: "global", mode: "upsert" },
    ]);
    expect((await invoke(run, "save_skill", { name: "Bad Name", description: "d", body: "b" })).isError).toBe(true);
    run.ports.resources.set("res://cell1/r1", "abcdefghij");
    expect((await invoke(run, "read_resource", { uri: "res://cell1/r1", offset: 2, limit: 3 })).output).toBe("cde");
  });
});

describe("kernel.cells", () => {
  it("spawns from preset defaults with the model's overrides and converts bounds, watches and schedules", async () => {
    const run = fakeRun();
    const r = await invoke(run, "spawn_cell", {
      preset: "worker",
      title: "修复 PR #108 CI",
      instruction: "修好 CI 并汇报",
      modelTier: "fast",
      contextMode: "fork_prefix",
      bounds: { tools: ["read", "edit", "bash"], canSendTo: ["inbox:cell1"], maxTokens: 200000 },
      watches: [{ thread: "github:org/repo#108", cancelGroup: "pr108" }],
      schedules: [{ at: "2026-11-18T09:00:00+08:00" }],
      workspace: { repoPath: "/repos/app" },
    });
    expect(r.output).toContain("inbox:child_1");
    const { spec, initialPayload } = run.ports.log.spawned[0]!;
    expect(initialPayload).toBe("修好 CI 并汇报");
    expect(spec).toMatchObject({
      preset: "worker",
      title: "修复 PR #108 CI",
      contextMode: "fork_prefix",
      processor: { kind: "llm", modelTier: "fast", toolsets: ["workspace", "kernel.comms"], maxSteps: 40 },
      watches: [{ threadOrFilter: { thread: "github:org/repo#108" }, cancelGroup: "pr108" }],
      schedules: [{ deliverAt: Date.parse("2026-11-18T01:00:00Z") }],
      meta: { workspace: { repoPath: "/repos/app" } },
    });
    expect([...spec.bounds!.tools!]).toEqual(["read", "edit", "bash"]);

    await invoke(run, "spawn_cell", { preset: "sensor", title: "指标巡检", instruction: "每天 9 点查", input: { metric: "pay_success" } });
    expect(run.ports.log.spawned[1]).toMatchObject({
      spec: { processor: { kind: "code", entry: "script:checks/metrics.sh" } },
      initialPayload: { instruction: "每天 9 点查", input: { metric: "pay_success" } },
    });
    expect((await invoke(run, "spawn_cell", { preset: "watcher", title: "t", instruction: "i" })).isError).toBe(true);
    // thrown errors become isError results inside the loop
    await expect(invoke(run, "spawn_cell", { preset: "worker", title: "t", instruction: "i", bounds: { canSendTo: ["nope"] } })).rejects.toThrow(
      "not addresses: nope",
    );
  });

  it("steers, pauses and closes children", async () => {
    const run = fakeRun();
    await invoke(run, "control_cell", { cellId: "w1", action: "steer", message: "先修单测" });
    await invoke(run, "control_cell", { cellId: "w1", action: "pause" });
    expect((await invoke(run, "control_cell", { cellId: "w1", action: "steer" })).isError).toBe(true);
    await invoke(run, "close_cell", { cellId: "w1", reason: "cancelled" });
    await invoke(run, "update_cell", { cellId: "w1", title: "新标题" });
    expect(run.ports.log.controls).toEqual([
      { cellId: "w1", action: "steer", steerMessage: "先修单测" },
      { cellId: "w1", action: "pause" },
    ]);
    expect(run.ports.log.closed).toEqual([{ cellId: "w1", reason: "cancelled" }]);
    expect(run.ports.log.updated).toEqual([{ cellId: "w1", patch: { title: "新标题" } }]);
  });

  it("is unavailable without spawn depth", () => {
    const t = tool("spawn_cell");
    expect(t.availableFor!({ bounds: makeBounds({ maxDepth: 0 }) })).toBe(false);
    expect(t.availableFor!({ bounds: makeBounds({ maxDepth: 1 }) })).toBe(true);
  });
});

describe("kernel.schedule", () => {
  it("sets one-shot and cron reminders on the cell's own inbox and cancels by group", async () => {
    const run = fakeRun();
    const r1 = await invoke(run, "set_reminder", { label: "给牙医打电话", at: "2026-11-20T15:00:00+08:00", subjectKey: "msg:env_1" });
    expect(r1.output).toBe("Reminder set for 2026-11-20T07:00:00.000Z.");
    await invoke(run, "set_reminder", { label: "催报价", inSeconds: 3600, cancelGroup: "quotes" });
    await invoke(run, "set_reminder", { label: "周一看指标", cron: "0 9 * * 1", tz: "Asia/Shanghai", id: "weekly" });
    expect((await invoke(run, "set_reminder", { label: "周一看指标", cron: "0 9 * * 1", id: "weekly" })).output).toContain("Already set");
    expect((await invoke(run, "set_reminder", { label: "x" })).isError).toBe(true);
    expect((await invoke(run, "set_reminder", { label: "x", at: "next friday" })).isError).toBe(true);
    expect(run.ports.log.scheduled).toEqual([
      { env: { type: "timer.fired", payload: { label: "给牙医打电话", subjectKey: "msg:env_1" } }, rule: { deliverAt: Date.parse("2026-11-20T07:00:00Z") } },
      { env: { type: "timer.fired", payload: { label: "催报价" } }, rule: { cancelGroup: "quotes", deliverAt: c.now() + 3_600_000 } },
      { env: { type: "timer.fired", payload: { label: "周一看指标" }, id: "weekly" }, rule: { cron: "0 9 * * 1", tz: "Asia/Shanghai" } },
    ]);
    await invoke(run, "cancel_scheduled", { cancelGroup: "quotes" });
    expect(run.ports.log.cancelled).toEqual([{ cellId: "cell1", cancelGroup: "quotes" }]);
  });
});

describe("workspace", () => {
  it("validates read ops and forwards exec, surfacing non-zero exit codes", async () => {
    const run = fakeRun({ exec: (t) => (t === "bash" ? { output: "1 failed", exitCode: 1 } : { output: "file text" }) });
    expect((await invoke(run, "read", { op: "read_file", path: "src/a.ts", limit: 20 })).output).toBe("file text");
    expect((await invoke(run, "read", { op: "search" })).isError).toBe(true);
    expect((await invoke(run, "bash", { command: "pnpm test" })).output).toBe("1 failed\n[exit code 1]");
    expect(run.ports.log.execs).toEqual([
      { tool: "read", args: { op: "read_file", path: "src/a.ts", limit: 20 } },
      { tool: "bash", args: { command: "pnpm test" } },
    ]);
    const started = await invoke(run, "job_start", { command: "pnpm build" });
    expect(started.awaitsWakeup).toBe(true);
    const jobId = (started.data as { jobId: string }).jobId;
    await invoke(run, "job_input", { jobId, input: "y\n" });
    expect((await invoke(run, "job_observe", { jobId })).output).toContain("state: running");
    await invoke(run, "job_cancel", { jobId });
    expect(run.ports.log.jobs[0]).toMatchObject({ input: ["y\n"], cancelled: true });
  });
});
