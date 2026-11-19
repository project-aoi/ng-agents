import { describe, expect, it } from "vitest";
import {
  asClarifyCard,
  CELL_RESULT_CANDIDATE_KEY,
  CELL_STATUS_KEY,
  createEnvelope,
  isNgError,
  makeBounds,
  NgError,
  PAYLOAD,
  selectRunTools,
  type CellInspection,
  type ChannelSendAction,
  type Envelope,
  type ProposedAction,
  type SendToCellResult,
  type ToolContext,
  type ToolDef,
} from "@ng/protocol";
import { createFakeRun, fakeInspection, type FakeRun, type FakeRunOptions } from "../src/testing";
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

  it("rejects non-addresses and ambiguous content", async () => {
    const run = fakeRun();
    expect(await invoke(run, "send_message", { to: "desk", text: "x", summary: "s" })).toEqual({
      output: '"desk" is not an address. Use channel:<channelId>:<target> for a person or inbox:<cellId> for a cell.',
      isError: true,
    });
    expect((await invoke(run, "send_message", { to: "channel:ui:owner", summary: "s" })).isError).toBe(true);
    expect((await invoke(run, "send_message", { to: "inbox:desk", summary: "s" })).isError).toBe(true); // a cell message needs text
    expect(run.ports.log.cellMessages).toEqual([]);
    expect(run.ports.log.authorizations).toEqual([]);
  });

  it("delivers to another cell's inbox without an approval, and says so out loud when the target is closed", async () => {
    const run = fakeRun({
      batch: ["转给 worker"],
      sendToCell: (to): SendToCellResult => {
        if (to === "inbox:w_done") return { status: "closed", closeReason: "completed" };
        if (to === "inbox:w_cancelled") return { status: "closed", closeReason: "cancelled" };
        if (to === "inbox:ghost") return { status: "not_found" };
        return { status: "delivered", envelopeId: `msg_to_${to.slice(6)}`, targetStatus: to === "inbox:parked" ? "paused" : "active" };
      },
    });
    const ok = await invoke(run, "send_message", { to: "inbox:w1", text: "顺便把单测也补上", summary: "追加要求" });
    expect(ok).toMatchObject({
      output:
        'Delivered to w1. It handles the message in its current run, or is woken with it (a dormant worker continues with everything it knows); if you need its answer, end your turn with wait (waitingFor "inbox:w1").',
    });
    expect(ok.isError).toBeUndefined();
    expect(run.ports.log.cellMessages[0]).toEqual({
      to: "inbox:w1",
      message: { text: "顺便把单测也补上", summary: "追加要求", id: `run_1:tu_${callCounter}:msg` },
      result: { status: "delivered", envelopeId: "msg_to_w1", targetStatus: "active" },
    });
    expect((await invoke(run, "send_message", { to: "inbox:parked", text: "x", summary: "s" })).output).toBe("Delivered to parked, which is paused: it reads the message when it is resumed.");
    const closed = await invoke(run, "send_message", { to: "inbox:w_done", text: "还有一件事", summary: "追加" });
    expect(closed.isError).toBe(true);
    // a worker is not closed for finishing a turn: a closed one was closed on purpose, or went with its project
    expect(closed.output).toMatch(/^NOT DELIVERED — w_done is closed \(it was closed, or its project ended\)\. Nothing was stored\. .*spawn_cell/);
    const cancelled = await invoke(run, "send_message", { to: "inbox:w_cancelled", text: "x", summary: "s" });
    expect(cancelled).toMatchObject({ isError: true, output: expect.stringMatching(/^NOT DELIVERED — w_cancelled is closed \(it was cancelled\)\. Nothing was stored\./) });
    const ghost = await invoke(run, "send_message", { to: "inbox:ghost", text: "x", summary: "s" });
    expect(ghost).toMatchObject({ isError: true, output: expect.stringMatching(/^NOT DELIVERED — there is no cell "ghost"/) });
    // cell-to-cell messages never go through the Gate or a channel
    expect(run.ports.log.authorizations).toEqual([]);
    expect(run.ports.log.sends).toEqual([]);
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

  it("a one-shot cell's result is only staged: nothing is sent, the run ends, the kernel delivers it on settling", async () => {
    const run = fakeRun({ cellId: "w1", spec: { lifetime: "one_shot" } });
    await invoke(run, "report_to_parent", { kind: "progress", text: "跑完一半" });
    const r = await invoke(run, "report_to_parent", { kind: "result", text: "测试全过，分支 fix/ci", artifactId: "art_rep", data: { branch: "fix/ci" } });
    expect(r).toMatchObject({ endRun: "completed", data: { staged: true } });
    expect(r.output).toMatch(/^Result recorded\. Your run ends now and your parent is told\. If a follow-up message reached you first, you are woken with it instead/);
    // progress still goes out at once (silent); the result does not
    expect(run.ports.log.emitted.map((e) => e.type)).toEqual([PAYLOAD.cellProgress]);
    expect(run.ports.state.get(CELL_RESULT_CANDIDATE_KEY)).toEqual({
      status: "completed",
      summary: "测试全过，分支 fix/ci",
      artifactId: "art_rep",
      data: { branch: "fix/ci" },
      at: c.now(),
    });
    expect(run.ports.state.get(CELL_STATUS_KEY)).toMatchObject({ text: "测试全过，分支 fix/ci" });
    // complete_self / pause_self are for cells that live until they say so
    expect(tool("complete_self").availableFor!({ bounds: run.ports.self.bounds, spec: run.ports.self.spec })).toBe(false);
    expect(tool("complete_self").availableFor!({ bounds: run.ports.self.bounds, spec: { processor: { kind: "llm" }, parentId: "desk" } })).toBe(true);
  });

  it("a wakeable worker's result is staged like a one-shot's: nothing is sent, the run ends; it settles nothing itself", async () => {
    const run = fakeRun({ cellId: "w2", spec: { lifetime: "wakeable" } });
    const r = await invoke(run, "report_to_parent", { kind: "result", text: "失败：上游接口 502", status: "failed", artifactId: "art_log" });
    expect(r).toEqual({
      output: "Result recorded. Your run ends now and your parent is told. If a follow-up message reached you first, you are woken with it instead — handle it, then report the updated result.",
      endRun: "completed",
      data: { staged: true },
    });
    expect(run.ports.log.emitted).toEqual([]);
    expect(run.ports.state.get(CELL_RESULT_CANDIDATE_KEY)).toEqual({ status: "failed", summary: "失败：上游接口 502", artifactId: "art_log", at: c.now() });
    expect(run.ports.state.get(CELL_STATUS_KEY)).toMatchObject({ text: "失败：上游接口 502" });
    // a leaf's turns are settled by the kernel: complete_self / pause_self are not offered to it
    for (const name of ["complete_self", "pause_self"]) {
      expect(tool(name).availableFor!({ bounds: run.ports.self.bounds, spec: run.ports.self.spec })).toBe(false);
      expect(tool(name).availableFor!({ bounds: run.ports.self.bounds, spec: { processor: { kind: "llm" }, parentId: "desk", lifetime: "persistent" } })).toBe(true);
    }
    // report_to_parent itself stays offered to every cell with a parent
    expect(tool("report_to_parent").availableFor!({ bounds: run.ports.self.bounds, spec: run.ports.self.spec })).toBe(true);
  });

  it("complete_self / pause_self hand the kernel a settle request and end the run", async () => {
    const run = fakeRun({ cellId: "p1" });
    const done = await invoke(run, "complete_self", { summary: "官网改版已上线" });
    expect(done).toMatchObject({ output: "Closing after this run. Stop here.", endRun: "completed", data: { action: "complete" } });
    await invoke(run, "complete_self", { summary: "放弃了", cancelled: true });
    await invoke(run, "pause_self", { reason: "等明年预算" });
    expect(run.ports.log.settled).toEqual([
      { action: "complete", summary: "官网改版已上线" },
      { action: "cancel", summary: "放弃了" },
      { action: "pause", summary: "等明年预算" },
    ]);
    expect(run.ports.state.get(CELL_STATUS_KEY)).toMatchObject({ text: "已停靠：等明年预算" });
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

  describe("handback picks the message by envelopeId when a wake-up holds several", () => {
    const secondMessage: Envelope = createEnvelope(
      {
        id: "env_feishu_2",
        from: "channel:feishu:oc_group",
        principalId: "feishu:ou_li",
        kind: "event",
        type: "user.message",
        payload: { text: "顺便问一下：\n下周的团建定了吗？", sender: { id: "ou_li", name: "李四" } },
        threads: ["feishu:oc_group"],
      },
      c,
    );
    const timer: Envelope = createEnvelope(
      { id: "env_timer_1", from: "timer:check", principalId: "owner", kind: "event", type: "timer.fired", payload: { label: "check" } },
      c,
    );
    const withPort = (batch: Envelope[]) => {
      const run = fakeRun({ cellId: "watch1", batch });
      const calls: Array<[string, string]> = [];
      Object.assign(run.ports, { handback: async (id: string, reason: string) => void calls.push([id, reason]) });
      return { run, calls };
    };
    const listing = [
      `- envelopeId "env_feishu_1" — channel:feishu:oc_group: 方案什么时候能好？`,
      `- envelopeId "env_feishu_2" — 李四: 顺便问一下： 下周的团建定了吗？`,
    ].join("\n");

    it("one message: no id needed, also next to envelopes that are not messages", async () => {
      const { run, calls } = withPort([timer, secondMessage]);
      expect(await invoke(run, "handback", { reason: "团建不归我管" })).toMatchObject({ output: "Handed back to the desk.", data: { envelopeId: "env_feishu_2" } });
      expect(calls).toEqual([["env_feishu_2", "团建不归我管"]]);
    });

    it("several messages and no id: an error listing each message with its id; nothing is handed back", async () => {
      const { run, calls } = withPort([feishuMessage, timer, secondMessage]);
      const r = await invoke(run, "handback", { reason: "团建不归我管" });
      expect(r.isError).toBe(true);
      expect(r.output).toBe(`This wake-up holds 2 messages; say which one to hand back with envelopeId (once per message):\n${listing}`);
      expect(calls).toEqual([]);
      // the fallback path hands nothing to the desk either
      const fallback = fakeRun({ cellId: "watch1", batch: [feishuMessage, secondMessage] });
      expect((await invoke(fallback, "handback", { reason: "x" })).isError).toBe(true);
      expect(fallback.ports.log.inboxOut).toEqual([]);
    });

    it("an explicit id hands back exactly that message (once per message)", async () => {
      const { run, calls } = withPort([feishuMessage, secondMessage]);
      expect(await invoke(run, "handback", { reason: "团建不归我管", envelopeId: "env_feishu_2" })).toMatchObject({ data: { envelopeId: "env_feishu_2" } });
      expect(await invoke(run, "handback", { reason: "方案另有人跟", envelopeId: " env_feishu_1 " })).toMatchObject({ data: { envelopeId: "env_feishu_1" } });
      expect(calls).toEqual([
        ["env_feishu_2", "团建不归我管"],
        ["env_feishu_1", "方案另有人跟"],
      ]);
      // without the kernel port the handback envelope for that message goes to the desk
      const fallback = fakeRun({ cellId: "watch1", batch: [feishuMessage, secondMessage] });
      await invoke(fallback, "handback", { reason: "团建不归我管", envelopeId: "env_feishu_2" });
      expect(fallback.ports.log.inboxOut.map((o) => [o.to, o.envelope.id])).toEqual([["inbox:desk", "env_feishu_2#handback#watch1"]]);
    });

    it("a unique suffix or fragment of the id is enough; an ambiguous one is not", async () => {
      const { run, calls } = withPort([feishuMessage, secondMessage]);
      expect(await invoke(run, "handback", { reason: "团建", envelopeId: "_2" })).toMatchObject({ data: { envelopeId: "env_feishu_2" } });
      expect(await invoke(run, "handback", { reason: "方案", envelopeId: "feishu_1" })).toMatchObject({ data: { envelopeId: "env_feishu_1" } });
      expect(calls).toEqual([
        ["env_feishu_2", "团建"],
        ["env_feishu_1", "方案"],
      ]);
      const ambiguous = await invoke(run, "handback", { reason: "?", envelopeId: "feishu" });
      expect(ambiguous).toMatchObject({ isError: true, output: `No message "feishu" in this wake-up. The messages are:\n${listing}` });
      expect(calls).toHaveLength(2);
    });

    it("an unknown id: an error with the same list; nothing is handed back", async () => {
      const { run, calls } = withPort([feishuMessage, secondMessage]);
      const r = await invoke(run, "handback", { reason: "x", envelopeId: "env_nope" });
      expect(r).toMatchObject({ isError: true, output: `No message "env_nope" in this wake-up. The messages are:\n${listing}` });
      expect(calls).toEqual([]);
      // with no message in the wake-up there is no list to show
      const empty = withPort([timer]);
      expect(await invoke(empty.run, "handback", { reason: "x", envelopeId: "env_nope" })).toMatchObject({ isError: true, output: `No message "env_nope" in this wake-up.` });
      expect(empty.calls).toEqual([]);
    });
  });

  it("complete_self / pause_self with closeChildren: true ask the kernel to settle with force; without it a conflict leaves everything as it was", async () => {
    const run = fakeRun({ cellId: "p1" });
    await invoke(run, "complete_self", { summary: "收尾，子任务不要了", closeChildren: true });
    await invoke(run, "complete_self", { summary: "放弃", cancelled: true, closeChildren: true });
    await invoke(run, "pause_self", { reason: "等预算", closeChildren: true });
    await invoke(run, "complete_self", { summary: "正常收尾", closeChildren: false });
    expect(run.ports.log.settled).toEqual([
      { action: "complete", summary: "收尾，子任务不要了", force: true },
      { action: "cancel", summary: "放弃", force: true },
      { action: "pause", summary: "等预算", force: true },
      { action: "complete", summary: "正常收尾" },
    ]);

    // The kernel refuses a settle without force while children are open: the tool records nothing and does not end the run.
    const refusing = fakeRun({
      cellId: "p2",
      settleSelf: (req) => {
        if (!req.force) throw new NgError("conflict", `1 child cell(s) are still open (w1 "写代码").`);
      },
    });
    await expect(invoke(refusing, "complete_self", { summary: "完成" })).rejects.toSatisfy((e) => isNgError(e, "conflict"));
    await expect(invoke(refusing, "pause_self", { reason: "停" })).rejects.toSatisfy((e) => isNgError(e, "conflict"));
    expect(refusing.ports.log.settled).toEqual([]);
    expect(refusing.ports.state.get(CELL_STATUS_KEY)).toBeUndefined();
    expect(await invoke(refusing, "complete_self", { summary: "完成", closeChildren: true })).toMatchObject({ endRun: "completed", data: { action: "complete" } });
    expect(refusing.ports.log.settled).toEqual([{ action: "complete", summary: "完成", force: true }]);
    // the tool descriptions say what closeChildren is for
    expect(tool("complete_self").description).toContain("closeChildren: true");
    expect(tool("pause_self").description).toContain("closeChildren: true");
  });

  it("wait ends the run as yielded_waiting, recording who it waits for when told", async () => {
    const run = fakeRun();
    expect(await invoke(run, "wait", { reason: "nothing new" })).toMatchObject({ endRun: "yielded_waiting" });
    expect(run.ports.log.waits).toEqual([]);
    const r = await invoke(run, "wait", { reason: "desk 裁决脏改动", waitingFor: "inbox:desk", timeoutMinutes: 30 });
    expect(r).toMatchObject({ endRun: "yielded_waiting", data: { waitingFor: "inbox:desk", timeoutAt: c.now() + 30 * 60_000 } });
    expect(run.ports.log.waits).toEqual([{ waitingFor: "inbox:desk", reason: "desk 裁决脏改动", timeoutAt: c.now() + 30 * 60_000 }]);
    expect((await invoke(run, "wait", { reason: "x", timeoutMinutes: 5 })).isError).toBe(true); // a timeout needs a party
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
    // A page says whether more follows and where; the last page and a whole short text come back bare.
    // An explicit page size is carried into the next call.
    expect((await invoke(run, "read_resource", { uri: "res://cell1/r1", offset: 2, limit: 3 })).output).toBe(
      'cde\n…[characters 2–5 shown; more follows: read_resource("res://cell1/r1", offset 5, limit 3)]',
    );
    expect((await invoke(run, "read_resource", { uri: "res://cell1/r1", offset: 5 })).output).toBe("fghij");
    expect((await invoke(run, "read_resource", { uri: "res://cell1/r1" })).output).toBe("abcdefghij");
    expect((await invoke(run, "read_resource", { uri: "res://cell1/r1", offset: 50 })).output).toContain("nothing at offset 50");
    // The default page is 8000 characters; an explicit limit reads up to 64000 per call, never more.
    run.ports.resources.set("res://cell1/big", "z".repeat(150_000));
    const first = (await invoke(run, "read_resource", { uri: "res://cell1/big" })).output;
    expect(first).toBe(`${"z".repeat(8000)}\n…[characters 0–8000 shown; more follows: read_resource("res://cell1/big", offset 8000)]`);
    const large = (await invoke(run, "read_resource", { uri: "res://cell1/big", offset: 8000, limit: 64_000 })).output;
    expect(large).toBe(`${"z".repeat(64_000)}\n…[characters 8000–72000 shown; more follows: read_resource("res://cell1/big", offset 72000, limit 64000)]`);
    const capped = (await invoke(run, "read_resource", { uri: "res://cell1/big", limit: 1_000_000 })).output;
    expect(capped.startsWith(`${"z".repeat(64_000)}\n…[characters 0–64000 shown; more follows`)).toBe(true);
    expect((await invoke(run, "read_resource", { uri: "res://cell1/big", offset: 100_000, limit: 64_000 })).output).toBe("z".repeat(50_000));
  });

  describe("patch_artifact", () => {
    const REPORT = [
      "# Harness 对比",
      "",
      "## 结论",
      "",
      "trae 基于事件循环。",
      "",
      "## 遥测",
      "",
      "侧车上报 OTLP。",
      "",
      "```bash",
      "## not a heading inside a code block",
      "```",
      "",
      "### 细节",
      "",
      "采样率 10%。",
      "",
      "## 附录",
      "",
      "- 待补",
      "",
    ].join("\n");

    async function withReport(o: { title?: string; body?: string } = {}) {
      const run = fakeRun();
      const created = await invoke(run, "save_artifact", { title: o.title ?? "Harness 对比报告", body: o.body ?? REPORT });
      return { run, id: (created.data as { artifactId: string }).artifactId };
    }
    const bodyOf = (run: FakeRun, id: string) => run.ports.artifacts.get(id)!.content.body;

    it("replaces one passage, keeps the title and reports the new version and size", async () => {
      const { run, id } = await withReport();
      const r = await invoke(run, "patch_artifact", { artifactId: id, expectedVersion: 1, edits: [{ op: "replace", find: "OTLP", replace: "OTLP/gRPC" }] });
      const body = REPORT.replace("OTLP", "OTLP/gRPC");
      expect(r).toMatchObject({ output: `Saved ${id} v2 (${body.length} chars, 1 edit applied).`, data: { artifactId: id, version: 2, chars: body.length, edits: 1 } });
      expect(run.ports.artifacts.get(id)!.content).toEqual({ format: "markdown", title: "Harness 对比报告", body });
      expect(run.ports.log.commits.at(-1)!.artifact).toMatchObject({ artifactId: id, updatedBy: "agent", expectedVersion: 1 });
    });

    it("applies several edits in order, renames when asked, and groups thousands in the size", async () => {
      const { run, id } = await withReport({ body: `${"x".repeat(1500)}\nEND` });
      const r = await invoke(run, "patch_artifact", {
        artifactId: id,
        expectedVersion: 1,
        title: "终稿",
        edits: [
          { op: "replace", find: "END", replace: "MID" },
          { op: "append", text: "END" },
          { op: "prepend", text: "# 标题" },
          { op: "replace", find: "x", replace: "y", all: true },
        ],
      });
      const body = `# 标题\n${"y".repeat(1500)}\nMID\nEND`;
      expect(body.length).toBe(1513);
      expect(r.output).toBe(`Saved ${id} v2 (1,513 chars, 4 edits applied; title now "终稿").`);
      expect(run.ports.artifacts.get(id)!.content).toMatchObject({ title: "终稿", body });
    });

    it("rejects an ambiguous or missing find and writes nothing", async () => {
      const { run, id } = await withReport();
      const commits = run.ports.log.commits.length;
      const twice = await invoke(run, "patch_artifact", {
        artifactId: id,
        expectedVersion: 1,
        edits: [
          { op: "append", text: "- 新增一条" },
          { op: "replace", find: "## ", replace: "### " },
        ],
      });
      expect(twice.isError).toBe(true);
      expect(twice.output).toContain("edit 2 (replace): the find text occurs 5 times (lines 3, 7, 12, 15, 19)");
      expect(twice.output).toContain(`Nothing was saved; ${id} stays at v1.`);
      const missing = await invoke(run, "patch_artifact", { artifactId: id, expectedVersion: 1, edits: [{ op: "replace", find: "OTLP over HTTP", replace: "x" }] });
      expect(missing.isError).toBe(true);
      expect(missing.output).toContain("edit 1 (replace): the find text does not occur in the body");
      const incomplete = await invoke(run, "patch_artifact", { artifactId: id, expectedVersion: 1, edits: [{ op: "replace", find: "OTLP" }] });
      expect(incomplete).toMatchObject({ isError: true, output: expect.stringContaining("edit 1 (replace) needs replace") });
      expect(run.ports.log.commits.length).toBe(commits);
      expect(run.ports.artifacts.get(id)!.version).toBe(1);
      expect(bodyOf(run, id)).toBe(REPORT);
    });

    it("replaces a Markdown section up to the next heading of the same or higher level", async () => {
      const { run, id } = await withReport();
      const r = await invoke(run, "patch_artifact", { artifactId: id, expectedVersion: 1, edits: [{ op: "replace_section", heading: "## 遥测", text: "侧车经 OTLP/gRPC 上报，采样率 5%。" }] });
      expect(r.output).toBe(`Saved ${id} v2 (${bodyOf(run, id).length} chars, 1 edit applied).`);
      // The subsection and the fenced block went with it; the blank lines around the section stay as they were.
      expect(bodyOf(run, id)).toBe(["# Harness 对比", "", "## 结论", "", "trae 基于事件循环。", "", "## 遥测", "", "侧车经 OTLP/gRPC 上报，采样率 5%。", "", "## 附录", "", "- 待补", ""].join("\n"));
      // Just the heading text works when it is unique; the last section runs to the end of the body.
      await invoke(run, "patch_artifact", { artifactId: id, expectedVersion: 2, edits: [{ op: "replace_section", heading: "附录", text: "- 无\n" }] });
      expect(bodyOf(run, id).endsWith("## 附录\n\n- 无\n")).toBe(true);
    });

    it("rejects an unknown or duplicate heading, listing the headings", async () => {
      const { run, id } = await withReport({ body: "## A\none\n## B\ntwo\n# Top\n## A\nthree\n" });
      const unknown = await invoke(run, "patch_artifact", { artifactId: id, expectedVersion: 1, edits: [{ op: "replace_section", heading: "## C", text: "x" }] });
      expect(unknown.isError).toBe(true);
      expect(unknown.output).toContain('edit 1 (replace_section): no heading "## C" in the body. Headings in the body: line 1: ## A; line 3: ## B; line 5: # Top; line 6: ## A.');
      const dup = await invoke(run, "patch_artifact", { artifactId: id, expectedVersion: 1, edits: [{ op: "replace_section", heading: "A", text: "x" }] });
      expect(dup.output).toContain('the heading "A" occurs 2 times (line 1: ## A; line 6: ## A)');
      expect(run.ports.artifacts.get(id)!.version).toBe(1);
    });

    it("appends on its own line", async () => {
      const { run, id } = await withReport({ body: "第一段" });
      await invoke(run, "patch_artifact", { artifactId: id, expectedVersion: 1, edits: [{ op: "append", text: "第二段" }] });
      expect(bodyOf(run, id)).toBe("第一段\n第二段");
      await invoke(run, "patch_artifact", { artifactId: id, expectedVersion: 2, edits: [{ op: "append", text: "\n\n第三段\n" }] });
      expect(bodyOf(run, id)).toBe("第一段\n第二段\n\n第三段\n");
      expect(run.ports.artifacts.get(id)!.content.title).toBe("Harness 对比报告");
    });

    it("a stale expectedVersion overwrites nothing and is reported like save_artifact's conflict", async () => {
      const { run, id } = await withReport();
      await invoke(run, "save_artifact", { artifactId: id, expectedVersion: 1, body: `${REPORT}\n另一个分身补的一段` });
      const stale = await invoke(run, "patch_artifact", { artifactId: id, expectedVersion: 1, edits: [{ op: "replace", find: "OTLP", replace: "OTLP/gRPC" }] });
      expect(stale.isError).toBe(true);
      expect(stale.output).toContain(`Version conflict: ${id} is at v2 (last edited by agent).`);
      expect(stale.output).toContain("patch with expectedVersion 2");
      expect(stale.output).toContain("另一个分身补的一段");
      expect(stale.data).toEqual({ artifactId: id, currentVersion: 2, updatedBy: "agent" });
      expect(run.ports.artifacts.get(id)!.version).toBe(2);
      expect(run.ports.log.parked).toEqual([]);

      // Over a human's newer version the edited text is kept beside it, as with save_artifact.
      run.ports.humanEdit(id, "人工 v3");
      const human = await invoke(run, "patch_artifact", { artifactId: id, expectedVersion: 2, edits: [{ op: "append", text: "补充" }] });
      expect(human.output).toContain("at v3 (last edited by human). Your text was kept beside it as a suggestion");
      expect(run.ports.log.parked).toHaveLength(1);
      expect(bodyOf(run, id)).toBe("人工 v3");
    });

    it("refuses a missing artifact and non-text formats", async () => {
      const run = fakeRun();
      expect((await invoke(run, "patch_artifact", { artifactId: "art_nope", expectedVersion: 1, edits: [{ op: "append", text: "x" }] })).output).toContain("No artifact art_nope");
      const json = await invoke(run, "save_artifact", { format: "json", body: '{"a":1}' });
      const jid = (json.data as { artifactId: string }).artifactId;
      const r = await invoke(run, "patch_artifact", { artifactId: jid, expectedVersion: 1, edits: [{ op: "replace", find: "1", replace: "2" }] });
      expect(r).toMatchObject({ isError: true, output: expect.stringContaining("is a json artifact; patch_artifact only edits text and Markdown bodies") });
      expect((await invoke(run, "patch_artifact", { artifactId: jid, expectedVersion: 1, edits: [] })).isError).toBe(true);
    });
  });

  it("save_note limits a preference to a directory and roles; refuses the limits on a note", async () => {
    const run = fakeRun();
    const gate = await invoke(run, "save_note", { name: "commit-gate", body: "提交前跑 cargo clippy", kind: "preference", cwdPrefix: "/work/trae-x", roles: ["worker"] });
    expect(gate.output).toBe('Saved preference "commit-gate" (global; only for cells in /work/trae-x and roles worker).');
    await invoke(run, "save_note", { name: "report-style", body: "报告先写结论", kind: "preference", roles: ["project", "worker"] });
    await invoke(run, "save_note", { name: "tone", body: "回复同事用简短中文", kind: "preference", roles: [] });
    expect(run.ports.log.knowledge).toEqual([
      { kind: "preference", name: "commit-gate", body: "提交前跑 cargo clippy", description: "提交前跑 cargo clippy", scope: "global", mode: "upsert", applies: { cwdPrefix: "/work/trae-x", roles: ["worker"] } },
      { kind: "preference", name: "report-style", body: "报告先写结论", description: "报告先写结论", scope: "global", mode: "upsert", applies: { roles: ["project", "worker"] } },
      { kind: "preference", name: "tone", body: "回复同事用简短中文", description: "回复同事用简短中文", scope: "global", mode: "upsert" },
    ]);
    for (const input of [
      { name: "n", body: "b", cwdPrefix: "/work/trae-x" },
      { name: "n", body: "b", kind: "note", roles: ["worker"] },
    ]) {
      const r = await invoke(run, "save_note", input);
      expect(r).toMatchObject({ isError: true, output: expect.stringContaining('only limit a preference; a note cannot take them') });
    }
    expect(run.ports.log.knowledge).toHaveLength(3);
    expect(tool("save_note").description).toContain("leave both out for a rule about how the owner wants things done everywhere");
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
      watches: [{ thread: "github:org/repo#108", cancelGroup: "pr108" }, { filter: { "payload.text": { $contains: "CI" } }, coalesceMinutes: 2 }],
      schedules: [{ at: "2026-11-18T09:00:00+08:00" }],
      cwd: "/repos/app",
    });
    expect(r).toEqual({
      output: 'Spawned "修复 PR #108 CI" (worker) as inbox:child_1 — cell id child_1. It starts now; you are woken when its turn is over.',
      data: { addr: "inbox:child_1" },
      // the child will wake this cell when its turn is over: a run that ends after spawning is waiting, not finished
      awaitsWakeup: true,
    });
    const { spec, initialPayload } = run.ports.log.spawned[0]!;
    expect(initialPayload).toBe("修好 CI 并汇报");
    expect(spec).toMatchObject({
      preset: "worker",
      title: "修复 PR #108 CI",
      contextMode: "fork_prefix",
      cwd: "/repos/app",
      processor: { kind: "llm", modelTier: "fast", toolsets: ["workspace", "kernel.comms"], maxSteps: 40 },
      watches: [
        { threadOrFilter: { thread: "github:org/repo#108" }, cancelGroup: "pr108" },
        { threadOrFilter: { "payload.text": { $contains: "CI" } }, coalesceMs: 120_000 },
      ],
      schedules: [{ deliverAt: Date.parse("2026-11-18T01:00:00Z") }],
    });
    // docs/05: no `workspace` argument any more (no automatic worktree); nothing ends up in meta
    expect(spec.meta).toBeUndefined();
    expect([...spec.bounds!.tools!]).toEqual(["read", "edit", "bash"]);

    // docs/05-proposals/03: no write queue — the spec carries no cwdMode
    expect(spec).not.toHaveProperty("cwdMode");

    const r2 = await invoke(run, "spawn_cell", { preset: "sensor", title: "指标巡检", instruction: "每天 9 点查", input: { metric: "pay_success" } });
    expect(r2.output).toBe('Spawned "指标巡检" (sensor) as inbox:child_2 — cell id child_2. It starts now; you are woken when its turn is over.');
    expect(run.ports.log.spawned[1]).toMatchObject({
      spec: { processor: { kind: "code", entry: "script:checks/metrics.sh" } },
      initialPayload: { instruction: "每天 9 点查", input: { metric: "pay_success" } },
    });
    expect(run.ports.log.spawned[1]!.spec).not.toHaveProperty("cwd");
    expect(run.ports.log.spawned[1]!.spec).not.toHaveProperty("cwdMode");
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
    expect(await invoke(run, "update_cell", { cellId: "w1", title: "新标题" })).toEqual({ output: "Updated w1: title." });
    // without cellId it is the cell itself (its own watches/schedules/title/meta — the kernel refuses anything else)
    expect(await invoke(run, "update_cell", { watches: [{ thread: "github:org/repo#9" }] })).toEqual({ output: "Updated this cell: watches." });
    expect(run.ports.log.controls).toEqual([
      { cellId: "w1", action: "steer", steerMessage: "先修单测" },
      { cellId: "w1", action: "pause" },
    ]);
    expect(run.ports.log.closed).toEqual([{ cellId: "w1", reason: "cancelled" }]);
    expect(run.ports.log.updated).toEqual([
      { cellId: "w1", patch: { title: "新标题" } },
      { cellId: "cell1", patch: { watches: [{ threadOrFilter: { thread: "github:org/repo#9" } }] } },
    ]);
  });

  it("spawn, inspect, control and close are unavailable without spawn depth; update_cell (own watches/schedules) always is", () => {
    for (const name of ["spawn_cell", "inspect_cell", "control_cell", "close_cell"]) {
      const t = tool(name);
      expect(t.availableFor!({ bounds: makeBounds({ maxDepth: 0 }) })).toBe(false);
      expect(t.availableFor!({ bounds: makeBounds({ maxDepth: 1 }) })).toBe(true);
    }
    expect(tool("update_cell").availableFor).toBeUndefined();
  });

  it("kernel.cells gives a leaf (maxDepth 0) only update_cell, and a coordinator all five tools", () => {
    const offered = (maxDepth: number) =>
      selectRunTools(registry.resolveTools(["kernel.cells"]), { kind: "llm", toolsets: ["kernel.cells"] }, makeBounds({ maxDepth }), { processor: { kind: "llm" }, parentId: "desk" }).map(
        (t) => t.name,
      );
    expect(offered(0)).toEqual(["update_cell"]);
    expect(offered(1)).toEqual(["spawn_cell", "inspect_cell", "update_cell", "control_cell", "close_cell"]);
  });

  it("spawn_cell takes no cwdMode (docs/05-proposals/03): it is not in the schema, and a stray one never reaches the spec", async () => {
    const schema = tool("spawn_cell").inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain("cwd");
    expect(Object.keys(schema.properties)).not.toContain("cwdMode");
    // the description says a child starts at once and nobody locks a directory
    expect(tool("spawn_cell").description).toContain("It starts at once: nothing queues or locks a directory.");
    expect(tool("spawn_cell").description).toContain('"active workspaces"');
    expect(tool("spawn_cell").description).not.toMatch(/write queue|cwdMode/);

    const run = fakeRun();
    const r = await invoke(run, "spawn_cell", { preset: "worker", title: "t", instruction: "i", cwd: "/repos/app", cwdMode: "write" });
    expect(r.isError).toBeUndefined();
    expect(run.ports.log.spawned[0]!.spec).toMatchObject({ cwd: "/repos/app" });
    expect(run.ports.log.spawned[0]!.spec).not.toHaveProperty("cwdMode");
  });
});

describe("kernel.cells inspect_cell", () => {
  it("describes its arguments: cellId, afterSeq (a cursor) and detail summary | full", () => {
    const schema = tool("inspect_cell").inputSchema as { properties: Record<string, { enum?: unknown[] }>; required?: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["afterSeq", "cellId", "detail"]);
    expect(schema.required).toEqual(["cellId"]);
    expect(schema.properties["detail"]!.enum).toEqual(["summary", "full"]);
    expect(tool("inspect_cell").kind).toBe("kernel");
  });

  it("asks the kernel with only the arguments given and returns its text, with the covered range and facts as data", async () => {
    const run = fakeRun();
    const r = await invoke(run, "inspect_cell", { cellId: "w1" });
    const canned = fakeInspection("w1");
    expect(r).toEqual({
      output: canned.text,
      data: { fromSeq: 1, toSeq: 3, more: false, state: "dormant", directChats: 0, artifactIds: [] },
    });
    expect(r.isError).toBeUndefined();
    expect(r.endRun).toBeUndefined();
    // no afterSeq: the kernel's own cursor applies; no detail: the kernel's default
    expect(run.ports.log.inspections).toEqual([{ cellId: "w1", opts: {}, result: canned }]);

    await invoke(run, "inspect_cell", { cellId: "w1", afterSeq: 0, detail: "full" });
    await invoke(run, "inspect_cell", { cellId: "w2", afterSeq: 17 });
    expect(run.ports.log.inspections.slice(1).map(({ cellId, opts }) => ({ cellId, opts }))).toEqual([
      { cellId: "w1", opts: { afterSeq: 0, detail: "full" } },
      { cellId: "w2", opts: { afterSeq: 17 } },
    ]);
  });

  it("hands on what the kernel found: more records left, direct chats with the owner, artifacts touched", async () => {
    const found: CellInspection = {
      cellId: "w3",
      title: "修复 PR #108 CI",
      state: "working",
      fromSeq: 41,
      toSeq: 90,
      more: true,
      directChats: 2,
      artifactIds: ["art_report"],
      text: "#41 inbound (the owner, directly): 先别动 main 分支\n#42 bash: git switch -c fix/ci → exit 0\n…",
    };
    const run = fakeRun({ inspectCell: (cellId, opts) => ({ ...found, cellId, fromSeq: (opts?.afterSeq ?? 0) + 1 }) });
    const r = await invoke(run, "inspect_cell", { cellId: "w3", afterSeq: 40, detail: "summary" });
    expect(r).toEqual({
      output: found.text,
      data: { fromSeq: 41, toSeq: 90, more: true, state: "working", directChats: 2, artifactIds: ["art_report"] },
    });
    expect(run.ports.log.inspections[0]).toMatchObject({ cellId: "w3", opts: { afterSeq: 40, detail: "summary" } });
  });

  it("refuses bad arguments, and says so when the kernel offers no inspect port", async () => {
    const run = fakeRun();
    for (const input of [{}, { cellId: "" }, { cellId: "w1", afterSeq: -1 }, { cellId: "w1", afterSeq: 1.5 }, { cellId: "w1", detail: "everything" }]) {
      const r = await invoke(run, "inspect_cell", input);
      expect(r).toMatchObject({ isError: true, output: expect.stringMatching(/^Invalid input for inspect_cell/) });
    }
    expect(run.ports.log.inspections).toEqual([]);

    const bare = fakeRun();
    delete (bare.ports as { inspectCell?: unknown }).inspectCell;
    expect(await invoke(bare, "inspect_cell", { cellId: "w1" })).toEqual({ output: "inspect_cell is not available in this environment.", isError: true });
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
