import { ScriptedModelClient } from "@ng/loop";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvelope, KERNEL_FROM, PAYLOAD, type ActionRecord } from "@ng/protocol";
import { itemSource } from "../src/shared/records";
import { boot, cleanupAll, gitRepo, HOUR, projects, tempDir, tool } from "./helpers";

afterEach(cleanupAll);

describe("Phase 0 (@ng/presets) — BUG-021, BUG-022, BUG-028, BUG-032", () => {
  it("BUG-021: draft_reply refuses blind overwrite when human edited the draft (even on revise), and succeeds with explicit expectedVersion", async () => {
    const h = await boot();
    h.script.add("desk", tool("draft_reply", { text: "初稿 v1", title: "回复 Alice" }));
    await h.memory.inject({ from: "alice", text: "什么时候上线？" });
    await h.kernel.idle();
    const [card] = h.cards();
    expect(card).toBeDefined();

    // Human edits draft v1 -> v2.
    expect(
      h.kernel.context.commitSync("desk", {
        artifact: {
          artifactId: card!.artifactId!,
          content: { format: "text", body: "主人手改 v2：下周三发版" },
          updatedBy: "human",
          expectedVersion: 1,
        },
      }),
    ).toMatchObject({ ok: true, artifactVersion: 2 });

    // Owner clicks revise; agent tries calling draft_reply WITHOUT expectedVersion → MUST be refused (no blind overwrite of human v2!).
    let sawConflict = false;
    h.script.add(
      "desk",
      tool("draft_reply", { text: "AI 覆盖稿" }),
      (req) => {
        const txt = JSON.stringify(req.messages);
        if (txt.includes("edited this draft themselves") && txt.includes("expectedVersion: 2")) sawConflict = true;
        // Now agent respects the human edit and passes explicit expectedVersion: 2!
        return tool("draft_reply", { text: "主人手改 v2：下周三发版（已润色）", expectedVersion: 2 });
      },
    );
    expect(
      await h.kernel.resolveApproval(card!.actionId, { decision: "revise", approverId: "owner", instruction: "在我的基础上润色一下" }),
    ).toMatchObject({ status: "revising" });
    await h.kernel.idle();

    expect(sawConflict).toBe(true);
    const finalArt = h.kernel.context.getArtifactSync(card!.artifactId!)!;
    expect(finalArt.version).toBe(3);
    expect(finalArt.content.body).toBe("主人手改 v2：下周三发版（已润色）");
  });

  it("BUG-028: standing-rule auto-approved draft_reply uses Outbox idempotency, creates unique unknown card (never lies sent), and reports failed cleanly", async () => {
    const h = await boot();
    // Enable standing auto-send rule for channel:memory:*!
    h.kernel.gate.upsertPolicyRuleSync({
      match: { type: "channel.send", target: "channel:memory:*" },
      effect: "allow",
      createdBy: "owner",
      maxUses: 10,
      note: "trust test",
    });

    // 1) Receipt = unknown → must NOT claim "sent"; must create a unique unknown verification card linked to Outbox!
    h.memory.respondWith("unknown");
    let unknownOutput = "";
    h.script.add(
      "desk",
      tool("draft_reply", { text: "自动回复内容", title: "回复 Alice" }),
      (req) => {
        unknownOutput = JSON.stringify(req.messages);
        return { text: "waiting for verification" };
      },
    );
    await h.memory.inject({ from: "alice", text: "你好" });
    await h.kernel.idle();
    expect(unknownOutput).toContain("unknown");
    expect(unknownOutput).not.toContain("Sent reply to");
    const unknownCards = h.kernel.gate.listApprovalsSync({ status: ["unknown"] });
    expect(unknownCards).toHaveLength(1);
    const outboxRows = h.kernel.hub.listOutboxSync({ channelId: "memory" });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.idempotencyKey).toMatch(/^reply:[a-f0-9]{64}$/);
    expect(outboxRows[0]!.actionId).toBe(unknownCards[0]!.actionId);

    // 2) Receipt = failed → returns isError: true with explicit retryable error (never claims sent!).
    h.memory.respondWith("failed");
    let failedOutput = "";
    h.script.add(
      "desk",
      tool("draft_reply", { text: "第二条自动回复", title: "回复 Bob" }),
      (req) => {
        failedOutput = JSON.stringify(req.messages);
        return { text: "send failed" };
      },
    );
    await h.memory.inject({ from: "bob", text: "问一下" });
    await h.kernel.idle();
    expect(failedOutput.toLowerCase()).toContain("delivery failed");
    expect(failedOutput).toContain("retry");

    const [failed] = h.kernel.gate.listApprovalsSync({status:["failed"]});
    const action = failed!.action;
    if (action.type !== "channel.send") throw Error("missing failed send");
    const meta = {cellId:failed!.cellId,epoch:failed!.epoch,principalId:"cell:"+failed!.cellId};
    expect(h.kernel.gate.authorizeSync(action,meta)).toMatchObject({type:"deny"});
    expect(()=>h.kernel.gate.recordStandingSendSync("another-attempt",action,meta)).toThrow("待处理");
    expect(h.kernel.gate.listApprovalsSync({status:["failed"]})).toHaveLength(1);

    // 3) Receipt = sent → delivers once cleanly with stable key.
    h.script.add("desk", tool("draft_reply", { text: "第三条自动回复", title: "回复 Carol" }), { text: "done" });
    await h.memory.inject({ from: "carol", text: "确认下" });
    await h.kernel.idle();
    expect(h.memory.sent.map((m) => m.target)).toEqual(["carol"]);
  });

  it.each(["draft_reply", "send_message"])("%s records one send across a claim retry after a process crash", async name => {
    const send = (text = "single reply") => name === "send_message" ? tool(name, {to:"channel:memory:alice", summary:"reply", text}) : tool(name, {text:"single reply"});
    const h = await boot();
    h.kernel.gate.upsertPolicyRuleSync({
      match: { type: "channel.send", target: "channel:memory:*" }, effect: "allow", createdBy: "owner", maxUses: 1,
    });
    const snapshot = tempDir("standing-send-crash");
    const deliver = h.memory.deliver.bind(h.memory);
    h.memory.deliver = async req => {
      const receipt = await deliver(req);
      // The remote received the body. Copy the committed database before the receipt reaches the kernel.
      h.kernel.db.prepare("VACUUM INTO ?").run(join(snapshot, "ng.db"));
      return receipt;
    };
    h.script.add("desk", send(), send(), { text: "done" });
    await h.memory.inject({ from: "alice", text: "hello" });
    await h.kernel.idle();
    expect(h.memory.deliveries).toHaveLength(1);
    expect(h.cards()).toHaveLength(0);
    expect(h.kernel.gate.listPolicyRulesSync()[0]?.uses).toBe(1);
    const [sent] = h.kernel.hub.listOutboxSync({ channelId: "memory" });
    expect(sent).toMatchObject({ status: "sent", attempts: 1 });

    const replay = new ScriptedModelClient([send("regenerated wording"), { text: "waiting for verification" }]);
    const restarted = await boot({ kernel: { dataDir: snapshot, model: replay } });
    await restarted.kernel.idle();
    const [unknown] = restarted.kernel.gate.listApprovalsSync({ status: ["unknown"] });
    expect(replay.calls.length).toBeGreaterThan(0);
    expect(unknown?.actionId).toBe(sent!.actionId);
    expect(restarted.kernel.gate.listPendingSync()).toHaveLength(0);
    expect(restarted.kernel.context.getArtifactSync(unknown!.artifactId!)?.version).toBe(1);
    expect(restarted.kernel.hub.getLatestOutboxByActionSync(unknown!.actionId)).toMatchObject({ status: "unknown", attempts: 1 });
    expect(restarted.memory.deliveries).toHaveLength(0);
    expect(restarted.kernel.resolveUnknownSend(unknown!.actionId, "sent", {
      approverId: "owner", seenItemRevision: unknown!.itemRevision, seenAttempt: 1,
    })).toBe("resolved");
  });

  it("BUG-032: items.ts returns false on channel.send failed/unknown so the desk LLM is woken instead of 0-Token swallowing", async () => {
    const h = await boot();
    h.script.add("desk", tool("draft_reply", { text: "你好 Alice", title: "回复 Alice" }));
    await h.memory.inject({ from: "alice", text: "在吗" });
    await h.kernel.idle();
    const [card] = h.cards();
    const callsBefore = h.script.callsOf("desk").length;

    h.memory.respondWith("failed");
    h.script.add("desk", { text: "I saw the send failure" });
    expect(
      await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 }),
    ).toMatchObject({ status: "failed" });
    await h.kernel.idle();
    // Desk LLM WAS woken to handle the failed send (calls increased by 1!).
    expect(h.script.callsOf("desk").length).toBe(callsBefore + 1);
  });

  it("BUG-032: propose_project hitting a standing allow rule directly launches the project and returns projectId", async () => {
    const h = await boot();
    const repo = gitRepo("standing-proj");
    h.kernel.gate.upsertPolicyRuleSync({
      match: { type: "project.start" },
      effect: "allow",
      createdBy: "owner",
      maxUses: 5,
      note: "auto start",
    });

    let toolOut = "";
    h.script.add(
      "desk",
      tool("propose_project", {
        title: "自动立项测试",
        outcome: "测试通过",
        actions: [{ title: "写测试", owner: "agent" }],
        cwd: repo,
      }),
      (req) => {
        toolOut = JSON.stringify(req.messages);
        return { text: "launched" };
      },
    );
    await h.ui.capture({ text: "直接帮我立项跑测试" });
    await h.kernel.idle();

    expect(h.cards()).toEqual([]);
    const launched = projects(h);
    expect(launched).toHaveLength(1);
    expect(toolOut).toContain(launched[0]!);
    expect(h.project(launched[0]!)).toMatchObject({ title: "自动立项测试", lifecycle: "active", cwd: repo });
  });

  it("BUG-021: remind_me writes NO desk:reminder:* shadow state (Inbox timer envelope is sole SSOT)", async () => {
    const h = await boot();
    h.script.add("desk", tool("remind_me", { text: "记得喝水", inMinutes: 10 }), { text: "好的" });
    await h.ui.capture({ text: "10 分钟后提醒我喝水" });
    await h.kernel.idle();

    const reminderState = h.kernel.context.listStateSync("desk", "desk:reminder:");
    expect(reminderState).toEqual([]);
    const scheduled = h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.timerFired });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.envelope.payload).toMatchObject({ label: "提醒：记得喝水" });

    // Advancing clock fires the Inbox timer directly without any shadow state resurrection.
    h.clock.advance(HOUR);
    await h.kernel.idle();
    expect(h.notices().some((n) => n.includes("记得喝水"))).toBe(true);
  });

  it("BUG-022: itemSource identifies KERNEL_FROM.control for both agent:* and owner", () => {
    const agentEnv = createEnvelope(
      { id: "s1", from: KERNEL_FROM.control, principalId: "agent:main", kind: "event", type: PAYLOAD.controlSteer, payload: { message: "改一下" } },
      { now: () => 100 },
    );
    const ownerEnv = createEnvelope(
      { id: "s2", from: KERNEL_FROM.control, principalId: "owner", kind: "event", type: PAYLOAD.controlSteer, payload: { message: "停一下" } },
      { now: () => 200 },
    );
    expect(itemSource(agentEnv, 100)).toMatchObject({ label: "外部助手", principalId: "agent:main", envelopeId: "s1", at: 100 });
    expect(itemSource(ownerEnv, 200)).toMatchObject({ label: "对话", principalId: "owner", envelopeId: "s2", at: 200 });
  });
});

it("delivers a due personal reminder on an exhausted root ledger while model messages stay pending",async()=>{
  const h=await boot();
  h.script.add("desk",tool("remind_me",{text:"打电话",inMinutes:1}));
  await h.ui.capture({text:"提醒我打电话"});
  await h.kernel.idle();
  const usage=h.kernel.gate.usageSync("desk");
  h.kernel.gate.meter("desk",{tokens:usage.limitTokens+1,billedCents:0});
  await h.ui.capture({text:"需要模型判断的事"});
  h.clock.advance(60_000);
  await h.kernel.idle();
  expect(h.notices().filter(n => n === "⏰ 提醒：打电话")).toHaveLength(1);
  const items=h.kernel.humanItems.list();
  expect(items.find(i=>i.title==="打电话")).toMatchObject({cellId:null});
  const budget=items.find(i=>i.subjectKey==="kernel:budget:desk")!;
  await h.kernel.humanItems.decide(budget.id,{optionId:"system.deny",seenItemRevision:budget.itemRevision},"owner");
  h.clock.advance(HOUR);
  await h.kernel.idle();
  expect(h.kernel.humanItems.list().filter(i=>i.subjectKey===budget.subjectKey)).toEqual([]);
  expect(h.kernel.inbox.listMessagesSync({cellId:"desk",type:PAYLOAD.userMessage,status:["pending"]})).toHaveLength(1);
});

it("consumes the only due desk reminder without raising a budget card from a cached queue scan", async () => {
  const h = await boot();
  h.script.add("desk", tool("remind_me",{text:"签到",inMinutes:1}));
  await h.ui.capture({text:"提醒我签到"});
  await h.kernel.idle();
  const calls = h.deskRuns();
  h.kernel.spawnCell("desk",{id:"coordinator",preset:"hub"});
  h.kernel.spawnCell("coordinator",{id:"helper",preset:"worker"});
  const usage = h.kernel.gate.usageSync("desk");
  h.kernel.gate.meter("desk", {tokens:usage.limitTokens + 1, billedCents:0});
  // Queue the coordinator first so its wrap-up eligibility reads the due set before the desk consumes the timer.
  h.kernel.sendToCell("coordinator", {text:"继续工作"});
  h.clock.advance(60_000);
  await h.kernel.idle();
  expect(h.notices()).toContain("⏰ 提醒：签到");
  expect(h.deskRuns()).toBe(calls);
  expect(h.kernel.humanItems.list().map(i => i.subjectKey)).not.toContain("kernel:budget:desk");
});

it.each(["existing", "inline"])("sends two distinct %s drafts to one recipient in a single trigger", async kind => {
  const h = await boot();
  h.kernel.gate.upsertPolicyRuleSync({match:{type:"channel.send",target:"channel:memory:alice"}, effect:"allow", createdBy:"owner"});
  const artifacts = ["receipt","schedule"];
  if (kind === "existing") for (const id of artifacts) h.kernel.context.commitSync("desk", {artifact:{artifactId:id, updatedBy:"agent", content:{format:"text", body:id}}});
  h.script.add("desk", ...artifacts.map(artifactId => tool("send_message", {...(kind === "existing" ? {artifactId} : {text:artifactId}), to:"channel:memory:alice", summary:artifactId})));
  await h.memory.inject({from:"alice", text:"请发两份文件"});
  await h.kernel.idle();
  expect(h.memory.sent.map(d => d.content.body)).toEqual(artifacts);
});
