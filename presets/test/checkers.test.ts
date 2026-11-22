import type { ModelRequest } from "@ng/loop/testing";
import { afterEach, describe, expect, it } from "vitest";

import { startProjectSync } from "../src";
import { boot, childrenOf, cleanupAll, continuesRun, requestText, tool } from "./helpers";

afterEach(cleanupAll);

function lastUserText(req: ModelRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  return (last?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

describe("the default checker: a one-shot checker that watches on its own", () => {
  it("looks, sets its own watch, sleeps; the event wakes it; it reports once and closes", async () => {
    const h = await boot();
    h.script.add(
      "project",
      tool("dispatch", { preset: "checker", title: "等 MR !5 合入", instruction: "检查 MR !5 是否合入；MR 的通知在 memory:mr-5 线程。" }),
      {},
    );
    h.script.add(
      "checker",
      (req) => {
        // a leaf: the shell, its own watches and reminders, reporting — but nothing that starts or steers cells
        const names = req.tools.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(["job_start", "update_cell", "set_reminder", "report_to_parent", "wait"]));
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
    expect(h.script.requests.find((r) => r.cellId === sensor.id)!.req.tools.map((t) => t.name)).toContain("job_start");
  });
});

