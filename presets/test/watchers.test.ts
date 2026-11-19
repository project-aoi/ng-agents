import { afterEach, describe, expect, it } from "vitest";
import { PAYLOAD, subjectKeys, type EscalationCard, type ModelRequest } from "@ng/protocol";
import { KEYS, LEGACY, startProjectSync, type WatcherState } from "../src";
import { boot, childrenOf, cleanupAll, continuesRun, DAY, HOUR, requestText, T0, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

function lastUserText(req: ModelRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  return (last?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

async function waitForZhang(h: Harness, extra: Record<string, unknown> = {}): Promise<{ project: string; watcher: string }> {
  h.script.add(
    "project",
    tool("await_reply", { who: "张三", description: "等张三给 Doubao work 的代码地址", thread: "memory:dm-zhang", to: "channel:memory:zhang", waitHours: 1, ...extra }),
    tool("wait", { reason: "等张三回复" }),
  );
  const { projectId } = startProjectSync(h.kernel, { title: "Harness 对比", outcome: "报告", brief: "对比" });
  await h.kernel.idle();
  return { project: projectId, watcher: childrenOf(h, projectId)[0]! };
}

const fromZhang = (h: Harness, text: string) => h.memory.inject({ from: "zhang", text, threads: ["memory:dm-zhang"] });

describe("await_reply — the zero-token reply watcher reports to its project in plain words", () => {
  it("the reply closes the watcher with one result; the project's books mark the party replied", async () => {
    const h = await boot();
    const { project, watcher } = await waitForZhang(h);
    expect(h.kernel.getCell(watcher)).toMatchObject({
      preset: "watcher",
      status: "active",
      spec: { lifetime: "persistent", processor: { kind: "code", entry: "gtd.wait_match" }, watches: [{ threadOrFilter: { thread: "memory:dm-zhang" } }] },
    });
    expect(h.actions(project)).toEqual([
      expect.objectContaining({
        owner: "waiting",
        status: "open",
        cellId: watcher,
        dueAt: T0 + HOUR,
        waiting: expect.objectContaining({ description: "等张三给 Doubao work 的代码地址", parties: [expect.objectContaining({ label: "张三", replied: false, dueAt: T0 + HOUR })] }),
      }),
    ]);
    const deskRuns = h.deskRuns();

    h.script.add("project", (req) => {
      expect(requestText(req)).toContain("张三已回复：代码在 git@x:doubao/work.git");
      return {};
    });
    h.clock.advance(10 * 60_000);
    await fromZhang(h, "代码在 git@x:doubao/work.git");
    await h.kernel.idle();

    expect(h.deskRuns()).toBe(deskRuns);
    expect(h.kernel.getCell(watcher)).toMatchObject({ status: "closed", closeReason: "completed" });
    expect(h.script.pending("project")).toBe(0);
    const [a] = h.actions(project);
    expect(a).toMatchObject({ status: "done", progress: { done: 1, total: 1 } });
    expect(a!.waiting!.parties[0]).toMatchObject({ replied: true, repliedAt: T0 + 10 * 60_000 });
    expect(h.kernel.inbox.listMessagesSync({ cellId: watcher, type: PAYLOAD.timerFired }).map((m) => m.status)).toEqual(["cancelled"]);
    expect(h.script.requests.filter((r) => r.cellId === watcher)).toEqual([]); // zero tokens
  });

  it("a timeout puts the drafted nudge on the owner's card (the project's one card); confirming sends it and sets the next check", async () => {
    const h = await boot();
    const { project, watcher } = await waitForZhang(h);
    h.clock.set(T0 + HOUR);
    await h.kernel.idle();
    const [card] = h.cards();
    expect(card).toMatchObject({ cellId: watcher, subjectKey: subjectKeys.project(project) });
    const esc = card!.clarify as EscalationCard;
    expect(esc).toMatchObject({ cardType: "escalation", title: "张三还没回复：等张三给 Doubao work 的代码地址", escalation: { reason: "waiting_timeout", nudgeTarget: "channel:memory:zhang", nudgeDraft: { version: 1 } } });
    expect(h.state<WatcherState>(watcher, KEYS.watcher)).toMatchObject({ status: "overdue" });

    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", seenArtifactVersion: 1 })).toMatchObject({ status: "sent" });
    expect(h.memory.sent.map((d) => [d.target, d.content.body])).toEqual([["zhang", "您好，想跟进一下：等张三给 Doubao work 的代码地址。方便的话请回复一下，谢谢！"]]);
    await h.kernel.idle();
    expect(h.state<WatcherState>(watcher, KEYS.watcher)).toMatchObject({ status: "waiting", nudges: 1, dueAt: T0 + HOUR + DAY });
    // The project learns of it at its next turn: the books move the party's deadline.
    const notes = h.kernel.inbox.listMessagesSync({ cellId: project, type: PAYLOAD.cellProgress }).map((m) => (m.envelope.payload as { text: string }).text);
    expect(notes.at(-1)).toContain("催问已发出");
    h.kernel.sendToCell(project, { text: "主人：张三那边怎么样了？" });
    await h.kernel.idle();
    expect(h.actions(project)[0]!.waiting!.parties[0]).toMatchObject({ replied: false, dueAt: T0 + HOUR + DAY });

    await fromZhang(h, "抱歉，地址是 git@x:doubao/work.git");
    await h.kernel.idle();
    expect(h.kernel.getCell(watcher)?.status).toBe("closed");
    expect(h.actions(project)[0]).toMatchObject({ status: "done" });
    expect(h.cards()).toEqual([]);
  });

  it("interpret: a small model hands off-topic messages back and records the real answer", async () => {
    const h = await boot();
    h.script.setDefault("watcher", (req) => {
      if (continuesRun(req)) return {};
      const text = lastUserText(req);
      if (text.includes("顺便问下")) return tool("handback", { reason: "和代码无关的新问题" });
      if (text.includes("发你了")) return tool("record_reply", { summary: "给了代码仓库地址" });
      return tool("update_watch");
    });
    const { project, watcher } = await waitForZhang(h, { interpret: true });
    expect(h.kernel.getCell(watcher)?.spec.processor).toMatchObject({ kind: "llm", modelTier: "fast", prompt: "gtd.watcher" });

    h.script.add("desk", (req) => {
      expect(requestText(req)).toContain("顺便问下");
      return tool("wait", { reason: "noted" });
    });
    await fromZhang(h, "顺便问下，下周团建去哪？");
    await h.kernel.idle();
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.handback })).toHaveLength(1);
    expect(h.kernel.getCell(watcher)?.status).toBe("active");

    h.script.add("project", (req) => {
      expect(requestText(req)).toContain("张三已回复：给了代码仓库地址");
      return {};
    });
    await fromZhang(h, "仓库地址发你了");
    await h.kernel.idle();
    expect(h.kernel.getCell(watcher)?.status).toBe("closed");
    expect(h.actions(project)[0]).toMatchObject({ status: "done" });
  });
});

describe("the default watcher: a one-shot checker that watches on its own", () => {
  it("looks, sets its own watch, sleeps; the event wakes it; it reports once and closes", async () => {
    const h = await boot();
    h.script.add(
      "project",
      tool("dispatch", { preset: "watcher", title: "等 MR !5 合入", instruction: "检查 MR !5 是否合入；MR 的通知在 memory:mr-5 线程。" }),
      {},
    );
    h.script.add(
      "checker",
      (req) => {
        // a leaf: the shell, its own watches and reminders, reporting — but nothing that starts or steers cells
        const names = req.tools.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(["bash", "update_cell", "set_reminder", "report_to_parent", "wait"]));
        for (const n of ["spawn_cell", "control_cell", "close_cell"]) expect(names).not.toContain(n);
        return tool("update_cell", { watches: [{ thread: "memory:mr-5" }] });
      },
      tool("wait", { reason: "MR 还没合入", waitingFor: "external" }),
      (req) => {
        expect(requestText(req)).toContain("merged");
        return tool("report_to_parent", { kind: "result", text: "MR !5 已合入" });
      },
    );
    const { projectId } = startProjectSync(h.kernel, { title: "p", outcome: "o", brief: "b" });
    await h.kernel.idle();
    const [checker] = childrenOf(h, projectId);
    expect(h.kernel.getCell(checker!)).toMatchObject({ status: "active", spec: { watches: [{ threadOrFilter: { thread: "memory:mr-5" } }] } });
    // a leaf: it starts no cells of its own
    expect(h.kernel.getCell(checker!)!.bounds.maxDepth).toBe(0);
    expect(h.actions(projectId)[0]).toMatchObject({ owner: "waiting", status: "open" });

    await h.memory.inject({ from: "gitlab", text: "MR !5 merged into main", threads: ["memory:mr-5"] });
    await h.kernel.idle();
    expect(h.kernel.getCell(checker!)?.status).toBe("closed");
    expect(h.actions(projectId)[0]).toMatchObject({ status: "done" });
  });
});

describe("a source filtered by a small model", () => {
  it("silent on noise, one hit on a real problem; it may run commands, in a directory of its own", async () => {
    const h = await boot();
    h.script.add("desk", tool("add_source", { title: "支付反馈", description: "有人反馈付款失败、白屏或扣款异常才算", watchThread: "memory:pay-group" }), tool("wait", { reason: "ok" }));
    h.script.setDefault("sensor", (req) => {
      if (continuesRun(req)) return {};
      const text = lastUserText(req);
      return text.includes("被扣了两次") ? tool("report_hit", { title: "用户反馈重复扣款", summary: "群里有人说同一笔订单被扣了两次", rawInput: "我昨天的订单被扣了两次款" }) : tool("no_hit");
    });
    await h.ui.capture({ text: "帮我盯着支付群，有人反馈付款问题就告诉我" });
    await h.kernel.idle();
    const sensor = h.kernel.listCells({ parentId: "desk", preset: "sensor" })[0]!;
    expect(sensor.spec).toMatchObject({ lifetime: "persistent", processor: { kind: "llm", modelTier: "fast" } });
    expect(sensor.spec.cwdMode).toBeUndefined();
    expect((sensor.spec.processor as { allowedTools?: unknown }).allowedTools).toBeUndefined();
    expect(h.source(sensor.id)).toMatchObject({ kind: "watch", processor: "llm", runCount: 0, hitCount: 0 });
    const deskRuns = h.deskRuns();

    await h.memory.inject({ from: "u1", text: "今天的活动海报真好看", threads: ["memory:pay-group"] });
    await h.kernel.idle();
    expect(h.source(sensor.id)).toMatchObject({ runCount: 1, hitCount: 0 });
    expect(h.deskRuns()).toBe(deskRuns);

    h.script.add("desk", (req) => {
      expect(requestText(req)).toContain("用户反馈重复扣款");
      return tool("archive_notification", { title: "重复扣款反馈（已转给支付组）" });
    }, tool("wait", { reason: "ok" }));
    await h.memory.inject({ from: "u2", text: "我昨天的订单被扣了两次款", threads: ["memory:pay-group"] });
    await h.kernel.idle();
    expect(h.source(sensor.id)).toMatchObject({ runCount: 2, hitCount: 1 });
    expect(h.activities()).toEqual([expect.objectContaining({ kind: "notification_archived", source: expect.objectContaining({ label: "信源 · 用户反馈重复扣款" }) })]);
    expect(h.script.requests.find((r) => r.cellId === sensor.id)!.req.tools.map((t) => t.name)).toContain("bash");
  });
});

describe("cells from before docs/05", () => {
  it("an old item root winds itself down as cancelled with a plain explanation; an old redraft helper does nothing", async () => {
    const h = await boot();
    // As an old database has it: an item root stored as a persistent "worker" with the depth it was given then (the
    // worker preset is a leaf now; stored bounds are not recomputed).
    h.kernel.spawnCell("desk", { id: "prj_old", preset: "worker", lifetime: "persistent", title: "旧事项", processor: { kind: "code", entry: LEGACY.joinAll }, bounds: { maxDepth: 2 } });
    h.kernel.spawnCell("prj_old", { id: "prj_old-edit1", preset: "inline", title: "按意见改稿", processor: { kind: "llm", prompt: LEGACY.editor, toolsets: [LEGACY.editor, "kernel.context"] }, meta: { role: "editor" } });
    h.script.add("editor", (req) => {
      expect(req.tools.map((t) => t.name)).not.toContain("submit_draft");
      return {};
    });
    h.script.add("desk", (req) => {
      expect(requestText(req)).toContain("这个事项是旧版本创建的，已无法继续；请重新发起。");
      return tool("wait", { reason: "ok" });
    });
    h.kernel.sendToCell("prj_old-edit1", { text: "改一下" });
    h.kernel.sendToCell("prj_old", { text: "继续" });
    await h.kernel.idle();
    expect(h.kernel.getCell("prj_old")).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect(h.kernel.getCell("prj_old-edit1")?.status).toBe("closed");
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.cellResult }).map((m) => m.envelope.payload)).toEqual([
      expect.objectContaining({ childCellId: "prj_old", status: "cancelled", summary: "这个事项是旧版本创建的，已无法继续；请重新发起。" }),
    ]);
  });
});
