import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, PAYLOAD, type SourceRecord } from "@ng/protocol";
import { boot, childrenOf, cleanupAll, continuesRun, gitRepo, lastToolResult, MIN, requestText, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

const at = (h: Harness, from: string, text: string) => h.ui.capture({ text: `${from}：${text}`, threads: ["ui:reviews"] });

describe("docs/05 scenario 6 — a hub for direct review requests: batched, routed, follow-ups forwarded", () => {
  it("add_hub with an operator watch and a window; one batch; workers per topic; follow-ups reach the worker still at it and wake the one that has finished — no successor; noise handed back", async () => {
    const h = await boot();
    const repo = gitRepo("gateway");
    h.script.add(
      "desk",
      tool("add_hub", {
        title: "代码评审直通",
        repos: [{ name: "gateway", cwd: repo, defaultBranch: "main" }],
        rules: "工作台 @bot 的代码评审请求：评审 MR，给出阻塞项和建议项；其他事情退回。",
        watch: { filter: { "payload.text": { $contains: "@bot" } } },
        coalesceMinutes: 2,
      }),
      tool("wait", { reason: "hub added" }),
    );
    const titleOf = (id: string) => h.kernel.getCell(id)?.title ?? "";
    const hubChild = (title: string) => childrenOf(h, hub()).find((id) => titleOf(id) === title)!;
    const hub = () => childrenOf(h, "desk", "hub")[0]!;
    const done = new Set<string>();
    let noiseId = "";
    h.script.setDefault("hub", (req, ctx) => {
      const text = ctx.lastUserText;
      if (text.includes("看下 MR !41") && !done.has("batch1")) {
        done.add("batch1");
        expect(text).toContain("重点看并发");
        expect(text).toContain("看下 MR !38");
        return {
          toolCalls: [
            { name: "spawn_cell", input: { preset: "worker", title: "评审 MR !41", cwd: repo, instruction: "评审 MR !41，张三特别提到：重点看并发。只做查阅，不要改文件、不要切分支。交付阻塞项/建议项。" } },
            { name: "spawn_cell", input: { preset: "worker", title: "评审 MR !38", cwd: repo, instruction: "评审 MR !38（王五）。只做查阅，不要改文件、不要切分支。" } },
            { name: "handback", input: { envelopeId: noiseId, reason: "不是代码评审的事" } },
            { name: "set_state", input: { patches: { "hub:topics": { "mr-41": { state: "reviewing" }, "mr-38": { state: "reviewing" } } } } },
          ],
        };
      }
      if (text.includes("再看下锁") && !done.has("batch2")) {
        done.add("batch2");
        return {
          toolCalls: [
            { name: "send_message", input: { to: `inbox:${hubChild("评审 MR !41")}`, summary: "追加诉求", text: "张三：!41 再看下锁的粒度" } },
            { name: "send_message", input: { to: `inbox:${hubChild("评审 MR !38")}`, summary: "追加诉求", text: "王五：!38 改好了再看一眼" } },
          ],
        };
      }
      if (done.has("batch2") && !done.has("delivered") && continuesRun(req) && lastToolResult(req).includes("Delivered to")) {
        done.add("delivered");
        // Both delivered: the one still reviewing takes it in its turn; the one that has finished is woken by it.
        expect(lastToolResult(req).match(/Delivered to /g)).toHaveLength(2);
        expect(lastToolResult(req)).not.toContain("NOT DELIVERED");
      }
      return {};
    });
    h.script.setDefault("worker", (req, ctx) => {
      if (continuesRun(req)) return {};
      const title = titleOf(req.metadata!.cellId!);
      if (title === "评审 MR !41") return ctx.lastUserText.includes("再看下锁") ? tool("report_to_parent", { kind: "result", text: "!41：并发与锁粒度均已评审，1 个建议项" }) : tool("wait", { reason: "评审中" });
      if (title === "评审 MR !38") {
        // Woken again for the author's follow-up: it continues on its own record (its first review is in front of it).
        if (!ctx.lastUserText.includes("改好了")) return tool("report_to_parent", { kind: "result", text: "!38 评审完成：2 个阻塞项" });
        expect(requestText(req)).toContain("!38 评审完成：2 个阻塞项");
        return tool("report_to_parent", { kind: "result", text: "!38 阻塞项已解决" });
      }
      throw new Error(`unexpected worker ${title}`);
    });
    await h.ui.capture({ text: "把工作台 @bot 的评审请求直接转给评审助手处理" });
    await h.kernel.idle();

    expect(h.kernel.getCell(hub())).toMatchObject({
      preset: "hub",
      status: "active",
      spec: { lifetime: "persistent", absorbInbound: true, watches: [{ threadOrFilter: { "payload.text": { $contains: "@bot" } }, coalesceMs: 2 * MIN }] },
    });
    expect(h.source(hub())).toMatchObject({ title: "代码评审直通", kind: "watch", processor: "llm", runCount: 0 } satisfies Partial<SourceRecord>);
    expect(h.notices()).toContain("已添加直通入口：代码评审直通");
    const deskRuns = h.deskRuns();
    const hubRuns = () => h.of("run.started").filter((e) => e.cellId === hub()).length;
    const before = hubRuns();

    // Four messages within the window: nothing runs until it closes, then one batch reaches the hub (not the desk).
    await at(h, "zhangsan", "@bot 看下 MR !41");
    await at(h, "zhangsan", "@bot !41 补充：重点看并发");
    noiseId = (await at(h, "lisi", "@bot 帮忙订会议室")).id;
    await at(h, "wangwu", "@bot 看下 MR !38");
    await h.kernel.idle();
    expect(hubRuns()).toBe(before);
    h.script.add("desk", (req) => {
      expect(requestText(req)).toContain("帮忙订会议室");
      expect(requestText(req)).toContain("不是代码评审的事");
      return tool("archive_notification", { title: "群里有人想订会议室" });
    }, tool("wait", { reason: "ok" }));
    h.clock.advance(2 * MIN);
    await h.kernel.idle();

    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.userMessage }).map((m) => (m.envelope.payload as { text: string }).text)).toEqual(["把工作台 @bot 的评审请求直接转给评审助手处理"]);
    expect(h.kernel.inbox.listMessagesSync({ cellId: "desk", type: PAYLOAD.handback })).toHaveLength(1);
    expect(h.deskRuns()).toBe(deskRuns + 1);
    expect(h.state(hub(), "hub:topics")).toMatchObject({ "mr-41": { state: "reviewing" } });
    expect(h.source(hub())).toMatchObject({ runCount: 1 });
    const review41 = hubChild("评审 MR !41");
    const review38 = hubChild("评审 MR !38");
    expect(h.kernel.getCell(review41)).toMatchObject({ status: "active", spec: { cwd: repo, lifetime: "wakeable" } });
    // !38's review turn is over: it rests, not closed.
    expect(h.kernel.getCell(review38)?.status).toBe("active");
    expect(h.kernel.activityOf([review38]).get(review38)!.state).toBe("dormant");

    // Follow-ups in the next window: one reaches the worker still reviewing, the other wakes the one that finished.
    await at(h, "zhangsan", "@bot !41 再看下锁");
    await at(h, "wangwu", "@bot !38 改好了再看一眼");
    h.clock.advance(2 * MIN);
    await h.kernel.idle();

    expect(done).toEqual(new Set(["batch1", "batch2", "delivered"]));
    // Still two workers: no successor was needed.
    expect(childrenOf(h, hub())).toEqual([review41, review38]);
    expect(h.kernel.activityOf([review41, review38]).get(review41)!.state).toBe("dormant");
    expect(h.kernel.activityOf([review41, review38]).get(review38)!.state).toBe("dormant");
    expect(h.of("run.started").filter((e) => e.cellId === review38)).toHaveLength(2);
    const results = h.kernel.inbox.listMessagesSync({ cellId: hub(), type: PAYLOAD.cellResult }).map((m) => m.envelope.payload as { childCellId: string; summary: string });
    expect(results.map((r) => r.summary)).toEqual(expect.arrayContaining(["!38 评审完成：2 个阻塞项", "!41：并发与锁粒度均已评审，1 个建议项", "!38 阻塞项已解决"]));
    expect(results.filter((r) => r.childCellId === review38)).toHaveLength(2);
    expect(h.kernel.context.readStateSync(hub(), gtdKeys.project)).toBeNull(); // a hub is a source, never a project row
  });
});
