import { afterEach, describe, expect, it } from "vitest";
import { gtdKeys, PAYLOAD, selectRunTools, type ActionRecord, type Envelope } from "@ng/protocol";
import { BUILTIN_SKILLS, KEYS, PROMPTS, startProjectSync } from "../src";
import { RESTORE_REASON, resolveConfig } from "../src/shared/config";
import { promptDefs } from "../src/shared/prompts";
import { SKILL_DOMAIN_HUB, SKILL_HABIT_DISCOVERY, SKILL_PROJECT_RELAY, SKILL_WORKSPACE_ARBITRATION } from "../src/shared/skills";
import { replyWatcherSpec } from "../src/shared/watcher";
import { boot, childrenOf, cleanupAll, lastToolResult, projects, tool, type Harness } from "./helpers";

afterEach(cleanupAll);

/** What the app sends for "移回待确认" (apps/gtd-desk restoreActivity). */
function restore(h: Harness, original: Envelope, activityId: string): void {
  h.kernel.inbox.enqueueSync("desk", {
    id: `${original.id}#restore#${activityId}`,
    from: "kernel:router",
    principalId: "owner",
    kind: "event",
    type: PAYLOAD.handback,
    payload: { original, fromCellId: "desk", reason: RESTORE_REASON },
    createdAt: h.clock.now(),
  });
}

describe("conventions the workbench app relies on", () => {
  it("an item moved back from the archive gets a card; archiving it again is refused", async () => {
    const h = await boot();
    h.script.add("desk", tool("archive_notification", { title: "CI 构建通过" }), tool("wait", { reason: "ok" }));
    const env = await h.memory.inject({ from: "ci-bot", text: "main 分支构建通过 #812" });
    await h.kernel.idle();
    const [archived] = h.activities();
    expect(archived).toMatchObject({ kind: "notification_archived", restorable: true, envelope: { id: env.id } });

    h.script.add(
      "desk",
      tool("archive_notification", { title: "CI 构建通过" }),
      (req) => {
        expect(lastToolResult(req)).toContain("moved this item back from the archive");
        return tool("present_to_owner", { title: "CI：main 分支构建通过 #812", summary: "构建通过，没有需要处理的；确认后归档。" });
      },
    );
    restore(h, archived!.envelope!, archived!.id);
    await h.kernel.idle();
    expect(h.activities()).toHaveLength(1);
    const [card] = h.cards();
    expect(card).toMatchObject({ cellId: "desk", subjectKey: `msg:${env.id}` });
    expect(card!.clarify).toMatchObject({ cardType: "response", confirmVerb: "accept", title: "CI：main 分支构建通过 #812", rawInput: { text: "main 分支构建通过 #812" }, source: { label: "测试通道" } });
    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({ status: "approved" });
  });

  it("a reply card the owner took over (\"我来处理\", approvalActionId) closes its Engage item when it is finally sent; other fields stay", async () => {
    const h = await boot();
    h.script.add("desk", tool("draft_reply", { text: "下周二可以。", title: "回复王总：会面时间" }));
    await h.memory.inject({ from: "wang", text: "下周二有空见一面吗？" });
    await h.kernel.idle();
    const [card] = h.cards();
    // What the app writes for "转给我处理" on a reply: the approval stays pending behind a human action.
    const human: ActionRecord & { appNote: string } = {
      id: "act_h1",
      title: "回复王总：会面时间",
      owner: "human",
      status: "open",
      approvalActionId: card!.actionId,
      artifactId: card!.artifactId!,
      effort: "15m",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
      appNote: "kept",
    };
    h.kernel.context.commitSync("desk", { statePatches: { [gtdKeys.action(human.id)]: human } });

    expect(await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 1 })).toMatchObject({ status: "sent" });
    await h.kernel.idle();
    expect(h.state<ActionRecord & { appNote: string }>("desk", gtdKeys.action(human.id))).toMatchObject({ status: "done", completedAt: h.clock.now(), appNote: "kept", approvalActionId: card!.actionId });
  });

  it("weekly review: the desk sees how the owner rewrote a reply and leaves a skill suggestion for the review column", async () => {
    const h = await boot({ presets: { weeklyReview: "0 16 * * 5" } });
    h.script.add("desk", tool("draft_reply", { text: "好的，收到。", title: "回复供应商：交期" }));
    await h.memory.inject({ from: "supplier", text: "交期能提前到周五吗？" });
    await h.kernel.idle();
    const [card] = h.cards();
    h.kernel.context.commitSync("desk", { artifact: { artifactId: card!.artifactId!, content: { format: "text", body: "您好，周五可以，但需要加急费 5%，请确认。" }, updatedBy: "human", expectedVersion: 1 } });
    await h.kernel.resolveApproval(card!.actionId, { decision: "approve", approverId: "owner", seenArtifactVersion: 2 });
    await h.kernel.idle();
    expect(h.kernel.inbox.listSchedulesSync({ cellId: "desk", activeOnly: true }).map((s) => [s.template.id, s.cron, s.tz])).toEqual([["gtd-weekly-review", "0 16 * * 5", "Asia/Shanghai"]]);

    h.script.add(
      "desk",
      (req) => {
        expect(JSON.stringify(req.messages)).toContain("每周回顾");
        return tool("review_week");
      },
      (req) => {
        const facts = lastToolResult(req);
        expect(facts).toContain("你的初稿：\n好的，收到。");
        expect(facts).toContain("主人发出的版本：\n您好，周五可以，但需要加急费 5%");
        return tool("suggest_skill", {
          name: "supplier-reply",
          description: "回复供应商时使用",
          body: "- 以“您好”开头\n- 涉及加急必须写明费用并请对方确认",
          reason: "本周你把给供应商的回复都改成了带称呼、写明费用的版本",
        });
      },
      tool("wait", { reason: "reviewed" }),
    );
    h.clock.set(Date.UTC(2026, 10, 20, 8, 0, 0)); // Friday 16:00 Asia/Shanghai
    await h.kernel.idle();
    expect(h.state("desk", KEYS.skillSuggestion("supplier-reply"))).toMatchObject({
      name: "supplier-reply",
      description: "回复供应商时使用",
      reason: "本周你把给供应商的回复都改成了带称呼、写明费用的版本",
    });
    expect(h.cards()).toEqual([]);
  });

  it("stopping a project the owner had paused closes it and everything below it; the records say cancelled", async () => {
    const h = await boot();
    h.script.add("desk", tool("start_project", { title: "整理客户名单", outcome: "一份去重后的客户名单", brief: "整理一下客户名单" }), tool("wait", { reason: "ok" }));
    h.script.add("project", tool("dispatch", { title: "整理名单", instruction: "整理客户名单" }), {});
    // Still at work: it waits for an answer (a bare wait would end its turn).
    h.script.add("worker", tool("wait", { reason: "thinking", waitingFor: "inbox:desk" }));
    await h.ui.capture({ text: "整理一下客户名单" });
    await h.kernel.idle();
    const [project] = projects(h);
    const [worker] = childrenOf(h, project!);
    expect(h.kernel.control(project!, { action: "pause" })).toMatchObject({ applied: true });

    h.script.add("desk", tool("stop_item", { itemId: project, reason: "不需要了" }), tool("wait", { reason: "ok" }));
    await h.ui.capture({ text: "客户名单不用整理了" });
    await h.kernel.idle();
    expect(h.project(project!)).toMatchObject({ lifecycle: "cancelled" });
    expect(h.actions(project)).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(h.kernel.getCell(project!)).toMatchObject({ status: "closed", closeReason: "cancelled" });
    expect(h.kernel.getCell(worker!)).toMatchObject({ status: "closed", closeReason: "cancelled" });
  });
});

// ==================== prompts vs tools ====================

/**
 * Snake_case or `ticked` words that appear in the prompts but are not tools: argument values and shell commands (the
 * worker's look-only note names git subcommands: `git log` / `diff` / `show`; dispatch's `check`), a message type
 * (`cell.direct_chat`), the sample cell names of the project's board note, and the subject-matter terms COMMON gives
 * as examples of words that are never translated (`code_cell.rs`, `token`, `queue`, `epoch`).
 */
const NOT_TOOLS = new Set(["research_then_park", "diff", "show", "check", "direct_chat", "worker_a1", "worker_b2", "code_cell", "token", "queue", "epoch"]);

/**
 * Names a prompt mentions that its role does not have, reported to the prompts' owner (see the presets report). The
 * test fails when a new one appears — and when one listed here is fixed, so this list never goes stale.
 */
const KNOWN_PROMPT_GAPS: Readonly<Record<string, readonly string[]>> = {};

function mentionedTools(text: string): string[] {
  const snake = text.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? [];
  const ticked = [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!);
  return [...new Set([...snake, ...ticked])].filter((n) => !NOT_TOOLS.has(n) && !n.startsWith("cell_")).sort();
}

describe("conventions: every prompt names only tools its role has", () => {
  it("role prompts and the playbooks they rely on", async () => {
    const h = await boot();
    const { projectId } = startProjectSync(h.kernel, { title: "p", outcome: "o", brief: "b" });
    h.kernel.spawnCell(projectId, { preset: "worker", title: "w" });
    h.kernel.spawnCell(projectId, { preset: "watcher", title: "c" });
    h.kernel.spawnCell(projectId, replyWatcherSpec({ id: "p1", label: "张三", thread: "memory:t" }, { description: "d", itemTitle: "p", interpret: true }));
    h.kernel.spawnCell("desk", { preset: "sensor", title: "s" });
    h.kernel.spawnCell("desk", { preset: "hub", title: "h" });
    const cells = h.kernel.listCells({ status: ["active"] });
    const toolsOf = (prompt: string): string[] => {
      const cell = cells.find((c) => c.spec.processor.kind === "llm" && c.spec.processor.prompt === prompt);
      if (!cell || cell.spec.processor.kind !== "llm") throw new Error(`no cell runs ${prompt}`);
      return selectRunTools(h.registry.resolveTools(cell.spec.processor.toolsets ?? []), cell.spec.processor, cell.bounds, cell.spec).map((t) => t.name);
    };
    const skill = (name: string) => BUILTIN_SKILLS.find((s) => s.name === name)!.body;
    const checks: Array<{ prompt: string; text: string; source: string }> = [
      ...promptDefs(resolveConfig()).map((p) => ({ prompt: p.name, text: p.text, source: p.name })),
      { prompt: PROMPTS.project, text: skill(SKILL_PROJECT_RELAY), source: SKILL_PROJECT_RELAY },
      { prompt: PROMPTS.hub, text: skill(SKILL_DOMAIN_HUB), source: SKILL_DOMAIN_HUB },
      { prompt: PROMPTS.desk, text: skill(SKILL_WORKSPACE_ARBITRATION), source: SKILL_WORKSPACE_ARBITRATION },
      { prompt: PROMPTS.desk, text: skill(SKILL_HABIT_DISCOVERY), source: SKILL_HABIT_DISCOVERY },
    ];
    const missing: Record<string, string[]> = {};
    for (const c of checks) {
      const have = new Set(toolsOf(c.prompt));
      const gaps = mentionedTools(c.text).filter((n) => !have.has(n));
      if (gaps.length) missing[c.source] = [...(missing[c.source] ?? []), ...gaps];
    }
    expect(missing).toEqual(KNOWN_PROMPT_GAPS);
    // A worker and the watcher preset's checker are leaves (maxDepth 0): the tools that start, steer or close cells are
    // not offered to them, so no prompt or playbook of theirs may rely on them. They keep the shell and the files, and
    // update_cell for their own watches.
    for (const prompt of [PROMPTS.worker, PROMPTS.checker]) {
      expect(toolsOf(prompt)).toEqual(expect.arrayContaining(["bash", "write", "update_cell"]));
      for (const name of ["spawn_cell", "control_cell", "close_cell"]) expect(toolsOf(prompt)).not.toContain(name);
    }
    // The coordinators read what their cells did.
    for (const prompt of [PROMPTS.desk, PROMPTS.project, PROMPTS.hub]) expect(toolsOf(prompt)).toContain("inspect_cell");
    // Every registered role prompt was checked (the legacy stand-in names no tools).
    expect(new Set(checks.map((c) => c.prompt))).toEqual(new Set(Object.values(PROMPTS)));
  });
});
